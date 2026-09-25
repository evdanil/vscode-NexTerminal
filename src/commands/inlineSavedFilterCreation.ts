import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { NexusCore } from "../core/nexusCore";
import type { WebviewFormPanel } from "../ui/webviewFormPanel";
import type { FormValues } from "../ui/formTypes";
import type { InventoryProvider } from "../models/inventory";
import { configMutationLock } from "../services/configMutationLock";
import { SAVED_FILTER_SELECT_KEY, inventoryConfigFieldPrefixedKey, savedFilterTarget } from "../ui/formDefinitions";

interface InlineSavedFilterContext {
  core: NexusCore;
  /** The source form's provider: its `savedFilterTarget` is the field this
   *  affordance saves from, and the one its message names (by the sanitized label). */
  provider: InventoryProvider;
}

export interface InlineSavedFilterCreationController {
  attachPanel(panel: WebviewFormPanel): void;
  handleCreateInline(key: string, values?: FormValues): void;
}

/**
 * SAVED FILTER DEFINITIONS (issue #48 PR-E) — the source form's "Save current
 * filter as…" affordance. Fired by the saved-filter select's `__create__`
 * sentinel, it reads the text the user has typed so far into the provider's
 * filter field (carried on the `createInline` message's `values` snapshot),
 * prompts for a name, saves a new `SavedFilterDefinition`, and appends it to the
 * picker so the user sees it land — mirroring `createInlineAuthProfileCreation`'s
 * shape, but with a plain prompt flow (no separate editor panel).
 *
 * The empty-state is constructive: with nothing typed yet, it explains what to do
 * rather than saving an empty definition — naming the field by the label this
 * provider gives it, since that is the field the user sees (issue #152).
 */
export function createInlineSavedFilterCreation(ctx: InlineSavedFilterContext): InlineSavedFilterCreationController {
  let panel: WebviewFormPanel | undefined;

  return {
    attachPanel(nextPanel) {
      panel = nextPanel;
      nextPanel.onDidDispose(() => {
        panel = undefined;
      });
    },
    handleCreateInline(key, values) {
      // No target field ⇒ the form rendered no picker, so nothing could have fired this.
      const target = savedFilterTarget(ctx.provider);
      if (key !== SAVED_FILTER_SELECT_KEY || !panel || target === undefined) {
        return;
      }
      const capturedPanel = panel;
      const rawFilter = values?.[inventoryConfigFieldPrefixedKey(target.field.id)];
      const currentFilter = typeof rawFilter === "string" ? rawFilter.trim() : "";
      void (async (): Promise<void> => {
        if (currentFilter === "") {
          void vscode.window.showWarningMessage(
            `${target.label} is empty — type a filter there first, then choose “Save current filter as…” to save it for reuse.`
          );
          return;
        }
        const name = await vscode.window.showInputBox({
          title: "Save Filter",
          prompt: "Name this saved filter so you can reuse it on other sources.",
          placeHolder: "e.g. Sydney core switches",
          value: "",
          // U4 — this box floats over the webview form; clicking back to the form
          // to re-check the filter must not silently dismiss it and save nothing.
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim().length === 0 ? "Enter a name." : undefined)
        });
        if (name === undefined) {
          return; // cancelled
        }
        const trimmedName = name.trim();
        if (trimmedName === "") {
          return;
        }
        const definition = { id: randomUUID(), name: trimmedName, filter: currentFilter };
        try {
          // FIX A (issue #48 PR-E / PR #64 Codex review round 2) — serialize the
          // persist under `configMutationLock`, the command-layer discipline the
          // device-template commands established (`saveTemplateRules` /
          // deviceTemplate delete). `addOrUpdateSavedFilter` is a lock-FREE core
          // primitive; without the lock, this inline write (fired from an open
          // inventory-source form) can interleave with a Complete Reset /
          // replace-import that snapshots-then-mutates under the same lock, so a
          // filter saved here could survive a reset that just reported all data
          // deleted. A fresh UUID means there is nothing to revalidate — the add
          // cannot collide with a concurrent edit — so the lock wraps the write
          // alone; the name prompt above already resolved outside it (never hold
          // the lock across interactive UI), and addSelectOption fires after it
          // releases (a webview post, not a config mutation).
          await configMutationLock.runExclusive(() => ctx.core.addOrUpdateSavedFilter(definition));
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Could not save the filter: ${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }
        // Append + select it in the picker (its synchronous fill re-affirms the
        // filter field with the same value it was saved from — a harmless no-op).
        // P1 — carry the definition's query as the option's description so the
        // just-saved row shows its query line immediately, like every other row,
        // rather than being the one row missing it until the form reopens.
        // FIX B — also carry the raw filter as the option's fillValue so re-picking
        // the just-saved row fills the filter field synchronously like any other.
        capturedPanel.addSelectOption(
          SAVED_FILTER_SELECT_KEY,
          definition.id,
          definition.name,
          definition.filter,
          definition.filter
        );
      })();
    }
  };
}
