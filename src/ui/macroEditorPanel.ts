import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { isValidBinding } from "../macroBindings";
import {
  assignBinding,
  normalizeBinding
} from "../macroBindingHelpers";
import {
  confirmBindingWarnings,
  getMacros,
  saveMacros
} from "../macroSettings";
import type { TerminalMacro } from "../models/terminalMacro";
import { DEFAULT_TRIGGER_COOLDOWN } from "../services/macroAutoTrigger";
import { validateRegexSafety } from "../utils/regexSafety";
import { renderMacroEditorHtml } from "./macroEditorHtml";
import type { MacroProfileOptionInput } from "./macroProfileOptions";

type MacroProfileProvider = () => MacroProfileOptionInput[];

export class MacroEditorPanel {
  private static instance: MacroEditorPanel | undefined;
  private static profileProvider: MacroProfileProvider = () => [];
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private selectedIndex: number | null = null;

  public static setProfileProvider(provider: MacroProfileProvider): void {
    MacroEditorPanel.profileProvider = provider;
  }

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
    this.panel.webview.html = renderMacroEditorHtml(macros, this.selectedIndex, nonce, MacroEditorPanel.profileProvider());
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
        const triggerInitiallyDisabled = msg.triggerInitiallyDisabled as boolean | undefined;
        const triggerInterval = msg.triggerInterval as number | undefined | null;
        const triggerScope = msg.triggerScope as TerminalMacro["triggerScope"] | undefined;
        const triggerProfileId = msg.triggerProfileId as string | null | undefined;
        const triggerPattern = ((msg.triggerPattern as string | null) ?? "").trim();
        const safeScope = triggerScope && ["all-terminals", "active-session", "profile"].includes(triggerScope)
          ? triggerScope
          : undefined;

        if (triggerPattern) {
          const safety = validateRegexSafety(triggerPattern);
          if (!safety.ok) {
            void this.panel.webview.postMessage({
              type: "saveError",
              field: "trigger",
              message: safety.message
            });
            return;
          }
          try {
            const regex = new RegExp(triggerPattern);
            if (regex.test("")) {
              void this.panel.webview.postMessage({
                type: "saveError",
                field: "trigger",
                message: "Pattern must not match empty strings."
              });
              return;
            }
          } catch (error) {
            void this.panel.webview.postMessage({
              type: "saveError",
              field: "trigger",
              message: error instanceof Error ? error.message : "Invalid regex."
            });
            return;
          }
        }
        if (triggerPattern && safeScope === "profile") {
          const profileId = typeof triggerProfileId === "string" ? triggerProfileId.trim() : "";
          const knownProfileIds = new Set(MacroEditorPanel.profileProvider().map((profile) =>
            typeof profile === "string" ? profile : profile.id
          ));
          if (!profileId) {
            void this.panel.webview.postMessage({
              type: "saveError",
              field: "trigger-profile",
              message: "Matching profile scope requires a profile id."
            });
            return;
          }
          if (knownProfileIds.size > 0 && !knownProfileIds.has(profileId)) {
            void this.panel.webview.postMessage({
              type: "saveError",
              field: "trigger-profile",
              message: "Unknown profile id."
            });
            return;
          }
        }

        const existingMacro = index !== null && index < macros.length ? macros[index] : undefined;
        const macro: TerminalMacro = { ...existingMacro, name, text };
        delete macro.keybinding;
        delete macro.slot;
        delete macro.triggerPattern;
        delete macro.triggerInitiallyDisabled;
        delete macro.triggerInterval;
        delete macro.triggerProfileId;
        if (secret) macro.secret = true;
        else delete macro.secret;
        const triggerCooldown = msg.triggerCooldown as number | undefined;
        if (triggerPattern) {
          macro.triggerPattern = triggerPattern;
          if (triggerInitiallyDisabled) {
            macro.triggerInitiallyDisabled = true;
          }
          if (typeof triggerInterval === "number" && triggerInterval > 0) {
            macro.triggerInterval = triggerInterval;
          }
        }
        if (triggerCooldown !== undefined && triggerCooldown !== DEFAULT_TRIGGER_COOLDOWN) macro.triggerCooldown = triggerCooldown;
        else delete macro.triggerCooldown;
        if (triggerPattern && safeScope) {
          macro.triggerScope = safeScope;
        } else {
          delete macro.triggerScope;
        }
        if (triggerPattern && macro.triggerScope === "profile" && typeof triggerProfileId === "string" && triggerProfileId.trim()) {
          macro.triggerProfileId = triggerProfileId.trim();
        } else {
          delete macro.triggerProfileId;
        }
        const normalizedBinding = normalizeBinding(bindingRaw);
        if (normalizedBinding) {
          if (!isValidBinding(normalizedBinding)) {
            break;
          }
          if (!(await confirmBindingWarnings(normalizedBinding))) {
            break;
          }
          if (index !== null && index < macros.length) {
            macros[index] = macro;
            assignBinding(macros, index, normalizedBinding);
            this.selectedIndex = index;
          } else {
            macros.push(macro);
            const newIndex = macros.length - 1;
            assignBinding(macros, newIndex, normalizedBinding);
            this.selectedIndex = newIndex;
          }
        } else if (index !== null && index < macros.length) {
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
