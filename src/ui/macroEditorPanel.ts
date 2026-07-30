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
import { getValidMacroVariables, MAX_MACRO_VARIABLES, validateMacroVariables } from "../services/macroVariables";
import { validateRegexSafety } from "../utils/regexSafety";
import { renderMacroEditorHtml } from "./macroEditorHtml";
import type { MacroProfileOptionInput } from "./macroProfileOptions";
import { createWebviewNonce } from "./shared/webviewNonce";

type MacroProfileProvider = () => MacroProfileOptionInput[];

/** Shown when a save/delete target cannot be resolved to exactly one macro. */
const AMBIGUOUS_TARGET_MESSAGE =
  "Another macro has the same internal id, so Nexus cannot tell which one you were editing. " +
  "Reorder any macro with Move Up / Move Down to assign fresh ids, then try again.";

/**
 * Resolves the save/delete target by stable id, never by the render-time array index:
 * an external reorder or delete between render and save would otherwise hit the wrong
 * macro.
 *
 * Returns -1 when the id is absent, unknown, OR claimed by more than one macro. That
 * last case is reachable for a macro list that predates the unique-id invariant
 * (`MacroStore.save()`), which the read path deliberately no longer repairs — see
 * `VscodeMacroStore.reloadFromState()`. Taking the first match would write the macro
 * the user was looking at over its twin, silently destroying it; refusing is the same
 * fail-safe `MacroAutoTrigger` applies to an ambiguous state key. Every other repair
 * route (Move Up / Move Down, delete, or editing any macro with a unique id) re-saves
 * the whole list and clears the conflict, so this is never a dead end.
 */
function resolveUniqueMacroIndex(macros: readonly TerminalMacro[], macroId: string | null): number {
  if (macroId === null) return -1;
  const first = macros.findIndex((m) => m.id === macroId);
  if (first === -1) return -1;
  return macros.some((m, i) => i > first && m.id === macroId) ? -1 : first;
}

function isAmbiguousMacroId(macros: readonly TerminalMacro[], macroId: string | null): boolean {
  return macroId !== null && macros.filter((m) => m.id === macroId).length > 1;
}

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
    // The `.catch()` is the whole point — see `reportHandlerFailure()`. The settled promise is
    // returned rather than discarded so a caller that CAN await one still can (VS Code does
    // not); it never rejects, so nothing downstream has to handle it.
    this.panel.webview.onDidReceiveMessage((msg) =>
      this.handleMessage(msg).catch((err) => this.reportHandlerFailure(err, msg?.type))
    );
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
        // A null id means an unsaved (new) macro → push path.
        const index = resolveUniqueMacroIndex(macros, macroId);
        if (macroId !== null && index === -1) {
          // The macro we were editing was deleted/changed externally, or its id is
          // shared with another macro. Do not fall through to the push path (that
          // would create a stray duplicate) and do not guess a target.
          void vscode.window.showWarningMessage(
            isAmbiguousMacroId(macros, macroId)
              ? AMBIGUOUS_TARGET_MESSAGE
              : "This macro changed externally and could not be saved. The editor has been refreshed."
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

        // A stored macro can carry declarations the editor cannot render — entries with
        // invalid names, which `getValidMacroVariables()` filters out before the rows
        // are built. Those still suppress the macro's auto-trigger, because
        // MacroAutoTrigger keys suppression on the raw array being non-empty.
        //
        // So the sequence "open such a macro, see no variable rows, press Save" would
        // otherwise submit zero variables, pass the §9.4 conflict check (which only
        // fires when variables are present), delete the array, and leave the trigger
        // live. For a secret macro that means its text starts auto-sending on matching
        // output — with the user having changed nothing they could see.
        //
        // Only the trigger-activating case is blocked. Clearing rows the user could
        // actually see, or adding a trigger to a macro whose declarations were all
        // visible and removed, both stay legal.
        const existing = index >= 0 ? macros[index] : undefined;
        const hiddenDeclarations =
          existing !== undefined &&
          Array.isArray(existing.variables) &&
          existing.variables.length > getValidMacroVariables(existing).length;
        if (hiddenDeclarations && triggerPattern && variables.length === 0) {
          void this.panel.webview.postMessage({
            type: "saveError",
            field: "trigger",
            message:
              "This macro has malformed variable declarations that cannot be shown here, " +
              "and they are currently suppressing its auto-trigger. Clear the auto-trigger " +
              "pattern before saving, or delete and recreate the macro."
          });
          return;
        }

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
        const index = resolveUniqueMacroIndex(macros, macroId);
        const macro = index >= 0 ? macros[index] : undefined;
        if (!macro) {
          if (macroId !== null) {
            void vscode.window.showWarningMessage(
              isAmbiguousMacroId(macros, macroId)
                ? AMBIGUOUS_TARGET_MESSAGE
                : "This macro changed externally and could not be deleted. The editor has been refreshed."
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
   * Reports a rejection out of `handleMessage()`.
   *
   * `onDidReceiveMessage` is a VS Code EVENT listener, not a command handler. Nothing awaits
   * the promise it returns and nothing reports its rejection, so without this every failure in
   * `handleMessage()` is invisible: no notification, no in-panel error, and the webview keeps
   * showing "Unsaved changes" because only a `saved` message clears the dirty flag. Every other
   * `saveMacros()` / `replaceMacros()` call site in the extension is awaited inside a
   * registered command handler, where VS Code surfaces a rejection itself; this one is the
   * exception, and it is the primary secret-editing surface.
   *
   * The failure that reaches here in practice is `persist()` → `MacroStore.save()`. That store
   * fails CLOSED when it cannot write a macro's secret-id marker file (unwritable global
   * storage, a full disk, a dead network share) rather than write a vault entry nothing can
   * name — and because a save republishes every secret the window holds, the condition fails
   * EVERY save containing any secret macro, including an edit to an unrelated plain one. It has
   * to be reported, and it must never be reported as success.
   *
   * Both channels are used deliberately: the notification is what the user sees when the panel
   * is not focused, and the `#error-save` slot is what they see when it is — it sits beside the
   * Save button, so the dirty flag that (correctly) stayed set has its reason next to it.
   *
   * It does NOT re-render. `render()` rebuilds the webview from the STORE, which for a failed
   * save is the state the user's edit was never written into — so re-rendering here would
   * silently discard the edit the message is telling them was not saved, which is exactly the
   * outcome reporting the failure exists to avoid. The panel keeps the user's text, keeps the
   * dirty flag, and shows why.
   *
   * `messageType` is the failing message's `type`, used only to name the operation: the same
   * store call backs both Save and Delete, and reporting a failed delete as "could not save the
   * macro" describes the wrong action.
   */
  private reportHandlerFailure(err: unknown, messageType?: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    const action = messageType === "delete" ? "delete" : "save";
    void vscode.window.showErrorMessage(`Nexus could not ${action} the macro: ${detail}`);
    if (this.disposed) return;
    void this.panel.webview.postMessage({
      type: "saveError",
      field: "save",
      message: `Not ${action === "delete" ? "deleted" : "saved"}: ${detail}`
    });
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
