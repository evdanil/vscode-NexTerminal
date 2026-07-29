import * as vscode from "vscode";
import { isValidBinding } from "../macroBindings";
import {
  assignBinding,
  normalizeBinding
} from "../macroBindingHelpers";
import {
  confirmBindingWarnings,
  getActiveMacroStore,
  getMacros,
  saveMacros
} from "../macroSettings";
import type { MacroVariable, TerminalMacro } from "../models/terminalMacro";
import { DEFAULT_TRIGGER_COOLDOWN } from "../services/macroAutoTrigger";
import { MAX_MACRO_VARIABLES, validateMacroVariables } from "../services/macroVariables";
import { validateRegexSafety } from "../utils/regexSafety";
import { renderMacroEditorHtml } from "./macroEditorHtml";
import type { MacroProfileOptionInput } from "./macroProfileOptions";
import { createWebviewNonce } from "./shared/webviewNonce";

type MacroProfileProvider = () => MacroProfileOptionInput[];

/**
 * Coerces the webview's raw `variables` payload into `MacroVariable[]`. The
 * panel uses `retainContextWhenHidden`, so the webview's own client-side
 * checks (macroEditorHtml.ts) can be stale relative to a store changed
 * externally — this parse is defensive, not just a passthrough, and
 * `default` is preserved even on a `secret` entry so `validateMacroVariables()`
 * below can catch and report that combination rather than have it silently
 * dropped before validation ever sees it.
 */
function parseIncomingVariables(raw: unknown): MacroVariable[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry): MacroVariable => {
    const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const variable: MacroVariable = {
      name: typeof e.name === "string" ? e.name.trim() : ""
    };
    if (typeof e.label === "string" && e.label.trim() !== "") {
      variable.label = e.label.trim();
    }
    if (typeof e.default === "string" && e.default !== "") {
      variable.default = e.default;
    }
    if (e.secret === true) {
      variable.secret = true;
    }
    if (e.remember === false) {
      variable.remember = false;
    }
    return variable;
  });
}

export class MacroEditorPanel {
  private static instance: MacroEditorPanel | undefined;
  private static profileProvider: MacroProfileProvider = () => [];
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private selectedIndex: number | null = null;
  private unsubscribe: () => void = () => {};
  /**
   * Set while this panel is persisting its own save/delete. The macro store's
   * change event fires for our own writes too; without this guard a self-save
   * would re-render mid-flow and could clobber the just-applied `selectedIndex`.
   */
  private isSaving = false;

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
      this.unsubscribe();
      MacroEditorPanel.instance = undefined;
    });
    // Re-render when the macro store changes externally (second window, Settings
    // Sync, legacy absorption, clearAll) so index/id resolution stays current.
    this.unsubscribe = getActiveMacroStore().onDidChange(() => {
      if (this.isSaving) return;
      this.render();
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
    const nonce = createWebviewNonce();
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
      case "addFromTemplate": {
        await vscode.commands.executeCommand("nexus.macro.addFromTemplate");
        break;
      }
      case "confirmAddFromTemplate": {
        const answer = await vscode.window.showWarningMessage(
          "You have unsaved changes. Discard them?",
          { modal: true },
          "Discard"
        );
        if (answer === "Discard") {
          await vscode.commands.executeCommand("nexus.macro.addFromTemplate");
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
        const macroId = typeof msg.id === "string" && msg.id.length > 0 ? msg.id : null;
        const macros = getMacros();
        // Resolve the target by stable id, never by the render-time array index:
        // an external reorder/delete between render and save would otherwise hit
        // the wrong macro. A null id means an unsaved (new) macro → push path.
        const index = macroId !== null ? macros.findIndex((m) => m.id === macroId) : -1;
        if (macroId !== null && index === -1) {
          // The macro we were editing was deleted/changed externally. Do not
          // fall through to the push path (that would create a stray duplicate).
          void vscode.window.showWarningMessage(
            "This macro changed externally and could not be saved. The editor has been refreshed."
          );
          this.render();
          return;
        }
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

        // §9.4 — host-side enforcement of every variable rule via the single
        // shared validator (never re-implemented here or trusted from the
        // webview alone; retainContextWhenHidden means the webview's own
        // client-side pre-check can be stale relative to a store changed
        // externally). Errors are routed to the sanctioned UI slot for each
        // class: per-row errors carry `row` (data-var-error="N"); the
        // variables/trigger conflict reuses the existing #error-trigger slot
        // (it can only occur when triggerPattern is set and variables.length
        // is within the cap, so it is always the remaining array-level error
        // once "too many" is ruled out); anything else array-level (only
        // "too many variables" today) goes to #error-variables.
        const variables = parseIncomingVariables(msg.variables);
        const variableErrors = validateMacroVariables(variables, {
          triggerPattern: triggerPattern || undefined
        });
        if (variableErrors.length > 0) {
          const first = variableErrors[0];
          if (first.index !== undefined) {
            void this.panel.webview.postMessage({
              type: "saveError",
              field: "variable",
              row: first.index,
              message: first.message
            });
          } else if (variables.length > MAX_MACRO_VARIABLES) {
            void this.panel.webview.postMessage({
              type: "saveError",
              field: "variables",
              message: first.message
            });
          } else {
            void this.panel.webview.postMessage({
              type: "saveError",
              field: "trigger",
              message: first.message
            });
          }
          return;
        }

        const existingMacro = index >= 0 ? macros[index] : undefined;
        const macro: TerminalMacro = { ...existingMacro, name, text };
        delete macro.keybinding;
        delete macro.slot;
        delete macro.triggerPattern;
        delete macro.triggerInitiallyDisabled;
        delete macro.triggerInterval;
        delete macro.triggerProfileId;
        // §9.5 — `variables` MUST join this delete-then-conditionally-re-add
        // pattern. Without the unconditional delete here, clearing every row
        // in the UI (variables === []) would silently resurrect the old array
        // through the `{ ...existingMacro }` spread above.
        delete macro.variables;
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
        if (variables.length > 0) {
          macro.variables = variables;
        }
        const normalizedBinding = normalizeBinding(bindingRaw);
        if (normalizedBinding) {
          if (!isValidBinding(normalizedBinding)) {
            break;
          }
          if (!(await confirmBindingWarnings(normalizedBinding))) {
            break;
          }
          if (index >= 0) {
            macros[index] = macro;
            assignBinding(macros, index, normalizedBinding);
            this.selectedIndex = index;
          } else {
            macros.push(macro);
            const newIndex = macros.length - 1;
            assignBinding(macros, newIndex, normalizedBinding);
            this.selectedIndex = newIndex;
          }
        } else if (index >= 0) {
          macros[index] = macro;
          this.selectedIndex = index;
        } else {
          macros.push(macro);
          this.selectedIndex = macros.length - 1;
        }

        await this.persist(macros);
        this.render();
        void this.panel.webview.postMessage({ type: "saved" });
        break;
      }
      case "delete": {
        const macroId = typeof msg.id === "string" && msg.id.length > 0 ? msg.id : null;
        const macros = getMacros();
        // Resolve by stable id; the render-time index may be stale.
        const index = macroId !== null ? macros.findIndex((m) => m.id === macroId) : -1;
        const macro = index >= 0 ? macros[index] : undefined;
        if (!macro) {
          if (macroId !== null) {
            void vscode.window.showWarningMessage(
              "This macro changed externally and could not be deleted. The editor has been refreshed."
            );
            this.render();
          }
          break;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Delete macro "${macro.name}"?`,
          { modal: true },
          "Delete"
        );
        if (confirm !== "Delete") break;

        macros.splice(index, 1);
        await this.persist(macros);
        this.selectedIndex = macros.length > 0 ? Math.min(index, macros.length - 1) : null;
        this.render();
        break;
      }
    }
  }

  /**
   * Persist macros while suppressing the store's change-event re-render for our
   * own write, so a self-save does not race the explicit `render()` calls in the
   * save/delete handlers (which set `selectedIndex` to the just-applied target).
   */
  private async persist(macros: TerminalMacro[]): Promise<void> {
    this.isSaving = true;
    try {
      await saveMacros(macros);
    } finally {
      this.isSaving = false;
    }
  }
}
