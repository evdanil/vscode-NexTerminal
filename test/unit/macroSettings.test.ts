import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  ConfigurationTarget: {
    Global: "global",
    Workspace: "workspace",
    WorkspaceFolder: "workspaceFolder"
  },
  workspace: {
    getConfiguration: vi.fn()
  },
  window: {
    showWarningMessage: vi.fn()
  }
}));

import {
  saveMacros,
  getMacros,
  setActiveMacroStore
} from "../../src/macroSettings";
import {
  assignBinding,
  getAssignedBinding
} from "../../src/macroBindingHelpers";
import type { TerminalMacro } from "../../src/models/terminalMacro";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";

describe("macroSettings", () => {
  beforeEach(async () => {
    const store = new InMemoryMacroStore();
    await store.initialize();
    setActiveMacroStore(store);
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

  it("saveMacros persists through MacroStore and getMacros retrieves them", async () => {
    await saveMacros([{ name: "new", text: "echo" }]);
    const result = getMacros();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("new");
    expect(result[0].text).toBe("echo");
  });

  it("saveMacros with secret macro — secret text is preserved via store", async () => {
    await saveMacros([{ name: "pwd", text: "classified", secret: true }]);
    const result = getMacros();
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("classified");
    expect(result[0].secret).toBe(true);
  });
});
