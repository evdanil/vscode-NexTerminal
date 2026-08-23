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
 *   "shut down"; a delayed SIGTERM → SIGKILL escalation in {@link dispose}
 *   guarantees no orphan holding UDP 69/67 after the extension host goes away.
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
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { normalizeBoundedNumber } from "../../utils/helpers";
import { attachBoundedLineReader } from "./boundedLineReader";
import type {
  DhcpAdapterConfig,
  NetworkServerConfigs,
  ServerConnectionEvent,
  ServerSnapshot,
  ServerStatus,
  ServerStatusChangeEvent,
  TftpAdapterConfig
} from "./core/index";
import type { DhcpLeaseInfo } from "./dhcp/DhcpAdapter";
import type { DhcpPacketCounters, DhcpPoolInfo } from "./dhcp/engine/DhcpEngine";
import {
  MAX_DAEMON_RPC_IN_FLIGHT,
  parseRpcEnvelope,
  parseRpcEvent,
  parseRpcResultForRequest,
  type RpcEnvelope,
  type RpcEvent,
  type RpcMethod,
  type RpcParams,
  type RpcParseResult,
  type RpcResult,
} from "./networkServerRpcProtocol";
import type { TftpTransferView } from "./tftp/TftpAdapter";

type StatusChangeListener = (event: ServerStatusChangeEvent) => void;
type RuntimeUpdateListener = (id: string) => void;
type ConnectionListener = (id: string, event: ServerConnectionEvent) => void;
type LogListener = (id: string, level: string, message: string) => void;
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

/** Grace period for the daemon's stdin-EOF shutdown path before SIGTERM. */
const DAEMON_STDIN_EOF_GRACE_MS = 500;
/** Escalation after SIGTERM if the process is still alive. */
const DAEMON_SIGKILL_ESCALATION_MS = 2000;

/** In-flight JSON-RPC call awaiting its response. */
interface PendingRequest {
  readonly method: RpcMethod;
  readonly parseResult: (value: unknown) => RpcParseResult<unknown>;
  readonly admission: RequestAdmission;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * One finite host admission, acquired before a caller can wait for startup.
 *
 * A reply may settle before Node has released the corresponding stdin frame,
 * so response and write ownership remain intentionally independent. The final
 * release happens only once both have settled, or when this exact child's
 * close proves the frame cannot remain retained by its writable stream.
 */
interface RequestAdmission {
  responseSettled: boolean;
  writeSettled: boolean;
  released: boolean;
  child?: ChildProcess;
  generation?: number;
}

/** One child owns one drain listener for all of its backpressured frames. */
interface ChildWriteAuthority {
  readonly child: ChildProcess;
  readonly generation: number;
  readonly stdin: NodeJS.WritableStream;
  readonly admissions: Set<RequestAdmission>;
  waitingForDrain: boolean;
  closed: boolean;
  readonly onDrain: () => void;
}

/** The EOF grace resources owned by one exact child generation. */
interface ChildStdoutEofDeadline {
  timer?: ReturnType<typeof setTimeout>;
  check?: ReturnType<typeof setImmediate>;
}

/** Protocol detachment and terminal error ownership have different lifetimes. */
interface ChildIoOwnership {
  readonly detachProtocol: () => void;
  readonly releaseTerminalGuards: () => void;
}

/** One cached startup promise belongs only to the child generation that spawned it. */
interface StartupAttempt {
  child?: ChildProcess;
  generation?: number;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
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
  /**
   * Which daemon implementation to spawn. `rust` is a preference: if no native
   * binary is available for this platform, the host falls back to Node.
   */
  engine?: NetworkServerEngine;
  /**
   * Resolves the implementation preference at launch time. Used by the VS Code
   * manager so a settings change takes effect on the next daemon start without
   * requiring an extension-host reload.
   */
  resolveEngine?: () => NetworkServerEngine;
  /** Absolute path to the native daemon binary, when one ships for this platform. */
  nativeBinaryPath?: string;
}

/** Environment variable carrying the spawn-time configuration seed. */
const CONFIG_ENV_VAR = "NEXUS_NETWORK_SERVERS_CONFIG";

/** Which implementation backs the daemon child process. */
export type NetworkServerEngine = "node" | "rust";

/**
 * Environment override for running a locally-built native daemon without a
 * packaged artifact.
 */
export const DAEMON_BINARY_ENV_VAR = "NEXUS_NETWORK_SERVER_DAEMON_BIN";

interface LaunchTarget {
  readonly command: string;
  readonly args: readonly string[];
  readonly native: boolean;
}

function toNativeDaemonPlatformKey(platform: NodeJS.Platform, arch: string): string | undefined {
  if (arch !== "x64" && arch !== "arm64") return undefined;
  switch (platform) {
    case "darwin":
    case "linux":
    case "win32":
      return `${platform}-${arch}`;
    default:
      return undefined;
  }
}

/**
 * Absolute path of the native daemon binary for the running platform, or
 * `undefined` when the platform/architecture is unsupported.
 */
export function resolveNativeDaemonBinaryPath(
  extensionPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const platformKey = toNativeDaemonPlatformKey(platform, arch);
  if (!platformKey) return undefined;
  const binaryName = platform === "win32" ? "nexus-network-server-daemon.exe" : "nexus-network-server-daemon";
  return path.join(extensionPath, "dist", "native", "network-server-daemon", platformKey, binaryName);
}

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
  /** Includes cold-start callers and retained stdin writes, not just replies. */
  private readonly admissions = new Set<RequestAdmission>();
  private readonly childWrites = new Map<ChildProcess, ChildWriteAuthority>();
  private readonly statusChangeListeners = new Set<StatusChangeListener>();
  private readonly runtimeUpdateListeners = new Set<RuntimeUpdateListener>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private readonly logListeners = new Set<LogListener>();
  private readonly exitListeners = new Set<ExitListener>();
  /** Resolved once the daemon pushes `ready`; rejected if it dies first. */
  private readonly readyWaiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();
  private readyFlag = false;
  private disposed = false;
  private startAttempt?: StartupAttempt;
  private nextGeneration = 1;
  private activeGeneration?: number;
  private readonly childIo = new Map<ChildProcess, ChildIoOwnership>();
  /** SIGTERM grace timer belongs to the specific child whose stdin was closed. */
  private readonly termTimers = new Map<ChildProcess, ReturnType<typeof setTimeout>>();
  /** SIGKILL escalation belongs to the specific child that received SIGTERM. */
  private readonly killTimers = new Map<ChildProcess, ReturnType<typeof setTimeout>>();
  /** A live child may close stdout only until this generation-owned deadline. */
  private readonly stdoutEofTimers = new Map<ChildProcess, ChildStdoutEofDeadline>();
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
    return result as readonly ServerSnapshot[];
  }

  /** Snapshot of a single service. */
  public async getStatus(id: string): Promise<ServerSnapshot> {
    return (await this.request("getStatus", { id } as RpcParams<"getStatus">)) as ServerSnapshot;
  }

  /**
   * Pushes configuration into the daemon without starting anything.
   *
   * Applied to the daemon's configuration store; services that are stopped are
   * rebuilt against the new values on their next start, while running services
   * keep serving under their current configuration until restarted.
   */
  public async configure(configs: NetworkServerConfigs): Promise<readonly string[]> {
    const result = await this.request("configure", { configs } as RpcParams<"configure">);
    return result.changed;
  }

  /**
   * Starts a service, optionally applying freshly-read configuration first.
   *
   * Resolves when the daemon acknowledges; the service may still be
   * `STARTING`. Subscribe via {@link onDidChangeStatus} for the real
   * transition.
   */
  public async startServer(id: string, config?: NetworkServerAdapterConfig): Promise<void> {
    await this.request("start", (config ? { id, config } : { id }) as RpcParams<"start">);
  }

  /** Gracefully stops a service. */
  public async stopServer(id: string): Promise<void> {
    await this.request("stop", { id } as RpcParams<"stop">);
  }

  /** Stops then starts a service, optionally applying new configuration between the two. */
  public async restartServer(id: string, config?: NetworkServerAdapterConfig): Promise<void> {
    await this.request("restart", (config ? { id, config } : { id }) as RpcParams<"restart">);
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
    const result = await this.request("cancelTransfer", { id, transferId } as RpcParams<"cancelTransfer">);
    return result.ok;
  }

  /**
   * Full mutable runtime for a service — the payload a tree view renders from.
   *
   * Shape is service-specific and preserved verbatim from the daemon:
   * `{snapshot, transfers, root, allowWrite, boundPort}` for TFTP,
   * `{snapshot, leases, packetCounters, poolInfo, boundPort}` for DHCP.
   */
  public async getServiceRuntime(id: string): Promise<NetworkServerRuntimeSnapshot> {
    return (await this.request("getServiceRuntime", { id } as RpcParams<"getServiceRuntime">)) as NetworkServerRuntimeSnapshot;
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
    const existingAttempt = this.startAttempt;
    if (
      existingAttempt
      && (
        // The deferred authority must be usable while the resolver and config
        // serializer synchronously reenter before a child exists.
        (!existingAttempt.child && existingAttempt.generation === undefined && !this.child)
        || (
          existingAttempt.child
          && existingAttempt.generation !== undefined
          && this.isCurrentChild(existingAttempt.child, existingAttempt.generation)
        )
      )
    ) {
      return existingAttempt.promise;
    }
    // A retired generation must never lend its already-settled startup
    // promise to a listener that synchronously starts a replacement.
    if (existingAttempt) this.startAttempt = undefined;

    let resolveAttempt!: () => void;
    let rejectAttempt!: (error: unknown) => void;
    const deferred = new Promise<void>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    let attempt!: StartupAttempt;
    const promise = deferred.finally(() => {
      // A retired attempt's reaction runs after user callbacks. Only its own
      // cache entry may be cleared; a replacement attempt belongs to another
      // child generation.
      if (this.startAttempt === attempt) this.startAttempt = undefined;
    });
    attempt = { promise, resolve: resolveAttempt, reject: rejectAttempt };
    this.startAttempt = attempt;
    // Publish the fully usable deferred attempt before `launch()` can invoke
    // user-owned config resolution or serialization. Its handlers settle only
    // this attempt, so an old launch cannot touch a reentrant replacement.
    void this.launch(attempt).then(attempt.resolve, attempt.reject);
    return attempt.promise;
  }

  /**
   * Tears down the bridge: closes stdin (EOF → graceful daemon shutdown), gives
   * that path a short grace window, then SIGTERMs the child and escalates to
   * SIGKILL after 2s if it is still alive. Rejects every pending request and
   * drops all listeners. Idempotent.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readyFlag = false;
    const error = new Error("Network servers daemon host disposed");
    const preSpawnAttempt = this.startAttempt;
    if (preSpawnAttempt && !preSpawnAttempt.child && preSpawnAttempt.generation === undefined) {
      this.startAttempt = undefined;
      preSpawnAttempt.reject(error);
    }

    const child = this.child;
    if (child) this.terminateChild(child);

    this.rejectAllPending(error);
    this.rejectAllReadyWaiters(error);
    this.statusChangeListeners.clear();
    this.runtimeUpdateListeners.clear();
    this.connectionListeners.clear();
    this.logListeners.clear();
    this.exitListeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Detaches a child from the bridge and tears it down: stdin EOF first, then
   * SIGTERM after the EOF grace window, escalating to SIGKILL after 2s if it is
   * still alive.
   *
   * Shared by {@link dispose} and by the ready-timeout path in {@link launch},
   * which needs exactly the same teardown — a child that never reported ready
   * is still a live process holding open pipes, and abandoning it means a
   * retry silently accumulates daemons that no `dispose()` can ever reach.
   *
   * The host-level state (pipe readers, `child`, `readyFlag`) is only
   * cleared when `child` really is the current one. Detaching a child that has
   * already been replaced must not close the live one's pipes.
   */
  private terminateChild(child: ChildProcess): void {
    if (this.child !== child) return;
    const generation = this.activeGeneration;
    if (this.startAttempt?.child === child && this.startAttempt.generation === generation) {
      this.startAttempt = undefined;
    }
    this.clearChildStdoutEofDeadline(child);
    this.child = undefined;
    this.activeGeneration = undefined;
    this.readyFlag = false;
    // These readers are attached to THIS child's stdout/stderr. Leaving them
    // attached lets a late line from a dead generation mutate its replacement.
    // Stream error guards stay attached through this child's later `close`:
    // Node can deliver a buffered EPIPE after exit/termination.
    this.detachChildProtocolIo(child);
    try { child.stdin?.end(); } catch { /* pipe already gone */ }
    this.scheduleChildTermination(child);
  }

  /**
   * Picks the child process to spawn.
   *
   * `engine: "rust"` is a preference, never a hard requirement. A user who
   * opts in on a platform without a packaged binary must still get working
   * TFTP/DHCP, so missing native artifacts degrade to the bundled Node daemon
   * with a visible warning.
   */
  private resolveLaunchTarget(): LaunchTarget {
    const nodeTarget = this.nodeLaunchTarget();
    const engine = this.options.resolveEngine?.() ?? this.options.engine ?? "node";
    if (engine !== "rust") return nodeTarget;

    const override = process.env[DAEMON_BINARY_ENV_VAR]?.trim();
    const binary = override && override.length > 0 ? override : this.options.nativeBinaryPath;
    if (!binary) {
      this.emitLog(
        "daemon",
        "warn",
        `Engine 'rust' requested but no native daemon ships for ${process.platform}-${process.arch}; using the bundled Node daemon instead.`
      );
      return nodeTarget;
    }
    if (!existsSync(binary)) {
      this.emitLog(
        "daemon",
        "warn",
        `Engine 'rust' requested but the native daemon binary is missing at ${binary}; using the bundled Node daemon instead.`
      );
      return nodeTarget;
    }
    return { command: binary, args: [], native: true };
  }

  private nodeLaunchTarget(): LaunchTarget {
    return { command: process.execPath, args: [this.daemonScriptPath], native: false };
  }

  private async launch(attempt: StartupAttempt): Promise<void> {
    const target = this.resolveLaunchTarget();
    if (target.native) {
      try {
        await this.launchTarget(attempt, target);
        return;
      } catch (error) {
        if (!this.canRetryStartupAttempt(attempt)) throw error;
        attempt.child = undefined;
        attempt.generation = undefined;
        this.startAttempt = attempt;
        this.emitLog(
          "daemon",
          "warn",
          `Native network servers daemon failed before reporting ready (${error instanceof Error ? error.message : String(error)}); using the bundled Node daemon instead.`
        );
        await this.launchTarget(attempt, this.nodeLaunchTarget());
        return;
      }
    }
    await this.launchTarget(attempt, target);
  }

  private canRetryStartupAttempt(attempt: StartupAttempt): boolean {
    return !this.disposed
      && !this.readyFlag
      && !this.child
      && (this.startAttempt === attempt || this.startAttempt === undefined);
  }

  private async launchTarget(attempt: StartupAttempt, target: LaunchTarget): Promise<void> {
    if (this.disposed || this.startAttempt !== attempt || this.child) {
      throw new Error(this.disposed
        ? "Network servers daemon host is disposed"
        : "Network servers daemon startup attempt was retired before spawn");
    }
    if (!target.native && !existsSync(this.daemonScriptPath)) {
      throw new Error(`Network servers daemon script not found: ${this.daemonScriptPath}`);
    }

    const seed = this.options.resolveSpawnConfig?.();
    const serializedSeed = seed ? JSON.stringify(seed) : undefined;
    // The resolver and JSON serialization may synchronously reenter or
    // dispose the host. Never spawn after this exact attempt was retired, and
    // never overwrite a child that another owner already made current.
    if (this.disposed || this.startAttempt !== attempt || this.child) {
      throw new Error(this.disposed
        ? "Network servers daemon host is disposed"
        : "Network servers daemon startup attempt was retired before spawn");
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(serializedSeed ? { [CONFIG_ENV_VAR]: serializedSeed } : {})
    };
    if (target.native) {
      // The native daemon is a plain executable, not a Node/Electron script.
      delete env.ELECTRON_RUN_AS_NODE;
    } else {
      env.ELECTRON_RUN_AS_NODE = "1";
    }
    const child = spawn(target.command, [...target.args], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.options.extensionRoot,
      windowsHide: true,
      env
    });
    const generation = this.nextGeneration++;
    this.child = child;
    this.activeGeneration = generation;
    attempt.child = child;
    attempt.generation = generation;
    if (child.stdin) this.installChildWriteAuthority(child, generation, child.stdin);

    // This observation deliberately survives bridge teardown. `terminateChild`
    // clears current-host state before signalling, so the guarded lifecycle
    // listener below must ignore its later exit; the child still owns the
    // timer that would otherwise escalate an unrelated replacement.
    const clearChildTimers = () => {
      this.clearChildTermination(child);
      this.clearChildEscalation(child);
      this.clearChildStdoutEofDeadline(child);
    };
    child.once("exit", clearChildTimers);
    child.once("close", clearChildTimers);
    child.once("close", () => this.releaseChildWriteAdmissions(child));
    child.once("close", () => this.releaseChildTerminalGuards(child));

    child.on("error", (error) => {
      if (!this.isCurrentChild(child, generation)) return;
      const wasReady = this.readyFlag;
      const terminalError = new Error(`Network servers daemon process error: ${error.message}`);
      this.terminateChild(child);
      this.rejectAllPending(terminalError);
      this.rejectAllReadyWaiters(terminalError);
      if (wasReady) this.emitExit(null, null);
      this.emitLog("daemon", "error", `Daemon process error: ${error.message}`);
    });

    child.on("exit", (code, signal) => {
      if (!this.isCurrentChild(child, generation)) return;
      if (this.startAttempt?.child === child && this.startAttempt.generation === generation) {
        this.startAttempt = undefined;
      }
      this.clearChildStdoutEofDeadline(child);
      this.readyFlag = false;
      this.detachChildProtocolIo(child);
      this.child = undefined;
      this.activeGeneration = undefined;
      const error = new Error(`Network servers daemon exited (code=${String(code ?? "null")})`);
      this.rejectAllPending(error);
      this.rejectAllReadyWaiters(error);
      this.emitExit(code, signal);
    });

    const protocolDetachers: Array<() => void> = [];
    const terminalGuardDetachers: Array<() => void> = [];

    if (child.stdout) {
      const stdout = child.stdout;
      const detachReader = attachBoundedLineReader(stdout, {
        onLine: (line) => {
          if (!this.isCurrentChild(child, generation)) return;
          this.handleMessage(child, generation, line);
        },
        onError: (error) => this.failChildProtocol(child, generation, error.message),
      });
      const onStdoutEnd = () => {
        this.scheduleChildStdoutEofDeadline(child, generation);
      };
      const onStdoutError = (error: Error) => {
        if (!this.isCurrentChild(child, generation)) return;
        this.failChildProtocol(child, generation, `daemon stdout stream error: ${error.message}`);
      };
      stdout.once("end", onStdoutEnd);
      // Keep this guard until the exact child closes. A late stream error
      // after generation teardown must be consumed, never handed to a
      // replacement generation or Node's unhandled-error path.
      stdout.on("error", onStdoutError);
      protocolDetachers.push(() => {
        detachReader();
        stdout.removeListener("end", onStdoutEnd);
      });
      terminalGuardDetachers.push(() => stdout.removeListener("error", onStdoutError));
    }
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on("line", (line) => {
        if (!this.isCurrentChild(child, generation)) return;
        this.emitLog("daemon", "warn", `[stderr] ${line}`);
      });
      const onStderrError = (error: Error) => {
        if (!this.isCurrentChild(child, generation)) return;
        this.emitLog("daemon", "warn", `Daemon stderr stream error: ${error.message}`);
      };
      child.stderr.on("error", onStderrError);
      protocolDetachers.push(() => {
        try { rl.close(); } catch { /* already closed */ }
      });
      terminalGuardDetachers.push(() => child.stderr?.removeListener("error", onStderrError));
    }
    if (child.stdin) {
      const onStdinError = (error: Error) => {
        if (!this.isCurrentChild(child, generation)) return;
        this.failChildTransport(child, generation, `daemon stdin stream error: ${error.message}`);
      };
      child.stdin.on("error", onStdinError);
      terminalGuardDetachers.push(() => child.stdin?.removeListener("error", onStdinError));
    }
    this.childIo.set(child, {
      detachProtocol: () => {
        for (const detach of protocolDetachers) detach();
      },
      releaseTerminalGuards: () => {
        for (const detach of terminalGuardDetachers) detach();
      },
    });

    try {
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
      if (!this.isCurrentChild(child, generation) || !this.readyFlag) {
        throw new Error("Network servers daemon startup retired before ready state was stable");
      }
    } catch (error) {
      // A spawn that times out leaves a live process behind. `ensureStarted`
      // does not cache a failed attempt, so the next call spawns another one
      // and overwrites `this.child` — the first daemon then holds its pipes
      // (and any UDP port it went on to bind) forever, unreachable by
      // `dispose()`, and its late `ready` would resolve waiters belonging to
      // its replacement. Kill it before allowing that retry. The `exit`
      // handler's own rejections are harmless here: the waiter is already
      // settled and the pending map is empty this early.
      this.terminateChild(child);
      throw error;
    }
  }

  private async request<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
    const admission = this.acquireAdmission();
    try {
      await this.ensureStarted();
      const child = this.child;
      const generation = this.activeGeneration;
      if (!child || !child.stdin || !child.stdin.writable) {
        throw new Error("Network servers daemon stdin is not writable");
      }
      if (generation === undefined) {
        throw new Error("Network servers daemon generation is unavailable");
      }
      // Capture the narrowed stream before entering deferred callbacks; the
      // ChildProcess property itself is nullable in Node's declarations.
      const stdin = child.stdin;
      const authority = this.childWrites.get(child);
      if (!authority || authority.generation !== generation || authority.stdin !== stdin || authority.closed) {
        throw new Error("Network servers daemon stdin ownership is unavailable");
      }

      const id = this.allocateRequestId();
      const responsePromise = new Promise<unknown>((resolve, reject) => {
        const deferred: PendingRequest = {
          method,
          parseResult: (value) => parseRpcResultForRequest(method, params, value),
          admission,
          resolve,
          reject,
        };
        deferred.timer = setTimeout(() => {
          const writeStillRetained = !admission.writeSettled;
          this.settlePending(id, deferred, (entry) => entry.reject(
            new Error(`Network servers daemon RPC timed out after ${this.rpcTimeoutMs / 1000}s (method=${method})`)
          ));
          // A timeout only frees its response ownership. A false-return frame
          // can still be retained by this exact stdin stream, so retire the
          // generation rather than recycling the admission into another write.
          if (writeStillRetained && this.isCurrentChild(child, generation)) {
            this.failChildTransport(child, generation, `daemon stdin write remained undrained after RPC timeout (method=${method})`);
          }
        }, this.rpcTimeoutMs);
        this.pending.set(id, deferred);

        this.beginAdmissionWrite(admission, authority);
        try {
          const request = params === undefined ? { id, method } : { id, method, params };
          const accepted = stdin.write(`${JSON.stringify(request)}\n`, (error?: Error | null) => {
            // Node has invoked this callback, so it no longer retains this
            // exact frame even if the child was already retired meanwhile.
            this.settleAdmissionWrite(admission);
            if (error && this.isCurrentChild(child, generation)) {
              this.failChildTransport(child, generation, `daemon stdin write failed: ${error.message}`);
            }
          });
          // `write()` is allowed to synchronously invoke its callback/error
          // path before returning false. Recheck both the exact admission and
          // current generation so a terminal callback cannot add a stale drain
          // listener after it has torn down the transport.
          if (!accepted && !admission.writeSettled && this.isCurrentChild(child, generation)) {
            this.waitForChildDrain(authority);
          }
        } catch (error) {
          this.settleAdmissionWrite(admission);
          if (this.isCurrentChild(child, generation)) {
            const message = error instanceof Error ? error.message : String(error);
            this.failChildTransport(child, generation, `daemon stdin write failed: ${message}`);
          }
        }
      });

      return await responsePromise as RpcResult<M>;
    } finally {
      // Startup/write failures have no response envelope to settle. A normal
      // reply or teardown has already done this and is harmlessly idempotent.
      this.settleAdmissionResponse(admission);
    }
  }

  private handleMessage(child: ChildProcess, generation: number, raw: string): void {
    if (!this.isCurrentChild(child, generation)) return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.failChildProtocol(child, generation, "invalid JSON from daemon");
      return;
    }

    const envelope = parseRpcEnvelope(payload);
    if (envelope.ok) {
      this.handleEnvelope(child, generation, envelope.value);
      return;
    }

    const event = parseRpcEvent(payload);
    if (event.ok) {
      this.handleNotification(child, generation, event.value);
      return;
    }

    this.failChildProtocol(child, generation, `${envelope.error} ${event.error}`);
  }

  private handleEnvelope(child: ChildProcess, generation: number, envelope: RpcEnvelope): void {
    if (!this.isCurrentChild(child, generation)) return;
    const deferred = this.pending.get(envelope.id);
    if (!deferred) {
      this.emitLog("daemon", "warn", `Ignoring daemon response for unknown request id ${envelope.id}`);
      return;
    }

    if ("error" in envelope) {
      this.settlePending(envelope.id, deferred, (entry) => {
        const error = new Error(envelope.error.message);
        error.name = envelope.error.code;
        entry.reject(error);
      });
      return;
    }

    const result = deferred.parseResult(envelope.result);
    if (!result.ok) {
      this.failChildProtocol(child, generation, `malformed ${deferred.method} result: ${result.error}`);
      return;
    }
    this.settlePending(envelope.id, deferred, (entry) => entry.resolve(result.value));
  }

  private handleNotification(child: ChildProcess, generation: number, notification: RpcEvent): void {
    if (!this.isCurrentChild(child, generation)) return;
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
        // JSON transports enum values as their closed string representation;
        // `parseRpcEvent` has already established the exact shared domain.
        const statusEvent: ServerStatusChangeEvent = {
          id: notification.data.id,
          status: notification.data.status as ServerStatus,
          ...(notification.data.error === undefined ? {} : { error: notification.data.error }),
        };
        for (const listener of this.statusChangeListeners) {
          if (!this.isCurrentChild(child, generation)) return;
          this.invokeUserListener(() => listener(statusEvent));
        }
        return;
      }
      case "runtimeUpdate": {
        for (const listener of this.runtimeUpdateListeners) {
          if (!this.isCurrentChild(child, generation)) return;
          this.invokeUserListener(() => listener(notification.data.id));
        }
        return;
      }
      case "connection": {
        for (const listener of this.connectionListeners) {
          if (!this.isCurrentChild(child, generation)) return;
          this.invokeUserListener(() => listener(notification.data.id, notification.data.connection));
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
      this.invokeUserListener(() => listener(id, level, message));
    }
  }

  /** Emits one lifecycle edge while isolating each extension-host listener. */
  private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of this.exitListeners) {
      this.invokeUserListener(() => listener(code, signal));
    }
  }

  private isCurrentChild(child: ChildProcess, generation: number): boolean {
    return this.child === child && this.activeGeneration === generation;
  }

  /** Reserves one finite host slot before startup, allocation, or serialization. */
  private acquireAdmission(): RequestAdmission {
    if (this.admissions.size >= MAX_DAEMON_RPC_IN_FLIGHT) {
      const error = new Error("Network servers daemon RPC admission is full");
      error.name = "SERVER_BUSY";
      throw error;
    }
    const admission: RequestAdmission = {
      responseSettled: false,
      // Until a write begins there is no stream-retained frame to own.
      writeSettled: true,
      released: false,
    };
    this.admissions.add(admission);
    return admission;
  }

  private beginAdmissionWrite(admission: RequestAdmission, authority: ChildWriteAuthority): void {
    if (admission.released) return;
    admission.writeSettled = false;
    admission.child = authority.child;
    admission.generation = authority.generation;
    authority.admissions.add(admission);
  }

  private settleAdmissionResponse(admission: RequestAdmission): void {
    if (admission.responseSettled) return;
    admission.responseSettled = true;
    this.releaseAdmissionIfComplete(admission);
  }

  private settleAdmissionWrite(admission: RequestAdmission): void {
    if (admission.writeSettled) return;
    admission.writeSettled = true;
    if (admission.child) this.childWrites.get(admission.child)?.admissions.delete(admission);
    this.releaseAdmissionIfComplete(admission);
  }

  private releaseAdmissionIfComplete(admission: RequestAdmission): void {
    if (admission.released || !admission.responseSettled || !admission.writeSettled) return;
    admission.released = true;
    this.admissions.delete(admission);
  }

  private installChildWriteAuthority(child: ChildProcess, generation: number, stdin: NodeJS.WritableStream): void {
    const authority: ChildWriteAuthority = {
      child,
      generation,
      stdin,
      admissions: new Set<RequestAdmission>(),
      waitingForDrain: false,
      closed: false,
      onDrain: () => {
        authority.waitingForDrain = false;
      },
    };
    this.childWrites.set(child, authority);
  }

  /** One child, rather than one request, owns the writable stream's drain listener. */
  private waitForChildDrain(authority: ChildWriteAuthority): void {
    if (authority.closed || authority.waitingForDrain) return;
    authority.waitingForDrain = true;
    authority.stdin.once("drain", authority.onDrain);
  }

  /** Child close is the final proof that its writable stream cannot retain a frame. */
  private releaseChildWriteAdmissions(child: ChildProcess): void {
    const authority = this.childWrites.get(child);
    if (!authority) return;
    authority.closed = true;
    if (authority.waitingForDrain) authority.stdin.removeListener("drain", authority.onDrain);
    authority.waitingForDrain = false;
    this.childWrites.delete(child);
    for (const admission of [...authority.admissions]) {
      this.settleAdmissionWrite(admission);
    }
    authority.admissions.clear();
  }

  /** Settles exactly the request which installed this callback, once. */
  private settlePending(id: number, expected: PendingRequest, settle: (entry: PendingRequest) => void): boolean {
    if (this.pending.get(id) !== expected) return false;
    this.pending.delete(id);
    if (expected.timer) clearTimeout(expected.timer);
    this.settleAdmissionResponse(expected.admission);
    settle(expected);
    return true;
  }

  /** Rejects this generation and reaps only its process after an untrusted stdout violation. */
  private failChildProtocol(child: ChildProcess, generation: number, reason: string): void {
    if (!this.isCurrentChild(child, generation)) return;
    const wasReady = this.readyFlag;
    const error = new Error(`Daemon protocol error: ${reason}`);
    this.terminateChild(child);
    this.rejectAllPending(error);
    this.rejectAllReadyWaiters(error);
    // User lifecycle listeners may synchronously start or request from a
    // replacement. Settle the failed generation first, then notify exactly
    // once with unknown metadata; no old-generation cleanup may follow.
    if (wasReady) this.emitExit(null, null);
  }

  /** Owns a terminal pipe failure exactly like protocol corruption, without blaming the peer's schema. */
  private failChildTransport(child: ChildProcess, generation: number, reason: string): void {
    if (!this.isCurrentChild(child, generation)) return;
    const wasReady = this.readyFlag;
    const error = new Error(`Network servers daemon transport error: ${reason}`);
    this.terminateChild(child);
    this.rejectAllPending(error);
    this.rejectAllReadyWaiters(error);
    if (wasReady) this.emitExit(null, null);
  }

  /** Allocates a finite request id and skips ids still owned by pending calls. */
  private allocateRequestId(): number {
    let id = Number.isSafeInteger(this.nextId) && this.nextId > 0 ? this.nextId : 1;
    const first = id;
    do {
      if (!this.pending.has(id)) {
        this.nextId = id === Number.MAX_SAFE_INTEGER ? 1 : id + 1;
        return id;
      }
      id = id === Number.MAX_SAFE_INTEGER ? 1 : id + 1;
    } while (id !== first);
    throw new Error("Network servers daemon has exhausted safe RPC request ids");
  }

  /** Gives normal exit/close delivery a conservative chance before treating live EOF as corruption. */
  private scheduleChildStdoutEofDeadline(child: ChildProcess, generation: number): void {
    if (!this.isCurrentChild(child, generation) || this.stdoutEofTimers.has(child)) return;
    const deadline: ChildStdoutEofDeadline = {};
    deadline.timer = setTimeout(() => {
      deadline.timer = undefined;
      if (this.stdoutEofTimers.get(child) !== deadline || !this.isCurrentChild(child, generation)) return;

      // An expired timer runs before the poll phase. A child can have exited
      // while the host loop was stalled, leaving its normal `exit`/`close`
      // callbacks queued behind this timer. Defer the live-EOF verdict to one
      // check-phase turn so those process callbacks get their normal poll
      // opportunity first; the exact child still owns this short resource.
      deadline.check = setImmediate(() => {
        deadline.check = undefined;
        if (this.stdoutEofTimers.get(child) !== deadline) return;
        this.stdoutEofTimers.delete(child);
        if (!this.isCurrentChild(child, generation)) return;
        if (child.exitCode === null && child.signalCode === null) {
          this.failChildProtocol(child, generation, "daemon stdout closed before the process exited");
        }
      });
      deadline.check.unref();
    }, 1_000);
    deadline.timer.unref();
    this.stdoutEofTimers.set(child, deadline);
  }

  private clearChildStdoutEofDeadline(child: ChildProcess): void {
    const deadline = this.stdoutEofTimers.get(child);
    if (!deadline) return;
    if (deadline.timer) clearTimeout(deadline.timer);
    if (deadline.check) clearImmediate(deadline.check);
    this.stdoutEofTimers.delete(child);
  }

  /** A user callback must never break framing, child ownership, or later listeners. */
  private invokeUserListener(callback: () => void): void {
    try {
      callback();
    } catch {
      // Listener exceptions are isolated at the host boundary by design.
    }
  }

  /** Installs no more than one unref'd SIGTERM timer for this exact child. */
  private scheduleChildTermination(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) {
      this.clearChildTermination(child);
      this.clearChildEscalation(child);
      return;
    }
    if (this.termTimers.has(child)) return;

    const timer = setTimeout(() => {
      this.termTimers.delete(child);
      if (child.exitCode !== null || child.signalCode !== null) {
        this.clearChildEscalation(child);
        return;
      }
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      this.scheduleChildEscalation(child);
    }, DAEMON_STDIN_EOF_GRACE_MS);
    timer.unref();
    this.termTimers.set(child, timer);
  }

  /** Clears only the SIGTERM timer owned by the child known to have ended. */
  private clearChildTermination(child: ChildProcess): void {
    const timer = this.termTimers.get(child);
    if (!timer) return;
    clearTimeout(timer);
    this.termTimers.delete(child);
  }

  /** Installs no more than one unref'd SIGKILL escalation timer for this exact child. */
  private scheduleChildEscalation(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) {
      this.clearChildEscalation(child);
      return;
    }
    if (this.killTimers.has(child)) return;

    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        this.clearChildEscalation(child);
        return;
      }
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, DAEMON_SIGKILL_ESCALATION_MS);
    timer.unref();
    this.killTimers.set(child, timer);
  }

  /** Clears only the escalation owned by the child known to have ended. */
  private clearChildEscalation(child: ChildProcess): void {
    const timer = this.killTimers.get(child);
    if (!timer) return;
    clearTimeout(timer);
    this.killTimers.delete(child);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, deferred] of [...this.pending]) {
      this.settlePending(id, deferred, (entry) => entry.reject(error));
    }
  }

  private rejectAllReadyWaiters(error: Error): void {
    for (const waiter of [...this.readyWaiters]) {
      waiter.reject(error);
    }
    this.readyWaiters.clear();
  }

  /** Stops this child's protocol/data callbacks without releasing terminal guards. */
  private detachChildProtocolIo(child: ChildProcess): void {
    this.childIo.get(child)?.detachProtocol();
  }

  /** Releases only the terminal guards owned by the child that actually closed. */
  private releaseChildTerminalGuards(child: ChildProcess): void {
    const ownership = this.childIo.get(child);
    if (!ownership) return;
    ownership.detachProtocol();
    ownership.releaseTerminalGuards();
    this.childIo.delete(child);
  }
}
