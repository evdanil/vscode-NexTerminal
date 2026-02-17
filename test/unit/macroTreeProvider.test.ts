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
  it("shows [Alt+N] label when displaySlot is provided", () => {
    const macro = { name: "Hello", text: "echo hello" };
    const item = new MacroTreeItem(macro, 0, 1);
    expect(item.label).toBe("[Alt+1] Hello");

    const item9 = new MacroTreeItem(macro, 8, 9);
    expect(item9.label).toBe("[Alt+9] Hello");

    const item0 = new MacroTreeItem(macro, 9, 0);
    expect(item0.label).toBe("[Alt+0] Hello");
  });

  it("shows plain name when displaySlot is undefined", () => {
    const macro = { name: "Hello", text: "echo hello" };
    const item = new MacroTreeItem(macro, 5);
    expect(item.label).toBe("Hello");
  });

  it("includes slot hint in tooltip when displaySlot is provided", () => {
    const macro = { name: "Test", text: "echo test" };
    const item = new MacroTreeItem(macro, 0, 3);
    expect(item.tooltip).toBe("Test (Alt+3)\necho test");
  });

  it("no slot hint in tooltip when displaySlot is undefined", () => {
    const macro = { name: "Test", text: "echo test" };
    const item = new MacroTreeItem(macro, 0);
    expect(item.tooltip).toBe("Test\necho test");
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

  it("wires click command to nexus.macro.runItem", () => {
    const item = new MacroTreeItem({ name: "Test", text: "test" }, 5, 6);
    expect(item.command).toEqual({
      command: "nexus.macro.runItem",
      title: "Run Macro",
      arguments: [item]
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

  it("legacy mode: positional Alt+N labels when no macros have slot", () => {
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

  it("explicit mode: only macros with slot show Alt+N labels", () => {
    const macros = [
      { name: "Hello", text: "echo hello", slot: 5 },
      { name: "World", text: "echo world" }
    ];
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue(macros)
    } as unknown as vscode.WorkspaceConfiguration);

    const children = provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children[0].label).toBe("[Alt+5] Hello");
    expect(children[1].label).toBe("World");
  });

  it("mixed: once any macro has a slot, unassigned ones show no prefix", () => {
    const macros = [
      { name: "A", text: "a" },
      { name: "B", text: "b", slot: 3 },
      { name: "C", text: "c" }
    ];
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue(macros)
    } as unknown as vscode.WorkspaceConfiguration);

    const children = provider.getChildren();
    expect(children[0].label).toBe("A");
    expect(children[1].label).toBe("[Alt+3] B");
    expect(children[2].label).toBe("C");
  });

  it("legacy mode: index 9 gets Alt+0", () => {
    const macros = Array.from({ length: 10 }, (_, i) => ({ name: `M${i}`, text: `t${i}` }));
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue(macros)
    } as unknown as vscode.WorkspaceConfiguration);

    const children = provider.getChildren();
    expect(children[0].label).toBe("[Alt+1] M0");
    expect(children[8].label).toBe("[Alt+9] M8");
    expect(children[9].label).toBe("[Alt+0] M9");
  });

  it("legacy mode: index 10+ gets no prefix", () => {
    const macros = Array.from({ length: 12 }, (_, i) => ({ name: `M${i}`, text: `t${i}` }));
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue(macros)
    } as unknown as vscode.WorkspaceConfiguration);

    const children = provider.getChildren();
    expect(children[10].label).toBe("M10");
    expect(children[11].label).toBe("M11");
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
