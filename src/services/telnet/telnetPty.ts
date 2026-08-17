import { randomUUID } from "node:crypto";
import * as net from "node:net";
import { StringDecoder } from "node:string_decoder";
import * as vscode from "vscode";
import type { ServerConfig } from "../../models/config";
import type { SessionLogger } from "../../logging/terminalLogger";
import type { SessionTranscript } from "../../logging/sessionTranscriptLogger";
import type { TerminalHighlighter, TerminalHighlighterStream } from "../terminalHighlighter";
import type { PtyOutputObserver } from "../macroAutoTrigger";
import { CLEAR_VISIBLE_SCREEN } from "../terminal/terminalEscapes";
import { PtyObserverHub } from "../terminal/ptyObserverHub";
import { TelnetNegotiator } from "./telnetProtocol";

/** How long to wait for the TCP connection before giving up. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * The slice of `net.Socket` this pty uses. Narrowed to an interface purely so
 * the unit tests can drive the whole lifecycle without a listener — the same
 * reason `SerialPty` takes a `SerialTransport` rather than reaching for the
 * sidecar itself.
 */
export interface TelnetSocket {
  on(event: "connect", listener: () => void): TelnetSocket;
  on(event: "data", listener: (chunk: Buffer) => void): TelnetSocket;
  on(event: "error", listener: (error: Error) => void): TelnetSocket;
  on(event: "close", listener: () => void): TelnetSocket;
  write(data: Buffer): boolean;
  destroy(): void;
  setNoDelay(noDelay: boolean): void;
}

export type TelnetSocketFactory = (options: { host: string; port: number }) => TelnetSocket;

export interface TelnetPtyCallbacks {
  onSessionOpened(sessionId: string): void;
  onSessionClosed(sessionId: string): void;
  /** Preferred over `onSessionClosed` on a LOST connection; see SshPtyCallbacks. */
  onDisconnected?(sessionId: string): void;
  onDataReceived?(sessionId: string): void;
  /** The INITIAL connect attempt failed; the tab stays open on the press-any-key notice. */
  onConnectFailed?(sessionId: string, message: string): void;
}

export interface TelnetPtyOptions {
  transcript?: SessionTranscript;
  highlighter?: TerminalHighlighter;
  outputObserver?: PtyOutputObserver;
  /** Answered to a TERMINAL-TYPE subnegotiation. Defaults to `xterm-256color`. */
  terminalType?: string;
  /** Injection point for tests; production uses `net.createConnection`. */
  socketFactory?: TelnetSocketFactory;
}

/**
 * A raw telnet terminal — the third transport beside SSH and Serial, and a
 * `SessionPtyHandle` on exactly the same terms as the other two, so highlighting,
 * the capture buffer, terminal tab commands, macros and scripts all work against
 * it without knowing which transport they are looking at.
 *
 * NO AUTHENTICATION AND NO TRANSPORT SECURITY, deliberately: telnet has neither.
 * Nothing here touches the password vault or the auth-profile machinery — a
 * telnet server logs in at the device's own prompt, in the terminal, like it does
 * from any other telnet client. The use case is lab gear and virtual-console
 * servers on a management network, which is where the protocol still lives.
 *
 * The IAC protocol itself is in `telnetProtocol.ts` (pure, no vscode) — this
 * class owns only the socket, the terminal surface and the session lifecycle.
 */
export class TelnetPty implements vscode.Pseudoterminal, vscode.Disposable {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private readonly nameEmitter = new vscode.EventEmitter<string>();
  private readonly sessionId = randomUUID();
  private readonly negotiator: TelnetNegotiator;
  /**
   * Stateful UTF-8 decode. A multibyte character split across two TCP segments
   * would otherwise render as two replacement characters — likelier here than on
   * SSH, where the transport already frames its own packets.
   */
  private readonly decoder = new StringDecoder("utf8");
  private readonly socketFactory: TelnetSocketFactory;

  private socket?: TelnetSocket;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private connected = false;
  private disposed = false;
  private disconnected = false;
  private connectFailed = false;
  private shuttingDown = false;
  private activityIndicator = false;
  private readonly highlighterStream?: TerminalHighlighterStream;
  private readonly observerHub: PtyObserverHub;

  public constructor(
    private readonly serverConfig: ServerConfig,
    private readonly callbacks: TelnetPtyCallbacks,
    private readonly logger: SessionLogger,
    private readonly options: TelnetPtyOptions = {}
  ) {
    const highlighter = options.highlighter;
    this.highlighterStream =
      typeof (highlighter as { createStream?: unknown } | undefined)?.createStream === "function"
        ? highlighter?.createStream((text) => this.writeEmitter.fire(text))
        : undefined;
    this.observerHub = new PtyObserverHub(options.outputObserver);
    this.negotiator = new TelnetNegotiator({ terminalType: options.terminalType });
    this.socketFactory =
      options.socketFactory ??
      ((opts) => net.createConnection({ host: opts.host, port: opts.port }) as unknown as TelnetSocket);
  }

  public addOutputObserver(observer: PtyOutputObserver): vscode.Disposable {
    return this.observerHub.addOutputObserver(observer);
  }

  public setInputBlocked(blocked: boolean): void {
    this.observerHub.setInputBlocked(blocked);
  }

  /**
   * Script writes. Bypasses the input lock (scripts own it) and goes through the
   * same NVT newline translation and IAC escaping keystrokes do, so a script and
   * a human typing the same line put the same bytes on the wire.
   */
  public writeProgrammatic(data: string): void {
    this.sendToSocket(data);
  }

  public resetTerminal(): void {
    if (this.disposed) return;
    this.writeEmitter.fire(CLEAR_VISIBLE_SCREEN);
  }

  public readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  public readonly onDidClose: vscode.Event<void> = this.closeEmitter.event;
  public readonly onDidChangeName: vscode.Event<string> = this.nameEmitter.event;

  private get baseName(): string {
    return `Nexus Telnet: ${this.serverConfig.name}`;
  }

  private get endpoint(): string {
    return `${this.serverConfig.host}:${this.serverConfig.port}`;
  }

  public setActivityIndicator(active: boolean): void {
    if (this.activityIndicator === active || this.disposed || this.disconnected) {
      return;
    }
    this.activityIndicator = active;
    this.nameEmitter.fire(active ? `● ${this.baseName}` : this.baseName);
  }

  public open(initialDimensions?: vscode.TerminalDimensions): void {
    if (initialDimensions) {
      // Recorded, not sent: NAWS may only be volunteered after the server has
      // asked for it (`DO NAWS`), which has not happened yet.
      this.negotiator.setWindowSize(initialDimensions.columns, initialDimensions.rows);
    }
    this.start();
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
    if (this.connectFailed || this.disconnected) {
      // Nothing to reconnect to — telnet has no session to resume, so the
      // press-any-key notice means exactly that (mirrors SerialPty).
      this.dispose();
      return;
    }
    this.sendToSocket(data);
  }

  public setDimensions(dimensions: vscode.TerminalDimensions): void {
    const naws = this.negotiator.setWindowSize(dimensions.columns, dimensions.rows);
    if (naws.length > 0 && this.connected && !this.disconnected && !this.disposed) {
      this.socket?.write(naws);
    }
  }

  public markShuttingDown(reason: string): void {
    if (this.disposed || this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.disconnected = true;
    this.observerHub.pauseIntervalMacros();
    this.highlighterStream?.flush();
    // Extension deactivate reaches the PTYs here — force the buffered transcript
    // tail to disk before the host goes away.
    this.options.transcript?.flush?.();
    this.teardownSocket();
    this.activityIndicator = false;
    this.nameEmitter.fire(`${this.baseName} [Disconnected]`);
    this.writeEmitter.fire(`\r\n\r\n[Nexus Telnet] ${reason}\r\n`);
    this.writeEmitter.fire("[Nexus Telnet] Close this terminal and connect again to reopen the session.\r\n");
    this.logger.log(`marked shutting down: ${reason}`);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.highlighterStream?.dispose();
    this.teardownSocket();
    this.observerHub.disposeAll();
    this.options.transcript?.close();
    this.logger.log("telnet terminal closed");
    this.logger.close();
    this.nameEmitter.dispose();
    this.writeEmitter.dispose();
    this.closeEmitter.fire();
    this.closeEmitter.dispose();
    this.callbacks.onSessionClosed(this.sessionId);
  }

  /** Destroy the socket and cancel the connect watchdog; safe to call twice. */
  private teardownSocket(): void {
    if (this.connectTimer !== undefined) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    this.socket?.destroy();
    this.socket = undefined;
  }

  private sendToSocket(data: string): void {
    if (this.disposed || this.disconnected || this.connectFailed || !this.connected) {
      return;
    }
    this.socket?.write(this.negotiator.encodeOutgoing(data));
  }

  private start(): void {
    const socket = this.socketFactory({ host: this.serverConfig.host, port: this.serverConfig.port });
    this.socket = socket;
    socket.setNoDelay(true);

    // A watchdog rather than `socket.setTimeout`: an unroutable address leaves
    // the OS retrying for minutes with nothing on screen, and an idle *session*
    // must never be torn down, which is what a socket timeout would also do.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined;
      if (this.connected || this.disposed || this.shuttingDown) {
        return;
      }
      this.failConnect(`connection to ${this.endpoint} timed out after ${CONNECT_TIMEOUT_MS / 1000}s`);
    }, CONNECT_TIMEOUT_MS);

    socket.on("connect", () => {
      if (this.disposed || this.shuttingDown) {
        socket.destroy();
        return;
      }
      if (this.connectTimer !== undefined) {
        clearTimeout(this.connectTimer);
        this.connectTimer = undefined;
      }
      this.connected = true;
      this.callbacks.onSessionOpened(this.sessionId);
      this.logger.log(`telnet connected ${this.endpoint}`);
      this.writeEmitter.fire(`\r\n[Nexus Telnet] Connected ${this.endpoint}\r\n`);
    });

    socket.on("data", (chunk: Buffer) => this.handleSocketData(chunk));

    socket.on("error", (error: Error) => {
      if (this.disposed || this.shuttingDown) {
        return;
      }
      if (!this.connected) {
        this.failConnect(error.message);
        return;
      }
      this.logger.log(`telnet socket error ${error.message}`);
      this.highlighterStream?.flush();
      this.writeEmitter.fire(`\r\n[Nexus Telnet Error] ${error.message}\r\n`);
      this.handleDisconnect();
    });

    socket.on("close", () => {
      if (this.disposed || this.shuttingDown || !this.connected) {
        return;
      }
      this.handleDisconnect();
    });
  }

  private handleSocketData(chunk: Buffer): void {
    if (this.disposed || this.shuttingDown) {
      return;
    }
    const { data, response } = this.negotiator.receive(chunk);
    if (response.length > 0) {
      this.socket?.write(response);
    }
    // Observers must never see protocol bytes: a script `waitFor` or a macro
    // trigger looking for a prompt would otherwise miss a match that IS on
    // screen, because the negotiation landed in the middle of it.
    const text = this.decoder.write(data);
    if (text.length === 0) {
      return;
    }
    this.logger.logOutput?.(`telnet stdout ${JSON.stringify(text)}`);
    this.options.transcript?.write(text);
    this.observerHub.notifyOutput(text, this.highlighterStream, this.options.highlighter, (rendered) =>
      this.writeEmitter.fire(rendered)
    );
    this.callbacks.onDataReceived?.(this.sessionId);
  }

  /** The INITIAL connect never came up: report, keep the tab, register nothing. */
  private failConnect(message: string): void {
    if (this.connectFailed) {
      return;
    }
    this.connectFailed = true;
    this.teardownSocket();
    this.logger.log(`telnet connect failed ${message}`);
    this.writeEmitter.fire(`\r\n[Nexus Telnet] Connection failed: ${message}\r\n`);
    this.writeEmitter.fire("\r\n[Nexus Telnet] Press any key to close this terminal.\r\n");
    this.callbacks.onConnectFailed?.(this.sessionId, message);
    void vscode.window.showErrorMessage(
      `Nexus Telnet connection failed for ${this.serverConfig.name}: ${message}`
    );
  }

  private handleDisconnect(): void {
    if (this.disposed || this.disconnected) {
      return;
    }
    this.observerHub.pauseIntervalMacros();
    this.disconnected = true;
    this.highlighterStream?.flush();
    // The session can sit disconnected indefinitely, so the buffered transcript
    // tail must reach disk at the moment of disconnect.
    this.options.transcript?.flush?.();
    this.teardownSocket();
    this.logger.log("telnet connection closed - entering disconnected state");

    if (this.callbacks.onDisconnected) {
      this.callbacks.onDisconnected(this.sessionId);
    } else {
      this.callbacks.onSessionClosed(this.sessionId);
    }

    this.activityIndicator = false;
    this.nameEmitter.fire(`${this.baseName} [Disconnected]`);
    this.writeEmitter.fire("\r\n\r\n[Nexus Telnet] Remote host closed the connection.\r\n");
    this.writeEmitter.fire("[Nexus Telnet] Press any key to close this terminal.\r\n");
  }
}
