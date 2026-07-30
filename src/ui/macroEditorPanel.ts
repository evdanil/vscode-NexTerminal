import * as vscode from "vscode";
import { isValidBinding } from "../macroBindings";
import {
  assignBinding,
  normalizeBinding
} from "../macroBindingHelpers";
import {
  confirmBindingWarnings,
  getActiveMacroStore,
  getMacroFolders,
  getMacros,
  saveMacros
} from "../macroSettings";
import type { MacroVariable, TerminalMacro } from "../models/terminalMacro";
import { DEFAULT_TRIGGER_COOLDOWN } from "../services/macroAutoTrigger";
import { getValidMacroVariables, MAX_MACRO_VARIABLES, validateMacroVariables } from "../services/macroVariables";
import { collectMacroFolders, macroFolderField } from "../services/macroFolders";
import {
  mutateMacro,
  resolveMacroTarget,
  AMBIGUOUS_MACRO_TARGET_MESSAGE,
  type MacroTarget
} from "../services/macroMutation";
import { normalizeOptionalFolderPath, INVALID_FOLDER_PATH_MESSAGE } from "../utils/folderPaths";
import { validateRegexSafety } from "../utils/regexSafety";
import { renderMacroEditorHtml } from "./macroEditorHtml";
import type { MacroProfileOptionInput } from "./macroProfileOptions";
import { createWebviewNonce } from "./shared/webviewNonce";

type MacroProfileProvider = () => MacroProfileOptionInput[];

/**
 * Resolves the save/delete target by stable id, never by the render-time array index:
 * an external reorder or delete between render and save would otherwise hit the wrong
 * macro.
 *
 * The shared `resolveMacroTarget` takes an optional index precisely so a clicked ROW
 * can disambiguate two macros sharing an id. The panel deliberately passes none. Its
 * webview payload's `index` is a RENDER-time position that survives arbitrarily long
 * — the panel stays open across any number of external writes and even clamps
 * `selectedIndex` when the list shrinks — so it is not the "the user just pointed at
 * this row" signal a tree item's index is. With no index, an id claimed by more than
 * one macro resolves to `"ambiguous"` and the panel refuses, exactly as it always
 * has: writing the macro the user was looking at over its twin would silently destroy
 * the twin, and refusing is the same fail-safe `MacroAutoTrigger` applies to an
 * ambiguous state key. Every other repair route (Move Up / Move Down, delete, or
 * editing any macro with a unique id) re-saves the whole list and clears the
 * conflict, so this is never a dead end.
 */
function resolveEditorTarget(macros: readonly TerminalMacro[], macroId: string | null): MacroTarget {
  return resolveMacroTarget(macros, { id: macroId });
}

/** The right thing to say for a target that could not be resolved to one macro. */
function unresolvedTargetMessage(target: MacroTarget, verb: "saved" | "deleted"): string {
  return target.kind === "ambiguous"
    ? AMBIGUOUS_MACRO_TARGET_MESSAGE
    : `This macro changed externally and could not be ${verb}. The editor has been refreshed.`;
}

/** §4.7 `addToFolder` seeds a new macro's Folder field with the clicked folder. */
export interface MacroEditorSeed {
  group?: string;
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
  /** Set only by `openNew(seed)`; consumed while composing that one new macro (§4.7). */
  private pendingSeedGroup: string | undefined;
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

  private constructor(initialIndex: number | null, seedGroup?: string) {
    this.selectedIndex = initialIndex;
    this.pendingSeedGroup = seedGroup;
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
    // Re-render when the macro store changes underneath us so index/id
    // resolution stays current. "Underneath us" means THIS window: the store's
    // change event fires only for this instance's own `save()` / `saveFolders()`
    // / `clearAll()`, so the writers are a macro command, a drag onto a folder,
    // a config import, or legacy absorption at activation. A second window's
    // `globalState` write is invisible here until reload — `Memento` has no
    // change event.
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

  public static openNew(seed?: MacroEditorSeed): void {
    if (MacroEditorPanel.instance) {
      MacroEditorPanel.instance.panel.reveal();
      MacroEditorPanel.instance.selectedIndex = null;
      MacroEditorPanel.instance.pendingSeedGroup = seed?.group;
      MacroEditorPanel.instance.render();
      return;
    }
    MacroEditorPanel.instance = new MacroEditorPanel(null, seed?.group);
  }

  private render(): void {
    if (this.disposed) return;
    const nonce = createWebviewNonce();
    const macros = getMacros();
    // Clamp selectedIndex if macros changed externally
    if (this.selectedIndex !== null && this.selectedIndex >= macros.length) {
      this.selectedIndex = macros.length > 0 ? macros.length - 1 : null;
    }
    // §4.11 — the seed only ever applies while composing a not-yet-saved new
    // macro; irrelevant once an existing macro is selected.
    const seedGroup = this.selectedIndex === null ? this.pendingSeedGroup : undefined;
    const folders = collectMacroFolders(macros, getMacroFolders());
    this.panel.webview.html = renderMacroEditorHtml(macros, this.selectedIndex, nonce, MacroEditorPanel.profileProvider(), folders, seedGroup);
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "selectMacro": {
        const value = msg.value as string;
        if (value === "__new__") {
          this.selectedIndex = null;
          // A user-driven "+ New Blank Macro" pick, not the addToFolder seed
          // path — an earlier seed must not leak into this genuinely blank macro.
          this.pendingSeedGroup = undefined;
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
            this.pendingSeedGroup = undefined;
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
        const target = resolveEditorTarget(macros, macroId);
        if (macroId !== null && target.kind !== "resolved") {
          // The macro we were editing was deleted/changed externally, or its id is
          // shared with another macro. Do not fall through to the push path (that
          // would create a stray duplicate) and do not guess a target.
          void vscode.window.showWarningMessage(unresolvedTargetMessage(target, "saved"));
          this.render();
          return;
        }
        // The one read of the stored record, hoisted above the Folder-field
        // logic below (which needs it) and shared with the hidden-declaration
        // check further down, which used to re-derive the identical value.
        const existingMacro = target.kind === "resolved" ? macros[target.index] : undefined;
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

        // §4.11 — Folder field validation, same helper every profile form uses.
        // "" canonicalizes to `undefined` (§4.1); anything else structurally
        // invalid (`..`, `.`, `\`, over-depth) is rejected rather than silently
        // dropped, since here (unlike ingest, §4.2) the user is right there to fix it.
        //
        // ...but ONLY when the user actually touched the field. §4.9.3 promises
        // that a stored folder path is "kept byte-for-byte and shown at the
        // root until you correct it", and this handler was the one place that
        // broke the promise: for a stored `Cisco\Routers` the renderer produced
        // an EMPTY Folder field, the webview posted `group: null`, and the
        // unconditional `delete macro.group` below destroyed the value on a
        // save that only changed the macro's NAME — the most ordinary write
        // path there is. `macroFolderField()` is the single shared definition
        // of what the field shows for a given stored value (see its doc
        // comment), so "the submitted text still equals the stored value's
        // field representation" is exactly "the user did not touch it", and
        // that case is carried through verbatim, unvalidated. Any real edit
        // goes through the grammar as before — so an unrenderable path the
        // user does touch forces an explicit, validated decision.
        const groupInput = typeof msg.group === "string" ? msg.group : "";
        const folderUntouched =
          existingMacro !== undefined && groupInput.trim() === macroFolderField(existingMacro.group).value;
        const normalizedGroup = folderUntouched ? undefined : normalizeOptionalFolderPath(groupInput);
        if (normalizedGroup === null) {
          void this.panel.webview.postMessage({
            type: "saveError",
            field: "folder",
            message: INVALID_FOLDER_PATH_MESSAGE
          });
          return;
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
        const hiddenDeclarations =
          existingMacro !== undefined &&
          Array.isArray(existingMacro.variables) &&
          existingMacro.variables.length > getValidMacroVariables(existingMacro).length;
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
        // §4.1 — "" canonicalizes to `undefined`; only a non-empty normalized
        // path is ever persisted. The untouched case re-attaches the stored
        // string byte-for-byte instead (see the Folder-field comment above);
        // the `delete` first keeps this in the same delete-then-re-add shape
        // as `variables` (§9.5), so nothing survives the spread by accident.
        delete macro.group;
        if (folderUntouched) {
          if (typeof existingMacro?.group === "string") macro.group = existingMacro.group;
        } else if (normalizedGroup) {
          macro.group = normalizedGroup;
        }
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
        if (normalizedBinding && !isValidBinding(normalizedBinding)) {
          break;
        }
        if (normalizedBinding && !(await confirmBindingWarnings(normalizedBinding))) {
          break;
        }

        // `confirmBindingWarnings` is a NON-modal `showWarningMessage`
        // (macroSettings.ts) — the window stays fully interactive while its
        // "Use Anyway / Cancel" toast is up, and the panel's own store
        // subscription re-renders from concurrent writes, so they are plainly
        // expected here. Writing back `macros` — read before that await — then
        // silently reverted whatever landed in between (a macro dragged into a
        // folder, a `moveToFolder`, an import), and `assignBinding`'s
        // clear-the-binding-from-every-other-macro pass compounded it across
        // the whole stale array. Re-resolve by id against a freshly read array,
        // exactly as every macro command now does.
        if (macroId !== null) {
          let savedIndex = -1;
          const outcome = await this.withSaveGuard(() =>
            mutateMacro({ id: macroId }, (latest, i) => {
              savedIndex = i;
              // `macro` was composed from the PRE-dialog record, so every field
              // on it is either something the user typed in this form or
              // something copied off that snapshot. For the fields the form
              // owns, overwriting is the point. `group` is the exception when
              // the Folder field was untouched: the value being written back is
              // then not a user decision at all, it is a copy of what the store
              // held before the dialog — so a folder move that landed while the
              // non-modal binding warning was up (a drag onto a folder,
              // `moveToFolder`) got silently reverted by a save that only
              // changed the macro's NAME. Re-read the folder off the LATEST
              // record instead, which is the same rule the untouched-field
              // branch below already applies, just against fresh data.
              if (folderUntouched) {
                delete macro.group;
                if (typeof latest[i].group === "string") macro.group = latest[i].group;
              }
              latest[i] = macro;
              if (normalizedBinding) {
                assignBinding(latest, i, normalizedBinding);
              }
            })
          );
          if (outcome !== "saved") {
            void vscode.window.showWarningMessage(
              outcome === "ambiguous"
                ? AMBIGUOUS_MACRO_TARGET_MESSAGE
                : "This macro changed externally and could not be saved. The editor has been refreshed."
            );
            this.render();
            break;
          }
          this.selectedIndex = savedIndex;
        } else {
          // A brand-new macro has no id to re-resolve, so the append is the
          // whole operation; it still reads the array fresh rather than
          // reusing the pre-dialog snapshot.
          const latest = getMacros();
          latest.push(macro);
          const newIndex = latest.length - 1;
          if (normalizedBinding) {
            assignBinding(latest, newIndex, normalizedBinding);
          }
          await this.persist(latest);
          this.selectedIndex = newIndex;
        }

        this.render();
        void this.panel.webview.postMessage({ type: "saved" });
        break;
      }
      case "delete": {
        const macroId = typeof msg.id === "string" && msg.id.length > 0 ? msg.id : null;
        const macros = getMacros();
        // Resolve by stable id; the render-time index may be stale.
        const target = resolveEditorTarget(macros, macroId);
        if (target.kind !== "resolved") {
          if (macroId !== null) {
            void vscode.window.showWarningMessage(unresolvedTargetMessage(target, "deleted"));
            this.render();
          }
          break;
        }
        const index = target.index;
        const macro = macros[index];

        const confirm = await vscode.window.showWarningMessage(
          `Delete macro "${macro.name}"?`,
          { modal: true },
          "Delete"
        );
        if (confirm !== "Delete") break;

        // Same discipline as the save path above. `{ modal: true }` blocks the
        // USER, not the extension host: an auto-trigger write, a watcher, or an
        // import can still land while the confirmation is up, and splicing a
        // pre-dialog snapshot would discard it.
        let deletedIndex = index;
        const outcome = await this.withSaveGuard(() =>
          mutateMacro({ id: macroId }, (latest, i) => {
            deletedIndex = i;
            latest.splice(i, 1);
          })
        );
        if (outcome !== "saved") {
          void vscode.window.showWarningMessage(
            outcome === "ambiguous"
              ? AMBIGUOUS_MACRO_TARGET_MESSAGE
              : "This macro changed externally and could not be deleted. The editor has been refreshed."
          );
          this.render();
          break;
        }
        const remaining = getMacros();
        this.selectedIndex = remaining.length > 0 ? Math.min(deletedIndex, remaining.length - 1) : null;
        this.render();
        break;
      }
    }
  }

  /**
   * Run a write while suppressing the store's change-event re-render for our
   * own save, so a self-save does not race the explicit `render()` calls in the
   * save/delete handlers (which set `selectedIndex` to the just-applied target).
   *
   * Every path that persists must go through this, including
   * `mutateMacro` — that helper calls `saveMacros()` directly, which would
   * otherwise fire the store's change event straight back into this panel's own
   * subscription mid-flow.
   */
  private async withSaveGuard<T>(run: () => Promise<T>): Promise<T> {
    this.isSaving = true;
    try {
      return await run();
    } finally {
      this.isSaving = false;
    }
  }

  private async persist(macros: TerminalMacro[]): Promise<void> {
    await this.withSaveGuard(() => saveMacros(macros));
  }
}
