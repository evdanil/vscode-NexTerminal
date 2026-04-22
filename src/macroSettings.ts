import * as vscode from "vscode";
import {
  bindingToDisplayLabel,
  CRITICAL_CTRL_SHIFT_KEYS,
  SPECIAL_BINDING_WARNINGS
} from "./macroBindings";
import { normalizeBinding } from "./macroBindingHelpers";
import type { TerminalMacro } from "./models/terminalMacro";
import type { MacroStore } from "./storage/macroStore";

let activeStore: MacroStore | undefined;

export function setActiveMacroStore(store: MacroStore | undefined): void {
  activeStore = store;
}

export function getActiveMacroStore(): MacroStore {
  if (!activeStore) {
    throw new Error("MacroStore not initialized. Call setActiveMacroStore() during activation.");
  }
  return activeStore;
}

export function getMacros(_resource?: vscode.Uri): TerminalMacro[] {
  return getActiveMacroStore().getAll();
}

/** @deprecated Macros no longer live in settings.json — kept for signature compat with callers. */
export function getMacroSettingsTarget(_resource?: vscode.Uri): vscode.ConfigurationTarget {
  return vscode.ConfigurationTarget.Global;
}

export async function saveMacros(macros: TerminalMacro[], _resource?: vscode.Uri): Promise<void> {
  await getActiveMacroStore().save(macros);
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
