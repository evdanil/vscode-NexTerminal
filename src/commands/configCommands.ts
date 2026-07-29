import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { AuthProfile, LocalShellProfile, ServerConfig, TunnelProfile, SerialProfile } from "../models/config";
import type { MacroTriggerScope, MacroVariable, TerminalMacro } from "../models/terminalMacro";
import { isValidVariableName, MAX_MACRO_VARIABLES, withSanitizedVariables } from "../services/macroVariables";
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
import { validateServerConfig, validateTunnelProfile, validateSerialProfile, validateLocalShellProfile } from "../utils/validation";
import { isValidBinding } from "../macroBindings";
import { getMacros, saveMacros, getActiveMacroStore } from "../macroSettings";
import { validateSettingUpdate } from "../ui/settingsValidation";
import { SETTINGS_META } from "../ui/settingsMetadata";
import { recordNexusConfigWrite } from "../services/terminal/settingsWriteRegistry";
import { validateAndSanitizeHighlightRules } from "../utils/highlightRuleValidation";
import { validateRegexSafety } from "../utils/regexSafety";
import { MAX_SCRIPT_RUNTIME_MS } from "../services/scripts/maxRuntime";
import { MAX_SCRIPT_WAIT_TIMEOUT_MS, MAX_SCRIPT_WAIT_TIMEOUT_SECONDS } from "../services/scripts/defaultTimeout";
import { getConfiguredSettingValue } from "../utils/configurationInspection";

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
  groups?: string[];
  macros?: TerminalMacro[]; // Non-secret fields; secret macros carry `text: ""`
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
  const tally: ImportTally = { imported: 0, skipped: 0 };
  for (const item of items ?? []) {
    ensureId(item as unknown as Record<string, unknown>);
    if (existingIds.has(item.id) || !validate(item)) {
      tally.skipped++;
    } else {
      await add(item);
      tally.imported++;
    }
  }
  return tally;
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

/** Restore one secret bucket (id → secret) into the vault under `keyFn(id)`. */
async function restoreSecrets(
  record: Record<string, string> | undefined,
  keyFn: (id: string) => string,
  vault: SecretVault
): Promise<void> {
  if (!record) return;
  for (const [id, secret] of Object.entries(record)) {
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
    return { ...s, id: newId, username: "user", keyPath: "", proxy: remapProxy(s.proxy, idMap), authProfileId: newAuthProfileId };
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
    .map((m) => withSanitizedVariables({ ...m, id: randomUUID() }));

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

function variableNamesKey(m: TerminalMacro): string {
  // §10 — two macros differing only in their variable declarations must not
  // collide on import/dedupe; append the (declaration-order) variable names.
  return Array.isArray(m.variables) ? m.variables.map((v) => v?.name ?? "").join(",") : "";
}

function keyOf(m: TerminalMacro): string {
  return `${m.name}|${m.text}|${m.triggerPattern ?? ""}|${m.keybinding ?? ""}|${variableNamesKey(m)}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const VALID_MACRO_TRIGGER_SCOPES = new Set<MacroTriggerScope>(["all-terminals", "active-session", "profile"]);

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
 */
function sanitizeImportedMacroVariables(macro: TerminalMacro): void {
  if (!Array.isArray(macro.variables)) {
    delete macro.variables;
    return;
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
}

function sanitizeImportedMacro(raw: TerminalMacro): TerminalMacro {
  const macro: TerminalMacro = { ...raw };
  if (typeof macro.keybinding === "string" && !isValidBinding(macro.keybinding)) {
    delete macro.keybinding;
  }

  // Runs unconditionally — independent of whatever the trigger-sanitization
  // branches below decide — so a macro with no trigger at all (the common case)
  // still gets its variables sanitized.
  sanitizeImportedMacroVariables(macro);

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
    if (typeof macro.triggerCooldown !== "number" || !Number.isFinite(macro.triggerCooldown) || macro.triggerCooldown < 0 || macro.triggerCooldown > 300) {
      delete macro.triggerCooldown;
    }
    if (typeof macro.triggerInterval !== "number" || !Number.isFinite(macro.triggerInterval) || macro.triggerInterval < 1 || macro.triggerInterval > 86400) {
      delete macro.triggerInterval;
    }
    if (typeof macro.triggerInitiallyDisabled !== "boolean") {
      delete macro.triggerInitiallyDisabled;
    }
  }

  // §6.2 — variables and auto-trigger are mutually exclusive. If both survive
  // independent sanitization, keep the variables and strip the trigger fields
  // (consistent with the existing precedent here of stripping trigger config
  // rather than dropping the macro).
  if (Array.isArray(macro.variables) && macro.variables.length > 0 && macro.triggerPattern !== undefined) {
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

export function registerConfigCommands(core: NexusCore, vault: SecretVault, context?: import("vscode").ExtensionContext): vscode.Disposable[] {
  async function exportBackup(): Promise<void> {
    const masterPassword = await promptMasterPassword();
    if (!masterPassword) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Creating encrypted backup\u2026" },
      async () => {
        const snapshot = core.getSnapshot();
        const settings = readSettings();

        // Collect secrets
        const secrets: Record<string, unknown> = {
          passwords: {},
          passphrases: {},
          proxyPasswords: {},
          authProfilePasswords: {},
          authProfilePassphrases: {},
          secretMacros: [],
          fileBackups: []
        };
        const passwords = secrets.passwords as Record<string, string>;
        const passphrases = secrets.passphrases as Record<string, string>;
        const proxyPasswords = secrets.proxyPasswords as Record<string, string>;
        const authProfilePasswords = secrets.authProfilePasswords as Record<string, string>;
        const authProfilePassphrases = secrets.authProfilePassphrases as Record<string, string>;
        for (const server of snapshot.servers) {
          const pw = await vault.get(passwordSecretKey(server.id));
          if (pw) passwords[server.id] = pw;
          const pp = await vault.get(passphraseSecretKey(server.id));
          if (pp) passphrases[server.id] = pp;
          const proxyPw = await vault.get(proxyPasswordSecretKey(server.id));
          if (proxyPw) proxyPasswords[server.id] = proxyPw;
        }
        for (const profile of snapshot.authProfiles) {
          const pw = await vault.get(authProfilePasswordSecretKey(profile.id));
          if (pw) authProfilePasswords[profile.id] = pw;
          const pp = await vault.get(authProfilePassphraseSecretKey(profile.id));
          if (pp) authProfilePassphrases[profile.id] = pp;
        }

        // Collect all macros from the store
        const allMacros = getMacros(); // resolved — secret text included
        // This array sits OUTSIDE `encryptedSecrets`, i.e. in the backup file's
        // cleartext — so a masked variable's plaintext `default` here would be
        // readable without the backup password.
        const nonSecretForTopLevel: TerminalMacro[] = allMacros.map((m) =>
          withSanitizedVariables(m.secret ? { ...m, text: "" } : { ...m })
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
          servers: snapshot.servers,
          tunnels: snapshot.tunnels,
          serialProfiles: snapshot.serialProfiles,
          localShellProfiles: snapshot.localShellProfiles,
          authProfiles: snapshot.authProfiles,
          groups: snapshot.explicitGroups,
          macros: nonSecretForTopLevel,
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

        const count = snapshot.servers.length + snapshot.tunnels.length + snapshot.serialProfiles.length + snapshot.localShellProfiles.length + snapshot.authProfiles.length;
        const fileCount = fileBackups.reduce((sum, folder) => sum + folder.files.length, 0);
        const fileNote = fileCount > 0
          ? ` and ${plural(fileCount, "encrypted .ssh/script file")}`
          : "";
        void vscode.window.showInformationMessage(`Backup saved with ${plural(count, "profile")}${fileNote} to ${uri.fsPath}`);
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
      tally(await addIfValid(remappedServer, validateServerConfig, (e) => core.addOrUpdateServer(e)));
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

  async function importMergeReplace(
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
    }

    const existingIds = mode === "merge"
      ? new Set([
          ...snapshot.servers.map((s) => s.id),
          ...snapshot.tunnels.map((t) => t.id),
          ...snapshot.serialProfiles.map((p) => p.id),
          ...snapshot.localShellProfiles.map((p) => p.id),
          ...snapshot.authProfiles.map((p) => p.id)
        ])
      : new Set<string>();

    let imported = 0;
    let skipped = 0;
    // id-PRESERVING import (distinct from the share path's fresh-id remap): each entity keeps
    // its id and is skipped when that id already exists. Same shape across all five buckets.
    for (const tally of [
      await importPreservingIds(data.servers, existingIds, validateServerConfig, (e) => core.addOrUpdateServer(e)),
      await importPreservingIds(data.tunnels, existingIds, validateTunnelProfile, (e) => core.addOrUpdateTunnel(e)),
      await importPreservingIds(data.serialProfiles, existingIds, validateSerialProfile, (e) => core.addOrUpdateSerialProfile(e)),
      await importPreservingIds(data.localShellProfiles, existingIds, validateLocalShellProfile, (e) => core.addOrUpdateLocalShellProfile(e)),
      await importPreservingIds(data.authProfiles, existingIds, validateAuthProfile, (e) => core.addOrUpdateAuthProfile(e))
    ]) {
      imported += tally.imported;
      skipped += tally.skipped;
    }

    // Clear dangling authProfileId references
    const postImportSnapshot = core.getSnapshot();
    const knownProfileIds = new Set(postImportSnapshot.authProfiles.map((p) => p.id));
    for (const server of postImportSnapshot.servers) {
      if (server.authProfileId && !knownProfileIds.has(server.authProfileId)) {
        await core.addOrUpdateServer({ ...server, authProfileId: undefined });
      }
    }

    if (Array.isArray(data.groups)) {
      for (const group of data.groups) {
        if (typeof group === "string" && group) {
          await core.addGroup(group);
        }
      }
    }

    // Apply macros from import payload
    const incomingResult = collectIncomingMacros(data, decryptedSecrets);
    if (incomingResult !== undefined) {
      const { macros: incomingMacros, unresolvedCount } = incomingResult;
      if (mode === "replace") {
        await saveMacros(incomingMacros);
      } else {
        const existing = getMacros();
        const existingIds = new Set(existing.map((m) => m.id).filter(Boolean) as string[]);
        const merged = [...existing];
        for (const m of incomingMacros) {
          if (m.id && existingIds.has(m.id)) continue;
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
    if (decryptedSecrets) {
      await restoreSecrets(decryptedSecrets.passwords as Record<string, string> | undefined, passwordSecretKey, vault);
      await restoreSecrets(decryptedSecrets.passphrases as Record<string, string> | undefined, passphraseSecretKey, vault);
      await restoreSecrets(decryptedSecrets.proxyPasswords as Record<string, string> | undefined, proxyPasswordSecretKey, vault);
      await restoreSecrets(decryptedSecrets.authProfilePasswords as Record<string, string> | undefined, authProfilePasswordSecretKey, vault);
      await restoreSecrets(decryptedSecrets.authProfilePassphrases as Record<string, string> | undefined, authProfilePassphraseSecretKey, vault);
      fileRestoreResult = await restoreBackupFolders(decryptedSecrets, mode, context);
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
      "This will permanently delete ALL servers, tunnels, serial profiles, local shell profiles, macros, groups, and saved passwords. This cannot be undone.",
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

    void vscode.window.showInformationMessage("All Nexus data has been deleted.");
  }

  /** Most frequently used username among existing servers, or "" if there are none. */
  function mostCommonUsername(servers: ServerConfig[]): string {
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
    value?: "clipboard" | "hostListFile" | "mobaxterm" | "securecrtXml" | "securecrtFolder" | "nexusExport";
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
