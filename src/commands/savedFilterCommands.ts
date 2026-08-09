import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { CommandContext } from "./types";
import type { SavedFilterDefinition } from "../models/savedFilter";
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

const EMPTY_STATE = "No saved filters yet. Save one to reuse a Device Filter across inventory sources.";

async function promptFilterFields(seed?: SavedFilterDefinition): Promise<{ name: string; filter: string } | undefined> {
  const name = await vscode.window.showInputBox({
    title: seed ? "Rename Saved Filter" : "New Saved Filter",
    prompt: "Name this saved filter.",
    placeHolder: "e.g. Sydney core switches",
    value: seed?.name ?? "",
    validateInput: (v) => (v.trim().length === 0 ? "Enter a name." : undefined)
  });
  if (name === undefined) {
    return undefined;
  }
  const filter = await vscode.window.showInputBox({
    title: seed ? "Edit Filter Query" : "Filter Query",
    prompt: "The NetBox Device Filter query string this saved filter applies.",
    placeHolder: "e.g. role=core-switch&site=syd",
    value: seed?.filter ?? "",
    // An empty query is a legal catch-all (the Device Filter field admits ""),
    // so it is allowed here too — no validateInput rejecting a blank.
    ignoreFocusOut: true
  });
  if (filter === undefined) {
    return undefined;
  }
  return { name: name.trim(), filter };
}

async function addSavedFilter(ctx: CommandContext): Promise<void> {
  const fields = await promptFilterFields();
  if (!fields) {
    return;
  }
  try {
    await ctx.core.addOrUpdateSavedFilter({ id: randomUUID(), name: fields.name, filter: fields.filter });
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
  try {
    await ctx.core.addOrUpdateSavedFilter({ id: existing.id, name: fields.name, filter: fields.filter });
    void vscode.window.showInformationMessage(`Saved filter "${fields.name}" updated.`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not save the filter: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    { title: "Delete Saved Filter", placeHolder: "Select a saved filter to delete" }
  );
  if (!pick) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Delete saved filter "${pick.filter.name}"? Inventory sources that already use this filter keep their own copy — only the reusable definition is removed.`,
    { modal: true },
    "Delete"
  );
  if (confirm !== "Delete") {
    return;
  }
  try {
    await ctx.core.removeSavedFilter(pick.filter.id);
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
    { title: "Manage Saved Filters", placeHolder: "Select a saved filter to edit, create a new one, or delete one" }
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
