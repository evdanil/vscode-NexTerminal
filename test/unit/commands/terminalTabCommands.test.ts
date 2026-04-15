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

import { registerTerminalTabCommands } from "../../../src/commands/terminalTabCommands";
import type { RegistryEntry } from "../../../src/services/terminal/terminalRegistry";

interface FakeRegistry {
  get(t: unknown): RegistryEntry | undefined;
  isConnected(e: RegistryEntry): boolean;
}

function fakeRegistry(entries: Map<unknown, RegistryEntry>, connectedEntries: Set<RegistryEntry>): FakeRegistry {
  return {
    get: (t) => entries.get(t),
    isConnected: (e) => connectedEntries.has(e)
  };
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
      const terminal = {} as never;
      const pty = fakePty();
      const buffer = fakeBuffer("");
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { pty: pty as never, buffer: buffer as never };
      entries.set(terminal, entry);
      const connected = new Set([entry]);
      registerTerminalTabCommands(context as never, fakeRegistry(entries, connected) as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler(terminal);
      expect(pty.resetTerminal).toHaveBeenCalledTimes(1);
    });

    it("palette path: falls back to window.activeTerminal when no argument is supplied", () => {
      const terminal = {} as never;
      const pty = fakePty();
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { pty: pty as never, buffer: fakeBuffer("") as never };
      entries.set(terminal, entry);
      state.activeTerminal = terminal;
      registerTerminalTabCommands(context as never, fakeRegistry(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler();
      expect(pty.resetTerminal).toHaveBeenCalledTimes(1);
    });

    it("no-ops on unknown terminal", () => {
      const pty = fakePty();
      registerTerminalTabCommands(context as never, fakeRegistry(new Map(), new Set()) as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler({} as never);
      expect(pty.resetTerminal).not.toHaveBeenCalled();
    });

    it("no-ops when session is disconnected", () => {
      const terminal = {} as never;
      const pty = fakePty();
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { pty: pty as never, buffer: fakeBuffer("") as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeRegistry(entries, new Set()) as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler(terminal);
      expect(pty.resetTerminal).not.toHaveBeenCalled();
    });

    it("no-ops when palette is invoked with no active terminal", () => {
      const pty = fakePty();
      registerTerminalTabCommands(context as never, fakeRegistry(new Map(), new Set()) as never);
      state.activeTerminal = undefined;
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler();
      expect(pty.resetTerminal).not.toHaveBeenCalled();
    });

    it("emits no toast on success", () => {
      const terminal = {} as never;
      const pty = fakePty();
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { pty: pty as never, buffer: fakeBuffer("") as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeRegistry(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.reset")!;
      handler(terminal);
      expect(state.showInfo).not.toHaveBeenCalled();
      expect(state.showWarning).not.toHaveBeenCalled();
    });
  });

  describe("nexus.terminal.copyAll", () => {
    it("menu path: writes buffer text to clipboard and shows line-count toast", async () => {
      const terminal = {} as never;
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { pty: fakePty() as never, buffer: fakeBuffer("line1\nline2", 2) as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeRegistry(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.copyAll")!;
      await handler(terminal);
      expect(state.clipboardWrite).toHaveBeenCalledWith("line1\nline2");
      expect(state.showInfo).toHaveBeenCalledWith("Copied 2 lines to clipboard.");
    });

    it("palette path: falls back to window.activeTerminal", async () => {
      const terminal = {} as never;
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { pty: fakePty() as never, buffer: fakeBuffer("hi", 1) as never };
      entries.set(terminal, entry);
      state.activeTerminal = terminal;
      registerTerminalTabCommands(context as never, fakeRegistry(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.copyAll")!;
      await handler();
      expect(state.clipboardWrite).toHaveBeenCalledWith("hi");
    });

    it("works post-disconnect (stays enabled when isConnected is false)", async () => {
      const terminal = {} as never;
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { pty: fakePty() as never, buffer: fakeBuffer("post", 1) as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeRegistry(entries, new Set()) as never);
      const handler = state.registeredCommands.get("nexus.terminal.copyAll")!;
      await handler(terminal);
      expect(state.clipboardWrite).toHaveBeenCalledWith("post");
    });

    it("empty-buffer path: warns and does not touch clipboard", async () => {
      const terminal = {} as never;
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { pty: fakePty() as never, buffer: fakeBuffer("", 0) as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeRegistry(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.copyAll")!;
      await handler(terminal);
      expect(state.clipboardWrite).not.toHaveBeenCalled();
      expect(state.showWarning).toHaveBeenCalledWith("Nothing to copy.");
    });

    it("clipboard write error: shows error toast and no success toast", async () => {
      const terminal = {} as never;
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { pty: fakePty() as never, buffer: fakeBuffer("data", 1) as never };
      entries.set(terminal, entry);
      state.clipboardWrite.mockImplementation(async () => {
        throw new Error("clipboard denied");
      });
      registerTerminalTabCommands(context as never, fakeRegistry(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.copyAll")!;
      await handler(terminal);
      expect(state.showError).toHaveBeenCalledWith(
        expect.stringContaining("clipboard denied")
      );
      expect(state.showInfo).not.toHaveBeenCalled();
    });
  });

  describe("nexus.terminal.clearScrollback", () => {
    it("menu path: clears buffer before invoking workbench.action.terminal.clear", async () => {
      const terminal = {} as never;
      const buffer = fakeBuffer("prev");
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { pty: fakePty() as never, buffer: buffer as never };
      entries.set(terminal, entry);
      const callOrder: string[] = [];
      (buffer.clear as ReturnType<typeof vi.fn>).mockImplementation(() => callOrder.push("buffer.clear"));
      registerTerminalTabCommands(context as never, fakeRegistry(entries, new Set([entry])) as never);
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
      const terminal = {} as never;
      const buffer = fakeBuffer("old");
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { pty: fakePty() as never, buffer: buffer as never };
      entries.set(terminal, entry);
      state.activeTerminal = terminal;
      registerTerminalTabCommands(context as never, fakeRegistry(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.clearScrollback")!;
      await handler();
      expect(buffer.clear).toHaveBeenCalled();
    });

    it("no-op on unknown terminal", async () => {
      const buffer = fakeBuffer("x");
      registerTerminalTabCommands(context as never, fakeRegistry(new Map(), new Set()) as never);
      const handler = state.registeredCommands.get("nexus.terminal.clearScrollback")!;
      await handler({} as never);
      expect(buffer.clear).not.toHaveBeenCalled();
    });

    it("no-op when session is disconnected", async () => {
      const terminal = {} as never;
      const buffer = fakeBuffer("x");
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { pty: fakePty() as never, buffer: buffer as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeRegistry(entries, new Set()) as never);
      const handler = state.registeredCommands.get("nexus.terminal.clearScrollback")!;
      await handler(terminal);
      expect(buffer.clear).not.toHaveBeenCalled();
    });

    it("emits no toast on success", async () => {
      const terminal = {} as never;
      const buffer = fakeBuffer("prev");
      const entries = new Map<unknown, RegistryEntry>();
      const entry: RegistryEntry = { pty: fakePty() as never, buffer: buffer as never };
      entries.set(terminal, entry);
      registerTerminalTabCommands(context as never, fakeRegistry(entries, new Set([entry])) as never);
      const handler = state.registeredCommands.get("nexus.terminal.clearScrollback")!;
      await handler(terminal);
      expect(state.showInfo).not.toHaveBeenCalled();
    });
  });
});
