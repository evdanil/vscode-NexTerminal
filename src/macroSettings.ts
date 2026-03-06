import * as vscode from "vscode";
import {
  bindingToDisplayLabel,
  CRITICAL_CTRL_SHIFT_KEYS,
  SPECIAL_BINDING_WARNINGS
} from "./macroBindings";
import { normalizeBinding } from "./macroBindingHelpers";
import type { TerminalMacro } from "./models/terminalMacro";

function getMacroConfiguration(resource?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("nexus.terminal", resource);
}

export function getMacros(resource?: vscode.Uri): TerminalMacro[] {
  return getMacroConfiguration(resource).get<TerminalMacro[]>("macros", []);
}

export function getMacroSettingsTarget(resource?: vscode.Uri): vscode.ConfigurationTarget {
  const inspect = getMacroConfiguration(resource).inspect<TerminalMacro[]>("macros");
  if (inspect?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (inspect?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

export async function saveMacros(macros: TerminalMacro[], resource?: vscode.Uri): Promise<void> {
  await getMacroConfiguration(resource).update("macros", macros, getMacroSettingsTarget(resource));
}

export async function confirmBindingWarnings(binding: string): Promise<boolean> {
  const normalized = normalizeBinding(binding);
  if (!normalized) {
    return true;
  }

  if (normalized.startsWith("ctrl+shift+")) {
    const key = normalized.slice(11);
    if (CRITICAL_CTRL_SHIFT_KEYS.has(key)) {
      const proceed = await vscode.window.showWarningMessage(
        `${bindingToDisplayLabel(normalized)} is a common VS Code shortcut. Using it for a macro will override the default behavior in the terminal.`,
        "Use Anyway",
        "Cancel"
      );
      if (proceed !== "Use Anyway") {
        return false;
      }
    }
  }

  const warning = SPECIAL_BINDING_WARNINGS[normalized];
  if (!warning) {
    return true;
  }

  const proceed = await vscode.window.showWarningMessage(
    warning,
    "Use Anyway",
    "Cancel"
  );
  return proceed === "Use Anyway";
}
