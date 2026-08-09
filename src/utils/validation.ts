import type {
  AuthProfile,
  DetachedServerOrigin,
  ServerConfig,
  ServerOrigin,
  TunnelProfile,
  SerialProfile,
  ProxyConfig,
  LocalShellProfile
} from "../models/config";
import type { InventorySourceConfig } from "../models/inventory";
import { normalizeFolderPath } from "./folderPaths";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function validateSerialDeviceHint(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    isOptionalNonEmptyString(obj.manufacturer) &&
    isOptionalNonEmptyString(obj.serialNumber) &&
    isOptionalNonEmptyString(obj.vendorId) &&
    isOptionalNonEmptyString(obj.productId)
  );
}

export function validateProxyConfig(proxy: unknown): proxy is ProxyConfig {
  if (typeof proxy !== "object" || proxy === null) {
    return false;
  }
  const obj = proxy as Record<string, unknown>;
  if (obj.type === "ssh") {
    return isNonEmptyString(obj.jumpHostId);
  }
  if (obj.type === "socks5") {
    return isNonEmptyString(obj.host) && isValidPort(obj.port);
  }
  if (obj.type === "http") {
    return isNonEmptyString(obj.host) && isValidPort(obj.port);
  }
  return false;
}

export function isValidServerOrigin(value: unknown): value is ServerOrigin {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  // `syncedUsername` and `syncedAuthProfileId` are optional (absent on every
  // server synced before each field existed) but shape-checked like the rest:
  // this guard is the ONLY thing standing between a hand-edited backup /
  // version-skewed globalState and the retro-apply rule that reads them, and an
  // origin member the engine did not write makes the whole marker untrustworthy.
  // Empty is rejected as well as non-string: neither ServerConfig.username nor
  // AuthProfile.id can ever be empty, so an empty stamp could not have come from
  // a sync. The disposition for a malformed origin is unchanged and
  // deliberately loud — both callers of this guard strip the WHOLE origin (see
  // VscodeConfigRepository.getServers and addServerSanitizingOrigin), which costs
  // that server its sync ownership and makes the next sync report an id collision
  // rather than silently mis-deciding whether it was ever hand-edited.
  return (
    isNonEmptyString(obj.sourceId) &&
    isNonEmptyString(obj.externalId) &&
    typeof obj.syncedAt === "number" &&
    isOptionalNonEmptyString(obj.syncedUsername) &&
    isOptionalNonEmptyString(obj.syncedAuthProfileId)
  );
}

/**
 * ADOPT 1 — the shape guard for `ServerConfig.formerlySynced`, the receipt
 * "Keep Servers" leaves behind (see DetachedServerOrigin in models/config.ts).
 *
 * Same trust boundary and the same deliberately strict disposition as
 * `isValidServerOrigin` above: this guard is the only thing standing between a
 * hand-edited backup or a version-skewed globalState row and the sync engine's
 * adoption rule, which hands an existing record's whole lifecycle — name,
 * address, folder, and the source's prune policy, `delete` included — to a
 * source. EVERY member is required and every string non-empty, because the
 * engine's only writer (`removeSource`'s Keep Servers branch) writes all five
 * unconditionally: an absent one cannot have come from this extension, and a
 * partially-trusted marker is one whose `externalId` decides an adoption while
 * its `providerId` is missing to scope it.
 *
 * Callers strip the WHOLE marker rather than the offending member (the same
 * F13/FIX 5 disposition `origin` gets, at the same two boundaries). The cost of
 * a stripped marker is proportionate and self-repairing in the safe direction:
 * the server simply stops being adoptable, so the next sync adds a duplicate and
 * says so, instead of re-homing a record on the strength of a field nobody wrote.
 *
 * REVIEW FINDING (P1, cross-instance adoption) — `instanceKey` is the ONE member
 * that is optional, and the asymmetry is deliberate. Absent, it means "this
 * marker names no provider instance", which the engine already refuses to adopt
 * on (see DetachedServerOrigin in models/config.ts): requiring it here would
 * discard the marker's `sourceName`/`detachedAt` receipts — the only record of
 * where such a server came from — to enforce a rule the engine enforces anyway.
 * PRESENT it must be well-formed, because a present key is compared for equality
 * and decides an adoption: a non-string or an empty string cannot have come from
 * `resolveProviderInstanceKey` (models/inventory.ts, which rejects both), and an
 * empty one would compare equal to another empty one — the very collision the
 * field exists to prevent. Length and control characters are not re-checked
 * here: those bound what this extension WRITES, and a marker that merely carries
 * an over-long key still names a real instance, which is a worse thing to
 * discard than to keep.
 */
export function isValidDetachedServerOrigin(value: unknown): value is DetachedServerOrigin {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj.instanceKey !== undefined && !isNonEmptyString(obj.instanceKey)) {
    return false;
  }
  return (
    isNonEmptyString(obj.sourceId) &&
    isNonEmptyString(obj.sourceName) &&
    isNonEmptyString(obj.providerId) &&
    isNonEmptyString(obj.externalId) &&
    typeof obj.detachedAt === "number"
  );
}

export function validateServerConfig(item: unknown): item is ServerConfig {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const obj = item as Record<string, unknown>;
  if (
    !(
      isNonEmptyString(obj.id) &&
      isNonEmptyString(obj.name) &&
      isNonEmptyString(obj.host) &&
      isValidPort(obj.port) &&
      isNonEmptyString(obj.username) &&
      (obj.authType === "password" || obj.authType === "key" || obj.authType === "agent")
    )
  ) {
    return false;
  }
  if (obj.proxy !== undefined && obj.proxy !== null) {
    if (!validateProxyConfig(obj.proxy)) {
      return false;
    }
  }
  if (obj.legacyAlgorithms !== undefined && typeof obj.legacyAlgorithms !== "boolean") {
    return false;
  }
  if (obj.openFileExplorerOnFirstConnect !== undefined && typeof obj.openFileExplorerOnFirstConnect !== "boolean") {
    return false;
  }
  if (obj.authProfileId !== undefined && (typeof obj.authProfileId !== "string" || obj.authProfileId === "")) {
    return false;
  }
  // REVIEW FINDING (P2) — the same shape check `validateAuthProfile` now makes
  // of `AuthProfile.keyPath`, for the same reason and with the same deliberate
  // limits. `ServerConfig.keyPath` is declared `string | undefined`, but until
  // this line nothing checked it, so a hand-edited backup or a version-skewed
  // globalState row could carry a number/object/array here and still be handed
  // out typed as `ServerConfig`. `hasOwnKeyPath` (services/inventory/syncEngine.ts)
  // then trims it while planning a sync whose key profile has lost its key
  // file, and the TypeError aborts the WHOLE sync after the inventory has
  // already been fetched — not one bad row skipped, the entire run lost.
  //
  // A TYPE check, deliberately not `isOptionalNonEmptyString`: `""` reads
  // identically to absent everywhere that matters (`buildConnectConfig` rejects
  // both with the same message, `hasOwnKeyPath` counts neither as a key of the
  // server's own), so rejecting it would discard a merely untidy record for
  // nothing. And rejection is destructive out of proportion to a malformed
  // bookkeeping field: a rejected server row is dropped by the import and by
  // the globalState load, taking its group, proxy, tunnels' jump-host target
  // and inventory-sync ownership with it. No version of Nexus has ever WRITTEN
  // a non-string here (`formValuesToServer` stores `string | undefined`), so
  // this line can only reject records that are already broken.
  //
  // The use site stays defensive too (see `hasOwnKeyPath`): this boundary is
  // what should stop such a value existing, not the only thing standing
  // between one and a thrown `.trim()`.
  if (obj.keyPath !== undefined && typeof obj.keyPath !== "string") {
    return false;
  }
  // Same tolerant TYPE check, for the same reasons, as `keyPath` above: reject a
  // shape no writer of ours produces, but never a merely untidy value. An empty
  // or whitespace `ipmiHost` reads identically to absent at its one use site
  // (`resolveProfileTokens` refuses both with the same "not set" error), and the
  // CHARSET of a non-empty value is checked there rather than here — the value
  // can arrive from a backup import written by anything, so the substitution
  // site is the chokepoint that actually holds.
  if (obj.ipmiHost !== undefined && typeof obj.ipmiHost !== "string") {
    return false;
  }
  // F13/FIX 5 — a malformed `origin` does not invalidate the whole server
  // row: the row is still accepted here. Stripping the malformed field is
  // NOT this function's job — a type guard must not mutate the value it is
  // asked to check (callers may reasonably assume `item` is unchanged after
  // a `boolean`-returning predicate). The actual strip-and-warn happens one
  // layer up, in VscodeConfigRepository.getServers(), which owns producing
  // the final, storage-clean ServerConfig list.
  //
  // ADOPT 1 — `formerlySynced` is governed by exactly the same rule, for
  // exactly the same reason: see `isValidDetachedServerOrigin` above, which the
  // same two boundaries call to strip it.
  return true;
}

export function validateInventorySource(item: unknown): item is InventorySourceConfig {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const obj = item as Record<string, unknown>;
  if (
    !(
      isNonEmptyString(obj.id) &&
      isNonEmptyString(obj.providerId) &&
      isNonEmptyString(obj.name) &&
      isNonEmptyString(obj.defaultUsername) &&
      (obj.prunePolicy === "delete" || obj.prunePolicy === "orphan" || obj.prunePolicy === "keep")
    )
  ) {
    return false;
  }
  if (typeof obj.targetFolder !== "string" || (obj.targetFolder !== "" && normalizeFolderPath(obj.targetFolder) === undefined)) {
    return false;
  }
  if (typeof obj.config !== "object" || obj.config === null || Array.isArray(obj.config)) {
    return false;
  }
  if (!Object.values(obj.config as Record<string, unknown>).every((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
    return false;
  }
  if (!Array.isArray(obj.secretFieldIds) || !obj.secretFieldIds.every((v) => typeof v === "string")) {
    return false;
  }
  if (obj.lastSyncAt !== undefined && typeof obj.lastSyncAt !== "number") {
    return false;
  }
  // FINDING 1 (removal-identity review) — optional for backward compat: a
  // record persisted before this field existed simply has no revision here;
  // the repository getter backfills one at load time (ensureInventorySourceRevision).
  // When present, it must be a non-empty string.
  if (obj.revision !== undefined && !isNonEmptyString(obj.revision)) {
    return false;
  }
  // ITEM A (provider trust fingerprint) — optional for backward compat, same
  // reasoning as `revision` above: a source saved before this field existed
  // simply has none. When present it must be a non-empty string.
  if (obj.providerFingerprint !== undefined && !isNonEmptyString(obj.providerFingerprint)) {
    return false;
  }
  // REVIEW FINDING 1 (P2, folder-GC ownership) — optional for backward
  // compat, same reasoning as `revision`/`providerFingerprint` above: a
  // record persisted before this field existed (or one that has never
  // completed a sync) simply has none. When present, every entry must be a
  // string (folder paths — not otherwise validated here, mirroring
  // `secretFieldIds` just above; applyInventorySyncPlan only ever writes
  // paths it itself normalized).
  //
  // REVIEW FINDING 2 (P2, imported managedFolders are untrusted) —
  // deliberately a SHAPE check only, same as every other field here. This
  // function also guards ordinary storage-layer loads of the extension's OWN
  // persisted state (VscodeConfigRepository), where `managedFolders` genuinely
  // IS trusted (this extension is the only writer), so it must stay
  // permissive. Backup-imported records are a DIFFERENT trust boundary — see
  // `sanitizeImportedInventorySources` in configCommands.ts, which strips the
  // field entirely from the backup payload BEFORE it ever reaches this
  // function (not after — a malformed value, e.g. `null` or a mixed-type
  // array, would otherwise fail this shape check and reject the entire
  // source, not just the untrusted field) — do NOT "fix" untrusted ownership
  // metadata here; that would also strip it from legitimate storage-layer
  // loads, which must keep it.
  if (obj.managedFolders !== undefined && (!Array.isArray(obj.managedFolders) || !obj.managedFolders.every((v) => typeof v === "string"))) {
    return false;
  }
  // Optional for backward compat, same reasoning as `revision`/
  // `providerFingerprint` above: a source saved before this field existed
  // simply has none. When present it must be a non-empty string — an empty
  // one would read downstream as a dangling profile reference rather than as
  // "no profile", which is what absent means.
  //
  // Unlike `managedFolders`, this is user-authored config, not extension
  // bookkeeping, so it is deliberately NOT stripped by
  // `sanitizeImportedInventorySources` in configCommands.ts: a malformed
  // value rejects the whole source here, exactly as a malformed `revision`
  // does. (A reference that is well-formed but points at a profile the import
  // didn't bring along is a different problem — resolution, not shape — and
  // is handled by the post-import dangling clear, not here.)
  if (obj.authProfileId !== undefined && !isNonEmptyString(obj.authProfileId)) {
    return false;
  }
  return true;
}

export function validateTunnelProfile(item: unknown): item is TunnelProfile {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const obj = item as Record<string, unknown>;
  return (
    isNonEmptyString(obj.id) &&
    isNonEmptyString(obj.name) &&
    isValidPort(obj.localPort) &&
    isNonEmptyString(obj.remoteIP) &&
    (isValidPort(obj.remotePort) || (obj.tunnelType === "dynamic" && obj.remotePort === 0))
  );
}

export function validateSerialProfile(item: unknown): item is SerialProfile {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const obj = item as Record<string, unknown>;
  return (
    isNonEmptyString(obj.id) &&
    isNonEmptyString(obj.name) &&
    isNonEmptyString(obj.path) &&
    typeof obj.baudRate === "number" &&
    (obj.mode === undefined || obj.mode === "standard" || obj.mode === "smartFollow") &&
    validateSerialDeviceHint(obj.deviceHint)
  );
}

function validateStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function validateEnv(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((item) => typeof item === "string");
}

export function validateLocalShellProfile(item: unknown): item is LocalShellProfile {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const obj = item as Record<string, unknown>;
  if (!(isNonEmptyString(obj.id) && isNonEmptyString(obj.name))) {
    return false;
  }
  if (obj.launchMode === "vscodeProfile") {
    if (!isNonEmptyString(obj.vscodeProfileName)) {
      return false;
    }
  } else if (obj.launchMode === "custom") {
    if (!isNonEmptyString(obj.shellPath)) {
      return false;
    }
  } else {
    return false;
  }
  return (
    validateStringArray(obj.shellArgs) &&
    validateEnv(obj.env) &&
    isOptionalNonEmptyString(obj.group) &&
    isOptionalNonEmptyString(obj.cwd) &&
    isOptionalNonEmptyString(obj.startupCommand)
  );
}

export function validateAuthProfile(item: unknown): item is AuthProfile {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const obj = item as Record<string, unknown>;
  if (
    !(
      isNonEmptyString(obj.id) &&
      isNonEmptyString(obj.name) &&
      isNonEmptyString(obj.username) &&
      (obj.authType === "password" || obj.authType === "key" || obj.authType === "agent")
    )
  ) {
    return false;
  }
  // REVIEW FINDING (P2) — optional `keyPath` was the one declared field this
  // guard never looked at, so a hand-edited backup or a version-skewed
  // globalState row could carry a number/object/array here and still be handed
  // out typed as `AuthProfile`. Everything downstream then treats it as a
  // string: `authProfileOwnedCredentials` trims it (models/config.ts) and
  // `formatAuthProfileLabel` hands it to `path.posix.basename` via
  // `normalizeKeyPathForComparison` (utils/authProfileLabel.ts) for every
  // option of every Auth Profile select and every server tooltip in the tree.
  // A TypeError there is not a rejected record, it is a sidebar that fails to
  // render, so the shape is settled HERE, once, at the two boundaries a
  // foreign record can arrive through (`VscodeConfigRepository.getAuthProfiles`
  // and both import paths in configCommands.ts).
  //
  // A TYPE check, deliberately not `isOptionalNonEmptyString`:
  //
  //   * `""` is harmless and must stay accepted. It reads identically to
  //     absent everywhere that matters — THE ONE RULE owns no blank key path,
  //     and `formatAuthProfileLabel` skips a falsy one — so rejecting it would
  //     buy nothing while newly discarding a record that is merely untidy.
  //   * No version of Nexus has ever WRITTEN a non-string here
  //     (`authProfileEditorPanel.ts` stores `string | undefined`), so nothing
  //     a user legitimately holds can be rejected by this line. That matters
  //     because rejection is destructive in a way a shape check on a
  //     bookkeeping field is not: a rejected profile is skipped by the import
  //     (counted, but not named), its vault password/passphrase are not
  //     restored — `restoreSecrets` is scoped to the ids actually imported —
  //     and the post-import dangling-reference sweep then strips the link from
  //     every server and inventory source that pointed at it. In REPLACE mode
  //     the local copy is already gone by the time this runs. Rejecting only
  //     values no writer of ours can produce keeps that blast radius aimed
  //     exclusively at records that are already broken.
  //
  // The rule itself stays defensive too (see `authProfileOwnedCredentials`):
  // this boundary is what should stop such a value existing, not the only
  // thing standing between one and a thrown `.trim()`.
  if (obj.keyPath !== undefined && typeof obj.keyPath !== "string") {
    return false;
  }
  return true;
}
