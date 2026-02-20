import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  isValidBinding,
  bindingToDisplayLabel,
  CRITICAL_CTRL_SHIFT_KEYS,
  SPECIAL_BINDING_WARNINGS
} from "../macroBindings";
import { renderMacroEditorHtml } from "./macroEditorHtml";
import type { TerminalMacro } from "./macroTreeProvider";

function getMacros(): TerminalMacro[] {
  return vscode.workspace.getConfiguration("nexus.terminal").get<TerminalMacro[]>("macros", []);
}

async function saveMacros(macros: TerminalMacro[]): Promise<void> {
  await vscode.workspace
    .getConfiguration("nexus.terminal")
    .update("macros", macros, vscode.ConfigurationTarget.Global);
}

export class MacroEditorPanel {
  private static instance: MacroEditorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private selectedIndex: number | null = null;

  private constructor(initialIndex: number | null) {
    this.selectedIndex = initialIndex;
    this.panel = vscode.window.createWebviewPanel(
      "nexus.macroEditor",
      "Macro Editor",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.render();
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      MacroEditorPanel.instance = undefined;
    });
  }

  public static open(macroIndex?: number): void {
    const index = macroIndex !== undefined ? macroIndex : null;
    if (MacroEditorPanel.instance) {
      MacroEditorPanel.instance.panel.reveal();
      if (index !== null) {
        MacroEditorPanel.instance.selectedIndex = index;
        MacroEditorPanel.instance.render();
      }
      return;
    }
    MacroEditorPanel.instance = new MacroEditorPanel(index);
  }

  public static openNew(): void {
    if (MacroEditorPanel.instance) {
      MacroEditorPanel.instance.panel.reveal();
      MacroEditorPanel.instance.selectedIndex = null;
      MacroEditorPanel.instance.render();
      return;
    }
    MacroEditorPanel.instance = new MacroEditorPanel(null);
  }

  private render(): void {
    if (this.disposed) return;
    const nonce = randomBytes(16).toString("base64");
    const macros = getMacros();
    // Clamp selectedIndex if macros changed externally
    if (this.selectedIndex !== null && this.selectedIndex >= macros.length) {
      this.selectedIndex = macros.length > 0 ? macros.length - 1 : null;
    }
    this.panel.webview.html = renderMacroEditorHtml(macros, this.selectedIndex, nonce);
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "selectMacro": {
        const value = msg.value as string;
        if (value === "__new__") {
          this.selectedIndex = null;
        } else {
          const parsed = parseInt(value, 10);
          this.selectedIndex = Number.isNaN(parsed) ? null : parsed;
        }
        this.render();
        break;
      }
      case "confirmSwitch": {
        const target = msg.targetValue as string;
        const answer = await vscode.window.showWarningMessage(
          "You have unsaved changes. Discard them?",
          { modal: true },
          "Discard"
        );
        if (answer === "Discard") {
          if (target === "__new__") {
            this.selectedIndex = null;
          } else {
            const parsed = parseInt(target, 10);
            this.selectedIndex = Number.isNaN(parsed) ? null : parsed;
          }
          this.render();
        }
        break;
      }
      case "save": {
        const name = (msg.name as string).trim();
        const text = msg.text as string;
        if (!name || !text) {
          return;
        }
        const secret = msg.secret as boolean;
        const bindingRaw = msg.keybinding as string | null;
        const index = msg.index as number | null;
        const macros = getMacros();

        const macro: TerminalMacro = { name, text };
        if (secret) macro.secret = true;
        if (bindingRaw) {
          const normalized = bindingRaw.toLowerCase();
          if (isValidBinding(normalized)) {
            // Warn about critical Ctrl+Shift keys
            if (normalized.startsWith("ctrl+shift+")) {
              const key = normalized.slice(11);
              if (CRITICAL_CTRL_SHIFT_KEYS.has(key)) {
                const proceed = await vscode.window.showWarningMessage(
                  `${bindingToDisplayLabel(normalized)} is a common VS Code shortcut. Using it for a macro will override the default behavior in the terminal.`,
                  "Use Anyway",
                  "Cancel"
                );
                if (proceed !== "Use Anyway") break;
              }
            }
            // Warn about alt+s override
            const specialWarning = SPECIAL_BINDING_WARNINGS[normalized];
            if (specialWarning) {
              const proceed = await vscode.window.showWarningMessage(
                specialWarning,
                "Use Anyway",
                "Cancel"
              );
              if (proceed !== "Use Anyway") break;
            }
            // Clear conflicting binding
            for (const m of macros) {
              if (m.keybinding?.toLowerCase() === normalized) {
                delete m.keybinding;
              }
            }
            macro.keybinding = normalized;
          }
        }

        if (index !== null && index < macros.length) {
          macros[index] = macro;
          this.selectedIndex = index;
        } else {
          macros.push(macro);
          this.selectedIndex = macros.length - 1;
        }

        await saveMacros(macros);
        this.render();
        void this.panel.webview.postMessage({ type: "saved" });
        break;
      }
      case "delete": {
        const index = msg.index as number;
        const macros = getMacros();
        const macro = macros[index];
        if (!macro) break;

        const confirm = await vscode.window.showWarningMessage(
          `Delete macro "${macro.name}"?`,
          { modal: true },
          "Delete"
        );
        if (confirm !== "Delete") break;

        macros.splice(index, 1);
        await saveMacros(macros);
        this.selectedIndex = macros.length > 0 ? Math.min(index, macros.length - 1) : null;
        this.render();
        break;
      }
    }
  }
}
