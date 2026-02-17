import * as vscode from "vscode";

export interface TerminalMacro {
  name: string;
  text: string;
}

export class MacroTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly macro: TerminalMacro,
    public readonly index: number
  ) {
    const slotLabel = index < 10 ? `[Alt+${(index + 1) % 10}]` : `[${index + 1}]`;
    super(`${slotLabel} ${macro.name}`, vscode.TreeItemCollapsibleState.None);
    this.id = `macro:${index}`;
    const preview = macro.text.replace(/\n/g, "\u21b5");
    this.description = `\u2192 ${preview.length > 40 ? preview.slice(0, 37) + "..." : preview}`;
    this.contextValue = "nexus.macro";
    this.command = {
      command: "nexus.macro.slot",
      title: "Run Macro",
      arguments: [{ index }]
    };
    this.tooltip = `${macro.name}\n${macro.text.replace(/\n/g, "\\n")}`;
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
    return macros.map((macro, index) => new MacroTreeItem(macro, index));
  }
}
