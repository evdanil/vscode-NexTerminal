import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import * as vscode from "vscode";
import type { ServerConfig } from "../../models/config";
import type { SessionLogger } from "../../logging/terminalLogger";
import type { SessionTranscript } from "../../logging/sessionTranscriptLogger";
import type { SshConnection, SshFactory } from "./contracts";
import type { TerminalHighlighter } from "../terminalHighlighter";
import type { PtyOutputObserver } from "../macroAutoTrigger";

export interface SshPtyCallbacks {
  onSessionOpened(sessionId: string): void;
  onSessionClosed(sessionId: string): void;
  onDisconnected?(sessionId: string): void;
  onDataReceived?(sessionId: string): void;
}

export class SshPty implements vscode.Pseudoterminal, vscode.Disposable {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private readonly nameEmitter = new vscode.EventEmitter<string>();
  private readonly sessionId = randomUUID();
  private stream?: Duplex;
  private connection?: SshConnection;
  private disposed = false;
  private disconnected = false;
  private reconnecting = false;
  private connectFailed = false;
  private lastDimensions?: vscode.TerminalDimensions;
  private connectionGeneration = 0;
  private activityIndicator = false;

  public constructor(
    private readonly serverConfig: ServerConfig,
    private readonly sshFactory: SshFactory,
    private readonly callbacks: SshPtyCallbacks,
    private readonly logger: SessionLogger,
    private readonly transcript?: SessionTranscript,
    private readonly highlighter?: TerminalHighlighter,
    private readonly outputObserver?: PtyOutputObserver,
    private readonly terminalType: string = "xterm-256color"
  ) {}

  public readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  public readonly onDidClose: vscode.Event<void> = this.closeEmitter.event;
  public readonly onDidChangeName: vscode.Event<string> = this.nameEmitter.event;

  private get baseName(): string {
    return `Nexus SSH: ${this.serverConfig.name}`;
  }

  public setActivityIndicator(active: boolean): void {
    if (this.activityIndicator === active || this.disposed || this.disconnected) {
      return;
    }
    this.activityIndicator = active;
    this.nameEmitter.fire(active ? `\u25cf ${this.baseName}` : this.baseName);
  }

  public open(initialDimensions?: vscode.TerminalDimensions): void {
    this.lastDimensions = initialDimensions;
    void this.start(initialDimensions);
  }

  public close(): void {
    this.dispose();
  }

  public handleInput(data: string): void {
    if (this.connectFailed) {
      this.dispose();
      return;
    }
    if (this.disconnected) {
      if (this.reconnecting) {
        return;
      }
      if (data === "r" || data === "R") {
        void this.reconnect();
      } else if (data === "\r") {
        this.dispose();
      }
      return;
    }
    this.stream?.write(data);
  }

  public setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.lastDimensions = dimensions;
    const channel = this.stream as { setWindow?: (rows: number, cols: number, height: number, width: number) => void };
    channel?.setWindow?.(dimensions.rows, dimensions.columns, 0, 0);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stream?.destroy();
    this.connection?.dispose();
    this.outputObserver?.dispose();
    this.transcript?.close();
    this.logger.log("terminal closed");
    this.logger.close();
    this.nameEmitter.dispose();
    this.writeEmitter.dispose();
    this.closeEmitter.fire();
    this.closeEmitter.dispose();
    this.callbacks.onSessionClosed(this.sessionId);
  }

  private handleDisconnect(
    generation: number,
    reason: "lost" | "remote-closed" = "lost"
  ): void {
    if (this.disposed || this.disconnected || generation !== this.connectionGeneration) {
      return;
    }
    this.outputObserver?.pauseIntervalMacros();
    this.disconnected = true;
    this.stream?.destroy();
    this.connection?.dispose();
    this.stream = undefined;
    this.connection = undefined;
    this.logger.log(
      reason === "remote-closed"
        ? "remote host closed the session - entering disconnected state"
        : "connection lost - entering disconnected state"
    );

    if (this.callbacks.onDisconnected) {
      this.callbacks.onDisconnected(this.sessionId);
    } else {
      this.callbacks.onSessionClosed(this.sessionId);
    }

    this.activityIndicator = false;
    this.nameEmitter.fire(`${this.baseName} [Disconnected]`);
    if (reason === "remote-closed") {
      this.writeEmitter.fire("\r\n\r\n[Nexus SSH] Remote host closed the session.\r\n");
    } else {
      this.writeEmitter.fire("\r\n\r\n[Nexus SSH] Connection lost.\r\n");
    }
    this.writeEmitter.fire("[Nexus SSH] Press R to reconnect, Enter to close.\r\n");
  }

  private async reconnect(): Promise<void> {
    if (this.disposed || this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    this.nameEmitter.fire(this.baseName);
    this.writeEmitter.fire("\r\n[Nexus SSH] Reconnecting...\r\n");
    this.logger.log("reconnecting");

    try {
      await this.start(this.lastDimensions);
      this.reconnecting = false;
    } catch {
      this.reconnecting = false;
      if (!this.disposed) {
        this.disconnected = true;
        this.nameEmitter.fire(`${this.baseName} [Disconnected]`);
        this.writeEmitter.fire("[Nexus SSH] Press R to reconnect, Enter to close.\r\n");
      }
    }
  }

  private async start(dimensions?: vscode.TerminalDimensions): Promise<void> {
    const generation = ++this.connectionGeneration;
    let connection: SshConnection | undefined;
    try {
      connection = await this.sshFactory.connect(this.serverConfig);
      if (this.disposed || generation !== this.connectionGeneration) {
        connection.dispose();
        return;
      }

      const stream = await connection.openShell({
        term: this.terminalType,
        rows: dimensions?.rows,
        cols: dimensions?.columns
      });
      if (this.disposed || generation !== this.connectionGeneration) {
        stream.destroy();
        connection.dispose();
        return;
      }
      this.connection = connection;
      this.stream = stream;
      this.disconnected = false;

      this.callbacks.onSessionOpened(this.sessionId);
      this.logger.log(`connected to ${this.serverConfig.name}`);

      const banner = connection.getBanner();
      if (banner) {
        const normalized = banner.replace(/\r?\n/g, "\r\n");
        this.writeEmitter.fire(normalized);
      }

      connection.onClose(() => this.handleDisconnect(generation));
      stream.on("data", (data: Buffer | string) => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        this.logger.log(`stdout ${JSON.stringify(text)}`);
        this.transcript?.write(text);
        this.outputObserver?.onOutput(text);
        this.callbacks.onDataReceived?.(this.sessionId);
        this.writeEmitter.fire(this.highlighter ? this.highlighter.apply(text) : text);
      });
      stream.on("end", () => this.handleDisconnect(generation, "remote-closed"));
      stream.on("close", () => this.handleDisconnect(generation));
      stream.on("error", (error: Error) => {
        this.logger.log(`error ${error.message}`);
        this.writeEmitter.fire(`\r\n[Nexus SSH Error] ${error.message}\r\n`);
        this.handleDisconnect(generation);
      });
    } catch (error) {
      if (connection && this.connection !== connection) {
        connection.dispose();
      }
      if (this.disposed) {
        return;
      }
      const message = error instanceof Error ? error.message : "unknown SSH error";
      this.logger.log(`connect failed ${message}`);
      if (this.reconnecting) {
        this.writeEmitter.fire(`[Nexus SSH] Reconnection failed: ${message}\r\n`);
        throw error;
      }
      this.connectFailed = true;
      this.writeEmitter.fire(`\r\n[Nexus SSH] Connection failed: ${message}\r\n`);
      this.writeEmitter.fire("\r\n[Nexus SSH] Press any key to close this terminal.\r\n");
      void vscode.window.showErrorMessage(`Nexus SSH connection failed for ${this.serverConfig.name}: ${message}`);
    }
  }
}
