import * as vscode from "vscode";
import type { MacroTreeItem } from "../ui/macroTreeProvider";
import { MacroEditorPanel } from "../ui/macroEditorPanel";
import {
  bindingToContextKey,
  bindingToDisplayLabel,
  isValidBinding,
  slotToBinding
} from "../macroBindings";
import {
  confirmBindingWarnings,
  getMacros,
  saveMacros
} from "../macroSettings";
import {
  assignBinding,
  findBindingOwnerIndex,
  getAssignedBinding,
  normalizeBinding
} from "../macroBindingHelpers";

function sendMacroText(text: string): void {
  void vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text });
}

/** Track which context keys are currently set to true, so we only update the delta. */
const activeContextKeys = new Set<string>();

function updateBindingContextKeys(): void {
  const macros = getMacros();
  const assignedBindings = new Set(
    macros.map((macro) => getAssignedBinding(macro)).filter((binding): binding is string => binding !== undefined)
  );

  // Set true for newly assigned bindings
  for (const binding of assignedBindings) {
    const key = bindingToContextKey(binding);
    if (!activeContextKeys.has(key)) {
      activeContextKeys.add(key);
      void vscode.commands.executeCommand("setContext", key, true);
    }
  }

  // Set false for previously active bindings that are no longer assigned
  const newActiveKeys = new Set(
    [...assignedBindings].map((b) => bindingToContextKey(b))
  );
  for (const key of activeContextKeys) {
    if (!newActiveKeys.has(key)) {
      activeContextKeys.delete(key);
      void vscode.commands.executeCommand("setContext", key, false);
    }
  }
}

export function updateMacroContext(): void {
  void vscode.commands.executeCommand("setContext", "nexus.hasMacros", getMacros().length > 0);
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

async function promptForBinding(
  macros: ReturnType<typeof getMacros>,
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
      const normalized = normalizeBinding(value);
      if (!normalized) {
        return undefined;
      }
      if (!isValidBinding(normalized)) {
        return "Invalid binding. Use alt+KEY, alt+shift+KEY, or ctrl+shift+KEY where KEY is A-Z or 0-9.";
      }
      // Check for conflict — warn but allow proceeding
      const owner = findBindingOwnerIndex(macros, normalized, excludeIndex);
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
    return undefined;
  }
  if (!result.trim()) {
    return null;
  }

  const normalized = normalizeBinding(result);
  if (!normalized) {
    return null;
  }
  if (!(await confirmBindingWarnings(normalized))) {
    return undefined;
  }

  return normalized;
}

export function registerMacroCommands(): vscode.Disposable[] {
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

      const pick = await vscode.window.showQuickPick(
        macros.map((m, i) => {
          const binding = getAssignedBinding(m);
          const prefix = binding ? `[${bindingToDisplayLabel(binding)}] ` : "";
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
      const binding = normalizeBinding(args?.binding);
      if (!binding) {
        return;
      }
      const macros = getMacros();
      const macro = macros.find((m) => getAssignedBinding(m) === binding);
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
      const bindingMacro = macros.find((m) => getAssignedBinding(m) === targetBinding);
      if (bindingMacro) {
        sendMacroText(bindingMacro.text);
        return;
      }

      const slotMacro = macros.find((m) => m.slot === targetSlot);
      if (slotMacro) {
        sendMacroText(slotMacro.text);
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
      const bindingResult = await promptForBinding(macros, index, getAssignedBinding(macro));
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
    }),

    vscode.commands.registerCommand("nexus.macro.copySecret", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (!item?.macro.secret) {
        return;
      }
      await vscode.env.clipboard.writeText(item.macro.text);
      void vscode.window.showInformationMessage(`Copied "${item.macro.name}" value to clipboard.`);
    }),

    vscode.commands.registerCommand("nexus.macro.pasteSecret", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (!item?.macro.secret) {
        return;
      }
      const clipText = await vscode.env.clipboard.readText();
      if (!clipText) {
        void vscode.window.showInformationMessage("Clipboard is empty.");
        return;
      }
      let text = clipText;
      if (!text.endsWith("\n")) {
        const choice = await vscode.window.showInformationMessage(
          "Append newline (\\n) to the end of the pasted text?",
          "Yes",
          "No"
        );
        if (choice === undefined) {
          return;
        }
        if (choice === "Yes") {
          text += "\n";
        }
      }
      const macros = getMacros();
      const macro = macros[item.index];
      if (!macro) {
        return;
      }
      macro.text = text;
      await saveMacros(macros);
      void vscode.window.showInformationMessage(`Updated "${item.macro.name}" from clipboard.`);
    })
  ];
}
