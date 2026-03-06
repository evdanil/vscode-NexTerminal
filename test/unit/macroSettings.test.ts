import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMock = vi.fn();
let inspectValue: Record<string, unknown> | undefined;
let macrosValue: unknown[] = [];

vi.mock("vscode", () => ({
  ConfigurationTarget: {
    Global: "global",
    Workspace: "workspace",
    WorkspaceFolder: "workspaceFolder"
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, defaultValue?: unknown) => macrosValue ?? defaultValue),
      inspect: vi.fn(() => inspectValue),
      update: updateMock
    }))
  },
  window: {
    showWarningMessage: vi.fn()
  }
}));

import * as vscode from "vscode";
import {
  saveMacros
} from "../../src/macroSettings";
import {
  assignBinding,
  getAssignedBinding
} from "../../src/macroBindingHelpers";
import type { TerminalMacro } from "../../src/models/terminalMacro";

describe("macroSettings", () => {
  beforeEach(() => {
    inspectValue = undefined;
    macrosValue = [];
    updateMock.mockReset();
  });

  it("prefers normalized keybinding over legacy slot", () => {
    expect(getAssignedBinding({ keybinding: " Alt+Shift+5 ", slot: 2 })).toBe("alt+shift+5");
    expect(getAssignedBinding({ slot: 2 })).toBe("alt+2");
    expect(getAssignedBinding({})).toBeUndefined();
  });

  it("assignBinding clears conflicting keybindings and legacy slots", () => {
    const macros: TerminalMacro[] = [
      { name: "slotOwner", text: "a", slot: 2 },
      { name: "bindingOwner", text: "b", keybinding: "alt+3" },
      { name: "target", text: "c" }
    ];

    assignBinding(macros, 2, "alt+2");
    expect(macros[0].slot).toBeUndefined();
    expect(macros[2].keybinding).toBe("alt+2");

    assignBinding(macros, 2, "alt+3");
    expect(macros[1].keybinding).toBeUndefined();
    expect(macros[2].keybinding).toBe("alt+3");
  });

  it("saveMacros preserves workspace scope when macros are defined there", async () => {
    inspectValue = { workspaceValue: [{ name: "ws", text: "echo" }] };

    await saveMacros([{ name: "new", text: "echo" }]);

    expect(updateMock).toHaveBeenCalledWith("macros", [{ name: "new", text: "echo" }], vscode.ConfigurationTarget.Workspace);
  });

  it("saveMacros defaults to global scope when no narrower value exists", async () => {
    inspectValue = { globalValue: [{ name: "user", text: "echo" }] };

    await saveMacros([{ name: "new", text: "echo" }]);

    expect(updateMock).toHaveBeenCalledWith("macros", [{ name: "new", text: "echo" }], vscode.ConfigurationTarget.Global);
  });
});
