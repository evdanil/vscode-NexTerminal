import * as vscode from "vscode";
import type { SerialDeviceHint, SerialProfile, SerialSessionStatus } from "../../models/config";
import type { SessionLogger } from "../../logging/terminalLogger";
import type { SessionTranscript } from "../../logging/sessionTranscriptLogger";
import type { TerminalHighlighter, TerminalHighlighterStream } from "../terminalHighlighter";
import type { PtyOutputObserver } from "../macroAutoTrigger";
import { toParityCode } from "../../utils/helpers";
import type { SerialTransport } from "./serialPty";
import { isBusyOrPermissionSerialError, isMissingSerialPortError, isSerialRuntimeMissingError } from "./errorMatchers";
import type { OpenPortParams, SerialPortInfo } from "./protocol";

const SMART_FOLLOW_POLL_MS = 2000;

export interface SmartSerialTransport extends SerialTransport {
  listPorts(): Promise<SerialPortInfo[]>;
}

export interface SmartSerialPtyCallbacks {
  onClosed(): void;
  onDataReceived?(): void;
  onTransportSessionChanged?(sessionId?: string): void;
  onResolvedPort?(path: string, deviceHint?: SerialDeviceHint): Promise<void> | void;
  onStateChanged?(status: SerialSessionStatus): void;
  onFatalError?(message: string): void;
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

type ResolveResult =
  | { type: "resolved"; path: string; port?: SerialPortInfo; note?: string }
  | { type: "waiting"; message: string; key: string };

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
  private activityIndicator = false;
  private hasEverConnected = false;
  private lastWaitingKey?: string;
  private pollTimer?: ReturnType<typeof setInterval>;
  private readonly highlighterStream?: TerminalHighlighterStream;
  private readonly unsubscribeData: () => void;
  private readonly unsubscribeError: () => void;
  private readonly unsubscribeDisconnect: () => void;

  public constructor(
    private readonly transport: SmartSerialTransport,
    private readonly profile: SerialProfile,
    private readonly callbacks: SmartSerialPtyCallbacks,
    private readonly logger: SessionLogger,
    private readonly transcript?: SessionTranscript,
    private readonly highlighter?: TerminalHighlighter,
    private readonly outputObserver?: PtyOutputObserver
  ) {
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
      this.outputObserver?.onOutput(output);
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
    this.writeBanner(
      `Smart Follow is active. Preferred port ${this.preferredPath}. Other serial profiles are blocked until this terminal closes.`
    );
    this.nameEmitter.fire(this.buildDisplayName());
    void this.ensureConnected("initial");
  }

  public close(): void {
    this.dispose();
  }

  public handleInput(data: string): void {
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
    this.outputObserver?.dispose();
    this.unsubscribeData();
    this.unsubscribeError();
    this.unsubscribeDisconnect();
    const sessionId = this.transportSessionId;
    this.transportSessionId = undefined;
    this.callbacks.onTransportSessionChanged?.(undefined);
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
    if (this.disposed || this.connecting) {
      return;
    }
    this.connecting = true;
    try {
      const previousPreferredPath = this.preferredPath;
      const directOpen = await this.tryOpen(previousPreferredPath);
      if (this.disposed) {
        return;
      }
      if (directOpen.type === "connected") {
        await this.handleConnected(directOpen.path, directOpen.port, previousPreferredPath, reason);
        return;
      }

      if (isSerialRuntimeMissingError(directOpen.message)) {
        this.handleHardFailure(`Serial runtime missing or incompatible: ${directOpen.message}`);
        return;
      }

      if (isBusyOrPermissionSerialError(directOpen.message)) {
        this.handleHardFailure(`Preferred port ${previousPreferredPath} is not usable: ${directOpen.message}`);
        return;
      }

      if (!isMissingSerialPortError(directOpen.message)) {
        this.handleHardFailure(`Preferred port ${previousPreferredPath} failed: ${directOpen.message}`);
        return;
      }

      const portResult = await this.listPortsResult();
      if ("error" in portResult) {
        if (isSerialRuntimeMissingError(portResult.error)) {
          this.handleHardFailure(`Serial runtime missing or incompatible: ${portResult.error}`);
          return;
        }
        return;
      }

      const resolved = this.resolveFallbackPort(portResult.ports, previousPreferredPath);
      if (resolved.type === "waiting") {
        this.enterWaiting(resolved.message, resolved.key);
        return;
      }

      const fallbackOpen = await this.tryOpen(resolved.path, resolved.port);
      if (this.disposed) {
        return;
      }
      if (fallbackOpen.type === "connected") {
        await this.handleConnected(fallbackOpen.path, fallbackOpen.port ?? resolved.port, previousPreferredPath, reason, resolved.note);
        return;
      }

      if (isMissingSerialPortError(fallbackOpen.message)) {
        this.enterWaiting(
          `Candidate port ${resolved.path} disappeared before Smart Follow could attach. Waiting for the preferred port or another safe replacement.`,
          `candidate-missing:${resolved.path}`
        );
        return;
      }

      this.handleHardFailure(`Candidate port ${resolved.path} is not usable: ${fallbackOpen.message}`);
    } finally {
      this.connecting = false;
    }
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

  private resolveFallbackPort(ports: SerialPortInfo[], preferredPath: string): ResolveResult {
    const candidates = ports.filter((port) => port.path !== preferredPath);
    const hintMatches = this.deviceHint ? candidates.filter((port) => matchesDeviceHint(port, this.deviceHint)) : [];

    if (hintMatches.length === 1) {
      return {
        type: "resolved",
        path: hintMatches[0].path,
        port: hintMatches[0],
        note: "Matched saved device metadata."
      };
    }

    if (hintMatches.length > 1) {
      return {
        type: "waiting",
        key: `ambiguous-hint:${hintMatches.map((port) => port.path).sort().join(",")}`,
        message: `Preferred port ${preferredPath} is missing. Smart Follow found multiple device-metadata matches (${hintMatches.map((port) => port.path).join(", ")}) and will wait instead of guessing.`
      };
    }

    if (candidates.length === 1) {
      return {
        type: "resolved",
        path: candidates[0].path,
        port: candidates[0],
        note: "Exactly one fallback port was available."
      };
    }

    if (candidates.length > 1) {
      return {
        type: "waiting",
        key: `ambiguous:${candidates.map((port) => port.path).sort().join(",")}`,
        message: `Preferred port ${preferredPath} is missing. Smart Follow found multiple other ports (${candidates.map((port) => port.path).join(", ")}) and will wait instead of guessing.`
      };
    }

    return {
      type: "waiting",
      key: `missing:${preferredPath}`,
      message: `Preferred port ${preferredPath} is missing. Smart Follow is waiting for it or a safe replacement port to appear.`
    };
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
    this.lastWaitingKey = undefined;
    this.currentPath = path;
    this.preferredPath = path;
    this.deviceHint = mergeDeviceHint(this.deviceHint, port);
    const firstConnection = !this.hasEverConnected;
    this.hasEverConnected = true;
    this.nameEmitter.fire(this.buildDisplayName());
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
    if (this.disposed) {
      return;
    }
    this.outputObserver?.pauseIntervalMacros();
    this.highlighterStream?.flush();
    const lostPath = this.currentPath ?? this.preferredPath;
    this.logger.log(`smart serial port disconnected: ${reason}`);
    this.transportSessionId = undefined;
    this.currentPath = undefined;
    this.callbacks.onTransportSessionChanged?.(undefined);
    this.enterWaiting(
      `Port ${lostPath} disconnected. Smart Follow is waiting for it or a safe replacement port to appear.`,
      `disconnect:${lostPath}:${reason}`
    );
  }

  private handleHardFailure(message: string): void {
    if (this.disposed) {
      return;
    }
    this.stopPolling();
    this.highlighterStream?.flush();
    this.logger.log(`smart serial hard failure ${message}`);
    this.writeBanner(message);
    this.callbacks.onFatalError?.(message);
    this.dispose();
  }

  private enterWaiting(message: string, key: string): void {
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
