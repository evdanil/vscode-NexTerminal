import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import type { RpcNotification, RpcRequest, RpcResponse, SerialPortInfo } from "./protocol";

type DataListener = (sessionId: string, data: Buffer) => void;
type ErrorListener = (sessionId: string, message: string) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class SerialSidecarManager {
  private processRef?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly dataListeners = new Set<DataListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  public constructor(private readonly sidecarScriptPath: string) {}

  public onDidReceiveData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  public onDidReceiveError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  public async listPorts(): Promise<SerialPortInfo[]> {
    const result = await this.request("listPorts");
    return (result as SerialPortInfo[]) ?? [];
  }

  public async openPort(path: string, baudRate: number): Promise<string> {
    const result = await this.request("openPort", { path, baudRate });
    const sessionId = (result as { sessionId?: string }).sessionId;
    if (!sessionId) {
      throw new Error("Serial sidecar returned invalid openPort response");
    }
    return sessionId;
  }

  public async writePort(sessionId: string, data: Buffer): Promise<void> {
    await this.request("writePort", { sessionId, data: data.toString("base64") });
  }

  public async closePort(sessionId: string): Promise<void> {
    await this.request("closePort", { sessionId });
  }

  public dispose(): void {
    for (const [, deferred] of this.pending) {
      deferred.reject(new Error("Serial sidecar disposed"));
    }
    this.pending.clear();
    this.processRef?.kill();
    this.processRef = undefined;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.processRef && !this.processRef.killed) {
      return this.processRef;
    }
    const child = spawn(process.execPath, [this.sidecarScriptPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.on("exit", () => {
      const error = new Error("Serial sidecar exited unexpectedly");
      for (const [, deferred] of this.pending) {
        deferred.reject(error);
      }
      this.pending.clear();
      this.processRef = undefined;
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
      this.pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return responsePromise;
  }

  private handleMessage(line: string): void {
    if (!line.trim()) {
      return;
    }
    const payload = JSON.parse(line) as RpcResponse | RpcNotification;
    if ("id" in payload) {
      const deferred = this.pending.get(payload.id);
      if (!deferred) {
        return;
      }
      this.pending.delete(payload.id);
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
    if (notification.method === "portData") {
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
    if (notification.method === "portError") {
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
