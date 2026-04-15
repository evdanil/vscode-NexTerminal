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
    getRunForSession: vi.fn(),
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

    const provider = new ScriptTreeProvider(mockManager());
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = provider.getTreeItem(children[0]);
    expect(item.label).toBe("Hello");
  });

  it("falls back to filename when @name is absent", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", [["foo.js", 1]]);
    mockFiles.set("/workspace/.nexus/scripts/foo.js", "/**\n * @nexus-script\n */\n");

    const provider = new ScriptTreeProvider(mockManager());
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = provider.getTreeItem(children[0]);
    expect(item.label).toBe("foo");
  });

  it("renders the 'open a folder' message when no workspace is open", async () => {
    (vscode.workspace as unknown as { workspaceFolders: unknown[] | undefined }).workspaceFolders = undefined;
    const provider = new ScriptTreeProvider(mockManager());
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = provider.getTreeItem(children[0]);
    expect(String(item.label).toLowerCase()).toContain("open a folder");
  });

  it("renders the 'no scripts found' message when the directory is empty", async () => {
    mockFsEntries.set("/workspace/.nexus/scripts", []);
    const provider = new ScriptTreeProvider(mockManager());
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = provider.getTreeItem(children[0]);
    expect(String(item.label).toLowerCase()).toContain("no scripts");
  });

  it("treats a missing scripts directory as 'no scripts found' rather than an error", async () => {
    // Don't set mockFsEntries for /workspace/.nexus/scripts — readDirectory will throw ENOENT.
    (vscode.workspace.fs as unknown as { readDirectory: typeof vscode.workspace.fs.readDirectory }).readDirectory = vi.fn(
      async () => {
        throw new Error("ENOENT");
      }
    );
    const provider = new ScriptTreeProvider(mockManager());
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = provider.getTreeItem(children[0]);
    expect(String(item.label).toLowerCase()).toContain("no scripts");
  });
});
