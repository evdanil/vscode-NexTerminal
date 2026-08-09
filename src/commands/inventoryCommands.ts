import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { InventorySourceRemovalMismatchError, type NexusCore } from "../core/nexusCore";
import type { AuthProfile, HttpConnectProxy, ProxyConfig, ServerConfig, Socks5Proxy } from "../models/config";
import { authProfileNeedsServerKeyPath, authProfileOwnedCredentials, cloneTemplatedStamps } from "../models/config";
import type { DeviceTemplateProfile } from "../models/deviceTemplate";
import {
  computeProviderFingerprint,
  InventoryProviderError,
  inventorySecretKey,
  inventorySourceValuesEqual,
  resolveProviderInstanceKey,
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
  computeSyncPlan,
  planToApplication,
  prunedServerIdsForSecretCleanup,
  validateInventoryTree,
  type InventoryAdoptionChoice,
  type InventorySyncPlan
} from "../services/inventory/syncEngine";
import type { SecretVault } from "../services/ssh/contracts";
import { passphraseSecretKey, passwordSecretKey, proxyPasswordSecretKey } from "../services/ssh/silentAuth";
import { configMutationLock } from "../services/configMutationLock";
import { inventoryConfigFieldPrefixedKey, inventorySourceFormDefinition } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { INVALID_FOLDER_PATH_MESSAGE, normalizeOptionalFolderPath } from "../utils/folderPaths";
import { mostCommonUsername } from "./configCommands";
import { createInlineAuthProfileCreation } from "./inlineAuthProfileCreation";

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
  return `Inventory provider "${providerId}" is not available (the extension providing it may be disabled).`;
}

/**
 * WHY a source is currently claimed in `inFlightSourceIds` — recorded at every
 * claim site, read by every refusal message.
 *
 * BUG (user-reported) — the marker used to be a bare `Set<string>`, so all
 * three commands worded their refusal as an in-flight sync. But syncNow is
 * only ONE of the three claimants: editSource holds the same marker for as
 * long as its form stays open (F4), and removeSource holds it across its
 * confirm-and-mutate run. Leaving an Edit Source tab open therefore made Sync
 * Now announce a sync that was not running, with no clue beyond "closing the
 * tab makes it work". Each claimant now names itself, so the refusal can say
 * what is actually true.
 *
 * There is deliberately no "other"/default member: the value type is this
 * union, so a claimed-but-unexplained source is unrepresentable, and
 * `sourceBusyMessage`'s Record forces any future member to bring its own
 * wording instead of silently inheriting one of these.
 */
type SourceBusyReason = "sync" | "edit" | "remove";

/**
 * The warning a command shows when the source it was asked to act on is
 * already claimed by another command.
 *
 * `holder` is the reason recorded by whoever claimed it; `asking` is the
 * reason the CALLER would have claimed. Only the sync case reads `asking`:
 * a Sync Now refused by a running sync is the user asking for the very thing
 * already in progress ("already syncing"), while edit/remove are asking for
 * something else and need to be told what to wait for. The other two cases
 * read the same from every caller — the source is unavailable, and the
 * sentence says what is holding it and how to free it.
 *
 * The Record is the exhaustiveness gate: adding a SourceBusyReason without
 * wording for it is a compile error here, not a message that quietly lies.
 */
function sourceBusyMessage(name: string, holder: SourceBusyReason, asking: SourceBusyReason): string {
  const wording: Record<SourceBusyReason, string> = {
    sync: asking === "sync" ? `"${name}" is already syncing.` : `"${name}" is currently syncing — try again once the sync finishes.`,
    edit: `"${name}" is open in Edit Source — close that tab, then try again.`,
    remove: `"${name}" is currently being removed — try again once the removal finishes.`
  };
  return wording[holder];
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
 *
 * THE THIRD BOUNDARY is `provider.instanceKey`, and it cannot use this helper —
 * it is invoked from `resolveProviderInstanceKey` in models/inventory.ts, which
 * must not import from the command layer. It clones inline on the same terms
 * (REVIEW FINDING, P2); the rule is "no provider ever receives a live config",
 * not "every caller uses this function".
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

/**
 * FIX B (issue #48 PR-T1 / PR #61 Codex review rounds 9+10, SECURITY) — clear the
 * stale per-server `proxy-password-{id}` when an inventory update moves the
 * server's proxy identity AWAY from the authenticated SOCKS5/HTTP endpoint that
 * secret was entered for, BEFORE the apply publishes the new proxy.
 *
 * `ProxySshFactory` reads `proxy-password-{serverId}` by server id and sends it
 * to whatever proxy the record now names whenever that proxy carries a username.
 * A device template that repoints a server's proxy from one authenticated
 * socks5/http endpoint to a DIFFERENT one — or to an ssh/none proxy — leaves the
 * OLD password in the vault, so the factory would send the old proxy's password
 * to the NEW endpoint: a credential leak to the wrong host.
 *
 * ROUND 10 — WHY BEFORE THE APPLY, NOT AFTER. `nexus.server.connect` deliberately
 * does NOT take `configMutationLock` (out of scope to change — a much larger
 * refactor). Round 9 cleared the secret AFTER `applyInventorySyncPlan` had already
 * published the new proxy into the core map: a connect landing in the awaited
 * apply/save/cleanup window would read the NEW proxy config with the OLD
 * `proxy-password-{id}` still in the vault and send it to the new endpoint — the
 * exact leak, only now through a race instead of a persistent stale key. Because
 * connect can't be serialized against the apply, the ONLY way to close the window
 * is to delete the stale secret BEFORE the new proxy becomes reachable. Moving the
 * delete before publish shrinks the worst case from a credential leak to at most a
 * transient "old proxy can't authenticate until the next connect prompt" window —
 * the fail-SAFE direction.
 *
 * FAIL CLOSED ON DELETE, RESTORE ON APPLY FAILURE. The delete is security-critical,
 * so it must NOT be best-effort: if `vault.delete` throws we cannot secure the
 * proxy change, so we restore any secret already deleted in this pass and rethrow
 * to ABORT the whole sync (the new proxy is never published) — fail closed, not
 * open. Conversely, when the delete succeeds but `applyInventorySyncPlan` then
 * throws, the plan did NOT commit: the OLD proxy config is still live and still
 * needs its password, so the caller restores the captured values (best-effort).
 * Ordering is therefore: capture+delete → publish → restore-on-failure.
 *
 * §5.3 of the device-template design: templates never carry proxy SECRETS — a
 * template-set socks5/http proxy relies on the per-connect prompt — so clearing
 * the stale secret is exactly right: the new proxy prompts per-connect rather
 * than reusing a password meant for a different endpoint.
 *
 * STALE (must be cleared) iff EITHER `before.proxy` OR `after.proxy` is a
 * password-bearing (`socks5`|`http`) endpoint AND the two are NOT the SAME
 * authenticated endpoint (same `type`+`host`+`port`+`username` — the identity
 * the password was entered for). The SAME-endpoint case KEEPS the secret — it
 * still applies. An ssh proxy never carries a password, so ssh↔ssh (and any
 * neither-side-bearing update, e.g. undefined↔ssh) needs no handling; a change
 * FROM socks5/http TO ssh/none clears the stale secret.
 *
 * ROUND 11 — WHY THE `after`-SIDE TRIGGER, not just `before`. A non-password-bearing
 * `before.proxy` (undefined or ssh) does NOT prove no `proxy-password-{id}` secret
 * exists: `configCommands.ts` restores every exported proxy password for an imported
 * server id WITHOUT requiring that server to currently carry a socks5/http proxy, so
 * a legacy backup can leave an ORPHANED entry sitting under an undefined/ssh proxy.
 * If a template then assigns that server a NEW authenticated socks5/http endpoint, a
 * `before`-only rule would early-return (before isn't password-bearing) and SKIP the
 * clear — sending the orphaned password to the new proxy. Triggering on EITHER side
 * closes that leak. It is a strict SUPERSET of the round-9 rule (every case it
 * cleared, this clears), and because the capture step reads the vault value first,
 * an update that newly matches but has no stored secret captures nothing and deletes
 * nothing — broadening the trigger costs nothing where there is no orphan.
 *
 * Centralized so EVERY inventory apply site shares one rule (invoked before BOTH
 * the fast-path recompute apply AND the in-lock confirmed apply). Deliberately NOT
 * the server-form `syncProxyPasswordSecret` path — that governs hand-edited
 * proxies and bypasses this apply flow entirely.
 *
 * Returns the `{key,value}` pairs it captured+deleted so the caller can restore
 * them if the subsequent apply throws. On any delete error it restores what it
 * already deleted in this pass (capture-delete atomicity — a mid-loop failure
 * must not strip a password with no publish and no restore) and rethrows.
 */
/**
 * A `proxy-password-{id}` secret only ever belongs to a `socks5`/`http` proxy —
 * the only kinds `ProxySshFactory` sends it to (an ssh jump proxy carries no
 * password). Narrows to that authenticated shape so both sides of an update can
 * be compared by identity below.
 */
function isPasswordBearingProxy(proxy: ProxyConfig | undefined): proxy is Socks5Proxy | HttpConnectProxy {
  return proxy !== undefined && (proxy.type === "socks5" || proxy.type === "http");
}

/**
 * Whether `before` and `after` are the SAME authenticated (socks5/http) endpoint —
 * same `type`+`host`+`port`+`username`, the identity the stored password was
 * entered for. This is the ONE case a proxy update KEEPS the secret: it still
 * applies. Both sides must be password-bearing to be "the same endpoint"; an
 * ssh/none on either side is never equal to a socks5/http one.
 */
function isSameAuthenticatedEndpoint(before: ProxyConfig | undefined, after: ProxyConfig | undefined): boolean {
  return (
    isPasswordBearingProxy(before) &&
    isPasswordBearingProxy(after) &&
    before.type === after.type &&
    before.host === after.host &&
    before.port === after.port &&
    before.username === after.username
  );
}

async function clearStaleProxyPasswordSecretsBeforeApply(
  vault: SecretVault,
  updates: ReadonlyArray<{ before: ServerConfig; after: ServerConfig }>
): Promise<Array<{ key: string; value: string }>> {
  const captured: Array<{ key: string; value: string }> = [];
  for (const { before, after } of updates) {
    const bp = before.proxy;
    const ap = after.proxy;
    // ROUND 11 — trigger on EITHER side being a password-bearing endpoint. A
    // non-password-bearing `before.proxy` does NOT prove no secret exists (an
    // orphaned legacy-backup entry can sit under an undefined/ssh proxy), so an
    // `after`-side authenticated endpoint must trigger the clear too — see the
    // function doc for why.
    if (!isPasswordBearingProxy(bp) && !isPasswordBearingProxy(ap)) {
      continue; // neither side carries a proxy password — nothing to leak (ssh proxies never send one)
    }
    if (isSameAuthenticatedEndpoint(bp, ap)) {
      continue; // still the same authenticated endpoint — the stored password still applies
    }
    // before.id === after.id (same record through an update); use after.id.
    const key = proxyPasswordSecretKey(after.id);
    let existing: string | undefined;
    try {
      existing = await vault.get(key);
    } catch (error) {
      // Cannot even read the secret — restore what we've deleted so far, abort.
      await restoreProxyPasswordSecrets(vault, captured);
      throw error;
    }
    // Capture BEFORE the delete so an aborting delete restores this key too (the
    // delete may have partially applied; restoring the old value is fail-safe).
    if (existing !== undefined) {
      captured.push({ key, value: existing });
    }
    try {
      await vault.delete(key);
    } catch (error) {
      // FAIL CLOSED — a proxy change we cannot secure must not be published.
      await restoreProxyPasswordSecrets(vault, captured);
      throw error;
    }
  }
  return captured;
}

/**
 * ROUND 10 — put back the proxy-password secrets captured by
 * `clearStaleProxyPasswordSecretsBeforeApply` when the apply they preceded did
 * NOT commit (or a mid-pass delete aborted). The old proxy config is still live
 * and still needs its password, so restoring is the fail-safe recovery. Best
 * effort per key: a failed restore here costs at most a re-prompt on the next
 * connect, and must not mask the original failure that triggered the restore.
 */
async function restoreProxyPasswordSecrets(
  vault: SecretVault,
  captured: ReadonlyArray<{ key: string; value: string }>
): Promise<void> {
  for (const { key, value } of captured) {
    try {
      await vault.store(key, value);
    } catch (error) {
      console.warn(`[Nexus] Failed to restore proxy password secret "${key}":`, error);
    }
  }
}

/**
 * ITEM A (restamp ordering) — restamps the source's providerFingerprint as
 * its OWN locked write, strictly AFTER a sync has already committed
 * successfully, rather than mid-flow (before/during the fetch+apply). The
 * rest of syncNow threads one fetch-time snapshot (`source`) through several
 * interlocking race guards — most centrally
 * `sourceConfigUnchanged(source, freshSource)`, which (once both sides carry
 * a revision, which every loaded record does) is decided ENTIRELY by
 * revision equality, and `addOrUpdateInventorySource` mints a brand-new
 * revision on every write with no exception for this one. Restamping before
 * or during the sync would therefore invalidate `source`'s revision out from
 * under every later drift check in that same run, unless `source` itself
 * were reassigned to the freshly restamped record at every downstream use —
 * a materially larger, riskier change to a function that already carries the
 * FINDINGS D/E/1/2/4 race-guard chain. Firing this only once the sync has
 * fully committed sidesteps all of that: nothing later in THIS invocation
 * reads `source` again, so a fresh read-and-write here needs to agree with
 * nothing but the CURRENT persisted record. Best-effort and independently
 * locked (a separate, non-nested configMutationLock acquisition, taken after
 * the sync's own acquisition has already resolved) — a failed restamp here
 * costs nothing but showing the confirm modal once more on the NEXT sync;
 * it must never fail the sync that already succeeded.
 */
/**
 * F5 — `syncSnapshot` is the EXACT record incarnation the sync that just
 * committed actually ran against (the `freshSource` read inside the sync's
 * own locked attempt, immediately before apply) — never the sourceId alone.
 * Without this, "whatever record currently holds the id" gets stamped
 * unconditionally: a source replaced (edited, or recreated by a
 * replace-mode import) in the gap between the sync committing and this
 * best-effort restamp acquiring its own lock would have the JUST-SYNCED
 * fingerprint silently stamped onto a DIFFERENT config's record — the next
 * syncNow would then skip the mismatch modal for a provider change it never
 * actually confirmed. `sourceConfigUnchanged` (revision-based once both
 * sides have one — see its doc) plus a name comparison (not covered by that
 * comparator) together prove the current record is still the same
 * incarnation the sync ran against; a routine lastSyncAt-only bump from the
 * sync's own apply never changes revision, so this still matches on the
 * ordinary, non-racy path.
 */
async function restampProviderFingerprintBestEffort(core: NexusCore, syncSnapshot: InventorySourceConfig, fingerprint: string): Promise<void> {
  await configMutationLock.runExclusive(async (): Promise<void> => {
    const current = core.getInventorySource(syncSnapshot.id);
    if (!current || current.providerFingerprint === fingerprint) {
      return;
    }
    if (!sourceConfigUnchanged(current, syncSnapshot) || current.name !== syncSnapshot.name) {
      return;
    }
    try {
      await core.addOrUpdateInventorySource({ ...current, providerFingerprint: fingerprint });
    } catch (error) {
      console.warn(`[Nexus] Failed to restamp provider fingerprint for inventory source "${syncSnapshot.id}":`, error);
    }
  });
}

/**
 * F3 — shared Continue/Cancel gate for handing a provider registrant a
 * source's saved secrets when its declared shape (label/configFields) has
 * drifted since the source was last saved/edited (see
 * InventorySourceConfig.providerFingerprint's doc for the trust-model
 * rationale). Used by BOTH syncNow (before its required-secret vault reads)
 * and editSource (before the form — and its Test button's vault-backed
 * secret hydration — ever opens) so the two flows can't drift on when this
 * confirmation is required. `outcome: "cancelled"` means the caller must
 * abort before any vault read for this source; `fingerprintToStamp` is only
 * meaningful to callers (syncNow) that restamp on their own success path —
 * editSource's Save already restamps unconditionally on every save
 * (deliberate — see persistUpdatedInventorySource's ITEM A) and ignores it.
 */
async function checkProviderFingerprint(
  source: InventorySourceConfig,
  provider: InventoryProvider
): Promise<{ outcome: "ok"; fingerprintToStamp: string | undefined } | { outcome: "cancelled" }> {
  const currentProviderFingerprint = computeProviderFingerprint(provider);
  if (source.providerFingerprint === undefined) {
    return { outcome: "ok", fingerprintToStamp: currentProviderFingerprint };
  }
  if (source.providerFingerprint === currentProviderFingerprint) {
    return { outcome: "ok", fingerprintToStamp: undefined };
  }
  const choice = await vscode.window.showWarningMessage(
    `Provider "${source.providerId}" looks different from when "${source.name}" was configured — its label or fields changed. Pass its saved credentials to the current provider?`,
    { modal: true },
    "Continue",
    "Cancel"
  );
  if (choice !== "Continue") {
    return { outcome: "cancelled" };
  }
  return { outcome: "ok", fingerprintToStamp: currentProviderFingerprint };
}

function describeInventoryError(error: unknown): string {
  if (error instanceof InventoryProviderError) {
    const prefix = error.kind === "auth" ? "Authentication failed" : error.kind === "network" ? "Network error" : "Unexpected response";
    return `${prefix}: ${error.message}`;
  }
  return String(error);
}

/**
 * m4 — core.applyInventorySyncPlan throws a plain Error (never a dedicated
 * type — see nexusCore.ts ~437-441) whose message names the raw sourceId and
 * says nothing a user would recognize. Detected here by a narrow substring
 * check on that exact wording rather than an exported error class (none
 * exists for this one) so the two call sites below can swap in the friendly,
 * source-name-bearing wording already used at the pre-apply fast-fail check
 * (~1330) instead of surfacing the raw "Inventory sync failed: ...uuid..."
 * text. Core's own message is NEVER changed by this — it's also asserted
 * verbatim by nexusCoreInventory.test.ts.
 */
function isSourceConfigMismatchError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("configuration changed since the sync was computed");
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
    // M2d — an action button straight to the add-source wizard, rather than
    // leaving "add one first" as an instruction with no affordance attached.
    void vscode.window.showWarningMessage("No inventory sources configured. Add one first.", "Add Inventory Source").then((choice) => {
      if (choice === "Add Inventory Source") void vscode.commands.executeCommand("nexus.inventory.addSource");
    });
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

interface ProviderPickResult {
  provider: InventoryProvider;
  /**
   * Whether a QuickPick was actually displayed to the user. False when
   * exactly one provider is registered (the auto-select branch below) — kept
   * for callers that care whether a picker interrupted the flow, though
   * addSource itself no longer needs it now that the form replaces the
   * sequential-prompt wizard's step numbering.
   */
  shown: boolean;
}

/** Auto-skips the picker when exactly one provider is registered. */
async function promptProviderPick(registry: InventoryProviderRegistry): Promise<ProviderPickResult | undefined> {
  const providers = registry.list();
  if (providers.length === 0) {
    void vscode.window.showErrorMessage("No inventory providers are registered.");
    return undefined;
  }
  if (providers.length === 1) {
    return { provider: providers[0], shown: false };
  }
  const pick = await vscode.window.showQuickPick(
    providers.map((provider) => ({ label: provider.label, provider })),
    { title: "Select Inventory Provider" }
  );
  return pick ? { provider: pick.provider, shown: true } : undefined;
}

/**
 * Voluntary connection test — fired only by the form's Test button, never by
 * Save. Unlike the old wizard's testConnectionWithRetry, a failure here never
 * gates persistence (no "Save Anyway" prompt): this just reports success or
 * failure and lets the user decide what to do next from the still-open form.
 */
async function testInventoryConnection(
  name: string,
  provider: InventoryProvider,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets
): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Testing connection to "${name}"…` },
      () => {
        const cloned = cloneForProvider(config, secrets);
        return provider.testConnection(cloned.config, cloned.secrets);
      }
    );
    void vscode.window.showInformationMessage(`Connection test succeeded for "${name}".`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Connection test failed: ${describeInventoryError(error)}`);
  }
}

interface ProviderConfigFormResult {
  config: InventorySourceValues;
  secrets: InventorySourceSecrets;
}

/**
 * Maps the form's flat FormValues object back to the provider's (config,
 * secrets) shape — the collection-side counterpart of
 * inventoryConfigFieldDescriptor (ui/formDefinitions.ts). Reads each
 * provider field's value from its PREFIXED form key
 * (inventoryConfigFieldPrefixedKey(field.id) — see F2's doc there) but
 * writes it back into `config`/`secrets` under the field's own unprefixed
 * `id`, exactly as InventorySourceValues/Secrets and the vault expect —
 * without this split, a provider field id that collided with a reserved
 * top-level key ("name", "targetFolder", "authProfileId", "defaultUsername",
 * "prunePolicy") would silently overwrite that source field's own value in
 * the same flat FormValues object (or be overwritten by it), whichever
 * happened to be assigned last. ("authProfileId" is doubly reserved: it is
 * also the key createInlineAuthProfileCreation hard-filters on.)
 *
 * `existingSecretFieldIds` (edit flow) marks which password fields already
 * have a saved vault value: a blank value for one of those is treated as
 * "keep the saved value" (omitted from `secrets` entirely, exactly like the
 * old wizard's blank-password branch) rather than a validation failure.
 *
 * Throws a plain Error naming the field on a required-but-missing value —
 * the form's own HTML `required` attribute already blocks most of these at
 * the browser layer (see inventoryConfigFieldDescriptor's `required` wiring),
 * this is the defense-in-depth layer for anything that reaches onSubmit/
 * onTest anyway (a value programmatically posted, or a required password
 * field newly required by a provider schema change since the form opened).
 */
function formValuesToProviderConfig(
  fields: InventoryConfigField[],
  values: FormValues,
  existingSecretFieldIds: ReadonlySet<string> = new Set()
): ProviderConfigFormResult {
  const config: InventorySourceValues = {};
  const secrets: InventorySourceSecrets = {};

  for (const field of fields) {
    const raw = values[inventoryConfigFieldPrefixedKey(field.id)];

    if (field.type === "password") {
      const hasSaved = existingSecretFieldIds.has(field.id);
      if (typeof raw === "string" && raw !== "") {
        secrets[field.id] = raw;
      } else if (field.required && !hasSaved) {
        throw new Error(`${field.label} is required`);
      }
      continue;
    }

    if (field.type === "boolean") {
      config[field.id] = raw === true;
      continue;
    }

    if (field.type === "number") {
      let numeric: number | undefined;
      if (typeof raw === "number" && Number.isFinite(raw)) {
        numeric = raw;
      } else if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
        numeric = Number(raw);
      }
      if (numeric !== undefined) {
        config[field.id] = numeric;
      } else if (field.required) {
        throw new Error(`${field.label} is required`);
      }
      continue;
    }

    // string
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed !== "") {
      config[field.id] = trimmed;
    } else if (field.required) {
      throw new Error(`${field.label} is required`);
    }
  }

  return { config, secrets };
}

interface ParsedSourceFormValues {
  name: string;
  targetFolder: string;
  /** `undefined` for the select's `(None)` option, never the empty string. */
  authProfileId?: string;
  defaultUsername: string;
  prunePolicy: InventoryPrunePolicy;
  config: InventorySourceValues;
  secrets: InventorySourceSecrets;
}

/**
 * Validates and normalizes the form's top-level (non-provider) fields and
 * delegates the provider config fields to formValuesToProviderConfig. Thrown
 * errors surface through WebviewFormPanel's generic "Save failed: ..."
 * banner and leave the form open for correction — the same recoverable
 * contract the old wizard's validateInput callbacks had, just surfaced once
 * at submit time instead of per-keystroke.
 *
 * Top-level-folder confirmation: the form itself has no confirm-modal
 * affordance, so this reproduces the old promptTargetFolder loop's warning
 * with a plain vscode.window.showWarningMessage (onSubmit runs in the
 * extension host, same as any other command) — "Continue" proceeds with an
 * empty (top-level) target folder, anything else throws so the form stays
 * open for the user to either type a folder or click Save again to confirm.
 */
async function parseSourceFormValues(
  values: FormValues,
  provider: InventoryProvider,
  existingSecretFieldIds: ReadonlySet<string> = new Set()
): Promise<ParsedSourceFormValues> {
  const name = typeof values.name === "string" ? values.name.trim() : "";
  if (!name) {
    throw new Error("Name is required");
  }

  const rawFolder = typeof values.targetFolder === "string" ? values.targetFolder : "";
  const normalizedFolder = normalizeOptionalFolderPath(rawFolder);
  if (normalizedFolder === null) {
    throw new Error(INVALID_FOLDER_PATH_MESSAGE);
  }
  const targetFolder = normalizedFolder ?? "";
  if (targetFolder === "") {
    // m9 — same modal wording/convention as the rest of this file (see
    // removeSource's own confirm).
    const choice = await vscode.window.showWarningMessage(
      "Place synced servers at the top level? No target folder was entered.",
      { modal: true },
      "Continue"
    );
    if (choice !== "Continue") {
      throw new Error("Enter a target folder, or click Save again to confirm placing synced servers at the top level.");
    }
  }

  // The Auth Profile select submits "" for its `(None)` option; a source must
  // never store that as an id — validateInventorySource rejects a non-empty
  // string, sourceConfigUnchanged would see "" and undefined as different
  // configurations, and the engine's resolution guard would treat "" as a
  // dangling reference and warn on every sync. Normalized to `undefined`
  // here, once, so nothing downstream has to know about the empty option.
  //
  // No existence check HERE: parsing has no core access, and a check at this
  // point would sit an entire keychain round trip away from the write it is
  // meant to protect. The posted id is re-resolved against live core state
  // immediately before the record is persisted instead — see
  // MISSING_AUTH_PROFILE_MESSAGE and the two persist helpers below.
  const rawAuthProfileId = values.authProfileId;
  const authProfileId = typeof rawAuthProfileId === "string" && rawAuthProfileId !== "" ? rawAuthProfileId : undefined;

  const defaultUsername = typeof values.defaultUsername === "string" ? values.defaultUsername.trim() : "";
  if (!defaultUsername) {
    throw new Error("Default SSH Username is required");
  }

  const rawPrunePolicy = values.prunePolicy;
  const prunePolicy: InventoryPrunePolicy =
    rawPrunePolicy === "delete" || rawPrunePolicy === "keep" ? rawPrunePolicy : "orphan";

  const { config, secrets } = formValuesToProviderConfig(provider.configFields, values, existingSecretFieldIds);

  return { name, targetFolder, authProfileId, defaultUsername, prunePolicy, config, secrets };
}

/**
 * REVIEW FINDING (P2) — shared by both persist helpers below, which re-resolve
 * the form's selected auth profile against LIVE core state immediately before
 * writing the source record.
 *
 * WHY A LATE RE-CHECK AT ALL: the select is populated once, when the form
 * opens, and the form can then sit open indefinitely. Deleting that profile in
 * the meantime (AuthProfileEditorPanel -> NexusCore.removeAuthProfile) leaves
 * the still-open form posting an id that no longer names anything.
 * removeAuthProfile's own reference clearing cannot help: it only touches
 * sources that ALREADY reference the profile. So the two cases it re-revisions
 * nothing for — an Add form (no record yet, hence nothing for the edit path's
 * ITEM 4 drift guard to compare against) and an Edit form switching a source
 * ONTO a profile it wasn't linked to — would persist a dangling reference,
 * and every later sync of that source would quietly fall back to the default
 * username with SSH agent auth: the exact defect this link exists to prevent,
 * with only a per-sync warning to show for it.
 *
 * WHY REJECT RATHER THAN CLEAR TO `(None)`: the user made an explicit
 * credential choice that can no longer be honoured. Saving without it is how
 * synced devices land on credentials nobody chose; refusing keeps the form
 * open (WebviewFormPanel's "Save failed: ..." banner) with the choice intact
 * so it can be re-pointed or deliberately cleared.
 *
 * Named, not id'd: this file's copy never shows a UUID (m3), and the profile
 * is gone by now, so there is no name left to quote either.
 */
const MISSING_AUTH_PROFILE_MESSAGE = "The selected auth profile no longer exists. Choose another, or clear the Auth Profile field.";

/**
 * REVIEW FINDING (P1) — the second reason a selected profile cannot be
 * honoured, refused in the same breath and by the same two persist helpers as
 * the first.
 *
 * A `key` profile that carries no key path forces `authType: "key"` onto every
 * server linked to it while supplying no path, and NO server this source
 * produces can supply one of its own: the add path writes `authType: "agent"`
 * with no `keyPath`, and retro-apply adopts only servers still carrying exactly
 * that. So `buildConnectConfig` throws `Missing keyPath for key auth on
 * <server>` for every device the source has ever synced or will sync — the same
 * fleet-wide unusability this feature was written to end, entered through the
 * Auth Profile select instead of through the missing default. See
 * `authProfileNeedsServerKeyPath` (models/config.ts) for why this is a property
 * of the PAIRING rather than something the field-ownership rule should absorb,
 * and why such a profile stays perfectly valid on a server form.
 *
 * WHY HERE AND NOT IN THE SELECT'S OPTION LIST: options are built once, when
 * the form opens, so filtering them cannot govern a profile whose key path is
 * removed while the form sits open — the same reason the missing-profile check
 * above is a persist-time re-resolve rather than a render-time filter. It would
 * also silently drop the currently-linked profile out of an Edit form's own
 * select, turning "your source is misconfigured" into "your source is linked to
 * nothing", which is the state this refusal exists to avoid persisting.
 * Refusing at Save keeps the choice visible and says what to repair.
 *
 * NAMED here, unlike MISSING_AUTH_PROFILE_MESSAGE: the profile still exists, so
 * there is a name to quote (m3 — a name, never the id), and the repair is to
 * that profile rather than to this form.
 */
function keylessKeyAuthProfileMessage(profile: AuthProfile): string {
  return `The auth profile "${profile.name}" uses private key authentication but has no key file. Servers synced from this source have no key of their own, so none of them could connect. Add a key file to that profile, or choose another.`;
}

/**
 * REVIEW FINDING (P2) — what an Add or Edit Source form committed to when it
 * last put a profile's username on screen. Compared against LIVE core state at
 * Save by `inventoryAuthProfileRejection`, the source form's counterpart of the
 * server form's `RenderedAuthProfile` (commands/serverCommands.ts).
 */
export interface RenderedSourceAuthProfile {
  /** The id whose username the form is currently showing. */
  id: string;
  /**
   * The username that profile SUPPLIED at that moment — THE ONE RULE
   * (`authProfileOwnedCredentials`), i.e. precisely what
   * `fallbackUsernameForSource` would have stored had Save been pressed then,
   * and `undefined` where it supplied none and Default SSH Username kept the
   * user's own value, unlocked.
   *
   * The value itself rather than the hashed shape the server form compares
   * (`authProfileOwnershipSignature`): there is exactly ONE profile fact a
   * source save reads, so `===` over `string | undefined` states it exactly,
   * with nothing to encode and nothing to collide.
   */
  username: string | undefined;
}

/**
 * The stamp for a profile this form is about to be handed the username of,
 * built from the SAME lookup the render (or the mirror) is built from, so what
 * the form shows and what Save checks against are one fact rather than two
 * lookups that can disagree.
 *
 * `undefined` for an id that resolves to no profile — the state in which the
 * form is showing NO profile's username: the mirror answers nothing (so
 * WebviewFormPanel suppresses the fillFields round trip entirely) and the Edit
 * render sanitizes such a seed down to `(None)` (`inventorySourceFormDefinition`,
 * ui/formDefinitions.ts). A Save that still carries that id is refused as
 * missing, one check earlier.
 */
function renderedSourceAuthProfile(profile: AuthProfile | undefined): RenderedSourceAuthProfile | undefined {
  return profile ? { id: profile.id, username: authProfileOwnedCredentials(profile).username } : undefined;
}

/**
 * REVIEW FINDING (P2) — the third reason a selected profile cannot be honoured,
 * refused in the same breath as the other two: the profile still exists and is
 * still linkable, but it no longer supplies the username the form is showing
 * for it.
 *
 * Named, like the keyless-key refusal and unlike the missing one: the profile
 * is still there to be named (m3 — a name, never the id), and the repair is a
 * single action in THIS form.
 */
function changedAuthProfileUsernameMessage(profile: AuthProfile): string {
  return `The auth profile "${profile.name}" changed the username it supplies while this form was open, so Default SSH Username on screen is not the one a save would store. Re-select it in the Auth Profile list to pick up its current username, then save again.`;
}

/**
 * The single answer to "may this source be saved carrying this auth profile?",
 * shared by both persist helpers so the Add and Edit paths cannot diverge on
 * it. Returns the message to reject with, or `undefined` to proceed.
 *
 * `profile` is what `authProfileId` resolved to against LIVE core state a
 * statement earlier — the caller does the lookup because only it knows which
 * rollback its own critical section owes on the way out. `rendered` is the
 * form's own stamp (`renderedSourceAuthProfile`), threaded through the persist
 * input so both paths are answered by this one function.
 *
 * REVIEW FINDING (P2) — THE THIRD CHECK, and why its comparand is not the
 * server form's.
 *
 * WHAT GOES WRONG WITHOUT IT: `fallbackUsernameForSource` derives
 * `defaultUsername` from the LIVE profile, deliberately and unconditionally. So
 * a username edited in the Auth Profile Editor while this form sat open makes
 * Save store a username the form never displayed — in a field the profile had
 * LOCKED, so the user could not have corrected it even had they noticed — and
 * nothing else surfaces it. Editing a profile does not revise the source, so
 * the edit path's ITEM 4 drift guard passes; saving any unrelated field
 * (a rename, a new target folder) is enough to carry it in. What lands is not
 * cosmetic either: `defaultUsername` is the username every server this source
 * syncs is stamped with, and the one `SilentAuthSshFactory` falls back to for
 * all of them if the profile is ever removed.
 *
 * THE COMPARAND IS THE USERNAME, AND ONLY THE USERNAME. The server form
 * compares `authProfileOwnershipSignature`, which deliberately EXCLUDES the
 * profile's values: a linked server stores neither the profile's username nor
 * its key path, so a value that moves under an open server form changes nothing
 * that save writes, and only the ownership SHAPE (plus `authType`, which
 * decides which credential control is rendered at all) can. Here that reasoning
 * INVERTS. A source record takes exactly one thing from its profile — the
 * username's VALUE, via `fallbackUsernameForSource` — and takes nothing else:
 * no `authType`, no key path, no name. So this compares the value the server
 * form omits, and omits everything the server form compares. Both halves cost
 * something to get wrong: including `authType` would refuse saves that are
 * correct (switching a profile from password to SSH agent changes nothing a
 * source record holds), and omitting the value would let the finding straight
 * through.
 *
 * "SUPPLIES NONE" IS A DISTINCT STATE, not a blank — which is the one thing
 * this shares with the server's signature, applied to the single field this
 * form has. GAINING a username (an imported blank-username profile edited into
 * a real one) turns the fallback the user typed and can see, in an unlocked
 * field, into one the save silently replaces. LOSING it leaves Default SSH
 * Username locked on screen against a profile that no longer fills it; the
 * string written happens to coincide, but what it MEANS does not — it stops
 * being the profile's username and becomes the source's own account, and only
 * a re-select runs the webview's release (`profileDisplacedValues`,
 * ui/formHtml.ts) that unlocks the field the user would need to change it in.
 *
 * ONLY WHEN `rendered` NAMES THE SUBMITTED ID — and this is where the server's
 * guard deliberately goes further than this one. There, a submission naming a
 * profile the form never rendered is refused outright, because
 * `preserveLinkedServerCredentials` reads the live profile to decide which
 * submitted fields are the user's own input, and that decision would be made
 * about a form nobody saw. Here the save does not decide anything from the
 * submission: it DERIVES the username from the live profile, so a Save that
 * beats the mirror's round trip stores exactly what the completed mirror would
 * have shown a moment later. That is `fallbackUsernameForSource`'s documented
 * purpose — making the invariant independent of webview timing — and refusing
 * it would reintroduce the very timing dependence that helper removed (the
 * "Save beats the autofill round trip" tests in
 * test/unit/inventoryCommands.test.ts pin it). What is checked is therefore
 * what this form actually PUT ON SCREEN for this profile, which is established
 * by the mirror's answer or by the Edit form's own render, and by nothing else.
 *
 * REJECT rather than re-render, for the same reason the server form does: the
 * values needed to re-render correctly live in the webview's transition
 * machinery, and pushing a bare `fillFields` from here would apply the new
 * state WITHOUT the release step, leaving a field the profile no longer fills
 * unlocked and still holding the profile's value. The message names the one
 * action that runs the real transition — re-select the profile.
 *
 * Call it with a `profile` re-resolved inside `configMutationLock`. Auth
 * profile writes take that same lock (ui/authProfileEditorPanel.ts), so a check
 * made while holding it stays true through the write it is guarding.
 */
function inventoryAuthProfileRejection(
  authProfileId: string | undefined,
  rendered: RenderedSourceAuthProfile | undefined,
  profile: AuthProfile | undefined
): string | undefined {
  if (authProfileId === undefined) {
    return undefined;
  }
  if (profile === undefined) {
    return MISSING_AUTH_PROFILE_MESSAGE;
  }
  if (authProfileNeedsServerKeyPath(profile)) {
    // Ahead of the drift check on purpose: a keyless key profile cannot be
    // linked at all, so "add a key file to that profile, or choose another" is
    // the repair even when its username moved too — re-selecting it would only
    // land the user back on this same refusal.
    return keylessKeyAuthProfileMessage(profile);
  }
  if (rendered?.id === authProfileId && rendered.username !== authProfileOwnedCredentials(profile).username) {
    return changedAuthProfileUsernameMessage(profile);
  }
  return undefined;
}

/**
 * REVIEW FINDING (P2) — the fallback username a source records. Called by both
 * persist helpers with the profile they just re-resolved (above), i.e. at the
 * exact moment the record is written.
 *
 * INVARIANT: every save through these two helpers — i.e. every save the Add and
 * Edit Source forms can make — stores the LINKED PROFILE's username as the
 * source's `defaultUsername`. (Nothing here reaches configCommands' backup
 * import, which restores whatever pair a file happens to carry; that path
 * writes records wholesale and is not a form save.) The form's
 * mirror-and-lock of the field (onAutofill -> `{ defaultUsername }`, plus the
 * read-only rendering formHtml gives every managed key) is therefore purely
 * COSMETIC: it shows the user what will be stored, it does not decide it.
 *
 * It cannot be what decides it. The mirror is an asynchronous webview round
 * trip, so a Save clicked before it returns posts the NEW `authProfileId`
 * alongside the PREVIOUS `defaultUsername`, and both persist paths used to
 * write that submitted value verbatim — the re-resolve above only proves the id
 * still names a profile, never that the two agree. The result was a linked
 * source whose locked fallback username disagreed with its own profile, and
 * nothing surfaced it: reopening the form re-renders the mirror, showing the
 * profile's username over a record holding a different one. Deriving here makes
 * the invariant unconditional and enforceable rather than dependent on webview
 * timing.
 *
 * WHICH username is derived is THE ONE RULE (`authProfileOwnedCredentials`,
 * models/config.ts): the profile's, when it supplies a usable one — trimmed,
 * exactly as parseSourceFormValues treats the field, so the derived value is
 * bit-identical to what a completed mirror would have posted. A profile whose
 * username is whitespace-only (reachable only through an imported backup — the
 * profile editor trims and rejects blanks) supplies none, so the submitted
 * username stands, which the parser already proved non-empty: a stored empty
 * `defaultUsername` fails validateInventorySource and would take the whole
 * source record down with it at the next load.
 *
 * REVIEW FINDING (P2) — that blank-profile branch is DEFENCE IN DEPTH, not the
 * primary handling. The mirror itself declines to fill a blank username
 * (authProfileUsernameMirror), so the form always submits a username the user
 * can see and edit; this branch covers the submissions that reach here with no
 * completed mirror behind them — Save clicked before the round trip returned,
 * which is the same race the whole helper exists for. It is deliberately kept:
 * derivation must be total, because the alternative is storing a whitespace
 * (or empty) `defaultUsername` that no SSH login can use.
 *
 * REVIEW FINDING (P2) — and the fallback it stores is now HONOURED rather than
 * quietly discarded. `SilentAuthSshFactory.resolveServer` used to overwrite
 * every synced server's username with the profile's own whitespace, so this
 * valid fallback reached the record and was then ignored at connect time; it
 * reads the same rule now, so a profile that supplies no username leaves the
 * username this helper chose in place.
 */
function fallbackUsernameForSource(profile: AuthProfile | undefined, submittedUsername: string): string {
  return authProfileOwnedCredentials(profile).username ?? submittedUsername;
}

/**
 * The Auth Profile select's mirror payload, shared by the Add and Edit Source
 * forms (`onAutofill`). Selecting a profile posts its id here; whatever comes
 * back is written into the form's fields verbatim by the webview, and the
 * managed field is then rendered read-only.
 *
 * REVIEW FINDING (P2) — a profile whose username is whitespace-only (reachable
 * through an imported backup: `validateAuthProfile` only checks length, while
 * the profile editor trims and rejects blanks) must mirror NOTHING. Returning
 * `{ defaultUsername: "   " }` used to write whitespace into a field that is
 * both REQUIRED and, once a profile is linked, read-only — so
 * `parseSourceFormValues` trimmed it, rejected the save with "Default SSH
 * Username is required", and left the user no field to fix it in. The accepted
 * profile could not be linked through the form at all, and
 * `fallbackUsernameForSource`'s blank-profile branch — which exists precisely
 * for this profile — was unreachable from the real flow.
 *
 * Leaving the user's own value alone is also the CORRECT mirror: when the
 * profile has no usable username, `fallbackUsernameForSource` stores the
 * submitted one, so the field is genuinely not managed by the profile and the
 * webview must not pretend otherwise (formHtml's `updateProfileManagedFields`
 * completes the pairing — it never locks a managed field the profile left
 * empty).
 *
 * `{}` rather than `undefined` for that case: `undefined` means "no answer",
 * and WebviewFormPanel suppresses the `fillFields` round trip entirely, so the
 * form would not re-evaluate the lock after the selection. An empty payload is
 * a positive "this profile fills nothing" — it writes no values but still
 * drives the re-evaluation. `undefined` stays reserved for an id that resolves
 * to no profile at all (deleted while the form sat open), where touching the
 * form would be guessing.
 *
 * Whether there is a username to mirror, and its trimmed form, both come from
 * THE ONE RULE (`authProfileOwnedCredentials`, models/config.ts) — the same
 * one `fallbackUsernameForSource` derives the stored value from and the same
 * one `authProfileFilledKeys` seeds the lock from, so what the mirror shows,
 * what the save stores, and what the form locks cannot disagree.
 *
 * REVIEW FINDING (P2) — takes the RESOLVED profile rather than an id to look up
 * itself, so the caller's single `getAuthProfile` feeds both this answer and
 * the render stamp `inventoryAuthProfileRejection` later checks it against
 * (`renderedSourceAuthProfile`). Two lookups could straddle a profile edit and
 * stamp a shape the form was never shown.
 */
function authProfileUsernameMirror(profile: AuthProfile | undefined): Record<string, string> | undefined {
  if (!profile) {
    return undefined;
  }
  const username = authProfileOwnedCredentials(profile).username;
  return username !== undefined ? { defaultUsername: username } : {};
}

export interface NewInventorySourceInput {
  name: string;
  targetFolder: string;
  authProfileId?: string;
  /**
   * What the form last showed as `authProfileId`'s username, or `undefined`
   * where it has shown none — see `inventoryAuthProfileRejection`. Declared
   * required-but-nullable so neither form path can quietly omit it.
   */
  renderedAuthProfile: RenderedSourceAuthProfile | undefined;
  defaultUsername: string;
  prunePolicy: InventoryPrunePolicy;
  provider: InventoryProvider;
  config: InventorySourceValues;
  secrets: InventorySourceSecrets;
}

/**
 * Create-path critical section, extracted verbatim (behavior-for-behavior)
 * from the old addSource wizard's post-prompt tail: vault-first secret
 * storage (only fields actually stored count toward secretFieldIds — an
 * optional blank password field is never recorded, see FINDING 2 below),
 * rollback of this run's own vault writes on either a store failure or a
 * rejected persist (FINDING B / FINDING 1), all held under ONE
 * configMutationLock acquisition so a replace-mode import/reset can't land
 * mid-write. Returns the created record on success; throws an Error whose
 * message is shown verbatim by the caller (the form's onSubmit lets
 * WebviewFormPanel surface it as "Save failed: ...", the old wizard showed it
 * directly via vscode.window.showErrorMessage — same wording either way).
 */
async function persistNewInventorySource(
  core: NexusCore,
  vault: SecretVault,
  input: NewInventorySourceInput
): Promise<InventorySourceConfig> {
  const { name, targetFolder, authProfileId, renderedAuthProfile, defaultUsername, prunePolicy, provider, config, secrets } = input;
  const id = randomUUID();
  const passwordFieldIds = provider.configFields.filter((f) => f.type === "password").map((f) => f.id);

  // FINDING 2 — secretFieldIds records only ids ACTUALLY stored to the vault
  // this run. A password field that is optional and left blank never gets a
  // vault entry, so it must not appear here either — otherwise syncNow's
  // missing-secret guard would later error on a vault key that was never
  // written, making the source unsyncable despite the field being genuinely
  // optional.
  const secretFieldIds: string[] = [];

  // CONFIG MUTATION LOCK — the form has already resolved (submit fired) and
  // nothing left in this span shows UI, so it's safe to hold the lock across
  // the store-secrets + persist sequence. Serializes against configCommands'
  // replace-mode import / complete reset, which could otherwise delete this
  // exact source id's vault keys mid-write.
  return configMutationLock.runExclusive(async (): Promise<InventorySourceConfig> => {
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
      throw new Error("Could not store credentials in the system keychain — the source was not created.");
    }

    // REVIEW FINDING (P2) — re-resolve the selected profile against live core
    // state (see MISSING_AUTH_PROFILE_MESSAGE for why this exists and why it
    // rejects instead of clearing). This path has no RECORD drift guard of its
    // own: there is no prior record, so nothing to compare a revision against —
    // which is exactly why the form's own render stamp is threaded in here
    // (`renderedAuthProfile`, see inventoryAuthProfileRejection): on Add it is
    // the only account of what this form put on screen.
    //
    // TOCTOU: the profile-deletion path (AuthProfileEditorPanel's delete
    // handler) takes this SAME configMutationLock around its vault deletes and
    // NexusCore.removeAuthProfile — see that handler and removeAuthProfile's
    // own doc for why the lock lives at the caller rather than inside the core
    // method — so a deletion cannot interleave with this section at all. Even
    // without that, no `await` separates this check from the
    // addOrUpdateInventorySource call below, so on the extension host's single
    // thread nothing can run between them; and a deletion landing after this
    // whole section is harmless, because addOrUpdateInventorySource inserts the
    // record into the map before removeAuthProfile scans it, so the reference
    // is cleared off this source exactly as it would be off any other holder.
    const linkedProfile = authProfileId !== undefined ? core.getAuthProfile(authProfileId) : undefined;
    const authProfileRejection = inventoryAuthProfileRejection(authProfileId, renderedAuthProfile, linkedProfile);
    if (authProfileRejection !== undefined) {
      // Same best-effort rollback as FINDING B / FINDING 1 below: the source
      // is not created on this path either, so nothing would ever enumerate
      // these keys to clean them up.
      for (const fieldId of secretFieldIds) {
        try {
          await vault.delete(inventorySecretKey(id, fieldId));
        } catch {
          // best-effort rollback — ignore
        }
      }
      throw new Error(authProfileRejection);
    }

    // ITEM A — stamp the provider's fingerprint at creation time: the user
    // is knowingly configuring against WHICHEVER registrant currently holds
    // `provider.id` right now, so that registrant's observable shape is the
    // baseline every later sync compares against.
    //
    // Built HERE, below the re-resolve rather than above it, because
    // `defaultUsername` is derived from the profile that resolve produced.
    // Purely a move of the object literal: it is synchronous, so the TOCTOU
    // argument above (nothing runs between the resolve and the persist) is
    // untouched.
    const source: InventorySourceConfig = {
      id,
      providerId: provider.id,
      name,
      targetFolder,
      prunePolicy,
      authProfileId,
      // REVIEW FINDING (P2) — the profile's username, not the posted one; see
      // fallbackUsernameForSource for the invariant and why the form's mirror
      // cannot be trusted to have landed before Save.
      defaultUsername: fallbackUsernameForSource(linkedProfile, defaultUsername),
      config,
      secretFieldIds,
      providerFingerprint: computeProviderFingerprint(provider)
    };

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
      throw new Error(`Could not save inventory source "${name}" — the source was not created.`);
    }

    return source;
  });
}

export interface UpdatedInventorySourceInput {
  name: string;
  targetFolder: string;
  /** `undefined` clears an existing link — the field is always written, never merged. */
  authProfileId?: string;
  /** As `NewInventorySourceInput` — see `inventoryAuthProfileRejection`. */
  renderedAuthProfile: RenderedSourceAuthProfile | undefined;
  defaultUsername: string;
  prunePolicy: InventoryPrunePolicy;
  provider: InventoryProvider;
  config: InventorySourceValues;
  /** Only fields the user actually re-typed this run — a blank/kept field is omitted. */
  reenteredSecrets: InventorySourceSecrets;
}

/**
 * Edit-path critical section, extracted verbatim from the old editSource
 * wizard's post-prompt tail: vault writes for re-entered secrets only
 * (classified newly-written vs. overwritten by ACTUAL vault state, never by
 * secretFieldIds membership — FINDING 1 P2), a pre-persist drift guard
 * comparing the live record against the pick-time `source` (ITEM 4), persist,
 * then best-effort stale-key cleanup for password fields dropped from the
 * new secretFieldIds (FINDING 3). All in ONE configMutationLock acquisition.
 * Returns the updated record on success; throws on any failure, with
 * rollback of this run's own vault writes (new keys deleted, overwritten
 * keys restored to their pre-run value — FINDING C) before the throw.
 */
async function persistUpdatedInventorySource(
  core: NexusCore,
  vault: SecretVault,
  source: InventorySourceConfig,
  input: UpdatedInventorySourceInput
): Promise<InventorySourceConfig> {
  const { name, targetFolder, authProfileId, renderedAuthProfile, defaultUsername, prunePolicy, provider, config, reenteredSecrets } = input;
  const existingSecretFieldIds = new Set(source.secretFieldIds);

  return configMutationLock.runExclusive(async (): Promise<InventorySourceConfig> => {
    const newlyWrittenFieldIds: string[] = [];
    const overwrittenPreviousValues = new Map<string, string>();

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
        // Classify by actual vault state, not by secretFieldIds membership.
        const previousValue = await vault.get(inventorySecretKey(source.id, fieldId));
        await vault.store(inventorySecretKey(source.id, fieldId), value);
        if (previousValue !== undefined) {
          overwrittenPreviousValues.set(fieldId, previousValue);
        } else {
          newlyWrittenFieldIds.push(fieldId);
        }
      }
    } catch {
      await rollbackThisRunsVaultWrites();
      throw new Error("Could not store credentials in the system keychain — the source was not updated.");
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

    // ITEM 4 — re-read the record immediately before persisting. configCommands
    // flows (importMergeReplace, completeReset) mutate inventory sources
    // directly and bypass inFlightSourceIds entirely, so an import/reset can
    // complete while the user still has the form open. Persisting `updated`
    // (built from the pick-time `source`) over that would silently overwrite
    // the imported record (and the stale-key cleanup below would then delete
    // the imported source's own vault keys), or resurrect a source the user
    // just reset away. `source` is the exact pick-time record — compared on
    // both config (sourceConfigUnchanged) and name, since name isn't part of
    // that comparator. The store loop above runs inside this same lock
    // acquisition, so an import/reset can no longer land BETWEEN the stores
    // and this check either.
    const currentSourceBeforePersist = core.getInventorySource(source.id);
    if (!currentSourceBeforePersist || !sourceConfigUnchanged(currentSourceBeforePersist, source) || currentSourceBeforePersist.name !== source.name) {
      await rollbackThisRunsVaultWrites();
      throw new Error("Inventory source changed while editing — reopen Edit Source.");
    }

    // REVIEW FINDING (P2) — the same live re-resolve the create path does; see
    // MISSING_AUTH_PROFILE_MESSAGE for the rationale and
    // persistNewInventorySource for the TOCTOU reasoning (identical here: no
    // `await` separates this check from the persist below).
    //
    // Deliberately AFTER the ITEM 4 guard, not folded into it. The two catch
    // different things and ITEM 4's answer ("reopen Edit Source") is the more
    // fundamental one when both apply: removeAuthProfile re-revisions ONLY the
    // sources that already reference the deleted profile, so a source that was
    // already linked trips ITEM 4 and is told to reopen, while a source being
    // switched ONTO that profile keeps its revision, sails through ITEM 4
    // untouched, and is caught here. The same split covers the third check: a
    // profile EDIT revises no source at all, so ITEM 4 sees nothing whatsoever
    // when the username under this open form moves.
    const linkedProfile = authProfileId !== undefined ? core.getAuthProfile(authProfileId) : undefined;
    const authProfileRejection = inventoryAuthProfileRejection(authProfileId, renderedAuthProfile, linkedProfile);
    if (authProfileRejection !== undefined) {
      await rollbackThisRunsVaultWrites();
      throw new Error(authProfileRejection);
    }

    // ITEM A — restamp on every save: the user has the form open against
    // `provider` (whichever registrant currently answers `source.providerId`)
    // and is knowingly interacting with it, exactly like at creation time.
    //
    // Built HERE, below both guards rather than above them, because
    // `defaultUsername` is derived from the profile the re-resolve above
    // produced. Nothing between the two guards reads `updated`, and building an
    // object literal is synchronous, so neither guard's reasoning changes —
    // ITEM 4 still runs first, and still no `await` separates the auth-profile
    // resolve from the persist below.
    const updated: InventorySourceConfig = {
      ...source,
      name,
      targetFolder,
      prunePolicy,
      // Assigned unconditionally (never spread-guarded): `undefined` is the
      // form's `(None)` answer and MUST overwrite a previously linked id,
      // which a conditional spread over `...source` would silently preserve.
      authProfileId,
      // REVIEW FINDING (P2) — the profile's username, not the posted one; see
      // fallbackUsernameForSource for the invariant and why the form's mirror
      // cannot be trusted to have landed before Save.
      defaultUsername: fallbackUsernameForSource(linkedProfile, defaultUsername),
      config,
      secretFieldIds: newSecretFieldIds,
      providerFingerprint: computeProviderFingerprint(provider)
    };

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
      throw new Error(`Could not save inventory source "${name}" — the update was not applied.`);
    }

    // FINDING 3 — vault keys for ids that were in the OLD secretFieldIds but
    // fell out of the new set (dropped from the provider schema, or simply
    // never re-stored) are orphaned: remove-source/reset/backup only walk
    // secretFieldIds, so a stale vault entry would live forever otherwise.
    // Deleted only AFTER the updated source is successfully persisted —
    // deleting them first would destroy still-referenced credentials if the
    // persist above then failed (FINDING 1).
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

    return updated;
  });
}

async function openInventoryIssuesText(lines: string[]): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content: lines.join("\n"), language: "log" });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** F16 — servers not themselves being removed whose SSH jump host is among `removedIds`. */
function countJumpHostDependents(allServers: ServerConfig[], removedIds: ReadonlySet<string>): number {
  return allServers.filter((s) => !removedIds.has(s.id) && s.proxy?.type === "ssh" && removedIds.has(s.proxy.jumpHostId)).length;
}

/**
 * The updates whose auth profile actually changes — the retro-apply and
 * retro-UNAPPLY subsets of `plan.updates` together. Both directions are
 * credential mutations on existing servers, so both are disclosed and both are
 * covered by the drift comparison; the two renderings below split them, because
 * "gains a profile" and "loses one" are not the same news.
 */
function authProfileSwitches(plan: InventorySyncPlan): Array<{ before: ServerConfig; after: ServerConfig }> {
  return plan.updates.filter((u) => u.before.authProfileId !== u.after.authProfileId);
}

/** The switches that ADOPT a profile — computeSyncPlan's AUTH 2 retro-apply. */
function authProfileAdoptions(plan: InventorySyncPlan): Array<{ before: ServerConfig; after: ServerConfig }> {
  return authProfileSwitches(plan).filter((u) => u.after.authProfileId !== undefined);
}

/**
 * REVIEW FINDING (P1) — the switches that REMOVE the source's profile:
 * computeSyncPlan's AUTH 2b, which undoes a link the source applied once the
 * profile can no longer honour it (a key profile that lost its key file). Split
 * out from the adoptions above because rendering it as "will switch to auth
 * profile X" would tell the user the exact opposite of what the plan does.
 */
function authProfileClears(plan: InventorySyncPlan): Array<{ before: ServerConfig; after: ServerConfig }> {
  return authProfileSwitches(plan).filter((u) => u.after.authProfileId === undefined);
}

/**
 * The updates that ADOPT a kept server — computeSyncPlan's adopt-on-add rule,
 * where a device's planned add instead becomes an update OF AN EXISTING RECORD:
 * one this source's predecessor synced from the same device and the user kept
 * when that source was removed. Reclaiming, not discovery — a server the user
 * built by hand is never eligible, whatever address it happens to sit at.
 *
 * Derived from the plan's own before/after pairs rather than carried as a
 * separate plan field, the same derive-don't-duplicate rationale as
 * `authProfileSwitches` above: a rendering computed from `updates` can never
 * disagree with what `updates` will actually write.
 *
 * The filter is EXACT, not a heuristic. Every OTHER update the engine produces
 * starts from a server this source already owns — the mapped-device path builds
 * them from its `ownedByExternalId` index (which requires
 * `origin.sourceId === source.id`) and both auth-profile passes likewise iterate
 * owned servers — so an update whose `before` carries no origin at all can only
 * be an adoption.
 */
function adoptionUpdates(plan: InventorySyncPlan): Array<{ before: ServerConfig; after: ServerConfig }> {
  return plan.updates.filter((u) => u.before.origin === undefined);
}

/**
 * ROUND 8 (P1) — group auth-profile switches / clears by the profile id each one
 * ACTUALLY targets, preserving first-seen order. A catch-all device template can
 * set a profile B that differs from the source-level profile A, and the engine
 * writes B onto the update's `after`; the consent line and the drift signature
 * must therefore name what the plan WRITES, not the source's profile. For a
 * switch the target is `after.authProfileId` (the profile adopted); for a clear
 * it is `before.authProfileId` (the profile stopped). Returned as arrays, not
 * just counts, so `planWarningsBuffer` can list the servers under each distinct
 * target heading.
 */
function groupByAuthTarget(
  switches: Array<{ before: ServerConfig; after: ServerConfig }>,
  targetOf: (u: { before: ServerConfig; after: ServerConfig }) => string | undefined
): Map<string | undefined, Array<{ before: ServerConfig; after: ServerConfig }>> {
  const groups = new Map<string | undefined, Array<{ before: ServerConfig; after: ServerConfig }>>();
  for (const u of switches) {
    const id = targetOf(u);
    const existing = groups.get(id);
    if (existing !== undefined) {
      existing.push(u);
    } else {
      groups.set(id, [u]);
    }
  }
  return groups;
}

/**
 * m1/m2 — full-sentence, singular/plural-correct rendering of a computed sync
 * plan for the confirm modal's `detail`.
 *
 * `authProfilesById` is the WHOLE profile store (the caller's
 * `resolveAuthProfilesById(core)` — the same map `computeSyncPlan` consumed),
 * used to resolve each planned update's ACTUAL target auth profile to a name
 * (ROUND 8 P1): the switch/clear lines are grouped by the real target id
 * (`after.authProfileId` / `before.authProfileId`), NOT by the single
 * source-level profile, because a template can make the two differ. It is a
 * render-time argument rather than something derived from the plan because the
 * plan carries only ids and this file's modal copy is names-never-UUIDs (m3).
 *
 * `authProfileName` is the legacy single-profile fallback, retained for the
 * direct unit tests that build synthetic plans with no profile map: when
 * `authProfilesById` is absent the switch/clear lines fall back to this single
 * name (or the nameless branch when it too is absent). Production always passes
 * the map.
 *
 * Exported for direct unit testing: the nameless-switch branch below is
 * unreachable through syncNow (every call site pairs plan and resolution), and
 * a guard that cannot be exercised is a guard nobody can prove still works.
 */
export function describePlanDetail(
  plan: InventorySyncPlan,
  allServers: ServerConfig[],
  authProfileName?: string,
  authProfilesById?: ReadonlyMap<string, AuthProfile>
): string {
  const lines: string[] = [];
  if (plan.adds.length > 0) {
    const n = plan.adds.length;
    lines.push(`${n} server${n === 1 ? "" : "s"} will be added.`);
  }
  // FIX 3 — aggregate manual-duplicate count (engine-computed, not
  // string-parsed from plan.warnings) surfaced once in the modal, rather than
  // leaving it discoverable only by opening the per-device warnings list.
  if (plan.manualDuplicateCount > 0) {
    const n = plan.manualDuplicateCount;
    const verb = n === 1 ? "matches" : "match";
    lines.push(`${n} device${n === 1 ? "" : "s"} ${verb} existing manual servers and will be added as duplicates.`);
  }
  if (plan.updates.length > 0) {
    const n = plan.updates.length;
    lines.push(`${n} server${n === 1 ? "" : "s"} will be updated.`);
  }
  // The adoption consent line. Like the auth-switch line below it annotates a
  // SUBSET of the "will be updated." line it sits directly under — an adopted
  // server IS one of those updates and is counted there too — which is why it is
  // placed immediately after it, the same subset-annotation placement
  // manualDuplicateCount uses after the adds line.
  //
  // Above the auth-switch line rather than below it, because the two can name
  // the very same servers: an adopted record in the add-path shape qualifies for
  // retro-apply in the SAME plan, so it renders on both lines. Adoption is the
  // identity change ("this existing server becomes this device"); the switch
  // annotates what that does to its credentials. Reversing them would describe
  // the credential consequence of an ownership change the user hasn't been told
  // about yet.
  //
  // "keeps its saved credentials" is the load-bearing half of the sentence: the
  // whole reason to adopt rather than duplicate is that the record — and so its
  // id, and so every SecretStorage key hanging off that id — survives.
  //
  // The clause naming WHERE these servers came from is the other half, and it is
  // not decoration: adoption is offered only for records a removed inventory
  // source synced and the user kept on Remove Source, never for a server built
  // by hand that merely sits at the same address. Saying "existing servers"
  // would describe a wider population than the plan can actually touch, and
  // wording it as an address match would describe a rule this no longer is.
  // "kept from a removed inventory source" is THE name for that population —
  // REVIEW FINDING: the branch had four (an earlier / a previous / a removed
  // inventory source, and "a previous sync of this source"), and the last of
  // them also misstated the rule, which matches by PROVIDER and not by source.
  //
  // FUTURE TENSE, like every sibling line here ("will be added.", "will be
  // updated.", "will be deleted…") and like the pair list this same plan renders
  // behind Show Warnings (REVIEW FINDING — it read "is being adopted", which
  // described the plan as already in flight while its own heading one click away
  // said "will be adopted").
  const adoptionCount = adoptionUpdates(plan).length;
  if (adoptionCount > 0) {
    const n = adoptionCount;
    // The subset qualifier is dropped when there IS no wider set to be a subset
    // of: with a single update, "1 of the updated servers" invites the reader to
    // look for the others (NIT). The definite article does the same job of
    // pointing at the line directly above.
    const subject = plan.updates.length === 1 ? "The updated server" : n === 1 ? "1 of the updated servers" : `${n} of the updated servers`;
    lines.push(
      n === 1
        ? `${subject} will be adopted by this source — it was kept from a removed inventory source, and it keeps its saved credentials.`
        : `${subject} will be adopted by this source — they were kept from a removed inventory source, and they keep their saved credentials.`
    );
    // REVIEW FINDING (latent) — the ONE thing an adoption can overwrite outside
    // the source's four fields, disclosed only when the plan actually does it.
    // The engine writes `endpoint.username` onto an adoptee when the inventory
    // supplies one (syncEngine.ts, and the comment there explains why that is
    // right), which no shipped provider does — but a third-party provider
    // through the public API would otherwise silently replace a hand-picked
    // username under copy that promises the server "keeps its saved
    // credentials". Derived from the pairs themselves rather than promised in
    // advance, so it can never disagree with what `updates` will write, and it
    // costs a plan that does not do this exactly nothing.
    const usernameOverwrites = adoptionUpdates(plan).filter((u) => u.before.username !== u.after.username).length;
    if (usernameOverwrites > 0) {
      const u = usernameOverwrites;
      lines.push(
        u === 1
          ? "1 adopted server will also take the username the inventory reports, replacing the one stored on it."
          : `${u} adopted servers will also take the usernames the inventory reports, replacing the ones stored on them.`
      );
    }
  }
  // The retro-apply consent line (UX §4). Derived from the plan's own
  // before/after pairs rather than a dedicated plan field, so it can never
  // disagree with what `updates` will actually write. It annotates a SUBSET of
  // the "will be updated" line it sits directly under — the same
  // subset-annotation placement manualDuplicateCount uses after adds — because
  // every auth switch is also counted there.
  //
  // ROUND 8 (P1) — the TARGET each switch names is that update's OWN
  // `after.authProfileId`, resolved through `authProfilesById`, NOT the single
  // source-level profile. A catch-all device template can set a profile B that
  // differs from the source's A, and the engine writes B; naming A here would
  // tell the user "switch to A" while the plan applies B (and a B→C template
  // change while the modal is open would evade drift, since the count and the
  // wrong name A would both be unchanged). Grouped by real target id — normally
  // one line in the T1 single-winner cascade, but correct if a plan ever writes
  // more than one target.
  //
  // A switch with no name is still reachable — a dangling target id that
  // resolves to no profile — and still honest consent: the user is told how many
  // servers change auth, and can cancel. The nameless branch also protects the
  // legacy single-name fallback used by the synthetic-plan unit tests (no map):
  // a caller that lost the name renders namelessly rather than dropping the line
  // SILENTLY, which would let the stamps apply past the modal with no disclosure
  // and no drift to catch it.
  const switches = authProfileAdoptions(plan);
  if (switches.length > 0) {
    if (authProfilesById !== undefined) {
      for (const [targetId, group] of groupByAuthTarget(switches, (u) => u.after.authProfileId)) {
        const name = targetId !== undefined ? authProfilesById.get(targetId)?.name : undefined;
        const n = group.length;
        lines.push(
          name !== undefined
            ? `${n} server${n === 1 ? "" : "s"} will switch to auth profile "${name}".`
            : `${n} server${n === 1 ? "" : "s"} will switch to a different auth profile.`
        );
      }
    } else {
      const n = switches.length;
      lines.push(
        authProfileName !== undefined
          ? `${n} server${n === 1 ? "" : "s"} will switch to auth profile "${authProfileName}".`
          : `${n} server${n === 1 ? "" : "s"} will switch to a different auth profile.`
      );
    }
  }
  // REVIEW FINDING (P1) — the other direction, on its own line and in the same
  // place: unlinking a server the source had linked is a credential change to an
  // existing record, so it is disclosed exactly like the adoption it reverses,
  // never folded into it. Wording matches the auth-profile delete confirmation
  // ("will revert to their own stored credentials") — the same event from the
  // server's point of view, and the reason the line does not promise SSH agent
  // authentication specifically: what a server falls back to is whatever its own
  // record holds.
  //
  // ROUND 8 (P1) — the profile named here is the one each server STOPS using,
  // i.e. that clear's own `before.authProfileId`, resolved through
  // `authProfilesById` and grouped per real target — never the source-level
  // profile, for the same reason the switch line groups by its target.
  const clears = authProfileClears(plan);
  if (clears.length > 0) {
    if (authProfilesById !== undefined) {
      for (const [targetId, group] of groupByAuthTarget(clears, (u) => u.before.authProfileId)) {
        const name = targetId !== undefined ? authProfilesById.get(targetId)?.name : undefined;
        const n = group.length;
        lines.push(
          name !== undefined
            ? `${n} server${n === 1 ? "" : "s"} will stop using auth profile "${name}" and revert to their own stored credentials.`
            : `${n} server${n === 1 ? "" : "s"} will stop using their auth profile and revert to their own stored credentials.`
        );
      }
    } else {
      const n = clears.length;
      lines.push(
        authProfileName !== undefined
          ? `${n} server${n === 1 ? "" : "s"} will stop using auth profile "${authProfileName}" and revert to their own stored credentials.`
          : `${n} server${n === 1 ? "" : "s"} will stop using their auth profile and revert to their own stored credentials.`
      );
    }
  }
  const orphaned = plan.prunes.filter((p) => p.policy === "orphan").length;
  const deleted = plan.prunes.filter((p) => p.policy === "delete").length;
  const kept = plan.prunes.filter((p) => p.policy === "keep").length;
  // NIT 2 — hiddenPruneCount is folded into whichever of the three prune
  // lines below actually renders, rather than sitting on its own line. A
  // single sync always applies exactly ONE prune policy (source.prunePolicy),
  // so at most one of orphaned/deleted/kept is ever non-zero and there is
  // never an ambiguity about which line it qualifies.
  const hiddenSuffix = plan.hiddenPruneCount > 0 ? ` (${plan.hiddenPruneCount} hidden)` : "";
  if (orphaned > 0) {
    // m2 (FIX — mis-rendered fallback depth) — the destination is read off the
    // PLAN's own orphan entries rather than recomputed here. Recomputing
    // `${targetFolder}/${ORPHAN_FOLDER_NAME}` assumed computeSyncPlan's happy
    // path; when targetFolder is already at MAX_FOLDER_DEPTH,
    // normalizeFolderPath rejects the one-level-deeper candidate and
    // computeSyncPlan's fallback (syncEngine.ts, FIX 6) leaves every orphan's
    // `after.group` at targetFolder itself instead (plus a warning) — the
    // recomputed path here would then name a folder no server was actually
    // moved to. All orphan entries in a single plan share one destination BY
    // CONSTRUCTION: computeSyncPlan computes a single `orphanGroupForPrune`
    // once per sync and reuses it for every "orphan" prune it pushes, so
    // reading it off the first orphan entry is exact, not a best guess.
    // `after.group === undefined` means the fallback landed at the top level
    // (source.targetFolder itself was "").
    const firstOrphan = plan.prunes.find(
      (p): p is { policy: "orphan"; server: ServerConfig; after: ServerConfig } => p.policy === "orphan"
    );
    const orphanDestination = firstOrphan?.after.group;
    const orphanDestinationText = orphanDestination === undefined ? "the top level" : `"${orphanDestination}"`;
    lines.push(`${orphaned} server${orphaned === 1 ? "" : "s"} will be moved to ${orphanDestinationText}${hiddenSuffix}.`);
  }
  if (deleted > 0) {
    const pronoun = deleted === 1 ? "its" : "their";
    const passwordWord = deleted === 1 ? "password" : "passwords";
    lines.push(`${deleted} server${deleted === 1 ? "" : "s"} will be deleted, including ${pronoun} saved ${passwordWord}${hiddenSuffix}.`);
  }
  if (kept > 0) {
    lines.push(`${kept} server${kept === 1 ? "" : "s"} will be kept in place${hiddenSuffix}.`);
  }
  lines.push(`${plan.unchangedCount} server${plan.unchangedCount === 1 ? " is" : "s are"} unchanged.`);
  if (plan.warnings.length > 0) {
    const n = plan.warnings.length;
    lines.push(`${n} warning${n === 1 ? "" : "s"} — choose Show Warnings to review.`);
  }
  if (deleted > 0) {
    const deletedIds = new Set(plan.prunes.filter((p) => p.policy === "delete").map((p) => p.server.id));
    const dependents = countJumpHostDependents(allServers, deletedIds);
    if (dependents > 0) {
      // m5 — verb keyed on the dependent count, "this server"/"these servers"
      // (and the singular/plural jump-host noun) keyed on how many servers
      // are actually being deleted; mirrored in removeSource below.
      const verb = dependents === 1 ? "uses" : "use";
      const noun = deleted === 1 ? "this server" : "these servers";
      const hostNoun = deleted === 1 ? "an SSH jump host" : "SSH jump hosts";
      lines.push(`${dependents} other server${dependents === 1 ? "" : "s"} ${verb} ${noun} as ${hostNoun}.`);
    }
  }
  return lines.join("\n");
}

/**
 * The buffer behind the confirm modal's `Show Warnings` button: the plan's own
 * warnings, plus — whenever the retro-apply rule would move servers onto the
 * source's auth profile — one line NAMING them. The modal's own detail keeps
 * the aggregate ("5 servers will switch to auth profile X."); this is where a
 * fleet-wide switch becomes inspectable instead of merely countable, one click
 * before Apply.
 *
 * EVERY switching server is listed, one per line under a counted heading — not
 * the count-plus-three-examples of syncEngine.ts's pushSkipSummary. That idiom
 * fits what it was written for: skipped devices are an aggregate the user acts
 * on as a group, and the examples exist only to hint at the category. This list
 * is the opposite — it is the audit of a credential change about to be applied
 * to named, individually-owned records, and "e.g." is worthless to someone
 * checking whether one particular server is in the set. The buffer opens as a
 * scrollable text document (openInventoryIssuesText), so length costs nothing,
 * and inspectability before Apply is the entire reason the names are here.
 * Names come from `before`, i.e. what the servers are called in the tree right
 * now, not what this same sync might rename them to.
 *
 * Deliberately NOT pushed into `plan.warnings` by the engine: that array is
 * also surfaced after a successful apply ("N warnings during sync") and in the
 * nothing-to-change toast, and a switch the user just consented to is not an
 * issue to report back to them.
 *
 * Exported for direct unit testing, for the same reason describePlanDetail is:
 * this is rendered consent text, and the cheapest way to pin its exact wording,
 * its per-list ordering, and the before/after side each name is read from is to
 * call it on synthetic plans rather than to reconstruct every plan shape through
 * a provider fetch.
 */
export function planWarningsBuffer(
  plan: InventorySyncPlan,
  authProfileName?: string,
  authProfilesById?: ReadonlyMap<string, AuthProfile>
): string[] {
  const buffer = [...plan.warnings];
  // The adoption pair list, in the established heading-plus-indented-names
  // shape and for the same reason the switch list exists: adoption changes WHICH
  // records this source owns (and hands their lifecycle, prune policy included,
  // to it), so "is MY server in this set" has to be answerable one click before
  // Apply — countable is not enough.
  //
  // BOTH names are shown per pair because the source renames what it adopts:
  // listing only the device name would hide the tree entry the user is actually
  // looking for whenever they had renamed it by hand, which is precisely the
  // population most likely to be checking. `before` is the record as it stands
  // in the tree right now (its name and its hidden state); `after` is the device
  // reclaiming it, with the address that record will carry afterwards — enough
  // to check the pairing at a glance. The address is a CONSEQUENCE here, never
  // the qualification: eligibility is device identity plus the kept marker, so
  // the line must not read as "these two share an address, therefore they are
  // the same machine".
  //
  // Listed BEFORE the two auth-profile lists below, which may name some of the
  // same servers, for the same ordering reason as the modal's lines.
  const adoptions = adoptionUpdates(plan);
  if (adoptions.length > 0) {
    const n = adoptions.length;
    buffer.push(
      n === 1
        ? "1 server kept from a removed inventory source will be adopted by this source (it keeps its saved credentials):"
        : `${n} servers kept from a removed inventory source will be adopted by this source (each keeps its saved credentials):`
    );
    for (const u of adoptions) {
      // Hidden servers are eligible for adoption (isHidden is tree visibility,
      // not identity), so the list has to say when a named pair will not be
      // visible in the tree after Apply — otherwise the audit reads as naming a
      // server the user then cannot find.
      const hiddenSuffix = u.before.isHidden ? " (hidden)" : "";
      buffer.push(`  "${u.before.name}" — device "${u.after.name}" (${u.after.host}:${u.after.port})${hiddenSuffix}`);
    }
  }
  // ROUND 8 (P1) — one heading per DISTINCT target profile the plan actually
  // writes (`after.authProfileId`), resolved through `authProfilesById`, so the
  // Show Warnings audit names the same real target the modal now does rather than
  // the source-level profile. Grouped by real target — one heading in the T1
  // single-winner cascade, but truthful if a plan ever switches to more than one.
  // Heading keeps the count (the modal's own line is an aggregate too, and the
  // two must agree at a glance); the colon marks the lines below as belonging to
  // it, and the indent keeps them from reading as sibling warnings when the plan
  // also carries engine warnings above. `authProfileName` is the legacy
  // single-name fallback for the synthetic-plan unit tests (no map).
  const switches = authProfileAdoptions(plan);
  if (switches.length > 0) {
    if (authProfilesById !== undefined) {
      for (const [targetId, group] of groupByAuthTarget(switches, (u) => u.after.authProfileId)) {
        const name = targetId !== undefined ? authProfilesById.get(targetId)?.name : undefined;
        const target = name !== undefined ? `auth profile "${name}"` : "a different auth profile";
        const n = group.length;
        buffer.push(`${n} server${n === 1 ? "" : "s"} will switch to ${target}:`);
        for (const u of group) {
          buffer.push(`  "${u.before.name}"`);
        }
      }
    } else {
      const n = switches.length;
      const target = authProfileName !== undefined ? `auth profile "${authProfileName}"` : "a different auth profile";
      buffer.push(`${n} server${n === 1 ? "" : "s"} will switch to ${target}:`);
      for (const u of switches) {
        buffer.push(`  "${u.before.name}"`);
      }
    }
  }
  // REVIEW FINDING (P1) — the unlink list, in the same shape and for the same
  // reason: every affected server named, so "is MY server in this set" is
  // answerable one click before Apply. Its own heading rather than a shared one,
  // because a plan can in principle carry both (the engine's two rules are
  // mutually exclusive per sync today, but the render must not depend on that to
  // stay truthful). ROUND 8 (P1) — grouped by each clear's own
  // `before.authProfileId` (the profile stopped), for the same reason.
  const clears = authProfileClears(plan);
  if (clears.length > 0) {
    if (authProfilesById !== undefined) {
      for (const [targetId, group] of groupByAuthTarget(clears, (u) => u.before.authProfileId)) {
        const name = targetId !== undefined ? authProfilesById.get(targetId)?.name : undefined;
        const target = name !== undefined ? `auth profile "${name}"` : "their auth profile";
        const n = group.length;
        buffer.push(`${n} server${n === 1 ? "" : "s"} will stop using ${target} and revert to their own stored credentials:`);
        for (const u of group) {
          buffer.push(`  "${u.before.name}"`);
        }
      }
    } else {
      const n = clears.length;
      const target = authProfileName !== undefined ? `auth profile "${authProfileName}"` : "their auth profile";
      buffer.push(`${n} server${n === 1 ? "" : "s"} will stop using ${target} and revert to their own stored credentials:`);
      for (const u of clears) {
        buffer.push(`  "${u.before.name}"`);
      }
    }
  }
  return buffer;
}

/** The set of server ids the plan would actually delete (prune policy "delete"). */
function deletePruneIds(plan: InventorySyncPlan): Set<string> {
  return new Set(plan.prunes.filter((p) => p.policy === "delete").map((p) => p.server.id));
}

/**
 * ADOPT 1 / REVIEW FINDING (P1, the adoption question behind the no-op fast
 * path) — "is there NOTHING for this sync to do AND nothing to ask the user
 * about?", the one condition syncNow's empty-plan fast path is allowed to
 * short-circuit on.
 *
 * THE COUNTS ALONE ARE NOT THAT CONDITION. An adoption candidate is normally
 * also a planned ADD (the device would be added beside the record it came from),
 * so a plan with candidates is non-empty by the counts and the question is
 * reached. There is exactly one shape where it is not: restore an ID-preserving
 * backup taken while a source was live, remove that source with Keep Servers and
 * add it back, and the kept server still holds
 * `deterministicServerId(source.id, externalId)` — the id THIS device's add
 * would need. The engine records the candidate, refuses to mint a second record
 * under an occupied id, and produces an entirely empty plan (syncEngine.ts, the
 * collision skip after the adoption block). The counts then say "nothing to do"
 * about the one run whose whole purpose is to ask a question, so the fast path
 * applied a no-op and returned, and a restored source could never reclaim its
 * servers — closing by the back door the exact path the collision guard's
 * adoptee exemption was written to open.
 *
 * WHY THIS PREDICATE AND NOT AN EARLIER QUESTION. Moving the question above the
 * fast path would ask it from the PRE-LOCK plan, before the in-lock recompute
 * that exists precisely because that plan can be stale, and would then have to
 * thread the answer into that recompute and re-derive the candidate list there —
 * two places deciding when to ask, for a question whose entire contract is that
 * it is asked once per run. It would also risk raising a modal for a sync that
 * the fresh snapshot proves has nothing left to ask about (another window
 * adopted or deleted the kept server first), which is the one thing this fast
 * path exists to prevent. Naming what "empty" means, and asking BOTH gates the
 * same question, fixes the predicate that was wrong instead of relocating the
 * user interaction that was not.
 *
 * A GENUINELY EMPTY SYNC STILL SHOWS NO MODAL: no candidates means no question,
 * so `adoptionCandidates` is empty and this reads exactly as the count
 * check did.
 */
function planHasNothingToDo(plan: InventorySyncPlan): boolean {
  return plan.adds.length === 0 && plan.updates.length === 0 && plan.prunes.length === 0 && plan.adoptionCandidates.length === 0;
}

/**
 * REVIEW FINDING (P2) — the captured signature of the plan's auth switches, the
 * identity behind `authProfileSwitches`' count. One key per switch, carrying the
 * record (`before.id` — the server as it exists right now, what the user
 * consents to) AND both ends of the credential move (`before.authProfileId` →
 * `after.authProfileId`).
 *
 * ROUND 8 (P1) — the from/to profile ids are in the key, not just the server id.
 * `describePlanDetail` now names the ACTUAL target (`after.authProfileId`, a
 * catch-all template can make it differ from the source-level profile), so a
 * B→C change of that target between the shown render and the fresh recompute
 * MUST drift and re-prompt. The rendered text catches it whenever the two
 * targets resolve to different NAMES; encoding the target ids here catches it
 * even when two distinct profiles happen to share a name.
 *
 * Deliberately the UNION of both directions (`authProfileSwitches`, not just the
 * adoptions): an unlink is a credential change to a named, disclosed server too,
 * so a mid-modal swap of WHICH server gets unlinked — or of WHICH profile it
 * stops using — has to drift exactly as an adoption swap does. Space-joined, and
 * the empty string stands in for `undefined` (a clear's `after`, a bare
 * `before`), unambiguous because server and profile ids are uuids / deterministic
 * hashes that contain no space and are never empty.
 *
 * Exported for direct unit testing alongside `planDetailDrift`: the target-id
 * swap it now catches renders identical text whenever two profiles share a name,
 * so the derivation has to be assertable — and buildable into a captured tuple —
 * on its own.
 */
export function authProfileSwitchIds(plan: InventorySyncPlan): Set<string> {
  return new Set(
    authProfileSwitches(plan).map((u) => `${u.before.id} ${u.before.authProfileId ?? ""} ${u.after.authProfileId ?? ""}`)
  );
}

/**
 * The (adoptee, device) PAIRS the plan would adopt — the identity behind the
 * adoption count `describePlanDetail` renders and the pairs
 * `planWarningsBuffer` lists.
 *
 * PAIR-SHAPED, not a set of server ids (REVIEW FINDING). A set of `before.id`
 * protects WHICH RECORD is handed over but not WHICH DEVICE claims it, and both
 * halves are consent: the pair list names "server X — device A", so a mid-modal
 * change that leaves X adopted by device B instead (a backup restore rewriting
 * X's marker and address onto another device, while A falls back to an add)
 * produces identical counts, identical rendered text, and an identical
 * `before.id` set. Nothing drifts, and X is renamed, re-addressed and re-foldered
 * onto a machine the user was never shown.
 *
 * The device half is `after.origin.externalId` — its IDENTITY, not its address.
 * `tree` is fetched once and reused by every recompute of a run, so a device's
 * endpoint is a function of its externalId here and adding host:port would
 * capture nothing further; the reverse does not hold, since two devices in one
 * tree may report the same address while being different machines.
 *
 * `before.id` for the record half, for the same reason the two sets above use
 * it: it is the record as it exists in the tree right now, which is what the
 * user is being asked to consent to. (For an adoption `after.id === before.id`
 * by construction — the whole point is that the record survives — so this is a
 * statement of intent as much as a choice of operand.) NUL-joined, and
 * unambiguous whatever a provider puts in an externalId, because the FIRST half
 * can never contain one — server ids are uuids or the deterministic hash — so
 * nothing can shift the boundary between the two.
 *
 * Exported for direct unit testing alongside `planDetailDrift`, which is the
 * only production caller: the swaps these keys exist to catch render no visible
 * difference anywhere, so the derivation has to be assertable on its own.
 */
export function adoptionPairKeys(plan: InventorySyncPlan): Set<string> {
  return new Set(adoptionUpdates(plan).map((u) => adoptionPairKey(u.before.id, u.after.origin?.externalId ?? "")));
}

/**
 * The one place the (record, device) pairing is spelled as a string, shared by
 * both derivations around it (REVIEW FINDING, P1). `adoptionPairKeys` reads the
 * pairing off an adoption the plan ALREADY MADE; `adoptionCandidateKeys` below
 * reads the same pairing off a candidate the plan has only OFFERED. The two are
 * compared against captures taken at different moments of one run, so they must
 * name a pairing identically — otherwise one guard could pass a key the other
 * would have failed.
 */
function adoptionPairKey(serverId: string, externalId: string): string {
  return `${serverId}\u0000${externalId}`;
}

/**
 * REVIEW FINDING (P1, re-ask when adoption candidates change) — the (adoptee,
 * device) pairs the plan would OFFER to adopt, in the same key space as
 * `adoptionPairKeys` above.
 *
 * WHY A SECOND DERIVATION EXISTS AT ALL. `adoptionPairKeys` can only see pairs
 * that became `updates`, which happens on an `"adopt"` run and no other — and
 * the plan the adoption QUESTION is asked from is by construction computed
 * BEFORE there is an answer, so its adoption-pair set is empty however many
 * candidates it carries. These pairs are what the question's consent is about,
 * and the only shape of that consent available at the moment it is collected.
 *
 * The two agree wherever both are defined: on an `"adopt"` run every candidate
 * becomes an update (syncEngine.ts pushes one unconditionally inside the adopt
 * branch), so `adoptionCandidateKeys(plan)` and `adoptionPairKeys(plan)` are the
 * same set. That is not a coincidence to lean on — it is what stops the two
 * guards built on them from ever disagreeing about what a pairing IS. They still
 * differ in the only way that matters: WHICH MOMENT each compares against (see
 * `answeredAdoptionPairs` in syncNow).
 *
 * Exported for the same reason `adoptionPairKeys` is: the swaps it exists to
 * catch are invisible in every rendered artifact, so the derivation has to be
 * assertable on its own.
 */
export function adoptionCandidateKeys(plan: InventorySyncPlan): Set<string> {
  return new Set(plan.adoptionCandidates.map((c) => adoptionPairKey(c.serverId, c.externalId)));
}

/** Set equality — the shape every captured-set drift comparison below uses (ids, and adoption pair keys). */
function capturedSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false;
    }
  }
  return true;
}

// FINDING 1 (P2, jump-host-dependents-drift review) — describePlanDetail IS
// the modal's rendered text. Comparing its OUTPUT for the plan just shown
// against a freshly recomputed plan subsumes every field this comparator
// used to check individually (adds/updates/prunes counts, unchangedCount,
// manualDuplicateCount, hiddenPruneCount, warnings.length) *and* the
// jump-host-dependents line, which depended on `allServers` rather than the
// plan alone and so could drift (a server edited mid-modal to proxy through
// a planned deletion) without changing anything the old field-list
// comparator looked at. It also automatically covers any future addition to
// describePlanDetail's rendering — there is no per-field list to keep in
// sync by hand anymore. Both renders MUST be produced with the exact
// arguments describePlanDetail was actually called with for that modal — the
// server snapshot captured when the modal was shown vs a FRESH snapshot
// taken at recompute time — passed in by the caller rather than re-read
// here, so this function can't silently compare a plan against the wrong
// snapshot.
//
// The prune-"delete" server-id SET is kept as its own, separate comparison
// (not folded into the rendered text): describePlanDetail only ever renders
// a COUNT of deletions, so two plans that delete the same NUMBER of servers
// but a DIFFERENT SET of them render identical text, even though the
// pre-apply teardown loop below tears down whatever the fresh recompute's
// delete set actually is — an unseen swap here would silently kill a
// different server's live terminals/tunnels/pool connection than the one the
// confirmed detail text implied. Every other individually-compared field
// from the old comparator is dropped as redundant now that the rendered
// string covers it; this is the one aggregate that isn't fully captured by
// the text and so earns its own dedicated check for teardown-safety.
//
// REVIEW FINDING (P2) — the AUTH-SWITCH server-id set is compared the same
// way and for the same reason. describePlanDetail renders only a COUNT of
// switches ("5 servers will switch to auth profile X."), so a mid-modal
// change that makes one server ineligible for retro-apply and another
// eligible produces byte-identical text with an identical delete set: no
// drift, and the fresh plan then stamps the profile onto a server that was
// never disclosed. It is disclosed BY NAME — `planWarningsBuffer` lists every
// switching server behind Show Warnings precisely so a fleet-wide credential
// change is inspectable one click before Apply — so the consent the modal
// collected is consent for THOSE servers, and an identity swap invalidates it
// exactly as a delete-set swap invalidates the teardown. Same shape as
// deleteIds (a captured set compared for equality) rather than a parallel
// mechanism, so there is one discipline here, not two.
//
// The ADOPTION pair set is the third instance of exactly that discipline, and
// the one with the least visible symptom. describePlanDetail renders only a
// COUNT of adoptions ("3 of the updated servers will be adopted by this
// source…"), so a mid-modal change to WHICH kept record a device reclaims — a
// config import replacing the record, a hand-delete followed by a restore from
// backup, a second copy of the same kept server landing in the list — produces
// byte-identical text with an identical delete set and an identical
// auth-switch set. Nothing drifts, and the fresh plan then takes over a server
// that was never disclosed: it gains this source's origin (and with it the
// source's prune policy, `delete` included), gets renamed and moved to the
// device's folder, while the server the user actually approved handing over
// stays behind as a duplicate. Adoption is disclosed BY NAME —
// `planWarningsBuffer` lists every pair behind Show Warnings — so the consent
// the modal collected is consent for THOSE servers, and an identity swap
// invalidates it exactly as a delete-set swap invalidates the teardown. Same
// shape as the two sets above (a captured set compared for equality) rather than
// a parallel mechanism, so there is one discipline here, not three.
//
// REVIEW FINDING — it is a set of PAIRS rather than of adoptee ids because the
// swap has two directions and a bare id set only closes one. The other is the
// device: same record, different claimant, same counts, same text, same ids (see
// `adoptionPairKeys`).
//
// `nextAuthProfilesById` (and the legacy `nextAuthProfileName`) follow the same
// rule as `nextServers`: they are the resolution taken FRESH alongside
// `nextPlan`, not the one the shown modal rendered with. That is what makes a
// mid-modal profile rename (same plan, different name → different text), a
// mid-modal profile delete (no resolution → nameless switch line + a
// dangling-profile warning) and — ROUND 8 (P1) — a mid-modal TEMPLATE change of
// the actual target (A/B→C, caught by the fresh render naming the new target and
// by the target ids `authProfileSwitchIds` now carries) all surface as ordinary
// drift, with no dedicated comparison of their own.
//
// Exported for direct unit testing: an identity swap is by definition the case
// where every rendered artifact is identical, so the only way to prove the
// comparator still catches it — rather than the surrounding text having caught
// something incidental — is to call it on two hand-built plans that differ in
// nothing else.
export function planDetailDrift(
  previous: { detail: string; deleteIds: ReadonlySet<string>; authSwitchIds: ReadonlySet<string>; adoptionPairs: ReadonlySet<string> },
  nextPlan: InventorySyncPlan,
  nextServers: ServerConfig[],
  nextAuthProfileName: string | undefined,
  nextAuthProfilesById?: ReadonlyMap<string, AuthProfile>
): { drift: boolean; detail: string } {
  const nextDetail = describePlanDetail(nextPlan, nextServers, nextAuthProfileName, nextAuthProfilesById);
  if (nextDetail !== previous.detail) {
    return { drift: true, detail: nextDetail };
  }
  if (!capturedSetsEqual(previous.deleteIds, deletePruneIds(nextPlan))) {
    return { drift: true, detail: nextDetail };
  }
  if (!capturedSetsEqual(previous.authSwitchIds, authProfileSwitchIds(nextPlan))) {
    return { drift: true, detail: nextDetail };
  }
  if (!capturedSetsEqual(previous.adoptionPairs, adoptionPairKeys(nextPlan))) {
    return { drift: true, detail: nextDetail };
  }
  return { drift: false, detail: nextDetail };
}

/**
 * computeSyncPlan is pure and has no core access, so the source's auth profile
 * is resolved here and handed in — exactly like `now`. Returns `undefined` when
 * the source has no profile AND when its id no longer names one (a profile
 * deleted by a build that predates removeAuthProfile's source-ref clearing, or
 * deleted in the window this sync is running in); the engine turns that second
 * case into its dangling-profile warning. The WHOLE profile is handed over, not
 * a `{ id, name }` pair: the engine decides for itself whether the profile is
 * usable by the servers it is about to stamp (AUTH 1b, syncEngine.ts) rather
 * than trusting a caller to have asked that question first.
 *
 * THE PAIRING RULE (extends the FINDING 1 captured-vs-fresh discipline to the
 * profile): every computeSyncPlan call site calls this immediately before the
 * call, against the SAME source snapshot it passes as `source`, and the
 * resulting (plan, resolution) pair travels together to whichever
 * describePlanDetail / planDetailDrift render belongs to that plan. Resolving
 * once at sync start and reusing the name for the drift render would compare a
 * fresh plan against a stale name, so a profile renamed while the confirm modal
 * is open would be applied under the name the user did NOT consent to.
 */
function resolveSourceAuthProfile(core: NexusCore, source: InventorySourceConfig): AuthProfile | undefined {
  if (source.authProfileId === undefined) {
    return undefined;
  }
  return core.getAuthProfile(source.authProfileId);
}

/**
 * DEVICE TEMPLATES (issue #48 PR-T1) — the two maps `computeSyncPlan` consumes,
 * resolved from the current core snapshot alongside `resolveSourceAuthProfile`
 * (the engine is pure and has no core access). `authProfilesById` is the WHOLE
 * store (rev3), a superset of `authProfile`, so the engine's unusable-profile
 * scan can name a profile reachable only through a retained link. Re-derived at
 * every recompute site, exactly like `planAuthProfile`, so a plan always sees
 * the templates/profiles that were live when it was computed.
 */
function resolveTemplatesById(core: NexusCore): Map<string, DeviceTemplateProfile> {
  return new Map(core.getSnapshot().deviceTemplates.map((t) => [t.id, t] as const));
}

function resolveAuthProfilesById(core: NexusCore): Map<string, AuthProfile> {
  return new Map(core.getSnapshot().authProfiles.map((p) => [p.id, p] as const));
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
  //
  // Keyed by source id, valued by WHY it is claimed (see SourceBusyReason):
  // the three claimants are not interchangeable to the user, so the refusal
  // each command renders is driven by the holder's reason rather than by the
  // one-size-fits-all "is currently syncing" this used to be.
  const inFlightSourceIds = new Map<string, SourceBusyReason>();

  /**
   * Shared Test-button handler for both the Add and Edit forms. Never throws
   * out to WebviewFormPanel — a bad/incomplete field value is reported as a
   * warning (mirrors profileCommands' onTest convention) rather than the
   * generic "Save failed" banner, since testing is voluntary and shouldn't
   * read like a failed save. `hydrateFrom`, when given, is the edit-mode
   * source whose vault-stored secrets fill in any field left blank (F7) so
   * the test exercises the value that will actually be used on Save, not an
   * empty string.
   */
  async function handleFormTest(
    values: FormValues,
    provider: InventoryProvider,
    fallbackName: string,
    hydrateFrom?: InventorySourceConfig
  ): Promise<void> {
    let parsed: ProviderConfigFormResult;
    try {
      parsed = formValuesToProviderConfig(provider.configFields, values, new Set(hydrateFrom?.secretFieldIds ?? []));
    } catch (error) {
      void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    const secretsForTest: InventorySourceSecrets = { ...parsed.secrets };
    if (hydrateFrom) {
      // REVIEW FINDING 2 (P2) — a rejecting SecretStorage.get here (vault
      // hydration of a kept/blank secret field) must not escape this
      // function: WebviewFormPanel's "test" message handler awaits onTest
      // with no catch of its own (see that file), so an uncaught rejection
      // here becomes a genuine unhandled promise rejection with no feedback
      // ever reaching the still-open form. Surface it through the exact same
      // failure UI a failed provider.testConnection uses — a plain
      // showErrorMessage("Connection test failed: ...") — rather than adding
      // a second, differently-shaped error path.
      try {
        for (const fieldId of hydrateFrom.secretFieldIds) {
          if (secretsForTest[fieldId] === undefined) {
            const stored = await vault.get(inventorySecretKey(hydrateFrom.id, fieldId));
            if (stored !== undefined) secretsForTest[fieldId] = stored;
          }
        }
      } catch {
        void vscode.window.showErrorMessage(
          "Connection test failed: Could not read saved credentials from the system keychain — re-enter them or try again."
        );
        return;
      }
    }
    const name = typeof values.name === "string" && values.name.trim() ? values.name.trim() : fallbackName;
    await testInventoryConnection(name, provider, parsed.config, secretsForTest);
  }

  async function addSource(): Promise<void> {
    const pickResult = await promptProviderPick(registry);
    if (!pickResult) return;
    const { provider } = pickResult;

    // VERIFIED (post-#52 review) — addSource has no editSource-style
    // dispose-vs-in-flight-submit race to guard against: there is no id to
    // register in inFlightSourceIds until AFTER persistNewInventorySource's
    // core.addOrUpdateInventorySource call actually succeeds (persistNewInventorySource
    // mints its own randomUUID() and only core-registers it at the very end
    // of its configMutationLock section). Closing this panel — Cancel, or a
    // native tab-close — while onSubmit is still mid keychain/repository I/O
    // does NOT free any busy marker prematurely, because none is ever
    // claimed for a source that doesn't exist yet: pickInventorySource (used
    // by editSource/removeSource/syncNow) can't select a not-yet-persisted
    // id, so no concurrent command can read/send credentials against it
    // mid-persist. If onSubmit's promise settles after the panel is already
    // gone, persistNewInventorySource's own FINDING B / FINDING 1 rollback
    // (vault-first, delete-on-persist-failure) still runs to completion
    // exactly as if the panel were still open — the panel's lifecycle plays
    // no part in that sequencing. No closure-local tracking is needed here.
    const snapshot = core.getSnapshot();
    const definition = inventorySourceFormDefinition(
      provider,
      undefined,
      mostCommonUsername(snapshot.servers),
      snapshot.authProfiles
    );
    // Same controller/handler triple the server edit form uses
    // (serverCommands.ts) — the only difference is onAutofill's payload: this
    // form mirrors the profile's username into `defaultUsername`, not into
    // `username`/`authType`/`keyPath` (fields it doesn't have).
    const inlineAuthProfile = createInlineAuthProfileCreation({ core, secretVault: vault });
    // REVIEW FINDING (P2) — the profile whose username this form is currently
    // showing, checked against live state at Save by
    // `inventoryAuthProfileRejection`. Seeded as `undefined` and NOT from any
    // record: an Add form opens on `(None)` with the user's own default
    // username in the field, so every username it ever displays FOR A PROFILE
    // arrives through an `onAutofill` answer below — a selection, or
    // `addSelectOption` after an inline create, both post one — and that is
    // what "rendered" means on this path.
    let renderedAuthProfile: RenderedSourceAuthProfile | undefined = undefined;
    const panel = WebviewFormPanel.open(`inventory-source-add-${provider.id}`, definition, {
      onSubmit: async (values) => {
        const parsed = await parseSourceFormValues(values, provider);
        const created = await persistNewInventorySource(core, vault, {
          name: parsed.name,
          targetFolder: parsed.targetFolder,
          authProfileId: parsed.authProfileId,
          renderedAuthProfile,
          defaultUsername: parsed.defaultUsername,
          prunePolicy: parsed.prunePolicy,
          provider,
          config: parsed.config,
          secrets: parsed.secrets
        });

        // F1 — onSubmit resolves as soon as persistence succeeds. The follow-up
        // toast's thenable never resolves once VS Code auto-hides it (there is
        // no explicit dismiss), so awaiting it here would leave onSubmit's
        // promise pending forever — WebviewFormPanel never disposes the panel
        // on a "successful" save, and every subsequent Save is swallowed by
        // submitInFlight (see WebviewFormPanel). The toast (and the optional
        // Sync Now follow-up it can trigger) runs detached instead, exactly
        // like every sibling form's post-save toast in this file.
        void (async (): Promise<void> => {
          const choice = await vscode.window.showInformationMessage(`Inventory source "${created.name}" added.`, "Sync Now");
          if (choice === "Sync Now") {
            await vscode.commands.executeCommand("nexus.inventory.syncNow", created.id);
          }
        })();
      },
      onTest: (values) => handleFormTest(values, provider, provider.label),
      onCreateInline: inlineAuthProfile.handleCreateInline,
      onAutofill: async (_key, value) => {
        // ONE lookup feeds both: what the form is about to show, and what Save
        // checks that against.
        const profile = core.getAuthProfile(value);
        renderedAuthProfile = renderedSourceAuthProfile(profile);
        return authProfileUsernameMirror(profile);
      }
    });
    inlineAuthProfile.attachPanel(panel);
  }

  // `sourceIdArg` mirrors syncNow's: the manage hub (and any future caller
  // that already knows which source the user picked) passes the id so the
  // picker is not shown a second time. Everything below — the busy claim, the
  // provider-fingerprint gate, the form lifecycle — is downstream of source
  // selection and is unchanged by this.
  async function editSource(sourceIdArg?: string): Promise<void> {
    const source = sourceIdArg ? core.getInventorySource(sourceIdArg) : await pickInventorySource(core, registry);
    if (!source) {
      if (sourceIdArg) void vscode.window.showErrorMessage("That inventory source no longer exists.");
      return;
    }
    const editBusyReason = inFlightSourceIds.get(source.id);
    if (editBusyReason !== undefined) {
      void vscode.window.showWarningMessage(sourceBusyMessage(source.name, editBusyReason, "edit"));
      return;
    }

    // REVIEW FINDING 2 (P2) — claimed HERE, synchronously adjacent to the
    // busy-check above (no await in between — mirrors syncNow's own
    // "Marked busy synchronously right after the last check above" comment),
    // NOT after the fingerprint-mismatch modal below. The fingerprint check
    // awaits on a user decision that can sit open for an arbitrary amount of
    // time; claiming the marker only after it returns leaves a window where
    // this source has already passed ITS OWN not-busy check but is not yet
    // recorded as busy, and a concurrent Sync Now (or another Edit) sails
    // through the SAME busy-check and claims the id too. Both then run
    // against the same source concurrently, and whichever's dispose/finally
    // fires first deletes the shared Set entry out from under the other,
    // which is then free to race a THIRD command in.
    //
    // F4 — marked busy for as long as the form stays open (submit pending,
    // or simply left open by the user), not just for the sequential prompts
    // the wizard used to run through — released via onDidDispose below,
    // which fires whether the form closes because Save succeeded or because
    // the user hit Cancel. A failed Save leaves the form (and the busy flag)
    // in place, matching the form's own "stays open for correction" idiom
    // rather than the wizard's "abort and unlock immediately" one.
    //
    // Every OTHER exit from here on (provider-missing abort, fingerprint
    // Cancel, open() throw) must also release it — see releaseInFlight below,
    // called at each of those points as well as from onDidDispose.
    //
    // Claimed as "edit", not merely claimed: for the whole time that form
    // stays open, every other command's refusal must name the open tab (which
    // the user can close) instead of an in-flight sync (which the user can
    // only wait out, and which is not happening).
    inFlightSourceIds.set(source.id, "edit");
    let releasedInFlight = false;

    // BUG FIX (post-#52 review) — onDidDispose used to release the marker
    // the instant the panel closed, synchronously, with no regard for
    // whether onSubmit (persistUpdatedInventorySource, below) was still
    // mid-flight. WebviewFormPanel's own submitInFlight guard only blocks a
    // SECOND submit message while one is pending; it does nothing to stop
    // the "cancel" message or a native tab-close from disposing the panel
    // (and firing every onDidDispose listener, including this one)
    // WHILE that first submit is still awaiting vault/repository I/O. That
    // left a window where the busy marker was gone — so a concurrent Sync
    // Now would sail past the busy-check above and read/send credentials
    // against a source that persistUpdatedInventorySource had already
    // partially mutated (vault overwritten, config record not yet
    // persisted; see its FINDING 1/FINDING C comments for that exact
    // sequencing).
    //
    // WebviewFormPanel exposes no submit-in-flight signal to dispose
    // listeners (its `submitInFlight` field is private and only gates its
    // own message handler), so the current onSubmit invocation's promise is
    // tracked here, closure-local, instead. `onSubmit` below assigns it
    // synchronously (before any `await` inside it can run — see its own
    // comment), so by the time WebviewFormPanel gets around to reacting to
    // the dispose, `currentSubmit` already reflects whatever is in flight,
    // no matter which of the two races (dispose winning vs. submit settling
    // first) actually happened.
    let currentSubmit: Promise<void> | undefined;
    let releasing: Promise<void> | undefined;
    const releaseInFlight = (): Promise<void> => {
      if (releasing) return releasing;
      releasing = (async (): Promise<void> => {
        if (currentSubmit) {
          try {
            await currentSubmit;
          } catch {
            // A rejected submit is already surfaced to the user by
            // WebviewFormPanel's own "Save failed: ..." toast (or, for the
            // early-exit callers of releaseInFlight below, never started at
            // all). This handler's only job is to wait for persistence to
            // SETTLE before freeing the marker — never to throw out of a
            // dispose listener (see WebviewFormPanel's onDidDispose, which
            // swallows listener errors but must never depend on that here).
          }
        }
        if (!releasedInFlight) {
          releasedInFlight = true;
          inFlightSourceIds.delete(source.id);
        }
      })();
      return releasing;
    };

    const provider = registry.get(source.providerId);
    if (!provider) {
      releaseInFlight();
      void vscode.window.showErrorMessage(providerMissingMessage(source.providerId));
      return;
    }

    // F3 — gated BEFORE the form ever opens: the Edit form's Test button
    // hydrates kept (blank) secret fields straight from the vault (see
    // handleFormTest's `hydrateFrom`), which is exactly the silent-secret-
    // handover risk syncNow's own fingerprint check guards against. Cancel
    // aborts here, before the form opens and before any vault read for this
    // source. (Save itself already restamps unconditionally on every
    // successful edit — see persistUpdatedInventorySource's ITEM A — so this
    // gate only needs to decide whether editing may proceed at all, never a
    // fingerprintToStamp to carry forward.) The marker was already claimed
    // above, so a Cancel here must release it before returning.
    const fingerprintCheck = await checkProviderFingerprint(source, provider);
    if (fingerprintCheck.outcome === "cancelled") {
      releaseInFlight();
      return;
    }

    const existingSecretFieldIds = new Set(source.secretFieldIds);
    // LIVE profiles, read here rather than reused from anything captured
    // earlier: the list both populates the select and decides whether the
    // seeded `source.authProfileId` survives sanitization, so a stale list
    // would render a real link as `(None)` and quietly drop it on Save.
    const authProfiles = core.getSnapshot().authProfiles;
    const definition = inventorySourceFormDefinition(provider, source, undefined, authProfiles);
    // REVIEW FINDING (P2) — as addSource's, but seeded: this form opens already
    // showing the LINKED profile's username in Default SSH Username, locked
    // (`inventorySourceFormDefinition`'s render rule), so on Edit "rendered"
    // starts as that render and is re-stamped by every later `onAutofill`
    // answer. Read from the SAME list the definition above was built from — a
    // second lookup could describe a profile this form never rendered. An id
    // that resolves to nothing in that list stamps `undefined`, matching the
    // definition's own sanitization of such a seed down to `(None)`.
    let renderedAuthProfile: RenderedSourceAuthProfile | undefined =
      source.authProfileId !== undefined
        ? renderedSourceAuthProfile(authProfiles.find((profile) => profile.id === source.authProfileId))
        : undefined;
    // Holding editSource's busy marker across inline profile creation is
    // correct and deliberate: creating a profile never touches the source
    // record, so nothing this controller does can race the edit it is nested
    // in. The marker machinery below is untouched by this wiring.
    const inlineAuthProfile = createInlineAuthProfileCreation({ core, secretVault: vault });
    let panel: ReturnType<typeof WebviewFormPanel.open>;
    try {
      // F6 — WebviewFormPanel.open can throw synchronously (or reject — see
      // its own contract) before ever returning a panel to attach
      // onDidDispose to; without this try/catch that throws straight out of
      // editSource with the busy flag already set above, and nothing is ever
      // left to call releaseInFlight. That strands the source busy forever —
      // every later editSource/syncNow/removeSource for this exact id would
      // then be refused as still open in Edit Source (a tab that does not
      // exist, so closing it can never free the source) until the extension
      // host restarts.
      panel = WebviewFormPanel.open(`inventory-source-edit-${source.id}`, definition, {
        // Deliberately NOT an `async` arrow function: an async function's
        // body only starts executing when it's CALLED, but the promise it
        // returns isn't available to assign into `currentSubmit` until
        // AFTER that call returns — by which point the body may already be
        // past its first `await`, i.e. already mid keychain/repository I/O,
        // with nothing yet recording that fact for releaseInFlight to see.
        // Wrapping the async work in its own IIFE here means the IIFE call
        // happens first (started, not awaited) and its returned promise is
        // captured into `currentSubmit` before this outer function returns
        // control to WebviewFormPanel — closing that gap.
        onSubmit: (values) => {
          const submitPromise = (async (): Promise<void> => {
            const parsed = await parseSourceFormValues(values, provider, existingSecretFieldIds);
            const updated = await persistUpdatedInventorySource(core, vault, source, {
              name: parsed.name,
              targetFolder: parsed.targetFolder,
              authProfileId: parsed.authProfileId,
              renderedAuthProfile,
              defaultUsername: parsed.defaultUsername,
              prunePolicy: parsed.prunePolicy,
              provider,
              config: parsed.config,
              reenteredSecrets: parsed.secrets
            });

            const folderNote = updated.targetFolder !== source.targetFolder ? " Servers move to the new folder on the next sync." : "";
            // Only a SET-or-SWITCHED profile earns the suffix and the button.
            // Clearing to `(None)` deliberately does not: the retro-apply rule
            // never strips a profile from a server that already has one, so
            // the next sync would change nothing and the sentence — plus the
            // Sync Now button under it — would be advertising a no-op.
            //
            // The wording is "servers still on the sync default", not "synced
            // servers", because the rule only adopts servers still carrying
            // exactly what the sync gave them. On a first-set that is every
            // untouched synced server; on an A -> B switch it is only the
            // stragglers the earlier syncs never reached — and promising THOSE
            // servers a switch would be contradicted by the very next sync's
            // "nothing to change (N unchanged)". One sentence, true in both.
            const authNote =
              updated.authProfileId !== source.authProfileId && updated.authProfileId !== undefined
                ? " Servers still on the sync default switch to it on the next sync."
                : "";
            if (authNote) {
              // Same detached-toast idiom as addSource's (F1 above): awaiting
              // a thenable VS Code may auto-hide without resolving would leave
              // onSubmit pending forever and swallow every later Save.
              void (async (): Promise<void> => {
                const choice = await vscode.window.showInformationMessage(
                  `Inventory source "${updated.name}" updated.${folderNote}${authNote}`,
                  "Sync Now"
                );
                if (choice === "Sync Now") {
                  await vscode.commands.executeCommand("nexus.inventory.syncNow", updated.id);
                }
              })();
            } else {
              void vscode.window.showInformationMessage(`Inventory source "${updated.name}" updated.${folderNote}`);
            }
          })();
          currentSubmit = submitPromise;
          // This `.finally()`/`.catch()` pair is a SECOND, closure-local
          // observer of `submitPromise` — separate from whatever the real
          // consumer (WebviewFormPanel's own `await
          // Promise.resolve(this.onSubmit(...))`, which owns showing "Save
          // failed: ...") does with the promise this function returns. A
          // `.finally()` callback forwards the original settlement (reject
          // included) to the promise it returns; without the trailing
          // `.catch(() => {})` here, a rejected Save would produce a SECOND,
          // unhandled rejection purely from this bookkeeping chain, on top
          // of whatever the real consumer already reports.
          void submitPromise
            .finally(() => {
              if (currentSubmit === submitPromise) currentSubmit = undefined;
            })
            .catch(() => {
              // Deliberately swallowed — see comment above.
            });
          return submitPromise;
        },
        onTest: (values) => handleFormTest(values, provider, source.name, source),
        onCreateInline: inlineAuthProfile.handleCreateInline,
        onAutofill: async (_key, value) => {
          // ONE lookup feeds both — see addSource's copy.
          const profile = core.getAuthProfile(value);
          renderedAuthProfile = renderedSourceAuthProfile(profile);
          return authProfileUsernameMirror(profile);
        }
      });
    } catch (error) {
      releaseInFlight();
      throw error;
    }
    panel.onDidDispose(releaseInFlight);
    inlineAuthProfile.attachPanel(panel);
  }

  /** `sourceIdArg` as in editSource/syncNow — see editSource's note. */
  async function removeSource(sourceIdArg?: string): Promise<void> {
    const source = sourceIdArg ? core.getInventorySource(sourceIdArg) : await pickInventorySource(core, registry);
    if (!source) {
      if (sourceIdArg) void vscode.window.showErrorMessage("That inventory source no longer exists.");
      return;
    }
    const removeBusyReason = inFlightSourceIds.get(source.id);
    if (removeBusyReason !== undefined) {
      void vscode.window.showWarningMessage(sourceBusyMessage(source.name, removeBusyReason, "remove"));
      return;
    }

    // Claimed as "remove" — the confirm modal below, and the mutation after
    // it, are neither a sync nor an open form, and reporting this window as
    // either would be the same lie in a third command.
    inFlightSourceIds.set(source.id, "remove");
    try {
      const snapshot = core.getSnapshot();
      const owned = snapshot.servers.filter((s) => s.origin?.sourceId === source.id);
      const hiddenOwnedCount = owned.filter((s) => s.isHidden).length;
      const ownedIds = new Set(owned.map((s) => s.id));
      const dependentCount = countJumpHostDependents(snapshot.servers, ownedIds);

      const detailLines: string[] = [];
      if (owned.length > 0) {
        const verb = owned.length === 1 ? "is" : "are";
        // NIT 3 — the hidden-count parenthetical moves before the period.
        const hiddenNote = hiddenOwnedCount > 0 ? ` (includes ${hiddenOwnedCount} hidden)` : "";
        detailLines.push(`${owned.length} synced server${owned.length === 1 ? "" : "s"} ${verb} linked to this source${hiddenNote}.`);
      }
      if (dependentCount > 0) {
        // m5 — mirrors describePlanDetail's own jump-host-dependents line
        // (~ line 428): verb keyed on the dependent count (was hardcoded
        // "use", wrong for a single dependent), "this server"/"these servers"
        // (and the singular/plural jump-host noun) keyed on how many linked
        // servers are actually being removed.
        const verb = dependentCount === 1 ? "uses" : "use";
        const noun = owned.length === 1 ? "this server" : "these servers";
        const hostNoun = owned.length === 1 ? "an SSH jump host" : "SSH jump hosts";
        detailLines.push(`${dependentCount} other server${dependentCount === 1 ? "" : "s"} ${verb} ${noun} as ${hostNoun}.`);
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
          // ADOPT 1 — strip AND STAMP. The strip is unchanged and stays
          // non-negotiable (a dangling origin must never let any sync act on a
          // record its source no longer manages); the stamp is what makes the
          // strip survivable. Without it, "Keep Servers" is a one-way door: a
          // re-added source mints a new id, so ownership resolution and
          // deterministicServerId both miss, and every device arrives a second
          // time beside the record it used to be — the reported bug.
          //
          // The marker is a RECEIPT, not an origin: it names the device this
          // server was mapped to and the provider that mapped it, so a future
          // source of the SAME provider can OFFER to reclaim the record. It
          // confers nothing on its own — no sync reads it unless the user
          // answers the adoption question with "Adopt Existing".
          //
          // One timestamp for the whole batch, not one per server: these
          // records were detached by a single user action, and a per-server
          // Date.now() would imply an ordering that does not exist.
          const detachedAt = Date.now();
          // REVIEW FINDING (P1, cross-instance adoption) — WHICH DEPLOYMENT of
          // the provider these servers came from, recorded now because after
          // this removal nothing else remembers: `source.config` is about to be
          // deleted with the record, and the marker is all that is left.
          //
          // `providerId` alone cannot scope the marker's `externalId` — two
          // instances of one provider both emit "device:1" — so a marker without
          // this is refused by the adoption rule rather than adopted on the
          // strength of the provider kind. See DetachedServerOrigin
          // (models/config.ts) and `sameProviderInstance` (syncEngine.ts).
          //
          // REVIEW FINDING (P1, the instance guard fed from the wrong place) —
          // COPIED FROM EACH SERVER'S OWN `origin.syncedInstanceKey`, never
          // re-derived here from `source.config` through the registered provider.
          // The config is mutable and the origins are not: a source synced
          // against deployment A and then EDITED to point at B — with no
          // successful sync since, which is the entire window this bug lives in
          // — still owns servers whose `externalId`s belong to A. Deriving the
          // key from the current config stamped every one of those markers "B",
          // so a later B source with the same id and address passed the instance
          // guard and could adopt, then prune, A's servers and their saved
          // credentials. The origin stamp is the only value that describes the
          // deployment those ids actually came from, and no edit can move it.
          //
          // A server whose origin carries no stamp (synced before the field
          // existed) yields a marker with no instance key: the receipt is still
          // written — the UI can still say which source kept this server — but
          // the record is not adoptable. Same safe direction as before, reached
          // for one more reason: an un-adoptable kept server costs a duplicate
          // the next sync explains, while a marker claiming an instance nobody
          // verified is how a record changes owner. Re-deriving as a FALLBACK for
          // those was rejected outright — a fallback is available in exactly the
          // repointed-config case that produces the wrong answer.
          const strippedServers = owned.map(({ origin, ...rest }) =>
            // `owned` is filtered on `origin?.sourceId === source.id`, so every
            // entry HAS an origin — but that is a filter, not a type narrowing,
            // and the marker's externalId has to come from somewhere. An
            // origin-less entry (unreachable today) keeps today's exact
            // behavior: stripped of nothing, stamped with nothing.
            origin === undefined
              ? (rest as ServerConfig)
              : ({
                  ...rest,
                  formerlySynced: {
                    sourceId: source.id,
                    sourceName: source.name,
                    providerId: source.providerId,
                    // Omitted entirely rather than written as `undefined` when
                    // the sync recorded no instance: `formerlySynced` is
                    // persisted verbatim, and an explicit `instanceKey:
                    // undefined` survives into globalState as a key with no
                    // value on some JSON paths. Absent and absent-valued mean
                    // the same thing to every reader here, so write the one that
                    // cannot be misread.
                    ...(origin.syncedInstanceKey !== undefined ? { instanceKey: origin.syncedInstanceKey } : {}),
                    externalId: origin.externalId,
                    // REVIEW FINDING (P1, adoption auth provenance) — the one
                    // part of the origin that has to SURVIVE the strip. It says
                    // whether the `authProfileId` this server keeps was the
                    // SYNC'S doing or the USER'S, which is what AUTH 2b (the
                    // unlink that rescues a server stranded by a key profile with
                    // no key file) and retro-apply's per-server opt-out are both
                    // decided on. Dropped here, an adopted server carried a
                    // sync-applied link that nothing could prove was the sync's,
                    // so nothing could ever take it back off. Omitted rather than
                    // written as `undefined` for the reason `instanceKey` is.
                    ...(origin.syncedAuthProfileId !== undefined ? { syncedAuthProfileId: origin.syncedAuthProfileId } : {}),
                    // OOB (PR-A REVIEW FINDING) — the second part of the origin
                    // that has to SURVIVE the strip, on exactly the terms of the
                    // auth provenance above. It says whether the `ipmiHost` this
                    // server keeps was the SYNC'S doing or the USER'S, which is
                    // the whole of the OOB write rule. Dropped here, an adopted
                    // server's sync-written BMC address arrived looking
                    // hand-typed and no later sync could ever update it. Omitted
                    // rather than written as `undefined` for the reason
                    // `instanceKey` is.
                    ...(origin.syncedIpmiHost !== undefined ? { syncedIpmiHost: origin.syncedIpmiHost } : {}),
                    // DEVICE TEMPLATES (issue #48 PR-T1) — the third part of the
                    // origin that has to SURVIVE the strip, on exactly the terms
                    // of the auth/OOB provenance above. It says whether the
                    // proxy/booleans this server keeps were the SYNC'S doing or
                    // the USER'S, which is the whole of the §4.3 template write
                    // matrix. Dropped here, a re-adopted server's
                    // template-managed fields arrived looking hand-owned (row 7)
                    // and an override template could never reclaim them. Unlike
                    // the two scalar siblings this holds a NESTED object, so it is
                    // DEEP-COPIED (`cloneTemplatedStamps`) rather than shared by
                    // reference — the receipt is persisted verbatim and must not
                    // alias the live origin's `templated`. Omitted rather than
                    // written as `undefined` for the reason `instanceKey` is.
                    ...(origin.templated !== undefined ? { templated: cloneTemplatedStamps(origin.templated) } : {}),
                    detachedAt
                  }
                } as ServerConfig)
          );
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

      // m6 — follow-on sentences (each ending with its own period), joined by
      // spaces, rather than the old chained post-period parentheticals.
      const skippedNote =
        removal.skippedCount > 0
          ? ` ${removal.skippedCount} server${removal.skippedCount === 1 ? "" : "s"} changed during removal and ${
              removal.skippedCount === 1 ? "was" : "were"
            } left untouched.`
          : "";
      const recreatedNote =
        removal.recreatedCount > 0
          ? ` ${removal.recreatedCount} re-created server${removal.recreatedCount === 1 ? "" : "s"} kept ${removal.recreatedCount === 1 ? "its" : "their"} credentials.`
          : "";
      // FINDING 2 (P2, second-sweep-abort review) — surface any teardown that
      // was contained (not swallowed silently) above.
      const teardownFailureNote =
        removal.teardownFailureCount > 0
          ? ` Runtime cleanup incomplete for ${removal.teardownFailureCount} server${
              removal.teardownFailureCount === 1 ? "" : "s"
            } — close ${removal.teardownFailureCount === 1 ? "its" : "their"} terminal${
              removal.teardownFailureCount === 1 ? "" : "s"
            } manually.`
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
    const syncBusyReason = inFlightSourceIds.get(source.id);
    if (syncBusyReason !== undefined) {
      void vscode.window.showWarningMessage(sourceBusyMessage(source.name, syncBusyReason, "sync"));
      return;
    }
    const provider = registry.get(source.providerId);
    if (!provider) {
      void vscode.window.showErrorMessage(providerMissingMessage(source.providerId));
      return;
    }

    // Marked busy synchronously right after the last check above (no await in
    // between) so a second invocation arriving on the next microtask sees it.
    // This is the one claimant for which "syncing" is the honest word.
    inFlightSourceIds.set(source.id, "sync");
    try {
      // ITEM A (provider trust fingerprint) / F3 — strictly BEFORE any vault
      // read for this source (the required-secret presence loop right below
      // this reads real secret values from the vault). VS Code gives Nexus no
      // way to verify WHICH extension currently answers `source.providerId`
      // (see publicApi.ts's trust-model doc) — only whether the current
      // registrant's declared shape (label + configFields) still matches
      // what the user configured against last time. A mismatch means the id
      // was re-registered with a materially different provider since —
      // silently handing that registrant the source's decrypted secrets is
      // exactly the silent-secret-handover risk the trust-model doc warns
      // about, so ask first. A source with NO stamped fingerprint at all
      // (saved before this field existed) has nothing to compare against —
      // it is stamped silently after this sync succeeds, no modal shown.
      // checkProviderFingerprint is the same helper editSource's own
      // pre-open gate uses, so the two flows can't drift on wording or on
      // when this confirmation fires.
      const fingerprintCheck = await checkProviderFingerprint(source, provider);
      if (fingerprintCheck.outcome === "cancelled") {
        // Cancel (or dismiss) aborts before ANY vault.get for this source —
        // the required-secret loop and every other vault read below never run.
        return;
      }
      const fingerprintToStamp = fingerprintCheck.fingerprintToStamp;

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
          // m3 — the user-facing label ("API Token"), not the provider's
          // internal field id ("apiToken"); falls back to the id only if a
          // provider ever leaves label unset (the type requires it, but this
          // stays defensive since providers are third-party-authored).
          const fieldName = field.label || field.id;
          void vscode.window.showErrorMessage(`Missing saved credential "${fieldName}" for "${source.name}" — edit the source to re-enter it.`);
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

      // PAIRING RULE (see resolveSourceAuthProfile) — resolved immediately
      // before the call it feeds, against `source`, and reassigned in lockstep
      // with `plan` at every point below where `plan` itself is reassigned
      // (the fast-path fall-through and the retry loop).
      let planAuthProfile = resolveSourceAuthProfile(core, source);
      // ADOPT 1 / REVIEW FINDING (P1, cross-instance adoption) — which DEPLOYMENT
      // of `provider` this sync is talking to, derived from the same source
      // config the fetch above used. Only a kept server whose marker names this
      // same deployment may be adopted (see `ComputeSyncPlanInput
      // .providerInstanceKey`); `undefined` — a provider that names no instance —
      // means no adoption at all, never a fall back to the provider id.
      //
      // Re-derived, like `planAuthProfile`, at every point below where `plan` is
      // recomputed against a re-read source record, so it always describes the
      // config that plan was computed from rather than the one this run started
      // with.
      let planInstanceKey = resolveProviderInstanceKey(provider, source.config);
      let plan = computeSyncPlan({
        source,
        tree,
        currentServers: core.getSnapshot().servers,
        now: Date.now(),
        authProfile: planAuthProfile,
        providerInstanceKey: planInstanceKey,
        templatesById: resolveTemplatesById(core),
        authProfilesById: resolveAuthProfilesById(core)
      });

      // Nothing to do AND nothing to ask: apply an empty application to bump
      // lastSyncAt without a confirm modal. `planHasNothingToDo` is the whole of
      // that condition and is shared with the in-lock recompute below — see its
      // doc for why an adoption candidate makes a count-empty plan non-empty
      // here, and why both gates have to ask the same question.
      if (planHasNothingToDo(plan)) {
        // FINDING 2 (P2, fast-path-stale-recompute review) — `plan` above was
        // computed BEFORE this lock acquisition; a queued mutation elsewhere
        // (e.g. a locked nexus.server.remove deleting a server this source
        // owns) can complete in the gap between that computation and actually
        // acquiring the lock here, turning a genuinely-stale empty plan into
        // one that would delete/add/update something once state is current.
        // Recompute from a FRESH snapshot inside the lock and branch on that
        // result, never on the pre-lock `plan`:
        //   - still empty -> the original behavior (bump lastSyncAt, "nothing
        //     to do" toast, no confirm modal — this path exists specifically
        //     to skip the modal for a no-op sync).
        //   - NOT empty -> do not apply anything here. Return a signal so the
        //     lock is released FIRST (never show the confirm modal while
        //     holding configMutationLock — see the rule documented on the
        //     lock itself) and the outer code falls through into the normal
        //     confirmation flow with the recomputed plan, exactly as if the
        //     very first computeSyncPlan call above had produced it.
        // ITEM 5 — same rejection surface as the main apply path below: a
        // source config race (or any persist failure) here must produce a
        // friendly error instead of an unhandled command rejection.
        type FastPathResult =
          | { kind: "done"; plan: InventorySyncPlan; removedEmptyFolderCount: number; source: InventorySourceConfig }
          | {
              kind: "not-empty";
              plan: InventorySyncPlan;
              authProfile: AuthProfile | undefined;
              // REVIEW FINDING (P1) — carried out with the plan for the same
              // reason `authProfile` is: the caller keeps computing plans after
              // this, and each of them must be computed against the same
              // instance identity this recompute used.
              instanceKey: string | undefined;
            }
          | { kind: "abort" };
        const fastPathResult: FastPathResult = await configMutationLock.runExclusive(async (): Promise<FastPathResult> => {
          const freshSource = core.getInventorySource(source.id);
          if (!freshSource) {
            void vscode.window.showErrorMessage("The inventory source was removed before the sync could be applied.");
            return { kind: "abort" };
          }
          if (!sourceConfigUnchanged(source, freshSource)) {
            void vscode.window.showErrorMessage(
              `Inventory source "${source.name}" configuration changed while syncing — run Sync Now again.`
            );
            return { kind: "abort" };
          }
          const freshAuthProfile = resolveSourceAuthProfile(core, freshSource);
          // Derived from `freshSource.config`, not the outer `source`'s — the
          // pairing rule `planAuthProfile` follows, for the same reason: this
          // plan is about the record as it stands now.
          const freshInstanceKey = resolveProviderInstanceKey(provider, freshSource.config);
          const recomputed = computeSyncPlan({
            source: freshSource,
            tree,
            currentServers: core.getSnapshot().servers,
            now: Date.now(),
            authProfile: freshAuthProfile,
            providerInstanceKey: freshInstanceKey,
            templatesById: resolveTemplatesById(core),
            authProfilesById: resolveAuthProfilesById(core)
          });
          // THE SAME PREDICATE AS THE OUTER GATE, deliberately — a second gate
          // asking a narrower question is the first one's blindness moved rather
          // than fixed (REVIEW FINDING, P1). This one is reachable with a
          // candidate the outer plan did not have: the queued mutation this
          // recompute exists to catch can be the very write that CREATES the
          // adoptee (an ID-preserving config import landing while the fetch was
          // in flight), which leaves the fresh plan count-empty and carrying a
          // question nobody would ever be asked.
          if (!planHasNothingToDo(recomputed)) {
            return { kind: "not-empty", plan: recomputed, authProfile: freshAuthProfile, instanceKey: freshInstanceKey };
          }
          // FIX B (round 10, SECURITY) — capture+delete any stale proxy-password
          // secret BEFORE the apply publishes the new proxy (see the helper's doc:
          // connect doesn't take the lock, so an after-apply clear leaks). A delete
          // failure throws out of the helper (fail closed) → the shared catch below
          // restores + aborts; an apply failure likewise restores `cleared` so the
          // still-live old proxy keeps its password. This fast-path only fires on a
          // nothing-to-do plan (no updates), so `cleared` is empty here — routed for
          // uniform coverage. `cleared` stays `[]` if the helper itself throws (it
          // restores internally), so the catch's restore is then a harmless no-op.
          let cleared: Array<{ key: string; value: string }> = [];
          try {
            cleared = await clearStaleProxyPasswordSecretsBeforeApply(vault, recomputed.updates);
            const applyResult = await core.applyInventorySyncPlan(planToApplication(recomputed, freshSource));
            // F5 — `freshSource` (the exact incarnation this apply just ran
            // against), not the outer `source` captured before this sync
            // started, is what the post-lock restamp below must compare
            // against.
            return { kind: "done", plan: recomputed, removedEmptyFolderCount: applyResult.removedEmptyFolderCount, source: freshSource };
          } catch (error) {
            // The apply did NOT commit (or a stale-secret delete failed) — the old
            // proxy config is still live and needs its password; put back what we
            // deleted before surfacing the failure.
            await restoreProxyPasswordSecrets(vault, cleared);
            // m4 — a source-record replacement race surfaces the same
            // friendly, name-bearing wording as the pre-apply fast-fail check
            // just above, never core's raw "...uuid..." message.
            void vscode.window.showErrorMessage(
              isSourceConfigMismatchError(error)
                ? `Inventory source "${source.name}" configuration changed while syncing — run Sync Now again.`
                : `Inventory sync failed: ${error instanceof Error ? error.message : String(error)}`
            );
            return { kind: "abort" };
          }
        });
        if (fastPathResult.kind === "abort") return;
        if (fastPathResult.kind === "done") {
          const donePlan = fastPathResult.plan;
          // ITEM A — the sync (a no-op apply, but still a successful one)
          // has now committed; restamp outside the lock just released above.
          if (fingerprintToStamp) {
            await restampProviderFingerprintBestEffort(core, fastPathResult.source, fingerprintToStamp);
          }
          // ITEM B — surfaced only when nonzero, appended to the same toast.
          const emptyFolderNote =
            fastPathResult.removedEmptyFolderCount > 0
              ? ` ${fastPathResult.removedEmptyFolderCount} empty folder${fastPathResult.removedEmptyFolderCount === 1 ? "" : "s"} removed.`
              : "";
          void vscode.window.showInformationMessage(
            `Inventory sync from "${source.name}" complete — nothing to change (${donePlan.unchangedCount} unchanged).${emptyFolderNote}`
          );
          if (donePlan.warnings.length > 0) {
            void vscode.window
              .showWarningMessage(`${donePlan.warnings.length} warning${donePlan.warnings.length === 1 ? "" : "s"} during sync.`, "Show Details")
              .then((choice) => {
                if (choice === "Show Details") void openInventoryIssuesText(donePlan.warnings);
              });
          }
          return;
        }
        // "not-empty" — lock already released above; fall through into the
        // normal confirmation flow below with the freshly recomputed plan.
        plan = fastPathResult.plan;
        planAuthProfile = fastPathResult.authProfile;
        planInstanceKey = fastPathResult.instanceKey;
      }

      // ADOPT 1 — THE QUESTION. Asked at most once per run, here: after the
      // fetch and the plan it produced, before the confirmation loop below.
      //
      // WHY THE ENGINE CANNOT DECIDE THIS. Adoption hands an existing record's
      // whole lifecycle to the source — its name, its address, its folder, and
      // the source's prune policy with `delete` in it. The plan can prove a
      // device WAS synced onto a record and that the record is still at that
      // address; it cannot know whether the user wants that record back under
      // management or deliberately kept it separate. So the engine reports
      // candidates and refuses to act, and the answer to this question is what
      // turns them into updates.
      //
      // WHY HERE, and not on the preview modal's button row: the preview's
      // detail must describe the ONE plan the user is consenting to, and the
      // drift machinery compares one rendered detail against one recompute. Two
      // apply variants would be one text describing two futures.
      //
      // NEVER WHILE HOLDING configMutationLock — the same rule the preview
      // modal obeys (see the lock's own doc). The fast-path block above has
      // released it by the time control reaches here, in both of its
      // fall-through paths.
      //
      // REACHED FROM EVERY PATH ABOVE, which is what `planHasNothingToDo` is
      // for. The fast path used to swallow this question whenever the counts came
      // back empty, and a candidate is NOT always a planned add: the restored
      // ID-preserving backup produces a candidate the engine cannot add (its id
      // is held by the adoptee) and therefore an empty-by-the-counts plan. That
      // run is the one that most needs asking — it is the only way a restored
      // source can ever reclaim its own servers — so "empty" now means "nothing
      // to do and nothing to ask", at both of the fast path's gates.
      let adoptionChoice: InventoryAdoptionChoice | undefined;
      // ADOPT 1 / REVIEW FINDING (P1, re-ask when adoption candidates change) —
      // the candidate set the question below was PUT ABOUT, captured from the
      // very plan that raised it. `undefined` while (and only while) no question
      // has been asked; see `adoptionAnswerIsStale` for what that state means.
      let answeredAdoptionPairs: ReadonlySet<string> | undefined;
      /**
       * REVIEW FINDING (P1, re-ask when adoption candidates change) — "is this
       * plan still about the candidates the user answered for?", asked of EVERY
       * plan computed under `adoptionChoice` before that plan is rendered or
       * applied.
       *
       * WHY THE ANSWER NEEDS A GUARD OF ITS OWN, over and above `planDetailDrift`.
       * The drift comparator's baseline ROLLS FORWARD: it compares the plan about
       * to be applied against the plan the LAST preview rendered, and on a
       * mismatch it re-renders and re-bases. That is right for the preview, whose
       * consent is collected fresh on every pass. The question is not re-put on
       * any pass, so its consent has one fixed baseline — this set — and the
       * window it has to cover starts the moment the question is shown, which is
       * BEFORE the first preview exists. A swap landing in that window (another
       * source removed with Keep Servers, a config import or backup restore
       * replacing a kept record) is invisible to every artifact downstream of it:
       * the preview counts the same number of adoptions, `describePlanDetail`
       * renders byte-identical text, and the pair list behind Show Warnings —
       * where the identities do appear — is one click the user need never take.
       *
       * SET EQUALITY, not "no new candidates". A candidate that DISAPPEARS is
       * also a changed question: the count the user weighed ("adopt 4 servers")
       * is part of what they answered, and a shrunken set means at least one
       * device they were told would be reclaimed is about to be duplicated or
       * skipped instead.
       *
       * `undefined` means the question was never put, which is not the same as
       * "no candidates were disclosed" — it is a run with no adoption consent in
       * it at all. `adoptionChoice` is then `undefined` too, so nothing can be
       * adopted whatever candidates a later recompute turns up (they render as
       * duplicate adds — today's accepted behaviour, see the note under the
       * question block). Refusing there would abort syncs over a set that cannot
       * be acted on.
       */
      const adoptionAnswerIsStale = (candidatePlan: InventorySyncPlan): boolean =>
        answeredAdoptionPairs !== undefined && !capturedSetsEqual(answeredAdoptionPairs, adoptionCandidateKeys(candidatePlan));
      /**
       * ABORT, NOT RE-ASK — the precedent every other "the world moved under a
       * confirmation" check in this command follows (source removed, config
       * changed, credentials changed; and `serverAuthProfileRejection` /
       * `inventoryAuthProfileRejection` outside it). The preview's drift guard
       * re-shows instead, but it can: it sits in a loop that already exists and
       * is capped, and the modal it re-shows is the one it just rendered.
       *
       * The question has neither. It is deliberately asked ONCE per run and never
       * while `configMutationLock` is held (see its own doc) — and two of the
       * three places this guard fires are inside that lock, after teardown has
       * begun. Re-asking from there would mean unwinding the lock, threading a
       * second answer back through a plan that has already been previewed, and
       * capping a second loop that can spin for the same reason the first one
       * can. Refusing costs the user one re-run of a sync that has changed
       * nothing, and the next run puts the question about the set that actually
       * exists.
       */
      const reportStaleAdoptionAnswer = (): void => {
        // States the FACT rather than the moment: this fires from three
        // different windows (while the question was open, while the preview was,
        // and during the in-lock awaits), and copy naming any one of them would
        // be wrong in the other two.
        void vscode.window.showErrorMessage(
          `The servers "${source.name}" offered to adopt are no longer the ones you were asked about — sync aborted, run Sync Now again.`
        );
      };
      if (plan.adoptionCandidates.length > 0) {
        const n = plan.adoptionCandidates.length;
        // Up to three names, `pushSkipSummary`'s precedent (syncEngine.ts) —
        // both the cap and the "e.g." that goes with it. Device names, which is
        // the half of each candidate pair the user can recognise from the
        // inventory they just re-added: at this point they have not been shown
        // any pairing yet, and the kept servers' own tree names are named one
        // click away, behind the preview's Show Warnings.
        //
        // The names sit beside the noun they belong to — "1 device (…)", not
        // "…a server you kept (…)" (NIT): they are DEVICE names, and attached to
        // the nearest noun they read as the tree names of the servers, which is
        // the one pairing the user cannot yet see.
        const examples = plan.adoptionCandidates
          .slice(0, 3)
          .map((candidate) => `"${candidate.deviceName}"`)
          .join(", ");
        // REVIEW FINDING (P2) — THE DECLINE LINE, which is the only line here
        // that can be false. `separateAddBlocked` is the engine's own record of
        // the collision exemption that let the candidate exist at all (see
        // `InventoryAdoptionCandidate`): the adoptee already holds the id an add
        // for this device would need, so choosing Add Separately reaches the
        // engine's collision fall-through, which skips the device and adds
        // nothing. Read off the candidate rather than recomputed from
        // `deterministicServerId` here — a second derivation of the same fact is
        // a second thing that can drift from the plan the answer is spent on.
        //
        // WHY THIS IS NOW REACHABLE AT ALL: the fast path used to return before
        // the question whenever a plan's add/update/prune counts were empty, and
        // a restored ID-preserving backup produces exactly such a plan. Fixing
        // that made this the ordinary shape of the restored-backup run, not a
        // corner of it — the copy promising a separate add went live with it.
        //
        // THE MIXED CASE IS NAMED, NOT AVERAGED. With one blocked device among
        // three, neither "adds each device" nor "adds nothing" is true, and a
        // sentence hedged into vagueness would leave the user unable to tell
        // which of the three they are about to lose. Same cap and the same "e.g."
        // discipline as the count line above (`pushSkipSummary`'s precedent), and
        // the same singular/plural rule: one name is the whole list, so it is not
        // an example.
        //
        // The reason given is the engine's own words for it ("still uses the id a
        // new server ... would need" — one name for one concept), so the sentence
        // the user reads before choosing and the warning they find afterwards
        // behind Show Warnings describe one situation rather than two.
        const blocked = plan.adoptionCandidates.filter((candidate) => candidate.separateAddBlocked);
        const blockedExamples = blocked
          .slice(0, 3)
          .map((candidate) => `"${candidate.deviceName}"`)
          .join(", ");
        /**
         * AND THE BUTTON ITSELF, in the one case where its name is the false
         * promise. "Add Separately" is an ACTION label — it says what pressing it
         * does — so when nothing can be added separately it is wrong in exactly
         * the way the detail line was, and a dialog whose button says "Add
         * Separately" above a body reading "adds nothing" makes the user
         * reconcile a contradiction the code could simply not have written.
         *
         * ONLY when EVERY candidate is blocked. In the mixed case the label is
         * true of at least one device and the detail names the exceptions, so a
         * third label there would buy nothing and cost the same.
         *
         * THE COST, stated plainly: a label that varies between runs is a real
         * cost — people learn a button by its name as well as its position. It is
         * paid here because the two runs are not the same question (their bodies
         * already differ), the button keeps its POSITION as the second, non-
         * adopting choice, and the name changes precisely when the old one would
         * have described something that does not happen. A fixed label bought
         * consistency by being false in a state the user can reach by restoring a
         * backup, which is the defect this finding is about.
         *
         * "Don't Adopt" rather than "Keep Servers": that phrase is already spent
         * on the removal dialog's opposite-of-delete fork, and reusing it for the
         * opposite-of-adopt fork would make one label mean two things.
         */
        const declineLabel = blocked.length === n ? "Don't Adopt" : "Add Separately";
        const separateLine =
          blocked.length === 0
            ? n === 1
              ? "Add Separately leaves that server untouched and adds the device as a separate new server."
              : "Add Separately leaves those servers untouched and adds each device as a separate new server."
            : blocked.length === n
              ? n === 1
                ? "Don't Adopt leaves that server untouched and adds nothing: it still uses the id a new server for this device would need, so the device is skipped rather than added separately."
                : "Don't Adopt leaves those servers untouched and adds nothing: each still uses the id a new server for its device would need, so every one of these devices is skipped rather than added separately."
              : blocked.length === 1
                ? `Add Separately leaves those servers untouched and adds each device as a separate new server — except 1 device (${blockedExamples}), whose kept server still uses the id a new server for it would need, so that device is skipped rather than added separately.`
                : `Add Separately leaves those servers untouched and adds each device as a separate new server — except ${blocked.length} devices (e.g. ${blockedExamples}), whose kept servers still use the ids new servers for them would need, so those devices are skipped rather than added separately.`;
        // m1/m2 — full sentences, per-count verbs, no bare counts. The first
        // line states the FACT that makes these servers eligible, in the same
        // words the preview and the pair list use ("kept from a removed
        // inventory source" — one name for one concept, REVIEW FINDING):
        // eligibility is a recorded history, not an address match, and copy that
        // said "servers already in your list" would describe a population this
        // can never touch.
        //
        // Each button's line says what that button does to the EXISTING
        // servers, because that is the whole of the decision — both answers
        // leave the same devices synced afterwards.
        //
        // THE PRUNE DISCLOSURE (REVIEW FINDING) is part of the Adopt line rather
        // than a footnote, because it is the one consequence of this decision
        // that arrives long after it and looks like something else when it does:
        // the code's own comments say five times that adoption hands the whole
        // lifecycle over "prune policy, `delete` included", while every sentence
        // the user ever saw stopped at name/address/folder — which reads as the
        // complete list. A source set to Delete can then remove an adopted
        // server, and its saved credentials, months later, reported only as an
        // anonymous count in some future plan. Named as the form names it
        // ("Removed-Device Policy", formDefinitions.ts) so it can be found and
        // changed.
        const detail =
          n === 1
            ? [
                `1 device (${examples}) was previously synced onto a server you kept from a removed inventory source.`,
                `Adopt Existing re-links that server to "${source.name}" instead of adding a copy — it keeps its saved credentials and settings, and this source takes over its name, address and folder from now on. This source's Removed-Device Policy applies to it too, so a source set to Delete removes it, and its saved credentials, if the device later disappears from the source.`,
                separateLine,
                "Nothing changes until you choose Apply on the sync preview."
              ].join("\n")
            : [
                `${n} devices (e.g. ${examples}) were previously synced onto servers you kept from a removed inventory source.`,
                `Adopt Existing re-links those servers to "${source.name}" instead of adding copies — each keeps its saved credentials and settings, and this source takes over its name, address and folder from now on. This source's Removed-Device Policy applies to them too, so a source set to Delete removes any one of them, and its saved credentials, if its device later disappears from the source.`,
                separateLine,
                "Nothing changes until you choose Apply on the sync preview."
              ].join("\n");
        // REVIEW FINDING (P1) — WHAT THE QUESTION IS ABOUT, captured BEFORE the
        // await that puts it, off the same `plan` object the copy above was
        // rendered from. Taking it here rather than after the answer comes back
        // is the whole discipline in one line: it cannot pick up a candidate set
        // that arrived while the modal was open, which is exactly the set the
        // answer must never be spent on.
        //
        // The full pair set, not the (up to three) names the copy shows: the
        // question asks the user to hand over a POPULATION it describes by count
        // and samples, so consent covers all n of them, and a comparison against
        // the rendered text alone would wave through any swap among the
        // candidates past the third.
        answeredAdoptionPairs = adoptionCandidateKeys(plan);
        // Information, not warning: this fork mutates nothing on its own — the
        // preview below still gates the apply. "Adopt Existing" first, since in
        // the scenario this feature exists for (remove with Keep Servers, re-add
        // the same source) it is almost always the intent.
        const answer = await vscode.window.showInformationMessage(
          n === 1
            ? `Adopt 1 server kept from a removed inventory source into "${source.name}"?`
            : `Adopt ${n} servers kept from a removed inventory source into "${source.name}"?`,
          { modal: true, detail },
          "Adopt Existing",
          declineLabel
        );
        // Compared against the label that was actually RENDERED, never against
        // the string literal: the decline button is named for what it does in
        // this run, so a hard-coded "Add Separately" here would silently drop the
        // answer on every all-blocked run and fall through to "dismissed".
        if (answer === "Adopt Existing" || answer === declineLabel) {
          adoptionChoice = answer === "Adopt Existing" ? "adopt" : "decline";
          // PAIRING RULE (see resolveSourceAuthProfile) — re-resolved in
          // lockstep with `plan`, immediately before the call it feeds, against
          // the same `source` snapshot the initial computation used.
          planAuthProfile = resolveSourceAuthProfile(core, source);
          planInstanceKey = resolveProviderInstanceKey(provider, source.config);
          // RECOMPUTED ON BOTH ANSWERS, not just on Adopt. The rule this run
          // follows from here is that the answer is threaded by name into EVERY
          // computeSyncPlan call, and the preview is the first of them: a plan
          // the modal renders that was computed under different inputs from the
          // in-lock recompute under it is drift by construction — the modal
          // re-shows on every pass until the mismatch cap aborts a sync nothing
          // was actually wrong with. `"decline"` happens to produce the same plan
          // as no answer today (see `InventoryAdoptionChoice`); making the
          // preview depend on that staying true is how the next behaviour keyed
          // on the answer would arrive already broken.
          plan = computeSyncPlan({
            source,
            tree,
            currentServers: core.getSnapshot().servers,
            now: Date.now(),
            authProfile: planAuthProfile,
            providerInstanceKey: planInstanceKey,
            templatesById: resolveTemplatesById(core),
            authProfilesById: resolveAuthProfilesById(core),
            adoptionChoice
          });
          // GUARD SITE 1 of 3 (REVIEW FINDING, P1) — this recompute is the first
          // consumer of the answer, and the one the finding is about: it reads a
          // server snapshot taken AFTER the question was answered, so the set it
          // finds eligible can differ from the set the question named while
          // reporting the same count. Everything downstream then agrees with
          // itself and with nothing the user saw — the preview counts n
          // adoptions, the drift comparator re-bases on those pairs, and Apply
          // transfers a record, its saved credentials and its future prune
          // lifecycle to this source without it ever having been mentioned.
          //
          // Nothing has been mutated at this point (the fetch is the only work
          // discarded), exactly as on the dismissal path below.
          if (adoptionAnswerIsStale(plan)) {
            reportStaleAdoptionAnswer();
            return;
          }
          // NO FAST-PATH RE-ENTRY after this recompute, deliberately. On Adopt
          // the plan carries the adoption, so there is nothing to re-enter for.
          // On Add Separately it CAN come back empty — the restored-backup shape
          // above is exactly that: the device cannot be added under an id its own
          // adoptee still holds, so the answer produces a skip and a warning
          // rather than a record. That run falls through into the preview below
          // with an empty plan, which is where it belongs: the modal states the
          // (nil) effect and Show Warnings carries the engine's sentence saying
          // the device was skipped rather than added separately, and how to
          // reclaim it. A silent return would drop the one explanation the user
          // has, and re-entering the fast path would collect a second consent for
          // a run they have already answered. An empty plan reaching this modal
          // is not a new shape — the drift/retry loop below can produce one
          // whenever a concurrent change empties a confirmed plan.
        } else {
          // Esc/dismiss ABORTS the sync. The answer governs the apply, and none
          // was given: defaulting an unanswered question to either side is the
          // silent path this whole feature exists to remove. Nothing has been
          // mutated at this point — the fetch is the only work discarded.
          return;
        }
      }
      // From here `adoptionChoice` is fixed for the whole run and is threaded BY
      // NAME into every remaining computeSyncPlan call. A recompute that misses
      // it computes a different plan than the preview rendered: the drift
      // comparator does catch that (adds↔updates changes the detail text), but
      // only by re-showing the modal until the mismatch cap aborts the sync.
      // The two fast-path recomputes above deliberately pass no answer — they
      // run BEFORE the question, and the candidate list of an unanswered plan is
      // exactly what decides whether the question is asked at all.
      //
      // Candidates that first appear in a LATER recompute of a run where the
      // question was never asked (initial count 0) render as duplicate adds.
      // That is today's behavior, accepted: the run is already under way and
      // re-asking mid-loop would collect an answer to a question the user never
      // saw the plan for. `adoptionAnswerIsStale` deliberately passes them —
      // there is no answer for them to be stale against, and with
      // `adoptionChoice` undefined nothing can be adopted whatever turns up.
      //
      // Where an answer DOES exist it is checked against the candidate set of
      // every plan computed under it, at all three of the sites below, and a
      // change ends the run. That is the other half of "asked once per run": the
      // question is not re-put, so the set it was put about is fixed for the rest
      // of the run and a plan about a different set is not this run's to apply.

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
        | { kind: "retry"; plan: InventorySyncPlan; authProfile: AuthProfile | undefined }
        | {
            kind: "success";
            finalPlan: InventorySyncPlan;
            recreatedCount: number;
            teardownFailureCount: number;
            removedEmptyFolderCount: number;
            // F5 — the exact source incarnation this attempt actually applied
            // against (`freshSource`, read inside this same locked attempt),
            // for the post-lock restamp below to compare against.
            source: InventorySourceConfig;
          };

      for (;;) {
        // FINDING 1 — captured together so the drift check inside the lock
        // below compares against EXACTLY what this modal rendered: the same
        // plan and the same server snapshot describePlanDetail was called
        // with here, not a re-derived approximation of either.
        const shownServers = core.getSnapshot().servers;
        // ROUND 8 (P1) — the whole-profile map is captured HERE, at shown time,
        // alongside `shownServers`, so `shownDetail` names each switch's real
        // target (`after.authProfileId`) as it stood when the modal opened; the
        // in-lock drift render below uses a FRESH map, so a template retarget or
        // a profile rename between the two surfaces as ordinary drift.
        const shownDetail = describePlanDetail(plan, shownServers, planAuthProfile?.name, resolveAuthProfilesById(core));
        const shownDeleteIds = deletePruneIds(plan);
        // Captured alongside the delete set, from the SAME plan this modal
        // renders — these are the servers `shownWarnings` is about to name.
        const shownAuthSwitchIds = authProfileSwitchIds(plan);
        // Same capture, same reason, for the pairs this plan would adopt:
        // `shownWarnings` names each pair — the record AND the device claiming
        // it — so consent is for those pairings, and the drift check below is
        // what keeps either half from being swapped out under it.
        const shownAdoptionPairs = adoptionPairKeys(plan);
        // The button is keyed on the BUFFER, not on plan.warnings: a retro-apply
        // sync usually carries no engine warnings at all, and without this the
        // one place that names the servers about to switch would be unreachable
        // in exactly the case it exists for. Nothing here feeds the drift
        // comparison — choosing Show Warnings ends the command (below), so the
        // names are never a consent artifact something later applies against.
        const shownWarnings = planWarningsBuffer(plan, planAuthProfile?.name, resolveAuthProfilesById(core));
        const buttons = shownWarnings.length > 0 ? ["Apply", "Show Warnings"] : ["Apply"];
        const choice = await vscode.window.showInformationMessage(
          `Apply inventory sync from "${source.name}"?`,
          { modal: true, detail: shownDetail },
          ...buttons
        );
        if (choice === "Show Warnings") {
          await openInventoryIssuesText(shownWarnings);
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

          const freshServersForRecompute = core.getSnapshot().servers;
          // Resolved FRESH here, inside the lock, against `freshSource` — never
          // the `planAuthProfile` the modal rendered with. That is the whole
          // point of the pairing rule: a profile renamed or deleted while the
          // modal was open changes this render and drifts.
          const freshAuthProfile = resolveSourceAuthProfile(core, freshSource);
          // REVIEW FINDING (P1) — derived fresh beside the profile, from
          // `freshSource.config`. `sourceConfigUnchanged` above has already
          // refused a changed config, so this cannot differ from
          // `planInstanceKey` today; deriving it here anyway keeps the plan's
          // inputs coming from ONE record rather than two, which is what stops a
          // later loosening of that check from quietly pairing this tree with
          // another deployment's identity.
          const freshInstanceKey = resolveProviderInstanceKey(provider, freshSource.config);
          const recomputed = computeSyncPlan({
            source: freshSource,
            tree,
            currentServers: freshServersForRecompute,
            now: Date.now(),
            authProfile: freshAuthProfile,
            providerInstanceKey: freshInstanceKey,
            templatesById: resolveTemplatesById(core),
            authProfilesById: resolveAuthProfilesById(core),
            // ADOPT 1 — the answer given once above governs EVERY recompute of
            // this run. Omitted here, this plan would render adds where the
            // preview rendered adoptions and drift on every pass, looping the
            // user through the modal until the mismatch cap aborts the sync.
            adoptionChoice
          });
          // GUARD SITE 2 of 3 (REVIEW FINDING, P1) — BEFORE the drift check, not
          // after it, and that order is the point. The drift comparator's verdict
          // on a changed candidate set is "re-show the preview", which re-bases
          // its own baseline on the new pairs; the next pass then agrees with
          // itself and applies a set the question was never put about. Asking the
          // fixed question here first means a swap that lands while the PREVIEW
          // is open ends the run instead of laundering itself through one extra
          // confirmation.
          //
          // Nothing has been mutated yet on this path either — the teardown loop
          // below is the first thing that touches anything.
          if (adoptionAnswerIsStale(recomputed)) {
            reportStaleAdoptionAnswer();
            return { kind: "abort" };
          }
          const recomputedDrift = planDetailDrift(
            { detail: shownDetail, deleteIds: shownDeleteIds, authSwitchIds: shownAuthSwitchIds, adoptionPairs: shownAdoptionPairs },
            recomputed,
            freshServersForRecompute,
            freshAuthProfile?.name,
            // ROUND 8 (P1) — fresh map, so a template retarget or profile rename
            // landing while the modal was open renders a different target here
            // than `shownDetail` captured and drifts.
            resolveAuthProfilesById(core)
          );
          if (recomputedDrift.drift) {
            return { kind: "retry", plan: recomputed, authProfile: freshAuthProfile };
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
          const finalServersForRecompute = core.getSnapshot().servers;
          // Resolved fresh again — the teardown loop and the FINDING D vault
          // re-read above are awaits a profile rename/delete can land inside.
          const finalAuthProfile = resolveSourceAuthProfile(core, freshSource);
          const finalPlan = computeSyncPlan({
            source: freshSource,
            tree,
            currentServers: finalServersForRecompute,
            now: Date.now(),
            authProfile: finalAuthProfile,
            // Same record, same derivation as the recompute above — this is the
            // plan that is actually APPLIED, so the identity that decided its
            // adoptions must be the one derived from the source it applies
            // against.
            providerInstanceKey: freshInstanceKey,
            templatesById: resolveTemplatesById(core),
            authProfilesById: resolveAuthProfilesById(core),
            // ADOPT 1 — same answer, same run. This is the plan that is actually
            // APPLIED, so an answer missed here would not merely loop: it would
            // apply duplicate adds against consent collected for adoptions
            // (caught by the drift check just below, but only as a retry).
            adoptionChoice
          });
          // GUARD SITE 3 of 3 (REVIEW FINDING, P1) — the LAST consumer of the
          // answer, and the plan that is actually applied. The awaits above it
          // (the teardown loop, the vault re-read) are a window a candidate swap
          // can land in like any other.
          //
          // On an "adopt" run `finalDrift` below would also notice — candidates
          // and adoption pairs are the same set there (`adoptionCandidateKeys`)
          // — but only as a retry, which is the laundering site 2 exists to
          // close, one loop iteration later. On a DECLINE run nothing else
          // compares candidates at all: no adoption pairs exist to compare, and a
          // candidate that stops being one is worth the same rendered counts. The
          // answer given governs this plan, so this plan is checked against it.
          if (adoptionAnswerIsStale(finalPlan)) {
            reportStaleAdoptionAnswer();
            return { kind: "abort" };
          }
          const finalApplication = planToApplication(finalPlan, freshSource);

          // FINDING 1 — compare the post-teardown final recompute's rendered
          // detail (and delete-id set) against the plan the user just
          // reconfirmed (`recomputed`, rendered right before the teardown
          // loop above via `recomputedDrift.detail`). If they differ, do NOT
          // apply unseen: loop back to the confirmation modal with the new
          // plan (releasing the lock first). Nothing has been applied yet
          // (applyInventorySyncPlan hasn't been called), so re-declining on
          // the next confirmation leaves state untouched.
          const finalDrift = planDetailDrift(
            {
              detail: recomputedDrift.detail,
              deleteIds: deletePruneIds(recomputed),
              authSwitchIds: authProfileSwitchIds(recomputed),
              adoptionPairs: adoptionPairKeys(recomputed)
            },
            finalPlan,
            finalServersForRecompute,
            finalAuthProfile?.name,
            // ROUND 8 (P1) — fresh map again; the awaited teardown / vault re-read
            // above are a window a template retarget or profile rename can land in.
            resolveAuthProfilesById(core)
          );
          if (finalDrift.drift) {
            finalRecomputeMismatchCount++;
            if (finalRecomputeMismatchCount > MAX_FINAL_RECOMPUTE_MISMATCHES) {
              void vscode.window.showErrorMessage(
                "Inventory state keeps changing — sync aborted, run Sync Now again."
              );
              return { kind: "abort" };
            }
            return { kind: "retry", plan: finalPlan, authProfile: finalAuthProfile };
          }

          // FINDING E — even after the checks above, the source record could
          // still be replaced during the teardown awaits themselves (between
          // the freshSource check and this call). applyInventorySyncPlan's own
          // synchronous, pre-mutation comparison against `application.expectedSource`
          // is the only thing that can still catch that — surface its rejection
          // the same way as the fast-fail check above rather than letting it
          // propagate as an unhandled command rejection.
          // FIX B (round 10, SECURITY) — capture+delete any stale proxy-password
          // secret BEFORE the apply publishes the new proxy. connect doesn't take
          // configMutationLock, so clearing after the apply (round 9) left a leak
          // window where a connect reads the new proxy config while the old
          // proxy-password-{id} is still in the vault; see the helper's doc. A
          // delete failure throws out of the helper (fail closed) → the catch below
          // restores + aborts; an apply failure restores `cleared` so the still-live
          // old proxy keeps its password.
          let applyResult: { skippedCount: number; removedServerIds: string[]; removedEmptyFolderCount: number };
          let cleared: Array<{ key: string; value: string }> = [];
          try {
            cleared = await clearStaleProxyPasswordSecretsBeforeApply(vault, finalPlan.updates);
            applyResult = await core.applyInventorySyncPlan(finalApplication);
          } catch (error) {
            // The apply did NOT commit (or a stale-secret delete failed) — the old
            // proxy config is still live and needs its password. `cleared` stays
            // `[]` when the helper itself throws (it restores internally), so this
            // restore is a no-op in that case and puts the captured values back
            // when the apply is what threw.
            await restoreProxyPasswordSecrets(vault, cleared);
            // m4 — same friendly rewording as the fast-path apply above.
            void vscode.window.showErrorMessage(
              isSourceConfigMismatchError(error)
                ? `Inventory source "${source.name}" configuration changed while syncing — run Sync Now again.`
                : `Inventory sync failed: ${error instanceof Error ? error.message : String(error)}`
            );
            return { kind: "abort" };
          }
          // (stale proxy secrets were already cleared BEFORE the apply above)

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

          return {
            kind: "success",
            finalPlan,
            recreatedCount: recreatedIds.size,
            teardownFailureCount: teardownFailedIds.size,
            removedEmptyFolderCount: applyResult.removedEmptyFolderCount,
            source: freshSource
          };
        });

        if (attempt.kind === "abort") return;
        if (attempt.kind === "retry") {
          plan = attempt.plan;
          // Reassigned in lockstep with `plan` — the re-shown modal must render
          // the resolution the retried plan was actually computed against.
          planAuthProfile = attempt.authProfile;
          continue;
        }

        // ITEM A — the sync has now committed successfully; restamp as a
        // separate, non-nested locked write outside the attempt's own
        // (already-resolved) lock acquisition. F5 — compared against
        // `attempt.source` (the exact incarnation this attempt applied
        // against), not the outer `source` captured before the sync started.
        if (fingerprintToStamp) {
          await restampProviderFingerprintBestEffort(core, attempt.source, fingerprintToStamp);
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
        // ITEM B — surfaced only when nonzero, appended to the same toast.
        const emptyFolderNote =
          attempt.removedEmptyFolderCount > 0
            ? ` ${attempt.removedEmptyFolderCount} empty folder${attempt.removedEmptyFolderCount === 1 ? "" : "s"} removed.`
            : "";
        // M3 — named-source, plain-English toast; the previous
        // "+A ~U -D (K unchanged)" shorthand never printed a zero-line
        // omission (all four counts always rendered regardless of value), so
        // this keeps that same always-print-all-four behavior.
        void vscode.window.showInformationMessage(
          `Inventory sync from "${source.name}" complete: ${finalPlan.adds.length} added, ${finalPlan.updates.length} updated, ${deletedCount} deleted (${finalPlan.unchangedCount} unchanged).${recreatedNote}${teardownFailureNote}${emptyFolderNote}`
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

  /**
   * nexus.inventory.manage — the Settings-tree hub (Settings ▸ Inventory
   * Sources). Two-level plain showQuickPick that ROUTES into the four
   * existing, race-guarded commands rather than reimplementing any of them:
   * no new persistence, no new webview, no new critical section. Level 2
   * dispatches through vscode.commands.executeCommand (never the local
   * function) so hub, palette and keybinding invocations share one path — and
   * always with the source id, so the target command never re-opens a picker
   * the user has already answered.
   *
   * Deliberately NOT here: a "Reapply auth to synced servers" row. Retro-apply
   * belongs to the sync plan preview and its confirm modal; a second bulk
   * mutation path bypassing that preview is exactly the rejected option C.
   */
  async function manageSources(): Promise<void> {
    const sources = core.getSnapshot().inventorySources;

    interface SourceHubItem extends vscode.QuickPickItem {
      source?: InventorySourceConfig;
      addSource?: boolean;
    }
    const rows: SourceHubItem[] = sources.map((source) => ({
      label: source.name,
      description: sourceDescription(source, registry),
      source
    }));
    if (rows.length > 0) {
      rows.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    }
    rows.push({ label: "$(add) Add Inventory Source…", addSource: true });

    const picked = await vscode.window.showQuickPick(rows, {
      title: "Inventory Sources",
      // Empty state stays INSIDE the picker: the user is already mid-gesture,
      // so the add row is the affordance and pickInventorySource's M2d warning
      // toast ("No inventory sources configured. Add one first.") would be a
      // dead-end interruption here. That toast still serves the direct
      // command paths.
      placeHolder:
        sources.length === 0
          ? "No inventory sources yet — add one to sync servers from your infrastructure"
          : "Choose a source to sync, edit, or remove"
    });
    if (!picked) return;
    if (picked.addSource) {
      await vscode.commands.executeCommand("nexus.inventory.addSource");
      return;
    }
    const source = picked.source;
    if (!source) return;

    interface SourceActionItem extends vscode.QuickPickItem {
      commandId: string;
    }
    const actions: SourceActionItem[] = [
      { label: "$(sync) Sync Now", description: "Fetch devices and preview changes", commandId: "nexus.inventory.syncNow" },
      { label: "$(edit) Edit…", description: "Change settings, credentials, or the auth profile", commandId: "nexus.inventory.editSource" },
      { label: "$(trash) Remove…", description: "Choose what happens to its synced servers", commandId: "nexus.inventory.removeSource" }
    ];
    const action = await vscode.window.showQuickPick(actions, { title: source.name });
    if (!action) return;
    await vscode.commands.executeCommand(action.commandId, source.id);
  }

  return [
    vscode.commands.registerCommand("nexus.inventory.addSource", addSource),
    // Same arg widening as syncNow's below: a menu/tree invocation hands the
    // handler its context object, which must fall through to the picker
    // rather than being read as a source id.
    vscode.commands.registerCommand("nexus.inventory.editSource", (arg?: unknown) => editSource(typeof arg === "string" ? arg : undefined)),
    vscode.commands.registerCommand("nexus.inventory.removeSource", (arg?: unknown) => removeSource(typeof arg === "string" ? arg : undefined)),
    vscode.commands.registerCommand("nexus.inventory.syncNow", (arg?: unknown) => syncNow(typeof arg === "string" ? arg : undefined)),
    vscode.commands.registerCommand("nexus.inventory.manage", manageSources)
  ];
}
