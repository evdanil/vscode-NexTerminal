import * as vscode from "vscode";
import { prepareSerialText, type SerialInputState, type SerialLineEnding, type SerialUserInput } from "../services/serial/serialUserInput";
import { createWebviewNonce } from "./shared/webviewNonce";
import { renderSerialSendHtml } from "./serialSendHtml";
import { SERIAL_SEND_FOCUS_CONTEXT, SERIAL_SEND_VIEW_TYPE } from "./serialSendConstants";

export interface SerialSendBinding {
  readonly sessionId: string;
  readonly profileName: string;
  readonly terminal: vscode.Terminal;
  readonly input: SerialUserInput;
}

/**
 * The "Keep text after sending" choice, remembered per user. It is one scalar UI
 * preference in `globalState`, not a `ConfigRepository` collection: windows that
 * toggle it concurrently resolve last-writer-wins (see the doc comment atop
 * storage/vscodeConfigRepository.ts), which is acceptable because the only
 * possible loss is a checkbox default that the user can see and change.
 */
export interface SerialSendPreferences {
  getKeepText(): boolean;
  setKeepText(keepText: boolean): void;
}

/** Combo identifiers ("alt+a") that currently run a macro or the macro picker. */
export interface SerialSendMacroShortcuts {
  getBoundShortcuts(): readonly string[];
  onDidChange(listener: () => void): vscode.Disposable;
}

export interface SerialSendPanelOptions {
  readonly preferences?: SerialSendPreferences;
  readonly macroShortcuts?: SerialSendMacroShortcuts;
  /** Defaults to the `setContext` command; injectable for tests. */
  readonly setContext?: (key: string, value: boolean) => void;
}

export const SERIAL_SEND_KEEP_TEXT_KEY = "nexus.serialSendBox.keepText";

export { SERIAL_SEND_FOCUS_CONTEXT, SERIAL_SEND_VIEW_TYPE };

export function createSerialSendPreferences(memento: Pick<vscode.Memento, "get" | "update">): SerialSendPreferences {
  return {
    getKeepText: () => memento.get<unknown>(SERIAL_SEND_KEEP_TEXT_KEY) === true,
    setKeepText: (keepText) => {
      // A failed write only loses the remembered default; never surface it as a send error.
      Promise.resolve(memento.update(SERIAL_SEND_KEEP_TEXT_KEY, keepText)).catch(() => undefined);
    }
  };
}

function inMemoryPreferences(): SerialSendPreferences {
  let keepText = false;
  return { getKeepText: () => keepText, setKeepText: (value) => { keepText = value; } };
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
  private readonly shortcutListener: vscode.Disposable | undefined;
  private readonly setContext: (key: string, value: boolean) => void;
  private readonly preferences: SerialSendPreferences;
  private focused: OpenComposer | undefined;
  private focusContext = false;
  private disposed = false;

  public constructor(private readonly options: SerialSendPanelOptions = {}) {
    this.setContext = options.setContext ?? ((key, value) => { void vscode.commands.executeCommand("setContext", key, value); });
    // Never cached here: each push reads the store, so refreshPreferences() after
    // Delete All Data shows open boxes the cleared value.
    this.preferences = options.preferences ?? inMemoryPreferences();
    this.terminalListener = vscode.window.onDidCloseTerminal((terminal) => {
      for (const entry of this.panels.values()) {
        if (entry.binding.terminal === terminal) this.close(entry);
      }
    });
    this.shortcutListener = options.macroShortcuts?.onDidChange(() => {
      const shortcuts = this.boundShortcuts();
      for (const entry of this.panels.values()) this.pushShortcuts(entry, shortcuts);
    });
  }

  /**
   * Re-posts the stored keep-text choice to every open box. A retained webview
   * sends `ready` only once, so a store change made elsewhere (Delete All Data)
   * reaches open boxes only through this.
   */
  public refreshPreferences(): void {
    for (const entry of this.panels.values()) this.pushPreferences(entry);
  }

  /** The binding of the send box that has keyboard focus, if any. */
  public getFocusedBinding(): SerialSendBinding | undefined {
    const entry = this.focused;
    // `panel.active` as well: view-state changes are ordered main-thread events,
    // but focus reports come from separate webviews. Switching from box A to box B
    // makes A inactive before (or with) B becoming active, while A's blur and B's
    // focus may still be in flight; without this, a shortcut pressed in B in that
    // gap would go to A's session.
    return entry && !entry.disposed && entry.panel.active && this.panels.get(entry.binding.sessionId) === entry ? entry.binding : undefined;
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
    const panel = vscode.window.createWebviewPanel(SERIAL_SEND_VIEW_TYPE, `Serial Send: ${binding.profileName}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: []
    });
    const entry: OpenComposer = { binding, panel, listeners: [], disposed: false, ownsGate: false, lastRequestId: 0 };
    this.panels.set(binding.sessionId, entry);
    try {
      entry.listeners.push(panel.onDidDispose(() => this.release(entry)));
      entry.listeners.push(panel.webview.onDidReceiveMessage((message: unknown) => this.receive(entry, message)));
      // Another editor becoming active means focus has left this box, even if its blur report is late or lost.
      entry.listeners.push(panel.onDidChangeViewState((event) => {
        // Returning to a box resyncs it with the stored keep-text choice (another window may have changed it).
        // The focus report may have arrived before the panel turned active.
        if (event.webviewPanel.active) { this.pushPreferences(entry); this.updateFocusContext(); }
        else this.setFocused(entry, false);
      }));
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
    this.shortcutListener?.dispose();
    for (const entry of [...this.panels.values()]) this.close(entry);
    this.updateFocusContext();
  }

  /**
   * Focus belongs to one entry at a time. A blur clears only the entry that
   * reported it: moving between two send boxes delivers A's blur and B's focus
   * from separate webviews in no guaranteed order, and A's late blur must not
   * clear B.
   */
  private setFocused(entry: OpenComposer, focused: boolean): void {
    if (focused && !entry.disposed) this.focused = entry;
    else if (this.focused === entry) this.focused = undefined;
    this.updateFocusContext();
  }

  private updateFocusContext(): void {
    const value = !this.disposed && this.getFocusedBinding() !== undefined;
    if (value === this.focusContext) return;
    this.focusContext = value;
    this.setContext(SERIAL_SEND_FOCUS_CONTEXT, value);
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
    this.setFocused(entry, false);
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

  private pushPreferences(entry: OpenComposer): void {
    if (entry.disposed) return;
    void entry.panel.webview.postMessage({ type: "preferences", keepText: this.preferences.getKeepText() === true });
  }

  /** getBoundMacroShortcuts() already validates against the binding grammar; the page re-validates at its trust boundary. */
  private boundShortcuts(): string[] {
    return [...(this.options.macroShortcuts?.getBoundShortcuts() ?? [])];
  }

  private pushShortcuts(entry: OpenComposer, shortcuts = this.boundShortcuts()): void {
    if (entry.disposed) return;
    void entry.panel.webview.postMessage({ type: "macroShortcuts", shortcuts });
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
    if (value.type === "ready" && hasOnlyKeys(value, ["type"])) {
      this.pushState(entry);
      this.pushPreferences(entry);
      this.pushShortcuts(entry);
      return;
    }
    if (value.type === "focusChanged" && hasOnlyKeys(value, ["type", "focused"]) && typeof value.focused === "boolean") {
      this.setFocused(entry, value.focused);
      return;
    }
    if (value.type === "setKeepText" && hasOnlyKeys(value, ["type", "keepText"]) && typeof value.keepText === "boolean") {
      // No "unchanged" shortcut: the shared key may hold another window's value,
      // so always persist this box's choice and resync every open box to it.
      this.preferences.setKeepText(value.keepText);
      for (const other of this.panels.values()) this.pushPreferences(other);
      return;
    }
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
