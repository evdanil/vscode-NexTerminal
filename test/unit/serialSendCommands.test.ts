import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as VSCode from "vscode";
import type { SerialInputState, SerialUserInput } from "../../src/services/serial/serialUserInput";
import type { SerialTerminalEntry } from "../../src/commands/types";

const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
const closeListeners = new Set<(terminal: VSCode.Terminal) => void>();
const pick = vi.fn(); const info = vi.fn(); const warning = vi.fn(); const execute = vi.fn();
vi.mock("vscode", () => ({
  commands: { registerCommand: vi.fn((id, fn) => { handlers.set(id, fn); return { dispose: vi.fn() }; }), executeCommand: (...args: unknown[]) => execute(...args) },
  window: { activeTerminal: undefined, onDidCloseTerminal: (fn: (terminal: VSCode.Terminal) => void) => { closeListeners.add(fn); return { dispose: () => closeListeners.delete(fn) }; }, showQuickPick: (...args: unknown[]) => pick(...args), showInformationMessage: (...args: unknown[]) => info(...args), showWarningMessage: (...args: unknown[]) => warning(...args) }
}));
import * as vscode from "vscode";
import { SerialSendCommands } from "../../src/commands/serialSendCommands";

function terminal(name: string): VSCode.Terminal { return { name, creationOptions: {}, show: vi.fn() } as unknown as VSCode.Terminal; }
function input(status: SerialInputState["status"] = "connected") {
  let state: SerialInputState = { connectionEpoch: 1, connected: status === "connected", status, inputLocked: false, dedicatedInputEnabled: false };
  const listeners = new Set<(s: SerialInputState) => void>();
  const owner: SerialUserInput = {
    getInputState: () => state,
    onDidChangeInputState: ((fn: (s: SerialInputState) => void) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; }) as VSCode.Event<SerialInputState>,
    setDedicatedInputEnabled: vi.fn((enabled: boolean) => change({ dedicatedInputEnabled: enabled })), sendUserInput: vi.fn()
  };
  function change(patch: Partial<SerialInputState>) { state = { ...state, ...patch }; for (const fn of listeners) fn(state); }
  return { owner, change, listeners };
}
function fixture(status: SerialInputState["status"] = "connected") {
  const a = terminal("A"), b = terminal("B"); const ia = input(), ib = input(status);
  const entries = new Map<string, SerialTerminalEntry>([["sa", { terminal: a, profileId: "pa", input: ia.owner }], ["sb", { terminal: b, profileId: "pb", input: ib.owner, smartFollow: status === "waiting" || status === "stopped" }]]);
  let profiles = [{ id: "pa", name: "A" }, { id: "pb", name: "B" }]; let sessions = [{ id: "sa" }, { id: "sb" }];
  const listeners = new Set<() => void>();
  const core = { getSerialProfile: (id: string) => profiles.find(p => p.id === id), getSnapshot: () => ({ serialProfiles: profiles, activeSerialSessions: sessions }), onDidChange: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
  const panel = { openOrReveal: vi.fn(), disposeForSession: vi.fn(), dispose: vi.fn() };
  const refresh = vi.fn(); const registry = { get: vi.fn() };
  const service = new SerialSendCommands({ core: core as never, serialTerminals: entries, panel, terminalRegistry: registry as never, onDedicatedSessionsChanged: refresh });
  Object.assign(vscode.window, { activeTerminal: a });
  const run = (...args: [arg?: unknown, direct?: boolean]) => {
    const [arg, direct = false] = args;
    const handler = handlers.get(direct ? "nexus.serial.useDirectInput" : "nexus.serial.openSendBox")!;
    return args.length === 0 ? handler() : handler(arg);
  };
  const changed = () => { for (const fn of listeners) fn(); };
  return { a, b, ia, ib, entries, panel, refresh, registry, service, run, changed, listeners, removeProfiles: () => { profiles = []; changed(); }, removeSessions: () => { sessions = []; changed(); } };
}
beforeEach(() => { vi.clearAllMocks(); handlers.clear(); closeListeners.clear(); pick.mockReset(); info.mockReset(); warning.mockReset(); });
describe("serial send command ownership", () => {
  it.each(["terminal", "session", "profile", "sessionId", "profileId"])("clicked B via %s wins over active A", async shape => {
    const f = fixture(); const arg = { terminal: f.b, session: { session: { id: "sb" } }, profile: { profile: { id: "pb" } }, sessionId: "sb", profileId: "pb" }[shape];
    await f.run(arg); expect(f.panel.openOrReveal).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sb", terminal: f.b, input: f.ib.owner })); expect(pick).not.toHaveBeenCalled();
  });
  it.each([{ session: { id: "gone" } }, { profile: { id: "gone" } }, "gone", null, {}, { scheme: "vscode-terminal", path: "/window/123" }])("stale explicit %j refuses without fallback", async arg => {
    const f = fixture(); await f.run(arg); expect(f.panel.openOrReveal).not.toHaveBeenCalled(); expect(pick).not.toHaveBeenCalled(); expect(warning).toHaveBeenCalledWith("This serial session is no longer available. Reconnect the profile to use its send box."); expect(execute).not.toHaveBeenCalled();
  });
  it.each([{ session: { id: "gone" } }, { profile: { id: "gone" } }, null, {}])("direct-input stale explicit %j cannot restore active A", async arg => {
    const f = fixture(); f.ia.change({ dedicatedInputEnabled: true }); await f.run(arg, true);
    expect(f.ia.owner.setDedicatedInputEnabled).not.toHaveBeenCalled(); expect(f.panel.disposeForSession).not.toHaveBeenCalled(); expect(pick).not.toHaveBeenCalled();
  });
  it("does not list sessions removed from core when stale map entries remain", async () => {
    const f = fixture(); f.removeSessions(); Object.assign(vscode.window, { activeTerminal: terminal("Shell") }); await f.run();
    expect(pick).not.toHaveBeenCalled(); expect(info).toHaveBeenCalledWith("Connect a serial profile to open its send box.", "Connect Serial Profile");
  });
  it("closed explicit serial terminal refuses as stale after maps and registry are gone", async () => {
    const f = fixture(); for (const listener of closeListeners) listener(f.b); f.entries.delete("sb"); await f.run(f.b);
    expect(warning).toHaveBeenCalledWith("This serial session is no longer available. Reconnect the profile to use its send box."); expect(f.panel.openOrReveal).not.toHaveBeenCalled(); expect(pick).not.toHaveBeenCalled();
  });
  it("clicked nonserial refuses while A is active", async () => { const f = fixture(); await f.run(terminal("Shell")); expect(f.panel.openOrReveal).not.toHaveBeenCalled(); expect(pick).not.toHaveBeenCalled(); expect(warning.mock.calls[0][0]).toMatch(/serial terminal/); });
  it("absent target uses active serial", async () => { const f = fixture(); await f.run(); expect(f.panel.openOrReveal).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sa" })); });
  it("offers live sessions only with no explicit target and safely cancels", async () => { const f = fixture(); Object.assign(vscode.window, { activeTerminal: terminal("Shell") }); await f.run(); expect(pick).toHaveBeenCalled(); expect(f.panel.openOrReveal).not.toHaveBeenCalled(); });
  it("rechecks picked entry identity after await", async () => { const f = fixture(); Object.assign(vscode.window, { activeTerminal: undefined }); pick.mockImplementationOnce((items: unknown[]) => { const selected = items[1]; f.entries.set("sb", { ...f.entries.get("sb")!, input: input().owner }); return selected; }); await f.run(); expect(f.panel.openOrReveal).not.toHaveBeenCalled(); expect(warning).toHaveBeenCalled(); });
  it("no sessions offers actionable Connect", async () => { const f = fixture(); f.entries.clear(); Object.assign(vscode.window, { activeTerminal: undefined }); info.mockResolvedValueOnce("Connect Serial Profile"); await f.run(); expect(info).toHaveBeenCalledWith("Connect a serial profile to open its send box.", "Connect Serial Profile"); expect(execute).toHaveBeenCalledWith("nexus.serial.connect"); expect(pick).not.toHaveBeenCalled(); });
  it.each(["waiting", "stopped"] as const)("Smart %s allows editing with truthful notification", async status => { const f = fixture(status); await f.run(f.b); expect(f.panel.openOrReveal).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sb" })); expect(info.mock.calls[0][0]).toMatch(status === "waiting" ? /waiting for the approved port/ : /close.*reconnect/i); expect(info.mock.calls[0][0]).not.toMatch(/refresh/i); });
  it("locked input offers existing Stop Script action", async () => { const f = fixture(); f.ib.change({ inputLocked: true }); info.mockResolvedValueOnce("Stop Script"); await f.run(f.b); expect(f.panel.openOrReveal).toHaveBeenCalled(); expect(execute).toHaveBeenCalledWith("nexus.script.stop", "sb"); });
  it.each(["opening", "disconnected", "closed"] as const)("Standard %s refuses truthfully", async status => { const f = fixture(status); await f.run(f.b); expect(f.panel.openOrReveal).not.toHaveBeenCalled(); expect(warning.mock.calls[0][0]).toMatch(status === "opening" ? /still opening/ : /no longer available/); expect(pick).not.toHaveBeenCalled(); });
  it("opening/disconnected Standard native tabs remain known through registry", async () => { const f = fixture(); f.entries.delete("sb"); f.registry.get.mockReturnValue({ pty: f.ib.owner }); f.ib.change({ status: "opening", connected: false }); await f.run(f.b); expect(warning.mock.calls[0][0]).toMatch(/still opening/); expect(pick).not.toHaveBeenCalled(); expect(f.panel.openOrReveal).not.toHaveBeenCalled(); });
  it("removed core session cannot open from a retained map entry", async () => { const f = fixture(); f.removeSessions(); await f.run(f.b); expect(f.panel.openOrReveal).not.toHaveBeenCalled(); expect(warning).toHaveBeenCalledWith("This serial session is no longer available. Reconnect the profile to use its send box."); });
  it("missing input capability refuses", async () => { const f = fixture(); delete f.entries.get("sb")!.input; await f.run(f.b); expect(f.panel.openOrReveal).not.toHaveBeenCalled(); expect(pick).not.toHaveBeenCalled(); });
  it("repeat open reveals, direct command restores only clicked owner", async () => { const f = fixture(); await f.run(f.b); await f.run(f.b); expect(f.panel.openOrReveal).toHaveBeenCalledTimes(2); f.ib.change({ dedicatedInputEnabled: true }); await f.run(f.b, true); expect(f.ib.owner.setDedicatedInputEnabled).toHaveBeenCalledWith(false); expect(f.ia.owner.setDedicatedInputEnabled).not.toHaveBeenCalled(); expect(f.panel.disposeForSession).toHaveBeenCalledWith("sb"); });
  it("native reminder action captures B despite later active A", async () => { const f = fixture(); info.mockImplementationOnce(() => { Object.assign(vscode.window, { activeTerminal: f.a }); return "Open Send Box"; }); await f.service.remindNativeInput(f.b, f.ib.owner); expect(f.panel.openOrReveal).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sb", terminal: f.b })); });
  it("native reminder cannot bind a replacement owner", async () => { const f = fixture(); info.mockImplementationOnce(() => { f.entries.set("sb", { ...f.entries.get("sb")!, input: input().owner }); return "Open Send Box"; }); await f.service.remindNativeInput(f.b, f.ib.owner); expect(f.panel.openOrReveal).not.toHaveBeenCalled(); });
  it("tracks transient mode with one subscription per owner and cleans removed sessions", () => { const f = fixture(); f.changed(); expect(f.ia.listeners.size).toBe(1); f.ib.change({ dedicatedInputEnabled: true }); expect(f.refresh).toHaveBeenLastCalledWith(new Set(["sb"])); f.removeSessions(); expect(f.panel.disposeForSession).toHaveBeenCalledWith("sb"); expect(f.ib.listeners.size).toBe(0); expect(f.refresh).toHaveBeenLastCalledWith(new Set()); });
  it("profile deletion/import reset cleans panel and subscriptions", () => { const f = fixture(); f.removeProfiles(); expect(f.panel.disposeForSession).toHaveBeenCalledWith("sb"); expect(f.ia.listeners.size).toBe(0); });
  it("deactivation owns subscriptions and panel cleanup", () => { const f = fixture(); f.service.dispose(); expect(f.panel.dispose).toHaveBeenCalledOnce(); expect(f.listeners.size).toBe(0); expect(f.ia.listeners.size).toBe(0); });
});


describe("Standard opening binding", () => {
  it("explicit profile and native terminal truthfully refuse pending open without fallback", async () => {
    const f = fixture(); f.entries.delete("sb"); f.changed(); f.ib.change({ status: "opening", connected: false });
    f.registry.get.mockReturnValue({ pty: f.ib.owner });
    f.service.trackOpening("pb", f.b, f.ib.owner);
    await f.run({ profile: { id: "pb" } }); await f.run("pb"); await f.run(f.b);
    expect(warning).toHaveBeenCalledTimes(3); for (const [message] of warning.mock.calls) expect(message).toMatch(/still opening/);
    expect(f.panel.openOrReveal).not.toHaveBeenCalled(); expect(pick).not.toHaveBeenCalled();
  });
  it.each(["cancel", "close", "profile", "dispose"])("removes pending binding on %s and cannot revive after late completion", async reason => {
    const f = fixture(); f.entries.delete("sb"); f.changed(); f.ib.change({ status: "opening", connected: false }); f.service.trackOpening("pb", f.b, f.ib.owner);
    expect(f.ib.listeners.size).toBe(1);
    if (reason === "cancel") f.ib.change({ status: "closed" });
    else if (reason === "close") { for (const listener of closeListeners) listener(f.b); }
    else if (reason === "profile") f.removeProfiles();
    else f.service.dispose();
    expect(f.ib.listeners.size).toBe(0);
    f.ib.change({ status: "connected", connected: true }); await f.run("pb");
    expect(f.panel.openOrReveal).not.toHaveBeenCalled(); expect(pick).not.toHaveBeenCalled();
  });
  it("normal readiness drops pending subscription then uses live map identity", async () => {
    const f = fixture(); const entry = f.entries.get("sb")!; f.entries.delete("sb"); f.changed(); f.ib.change({ status: "opening", connected: false }); f.service.trackOpening("pb", f.b, f.ib.owner);
    f.ib.change({ status: "connected", connected: true }); f.entries.set("sb", entry); f.changed(); await f.run("pb");
    expect(f.panel.openOrReveal).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sb", input: f.ib.owner })); expect(f.ib.listeners.size).toBe(1);
  });
  it("Smart Follow opening may compose while Send remains unavailable", async () => {
    const f = fixture("opening"); f.entries.get("sb")!.smartFollow = true; await f.run(f.b);
    expect(f.panel.openOrReveal).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sb" })); expect(f.ib.owner.getInputState().connected).toBe(false);
  });
});


describe("native command invocation metadata", () => {
  for (const command of ["nexus.serial.openSendBox", "nexus.serial.useDirectInput"]) {
    it.each(["closed-only", "closed-and-active", "active-selection", "explicit-undefined"])(`${command} refuses missing clicked target with %s context`, async shape => {
      const f = fixture();
      f.ia.change({ dedicatedInputEnabled: true });
      const handler = handlers.get(command)!;
      if (shape === "explicit-undefined") await handler(undefined);
      else {
        const selection = shape === "closed-only" ? [undefined] : shape === "closed-and-active" ? [undefined, f.a] : [f.a];
        await handler(undefined, selection);
      }
      expect(warning).toHaveBeenCalledWith("This serial session is no longer available. Reconnect the profile to use its send box.");
      expect(f.panel.openOrReveal).not.toHaveBeenCalled();
      expect(f.panel.disposeForSession).not.toHaveBeenCalled();
      expect(pick).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(f.ia.owner.setDedicatedInputEnabled).not.toHaveBeenCalled();
      expect(f.ia.owner.getInputState().dedicatedInputEnabled).toBe(true);
      expect(f.a.show).not.toHaveBeenCalled();
    });

    it(`${command} preserves genuine no-argument palette invocation`, async () => {
      const f = fixture();
      f.ia.change({ dedicatedInputEnabled: true });
      await handlers.get(command)!();
      if (command === "nexus.serial.openSendBox") expect(f.panel.openOrReveal).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sa", terminal: f.a }));
      else expect(f.ia.owner.setDedicatedInputEnabled).toHaveBeenCalledWith(false);
      expect(pick).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled();
    });

    it(`${command} honors valid clicked B over active A and selection`, async () => {
      const f = fixture();
      f.ia.change({ dedicatedInputEnabled: true }); f.ib.change({ dedicatedInputEnabled: true });
      await handlers.get(command)!(f.b, [f.b, f.a]);
      if (command === "nexus.serial.openSendBox") expect(f.panel.openOrReveal).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sb", terminal: f.b }));
      else expect(f.ib.owner.setDedicatedInputEnabled).toHaveBeenCalledWith(false);
      expect(f.ia.owner.setDedicatedInputEnabled).not.toHaveBeenCalled();
      expect(pick).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled();
    });
  }
});
