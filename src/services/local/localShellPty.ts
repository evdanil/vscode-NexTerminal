import { spawn } from "node:child_process";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import * as vscode from "vscode";
import type { SessionPtyHandle } from "../../models/config";
import type { PtyOutputObserver } from "../macroAutoTrigger";

const MAX_FRAME_LENGTH = 1024 * 1024;

type LocalPtyState = "idle" | "spawning" | "running" | "failed" | "exited" | "closing" | "disposed";

interface LocalPtyFrame {
  type: string;
  data?: string;
  message?: string;
  code?: number | null;
}

export interface LocalPtySidecarProcess {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type LocalPtySidecarSpawner = (sidecarPath: string) => LocalPtySidecarProcess;
export interface LocalShellOutputChannel {
  appendLine(value: string): void;
}

export interface LocalShellPtyOptions {
  sidecarPath: string;
  shellPath: string;
  shellArgs?: string[];
  cwd?: string;
  env?: Record<string, string | null | undefined>;
  terminalName: string;
  startupCommand?: string;
  spawnSidecar?: LocalPtySidecarSpawner;
  outputChannel?: LocalShellOutputChannel;
}

function encodeBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function decodeBase64(data: string | undefined): string {
  if (!data) return "";
  return Buffer.from(data, "base64").toString("utf8");
}

function startupCommandInput(command: string): string {
  return `${command}\n`;
}

function defaultSpawnSidecar(sidecarPath: string): LocalPtySidecarProcess {
  return spawn(sidecarPath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  }) as LocalPtySidecarProcess;
}

export function localPtyPlatformKey(platform = process.platform, arch = process.arch): string | undefined {
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return `win32-${arch}`;
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) return `linux-${arch}`;
  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) return `darwin-${arch}`;
  return undefined;
}

export function resolveLocalPtySidecarPath(extensionPath: string): string {
  const key = localPtyPlatformKey();
  if (!key) {
    throw new Error(`Local Shell auto-trigger is not supported on ${process.platform}-${process.arch}.`);
  }
  const binary = process.platform === "win32" ? "nexus-local-pty.exe" : "nexus-local-pty";
  return path.join(extensionPath, "dist", "native", "local-pty", key, binary);
}

export class LocalShellPty implements vscode.Pseudoterminal, SessionPtyHandle {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  private readonly outputObservers = new Set<PtyOutputObserver>();
  private readonly queuedInput: string[] = [];
  private readonly spawnSidecar: LocalPtySidecarSpawner;
  private sidecar?: LocalPtySidecarProcess;
  private stdoutBuffer = "";
  private state: LocalPtyState = "idle";
  private inputBlocked = false;
  private inputBlockNoticeArmed = false;

  public readonly onDidWrite = this.writeEmitter.event;
  public readonly onDidClose = this.closeEmitter.event;

  public constructor(private readonly options: LocalShellPtyOptions) {
    this.spawnSidecar = options.spawnSidecar ?? defaultSpawnSidecar;
  }

  public open(dimensions?: vscode.TerminalDimensions): void {
    if (this.state !== "idle") return;
    this.state = "spawning";
    this.log(`Starting ${this.options.terminalName}`);
    this.log(`Sidecar: ${this.options.sidecarPath}`);
    this.log(`Shell: ${this.options.shellPath}${this.options.shellArgs?.length ? ` ${this.options.shellArgs.join(" ")}` : ""}`);
    try {
      const sidecar = this.spawnSidecar(this.options.sidecarPath);
      this.sidecar = sidecar;
      sidecar.stdout.on("data", (chunk) => this.handleStdout(chunk));
      sidecar.stderr.on("data", (chunk) => this.handleStderr(chunk));
      sidecar.on("error", (error) => this.fail(error.message));
      sidecar.on("exit", (code) => this.handleExit(code));
      this.sendFrame({
        type: "spawn",
        shellPath: this.options.shellPath,
        shellArgs: this.options.shellArgs ?? [],
        cwd: this.options.cwd,
        env: this.options.env,
        rows: dimensions?.rows ?? 24,
        cols: dimensions?.columns ?? 80
      });
    } catch (error) {
      this.failBeforeReady(error instanceof Error ? error.message : String(error));
    }
  }

  public close(): void {
    this.dispose("closing");
  }

  public handleInput(data: string): void {
    if (this.inputBlocked) {
      if (this.inputBlockNoticeArmed) {
        this.writeEmitter.fire("\r\n[Nexus] Input is locked while a script is running.\r\n");
        this.inputBlockNoticeArmed = false;
      }
      return;
    }
    this.writeProgrammatic(data);
  }

  public setDimensions(dimensions: vscode.TerminalDimensions): void {
    if (this.state === "disposed" || this.state === "failed") return;
    this.sendFrame({
      type: "resize",
      rows: dimensions.rows,
      cols: dimensions.columns
    });
  }

  public addOutputObserver(observer: PtyOutputObserver): vscode.Disposable {
    this.outputObservers.add(observer);
    return new vscode.Disposable(() => {
      this.outputObservers.delete(observer);
    });
  }

  public setInputBlocked(blocked: boolean): void {
    this.inputBlocked = blocked;
    if (blocked) this.inputBlockNoticeArmed = true;
  }

  public writeProgrammatic(data: string): void {
    if (this.state === "idle" || this.state === "spawning") {
      this.queuedInput.push(data);
      return;
    }
    if (this.state !== "running") return;
    this.sendInput(data);
  }

  public resetTerminal(): void {
    this.writeEmitter.fire("\x1b[2J\x1b[3J\x1b[H");
  }

  public markShuttingDown(reason: string): void {
    if (this.state === "disposed" || this.state === "closing") return;
    this.state = "closing";
    this.pauseIntervalMacros();
    this.writeEmitter.fire(`\r\n[Nexus Local Shell] ${reason}\r\n`);
    this.writeEmitter.fire("[Nexus Local Shell] Close this terminal and reopen the profile to reconnect.\r\n");
    this.sendFrame({ type: "kill" });
    this.sidecar?.kill();
    this.sidecar = undefined;
  }

  private handleStdout(chunk: Buffer | string): void {
    this.stdoutBuffer += chunk.toString();
    if (this.stdoutBuffer.length > MAX_FRAME_LENGTH) {
      this.fail("Local PTY sidecar sent an oversized protocol frame.");
      return;
    }
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.handleFrameLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleFrameLine(line: string): void {
    let frame: LocalPtyFrame;
    try {
      frame = JSON.parse(line) as LocalPtyFrame;
    } catch {
      this.fail("Local PTY sidecar sent malformed JSON.");
      return;
    }

    switch (frame.type) {
      case "ready":
        if (this.state !== "spawning") return;
        this.state = "running";
        if (this.options.startupCommand) {
          this.queuedInput.unshift(startupCommandInput(this.options.startupCommand));
        }
        while (this.queuedInput.length > 0) {
          this.sendInput(this.queuedInput.shift() ?? "");
        }
        break;
      case "data": {
        const output = decodeBase64(frame.data);
        this.outputObservers.forEach((observer) => observer.onOutput(output));
        this.writeEmitter.fire(output);
        break;
      }
      case "exit":
        this.handleExit(typeof frame.code === "number" ? frame.code : 0);
        break;
      case "error":
        if (this.state === "spawning") {
          this.failBeforeReady(frame.message ?? "Local PTY sidecar failed before startup completed.");
        } else {
          this.fail(frame.message ?? "Local PTY sidecar failed.");
        }
        break;
      default:
        this.fail(`Local PTY sidecar sent unknown frame type "${frame.type}".`);
        break;
    }
  }

  private handleStderr(chunk: Buffer | string): void {
    const text = chunk.toString().trim();
    if (text) {
      this.log(`stderr: ${text}`);
      console.error(`[Nexus Local Shell] ${text}`);
    }
  }

  private handleExit(code: number | null): void {
    if (this.state === "disposed" || this.state === "exited" || this.state === "closing") return;
    if (this.state === "spawning") {
      this.failBeforeReady(`Local Shell sidecar exited before startup completed. Exit code: ${code ?? "unknown"}.`);
      return;
    }
    this.state = "exited";
    this.pauseIntervalMacros();
    this.disposeObservers();
    this.closeEmitter.fire(code ?? undefined);
  }

  private failBeforeReady(message: string): void {
    if (this.state === "disposed" || this.state === "failed") return;
    this.state = "failed";
    this.log(`Sidecar exited before ready: ${message}`);
    this.writeEmitter.fire(`\r\n[Nexus Local Shell Error] ${message}\r\n`);
    this.writeEmitter.fire(`[Nexus Local Shell] Sidecar: ${this.options.sidecarPath}\r\n`);
    this.writeEmitter.fire("[Nexus Local Shell] See the Nexus Local Shell output channel for startup details.\r\n");
    this.pauseIntervalMacros();
    this.disposeObservers();
    this.sidecar = undefined;
  }

  private fail(message: string): void {
    if (this.state === "disposed") return;
    this.state = "failed";
    this.log(`Failed: ${message}`);
    this.writeEmitter.fire(`\r\n[Nexus Local Shell Error] ${message}\r\n`);
    this.pauseIntervalMacros();
    this.disposeObservers();
    this.closeEmitter.fire(1);
  }

  private sendInput(data: string): void {
    if (!data) return;
    this.sendFrame({ type: "input", data: encodeBase64(data) });
  }

  private sendFrame(frame: Record<string, unknown>): void {
    this.sidecar?.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private log(message: string): void {
    this.options.outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private pauseIntervalMacros(): void {
    this.outputObservers.forEach((observer) => observer.pauseIntervalMacros());
  }

  private disposeObservers(): void {
    for (const observer of this.outputObservers) {
      observer.dispose();
    }
    this.outputObservers.clear();
  }

  private dispose(nextState: LocalPtyState): void {
    if (this.state === "disposed") return;
    this.state = nextState;
    this.pauseIntervalMacros();
    this.sendFrame({ type: "kill" });
    this.sidecar?.kill();
    this.sidecar = undefined;
    this.disposeObservers();
    this.state = "disposed";
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}
