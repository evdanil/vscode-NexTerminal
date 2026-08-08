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
  return isNonEmptyString(obj.sourceId) && isNonEmptyString(obj.externalId) && typeof obj.syncedAt === "number";
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
  return (
    isNonEmptyString(obj.id) &&
    isNonEmptyString(obj.name) &&
    isNonEmptyString(obj.username) &&
    (obj.authType === "password" || obj.authType === "key" || obj.authType === "agent")
  );
}
