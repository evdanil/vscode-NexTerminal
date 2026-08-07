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

async function promptPrunePolicy(targetFolder: string): Promise<InventoryPrunePolicy | undefined> {
  const orphanTarget = targetFolder ? `${targetFolder}/${ORPHAN_FOLDER_NAME}` : ORPHAN_FOLDER_NAME;
  const pick = await vscode.window.showQuickPick(
    [
      { label: `Move to "${orphanTarget}"`, description: "Recommended — keeps synced settings if the device returns", value: "orphan" as const },
      { label: "Delete", description: "Removes the server and its saved credentials", value: "delete" as const },
      { label: "Keep", description: "Leaves the server where it is", value: "keep" as const }
    ],
    { title: "When a device disappears from the source…" }
  );
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
      const pick = await vscode.window.showQuickPick(
        [
          { label: "Yes", value: true },
          { label: "No", value: false }
        ],
        { title: field.label, placeHolder: field.description }
      );
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
      lines.push(`${dependents} other server${dependents === 1 ? "" : "s"} use these as SSH jump hosts.`);
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
    const secretFieldIds = provider.configFields.filter((f) => f.type === "password").map((f) => f.id);

    // F18 — secrets to vault FIRST; only on success does the source record get created.
    try {
      for (const fieldId of secretFieldIds) {
        const value = secrets[fieldId];
        if (value !== undefined) {
          await vault.store(inventorySecretKey(id, fieldId), value);
        }
      }
    } catch {
      void vscode.window.showErrorMessage("Could not store credentials in the system keychain — the source was not created.");
      return;
    }

    const source: InventorySourceConfig = { id, providerId: provider.id, name, targetFolder, prunePolicy, defaultUsername, config, secretFieldIds };
    await core.addOrUpdateInventorySource(source);

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

      const prunePolicy = await promptPrunePolicy(targetFolder);
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

      const newSecretFieldIds = provider.configFields.filter((f) => f.type === "password").map((f) => f.id);

      // F18 — vault writes first; only re-entered secrets are stored, so a blank field
      // leaves its previously saved value untouched.
      try {
        for (const [fieldId, value] of Object.entries(reenteredSecrets)) {
          await vault.store(inventorySecretKey(source.id, fieldId), value);
        }
      } catch {
        void vscode.window.showErrorMessage("Could not store credentials in the system keychain — the source was not updated.");
        return;
      }

      const updated: InventorySourceConfig = { ...source, name, targetFolder, prunePolicy, defaultUsername, config, secretFieldIds: newSecretFieldIds };
      await core.addOrUpdateInventorySource(updated);

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
      const secrets: InventorySourceSecrets = {};
      for (const fieldId of source.secretFieldIds) {
        const value = await vault.get(inventorySecretKey(source.id, fieldId));
        if (value === undefined) {
          void vscode.window.showErrorMessage(`Missing saved credential "${fieldId}" for "${source.name}". Edit the source to re-enter it.`);
          return;
        }
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
