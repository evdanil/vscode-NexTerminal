import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFsEntries = new Map<string, Array<[string, number]>>();
const mockFiles = new Map<string, string>();

// Captured by the mock's onDidChangeConfiguration so tests can drive config-
// change events through the provider.
const configChangeListeners = new Set<(e: { affectsConfiguration: (section: string) => boolean }) => void>();

// Resettable per-test pretend scripts path — lets tests simulate the setting
// moving between directories to exercise the watcher-rebuild path.
let mockScriptsPath = ".nexus/scripts";

// Count of createFileSystemWatcher calls so tests can assert the watcher was
// rebuilt when the target directory changed.
let createWatcherCalls = 0;

// Captured watcher event callbacks, each tagged with the glob pattern its
// watcher was created with, so `fireWatcherEvent()` below can emulate real
// FileSystemWatcher pattern-matching rather than blindly invoking every
// registered callback regardless of what glob it was bound to. This is what
// makes the directory-rename/delete test actually sensitive to "**/*" vs
// "**/*.js" — a bare directory path structurally can't match the latter.
interface WatcherRegistration {
  pattern: string;
  cb: (uri: unknown) => void;
}
const watcherHandlers = {
  create: [] as WatcherRegistration[],
  change: [] as WatcherRegistration[],
  delete: [] as WatcherRegistration[]
};

/** Minimal glob emulation covering only the shapes this feature ever uses. */
function globMatchesSuffix(pattern: string, fsPath: string): boolean {
  const suffix = pattern.replace(/^\*\*\//, "");
  if (suffix === "*") return true; // "**/*" — matches any file OR directory path
  const extMatch = /^\*(\..+)$/.exec(suffix);
  if (extMatch) {
    return fsPath.toLowerCase().endsWith(extMatch[1].toLowerCase()); // "**/*.js"
  }
  return true;
}

function fireWatcherEvent(kind: "create" | "change" | "delete", fsPath: string): void {
  for (const { pattern, cb } of watcherHandlers[kind]) {
    if (globMatchesSuffix(pattern, fsPath)) {
      cb({ fsPath, scheme: "file", path: fsPath, toString: () => fsPath });
    }
  }
}

vi.mock("vscode", () => ({
  EventEmitter: class MockEventEmitter<T> {
    private listeners = new Set<(v: T) => void>();
    public readonly event = (l: (v: T) => void) => {
      this.listeners.add(l);
      return { dispose: () => this.listeners.delete(l) };
    };
    public fire(v?: T): void {
      for (const l of this.listeners) l(v as T);
    }
    public dispose(): void {
      this.listeners.clear();
    }
  },
  TreeItem: class MockTreeItem {
    public label: string;
    public description?: string;
    public tooltip?: string;
    public collapsibleState?: number;
    public contextValue?: string;
    public command?: unknown;
    public iconPath?: unknown;
    public resourceUri?: unknown;
    public constructor(label: string, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    public constructor(public readonly id: string) {}
  },
  RelativePattern: class {
    public constructor(public readonly base: unknown, public readonly pattern: string) {}
  },
  FileType: { File: 1, Directory: 2 },
  Uri: {
    file: (p: string) => ({
      fsPath: p,
      scheme: "file",
      path: p,
      toString: () => p
    }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
      scheme: "file",
      path: [base.fsPath, ...parts].join("/"),
      toString: () => [base.fsPath, ...parts].join("/")
    })
  },
  workspace: {
    workspaceFolders: [],
    fs: {
      readDirectory: vi.fn(async (uri: { fsPath: string }) => mockFsEntries.get(uri.fsPath) ?? []),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const content = mockFiles.get(uri.fsPath);
        if (content === undefined) throw new Error(`ENOENT: ${uri.fsPath}`);
        return new TextEncoder().encode(content);
      })
    },
    getConfiguration: vi.fn(() => ({
      // Return the pretend scripts path for `nexus.scripts.path`, fall through
      // to the provided default for anything else so existing tests still see
      // `.nexus/scripts` via resolveScriptsDir's default.
      get: vi.fn((k: string, d?: unknown) => (k === "path" ? mockScriptsPath : d))
    })),
    onDidChangeConfiguration: vi.fn((listener: (e: { affectsConfiguration: (section: string) => boolean }) => void) => {
      configChangeListeners.add(listener);
      return { dispose: () => configChangeListeners.delete(listener) };
    }),
    createFileSystemWatcher: vi.fn((relPattern: { pattern: string }) => {
      createWatcherCalls += 1;
      const pattern = relPattern.pattern;
      return {
        onDidCreate: vi.fn((cb: (uri: unknown) => void) => {
          watcherHandlers.create.push({ pattern, cb });
          return { dispose: vi.fn() };
        }),
        onDidChange: vi.fn((cb: (uri: unknown) => void) => {
          watcherHandlers.change.push({ pattern, cb });
          return { dispose: vi.fn() };
        }),
        onDidDelete: vi.fn((cb: (uri: unknown) => void) => {
          watcherHandlers.delete.push({ pattern, cb });
          return { dispose: vi.fn() };
        }),
        dispose: vi.fn()
      };
    })
  }
}));

import * as vscode from "vscode";
import { ScriptTreeProvider } from "../../../src/ui/scriptTreeProvider";
import type { ScriptRuntimeManager } from "../../../src/services/scripts/scriptRuntimeManager";

function mockManager(): ScriptRuntimeManager {
  return {
    getRuns: vi.fn(() => []),
    onDidChangeRun: Object.assign(
      (_listener: () => void) => ({ dispose: () => {} }),
      {}
    ) as unknown as ScriptRuntimeManager["onDidChangeRun"]
  } as unknown as ScriptRuntimeManager;
}

describe("ScriptTreeProvider", () => {
  beforeEach(() => {
    mockFsEntries.clear();
    mockFiles.clear();
    configChangeListeners.clear();
    createWatcherCalls = 0;
    watcherHandlers.create.length = 0;
    watcherHandlers.change.length = 0;
    watcherHandlers.delete.length = 0;
    mockScriptsPath = ".nexus/scripts";
    (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
      { uri: { fsPath: "/workspace", scheme: "file", path: "/workspace" }, name: "ws", index: 0 }
    ];
    // Restore the standard mock for fs.readDirectory in case a prior test stubbed it.
    (vscode.workspace.fs as unknown as { readDirectory: (u: { fsPath: string }) => Promise<Array<[string, number]>> }).readDirectory = vi.fn(
      async (uri: { fsPath: string }) => mockFsEntries.get(uri.fsPath) ?? []
    );
  });

  it("lists .js files whose leading JSDoc contains @nexus-script", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [
      ["hello.js", 1],
      ["notAScript.js", 1]
    ]);
    mockFiles.set(
      "/workspace/.nexus/scripts/hello.js",
      "/**\n * @nexus-script\n * @name Hello\n */\n"
    );
    mockFiles.set("/workspace/.nexus/scripts/notAScript.js", "console.log('hi');\n");

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = provider.getTreeItem(children[0]);
    expect(item.label).toBe("Hello");
  });

  it("falls back to filename when @name is absent", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [["foo.js", 1]]);
    mockFiles.set("/workspace/.nexus/scripts/foo.js", "/**\n * @nexus-script\n */\n");

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = provider.getTreeItem(children[0]);
    expect(item.label).toBe("foo");
  });

  it("shows placeholder actions when no workspace is open and no scripts exist", async () => {
    (vscode.workspace as unknown as { workspaceFolders: unknown[] | undefined }).workspaceFolders = undefined;
    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();
    expect(children.map((child) => child.kind)).toEqual(["placeholder", "placeholder", "placeholder"]);
    const items = children.map((child) => provider.getTreeItem(child) as unknown as { command?: { command: string }; iconPath?: { id: string } });
    expect(items.map((item) => item.command?.command)).toEqual([
      "nexus.script.new",
      "nexus.script.openDocs",
      "nexus.script.openExamples"
    ]);
    expect(items.map((item) => item.iconPath?.id)).toEqual(["new-file", "book", "file-code"]);
  });

  it("shows placeholder actions when the scripts directory is empty", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", []);
    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();
    expect(children).toHaveLength(3);
    const labels = children.map((child) => provider.getTreeItem(child).label);
    expect(labels).toEqual(["New Script", "Open Scripting Guide", "Open Script Examples"]);
  });

  it("shows placeholder actions on missing scripts directory", async () => {
    // Don't set mockFsEntries for /workspace/.nexus/scripts — readDirectory will throw ENOENT.
    (vscode.workspace.fs as unknown as { readDirectory: typeof vscode.workspace.fs.readDirectory }).readDirectory = vi.fn(
      async () => {
        throw new Error("ENOENT");
      }
    );
    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();
    expect(children).toHaveLength(3);
  });

  it("sets contextValue to nexus.script.file for idle scripts and nexus.script.running when running (S2)", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [
      ["idle.js", 1],
      ["active.js", 1]
    ]);
    mockFiles.set(
      "/workspace/.nexus/scripts/idle.js",
      "/**\n * @nexus-script\n */\n"
    );
    mockFiles.set(
      "/workspace/.nexus/scripts/active.js",
      "/**\n * @nexus-script\n */\n"
    );

    const manager = {
      getRuns: vi.fn(() => [
        {
          id: "r1",
          scriptName: "active",
          scriptPath: "/workspace/.nexus/scripts/active.js",
          sessionId: "s1",
          sessionName: "sess",
          sessionType: "ssh" as const,
          startedAt: 0,
          state: "running" as const,
          currentOperation: null
        }
      ]),
      onDidChangeRun: Object.assign(
        (_l: () => void) => ({ dispose: () => {} }),
        {}
      )
    } as unknown as ScriptRuntimeManager;

    const provider = new ScriptTreeProvider(manager, "/tmp/fake-gs");
    const children = await provider.getChildren();
    const items = children.map((c) => provider.getTreeItem(c));
    const byLabel = new Map(items.map((it) => [String(it.label), it]));
    expect(byLabel.get("idle")?.contextValue).toBe("nexus.script.file");
    expect(byLabel.get("active")?.contextValue).toBe("nexus.script.running");
  });

  it("shows a running badge description when a script is running (F8)", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [["active.js", 1]]);
    mockFiles.set(
      "/workspace/.nexus/scripts/active.js",
      "/**\n * @nexus-script\n */\n"
    );
    const manager = {
      getRuns: vi.fn(() => [
        {
          id: "r1",
          scriptName: "active",
          scriptPath: "/workspace/.nexus/scripts/active.js",
          sessionId: "s1",
          sessionName: "sess",
          sessionType: "ssh" as const,
          startedAt: 0,
          state: "running" as const,
          currentOperation: null
        }
      ]),
      onDidChangeRun: Object.assign(
        (_l: () => void) => ({ dispose: () => {} }),
        {}
      )
    } as unknown as ScriptRuntimeManager;
    const provider = new ScriptTreeProvider(manager, "/tmp/fake-gs");
    const children = await provider.getChildren();
    const item = provider.getTreeItem(children[0]);
    expect(String(item.description ?? "")).toContain("running");
  });

  it("does NOT echo header description next to the name — description lives in the tooltip only", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [["hasdesc.js", 1]]);
    mockFiles.set(
      "/workspace/.nexus/scripts/hasdesc.js",
      "/**\n * @nexus-script\n * @name Labeled\n * @description A long description that would clutter the row\n */\n"
    );
    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();
    const item = provider.getTreeItem(children[0]);
    // Row label is just the name. Description column is empty for idle scripts.
    expect(item.label).toBe("Labeled");
    expect(String(item.description ?? "")).toBe("");
    // But the hover tooltip DOES include the description so users who want it can see it.
    expect(String(item.tooltip ?? "")).toContain("A long description that would clutter the row");
  });

  it("does NOT refresh on log / operationBegin / operationEnd events (prevents panel-flashing)", async () => {
    type Listener = (e: { kind: string }) => void;
    const runListeners = new Set<Listener>();
    const fireTreeEvent: Array<void> = [];

    const manager = {
      getRuns: vi.fn(() => []),
      onDidChangeRun: Object.assign(
        (l: Listener) => {
          runListeners.add(l);
          return { dispose: () => runListeners.delete(l) };
        },
        {}
      )
    } as unknown as ScriptRuntimeManager;

    const provider = new ScriptTreeProvider(manager, "/tmp/fake-gs");
    // Listen for onDidChangeTreeData emissions from the provider.
    const sub = provider.onDidChangeTreeData(() => fireTreeEvent.push(undefined));

    // Noisy events that should NOT re-render the tree.
    const fire = (e: { kind: string }) => {
      for (const l of runListeners) l(e);
    };
    fire({ kind: "log" });
    fire({ kind: "operationBegin" });
    fire({ kind: "operationEnd" });
    fire({ kind: "log" });
    expect(fireTreeEvent).toHaveLength(0);

    // State-transition events SHOULD re-render.
    fire({ kind: "started" });
    fire({ kind: "ended" });
    expect(fireTreeEvent.length).toBeGreaterThanOrEqual(2);

    sub.dispose();
  });

  it("does not attach a click-open command — Edit lives in the right-click menu now", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [["broken.js", 1]]);
    mockFiles.set(
      "/workspace/.nexus/scripts/broken.js",
      "/**\n * @nexus-script\n * @default-timeout nope\n */\n"
    );
    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();
    const item = provider.getTreeItem(children[0]) as unknown as {
      command?: { command: string };
      tooltip?: string;
    };
    // No click command — clicking a script used to be noisy. Edit is the
    // right-click menu entry that opens the file.
    expect(item.command).toBeUndefined();
    // Parse errors must still be visible so the user has a reason to fix it.
    expect(String(item.tooltip ?? "")).toMatch(/error|@default-timeout/i);
  });

  it("refreshes the tree when nexus.scripts.path configuration changes", async () => {
    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const events: Array<void> = [];
    const sub = provider.onDidChangeTreeData(() => events.push(undefined));

    // Verify the config listener was registered during construction.
    expect(configChangeListeners.size).toBe(1);

    // Fire a config change that matches nexus.scripts.path — tree should refire.
    for (const listener of configChangeListeners) {
      listener({ affectsConfiguration: (section: string) => section === "nexus.scripts.path" });
    }
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Unrelated config change should NOT refresh — saves a full tree redraw on
    // every unrelated setting toggle.
    events.length = 0;
    for (const listener of configChangeListeners) {
      listener({ affectsConfiguration: () => false });
    }
    expect(events).toHaveLength(0);

    sub.dispose();
  });

  it("rebuilds the file watcher when the configured scripts directory changes", async () => {
    // First construction creates watcher #1 pointing at the default location.
    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    expect(createWatcherCalls).toBe(1);

    // Simulate the user changing the setting and the config listener firing.
    mockScriptsPath = "/elsewhere/my-scripts";
    for (const listener of configChangeListeners) {
      listener({ affectsConfiguration: (section: string) => section === "nexus.scripts.path" });
    }

    // refresh() → ensureWatcher() must notice the dir changed and rebuild.
    expect(createWatcherCalls).toBe(2);

    // Firing another config change with the same dir must NOT rebuild —
    // otherwise chatty settings events would churn watchers for nothing.
    for (const listener of configChangeListeners) {
      listener({ affectsConfiguration: (section: string) => section === "nexus.scripts.path" });
    }
    expect(createWatcherCalls).toBe(2);

    provider.dispose();
  });

  // ---- §5.4/§5.5 — hierarchical rendering ---------------------------------

  it("renders folders before scripts at root, both naturally sorted", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [
      ["zzz.js", 1],
      ["Bravo", 2],
      ["alpha", 2],
      ["aaa.js", 1]
    ]);
    mockFsEntries.set("/workspace/.nexus/scripts/Bravo", []);
    mockFsEntries.set("/workspace/.nexus/scripts/alpha", []);
    mockFiles.set("/workspace/.nexus/scripts/zzz.js", "/**\n * @nexus-script\n * @name Zzz\n */\n");
    mockFiles.set("/workspace/.nexus/scripts/aaa.js", "/**\n * @nexus-script\n * @name Aaa\n */\n");

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();
    expect(children.map((c) => c.kind)).toEqual(["folder", "folder", "script", "script"]);
    expect(
      children.filter((c) => c.kind === "folder").map((c) => (c as { name: string }).name)
    ).toEqual(["alpha", "Bravo"]);
    expect(
      children.filter((c) => c.kind === "script").map((c) => (c as { name: string }).name)
    ).toEqual(["Aaa", "Zzz"]);
  });

  it("discovers a script nested several folders deep and lists it when its parent folder is expanded", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [["cisco", 2]]);
    mockFsEntries.set("/workspace/.nexus/scripts/cisco", [["routers", 2]]);
    mockFsEntries.set("/workspace/.nexus/scripts/cisco/routers", [["backup.js", 1]]);
    mockFiles.set(
      "/workspace/.nexus/scripts/cisco/routers/backup.js",
      "/**\n * @nexus-script\n * @name Backup\n */\n"
    );

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const root = await provider.getChildren();
    expect(root).toHaveLength(1);
    expect(root[0].kind).toBe("folder");
    expect((root[0] as { name: string }).name).toBe("cisco");

    const ciscoChildren = await provider.getChildren(root[0]);
    expect(ciscoChildren).toHaveLength(1);
    expect((ciscoChildren[0] as { name: string }).name).toBe("routers");

    const routersChildren = await provider.getChildren(ciscoChildren[0]);
    expect(routersChildren.map((c) => c.kind)).toEqual(["script"]);
    expect((routersChildren[0] as { name: string }).name).toBe("Backup");
  });

  it("shows an empty directory as a folder even when it holds no scripts", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [["cisco", 2], ["reports", 2]]);
    mockFsEntries.set("/workspace/.nexus/scripts/cisco", [["a.js", 1]]);
    mockFsEntries.set("/workspace/.nexus/scripts/reports", []); // empty — no scripts at all
    mockFiles.set("/workspace/.nexus/scripts/cisco/a.js", "/**\n * @nexus-script\n */\n");

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const root = await provider.getChildren();
    const folderNames = root.filter((c) => c.kind === "folder").map((c) => (c as { name: string }).name);
    expect(folderNames).toEqual(["cisco", "reports"]);

    const reportsNode = root.find((c) => c.kind === "folder" && (c as { name: string }).name === "reports")!;
    expect(await provider.getChildren(reportsNode)).toEqual([]);
  });

  // ---- §5.6 — placeholders only when the WHOLE tree is empty, root only --

  it("does NOT show placeholders when a marked script exists only inside a nested folder", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [["cisco", 2], ["empty", 2]]);
    mockFsEntries.set("/workspace/.nexus/scripts/cisco", [["a.js", 1]]);
    mockFsEntries.set("/workspace/.nexus/scripts/empty", []);
    mockFiles.set("/workspace/.nexus/scripts/cisco/a.js", "/**\n * @nexus-script\n * @name A\n */\n");

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const root = await provider.getChildren();
    expect(root.some((c) => c.kind === "placeholder")).toBe(false);
    expect(root.map((c) => c.kind)).toEqual(["folder", "folder"]);
  });

  it("shows placeholders at root when the tree contains folders but no MARKED scripts anywhere", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [["empty", 2]]);
    mockFsEntries.set("/workspace/.nexus/scripts/empty", []);

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const root = await provider.getChildren();
    expect(root.filter((c) => c.kind === "folder")).toHaveLength(1);
    expect(root.filter((c) => c.kind === "placeholder")).toHaveLength(3);
  });

  it("never shows placeholders for a subfolder, even when that subfolder itself is empty", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [["cisco", 2], ["empty", 2]]);
    mockFsEntries.set("/workspace/.nexus/scripts/cisco", [["a.js", 1]]);
    mockFsEntries.set("/workspace/.nexus/scripts/empty", []);
    mockFiles.set("/workspace/.nexus/scripts/cisco/a.js", "/**\n * @nexus-script\n * @name A\n */\n");

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const root = await provider.getChildren();
    const emptyNode = root.find((c) => c.kind === "folder" && (c as { name: string }).name === "empty")!;
    const children = await provider.getChildren(emptyNode);
    expect(children).toEqual([]); // NOT placeholders — root-only per §5.6
  });

  // ---- §5.3 — truncation node -------------------------------------------

  it("pins a truncation node first at root when the entry cap is hit, with a click action that opens the scripts-path setting", async () => {
    const entries: Array<[string, number]> = [];
    for (let i = 0; i < 501; i++) {
      entries.push([`d${i}`, 2]);
      mockFsEntries.set(`/workspace/.nexus/scripts/d${i}`, []);
    }
    mockFsEntries.set("/workspace/.nexus/scripts", entries);

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();
    expect(children[0].kind).toBe("truncated");
    const item = provider.getTreeItem(children[0]);
    expect(item.command?.command).toBe("workbench.action.openSettings");
    expect(item.command?.arguments).toEqual(["nexus.scripts.path"]);
    // Never matches either script-menu equality gate (§5.5's design note).
    expect(item.contextValue).not.toBe("nexus.script.file");
    expect(item.contextValue).not.toBe("nexus.script.running");
  });

  it("does not show the truncation node for a subfolder — it is root-only", async () => {
    const entries: Array<[string, number]> = [["cisco", 2]];
    for (let i = 0; i < 501; i++) {
      entries.push([`d${i}`, 2]);
      mockFsEntries.set(`/workspace/.nexus/scripts/d${i}`, []);
    }
    mockFsEntries.set("/workspace/.nexus/scripts", entries);
    mockFsEntries.set("/workspace/.nexus/scripts/cisco", []);

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const root = await provider.getChildren();
    expect(root[0].kind).toBe("truncated");
    const ciscoNode = root.find((c) => c.kind === "folder" && (c as { name: string }).name === "cisco")!;
    const nested = await provider.getChildren(ciscoNode);
    expect(nested.some((c) => c.kind === "truncated")).toBe(false);
  });

  // ---- §5.2 — watcher on "**/*", debounced --------------------------------

  it("rescans on a directory-level watcher event (rename/delete) — **/*.js could never fire for these", async () => {
    vi.useFakeTimers();
    try {
      mockFsEntries.set("/workspace/.nexus/scripts", [["cisco", 2]]);
      mockFsEntries.set("/workspace/.nexus/scripts/cisco", [["a.js", 1]]);
      mockFiles.set("/workspace/.nexus/scripts/cisco/a.js", "/**\n * @nexus-script\n */\n");

      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
      const before = await provider.getChildren();
      expect((before[0] as { name: string }).name).toBe("cisco");

      // Simulate renaming cisco/ -> juniper/ on disk.
      mockFsEntries.delete("/workspace/.nexus/scripts/cisco");
      mockFsEntries.set("/workspace/.nexus/scripts", [["juniper", 2]]);
      mockFsEntries.set("/workspace/.nexus/scripts/juniper", [["a.js", 1]]);
      mockFiles.set("/workspace/.nexus/scripts/juniper/a.js", "/**\n * @nexus-script\n */\n");

      expect(watcherHandlers.delete.length).toBeGreaterThan(0);
      // A DIRECTORY delete event — carries the directory's own path, which a
      // "**/*.js" watcher pattern structurally cannot match. fireWatcherEvent
      // emulates that glob restriction, so this only reaches the handler if
      // the provider actually watches "**/*".
      fireWatcherEvent("delete", "/workspace/.nexus/scripts/cisco");

      await vi.advanceTimersByTimeAsync(300);

      const after = await provider.getChildren();
      expect((after[0] as { name: string }).name).toBe("juniper");

      provider.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a burst of watcher events into a single rescan (~300ms debounce)", async () => {
    vi.useFakeTimers();
    try {
      mockFsEntries.set("/workspace/.nexus/scripts", []);
      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
      let fireCount = 0;
      const sub = provider.onDidChangeTreeData(() => {
        fireCount += 1;
      });

      fireWatcherEvent("create", "/workspace/.nexus/scripts/a.js");
      fireWatcherEvent("change", "/workspace/.nexus/scripts/a.js");
      fireWatcherEvent("create", "/workspace/.nexus/scripts/b.js");
      fireWatcherEvent("delete", "/workspace/.nexus/scripts/old");

      await vi.advanceTimersByTimeAsync(299);
      expect(fireCount).toBe(0); // still inside the debounce window

      await vi.advanceTimersByTimeAsync(1);
      expect(fireCount).toBe(1); // one rescan for the whole burst, not four

      sub.dispose();
      provider.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- §5.1 — scan generation counter -------------------------------------

  it("discards a stale scan result when a newer refresh started before it resolved, and getChildren awaits the CURRENT generation", async () => {
    type Resolver = (entries: Array<[string, number]>) => void;
    const pending: Resolver[] = [];
    (vscode.workspace.fs as unknown as { readDirectory: (u: unknown) => Promise<Array<[string, number]>> }).readDirectory = vi.fn(
      () => new Promise<Array<[string, number]>>((resolve) => { pending.push(resolve); })
    );
    mockFiles.set("/workspace/.nexus/scripts/old.js", "/**\n * @nexus-script\n * @name Old\n */\n");
    mockFiles.set("/workspace/.nexus/scripts/new.js", "/**\n * @nexus-script\n * @name New\n */\n");

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

    // Kick off getChildren() — it starts (and will await) the FIRST scan.
    const pendingChildren = provider.getChildren();

    // A second refresh starts a NEWER scan before the first one resolves —
    // e.g. the user changed nexus.scripts.path mid-flight (§5.1's race).
    provider.refresh();

    expect(pending.length).toBe(2);

    // Resolve the STALE (first) scan, then the current one — in that order,
    // regardless of which readDirectory call was issued first.
    pending[0]([["old.js", 1]]);
    pending[1]([["new.js", 1]]);

    const children = await pendingChildren;
    const names = children.filter((c) => c.kind === "script").map((c) => (c as { name: string }).name);
    expect(names).toEqual(["New"]); // NOT ["Old"] — the stale result must be discarded

    provider.dispose();
  });
});
