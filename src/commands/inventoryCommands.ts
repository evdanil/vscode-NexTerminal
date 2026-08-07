import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { InventorySourceRemovalMismatchError, type NexusCore } from "../core/nexusCore";
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
import { configMutationLock } from "../services/configMutationLock";
import { INVALID_FOLDER_PATH_MESSAGE, normalizeOptionalFolderPath } from "../utils/folderPaths";
import { mostCommonUsername } from "./configCommands";

/**
 * F1 — server runtime teardown, injected from extension.ts (mirrors the
 * disconnect/stop-tunnels/sshPool.disconnect sequence in serverCommands.ts's
 * remove flow). This module never touches ssh/tunnel plumbing directly.
 *
 * FINDING 5 (removal-teardown review) — the two callers no longer share the
 * same ordering relative to applyInventorySyncPlan. syncNow (prune "delete")
 * still tears down BEFORE applying: its final pre-apply recompute already
 * re-validates the plan against fresh state (see the FINDING 1/E chain in
 * syncNow), so by the time teardown runs there the ids are trustworthy, and
 * reordering there would require restructuring that recompute loop for no
 * real gain. removeSource's "Delete Servers" flow instead applies FIRST and
 * tears down only the ids `applyInventorySyncPlan` actually reports as
 * removed (`removedServerIds`) — its absent-mode apply can silently SKIP an
 * id whose server was taken over by a concurrent import (see
 * InventorySyncApplication.expectedBeforeByServerId), and tearing down a
 * server that survives the apply untouched would kill its live
 * terminals/tunnels/pool connection for nothing. teardownServerRuntime
 * itself (see serverCommands.ts) does not depend on the server record still
 * existing in NexusCore, so calling it AFTER the record is gone is safe.
 *
 * FINDING 2 (P2, mid-teardown-recheck review) — `shouldAbort` is threaded
 * straight through to teardownServerRuntime, which rechecks it after its own
 * internal awaits (see that function's doc) — a pre-teardown-only absence
 * check at the call site can't protect against a replacement created DURING
 * teardown's own awaited tunnel stops. The two POST-apply inventory call
 * sites (syncNow's second sweep, removeSource's Delete Servers loop) pass
 * `() => core.getServer(id) !== undefined` — existence there genuinely means
 * a concurrent recreate raced the apply. syncNow's PRE-apply sweep
 * (ROUND 24 FIX, P1, pre-apply-shouldAbort review) passes no shouldAbort at
 * all: before applyInventorySyncPlan runs, every id in its removal candidate
 * list still exists in core by construction, so that same predicate would be
 * unconditionally true there and silently skip sshPool.disconnect on every
 * call — there is no "recreated mid-teardown" signal to guard against this
 * early, so teardown runs unconditionally.
 */
export interface InventoryRuntimeTeardown {
  teardownServerRuntime(serverId: string, shouldAbort?: () => boolean): Promise<void>;
}

function providerMissingMessage(providerId: string): string {
  return `Provider "${providerId}" not available (the extension providing it may be disabled).`;
}

/**
 * FINDING 2 (P2, defensive-copy review) — every provider.testConnection /
 * provider.fetchInventory call site was passing the live config/secrets
 * objects straight through. `config` here can be the EXACT object stored on
 * an InventorySourceConfig in NexusCore (e.g. syncNow passes `source.config`
 * directly) — a third-party provider that mutates its `config` argument in
 * place corrupts the stored record silently: since InventorySourceValues is
 * all primitives, the mutated copy and the "current" record are one and the
 * same object, so there's nothing to diff against and no revision bump to
 * notice. Every call boundary must hand the provider its own copy instead:
 * structuredClone for config (cheap — every value is a string/number/boolean)
 * and a shallow copy for secrets (also a flat Record<string,string>). A tiny
 * shared helper so future provider call sites inherit this for free instead
 * of each having to remember it individually.
 */
function cloneForProvider(
  config: InventorySourceValues,
  secrets: InventorySourceSecrets
): { config: InventorySourceValues; secrets: InventorySourceSecrets } {
  return { config: structuredClone(config), secrets: { ...secrets } };
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
      () => {
        const cloned = cloneForProvider(config, secrets);
        return provider.testConnection(cloned.config, cloned.secrets);
      }
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
//
// FINDING 3 — raw counts (adds/updates/prunes/unchanged) can stay identical
// while a modal-visible AGGREGATE changes: a manual server landing on a
// planned add's host:port between the modal and the recompute leaves
// adds.length untouched but bumps manualDuplicateCount, and the modal's "will
// be added as duplicates" line only reflects the plan that was actually
// shown. Compare every plan-derived value describePlanDetail renders —
// manualDuplicateCount, hiddenPruneCount, and warnings.length — alongside the
// raw counts, so a drift in any of them (not just the counts) loops back to
// reconfirmation instead of applying a plan the user never saw the modal for.
function planCountsEqual(a: InventorySyncPlan, b: InventorySyncPlan): boolean {
  if (
    a.adds.length !== b.adds.length ||
    a.updates.length !== b.updates.length ||
    a.prunes.length !== b.prunes.length ||
    a.unchangedCount !== b.unchangedCount ||
    a.manualDuplicateCount !== b.manualDuplicateCount ||
    a.hiddenPruneCount !== b.hiddenPruneCount ||
    a.warnings.length !== b.warnings.length
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

    // CONFIG MUTATION LOCK — every prompt (provider/name/folder/username/
    // prune-policy/field pickers) and the connection test have already
    // resolved above; nothing left in this span shows UI, so it's safe to
    // hold the lock across the store-secrets + persist sequence. Serializes
    // against configCommands' replace-mode import / complete reset, which
    // could otherwise delete this exact source id's vault keys mid-write.
    const created = await configMutationLock.runExclusive(async (): Promise<boolean> => {
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
        return false;
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
        return false;
      }

      return true;
    });
    if (!created) return;

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

      // CONFIG MUTATION LOCK — every prompt (name/folder/username/prune-policy/
      // field pickers) and the connection test have already resolved above;
      // nothing left in this span shows UI. Moved the whole store+guard+persist
      // sequence into ONE lock acquisition (secret stores used to run before the
      // drift guard, with nothing stopping an import from landing in between)
      // so a replace-mode import/reset can no longer interleave with any part
      // of it — see importMergeReplace's doc comment for the race class.
      const persisted = await configMutationLock.runExclusive(async (): Promise<boolean> => {
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
        // FINDING 1 (P2, rollback-classification review) — the split between
        // "newly-written" and "overwritten" is decided by what vault.get
        // ACTUALLY returned for this field, never by secretFieldIds
        // membership. A field can be listed in the old secretFieldIds while
        // the vault key itself is missing (e.g. a restore that warned about
        // an absent credential) — declared-but-absent. Classifying that case
        // as "existing" (the old `existingSecretFieldIds.has(fieldId)` check)
        // meant a rollback below neither restored it (nothing was captured,
        // correctly) NOR deleted it (it was never pushed to
        // newlyWrittenFieldIds, incorrectly) — the freshly-entered credential
        // would survive a reported-failed update. previousValue === undefined
        // now always means "treat as newly-written, delete on rollback";
        // previousValue !== undefined always means "treat as overwritten,
        // restore on rollback" — regardless of what secretFieldIds says.
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
            // Classify by actual vault state, not by secretFieldIds
            // membership — see FINDING 1 comment above the declarations.
            const previousValue = await vault.get(inventorySecretKey(source.id, fieldId));
            await vault.store(inventorySecretKey(source.id, fieldId), value);
            if (previousValue !== undefined) {
              overwrittenPreviousValues.set(fieldId, previousValue);
            } else {
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
          return false;
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
        // of that comparator. Now that the store loop above also runs inside this
        // same lock acquisition, an import/reset can no longer land BETWEEN the
        // stores and this check either — it either completed entirely before this
        // acquisition started, or will wait for this one to finish first.
        const currentSourceBeforePersist = core.getInventorySource(source.id);
        if (!currentSourceBeforePersist || !sourceConfigUnchanged(currentSourceBeforePersist, source) || currentSourceBeforePersist.name !== source.name) {
          await rollbackThisRunsVaultWrites();
          void vscode.window.showErrorMessage("Inventory source changed while editing — reopen Edit Source.");
          return false;
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
          return false;
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

        return true;
      });
      if (!persisted) return;

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

      // CONFIG MUTATION LOCK — the confirm modal above has already resolved;
      // everything below (pre-flight revision re-check, secret capture,
      // secret deletion, record removal, disposition apply, teardown, vault
      // cleanup) shows no further UI, so it's safe to hold the lock across
      // all of it as ONE critical section. Serializes against configCommands'
      // replace-mode import / complete reset, which could otherwise recreate
      // this exact source id (or the servers it owns) while this section is
      // still using the OLD incarnation. Only the closing summary/message
      // calls stay outside — they're fire-and-forget and don't need to be
      // atomic with the mutation.
      const removal = await configMutationLock.runExclusive(async (): Promise<
        { ok: true; skippedCount: number; recreatedCount: number; teardownFailureCount: number } | { ok: false }
      > => {
        // ITEM 6 (carried forward from the pre-reorder flow) — a source config
        // race landing while the confirm modal was open (e.g. a replace-mode
        // import) must abort here, before anything is touched. Previously this
        // fell out incidentally of applyInventorySyncPlan's expectedSource
        // check, because server disposition ran first and was checked against
        // the pick-time `source`. Now disposition runs LAST (see the REORDER
        // comment below) and is checked against "absent" instead — which
        // guards a different, narrower race — so this same-config guard is now
        // explicit here, using the same comparator applyInventorySyncPlan used
        // to use for this purpose.
        const currentSource = core.getInventorySource(source.id);
        if (!currentSource || !sourceConfigUnchanged(currentSource, source) || currentSource.name !== source.name) {
          void vscode.window.showErrorMessage("Inventory source changed while removing — try again.");
          return { ok: false };
        }

        // REORDER (Findings 1 & 2) — new phase order so every failure point
        // below leaves a coherent, still-fully-functional state:
        //   1. Capture every secret value this source owns.
        //   2. Delete the source's own secret keys as ONE guarded unit — a
        //      mid-loop rejection (a provider with multiple secret fields)
        //      restores everything captured and stops before the record or any
        //      owned server is touched (closes FINDING 2 — previously this
        //      loop sat outside any catch).
        //   3. Remove the source record itself — a rejection (core restores
        //      the record in memory; see NexusCore.removeInventorySource)
        //      restores the credentials too, so the source stays fully usable.
        //   4. ONLY NOW touch owned servers: runtime teardown + the
        //      delete/strip-origin disposition. Record removal above can no
        //      longer fail AFTER servers were already deleted/stripped —
        //      closes FINDING 1 (previously disposition ran first, so a
        //      rejected record removal left a live source that could no
        //      longer manage anything).
        const capturedSecrets = new Map<string, string>();
        for (const fieldId of source.secretFieldIds) {
          const value = await vault.get(inventorySecretKey(source.id, fieldId));
          if (value !== undefined) {
            capturedSecrets.set(fieldId, value);
          }
        }
        // FINDING 3 — returns the field ids whose restore itself rejected,
        // instead of silently swallowing that rejection. A caller that ignores
        // this can no longer claim "nothing was changed" / "the source is
        // intact" when a credential restore actually failed — that claim would
        // be false, and the user needs to know to re-enter it rather than trust
        // a synced badge or a next sync that authenticates with nothing.
        const restoreCapturedSecrets = async (): Promise<string[]> => {
          const failedFieldIds: string[] = [];
          for (const [fieldId, value] of capturedSecrets) {
            try {
              await vault.store(inventorySecretKey(source.id, fieldId), value);
            } catch {
              failedFieldIds.push(fieldId);
            }
          }
          return failedFieldIds;
        };
        const restoreFailureMessage = (failedCount: number): string =>
          `Removal failed and ${failedCount} credential${failedCount === 1 ? "" : "s"} could not be restored — re-enter ${
            failedCount === 1 ? "it" : "them"
          } via Edit Source before syncing.`;

        // FINDING 2 — the entire delete loop is one guarded unit: a rejection
        // on any key (not just the first) restores every captured value and
        // stops before the record or any server is touched.
        try {
          for (const fieldId of source.secretFieldIds) {
            await vault.delete(inventorySecretKey(source.id, fieldId));
          }
        } catch {
          const failedRestores = await restoreCapturedSecrets();
          void vscode.window.showErrorMessage(
            failedRestores.length > 0 ? restoreFailureMessage(failedRestores.length) : "Could not remove source credentials — nothing was changed."
          );
          return { ok: false };
        }

        try {
          // FINDING 1 — pass the pick-time `source` as `expected`: core
          // compares it SYNCHRONOUSLY against the current record before
          // deleting. Without this, a replace-mode import that deletes and
          // recreates this exact source id during the awaited vault reads/
          // deletes above would have its REPLACEMENT record unconditionally
          // deleted here instead of throwing.
          await core.removeInventorySource(source.id, source);
        } catch (error) {
          // FINDING 2 (removal-teardown review) — a mismatch means the record
          // was REPLACED (e.g. a replace-mode import recreated this exact id)
          // during the window above; the current record is a different
          // incarnation from the one whose secrets we captured. Do NOT restore
          // here: inventorySecretKey(id, fieldId) is keyed by sourceId+fieldId
          // only (not by revision), so the replacement may already have its
          // OWN freshly-imported credential sitting under some of these same
          // vault keys — writing the captured (dead-incarnation) values back
          // would silently clobber it, or plant an undeclared key on a source
          // we no longer own either way. Nothing was removed; whatever the
          // replacement's current credentials are, they are left exactly as
          // they stood. This is deliberately the ONE case in this catch that
          // never calls restoreCapturedSecrets().
          if (error instanceof InventorySourceRemovalMismatchError) {
            void vscode.window.showErrorMessage(
              `Inventory source "${source.name}" changed while removing — nothing was removed; its current credentials were preserved.`
            );
            return { ok: false };
          }
          // Chosen behavior for every OTHER failure (documented once, here):
          // fail-closed restore — put every captured credential back so the
          // source (which core has already rolled back to still exist) stays
          // fully usable. No server has been touched yet at this point
          // (FINDING 1), so nothing else needs restoring.
          const failedRestores = await restoreCapturedSecrets();
          if (failedRestores.length > 0) {
            // FINDING 3 — a failed restore takes priority over the "intact"
            // claim below: the user must be told credentials are actually
            // missing, not that the source is safe to just retry.
            void vscode.window.showErrorMessage(restoreFailureMessage(failedRestores.length));
          } else {
            void vscode.window.showErrorMessage(
              `Failed to remove inventory source "${source.name}" — the removal did not complete and the source (with its credentials) is intact.`
            );
          }
          return { ok: false };
        }

        // FINDING 1 — the source record is gone for good now, so record
        // removal can no longer race server disposition. `expectedSource:
        // "absent"` still guards a narrower race: a replace-mode import
        // recreating this exact source id in the gap between the
        // removeInventorySource call above and this apply. If that happens,
        // applyInventorySyncPlan throws rather than run this now-stale
        // disposition against the NEW source's servers.
        //
        // FINDING 2 — even within a single "absent" apply, importMergeReplace
        // imports servers BEFORE sources, so an owned server can be recreated
        // (or have its id taken over by a NEW source) between the record
        // removal above and this call — a window narrower than "the whole
        // source id came back", but real. `skippedCount` (returned by
        // applyInventorySyncPlan) counts entries core refused to touch because
        // current state no longer matched what this disposition expected.
        let skippedCount = 0;
        const recreatedIds = new Set<string>();
        let teardownFailureCount = 0;
        if (choice === "Delete Servers") {
          // FINDING 5 (removal-teardown review, REORDER) — apply the deletion
          // FIRST, then tear down runtime state + vault secrets only for the
          // ids applyInventorySyncPlan actually reports as removed. The old
          // order (teardown for every `owned` id, then apply) killed live
          // terminals/tunnels/pool connections for a server the apply might go
          // on to SKIP (FINDING 4 below) — e.g. one a concurrent import took
          // over in the window since `owned` was captured — even though that
          // server survives untouched. teardownServerRuntime itself no longer
          // needs the server record to still exist in NexusCore (see its
          // updated doc in serverCommands.ts), so it's safe to call after the
          // record is already gone.
          //
          // FINDING 4 — `expectedBeforeByServerId` (previously built only for
          // the Keep Servers upserts below) now also covers these delete
          // targets: ownership (origin.sourceId match) alone can't distinguish
          // a genuinely-stale entry from a REPLACEMENT server that kept the
          // same id and origin.sourceId but had its content changed
          // underneath this removal — see NexusCore.applyInventorySyncPlan.
          const expectedBeforeByServerId = new Map(owned.map((s) => [s.id, s] as const));
          let removedServerIds: string[];
          try {
            const result = await core.applyInventorySyncPlan({
              sourceId: source.id,
              syncedAt: Date.now(),
              upsertServers: [],
              removeServerIds: owned.map((s) => s.id),
              folders: [],
              expectedSource: "absent",
              expectedBeforeByServerId
            });
            skippedCount = result.skippedCount;
            removedServerIds = result.removedServerIds;
          } catch {
            // Residue is intentional and harmless: the source record is
            // already gone, so nothing will ever sync against these servers
            // again — a dangling origin is inert (the engine only ever acts on
            // behalf of an existing source), though the tree may keep showing
            // the synced badge on these servers until they're edited or
            // removed by hand.
            void vscode.window.showErrorMessage(
              `Inventory source "${source.name}" removed, but ${owned.length} linked server${owned.length === 1 ? "" : "s"} could not be cleaned up and may still show the synced badge.`
            );
            return { ok: false };
          }
          // FINDING 5 — teardown ONLY the ids actually removed above; a
          // skipped (taken-over) server keeps its live sessions/tunnels/pool
          // connection exactly as the surviving server record implies.
          // FINDING 2 (P2, second-sweep-abort review) — this runs AFTER the
          // record removal above already committed, so a rejected teardown
          // (e.g. a tunnel stop failing) must not be allowed to throw here:
          // an uncaught rejection would abort this loop mid-way, skipping
          // teardown for the remaining ids, skipping the credential-cleanup
          // loop below entirely, and skipping the normal success message —
          // even though the servers are already gone for good. Contain each
          // teardown per id, count failures, and keep going regardless; the
          // count is folded into the closing report below.
          // FINDING (round 22, mirrors syncNow) — nexus.server.edit /
          // nexus.server.rename deliberately don't take configMutationLock,
          // so a re-add (upsert) of one of these ids can land in the awaited
          // window between applyInventorySyncPlan committing above and this
          // loop's iteration for it running. Re-check the server is actually
          // still absent immediately before tearing it down — otherwise a
          // recreated, live server's terminals/tunnels/pool connection would
          // be killed out from under it. Ids skipped this way are folded into
          // the same `recreatedIds` set the credential-cleanup loop below
          // uses, so the final "N re-created server(s)" report counts each id
          // once even though both loops can independently notice the same
          // recreation.
          for (const id of removedServerIds) {
            if (core.getServer(id) !== undefined) {
              recreatedIds.add(id);
              continue;
            }
            try {
              // FINDING 2 (P2, mid-teardown-recheck review) — the presence
              // check just above only catches a recreation that landed BEFORE
              // this iteration; shouldAbort lets teardownServerRuntime itself
              // recheck between its own internal awaits, so a recreation
              // racing teardown's awaited tunnel stops doesn't get its fresh
              // pooled SSH connection disconnected out from under it.
              await teardown.teardownServerRuntime(id, () => core.getServer(id) !== undefined);
            } catch {
              teardownFailureCount++;
            }
          }
          // FINDING 3 — likewise, vault secret cleanup is limited to ids
          // actually removed — previously this looped over the whole `owned`
          // list regardless of what the apply above actually did, so a
          // skipped (taken-over) server's password/passphrase/proxy keys were
          // wrongly wiped out from under its surviving, live record.
          // ITEM 9 — per-key best-effort: one rejected delete must not strand
          // the remaining removed servers' secrets uncleaned.
          // FINDING 2 (review) — nexus.server.edit / nexus.server.rename
          // deliberately don't take configMutationLock, so while
          // applyInventorySyncPlan above was awaiting its saves such a flow
          // could have re-added one of these ids (upsert semantics) before
          // this loop's iteration for it runs. Re-check the server is still
          // absent immediately before deleting its keys — otherwise a
          // recreated, live server's credentials would be wiped out from
          // under it. The narrower residual window — a re-add landing during
          // the awaited vault.delete call itself, inside
          // deleteSecretBestEffort — is intrinsic to the async vault API and
          // accepted here; closing it would require generation-specific
          // secret keys, which touches the whole password subsystem and is
          // out of scope.
          for (const id of removedServerIds) {
            if (core.getServer(id) !== undefined) {
              recreatedIds.add(id);
              continue;
            }
            await deleteSecretBestEffort(vault, passwordSecretKey(id));
            await deleteSecretBestEffort(vault, passphraseSecretKey(id));
            await deleteSecretBestEffort(vault, proxyPasswordSecretKey(id));
          }
        } else if (choice === "Keep Servers") {
          const strippedServers = owned.map(({ origin, ...rest }) => rest as ServerConfig);
          // FINDING 2 — the pre-strip snapshot for each server, so core can
          // refuse to overwrite one that was replaced in the window above.
          const expectedBeforeByServerId = new Map(owned.map((s) => [s.id, s] as const));
          try {
            const result = await core.applyInventorySyncPlan({
              sourceId: source.id,
              syncedAt: Date.now(),
              upsertServers: strippedServers,
              removeServerIds: [],
              folders: [],
              expectedSource: "absent",
              expectedBeforeByServerId
            });
            skippedCount = result.skippedCount;
          } catch {
            // Same residue note as the Delete Servers branch above.
            void vscode.window.showErrorMessage(
              `Inventory source "${source.name}" removed, but ${owned.length} linked server${owned.length === 1 ? "" : "s"} could not be cleaned up and may still show the synced badge.`
            );
            return { ok: false };
          }
        }

        return { ok: true, skippedCount, recreatedCount: recreatedIds.size, teardownFailureCount };
      });
      if (!removal.ok) return;

      const skippedNote =
        removal.skippedCount > 0
          ? ` (${removal.skippedCount} server${removal.skippedCount === 1 ? "" : "s"} ${removal.skippedCount === 1 ? "was" : "were"} left untouched because ${
              removal.skippedCount === 1 ? "it" : "they"
            } changed during removal)`
          : "";
      const recreatedNote =
        removal.recreatedCount > 0
          ? ` (${removal.recreatedCount} re-created server${removal.recreatedCount === 1 ? "" : "s"} kept ${removal.recreatedCount === 1 ? "its" : "their"} credentials)`
          : "";
      // FINDING 2 (P2, second-sweep-abort review) — surface any teardown that
      // was contained (not swallowed silently) above.
      const teardownFailureNote =
        removal.teardownFailureCount > 0
          ? ` (runtime cleanup incomplete for ${removal.teardownFailureCount} server${
              removal.teardownFailureCount === 1 ? "" : "s"
            } — close ${removal.teardownFailureCount === 1 ? "its" : "their"} terminal${
              removal.teardownFailureCount === 1 ? "" : "s"
            } manually)`
          : "";
      void vscode.window.showInformationMessage(
        `Inventory source "${source.name}" removed.${skippedNote}${recreatedNote}${teardownFailureNote}`
      );
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
          () => {
            const cloned = cloneForProvider(source.config, secrets);
            return provider.fetchInventory(cloned.config, cloned.secrets);
          }
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
        // CONFIG MUTATION LOCK — no modal on this path, so the mutation is
        // safe to lock immediately. Same serialization guarantee as the
        // reconfirm loop below, for the same reason: this still calls
        // applyInventorySyncPlan and must not interleave with a config-level
        // import/reset's own critical section.
        // ITEM 5 — same rejection surface as the main apply path below: a
        // source config race (or any persist failure) here must produce a
        // friendly error instead of an unhandled command rejection.
        const nothingToDoApplied = await configMutationLock.runExclusive(async (): Promise<boolean> => {
          try {
            await core.applyInventorySyncPlan(planToApplication(plan, source));
            return true;
          } catch (error) {
            void vscode.window.showErrorMessage(
              `Inventory sync failed: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
          }
        });
        if (!nothingToDoApplied) return;
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

      // Result of one post-modal locked attempt: "abort" ends the command
      // (an error was already shown), "retry" means the plan drifted and the
      // loop must release the lock and re-show the confirm modal with the
      // updated plan, "success" means applyInventorySyncPlan committed.
      type SyncAttempt =
        | { kind: "abort" }
        | { kind: "retry"; plan: InventorySyncPlan }
        | { kind: "success"; finalPlan: InventorySyncPlan; recreatedCount: number; teardownFailureCount: number };

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

        // CONFIG MUTATION LOCK — acquired immediately after the modal
        // resolves (no UI shown from here until either this closure returns
        // or the loop reaches the top again to reshow the modal). Covers the
        // whole post-confirmation mutation attempt: the drift/secret checks,
        // teardown, the final recompute, apply, and pruned-secret cleanup.
        // On a "retry" the lock is released (the closure just returns) BEFORE
        // the loop goes back to `showInformationMessage` above — never held
        // across that modal.
        const attempt: SyncAttempt = await configMutationLock.runExclusive(async (): Promise<SyncAttempt> => {
          // F3 — recompute against a fresh snapshot right before applying; if the
          // counts changed since the modal was shown, re-show it with the new
          // counts instead of applying stale plan data.
          const freshSource = core.getInventorySource(source.id);
          if (!freshSource) {
            void vscode.window.showErrorMessage("The inventory source was removed before the sync could be applied.");
            return { kind: "abort" };
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
            return { kind: "abort" };
          }

          const recomputed = computeSyncPlan({ source: freshSource, tree, currentServers: core.getSnapshot().servers, now: Date.now() });
          if (!planCountsEqual(plan, recomputed)) {
            return { kind: "retry", plan: recomputed };
          }

          const application = planToApplication(recomputed, freshSource);
          // FINDING 2 (P2, second-sweep-abort review) — a rejected teardown
          // (e.g. a tunnel stop failing) must not be allowed to throw out of
          // this loop: an uncaught rejection here would propagate straight
          // through applyInventorySyncPlan (never called), the vault
          // re-checks, and the second teardown sweep below, aborting the
          // whole attempt with no user-facing report. Contain it per id and
          // keep going. Failures are collected into `teardownFailedIds` — a
          // Set, not a raw counter, shared with the post-apply sweep below —
          // so an id that fails teardown in BOTH sweeps (pre-apply here and
          // the post-apply reconnect-race sweep) is still reported as one
          // server needing manual attention, not two.
          const teardownFailedIds = new Set<string>();
          // FINDING 1 — only tear down ids not already torn down by an earlier
          // iteration of this loop (a prior reconfirmation may have already
          // handled some of these).
          for (const id of application.removeServerIds) {
            if (tornDownIds.has(id)) continue;
            try {
              // ROUND 24 FIX (P1, pre-apply-shouldAbort review) — no shouldAbort
              // here: applyInventorySyncPlan hasn't run yet, so every id in
              // `application.removeServerIds` still exists in core by
              // definition — `() => core.getServer(id) !== undefined` would be
              // unconditionally true and silently skip sshPool.disconnect on
              // every call through this sweep (masked on the success path only
              // because the post-apply sweep below disconnects it instead; on
              // every abort path after this — credential recheck, final
              // recompute mismatch, persist rejection — the pooled connection
              // would leak). There is no "recreated mid-teardown" signal to
              // guard against pre-apply, so teardown runs unconditionally.
              await teardown.teardownServerRuntime(id);
            } catch {
              teardownFailedIds.add(id);
            }
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
            return { kind: "abort" };
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
          // the confirmation modal with the new plan (releasing the lock
          // first). Nothing has been applied yet (applyInventorySyncPlan
          // hasn't been called), so re-declining on the next confirmation
          // leaves state untouched.
          if (!planCountsEqual(recomputed, finalPlan)) {
            finalRecomputeMismatchCount++;
            if (finalRecomputeMismatchCount > MAX_FINAL_RECOMPUTE_MISMATCHES) {
              void vscode.window.showErrorMessage(
                "Inventory state keeps changing — sync aborted, run Sync Now again."
              );
              return { kind: "abort" };
            }
            return { kind: "retry", plan: finalPlan };
          }

          // FINDING E — even after the checks above, the source record could
          // still be replaced during the teardown awaits themselves (between
          // the freshSource check and this call). applyInventorySyncPlan's own
          // synchronous, pre-mutation comparison against `application.expectedSource`
          // is the only thing that can still catch that — surface its rejection
          // the same way as the fast-fail check above rather than letting it
          // propagate as an unhandled command rejection.
          let applyResult: { skippedCount: number; removedServerIds: string[] };
          try {
            applyResult = await core.applyInventorySyncPlan(finalApplication);
          } catch (error) {
            void vscode.window.showErrorMessage(
              `Inventory sync failed: ${error instanceof Error ? error.message : String(error)}`
            );
            return { kind: "abort" };
          }

          // FINDING 1 (P2, reconnect-during-prune review) — nexus.server.connect
          // deliberately doesn't (and shouldn't) take configMutationLock, so a
          // user can reconnect a server torn down by the pre-apply teardown
          // loop above in the awaited window between that teardown and this
          // apply — resurrecting a live terminal/tunnel attached to a record
          // the apply above just deleted. Run a second best-effort teardown
          // pass, by id, over `applyResult.removedServerIds` (the ids the
          // apply actually removed, not our own pre-apply candidate list —
          // same reasoning as the ITEM 9 cleanup loop below). teardownServerRuntime
          // is idempotent and doesn't need the server record to still exist
          // (see its doc in serverCommands.ts), so re-running it for an id
          // already handled by the pre-apply loop above is harmless.
          // Residual micro-window (accepted, not closeable without making
          // connect take the lock): a connect that resolved its server object
          // BEFORE the apply and only creates its terminal AFTER this second
          // sweep still leaves a stranded terminal attached to a deleted
          // record. This is intrinsic without locking connects (out of scope
          // here — see the finding). The extension's orphan-terminal detection
          // (services/terminal/orphanDetect.ts, run at next activation) is the
          // backstop that surfaces any terminal stranded this way.
          //
          // FINDING 1 (P2, second-sweep-abort review) — nexus.server.edit /
          // nexus.server.rename deliberately don't take configMutationLock,
          // so a re-add (upsert) of one of these ids can land in the awaited
          // window between applyInventorySyncPlan committing above and this
          // loop's iteration for it running. Re-check the server is actually
          // still absent immediately before tearing it down — mirrors the
          // credential-cleanup loop right below — otherwise a recreated,
          // live server's terminals/tunnels/pool connection would be killed
          // out from under it. Ids skipped this way are folded into the same
          // `recreatedIds` set the credential-cleanup loop uses, so the final
          // "N re-created server(s)" report counts each id once even though
          // both loops can independently notice the same recreation.
          //
          // FINDING 2 (P2, second-sweep-abort review) — a rejected teardown
          // (e.g. a tunnel stop failing) must not be allowed to throw out of
          // this loop: the deletion has already committed by this point, so
          // an uncaught rejection here would abort mid-sweep, skipping
          // teardown for the remaining ids, the pruned-secret cleanup loop
          // below entirely, and the normal success report. Contain it per id
          // and add it to the shared `teardownFailedIds` set, then keep going.
          const recreatedIds = new Set<string>();
          for (const id of applyResult.removedServerIds) {
            if (core.getServer(id) !== undefined) {
              recreatedIds.add(id);
              continue;
            }
            try {
              // FINDING 2 (P2, mid-teardown-recheck review) — the presence
              // check just above only catches a recreation that landed BEFORE
              // this iteration; shouldAbort lets teardownServerRuntime itself
              // recheck between its own internal awaits, so a recreation
              // racing teardown's awaited tunnel stops doesn't get its fresh
              // pooled SSH connection disconnected out from under it.
              await teardown.teardownServerRuntime(id, () => core.getServer(id) !== undefined);
            } catch {
              teardownFailedIds.add(id);
            }
          }

          // ITEM 9 — per-key best-effort: one rejected delete must not strand
          // the remaining pruned servers' secrets uncleaned.
          // FINDING 2 (review) — nexus.server.edit / nexus.server.rename
          // deliberately don't take configMutationLock, so while
          // applyInventorySyncPlan above was awaiting its saves such a flow
          // could have re-added one of these pruned ids (upsert semantics)
          // before this loop's iteration for it runs. Re-check the server is
          // still absent immediately before deleting its keys — otherwise a
          // recreated, live server's credentials would be wiped out from
          // under it. The narrower residual window — a re-add landing during
          // the awaited vault.delete call itself, inside
          // deleteSecretBestEffort — is intrinsic to the async vault API and
          // accepted here; closing it would require generation-specific
          // secret keys, which touches the whole password subsystem and is
          // out of scope.
          for (const id of prunedServerIdsForSecretCleanup(finalPlan)) {
            if (core.getServer(id) !== undefined) {
              recreatedIds.add(id);
              continue;
            }
            await deleteSecretBestEffort(vault, passwordSecretKey(id));
            await deleteSecretBestEffort(vault, passphraseSecretKey(id));
            await deleteSecretBestEffort(vault, proxyPasswordSecretKey(id));
          }

          return { kind: "success", finalPlan, recreatedCount: recreatedIds.size, teardownFailureCount: teardownFailedIds.size };
        });

        if (attempt.kind === "abort") return;
        if (attempt.kind === "retry") {
          plan = attempt.plan;
          continue;
        }

        const finalPlan = attempt.finalPlan;
        const deletedCount = finalPlan.prunes.filter((p) => p.policy === "delete").length;
        const recreatedNote =
          attempt.recreatedCount > 0
            ? ` ${attempt.recreatedCount} re-created server${attempt.recreatedCount === 1 ? "" : "s"} kept ${attempt.recreatedCount === 1 ? "its" : "their"} credentials.`
            : "";
        // FINDING 2 (P2, second-sweep-abort review) — surface any teardown
        // that was contained (not swallowed silently) above.
        const teardownFailureNote =
          attempt.teardownFailureCount > 0
            ? ` Runtime cleanup incomplete for ${attempt.teardownFailureCount} server${
                attempt.teardownFailureCount === 1 ? "" : "s"
              } — close ${attempt.teardownFailureCount === 1 ? "its" : "their"} terminal${
                attempt.teardownFailureCount === 1 ? "" : "s"
              } manually.`
            : "";
        void vscode.window.showInformationMessage(
          `Inventory sync complete: +${finalPlan.adds.length} ~${finalPlan.updates.length} -${deletedCount} (${finalPlan.unchangedCount} unchanged).${recreatedNote}${teardownFailureNote}`
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
