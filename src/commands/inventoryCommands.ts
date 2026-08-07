import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { ServerConfig } from "../models/config";
import {
  InventoryProviderError,
  inventorySecretKey,
  inventorySourceValuesEqual,
  sourceConfigUnchanged,
  type InventoryConfigField,
  type InventoryPrunePolicy,
  type InventoryProvider,
  type InventorySourceConfig,
  type InventorySourceSecrets,
  type InventorySourceValues,
  type InventoryTree
} from "../models/inventory";
import type { InventoryProviderRegistry } from "../services/inventory/providerRegistry";
import {
  ORPHAN_FOLDER_NAME,
  computeSyncPlan,
  planToApplication,
  prunedServerIdsForSecretCleanup,
  validateInventoryTree,
  type InventorySyncPlan
} from "../services/inventory/syncEngine";
import type { SecretVault } from "../services/ssh/contracts";
import { passphraseSecretKey, passwordSecretKey, proxyPasswordSecretKey } from "../services/ssh/silentAuth";
import { INVALID_FOLDER_PATH_MESSAGE, normalizeOptionalFolderPath } from "../utils/folderPaths";
import { mostCommonUsername } from "./configCommands";

/**
 * F1 — server runtime teardown, injected from extension.ts (mirrors the
 * disconnect/stop-tunnels/sshPool.disconnect sequence in serverCommands.ts's
 * remove flow). Called for every server id about to be deleted, BEFORE
 * applyInventorySyncPlan, by both syncNow (prune "delete") and removeSource
 * ("Delete Servers") — this module never touches ssh/tunnel plumbing directly.
 */
export interface InventoryRuntimeTeardown {
  teardownServerRuntime(serverId: string): Promise<void>;
}

function providerMissingMessage(providerId: string): string {
  return `Provider "${providerId}" not available (the extension providing it may be disabled).`;
}

/**
 * ITEM 9 — best-effort secret delete for post-apply/post-removal cleanup
 * steps that must not abort a primary operation that has already succeeded
 * (servers removed / plan applied) just because clearing one now-orphaned
 * vault key failed. Logs and continues so the remaining keys in the batch
 * still get their own delete attempt.
 */
async function deleteSecretBestEffort(vault: SecretVault, key: string): Promise<void> {
  try {
    await vault.delete(key);
  } catch (error) {
    console.warn(`[Nexus] Failed to delete secret key "${key}":`, error);
  }
}

function describeInventoryError(error: unknown): string {
  if (error instanceof InventoryProviderError) {
    const prefix = error.kind === "auth" ? "Authentication failed" : error.kind === "network" ? "Network error" : "Unexpected response";
    return `${prefix}: ${error.message}`;
  }
  return String(error);
}

function formatLastSync(source: InventorySourceConfig): string {
  if (!source.lastSyncAt) return "never synced";
  const minutes = Math.floor((Date.now() - source.lastSyncAt) / 60_000);
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `synced ${hours}h ago`;
  return `synced ${Math.floor(hours / 24)}d ago`;
}

function sourceDescription(source: InventorySourceConfig, registry: InventoryProviderRegistry): string {
  const providerLabel = registry.get(source.providerId)?.label ?? source.providerId;
  return `${providerLabel} — ${formatLastSync(source)}`;
}

/** Auto-picks when exactly one source exists; warns and returns undefined when there are none. */
async function pickInventorySource(core: NexusCore, registry: InventoryProviderRegistry): Promise<InventorySourceConfig | undefined> {
  const sources = core.getSnapshot().inventorySources;
  if (sources.length === 0) {
    void vscode.window.showWarningMessage("No inventory sources configured. Add one first.");
    return undefined;
  }
  if (sources.length === 1) {
    return sources[0];
  }
  const pick = await vscode.window.showQuickPick(
    sources.map((source) => ({ label: source.name, description: sourceDescription(source, registry), source })),
    { title: "Select Inventory Source" }
  );
  return pick?.source;
}

async function promptProviderPick(registry: InventoryProviderRegistry): Promise<InventoryProvider | undefined> {
  const providers = registry.list();
  if (providers.length === 0) {
    void vscode.window.showErrorMessage("No inventory providers are registered.");
    return undefined;
  }
  if (providers.length === 1) {
    return providers[0];
  }
  const pick = await vscode.window.showQuickPick(
    providers.map((provider) => ({ label: provider.label, provider })),
    { title: "Select Inventory Provider" }
  );
  return pick?.provider;
}

/**
 * Loops on an empty target folder: warns (top level is unusual, not forbidden)
 * and offers "Choose Folder" to re-prompt instead of silently proceeding.
 * Returns undefined on outright cancellation (Escape / dismiss).
 */
async function promptTargetFolder(initialValue = ""): Promise<string | undefined> {
  let seed = initialValue;
  for (;;) {
    const input = await vscode.window.showInputBox({
      title: "Target Folder",
      prompt: 'Servers synced from this source are placed under this folder. Leave empty for the top level.',
      value: seed,
      ignoreFocusOut: true,
      validateInput: (value) => (normalizeOptionalFolderPath(value) === null ? INVALID_FOLDER_PATH_MESSAGE : undefined)
    });
    if (input === undefined) return undefined;
    const normalized = normalizeOptionalFolderPath(input) ?? "";
    if (normalized !== "") {
      return normalized;
    }
    const choice = await vscode.window.showWarningMessage(
      "No target folder selected — synced servers will be placed at the top level. Continue?",
      { modal: true },
      "Continue",
      "Choose Folder"
    );
    if (choice === "Continue") return "";
    if (choice === "Choose Folder") {
      seed = "";
      continue;
    }
    return undefined;
  }
}

/**
 * FIX 7 — when editing an existing source, the item matching the currently
 * saved value gets " (current)" appended to its description and is listed
 * first, so the picker doesn't read as a blank slate. `current` is omitted
 * entirely on addSource (nothing saved yet) and the list keeps its default
 * order.
 */
async function promptPrunePolicy(targetFolder: string, current?: InventoryPrunePolicy): Promise<InventoryPrunePolicy | undefined> {
  const orphanTarget = targetFolder ? `${targetFolder}/${ORPHAN_FOLDER_NAME}` : ORPHAN_FOLDER_NAME;
  const items = [
    { label: `Move to "${orphanTarget}"`, description: "Recommended — keeps synced settings if the device returns", value: "orphan" as const },
    { label: "Delete", description: "Removes the server and its saved credentials", value: "delete" as const },
    { label: "Keep", description: "Leaves the server where it is", value: "keep" as const }
  ].map((item) => (item.value === current ? { ...item, description: `${item.description} (current)` } : item));
  const ordered = current ? [...items.filter((i) => i.value === current), ...items.filter((i) => i.value !== current)] : items;
  const pick = await vscode.window.showQuickPick(ordered, { title: "When a device disappears from the source…" });
  return pick?.value;
}

interface ConfigFieldsResult {
  config: InventorySourceValues;
  secrets: InventorySourceSecrets;
}

/**
 * Sequential prompts, one per provider config field. `existingSecretFieldIds`
 * marks which password fields already have a saved vault value (edit flow) —
 * those may be left blank to keep the saved value; everything else required
 * must be non-empty. Returns undefined on cancellation at any step.
 */
async function promptConfigFields(
  fields: InventoryConfigField[],
  existingConfig: InventorySourceValues,
  existingSecretFieldIds: ReadonlySet<string>
): Promise<ConfigFieldsResult | undefined> {
  const config: InventorySourceValues = {};
  const secrets: InventorySourceSecrets = {};

  for (const field of fields) {
    if (field.type === "boolean") {
      // FIX 7 — mark whichever option matches the saved config value (edit
      // flow) and list it first; addSource has no `existingConfig` entry for
      // the field, so neither option is marked and the default order holds.
      const current = existingConfig[field.id];
      const items = [
        { label: "Yes", value: true, description: current === true ? "(current)" : undefined },
        { label: "No", value: false, description: current === false ? "(current)" : undefined }
      ];
      const ordered = current === false ? [items[1], items[0]] : items;
      const pick = await vscode.window.showQuickPick(ordered, { title: field.label, placeHolder: field.description });
      if (pick === undefined) return undefined;
      config[field.id] = pick.value;
      continue;
    }

    if (field.type === "password") {
      const hasSaved = existingSecretFieldIds.has(field.id);
      const value = await vscode.window.showInputBox({
        title: field.label,
        prompt: field.description,
        placeHolder: hasSaved ? "Leave empty to keep the saved value" : field.placeholder,
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (field.required && !v && !hasSaved ? `${field.label} is required` : undefined)
      });
      if (value === undefined) return undefined;
      if (value !== "") {
        secrets[field.id] = value;
      }
      continue;
    }

    const existingValue = existingConfig[field.id];
    const value = await vscode.window.showInputBox({
      title: field.label,
      prompt: field.description,
      placeHolder: field.placeholder,
      value: existingValue !== undefined ? String(existingValue) : "",
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (field.required && !v.trim()) return `${field.label} is required`;
        if (field.type === "number" && v.trim() && !Number.isFinite(Number(v))) return "Must be a number";
        return undefined;
      }
    });
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    if (trimmed === "") {
      continue; // optional empty -> omitted from config
    }
    config[field.id] = field.type === "number" ? Number(trimmed) : trimmed;
  }

  return { config, secrets };
}

async function testConnectionWithRetry(
  provider: InventoryProvider,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets
): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Testing connection to "${provider.label}"…` },
      () => provider.testConnection(config, secrets)
    );
    return true;
  } catch (error) {
    const choice = await vscode.window.showErrorMessage(
      `Connection test failed: ${describeInventoryError(error)}`,
      "Save Anyway",
      "Cancel"
    );
    return choice === "Save Anyway";
  }
}

async function openInventoryIssuesText(lines: string[]): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content: lines.join("\n"), language: "log" });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** F16 — servers not themselves being removed whose SSH jump host is among `removedIds`. */
function countJumpHostDependents(allServers: ServerConfig[], removedIds: ReadonlySet<string>): number {
  return allServers.filter((s) => !removedIds.has(s.id) && s.proxy?.type === "ssh" && removedIds.has(s.proxy.jumpHostId)).length;
}

function describePlanDetail(plan: InventorySyncPlan, allServers: ServerConfig[]): string {
  const lines: string[] = [];
  if (plan.adds.length > 0) lines.push(`${plan.adds.length} added`);
  // FIX 3 — aggregate manual-duplicate count (engine-computed, not
  // string-parsed from plan.warnings) surfaced once in the modal, rather than
  // leaving it discoverable only by opening the per-device warnings list.
  if (plan.manualDuplicateCount > 0) {
    const n = plan.manualDuplicateCount;
    const verb = n === 1 ? "matches" : "match";
    lines.push(`${n} device${n === 1 ? "" : "s"} ${verb} existing manual servers and will be added as duplicates.`);
  }
  if (plan.updates.length > 0) lines.push(`${plan.updates.length} updated`);
  const orphaned = plan.prunes.filter((p) => p.policy === "orphan").length;
  const deleted = plan.prunes.filter((p) => p.policy === "delete").length;
  const kept = plan.prunes.filter((p) => p.policy === "keep").length;
  if (orphaned > 0) lines.push(`${orphaned} moved to _orphaned`);
  if (deleted > 0) lines.push(`${deleted} deleted (including saved passwords)`);
  if (kept > 0) lines.push(`${kept} kept`);
  lines.push(`${plan.unchangedCount} unchanged`);
  if (plan.hiddenPruneCount > 0) lines.push(`(includes ${plan.hiddenPruneCount} hidden)`);
  if (plan.warnings.length > 0) lines.push(`${plan.warnings.length} warning${plan.warnings.length === 1 ? "" : "s"}`);
  if (deleted > 0) {
    const deletedIds = new Set(plan.prunes.filter((p) => p.policy === "delete").map((p) => p.server.id));
    const dependents = countJumpHostDependents(allServers, deletedIds);
    if (dependents > 0) {
      const verb = dependents === 1 ? "uses" : "use";
      lines.push(`${dependents} other server${dependents === 1 ? "" : "s"} ${verb} these as SSH jump hosts.`);
    }
  }
  return lines.join("\n");
}

/** The set of server ids the plan would actually delete (prune policy "delete"). */
function deletePruneIds(plan: InventorySyncPlan): Set<string> {
  return new Set(plan.prunes.filter((p) => p.policy === "delete").map((p) => p.server.id));
}

// FINDING 1 — counts alone can match while the actual set of servers slated
// for deletion differs (e.g. a concurrent import added an owned server absent
// from the fetched tree, and something else's delete count happened to drop
// by one) — compare the prune-"delete" server-id set too, not just counts.
function planCountsEqual(a: InventorySyncPlan, b: InventorySyncPlan): boolean {
  if (
    a.adds.length !== b.adds.length ||
    a.updates.length !== b.updates.length ||
    a.prunes.length !== b.prunes.length ||
    a.unchangedCount !== b.unchangedCount
  ) {
    return false;
  }
  const idsA = deletePruneIds(a);
  const idsB = deletePruneIds(b);
  if (idsA.size !== idsB.size) {
    return false;
  }
  for (const id of idsA) {
    if (!idsB.has(id)) {
      return false;
    }
  }
  return true;
}

export function registerInventoryCommands(
  core: NexusCore,
  registry: InventoryProviderRegistry,
  vault: SecretVault,
  teardown: InventoryRuntimeTeardown
): vscode.Disposable[] {
  // F4 — shared by all four commands: syncNow holds a source's id for its whole
  // run; editSource/removeSource hold it for their whole run too (they mutate
  // servers/secrets); every command refuses to start work on a source another
  // command already marked busy.
  const inFlightSourceIds = new Set<string>();

  async function addSource(): Promise<void> {
    const provider = await promptProviderPick(registry);
    if (!provider) return;

    const nameInput = await vscode.window.showInputBox({
      title: "Inventory Source Name",
      value: provider.label,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Name is required")
    });
    if (nameInput === undefined) return;
    const name = nameInput.trim();

    const targetFolder = await promptTargetFolder();
    if (targetFolder === undefined) return;

    const defaultUsernameInput = await vscode.window.showInputBox({
      title: "Default SSH Username",
      prompt: "Used when the inventory source doesn't provide a username.",
      value: mostCommonUsername(core.getSnapshot().servers),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Username is required")
    });
    if (defaultUsernameInput === undefined) return;
    const defaultUsername = defaultUsernameInput.trim();

    const prunePolicy = await promptPrunePolicy(targetFolder);
    if (!prunePolicy) return;

    const fieldsResult = await promptConfigFields(provider.configFields, {}, new Set());
    if (!fieldsResult) return;
    const { config, secrets } = fieldsResult;

    const ok = await testConnectionWithRetry(provider, config, secrets);
    if (!ok) return;

    const id = randomUUID();
    const passwordFieldIds = provider.configFields.filter((f) => f.type === "password").map((f) => f.id);

    // FINDING 2 — secretFieldIds records only ids ACTUALLY stored to the vault
    // this run. A password field that is optional and left blank never gets a
    // vault entry, so it must not appear here either — otherwise syncNow's
    // missing-secret guard would later error on a vault key that was never
    // written, making the source unsyncable despite the field being genuinely
    // optional.
    const secretFieldIds: string[] = [];

    // F18 — secrets to vault FIRST; only on success does the source record get created.
    try {
      for (const fieldId of passwordFieldIds) {
        const value = secrets[fieldId];
        if (value !== undefined) {
          await vault.store(inventorySecretKey(id, fieldId), value);
          secretFieldIds.push(fieldId);
        }
      }
    } catch {
      // FINDING B — a later field's store rejecting after earlier ones
      // succeeded must not orphan those earlier keys: the source is never
      // created on this path, so nothing will ever enumerate secretFieldIds
      // to clean them up. Best-effort delete everything written this run.
      for (const fieldId of secretFieldIds) {
        try {
          await vault.delete(inventorySecretKey(id, fieldId));
        } catch {
          // best-effort rollback — ignore
        }
      }
      void vscode.window.showErrorMessage("Could not store credentials in the system keychain — the source was not created.");
      return;
    }

    const source: InventorySourceConfig = { id, providerId: provider.id, name, targetFolder, prunePolicy, defaultUsername, config, secretFieldIds };

    // FINDING 1 — if persisting the new source record fails, the vault keys
    // just written above have no source to be enumerated/cleaned up by, so
    // they'd be orphaned forever. Roll them back (best-effort — a delete
    // failure here must not mask the original persistence error) and report
    // that the source was not created.
    try {
      await core.addOrUpdateInventorySource(source);
    } catch {
      for (const fieldId of secretFieldIds) {
        try {
          await vault.delete(inventorySecretKey(id, fieldId));
        } catch {
          // best-effort rollback — ignore
        }
      }
      void vscode.window.showErrorMessage(`Could not save inventory source "${name}" — the source was not created.`);
      return;
    }

    const choice = await vscode.window.showInformationMessage(`Inventory source "${name}" added.`, "Sync Now");
    if (choice === "Sync Now") {
      await vscode.commands.executeCommand("nexus.inventory.syncNow", id);
    }
  }

  async function editSource(): Promise<void> {
    const source = await pickInventorySource(core, registry);
    if (!source) return;
    if (inFlightSourceIds.has(source.id)) {
      void vscode.window.showWarningMessage(`"${source.name}" is currently syncing — try again once the sync finishes.`);
      return;
    }
    const provider = registry.get(source.providerId);
    if (!provider) {
      void vscode.window.showErrorMessage(providerMissingMessage(source.providerId));
      return;
    }

    inFlightSourceIds.add(source.id);
    try {
      const nameInput = await vscode.window.showInputBox({
        title: "Inventory Source Name",
        value: source.name,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : "Name is required")
      });
      if (nameInput === undefined) return;
      const name = nameInput.trim();

      const targetFolder = await promptTargetFolder(source.targetFolder);
      if (targetFolder === undefined) return;

      const defaultUsernameInput = await vscode.window.showInputBox({
        title: "Default SSH Username",
        value: source.defaultUsername,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : "Username is required")
      });
      if (defaultUsernameInput === undefined) return;
      const defaultUsername = defaultUsernameInput.trim();

      const prunePolicy = await promptPrunePolicy(targetFolder, source.prunePolicy);
      if (!prunePolicy) return;

      const existingSecretFieldIds = new Set(source.secretFieldIds);
      const fieldsResult = await promptConfigFields(provider.configFields, source.config, existingSecretFieldIds);
      if (!fieldsResult) return;
      const { config, secrets: reenteredSecrets } = fieldsResult;

      // F7 — hydrate every kept (blank) secret field from the vault BEFORE testConnection,
      // so the test exercises the value that will actually be used, not an empty string.
      const secretsForTest: InventorySourceSecrets = { ...reenteredSecrets };
      for (const fieldId of source.secretFieldIds) {
        if (secretsForTest[fieldId] === undefined) {
          const stored = await vault.get(inventorySecretKey(source.id, fieldId));
          if (stored !== undefined) secretsForTest[fieldId] = stored;
        }
      }

      const ok = await testConnectionWithRetry(provider, config, secretsForTest);
      if (!ok) return;

      // F18 — vault writes first; only re-entered secrets are stored, so a blank field
      // leaves its previously saved value untouched.
      // FINDING 1 — track which of those writes are for fields NOT already in
      // the old secretFieldIds (i.e. brand-new secrets for this source, as
      // opposed to an overwrite of a value that already existed).
      // FINDING C — a re-entered field that WAS already in the old
      // secretFieldIds gets its pre-write value captured here, BEFORE the
      // overwrite, so a failed persist below can put it back — the previous
      // rollback only deleted newly-added keys, leaving an overwritten token
      // stuck at its new value even though the source record reverted to old.
      const newlyWrittenFieldIds: string[] = [];
      const overwrittenPreviousValues = new Map<string, string>();

      // ITEM 3/4 shared rollback — best-effort delete of everything newly
      // written this run and best-effort restore of everything overwritten
      // this run. Used both when the store loop itself fails partway through
      // (ITEM 3) and when a pre-persist drift check aborts after the loop
      // completed successfully (ITEM 4).
      const rollbackThisRunsVaultWrites = async (): Promise<void> => {
        for (const fieldId of newlyWrittenFieldIds) {
          try {
            await vault.delete(inventorySecretKey(source.id, fieldId));
          } catch {
            // best-effort rollback — ignore
          }
        }
        for (const [fieldId, previousValue] of overwrittenPreviousValues) {
          try {
            await vault.store(inventorySecretKey(source.id, fieldId), previousValue);
          } catch {
            // best-effort rollback — ignore
          }
        }
      };

      try {
        for (const [fieldId, value] of Object.entries(reenteredSecrets)) {
          if (existingSecretFieldIds.has(fieldId)) {
            const previousValue = await vault.get(inventorySecretKey(source.id, fieldId));
            if (previousValue !== undefined) {
              overwrittenPreviousValues.set(fieldId, previousValue);
            }
          }
          await vault.store(inventorySecretKey(source.id, fieldId), value);
          if (!existingSecretFieldIds.has(fieldId)) {
            newlyWrittenFieldIds.push(fieldId);
          }
        }
      } catch {
        // ITEM 3 — a later field's store rejecting after earlier ones in
        // THIS loop succeeded must not leave those earlier writes stuck:
        // an overwritten field's old value would otherwise be lost even
        // though the update as a whole never took effect, and a brand-new
        // field's key would otherwise be orphaned exactly like FINDING B on
        // the add path.
        await rollbackThisRunsVaultWrites();
        void vscode.window.showErrorMessage("Could not store credentials in the system keychain — the source was not updated.");
        return;
      }

      // FINDING 2 — a password field in the CURRENT schema counts as stored
      // for this source when it was just re-entered, or when it's a kept
      // (left-blank) field that already had a saved vault value — never
      // merely because the schema declares it. A field dropped from the
      // schema entirely, or an optional field that has never had a value
      // saved, is excluded.
      const newSecretFieldIds = provider.configFields
        .filter((f) => f.type === "password" && (reenteredSecrets[f.id] !== undefined || existingSecretFieldIds.has(f.id)))
        .map((f) => f.id);

      const updated: InventorySourceConfig = { ...source, name, targetFolder, prunePolicy, defaultUsername, config, secretFieldIds: newSecretFieldIds };

      // ITEM 4 — re-read the record immediately before persisting. configCommands
      // flows (importMergeReplace, completeReset) mutate inventory sources
      // directly and bypass inFlightSourceIds entirely, so an import/reset can
      // complete while the user still sits in these prompts. Persisting `updated`
      // (built from the pick-time `source`) over that would silently overwrite
      // the imported record (and FINDING 3's stale-key cleanup below would then
      // delete the imported source's own vault keys), or resurrect a source the
      // user just reset away. `source` is the exact pick-time record — compared
      // on both config (sourceConfigUnchanged) and name, since name isn't part
      // of that comparator.
      const currentSourceBeforePersist = core.getInventorySource(source.id);
      if (!currentSourceBeforePersist || !sourceConfigUnchanged(currentSourceBeforePersist, source) || currentSourceBeforePersist.name !== source.name) {
        await rollbackThisRunsVaultWrites();
        void vscode.window.showErrorMessage("Inventory source changed while editing — reopen Edit Source.");
        return;
      }

      // FINDING 1 — persist BEFORE any vault cleanup. If persistence rejects,
      // the pre-existing secretFieldIds keys must be left untouched (they're
      // still the keys the last-known-good source record points at), and any
      // brand-new keys written above must be rolled back (best-effort — a
      // delete failure here must not mask the original persistence error).
      // FINDING C — additionally, any re-entered field that OVERWROTE an
      // existing value gets that captured previous value restored, so the
      // vault matches the reverted (last-known-good) source record.
      try {
        await core.addOrUpdateInventorySource(updated);
      } catch {
        await rollbackThisRunsVaultWrites();
        void vscode.window.showErrorMessage(`Could not save inventory source "${name}" — the update was not applied.`);
        return;
      }

      // FINDING 3 — vault keys for ids that were in the OLD secretFieldIds but
      // fell out of the new set (dropped from the provider schema, or simply
      // never re-stored) are orphaned: remove-source/reset/backup only walk
      // secretFieldIds, so a stale vault entry would live forever otherwise.
      // Deleted only AFTER the updated source is successfully persisted —
      // deleting them first would destroy still-referenced credentials if the
      // persist below then failed (FINDING 1).
      // ITEM 8 — each stale-key delete is independent and best-effort: one
      // rejection must neither throw out of an otherwise-successful edit nor
      // block the remaining stale keys from being cleaned up.
      const newSecretFieldIdSet = new Set(newSecretFieldIds);
      for (const staleId of source.secretFieldIds) {
        if (!newSecretFieldIdSet.has(staleId)) {
          const staleKey = inventorySecretKey(source.id, staleId);
          try {
            await vault.delete(staleKey);
          } catch (error) {
            console.warn(`[Nexus] Failed to delete stale inventory secret key "${staleKey}":`, error);
          }
        }
      }

      const folderNote = targetFolder !== source.targetFolder ? " Servers move to the new folder on the next sync." : "";
      void vscode.window.showInformationMessage(`Inventory source "${name}" updated.${folderNote}`);
    } finally {
      inFlightSourceIds.delete(source.id);
    }
  }

  async function removeSource(): Promise<void> {
    const source = await pickInventorySource(core, registry);
    if (!source) return;
    if (inFlightSourceIds.has(source.id)) {
      void vscode.window.showWarningMessage(`"${source.name}" is currently syncing — try again once the sync finishes.`);
      return;
    }

    inFlightSourceIds.add(source.id);
    try {
      const snapshot = core.getSnapshot();
      const owned = snapshot.servers.filter((s) => s.origin?.sourceId === source.id);
      const hiddenOwnedCount = owned.filter((s) => s.isHidden).length;
      const ownedIds = new Set(owned.map((s) => s.id));
      const dependentCount = countJumpHostDependents(snapshot.servers, ownedIds);

      const detailLines: string[] = [];
      if (owned.length > 0) {
        const verb = owned.length === 1 ? "is" : "are";
        const hiddenNote = hiddenOwnedCount > 0 ? ` (includes ${hiddenOwnedCount} hidden)` : "";
        detailLines.push(`${owned.length} synced server${owned.length === 1 ? "" : "s"} ${verb} linked to this source.${hiddenNote}`);
      }
      if (dependentCount > 0) {
        detailLines.push(`${dependentCount} other server${dependentCount === 1 ? "" : "s"} use these as SSH jump hosts.`);
      }

      const buttons = owned.length > 0 ? ["Delete Servers", "Keep Servers"] : ["Remove"];
      const choice = await vscode.window.showWarningMessage(
        `Remove inventory source "${source.name}"?`,
        { modal: true, detail: detailLines.join("\n") },
        ...buttons
      );
      if (!choice) return;

      if (choice === "Delete Servers") {
        // F1 — teardown running sessions/tunnels/pool connections BEFORE the plan removes
        // the server records, mirroring serverCommands.ts's own remove flow.
        for (const server of owned) {
          await teardown.teardownServerRuntime(server.id);
        }
        // FINDINGS D/E — `source` is the snapshot taken at the start of this
        // command, before the confirm modal and teardown awaits; it's the
        // correct expectedSource here since removeSource never recomputes
        // against a fresher record the way syncNow does.
        // ITEM 6 — a source config change racing this call (e.g. import/reset)
        // makes applyInventorySyncPlan's own atomic expectedSource check
        // throw; catch it here with a removal-appropriate message instead of
        // letting it surface as an unhandled command rejection, and stop
        // before touching any secrets or the source record (no partial
        // removal).
        try {
          await core.applyInventorySyncPlan({
            sourceId: source.id,
            syncedAt: Date.now(),
            upsertServers: [],
            removeServerIds: owned.map((s) => s.id),
            folders: [],
            expectedSource: source
          });
        } catch {
          void vscode.window.showErrorMessage("Inventory source changed while removing — try again.");
          return;
        }
        // ITEM 9 — per-key best-effort: one rejected delete must not strand
        // the remaining owned servers' secrets uncleaned.
        for (const server of owned) {
          await deleteSecretBestEffort(vault, passwordSecretKey(server.id));
          await deleteSecretBestEffort(vault, passphraseSecretKey(server.id));
          await deleteSecretBestEffort(vault, proxyPasswordSecretKey(server.id));
        }
      } else if (choice === "Keep Servers") {
        const strippedServers = owned.map(({ origin, ...rest }) => rest as ServerConfig);
        // ITEM 6 — same reasoning as the Delete Servers branch above.
        try {
          await core.applyInventorySyncPlan({
            sourceId: source.id,
            syncedAt: Date.now(),
            upsertServers: strippedServers,
            removeServerIds: [],
            folders: [],
            expectedSource: source
          });
        } catch {
          void vscode.window.showErrorMessage("Inventory source changed while removing — try again.");
          return;
        }
      }

      for (const fieldId of source.secretFieldIds) {
        await vault.delete(inventorySecretKey(source.id, fieldId));
      }
      await core.removeInventorySource(source.id);

      void vscode.window.showInformationMessage(`Inventory source "${source.name}" removed.`);
    } finally {
      inFlightSourceIds.delete(source.id);
    }
  }

  async function syncNow(sourceIdArg?: string): Promise<void> {
    const source = sourceIdArg ? core.getInventorySource(sourceIdArg) : await pickInventorySource(core, registry);
    if (!source) {
      if (sourceIdArg) void vscode.window.showErrorMessage("That inventory source no longer exists.");
      return;
    }
    if (inFlightSourceIds.has(source.id)) {
      void vscode.window.showWarningMessage(`"${source.name}" is already syncing.`);
      return;
    }
    const provider = registry.get(source.providerId);
    if (!provider) {
      void vscode.window.showErrorMessage(providerMissingMessage(source.providerId));
      return;
    }

    // Marked busy synchronously right after the last check above (no await in
    // between) so a second invocation arriving on the next microtask sees it.
    inFlightSourceIds.add(source.id);
    try {
      // FINDING 2 — the required-secret check is driven by the provider's
      // CURRENT configFields schema, not by the stored source.secretFieldIds.
      // A provider upgrade that adds a new required password field (or flips
      // a blank optional field to required) must be caught here even though
      // the stored source predates that schema change and its
      // secretFieldIds never mention the new field id. `provider` is
      // guaranteed registered here (checked above), so "provider unavailable"
      // never applies within this call.
      for (const field of provider.configFields) {
        if (field.type !== "password" || !field.required) continue;
        const value = await vault.get(inventorySecretKey(source.id, field.id));
        if (!value) {
          void vscode.window.showErrorMessage(`Missing saved credential "${field.id}" for "${source.name}". Edit the source to re-enter it.`);
          return;
        }
      }

      // Loading stored secrets into the payload sent to the provider stays
      // driven by secretFieldIds (unchanged from before FINDING 2) — every id
      // that was actually stored (optional or stale) is harmless to pass
      // through, whether or not the current schema still calls it required.
      const secrets: InventorySourceSecrets = {};
      for (const fieldId of source.secretFieldIds) {
        const value = await vault.get(inventorySecretKey(source.id, fieldId));
        if (value === undefined) continue;
        secrets[fieldId] = value;
      }

      let tree: InventoryTree;
      try {
        const fetched = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Syncing inventory from "${source.name}"…` },
          () => provider.fetchInventory(source.config, secrets)
        );
        try {
          validateInventoryTree(fetched);
        } catch (validationError) {
          const reason = validationError instanceof Error ? validationError.message : String(validationError);
          throw new InventoryProviderError("protocol", `Provider returned an invalid inventory tree: ${reason}`);
        }
        tree = fetched;
      } catch (error) {
        void vscode.window.showErrorMessage(`Inventory sync failed: ${describeInventoryError(error)}`);
        return;
      }

      let plan = computeSyncPlan({ source, tree, currentServers: core.getSnapshot().servers, now: Date.now() });

      // Nothing to do: apply an empty application to bump lastSyncAt without a confirm modal.
      if (plan.adds.length === 0 && plan.updates.length === 0 && plan.prunes.length === 0) {
        // ITEM 5 — same rejection surface as the main apply path below: a
        // source config race (or any persist failure) here must produce a
        // friendly error instead of an unhandled command rejection.
        try {
          await core.applyInventorySyncPlan(planToApplication(plan, source));
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Inventory sync failed: ${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }
        void vscode.window.showInformationMessage(`Inventory sync from "${source.name}": nothing to do (${plan.unchangedCount} unchanged).`);
        if (plan.warnings.length > 0) {
          void vscode.window
            .showWarningMessage(`${plan.warnings.length} warning${plan.warnings.length === 1 ? "" : "s"} during sync.`, "Show Details")
            .then((choice) => {
              if (choice === "Show Details") void openInventoryIssuesText(plan.warnings);
            });
        }
        return;
      }

      // FINDING 1 — the post-teardown final recompute (below) can turn up a
      // different plan than the one just reconfirmed (e.g. a concurrent
      // import added an owned server absent from the fetched tree — applying
      // unseen would delete it). `tornDownIds` tracks every server id already
      // torn down across re-confirmation loops so a later iteration only
      // tears down NEWLY-deleted ids, never repeats a teardown. The loop is
      // bounded — if the plan keeps changing out from under the user, abort
      // rather than reconfirm forever.
      const tornDownIds = new Set<string>();
      let finalRecomputeMismatchCount = 0;
      const MAX_FINAL_RECOMPUTE_MISMATCHES = 5;

      for (;;) {
        const buttons = plan.warnings.length > 0 ? ["Apply", "Show Warnings"] : ["Apply"];
        const choice = await vscode.window.showInformationMessage(
          `Apply inventory sync from "${source.name}"?`,
          { modal: true, detail: describePlanDetail(plan, core.getSnapshot().servers) },
          ...buttons
        );
        if (choice === "Show Warnings") {
          await openInventoryIssuesText(plan.warnings);
          return;
        }
        if (choice !== "Apply") return;

        // F3 — recompute against a fresh snapshot right before applying; if the
        // counts changed since the modal was shown, re-show it with the new
        // counts instead of applying stale plan data.
        const freshSource = core.getInventorySource(source.id);
        if (!freshSource) {
          void vscode.window.showErrorMessage("The inventory source was removed before the sync could be applied.");
          return;
        }

        // FINDING 2 — `source` (captured when this sync started, and used to
        // fetch `tree`) must still match the current record on every field
        // that feeds the plan/apply. A presence check alone lets a
        // delete-and-recreate race (e.g. replace-mode config import) apply
        // the OLD fetch's tree against a NEW provider config's servers.
        if (!sourceConfigUnchanged(source, freshSource)) {
          void vscode.window.showErrorMessage(
            `Inventory source "${source.name}" configuration changed while syncing — run Sync Now again.`
          );
          return;
        }

        const recomputed = computeSyncPlan({ source: freshSource, tree, currentServers: core.getSnapshot().servers, now: Date.now() });
        if (!planCountsEqual(plan, recomputed)) {
          plan = recomputed;
          continue;
        }

        const application = planToApplication(recomputed, freshSource);
        // FINDING 1 — only tear down ids not already torn down by an earlier
        // iteration of this loop (a prior reconfirmation may have already
        // handled some of these).
        for (const id of application.removeServerIds) {
          if (tornDownIds.has(id)) continue;
          await teardown.teardownServerRuntime(id);
          tornDownIds.add(id);
        }

        // FINDING D — the config-level check above (sourceConfigUnchanged)
        // doesn't see secret VALUES: a replace-mode import can recreate an
        // identical-looking record (same providerId/config/secretFieldIds)
        // while pointing the same field ids at a different vault entry, so
        // `tree` — fetched under the OLD token — would otherwise get applied
        // as if it came from the new one. Re-read the vault for the exact
        // fields the fetch used and compare against what was actually sent,
        // right after the teardown awaits and immediately before apply — the
        // narrowest window this check can occupy without moving inside core
        // (core has no vault access).
        const currentSecretsForFetchFields: InventorySourceSecrets = {};
        for (const fieldId of source.secretFieldIds) {
          const value = await vault.get(inventorySecretKey(source.id, fieldId));
          if (value === undefined) continue;
          currentSecretsForFetchFields[fieldId] = value;
        }
        if (!inventorySourceValuesEqual(secrets, currentSecretsForFetchFields)) {
          void vscode.window.showErrorMessage(
            `Inventory source "${source.name}" credentials changed while syncing — run Sync Now again.`
          );
          return;
        }

        // ITEM 2 — recompute the plan/application ONE MORE TIME here, after
        // the very last await above (the teardown loop and the FINDING D
        // vault re-read), immediately before applyInventorySyncPlan — no
        // await separates this recompute from the apply call. Without this,
        // a server edited during those awaits would be overwritten by the
        // stale `application` object computed before them (`recomputed`
        // above only reflects state as of right before the teardown loop
        // started). The teardown loop already ran against that pre-teardown
        // `application.removeServerIds` — if this fresh recompute's delete
        // set differs (e.g. a server edited out of "delete" during teardown),
        // we do NOT re-run teardown for it: applying the fresh plan is what
        // matters, and a torn-down connection for a server that's no longer
        // being deleted is an acceptable, visible cost. `freshSource` (not a
        // re-read here) stays the basis for both the plan and
        // applyInventorySyncPlan's expectedSource — FINDING E's synchronous
        // check inside applyInventorySyncPlan is what still catches the
        // source record itself being replaced during this window.
        const finalPlan = computeSyncPlan({ source: freshSource, tree, currentServers: core.getSnapshot().servers, now: Date.now() });
        const finalApplication = planToApplication(finalPlan, freshSource);

        // FINDING 1 — compare the post-teardown final recompute against the
        // plan the user just reconfirmed (`recomputed`, computed right before
        // the teardown loop above). If they differ — counts OR the actual
        // prune-"delete" server-id set — do NOT apply unseen: loop back to
        // the confirmation modal with the new plan. Nothing has been applied
        // yet (applyInventorySyncPlan hasn't been called), so re-declining on
        // the next confirmation leaves state untouched.
        if (!planCountsEqual(recomputed, finalPlan)) {
          finalRecomputeMismatchCount++;
          if (finalRecomputeMismatchCount > MAX_FINAL_RECOMPUTE_MISMATCHES) {
            void vscode.window.showErrorMessage(
              "Inventory state keeps changing — sync aborted, run Sync Now again."
            );
            return;
          }
          plan = finalPlan;
          continue;
        }

        // FINDING E — even after the checks above, the source record could
        // still be replaced during the teardown awaits themselves (between
        // the freshSource check and this call). applyInventorySyncPlan's own
        // synchronous, pre-mutation comparison against `application.expectedSource`
        // is the only thing that can still catch that — surface its rejection
        // the same way as the fast-fail check above rather than letting it
        // propagate as an unhandled command rejection.
        try {
          await core.applyInventorySyncPlan(finalApplication);
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Inventory sync failed: ${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }
        // ITEM 9 — per-key best-effort: one rejected delete must not strand
        // the remaining pruned servers' secrets uncleaned.
        for (const id of prunedServerIdsForSecretCleanup(finalPlan)) {
          await deleteSecretBestEffort(vault, passwordSecretKey(id));
          await deleteSecretBestEffort(vault, passphraseSecretKey(id));
          await deleteSecretBestEffort(vault, proxyPasswordSecretKey(id));
        }

        const deletedCount = finalPlan.prunes.filter((p) => p.policy === "delete").length;
        void vscode.window.showInformationMessage(
          `Inventory sync complete: +${finalPlan.adds.length} ~${finalPlan.updates.length} -${deletedCount} (${finalPlan.unchangedCount} unchanged).`
        );
        if (finalPlan.warnings.length > 0) {
          void vscode.window
            .showWarningMessage(`${finalPlan.warnings.length} warning${finalPlan.warnings.length === 1 ? "" : "s"} during sync.`, "Show Details")
            .then((detailChoice) => {
              if (detailChoice === "Show Details") void openInventoryIssuesText(finalPlan.warnings);
            });
        }
        return;
      }
    } finally {
      inFlightSourceIds.delete(source.id);
    }
  }

  return [
    vscode.commands.registerCommand("nexus.inventory.addSource", addSource),
    vscode.commands.registerCommand("nexus.inventory.editSource", editSource),
    vscode.commands.registerCommand("nexus.inventory.removeSource", removeSource),
    vscode.commands.registerCommand("nexus.inventory.syncNow", (arg?: unknown) => syncNow(typeof arg === "string" ? arg : undefined))
  ];
}
