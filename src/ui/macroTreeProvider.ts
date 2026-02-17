import * as vscode from "vscode";

export interface TerminalMacro {
  name: string;
  text: string;
  slot?: number;
}

export class MacroTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly macro: TerminalMacro,
    public readonly index: number,
    public readonly displaySlot?: number
  ) {
    const prefix = displaySlot !== undefined ? `[Alt+${displaySlot}] ` : "";
    super(`${prefix}${macro.name}`, vscode.TreeItemCollapsibleState.None);
    this.id = `macro:${index}`;
    const preview = macro.text.replace(/\n/g, "\u21b5");
    this.description = `\u2192 ${preview.length > 40 ? preview.slice(0, 37) + "..." : preview}`;
    this.contextValue = "nexus.macro";
    this.command = {
      command: "nexus.macro.runItem",
      title: "Run Macro",
      arguments: [this]
    };
    const slotHint = displaySlot !== undefined ? ` (Alt+${displaySlot})` : "";
    this.tooltip = `${macro.name}${slotHint}\n${macro.text.replace(/\n/g, "\\n")}`;
    this.iconPath = new vscode.ThemeIcon("terminal");
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

    const anyHasSlot = macros.some((m) => m.slot !== undefined);

    return macros.map((macro, index) => {
      let displaySlot: number | undefined;
      if (macro.slot !== undefined) {
        displaySlot = macro.slot;
      } else if (!anyHasSlot && index < 10) {
        // Legacy mode: no macros have explicit slots, use positional
        displaySlot = (index + 1) % 10;
      }
      return new MacroTreeItem(macro, index, displaySlot);
    });
  }
}
