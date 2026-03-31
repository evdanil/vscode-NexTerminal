import * as vscode from "vscode";
import { bindingToDisplayLabel } from "../macroBindings";
import { getAssignedBinding } from "../macroBindingHelpers";
import type { TerminalMacro } from "../models/terminalMacro";

export class MacroTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly macro: TerminalMacro,
    public readonly index: number,
    public readonly displayBinding?: string,
    triggerDisabled?: boolean
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
    if (macro.triggerPattern) {
      const state = triggerDisabled ? "paused" : "active";
      const intervalHint = macro.triggerInterval ? `, every ${macro.triggerInterval}s` : "";
      this.tooltip += `\nAuto-trigger: /${macro.triggerPattern}/ (${state}${intervalHint})`;
      const base = triggerDisabled ? "nexus.macro.triggered.disabled" : "nexus.macro.triggered";
      this.contextValue = macro.secret ? base.replace("nexus.macro.", "nexus.macro.secret.") : base;
      this.iconPath = new vscode.ThemeIcon(triggerDisabled ? "circle-slash" : "zap");
    } else {
      this.contextValue = macro.secret ? "nexus.macro.secret" : "nexus.macro";
      this.iconPath = new vscode.ThemeIcon(macro.secret ? "lock" : "terminal");
    }
  }
}

export class MacroTreeProvider implements vscode.TreeDataProvider<MacroTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<MacroTreeItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly isTriggerDisabled: (macro: TerminalMacro, index: number) => boolean = () => false
  ) {}

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

    return macros.map((macro, index) => {
      const displayBinding = getAssignedBinding(macro);
      const triggerDisabled = macro.triggerPattern ? this.isTriggerDisabled(macro, index) : undefined;
      return new MacroTreeItem(macro, index, displayBinding, triggerDisabled);
    });
  }
}
