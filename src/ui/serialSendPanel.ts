import * as vscode from "vscode";
import { prepareSerialText, type SerialInputState, type SerialLineEnding, type SerialUserInput } from "../services/serial/serialUserInput";
import { createWebviewNonce } from "./shared/webviewNonce";
import { renderSerialSendHtml } from "./serialSendHtml";

export interface SerialSendBinding {
  readonly sessionId: string;
  readonly profileName: string;
  readonly terminal: vscode.Terminal;
  readonly input: SerialUserInput;
}

interface OpenComposer {
  readonly binding: SerialSendBinding;
  readonly panel: vscode.WebviewPanel;
  readonly listeners: vscode.Disposable[];
  disposed: boolean;
  ownsGate: boolean;
  lastRequestId: number;
  pendingRequestId?: number;
}

const DELIVERY_UNKNOWN = "Serial write failed. Delivery may be partial or unknown. Review the device state before manually retrying.";
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isEpoch = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isEnding = (value: unknown): value is SerialLineEnding => value === "none" || value === "cr" || value === "lf" || value === "crlf";
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

/** Owns composers by live logical session, never by a target supplied by a webview. */
export class SerialSendPanel implements vscode.Disposable {
  private readonly panels = new Map<string, OpenComposer>();
  private readonly terminalListener: vscode.Disposable;
  private disposed = false;

  public constructor() {
    this.terminalListener = vscode.window.onDidCloseTerminal((terminal) => {
      for (const entry of this.panels.values()) {
        if (entry.binding.terminal === terminal) this.close(entry);
      }
    });
  }

  public openOrReveal(binding: SerialSendBinding): void {
    binding = { sessionId: binding.sessionId, profileName: binding.profileName, terminal: binding.terminal, input: binding.input };
    if (this.disposed) throw new Error("Serial send box is unavailable.");
    const existing = this.panels.get(binding.sessionId);
    if (existing) {
      if (existing.binding.input !== binding.input || existing.binding.terminal !== binding.terminal) {
        throw new Error("Serial session changed. Open its current send box again.");
      }
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const previous = binding.input.getInputState();
    if (previous.status === "closed") throw new Error("Serial session is closed.");
    const panel = vscode.window.createWebviewPanel("nexus.serialSend", `Serial Send: ${binding.profileName}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: []
    });
    const entry: OpenComposer = { binding, panel, listeners: [], disposed: false, ownsGate: false, lastRequestId: 0 };
    this.panels.set(binding.sessionId, entry);
    try {
      entry.listeners.push(panel.onDidDispose(() => this.release(entry)));
      entry.listeners.push(panel.webview.onDidReceiveMessage((message: unknown) => this.receive(entry, message)));
      entry.listeners.push(binding.input.onDidChangeInputState((state) => {
        if (state.status === "closed") this.close(entry);
        else this.pushState(entry);
      }));
      panel.webview.html = renderSerialSendHtml(createWebviewNonce());
      // Install disposal/state listeners before enabling: the mode change can synchronously close the owner.
      entry.ownsGate = true;
      binding.input.setDedicatedInputEnabled(true);
      this.pushState(entry);
    } catch {
      this.close(entry, previous.dedicatedInputEnabled);
      throw new Error("Could not open the serial send box. Try opening it again.");
    }
  }

  public disposeForSession(sessionId: string): void {
    const entry = this.panels.get(sessionId);
    if (entry) this.close(entry);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminalListener.dispose();
    for (const entry of [...this.panels.values()]) this.close(entry);
  }

  private close(entry: OpenComposer, restoreMode = false): void {
    if (entry.disposed) return;
    this.release(entry, restoreMode);
    entry.panel.dispose();
  }

  private release(entry: OpenComposer, restoreMode = false): void {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.pendingRequestId = undefined;
    this.panels.delete(entry.binding.sessionId);
    for (const listener of entry.listeners) listener.dispose();
    entry.listeners.length = 0;
    if (entry.ownsGate) {
      entry.ownsGate = false;
      if (entry.binding.input.getInputState().status !== "closed") entry.binding.input.setDedicatedInputEnabled(restoreMode);
    }
  }

  private pushState(entry: OpenComposer): void {
    if (entry.disposed) return;
    void entry.panel.webview.postMessage({ type: "state", profileName: entry.binding.profileName, ...entry.binding.input.getInputState() });
  }

  private result(entry: OpenComposer, requestId: number, error?: string): void {
    if (entry.disposed) return;
    void entry.panel.webview.postMessage(error
      ? { type: "sendResult", requestId, ok: false, error }
      : { type: "sendResult", requestId, ok: true });
  }

  private refusal(state: SerialInputState): string | undefined {
    if (!state.connected) return `Serial session is ${state.status}. Keep the draft until the session is connected.`;
    if (state.inputLocked) return "Serial input is locked by a script. Use Nexus: Stop Script or the terminal lock indicator to stop it.";
    if (!state.dedicatedInputEnabled) return "Direct terminal input is enabled. Open the serial send box again to use dedicated input.";
    return undefined;
  }

  private async receive(entry: OpenComposer, message: unknown): Promise<void> {
    if (entry.disposed || !message || typeof message !== "object" || Array.isArray(message)) return;
    const value = message as Record<string, unknown>;
    if (value.type === "ready" && hasOnlyKeys(value, ["type"])) { this.pushState(entry); return; }
    if (value.type === "focusTerminal" && hasOnlyKeys(value, ["type"])) { entry.binding.terminal.show(false); return; }
    if (value.type === "useDirectInput" && hasOnlyKeys(value, ["type"])) {
      this.close(entry);
      entry.binding.terminal.show(false);
      return;
    }
    if (value.type !== "send" || !isId(value.requestId) || value.requestId <= entry.lastRequestId) return;
    // Consuming IDs also for refused requests prevents a duplicate from answering an existing pending request.
    const requestId = value.requestId;
    entry.lastRequestId = requestId;
    if (!hasOnlyKeys(value, ["type", "requestId", "connectionEpoch", "text", "lineEnding"]) ||
        !isEpoch(value.connectionEpoch) || typeof value.text !== "string" || !isEnding(value.lineEnding) ||
        Buffer.byteLength(value.text, "utf8") > 65536) {
      this.result(entry, requestId, "Invalid serial send request. Enter at most 65,536 UTF-8 bytes and choose a line ending.");
      return;
    }
    if (entry.pendingRequestId !== undefined) {
      this.result(entry, requestId, "A serial write is already pending. Wait for its result before sending again.");
      return;
    }
    const state = entry.binding.input.getInputState();
    const refusal = this.refusal(state);
    if (refusal || state.connectionEpoch !== value.connectionEpoch) {
      this.result(entry, requestId, refusal ?? "Serial connection changed. Review the current connection before sending again.");
      this.pushState(entry);
      return;
    }
    let payload: string;
    try { payload = prepareSerialText(value.text, value.lineEnding); }
    catch {
      this.result(entry, requestId, "Enter text or choose a line ending. The converted send must fit within 65,536 UTF-8 bytes.");
      return;
    }
    entry.pendingRequestId = requestId;
    try {
      await entry.binding.input.sendUserInput(payload, value.connectionEpoch);
      const current = entry.binding.input.getInputState();
      this.result(entry, requestId, !current.connected || current.connectionEpoch !== value.connectionEpoch ? DELIVERY_UNKNOWN : undefined);
    } catch {
      // Transport errors can contain device output or outgoing text; only fixed, content-free text crosses the UI boundary.
      this.result(entry, requestId, DELIVERY_UNKNOWN);
    } finally {
      if (entry.pendingRequestId === requestId) entry.pendingRequestId = undefined;
    }
  }
}
