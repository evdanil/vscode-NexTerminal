import * as vscode from "vscode";
import type { MacroTreeItem, MacroTreeProvider } from "../ui/macroTreeProvider";

interface TerminalMacro {
  name: string;
  text: string;
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
      macros.push({ name: name.trim(), text: text.replace(/\\n/g, "\n") });
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
      macros[index] = { name: name.trim(), text: text.replace(/\\n/g, "\n") };
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
      const pick = await vscode.window.showQuickPick(
        macros.map((m, i) => {
          const slot = i < 10 ? `[Alt+${(i + 1) % 10}] ` : "";
          return {
            label: `${slot}${m.name}`,
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
      const macro = macros[index];
      if (!macro) {
        return;
      }
      sendMacroText(macro.text);
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
