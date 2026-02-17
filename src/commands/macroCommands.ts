import * as vscode from "vscode";
import type { MacroTreeItem, MacroTreeProvider } from "../ui/macroTreeProvider";

interface TerminalMacro {
  name: string;
  text: string;
  slot?: number;
}

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

/** Convert keybinding index (0-9) to the keyboard digit: index 0 → 1, ..., 8 → 9, 9 → 0 */
function indexToSlot(index: number): number {
  return (index + 1) % 10;
}

function slotLabel(slot: number): string {
  return `Alt+${slot}`;
}

function assignSlot(macros: TerminalMacro[], targetIndex: number, slot: number | null): void {
  if (slot !== null) {
    // Clear slot from any conflicting macro
    for (const m of macros) {
      if (m.slot === slot) {
        delete m.slot;
      }
    }
    macros[targetIndex].slot = slot;
  } else {
    delete macros[targetIndex].slot;
  }
}

async function promptForSlot(
  macros: TerminalMacro[],
  excludeIndex?: number,
  currentSlot?: number
): Promise<number | null | undefined> {
  // Returns: number = chosen slot, null = "None" selected, undefined = cancelled
  const items: (vscode.QuickPickItem & { slot: number | null })[] = [];

  items.push({
    label: "None",
    description: "No keyboard shortcut",
    slot: null,
    picked: currentSlot === undefined
  });

  for (let s = 1; s <= 9; s++) {
    const owner = macros.findIndex((m, i) => m.slot === s && i !== excludeIndex);
    const taken = owner >= 0 ? ` (currently: ${macros[owner].name})` : "";
    items.push({
      label: slotLabel(s),
      description: taken,
      slot: s,
      picked: currentSlot === s
    });
  }
  // Alt+0 = slot 0
  {
    const owner = macros.findIndex((m, i) => m.slot === 0 && i !== excludeIndex);
    const taken = owner >= 0 ? ` (currently: ${macros[owner].name})` : "";
    items.push({
      label: slotLabel(0),
      description: taken,
      slot: 0,
      picked: currentSlot === 0
    });
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: "Assign Keyboard Shortcut",
    placeHolder: "Select a slot for this macro"
  });

  return pick === undefined ? undefined : pick.slot;
}

export function updateMacroContext(): void {
  const macros = getMacros();
  void vscode.commands.executeCommand("setContext", "nexus.hasMacros", macros.length > 0);
}

export function registerMacroCommands(treeProvider: MacroTreeProvider): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.macro.add", async () => {
      const name = await vscode.window.showInputBox({
        title: "Macro Name",
        prompt: "Display name for the macro",
        validateInput: (v) => (v.trim() ? null : "Name cannot be empty")
      });
      if (!name) {
        return;
      }
      const text = await vscode.window.showInputBox({
        title: "Macro Text",
        prompt: "Text to send (use \\n for Enter)",
        validateInput: (v) => (v ? null : "Text cannot be empty")
      });
      if (text === undefined) {
        return;
      }
      const macros = getMacros();
      const newMacro: TerminalMacro = { name: name.trim(), text: text.replace(/\\n/g, "\n") };

      const slotResult = await promptForSlot(macros);
      if (slotResult !== undefined && slotResult !== null) {
        // Clear any conflict before pushing
        for (const m of macros) {
          if (m.slot === slotResult) {
            delete m.slot;
          }
        }
        newMacro.slot = slotResult;
      }

      macros.push(newMacro);
      await saveMacros(macros);
    }),

    vscode.commands.registerCommand("nexus.macro.edit", async (arg?: unknown) => {
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
          macros.map((m, i) => ({ label: m.name, description: m.text.replace(/\n/g, "\\n"), index: i })),
          { title: "Select Macro to Edit" }
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
      const name = await vscode.window.showInputBox({
        title: "Macro Name",
        prompt: "Display name for the macro",
        value: macro.name,
        validateInput: (v) => (v.trim() ? null : "Name cannot be empty")
      });
      if (!name) {
        return;
      }
      const text = await vscode.window.showInputBox({
        title: "Macro Text",
        prompt: "Text to send (use \\n for Enter)",
        value: macro.text.replace(/\n/g, "\\n"),
        validateInput: (v) => (v ? null : "Text cannot be empty")
      });
      if (text === undefined) {
        return;
      }
      const currentSlot = macro.slot;
      const slotResult = await promptForSlot(macros, index, currentSlot);
      if (slotResult === undefined) {
        // Cancelled — preserve existing slot
        macros[index] = { name: name.trim(), text: text.replace(/\\n/g, "\n"), ...(currentSlot !== undefined ? { slot: currentSlot } : {}) };
      } else {
        macros[index] = { name: name.trim(), text: text.replace(/\\n/g, "\n") };
        assignSlot(macros, index, slotResult);
      }
      await saveMacros(macros);
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
          macros.map((m, i) => ({ label: m.name, description: m.text.replace(/\n/g, "\\n"), index: i })),
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

      const anyHasSlot = macros.some((m) => m.slot !== undefined);

      const pick = await vscode.window.showQuickPick(
        macros.map((m, i) => {
          let prefix = "";
          if (m.slot !== undefined) {
            prefix = `[${slotLabel(m.slot)}] `;
          } else if (!anyHasSlot && i < 10) {
            prefix = `[${slotLabel(indexToSlot(i))}] `;
          }
          return {
            label: `${prefix}${m.name}`,
            description: m.text.replace(/\n/g, "\\n"),
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

    vscode.commands.registerCommand("nexus.macro.slot", (arg?: unknown) => {
      const args = arg as { index?: number } | undefined;
      const index = args?.index;
      if (typeof index !== "number") {
        return;
      }
      const macros = getMacros();
      const targetSlot = indexToSlot(index);

      // Find macro with explicit slot matching targetSlot
      const slotMacro = macros.find((m) => m.slot === targetSlot);
      if (slotMacro) {
        sendMacroText(slotMacro.text);
        return;
      }

      // Legacy mode: no macros have any slot property → fall back to positional
      const anyHasSlot = macros.some((m) => m.slot !== undefined);
      if (!anyHasSlot) {
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
          macros.map((m, i) => ({ label: m.name, description: m.text.replace(/\n/g, "\\n"), index: i })),
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
      const slotResult = await promptForSlot(macros, index, macro.slot);
      if (slotResult === undefined) {
        return; // Cancelled
      }
      assignSlot(macros, index, slotResult);
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
