import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import * as vscode from "vscode";
import type { ServerConfig } from "../../models/config";
import type { SessionLogger } from "../../logging/terminalLogger";
import type { SessionTranscript } from "../../logging/sessionTranscriptLogger";
import type { SshConnection, SshFactory } from "./contracts";
import type { TerminalHighlighter, TerminalHighlighterStream } from "../terminalHighlighter";
import type { PtyOutputObserver } from "../macroAutoTrigger";
import { CLEAR_VISIBLE_SCREEN } from "../terminal/terminalEscapes";
import { PtyObserverHub } from "../terminal/ptyObserverHub";
import { OscContextFilter } from "../terminal/oscContextFilter";

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
  private shuttingDown = false;
  private lastDimensions?: vscode.TerminalDimensions;
  private connectionGeneration = 0;
  private activityIndicator = false;
  private readonly highlighterStream?: TerminalHighlighterStream;

  private readonly observerHub: PtyObserverHub;
  private readonly oscFilter = new OscContextFilter();

  public constructor(
    private readonly serverConfig: ServerConfig,
    private readonly sshFactory: SshFactory,
    private readonly callbacks: SshPtyCallbacks,
    private readonly logger: SessionLogger,
    private readonly transcript?: SessionTranscript,
    private readonly highlighter?: TerminalHighlighter,
    outputObserver?: PtyOutputObserver,
    private readonly terminalType: string = "xterm-256color"
  ) {
    this.highlighterStream =
      typeof (highlighter as { createStream?: unknown } | undefined)?.createStream === "function"
        ? highlighter?.createStream((text) => this.writeEmitter.fire(text))
        : undefined;
    this.observerHub = new PtyObserverHub(outputObserver);
  }

  public addOutputObserver(observer: PtyOutputObserver): vscode.Disposable {
    return this.observerHub.addOutputObserver(observer);
  }

  public setInputBlocked(blocked: boolean): void {
    this.observerHub.setInputBlocked(blocked);
  }

  public writeProgrammatic(data: string): void {
    if (this.disposed || this.disconnected || this.connectFailed) return;
    this.stream?.write(data);
  }

  public resetTerminal(): void {
    if (this.disposed) return;
    this.writeEmitter.fire(CLEAR_VISIBLE_SCREEN);
  }

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
    if (this.shuttingDown) {
      return;
    }
    if (this.observerHub.isInputBlocked) {
      const notice = this.observerHub.consumeLockedNotice();
      if (notice) this.writeEmitter.fire(notice);
      return;
    }
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

  public markShuttingDown(reason: string): void {
    if (this.disposed || this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.observerHub.pauseIntervalMacros();
    this.highlighterStream?.flush();
    this.stream?.destroy();
    this.connection?.dispose();
    this.stream = undefined;
    this.connection = undefined;
    this.disconnected = true;
    this.activityIndicator = false;
    this.nameEmitter.fire(`${this.baseName} [Disconnected]`);
    this.writeEmitter.fire(`\r\n\r\n[Nexus SSH] ${reason}\r\n`);
    this.writeEmitter.fire("[Nexus SSH] Close this terminal and start a new session to reconnect.\r\n");
    this.logger.log(`marked shutting down: ${reason}`);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.oscFilter.reset();
    this.highlighterStream?.dispose();
    this.stream?.destroy();
    this.connection?.dispose();
    this.observerHub.disposeAll();
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
    this.observerHub.pauseIntervalMacros();
    this.disconnected = true;
    this.highlighterStream?.flush();
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
    if (this.disposed || this.shuttingDown || this.reconnecting) {
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
      if (!this.disposed && !this.shuttingDown) {
        this.disconnected = true;
        this.nameEmitter.fire(`${this.baseName} [Disconnected]`);
        this.writeEmitter.fire("[Nexus SSH] Press R to reconnect, Enter to close.\r\n");
      }
    }
  }

  private async start(dimensions?: vscode.TerminalDimensions): Promise<void> {
    const generation = ++this.connectionGeneration;
    // Clear any OSC-3008 carry held from a previous session so a partial
    // sequence stranded by a disconnect cannot prepend to this session's first
    // chunk. No-op on first connect; idempotent with the dispose() reset.
    this.oscFilter.reset();
    let connection: SshConnection | undefined;
    try {
      connection = await this.sshFactory.connect(this.serverConfig);
      if (this.disposed || this.shuttingDown || generation !== this.connectionGeneration) {
        connection.dispose();
        return;
      }

      const stream = await connection.openShell({
        term: this.terminalType,
        rows: dimensions?.rows,
        cols: dimensions?.columns
      });
      if (this.disposed || this.shuttingDown || generation !== this.connectionGeneration) {
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
        const rawText = typeof data === "string" ? data : data.toString("utf8");
        const text = this.oscFilter.filter(rawText);
        this.logger.log(`stdout ${JSON.stringify(text)}`);
        this.transcript?.write(text);
        this.observerHub.notifyOutput(text, this.highlighterStream, this.highlighter, (rendered) =>
          this.writeEmitter.fire(rendered)
        );
        this.callbacks.onDataReceived?.(this.sessionId);
      });
      stream.on("end", () => this.handleDisconnect(generation, "remote-closed"));
      stream.on("close", () => this.handleDisconnect(generation));
      stream.on("error", (error: Error) => {
        this.logger.log(`error ${error.message}`);
        this.highlighterStream?.flush();
        this.writeEmitter.fire(`\r\n[Nexus SSH Error] ${error.message}\r\n`);
        this.handleDisconnect(generation);
      });
    } catch (error) {
      if (connection && this.connection !== connection) {
        connection.dispose();
      }
      if (this.disposed || this.shuttingDown) {
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
