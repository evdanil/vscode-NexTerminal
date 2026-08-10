import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { NexusCore } from "../core/nexusCore";
import type { WebviewFormPanel } from "../ui/webviewFormPanel";
import type { FormValues } from "../ui/formTypes";
import {
  SAVED_FILTER_SELECT_KEY,
  inventoryConfigFieldPrefixedKey,
  SAVED_FILTER_TARGET_FIELD_ID
} from "../ui/formDefinitions";

interface InlineSavedFilterContext {
  core: NexusCore;
}

export interface InlineSavedFilterCreationController {
  attachPanel(panel: WebviewFormPanel): void;
  handleCreateInline(key: string, values?: FormValues): void;
}

/**
 * SAVED FILTER DEFINITIONS (issue #48 PR-E) — the source form's "Save current
 * filter as…" affordance. Fired by the saved-filter select's `__create__`
 * sentinel, it reads the Device Filter text the user has typed so far (carried on
 * the `createInline` message's `values` snapshot), prompts for a name, saves a
 * new `SavedFilterDefinition`, and appends it to the picker so the user sees it
 * land — mirroring `createInlineAuthProfileCreation`'s shape, but with a plain
 * prompt flow (no separate editor panel).
 *
 * The empty-state is constructive: with no Device Filter typed yet, it explains
 * what to do rather than saving an empty definition.
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
      if (key !== SAVED_FILTER_SELECT_KEY || !panel) {
        return;
      }
      const capturedPanel = panel;
      const rawFilter = values?.[inventoryConfigFieldPrefixedKey(SAVED_FILTER_TARGET_FIELD_ID)];
      const currentFilter = typeof rawFilter === "string" ? rawFilter.trim() : "";
      void (async (): Promise<void> => {
        if (currentFilter === "") {
          void vscode.window.showWarningMessage(
            "Type a Device Filter first, then choose “Save current filter as…” to save it for reuse."
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
          await ctx.core.addOrUpdateSavedFilter(definition);
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Could not save the filter: ${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }
        // Append + select it in the picker (its autofill re-fills the Device
        // Filter with the same value it was saved from — a harmless no-op).
        // P1 — carry the definition's query as the option's description so the
        // just-saved row shows its query line immediately, like every other row,
        // rather than being the one row missing it until the form reopens.
        capturedPanel.addSelectOption(SAVED_FILTER_SELECT_KEY, definition.id, definition.name, definition.filter);
      })();
    }
  };
}
