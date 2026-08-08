import type { AuthProfile, ServerConfig, ServerOrigin, TunnelProfile, SerialProfile, ProxyConfig, LocalShellProfile } from "../models/config";
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
  // F13/FIX 5 — a malformed `origin` does not invalidate the whole server
  // row: the row is still accepted here. Stripping the malformed field is
  // NOT this function's job — a type guard must not mutate the value it is
  // asked to check (callers may reasonably assume `item` is unchanged after
  // a `boolean`-returning predicate). The actual strip-and-warn happens one
  // layer up, in VscodeConfigRepository.getServers(), which owns producing
  // the final, storage-clean ServerConfig list.
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
