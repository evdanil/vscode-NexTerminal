import * as vscode from "vscode";
import { bindingToDisplayLabel } from "../macroBindings";

export interface TerminalMacro {
  name: string;
  text: string;
  keybinding?: string;
  /** @deprecated Use keybinding instead. Auto-migrated on first load. */
  slot?: number;
  secret?: boolean;
}

export class MacroTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly macro: TerminalMacro,
    public readonly index: number,
    public readonly displayBinding?: string
  ) {
    const prefix = displayBinding ? `[${bindingToDisplayLabel(displayBinding)}] ` : "";
    super(`${prefix}${macro.name}`, vscode.TreeItemCollapsibleState.None);
    this.id = `macro:${index}`;
    if (macro.secret) {
      this.description = "\u2022\u2022\u2022\u2022\u2022";
    } else {
      const preview = macro.text.replace(/\n/g, "\u21b5");
      this.description = `\u2192 ${preview.length > 40 ? preview.slice(0, 37) + "..." : preview}`;
    }
    this.contextValue = "nexus.macro";
    this.command = {
      command: "nexus.macro.runItem",
      title: "Run Macro",
      arguments: [this]
    };
    const bindingHint = displayBinding ? ` (${bindingToDisplayLabel(displayBinding)})` : "";
    if (macro.secret) {
      this.tooltip = `${macro.name}${bindingHint} (secret)`;
    } else {
      this.tooltip = `${macro.name}${bindingHint}\n${macro.text.replace(/\n/g, "\\n")}`;
    }
    this.iconPath = new vscode.ThemeIcon(macro.secret ? "lock" : "terminal");
  }
}

export class MacroTreeProvider implements vscode.TreeDataProvider<MacroTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<MacroTreeItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: MacroTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): MacroTreeItem[] {
    const macros = vscode.workspace
      .getConfiguration("nexus.terminal")
      .get<TerminalMacro[]>("macros", []);

    const anyHasBindingOrSlot = macros.some((m) => m.keybinding !== undefined || m.slot !== undefined);

    return macros.map((macro, index) => {
      let displayBinding: string | undefined;
      if (macro.keybinding) {
        displayBinding = macro.keybinding;
      } else if (macro.slot !== undefined) {
        displayBinding = `alt+${macro.slot}`;
      } else if (!anyHasBindingOrSlot && index < 10) {
        // Legacy positional mode: no macros have explicit keybinding or slot
        displayBinding = `alt+${(index + 1) % 10}`;
      }
      return new MacroTreeItem(macro, index, displayBinding);
    });
  }
}
