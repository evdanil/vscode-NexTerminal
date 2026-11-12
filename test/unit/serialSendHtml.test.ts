import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { renderSerialSendHtml } from "../../src/ui/serialSendHtml";

// The real rendered JS runs here; browser layout/selection and native IME still need Chromium/EHD acceptance.
class Element {
  private currentValue = "";
  writes = 0;
  textContent = "";
  disabled = false;
  readOnly = false;
  checked = false;
  listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  get value() { return this.currentValue; }
  set value(value: string) { this.currentValue = value; this.writes++; }
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  setAttribute() { /* aria only */ }
  fire(type: string, data: Record<string, unknown> = {}) {
    const event = { preventDefault: vi.fn(), ...data };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
}

function browser(setup: { hasFocus?: boolean } = {}) {
  const html = renderSerialSendHtml("test-nonce");
  const elements = new Map<string, Element>();
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element());
  // Initial checkbox state comes from the markup, as in a browser.
  for (const match of html.matchAll(/<input\b([^>]*)>/g)) {
    const id = match[1].match(/\bid="([^"]+)"/)?.[1];
    if (id) elements.get(id)!.checked = /\schecked(?:[\s=>]|$)/.test(match[1]);
  }
  const el = (id: string) => elements.get(id)!;
  const options = [...html.match(/<select id="line-ending">([\s\S]*?)<\/select>/)![1].matchAll(/<option\b([^>]*)>/g)];
  const defaultOption = options.find((option) => /\bselected(?:\s|=|$)/.test(option[1])) ?? options[0];
  el("line-ending").value = defaultOption[1].match(/value="([^"]*)"/)![1];
  const messages: Record<string, unknown>[] = [];
  const windowListeners = new Map<string, Array<(event: unknown) => void>>();
  const documentListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const listen = <T,>(map: Map<string, T[]>) => (type: string, listener: T) => { map.set(type, [...(map.get(type) ?? []), listener]); };
  const receive = (event: { data: unknown }) => { for (const listener of windowListeners.get("message") ?? []) listener(event); };
  const windowEvent = (type: string) => { for (const listener of windowListeners.get(type) ?? []) listener({}); };
  const keydown = (data: Record<string, unknown>) => {
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(), ...data };
    for (const listener of documentListeners.get("keydown") ?? []) listener(event);
    return event;
  };
  const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/i)![1];
  runInNewContext(script, {
    document: { getElementById: el, addEventListener: listen(documentListeners), hasFocus: () => setup.hasFocus === true },
    window: { addEventListener: listen(windowListeners) },
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => messages.push(message) }),
    TextEncoder
  });
  const state = (patch: Record<string, unknown> = {}) => receive({ data: {
    type: "state", profileName: "<b>profile</b>", path: "/dev/test", status: "connected", connected: true,
    inputLocked: false, dedicatedInputEnabled: true, connectionEpoch: 1, ...patch
  } });
  const input = (value: string) => { el("draft").value = value; el("draft").fire("input"); };
  const result = (requestId: number, ok: boolean) => receive({ data: { type: "sendResult", requestId, ok, error: "Delivery may be partial or unknown; review before retrying." } });
  state();
  return { html, el, messages, receive, state, input, result, keydown, windowEvent };
}

describe("serial composer browser behavior", () => {
  it("has a nonce-only CSP and no external/command resources or stored draft state", () => {
    const { html, messages } = browser();
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-test-nonce'");
    expect(html).toContain('script nonce="test-nonce"');
    expect(html).not.toMatch(/(?:src|href)=["'](?:https?:|command:)|url\(["']?https?:|localStorage|setState|getState|innerHTML/);
    expect(messages).toEqual([{ type: "ready" }, { type: "focusChanged", focused: false }]);
  });

  it("sends a bound-epoch snapshot, keeps editing available, and prevents rapid double send", () => {
    const b = browser();
    b.input("commands");
    b.el("send").fire("click");
    b.el("send").fire("click");
    expect(b.messages.at(-1)).toEqual({ type: "send", requestId: 1, connectionEpoch: 1, text: "commands", lineEnding: "cr" });
    expect(b.messages.filter((m) => m.type === "send")).toHaveLength(1);
    expect(b.el("send").disabled).toBe(true);
    expect(b.el("draft").disabled || b.el("draft").readOnly).toBe(false);
  });

  it("state updates alter labels in place without touching the draft value", () => {
    const b = browser();
    b.input("selected draft");
    const writes = b.el("draft").writes;
    b.state({ status: "waiting", connected: false, profileName: "<img src=x onerror=bad()>", path: "<script>path</script>" });
    expect(b.el("draft").value).toBe("selected draft");
    expect(b.el("draft").writes).toBe(writes);
    expect(b.el("profile").textContent).toBe("<img src=x onerror=bad()>");
    expect(b.el("path").textContent).toBe("<script>path</script>");
    expect(b.el("connection-state").textContent).toMatch(/waiting/i);
  });

  it.each(["opening", "waiting", "stopped", "disconnected", "closed"])("keeps drafts editable in %s while disabling Send", (status) => {
    const b = browser();
    b.input("draft");
    b.state({ status, connected: false });
    b.el("send").fire("click");
    expect(b.el("send").disabled).toBe(true);
    expect(b.el("connection-state").textContent.toLowerCase()).toContain(status);
    expect(b.el("draft").disabled || b.el("draft").readOnly).toBe(false);
    expect(b.messages.filter((m) => m.type === "send")).toHaveLength(0);
  });

  it("disables locked/direct input and restores Send when the host permits it", () => {
    const b = browser();
    b.input("draft");
    b.state({ inputLocked: true });
    expect(b.el("connection-state").textContent).toMatch(/Stop Script/);
    expect(b.el("send").disabled).toBe(true);
    b.state({ dedicatedInputEnabled: false });
    expect(b.el("send").disabled).toBe(true);
    b.state({ connectionEpoch: 2 });
    expect(b.el("send").disabled).toBe(false);
    b.el("send").fire("click");
    expect(b.messages.at(-1)).toMatchObject({ connectionEpoch: 2 });
  });

  it("normal Enter remains a newline; Ctrl/Cmd+Enter sends and suppresses only that key", () => {
    for (const modifier of ["ctrlKey", "metaKey"]) {
      const b = browser();
      b.input("draft");
      expect(b.el("draft").fire("keydown", { key: "Enter" }).preventDefault).not.toHaveBeenCalled();
      const event = b.el("draft").fire("keydown", { key: "Enter", [modifier]: true });
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(b.messages.at(-1)).toMatchObject({ type: "send", text: "draft" });
    }
  });

  it.each([{ isComposing: true }, { keyCode: 229 }, { composition: true }])("does not send through an IME confirmation key: %j", (guard) => {
    const b = browser();
    b.input("変換");
    if (guard.composition) b.el("draft").fire("compositionstart");
    b.el("draft").fire("keydown", { key: "Enter", ctrlKey: true, ...guard });
    expect(b.messages.filter((m) => m.type === "send")).toHaveLength(0);
  });

  it("clears only a successful unchanged submitted draft and reports driver acknowledgement", () => {
    const b = browser();
    b.input("draft");
    b.el("send").fire("click");
    b.result(1, true);
    expect(b.el("draft").value).toBe("");
    expect(b.el("send-result").textContent).toBe("Written to serial driver");
    expect(b.el("send-result").textContent).not.toMatch(/delivered|received by/i);
  });

  it.each(["edit", "edit-back", "ending", "composition", "epoch"])("does not clear a newer draft after %s", (change) => {
    const b = browser();
    b.input("draft");
    b.el("send").fire("click");
    if (change === "edit" || change === "edit-back") b.input("new draft");
    if (change === "edit-back") b.input("draft");
    if (change === "ending") { b.el("line-ending").value = "lf"; b.el("line-ending").fire("change"); }
    if (change === "composition") b.el("draft").fire("compositionstart");
    if (change === "epoch") b.state({ connectionEpoch: 2 });
    b.result(1, true);
    expect(b.el("draft").value).toBe(change === "edit" ? "new draft" : "draft");
  });

  it("failed sends and unrelated late results cannot clear or release a later pending draft", () => {
    const b = browser();
    b.input("draft");
    b.el("send").fire("click");
    b.input("later");
    b.result(1, false);
    expect(b.el("draft").value).toBe("later");
    expect(b.el("send-result").textContent).toMatch(/partial or unknown/);
    b.el("send").fire("click");
    b.result(1, true);
    b.result(99, true);
    expect(b.el("draft").value).toBe("later");
    expect(b.el("send").disabled).toBe(true);
    b.result(2, true);
    expect(b.el("draft").value).toBe("");
  });

  it("counts converted UTF-8 bytes and refuses overflow while allowing empty line endings", () => {
    const b = browser();
    expect(b.el("byte-count").textContent).toContain("1 / 65,536");
    expect(b.el("send").disabled).toBe(false);
    b.el("line-ending").value = "crlf";
    b.el("line-ending").fire("change");
    expect(b.el("send").disabled).toBe(false);
    expect(b.el("byte-count").textContent).toContain("2 / 65,536");
    expect(b.el("ending-help").textContent).toMatch(/normalize|normaliz/i);
    b.input("😀\nx");
    expect(b.el("byte-count").textContent).toContain("9 / 65,536");
    b.input("😀".repeat(16384));
    expect(b.el("send").disabled).toBe(true);
    b.el("line-ending").value = "none";
    b.el("line-ending").fire("change");
    expect(b.el("send").disabled).toBe(false);
    expect(b.el("byte-count").textContent).toContain("65536 / 65,536");
    expect(b.el("ending-help").textContent).toMatch(/preserve/i);
    b.input("");
    expect(b.el("send").disabled).toBe(true);
  });

  it("focus/direct actions send only closed protocol messages", () => {
    const b = browser();
    b.el("focus-terminal").fire("click");
    expect(b.messages.at(-1)).toEqual({ type: "focusTerminal" });
    b.el("direct-input").fire("click");
    expect(b.messages.at(-1)).toEqual({ type: "useDirectInput" });
  });

  it("explains each line ending without promising a CR-only console runs LF or CRLF", () => {
    const b = browser();
    const help = (value: string) => { b.el("line-ending").value = value; b.el("line-ending").fire("change"); return b.el("ending-help").textContent; };
    expect(help("cr")).toMatch(/CR matches pressing Enter in the terminal/);
    expect(help("cr")).toMatch(/most device consoles use to run a command/);
    expect(help("lf")).toMatch(/Choose LF only when the device expects it/);
    expect(help("lf")).toMatch(/may echo LF-terminated text without running it/);
    expect(help("crlf")).toMatch(/Choose CRLF only when the device expects it/);
    expect(help("crlf")).toMatch(/extra blank line or prompt/);
    for (const value of ["lf", "crlf"]) {
      expect(help(value)).not.toMatch(/most device consoles|matches pressing Enter/);
      expect(help(value)).toMatch(/Normalizes every line break/);
    }
    expect(help("none")).toBe("None preserves text exactly, with no appended line ending.");
    // The old generic sentence gave no reason to prefer CR; it must not return.
    for (const value of ["cr", "lf", "crlf"]) expect(help(value)).not.toContain("Normalize every line break to");
  });

  it("keep text: unchecked clears as before, checked keeps the draft after a successful send", () => {
    const b = browser();
    expect(b.el("keep-text").checked).toBe(false);
    b.input("show version");
    b.el("send").fire("click");
    b.result(1, true);
    expect(b.el("draft").value).toBe("");
    b.receive({ data: { type: "preferences", keepText: true } });
    expect(b.el("keep-text").checked).toBe(true);
    b.input("show version");
    b.el("send").fire("click");
    b.result(2, true);
    expect(b.el("draft").value).toBe("show version");
    expect(b.el("send-result").textContent).toBe("Written to serial driver");
    expect(b.el("send").disabled).toBe(false);
    b.el("send").fire("click");
    expect(b.messages.at(-1)).toMatchObject({ type: "send", requestId: 3, text: "show version" });
  });

  it("keep text reports only a boolean and ignores non-boolean preferences", () => {
    const b = browser();
    b.el("keep-text").checked = true;
    b.el("keep-text").fire("change");
    expect(b.messages.at(-1)).toEqual({ type: "setKeepText", keepText: true });
    for (const keepText of ["false", 0, null, undefined, {}]) b.receive({ data: { type: "preferences", keepText } });
    expect(b.el("keep-text").checked).toBe(true);
    b.receive({ data: { type: "preferences", keepText: false } });
    expect(b.el("keep-text").checked).toBe(false);
  });

  it("reports window focus and blur, and the initial focus state", () => {
    expect(browser({ hasFocus: true }).messages).toEqual([{ type: "ready" }, { type: "focusChanged", focused: true }]);
    const b = browser();
    b.windowEvent("focus");
    expect(b.messages.at(-1)).toEqual({ type: "focusChanged", focused: true });
    b.windowEvent("blur");
    expect(b.messages.at(-1)).toEqual({ type: "focusChanged", focused: false });
  });

  const key = (code: string, mods: Record<string, boolean> = {}, keyCode = code.startsWith("Key") ? code.charCodeAt(3) : code.charCodeAt(5)) =>
    ({ code, keyCode, key: "å", altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });

  it("suppresses only the default action of a bound macro combo and never stops propagation", () => {
    const b = browser();
    b.receive({ data: { type: "macroShortcuts", shortcuts: ["alt+a", "alt+s", "alt+shift+1", "ctrl+shift+z"] } });
    for (const event of [key("KeyA", { altKey: true }), key("KeyS", { altKey: true }), key("Digit1", { altKey: true, shiftKey: true }),
      key("KeyZ", { ctrlKey: true, shiftKey: true })]) {
      const fired = b.keydown(event);
      expect(fired.preventDefault, JSON.stringify(event)).toHaveBeenCalledOnce();
      expect(fired.stopPropagation).not.toHaveBeenCalled();
      expect(fired.stopImmediatePropagation).not.toHaveBeenCalled();
    }
    const allowed = [
      key("KeyB", { altKey: true }),                      // not bound
      key("KeyA"), key("KeyA", { shiftKey: true }),       // ordinary typing
      key("KeyA", { altKey: true, shiftKey: true }),      // different modifier set
      key("KeyA", { altKey: true, ctrlKey: true }),       // AltGr on Windows
      key("KeyA", { altKey: true, metaKey: true }),
      key("KeyZ", { ctrlKey: true }),
      key("Digit1", { altKey: true }),
      key("Numpad1", { altKey: true, shiftKey: true }, 97),
      key("KeyA", { altKey: true }, 81),                  // layout maps the physical key elsewhere
      key("KeyA", { altKey: true, isComposing: true }),
      key("KeyA", { altKey: true }, 229),
      { key: "Enter", code: "Enter", keyCode: 13, ctrlKey: true },
      { key: "Enter", code: "Enter", keyCode: 13, metaKey: true }
    ];
    for (const event of allowed) expect(b.keydown(event).preventDefault, JSON.stringify(event)).not.toHaveBeenCalled();
  });

  it.each([
    "alt+a", ["alt+a", 1], ["Alt+A"], ["alt+a", "<b>Backup</b>"], ["ctrl+alt+a"], ["alt+aa"], Array(129).fill("alt+a"), { 0: "alt+a" }
  ])("ignores a malformed shortcut list without dropping the previous one: %j", (shortcuts) => {
    const b = browser();
    b.receive({ data: { type: "macroShortcuts", shortcuts: ["alt+q"] } });
    b.receive({ data: { type: "macroShortcuts", shortcuts } });
    expect(b.keydown(key("KeyQ", { altKey: true })).preventDefault).toHaveBeenCalledOnce();
    expect(b.keydown(key("KeyA", { altKey: true })).preventDefault).not.toHaveBeenCalled();
  });

  it("tells the user where macro shortcuts go from this box", () => {
    expect(browser().html).toContain("Macro shortcuts, including Alt+S, send to this session while this box has focus.");
  });

  it("blocks nothing before the host sends a shortcut list", () => {
    const b = browser();
    expect(b.keydown(key("KeyS", { altKey: true })).preventDefault).not.toHaveBeenCalled();
  });
});
