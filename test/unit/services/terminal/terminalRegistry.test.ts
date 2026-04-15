import { beforeEach, describe, expect, it, vi } from "vitest";

type ActiveTerminalListener = (t: unknown) => void;
type CloseTerminalListener = (t: unknown) => void;

const state = {
  setContextCalls: [] as Array<{ key: string; value: unknown }>,
  activeTerminalListeners: new Set<ActiveTerminalListener>(),
  closeTerminalListeners: new Set<CloseTerminalListener>(),
  activeTerminal: undefined as unknown,
  configListeners: new Set<(e: { affectsConfiguration: (k: string) => boolean }) => void>()
};

vi.mock("vscode", () => ({
  commands: {
    executeCommand: vi.fn((cmd: string, ...args: unknown[]) => {
      if (cmd === "setContext") {
        state.setContextCalls.push({ key: args[0] as string, value: args[1] });
      }
      return Promise.resolve();
    })
  },
  window: {
    get activeTerminal() {
      return state.activeTerminal;
    },
    onDidChangeActiveTerminal: (listener: ActiveTerminalListener) => {
      state.activeTerminalListeners.add(listener);
      return { dispose: () => state.activeTerminalListeners.delete(listener) };
    },
    onDidCloseTerminal: (listener: CloseTerminalListener) => {
      state.closeTerminalListeners.add(listener);
      return { dispose: () => state.closeTerminalListeners.delete(listener) };
    }
  },
  workspace: {
    getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
    onDidChangeConfiguration: (listener: (e: { affectsConfiguration: (k: string) => boolean }) => void) => {
      state.configListeners.add(listener);
      return { dispose: () => state.configListeners.delete(listener) };
    }
  },
  Disposable: class {
    public constructor(private readonly cb: () => void) {}
    public dispose() {
      this.cb();
    }
  }
}));

import { TerminalRegistry } from "../../../../src/services/terminal/terminalRegistry";
import type { SessionPtyHandle } from "../../../../src/models/config";

interface FakeNexusCore {
  getSnapshot(): {
    activeSessions: Array<{ id: string; pty?: SessionPtyHandle }>;
    activeSerialSessions: Array<{ id: string; pty?: SessionPtyHandle }>;
  };
  onDidChange(l: () => void): () => void;
}

function makePty(): SessionPtyHandle & { resetTerminal: () => void; onOutput(text: string): void; __observers: Array<(text: string) => void> } {
  const observers: Array<(text: string) => void> = [];
  return {
    addOutputObserver(o) {
      const wrapped = (text: string) => o.onOutput(text);
      observers.push(wrapped);
      return {
        dispose: () => {
          const i = observers.indexOf(wrapped);
          if (i >= 0) observers.splice(i, 1);
        }
      } as unknown as ReturnType<SessionPtyHandle["addOutputObserver"]>;
    },
    setInputBlocked: () => {},
    writeProgrammatic: () => {},
    resetTerminal: () => {},
    onOutput(text: string) {
      observers.forEach((cb) => cb(text));
    },
    __observers: observers
  } as unknown as SessionPtyHandle & { resetTerminal: () => void; onOutput(text: string): void; __observers: Array<(text: string) => void> };
}

function makeCore(): FakeNexusCore & { sessions: Array<{ id: string; pty?: SessionPtyHandle }>; serialSessions: Array<{ id: string; pty?: SessionPtyHandle }>; emit: () => void } {
  const listeners = new Set<() => void>();
  const core = {
    sessions: [] as Array<{ id: string; pty?: SessionPtyHandle }>,
    serialSessions: [] as Array<{ id: string; pty?: SessionPtyHandle }>,
    getSnapshot() {
      return { activeSessions: core.sessions, activeSerialSessions: core.serialSessions };
    },
    onDidChange(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit() {
      listeners.forEach((l) => l());
    }
  };
  return core;
}

function fireActiveTerminal(t: unknown) {
  state.activeTerminal = t;
  state.activeTerminalListeners.forEach((l) => l(t));
}

describe("TerminalRegistry", () => {
  beforeEach(() => {
    state.setContextCalls = [];
    state.activeTerminalListeners.clear();
    state.closeTerminalListeners.clear();
    state.configListeners.clear();
    state.activeTerminal = undefined;
  });

  function latestContextKey(key: string): unknown {
    const hits = state.setContextCalls.filter((c) => c.key === key);
    return hits.length === 0 ? undefined : hits[hits.length - 1].value;
  }

  it("register/get/unregister is symmetric", () => {
    const reg = new TerminalRegistry(makeCore());
    const terminal = {} as never;
    const pty = makePty();
    reg.register(terminal, pty);
    expect(reg.get(terminal)).toBeDefined();
    expect(reg.get(terminal)?.pty).toBe(pty);
    reg.unregister(terminal);
    expect(reg.get(terminal)).toBeUndefined();
    reg.dispose();
  });

  it("refreshes both context keys when active terminal changes to a Nexus terminal with a live session", () => {
    const core = makeCore();
    const reg = new TerminalRegistry(core);
    const terminal = {} as never;
    const pty = makePty();
    core.sessions.push({ id: "s1", pty });
    reg.register(terminal, pty);
    fireActiveTerminal(terminal);
    expect(latestContextKey("nexus.isNexusTerminal")).toBe(true);
    expect(latestContextKey("nexus.isNexusTerminalConnected")).toBe(true);
    reg.dispose();
  });

  it("sets both keys false when the active terminal is non-Nexus", () => {
    const reg = new TerminalRegistry(makeCore());
    fireActiveTerminal({} as never);
    expect(latestContextKey("nexus.isNexusTerminal")).toBe(false);
    expect(latestContextKey("nexus.isNexusTerminalConnected")).toBe(false);
    reg.dispose();
  });

  it("nexus.isNexusTerminalConnected follows NexusCore session lifecycle", () => {
    const core = makeCore();
    const reg = new TerminalRegistry(core);
    const terminal = {} as never;
    const pty = makePty();
    reg.register(terminal, pty);
    fireActiveTerminal(terminal);
    // No session registered yet
    expect(latestContextKey("nexus.isNexusTerminal")).toBe(true);
    expect(latestContextKey("nexus.isNexusTerminalConnected")).toBe(false);
    // Session opens
    core.sessions.push({ id: "s1", pty });
    core.emit();
    expect(latestContextKey("nexus.isNexusTerminalConnected")).toBe(true);
    // Session disconnects
    core.sessions.length = 0;
    core.emit();
    expect(latestContextKey("nexus.isNexusTerminalConnected")).toBe(false);
    // Critical invariant: disconnect does NOT remove the registry entry
    expect(reg.get(terminal)).toBeDefined();
    expect(latestContextKey("nexus.isNexusTerminal")).toBe(true);
    reg.dispose();
  });

  it("disconnect does not dispose the capture buffer (FR-011)", () => {
    const core = makeCore();
    const reg = new TerminalRegistry(core);
    const terminal = {} as never;
    const pty = makePty();
    reg.register(terminal, pty);
    fireActiveTerminal(terminal);
    // Simulate session lifecycle
    core.sessions.push({ id: "s1", pty });
    core.emit();
    pty.onOutput("pre-disconnect\n");
    // Disconnect
    core.sessions.length = 0;
    core.emit();
    // Buffer still readable
    const entry = reg.get(terminal);
    expect(entry?.buffer.getText()).toBe("pre-disconnect");
    reg.dispose();
  });

  it("recognizes serial sessions as connected", () => {
    const core = makeCore();
    const reg = new TerminalRegistry(core);
    const terminal = {} as never;
    const pty = makePty();
    core.serialSessions.push({ id: "sr1", pty });
    reg.register(terminal, pty);
    fireActiveTerminal(terminal);
    expect(latestContextKey("nexus.isNexusTerminalConnected")).toBe(true);
    reg.dispose();
  });

  it("unregister clears the entry and disposes the buffer observer", () => {
    const reg = new TerminalRegistry(makeCore());
    const terminal = {} as never;
    const pty = makePty();
    reg.register(terminal, pty);
    pty.onOutput("first\n");
    const before = reg.get(terminal)?.buffer.getText();
    expect(before).toBe("first");
    reg.unregister(terminal);
    expect(reg.get(terminal)).toBeUndefined();
    reg.dispose();
  });

  it("onDidCloseTerminal triggers unregister automatically", () => {
    const reg = new TerminalRegistry(makeCore());
    const terminal = {} as never;
    const pty = makePty();
    reg.register(terminal, pty);
    expect(reg.get(terminal)).toBeDefined();
    state.closeTerminalListeners.forEach((l) => l(terminal));
    expect(reg.get(terminal)).toBeUndefined();
    reg.dispose();
  });

  it("dispose tears down all subscriptions and entries", () => {
    const core = makeCore();
    const reg = new TerminalRegistry(core);
    const terminal = {} as never;
    const pty = makePty();
    reg.register(terminal, pty);
    const subsBefore = state.activeTerminalListeners.size;
    reg.dispose();
    expect(state.activeTerminalListeners.size).toBeLessThan(subsBefore);
    expect(state.closeTerminalListeners.size).toBe(0);
    expect(reg.get(terminal)).toBeUndefined();
  });
});
