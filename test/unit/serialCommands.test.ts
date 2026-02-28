import { describe, expect, it, vi } from "vitest";
import { formValuesToSerial } from "../../src/commands/serialCommands";

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn(),
    executeCommand: vi.fn()
  },
  window: {
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn()
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(() => true)
    }))
  },
  env: {
    clipboard: {
      writeText: vi.fn()
    }
  },
  TerminalLocation: { Editor: 2, Panel: 1 },
  TreeItem: class {
    public id?: string;
    public tooltip?: string;
    public description?: string;
    public contextValue?: string;
    public iconPath?: unknown;
    public constructor(
      public readonly label: string,
      public readonly collapsibleState?: number
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    public constructor(
      public readonly id: string,
      public readonly color?: unknown
    ) {}
  },
  ThemeColor: class {
    public constructor(public readonly id: string) {}
  }
}));

describe("formValuesToSerial", () => {
  it("normalizes valid group values", () => {
    const serial = formValuesToSerial({
      name: "USB Console",
      path: "COM3",
      group: "  Lab / Rack  "
    });
    expect(serial).toBeDefined();
    expect(serial!.group).toBe("Lab/Rack");
  });

  it("rejects invalid non-empty group values", () => {
    const serial = formValuesToSerial({
      name: "USB Console",
      path: "COM3",
      group: "/"
    });
    expect(serial).toBeUndefined();
  });
});
