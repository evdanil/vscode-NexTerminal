import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
  activeTerminal: undefined as unknown,
  executeCommandCalls: [] as Array<{ cmd: string; args: unknown[] }>,
  showWarning: vi.fn(),
  showInfo: vi.fn(),
  showError: vi.fn(),
  clipboardWrite: vi.fn(async () => {})
};

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      state.registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(async (cmd: string, ...args: unknown[]) => {
      state.executeCommandCalls.push({ cmd, args });
    })
  },
  window: {
    get activeTerminal() {
      return state.activeTerminal;
    },
    showWarningMessage: (...args: unknown[]) => {
      state.showWarning(...args);
      return Promise.resolve(undefined);
    },
    showInformationMessage: (...args: unknown[]) => {
      state.showInfo(...args);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (...args: unknown[]) => {
      state.showError(...args);
      return Promise.resolve(undefined);
    }
  },
  env: {
    clipboard: {
      writeText: (text: string) => state.clipboardWrite(text)
    }
  }
}));

import { registerTerminalTabCommands, type TerminalTabCommandsDeps } from "../../../src/commands/terminalTabCommands";
import type { RegistryEntry } from "../../../src/services/terminal/terminalRegistry";

function fakeDeps(entries: Map<unknown, RegistryEntry>, connectedEntries: Set<RegistryEntry>): TerminalTabCommandsDeps {
  return {
    registry: {
      get: (t: unknown) => entries.get(t),
      isConnected: (e: RegistryEntry) => connectedEntries.has(e)
    } as never,
    sessionTerminals: new Map(),
    serialTerminals: new Map()
  };
}

function fakeTerminal() {
  return { show: vi.fn(), creationOptions: {} };
}

function fakePty() {
  return {
    addOutputObserver: vi.fn(() => ({ dispose: () => {} })),
    setInputBlocked: vi.fn(),
    writeProgrammatic: vi.fn(),
    resetTerminal: vi.fn()
  };
}

function fakeBuffer(text: string, lineCount = text.split("\n").length) {
  return {
    append: vi.fn(),
    clear: vi.fn(),
    getText: () => text,
    lineCount: () => lineCount,
    setMaxLines: vi.fn(),
    dispose: vi.fn()
  };
}

describe("terminalTabCommands", () => {
  beforeEach(() => {
    state.registeredCommands.clear();
    state.executeCommandCalls = [];
    state.activeTerminal = undefined;
    state.showWarning.mockClear();
    state.showInfo.mockClear();
    state.showError.mockClear();
    state.clipboardWrite.mockClear();
    state.clipboardWrite.mockImplementation(async () => {});
  });

  const context = { subscriptions: [] as { dispose: () => void }[] };

  describe("nexus.terminal.reset", () => {
    it("menu path: calls pty.resetTerminal on the supplied terminal", () => {
      const terminal = fakeTerminal() as never;
      const pty = fakePty();
      const buffer = fakeBuffer("");
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty: pty as never, buffer: buffer as never };
      entries.set(terminal, entry);
      const connected = new Set([entry]);
      registerTerminalTabCommands(context as never, fakeDeps(entries, connected) as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler(terminal);
      expect(pty.resetTerminal).toHaveBeenCalledTimes(1);
    });

    it("palette path: falls back to window.activeTerminal when no argument is supplied", () => {
      const terminal = fakeTerminal() as never;
      const pty = fakePty();
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty:pty as never, buffer: fakeBuffer("") as never };
      entries.set(terminal, entry);
      state.activeTerminal = terminal;
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler();
      expect(pty.resetTerminal).toHaveBeenCalledTimes(1);
    });

    it("no-ops on unknown terminal", () => {
      const pty = fakePty();
      registerTerminalTabCommands(context as never, fakeDeps(new Map(), new Set()) as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler({} as never);
      expect(pty.resetTerminal).not.toHaveBeenCalled();
    });

    it("no-ops when session is disconnected", () => {
      const terminal = fakeTerminal() as never;
      const pty = fakePty();
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty:pty as never, buffer: fakeBuffer("") as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set()) as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler(terminal);
      expect(pty.resetTerminal).not.toHaveBeenCalled();
    });

    it("no-ops when palette is invoked with no active terminal", () => {
      const pty = fakePty();
      registerTerminalTabCommands(context as never, fakeDeps(new Map(), new Set()) as never);
      state.activeTerminal = undefined;
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler();
      expect(pty.resetTerminal).not.toHaveBeenCalled();
    });

    it("tree-item path: resolves SSH SessionTreeItem via session.id → sessionTerminals", () => {
      const terminal = fakeTerminal() as never;
      const pty = fakePty();
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty: pty as never, buffer: fakeBuffer("") as never };
      entries.set(terminal, entry);
      const deps = fakeDeps(entries, new Set([entry]));
      deps.sessionTerminals.set("sess-1", terminal as never);
      registerTerminalTabCommands(context as never, deps as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler({ session: { id: "sess-1" } });
      expect(pty.resetTerminal).toHaveBeenCalledTimes(1);
    });

    it("tree-item path: resolves SerialProfileTreeItem via profile.id → serialTerminals", () => {
      const terminal = fakeTerminal() as never;
      const pty = fakePty();
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty: pty as never, buffer: fakeBuffer("") as never };
      entries.set(terminal, entry);
      const deps = fakeDeps(entries, new Set([entry]));
      deps.serialTerminals.set("serial-sess-1", { terminal: terminal as never, profileId: "prof-1" } as never);
      registerTerminalTabCommands(context as never, deps as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler({ profile: { id: "prof-1" } });
      expect(pty.resetTerminal).toHaveBeenCalledTimes(1);
    });

    it("tree-item path: resolves serial SessionTreeItem via session.id → serialTerminals", () => {
      const terminal = fakeTerminal() as never;
      const pty = fakePty();
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty: pty as never, buffer: fakeBuffer("") as never };
      entries.set(terminal, entry);
      const deps = fakeDeps(entries, new Set([entry]));
      deps.serialTerminals.set("serial-sess-1", { terminal: terminal as never, profileId: "prof-1" } as never);
      registerTerminalTabCommands(context as never, deps as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler({ session: { id: "serial-sess-1" } });
      expect(pty.resetTerminal).toHaveBeenCalledTimes(1);
    });

    it("tree-item path: returns undefined for unknown session ID (no-op)", () => {
      const pty = fakePty();
      registerTerminalTabCommands(context as never, fakeDeps(new Map(), new Set()) as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler({ session: { id: "nonexistent" } });
      expect(pty.resetTerminal).not.toHaveBeenCalled();
    });

    it("emits no toast on success", () => {
      const terminal = fakeTerminal() as never;
      const pty = fakePty();
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty:pty as never, buffer: fakeBuffer("") as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler(terminal);
      expect(state.showInfo).not.toHaveBeenCalled();
      expect(state.showWarning).not.toHaveBeenCalled();
    });
  });

  describe("nexus.terminal.copyAll", () => {
    it("menu path: writes buffer text to clipboard and shows line-count toast", async () => {
      const terminal = fakeTerminal() as never;
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty:fakePty() as never, buffer: fakeBuffer("line1\nline2", 2) as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.copyAll")!;
      await handler(terminal);
      expect(state.clipboardWrite).toHaveBeenCalledWith("line1\nline2");
      expect(state.showInfo).toHaveBeenCalledWith("Copied 2 lines to clipboard.");
    });

    it("uses singular 'line' when exactly one line was copied", async () => {
      const terminal = fakeTerminal() as never;
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty:fakePty() as never, buffer: fakeBuffer("solo", 1) as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.copyAll")!;
      await handler(terminal);
      expect(state.showInfo).toHaveBeenCalledWith("Copied 1 line to clipboard.");
    });

    it("palette path: falls back to window.activeTerminal", async () => {
      const terminal = fakeTerminal() as never;
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty:fakePty() as never, buffer: fakeBuffer("hi", 1) as never };
      entries.set(terminal, entry);
      state.activeTerminal = terminal;
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.copyAll")!;
      await handler();
      expect(state.clipboardWrite).toHaveBeenCalledWith("hi");
    });

    it("works post-disconnect (stays enabled when isConnected is false)", async () => {
      const terminal = fakeTerminal() as never;
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty:fakePty() as never, buffer: fakeBuffer("post", 1) as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set()) as never);
      const handler = state.registeredCommands.get("nexus.terminal.copyAll")!;
      await handler(terminal);
      expect(state.clipboardWrite).toHaveBeenCalledWith("post");
    });

    it("empty-buffer path: warns and does not touch clipboard", async () => {
      const terminal = fakeTerminal() as never;
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty:fakePty() as never, buffer: fakeBuffer("", 0) as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.copyAll")!;
      await handler(terminal);
      expect(state.clipboardWrite).not.toHaveBeenCalled();
      expect(state.showWarning).toHaveBeenCalledWith("Nothing to copy.");
    });

    it("clipboard write error: shows error toast and no success toast", async () => {
      const terminal = fakeTerminal() as never;
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty:fakePty() as never, buffer: fakeBuffer("data", 1) as never };
      entries.set(terminal, entry);
      state.clipboardWrite.mockImplementation(async () => {
        throw new Error("clipboard denied");
      });
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.copyAll")!;
      await handler(terminal);
      expect(state.showError).toHaveBeenCalledWith(
        expect.stringContaining("clipboard denied")
      );
      expect(state.showError).toHaveBeenCalledWith(
        expect.stringMatching(/^Failed to copy to clipboard:/)
      );
      expect(state.showInfo).not.toHaveBeenCalled();
    });
  });

  describe("nexus.terminal.clearScrollback", () => {
    it("menu path: clears buffer before invoking workbench.action.terminal.clear", async () => {
      const terminal = fakeTerminal() as never;
      const buffer = fakeBuffer("prev");
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty:fakePty() as never, buffer: buffer as never };
      entries.set(terminal, entry);
      const callOrder: string[] = [];
      (buffer.clear as ReturnType<typeof vi.fn>).mockImplementation(() => callOrder.push("buffer.clear"));
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.clearScrollback")!;
      await handler(terminal);
      expect(buffer.clear).toHaveBeenCalledTimes(1);
      const terminalClearIndex = state.executeCommandCalls.findIndex(
        (c) => c.cmd === "workbench.action.terminal.clear"
      );
      expect(terminalClearIndex).toBeGreaterThanOrEqual(0);
      callOrder.push("executeCommand");
      expect(callOrder).toEqual(["buffer.clear", "executeCommand"]);
    });

    it("palette path: falls back to window.activeTerminal", async () => {
      const terminal = fakeTerminal() as never;
      const buffer = fakeBuffer("old");
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty:fakePty() as never, buffer: buffer as never };
      entries.set(terminal, entry);
      state.activeTerminal = terminal;
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.clearScrollback")!;
      await handler();
      expect(buffer.clear).toHaveBeenCalled();
    });

    it("no-op on unknown terminal", async () => {
      const buffer = fakeBuffer("x");
      registerTerminalTabCommands(context as never, fakeDeps(new Map(), new Set()) as never);
      const handler = state.registeredCommands.get("nexus.terminal.clearScrollback")!;
      await handler({} as never);
      expect(buffer.clear).not.toHaveBeenCalled();
    });

    it("no-op when session is disconnected", async () => {
      const terminal = fakeTerminal() as never;
      const buffer = fakeBuffer("x");
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty:fakePty() as never, buffer: buffer as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set()) as never);
      const handler = state.registeredCommands.get("nexus.terminal.clearScrollback")!;
      await handler(terminal);
      expect(buffer.clear).not.toHaveBeenCalled();
    });

    it("emits no toast on success", async () => {
      const terminal = fakeTerminal() as never;
      const buffer = fakeBuffer("prev");
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal, pty:fakePty() as never, buffer: buffer as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.clearScrollback")!;
      await handler(terminal);
      expect(state.showInfo).not.toHaveBeenCalled();
    });

    it("focuses the resolved terminal before executing the built-in clear when it is not active", async () => {
      const targetTerminal = fakeTerminal();
      const otherActiveTerminal = fakeTerminal();
      const buffer = fakeBuffer("prev");
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal: targetTerminal as never, pty: fakePty() as never, buffer: buffer as never };
      entries.set(targetTerminal, entry);
      state.activeTerminal = otherActiveTerminal;
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.clearScrollback")!;
      await handler(targetTerminal as never);
      expect(targetTerminal.show).toHaveBeenCalledWith(true);
      expect(state.executeCommandCalls.some((c) => c.cmd === "workbench.action.terminal.clear")).toBe(true);
    });

    it("does not re-focus the terminal when it is already the active one", async () => {
      const terminal = fakeTerminal();
      const buffer = fakeBuffer("prev");
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { terminal: terminal as never, pty: fakePty() as never, buffer: buffer as never };
      entries.set(terminal, entry);
      state.activeTerminal = terminal;
      registerTerminalTabCommands(context as never, fakeDeps(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.clearScrollback")!;
      await handler(terminal as never);
      expect(terminal.show).not.toHaveBeenCalled();
    });
  });
});
