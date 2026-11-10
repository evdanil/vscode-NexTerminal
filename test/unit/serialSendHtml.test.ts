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

function browser() {
  const html = renderSerialSendHtml("test-nonce");
  const elements = new Map<string, Element>();
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element());
  const el = (id: string) => elements.get(id)!;
  const options = [...html.match(/<select id="line-ending">([\s\S]*?)<\/select>/)![1].matchAll(/<option\b([^>]*)>/g)];
  const defaultOption = options.find((option) => /\bselected(?:\s|=|$)/.test(option[1])) ?? options[0];
  el("line-ending").value = defaultOption[1].match(/value="([^"]*)"/)![1];
  const messages: Record<string, unknown>[] = [];
  let receive!: (event: { data: unknown }) => void;
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i)![1];
  runInNewContext(script, {
    document: { getElementById: el },
    window: { addEventListener: (_: string, listener: typeof receive) => { receive = listener; } },
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
  return { html, el, messages, receive, state, input, result };
}

describe("serial composer browser behavior", () => {
  it("has a nonce-only CSP and no external/command resources or stored draft state", () => {
    const { html, messages } = browser();
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-test-nonce'");
    expect(html).toContain('script nonce="test-nonce"');
    expect(html).not.toMatch(/(?:src|href)=["'](?:https?:|command:)|url\(["']?https?:|localStorage|setState|getState|innerHTML/);
    expect(messages).toEqual([{ type: "ready" }]);
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
});
