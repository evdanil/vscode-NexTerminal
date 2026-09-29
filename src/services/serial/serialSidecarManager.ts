import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import { normalizeBoundedNumber } from "../../utils/helpers";
import {
  PORT_DATA_NOTIFICATION,
  PORT_DISCONNECTED_NOTIFICATION,
  PORT_ERROR_NOTIFICATION,
  PORT_RELEASE_FAILED_NOTIFICATION,
  type OpenPortParams,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
  type SerialPortInfo
} from "./protocol";

type DataListener = (sessionId: string, data: Buffer) => void;
type ErrorListener = (sessionId: string, message: string) => void;
type PortReleaseFailedListener = (portPath: string, message: string) => void;
type DisconnectListener = (sessionId: string, reason: string) => void;

/**
 * The manager gave up waiting; the worker never answered, so whatever the
 * request started there may still be running. Distinct from a worker-reported
 * error, which means the worker already settled the request.
 */
class SerialRpcTimeoutError extends Error {}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function normalizeRpcTimeoutMs(timeoutMs: number): number {
  return normalizeBoundedNumber(timeoutMs, 10_000, 2_000, 60_000);
}

export class SerialSidecarManager {
  private processRef?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly dataListeners = new Set<DataListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly disconnectListeners = new Set<DisconnectListener>();
  private readonly portReleaseFailedListeners = new Set<PortReleaseFailedListener>();
  private rpcTimeoutMs: number;

  public constructor(
    private readonly sidecarScriptPath: string,
    private readonly extensionRoot?: string,
    rpcTimeoutMs: number = 10_000
  ) {
    this.rpcTimeoutMs = normalizeRpcTimeoutMs(rpcTimeoutMs);
  }

  public updateRpcTimeout(timeoutMs: number): void {
    this.rpcTimeoutMs = normalizeRpcTimeoutMs(timeoutMs);
  }

  public onDidReceiveData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  public onDidReceiveError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  public onDidDisconnect(listener: DisconnectListener): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** An abandoned open completed but the sidecar could not close the port. */
  public onPortReleaseFailed(listener: PortReleaseFailedListener): () => void {
    this.portReleaseFailedListeners.add(listener);
    return () => this.portReleaseFailedListeners.delete(listener);
  }

  public async listPorts(): Promise<SerialPortInfo[]> {
    const result = await this.request("listPorts");
    return (result as SerialPortInfo[]) ?? [];
  }

  public async openPort(path: string, baudRate: number): Promise<string>;

  public async openPort(options: OpenPortParams, sessionId?: string): Promise<string>;
  public async openPort(path: string, baudRate?: number): Promise<string>;

  public async openPort(pathOrOptions: string | OpenPortParams, sessionIdOrBaudRate?: number | string): Promise<string> {
    const params: OpenPortParams =
      typeof pathOrOptions === "string"
        ? {
            path: pathOrOptions,
            baudRate: typeof sessionIdOrBaudRate === "number" ? sessionIdOrBaudRate : 115200
          }
        : pathOrOptions;
    const requestedSessionId =
      typeof pathOrOptions !== "string" && typeof sessionIdOrBaudRate === "string" ? sessionIdOrBaudRate : undefined;
    const child = this.ensureStarted();
    let result: unknown;
    try {
      result = await this.request(
        "openPort",
        requestedSessionId !== undefined ? { ...params, sessionId: requestedSessionId } : params
      );
    } catch (error) {
      // Only a timeout leaves the worker's open in flight. A worker-reported
      // error (e.g. "session ID is already in use") settled the request, and a
      // cancel there would close the legitimate session that owns that id.
      if (requestedSessionId !== undefined && error instanceof SerialRpcTimeoutError) {
        this.cancelAbandonedOpen(child, requestedSessionId);
      }
      throw error;
    }
    const openedSessionId = (result as { sessionId?: string }).sessionId;
    if (!openedSessionId) {
      throw new Error("Serial sidecar returned invalid openPort response");
    }
    return openedSessionId;
  }

  /**
   * After a client-side RPC timeout the worker is still waiting on the native open
   * and would keep the port once it succeeds. Tell that same worker to cancel.
   * This writes to the child that owned the open and never goes through
   * ensureStarted(): if it was disposed or exited, its ports died with it and
   * spawning a fresh sidecar just to cancel would leak an unowned process.
   */
  private cancelAbandonedOpen(child: ChildProcessWithoutNullStreams, sessionId: string): void {
    if (this.processRef !== child || child.killed) {
      return;
    }
    const payload: RpcRequest = { id: randomUUID(), method: "cancelAbandonedOpen", params: { sessionId } };
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // Best effort: the child is going away, and so is its open port.
    }
  }

  public async writePort(sessionId: string, data: Buffer): Promise<void> {
    await this.request("writePort", { sessionId, data: data.toString("base64") });
  }

  public async sendBreak(sessionId: string, duration?: number): Promise<void> {
    await this.request("sendBreak", { sessionId, duration });
  }

  public async closePort(sessionId: string): Promise<void> {
    await this.request("closePort", { sessionId });
  }

  public dispose(): void {
    for (const [, deferred] of this.pending) {
      if (deferred.timer) {
        clearTimeout(deferred.timer);
      }
      deferred.reject(new Error("Serial sidecar disposed"));
    }
    this.pending.clear();
    this.dataListeners.clear();
    this.errorListeners.clear();
    this.disconnectListeners.clear();
    this.portReleaseFailedListeners.clear();
    this.processRef?.kill();
    this.processRef = undefined;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.processRef && !this.processRef.killed) {
      return this.processRef;
    }
    const child = spawn(process.execPath, [this.sidecarScriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.extensionRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    child.on("exit", () => {
      const error = new Error("Serial sidecar exited unexpectedly");
      for (const [, deferred] of this.pending) {
        if (deferred.timer) {
          clearTimeout(deferred.timer);
        }
        deferred.reject(error);
      }
      this.pending.clear();
      this.processRef = undefined;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      console.warn("[Nexus Serial Sidecar stderr]", chunk.toString("utf8").trim());
    });
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      this.handleMessage(line);
    });
    this.processRef = child;
    return child;
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const child = this.ensureStarted();
    const id = randomUUID();
    const payload: RpcRequest = { id, method, params };
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const deferred: PendingRequest = { resolve, reject };
      deferred.timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        pending.reject(new SerialRpcTimeoutError(`Serial sidecar RPC timed out after ${this.rpcTimeoutMs / 1000}s (method=${method})`));
      }, this.rpcTimeoutMs);
      this.pending.set(id, deferred);
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return responsePromise;
  }

  private handleMessage(line: string): void {
    if (!line.trim()) {
      return;
    }
    let payload: RpcResponse | RpcNotification;
    try {
      payload = JSON.parse(line) as RpcResponse | RpcNotification;
    } catch {
      console.warn("[Nexus Serial] Failed to parse sidecar message:", line.slice(0, 200));
      return;
    }
    if ("id" in payload) {
      const deferred = this.pending.get(payload.id);
      if (!deferred) {
        return;
      }
      this.pending.delete(payload.id);
      if (deferred.timer) {
        clearTimeout(deferred.timer);
      }
      if (payload.error) {
        deferred.reject(new Error(payload.error.message));
        return;
      }
      deferred.resolve(payload.result);
      return;
    }

    this.handleNotification(payload);
  }

  private handleNotification(notification: RpcNotification): void {
    if (notification.method === PORT_DATA_NOTIFICATION) {
      const data = notification.params as { sessionId?: string; data?: string };
      if (!data.sessionId || !data.data) {
        return;
      }
      const buffer = Buffer.from(data.data, "base64");
      for (const listener of this.dataListeners) {
        listener(data.sessionId, buffer);
      }
      return;
    }
    if (notification.method === PORT_DISCONNECTED_NOTIFICATION) {
      const disconnected = notification.params as { sessionId?: string; reason?: string };
      if (!disconnected.sessionId) {
        return;
      }
      const reason = disconnected.reason ?? "Port closed";
      for (const listener of this.disconnectListeners) {
        listener(disconnected.sessionId, reason);
      }
      return;
    }
    if (notification.method === PORT_RELEASE_FAILED_NOTIFICATION) {
      const failed = notification.params as { path?: string; message?: string };
      if (!failed.path) {
        return;
      }
      for (const listener of this.portReleaseFailedListeners) {
        listener(failed.path, failed.message ?? "");
      }
      return;
    }
    if (notification.method === PORT_ERROR_NOTIFICATION) {
      const error = notification.params as { sessionId?: string; message?: string };
      if (!error.sessionId || !error.message) {
        return;
      }
      for (const listener of this.errorListeners) {
        listener(error.sessionId, error.message);
      }
    }
  }
}
