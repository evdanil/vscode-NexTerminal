import * as vscode from "vscode";
import type { SerialDeviceHint, SerialProfile, SerialSessionStatus } from "../../models/config";
import type { SessionLogger } from "../../logging/terminalLogger";
import type { SessionTranscript } from "../../logging/sessionTranscriptLogger";
import type { TerminalHighlighter, TerminalHighlighterStream } from "../terminalHighlighter";
import type { PtyOutputObserver } from "../macroAutoTrigger";
import { toParityCode } from "../../utils/helpers";
import type { SerialTransport } from "./serialPty";
import { isSerialRuntimeMissingError } from "./errorMatchers";
import type { OpenPortParams, SerialPortInfo } from "./protocol";

const SMART_FOLLOW_POLL_MS = 2000;
const STOPPED_INPUT_HINT_INTERVAL_MS = 1000;

/** Normalize a serial port path for case-insensitive comparison on Windows. */
export function normalizePortPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export interface SmartSerialTransport extends SerialTransport {
  listPorts(): Promise<SerialPortInfo[]>;
}

export interface SmartFollowPromptInput {
  profileName: string;
  preferredPath: string;
  preferredStatus: "missing" | "busy";
  hintMatches: SerialPortInfo[];
  otherCandidates: SerialPortInfo[];
  hasHint: boolean;
  reason: "initial" | "mid-session" | "poll";
}

export type SmartFollowPromptResult =
  | { kind: "connect"; port: SerialPortInfo }
  | { kind: "wait" };

export interface SmartSerialPtyCallbacks {
  onClosed(): void;
  onDataReceived?(): void;
  onTransportSessionChanged?(sessionId?: string): void;
  onResolvedPort?(path: string, deviceHint?: SerialDeviceHint): Promise<void> | void;
  onStateChanged?(status: SerialSessionStatus): void;
  /** Notification only — must NOT dispose the PTY or close the terminal. */
  onFatalError?(message: string): void;
  /** Synchronously returns paths currently held by other extension serial sessions (excluding self). */
  getBusyPaths(): Set<string>;
  /** Show a picker to the user. Lives in the command layer so the PTY has no VS Code UI dependency beyond events. */
  promptPortChoice(input: SmartFollowPromptInput): Promise<SmartFollowPromptResult>;
  /** Tells the command layer the current active path so SerialTerminalEntry.activePath can be kept in sync. */
  onActivePortChanged?(path?: string): void;
}

function mergeDeviceHint(existing: SerialDeviceHint | undefined, port: SerialPortInfo | undefined): SerialDeviceHint | undefined {
  const next: SerialDeviceHint = {
    manufacturer: port?.manufacturer ?? existing?.manufacturer,
    serialNumber: port?.serialNumber ?? existing?.serialNumber,
    vendorId: port?.vendorId ?? existing?.vendorId,
    productId: port?.productId ?? existing?.productId
  };
  return next.manufacturer || next.serialNumber || next.vendorId || next.productId ? next : undefined;
}

function matchesDeviceHint(port: SerialPortInfo, hint: SerialDeviceHint | undefined): boolean {
  if (!hint) {
    return false;
  }
  if (!hint.manufacturer && !hint.serialNumber && !hint.vendorId && !hint.productId) {
    return false;
  }
  return (
    (hint.manufacturer === undefined || port.manufacturer === hint.manufacturer) &&
    (hint.serialNumber === undefined || port.serialNumber === hint.serialNumber) &&
    (hint.vendorId === undefined || port.vendorId === hint.vendorId) &&
    (hint.productId === undefined || port.productId === hint.productId)
  );
}

export class SmartSerialPty implements vscode.Pseudoterminal, vscode.Disposable {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private readonly nameEmitter = new vscode.EventEmitter<string>();
  private transportSessionId?: string;
  private currentPath?: string;
  private preferredPath: string;
  private deviceHint?: SerialDeviceHint;
  private disposed = false;
  private waiting = false;
  private connecting = false;
  /** A picker is awaiting user input — re-entrant calls bail out so the poll timer can't open a second prompt. */
  private prompting = false;
  /** Sticky unrecoverable state. Tab stays open; polling stopped; only manual close disposes. */
  private stopped = false;
  private activityIndicator = false;
  private hasEverConnected = false;
  private lastWaitingKey?: string;
  /** Debounce key for `promptPortChoice` so we don't re-prompt every poll tick with the same candidate set. */
  private lastPromptedKey?: string;
  /** Timestamp of the last "session stopped" hint echoed in handleInput, for 1s debouncing. */
  private lastStoppedHintAt = 0;
  private pollTimer?: ReturnType<typeof setInterval>;
  private readonly highlighterStream?: TerminalHighlighterStream;
  private readonly unsubscribeData: () => void;
  private readonly unsubscribeError: () => void;
  private readonly unsubscribeDisconnect: () => void;

  private readonly outputObservers = new Set<PtyOutputObserver>();
  private inputBlocked = false;
  private inputBlockNoticeArmed = true;

  public constructor(
    private readonly transport: SmartSerialTransport,
    private readonly profile: SerialProfile,
    private readonly callbacks: SmartSerialPtyCallbacks,
    private readonly logger: SessionLogger,
    private readonly transcript?: SessionTranscript,
    private readonly highlighter?: TerminalHighlighter,
    outputObserver?: PtyOutputObserver
  ) {
    if (outputObserver) this.outputObservers.add(outputObserver);
    this.preferredPath = profile.path;
    this.deviceHint = profile.deviceHint;
    this.highlighterStream =
      typeof (highlighter as { createStream?: unknown } | undefined)?.createStream === "function"
        ? highlighter?.createStream((text) => this.writeEmitter.fire(text))
        : undefined;
    this.unsubscribeData = this.transport.onDidReceiveData((sessionId, data) => {
      if (sessionId !== this.transportSessionId) {
        return;
      }
      const output = data.toString("utf8");
      this.logger.log(`smart serial stdout ${JSON.stringify(output)}`);
      this.transcript?.write(output);
      this.outputObservers.forEach((o) => o.onOutput(output));
      this.callbacks.onDataReceived?.();
      if (this.highlighterStream) {
        this.highlighterStream.push(output);
      } else {
        this.writeEmitter.fire(this.highlighter ? this.highlighter.apply(output) : output);
      }
    });
    this.unsubscribeError = this.transport.onDidReceiveError((sessionId, message) => {
      if (sessionId !== this.transportSessionId) {
        return;
      }
      this.logger.log(`smart serial port error ${message}`);
      this.highlighterStream?.flush();
      this.writeEmitter.fire(`\r\n[Nexus Serial Error] ${message}\r\n`);
    });
    this.unsubscribeDisconnect = this.transport.onDidDisconnect((sessionId, reason) => {
      if (sessionId !== this.transportSessionId) {
        return;
      }
      this.handleTransportDisconnect(reason);
    });
  }

  public readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  public readonly onDidClose: vscode.Event<void> = this.closeEmitter.event;
  public readonly onDidChangeName: vscode.Event<string> = this.nameEmitter.event;

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
    if (this.disposed || this.stopped || !this.transportSessionId) return;
    void this.transport.writePort(this.transportSessionId, Buffer.from(data, "utf8")).catch(() => {
      /* best-effort; ConnectionLost surfaces via NexusCore.onDidChange */
    });
  }

  private get terminalNameBase(): string {
    return `Nexus Serial: ${this.profile.name} [Smart Follow]`;
  }

  private get openPortOptions(): OpenPortParams {
    return {
      path: this.preferredPath,
      baudRate: this.profile.baudRate,
      dataBits: this.profile.dataBits,
      stopBits: this.profile.stopBits,
      parity: this.profile.parity,
      rtscts: this.profile.rtscts
    };
  }

  public setActivityIndicator(active: boolean): void {
    if (this.activityIndicator === active || this.disposed) {
      return;
    }
    this.activityIndicator = active;
    this.nameEmitter.fire(this.buildDisplayName());
  }

  public open(): void {
    this.writeBanner(`Smart Follow is active. Preferred port ${this.preferredPath}.`);
    this.nameEmitter.fire(this.buildDisplayName());
    void this.ensureConnected("initial");
  }

  public close(): void {
    this.dispose();
  }

  public handleInput(data: string): void {
    if (this.inputBlocked) {
      if (this.inputBlockNoticeArmed) {
        this.inputBlockNoticeArmed = false;
        this.writeEmitter.fire("\r\n[Nexus] Terminal is locked while a script is running. Stop the script to send input.\r\n");
      }
      return;
    }
    if (this.stopped) {
      const now = Date.now();
      if (now - this.lastStoppedHintAt >= STOPPED_INPUT_HINT_INTERVAL_MS) {
        this.lastStoppedHintAt = now;
        this.writeEmitter.fire("\r\n[Nexus Smart Follow] Session stopped. Close the terminal to exit.\r\n");
      }
      return;
    }
    if (!this.transportSessionId) {
      return;
    }
    void this.transport.writePort(this.transportSessionId, Buffer.from(data, "utf8")).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown serial write error";
      this.logger.log(`smart serial write failed ${message}`);
      if (message.includes("unknown serial session")) {
        this.handleTransportDisconnect("Port no longer available");
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
    this.stopPolling();
    this.highlighterStream?.dispose();
    this.outputObservers.forEach((o) => {
      try {
        o.dispose();
      } catch {
        /* tolerate misbehaving observer */
      }
    });
    this.outputObservers.clear();
    this.unsubscribeData();
    this.unsubscribeError();
    this.unsubscribeDisconnect();
    const sessionId = this.transportSessionId;
    this.transportSessionId = undefined;
    this.callbacks.onTransportSessionChanged?.(undefined);
    this.callbacks.onActivePortChanged?.(undefined);
    if (sessionId) {
      void this.transport.closePort(sessionId).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown serial close error";
        this.logger.log(`smart serial close failed ${message}`);
      });
    }
    this.transcript?.close();
    this.logger.log("smart serial terminal closed");
    this.logger.close();
    this.nameEmitter.dispose();
    this.closeEmitter.fire();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this.callbacks.onClosed();
  }

  private async ensureConnected(reason: "initial" | "poll" | "disconnect"): Promise<void> {
    if (this.disposed || this.stopped || this.connecting || this.prompting) {
      return;
    }
    this.connecting = true;
    try {
      const previousPreferredPath = this.preferredPath;

      // 1. List ports and gather state. Note: we list FIRST so we can filter busy ports
      // before attempting to open the preferred path. This avoids stepping on another
      // session that already owns the port.
      const portResult = await this.listPortsResult();
      if (this.disposed || this.stopped) {
        return;
      }
      if ("error" in portResult) {
        if (isSerialRuntimeMissingError(portResult.error)) {
          this.enterStopped(`Serial runtime missing or incompatible: ${portResult.error}`);
          return;
        }
        this.enterWaiting(
          `Unable to list serial ports: ${portResult.error}. Smart Follow will retry.`,
          `list-fail:${portResult.error}`
        );
        return;
      }
      const ports = portResult.ports;
      const busy = this.callbacks.getBusyPaths();

      const normalizedPreferred = normalizePortPath(previousPreferredPath);
      const preferred = ports.find((p) => normalizePortPath(p.path) === normalizedPreferred);
      const preferredFree = preferred !== undefined && !busy.has(normalizePortPath(preferred.path));
      let preferredStatus: "missing" | "busy" = preferred === undefined ? "missing" : "busy";

      // 2. Try preferred port if it is free.
      if (preferredFree) {
        const directOpen = await this.tryOpen(preferred!.path, preferred);
        if (this.disposed || this.stopped) {
          return;
        }
        if (directOpen.type === "connected") {
          await this.handleConnected(directOpen.path, directOpen.port, previousPreferredPath, reason);
          return;
        }
        if (isSerialRuntimeMissingError(directOpen.message)) {
          this.enterStopped(`Serial runtime missing or incompatible: ${directOpen.message}`);
          return;
        }
        // Preferred is listed but a race let another process grab it (or driver glitch).
        // Treat it as effectively busy and fall through to the candidate logic.
        this.writeBanner(
          `Preferred port ${preferred!.path} could not be opened: ${directOpen.message}. Smart Follow will look for alternatives.`
        );
        busy.add(normalizePortPath(preferred!.path));
      }

      // 3. Build candidate sets, excluding the preferred path and any busy ports.
      const isPreferredPath = (p: SerialPortInfo): boolean => normalizePortPath(p.path) === normalizedPreferred;
      const isBusy = (p: SerialPortInfo): boolean => busy.has(normalizePortPath(p.path));
      let hintMatches = this.deviceHint
        ? ports.filter((p) => !isPreferredPath(p) && !isBusy(p) && matchesDeviceHint(p, this.deviceHint))
        : [];
      const otherCandidates = ports.filter(
        (p) => !isPreferredPath(p) && !isBusy(p) && !hintMatches.includes(p)
      );

      // 4. Silent fallback when exactly one hint match exists and the preferred
      // port is truly missing. If the preferred port is busy/open-failed, the
      // user must explicitly choose the replacement device.
      if (preferredStatus === "missing" && hintMatches.length === 1) {
        const hintPort = hintMatches[0];
        const hintOpen = await this.tryOpen(hintPort.path, hintPort);
        if (this.disposed || this.stopped) {
          return;
        }
        if (hintOpen.type === "connected") {
          await this.handleConnected(
            hintOpen.path,
            hintOpen.port ?? hintPort,
            previousPreferredPath,
            reason,
            "Matched saved device metadata."
          );
          return;
        }
        if (isSerialRuntimeMissingError(hintOpen.message)) {
          this.enterStopped(`Serial runtime missing or incompatible: ${hintOpen.message}`);
          return;
        }
        this.writeBanner(
          `Hint-matched port ${hintPort.path} could not be opened: ${hintOpen.message}. Smart Follow will keep trying.`
        );
        // Drop the failed hint candidate from this round so we don't fall through
        // into a picker with no real port options. Do not re-add it to
        // otherCandidates because the failure suggests transient unavailability,
        // not a different device the user should explicitly approve.
        hintMatches = [];
      }

      const promptHintMatches =
        preferredStatus === "busy" || hintMatches.length >= 2 ? hintMatches : [];

      // 5. Nothing to offer? Wait silently.
      if (promptHintMatches.length === 0 && otherCandidates.length === 0) {
        if (preferredStatus === "missing") {
          this.enterWaiting(
            `Preferred port ${previousPreferredPath} is missing. Smart Follow is waiting for it or a safe replacement.`,
            `missing:${previousPreferredPath}`
          );
        } else {
          this.enterWaiting(
            `Preferred port ${previousPreferredPath} is busy. Smart Follow is waiting for it to free up.`,
            `busy:${previousPreferredPath}`
          );
        }
        return;
      }

      // 6. Prompt the user for an explicit choice. Debounce on candidate set.
      const candidateKey = this.buildCandidateKey(
        preferredStatus,
        promptHintMatches,
        otherCandidates
      );
      if (this.lastPromptedKey === candidateKey) {
        // Already prompted with this exact set and the user dismissed. Stay silent.
        if (preferredStatus === "missing") {
          this.enterWaiting(
            `Smart Follow is waiting (you dismissed the picker for the current port set).`,
            `waiting-after-prompt:${candidateKey}`
          );
        } else {
          this.enterWaiting(
            `Smart Follow is waiting for ${previousPreferredPath} to free up (you dismissed the picker).`,
            `waiting-after-prompt:${candidateKey}`
          );
        }
        return;
      }

      this.lastPromptedKey = candidateKey;
      this.prompting = true;
      let choice: SmartFollowPromptResult;
      try {
        choice = await this.callbacks.promptPortChoice({
          profileName: this.profile.name,
          preferredPath: previousPreferredPath,
          preferredStatus,
          hintMatches: promptHintMatches,
          otherCandidates,
          hasHint: this.deviceHint !== undefined,
          reason: reason === "poll" ? "poll" : reason === "disconnect" ? "mid-session" : "initial"
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "unknown picker error";
        this.logger.log(`smart serial picker rejected ${message}`);
        choice = { kind: "wait" };
      } finally {
        this.prompting = false;
      }

      if (this.disposed || this.stopped) {
        return;
      }
      if (choice.kind === "wait") {
        this.enterWaiting(
          `Smart Follow is waiting (picker dismissed). The picker will reappear when the available ports change.`,
          `waiting-after-prompt:${candidateKey}`
        );
        return;
      }

      // 7. User picked a port. Try it.
      const pickedOpen = await this.tryOpen(choice.port.path, choice.port);
      if (this.disposed || this.stopped) {
        return;
      }
      if (pickedOpen.type === "connected") {
        await this.handleConnected(
          pickedOpen.path,
          pickedOpen.port ?? choice.port,
          previousPreferredPath,
          reason
        );
        return;
      }
      if (isSerialRuntimeMissingError(pickedOpen.message)) {
        this.enterStopped(`Serial runtime missing or incompatible: ${pickedOpen.message}`);
        return;
      }
      this.writeBanner(
        `Could not open ${choice.port.path}: ${pickedOpen.message}. Smart Follow will keep trying.`
      );
      this.enterWaiting(
        `Open failed for ${choice.port.path}: ${pickedOpen.message}`,
        `open-fail:${choice.port.path}:${pickedOpen.message}`
      );
    } finally {
      this.connecting = false;
    }
  }

  private buildCandidateKey(
    status: "missing" | "busy",
    hintMatches: SerialPortInfo[],
    others: SerialPortInfo[]
  ): string {
    const hintKey = hintMatches.map((p) => p.path).sort().join(",");
    const otherKey = others.map((p) => p.path).sort().join(",");
    return `${status}|h:${hintKey}|o:${otherKey}`;
  }

  private async listPortsResult(): Promise<{ ports: SerialPortInfo[] } | { error: string }> {
    try {
      return { ports: await this.transport.listPorts() };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown serial discovery error";
      this.logger.log(`smart serial listPorts failed ${message}`);
      return { error: message };
    }
  }

  private async tryOpen(path: string, knownPort?: SerialPortInfo): Promise<
    | { type: "connected"; path: string; port?: SerialPortInfo }
    | { type: "failed"; message: string }
  > {
    try {
      const sessionId = await this.transport.openPort({
        ...this.openPortOptions,
        path
      });
      if (this.disposed) {
        await this.transport.closePort(sessionId);
        return { type: "failed", message: "terminal disposed" };
      }
      this.transportSessionId = sessionId;
      this.callbacks.onTransportSessionChanged?.(sessionId);
      return { type: "connected", path, port: knownPort };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown serial connection error";
      this.logger.log(`smart serial open failed path=${path} ${message}`);
      return { type: "failed", message };
    }
  }

  private async handleConnected(
    path: string,
    port: SerialPortInfo | undefined,
    previousPreferredPath: string,
    reason: "initial" | "poll" | "disconnect",
    note?: string
  ): Promise<void> {
    this.stopPolling();
    this.waiting = false;
    this.stopped = false;
    this.lastWaitingKey = undefined;
    this.lastPromptedKey = undefined;
    this.currentPath = path;
    this.preferredPath = path;
    this.deviceHint = mergeDeviceHint(this.deviceHint, port);
    const firstConnection = !this.hasEverConnected;
    this.hasEverConnected = true;
    this.nameEmitter.fire(this.buildDisplayName());
    this.callbacks.onActivePortChanged?.(path);
    try {
      await Promise.resolve(this.callbacks.onResolvedPort?.(path, this.deviceHint));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown profile update error";
      this.logger.log(`smart serial profile update failed ${message}`);
    }
    this.callbacks.onStateChanged?.("connected");

    if (path !== previousPreferredPath) {
      this.writeBanner(
        `Connected ${path} @ ${this.profile.baudRate} (${this.profile.dataBits}${toParityCode(this.profile.parity)}${this.profile.stopBits}). Preferred port updated from ${previousPreferredPath} to ${path}. ${note ?? ""}`.trim()
      );
      return;
    }

    const prefix = firstConnection && reason === "initial" ? "Connected" : "Reattached";
    this.writeBanner(
      `${prefix} ${path} @ ${this.profile.baudRate} (${this.profile.dataBits}${toParityCode(this.profile.parity)}${this.profile.stopBits}).`
    );
  }

  private handleTransportDisconnect(reason: string): void {
    if (this.disposed || this.stopped) {
      return;
    }
    this.outputObservers.forEach((o) => o.pauseIntervalMacros());
    this.highlighterStream?.flush();
    const lostPath = this.currentPath ?? this.preferredPath;
    this.logger.log(`smart serial port disconnected: ${reason}`);
    this.transportSessionId = undefined;
    this.currentPath = undefined;
    this.callbacks.onTransportSessionChanged?.(undefined);
    this.callbacks.onActivePortChanged?.(undefined);
    // Reset the picker debounce so the next ensureConnected can re-evaluate freely
    // (e.g. show the foreign-device popup if a different port appears).
    this.lastPromptedKey = undefined;
    this.enterWaiting(
      `Port ${lostPath} disconnected. Smart Follow is waiting for it or a safe replacement port to appear.`,
      `disconnect:${lostPath}:${reason}`
    );
  }

  /**
   * Sticky unrecoverable state. The terminal tab stays open with a pinned banner.
   * Polling stops. Only the user closing the tab disposes anything.
   */
  private enterStopped(message: string): void {
    if (this.disposed || this.stopped) {
      return;
    }
    this.stopped = true;
    this.stopPolling();
    this.highlighterStream?.flush();
    this.waiting = false;
    this.currentPath = undefined;
    this.transportSessionId = undefined;
    this.logger.log(`smart serial stopped ${message}`);
    this.callbacks.onTransportSessionChanged?.(undefined);
    this.callbacks.onActivePortChanged?.(undefined);
    this.nameEmitter.fire(this.buildDisplayName());
    this.writeBanner(`${message} Close this terminal to exit.`);
    this.callbacks.onStateChanged?.("waiting");
    this.callbacks.onFatalError?.(message);
    // CRITICAL: do NOT call this.dispose() — the tab must persist per user requirement.
  }

  private enterWaiting(message: string, key: string): void {
    if (this.stopped) {
      return;
    }
    this.waiting = true;
    this.currentPath = undefined;
    this.nameEmitter.fire(this.buildDisplayName());
    this.callbacks.onStateChanged?.("waiting");
    this.startPolling();
    if (this.lastWaitingKey === key) {
      return;
    }
    this.lastWaitingKey = key;
    this.writeBanner(message);
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.ensureConnected("poll");
    }, SMART_FOLLOW_POLL_MS);
  }

  private stopPolling(): void {
    if (!this.pollTimer) {
      return;
    }
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private buildDisplayName(): string {
    const prefix = this.activityIndicator ? "\u25cf " : "";
    if (this.stopped) {
      return `${prefix}${this.terminalNameBase} [Stopped]`;
    }
    if (this.transportSessionId && this.currentPath) {
      return `${prefix}${this.terminalNameBase} [${this.currentPath}]`;
    }
    if (this.waiting) {
      return `${prefix}${this.terminalNameBase} [Waiting for port]`;
    }
    return `${prefix}${this.terminalNameBase}`;
  }

  private writeBanner(message: string): void {
    this.highlighterStream?.flush();
    this.writeEmitter.fire(`\r\n[Nexus Smart Follow] ${message}\r\n`);
  }
}
