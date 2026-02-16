import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import * as vscode from "vscode";
import type { ServerConfig } from "../../models/config";
import type { SessionLogger } from "../../logging/terminalLogger";
import type { SessionTranscript } from "../../logging/sessionTranscriptLogger";
import type { SshConnection } from "./contracts";
import type { SilentAuthSshFactory } from "./silentAuth";

export interface SshPtyCallbacks {
  onSessionOpened(sessionId: string): void;
  onSessionClosed(sessionId: string): void;
}

export class SshPty implements vscode.Pseudoterminal, vscode.Disposable {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private readonly sessionId = randomUUID();
  private stream?: Duplex;
  private connection?: SshConnection;
  private disposed = false;
  private connectFailed = false;

  public constructor(
    private readonly serverConfig: ServerConfig,
    private readonly sshFactory: SilentAuthSshFactory,
    private readonly callbacks: SshPtyCallbacks,
    private readonly logger: SessionLogger,
    private readonly transcript?: SessionTranscript
  ) {}

  public readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  public readonly onDidClose: vscode.Event<void> = this.closeEmitter.event;

  public open(): void {
    void this.start();
  }

  public close(): void {
    this.dispose();
  }

  public handleInput(data: string): void {
    if (this.connectFailed) {
      this.dispose();
      return;
    }
    this.logger.log(`stdin ${JSON.stringify(data)}`);
    this.stream?.write(data);
  }

  public setDimensions(dimensions: vscode.TerminalDimensions): void {
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
    this.transcript?.close();
    this.logger.log("terminal closed");
    this.logger.close();
    this.writeEmitter.dispose();
    this.closeEmitter.fire();
    this.closeEmitter.dispose();
    this.callbacks.onSessionClosed(this.sessionId);
  }

  private async start(): Promise<void> {
    try {
      this.connection = await this.sshFactory.connect(this.serverConfig);
      this.stream = await this.connection.openShell();
      this.callbacks.onSessionOpened(this.sessionId);
      this.logger.log(`connected to ${this.serverConfig.name}`);

      this.connection.onClose(() => this.dispose());
      this.stream.on("data", (data: Buffer | string) => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        this.logger.log(`stdout ${JSON.stringify(text)}`);
        this.transcript?.write(text);
        this.writeEmitter.fire(text);
      });
      this.stream.on("close", () => this.dispose());
      this.stream.on("error", (error: Error) => {
        this.logger.log(`error ${error.message}`);
        this.writeEmitter.fire(`\r\n[Nexus SSH Error] ${error.message}\r\n`);
        this.dispose();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown SSH error";
      this.logger.log(`connect failed ${message}`);
      this.connectFailed = true;
      this.writeEmitter.fire(`\r\n[Nexus SSH] Connection failed: ${message}\r\n`);
      this.writeEmitter.fire("\r\n[Nexus SSH] Press any key to close this terminal.\r\n");
      void vscode.window.showErrorMessage(`Nexus SSH connection failed for ${this.serverConfig.name}: ${message}`);
    }
  }
}
