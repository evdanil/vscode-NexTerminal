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

// Every rename that reached `workspace.applyEdit`, oldest first — the drag-and-
// drop tests assert on this rather than on the tree, because "nothing moved" and
// "moved somewhere the next scan hides" look identical from the tree alone.
const appliedRenames: Array<{ from: string; to: string; toScheme: string }> = [];

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
  // Real vscode.FileType values — SymbolicLink included, because a symlinked
  // directory reports `Directory | SymbolicLink` (2 | 64 = 66) and the scanner
  // separates the two bits.
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: {
    file: (p: string) => ({
      fsPath: p,
      scheme: "file",
      path: p,
      toString: () => p
    }),
    // Normalizes "." / ".." and PRESERVES scheme + authority, because
    // `handleDrop` derives a script's parent folder with `joinPath(uri, "..")`
    // and the whole point of that call is that a `vscode-remote` row does not
    // come back as a `file:` URI. A mock that always answered "file" could not
    // tell the fix from the bug.
    joinPath: (base: { path: string; scheme?: string; authority?: string }, ...parts: string[]) => {
      const segments: string[] = [];
      for (const raw of [base.path, ...parts]) {
        for (const seg of raw.split("/")) {
          if (seg === "" || seg === ".") continue;
          if (seg === "..") {
            segments.pop();
            continue;
          }
          segments.push(seg);
        }
      }
      const joined = `/${segments.join("/")}`;
      const scheme = base.scheme ?? "file";
      const authority = base.authority ?? "";
      return {
        fsPath: joined,
        scheme,
        authority,
        path: joined,
        toString: () => (scheme === "file" ? joined : `${scheme}://${authority}${joined}`)
      };
    }
  },
  DataTransferItem: class MockDataTransferItem {
    public constructor(public readonly value: string) {}
    public async asString(): Promise<string> {
      return this.value;
    }
  },
  WorkspaceEdit: class MockWorkspaceEdit {
    public pending: Array<{ from: string; to: string; toScheme: string }> = [];
    public renameFile(
      from: { fsPath: string },
      to: { fsPath: string; scheme?: string }
    ): void {
      this.pending.push({ from: from.fsPath, to: to.fsPath, toScheme: to.scheme ?? "file" });
    }
  },
  window: {
    showWarningMessage: vi.fn(async () => undefined)
  },
  workspace: {
    workspaceFolders: [],
    fs: {
      readDirectory: vi.fn(async (uri: { fsPath: string }) => mockFsEntries.get(uri.fsPath) ?? []),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const content = mockFiles.get(uri.fsPath);
        if (content === undefined) throw new Error(`ENOENT: ${uri.fsPath}`);
        return new TextEncoder().encode(content);
      }),
      // Drag-and-drop only: the destination-exists check in `moveScriptIntoFolder`.
      stat: vi.fn(async (uri: { fsPath: string }) => {
        if (!mockFiles.has(uri.fsPath)) throw new Error(`ENOENT: ${uri.fsPath}`);
        return { type: 1, ctime: 0, mtime: 0, size: 1 };
      })
    },
    applyEdit: vi.fn(async (edit: { pending: Array<{ from: string; to: string; toScheme: string }> }) => {
      for (const op of edit.pending) {
        appliedRenames.push(op);
        const content = mockFiles.get(op.from);
        if (content !== undefined) {
          mockFiles.delete(op.from);
          mockFiles.set(op.to, content);
        }
      }
      return true;
    }),
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
import { ScriptTreeProvider, type ScriptNode } from "../../../src/ui/scriptTreeProvider";
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
    appliedRenames.length = 0;
    vi.mocked(vscode.window.showWarningMessage).mockClear();
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
    // …and readFile, for the same reason. Without this, the Fix 5 test's stub
    // (which pins ONE path to a promise it controls and rejects for anything it
    // has no content for) stayed installed for every test after it: a later test
    // seeding that same path got the earlier test's content instead of its own,
    // and which tests those are depends purely on declaration order.
    (vscode.workspace.fs as unknown as { readFile: (u: { fsPath: string }) => Promise<Uint8Array> }).readFile = vi.fn(
      async (uri: { fsPath: string }) => {
        const content = mockFiles.get(uri.fsPath);
        if (content === undefined) throw new Error(`ENOENT: ${uri.fsPath}`);
        return new TextEncoder().encode(content);
      }
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

  it("marks a symlinked folder as linked and says the watcher will not notice changes in it", async () => {
    // The scan follows symlinked directories; the file-system watcher does not
    // follow links nested under the folder it watches, and VS Code offers no way
    // to make it (see the argument at ScriptTreeProvider.ensureWatcher). So the
    // row itself carries the limitation and names the remedy that does work —
    // Refresh. Left unsaid, this folder's listing can go stale indefinitely with
    // nothing on screen suggesting why.
    mockFsEntries.set("/workspace/.nexus/scripts", [["shared", 2 | 64], ["local", 2]]);
    mockFsEntries.set("/workspace/.nexus/scripts/shared", []);
    mockFsEntries.set("/workspace/.nexus/scripts/local", []);
    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

    const children = await provider.getChildren();
    const items = children.map((c) => provider.getTreeItem(c) as { label: string; tooltip?: string; iconPath?: { id: string } });
    const linked = items.find((i) => i.label === "shared")!;
    const plain = items.find((i) => i.label === "local")!;

    expect(linked.iconPath?.id).toBe("file-symlink-directory");
    expect(String(linked.tooltip)).toContain("not detected automatically");
    expect(String(linked.tooltip)).toContain("Refresh");
    // The ordinary folder is untouched — no icon churn, no scary tooltip.
    expect(plain.iconPath?.id).toBe("folder");
    expect(String(plain.tooltip)).toBe("local");
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

  it("Fix 5 — a refresh landing while hasMarkedScriptBelowRoot() is still reading an OLD generation's script must not poison the NEW generation's cache", async () => {
    // Directory A: nothing at root, a marked script nested in "cisco" — this
    // forces getChildren(root) to fall through to hasMarkedScriptBelowRoot(),
    // which reads that nested script's content.
    mockFsEntries.set("/workspace/.nexus/scripts", [["cisco", 2]]);
    mockFsEntries.set("/workspace/.nexus/scripts/cisco", [["a.js", 1]]);

    let signalReached: () => void = () => {};
    const reachedBlockingPoint = new Promise<void>((resolve) => { signalReached = resolve; });
    let resolveNestedRead: (bytes: Uint8Array) => void = () => {};
    const nestedReadPromise = new Promise<Uint8Array>((resolve) => { resolveNestedRead = resolve; });

    const NESTED_PATH = "/workspace/.nexus/scripts/cisco/a.js";
    (vscode.workspace.fs as unknown as { readFile: typeof vscode.workspace.fs.readFile }).readFile = vi.fn(
      (uri: { fsPath: string }) => {
        if (uri.fsPath === NESTED_PATH) {
          signalReached();
          return nestedReadPromise as unknown as Promise<Uint8Array>;
        }
        const content = mockFiles.get(uri.fsPath);
        if (content === undefined) return Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
        return Promise.resolve(new TextEncoder().encode(content));
      }
    ) as unknown as typeof vscode.workspace.fs.readFile;

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

    // Generation 1: getChildren(root) starts, scans dir A (fast, unblocked),
    // finds no root scripts, and falls into hasMarkedScriptBelowRoot() —
    // which blocks reading cisco/a.js. We wait for that exact blocking point
    // (rather than a fixed number of microtask ticks) so the sequencing
    // below is deterministic.
    const gen1Children = provider.getChildren();
    await reachedBlockingPoint;

    // The user points nexus.scripts.path at a DIFFERENT, empty directory —
    // e.g. the exact trigger from the review. A NEW generation's scan starts
    // and completes without ever touching the still-blocked read above.
    mockScriptsPath = "/workspace/.nexus/other";
    mockFsEntries.set("/workspace/.nexus/other", []);
    for (const listener of configChangeListeners) {
      listener({ affectsConfiguration: (section: string) => section === "nexus.scripts.path" });
    }
    const gen2Children = await provider.getChildren();
    expect(gen2Children.filter((c) => c.kind === "placeholder")).toHaveLength(3); // dir B is genuinely empty

    // NOW let generation 1's blocked read resolve — its own
    // hasMarkedScriptBelowRoot() call finishes AFTER the generation bump.
    resolveNestedRead(new TextEncoder().encode("/**\n * @nexus-script\n * @name A\n */\n"));
    await gen1Children;

    // A THIRD call, still generation 2 (dir B, still genuinely empty). Before
    // Fix 5, generation 1's late-resolving hasMarkedScriptBelowRoot() call
    // stamped `{ generation: this.generation (already bumped to 2), result:
    // true (found in dir A's content) }` into the cache — CLOBBERING the
    // correct entry gen2Children's own call had already written — so this
    // call would wrongly suppress the onboarding placeholders for a
    // directory that has nothing in it at all.
    const gen2Again = await provider.getChildren();
    expect(gen2Again.filter((c) => c.kind === "placeholder")).toHaveLength(3);

    provider.dispose();
  });

  // ---- §5.3 — depth-cap truncation is announced too (Fix 6) --------------

  it("Fix 6 — pins a depth-truncation warning node at root when a folder beyond the depth cap is found, distinct from the entry-cap node", async () => {
    // A straight-line chain d1/.../d11 — one level past the 10-level depth
    // cap — with a marked script sitting inside the un-descended d11.
    // Before Fix 6, this script vanished from the tree with NO warning node
    // anywhere: the scan neither descended into d11 nor set any truncation
    // flag at all.
    let currentPath = "/workspace/.nexus/scripts";
    for (let i = 1; i <= 11; i++) {
      mockFsEntries.set(currentPath, [[`d${i}`, 2]]);
      currentPath = `${currentPath}/d${i}`;
    }
    mockFsEntries.set(currentPath, [["toodeep.js", 1]]);
    mockFiles.set(`${currentPath}/toodeep.js`, "/**\n * @nexus-script\n */\n");

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();

    const node = children.find((c) => c.kind === "depthTruncated");
    expect(node).toBeDefined();
    const item = provider.getTreeItem(node!);
    expect(item.command?.command).toBe("workbench.action.openSettings");
    expect(item.command?.arguments).toEqual(["nexus.scripts.path"]);
    // Never matches either script-menu equality gate, same as the entry-cap node.
    expect(item.contextValue).not.toBe("nexus.script.file");
    expect(item.contextValue).not.toBe("nexus.script.running");
    // And it must not be the SAME node/message as the entry-count truncation.
    expect(children.some((c) => c.kind === "truncated")).toBe(false);
  });

  it("does not show the depth-truncation node when nothing exceeded the depth cap", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [["cisco", 2]]);
    mockFsEntries.set("/workspace/.nexus/scripts/cisco", [["a.js", 1]]);
    mockFiles.set("/workspace/.nexus/scripts/cisco/a.js", "/**\n * @nexus-script\n */\n");

    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();

    expect(children.some((c) => c.kind === "depthTruncated")).toBe(false);
  });

  // ---- Starved render: the retry budget must never render a stale tree -----
  //
  // Both retry budgets (MAX_SCAN_RETRIES / MAX_CHILDREN_RESTARTS) exist to
  // stop an unbounded wait when refreshes land faster than scans complete.
  // Exhausting them used to RETURN THE SUPERSEDED SCAN — after a
  // `nexus.scripts.path` change, a listing of a directory nobody watches any
  // more, presented as the truth. This is deterministic, not timing-based:
  // `readDirectory` is gated on a resolver the test owns, and `refresh()` is
  // synchronous, so the generation always moves BEFORE the resumed
  // continuation observes it — every scan is superseded the instant it lands.
  describe("starved render", () => {
    /** Replaces readDirectory with a gate the test releases one call at a time. */
    function gateReadDirectory(): Array<() => void> {
      const waiters: Array<() => void> = [];
      (vscode.workspace.fs as unknown as { readDirectory: (u: { fsPath: string }) => Promise<Array<[string, number]>> }).readDirectory =
        vi.fn(async (uri: { fsPath: string }) => {
          // Registered synchronously: `scanScriptsDir` -> `walk` -> here all
          // run synchronously up to this await, so by the time `refresh()`
          // returns, the new scan's waiter already exists.
          await new Promise<void>((resolve) => { waiters.push(resolve); });
          return mockFsEntries.get(uri.fsPath) ?? [];
        });
      return waiters;
    }

    /** Drains every pending microtask (a 0ms timer runs strictly after them). */
    const flush = (): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    function seedStaleListing(): void {
      // A FILE, not a folder, so each scan is exactly one gated readDirectory
      // and the waiter index below stays 1:1 with the scan generation.
      mockFsEntries.set("/workspace/.nexus/scripts", [["stale.js", 1]]);
      mockFiles.set(
        "/workspace/.nexus/scripts/stale.js",
        "/**\n * @nexus-script\n * @name Stale Listing\n */\n"
      );
    }

    it("returns the scanning node instead of a superseded directory listing when the retry budget runs out", async () => {
      seedStaleListing();
      const waiters = gateReadDirectory();
      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

      let result: Awaited<ReturnType<typeof provider.getChildren>> | undefined;
      void provider.getChildren().then((c) => { result = c; });
      await flush(); // generation 1's scan is now parked on waiters[0]

      let iterations = 0;
      for (let i = 0; result === undefined && i < 100; i++) {
        // Let the awaited scan finish, then supersede it in the same
        // synchronous turn — its continuation cannot run until the microtask
        // queue drains, by which point `this.generation` has already moved.
        waiters[i]?.();
        provider.refresh();
        await flush();
        iterations = i + 1;
      }

      expect(iterations).toBeLessThan(100); // it terminated rather than hanging
      // The whole point: NOT [{ kind: "script", name: "Stale Listing" }].
      expect(result?.map((n) => n.kind)).toEqual(["scanning"]);

      provider.dispose();
    });

    it("repaints itself once the storm stops — the scanning node is not a dead end", async () => {
      seedStaleListing();
      const waiters = gateReadDirectory();
      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

      const repaints: number[] = [];
      provider.onDidChangeTreeData(() => repaints.push(Date.now()));

      let result: Awaited<ReturnType<typeof provider.getChildren>> | undefined;
      void provider.getChildren().then((c) => { result = c; });
      await flush();
      for (let i = 0; result === undefined && i < 100; i++) {
        waiters[i]?.();
        provider.refresh();
        await flush();
      }
      expect(result?.map((n) => n.kind)).toEqual(["scanning"]);

      // A repaint is scheduled without any user action. Confirm the view was
      // told to re-ask (refresh() fires the same event, so count only what
      // arrives after the storm ends).
      //
      // POLL, rather than sleep a fixed 400ms and assert once. The repaint runs
      // on a REAL 300ms timer, so a fixed deadline 100ms past it fails whenever
      // this worker is stalled longer than that — which a full-suite run on a
      // loaded machine does routinely, and which has nothing to do with what is
      // under test. The assertion itself is unchanged and just as strict: a
      // repaint MUST arrive with no user action. Only the patience is.
      const before = repaints.length;
      const deadline = Date.now() + 5000;
      while (repaints.length === before && Date.now() < deadline) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
      }
      expect(repaints.length).toBeGreaterThan(before);

      // ...and re-asking now that generations have settled yields the real
      // tree, so the node is transient rather than sticky.
      for (const w of waiters.splice(0)) w();
      const settled = await provider.getChildren();
      expect(settled.filter((c) => c.kind === "script").map((c) => (c as { name: string }).name)).toEqual([
        "Stale Listing"
      ]);

      provider.dispose();
    });

    it("renders the scanning node as a distinct, menu-safe row with a refresh action", async () => {
      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

      const item = provider.getTreeItem({ kind: "scanning" });

      expect(item.label).toBe("Scanning scripts…");
      expect(item.command?.command).toBe("nexus.script.refresh");
      // Outside both script-menu equality gates (package.json uses `==`).
      expect(item.contextValue).not.toBe("nexus.script.file");
      expect(item.contextValue).not.toBe("nexus.script.running");
      // No fixed id: a storm starves every expanded folder at once, and a
      // duplicate TreeItem id makes VS Code reject the whole render.
      expect(item.id).toBeUndefined();

      provider.dispose();
    });
  });

  describe("drag and drop (§5.9)", () => {
    const SCRIPT_MIME = "application/vnd.nexus.script";
    const ROOT = "/workspace/.nexus/scripts";

    /** The two methods of `vscode.DataTransfer` this feature touches. */
    class FakeDataTransfer {
      private readonly items = new Map<string, { asString(): Promise<string> }>();
      public set(mime: string, item: { asString(): Promise<string> }): void {
        this.items.set(mime, item);
      }
      public get(mime: string): { asString(): Promise<string> } | undefined {
        return this.items.get(mime);
      }
    }

    function scriptNode(fsPath: string, name = "Probe"): ScriptNode {
      return {
        kind: "script",
        uri: vscode.Uri.file(fsPath),
        name,
        description: "",
        running: false,
        parseErrors: []
      };
    }

    function folderNode(relPath: string): ScriptNode {
      return {
        kind: "folder",
        uri: vscode.Uri.file(`${ROOT}/${relPath}`),
        path: relPath,
        name: relPath,
        linked: false
      };
    }

    /** Runs a whole gesture and hands back the transfer, so tests can inspect the wire. */
    async function drag(
      provider: ScriptTreeProvider,
      source: ScriptNode
    ): Promise<FakeDataTransfer> {
      const transfer = new FakeDataTransfer();
      await provider.handleDrag([source], transfer as unknown as vscode.DataTransfer);
      return transfer;
    }

    it("puts a lookup token on the wire and NOTHING about the file", async () => {
      // The drop ends in `applyEdit(renameFile)`. A payload naming a path would
      // be an instruction to move that path, available to any producer that can
      // write this MIME — so the wire carries a key to a host-side record and
      // the record never leaves the process.
      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

      const transfer = await drag(provider, scriptNode(`${ROOT}/probe.js`));
      const payload = await transfer.get(SCRIPT_MIME)!.asString();

      expect(payload).not.toContain("probe.js");
      expect(payload).not.toContain(ROOT);
      expect(payload).not.toContain("/");

      provider.dispose();
    });

    it("a token this view never minted moves nothing at all", async () => {
      mockFiles.set(`${ROOT}/probe.js`, "/**\n * @nexus-script\n */\n");
      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
      // A real drag happened, so there IS a capture to hijack — the forged
      // payload is refused because it names a different token, not because the
      // view happens to be holding nothing.
      await drag(provider, scriptNode(`${ROOT}/probe.js`));

      const forged = new FakeDataTransfer();
      forged.set(SCRIPT_MIME, { asString: async () => "script-drag-9999" });
      await provider.handleDrop(folderNode("cisco"), forged as unknown as vscode.DataTransfer);

      expect(appliedRenames).toEqual([]);

      provider.dispose();
    });

    it("moves the script into the folder it was dropped on", async () => {
      mockFiles.set(`${ROOT}/probe.js`, "/**\n * @nexus-script\n */\n");
      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

      const transfer = await drag(provider, scriptNode(`${ROOT}/probe.js`));
      await provider.handleDrop(folderNode("cisco"), transfer as unknown as vscode.DataTransfer);

      expect(appliedRenames).toEqual([{ from: `${ROOT}/probe.js`, to: `${ROOT}/cisco/probe.js`, toScheme: "file" }]);
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();

      provider.dispose();
    });

    it("dropping onto another SCRIPT targets that script's folder, not the script", async () => {
      mockFiles.set(`${ROOT}/probe.js`, "/**\n * @nexus-script\n */\n");
      mockFiles.set(`${ROOT}/cisco/neighbour.js`, "/**\n * @nexus-script\n */\n");
      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

      const transfer = await drag(provider, scriptNode(`${ROOT}/probe.js`));
      await provider.handleDrop(
        scriptNode(`${ROOT}/cisco/neighbour.js`, "Neighbour"),
        transfer as unknown as vscode.DataTransfer
      );

      expect(appliedRenames).toEqual([{ from: `${ROOT}/probe.js`, to: `${ROOT}/cisco/probe.js`, toScheme: "file" }]);

      provider.dispose();
    });

    it("dropping on empty space moves the script back to the root", async () => {
      mockFiles.set(`${ROOT}/cisco/probe.js`, "/**\n * @nexus-script\n */\n");
      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

      const transfer = await drag(provider, scriptNode(`${ROOT}/cisco/probe.js`));
      await provider.handleDrop(undefined, transfer as unknown as vscode.DataTransfer);

      expect(appliedRenames).toEqual([{ from: `${ROOT}/cisco/probe.js`, to: `${ROOT}/probe.js`, toScheme: "file" }]);

      provider.dispose();
    });

    it("a banner row is a root drop, not a dead spot", async () => {
      // The truncation / depth-truncation / scanning rows all render AT the
      // root and are all under the pointer at the top of the list. Treating
      // only `undefined` as root would make releasing over one of them do
      // nothing and say nothing — the failure this whole feature answers.
      mockFiles.set(`${ROOT}/cisco/probe.js`, "/**\n * @nexus-script\n */\n");
      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

      const transfer = await drag(provider, scriptNode(`${ROOT}/cisco/probe.js`));
      await provider.handleDrop(
        { kind: "truncated", examined: 500 },
        transfer as unknown as vscode.DataTransfer
      );

      expect(appliedRenames).toEqual([{ from: `${ROOT}/cisco/probe.js`, to: `${ROOT}/probe.js`, toScheme: "file" }]);

      provider.dispose();
    });

    it("the same token cannot be replayed for a second move", async () => {
      // The capture is cleared by the drop it belongs to. Without that, a
      // payload kept from an earlier gesture would move the script again —
      // against a tree that has since changed underneath it.
      mockFiles.set(`${ROOT}/probe.js`, "/**\n * @nexus-script\n */\n");
      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

      const transfer = await drag(provider, scriptNode(`${ROOT}/probe.js`));
      await provider.handleDrop(folderNode("cisco"), transfer as unknown as vscode.DataTransfer);
      await provider.handleDrop(folderNode("juniper"), transfer as unknown as vscode.DataTransfer);

      expect(appliedRenames).toEqual([{ from: `${ROOT}/probe.js`, to: `${ROOT}/cisco/probe.js`, toScheme: "file" }]);

      provider.dispose();
    });

    it("refuses a running script and says so, rather than moving it quietly", async () => {
      mockFiles.set(`${ROOT}/probe.js`, "/**\n * @nexus-script\n */\n");
      const manager = mockManager();
      vi.mocked(manager.getRuns).mockReturnValue([
        { scriptPath: `${ROOT}/probe.js` } as unknown as ReturnType<ScriptRuntimeManager["getRuns"]>[number]
      ]);
      const provider = new ScriptTreeProvider(manager, "/tmp/fake-gs");

      const transfer = await drag(provider, scriptNode(`${ROOT}/probe.js`));
      await provider.handleDrop(folderNode("cisco"), transfer as unknown as vscode.DataTransfer);

      expect(appliedRenames).toEqual([]);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("it is running")
      );

      provider.dispose();
    });

    it("keeps the workspace's scheme when the drop target is another script", async () => {
      // Remote-SSH / Codespaces with the default RELATIVE scripts path: every
      // scanned node carries the workspace's scheme. Deriving the target folder
      // as `Uri.file(dirname(uri.fsPath))` hands `renameFile` a remote source
      // and a LOCAL destination, so this one drop shape fails with the generic
      // "Could not move" while folder and root drops work. `joinPath(uri, "..")`
      // preserves scheme and authority.
      const remote = (p: string): vscode.Uri =>
        ({
          fsPath: p,
          scheme: "vscode-remote",
          authority: "ssh-remote+box",
          path: p,
          toString: () => `vscode-remote://ssh-remote+box${p}`
        }) as unknown as vscode.Uri;

      (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
        { uri: remote("/home/u"), name: "remote", index: 0 }
      ];
      const REMOTE_ROOT = "/home/u/.nexus/scripts";
      mockFiles.set(`${REMOTE_ROOT}/probe.js`, "/**\n * @nexus-script\n */\n");
      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

      const transfer = new FakeDataTransfer();
      await provider.handleDrag(
        [{ ...scriptNode(""), uri: remote(`${REMOTE_ROOT}/probe.js`) }],
        transfer as unknown as vscode.DataTransfer
      );
      await provider.handleDrop(
        { ...scriptNode(""), uri: remote(`${REMOTE_ROOT}/cisco/neighbour.js`) },
        transfer as unknown as vscode.DataTransfer
      );

      expect(appliedRenames).toEqual([
        {
          from: `${REMOTE_ROOT}/probe.js`,
          to: `${REMOTE_ROOT}/cisco/probe.js`,
          toScheme: "vscode-remote"
        }
      ]);
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();

      provider.dispose();
    });

    it("does not start a drag for a folder row", async () => {
      const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");

      const transfer = await drag(provider, folderNode("cisco"));

      expect(transfer.get(SCRIPT_MIME)).toBeUndefined();

      provider.dispose();
    });
  });
});
