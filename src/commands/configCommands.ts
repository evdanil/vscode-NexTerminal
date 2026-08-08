import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { AuthProfile, LocalShellProfile, ServerConfig, TunnelProfile, SerialProfile } from "../models/config";
import type { InventorySourceConfig } from "../models/inventory";
import { inventorySecretKey } from "../models/inventory";
import type { MacroVariable, TerminalMacro } from "../models/terminalMacro";
import { isValidVariableName, MAX_MACRO_VARIABLES, withRedactedVariables } from "../services/macroVariables";
import { sanitizeMacroFolderList, sanitizeMacroGroup } from "../services/macroFolders";
import type { SecretVault } from "../services/ssh/contracts";
import {
  passwordSecretKey,
  passphraseSecretKey,
  proxyPasswordSecretKey,
  authProfilePasswordSecretKey,
  authProfilePassphraseSecretKey
} from "../services/ssh/silentAuth";
import { validateAuthProfile } from "../utils/validation";
import { encrypt, decrypt, type EncryptedPayload } from "../utils/configCrypto";
import { parseMobaxtermSessions } from "../utils/mobaxtermParser";
import { parseInventoryList, type InventoryParseIssue, MAX_DATA_ROWS as INVENTORY_MAX_ROWS } from "../utils/inventoryParser";
import { normalizeOptionalFolderPath, INVALID_FOLDER_PATH_MESSAGE } from "../utils/folderPaths";
import { defaultSshDir } from "../services/ssh/deploySshKey";
import {
  parseSecureCrtDirectory,
  parseSecureCrtXmlExport,
  hasSecureCrtSessionsRoot,
  type ImportParseResult,
  type SecureCrtFileEntry
} from "../utils/securecrtParser";
import { sniffImportFormat, type SniffedFormat } from "../utils/importFormatSniffer";
import {
  validateServerConfig,
  validateTunnelProfile,
  validateSerialProfile,
  validateLocalShellProfile,
  validateInventorySource,
  isValidServerOrigin
} from "../utils/validation";
import { isValidBinding } from "../macroBindings";
import {
  VALID_MACRO_TRIGGER_SCOPES,
  canonicalMacroBinding,
  canonicalMacroSecret,
  canonicalMacroTriggerTerms,
  canonicalMacroVariableTerms,
  compiledTriggerCooldownSeconds,
  compiledTriggerIntervalSeconds
} from "../storage/macroStore";
import {
  getMacroFolders,
  getMacros,
  saveMacroFolders,
  saveMacros,
  replaceMacros,
  getActiveMacroStore
} from "../macroSettings";
import { validateSettingUpdate } from "../ui/settingsValidation";
import { SETTINGS_META } from "../ui/settingsMetadata";
import { recordNexusConfigWrite } from "../services/terminal/settingsWriteRegistry";
import { validateAndSanitizeHighlightRules } from "../utils/highlightRuleValidation";
import { validateRegexSafety } from "../utils/regexSafety";
import { MAX_SCRIPT_RUNTIME_MS } from "../services/scripts/maxRuntime";
import { MAX_SCRIPT_WAIT_TIMEOUT_MS, MAX_SCRIPT_WAIT_TIMEOUT_SECONDS } from "../services/scripts/defaultTimeout";
import { getConfiguredSettingValue } from "../utils/configurationInspection";
import { configMutationLock } from "../services/configMutationLock";

interface MacroEntry {
  name?: string;
  text?: string;
  secret?: boolean;
  keybinding?: string;
  triggerPattern?: string;
  triggerCooldown?: number;
  triggerInterval?: number;
  triggerInitiallyDisabled?: boolean;
  [key: string]: unknown;
}

interface NexusConfigExport {
  version: 1 | 2;
  exportType?: "backup" | "share";
  exportedAt: string;
  servers?: ServerConfig[];
  tunnels?: TunnelProfile[];
  serialProfiles?: SerialProfile[];
  localShellProfiles?: LocalShellProfile[];
  authProfiles?: AuthProfile[];
  /** Backup-only (§B6) — never present on a share export; secrets live under `encryptedSecrets.inventorySourceSecrets`. */
  inventorySources?: InventorySourceConfig[];
  groups?: string[];
  macros?: TerminalMacro[]; // Non-secret fields; secret macros carry `text: ""`
  /** Explicit macro folders (`nexus.macros.folders`, §4.1) — carried exactly as `groups` is. */
  macroFolders?: string[];
  settings?: Record<string, unknown>;
  encryptedSecrets?: EncryptedPayload;
}

interface BackupFileEntry {
  relativePath: string;
  contentsBase64: string;
}

interface BackupFolderPayload {
  id: "ssh" | "scripts";
  label: string;
  configuredPath?: string;
  directories: string[];
  files: BackupFileEntry[];
}

interface RestoreBackupFoldersResult {
  restoredFiles: number;
  skippedExistingFiles: number;
}

const DEFAULT_SCRIPTS_RELATIVE_PATH = ".nexus/scripts";

// Import-compat keys that are NOT contributed in settingsMetadata.ts but must still be
// read/written so old export files keep importing. Appended AFTER the SETTINGS_META-derived
// entries — `nexus.scripts.defaultTimeout` (legacy ms) intentionally comes after
// `nexus.scripts.defaultTimeoutSeconds` so the "modern value wins" guard in readSettings holds.
const EXTRA_IMPORT_KEYS: Array<{ section: string; key: string }> = [
  { section: "nexus.terminal.highlighting", key: "rules" },
  { section: "nexus.scripts", key: "defaultTimeout" },
  { section: "nexus.scripts", key: "maxRuntimeMs" }
];

// Derived from SETTINGS_META (single source of truth for contributed settings) plus the
// import-compat extras above, so adding a setting only requires editing settingsMetadata.ts.
// The SETTINGS_KEYS ⊇ SETTINGS_META invariant is asserted in configImportExport.test.ts.
export const SETTINGS_KEYS: Array<{ section: string; key: string }> = [
  ...SETTINGS_META.map((m) => ({ section: m.section, key: m.key })),
  ...EXTRA_IMPORT_KEYS
];

const SETTINGS_KEY_SET = new Set(SETTINGS_KEYS.map(({ section, key }) => `${section}.${key}`));
const SCRIPT_DEFAULT_TIMEOUT_SECONDS_KEY = "nexus.scripts.defaultTimeoutSeconds";
const LEGACY_SCRIPT_DEFAULT_TIMEOUT_MS_KEY = "nexus.scripts.defaultTimeout";

function legacyDefaultTimeoutMsToSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 100) {
    return undefined;
  }

  return Math.max(1, Math.min(MAX_SCRIPT_WAIT_TIMEOUT_SECONDS, value / 1000));
}

type SettingValidation = { ok: true; value: unknown } | { ok: false };

function validBoundedNumber(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

// Per-key validators applied before the generic validateSettingUpdate fallback in applySettings.
// Keeping them in a lookup map keeps the apply loop flat (no special-case if/else ladder).
const SPECIAL_SETTING_VALIDATORS: Record<string, (value: unknown) => SettingValidation> = {
  "nexus.terminal.highlighting.rules": (value) => {
    const rules = validateAndSanitizeHighlightRules(value);
    return rules ? { ok: true, value: rules } : { ok: false };
  },
  "nexus.scripts.maxRuntimeMs": (value) =>
    validBoundedNumber(value, 0, MAX_SCRIPT_RUNTIME_MS) ? { ok: true, value } : { ok: false },
  "nexus.scripts.defaultTimeout": (value) =>
    validBoundedNumber(value, 100, MAX_SCRIPT_WAIT_TIMEOUT_MS) ? { ok: true, value } : { ok: false }
};

function readSettings(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const { section, key } of SETTINGS_KEYS) {
    const config = vscode.workspace.getConfiguration(section);
    const value = getConfiguredSettingValue(config, key);
    if (value !== undefined) {
      const fullKey = `${section}.${key}`;
      if (fullKey === LEGACY_SCRIPT_DEFAULT_TIMEOUT_MS_KEY) {
        if (result[SCRIPT_DEFAULT_TIMEOUT_SECONDS_KEY] === undefined) {
          const seconds = legacyDefaultTimeoutMsToSeconds(value);
          if (seconds !== undefined) {
            result[SCRIPT_DEFAULT_TIMEOUT_SECONDS_KEY] = seconds;
          }
        }
      } else {
        result[fullKey] = value;
      }
    }
  }
  return result;
}


async function applySettings(settings: Record<string, unknown>): Promise<void> {
  const allowedSettings: Record<string, unknown> = {};
  let invalidCount = 0;
  let legacyDefaultTimeoutSeconds: number | undefined;
  for (const [fullKey, value] of Object.entries(settings)) {
    if (!SETTINGS_KEY_SET.has(fullKey)) {
      continue;
    }

    if (fullKey === LEGACY_SCRIPT_DEFAULT_TIMEOUT_MS_KEY) {
      const seconds = legacyDefaultTimeoutMsToSeconds(value);
      if (seconds === undefined) {
        invalidCount++;
      } else {
        legacyDefaultTimeoutSeconds = seconds;
      }
      continue;
    }

    allowedSettings[fullKey] = value;
  }
  if (legacyDefaultTimeoutSeconds !== undefined) {
    allowedSettings[SCRIPT_DEFAULT_TIMEOUT_SECONDS_KEY] = legacyDefaultTimeoutSeconds;
  }
  // nexus.terminal.macros (the array) is intentionally excluded from SETTINGS_KEYS
  // — macros now live in MacroStore, not settings. The allowedSettings filter above
  // will already exclude it, but delete explicitly in case any stale reference slips through.

  for (const [fullKey, value] of Object.entries(allowedSettings)) {
    const lastDot = fullKey.lastIndexOf(".");
    if (lastDot < 0) {
      continue;
    }
    const section = fullKey.substring(0, lastDot);
    const key = fullKey.substring(lastDot + 1);

    const special = SPECIAL_SETTING_VALIDATORS[fullKey];
    const validation = special
      ? special(value)
      : validateSettingUpdate(section, key, value);
    if (!validation.ok) {
      invalidCount++;
      continue;
    }

    const config = vscode.workspace.getConfiguration(section);
    recordNexusConfigWrite(fullKey, validation.value, Date.now());
    await config.update(key, validation.value, vscode.ConfigurationTarget.Global);
  }
  if (invalidCount > 0) {
    void vscode.window.showWarningMessage(
      invalidCount === 1
        ? "1 imported Nexus setting had an invalid value and was skipped."
        : `${invalidCount} imported Nexus settings had invalid values and were skipped.`
    );
  }
}

function isFile(type: vscode.FileType): boolean {
  return (type & vscode.FileType.File) === vscode.FileType.File;
}

function isDirectory(type: vscode.FileType): boolean {
  return (type & vscode.FileType.Directory) === vscode.FileType.Directory;
}

function isSymlink(type: vscode.FileType): boolean {
  return (type & vscode.FileType.SymbolicLink) === vscode.FileType.SymbolicLink;
}

async function safeStat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat && typeof stat.type === "number" ? stat : undefined;
  } catch {
    return undefined;
  }
}

async function collectFolderBackup(
  id: BackupFolderPayload["id"],
  label: string,
  root: vscode.Uri,
  configuredPath?: string
): Promise<BackupFolderPayload | undefined> {
  const rootStat = await safeStat(root);
  if (!rootStat || !isDirectory(rootStat.type) || isSymlink(rootStat.type)) {
    return undefined;
  }

  const payload: BackupFolderPayload = { id, label, configuredPath, directories: [], files: [] };

  async function walk(dir: vscode.Uri, relativeDir: string): Promise<void> {
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }

    for (const [name, type] of entries) {
      if (isSymlink(type)) continue;
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      const child = vscode.Uri.joinPath(dir, name);

      if (isDirectory(type)) {
        payload.directories.push(relativePath);
        await walk(child, relativePath);
      } else if (isFile(type)) {
        try {
          const bytes = await vscode.workspace.fs.readFile(child);
          payload.files.push({
            relativePath,
            contentsBase64: Buffer.from(bytes).toString("base64")
          });
        } catch {
          // Files can disappear while the backup is being collected.
        }
      }
    }
  }

  await walk(root, "");
  return payload;
}

function readScriptsPathSetting(): string {
  const configured = vscode.workspace
    .getConfiguration("nexus.scripts")
    .get<string>("path", DEFAULT_SCRIPTS_RELATIVE_PATH);
  return typeof configured === "string" && configured.trim() ? configured : DEFAULT_SCRIPTS_RELATIVE_PATH;
}

function resolveScriptsDirFromConfiguredPath(globalStoragePath: string, configuredPath: string): vscode.Uri {
  if (path.isAbsolute(configuredPath)) {
    return vscode.Uri.file(configuredPath);
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (root) {
    return vscode.Uri.joinPath(root, configuredPath);
  }

  return vscode.Uri.file(path.join(globalStoragePath, "scripts"));
}

async function collectBackupFolders(context?: vscode.ExtensionContext): Promise<BackupFolderPayload[]> {
  const folders: BackupFolderPayload[] = [];
  const sshBackup = await collectFolderBackup("ssh", "SSH user folder", vscode.Uri.file(defaultSshDir()));
  if (sshBackup) folders.push(sshBackup);

  const globalStoragePath = context?.globalStorageUri.fsPath;
  if (globalStoragePath) {
    const configuredPath = readScriptsPathSetting();
    const scriptsBackup = await collectFolderBackup(
      "scripts",
      "Nexus scripts folder",
      resolveScriptsDirFromConfiguredPath(globalStoragePath, configuredPath),
      configuredPath
    );
    if (scriptsBackup) folders.push(scriptsBackup);
  }

  return folders;
}

function safeRelativeSegments(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) return undefined;
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return undefined;

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  if (segments.some((segment) => segment === "." || segment === "..")) return undefined;
  return segments;
}

function backupRootFor(
  id: unknown,
  context?: vscode.ExtensionContext,
  configuredPath?: unknown
): vscode.Uri | undefined {
  if (id === "ssh") return vscode.Uri.file(defaultSshDir());
  if (id === "scripts" && context?.globalStorageUri.fsPath) {
    const pathSetting = typeof configuredPath === "string" && configuredPath.trim()
      ? configuredPath
      : DEFAULT_SCRIPTS_RELATIVE_PATH;
    return resolveScriptsDirFromConfiguredPath(context.globalStorageUri.fsPath, pathSetting);
  }
  return undefined;
}

async function chmodFileUri(uri: vscode.Uri, mode: number): Promise<void> {
  if (uri.scheme !== "file") return;
  try {
    await chmod(uri.fsPath, mode);
  } catch {
    // Not all platforms or filesystem providers support POSIX modes.
  }
}

async function ensureParentDirectory(root: vscode.Uri, segments: string[]): Promise<void> {
  if (segments.length <= 1) {
    await vscode.workspace.fs.createDirectory(root);
    return;
  }
  const parent = vscode.Uri.joinPath(root, ...segments.slice(0, -1));
  await vscode.workspace.fs.createDirectory(parent);
}

async function restoreBackupFolders(
  decryptedSecrets: Record<string, unknown> | undefined,
  mode: "merge" | "replace",
  context?: vscode.ExtensionContext
): Promise<RestoreBackupFoldersResult> {
  const result: RestoreBackupFoldersResult = { restoredFiles: 0, skippedExistingFiles: 0 };
  const fileBackups = decryptedSecrets?.fileBackups;
  if (!Array.isArray(fileBackups)) return result;

  for (const backup of fileBackups) {
    if (typeof backup !== "object" || backup === null) continue;
    const obj = backup as Partial<BackupFolderPayload>;
    const root = backupRootFor(obj.id, context, obj.configuredPath);
    if (!root) continue;
    const isSshBackup = obj.id === "ssh";

    try {
      await vscode.workspace.fs.createDirectory(root);
      if (isSshBackup) await chmodFileUri(root, 0o700);
    } catch {
      continue;
    }

    const directories = Array.isArray(obj.directories) ? obj.directories : [];
    for (const relativePath of directories) {
      const segments = safeRelativeSegments(relativePath);
      if (!segments) continue;
      try {
        const directory = vscode.Uri.joinPath(root, ...segments);
        await vscode.workspace.fs.createDirectory(directory);
        if (isSshBackup) await chmodFileUri(directory, 0o700);
      } catch {
        // Keep restoring other entries.
      }
    }

    const files = Array.isArray(obj.files) ? obj.files : [];
    for (const file of files) {
      if (typeof file !== "object" || file === null) continue;
      const entry = file as Partial<BackupFileEntry>;
      const segments = safeRelativeSegments(entry.relativePath);
      if (!segments || typeof entry.contentsBase64 !== "string") continue;
      const target = vscode.Uri.joinPath(root, ...segments);
      if (mode === "merge" && await safeStat(target)) {
        result.skippedExistingFiles++;
        continue;
      }
      try {
        await ensureParentDirectory(root, segments);
        if (isSshBackup && segments.length > 1) {
          await chmodFileUri(vscode.Uri.joinPath(root, ...segments.slice(0, -1)), 0o700);
        }
        await vscode.workspace.fs.writeFile(target, Buffer.from(entry.contentsBase64, "base64"));
        if (isSshBackup) await chmodFileUri(target, 0o600);
        result.restoredFiles++;
      } catch {
        // A single unreadable target should not block the rest of the import.
      }
    }
  }

  return result;
}

export function isValidExport(data: unknown): data is NexusConfigExport {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  const profileArrayKeys = ["servers", "tunnels", "serialProfiles", "localShellProfiles", "authProfiles", "macros"] as const;
  for (const key of profileArrayKeys) {
    const value = obj[key];
    if (value !== undefined && !Array.isArray(value)) {
      return false;
    }
  }
  if (obj.groups !== undefined && !Array.isArray(obj.groups)) {
    return false;
  }
  if (obj.macroFolders !== undefined && !Array.isArray(obj.macroFolders)) {
    return false;
  }
  if (obj.inventorySources !== undefined && !Array.isArray(obj.inventorySources)) {
    return false;
  }
  if (
    obj.settings !== undefined &&
    (typeof obj.settings !== "object" || obj.settings === null || Array.isArray(obj.settings))
  ) {
    return false;
  }
  const hasProfileArrays = profileArrayKeys.some((key) => Array.isArray(obj[key]));
  return (obj.version === 1 || obj.version === 2) && hasProfileArrays;
}

function ensureId(item: Record<string, unknown>): void {
  if (!item.id || typeof item.id !== "string" || (item.id as string).trim() === "") {
    item.id = randomUUID();
  }
}

interface ImportTally {
  imported: number;
  skipped: number;
  /** ids that were actually added this run (i.e. not skipped as already-existing/invalid).
   *  Callers that need to know which ids were freshly imported — e.g. to scope a secret
   *  restore so a merge-mode skip of a retained local record isn't undone by an
   *  unconditional secret write — read this instead of re-deriving it from `existingIds`. */
  importedIds: string[];
}

/**
 * id-preserving merge/replace import: validate each entity and add it unless its id already
 * exists (`existingIds`). Used by the backup/legacy import path where ids are kept as-is.
 */
async function importPreservingIds<T extends { id: string }>(
  items: T[] | undefined,
  existingIds: Set<string>,
  validate: (entity: T) => boolean,
  add: (entity: T) => Promise<void>
): Promise<ImportTally> {
  const tally: ImportTally = { imported: 0, skipped: 0, importedIds: [] };
  for (const item of items ?? []) {
    ensureId(item as unknown as Record<string, unknown>);
    if (existingIds.has(item.id) || !validate(item)) {
      tally.skipped++;
    } else {
      await add(item);
      tally.imported++;
      tally.importedIds.push(item.id);
    }
  }
  return tally;
}

/**
 * N2 — sanitize a malformed `origin` at the import boundary, shared by both
 * server-import paths (share-import and backup merge/replace). Neither path
 * flows through VscodeConfigRepository.getServers() (that strip only applies
 * on the next read), so a file-supplied server with a malformed origin (e.g.
 * a numeric externalId from a hand-edited or version-skewed backup) would
 * otherwise reach core.addOrUpdateServer as-is and can mis-key the sync
 * engine's owned-index until the next reload.
 */
async function addServerSanitizingOrigin(server: ServerConfig, add: (entity: ServerConfig) => Promise<void>): Promise<void> {
  if (server.origin !== undefined && !isValidServerOrigin(server.origin)) {
    console.warn("[Nexus] Imported server has a malformed origin; stripping it:", JSON.stringify(server.origin));
    const { origin: _origin, ...rest } = server;
    await add(rest as ServerConfig);
    return;
  }
  await add(server);
}

/**
 * REVIEW FINDING 2 (P2, imported managedFolders are untrusted) — strip
 * `managedFolders` from every backup-imported inventory source BEFORE the
 * array is handed to `validateInventorySource`/`importPreservingIds`.
 * `managedFolders` is GC-ownership bookkeeping this extension itself writes
 * (see `applyInventorySyncPlan` in nexusCore.ts) — it is never something a
 * user or provider is meant to author. `validateInventorySource` only checks
 * its SHAPE (an array of strings), by design: that check also guards the
 * extension's OWN persisted state on ordinary storage-layer loads
 * (VscodeConfigRepository), where the field genuinely is trusted, so it must
 * stay permissive there. A backup file is a different trust boundary — it can
 * be hand-edited, come from another machine's differently-shaped folder tree,
 * or simply be stale — so a `managedFolders` array copied verbatim from one
 * would hand this source GC authority over folder paths (e.g.
 * "Manual/Staging") it never actually created on THIS machine. The next sync
 * would then delete a folder the source never owns, because
 * `applyInventorySyncPlan` trusts `managedFolders` completely once it's on
 * the record.
 *
 * ROUND (validate-before-strip) FINDING — this must run BEFORE
 * `validateInventorySource`, not after (the strip used to live in
 * `importPreservingIds`'s `add` callback, which only runs once validation has
 * already passed). `managedFolders` is untrusted precisely because a backup
 * can carry it malformed (`null`, a mixed-type array, …) as well as
 * well-shaped-but-wrong — and a malformed value fails
 * `validateInventorySource`'s shape check, which rejects the ENTIRE source,
 * not just the untrusted field. In replace mode the prior source and its
 * vault secrets are already cleared by the time import runs (see the
 * replace-mode wipe in `importMergeReplaceLocked`), so a validate-before-strip
 * rejection permanently drops an otherwise-good source and its secrets are
 * never restored (its id never lands in `importedIds`, so the secret-restore
 * loop skips it too). Deleting the property unconditionally here — before
 * validation ever sees it — means the shape check downstream only ever
 * observes `managedFolders` in a shape it doesn't need to reject on.
 *
 * Stripping it (rather than trying to repair it) is the safe direction: an
 * imported source simply starts with no bookkept ownership, exactly like a
 * legacy/never-synced record. Its very next sync re-accumulates
 * `managedFolders` normally from the folders THAT sync actually creates (see
 * `createdThisApply` in `applyInventorySyncPlan`) — any folder that already
 * existed before the import (including ones the ORIGINAL machine's source
 * once owned) simply stops being a GC candidate rather than becoming a
 * wrongly-trusted one; it is never deleted on the strength of imported
 * metadata alone.
 *
 * Mutates each element in place (deleting the property outright, regardless
 * of its type) and returns the same array reference: callers downstream of
 * this (the secret-restore loop's `importedSourceById` lookup keyed off
 * `data.inventorySources`) only ever read `id`/`secretFieldIds`, which this
 * never touches.
 */
function sanitizeImportedInventorySources(sources: InventorySourceConfig[] | undefined): InventorySourceConfig[] | undefined {
  if (!sources) {
    return sources;
  }
  for (const source of sources) {
    delete (source as unknown as Record<string, unknown>).managedFolders;
  }
  return sources;
}

/** Mechanical validate-then-add tail shared by the share-import remap loops; remap stays inline. */
async function addIfValid<T>(
  entity: T,
  validate: (entity: T) => boolean,
  add: (entity: T) => Promise<void>
): Promise<boolean> {
  if (validate(entity)) {
    await add(entity);
    return true;
  }
  return false;
}

/**
 * Restore one secret bucket (id → secret) into the vault under `keyFn(id)`.
 *
 * `importedIds` scopes the restore to records this run actually imported — the same
 * `importPreservingIds().importedIds` mechanism the inventory-source secret restore uses (see
 * FINDING 3 at the inventorySourceSecrets loop below). Applied in BOTH modes, not merge-only:
 * merge mode skips an id already present locally (the local record — and its working
 * credential — wins, so the backup's copy must never overwrite it), and replace mode skips an
 * id that fails validation (nothing was persisted for it, so a secret written for it would be
 * an undiscoverable dead vault key — export/removal/reset all enumerate persisted records, not
 * the backup payload — exactly the residue class FINDING 3 calls out). In replace mode every
 * *valid* record IS imported (existingIds is empty there), so scoping to importedIds still
 * restores every secret whose owning record survived import; it only additionally excludes the
 * secrets of records replace mode itself declined to import.
 */
async function restoreSecrets(
  record: Record<string, string> | undefined,
  keyFn: (id: string) => string,
  vault: SecretVault,
  importedIds: Set<string>
): Promise<void> {
  if (!record) return;
  for (const [id, secret] of Object.entries(record)) {
    if (!importedIds.has(id)) continue;
    await vault.store(keyFn(id), secret);
  }
}

interface SanitizedSnapshot {
  servers: ServerConfig[];
  tunnels: TunnelProfile[];
  serialProfiles: SerialProfile[];
  localShellProfiles: LocalShellProfile[];
  authProfiles: AuthProfile[];
  macros: TerminalMacro[];
  settings: Record<string, unknown>;
}

function remapProxy(proxy: import("../models/config").ProxyConfig | undefined, idMap: Map<string, string>): import("../models/config").ProxyConfig | undefined {
  if (!proxy) return undefined;
  if (proxy.type === "ssh") {
    const newJumpHostId = idMap.get(proxy.jumpHostId);
    if (!newJumpHostId) return undefined; // Jump host not in export
    return { ...proxy, jumpHostId: newJumpHostId };
  }
  if (proxy.type === "socks5") {
    return { type: "socks5", host: proxy.host, port: proxy.port };
  }
  if (proxy.type === "http") {
    return { type: "http", host: proxy.host, port: proxy.port };
  }
  return undefined;
}

export function sanitizeForSharing(
  servers: ServerConfig[],
  tunnels: TunnelProfile[],
  serialProfiles: SerialProfile[],
  localShellProfiles: LocalShellProfile[],
  settings: Record<string, unknown> = {},
  authProfiles: AuthProfile[] = [],
  macros: TerminalMacro[] = []
): SanitizedSnapshot {
  const idMap = new Map<string, string>();

  // First pass: assign new IDs for auth profiles
  for (const p of authProfiles) {
    idMap.set(p.id, randomUUID());
  }

  // Second pass: assign new IDs for servers
  for (const s of servers) {
    idMap.set(s.id, randomUUID());
  }

  // Build sanitized auth profiles (redact credentials, keep name)
  const referencedProfileIds = new Set(servers.map((s) => s.authProfileId).filter(Boolean) as string[]);
  const newAuthProfiles = authProfiles
    .filter((p) => referencedProfileIds.has(p.id))
    .map((p) => ({
      ...p,
      id: idMap.get(p.id)!,
      username: "user",
      keyPath: undefined
    }));

  const newServers = servers.map((s) => {
    const newId = idMap.get(s.id)!;
    const newAuthProfileId = s.authProfileId ? idMap.get(s.authProfileId) : undefined;
    // §B6 — a share export travels to another person/machine; a synced-server marker
    // (sourceId/externalId) names an inventory source that only exists locally and
    // would be meaningless (and misleading) on the receiving end.
    return { ...s, id: newId, username: "user", keyPath: "", proxy: remapProxy(s.proxy, idMap), authProfileId: newAuthProfileId, origin: undefined };
  });

  const newTunnels = tunnels.map((t) => {
    const newId = randomUUID();
    idMap.set(t.id, newId);
    const remapped = { ...t, id: newId };
    if (remapped.defaultServerId) {
      remapped.defaultServerId = idMap.get(remapped.defaultServerId) ?? undefined;
    }
    return remapped;
  });

  const newSerialProfiles = serialProfiles.map((p) => {
    const newId = randomUUID();
    idMap.set(p.id, newId);
    return { ...p, id: newId, deviceHint: undefined };
  });

  const newLocalShellProfiles = localShellProfiles.map((p) => {
    const newId = randomUUID();
    idMap.set(p.id, newId);
    return {
      ...p,
      id: newId,
      cwd: undefined,
      startupCommand: undefined
    };
  });

  const sanitizedMacros = macros
    .filter((m) => !m.secret)
    // fresh ids for share exports; variable declarations normalized so a masked
    // variable's plaintext `default` never leaves this machine in a share file.
    .map((m) => withRedactedVariables({ ...m, id: randomUUID() }));

  // Sanitize paths from the settings snapshot.
  const sanitizedSettings = { ...settings };
  if (sanitizedSettings["nexus.logging.sessionLogDirectory"]) {
    sanitizedSettings["nexus.logging.sessionLogDirectory"] = "";
  }

  return {
    servers: newServers,
    tunnels: newTunnels,
    serialProfiles: newSerialProfiles,
    localShellProfiles: newLocalShellProfiles,
    authProfiles: newAuthProfiles,
    macros: sanitizedMacros,
    settings: sanitizedSettings
  };
}

async function promptMasterPassword(): Promise<string | undefined> {
  const password = await vscode.window.showInputBox({
    title: "Backup Master Password",
    prompt: "Enter a master password to encrypt profiles, settings, saved credentials, ~/.ssh, and Nexus scripts",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.length < 8 ? "Password must be at least 8 characters" : undefined
  });
  if (!password) return undefined;

  const confirm = await vscode.window.showInputBox({
    title: "Confirm Master Password",
    prompt: "Re-enter the master password to confirm",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value !== password ? "Passwords do not match" : undefined
  });
  if (!confirm) return undefined;
  return password;
}

async function promptDecryptPassword(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: "Backup Master Password",
    prompt: "Enter the master password to decrypt this backup",
    password: true,
    ignoreFocusOut: true
  });
}

/**
 * Content key for "do I already have this macro?" — used by share import and by merge-mode
 * backup import (the latter because replace-mode restore re-keys every incoming record, so an
 * id in a file stops naming anything local the moment a replace has run; see the merge branch).
 *
 * IT MUST NAME EVERY FIELD THAT MAKES TWO RECORDS DIFFERENT MACROS, because a collision here
 * is not a merge — it is a silent DROP. The merge branch skips an incoming record whose key it
 * already has, so any field left out of this key is a field two legitimately distinct macros
 * can differ in while one of them is discarded with no report. An earlier revision keyed on
 * name/secret/text/triggerPattern/keybinding plus variable NAMES only, so two records agreeing
 * on those but scoped `active-session` versus `profile` — or differing in cooldown, interval,
 * start-paused, target profile, or any variable's label/default/secret/remember — collided and
 * the second was thrown away before `assignMacroIds()` could ever re-key it.
 *
 * `secret` is part of the key even though the share path filters secrets out before it gets
 * here, so the term is inert for that caller. It matters for merge, which does carry secret
 * macros: without it a secret macro whose decrypted text happens to equal a plain macro's, with
 * the same name and trigger, is taken for the same macro and silently not imported.
 *
 * `id` is deliberately NOT part of the key. Identity is the merge branch's separate id skip;
 * this key answers the different question of whether the CONTENT is already present, which is
 * what makes importing the same file twice idempotent after a replace-mode restore has re-keyed
 * everything in it. See the merge branch for why both are load-bearing.
 *
 * BEING TOO SPECIFIC IS ALSO A BUG, and the opposite one. Every term therefore names what the
 * RUNTIME can observe, not the field as it happens to be spelled on disk — see
 * `canonicalMacroTriggerTerms()` and friends (storage/macroStore.ts) for the collapses and the
 * runtime lines each one mirrors. Two records this key separates are added as two macros, each
 * with a live auto-trigger, so a spelling difference that the trigger compiler cannot see
 * (`triggerScope: "all-terminals"` as the macro editor writes it versus the absent scope
 * `sanitizeImportedMacro()` leaves alone) means a `Password:` responder answering one prompt
 * twice. That regression shipped on this branch and this is where it is closed.
 *
 * Built with `JSON.stringify` rather than a `|` join so that a value containing the delimiter
 * cannot forge a different record's key — with a join, a macro named `a|b` and text `c` keys
 * the same as one named `a` with text `b|c`.
 *
 * §7 — `group` is DELIBERATELY excluded, and exported so a unit test can pin that: two macros
 * identical except for their sidebar folder are still "the same macro" for import and dedup
 * purposes, exactly as `keyOfLegacy()` in `vscodeMacroStore.ts` also excludes it. A folder is a
 * display projection, not a property the trigger compiler or the prompt path can observe, so
 * naming it here would fail the "what the RUNTIME can see" rule above in the duplicate
 * direction.
 */
export function keyOf(m: TerminalMacro): string {
  return JSON.stringify([
    m.name ?? "",
    canonicalMacroSecret(m),
    m.text ?? "",
    ...canonicalMacroTriggerTerms(m),
    canonicalMacroBinding(m),
    canonicalMacroVariableTerms(m)
  ]);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function stripMacroTrigger(macro: TerminalMacro): void {
  delete macro.triggerPattern;
  delete macro.triggerCooldown;
  delete macro.triggerInterval;
  delete macro.triggerInitiallyDisabled;
  delete macro.triggerScope;
  delete macro.triggerProfileId;
}

function isSafeMacroTriggerPattern(pattern: string): boolean {
  const safety = validateRegexSafety(pattern);
  if (!safety.ok) return false;
  try {
    const regex = new RegExp(pattern);
    return !regex.test("");
  } catch {
    return false;
  }
}

/**
 * §10 — sanitizes an imported macro's `variables`: drops a non-array shape, drops
 * entries failing the name pattern, drops duplicate names, caps at 10, and strips
 * `default` / `remember` from secret variables (a default would be plaintext in
 * the store; `remember` is meaningless — secret values are never remembered).
 * Mutates `macro` in place; leaves `macro.variables` undefined when nothing survives.
 *
 * Returns whether the macro carried ANY declaration before sanitization. The caller
 * needs that, not the post-sanitization array: a macro whose declarations were all
 * invalid ends up with no `variables` at all, and deciding the §6.2 trigger strip on
 * the surviving array would then leave the trigger live on a macro that the store and
 * the compiler both treat as suppressed. For a hand-crafted
 * `{secret: true, text: "hunter2\n", triggerPattern: "[Pp]assword:",
 * variables: [{name: "2bad"}]}` that means importing it turns the secret text into an
 * auto-send. A malformed non-array counts as a declaration too — it can never suppress
 * at runtime, so stripping the trigger is the fail-safe direction.
 */
function sanitizeImportedMacroVariables(macro: TerminalMacro): boolean {
  const hadDeclaration =
    macro.variables !== undefined &&
    (!Array.isArray(macro.variables) || macro.variables.length > 0);

  if (!Array.isArray(macro.variables)) {
    delete macro.variables;
    return hadDeclaration;
  }

  const seenNames = new Set<string>();
  const sanitized: MacroVariable[] = [];
  for (const raw of macro.variables as unknown[]) {
    if (sanitized.length >= MAX_MACRO_VARIABLES) break;
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (!isValidVariableName(entry.name)) continue;
    const name = entry.name;
    if (seenNames.has(name)) continue;
    seenNames.add(name);

    const clean: MacroVariable = { name };
    if (typeof entry.label === "string" && entry.label.trim() !== "") {
      clean.label = entry.label;
    }
    if (entry.secret === true) {
      clean.secret = true;
      // `default` and `remember` deliberately stripped for secret variables (§7.1/§9.4).
    } else {
      if (typeof entry.default === "string") {
        clean.default = entry.default;
      }
      if (entry.remember === false) {
        clean.remember = false;
      }
    }
    sanitized.push(clean);
  }

  if (sanitized.length > 0) {
    macro.variables = sanitized;
  } else {
    delete macro.variables;
  }
  return hadDeclaration;
}

function sanitizeImportedMacro(raw: TerminalMacro): TerminalMacro {
  const macro: TerminalMacro = { ...raw };
  // A non-string keybinding is dropped for the same reason a malformed string one is: it is
  // not a binding. `normalizeBinding()` already refuses to resolve it, so this changes nothing
  // the app applies — it keeps an unusable value out of globalState, where it would sit in a
  // field the editor renders as empty and no consumer can act on.
  if (macro.keybinding !== undefined && (typeof macro.keybinding !== "string" || !isValidBinding(macro.keybinding))) {
    delete macro.keybinding;
  }

  // §4.2 — `group` is untrusted on import too: normalize-or-drop, same rule
  // as every other ingest path (VscodeMacroStore's `persistLegacyMigration`/
  // `reloadFromState`). "" canonicalizes to `undefined` alongside anything
  // structurally invalid (non-string, `..`, `.`, `\`, over-depth).
  const normalizedGroup = sanitizeMacroGroup(macro.group);
  if (normalizedGroup) {
    macro.group = normalizedGroup;
  } else {
    delete macro.group;
  }

  // Runs unconditionally — independent of whatever the trigger-sanitization
  // branches below decide — so a macro with no trigger at all (the common case)
  // still gets its variables sanitized.
  const declaredVariables = sanitizeImportedMacroVariables(macro);

  const triggerPattern = typeof macro.triggerPattern === "string" ? macro.triggerPattern.trim() : "";
  if (!triggerPattern || !isSafeMacroTriggerPattern(triggerPattern)) {
    stripMacroTrigger(macro);
  } else {
    macro.triggerPattern = triggerPattern;

    if (macro.triggerScope !== undefined && !VALID_MACRO_TRIGGER_SCOPES.has(macro.triggerScope)) {
      stripMacroTrigger(macro);
    } else {
      if (macro.triggerScope === "profile") {
        const profileId = typeof macro.triggerProfileId === "string" ? macro.triggerProfileId.trim() : "";
        if (!profileId) {
          stripMacroTrigger(macro);
        } else {
          macro.triggerProfileId = profileId;
        }
      } else {
        delete macro.triggerProfileId;
      }
    }
  }

  if (macro.triggerPattern !== undefined) {
    // NORMALIZE ONTO THE RUNTIME MEANING — never delete a value the compiler would have honoured.
    //
    // Deleting is not a neutral rejection. `MacroAutoTrigger.reload()` reads an absent cooldown as
    // "follow the `defaultCooldown` SETTING" and any present one as a pinned value, so dropping a
    // `triggerCooldown: 5000` did not remove a bad number, it changed a macro pinned at 300s (the
    // clamp's ceiling) into one that tracks a machine-local setting. The record it was exported
    // from still keys as 300s, so the two stopped matching and the import added a SECOND copy —
    // with its own id, its own live `Password:` rule and, for a responder macro, a second password
    // per prompt. The same held for a quoted `"5"` (the compiler pins the shipped default for it)
    // and, in the opposite direction, for the old 1..86400 interval window: `reload()` asks only
    // for `> 0`, so a legacy `0.5` runs a live 500 ms rule that this path used to erase.
    //
    // `compiledTrigger*Seconds()` (storage/macroStore.ts) is the same pair of functions `reload()`
    // compiles with and both content keys are built on, so what lands here is by construction the
    // macro the file described — clamped where the runtime clamps, preserved where it does not.
    const cooldownSeconds = compiledTriggerCooldownSeconds(macro.triggerCooldown);
    if (cooldownSeconds === undefined) delete macro.triggerCooldown;
    else macro.triggerCooldown = cooldownSeconds;

    const intervalSeconds = compiledTriggerIntervalSeconds(macro.triggerInterval);
    if (intervalSeconds === undefined) delete macro.triggerInterval;
    else macro.triggerInterval = intervalSeconds;

    // `reload()` tests this for TRUTHINESS (`if (macro.triggerInitiallyDisabled)`), so a
    // hand-edited `"yes"` means "start paused" and deleting it silently started the imported copy
    // live — one paused macro and one live one where the store held a single paused record.
    if (typeof macro.triggerInitiallyDisabled !== "boolean") {
      if (macro.triggerInitiallyDisabled) macro.triggerInitiallyDisabled = true;
      else delete macro.triggerInitiallyDisabled;
    }
  }

  // §6.2 — variables and auto-trigger are mutually exclusive. If both survive
  // independent sanitization, keep the variables and strip the trigger fields
  // (consistent with the existing precedent here of stripping trigger config
  // rather than dropping the macro).
  // Keyed on the PRE-sanitization declaration, not the surviving array — see
  // sanitizeImportedMacroVariables' doc comment for why the difference matters.
  if (declaredVariables && macro.triggerPattern !== undefined) {
    stripMacroTrigger(macro);
  }

  return macro;
}

/**
 * Extract macros from an import payload, supporting both the new (top-level `macros`)
 * and legacy (settings + name-matched secret blob) formats. Secret text is resolved from
 * `encryptedSecrets.secretMacros` when present.
 */
export function collectIncomingMacros(
  data: NexusConfigExport,
  decryptedSecrets?: Record<string, unknown>
): { macros: TerminalMacro[]; unresolvedCount: number } | undefined {
  // New format (version 2): top-level `macros` + id-keyed secret blobs
  if (Array.isArray(data.macros)) {
    const secretBlobs = (decryptedSecrets?.secretMacros as Array<{ id?: string; name?: string; text?: string }> | undefined) ?? [];
    const byId = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const blob of secretBlobs) {
      if (blob.id && typeof blob.text === "string") byId.set(blob.id, blob.text);
      if (blob.name && typeof blob.text === "string") byName.set(blob.name, blob.text);
    }
    let unresolvedCount = 0;
    const macros = data.macros.map<TerminalMacro>((m) => {
      if (m.secret) {
        const plain = (m.id && byId.get(m.id)) ?? (m.name && byName.get(m.name)) ?? "";
        if (!plain) unresolvedCount++;
        return sanitizeImportedMacro({ ...m, text: plain });
      }
      return sanitizeImportedMacro({ ...m });
    });
    return { macros, unresolvedCount };
  }

  // Legacy format (version 1): macros under `settings.nexus.terminal.macros`;
  // secret text carried separately by name.
  const legacy = (data.settings?.["nexus.terminal.macros"] as TerminalMacro[] | undefined);
  if (Array.isArray(legacy)) {
    const secretBlobs = (decryptedSecrets?.secretMacros as Array<{ name?: string; text?: string; secret?: boolean }> | undefined) ?? [];
    const byName = new Map<string, string>();
    for (const blob of secretBlobs) {
      if (blob.name && typeof blob.text === "string") byName.set(blob.name, blob.text);
    }
    let unresolvedCount = 0;
    const macros = legacy.map<TerminalMacro>((m) => {
      if (m.secret) {
        const plain = byName.get(m.name ?? "") ?? m.text ?? "";
        if (plain === "") unresolvedCount++;
        return sanitizeImportedMacro({ ...m, text: plain });
      }
      return sanitizeImportedMacro({ ...m });
    });
    return { macros, unresolvedCount };
  }

  return undefined;
}

/** Pluralizes a noun for count-driven messages ("1 server" / "2 servers") without the "(s)" shorthand. */
function pluralizeNoun(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

/**
 * Most frequently used username among existing servers, or "" if there are none.
 * F20 — exported (not duplicated) so inventoryCommands.ts's addSource default-username
 * prefill shares this exact logic with the CSV/host-list importer's own prefill.
 */
export function mostCommonUsername(servers: ServerConfig[]): string {
  const counts = new Map<string, number>();
  for (const server of servers) {
    if (!server.username) continue;
    counts.set(server.username, (counts.get(server.username) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [username, count] of counts) {
    if (count > bestCount) {
      best = username;
      bestCount = count;
    }
  }
  return best;
}

/**
 * FINDING 1 (backup-export review, round 16) — captures EVERY vault-backed
 * bucket exportBackup reads (servers + their password/passphrase/proxy-
 * password secrets, auth profiles + their password/passphrase secrets,
 * inventory sources + their secrets) as one consistent generation, under a
 * SINGLE configMutationLock.runExclusive span. Originally only the
 * inventory-source bucket was locked here (round 15) while the server and
 * auth-profile record + secret reads ran directly in exportBackup with NO
 * lock held at all — an inventory sync with prune "delete" (whose mutation
 * phase, including its post-apply server-credential vault.delete calls,
 * holds this same configMutationLock) could commit in the gap between
 * exportBackup's unlocked `snapshot.servers` read and its unlocked
 * `vault.get(passwordSecretKey(...))` calls, pairing a pre-sync server
 * record (one the sync was about to delete) with a post-sync vault read
 * that already came back empty — a torn backup entry: a server with no
 * password. Taking ONE fresh snapshot AND reading every secret for every
 * bucket inside the SAME lock span closes that for all three buckets at
 * once: nothing else that mutates servers, auth profiles, or inventory
 * sources/secrets (addSource/editSource/removeSource/syncNow, replace-mode
 * import, complete reset) can run while this capture is in flight, so the
 * records and the secrets read here always describe the same generation.
 * Exported (not nested in registerConfigCommands) so it can be
 * unit-tested directly for lock acquisition + consistency without having
 * to drive the full exportBackup command (file dialog, encryption prompt)
 * through the test harness.
 *
 * Deliberately still narrow in one direction: tunnels, serial profiles,
 * local shell profiles, and explicit groups are NOT captured here — none of
 * them are vault-backed (exportBackup reads those straight off
 * `core.getSnapshot()`), so there is nothing for this lock to protect there.
 * Macro secrets (`getMacros()`) are also outside — they live in the macro
 * store, not this SecretVault. The save dialog and the master-password
 * prompt stay outside too — none of that is UI-free, and the lock's own
 * contract forbids holding it across interactive UI.
 */
export async function captureBackupStateForExport(
  core: NexusCore,
  vault: SecretVault
): Promise<{
  servers: ServerConfig[];
  serverSecrets: {
    passwords: Record<string, string>;
    passphrases: Record<string, string>;
    proxyPasswords: Record<string, string>;
  };
  authProfiles: AuthProfile[];
  authProfileSecrets: {
    passwords: Record<string, string>;
    passphrases: Record<string, string>;
  };
  inventorySources: InventorySourceConfig[];
  inventorySourceSecrets: Record<string, Record<string, string>>;
  // FINDING 1 (P2, secrets review) — count of sources for which at least one declared
  // secretFieldId came back empty from vault.get (a locked/unavailable keychain, most
  // commonly). Previously these secrets were just omitted from the bucket with no signal
  // anywhere: the record still exported cleanly, so a replace-restore of that backup would
  // re-import the source, its per-source secret-restore loop would iterate zero fields
  // (nothing to fail on), and the whole import would report success for a source that in
  // fact has no credentials to sync with. Surfaced by exportBackup as a warning appended to
  // its completion message — a stuck keychain shouldn't block backing up everything else, so
  // this is a count to warn with, not a reason to abort the export.
  sourcesWithMissingSecrets: number;
}> {
  return configMutationLock.runExclusive(async () => {
    // Fresh read taken INSIDE the lock — an earlier top-of-export snapshot
    // (taken before the lock, if any) must never be reused for these three
    // buckets.
    const snapshot = core.getSnapshot();
    const servers = snapshot.servers;
    const authProfiles = snapshot.authProfiles;
    const inventorySources = snapshot.inventorySources;

    const passwords: Record<string, string> = {};
    const passphrases: Record<string, string> = {};
    const proxyPasswords: Record<string, string> = {};
    for (const server of servers) {
      const pw = await vault.get(passwordSecretKey(server.id));
      if (pw) passwords[server.id] = pw;
      const pp = await vault.get(passphraseSecretKey(server.id));
      if (pp) passphrases[server.id] = pp;
      const proxyPw = await vault.get(proxyPasswordSecretKey(server.id));
      if (proxyPw) proxyPasswords[server.id] = proxyPw;
    }

    const authProfilePasswords: Record<string, string> = {};
    const authProfilePassphrases: Record<string, string> = {};
    for (const profile of authProfiles) {
      const pw = await vault.get(authProfilePasswordSecretKey(profile.id));
      if (pw) authProfilePasswords[profile.id] = pw;
      const pp = await vault.get(authProfilePassphraseSecretKey(profile.id));
      if (pp) authProfilePassphrases[profile.id] = pp;
    }

    const inventorySourceSecrets: Record<string, Record<string, string>> = {};
    let sourcesWithMissingSecrets = 0;
    for (const source of inventorySources) {
      const fields: Record<string, string> = {};
      let missingAny = false;
      for (const fieldId of source.secretFieldIds) {
        const value = await vault.get(inventorySecretKey(source.id, fieldId));
        if (value) fields[fieldId] = value;
        else missingAny = true;
      }
      if (Object.keys(fields).length > 0) inventorySourceSecrets[source.id] = fields;
      if (missingAny) sourcesWithMissingSecrets++;
    }

    return {
      servers,
      serverSecrets: { passwords, passphrases, proxyPasswords },
      authProfiles,
      authProfileSecrets: { passwords: authProfilePasswords, passphrases: authProfilePassphrases },
      inventorySources,
      inventorySourceSecrets,
      sourcesWithMissingSecrets
    };
  });
}

export function registerConfigCommands(core: NexusCore, vault: SecretVault, context?: import("vscode").ExtensionContext): vscode.Disposable[] {
  async function exportBackup(): Promise<void> {
    const masterPassword = await promptMasterPassword();
    if (!masterPassword) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Creating encrypted backup\u2026" },
      async () => {
        // FINDING 1 (round 16) — servers, auth profiles, and inventory
        // sources, PLUS every one of their vault secrets, are captured
        // together in ONE configMutationLock span (see
        // captureBackupStateForExport's doc comment for the race this
        // closes). Everything below consumes `captured.*` for those three
        // buckets — never `snapshot.servers` / `snapshot.authProfiles` /
        // `snapshot.inventorySources`, which would be a second,
        // independently stale read. `snapshot` below is used only for the
        // buckets the lock does not cover (tunnels, serial profiles, local
        // shell profiles, explicit groups) — none of which are vault-backed.
        const captured = await captureBackupStateForExport(core, vault);
        const snapshot = core.getSnapshot();
        const settings = readSettings();

        // Collect secrets
        const secrets: Record<string, unknown> = {
          passwords: captured.serverSecrets.passwords,
          passphrases: captured.serverSecrets.passphrases,
          proxyPasswords: captured.serverSecrets.proxyPasswords,
          authProfilePasswords: captured.authProfileSecrets.passwords,
          authProfilePassphrases: captured.authProfileSecrets.passphrases,
          inventorySourceSecrets: captured.inventorySourceSecrets,
          secretMacros: [],
          fileBackups: []
        };

        // Collect all macros from the store
        const allMacros = getMacros(); // resolved — secret text included
        // This array sits OUTSIDE `encryptedSecrets`, i.e. in the backup file's
        // cleartext — so a masked variable's plaintext `default` here would be
        // readable without the backup password.
        const nonSecretForTopLevel: TerminalMacro[] = allMacros.map((m) =>
          withRedactedVariables(m.secret ? { ...m, text: "" } : { ...m })
        );
        const secretMacroBlobs = allMacros
          .filter((m) => m.secret && m.id)
          .map((m) => ({ id: m.id!, text: m.text }));

        const fileBackups = await collectBackupFolders(context);
        secrets.secretMacros = secretMacroBlobs;
        secrets.fileBackups = fileBackups;

        const encryptedSecrets = encrypt(JSON.stringify(secrets), masterPassword);

        const exportData: NexusConfigExport = {
          version: 2,
          exportType: "backup",
          exportedAt: new Date().toISOString(),
          servers: captured.servers,
          tunnels: snapshot.tunnels,
          serialProfiles: snapshot.serialProfiles,
          localShellProfiles: snapshot.localShellProfiles,
          authProfiles: captured.authProfiles,
          inventorySources: captured.inventorySources,
          groups: snapshot.explicitGroups,
          macros: nonSecretForTopLevel,
          macroFolders: getMacroFolders(),
          settings, // no longer contains nexus.terminal.macros
          encryptedSecrets
        };

        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file("nexus-backup.json"),
          filters: { "JSON Files": ["json"] },
          title: "Save Encrypted Backup"
        });
        if (!uri) return;

        const json = JSON.stringify(exportData, null, 2);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(json, "utf8"));

        const count = captured.servers.length + snapshot.tunnels.length + snapshot.serialProfiles.length + snapshot.localShellProfiles.length + captured.authProfiles.length;
        const fileCount = fileBackups.reduce((sum, folder) => sum + folder.files.length, 0);
        const fileNote = fileCount > 0
          ? ` and ${plural(fileCount, "encrypted .ssh/script file")}`
          : "";
        // FINDING 1 (P2, secrets review) — warn, don't abort: a locked/unavailable keychain
        // shouldn't block backing up everything else. Appended to the SAME completion message
        // (not a separate dialog) so it can't be missed/dismissed independently of the success
        // notification.
        const missingSecretsNote = captured.sourcesWithMissingSecrets > 0
          ? ` ${captured.sourcesWithMissingSecrets} inventory source${captured.sourcesWithMissingSecrets === 1 ? "" : "s"} had unreadable credentials — the backup does not include them.`
          : "";
        void vscode.window.showInformationMessage(`Backup saved with ${plural(count, "profile")}${fileNote} to ${uri.fsPath}${missingSecretsNote}`);
      }
    );
  }

  async function exportShare(): Promise<void> {
    const snapshot = core.getSnapshot();
    const settings = readSettings();
    const allMacros = getMacros();

    const sanitized = sanitizeForSharing(
      snapshot.servers,
      snapshot.tunnels,
      snapshot.serialProfiles,
      snapshot.localShellProfiles,
      settings,
      snapshot.authProfiles,
      allMacros
    );

    const exportData: NexusConfigExport = {
      version: 2,
      exportType: "share",
      exportedAt: new Date().toISOString(),
      servers: sanitized.servers,
      tunnels: sanitized.tunnels,
      serialProfiles: sanitized.serialProfiles,
      localShellProfiles: sanitized.localShellProfiles,
      authProfiles: sanitized.authProfiles.length > 0 ? sanitized.authProfiles : undefined,
      groups: snapshot.explicitGroups,
      macros: sanitized.macros.length > 0 ? sanitized.macros : undefined,
      macroFolders: getMacroFolders(),
      settings: sanitized.settings
    };

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file("nexus-config-shared.json"),
      filters: { "JSON Files": ["json"] },
      title: "Export for Sharing"
    });
    if (!uri) return;

    const json = JSON.stringify(exportData, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(json, "utf8"));

    const count = snapshot.servers.length + snapshot.tunnels.length + snapshot.serialProfiles.length + snapshot.localShellProfiles.length + sanitized.authProfiles.length;
    const excludedSecretCount = allMacros.filter((m) => m.secret).length;
    const base = `Exported ${count} profiles for sharing to ${uri.fsPath}`;
    const suffix = excludedSecretCount > 0
      ? ` (${excludedSecretCount} secret macro${excludedSecretCount === 1 ? "" : "s"} excluded)`
      : "";
    void vscode.window.showInformationMessage(`${base}${suffix}.`);
  }

  /**
   * Branch 6 tail (Nexus Export File…): parse already-acquired text as a Nexus
   * export and apply it. Shared by the direct dialog flow below and by every
   * cross-branch reroute that lands here with bytes it already read — never a
   * fresh file dialog, so a wrong-format detour is always exactly one click.
   */
  async function applyNexusExportText(text: string): Promise<void> {
    let data: unknown;
    let parseError = false;
    try {
      data = JSON.parse(text);
    } catch {
      parseError = true;
    }

    if (parseError || !isValidExport(data)) {
      await reportNexusExportFormatMismatch(text, parseError);
      return;
    }

    const exportType = data.exportType;

    // For share exports, always merge with fresh IDs
    if (exportType === "share") {
      await importShareData(data);
      return;
    }

    // For backup or legacy: ask merge/replace
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: "Merge",
          description: "Add profiles; restore only missing .ssh and script files",
          detail: "Existing local files are left unchanged.",
          value: "merge" as const
        },
        {
          label: "Replace",
          description: "Replace profiles; overwrite backed-up .ssh and script files",
          detail: "Extra local files are not deleted.",
          value: "replace" as const
        }
      ],
      { title: "Import Mode" }
    );
    if (!mode) return;

    // Decrypt secrets for backup files
    let decryptedSecrets: Record<string, unknown> | undefined;
    if (exportType === "backup" && data.encryptedSecrets) {
      const password = await promptDecryptPassword();
      if (!password) return;
      try {
        decryptedSecrets = JSON.parse(decrypt(data.encryptedSecrets, password));
      } catch {
        void vscode.window.showErrorMessage("Incorrect password or corrupted backup.");
        return;
      }
    }

    await importMergeReplace(data, mode.value, decryptedSecrets);
  }

  /**
   * Branch 6's "declared Nexus export but the content disagrees" fallback. Same
   * contract as every other branch: the sniffer only ever contradicts — a
   * confidently different signature gets a one-click reroute using the same
   * bytes, never a fresh dialog. Syntactically broken text that still starts
   * with "{" is named as broken rather than offered a host-list reroute it
   * cannot be (see importFormatSniffer's own "still not a host list" rule).
   */
  async function reportNexusExportFormatMismatch(text: string, isMalformedJson: boolean): Promise<void> {
    const sniff = sniffImportFormat(text);

    if (sniff === "host-list") {
      const choice = await vscode.window.showErrorMessage(
        "That file isn't a Nexus JSON export.",
        "Import as Host List"
      );
      if (choice === "Import as Host List") await applyInventoryText(text);
      return;
    }
    if (sniff === "mobaxterm") {
      const choice = await vscode.window.showErrorMessage(
        "That file isn't a Nexus export — it looks like a MobaXterm INI.",
        "Import as MobaXterm"
      );
      if (choice === "Import as MobaXterm") await applyMobaxtermText(text);
      return;
    }
    if (sniff === "xml") {
      const choice = await vscode.window.showErrorMessage(
        "This is an XML file. If it came from SecureCRT, import it as a SecureCRT export.",
        "Import as SecureCRT XML"
      );
      if (choice === "Import as SecureCRT XML") await applySecureCrtXmlText(text);
      return;
    }

    // sniff === "nexus-json": starts with "{" but either didn't parse at all, or
    // parsed to JSON that isn't shaped like an export. These get different
    // wording — claiming "this is valid JSON" about text that failed JSON.parse
    // would be false.
    if (isMalformedJson) {
      void vscode.window.showErrorMessage(
        "This looks like a Nexus export, but the file could not be parsed as JSON."
      );
      return;
    }
    void vscode.window.showErrorMessage(
      "This is valid JSON, but not a Nexus export — expected a version field and at least one profile list (servers, tunnels, …)."
    );
  }

  /** Branch 6 (Nexus Export File…): the dialog + read wrapper around applyNexusExportText. */
  async function importNexusExport(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { "JSON Files": ["json"] },
      title: "Import Nexus Configuration"
    });
    if (!uris || uris.length === 0) return;

    const raw = await vscode.workspace.fs.readFile(uris[0]);
    await applyNexusExportText(Buffer.from(raw).toString("utf8"));
  }

  async function importShareData(data: NexusConfigExport): Promise<void> {
    // Generate fresh IDs to prevent duplicates on re-import
    const idMap = new Map<string, string>();

    const authProfiles = data.authProfiles ?? [];
    const servers = data.servers ?? [];
    const tunnels = data.tunnels ?? [];
    const serialProfiles = data.serialProfiles ?? [];
    const localShellProfiles = data.localShellProfiles ?? [];

    // First pass: assign new IDs for auth profiles and servers so links can be remapped.
    for (const profile of authProfiles) {
      ensureId(profile as unknown as Record<string, unknown>);
      idMap.set(profile.id, randomUUID());
    }
    for (const server of servers) {
      ensureId(server as unknown as Record<string, unknown>);
      idMap.set(server.id, randomUUID());
    }

    let imported = 0;
    let skipped = 0;

    // Each block remaps ids inline (semantics differ per entity), then defers the
    // validate-then-add-or-skip tally to addIfValid to keep that mechanical part DRY.
    const tally = (ok: boolean): void => {
      if (ok) imported++;
      else skipped++;
    };

    for (const profile of authProfiles) {
      const remappedProfile: AuthProfile = {
        ...profile,
        id: idMap.get(profile.id)!
      };
      tally(await addIfValid(remappedProfile, validateAuthProfile, (e) => core.addOrUpdateAuthProfile(e)));
    }

    for (const server of servers) {
      let remappedProxy = server.proxy;
      if (remappedProxy?.type === "ssh") {
        const remapped = idMap.get(remappedProxy.jumpHostId);
        if (remapped) {
          remappedProxy = { ...remappedProxy, jumpHostId: remapped };
        } else {
          remappedProxy = undefined; // Jump host not in export
        }
      }
      const remappedServer: ServerConfig = {
        ...server,
        id: idMap.get(server.id)!,
        proxy: remappedProxy,
        authProfileId: server.authProfileId ? idMap.get(server.authProfileId) : undefined
      };
      tally(await addIfValid(remappedServer, validateServerConfig, (e) => addServerSanitizingOrigin(e, (s) => core.addOrUpdateServer(s))));
    }
    for (const tunnel of tunnels) {
      ensureId(tunnel as unknown as Record<string, unknown>);
      const remappedTunnel: TunnelProfile = {
        ...tunnel,
        id: randomUUID(),
        defaultServerId: tunnel.defaultServerId ? idMap.get(tunnel.defaultServerId) ?? undefined : undefined
      };
      tally(await addIfValid(remappedTunnel, validateTunnelProfile, (e) => core.addOrUpdateTunnel(e)));
    }
    for (const profile of serialProfiles) {
      ensureId(profile as unknown as Record<string, unknown>);
      const remappedProfile: SerialProfile = {
        ...profile,
        id: randomUUID()
      };
      tally(await addIfValid(remappedProfile, validateSerialProfile, (e) => core.addOrUpdateSerialProfile(e)));
    }
    for (const profile of localShellProfiles) {
      ensureId(profile as unknown as Record<string, unknown>);
      const remappedProfile: LocalShellProfile = {
        ...profile,
        id: randomUUID()
      };
      tally(await addIfValid(remappedProfile, validateLocalShellProfile, (e) => core.addOrUpdateLocalShellProfile(e)));
    }

    if (Array.isArray(data.groups)) {
      for (const group of data.groups) {
        if (typeof group === "string" && group) {
          await core.addGroup(group);
        }
      }
    }

    // §4.1 — explicit macro folders carried exactly as `groups` is: merge
    // (union), sanitizing untrusted input the same way as everywhere else (§4.2).
    if (Array.isArray(data.macroFolders)) {
      const incomingFolders = sanitizeMacroFolderList(data.macroFolders);
      if (incomingFolders.length > 0) {
        const merged = new Set([...getMacroFolders(), ...incomingFolders]);
        await saveMacroFolders([...merged]);
      }
    }

    if (data.settings && typeof data.settings === "object") {
      await applySettings(data.settings);
    }

    // Apply macros (share = non-secret only)
    // v2 shape: top-level `data.macros` array
    // v1 shape: macros under `data.settings["nexus.terminal.macros"]`
    const rawMacros: TerminalMacro[] = Array.isArray(data.macros)
      ? data.macros
      : Array.isArray(data.settings?.["nexus.terminal.macros"])
        ? (data.settings!["nexus.terminal.macros"] as TerminalMacro[])
        : [];
    if (rawMacros.length > 0) {
      const incoming = rawMacros.filter((m) => !m.secret);
      const existing = getMacros();
      const existingByKey = new Set(existing.map(keyOf));
      const merged = [...existing];
      for (const m of incoming) {
        // Sanitize before dedup and save. A share file is untrusted input from
        // another machine: without this it can persist a masked variable carrying a
        // plaintext `default` (which then reaches globalState and `Copy All as JSON`),
        // an over-cap or malformed `variables` array, or a variables+trigger macro
        // whose auto-trigger can never compile.
        const remapped: TerminalMacro = sanitizeImportedMacro({ ...m, id: randomUUID() });
        const key = keyOf(remapped);
        if (!existingByKey.has(key)) {
          // Record the key as we go: two entries in one share file can differ before
          // sanitization and be identical after it (e.g. one carries an extra
          // invalid-named variable that gets dropped), and would otherwise both land.
          existingByKey.add(key);
          merged.push(remapped);
        }
      }
      await saveMacros(merged);
    }

    const skipNote = skipped > 0 ? ` (${skipped} skipped)` : "";
    void vscode.window.showInformationMessage(`Imported ${imported} profiles${skipNote}.`);
  }

  /**
   * CONFIG MUTATION LOCK — everything below (id-preserving import, replace-mode
   * wipe, macro/settings/secret restore) is the post-confirmation mutation
   * phase: the mode picker and the master-password prompt have already
   * resolved by the time a caller reaches this function (see
   * applyNexusExportText / the "backup or legacy" branch above), so there is
   * no interactive UI left to hold the lock across. Serializing this against
   * inventoryCommands' critical sections closes the round-14 race class: a
   * replace-mode import here can otherwise delete/recreate an inventory
   * source's vault key, tear down a recreated server's runtime, or delete a
   * recreated server's credentials WHILE removeSource/syncNow's own awaited
   * post-apply phase is still touching the same source/server.
   */
  async function importMergeReplace(
    data: NexusConfigExport,
    mode: "merge" | "replace",
    decryptedSecrets?: Record<string, unknown>
  ): Promise<void> {
    await configMutationLock.runExclusive(() => importMergeReplaceLocked(data, mode, decryptedSecrets));
  }

  async function importMergeReplaceLocked(
    data: NexusConfigExport,
    mode: "merge" | "replace",
    decryptedSecrets?: Record<string, unknown>
  ): Promise<void> {
    const snapshot = core.getSnapshot();

    if (mode === "replace") {
      for (const server of snapshot.servers) {
        await core.removeServer(server.id);
      }
      for (const tunnel of snapshot.tunnels) {
        await core.removeTunnel(tunnel.id);
      }
      for (const profile of snapshot.serialProfiles) {
        await core.removeSerialProfile(profile.id);
      }
      for (const profile of snapshot.localShellProfiles) {
        await core.removeLocalShellProfile(profile.id);
      }
      for (const profile of snapshot.authProfiles) {
        if (vault) {
          await vault.delete(authProfilePasswordSecretKey(profile.id));
          await vault.delete(authProfilePassphraseSecretKey(profile.id));
        }
        await core.removeAuthProfile(profile.id);
      }
      for (const group of snapshot.explicitGroups) {
        await core.removeExplicitGroup(group);
      }
      // F18-adjacent ordering: wipe each source's vault secrets before dropping the
      // source record itself, same as every other replace-mode secret cleanup above.
      for (const source of snapshot.inventorySources) {
        for (const fieldId of source.secretFieldIds) {
          await vault.delete(inventorySecretKey(source.id, fieldId));
        }
        await core.removeInventorySource(source.id);
      }
    }

    // F14 — merge mode: existing inventory source ids join the existing-id set so
    // importPreservingIds skips them (a local source is never silently overwritten
    // by a same-id source from the file); replace mode already cleared them above.
    const existingIds = mode === "merge"
      ? new Set([
          ...snapshot.servers.map((s) => s.id),
          ...snapshot.tunnels.map((t) => t.id),
          ...snapshot.serialProfiles.map((p) => p.id),
          ...snapshot.localShellProfiles.map((p) => p.id),
          ...snapshot.authProfiles.map((p) => p.id),
          ...snapshot.inventorySources.map((s) => s.id)
        ])
      : new Set<string>();

    let imported = 0;
    let skipped = 0;
    // id-PRESERVING import (distinct from the share path's fresh-id remap): each entity keeps
    // its id and is skipped when that id already exists. Same shape across all six buckets.
    const serverTally = await importPreservingIds(data.servers, existingIds, validateServerConfig, (e) => addServerSanitizingOrigin(e, (s) => core.addOrUpdateServer(s)));
    const tunnelTally = await importPreservingIds(data.tunnels, existingIds, validateTunnelProfile, (e) => core.addOrUpdateTunnel(e));
    const serialTally = await importPreservingIds(data.serialProfiles, existingIds, validateSerialProfile, (e) => core.addOrUpdateSerialProfile(e));
    // Kept in its own variable (not folded into the array below) because the inventory-secret
    // restore loop further down needs to know exactly which source ids this run imported — see
    // the comment there.
    // REVIEW FINDING 2 (P2) / ROUND (validate-before-strip) FINDING — strip
    // `managedFolders` from `data.inventorySources` BEFORE validation runs;
    // see `sanitizeImportedInventorySources`'s doc for why the strip can't
    // live inside `validateInventorySource`, nor after it (a malformed value
    // must not be able to reject the whole source).
    data.inventorySources = sanitizeImportedInventorySources(data.inventorySources);
    const inventorySourceTally = await importPreservingIds(data.inventorySources, existingIds, validateInventorySource, (e) =>
      core.addOrUpdateInventorySource(e)
    );
    const localShellTally = await importPreservingIds(data.localShellProfiles, existingIds, validateLocalShellProfile, (e) => core.addOrUpdateLocalShellProfile(e));
    const authProfileTally = await importPreservingIds(data.authProfiles, existingIds, validateAuthProfile, (e) => core.addOrUpdateAuthProfile(e));
    for (const tally of [serverTally, tunnelTally, serialTally, inventorySourceTally, localShellTally, authProfileTally]) {
      imported += tally.imported;
      skipped += tally.skipped;
    }

    // Clear dangling authProfileId references
    const postImportSnapshot = core.getSnapshot();
    const knownProfileIds = new Set(postImportSnapshot.authProfiles.map((p) => p.id));
    for (const server of postImportSnapshot.servers) {
      if (server.authProfileId && !knownProfileIds.has(server.authProfileId)) {
        const cleared: ServerConfig = { ...server, authProfileId: undefined };
        // Same rule as NexusCore.removeAuthProfile: the inventory sync's record
        // that IT applied this profile (origin.syncedAuthProfileId) dies with the
        // link it describes. Left behind, it would read as a per-server opt-out —
        // no `authProfileId`, but a stamp naming a profile — and lock a server
        // nobody hand-configured out of retro-apply for good. Only the stamp
        // naming the very profile being cleared is dropped; a stamp the user has
        // already diverged from is their decision and is left alone.
        if (server.origin?.syncedAuthProfileId === server.authProfileId) {
          cleared.origin = { ...server.origin, syncedAuthProfileId: undefined };
        }
        await core.addOrUpdateServer(cleared);
      }
    }
    // Same clear for inventory sources, whose `authProfileId` links their synced
    // servers to a profile the same way. Backup import preserves ids on BOTH sides
    // (importPreservingIds above), so a surviving reference needs no remap — but it
    // can still dangle: a payload can carry a source whose profile was never exported
    // (or was skipped/rejected on import), and merge mode may keep a local profile-less
    // record while importing nothing to satisfy it. Resolution is checked against the
    // POST-import snapshot, not the payload, so a source that links to a profile this
    // machine already has keeps its link. A dangling id left in place would survive
    // every later resolution attempt as a permanent no-op — the sync engine degrades to
    // the default username + SSH agent and warns on every run — so it is cleared here
    // exactly as the server refs above are. `addOrUpdateInventorySource` re-revisions,
    // which is correct: this is a new incarnation of the record.
    for (const source of postImportSnapshot.inventorySources) {
      if (source.authProfileId && !knownProfileIds.has(source.authProfileId)) {
        await core.addOrUpdateInventorySource({ ...source, authProfileId: undefined });
      }
    }

    if (Array.isArray(data.groups)) {
      for (const group of data.groups) {
        if (typeof group === "string" && group) {
          await core.addGroup(group);
        }
      }
    }

    // Read the incoming macros BEFORE the folder block: whether this payload
    // replaces the macros array at all is what decides whether clearing the
    // folder list is a correction or a deletion. See below.
    const incomingResult = collectIncomingMacros(data, decryptedSecrets);

    // §4.1 — explicit macro folders, carried exactly as `groups` is. Replace
    // mode overwrites the persisted list outright (mirrors the macros-array
    // replace just below, and `saveFolders()` itself replaces — no separate
    // upfront-clear step is needed the way `groups` needs one for `addGroup`'s
    // additive API); merge mode unions with what already exists.
    //
    // Fix 5 — a pre-2.8.75 backup predates `macroFolders` entirely, so
    // `data.macroFolders` is `undefined` rather than `[]`. In REPLACE mode that
    // must still clear the list WHEN THE MACROS ARE ALSO BEING REPLACED,
    // otherwise the store shows folders left over from a config the import just
    // discarded.
    //
    // "When the macros are also being replaced" is the whole condition, and the
    // earlier unconditional clear got it wrong by asserting `saveMacros()`
    // always runs below. It does not: `collectIncomingMacros()` returns
    // `undefined` for a payload carrying neither a top-level `macros` array nor
    // `settings["nexus.terminal.macros"]`, and the macros block is then skipped
    // entirely. `isValidExport()` accepts exactly that shape — a servers-only
    // export, or any pre-macro-export backup — so replace-importing one used to
    // keep every macro and destroy every explicit empty folder, which is the
    // one artifact this feature exists to persist. Nothing was replaced;
    // nothing should have been cleared.
    //
    // Merge mode has no such gap — unioning with nothing already sitting there
    // is a correct no-op.
    if (mode === "replace") {
      if (Array.isArray(data.macroFolders)) {
        await saveMacroFolders(sanitizeMacroFolderList(data.macroFolders));
      } else if (incomingResult !== undefined) {
        await saveMacroFolders([]);
      }
    } else if (Array.isArray(data.macroFolders)) {
      const incomingFolders = sanitizeMacroFolderList(data.macroFolders);
      if (incomingFolders.length > 0) {
        await saveMacroFolders([...new Set([...getMacroFolders(), ...incomingFolders])]);
      }
    }

    // Apply macros from import payload
    if (incomingResult !== undefined) {
      const { macros: incomingMacros, unresolvedCount } = incomingResult;
      if (mode === "replace") {
        // `replaceMacros`, not `saveMacros`: this is the one macro write in the extension whose
        // input is a wholesale external list, and the store's two entry points exist for
        // exactly that distinction (see `MacroStore.save()` / `MacroStore.replaceAll()`). The
        // ids in a backup file are strings that were identities on some other machine; any
        // agreement with a local macro's id is a collision. Handing them to `saveMacros()` let
        // an imported record be treated as the local record filed under that id — and with the
        // keyring transiently unavailable, an imported macro whose own secret failed to decrypt
        // inherited the local macro's stored password.
        await replaceMacros(incomingMacros);
      } else {
        // Merge keeps the file's ids, and skips on TWO independent keys. Both are load-bearing
        // and they close different holes.
        //
        // 1. THE ID SKIP is what lets these records go to `saveMacros()` at all: every
        //    incoming record whose id the store already holds is DROPPED, so no id reaching
        //    the store from this branch can name anything the store knows, which is exactly
        //    `MacroStore.save()`'s precondition. It has to stay here rather than become a
        //    store concern for that reason. It also means a macro the user edited locally is
        //    not re-added from the backup as a second copy.
        //
        // 2. THE CONTENT SKIP is what makes importing the same file twice idempotent. The id
        //    skip alone is NOT, and that is not hypothetical: replace-mode restore assigns a
        //    fresh id to every incoming record (`MacroStore.replaceAll()` — an id in a file is
        //    an identity from another machine, and treating it as a local one handed imported
        //    macros local passwords). So after restoring a backup in replace mode, none of the
        //    ids in that file name anything any more, and the ordinary follow-up — merging the
        //    same file to pick up something added since — matched nothing and added a SECOND
        //    copy of every macro in it. Both copies carry distinct ids, so the duplicate-id
        //    fail-safe does not suppress either: both compile auto-trigger rules and both fire
        //    on one match, and a secret `Password:` responder sends the password twice per
        //    prompt. `keyOf()` is the same content key the share-import path deduplicates on,
        //    and it names EVERY field that makes two records different macros — a collision
        //    here is a silent drop, not a merge, so anything left out of it is a legitimate
        //    macro this loop can throw away with no report. See `keyOf()`.
        //
        // Only the CONTENT key is recorded as we go, matching the share-import path: two
        // entries in one file that agree on content are the same macro twice and the second is
        // dropped. With the key covering every content field, "agree on content" now means the
        // two records are indistinguishable in everything except their ids — which is the only
        // reading under which dropping one is right. The id set is deliberately not extended,
        // so two records in one file that share an id but differ in ANY content field are
        // treated as the two different macros they are — both land, and the store re-keys the
        // second (`assignMacroIds()`). Neither of them can reach the pin predicate, which only
        // fires for ids the store already holds.
        const existing = getMacros();
        const existingIds = new Set(existing.map((m) => m.id).filter(Boolean) as string[]);
        const existingKeys = new Set(existing.map(keyOf));
        const merged = [...existing];
        for (const m of incomingMacros) {
          if (m.id && existingIds.has(m.id)) continue;
          const key = keyOf(m);
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);
          merged.push({ ...m, id: m.id ?? randomUUID() });
        }
        await saveMacros(merged);
      }
      if (unresolvedCount > 0) {
        void vscode.window.showWarningMessage(
          `${unresolvedCount} secret macro${unresolvedCount === 1 ? "" : "s"} could not be decrypted from this backup. Their entries were imported but the secret text is missing — edit them to restore the value.`
        );
      }
    }

    // Apply settings
    if (data.settings && typeof data.settings === "object") {
      await applySettings(data.settings);
    }

    // Restore passwords/passphrases from decrypted secrets
    let fileRestoreResult: RestoreBackupFoldersResult = { restoredFiles: 0, skippedExistingFiles: 0 };
    // Sources whose record + secrets were both successfully rolled back this run.
    const failedInventorySourceNames: string[] = [];
    // FINDING 1 — sources whose secret store ALSO failed to roll back (removeInventorySource
    // itself rejected). Kept separate from failedInventorySourceNames: these sources are still
    // live in core (removeInventorySource's own catch restores the in-memory record when its
    // persist fails — see NexusCore.removeInventorySource), so lumping them into the "could not
    // be restored — re-import or add it manually" message would tell the user the source is
    // gone when it is actually still present with missing/partial credentials.
    const unremovableInventorySourceNames: string[] = [];
    // FINDING 2 — total count of servers imported THIS RUN that named a rolled-back source as
    // their origin and were converted to plain manual servers (origin stripped). Only servers
    // this run itself created are touched; a pre-existing server that happens to share the
    // rolled-back source id is never modified.
    let convertedServerCount = 0;
    // FINDING 2 (P2, origin-strip review) — count of the same servers whose conversion attempt
    // (addOrUpdateServer) itself rejected. Previously this catch was silent: the warning below
    // under-counted (a failed conversion just vanished from the tally) and, because in-memory
    // core state can diverge from what actually made it to disk while the write is in flight,
    // the server's origin can still point at the now-removed source after a reload — a stale
    // "synced" badge with nothing left to manage it. That in-memory-ahead-of-disk gap is the
    // repo-wide last-writer-wins pattern already accepted everywhere else in this file (e.g. the
    // best-effort vault-delete/removeInventorySource rollbacks above) — no new compensation
    // machinery belongs here. The fix is only to stop swallowing the count and say so.
    let failedConversionCount = 0;
    // Declared here (not inside the `inventorySourceSecrets` branch below) because the
    // FINDING 1 (P2, secrets review) missing-credentials sweep after the restore phase needs
    // them too, and that sweep must run whether or not this backup carried an
    // `inventorySourceSecrets` bucket at all — a backup with none is exactly the case where
    // every declared secretFieldId comes back empty.
    const importedSourceIds = new Set(inventorySourceTally.importedIds);
    const importedSourceById = new Map((data.inventorySources ?? []).map((s) => [s.id, s]));
    // Sources handled by one of the two rollback warnings above (removed entirely, or left
    // live-but-unremovable) — both already tell the user what to do about their credentials,
    // so the missing-credentials sweep below skips them to avoid a redundant second warning.
    const rolledBackSourceIds = new Set<string>();
    if (decryptedSecrets) {
      // Scope to ids actually imported this run — server-keyed buckets to serverTally, the
      // auth-profile-keyed pair to authProfileTally. See restoreSecrets()'s doc comment for why
      // this applies in both merge and replace mode.
      const importedServerIds = new Set(serverTally.importedIds);
      const importedAuthProfileIds = new Set(authProfileTally.importedIds);
      await restoreSecrets(decryptedSecrets.passwords as Record<string, string> | undefined, passwordSecretKey, vault, importedServerIds);
      await restoreSecrets(decryptedSecrets.passphrases as Record<string, string> | undefined, passphraseSecretKey, vault, importedServerIds);
      await restoreSecrets(decryptedSecrets.proxyPasswords as Record<string, string> | undefined, proxyPasswordSecretKey, vault, importedServerIds);
      await restoreSecrets(decryptedSecrets.authProfilePasswords as Record<string, string> | undefined, authProfilePasswordSecretKey, vault, importedAuthProfileIds);
      await restoreSecrets(decryptedSecrets.authProfilePassphrases as Record<string, string> | undefined, authProfilePassphraseSecretKey, vault, importedAuthProfileIds);
      // Nested (sourceId -> fieldId -> secret) shape, unlike the flat id->secret buckets
      // above, so it gets its own loop rather than restoreSecrets()'s single-level keyFn.
      const inventorySourceSecrets = decryptedSecrets.inventorySourceSecrets as Record<string, Record<string, string>> | undefined;
      if (inventorySourceSecrets) {
        // FINDING 3 — importPreservingIds's `importedIds` only names sources that actually
        // landed: merge mode skips an id that already exists locally (the local record wins),
        // and BOTH modes skip a source that fails validateInventorySource (e.g. a corrupt
        // prunePolicy). Restoring unconditionally in either case would write a vault key for a
        // source that was never persisted — undiscoverable dead secrets, since export, removal,
        // and reset all enumerate persisted sources, not the backup payload. So the restore is
        // scoped to importedIds in both modes, not merge-only.
        //
        // FINDING 2 — the importedIds gate above is source-scoped only: it says nothing
        // about which fields WITHIN that source's bucket are legitimate. A malformed/stale
        // backup can carry a secrets bucket wider than the imported source record's own
        // declared `secretFieldIds` (e.g. a field removed from the provider's config schema
        // since the backup was taken, or hand-edited backup JSON). Restoring those extra
        // fields writes a vault key nothing can ever enumerate again — export, removal, and
        // reset all walk `secretFieldIds`, not the backup payload — so it becomes a
        // permanent, undiscoverable secret. Intersect with the imported record's own
        // `secretFieldIds` (looked up from `data.inventorySources`, which importPreservingIds
        // mutated in place with the final id) so only fields the source actually declares
        // are restored.
        //
        // ROUND 16 FINDING (import review) — importPreservingIds above already PERSISTED
        // each imported source's record before this loop runs; a vault.store rejection here
        // used to leave that record stranded live with no credential (worst in replace mode,
        // where the prior local record is already gone — there is nothing to fall back to).
        // Per source, track exactly which keys THIS RUN stored; on any store failure for that
        // source, best-effort delete those keys back out, remove the just-imported record via
        // core.removeInventorySource, and record its name for the closing warning below. Other
        // sources' restores are unaffected — the try/catch is scoped per source, not around the
        // whole loop, so one failure never aborts the rest.
        //
        // A vault-first reordering (store secrets, THEN persist the record) would close this
        // more cleanly, but importPreservingIds is the generic shared path all six imported
        // buckets go through — special-casing the ordering there for inventory sources alone
        // would complicate every other bucket's call site. This per-source rollback is the
        // minimal change scoped to the one bucket that reads secrets back out of the vault.
        for (const [sourceId, fields] of Object.entries(inventorySourceSecrets)) {
          if (!importedSourceIds.has(sourceId)) continue;
          const importedSource = importedSourceById.get(sourceId);
          const declaredFieldIds = new Set(importedSource?.secretFieldIds ?? []);
          const storedKeysThisRun: string[] = [];
          try {
            for (const [fieldId, value] of Object.entries(fields)) {
              if (!declaredFieldIds.has(fieldId)) continue;
              const key = inventorySecretKey(sourceId, fieldId);
              await vault.store(key, value);
              storedKeysThisRun.push(key);
            }
          } catch {
            for (const key of storedKeysThisRun) {
              try {
                await vault.delete(key);
              } catch {
                // Best-effort — nothing else to do if the rollback delete itself fails; the
                // source record is removed below regardless, so this is at worst a leftover
                // vault key for a source that no longer exists (same residue class already
                // accepted elsewhere in this file, e.g. removeSource's own best-effort cleanup).
              }
            }
            try {
              await core.removeInventorySource(sourceId);
            } catch {
              // FINDING 1 — the removal itself failed. removeInventorySource's own catch
              // already restored the record in memory (its persist rejected), so the source is
              // NOT gone — it is still live in core, just missing some or all of the
              // credentials we just deleted/never stored. Report this distinctly below and do
              // NOT fall into the "successfully rolled back" bookkeeping: don't decrement
              // `imported` (the source is still counted as imported) and don't touch its
              // servers' origin — a source that still exists can still manage them.
              unremovableInventorySourceNames.push(importedSource?.name ?? sourceId);
              rolledBackSourceIds.add(sourceId);
              continue;
            }
            imported--;
            failedInventorySourceNames.push(importedSource?.name ?? sourceId);
            rolledBackSourceIds.add(sourceId);

            // FINDING 2 — the backup can also carry servers whose origin.sourceId names this
            // now-removed source. Left alone they'd stay synced-badged forever: a manually
            // re-added source gets a fresh id, so nothing could ever claim them again. Scope
            // the sweep to servers THIS RUN imported (serverTally.importedIds) — a pre-existing
            // server is never touched, even if it happens to share the rolled-back source id.
            for (const serverId of serverTally.importedIds) {
              const server = core.getServer(serverId);
              if (!server || server.origin?.sourceId !== sourceId) continue;
              const { origin: _origin, ...withoutOrigin } = server;
              try {
                await core.addOrUpdateServer(withoutOrigin as ServerConfig);
                convertedServerCount++;
              } catch {
                // Best-effort, same residue class as the vault-delete rollback above: at worst
                // this server keeps an origin pointing at a source that no longer exists. Counted
                // (not silently dropped) so the closing warning can say so honestly.
                failedConversionCount++;
              }
            }
          }
        }
      }
      fileRestoreResult = await restoreBackupFolders(decryptedSecrets, mode, context);
    }

    // FINDING 1 (P2, secrets review) — after the secret-restore phase above, catch the case a
    // rejected vault.store never triggers: a source that imported cleanly, and whose secret
    // restore raised NO error, but which still ends up MISSING one or more of its declared
    // secretFieldIds in the vault. Most commonly this is the restore-side mirror of
    // captureBackupStateForExport's missing-secret counting on the export side — the backup
    // simply never captured the credential (a locked/unavailable keychain at export time), so
    // there was nothing for this restore to store no matter how cleanly the rest of the run
    // went. The source can still be added/edited/synced against, but authentication will fail
    // silently until the value is re-entered — so this is a warning, not a rollback: unlike the
    // vault.store-rejection rollback above, the record itself is fine, only (part of) the
    // secret is absent, which is exactly the state "Edit Source" exists to fix. Checked against
    // the vault directly (not the backup payload) so it also catches a backup with no
    // `inventorySourceSecrets` bucket at all. FINDING (P2, round-19 review): a provider can
    // declare MULTIPLE secretFieldIds — checking only whether ANY of them made it into the
    // vault let one present field mask another absent (possibly required) one, so a source
    // that can't actually authenticate was reported as a clean import. Every declared field is
    // now checked; the warning fires if ANY are missing, not only when ALL are.
    const sourcesRestoredWithoutCredentials: string[] = [];
    for (const sourceId of importedSourceIds) {
      if (rolledBackSourceIds.has(sourceId)) continue;
      const importedSource = importedSourceById.get(sourceId);
      const declaredFieldIds = importedSource?.secretFieldIds ?? [];
      if (declaredFieldIds.length === 0) continue;
      let hasMissingValue = false;
      for (const fieldId of declaredFieldIds) {
        const value = await vault.get(inventorySecretKey(sourceId, fieldId));
        if (!value) {
          hasMissingValue = true;
          break;
        }
      }
      if (hasMissingValue) sourcesRestoredWithoutCredentials.push(importedSource?.name ?? sourceId);
    }
    if (sourcesRestoredWithoutCredentials.length > 0) {
      const isSingle = sourcesRestoredWithoutCredentials.length === 1;
      const names = sourcesRestoredWithoutCredentials.map((n) => `"${n}"`).join(", ");
      void vscode.window.showWarningMessage(
        `${isSingle ? "Source" : "Sources"} ${names} ${isSingle ? "was" : "were"} restored with missing credential(s) — re-enter them via Edit Source before syncing.`
      );
    }

    // FINDING 2 (rollback review) — surface every source rolled back above (record + secret
    // restore both undone) so the user knows to re-import or add it by hand, rather than
    // silently discovering a missing source later. Appends how many of its servers were
    // converted to plain manual servers, when any were, PLUS (FINDING 2, P2, origin-strip
    // review) how many of the SAME servers failed that conversion, when any did — both counts
    // come from the same sweep above and are reported together rather than the failure count
    // being silently dropped.
    if (failedInventorySourceNames.length > 0) {
      const isSingle = failedInventorySourceNames.length === 1;
      const names = failedInventorySourceNames.map((n) => `"${n}"`).join(", ");
      const noteParts: string[] = [];
      if (convertedServerCount > 0) {
        noteParts.push(`${convertedServerCount} of ${isSingle ? "its" : "their"} servers were kept as manual servers`);
      }
      if (failedConversionCount > 0) {
        noteParts.push(`${failedConversionCount} servers could not be converted and may still show a synced badge — edit them to clear it`);
      }
      const noteTail = noteParts.length > 0 ? `; ${noteParts.join("; ")}.` : ".";
      void vscode.window.showWarningMessage(
        `${isSingle ? "Source" : "Sources"} ${names} could not be restored — ${isSingle ? "its" : "their"} credentials failed to store; re-import or add ${isSingle ? "it" : "them"} manually${noteTail}`
      );
    }

    // FINDING 1 (rollback review) — a distinct message for sources where even the rollback's
    // own removal failed: unlike the case above, the record is still live in core (partially or
    // fully missing its credentials), so telling the user to "re-import or add it manually"
    // would be false — re-importing would skip it as already-existing, and adding it manually
    // would collide. Point at Edit Source instead, where the existing record can be fixed up.
    if (unremovableInventorySourceNames.length > 0) {
      const isSingle = unremovableInventorySourceNames.length === 1;
      const names = unremovableInventorySourceNames.map((n) => `"${n}"`).join(", ");
      void vscode.window.showWarningMessage(
        `${isSingle ? "Source" : "Sources"} ${names} ${isSingle ? "was" : "were"} imported but ${isSingle ? "its" : "their"} credentials failed to store and ${isSingle ? "it" : "they"} could not be removed — re-enter them via Edit Source before syncing.`
      );
    }

    const skipNote = skipped > 0 ? ` (${skipped} skipped)` : "";
    const restoredFileNote = fileRestoreResult.restoredFiles > 0 || fileRestoreResult.skippedExistingFiles > 0
      ? `; restored ${plural(fileRestoreResult.restoredFiles, "backup file")}${fileRestoreResult.skippedExistingFiles > 0 ? `, skipped ${plural(fileRestoreResult.skippedExistingFiles, "existing file")}` : ""}`
      : "";
    void vscode.window.showInformationMessage(
      `Imported ${plural(imported, "profile")}${mode === "replace" ? " (replaced existing)" : ""}${skipNote}${restoredFileNote}.`
    );
  }

  async function completeReset(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      "This will permanently delete ALL servers, tunnels, serial profiles, local shell profiles, inventory sources, macros, groups, and saved passwords. This cannot be undone.",
      { modal: true },
      "Delete Everything"
    );
    if (confirm !== "Delete Everything") return;

    const typed = await vscode.window.showInputBox({
      title: "Confirm Complete Reset",
      prompt: "Type DELETE to confirm",
      ignoreFocusOut: true,
      validateInput: (value) => value === "DELETE" ? undefined : "Type DELETE to confirm"
    });
    if (typed !== "DELETE") return;

    // CONFIG MUTATION LOCK — both confirmations have already resolved above;
    // everything from here down is the mutation phase, with no further
    // interactive UI, so it's safe to hold the lock across all of it. See
    // importMergeReplace's doc comment for the race class this closes against
    // inventoryCommands' critical sections.
    await configMutationLock.runExclusive(async () => {
      const snapshot = core.getSnapshot();

      // Delete all passwords/passphrases first (before removing servers)
      for (const server of snapshot.servers) {
        await vault.delete(passwordSecretKey(server.id));
        await vault.delete(passphraseSecretKey(server.id));
        await vault.delete(proxyPasswordSecretKey(server.id));
      }

      // Remove all servers
      for (const server of snapshot.servers) {
        await core.removeServer(server.id);
      }

      // Remove all tunnels
      for (const tunnel of snapshot.tunnels) {
        await core.removeTunnel(tunnel.id);
      }

      // Remove all serial profiles
      for (const profile of snapshot.serialProfiles) {
        await core.removeSerialProfile(profile.id);
      }

      // Remove all local shell profiles
      for (const profile of snapshot.localShellProfiles) {
        await core.removeLocalShellProfile(profile.id);
      }

      // Remove all auth profiles
      for (const profile of snapshot.authProfiles) {
        await vault.delete(authProfilePasswordSecretKey(profile.id));
        await vault.delete(authProfilePassphraseSecretKey(profile.id));
        await core.removeAuthProfile(profile.id);
      }

      // Remove all groups
      for (const group of snapshot.explicitGroups) {
        await core.removeExplicitGroup(group);
      }

      // Remove all inventory sources and their vault secrets
      for (const source of snapshot.inventorySources) {
        for (const fieldId of source.secretFieldIds) {
          await vault.delete(inventorySecretKey(source.id, fieldId));
        }
        await core.removeInventorySource(source.id);
      }

      // Clear macros (globalState + vault entries)
      await getActiveMacroStore().clearAll();
      if (context) {
        await context.globalState.update("nexus.macros.migrationNoticeShown", undefined);
      }

      // Reset all settings to defaults
      for (const { section, key } of SETTINGS_KEYS) {
        const config = vscode.workspace.getConfiguration(section);
        recordNexusConfigWrite(`${section}.${key}`, undefined, Date.now());
        await config.update(key, undefined, vscode.ConfigurationTarget.Global);
      }
    });

    void vscode.window.showInformationMessage("All Nexus data has been deleted.");
  }

  // Shared tail for the MobaXterm / SecureCRT importers: no-sessions warning, confirm
  // modal, group + server creation, success toast. `noSessionsLocation` and `sourceName` are
  // the only per-source differences in the user-facing strings; `skipLabel` describes what
  // was skipped ("non-SSH" for both current callers). The inventory importer needs a
  // materially different flow (single modal with a `detail` breakdown, dedupe-aware
  // messaging, non-blocking issue toast) and has its own tail — see `importInventory`.
  async function applyImportedSessions(
    result: ImportParseResult,
    sourceName: string,
    noSessionsLocation: string,
    skipLabel: string = "non-SSH",
    noun: string = "SSH session"
  ): Promise<void> {
    if (result.sessions.length === 0) {
      const note = result.skippedCount > 0
        ? `No ${pluralizeNoun(noun, 0)} found (${result.skippedCount} ${skipLabel} skipped).`
        : `No ${pluralizeNoun(noun, 0)} found in the selected ${noSessionsLocation}.`;
      void vscode.window.showWarningMessage(note);
      return;
    }

    const folderNote = result.folders.length > 0 ? ` in ${result.folders.length} folder(s)` : "";
    const skipNote = result.skippedCount > 0 ? ` (${result.skippedCount} ${skipLabel} skipped)` : "";
    const confirm = await vscode.window.showInformationMessage(
      `Found ${result.sessions.length} ${pluralizeNoun(noun, result.sessions.length)}${folderNote}${skipNote}. Import?`,
      { modal: true },
      "Import"
    );
    if (confirm !== "Import") return;

    for (const folder of result.folders) {
      await core.addGroup(folder);
    }
    for (const session of result.sessions) {
      await core.addOrUpdateServer({
        id: randomUUID(),
        name: session.name,
        host: session.host,
        port: session.port,
        username: session.username,
        authType: "password",
        isHidden: false,
        group: session.folder || undefined
      });
    }

    void vscode.window.showInformationMessage(
      `Imported ${result.sessions.length} ${pluralizeNoun(noun, result.sessions.length)} from ${sourceName}.`
    );
  }

  /** Branch 3 tail: no dialog left to run, just parse-and-apply already-acquired text. */
  async function applyMobaxtermText(text: string): Promise<void> {
    const result = parseMobaxtermSessions(text);
    await applyImportedSessions(result, "MobaXterm", "file");
  }

  /**
   * Branch 3's "declared MobaXterm but no [Bookmarks] section" fallback. Same
   * contract as every other branch: a confidently different signature gets a
   * one-click reroute with the same bytes; anything else (including a merely
   * malformed Bookmarks file) gets the plain error with no button to press.
   */
  async function reportMobaxtermFormatMismatch(text: string, sniff: SniffedFormat): Promise<void> {
    const message = "This doesn't look like a MobaXterm sessions file — no [Bookmarks] section found.";
    if (sniff === "nexus-json") {
      const choice = await vscode.window.showErrorMessage(message, "Import as Nexus Export");
      if (choice === "Import as Nexus Export") await applyNexusExportText(text);
      return;
    }
    if (sniff === "xml") {
      const choice = await vscode.window.showErrorMessage(message, "Import as SecureCRT XML");
      if (choice === "Import as SecureCRT XML") await applySecureCrtXmlText(text);
      return;
    }
    // host-list (the everything-else class): no other signature to reroute to.
    void vscode.window.showErrorMessage(message);
  }

  async function importMobaxterm(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { "MobaXterm INI Files": ["ini"], "All Files": ["*"] },
      title: "Import from MobaXterm"
    });
    if (!uris || uris.length === 0) return;

    const raw = await vscode.workspace.fs.readFile(uris[0]);
    const text = Buffer.from(raw).toString("utf8");

    const sniff = sniffImportFormat(text);
    if (sniff !== "mobaxterm") {
      await reportMobaxtermFormatMismatch(text, sniff);
      return;
    }

    await applyMobaxtermText(text);
  }

  const INVENTORY_MAX_BYTES = 2 * 1024 * 1024;

  async function openInventoryIssuesDocument(issues: InventoryParseIssue[]): Promise<void> {
    const content = issues.map((issue) => `line ${issue.line}: ${issue.text} — ${issue.reason}`).join("\n");
    const doc = await vscode.workspace.openTextDocument({ content, language: "log" });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** Branch 1 / .inventory clipboard source: empty-clipboard warning + 2 MB backstop. */
  async function acquireClipboardText(): Promise<string | undefined> {
    const text = (await vscode.env.clipboard.readText()) ?? "";
    if (!text.trim()) {
      void vscode.window.showWarningMessage("Clipboard is empty.");
      return undefined;
    }
    // Backstop for the clipboard path, which has no URI to stat ahead of time.
    if (Buffer.byteLength(text, "utf8") > INVENTORY_MAX_BYTES) {
      void vscode.window.showErrorMessage("The list exceeds the 2 MB size limit.");
      return undefined;
    }
    return text;
  }

  /** Branch 2 / .inventory file source: stat-first 2 MB guard, then read. */
  async function acquireFileText(dialogOptions: vscode.OpenDialogOptions): Promise<string | undefined> {
    const uris = await vscode.window.showOpenDialog(dialogOptions);
    if (!uris || uris.length === 0) return undefined;

    // Stat before reading: rejects an over-limit file (an accidental large
    // selection, or a file on a remote/virtual filesystem) without loading it
    // — and the Buffer/string copies decoding it would take — into memory.
    const stat = await vscode.workspace.fs.stat(uris[0]);
    if (stat.size > INVENTORY_MAX_BYTES) {
      void vscode.window.showErrorMessage("The list exceeds the 2 MB size limit.");
      return undefined;
    }

    const raw = await vscode.workspace.fs.readFile(uris[0]);
    return Buffer.from(raw).toString("utf8");
  }

  // Bespoke tail for the inventory importer — deliberately not funneled through
  // applyImportedSessions. It needs a single confirm modal (detail breakdown,
  // dedupe-aware wording, a "Show Skipped Lines" escape hatch) and a batched,
  // progress-reported apply step that the MobaXterm/SecureCRT tail has no need for.
  // Shared by the chooser's clipboard/file branches, the .inventory deep link, and
  // every cross-branch "Import as Host List" reroute — all funnel already-acquired
  // text here rather than re-running a source pick.
  async function applyInventoryText(text: string): Promise<void> {
    // Guard here, not just upstream: this is the shared tail every route funnels
    // into — the direct dialog's own stat-first/backstop guard, and every current
    // and future cross-branch "Import as Host List" reroute that hands over bytes
    // already read past a different (unguarded) dialog. A per-caller check cannot
    // cover a reroute it doesn't know about; this one does.
    if (Buffer.byteLength(text, "utf8") > INVENTORY_MAX_BYTES) {
      void vscode.window.showErrorMessage("The list exceeds the 2 MB size limit.");
      return;
    }

    // No-options pass first: tells us whether the list carries its own folder
    // data and how many rows are missing a username, before deciding which of
    // the two prompts below are even necessary.
    const initialParse = parseInventoryList(text);

    let defaultUsername: string | undefined;
    if (initialParse.needsDefaultUsername) {
      const suggested = mostCommonUsername(core.getSnapshot().servers);
      const missingCount = initialParse.missingUsernameCount;
      const username = await vscode.window.showInputBox({
        title: "Default SSH Username",
        prompt: `Applied to the ${missingCount} row${missingCount === 1 ? "" : "s"} that don't specify a username`,
        value: suggested,
        ignoreFocusOut: true
      });
      if (username === undefined) {
        void vscode.window.showWarningMessage("Import canceled.");
        return;
      }
      if (!username.trim()) {
        void vscode.window.showWarningMessage("Import canceled — a username is required.");
        return;
      }
      defaultUsername = username.trim();
    }

    // Skip the folder prompt entirely when the list already has its own folder
    // column — asking again would be a redundant second back-to-back prompt.
    let defaultFolder: string | undefined;
    if (initialParse.folders.length === 0) {
      const folderInput = await vscode.window.showInputBox({
        title: "Folder for Imported Servers (Optional)",
        placeHolder: "e.g. Site7/Access — press Enter to skip",
        ignoreFocusOut: true,
        validateInput: (value) => (normalizeOptionalFolderPath(value) === null ? INVALID_FOLDER_PATH_MESSAGE : undefined)
      });
      if (folderInput === undefined) {
        void vscode.window.showWarningMessage("Import canceled.");
        return;
      }
      const normalizedPrefix = normalizeOptionalFolderPath(folderInput);
      if (normalizedPrefix === null) {
        void vscode.window.showErrorMessage(INVALID_FOLDER_PATH_MESSAGE);
        return;
      }
      defaultFolder = normalizedPrefix;
    }

    const result = parseInventoryList(text, { defaultUsername, defaultFolder });

    const existingKeys = new Set(
      core.getSnapshot().servers.map((server) => `${server.host.toLowerCase()}|${server.port}|${server.username}`)
    );
    const sessions = result.sessions.filter(
      (session) => !existingKeys.has(`${session.host.toLowerCase()}|${session.port}|${session.username}`)
    );
    const dedupedCount = result.sessions.length - sessions.length;
    // Only create groups actually used by the servers that survive dedupe — a
    // folder whose only rows were all duplicates should not appear as an empty group.
    const usedFolders = new Set(sessions.map((session) => session.folder).filter((folder): folder is string => !!folder));
    const folders = result.folders.filter((folder) => usedFolders.has(folder));
    // The 5000-row cap gets its own sentence in the modal below; don't double-count
    // it in the generic "N lines could not be parsed" figure.
    const parseIssues = result.issues.filter((issue) => !issue.reason.startsWith("input truncated"));

    if (sessions.length === 0) {
      if (dedupedCount > 0) {
        const verb = dedupedCount === 1 ? "exists" : "exist";
        void vscode.window.showInformationMessage(
          `All ${dedupedCount} ${pluralizeNoun("server", dedupedCount)} in the list already ${verb} — nothing to import.`
        );
        return;
      }
      const note = result.skippedCount > 0
        ? `No servers found (${result.skippedCount} skipped).`
        : "No servers found in the selected list.";
      void vscode.window.showWarningMessage(note);
      return;
    }

    const detailLines: string[] = [];
    if (folders.length > 0) {
      detailLines.push(`${folders.length} ${pluralizeNoun("folder", folders.length)} will be created.`);
    }
    if (dedupedCount > 0) {
      detailLines.push(`${dedupedCount} ${pluralizeNoun("server", dedupedCount)} you already have will be skipped.`);
    }
    if (parseIssues.length > 0) {
      detailLines.push(`${parseIssues.length} ${pluralizeNoun("line", parseIssues.length)} could not be parsed.`);
    }
    if (result.truncatedCount > 0) {
      detailLines.push(
        `Only the first ${INVENTORY_MAX_ROWS.toLocaleString()} rows were read ` +
          `(${result.truncatedCount.toLocaleString()} ${pluralizeNoun("row", result.truncatedCount)} ignored).`
      );
    }

    // One confirm modal carrying everything the user needs to sanity-check the
    // import, via `detail` — not a chain of toasts a modal can cover before
    // they're read. "Show Skipped Lines" opens the scratch doc without importing;
    // re-run the command afterward once the list looks right.
    const buttons = result.issues.length > 0 ? ["Import", "Show Skipped Lines"] : ["Import"];
    const choice = await vscode.window.showInformationMessage(
      `Import ${sessions.length} ${pluralizeNoun("server", sessions.length)}?`,
      { modal: true, detail: detailLines.join("\n") },
      ...buttons
    );

    if (choice === "Show Skipped Lines") {
      await openInventoryIssuesDocument(result.issues);
      return;
    }
    if (choice !== "Import") return;

    const serverConfigs: ServerConfig[] = sessions.map((session) => ({
      id: randomUUID(),
      name: session.name,
      host: session.host,
      port: session.port,
      username: session.username,
      authType: "password",
      isHidden: false,
      group: session.folder || undefined
    }));

    // Not cancellable: addServersBatch is a single atomic persisted write (see
    // NexusCore), so there is no per-row loop left to check a token against
    // mid-flight — a Cancel button here could only ever fire after the write had
    // already started, leaving every server persisted anyway. Offering a control
    // that can't do what it promises would be worse than not offering one.
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Importing ${serverConfigs.length} ${pluralizeNoun("server", serverConfigs.length)}…`,
        cancellable: false
      },
      async () => {
        await core.addServersBatch(serverConfigs, folders);
      }
    );

    void vscode.window.showInformationMessage(
      `Imported ${serverConfigs.length} ${pluralizeNoun("server", serverConfigs.length)}.`
    );

    // Never an awaited gate (P1): a notification carrying a button does not
    // auto-dismiss, and users routinely ignore corner toasts — awaiting this
    // would silently stall the command on exactly the messy list this feature
    // exists for. Fire-and-forget with a `.then` for the optional follow-up.
    if (parseIssues.length > 0) {
      const verb = parseIssues.length === 1 ? "was" : "were";
      void vscode.window
        .showWarningMessage(`${parseIssues.length} ${pluralizeNoun("line", parseIssues.length)} ${verb} skipped.`, "Show Details")
        .then((detailChoice) => {
          if (detailChoice === "Show Details") {
            void openInventoryIssuesDocument(result.issues);
          }
        });
    }
  }

  /** Chooser row 1 (Paste Host List from Clipboard): clipboard source, straight into the tail. */
  async function importHostListFromClipboard(): Promise<void> {
    const text = await acquireClipboardText();
    if (text === undefined) return;
    await applyInventoryText(text);
  }

  /**
   * Chooser row 2 (Host List File…): file source, then sniff — and if the content
   * confidently indicates a different declared format, stop with a named error, a
   * one-click reroute into that format's own tail, and a second "Import as Host
   * List Anyway" button that proceeds into the inventory tail regardless (the
   * sniff is a heuristic, not proof — a real escape hatch beats a dead end). A
   * generic INI or a bare host list both sniff as "host-list" and fall through to
   * the inventory parser exactly as before; see importFormatSniffer for why that
   * class has no positive signature of its own.
   */
  async function importHostListFile(): Promise<void> {
    const text = await acquireFileText({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { "Host Lists": ["csv", "tsv", "txt"], "All Files": ["*"] },
      title: "Import Host List"
    });
    if (text === undefined) return;

    // Non-terminal on purpose: the sniff is a heuristic, and a genuine host list
    // can trip it (e.g. a hostname list whose first line happens to start with
    // "{"). "Import as Host List Anyway" proceeds into the same inventory tail
    // with the bytes already in hand — the only other way through a false
    // contradiction would be discovering a different command, which no user
    // will deduce. Dismissing the toast without a choice still aborts, same as before.
    const sniff = sniffImportFormat(text);
    if (sniff === "nexus-json") {
      const choice = await vscode.window.showErrorMessage(
        "This looks like a Nexus JSON export, not a host list.",
        "Import as Nexus Export",
        "Import as Host List Anyway"
      );
      if (choice === "Import as Nexus Export") await applyNexusExportText(text);
      else if (choice === "Import as Host List Anyway") await applyInventoryText(text);
      return;
    }
    if (sniff === "xml") {
      const choice = await vscode.window.showErrorMessage(
        "This is an XML file. If it came from SecureCRT, import it as a SecureCRT export.",
        "Import as SecureCRT XML",
        "Import as Host List Anyway"
      );
      if (choice === "Import as SecureCRT XML") await applySecureCrtXmlText(text);
      else if (choice === "Import as Host List Anyway") await applyInventoryText(text);
      return;
    }
    if (sniff === "mobaxterm") {
      const choice = await vscode.window.showErrorMessage(
        "This looks like a MobaXterm INI file.",
        "Import as MobaXterm",
        "Import as Host List Anyway"
      );
      if (choice === "Import as MobaXterm") await applyMobaxtermText(text);
      else if (choice === "Import as Host List Anyway") await applyInventoryText(text);
      return;
    }

    await applyInventoryText(text);
  }

  /** .inventory deep link: keeps its own clipboard/file source pick, then shares the tail. */
  async function importInventory(): Promise<void> {
    const sourcePick = await vscode.window.showQuickPick(
      [
        { label: "Paste from Clipboard", value: "clipboard" as const },
        { label: "Choose File…", value: "file" as const }
      ],
      { title: "Import Servers from List" }
    );
    if (!sourcePick) return;

    const text = sourcePick.value === "clipboard"
      ? await acquireClipboardText()
      : await acquireFileText({
          canSelectFiles: true,
          canSelectMany: false,
          filters: { "Inventory Lists": ["csv", "txt", "tsv"], "All Files": ["*"] },
          title: "Import Servers from List"
        });
    if (text === undefined) return;

    await applyInventoryText(text);
  }

  const SECURECRT_XML_MAX_BYTES = 10 * 1024 * 1024;

  /** Branch 4 tail: parse already-acquired XML text and apply it. */
  async function applySecureCrtXmlText(text: string): Promise<void> {
    // Guard here, not just upstream: this is the shared tail every route funnels
    // into — the direct dialog's own post-read guard below, and every current and
    // future cross-branch "Import as SecureCRT XML" reroute that hands over bytes
    // already read past a different (unguarded) dialog. A per-caller check cannot
    // cover a reroute it doesn't know about; this one does.
    if (Buffer.byteLength(text, "utf8") > SECURECRT_XML_MAX_BYTES) {
      void vscode.window.showErrorMessage("SecureCRT XML file exceeds the 10 MB size limit.");
      return;
    }

    let result: ImportParseResult;
    try {
      result = parseSecureCrtXmlExport(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown parse error";
      void vscode.window.showErrorMessage(`Failed to parse SecureCRT XML: ${message}`);
      return;
    }

    // parseSecureCrtXmlExport returns the same empty shape whether the root lacks
    // a <VanDyke><key name="Sessions"> structure entirely, or has one with zero
    // SSH entries inside it. Only call the extra validate+parse pass below when the
    // result is fully empty (no sessions AND nothing skipped) — any non-empty
    // result, even one that's all skipped entries, already proves the Sessions
    // root exists, so re-checking it would just re-validate and re-parse for free.
    if (result.sessions.length === 0 && result.skippedCount === 0 && !hasSecureCrtSessionsRoot(text)) {
      void vscode.window.showErrorMessage(
        "This XML isn't a SecureCRT export — expected a <VanDyke> document with a Sessions section. In SecureCRT, use Tools → Export Settings."
      );
      return;
    }

    await applyImportedSessions(result, "SecureCRT", "file");
  }

  /** Branches 4 (xml) and 5 (folder): dialog + guards + parser, shared by the chooser rows and the .securecrt deep link. */
  async function runSecureCrtImport(source: "xml" | "folder"): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: source === "xml",
      canSelectFolders: source === "folder",
      canSelectMany: false,
      filters: source === "xml" ? { "SecureCRT XML Files": ["xml"], "All Files": ["*"] } : undefined,
      title: source === "xml" ? "Select SecureCRT XML Export File" : "Select SecureCRT Sessions Folder"
    });
    if (!uris || uris.length === 0) return;

    const inputUri = uris[0];
    const stat = await vscode.workspace.fs.stat(inputUri);
    const unsupportedMsg = "Unsupported SecureCRT input. Select a SecureCRT XML export file or Sessions folder.";

    if (source === "folder") {
      const isDirectory = (stat.type & vscode.FileType.Directory) === vscode.FileType.Directory;
      if (!isDirectory) {
        void vscode.window.showErrorMessage(unsupportedMsg);
        return;
      }

      const files: SecureCrtFileEntry[] = [];

      async function walkDirectory(uri: vscode.Uri, folder: string): Promise<void> {
        const entries = await vscode.workspace.fs.readDirectory(uri);
        for (const [name, type] of entries) {
          const childUri = vscode.Uri.joinPath(uri, name);
          if (type === vscode.FileType.Directory) {
            const childFolder = folder ? `${folder}/${name}` : name;
            await walkDirectory(childUri, childFolder);
          } else if (type === vscode.FileType.File && name.toLowerCase().endsWith(".ini")) {
            const raw = await vscode.workspace.fs.readFile(childUri);
            const content = Buffer.from(raw).toString("utf8");
            const sessionName = name.replace(/\.ini$/i, "");
            files.push({ name: sessionName, folder, content });
          }
        }
      }

      await walkDirectory(inputUri, "");

      if (files.length === 0) {
        void vscode.window.showErrorMessage(
          "No .ini session files found under this folder. Select SecureCRT's Sessions directory (on Windows usually %APPDATA%\\VanDyke\\Config\\Sessions)."
        );
        return;
      }

      const result = parseSecureCrtDirectory(files);
      await applyImportedSessions(result, "SecureCRT", "folder");
      return;
    }

    // Extension is not the gate here — content validation exists
    // (parseSecureCrtXmlExport / hasSecureCrtSessionsRoot below), so a renamed
    // export (e.g. picked via the "All Files" filter) must still import; a non-XML
    // file gets the named content error from applySecureCrtXmlText instead.
    const isFile = (stat.type & vscode.FileType.File) === vscode.FileType.File;
    if (!isFile) {
      void vscode.window.showErrorMessage(unsupportedMsg);
      return;
    }
    const raw = await vscode.workspace.fs.readFile(inputUri);
    if (raw.byteLength > SECURECRT_XML_MAX_BYTES) {
      void vscode.window.showErrorMessage("SecureCRT XML file exceeds the 10 MB size limit.");
      return;
    }
    await applySecureCrtXmlText(Buffer.from(raw).toString("utf8"));
  }

  /** .securecrt deep link: keeps its own XML/folder source pick, then shares runSecureCrtImport. */
  async function importSecureCrt(): Promise<void> {
    const sourcePick = await vscode.window.showQuickPick(
      [
        { label: "SecureCRT XML Export File (.xml)", value: "xml" as const },
        { label: "SecureCRT Sessions Folder", value: "folder" as const }
      ],
      { title: "SecureCRT Import Source" }
    );
    if (!sourcePick) return;

    await runSecureCrtImport(sourcePick.value);
  }

  interface ImportChooserItem extends vscode.QuickPickItem {
    value?: "clipboard" | "hostListFile" | "inventorySource" | "mobaxterm" | "securecrtXml" | "securecrtFolder" | "nexusExport";
  }

  // Row order is deliberate, not alphabetical: bulk host-list add is the lead
  // persona action (README headline, and issue #29's exact need), migration from
  // another client is a once-per-user action, and the Nexus export row — the only
  // one with a destructive Replace mode — is last so it is never the
  // default-focused item; those users already know the product and can
  // type-to-filter straight to it.
  const IMPORT_CHOOSER_ITEMS: ImportChooserItem[] = [
    { label: "add servers in bulk", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(clippy) Paste Host List from Clipboard",
      description: "Hostnames or CSV rows copied from a spreadsheet",
      value: "clipboard"
    },
    {
      label: "$(list-flat) Host List File…",
      description: ".csv, .tsv, or .txt — one device per line",
      value: "hostListFile"
    },
    {
      label: "$(sync) Inventory Source (NetBox)…",
      description: "Live sync — devices stay linked to the source",
      value: "inventorySource"
    },
    { label: "migrate from another client", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(file-code) MobaXterm INI File…",
      description: "Sessions from a MobaXterm .ini bookmarks export",
      value: "mobaxterm"
    },
    {
      label: "$(file-code) SecureCRT XML Export…",
      description: "Created in SecureCRT via Tools → Export Settings",
      value: "securecrtXml"
    },
    {
      label: "$(folder-opened) SecureCRT Sessions Folder…",
      description: "SecureCRT's Config/Sessions directory",
      value: "securecrtFolder"
    },
    { label: "nexus", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(json) Nexus Export File…",
      description: "An encrypted backup or a shared config (.json)",
      value: "nexusExport"
    }
  ];

  /** nexus.config.import: the universal chooser. Asks what the user is importing, then branches. */
  async function importConfig(): Promise<void> {
    const pick = await vscode.window.showQuickPick(IMPORT_CHOOSER_ITEMS, {
      title: "Import",
      placeHolder: "What are you importing?"
    });
    if (!pick?.value) return;

    switch (pick.value) {
      case "clipboard":
        await importHostListFromClipboard();
        break;
      case "hostListFile":
        await importHostListFile();
        break;
      case "inventorySource":
        await vscode.commands.executeCommand("nexus.inventory.addSource");
        break;
      case "mobaxterm":
        await importMobaxterm();
        break;
      case "securecrtXml":
        await runSecureCrtImport("xml");
        break;
      case "securecrtFolder":
        await runSecureCrtImport("folder");
        break;
      case "nexusExport":
        await importNexusExport();
        break;
    }
  }

  return [
    vscode.commands.registerCommand("nexus.config.export", exportShare),
    vscode.commands.registerCommand("nexus.config.export.backup", exportBackup),
    vscode.commands.registerCommand("nexus.config.import", importConfig),
    vscode.commands.registerCommand("nexus.config.import.mobaxterm", importMobaxterm),
    vscode.commands.registerCommand("nexus.config.import.securecrt", importSecureCrt),
    vscode.commands.registerCommand("nexus.config.import.inventory", importInventory),
    vscode.commands.registerCommand("nexus.config.completeReset", completeReset)
  ];
}
