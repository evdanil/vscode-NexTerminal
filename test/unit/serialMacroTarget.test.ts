import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as VSCode from "vscode";
import type { TerminalMacro } from "../../src/models/terminalMacro";

const fixture = vi.hoisted(() => ({
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
    showQuickPick: vi.fn(async () => ({ index: 0 })),
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
  QuickInputButtons: { Back: {} }
}));
vi.mock("../../src/macroSettings", () => ({ getMacros: () => fixture.macros }));
vi.mock("../../src/ui/macroEditorPanel", () => ({ MacroEditorPanel: {} }));

import * as vscode from "vscode";
import { SerialPty, type SerialTransport } from "../../src/services/serial/serialPty";
import { SmartSerialPty } from "../../src/services/serial/smartSerialPty";
import { TerminalRegistry } from "../../src/services/terminal/terminalRegistry";
import { registerMacroCommands } from "../../src/commands/macroCommands";
import { createSerialMacroTargetResolver } from "../../src/commands/serialMacroTarget";

async function flush(): Promise<void> { for (let i = 0; i < 16; i++) await Promise.resolve(); }
const owners: Array<{ dispose(): void }> = [];

async function harness(smart: boolean, enabled: boolean, connect = true) {
  let count = 0;
  let disconnect: ((id: string, reason: string) => void) | undefined;
  const transport: SerialTransport & { listPorts(): Promise<{ path: string }[]> } = {
    openPort: vi.fn(async () => `physical-${++count}`), writePort: vi.fn(async () => {}), closePort: vi.fn(async () => {}),
    listPorts: async () => connect ? [{ path: "COM5" }] : [],
    onDidReceiveData: () => () => {}, onDidReceiveError: () => () => {},
    onDidDisconnect: (cb) => { disconnect = cb; return () => { disconnect = undefined; }; }
  };
  const profile = { id: "serial", name: "Console", path: "COM5", baudRate: 115200, dataBits: 8 as const, stopBits: 1 as const, parity: "none" as const, rtscts: false };
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
  const resolver = createSerialMacroTargetResolver(registry);
  registerMacroCommands(undefined, resolver);
  vi.mocked(vscode.commands.executeCommand).mockClear();
  vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command, args) => {
    if (command === "workbench.action.terminal.sendSequence") pty.handleInput((args as { text: string }).text);
  });
  return { pty, transport, terminal, other, registry, resolver, disconnect: () => disconnect?.("physical-1", "removed") };
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
  it.each(cases)("$route smart=$smart dedicated=$enabled prompted=$prompted preserves bytes once", async ({ route, smart, enabled, prompted }) => {
    const h = await harness(smart, enabled);
    const pending = invoke(route, macroFor(route, prompted));
    await flush();
    if (prompted) {
      expect(fixture.box).toBeDefined();
      Object.assign(vscode.window, { activeTerminal: h.other });
      fixture.box!.value = "é"; fixture.box!.accept();
    }
    await pending;
    expect(h.transport.writePort).toHaveBeenCalledExactlyOnceWith("physical-1", Buffer.from(" \té\r\n\n"));
    expect(h.terminal.sendText).not.toHaveBeenCalled(); expect(h.other.sendText).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.terminal.sendSequence", expect.anything());
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
    expect(done).toBe(false); expect(h.transport.writePort).toHaveBeenCalledExactlyOnceWith("physical-1", Buffer.from(payload));
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
    const h = await harness(false, true);
    Object.assign(vscode.window, { activeTerminal: h.other });
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    const pending = invoke("runBinding", macroFor("runBinding", false));
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.terminal.sendSequence", { text: " \té\r\n\n" });
    await pending;
    const prompted = invoke("runBinding", macroFor("runBinding", true)); await flush(); fixture.box!.value = "é"; fixture.box!.accept(); await prompted;
    expect(h.other.sendText).toHaveBeenCalledExactlyOnceWith(" \té\r\n\n", false); expect(h.transport.writePort).not.toHaveBeenCalled();
  });
});
