import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => {
  const EventEmitter = vi.fn().mockImplementation(() => {
    const listeners: Array<(e: unknown) => void> = [];
    return {
      event: (listener: (e: unknown) => void) => { listeners.push(listener); },
      fire: (e: unknown) => { for (const l of listeners) { l(e); } },
      _listeners: listeners
    };
  });
  return {
    TreeItem: class {
      label?: string;
      id?: string;
      description?: string;
      contextValue?: string;
      command?: unknown;
      tooltip?: string;
      iconPath?: unknown;
      collapsibleState?: number;
      constructor(label: string, collapsibleState?: number) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(public id: string) {} },
    EventEmitter,
    workspace: {
      getConfiguration: vi.fn()
    }
  };
});

import { MacroTreeProvider, MacroTreeItem } from "../../src/ui/macroTreeProvider";
import * as vscode from "vscode";

describe("MacroTreeItem", () => {
  it("shows [Alt+N] labels for indices 0-9", () => {
    const macro = { name: "Hello", text: "echo hello" };
    // index 0 → Alt+1, index 1 → Alt+2, ..., index 8 → Alt+9, index 9 → Alt+0
    const item0 = new MacroTreeItem(macro, 0);
    expect(item0.label).toBe("[Alt+1] Hello");

    const item8 = new MacroTreeItem(macro, 8);
    expect(item8.label).toBe("[Alt+9] Hello");

    const item9 = new MacroTreeItem(macro, 9);
    expect(item9.label).toBe("[Alt+0] Hello");
  });

  it("shows [N] labels for indices 10+", () => {
    const macro = { name: "Test", text: "test" };
    const item10 = new MacroTreeItem(macro, 10);
    expect(item10.label).toBe("[11] Test");

    const item15 = new MacroTreeItem(macro, 15);
    expect(item15.label).toBe("[16] Test");
  });

  it("truncates description at ~40 chars and replaces newlines with ↵", () => {
    const shortMacro = { name: "Short", text: "echo hi" };
    const shortItem = new MacroTreeItem(shortMacro, 0);
    expect(shortItem.description).toBe("\u2192 echo hi");

    const longMacro = { name: "Long", text: "a".repeat(50) };
    const longItem = new MacroTreeItem(longMacro, 0);
    expect(longItem.description).toBe(`\u2192 ${"a".repeat(37)}...`);

    const newlineMacro = { name: "NL", text: "line1\nline2\nline3" };
    const nlItem = new MacroTreeItem(newlineMacro, 0);
    expect(nlItem.description).toBe("\u2192 line1\u21b5line2\u21b5line3");
  });

  it("sets contextValue to nexus.macro for all items", () => {
    const item = new MacroTreeItem({ name: "Test", text: "test" }, 0);
    expect(item.contextValue).toBe("nexus.macro");
  });

  it("wires click command to nexus.macro.slot with correct index", () => {
    const item = new MacroTreeItem({ name: "Test", text: "test" }, 5);
    expect(item.command).toEqual({
      command: "nexus.macro.slot",
      title: "Run Macro",
      arguments: [{ index: 5 }]
    });
  });
});

describe("MacroTreeProvider", () => {
  let provider: MacroTreeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new MacroTreeProvider();
  });

  it("returns empty array when no macros configured", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue([])
    } as unknown as vscode.WorkspaceConfiguration);

    const children = provider.getChildren();
    expect(children).toHaveLength(0);
  });

  it("returns MacroTreeItems for configured macros", () => {
    const macros = [
      { name: "Hello", text: "echo hello" },
      { name: "World", text: "echo world" }
    ];
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue(macros)
    } as unknown as vscode.WorkspaceConfiguration);

    const children = provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children[0]).toBeInstanceOf(MacroTreeItem);
    expect(children[0].label).toBe("[Alt+1] Hello");
    expect(children[1].label).toBe("[Alt+2] World");
  });

  it("fires onDidChangeTreeData when refresh() is called", () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.refresh();
    expect(listener).toHaveBeenCalledWith(undefined);
  });

  it("getTreeItem returns the element itself", () => {
    const item = new MacroTreeItem({ name: "Test", text: "test" }, 0);
    expect(provider.getTreeItem(item)).toBe(item);
  });
});
