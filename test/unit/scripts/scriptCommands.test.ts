import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
  writtenFiles: new Map<string, string>(),
  inputBoxValidator: undefined as ((v: string) => string | undefined) | undefined,
  inputBoxReturn: undefined as string | undefined,
  warningReturn: undefined as string | undefined,
  mockShowWarningMessage: vi.fn(),
  mockShowInformationMessage: vi.fn(),
  mockShowErrorMessage: vi.fn(),
  mockOpenExternal: vi.fn(),
  mockFsDelete: vi.fn(async () => {}),
  mockFsStatThrows: true
};

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      state.registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn()
  },
  window: {
    showInputBox: (opts: { validateInput?: (v: string) => string | undefined }) => {
      state.inputBoxValidator = opts?.validateInput;
      return Promise.resolve(state.inputBoxReturn);
    },
    showWarningMessage: (...args: unknown[]) => {
      state.mockShowWarningMessage(...args);
      return Promise.resolve(state.warningReturn);
    },
    showInformationMessage: (...args: unknown[]) => {
      state.mockShowInformationMessage(...args);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (...args: unknown[]) => {
      state.mockShowErrorMessage(...args);
      return Promise.resolve(undefined);
    },
    showOpenDialog: vi.fn(() => Promise.resolve(undefined)),
    showTextDocument: vi.fn(() => Promise.resolve()),
    showQuickPick: vi.fn(() => Promise.resolve(undefined))
  },
  workspace: {
    workspaceFolders: [
      { uri: { fsPath: "/ws", scheme: "file", path: "/ws" }, name: "ws", index: 0 }
    ],
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_k: string, d?: unknown) => d)
    })),
    openTextDocument: vi.fn(() => Promise.resolve({})),
    fs: {
      createDirectory: vi.fn(async () => {}),
      stat: vi.fn(async () => {
        if (state.mockFsStatThrows) throw new Error("ENOENT");
        return {};
      }),
      writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
        state.writtenFiles.set(uri.fsPath, new TextDecoder().decode(bytes));
      }),
      delete: (...args: unknown[]) => state.mockFsDelete(...args)
    }
  },
  env: {
    openExternal: (...args: unknown[]) => state.mockOpenExternal(...args)
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: "file", path: p, toString: () => p }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
      scheme: "file",
      path: [base.fsPath, ...parts].join("/"),
      toString: () => [base.fsPath, ...parts].join("/")
    }),
    parse: (s: string) => ({ fsPath: s, scheme: "https", toString: () => s })
  }
}));

import { registerScriptCommands } from "../../../src/commands/scriptCommands";
import type { ScriptRuntimeManager } from "../../../src/services/scripts/scriptRuntimeManager";

function makeManager(overrides: Partial<Record<string, unknown>> = {}): ScriptRuntimeManager {
  return {
    runScript: vi.fn(async () => undefined),
    stopScript: vi.fn(async () => {}),
    getRuns: vi.fn(() => []),
    getRunForSession: vi.fn(),
    onDidChangeRun: Object.assign(
      (_l: () => void) => ({ dispose: () => {} }),
      {}
    ),
    ...overrides
  } as unknown as ScriptRuntimeManager;
}

const outputChannel = {
  show: vi.fn(),
  appendLine: vi.fn(),
  append: vi.fn(),
  replace: vi.fn(),
  clear: vi.fn(),
  dispose: vi.fn(),
  hide: vi.fn(),
  name: "Nexus Scripts"
} as unknown as import("vscode").OutputChannel;

describe("scriptCommands", () => {
  beforeEach(() => {
    state.registeredCommands.clear();
    state.writtenFiles.clear();
    state.inputBoxValidator = undefined;
    state.inputBoxReturn = undefined;
    state.warningReturn = undefined;
    state.mockShowWarningMessage.mockClear();
    state.mockShowInformationMessage.mockClear();
    state.mockShowErrorMessage.mockClear();
    state.mockOpenExternal.mockClear();
    state.mockFsDelete.mockClear();
    state.mockFsStatThrows = true;
  });

  describe("F1/F2 — starter template", () => {
    it("writes a starter script that includes @target-type ssh", async () => {
      state.inputBoxReturn = "my-procedure";
      registerScriptCommands(makeManager(), outputChannel);
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      const body = state.writtenFiles.get("/ws/.nexus/scripts/my-procedure.js");
      expect(body).toBeDefined();
      expect(body!).toMatch(/@target-type\s+ssh/);
    });

    it("includes @allow-macros escape-hatch comment and try/catch scaffold", async () => {
      state.inputBoxReturn = "login";
      registerScriptCommands(makeManager(), outputChannel);
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      const body = state.writtenFiles.get("/ws/.nexus/scripts/login.js");
      expect(body).toBeDefined();
      expect(body!).toMatch(/@allow-macros/);
      expect(body!).toMatch(/try\s*\{/);
      expect(body!).toMatch(/catch\s*\(/);
    });
  });

  describe("P3 — strip trailing .js", () => {
    it("strips trailing .js from the user-typed filename", async () => {
      state.inputBoxReturn = "login.js";
      registerScriptCommands(makeManager(), outputChannel);
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      // Should not produce login.js.js
      expect(state.writtenFiles.has("/ws/.nexus/scripts/login.js.js")).toBe(false);
      expect(state.writtenFiles.has("/ws/.nexus/scripts/login.js")).toBe(true);
    });

    it("validator rejects empty after strip and accepts .js suffix inputs", async () => {
      state.inputBoxReturn = "my-procedure.js";
      registerScriptCommands(makeManager(), outputChannel);
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      expect(state.inputBoxValidator).toBeDefined();
      expect(state.inputBoxValidator!("login.js")).toBeUndefined();
      expect(state.inputBoxValidator!(".js")).toBeDefined(); // empty after strip
      expect(state.inputBoxValidator!("")).toBeDefined();
      expect(state.inputBoxValidator!("bad name")).toBeDefined(); // has a space
    });
  });

  describe("S1 — openDocs command", () => {
    it("registers nexus.script.openDocs which calls env.openExternal", async () => {
      registerScriptCommands(makeManager(), outputChannel);
      const handler = state.registeredCommands.get("nexus.script.openDocs");
      expect(handler).toBeDefined();
      await handler!();
      expect(state.mockOpenExternal).toHaveBeenCalled();
      const arg = state.mockOpenExternal.mock.calls[0][0] as { toString: () => string };
      expect(String(arg)).toMatch(/github\.com/);
      expect(String(arg)).toMatch(/docs\/scripting\.md/);
    });
  });

  describe("workspace gating", () => {
    it("run works without an open workspace folder (user can open a .js directly)", async () => {
      const prevFolders = (await import("vscode")).workspace.workspaceFolders;
      (await import("vscode")).workspace.workspaceFolders = undefined as unknown as typeof prevFolders;

      const mgr = makeManager();
      registerScriptCommands(mgr, outputChannel);
      const run = state.registeredCommands.get("nexus.script.run")!;
      const uri = { fsPath: "/tmp/adhoc.js", scheme: "file", path: "/tmp/adhoc.js", toString: () => "" };
      await run(uri);
      expect(mgr.runScript).toHaveBeenCalledWith(uri);
      expect(state.mockShowInformationMessage).not.toHaveBeenCalled(); // no "open a folder" nag

      (await import("vscode")).workspace.workspaceFolders = prevFolders;
    });

    it("new still requires a workspace folder (has to know where to write)", async () => {
      const prevFolders = (await import("vscode")).workspace.workspaceFolders;
      (await import("vscode")).workspace.workspaceFolders = undefined as unknown as typeof prevFolders;

      registerScriptCommands(makeManager(), outputChannel);
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      expect(state.mockShowInformationMessage).toHaveBeenCalled();

      (await import("vscode")).workspace.workspaceFolders = prevFolders;
    });
  });

  describe("tree-view argument unwrap (bug: 'Unable to resolve filesystem provider …')", () => {
    it("run accepts a real Uri from the CodeLens path", async () => {
      const mgr = makeManager();
      registerScriptCommands(mgr, outputChannel);
      const run = state.registeredCommands.get("nexus.script.run")!;
      const uri = { fsPath: "/ws/.nexus/scripts/test.js", scheme: "file", path: "/ws/.nexus/scripts/test.js", toString: () => "" };
      await run(uri);
      expect(mgr.runScript).toHaveBeenCalledWith(uri);
    });

    it("run accepts a ScriptNode { uri } from the tree view menu", async () => {
      const mgr = makeManager();
      registerScriptCommands(mgr, outputChannel);
      const run = state.registeredCommands.get("nexus.script.run")!;
      const innerUri = {
        fsPath: "/ws/.nexus/scripts/test.js",
        scheme: "file",
        path: "/ws/.nexus/scripts/test.js",
        toString: () => ""
      };
      // Simulate the ScriptNode object the tree view passes.
      const scriptNode = {
        kind: "script",
        uri: innerUri,
        name: "test",
        description: "",
        running: false,
        parseErrors: []
      };
      await run(scriptNode);
      // Must unwrap to the inner URI.
      expect(mgr.runScript).toHaveBeenCalledWith(innerUri);
    });

    it("run accepts a TreeItem-like object with resourceUri (explorer or nested case)", async () => {
      const mgr = makeManager();
      registerScriptCommands(mgr, outputChannel);
      const run = state.registeredCommands.get("nexus.script.run")!;
      const innerUri = {
        fsPath: "/ws/.nexus/scripts/test.js",
        scheme: "file",
        path: "/ws/.nexus/scripts/test.js",
        toString: () => ""
      };
      await run({ resourceUri: innerUri, label: "test.js" });
      expect(mgr.runScript).toHaveBeenCalledWith(innerUri);
    });

    it("run falls back to file picker when given an unrecognisable argument", async () => {
      const mgr = makeManager();
      registerScriptCommands(mgr, outputChannel);
      const run = state.registeredCommands.get("nexus.script.run")!;
      // ShowOpenDialog is mocked to return undefined → no run initiated.
      await run({ someUnrelatedShape: true });
      expect(mgr.runScript).not.toHaveBeenCalled();
    });

    it("delete unwraps a ScriptNode rather than silently no-op-ing", async () => {
      state.warningReturn = "Delete";
      registerScriptCommands(makeManager(), outputChannel);
      const del = state.registeredCommands.get("nexus.script.delete")!;
      const innerUri = { fsPath: "/ws/.nexus/scripts/foo.js", scheme: "file", path: "/ws/.nexus/scripts/foo.js", toString: () => "" };
      await del({ kind: "script", uri: innerUri, name: "foo", description: "", running: false, parseErrors: [] });
      expect(state.mockFsDelete).toHaveBeenCalled();
    });

    it("stop from tree view unwraps ScriptNode and maps it to the matching run", async () => {
      const runsSnapshot = [
        {
          id: "r1",
          scriptName: "foo",
          scriptPath: "/ws/.nexus/scripts/foo.js",
          sessionId: "sess-a",
          sessionName: "term",
          sessionType: "ssh",
          startedAt: 0,
          state: "running",
          currentOperation: null,
          inputLockHeld: false
        }
      ];
      const mgr = makeManager({ getRuns: () => runsSnapshot });
      registerScriptCommands(mgr, outputChannel);
      const stop = state.registeredCommands.get("nexus.script.stop")!;
      const innerUri = { fsPath: "/ws/.nexus/scripts/foo.js", scheme: "file", path: "/ws/.nexus/scripts/foo.js", toString: () => "" };
      await stop({ kind: "script", uri: innerUri, name: "foo", description: "", running: true, parseErrors: [] });
      expect(mgr.stopScript).toHaveBeenCalledWith("sess-a");
    });

    it("stop still accepts a bare sessionId string (status-bar tooltip path)", async () => {
      const mgr = makeManager({ getRuns: () => [] });
      registerScriptCommands(mgr, outputChannel);
      const stop = state.registeredCommands.get("nexus.script.stop")!;
      await stop("sess-z");
      expect(mgr.stopScript).toHaveBeenCalledWith("sess-z");
    });
  });

  describe("openScriptsFolder command", () => {
    it("registers nexus.script.openScriptsFolder and reveals the configured scripts dir", async () => {
      registerScriptCommands(makeManager(), outputChannel);
      const handler = state.registeredCommands.get("nexus.script.openScriptsFolder");
      expect(handler).toBeDefined();
      await handler!();
      expect(state.mockOpenExternal).toHaveBeenCalled();
      const arg = state.mockOpenExternal.mock.calls[0][0] as { fsPath: string };
      expect(arg.fsPath).toBe("/ws/.nexus/scripts");
    });

    it("informs the user and does nothing when there is no workspace", async () => {
      const prevFolders = (await import("vscode")).workspace.workspaceFolders;
      (await import("vscode")).workspace.workspaceFolders = undefined as unknown as typeof prevFolders;

      registerScriptCommands(makeManager(), outputChannel);
      await state.registeredCommands.get("nexus.script.openScriptsFolder")!();
      expect(state.mockShowInformationMessage).toHaveBeenCalled();
      expect(state.mockOpenExternal).not.toHaveBeenCalled();

      (await import("vscode")).workspace.workspaceFolders = prevFolders;
    });
  });

  describe("S2 — delete command", () => {
    it("registers nexus.script.delete which confirms and deletes", async () => {
      state.warningReturn = "Delete";
      registerScriptCommands(makeManager(), outputChannel);
      const handler = state.registeredCommands.get("nexus.script.delete");
      expect(handler).toBeDefined();
      const uri = { fsPath: "/ws/.nexus/scripts/foo.js", scheme: "file", toString: () => "/ws/.nexus/scripts/foo.js" };
      await handler!(uri);
      expect(state.mockShowWarningMessage).toHaveBeenCalled();
      expect(state.mockFsDelete).toHaveBeenCalled();
    });

    it("does not delete when the user cancels", async () => {
      state.warningReturn = undefined; // cancelled
      registerScriptCommands(makeManager(), outputChannel);
      const handler = state.registeredCommands.get("nexus.script.delete")!;
      const uri = { fsPath: "/ws/.nexus/scripts/foo.js", scheme: "file", toString: () => "/ws/.nexus/scripts/foo.js" };
      await handler(uri);
      expect(state.mockFsDelete).not.toHaveBeenCalled();
    });
  });
});
