import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFsEntries = new Map<string, Array<[string, number]>>();
const mockFiles = new Map<string, string>();

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
    getConfiguration: vi.fn(() => ({ get: vi.fn((_k: string, d?: unknown) => d) })),
    createFileSystemWatcher: vi.fn(() => ({
      onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn()
    }))
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

  it("returns empty array when no workspace is open (lets viewsWelcome render the 'New Script' button)", async () => {
    (vscode.workspace as unknown as { workspaceFolders: unknown[] | undefined }).workspaceFolders = undefined;
    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();
    expect(children).toHaveLength(0);
  });

  it("returns empty array when the scripts directory is empty (lets viewsWelcome render)", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", []);
    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();
    expect(children).toHaveLength(0);
  });

  it("returns empty array on missing scripts directory (welcome view stays visible)", async () => {
    // Don't set mockFsEntries for /workspace/.nexus/scripts — readDirectory will throw ENOENT.
    (vscode.workspace.fs as unknown as { readDirectory: typeof vscode.workspace.fs.readDirectory }).readDirectory = vi.fn(
      async () => {
        throw new Error("ENOENT");
      }
    );
    const provider = new ScriptTreeProvider(mockManager(), "/tmp/fake-gs");
    const children = await provider.getChildren();
    expect(children).toHaveLength(0);
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
});
