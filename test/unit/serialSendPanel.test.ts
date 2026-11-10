import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { SerialInputState, SerialUserInput } from "../../src/services/serial/serialUserInput";
import { SerialSendPanel } from "../../src/ui/serialSendPanel";

function events<T>() {
  const listeners = new Set<(value: T) => unknown>();
  return {
    event: ((listener: (value: T) => unknown) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }) as vscode.Event<T>,
    fire: (value: T) => { for (const listener of [...listeners]) listener(value); },
    listeners
  };
}

interface FakePanel {
  webview: { html: string; postMessage: ReturnType<typeof vi.fn>; onDidReceiveMessage: vscode.Event<unknown> };
  receive: ReturnType<typeof events<unknown>>;
  closed: ReturnType<typeof events<void>>;
  onDidDispose: vscode.Event<void>;
  reveal: ReturnType<typeof vi.fn<(column?: number) => void>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
  message: (value: unknown) => Promise<void>;
}

const host = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn() }));
vi.mock("vscode", () => ({
  window: { createWebviewPanel: host.create, onDidCloseTerminal: host.close },
  ViewColumn: { Beside: 2 }
}));

function panel(): FakePanel {
  const receive = events<unknown>();
  const closed = events<void>();
  return {
    receive, closed,
    webview: { html: "", postMessage: vi.fn(async () => true), onDidReceiveMessage: receive.event },
    onDidDispose: closed.event,
    reveal: vi.fn(),
    dispose: vi.fn(() => closed.fire()),
    message: async (value) => { await Promise.all([...receive.listeners].map((listener) => listener(value))); }
  };
}

function binding(sessionId = "session-1") {
  const changed = events<SerialInputState>();
  let state: SerialInputState = {
    connectionEpoch: 1, status: "connected", connected: true,
    inputLocked: false, dedicatedInputEnabled: false, path: "/dev/test"
  };
  const input: SerialUserInput & { writeProgrammatic: ReturnType<typeof vi.fn> } = {
    getInputState: () => state,
    onDidChangeInputState: changed.event,
    setDedicatedInputEnabled: vi.fn((enabled: boolean) => {
      state = { ...state, dedicatedInputEnabled: enabled };
      changed.fire(state);
    }),
    sendUserInput: vi.fn(async () => undefined),
    writeProgrammatic: vi.fn(async () => undefined)
  };
  return {
    sessionId, profileName: "<script>profile</script>",
    terminal: { show: vi.fn() } as unknown as vscode.Terminal,
    input, changed,
    change: (patch: Partial<SerialInputState>, emit = true) => {
      state = { ...state, ...patch };
      if (emit) changed.fire(state);
    }
  };
}

const send = (requestId = 1, connectionEpoch = 1) => ({
  type: "send", requestId, connectionEpoch, text: "show\nstatus", lineEnding: "crlf"
});

describe("serial send panel host boundary", () => {
  let registry: SerialSendPanel;
  let panels: FakePanel[];
  let terminalClosed: ReturnType<typeof events<vscode.Terminal>>;
  beforeEach(() => {
    panels = [];
    terminalClosed = events<vscode.Terminal>();
    host.create.mockReset().mockImplementation(() => { const p = panel(); panels.push(p); return p; });
    host.close.mockReset().mockImplementation(terminalClosed.event);
    registry = new SerialSendPanel();
  });
  afterEach(() => registry.dispose());

  it("creates one retained, sandboxed panel per logical session and reveals without replacing HTML", () => {
    const first = binding();
    registry.openOrReveal(first);
    const html = panels[0].webview.html;
    registry.openOrReveal(first);
    registry.openOrReveal(binding("session-2"));
    expect(panels).toHaveLength(2);
    expect(panels[0].reveal).toHaveBeenCalledOnce();
    expect(panels[0].webview.html).toBe(html);
    expect(html).not.toContain(first.profileName);
    expect(host.create.mock.calls[0][3]).toEqual({ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    expect(first.input.getInputState().dedicatedInputEnabled).toBe(true);
  });

  it("identifies differently named sessions in plain tab titles without putting names in HTML", () => {
    const first = binding();
    const second = binding("session-2");
    second.profileName = "Router Console";
    registry.openOrReveal(first);
    registry.openOrReveal(second);
    expect(host.create.mock.calls.map(call => call[1])).toEqual([
      `Serial Send: ${first.profileName}`,
      "Serial Send: Router Console"
    ]);
    expect(panels[0].webview.html).not.toContain(first.profileName);
    expect(panels[1].webview.html).not.toContain(second.profileName);
  });

  it("cannot replace the input owner or terminal behind an existing logical session", async () => {
    const first = binding();
    const forged = binding();
    registry.openOrReveal(first);
    expect(() => registry.openOrReveal(forged)).toThrow();
    await panels[0].message(send());
    expect(first.input.sendUserInput).toHaveBeenCalledWith("show\r\nstatus\r\n", 1);
    expect(forged.input.sendUserInput).not.toHaveBeenCalled();
  });

  it.each([
    ["none", "α\r\nβ\n"], ["cr", "α\rβ\r\r"], ["lf", "α\nβ\n\n"], ["crlf", "α\r\nβ\r\n\r\n"]
  ])("uses guarded user input with exact %s conversion", async (lineEnding, expected) => {
    const b = binding();
    registry.openOrReveal(b);
    await panels[0].message({ ...send(), text: "α\r\nβ\n", lineEnding });
    expect(b.input.sendUserInput).toHaveBeenCalledExactlyOnceWith(expected, 1);
    expect(b.input.writeProgrammatic).not.toHaveBeenCalled();
  });

  it("captures the host binding once even if its caller later mutates the supplied object", async () => {
    const b = binding();
    const original = b.input;
    registry.openOrReveal(b);
    b.input = binding("other").input;
    b.sessionId = "other";
    await panels[0].message(send());
    expect(original.sendUserInput).toHaveBeenCalledExactlyOnceWith("show\r\nstatus\r\n", 1);
    expect(b.input.sendUserInput).not.toHaveBeenCalled();
    registry.disposeForSession("session-1");
    expect(original.getInputState().dedicatedInputEnabled).toBe(false);
  });

  it("does not enable dedicated input if creation fails", () => {
    const b = binding();
    host.create.mockImplementationOnce(() => { throw new Error("host failure"); });
    expect(() => registry.openOrReveal(b)).toThrow();
    expect(b.input.setDedicatedInputEnabled).not.toHaveBeenCalled();
    expect(b.input.getInputState().dedicatedInputEnabled).toBe(false);
  });

  it("rolls back mode and listeners if enabling fails after changing mode", () => {
    const b = binding();
    vi.mocked(b.input.setDedicatedInputEnabled).mockImplementationOnce(() => {
      b.change({ dedicatedInputEnabled: true });
      throw new Error("enable failed");
    });
    expect(() => registry.openOrReveal(b)).toThrow();
    expect(b.input.getInputState().dedicatedInputEnabled).toBe(false);
    expect(b.changed.listeners.size).toBe(0);
    expect(panels[0].dispose).toHaveBeenCalledOnce();
  });

  it("closing twice restores direct mode and releases subscriptions exactly once", () => {
    const b = binding();
    registry.openOrReveal(b);
    panels[0].dispose();
    panels[0].dispose();
    registry.disposeForSession(b.sessionId);
    expect(b.input.setDedicatedInputEnabled).toHaveBeenCalledTimes(2);
    expect(b.input.setDedicatedInputEnabled).toHaveBeenLastCalledWith(false);
    expect(b.changed.listeners.size).toBe(0);
    expect(panels[0].receive.listeners.size).toBe(0);
  });

  it("terminal close disposes only its bound panel", () => {
    const a = binding();
    const b = binding("session-2");
    registry.openOrReveal(a);
    registry.openOrReveal(b);
    terminalClosed.fire(a.terminal);
    expect(panels[0].dispose).toHaveBeenCalledOnce();
    expect(panels[1].dispose).not.toHaveBeenCalled();
    expect(a.input.getInputState().dedicatedInputEnabled).toBe(false);
  });

  it("session/profile removal and extension teardown release all panels and the terminal listener", () => {
    const a = binding();
    const b = binding("session-2");
    registry.openOrReveal(a);
    registry.openOrReveal(b);
    registry.disposeForSession(a.sessionId);
    registry.dispose();
    registry.dispose();
    expect(panels.every((p) => p.dispose.mock.calls.length === 1)).toBe(true);
    expect(a.changed.listeners.size + b.changed.listeners.size + terminalClosed.listeners.size).toBe(0);
    expect(() => registry.openOrReveal(binding("late"))).toThrow();
  });

  it("owner disposal closes without attempting to re-enable direct input on a closed PTY", () => {
    const b = binding();
    registry.openOrReveal(b);
    b.change({ status: "closed", connected: false });
    expect(panels[0].dispose).toHaveBeenCalledOnce();
    expect(b.input.setDedicatedInputEnabled).toHaveBeenCalledTimes(1);
  });

  it.each(["opening", "waiting", "stopped", "disconnected"] as const)("publishes truthful %s state without closing or replacing the editor", async (status) => {
    const b = binding();
    registry.openOrReveal(b);
    const html = panels[0].webview.html;
    b.change({ status, connected: false });
    await panels[0].message({ type: "ready" });
    expect(panels[0].webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "state", status, connected: false }));
    expect(panels[0].webview.html).toBe(html);
    expect(panels[0].dispose).not.toHaveBeenCalled();
    await panels[0].message(send());
    expect(b.input.sendUserInput).not.toHaveBeenCalled();
  });

  it("Smart Follow reconnect exposes a new epoch and accepts only that epoch", async () => {
    const b = binding();
    registry.openOrReveal(b);
    b.change({ status: "waiting", connected: false });
    b.change({ status: "connected", connected: true, connectionEpoch: 3, path: "/dev/replacement" });
    await panels[0].message(send());
    await panels[0].message(send(2, 3));
    expect(b.input.sendUserInput).toHaveBeenCalledExactlyOnceWith("show\r\nstatus\r\n", 3);
  });

  it("rechecks script lock at handler invocation even without an event", async () => {
    const b = binding();
    registry.openOrReveal(b);
    b.change({ inputLocked: true }, false);
    await panels[0].message(send());
    expect(b.input.sendUserInput).not.toHaveBeenCalled();
    expect(b.input.writeProgrammatic).not.toHaveBeenCalled();
    expect(panels[0].webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.stringContaining("script") }));
  });

  it.each([
    null, [], { type: "unknown" }, { ...send(), text: {} }, { ...send(), lineEnding: "bad" },
    { ...send(), sessionId: "other" }, { ...send(), transportId: "other" },
    { ...send(), profileId: "other" }, { ...send(), command: "nexus.any" },
    { ...send(), requestId: NaN }, { ...send(), requestId: Infinity }, { ...send(), requestId: 1.5 },
    { ...send(), requestId: 0 }, { ...send(), connectionEpoch: -1 },
    { ...send(), connectionEpoch: 1.5 }, { ...send(), text: "😀".repeat(16385) },
    { ...send(), text: "a".repeat(65536), lineEnding: "crlf" }, { ...send(), text: "", lineEnding: "none" }
  ])("ignores/refuses hostile shape without writing: %j", async (message) => {
    const b = binding();
    registry.openOrReveal(b);
    await panels[0].message(message);
    expect(b.input.sendUserInput).not.toHaveBeenCalled();
    expect(b.input.writeProgrammatic).not.toHaveBeenCalled();
  });

  it("never lets a page focus or disable a different terminal", async () => {
    const b = binding();
    registry.openOrReveal(b);
    await panels[0].message({ type: "focusTerminal", sessionId: "other" });
    await panels[0].message({ type: "useDirectInput", command: "other" });
    expect(b.terminal.show).not.toHaveBeenCalled();
    expect(panels[0].dispose).not.toHaveBeenCalled();
    await panels[0].message({ type: "focusTerminal" });
    expect(b.terminal.show).toHaveBeenCalledWith(false);
    await panels[0].message({ type: "useDirectInput" });
    expect(b.input.getInputState().dedicatedInputEnabled).toBe(false);
    expect(panels[0].dispose).toHaveBeenCalledOnce();
  });

  it("allows only one in-flight write, answers each ID at most once, and rejects old IDs", async () => {
    const b = binding();
    let finish!: () => void;
    vi.mocked(b.input.sendUserInput).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    registry.openOrReveal(b);
    const first = panels[0].message(send());
    await panels[0].message(send());
    await panels[0].message(send(2));
    expect(b.input.sendUserInput).toHaveBeenCalledTimes(1);
    finish();
    await first;
    await panels[0].message(send());
    await panels[0].message(send(2));
    const results = panels[0].webview.postMessage.mock.calls.map(([value]) => value).filter((value) => value.type === "sendResult");
    expect(results).toEqual([
      expect.objectContaining({ requestId: 2, ok: false }),
      { type: "sendResult", requestId: 1, ok: true }
    ]);
    await panels[0].message(send(3));
    expect(b.input.sendUserInput).toHaveBeenCalledTimes(2);
  });

  it("does not publish a late result after disposal or to a newly opened panel", async () => {
    const b = binding();
    let finish!: () => void;
    vi.mocked(b.input.sendUserInput).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    registry.openOrReveal(b);
    const first = panels[0].message(send());
    panels[0].dispose();
    registry.openOrReveal(b);
    panels[0].webview.postMessage.mockClear();
    panels[1].webview.postMessage.mockClear();
    finish();
    await first;
    expect(panels[0].webview.postMessage).not.toHaveBeenCalled();
    expect(panels[1].webview.postMessage).not.toHaveBeenCalled();
  });

  it("does not confirm an old connection after a delayed driver acknowledgement", async () => {
    const b = binding();
    let finish!: () => void;
    vi.mocked(b.input.sendUserInput).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    registry.openOrReveal(b);
    const first = panels[0].message(send());
    b.change({ connectionEpoch: 2 });
    finish();
    await first;
    expect(panels[0].webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 1, ok: false }));
  });

  it("keeps arbitrary transport failure/draft out of diagnostics and makes no automatic retry", async () => {
    const b = binding();
    vi.mocked(b.input.sendUserInput).mockRejectedValue(new Error("SECRET draft show status"));
    registry.openOrReveal(b);
    await panels[0].message(send());
    const result = panels[0].webview.postMessage.mock.calls.at(-1)![0];
    expect(result).toMatchObject({ type: "sendResult", ok: false });
    expect(result.error).toMatch(/partial|unknown/i);
    expect(result.error).not.toContain("SECRET");
    expect(result.error).not.toContain("show");
    expect(b.input.sendUserInput).toHaveBeenCalledTimes(1);
  });
});
