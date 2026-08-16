/**
 * JSON-RPC bridge over stdin/stdout between the extension host and the
 * network-servers daemon (`networkServerDaemon.ts`, spawned as a child
 * process).
 *
 * ## Why a child process at all
 *
 * - **No ports, no firewall**: unlike an HTTP/WebSocket control channel, a pipe
 *   never collides with a user-occupied port and never triggers a Windows
 *   Firewall prompt.
 * - **Coupled lifecycle**: closing stdin is an EOF the daemon treats as
 *   "shut down"; a SIGTERM → SIGKILL escalation in {@link dispose} guarantees
 *   no orphan holding UDP 69/67 after the extension host goes away.
 * - **Crash isolation**: a fault in the DHCP library cannot take down the
 *   extension host, exactly as the serial sidecar isolates `serialport`.
 *
 * ## Internal shape
 *
 * The wire protocol is inherited unchanged from the standalone add-on
 * (newline-delimited JSON, `{id, method, params}` → `{id, result|error}`, plus
 * unsolicited `{event, data}` pushes). The *plumbing* around it deliberately
 * mirrors `services/serial/serialSidecarManager.ts` so both out-of-process
 * bridges in this codebase read the same way:
 *
 * - a `Map<id, PendingRequest>` of in-flight calls, each with its own timeout;
 * - every pending call rejected and cleared on child exit and in `dispose()`,
 *   so no promise is ever left dangling;
 * - notifications fanned out to `Set<Listener>` collections, each subscription
 *   returning its own unsubscribe function.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { normalizeBoundedNumber } from "../../utils/helpers";
import type {
  DhcpAdapterConfig,
  NetworkServerConfigs,
  ServerConnectionEvent,
  ServerSnapshot,
  ServerStatusChangeEvent,
  TftpAdapterConfig
} from "./core/index";
import type { DhcpLeaseInfo } from "./dhcp/DhcpAdapter";
import type { DhcpPacketCounters, DhcpPoolInfo } from "./dhcp/engine/DhcpEngine";
import type { TftpTransferView } from "./tftp/TftpAdapter";

/** Successful JSON-RPC response (id + result). */
type JsonRpcResult = { readonly id: number; readonly result: unknown };
/** Error JSON-RPC response (id + error.code + error.message). */
type JsonRpcError = { readonly id: number; readonly error: { readonly code: string; readonly message: string } };
/** Union of all possible daemon responses. */
type JsonRpcResponse = JsonRpcResult | JsonRpcError;

/**
 * Unsolicited pushes from the daemon (not replies to any request).
 * - `ready`: initialization finished; RPCs are now accepted.
 * - `statusChange`: a service moved between stopped/starting/running/error.
 * - `log`: a log line to surface in the output channel.
 * - `runtimeUpdate`: mutable runtime changed (TFTP transfers / DHCP leases).
 * - `connection`: a client connection lifecycle edge — a TFTP transfer opened,
 *   finished or failed, a DHCP lease was granted or declined. One push per
 *   edge, never per progress tick, so a consumer may surface each one directly
 *   to the user without any throttling of its own.
 */
type JsonRpcEvent =
  | { readonly event: "ready"; readonly data: null }
  | { readonly event: "statusChange"; readonly data: ServerStatusChangeEvent }
  | { readonly event: "log"; readonly data: { readonly id: string; readonly level: string; readonly message: string } }
  | { readonly event: "runtimeUpdate"; readonly data: { readonly id: string } }
  | {
      readonly event: "connection";
      readonly data: { readonly id: string; readonly connection: ServerConnectionEvent };
    };

type StatusChangeListener = (event: ServerStatusChangeEvent) => void;
type RuntimeUpdateListener = (id: string) => void;
type ConnectionListener = (id: string, event: ServerConnectionEvent) => void;
type LogListener = (id: string, level: string, message: string) => void;
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

/** In-flight JSON-RPC call awaiting its response. */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** `getServiceRuntime` reply for the TFTP service. */
export interface TftpRuntimeSnapshot {
  readonly snapshot: ServerSnapshot;
  readonly transfers: readonly TftpTransferView[];
  readonly root: string;
  readonly allowWrite: boolean;
  readonly boundPort: number | null;
}

/** `getServiceRuntime` reply for the DHCP service. */
export interface DhcpRuntimeSnapshot {
  readonly snapshot: ServerSnapshot;
  readonly leases: readonly DhcpLeaseInfo[];
  readonly packetCounters: DhcpPacketCounters;
  readonly poolInfo: DhcpPoolInfo;
  readonly boundPort: number | null;
}

/** Either service's runtime reply — discriminate on the presence of `leases`. */
export type NetworkServerRuntimeSnapshot = TftpRuntimeSnapshot | DhcpRuntimeSnapshot;

/** Configuration payload for whichever service a start/restart targets. */
export type NetworkServerAdapterConfig = TftpAdapterConfig | DhcpAdapterConfig;

export interface NetworkServerDaemonHostOptions {
  /** Working directory for the child process (typically the extension root). */
  extensionRoot?: string;
  /** Per-request timeout. Clamped to [2s, 60s]; defaults to 15s. */
  rpcTimeoutMs?: number;
  /** How long to wait for the daemon's `ready` push. Clamped to [1s, 60s]. */
  readyTimeoutMs?: number;
  /**
   * Resolves the configuration seed handed to the daemon at spawn time via the
   * `NEXUS_NETWORK_SERVERS_CONFIG` environment variable.
   *
   * The daemon has no access to the `vscode` module and so cannot read
   * settings itself; this closure is the host's one chance to give it correct
   * values *before* the first RPC, so an early `listServers()` does not report
   * default ports for services the user has reconfigured.
   */
  resolveSpawnConfig?: () => NetworkServerConfigs;
}

/** Environment variable carrying the spawn-time configuration seed. */
const CONFIG_ENV_VAR = "NEXUS_NETWORK_SERVERS_CONFIG";

function normalizeRpcTimeoutMs(timeoutMs: number): number {
  return normalizeBoundedNumber(timeoutMs, 15_000, 2_000, 60_000);
}

function normalizeReadyTimeoutMs(timeoutMs: number): number {
  return normalizeBoundedNumber(timeoutMs, 10_000, 1_000, 60_000);
}

/**
 * Extension-host side of the network-servers daemon bridge.
 *
 * Safe to call repeatedly: `ensureStarted()` is idempotent and coalesces
 * concurrent callers onto a single spawn, and `dispose()` is a no-op after the
 * first call.
 */
export class NetworkServerDaemonHost {
  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly statusChangeListeners = new Set<StatusChangeListener>();
  private readonly runtimeUpdateListeners = new Set<RuntimeUpdateListener>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private readonly logListeners = new Set<LogListener>();
  private readonly exitListeners = new Set<ExitListener>();
  /** Resolved once the daemon pushes `ready`; rejected if it dies first. */
  private readonly readyWaiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();
  private readyFlag = false;
  private disposed = false;
  private startPromise?: Promise<void>;
  private rlStdout?: Interface;
  private rlStderr?: Interface;
  private killTimer?: ReturnType<typeof setTimeout>;
  private readonly rpcTimeoutMs: number;
  private readonly readyTimeoutMs: number;

  public constructor(
    private readonly daemonScriptPath: string,
    private readonly options: NetworkServerDaemonHostOptions = {}
  ) {
    this.rpcTimeoutMs = normalizeRpcTimeoutMs(options.rpcTimeoutMs ?? 15_000);
    this.readyTimeoutMs = normalizeReadyTimeoutMs(options.readyTimeoutMs ?? 10_000);
  }

  /** True once the daemon has pushed `ready` and accepts RPCs. */
  public get isReady(): boolean {
    return this.readyFlag;
  }

  /** True while the child process handle exists and has not been killed. */
  public get isRunning(): boolean {
    return this.child !== undefined && !this.child.killed;
  }

  public onDidChangeStatus(listener: StatusChangeListener): () => void {
    this.statusChangeListeners.add(listener);
    return () => this.statusChangeListeners.delete(listener);
  }

  public onDidUpdateRuntime(listener: RuntimeUpdateListener): () => void {
    this.runtimeUpdateListeners.add(listener);
    return () => this.runtimeUpdateListeners.delete(listener);
  }

  /**
   * Subscribes to client connection lifecycle edges.
   *
   * Emitted at most once per transfer/lease edge, so a listener may act on
   * every call — including showing a notification — without debouncing.
   */
  public onDidConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  public onDidLog(listener: LogListener): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  public onDidExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  // ---------------------------------------------------------------------------
  // RPC surface (wire methods preserved 1:1 from the standalone add-on)
  // ---------------------------------------------------------------------------

  /** Lists every registered service with its current snapshot. */
  public async listServers(): Promise<readonly ServerSnapshot[]> {
    const result = await this.request("list");
    return (result as ServerSnapshot[]) ?? [];
  }

  /** Snapshot of a single service. */
  public async getStatus(id: string): Promise<ServerSnapshot> {
    return (await this.request("getStatus", { id })) as ServerSnapshot;
  }

  /**
   * Pushes configuration into the daemon without starting anything.
   *
   * Applied to the daemon's configuration store; services that are stopped are
   * rebuilt against the new values on their next start, while running services
   * keep serving under their current configuration until restarted.
   */
  public async configure(configs: NetworkServerConfigs): Promise<readonly string[]> {
    const result = await this.request("configure", { configs });
    return ((result as { changed?: string[] })?.changed ?? []) as readonly string[];
  }

  /**
   * Starts a service, optionally applying freshly-read configuration first.
   *
   * Resolves when the daemon acknowledges; the service may still be
   * `STARTING`. Subscribe via {@link onDidChangeStatus} for the real
   * transition.
   */
  public async startServer(id: string, config?: NetworkServerAdapterConfig): Promise<void> {
    await this.request("start", config ? { id, config } : { id });
  }

  /** Gracefully stops a service. */
  public async stopServer(id: string): Promise<void> {
    await this.request("stop", { id });
  }

  /** Stops then starts a service, optionally applying new configuration between the two. */
  public async restartServer(id: string, config?: NetworkServerAdapterConfig): Promise<void> {
    await this.request("restart", config ? { id, config } : { id });
  }

  /**
   * Aborts one in-flight TFTP transfer.
   *
   * @param id         Service id — only `"tftp"` has cancellable transfers.
   * @param transferId `address:port` id from {@link TftpTransferView.id}.
   * @returns `true` when the daemon aborted a live transfer, `false` when it
   *          had already finished on its own (a race the caller reports as
   *          "already finished", not as an error).
   */
  public async cancelTransfer(id: string, transferId: string): Promise<boolean> {
    const result = await this.request("cancelTransfer", { id, transferId });
    return (result as { ok?: boolean } | undefined)?.ok === true;
  }

  /**
   * Full mutable runtime for a service — the payload a tree view renders from.
   *
   * Shape is service-specific and preserved verbatim from the daemon:
   * `{snapshot, transfers, root, allowWrite, boundPort}` for TFTP,
   * `{snapshot, leases, packetCounters, poolInfo, boundPort}` for DHCP.
   */
  public async getServiceRuntime(id: string): Promise<NetworkServerRuntimeSnapshot> {
    return (await this.request("getServiceRuntime", { id })) as NetworkServerRuntimeSnapshot;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Spawns the daemon if needed and resolves once it reports `ready`.
   *
   * Concurrent callers share one spawn attempt; a failed attempt is not cached,
   * so a later call retries cleanly.
   */
  public async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error("Network servers daemon host is disposed");
    }
    if (this.child && this.readyFlag) {
      return;
    }
    if (!this.startPromise) {
      this.startPromise = this.launch().finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  /**
   * Tears down the bridge: closes stdin (EOF → graceful daemon shutdown),
   * SIGTERMs the child, escalates to SIGKILL after 2s, rejects every pending
   * request and drops all listeners. Idempotent.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readyFlag = false;

    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
    this.closeReadlineInterfaces();

    const child = this.child;
    this.child = undefined;
    if (child) {
      child.removeAllListeners();
      try { child.stdin?.end(); } catch { /* pipe already gone */ }
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      if (child.exitCode === null && child.signalCode === null) {
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, 2000);
        timer.unref();
        this.killTimer = timer;
      }
    }

    this.rejectAllPending(new Error("Network servers daemon host disposed"));
    this.rejectAllReadyWaiters(new Error("Network servers daemon host disposed"));
    this.statusChangeListeners.clear();
    this.runtimeUpdateListeners.clear();
    this.connectionListeners.clear();
    this.logListeners.clear();
    this.exitListeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async launch(): Promise<void> {
    if (!existsSync(this.daemonScriptPath)) {
      throw new Error(`Network servers daemon script not found: ${this.daemonScriptPath}`);
    }

    const seed = this.options.resolveSpawnConfig?.();
    const child = spawn(process.execPath, [this.daemonScriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.options.extensionRoot,
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ...(seed ? { [CONFIG_ENV_VAR]: JSON.stringify(seed) } : {})
      }
    });
    this.child = child;

    child.on("error", (error) => {
      this.rejectAllReadyWaiters(error);
      this.emitLog("daemon", "error", `Daemon process error: ${error.message}`);
    });

    child.on("exit", (code, signal) => {
      this.readyFlag = false;
      this.closeReadlineInterfaces();
      this.child = undefined;
      const error = new Error(`Network servers daemon exited (code=${String(code ?? "null")})`);
      this.rejectAllPending(error);
      this.rejectAllReadyWaiters(error);
      for (const listener of this.exitListeners) {
        listener(code, signal);
      }
    });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => this.handleMessage(line));
      this.rlStdout = rl;
    }
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on("line", (line) => this.emitLog("daemon", "warn", `[stderr] ${line}`));
      this.rlStderr = rl;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          this.readyWaiters.delete(waiter);
          resolve();
        },
        reject: (error: unknown) => {
          clearTimeout(timer);
          this.readyWaiters.delete(waiter);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const timer = setTimeout(() => {
        waiter.reject(new Error(`Network servers daemon did not report ready within ${this.readyTimeoutMs / 1000}s`));
      }, this.readyTimeoutMs);
      this.readyWaiters.add(waiter);
    });
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted();
    const child = this.child;
    if (!child || !child.stdin || !child.stdin.writable) {
      throw new Error("Network servers daemon stdin is not writable");
    }

    const id = this.nextId++;
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const deferred: PendingRequest = { resolve, reject };
      deferred.timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.reject(
          new Error(`Network servers daemon RPC timed out after ${this.rpcTimeoutMs / 1000}s (method=${method})`)
        );
      }, this.rpcTimeoutMs);
      this.pending.set(id, deferred);
    });

    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return responsePromise;
  }

  private handleMessage(raw: string): void {
    const line = raw.trim();
    if (!line) return;

    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      this.emitLog("daemon", "warn", `Invalid JSON from daemon: ${line.slice(0, 200)}`);
      return;
    }

    if (this.isResponse(payload)) {
      const deferred = this.pending.get(payload.id);
      if (!deferred) return;
      this.pending.delete(payload.id);
      if (deferred.timer) {
        clearTimeout(deferred.timer);
      }
      if ("error" in payload) {
        const error = new Error(payload.error.message);
        error.name = payload.error.code;
        deferred.reject(error);
        return;
      }
      deferred.resolve(payload.result);
      return;
    }

    if (this.isEvent(payload)) {
      this.handleNotification(payload);
      return;
    }

    this.emitLog("daemon", "warn", `Unknown JSON shape from daemon: ${line.slice(0, 160)}`);
  }

  private handleNotification(notification: JsonRpcEvent): void {
    switch (notification.event) {
      case "ready": {
        this.readyFlag = true;
        for (const waiter of [...this.readyWaiters]) {
          waiter.resolve();
        }
        this.readyWaiters.clear();
        return;
      }
      case "statusChange": {
        for (const listener of this.statusChangeListeners) {
          listener(notification.data);
        }
        return;
      }
      case "runtimeUpdate": {
        for (const listener of this.runtimeUpdateListeners) {
          listener(notification.data.id);
        }
        return;
      }
      case "connection": {
        for (const listener of this.connectionListeners) {
          listener(notification.data.id, notification.data.connection);
        }
        return;
      }
      case "log": {
        this.emitLog(notification.data.id, notification.data.level, notification.data.message);
        return;
      }
    }
  }

  private emitLog(id: string, level: string, message: string): void {
    for (const listener of this.logListeners) {
      listener(id, level, message);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, deferred] of this.pending) {
      if (deferred.timer) {
        clearTimeout(deferred.timer);
      }
      deferred.reject(error);
    }
    this.pending.clear();
  }

  private rejectAllReadyWaiters(error: Error): void {
    for (const waiter of [...this.readyWaiters]) {
      waiter.reject(error);
    }
    this.readyWaiters.clear();
  }

  private closeReadlineInterfaces(): void {
    if (this.rlStdout) {
      try { this.rlStdout.close(); } catch { /* already closed */ }
      this.rlStdout = undefined;
    }
    if (this.rlStderr) {
      try { this.rlStderr.close(); } catch { /* already closed */ }
      this.rlStderr = undefined;
    }
  }

  private isResponse(value: unknown): value is JsonRpcResponse {
    if (!value || typeof value !== "object") return false;
    const obj = value as Record<string, unknown>;
    if (typeof obj.id !== "number") return false;
    if ("result" in obj) return true;
    return (
      typeof obj.error === "object" &&
      obj.error !== null &&
      typeof (obj.error as Record<string, unknown>).message === "string"
    );
  }

  private isEvent(value: unknown): value is JsonRpcEvent {
    if (!value || typeof value !== "object") return false;
    const obj = value as Record<string, unknown>;
    return typeof obj.event === "string" && "data" in obj;
  }
}
