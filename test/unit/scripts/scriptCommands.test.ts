import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
  writtenFiles: new Map<string, string>(),
  inputBoxValidator: undefined as ((v: string) => string | undefined) | undefined,
  inputBoxOptions: undefined as { value?: string; valueSelection?: [number, number] } | undefined,
  inputBoxReturn: undefined as string | undefined,
  quickPickOptions: undefined as unknown,
  quickPickReturn: undefined as unknown,
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
    activeTextEditor: undefined,
    activeTerminal: undefined as unknown,
    showInputBox: (opts: { validateInput?: (v: string) => string | undefined; value?: string; valueSelection?: [number, number] }) => {
      state.inputBoxValidator = opts?.validateInput;
      state.inputBoxOptions = { value: opts?.value, valueSelection: opts?.valueSelection };
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
    showQuickPick: vi.fn((items: unknown) => {
      state.quickPickOptions = items;
      if (state.quickPickReturn !== undefined) {
        return Promise.resolve(state.quickPickReturn);
      }
      return Promise.resolve(Array.isArray(items) ? items[0] : undefined);
    })
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

import * as vscode from "vscode";
import { registerScriptCommands } from "../../../src/commands/scriptCommands";
import type { ScriptRuntimeManager } from "../../../src/services/scripts/scriptRuntimeManager";

function makeManager(overrides: Partial<Record<string, unknown>> = {}): ScriptRuntimeManager {
  return {
    runScript: vi.fn(async () => undefined),
    stopScript: vi.fn(async () => {}),
    getRuns: vi.fn(() => []),
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
    state.inputBoxOptions = undefined;
    state.inputBoxReturn = undefined;
    state.quickPickOptions = undefined;
    state.quickPickReturn = undefined;
    state.warningReturn = undefined;
    state.mockShowWarningMessage.mockClear();
    state.mockShowInformationMessage.mockClear();
    state.mockShowErrorMessage.mockClear();
    state.mockOpenExternal.mockClear();
    vi.mocked(vscode.commands.executeCommand).mockClear();
    vi.mocked(vscode.workspace.fs.createDirectory).mockClear();
    state.mockFsDelete.mockClear();
    state.mockFsStatThrows = true;
  });

  describe("F1/F2 — starter templates", () => {
    it("offers script templates before asking for the script name", async () => {
      state.inputBoxReturn = "my-procedure";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      const labels = (state.quickPickOptions as Array<{ label: string }>).map((item) => item.label);
      expect(labels).toEqual([
        "Basic command",
        "Wait for prompt then send",
        "Capture command output",
        "Backup running config"
      ]);
    });

    it("writes a starter script that includes @target-type ssh", async () => {
      state.inputBoxReturn = "my-procedure";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      const body = state.writtenFiles.get("/ws/.nexus/scripts/my-procedure.js");
      expect(body).toBeDefined();
      expect(body!).toMatch(/@target-type\s+ssh/);
    });

    it("includes @allow-macros escape-hatch comment and try/catch scaffold", async () => {
      state.inputBoxReturn = "login";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      const body = state.writtenFiles.get("/ws/.nexus/scripts/login.js");
      expect(body).toBeDefined();
      expect(body!).toMatch(/@allow-macros/);
      expect(body!).toMatch(/try\s*\{/);
      expect(body!).toMatch(/catch\s*\(/);
    });

    it("writes the selected wait-and-send template content", async () => {
      state.inputBoxReturn = "wait-send";
      state.quickPickReturn = { label: "Wait for prompt then send", templateId: "wait-send" };
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      const body = state.writtenFiles.get("/ws/.nexus/scripts/wait-send.js");
      expect(body).toBeDefined();
      expect(body!).toMatch(/@nexus-script/);
      expect(body!).toMatch(/@name wait-send/);
      expect(body!).toMatch(/await expect\(\s*\/login:/);
      expect(body!).toMatch(/await sendLine\("admin"\)/);
    });

    it("writes capture-output and backup-running-config templates as valid Nexus scripts", async () => {
      for (const [templateId, scriptName, expected] of [
        ["capture-output", "capture", /const output = result\.before\.trim\(\)/],
        ["backup-running-config", "backup", /show running-config/]
      ] as const) {
        state.inputBoxReturn = scriptName;
        state.quickPickReturn = { label: templateId, templateId };
        registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
        const handler = state.registeredCommands.get("nexus.script.new")!;
        await handler();
        const body = state.writtenFiles.get(`/ws/.nexus/scripts/${scriptName}.js`);
        expect(body).toBeDefined();
        expect(body!).toMatch(/@nexus-script/);
        expect(body!).toMatch(expected);
      }
    });
  });

  describe("P3 — strip trailing .js", () => {
    it("strips trailing .js from the user-typed filename", async () => {
      state.inputBoxReturn = "login.js";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      // Should not produce login.js.js
      expect(state.writtenFiles.has("/ws/.nexus/scripts/login.js.js")).toBe(false);
      expect(state.writtenFiles.has("/ws/.nexus/scripts/login.js")).toBe(true);
    });

    it("validator rejects empty after strip and accepts .js suffix inputs", async () => {
      state.inputBoxReturn = "my-procedure.js";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      expect(state.inputBoxValidator).toBeDefined();
      expect(state.inputBoxValidator!("login.js")).toBeUndefined();
      expect(state.inputBoxValidator!(".js")).toBeDefined(); // empty after strip
      expect(state.inputBoxValidator!("")).toBeDefined();
      expect(state.inputBoxValidator!("bad name")).toBeDefined(); // has a space
    });
  });

  describe("§5.7 — path grammar for New Script (folders + traversal safety)", () => {
    it("creates intermediate directories for a folder-qualified name like 'a/b'", async () => {
      state.inputBoxReturn = "a/b";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      const createDirCalls = vi
        .mocked(vscode.workspace.fs.createDirectory)
        .mock.calls.map((c) => (c[0] as { fsPath: string }).fsPath);
      expect(createDirCalls).toContain("/ws/.nexus/scripts/a");
      expect(state.writtenFiles.has("/ws/.nexus/scripts/a/b.js")).toBe(true);
    });

    it("pre-seeds the input box with 'folder/' when invoked from that folder's context menu", async () => {
      state.inputBoxReturn = undefined; // cancel — only the seeded value matters here
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler({ kind: "folder", path: "cisco", name: "cisco", uri: { fsPath: "/ws/.nexus/scripts/cisco" } });
      expect(state.inputBoxOptions?.value).toBe("cisco/");
    });

    it("the validator rejects '../' traversal in the folder part", async () => {
      state.inputBoxReturn = "../../../../home/evgeny/startup";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      expect(state.inputBoxValidator).toBeDefined();
      expect(state.inputBoxValidator!("../../../../home/evgeny/startup")).toBeDefined();
      expect(state.inputBoxValidator!("cisco/../secret")).toBeDefined();
    });

    it("verified consequence stays closed: '../' traversal input never escapes the scripts directory", async () => {
      state.inputBoxReturn = "../../../../home/evgeny/startup";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      // Nothing gets written at all — parseScriptPathInput rejects it even if
      // some caller bypassed the input box's own validateInput.
      expect(state.writtenFiles.size).toBe(0);
      for (const path of state.writtenFiles.keys()) {
        expect(path.startsWith("/ws/.nexus/scripts")).toBe(true);
      }
    });

    it("rejects a backslash with a message telling the user to use '/'", async () => {
      state.inputBoxReturn = "cisco\\backup";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      expect(state.inputBoxValidator).toBeDefined();
      const message = state.inputBoxValidator!("cisco\\backup");
      expect(message).toBeDefined();
      expect(message!).toMatch(/use '\/'/i);
      expect(state.writtenFiles.size).toBe(0);
    });

    it("rejects a folder part the Scripts view will never render, so a new script cannot be created somewhere invisible", async () => {
      state.inputBoxReturn = undefined;
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler();
      const validate = state.inputBoxValidator!;

      expect(validate("node_modules/backup")).toMatch(/never shows/);
      expect(validate(".archive/backup")).toMatch(/never shows/);
      expect(validate("types/backup")).toMatch(/never shows/);
      expect(validate("cisco/types/backup")).toBeUndefined();
      expect(validate("cisco/backup")).toBeUndefined();
      // A dot-prefixed LEAF is a file, not a directory — the scanner lists it.
      expect(validate(".hidden")).toBeUndefined();
    });

    it("Fix 7 — a trailing slash is rejected with 'Name is required', not silently creating the folder name as a script at the root", async () => {
      // Regression: right-click "cisco" -> New Script pre-seeds "cisco/"; if
      // the user presses Enter without typing a leaf, the pre-fix code
      // silently created "cisco.js" at the scripts ROOT — the opposite of
      // what pre-seeding a folder prefix promises.
      state.inputBoxReturn = "cisco/";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;
      await handler({ kind: "folder", path: "cisco", name: "cisco", uri: { fsPath: "/ws/.nexus/scripts/cisco" } });

      expect(state.inputBoxValidator).toBeDefined();
      expect(state.inputBoxValidator!("cisco/")).toBe("Name is required");
      // Even though the mock's showInputBox doesn't itself enforce
      // validateInput, parseScriptPathInput independently rejects the same
      // input — nothing gets written at all, and specifically not at the root.
      expect(state.writtenFiles.has("/ws/.nexus/scripts/cisco.js")).toBe(false);
      expect(state.writtenFiles.size).toBe(0);
    });
  });

  describe("Fix 5 — filesystem failures during New Script / New Folder are reported, not left to surface as a generic 'contributed command failed'", () => {
    it("New Script: a createDirectory failure is caught and shown via showErrorMessage", async () => {
      vi.mocked(vscode.workspace.fs.createDirectory).mockRejectedValueOnce(new Error("EINVAL: invalid path"));
      state.inputBoxReturn = "my-procedure";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.new")!;

      await expect(handler()).resolves.toBeUndefined();

      expect(state.mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("EINVAL"));
      expect(state.writtenFiles.size).toBe(0);
    });

    it("New Folder: a createDirectory failure is caught and shown via showErrorMessage", async () => {
      state.mockFsStatThrows = true; // doesn't exist yet, so creation is attempted
      vi.mocked(vscode.workspace.fs.createDirectory).mockRejectedValueOnce(new Error("EACCES: permission denied"));
      state.inputBoxReturn = "cisco";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.newFolder")!;

      await expect(handler()).resolves.toBeUndefined();

      expect(state.mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    });
  });

  describe("nexus.script.newFolder (§5.7 — New Folder)", () => {
    it("creates a real directory on disk", async () => {
      state.mockFsStatThrows = true; // doesn't exist yet
      state.inputBoxReturn = "cisco/backup";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.newFolder")!;
      await handler();
      const createDirCalls = vi
        .mocked(vscode.workspace.fs.createDirectory)
        .mock.calls.map((c) => (c[0] as { fsPath: string }).fsPath);
      expect(createDirCalls).toContain("/ws/.nexus/scripts/cisco/backup");
    });

    it("is a no-op with an info message when the folder already exists", async () => {
      state.mockFsStatThrows = false; // exists
      state.inputBoxReturn = "cisco";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.newFolder")!;
      await handler();
      expect(state.mockShowInformationMessage).toHaveBeenCalled();
      expect(vi.mocked(vscode.workspace.fs.createDirectory).mock.calls.length).toBe(0);
    });

    it("pre-seeds the input with 'folder/' when invoked from a folder's context menu (nested folder creation)", async () => {
      state.inputBoxReturn = undefined;
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.newFolder")!;
      await handler({ kind: "folder", path: "cisco", name: "cisco", uri: { fsPath: "/ws/.nexus/scripts/cisco" } });
      expect(state.inputBoxOptions?.value).toBe("cisco/");
    });

    it("rejects a path containing '..'", async () => {
      state.inputBoxReturn = "../escape";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.newFolder")!;
      await handler();
      expect(state.inputBoxValidator).toBeDefined();
      expect(state.inputBoxValidator!("../escape")).toBeDefined();
      expect(vi.mocked(vscode.workspace.fs.createDirectory).mock.calls.length).toBe(0);
    });

    it("rejects a backslash with a 'use /' message", async () => {
      state.inputBoxReturn = "cisco\\backup";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.newFolder")!;
      await handler();
      const message = state.inputBoxValidator!("cisco\\backup");
      expect(message).toBeDefined();
      expect(message!).toMatch(/use '\/'/i);
    });

    it("rejects names the Scripts view will never render, instead of creating an invisible directory", async () => {
      // These all pass the folder-path grammar, so the directory really got
      // created on disk — and then `scanScriptsDir` skipped it, so it never
      // appeared, and a second attempt reported "already exists" about a
      // folder the user cannot see anywhere.
      state.inputBoxReturn = undefined;
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.newFolder")!;
      await handler();
      const validate = state.inputBoxValidator!;

      expect(validate(".archive")).toMatch(/never shows/);
      expect(validate("node_modules")).toMatch(/never shows/);
      expect(validate("types")).toMatch(/never shows/);
      expect(validate("cisco/.old")).toMatch(/never shows/);
      // ...and does NOT reject the things the scanner does walk.
      expect(validate("cisco")).toBeUndefined();
      expect(validate("cisco/types")).toBeUndefined();
    });
  });

  describe("nexus.script.refresh", () => {
    it("calls the injected refresh callback", () => {
      const refresh = vi.fn();
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs", undefined, refresh);
      const handler = state.registeredCommands.get("nexus.script.refresh")!;
      handler();
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("does nothing (does not throw) when no refresh callback was provided", () => {
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.refresh")!;
      expect(() => handler()).not.toThrow();
    });
  });

  describe("S1 — openDocs command", () => {
    it("registers nexus.script.openDocs which calls env.openExternal", async () => {
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.openDocs");
      expect(handler).toBeDefined();
      await handler!();
      expect(state.mockOpenExternal).toHaveBeenCalled();
      const arg = state.mockOpenExternal.mock.calls[0][0] as { toString: () => string };
      expect(String(arg)).toMatch(/github\.com/);
      expect(String(arg)).toMatch(/docs\/scripting\.md/);
    });

    it("registers nexus.script.openExamples which opens bundled script examples", async () => {
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.openExamples");
      expect(handler).toBeDefined();
      await handler!();
      expect(state.mockOpenExternal).toHaveBeenCalled();
      const arg = state.mockOpenExternal.mock.calls[0][0] as { toString: () => string };
      expect(String(arg)).toMatch(/github\.com/);
      expect(String(arg)).toMatch(/examples\/scripts/);
    });
  });

  describe("workspace gating", () => {
    it("run works without an open workspace folder (user can open a .js directly)", async () => {
      const prevFolders = (await import("vscode")).workspace.workspaceFolders;
      (await import("vscode")).workspace.workspaceFolders = undefined as unknown as typeof prevFolders;

      const mgr = makeManager();
      registerScriptCommands(mgr, outputChannel, "/tmp/fake-gs");
      const run = state.registeredCommands.get("nexus.script.run")!;
      const uri = { fsPath: "/tmp/adhoc.js", scheme: "file", path: "/tmp/adhoc.js", toString: () => "" };
      await run(uri);
      expect(mgr.runScript).toHaveBeenCalledWith(uri);
      expect(state.mockShowInformationMessage).not.toHaveBeenCalled(); // no "open a folder" nag

      (await import("vscode")).workspace.workspaceFolders = prevFolders;
    });

    it("new works without a workspace by falling back to globalStoragePath", async () => {
      const prevFolders = (await import("vscode")).workspace.workspaceFolders;
      try {
        (await import("vscode")).workspace.workspaceFolders = undefined as unknown as typeof prevFolders;
        state.inputBoxReturn = "my-procedure";
        registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
        const handler = state.registeredCommands.get("nexus.script.new")!;
        await handler();
        const body = state.writtenFiles.get("/tmp/fake-gs/scripts/my-procedure.js");
        expect(body).toBeDefined();
        expect(body!).toMatch(/@nexus-script/);
      } finally {
        (await import("vscode")).workspace.workspaceFolders = prevFolders;
      }
    });
  });

  describe("tree-view argument unwrap (bug: 'Unable to resolve filesystem provider …')", () => {
    it("run accepts a real Uri from the CodeLens path", async () => {
      const mgr = makeManager();
      registerScriptCommands(mgr, outputChannel, "/tmp/fake-gs");
      const run = state.registeredCommands.get("nexus.script.run")!;
      const uri = { fsPath: "/ws/.nexus/scripts/test.js", scheme: "file", path: "/ws/.nexus/scripts/test.js", toString: () => "" };
      await run(uri);
      expect(mgr.runScript).toHaveBeenCalledWith(uri);
    });

    it("run accepts a ScriptNode { uri } from the tree view menu", async () => {
      const mgr = makeManager();
      registerScriptCommands(mgr, outputChannel, "/tmp/fake-gs");
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
      registerScriptCommands(mgr, outputChannel, "/tmp/fake-gs");
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
      registerScriptCommands(mgr, outputChannel, "/tmp/fake-gs");
      const run = state.registeredCommands.get("nexus.script.run")!;
      // ShowOpenDialog is mocked to return undefined → no run initiated.
      await run({ someUnrelatedShape: true });
      expect(mgr.runScript).not.toHaveBeenCalled();
    });

    it("delete unwraps a ScriptNode rather than silently no-op-ing", async () => {
      state.warningReturn = "Delete";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
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
      registerScriptCommands(mgr, outputChannel, "/tmp/fake-gs");
      const stop = state.registeredCommands.get("nexus.script.stop")!;
      const innerUri = { fsPath: "/ws/.nexus/scripts/foo.js", scheme: "file", path: "/ws/.nexus/scripts/foo.js", toString: () => "" };
      await stop({ kind: "script", uri: innerUri, name: "foo", description: "", running: true, parseErrors: [] });
      expect(mgr.stopScript).toHaveBeenCalledWith("sess-a");
    });

    it("stop still accepts a bare sessionId string (status-bar tooltip path)", async () => {
      const mgr = makeManager({ getRuns: () => [] });
      registerScriptCommands(mgr, outputChannel, "/tmp/fake-gs");
      const stop = state.registeredCommands.get("nexus.script.stop")!;
      await stop("sess-z");
      expect(mgr.stopScript).toHaveBeenCalledWith("sess-z");
    });
  });

  describe("runQuick command (tree view inline ▶ — uses active terminal)", () => {
    it("binds to the focused Nexus terminal when one is active (no picker shown)", async () => {
      const mgr = makeManager();
      const fakeTerminal = { name: "web-1" } as unknown as import("vscode").Terminal;
      (await import("vscode")).window.activeTerminal = fakeTerminal;
      const resolver = vi.fn((t: unknown) => (t === fakeTerminal ? "sess-a" : undefined));

      registerScriptCommands(mgr, outputChannel, "/tmp/fake-gs", resolver as never);
      const runQuick = state.registeredCommands.get("nexus.script.runQuick")!;
      const uri = { fsPath: "/ws/.nexus/scripts/x.js", scheme: "file", path: "/ws/.nexus/scripts/x.js", toString: () => "" };
      await runQuick(uri);

      expect(resolver).toHaveBeenCalledWith(fakeTerminal);
      expect(mgr.runScript).toHaveBeenCalledWith(uri, "sess-a");

      (await import("vscode")).window.activeTerminal = undefined;
    });

    it("falls back to the picker (manager.runScript(uri)) when no terminal is focused", async () => {
      const mgr = makeManager();
      (await import("vscode")).window.activeTerminal = undefined;
      const resolver = vi.fn(() => undefined);

      registerScriptCommands(mgr, outputChannel, "/tmp/fake-gs", resolver as never);
      const runQuick = state.registeredCommands.get("nexus.script.runQuick")!;
      const uri = { fsPath: "/ws/.nexus/scripts/x.js", scheme: "file", path: "/ws/.nexus/scripts/x.js", toString: () => "" };
      await runQuick(uri);

      // manager.runScript called WITHOUT sessionId — picker path inside the runtime.
      expect(mgr.runScript).toHaveBeenCalledWith(uri, undefined);
    });

    it("falls back to the picker when the focused terminal isn't a Nexus session", async () => {
      const mgr = makeManager();
      const nonNexusTerminal = { name: "bash" } as unknown as import("vscode").Terminal;
      (await import("vscode")).window.activeTerminal = nonNexusTerminal;
      const resolver = vi.fn(() => undefined); // not a Nexus session

      registerScriptCommands(mgr, outputChannel, "/tmp/fake-gs", resolver as never);
      const runQuick = state.registeredCommands.get("nexus.script.runQuick")!;
      const uri = { fsPath: "/ws/.nexus/scripts/x.js", scheme: "file", path: "/ws/.nexus/scripts/x.js", toString: () => "" };
      await runQuick(uri);

      expect(mgr.runScript).toHaveBeenCalledWith(uri, undefined);

      (await import("vscode")).window.activeTerminal = undefined;
    });

    it("binds to the focused Local Shell terminal when one is active", async () => {
      const mgr = makeManager();
      const localShellTerminal = { name: "Nexus Local Shell: Dev" } as unknown as import("vscode").Terminal;
      (await import("vscode")).window.activeTerminal = localShellTerminal;
      const resolver = vi.fn((terminal: unknown) => terminal === localShellTerminal ? "local-session" : undefined);

      registerScriptCommands(mgr, outputChannel, "/tmp/fake-gs", resolver as never);
      const runQuick = state.registeredCommands.get("nexus.script.runQuick")!;
      const uri = { fsPath: "/ws/.nexus/scripts/x.js", scheme: "file", path: "/ws/.nexus/scripts/x.js", toString: () => "" };
      await runQuick(uri);

      expect(resolver).toHaveBeenCalledWith(localShellTerminal);
      expect(mgr.runScript).toHaveBeenCalledWith(uri, "local-session");

      (await import("vscode")).window.activeTerminal = undefined;
    });

    it("unwraps ScriptNode like the other handlers do", async () => {
      const mgr = makeManager();
      const fakeTerminal = { name: "web-1" } as unknown as import("vscode").Terminal;
      (await import("vscode")).window.activeTerminal = fakeTerminal;
      const resolver = vi.fn(() => "sess-a");

      registerScriptCommands(mgr, outputChannel, "/tmp/fake-gs", resolver as never);
      const runQuick = state.registeredCommands.get("nexus.script.runQuick")!;
      const innerUri = { fsPath: "/ws/.nexus/scripts/x.js", scheme: "file", path: "/ws/.nexus/scripts/x.js", toString: () => "" };
      await runQuick({ kind: "script", uri: innerUri, name: "x", description: "", running: false, parseErrors: [] });

      expect(mgr.runScript).toHaveBeenCalledWith(innerUri, "sess-a");

      (await import("vscode")).window.activeTerminal = undefined;
    });
  });

  describe("openScriptsFolder command", () => {
    function revealArg(): { fsPath: string } | undefined {
      const call = vi.mocked(vscode.commands.executeCommand).mock.calls.find(
        (c) => c[0] === "revealFileInOS"
      );
      return call?.[1] as { fsPath: string } | undefined;
    }

    it("opens the scripts folder ITSELF, not the folder that contains it", async () => {
      // `revealFileInOS` is Electron's `showItemInFolder`: given a directory it
      // opens that directory's PARENT with the directory selected. For the
      // default `.nexus/scripts` that means a window on `<workspace>/.nexus`,
      // which holds no scripts — the command is called Open Scripts Folder and
      // it was opening the wrong one. `openExternal` opens the directory.
      state.mockOpenExternal.mockResolvedValue(true);
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.openScriptsFolder");
      expect(handler).toBeDefined();

      await handler!();

      expect(state.mockOpenExternal).toHaveBeenCalledTimes(1);
      expect((state.mockOpenExternal.mock.calls[0][0] as { fsPath: string }).fsPath).toBe(
        "/ws/.nexus/scripts"
      );
      // Not also revealed — one window, and never the parent when the right
      // one opened.
      expect(revealArg()).toBeUndefined();
    });

    it("falls back to revealFileInOS when openExternal reports it did not open", async () => {
      // From a remote window a `file:` URI resolves on the local machine, so
      // `openExternal` can decline. Landing on the parent folder beats landing
      // nowhere.
      state.mockOpenExternal.mockResolvedValue(false);
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");

      await state.registeredCommands.get("nexus.script.openScriptsFolder")!();

      expect(revealArg()?.fsPath).toBe("/ws/.nexus/scripts");
    });

    it("falls back to revealFileInOS when openExternal throws", async () => {
      state.mockOpenExternal.mockRejectedValue(new Error("no handler"));
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");

      await state.registeredCommands.get("nexus.script.openScriptsFolder")!();

      expect(revealArg()?.fsPath).toBe("/ws/.nexus/scripts");
    });

    it("says where the folder is when neither route works, instead of failing silently", async () => {
      state.mockOpenExternal.mockResolvedValue(false);
      vi.mocked(vscode.commands.executeCommand).mockRejectedValue(new Error("unsupported"));
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");

      await state.registeredCommands.get("nexus.script.openScriptsFolder")!();

      expect(state.mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("/ws/.nexus/scripts")
      );
    });

    it("falls back to globalStoragePath when no workspace is open", async () => {
      const prevFolders = (await import("vscode")).workspace.workspaceFolders;
      try {
        (await import("vscode")).workspace.workspaceFolders = undefined as unknown as typeof prevFolders;
        state.mockOpenExternal.mockResolvedValue(true);
        registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");

        await state.registeredCommands.get("nexus.script.openScriptsFolder")!();

        expect((state.mockOpenExternal.mock.calls[0][0] as { fsPath: string }).fsPath).toBe(
          "/tmp/fake-gs/scripts"
        );
      } finally {
        (await import("vscode")).workspace.workspaceFolders = prevFolders;
      }
    });
  });

  describe("S2 — delete command", () => {
    it("registers nexus.script.delete which confirms and deletes", async () => {
      state.warningReturn = "Delete";
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.delete");
      expect(handler).toBeDefined();
      const uri = { fsPath: "/ws/.nexus/scripts/foo.js", scheme: "file", toString: () => "/ws/.nexus/scripts/foo.js" };
      await handler!(uri);
      expect(state.mockShowWarningMessage).toHaveBeenCalled();
      expect(state.mockFsDelete).toHaveBeenCalled();
    });

    it("does not delete when the user cancels", async () => {
      state.warningReturn = undefined; // cancelled
      registerScriptCommands(makeManager(), outputChannel, "/tmp/fake-gs");
      const handler = state.registeredCommands.get("nexus.script.delete")!;
      const uri = { fsPath: "/ws/.nexus/scripts/foo.js", scheme: "file", toString: () => "/ws/.nexus/scripts/foo.js" };
      await handler(uri);
      expect(state.mockFsDelete).not.toHaveBeenCalled();
    });
  });
});
