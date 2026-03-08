import * as vscode from "vscode";
import type { SessionLogger } from "../../logging/terminalLogger";
import type { SessionTranscript } from "../../logging/sessionTranscriptLogger";
import type { TerminalHighlighter } from "../terminalHighlighter";
import type { PtyOutputObserver } from "../macroAutoTrigger";
import { toParityCode } from "../../utils/helpers";
import type { OpenPortParams } from "./protocol";

export interface SerialTransport {
  openPort(options: OpenPortParams): Promise<string>;
  writePort(sessionId: string, data: Buffer): Promise<void>;
  closePort(sessionId: string): Promise<void>;
  onDidReceiveData(listener: (sessionId: string, data: Buffer) => void): () => void;
  onDidReceiveError(listener: (sessionId: string, message: string) => void): () => void;
  onDidDisconnect(listener: (sessionId: string, reason: string) => void): () => void;
}

export type SerialPtyOptions = OpenPortParams;

export interface SerialPtyCallbacks {
  onSessionOpened(sessionId: string): void;
  onSessionClosed(sessionId: string): void;
  onDataReceived?(sessionId: string): void;
}

export class SerialPty implements vscode.Pseudoterminal, vscode.Disposable {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private readonly nameEmitter = new vscode.EventEmitter<string>();
  private sidecarSessionId?: string;
  private dataSubscription?: () => void;
  private errorSubscription?: () => void;
  private disconnectSubscription?: () => void;
  private disposed = false;
  private disconnected = false;
  private failed = false;
  private activityIndicator = false;

  public constructor(
    private readonly transport: SerialTransport,
    private readonly options: SerialPtyOptions,
    private readonly callbacks: SerialPtyCallbacks,
    private readonly logger: SessionLogger,
    private readonly transcript?: SessionTranscript,
    private readonly highlighter?: TerminalHighlighter,
    private readonly outputObserver?: PtyOutputObserver
  ) {}

  public readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  public readonly onDidClose: vscode.Event<void> = this.closeEmitter.event;
  public readonly onDidChangeName: vscode.Event<string> = this.nameEmitter.event;

  private get baseName(): string {
    return `Nexus Serial: ${this.options.path}`;
  }

  public setActivityIndicator(active: boolean): void {
    if (this.activityIndicator === active || this.disposed || this.disconnected) {
      return;
    }
    this.activityIndicator = active;
    this.nameEmitter.fire(active ? `● ${this.baseName}` : this.baseName);
  }

  public open(): void {
    void this.start();
  }

  public close(): void {
    this.dispose();
  }

  public handleInput(data: string): void {
    if (this.failed || this.disconnected) {
      this.dispose();
      return;
    }
    if (!this.sidecarSessionId) {
      return;
    }
    void this.transport.writePort(this.sidecarSessionId, Buffer.from(data, "utf8")).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown serial write error";
      this.logger.log(`serial write failed ${message}`);
      if (message.includes("unknown serial session")) {
        this.handleDisconnect("Port no longer available");
      } else {
        this.writeEmitter.fire(`\r\n[Nexus Serial Error] ${message}\r\n`);
      }
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.outputObserver?.dispose();

    const sessionId = this.releaseSubscriptions();

    if (sessionId) {
      this.callbacks.onSessionClosed(sessionId);
      void this.transport.closePort(sessionId).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown serial close error";
        this.logger.log(`serial close failed ${message}`);
      });
    }

    this.transcript?.close();
    this.logger.log("serial terminal closed");
    this.logger.close();
    this.nameEmitter.dispose();
    this.closeEmitter.fire();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  /** Clear sidecar session and event subscriptions; returns the former session ID. */
  private releaseSubscriptions(): string | undefined {
    const sessionId = this.sidecarSessionId;
    this.sidecarSessionId = undefined;
    this.dataSubscription?.();
    this.errorSubscription?.();
    this.disconnectSubscription?.();
    this.dataSubscription = undefined;
    this.errorSubscription = undefined;
    this.disconnectSubscription = undefined;
    return sessionId;
  }

  private handleDisconnect(message: string): void {
    if (this.disposed || this.disconnected) {
      return;
    }
    this.disconnected = true;

    const sessionId = this.releaseSubscriptions();

    this.logger.log(`serial port disconnected: ${message}`);

    if (sessionId) {
      this.callbacks.onSessionClosed(sessionId);
    }

    this.activityIndicator = false;
    this.nameEmitter.fire(`${this.baseName} [Disconnected]`);
    this.writeEmitter.fire(`\r\n\r\n[Nexus Serial] Port disconnected.\r\n`);
    this.writeEmitter.fire("[Nexus Serial] Press any key to close this terminal.\r\n");
  }

  private async start(): Promise<void> {
    try {
      const sessionId = await this.transport.openPort(this.options);
      if (this.disposed) {
        await this.transport.closePort(sessionId);
        return;
      }
      this.sidecarSessionId = sessionId;
      this.callbacks.onSessionOpened(sessionId);
      this.logger.log(
        `serial connected path=${this.options.path} baud=${this.options.baudRate} parity=${this.options.parity ?? "none"} dataBits=${this.options.dataBits ?? 8} stopBits=${this.options.stopBits ?? 1} rtscts=${this.options.rtscts ? "on" : "off"}`
      );
      this.writeEmitter.fire(
        `\r\n[Nexus Serial] Connected ${this.options.path} @ ${this.options.baudRate} (${this.options.dataBits ?? 8}${toParityCode(this.options.parity)}${this.options.stopBits ?? 1})\r\n`
      );

      this.dataSubscription = this.transport.onDidReceiveData((eventSessionId, data) => {
        if (eventSessionId !== this.sidecarSessionId) {
          return;
        }
        const output = data.toString("utf8");
        this.logger.log(`serial stdout ${JSON.stringify(output)}`);
        this.transcript?.write(output);
        this.outputObserver?.onOutput(output);
        this.callbacks.onDataReceived?.(eventSessionId);
        this.writeEmitter.fire(this.highlighter ? this.highlighter.apply(output) : output);
      });
      this.errorSubscription = this.transport.onDidReceiveError((eventSessionId, errorMessage) => {
        if (eventSessionId !== this.sidecarSessionId) {
          return;
        }
        this.logger.log(`serial port error ${errorMessage}`);
        this.writeEmitter.fire(`\r\n[Nexus Serial Error] ${errorMessage}\r\n`);
      });
      this.disconnectSubscription = this.transport.onDidDisconnect((eventSessionId, reason) => {
        if (eventSessionId !== this.sidecarSessionId) {
          return;
        }
        this.handleDisconnect(reason);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown serial connection error";
      this.logger.log(`serial connect failed ${message}`);
      this.writeEmitter.fire(`\r\n[Nexus Serial] Connection failed: ${message}\r\n\r\nPress any key to close.\r\n`);
      this.failed = true;
    }
  }

}
