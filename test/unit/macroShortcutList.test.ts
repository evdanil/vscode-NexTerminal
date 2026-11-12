import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalMacro } from "../../src/models/terminalMacro";

const fixture = vi.hoisted(() => ({ macros: [] as TerminalMacro[], setContext: new Map<string, unknown>() }));

vi.mock("vscode", () => ({
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: vi.fn(async (command: string, key: string, value: unknown) => {
      if (command === "setContext") fixture.setContext.set(key, value);
    })
  },
  window: {}
}));
vi.mock("../../src/macroSettings", () => ({ getMacros: () => fixture.macros }));
vi.mock("../../src/ui/macroEditorPanel", () => ({ MacroEditorPanel: {} }));

import { getBoundMacroShortcuts, onDidChangeMacroShortcuts, updateMacroContext } from "../../src/commands/macroCommands";

describe("macro shortcut list for the Serial Send Box", () => {
  beforeEach(() => { fixture.macros = []; });

  it("lists exactly the combos whose nexus.macro context keys are set, plus the Alt+S picker, with no macro text", () => {
    fixture.macros = [
      { name: "Backup", text: "secret-text", keybinding: "Alt+Shift+B" },
      { name: "Legacy", text: "x", slot: 3 },
      { name: "Unbound", text: "y" },
      { name: "Invalid", text: "z", keybinding: "ctrl+alt+q" }
    ];
    updateMacroContext();
    expect(fixture.setContext.get("nexus.macro.altShift.b")).toBe(true);
    expect(fixture.setContext.get("nexus.macro.alt.3")).toBe(true);
    expect(getBoundMacroShortcuts()).toEqual(["alt+3", "alt+s", "alt+shift+b"]);
    expect(JSON.stringify(getBoundMacroShortcuts())).not.toMatch(/Backup|secret-text/);
  });

  it("notifies listeners when the bound set changes, and not otherwise", () => {
    fixture.macros = [{ name: "One", text: "1", keybinding: "alt+1" }];
    updateMacroContext();
    const listener = vi.fn();
    const subscription = onDidChangeMacroShortcuts(listener);
    updateMacroContext();
    expect(listener).not.toHaveBeenCalled();
    fixture.macros = [{ name: "One", text: "1", keybinding: "alt+2" }];
    updateMacroContext();
    expect(listener).toHaveBeenCalledOnce();
    expect(getBoundMacroShortcuts()).toEqual(["alt+2", "alt+s"]);
    subscription.dispose();
    fixture.macros = [];
    updateMacroContext();
    expect(listener).toHaveBeenCalledOnce();
  });
});
