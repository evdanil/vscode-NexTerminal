import * as vscode from "vscode";
import type { MacroTreeItem, MacroTreeProvider, TerminalMacro } from "../ui/macroTreeProvider";
import { MacroEditorPanel } from "../ui/macroEditorPanel";
import {
  ALL_BINDINGS,
  bindingToContextKey,
  bindingToDisplayLabel,
  isValidBinding,
  slotToBinding,
  CRITICAL_CTRL_SHIFT_KEYS,
  SPECIAL_BINDING_WARNINGS
} from "../macroBindings";

function getMacros(): TerminalMacro[] {
  return vscode.workspace.getConfiguration("nexus.terminal").get<TerminalMacro[]>("macros", []);
}

async function saveMacros(macros: TerminalMacro[]): Promise<void> {
  await vscode.workspace
    .getConfiguration("nexus.terminal")
    .update("macros", macros, vscode.ConfigurationTarget.Global);
}

function sendMacroText(text: string): void {
  void vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text });
}

function updateBindingContextKeys(): void {
  const macros = getMacros();
  const assignedBindings = new Set(
    macros.map((m) => m.keybinding?.toLowerCase()).filter((b): b is string => b !== undefined)
  );
  for (const binding of ALL_BINDINGS) {
    void vscode.commands.executeCommand("setContext", bindingToContextKey(binding), assignedBindings.has(binding));
  }
}

export function updateMacroContext(): void {
  const macros = getMacros();
  void vscode.commands.executeCommand("setContext", "nexus.hasMacros", macros.length > 0);
  updateBindingContextKeys();
}

/** Migrate old slot-based macros to keybinding-based. */
export async function migrateMacroSlots(): Promise<void> {
  const macros = getMacros();
  let changed = false;
  for (const macro of macros) {
    if (macro.slot !== undefined && !macro.keybinding) {
      macro.keybinding = slotToBinding(macro.slot);
      delete macro.slot;
      changed = true;
    }
  }
  if (changed) {
    await saveMacros(macros);
  }
}

function assignBinding(macros: TerminalMacro[], targetIndex: number, binding: string | null): void {
  if (binding !== null) {
    const normalized = binding.toLowerCase();
    // Clear conflicting binding
    for (const m of macros) {
      if (m.keybinding?.toLowerCase() === normalized) {
        delete m.keybinding;
      }
    }
    macros[targetIndex].keybinding = normalized;
    // Clear legacy slot if present
    delete macros[targetIndex].slot;
  } else {
    delete macros[targetIndex].keybinding;
  }
}

async function promptForBinding(
  macros: TerminalMacro[],
  excludeIndex?: number,
  currentBinding?: string
): Promise<string | null | undefined> {
  // Returns: string = chosen binding, null = "None" selected, undefined = cancelled
  const result = await vscode.window.showInputBox({
    title: "Assign Keyboard Shortcut",
    prompt: "Enter a key combination (e.g., alt+m, alt+shift+5, ctrl+shift+a) or leave empty for none",
    value: currentBinding ?? "",
    placeHolder: "alt+m",
    validateInput(value) {
      if (!value.trim()) {
        return undefined; // Allow empty = none
      }
      const normalized = value.trim().toLowerCase();
      if (!isValidBinding(normalized)) {
        return "Invalid binding. Use alt+KEY, alt+shift+KEY, or ctrl+shift+KEY where KEY is A-Z or 0-9.";
      }
      // Check for conflict — warn but allow proceeding
      const owner = macros.findIndex(
        (m, i) => i !== excludeIndex && m.keybinding?.toLowerCase() === normalized
      );
      if (owner >= 0) {
        return {
          message: `Already used by "${macros[owner].name}". It will be reassigned if you proceed.`,
          severity: vscode.InputBoxValidationSeverity.Warning
        };
      }
      return undefined;
    }
  });

  if (result === undefined) {
    return undefined; // Cancelled
  }
  if (!result.trim()) {
    return null; // Empty = none
  }

  const normalized = result.trim().toLowerCase();

  // Show critical key warning
  if (normalized.startsWith("ctrl+shift+")) {
    const key = normalized.slice(11);
    if (CRITICAL_CTRL_SHIFT_KEYS.has(key)) {
      const proceed = await vscode.window.showWarningMessage(
        `${bindingToDisplayLabel(normalized)} is a common VS Code shortcut. Using it for a macro will override the default behavior in the terminal.`,
        "Use Anyway",
        "Cancel"
      );
      if (proceed !== "Use Anyway") {
        return undefined;
      }
    }
  }

  // Show alt+s override warning
  const warning = SPECIAL_BINDING_WARNINGS[normalized];
  if (warning) {
    const proceed = await vscode.window.showWarningMessage(
      warning,
      "Use Anyway",
      "Cancel"
    );
    if (proceed !== "Use Anyway") {
      return undefined;
    }
  }

  return normalized;
}

export function registerMacroCommands(treeProvider: MacroTreeProvider): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.macro.add", () => {
      MacroEditorPanel.openNew();
    }),

    vscode.commands.registerCommand("nexus.macro.editor", () => {
      MacroEditorPanel.open();
    }),

    vscode.commands.registerCommand("nexus.macro.edit", (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (item) {
        MacroEditorPanel.open(item.index);
      } else {
        MacroEditorPanel.open();
      }
    }),

    vscode.commands.registerCommand("nexus.macro.remove", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      let index: number;
      if (item) {
        index = item.index;
      } else {
        const macros = getMacros();
        if (macros.length === 0) {
          void vscode.window.showInformationMessage("No macros defined.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          macros.map((m, i) => ({ label: m.name, description: m.secret ? "***" : m.text.replace(/\n/g, "\\n"), index: i })),
          { title: "Select Macro to Remove" }
        );
        if (!pick) {
          return;
        }
        index = pick.index;
      }
      const macros = getMacros();
      const macro = macros[index];
      if (!macro) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Remove macro "${macro.name}"?`,
        { modal: true },
        "Remove"
      );
      if (confirm !== "Remove") {
        return;
      }
      macros.splice(index, 1);
      await saveMacros(macros);
    }),

    vscode.commands.registerCommand("nexus.macro.run", async () => {
      const macros = getMacros();
      if (macros.length === 0) {
        const action = await vscode.window.showInformationMessage(
          "No macros defined.",
          "Add Macro"
        );
        if (action === "Add Macro") {
          await vscode.commands.executeCommand("nexus.macro.add");
        }
        return;
      }

      const anyHasBindingOrSlot = macros.some((m) => m.keybinding !== undefined || m.slot !== undefined);

      const pick = await vscode.window.showQuickPick(
        macros.map((m, i) => {
          let prefix = "";
          if (m.keybinding) {
            prefix = `[${bindingToDisplayLabel(m.keybinding)}] `;
          } else if (m.slot !== undefined) {
            prefix = `[Alt+${m.slot}] `;
          } else if (!anyHasBindingOrSlot && i < 10) {
            prefix = `[Alt+${(i + 1) % 10}] `;
          }
          return {
            label: `${prefix}${m.name}`,
            description: m.secret ? "***" : m.text.replace(/\n/g, "\\n"),
            index: i
          };
        }),
        { title: "Run Macro", placeHolder: "Select a macro to send to the terminal" }
      );
      if (!pick) {
        return;
      }
      sendMacroText(macros[pick.index].text);
    }),

    vscode.commands.registerCommand("nexus.macro.runBinding", (arg?: unknown) => {
      const args = arg as { binding?: string } | undefined;
      const binding = args?.binding?.toLowerCase();
      if (!binding) {
        return;
      }
      const macros = getMacros();
      const macro = macros.find((m) => m.keybinding?.toLowerCase() === binding);
      if (macro) {
        sendMacroText(macro.text);
      }
    }),

    vscode.commands.registerCommand("nexus.macro.slot", (arg?: unknown) => {
      const args = arg as { index?: number } | undefined;
      const index = args?.index;
      if (typeof index !== "number") {
        return;
      }
      const macros = getMacros();
      const targetSlot = (index + 1) % 10;
      const targetBinding = `alt+${targetSlot}`;

      // First try new keybinding system
      const bindingMacro = macros.find((m) => m.keybinding?.toLowerCase() === targetBinding);
      if (bindingMacro) {
        sendMacroText(bindingMacro.text);
        return;
      }

      // Then try legacy slot
      const slotMacro = macros.find((m) => m.slot === targetSlot);
      if (slotMacro) {
        sendMacroText(slotMacro.text);
        return;
      }

      // Legacy mode: no macros have any keybinding or slot → fall back to positional
      const anyHasBindingOrSlot = macros.some((m) => m.keybinding !== undefined || m.slot !== undefined);
      if (!anyHasBindingOrSlot) {
        const macro = macros[index];
        if (macro) {
          sendMacroText(macro.text);
        }
      }
    }),

    vscode.commands.registerCommand("nexus.macro.runItem", (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (item) {
        sendMacroText(item.macro.text);
      }
    }),

    vscode.commands.registerCommand("nexus.macro.assignSlot", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      let index: number;
      if (item) {
        index = item.index;
      } else {
        const macros = getMacros();
        if (macros.length === 0) {
          void vscode.window.showInformationMessage("No macros defined.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          macros.map((m, i) => ({ label: m.name, description: m.secret ? "***" : m.text.replace(/\n/g, "\\n"), index: i })),
          { title: "Select Macro" }
        );
        if (!pick) {
          return;
        }
        index = pick.index;
      }
      const macros = getMacros();
      const macro = macros[index];
      if (!macro) {
        return;
      }
      const bindingResult = await promptForBinding(macros, index, macro.keybinding);
      if (bindingResult === undefined) {
        return; // Cancelled
      }
      assignBinding(macros, index, bindingResult);
      await saveMacros(macros);
    }),

    vscode.commands.registerCommand("nexus.macro.moveUp", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (!item || item.index <= 0) {
        return;
      }
      const macros = getMacros();
      if (item.index >= macros.length) {
        return;
      }
      [macros[item.index - 1], macros[item.index]] = [macros[item.index], macros[item.index - 1]];
      await saveMacros(macros);
    }),

    vscode.commands.registerCommand("nexus.macro.moveDown", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (!item) {
        return;
      }
      const macros = getMacros();
      if (item.index >= macros.length - 1) {
        return;
      }
      [macros[item.index], macros[item.index + 1]] = [macros[item.index + 1], macros[item.index]];
      await saveMacros(macros);
    })
  ];
}
