import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { ServerConfig } from "../models/config";
import {
  InventoryProviderError,
  inventorySecretKey,
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

function planCountsEqual(a: InventorySyncPlan, b: InventorySyncPlan): boolean {
  return (
    a.adds.length === b.adds.length &&
    a.updates.length === b.updates.length &&
    a.prunes.length === b.prunes.length &&
    a.unchangedCount === b.unchangedCount
  );
}

function inventorySourceValuesEqual(a: InventorySourceValues, b: InventorySourceValues): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}

function secretFieldIdsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

/**
 * FINDING 2 — compares exactly the InventorySourceConfig fields that feed
 * computeSyncPlan/planToApplication (and the earlier fetchInventory call): a
 * source record that differs on any of these must not have the tree fetched
 * under the OLD config applied against it, even though its id still exists
 * and the "source was removed" guard alone would let it through — e.g. a
 * replace-mode config import can delete and recreate the same source id with
 * an entirely different provider config while a sync is mid-flight.
 */
function sourceConfigUnchanged(a: InventorySourceConfig, b: InventorySourceConfig): boolean {
  return (
    a.providerId === b.providerId &&
    a.targetFolder === b.targetFolder &&
    a.prunePolicy === b.prunePolicy &&
    a.defaultUsername === b.defaultUsername &&
    inventorySourceValuesEqual(a.config, b.config) &&
    secretFieldIdsEqual(a.secretFieldIds, b.secretFieldIds)
  );
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
      // opposed to an overwrite of a value that already existed). Only those
      // are safe to roll back later — a pre-existing key's old value isn't
      // available to restore.
      const newlyWrittenFieldIds: string[] = [];
      try {
        for (const [fieldId, value] of Object.entries(reenteredSecrets)) {
          await vault.store(inventorySecretKey(source.id, fieldId), value);
          if (!existingSecretFieldIds.has(fieldId)) {
            newlyWrittenFieldIds.push(fieldId);
          }
        }
      } catch {
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

      // FINDING 1 — persist BEFORE any vault cleanup. If persistence rejects,
      // the pre-existing secretFieldIds keys must be left untouched (they're
      // still the keys the last-known-good source record points at), and any
      // brand-new keys written above must be rolled back (best-effort — a
      // delete failure here must not mask the original persistence error).
      try {
        await core.addOrUpdateInventorySource(updated);
      } catch {
        for (const fieldId of newlyWrittenFieldIds) {
          try {
            await vault.delete(inventorySecretKey(source.id, fieldId));
          } catch {
            // best-effort rollback — ignore
          }
        }
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
      const newSecretFieldIdSet = new Set(newSecretFieldIds);
      for (const staleId of source.secretFieldIds) {
        if (!newSecretFieldIdSet.has(staleId)) {
          await vault.delete(inventorySecretKey(source.id, staleId));
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
        await core.applyInventorySyncPlan({ sourceId: source.id, syncedAt: Date.now(), upsertServers: [], removeServerIds: owned.map((s) => s.id), folders: [] });
        for (const server of owned) {
          await vault.delete(passwordSecretKey(server.id));
          await vault.delete(passphraseSecretKey(server.id));
          await vault.delete(proxyPasswordSecretKey(server.id));
        }
      } else if (choice === "Keep Servers") {
        const strippedServers = owned.map(({ origin, ...rest }) => rest as ServerConfig);
        await core.applyInventorySyncPlan({ sourceId: source.id, syncedAt: Date.now(), upsertServers: strippedServers, removeServerIds: [], folders: [] });
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
        await core.applyInventorySyncPlan(planToApplication(plan));
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

        const application = planToApplication(recomputed);
        for (const id of application.removeServerIds) {
          await teardown.teardownServerRuntime(id);
        }
        await core.applyInventorySyncPlan(application);
        for (const id of prunedServerIdsForSecretCleanup(recomputed)) {
          await vault.delete(passwordSecretKey(id));
          await vault.delete(passphraseSecretKey(id));
          await vault.delete(proxyPasswordSecretKey(id));
        }

        const deletedCount = recomputed.prunes.filter((p) => p.policy === "delete").length;
        void vscode.window.showInformationMessage(
          `Inventory sync complete: +${recomputed.adds.length} ~${recomputed.updates.length} -${deletedCount} (${recomputed.unchangedCount} unchanged).`
        );
        if (recomputed.warnings.length > 0) {
          void vscode.window
            .showWarningMessage(`${recomputed.warnings.length} warning${recomputed.warnings.length === 1 ? "" : "s"} during sync.`, "Show Details")
            .then((detailChoice) => {
              if (detailChoice === "Show Details") void openInventoryIssuesText(recomputed.warnings);
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
