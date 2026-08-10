import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { CommandContext } from "./types";
import type { SavedFilterDefinition } from "../models/savedFilter";
import { configMutationLock } from "../services/configMutationLock";
import { naturalCompare } from "../utils/naturalCompare";

/**
 * SAVED FILTER DEFINITIONS (issue #48 PR-E, backlog #1) — the `nexus.savedFilter
 * .manage` palette command: a named library of reusable inventory Device Filter
 * queries. Mirrors the device-template / auth-profile manage idioms — a QuickPick
 * hub over list → add / edit / delete — but simpler: a saved filter is just a
 * name + query string with no secrets and no live references.
 *
 * A saved definition is a TEMPLATE TO COPY FROM, never a live reference (the
 * add/edit-source flow copies its `filter` into the source's own `config.filter`),
 * so deleting one here does NOT touch any source's stored filter — see
 * `NexusCore.removeSavedFilter`.
 */

const EMPTY_STATE =
  'No saved filters yet. Create one here, or use "Save current filter as…" next to a source\'s Device Filter.';

async function promptFilterFields(seed?: SavedFilterDefinition): Promise<{ name: string; filter: string } | undefined> {
  // U1/U4 — both steps are titled as one coherent 2-step progress flow that keeps
  // the "Saved Filter" context (not the old "Rename Saved Filter" / "Edit Filter
  // Query" split, which mis-titled the edit and hid the second step). `ignoreFocusOut`
  // on BOTH steps (U4) so clicking away on either does not silently abort the flow.
  const verb = seed ? "Edit" : "New";
  const name = await vscode.window.showInputBox({
    title: `${verb} Saved Filter (1/2) — Name`,
    prompt: "Name this saved filter.",
    placeHolder: "e.g. Sydney core switches",
    value: seed?.name ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "Enter a name." : undefined)
  });
  if (name === undefined) {
    return undefined;
  }
  const filter = await vscode.window.showInputBox({
    title: `${verb} Saved Filter (2/2) — Filter Query`,
    prompt: "The NetBox Device Filter query string this saved filter applies. Leave empty to match all devices.",
    placeHolder: "e.g. role=core-switch&site=syd",
    value: seed?.filter ?? "",
    // An empty query is a legal catch-all (the Device Filter field admits ""),
    // so it is allowed here too — no validateInput rejecting a blank.
    ignoreFocusOut: true
  });
  if (filter === undefined) {
    return undefined;
  }
  // P3 — trim the query, matching the inline "Save current filter as…" path.
  return { name: name.trim(), filter: filter.trim() };
}

/**
 * FIX A (issue #48 PR-E / PR #64 Codex review round 2) — every saved-filter
 * mutation is serialized through `configMutationLock` at the COMMAND layer, the
 * discipline the device-template loop established (`saveTemplateRules` /
 * deviceTemplate delete). `NexusCore`'s saved-filter CRUD stay lock-FREE
 * primitives; the lock lives here. Without it, a saved-filter write fired from an
 * open manage flow could interleave with a Complete Reset / replace-import (both
 * snapshot-then-mutate under this same lock), so a filter saved after a reset
 * reported "all data deleted" would survive it. The lock wraps the PERSIST only —
 * never an open InputBox/QuickPick — matching the reset/import and device-template
 * precedent (acquire after the last prompt resolves).
 */
async function addSavedFilter(ctx: CommandContext): Promise<void> {
  const fields = await promptFilterFields();
  if (!fields) {
    return;
  }
  try {
    // A fresh UUID cannot collide with a concurrent edit, so the add wraps the
    // write alone with nothing to revalidate.
    await configMutationLock.runExclusive(() =>
      ctx.core.addOrUpdateSavedFilter({ id: randomUUID(), name: fields.name, filter: fields.filter })
    );
    void vscode.window.showInformationMessage(`Saved filter "${fields.name}" created.`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not save the filter: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function editSavedFilter(ctx: CommandContext, existing: SavedFilterDefinition): Promise<void> {
  const fields = await promptFilterFields(existing);
  if (!fields) {
    return;
  }
  // FIX A — resolve-under-lock (the T1b discipline). The manage flow opens the
  // editor from a snapshot, then sits in the two prompts for an unbounded time; a
  // concurrent delete or another edit of the SAME id can land meanwhile. Re-read
  // the live record UNDER the lock and refuse (saving nothing) on divergence — a
  // now-missing id (deleted) or a name/filter that no longer matches the record we
  // opened (edited elsewhere) — rather than resurrecting or clobbering it. Saved
  // filters mint no `revision` (unlike device templates), so the value comparison
  // IS the divergence signal. The refusal toast fires after the lock releases.
  let refusal: string | undefined;
  try {
    await configMutationLock.runExclusive(async () => {
      const live = ctx.core.getSavedFilter(existing.id);
      if (live === undefined) {
        refusal =
          "This saved filter was deleted while the editor was open — nothing was saved. " +
          "Reopen Manage Saved Filters to create it again if you still need it.";
        return;
      }
      if (live.name !== existing.name || live.filter !== existing.filter) {
        refusal =
          "This saved filter was changed elsewhere while the editor was open — nothing was saved. " +
          "Reopen it to pick up the current version, then redo your edit.";
        return;
      }
      await ctx.core.addOrUpdateSavedFilter({ id: existing.id, name: fields.name, filter: fields.filter });
    });
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not save the filter: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (refusal !== undefined) {
    void vscode.window.showWarningMessage(refusal);
    return;
  }
  void vscode.window.showInformationMessage(`Saved filter "${fields.name}" updated.`);
}

async function deleteSavedFilterFlow(ctx: CommandContext): Promise<void> {
  const filters = ctx.core.getSnapshot().savedFilters;
  if (filters.length === 0) {
    return;
  }
  const pick = await vscode.window.showQuickPick(
    filters
      .slice()
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((f) => ({ label: f.name, description: f.filter || "(empty filter)", filter: f })),
    // P5 — matchOnDescription so typing a fragment of the query string finds the filter.
    { title: "Delete Saved Filter", placeHolder: "Select a saved filter to delete", matchOnDescription: true }
  );
  if (!pick) {
    return;
  }
  // P4 — the consequence sentence lives in the modal `detail` slot, mirroring the
  // device-template delete house style (deviceTemplateCommands.ts). Copy verbatim.
  const confirm = await vscode.window.showWarningMessage(
    `Delete saved filter "${pick.filter.name}"?`,
    {
      modal: true,
      detail:
        "Inventory sources that already use this filter keep their own copy — only the reusable definition is removed."
    },
    "Delete"
  );
  if (confirm !== "Delete") {
    return;
  }
  try {
    // FIX A — serialize the removal under `configMutationLock` (acquired after the
    // confirm modal resolves, never across it). `removeSavedFilter` is idempotent
    // — an already-gone id is a harmless no-op — and the modal's disclosure does
    // not depend on live state, so no divergence revalidation is needed beyond
    // that: the lock's job here is purely mutual exclusion against a Complete
    // Reset / replace-import running its own locked mutation phase.
    await configMutationLock.runExclusive(() => ctx.core.removeSavedFilter(pick.filter.id));
    void vscode.window.showInformationMessage(`Saved filter "${pick.filter.name}" deleted.`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not delete the filter: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function manageSavedFilters(ctx: CommandContext): Promise<void> {
  const filters = ctx.core.getSnapshot().savedFilters;
  if (filters.length === 0) {
    const choice = await vscode.window.showInformationMessage(EMPTY_STATE, "New Saved Filter");
    if (choice === "New Saved Filter") {
      await addSavedFilter(ctx);
    }
    return;
  }
  const NEW = "$(add) New Saved Filter";
  const DELETE = "$(trash) Delete a Saved Filter…";
  type ManageAction = "new" | "delete" | "edit";
  const pick = await vscode.window.showQuickPick(
    [
      { label: NEW, action: "new" as ManageAction, filter: undefined as SavedFilterDefinition | undefined },
      ...filters
        .slice()
        .sort((a, b) => naturalCompare(a.name, b.name))
        .map((f) => ({
          label: f.name,
          description: f.filter || "(empty filter)",
          action: "edit" as ManageAction,
          filter: f as SavedFilterDefinition | undefined
        })),
      { label: DELETE, action: "delete" as ManageAction, filter: undefined as SavedFilterDefinition | undefined }
    ],
    {
      title: "Manage Saved Filters",
      placeHolder: "Select a saved filter to edit, create a new one, or delete one",
      // P5 — matchOnDescription so typing a fragment of the query string finds the filter.
      matchOnDescription: true
    }
  );
  if (!pick) {
    return;
  }
  if (pick.action === "new") {
    await addSavedFilter(ctx);
    return;
  }
  if (pick.action === "delete") {
    await deleteSavedFilterFlow(ctx);
    return;
  }
  if (pick.filter) {
    await editSavedFilter(ctx, pick.filter);
  }
}

export function registerSavedFilterCommands(ctx: CommandContext): vscode.Disposable[] {
  return [vscode.commands.registerCommand("nexus.savedFilter.manage", () => manageSavedFilters(ctx))];
}
