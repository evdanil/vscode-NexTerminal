import * as vscode from "vscode";
import { bindingToDisplayLabel } from "../macroBindings";
import { getAssignedBinding } from "../macroBindingHelpers";
import type { TerminalMacro } from "../models/terminalMacro";
import { getMacros } from "../macroSettings";
import { getValidMacroVariables, hasMacroVariables, scanPlaceholders } from "../services/macroVariables";
import { VARIABLE_MARKER } from "./macroVariableMarker";

export { VARIABLE_MARKER };

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

    // \u00a74.2 \u2014 `variables` is untrusted at every read site: shape-guarded helpers
    // only, never a bare `macro.variables` truthy check.
    const hasVariables = hasMacroVariables(macro);

    // \u00a79.6 \u2014 the marker and icon must reflect whether the macro will ACTUALLY
    // prompt, not merely whether it declares a `variables` array. A macro that
    // declares `port` but never references `$port` in its text sends immediately
    // on click \u2014 "click = sends immediately" vs "click = opens prompts" is exactly
    // the distinction the marker exists to communicate, so it keys off the same
    // scan the tooltip below already uses, never the raw shape check.
    const declaredNames = hasVariables ? getValidMacroVariables(macro).map((v) => v.name) : [];
    const promptedNames = hasVariables ? scanPlaceholders(macro.text, declaredNames).used : [];
    const willPrompt = promptedNames.length > 0;
    const variableMarker = willPrompt ? VARIABLE_MARKER : "";

    if (macro.secret) {
      this.description = `${variableMarker}\u2022\u2022\u2022\u2022\u2022`;
    } else {
      const preview = macro.text.replace(/\n/g, "\u21b5");
      this.description = `${variableMarker}\u2192 ${preview.length > 40 ? preview.slice(0, 37) + "..." : preview}`;
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

    // \u00a79.6 \u2014 names only; values do not exist at this point. Only names whose
    // placeholder actually appears (unescaped) in the text are ever prompted
    // for (\u00a75.3), so this mirrors runMacro()'s own scan rather than just
    // listing every declaration.
    if (willPrompt) {
      this.tooltip += `\nPrompts for: ${promptedNames.join(", ")}`;
    }

    // \u00a76.3 \u2014 a macro with BOTH a triggerPattern and variables must never
    // render as a live trigger macro: macroAutoTrigger.reload()'s in-loop
    // `continue` means such a rule never compiles, so the zap icon,
    // enable/disable toggle, and "active"/"paused" tooltip would all be dead
    // controls for a rule that can never fire.
    const isTriggerMacro = !!macro.triggerPattern && !hasVariables;

    if (isTriggerMacro) {
      const state = triggerDisabled ? "paused" : "active";
      const intervalHint = macro.triggerInterval ? `, every ${macro.triggerInterval}s` : "";
      this.tooltip += `\nAuto-trigger: /${macro.triggerPattern}/ (${state}${intervalHint})`;
      const base = triggerDisabled ? "nexus.macro.triggered.disabled" : "nexus.macro.triggered";
      this.contextValue = macro.secret ? base.replace("nexus.macro.", "nexus.macro.secret.") : base;
      this.iconPath = new vscode.ThemeIcon(triggerDisabled ? "circle-slash" : "zap");
    } else {
      if (hasVariables && macro.triggerPattern) {
        this.tooltip += "\nAuto-trigger suppressed: macro has variables";
      }
      // contextValue is intentionally UNCHANGED for variable macros (\u00a79.6) \u2014
      // only the icon and tooltip differ; the context menu stays the one for
      // a plain (or secret) macro.
      this.contextValue = macro.secret ? "nexus.macro.secret" : "nexus.macro";
      this.iconPath = new vscode.ThemeIcon(willPrompt ? "symbol-parameter" : (macro.secret ? "lock" : "terminal"));
    }
  }
}

export class MacroTreeProvider implements vscode.TreeDataProvider<MacroTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<MacroTreeItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly isTriggerDisabled: (macro: TerminalMacro) => boolean = () => false
  ) {}

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: MacroTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): MacroTreeItem[] {
    const macros = getMacros();

    return macros.map((macro, index) => {
      const displayBinding = getAssignedBinding(macro);
      const triggerDisabled = macro.triggerPattern ? this.isTriggerDisabled(macro) : undefined;
      return new MacroTreeItem(macro, index, displayBinding, triggerDisabled);
    });
  }
}
