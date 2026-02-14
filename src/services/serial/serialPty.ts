import * as vscode from "vscode";
import type { SessionLogger } from "../../logging/terminalLogger";

export interface SerialTransport {
  openPort(path: string, baudRate: number): Promise<string>;
  writePort(sessionId: string, data: Buffer): Promise<void>;
  closePort(sessionId: string): Promise<void>;
  onDidReceiveData(listener: (sessionId: string, data: Buffer) => void): () => void;
  onDidReceiveError(listener: (sessionId: string, message: string) => void): () => void;
}

export interface SerialPtyOptions {
  path: string;
  baudRate: number;
}

export interface SerialPtyCallbacks {
  onSessionOpened(sessionId: string): void;
  onSessionClosed(sessionId: string): void;
}

export class SerialPty implements vscode.Pseudoterminal, vscode.Disposable {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private sidecarSessionId?: string;
  private dataSubscription?: () => void;
  private errorSubscription?: () => void;
  private disposed = false;

  public constructor(
    private readonly transport: SerialTransport,
    private readonly options: SerialPtyOptions,
    private readonly callbacks: SerialPtyCallbacks,
    private readonly logger: SessionLogger
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
    if (!this.sidecarSessionId) {
      return;
    }
    this.logger.log(`serial stdin ${JSON.stringify(data)}`);
    void this.transport.writePort(this.sidecarSessionId, Buffer.from(data, "utf8")).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown serial write error";
      this.writeEmitter.fire(`\r\n[Nexus Serial Error] ${message}\r\n`);
      this.logger.log(`serial write failed ${message}`);
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const sessionId = this.sidecarSessionId;
    this.sidecarSessionId = undefined;
    this.dataSubscription?.();
    this.errorSubscription?.();
    this.dataSubscription = undefined;
    this.errorSubscription = undefined;

    if (sessionId) {
      this.callbacks.onSessionClosed(sessionId);
      void this.transport.closePort(sessionId).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown serial close error";
        this.logger.log(`serial close failed ${message}`);
      });
    }

    this.logger.log("serial terminal closed");
    this.logger.close();
    this.closeEmitter.fire();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private async start(): Promise<void> {
    try {
      const sessionId = await this.transport.openPort(this.options.path, this.options.baudRate);
      if (this.disposed) {
        await this.transport.closePort(sessionId);
        return;
      }
      this.sidecarSessionId = sessionId;
      this.callbacks.onSessionOpened(sessionId);
      this.logger.log(`serial connected path=${this.options.path} baud=${this.options.baudRate}`);
      this.writeEmitter.fire(`\r\n[Nexus Serial] Connected ${this.options.path} @ ${this.options.baudRate}\r\n`);

      this.dataSubscription = this.transport.onDidReceiveData((eventSessionId, data) => {
        if (eventSessionId !== this.sidecarSessionId) {
          return;
        }
        const output = data.toString("utf8");
        this.logger.log(`serial stdout ${JSON.stringify(output)}`);
        this.writeEmitter.fire(output);
      });
      this.errorSubscription = this.transport.onDidReceiveError((eventSessionId, message) => {
        if (eventSessionId !== this.sidecarSessionId) {
          return;
        }
        this.logger.log(`serial port error ${message}`);
        this.writeEmitter.fire(`\r\n[Nexus Serial Error] ${message}\r\n`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown serial connection error";
      this.logger.log(`serial connect failed ${message}`);
      this.writeEmitter.fire(`\r\n[Nexus Serial] Connection failed: ${message}\r\n`);
      this.dispose();
    }
  }
}
