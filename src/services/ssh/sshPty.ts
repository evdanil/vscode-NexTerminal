import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import * as vscode from "vscode";
import type { ServerConfig } from "../../models/config";
import type { SessionLogger } from "../../logging/terminalLogger";
import type { SessionTranscript } from "../../logging/sessionTranscriptLogger";
import type { SshConnection, SshFactory } from "./contracts";
import { hasContextAwareConnect } from "./contracts";
import { classifySshConnectionError } from "./connectionDiagnostics";
import type { TerminalHighlighter, TerminalHighlighterStream } from "../terminalHighlighter";
import type { PtyOutputObserver } from "../macroAutoTrigger";
import { CLEAR_VISIBLE_SCREEN } from "../terminal/terminalEscapes";
import { PtyObserverHub } from "../terminal/ptyObserverHub";
import { OscContextFilter } from "../terminal/oscContextFilter";
import { createAnsiRegex } from "../../utils/ansi";

// Pre-auth server messages (USERAUTH_BANNER, keyboard-interactive
// name/instructions) are attacker-controlled text rendered before any trust
// decision has been made. Strip ANSI escapes and C0 control chars (except
// \n, \r, \t) the same way TerminalCaptureBuffer does on ingest, so a
// malicious banner can't manipulate terminal state or spoof the prompt.
const AUTH_MESSAGE_ANSI_RE = createAnsiRegex();
const AUTH_MESSAGE_CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export interface SshPtyCallbacks {
  onSessionOpened(sessionId: string): void;
  onSessionClosed(sessionId: string): void;
  onDisconnected?(sessionId: string): void;
  onDataReceived?(sessionId: string): void;
  /**
   * REVIEW FINDING (P2) — the INITIAL connect attempt failed (auth refused,
   * host unreachable, proxy error). Optional and purely additive: the
   * error-handling contract around it is unchanged — the failure is still
   * swallowed here, the terminal is still left open holding the "Press any key
   * to close" notice, and `showErrorMessage` below still names the cause. This
   * exists because that is ALL that happens: no session is ever registered, the
   * pty is not disposed, and `closeEmitter` never fires, so a caller waiting on
   * "a session for this server appeared" has nothing else to observe and sits
   * out its whole watchdog (see `connectAndAwaitSessionTerminal`,
   * commands/serverMacroCommands.ts).
   *
   * Fires at most once per pty, and NEVER for a failed *reconnect* — that path
   * rethrows to `reconnect()` above, which owns its own reporting.
   */
  onConnectFailed?(sessionId: string, message: string): void;
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
    // Extension deactivate reaches the PTYs here. The transcript writer is
    // buffered, so anything still queued has to be forced out now.
    this.transcript?.flush?.();
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
    // The session can sit disconnected indefinitely (or be reconnected), so the
    // buffered transcript tail must reach disk at the moment of disconnect.
    this.transcript?.flush?.();
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
    // Relays live auth messages (USERAUTH_BANNER, keyboard-interactive
    // name/instructions — e.g. Duo's option menu) to the terminal while the
    // MFA popup is showing, instead of only the post-ready banner flush
    // below. Guarded against firing after dispose/shutdown or once a newer
    // connection attempt (reconnect) has superseded this one.
    const onAuthMessage = (text: string): void => {
      if (this.disposed || this.shuttingDown || generation !== this.connectionGeneration) {
        return;
      }
      AUTH_MESSAGE_ANSI_RE.lastIndex = 0;
      AUTH_MESSAGE_CONTROL_CHAR_RE.lastIndex = 0;
      const sanitized = text.replace(AUTH_MESSAGE_ANSI_RE, "").replace(AUTH_MESSAGE_CONTROL_CHAR_RE, "");
      if (!sanitized.trim()) {
        return;
      }
      // Normalize every CR variant (CRLF and lone CR) to LF first, then LF to
      // CRLF. A lone CR left un-normalized is bare carriage-return, which
      // VS Code's terminal treats as cursor-to-column-0 — server-controlled
      // pre-auth text could otherwise overwrite/spoof an already-rendered
      // line despite the ANSI/control-char stripping above.
      let normalized = sanitized.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
      if (!normalized.endsWith("\r\n")) {
        normalized += "\r\n";
      }
      this.writeEmitter.fire(normalized);
    };
    // ALTERNATE HOST (issue #48) — did the connection that actually opened come
    // from the alternate address? Set only when the fallback below is taken and
    // succeeds, so the confirmation banner names the winning address and only
    // then. `undefined` = primary won (the ordinary case, no banner).
    let connectedViaAltHost: string | undefined;
    try {
      // ALTERNATE HOST (issue #48) — try the primary `host`, then fall back once
      // to `altHost` on a CONNECTION-LEVEL failure only. Wrapped INSIDE the
      // existing try so a fallback attempt that also fails flows to the same
      // catch below as any other connect failure — the terminal is left open on
      // the "press any key" notice and `onConnectFailed` fires exactly once.
      const connectOnce = (cfg: ServerConfig): Promise<SshConnection> =>
        hasContextAwareConnect(this.sshFactory)
          ? this.sshFactory.connectWithContext(cfg, { onAuthMessage })
          : this.sshFactory.connect(cfg);

      // Blank / whitespace reads as "no alternate host", matching the form's
      // empty → undefined normalization and validation's tolerance of "".
      const altHost =
        typeof this.serverConfig.altHost === "string" && this.serverConfig.altHost.trim() !== ""
          ? this.serverConfig.altHost.trim()
          : undefined;

      try {
        connection = await connectOnce(this.serverConfig);
      } catch (primaryError) {
        // Fall back ONLY for a TCP/DNS-stage failure — unreachable, refused,
        // timed out, name-resolution failure. Auth / host-key / key / proxy
        // failures are NOT connection-level: the alternate address would just
        // re-fail the same way, and re-attempting could cost a second
        // credential prompt or trip a lockout, so those rethrow unchanged.
        const stage = classifySshConnectionError(primaryError).stage;
        // ssh2's `readyTimeout` ("Timed out while waiting for handshake") fires AFTER
        // the TCP socket has connected — the peer is reachable and the handshake/auth
        // may already be in flight (slow MFA / keyboard-interactive), so the alternate
        // address would not help and a retry could cost a second auth attempt or trip
        // a lockout. Only a PRE-connection timeout ("connect ETIMEDOUT") is a genuine
        // transport failure worth falling back on. Both currently classify as `tcp`,
        // so exclude the handshake timeout explicitly (PR #67 Codex round 1, P1).
        const primaryMessage = primaryError instanceof Error ? primaryError.message.toLowerCase() : "";
        const isHandshakeTimeout = primaryMessage.includes("timed out while waiting for handshake");
        const isConnectionLevel = (stage === "tcp" || stage === "dns") && !isHandshakeTimeout;
        // Hostname comparison is case-insensitive (PR #67 Codex round 3 P2b): DNS
        // names are case-insensitive, so an alternate that differs from the primary
        // only by casing (`example.com` vs `EXAMPLE.COM`) is the SAME endpoint and a
        // retry would be futile — risking a second credential prompt / lockout. Both
        // sides are trimmed + lower-cased before the equality check.
        const primaryHostNormalized =
          typeof this.serverConfig.host === "string" ? this.serverConfig.host.trim().toLowerCase() : "";
        const altHostIsPrimary = altHost !== undefined && altHost.toLowerCase() === primaryHostNormalized;
        if (
          !isConnectionLevel ||
          altHost === undefined ||
          altHostIsPrimary ||
          this.disposed ||
          this.shuttingDown ||
          generation !== this.connectionGeneration
        ) {
          // Auth/host-key/key/proxy, no alt configured, alt equals primary, or
          // this attempt was torn down/superseded → existing failure path.
          throw primaryError;
        }
        this.logger.log(`primary host unreachable (${stage}); trying altHost ${altHost}`);
        this.writeEmitter.fire(
          `\r\n[Nexus SSH] ${this.serverConfig.host} unreachable — trying alternate host ${altHost}…\r\n`
        );
        // KNOWN v1 LIMITATION — double prompt. For a password-auth server with
        // NO saved password, `SilentAuthSshFactory` prompts for the password
        // BEFORE the transport connects, so a primary TCP failure followed by
        // this altHost retry can prompt for the same password twice. Accepted
        // for v1: the fleet norm is saved-credential and key/agent servers,
        // which never hit it. The deferred fix is to centralize the fallback in
        // `SilentAuthSshFactory` (which would also cover tunnels and jump-hosts).
        connection = await connectOnce({ ...this.serverConfig, host: altHost });
        connectedViaAltHost = altHost;
      }
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

      // ALTERNATE HOST (issue #48) — surface WHICH address won, but only when the
      // fallback was actually taken (the primary-wins path is silent, unchanged).
      if (connectedViaAltHost !== undefined) {
        this.logger.log(`connected via alternate host ${connectedViaAltHost}`);
        this.writeEmitter.fire(`[Nexus SSH] Connected via alternate host ${connectedViaAltHost}.\r\n`);
      }

      const banner = connection.getBanner();
      if (banner) {
        const normalized = banner.replace(/\r?\n/g, "\r\n");
        this.writeEmitter.fire(normalized);
      }

      connection.onClose(() => this.handleDisconnect(generation));
      stream.on("data", (data: Buffer | string) => {
        const rawText = typeof data === "string" ? data : data.toString("utf8");
        const text = this.oscFilter.filter(rawText);
        this.logger.logOutput?.(`stdout ${JSON.stringify(text)}`);
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
      this.callbacks.onConnectFailed?.(this.sessionId, message);
      void vscode.window.showErrorMessage(`Nexus SSH connection failed for ${this.serverConfig.name}: ${message}`);
    }
  }
}
