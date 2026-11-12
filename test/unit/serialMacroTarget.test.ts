import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as VSCode from "vscode";
import type { TerminalMacro } from "../../src/models/terminalMacro";

const fixture = vi.hoisted(() => ({
  webviewPanels: [] as Array<{ active: boolean; receive?: (message: unknown) => unknown; viewState?: (event: { webviewPanel: { active: boolean } }) => void }>,
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  macros: [] as TerminalMacro[],
  box: undefined as undefined | { value: string; accept(): void }
}));

vi.mock("vscode", () => ({
  Disposable: class { constructor(private readonly callback: () => void) {} dispose() { this.callback(); } },
  EventEmitter: class<T> {
    listeners = new Set<(value: T) => void>();
    event = (listener: (value: T) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value: T) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => { fixture.commands.set(id, handler); return { dispose() {} }; },
    executeCommand: vi.fn()
  },
  window: {
    activeTerminal: undefined,
    terminals: [],
    onDidChangeActiveTerminal: () => ({ dispose() {} }),
    onDidCloseTerminal: () => ({ dispose() {} }),
    // Just enough of a webview panel for the real SerialSendPanel.
    createWebviewPanel: () => {
      const record: (typeof fixture.webviewPanels)[number] = { active: true };
      fixture.webviewPanels.push(record);
      return {
        get active() { return record.active; },
        webview: { html: "", postMessage: async () => true, onDidReceiveMessage: (cb: (m: unknown) => unknown) => { record.receive = cb; return { dispose() {} }; } },
        onDidDispose: () => ({ dispose() {} }),
        onDidChangeViewState: (cb: (event: { webviewPanel: { active: boolean } }) => void) => { record.viewState = cb; return { dispose() {} }; },
        reveal() {}, dispose() {}
      };
    },
    showQuickPick: vi.fn(async () => ({ index: 0 })),
    showInformationMessage: vi.fn(async () => undefined),
    setStatusBarMessage: vi.fn(),
    createInputBox: () => {
      const accept = new Set<() => void>();
      const box = { value: "", show() {}, dispose() {}, accept() { for (const cb of [...accept]) cb(); },
        onDidAccept(cb: () => void) { accept.add(cb); return { dispose: () => accept.delete(cb) }; },
        onDidHide: () => ({ dispose() {} }), onDidTriggerButton: () => ({ dispose() {} }) };
      fixture.box = box;
      return box;
    }
  },
  workspace: { getConfiguration: () => ({ get: () => 1000 }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  QuickInputButtons: { Back: {} },
  ViewColumn: { Beside: 2 }
}));
vi.mock("../../src/macroSettings", () => ({ getMacros: () => fixture.macros }));
vi.mock("../../src/ui/macroEditorPanel", () => ({ MacroEditorPanel: {} }));

import * as vscode from "vscode";
import { SerialPty, type SerialTransport } from "../../src/services/serial/serialPty";
import { SmartSerialPty } from "../../src/services/serial/smartSerialPty";
import { TerminalRegistry } from "../../src/services/terminal/terminalRegistry";
import { registerMacroCommands, SERIAL_SEND_BOX_MACRO_SOURCE } from "../../src/commands/macroCommands";
import { createFocusedSendBoxMacroTarget, createSerialMacroNewlineLookup, createSerialMacroTargetResolver } from "../../src/commands/serialMacroTarget";
import type { SerialMacroNewline } from "../../src/models/config";
import { SerialSendPanel, type SerialSendBinding } from "../../src/ui/serialSendPanel";

async function flush(): Promise<void> { for (let i = 0; i < 16; i++) await Promise.resolve(); }
const owners: Array<{ dispose(): void }> = [];

/** A core stand-in whose live serial sessions and saved profiles the test controls. */
function fakeCore(sessions: Array<{ profileId: string; pty: unknown }>, profiles: Record<string, { macroNewline?: unknown }>) {
  return {
    getSnapshot: () => ({ activeSerialSessions: sessions as never }),
    getSerialProfile: (id: string) => profiles[id] as never
  };
}

async function harness(smart: boolean, enabled: boolean, connect = true, macroNewline?: SerialMacroNewline) {
  let count = 0;
  let disconnect: ((id: string, reason: string) => void) | undefined;
  const transport: SerialTransport & { listPorts(): Promise<{ path: string }[]> } = {
    openPort: vi.fn(async () => `physical-${++count}`), writePort: vi.fn(async () => {}), closePort: vi.fn(async () => {}),
    listPorts: async () => connect ? [{ path: "COM5" }] : [],
    onDidReceiveData: () => () => {}, onDidReceiveError: () => () => {},
    onDidDisconnect: (cb) => { disconnect = cb; return () => { disconnect = undefined; }; }
  };
  const profile: { id: string; name: string; path: string; baudRate: number; dataBits: 8; stopBits: 1; parity: "none"; rtscts: boolean; macroNewline?: SerialMacroNewline } =
    { id: "serial", name: "Console", path: "COM5", baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", rtscts: false, ...(macroNewline ? { macroNewline } : {}) };
  const pty = smart
    ? new SmartSerialPty(transport, profile, { onClosed() {}, getBusyPaths: () => new Set(), promptPortChoice: async () => ({ kind: "wait" }) }, { log() {}, close() {} })
    : new SerialPty(transport, profile, { onSessionOpened() {}, onSessionClosed() {} }, { log() {}, close() {} });
  owners.push(pty);
  const terminal = { name: "Console", sendText: vi.fn(), exitStatus: undefined } as unknown as VSCode.Terminal;
  const other = { name: "Other", sendText: vi.fn(), exitStatus: undefined } as unknown as VSCode.Terminal;
  Object.assign(vscode.window, { activeTerminal: terminal, terminals: [terminal, other] });
  const registry = new TerminalRegistry({ onDidChange: () => () => {}, getSnapshot: () => ({ activeSessions: [], activeSerialSessions: [], activeLocalShellSessions: [], activeLocalServerSessions: [] }) });
  owners.push(registry);
  registry.register(terminal, pty);
  if (connect || smart) pty.open();
  await flush();
  pty.setDedicatedInputEnabled(enabled);
  const resolver = createSerialMacroTargetResolver(registry, createSerialMacroNewlineLookup(fakeCore([{ profileId: "serial", pty }], { serial: profile })));
  registerMacroCommands(undefined, resolver);
  vi.mocked(vscode.commands.executeCommand).mockClear();
  vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command, args) => {
    if (command === "workbench.action.terminal.sendSequence") pty.handleInput((args as { text: string }).text);
  });
  return { pty, transport, terminal, other, registry, resolver, profile, disconnect: () => disconnect?.("physical-1", "removed") };
}

beforeEach(() => { vi.clearAllMocks(); fixture.commands.clear(); fixture.macros = []; fixture.box = undefined; });
afterEach(() => { for (const owner of owners.splice(0).reverse()) owner.dispose(); vi.useRealTimers(); });

const routes = ["run", "runBinding", "slot-binding", "slot-legacy", "runItem"] as const;
function invoke(route: typeof routes[number], macro: TerminalMacro): Promise<unknown> {
  fixture.macros = [macro];
  const command = route.startsWith("slot-") ? "slot" : route;
  const args = route === "runItem" ? { macro } : route === "runBinding" ? { binding: "alt+1" } : command === "slot" ? { index: 0 } : undefined;
  return Promise.resolve(fixture.commands.get(`nexus.macro.${command}`)!(args));
}
function macroFor(route: typeof routes[number], prompted: boolean): TerminalMacro {
  return { id: "macro", name: "Bytes", text: prompted ? " \t$value\r\n\n" : " \té\r\n\n", keybinding: route === "slot-legacy" ? "alt+2" : "alt+1", slot: 1,
    ...(prompted ? { variables: [{ name: "value" }] } : {}) };
}

describe("manual serial macro command-to-PTY routes", () => {
  const cases = routes.flatMap((route) => [false, true].flatMap((smart) => [false, true].flatMap((enabled) => [false, true].map((prompted) => ({ route, smart, enabled, prompted })))));
  // Issue #339: VS Code's sendText turned each \r?\n into CR; the direct PTY route must too, by default.
  it.each(cases)("$route smart=$smart dedicated=$enabled prompted=$prompted sends each newline as CR, once", async ({ route, smart, enabled, prompted }) => {
    const h = await harness(smart, enabled);
    const pending = invoke(route, macroFor(route, prompted));
    await flush();
    if (prompted) {
      expect(fixture.box).toBeDefined();
      Object.assign(vscode.window, { activeTerminal: h.other });
      fixture.box!.value = "é"; fixture.box!.accept();
    }
    await pending;
    expect(h.transport.writePort).toHaveBeenCalledExactlyOnceWith("physical-1", Buffer.from(" \té\r\r"));
    expect(h.terminal.sendText).not.toHaveBeenCalled(); expect(h.other.sendText).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.terminal.sendSequence", expect.anything());
  });

  const expected = { lf: " \té\n\n", crlf: " \té\r\n\r\n" } as const;
  it.each(routes.flatMap((route) => [false, true].flatMap((smart) => [false, true].flatMap((prompted) =>
    (["lf", "crlf"] as const).map((newline) => ({ route, smart, prompted, newline }))))))(
    "$route smart=$smart prompted=$prompted follows the profile's Macro Newline ($newline)", async ({ route, smart, prompted, newline }) => {
      const h = await harness(smart, true, true, newline);
      const pending = invoke(route, macroFor(route, prompted));
      await flush();
      if (prompted) { fixture.box!.value = "é"; fixture.box!.accept(); }
      await pending;
      expect(h.transport.writePort).toHaveBeenCalledExactlyOnceWith("physical-1", Buffer.from(expected[newline]));
    });

  it.each([false, true])("converts newlines inside variable values and reads the profile at send time (smart=%s)", async (smart) => {
    const h = await harness(smart, true);
    const macro: TerminalMacro = { id: "macro", name: "Bytes", text: "set $value\n", keybinding: "alt+1", variables: [{ name: "value" }] };
    const pending = invoke("runBinding", macro);
    await flush();
    // Edited while the prompt is open: the send uses the profile as saved now.
    h.profile.macroNewline = "crlf";
    fixture.box!.value = "a\nb\r\nc\rd"; fixture.box!.accept();
    await pending;
    expect(h.transport.writePort).toHaveBeenCalledExactlyOnceWith("physical-1", Buffer.from("set a\r\nb\r\nc\rd\r\n"));
  });

  it.each(routes.flatMap((route) => [false, true].flatMap((smart) => ["lock", "close", "reconnect"].map((change) => ({ route, smart, change })))))(
    "$route smart=$smart refuses $change while prompting without a success status", async ({ route, smart, change }) => {
      vi.useFakeTimers();
      const h = await harness(smart, true);
      const pending = invoke(route, macroFor(route, true)); await flush();
      if (change === "lock") h.pty.setInputBlocked(true);
      else if (change === "close") { h.registry.unregister(h.terminal); Object.assign(vscode.window, { terminals: [h.other] }); }
      else { h.disconnect(); if (smart) { await vi.advanceTimersByTimeAsync(2000); await flush(); } }
      Object.assign(vscode.window, { activeTerminal: h.other });
      fixture.box!.value = "secret-value"; fixture.box!.accept(); await pending;
      expect(h.transport.writePort).not.toHaveBeenCalled(); expect(h.terminal.sendText).not.toHaveBeenCalled(); expect(h.other.sendText).not.toHaveBeenCalled();
      const messages = vi.mocked(vscode.window.setStatusBarMessage).mock.calls.map(([message]) => message).join("\n");
      expect(messages).toMatch(/nothing was sent|send failed/i); expect(messages).not.toContain('Macro "Bytes" sent'); expect(messages).not.toContain("secret-value");
    });
});

describe("createSerialMacroNewlineLookup", () => {
  it("reads the saved setting of the profile whose live session owns the PTY, and nothing for an unknown PTY", () => {
    const ptyA = {}; const ptyB = {}; const stranger = {};
    const profiles: Record<string, { macroNewline?: unknown }> = { a: { macroNewline: "lf" }, b: { macroNewline: "crlf" } };
    const lookup = createSerialMacroNewlineLookup(fakeCore([{ profileId: "b", pty: ptyB }, { profileId: "a", pty: ptyA }], profiles));
    expect(lookup(ptyA as never)).toBe("lf");
    expect(lookup(ptyB as never)).toBe("crlf");
    expect(lookup(stranger as never)).toBeUndefined();
    profiles.a = { macroNewline: "crlf" };
    expect(lookup(ptyA as never)).toBe("crlf");
    delete profiles.a;
    expect(lookup(ptyA as never)).toBeUndefined();
  });
});

describe("serial adapter", () => {
  it.each(["waiting", "stopped", "closed", "disconnected"] as const)("returns a refusing target for a known %s serial owner", async (status) => {
    const h = await harness(status !== "disconnected", true, status !== "waiting");
    if (status === "stopped") h.pty.markShuttingDown("shutdown");
    if (status === "closed") h.pty.dispose();
    if (status === "disconnected") h.disconnect();
    expect(h.pty.getInputState().status).toBe(status);
    const target = h.resolver(h.terminal);
    expect(target).toBeDefined(); expect(await target!.send("no" )).toBe(false);
    expect(h.transport.writePort).not.toHaveBeenCalled(); expect(h.terminal.sendText).not.toHaveBeenCalled();
  });
  it("preserves macros beyond the composer size bound and waits for driver acknowledgement", async () => {
    const h = await harness(false, true);
    let complete!: () => void;
    vi.mocked(h.transport.writePort).mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    let done = false;
    const payload = " "+"é".repeat(65536)+"\r\n";
    const sending = h.resolver(h.terminal)!.send(payload) as Promise<boolean>;
    void sending.then(() => { done = true; }); await flush();
    expect(done).toBe(false); expect(h.transport.writePort).toHaveBeenCalledExactlyOnceWith("physical-1", Buffer.from(payload.replace("\r\n", "\r")));
    complete(); expect(await sending).toBe(true);
    vi.mocked(h.transport.writePort).mockRejectedValueOnce(new Error("driver error with secret-value"));
    expect(await h.resolver(h.terminal)!.send("secret-value")).toBe(false);
    expect(JSON.stringify(vi.mocked(vscode.window.setStatusBarMessage).mock.calls)).not.toContain("secret-value");
  });
  it("returns undefined only for nonserial terminals and rejects a replaced PTY identity", async () => {
    const h = await harness(false, true);
    expect(h.resolver(h.other)).toBeUndefined();
    const target = h.resolver(h.terminal)!;
    h.registry.unregister(h.terminal); h.registry.register(h.terminal, { addOutputObserver: () => ({ dispose() {} }) } as never);
    expect(await target.send("no")).toBe(false); expect(h.transport.writePort).not.toHaveBeenCalled();
  });
  it("retains the nonserial same-tick sendSequence and prompted sendText delivery", async () => {
    // A serial profile set to CRLF must not reach a nonserial terminal: its text goes to VS Code unchanged.
    const h = await harness(false, true, true, "crlf");
    Object.assign(vscode.window, { activeTerminal: h.other });
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    const pending = invoke("runBinding", macroFor("runBinding", false));
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.terminal.sendSequence", { text: " \té\r\n\n" });
    await pending;
    const prompted = invoke("runBinding", macroFor("runBinding", true)); await flush(); fixture.box!.value = "é"; fixture.box!.accept(); await prompted;
    expect(h.other.sendText).toHaveBeenCalledExactlyOnceWith(" \té\r\n\n", false); expect(h.transport.writePort).not.toHaveBeenCalled();
  });
});

describe("macro shortcuts from a focused Serial Send Box", () => {
  async function serialSession(name: string) {
    let count = 0;
    const transport: SerialTransport = {
      openPort: vi.fn(async () => `${name}-physical-${++count}`), writePort: vi.fn(async () => {}), closePort: vi.fn(async () => {}),
      onDidReceiveData: () => () => {}, onDidReceiveError: () => () => {}, onDidDisconnect: () => () => {}
    };
    const profile = { id: name, name, path: `/dev/${name}`, baudRate: 115200, dataBits: 8 as const, stopBits: 1 as const, parity: "none" as const, rtscts: false };
    const pty = new SerialPty(transport, profile, { onSessionOpened() {}, onSessionClosed() {} }, { log() {}, close() {} });
    owners.push(pty);
    const terminal = { name, sendText: vi.fn(), exitStatus: undefined } as unknown as VSCode.Terminal;
    return { pty, transport, terminal, saved: { macroNewline: undefined as SerialMacroNewline | undefined } };
  }

  async function sendBoxHarness() {
    const a = await serialSession("A");
    const b = await serialSession("B");
    Object.assign(vscode.window, { activeTerminal: b.terminal, terminals: [a.terminal, b.terminal] });
    const registry = new TerminalRegistry({ onDidChange: () => () => {}, getSnapshot: () => ({ activeSessions: [], activeLocalShellSessions: [], activeLocalServerSessions: [], activeSerialSessions: [] }) });
    owners.push(registry);
    registry.register(a.terminal, a.pty);
    registry.register(b.terminal, b.pty);
    a.pty.open(); b.pty.open();
    await flush();
    // Dedicated input on A, as a send box would set it.
    a.pty.setDedicatedInputEnabled(true);
    const panel = { focused: { sessionId: "A", profileName: "A", terminal: a.terminal, input: a.pty } as SerialSendBinding | undefined,
      getFocusedBinding() { return this.focused; } };
    // B is listed first, so a lookup that ignored PTY identity would read B's setting for A's box.
    const core = fakeCore([{ profileId: "B", pty: b.pty }, { profileId: "A", pty: a.pty }], { A: a.saved, B: b.saved });
    const resolver = createSerialMacroTargetResolver(registry, createSerialMacroNewlineLookup(core));
    registerMacroCommands(undefined, resolver, createFocusedSendBoxMacroTarget(panel, registry, resolver));
    vi.mocked(vscode.commands.executeCommand).mockClear();
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    return { a, b, registry, panel, core };
  }
  const sendBox = { source: SERIAL_SEND_BOX_MACRO_SOURCE };
  const NO_FOCUSED_BOX = "Click into the serial send box, then press the shortcut again. Nothing was sent.";
  const SESSION_GONE = "The serial send box's session is no longer available. Nothing was sent.";
  const plain: TerminalMacro = { id: "plain", name: "Plain", text: "show run\r", keybinding: "alt+1" };
  const prompted: TerminalMacro = { id: "prompted", name: "Prompted", text: "ping $host\r", keybinding: "alt+1", variables: [{ name: "host" }] };
  const run = (command: string, args: unknown) => Promise.resolve(fixture.commands.get(command)!(args));
  function expectNothingSent(h: Awaited<ReturnType<typeof sendBoxHarness>>) {
    expect(h.a.transport.writePort).not.toHaveBeenCalled(); expect(h.b.transport.writePort).not.toHaveBeenCalled();
    expect(h.a.terminal.sendText).not.toHaveBeenCalled(); expect(h.b.terminal.sendText).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.terminal.sendSequence", expect.anything());
  }

  it.each([false, true])("runBinding targets the focused box's session, not activeTerminal (prompted=%s)", async (withVariables) => {
    const h = await sendBoxHarness();
    fixture.macros = [withVariables ? prompted : plain];
    const pending = run("nexus.macro.runBinding", { binding: "alt+1", ...sendBox });
    await flush();
    if (withVariables) {
      // The prompt takes focus from the box; the pinned session must not change.
      h.panel.focused = undefined;
      fixture.box!.value = "10.0.0.1"; fixture.box!.accept();
    }
    await pending;
    expect(h.a.transport.writePort).toHaveBeenCalledExactlyOnceWith("A-physical-1", Buffer.from(withVariables ? "ping 10.0.0.1\r" : "show run\r"));
    expect(h.b.transport.writePort).not.toHaveBeenCalled(); expect(h.b.terminal.sendText).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.terminal.sendSequence", expect.anything());
  });

  it.each([[undefined, "show run\r"], ["lf", "show run\n"], ["crlf", "show run\r\n"]] as const)(
    "a shortcut from the box sends newlines as its own profile's Macro Newline (%s), not the active terminal's", async (newline, bytes) => {
      const h = await sendBoxHarness();
      h.a.saved.macroNewline = newline;
      // The active terminal's profile differs, so reading the wrong session's setting shows up.
      h.b.saved.macroNewline = newline === "lf" ? "crlf" : "lf";
      fixture.macros = [{ id: "nl", name: "Newline", text: "show run\n", keybinding: "alt+1" }];
      await run("nexus.macro.runBinding", { binding: "alt+1", ...sendBox });
      expect(h.a.transport.writePort).toHaveBeenCalledExactlyOnceWith("A-physical-1", Buffer.from(bytes));
      expect(h.b.transport.writePort).not.toHaveBeenCalled();
    });

  it("the Alt+S picker pins the focused box before the pick resolves", async () => {
    const h = await sendBoxHarness();
    fixture.macros = [plain];
    let choose!: (value: { index: number }) => void;
    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(() => new Promise((resolve) => { choose = resolve as typeof choose; }) as never);
    const pending = run("nexus.macro.run", sendBox);
    await flush();
    h.panel.focused = { sessionId: "B", profileName: "B", terminal: h.b.terminal, input: h.b.pty };
    choose({ index: 0 });
    await pending;
    expect(h.a.transport.writePort).toHaveBeenCalledExactlyOnceWith("A-physical-1", Buffer.from("show run\r"));
    expect(h.b.transport.writePort).not.toHaveBeenCalled();
  });

  it.each(["unfocused", "unregistered", "replaced", "closed"] as const)("refuses with no fallback when the box's session is %s", async (change) => {
    const h = await sendBoxHarness();
    fixture.macros = [plain];
    if (change === "unfocused") h.panel.focused = undefined;
    if (change === "unregistered") h.registry.unregister(h.a.terminal);
    if (change === "replaced") { h.registry.unregister(h.a.terminal); h.registry.register(h.a.terminal, h.b.pty); }
    if (change === "closed") h.a.pty.dispose();
    await run("nexus.macro.runBinding", { binding: "alt+1", ...sendBox });
    await run("nexus.macro.run", sendBox);
    expectNothingSent(h);
    const statuses = vi.mocked(vscode.window.setStatusBarMessage).mock.calls.map(([m]) => String(m));
    // A closed but still-registered owner resolves to a target that refuses at delivery, like the terminal path;
    // the others are captured as unavailable and refused once the macro is bound for a session.
    if (change === "closed") expect(statuses.join("\n")).toMatch(/nothing was sent/i);
    else expect(statuses.filter((m) => m === (change === "unfocused" ? NO_FOCUSED_BOX : SESSION_GONE))).toHaveLength(2);
    // Each state has its own message; the other one never appears.
    expect(statuses).not.toContain(change === "unfocused" ? SESSION_GONE : NO_FOCUSED_BOX);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("a stale focus pointer on an inactive box sends nothing to it (switching boxes)", async () => {
    const h = await sendBoxHarness();
    fixture.webviewPanels = [];
    const panel = new SerialSendPanel({ setContext: () => {} });
    owners.push(panel);
    panel.openOrReveal({ sessionId: "A", profileName: "A", terminal: h.a.terminal, input: h.a.pty });
    panel.openOrReveal({ sessionId: "B", profileName: "B", terminal: h.b.terminal, input: h.b.pty });
    const [boxA, boxB] = fixture.webviewPanels;
    await boxA.receive!({ type: "focusChanged", focused: true });
    const resolver = createSerialMacroTargetResolver(h.registry, createSerialMacroNewlineLookup(h.core));
    registerMacroCommands(undefined, resolver, createFocusedSendBoxMacroTarget(panel, h.registry, resolver));
    // The user switches to B: VS Code has updated active state, but neither A's blur
    // nor B's focus report (nor A's view-state listener) has run yet.
    boxA.active = false;
    boxB.active = true;
    fixture.macros = [plain];
    await run("nexus.macro.runBinding", { binding: "alt+1", ...sendBox });
    expectNothingSent(h);
    expect(vi.mocked(vscode.window.setStatusBarMessage)).toHaveBeenCalledWith(NO_FOCUSED_BOX, 4000);
    // Once B's own focus report lands, its shortcut goes to B.
    await boxB.receive!({ type: "focusChanged", focused: true });
    await run("nexus.macro.runBinding", { binding: "alt+1", ...sendBox });
    expect(h.b.transport.writePort).toHaveBeenCalledExactlyOnceWith("B-physical-1", Buffer.from("show run\r"));
    expect(h.a.transport.writePort).not.toHaveBeenCalled();
  });

  const profileMacros: Array<[string, TerminalMacro]> = [
    ["profile token", { id: "prof", name: "Prof", text: "ssh ${profile.host}\r", keybinding: "alt+1" }],
    ["non-session target", { id: "web", name: "Web", text: "https://example.test", keybinding: "alt+1", runIn: "browser" } as TerminalMacro]
  ];
  it.each(profileMacros.flatMap(([label, macro]) => (["runBinding", "run"] as const).flatMap((route) =>
    (["unfocused", "sessionGone", "live"] as const).map((state) => ({ label, macro, route, state })))))(
    "$route: a $label macro from a send box ($state) is offered Run Macro on Server, not refused", async ({ macro, route, state }) => {
      const h = await sendBoxHarness();
      fixture.macros = [macro];
      if (state === "unfocused") h.panel.focused = undefined;
      if (state === "sessionGone") h.registry.unregister(h.a.terminal);
      await run(`nexus.macro.${route}`, route === "run" ? sendBox : { binding: "alt+1", ...sendBox });
      expect(vscode.window.showInformationMessage).toHaveBeenCalledExactlyOnceWith(`"${macro.name}" runs against a server profile. Pick the server to run it on.`, "Run Macro on Server…");
      expect(vi.mocked(vscode.window.setStatusBarMessage).mock.calls.map(([m]) => String(m)).join("\n")).not.toMatch(/no longer available|Click into/);
      expectNothingSent(h);
    });

  it("a script lock on the box's session still blocks the shortcut", async () => {
    const h = await sendBoxHarness();
    fixture.macros = [plain];
    h.a.pty.setInputBlocked(true);
    await run("nexus.macro.runBinding", { binding: "alt+1", ...sendBox });
    expectNothingSent(h);
  });

  it.each([undefined, {}, { source: "serialsendbox" }, { source: ["serialSendBox"] }])("invocations without the send-box source keep resolving activeTerminal: %j", async (extra) => {
    const h = await sendBoxHarness();
    fixture.macros = [plain];
    await run("nexus.macro.runBinding", { binding: "alt+1", ...(extra ?? {}) });
    await run("nexus.macro.run", extra);
    await run("nexus.macro.runItem", { macro: plain });
    expect(h.b.transport.writePort).toHaveBeenCalledTimes(3);
    expect(h.a.transport.writePort).not.toHaveBeenCalled();
  });
});
