import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { AuthProfile, LocalShellProfile, ServerConfig, ServerOrigin, TunnelProfile, SerialProfile } from "../models/config";
import { cloneTemplatedStamps, templatedHasAnyStamp } from "../models/config";
import type { InventorySourceConfig } from "../models/inventory";
import { inventorySecretKey } from "../models/inventory";
import type { DeviceTemplateProfile } from "../models/deviceTemplate";
import type { SavedFilterDefinition } from "../models/savedFilter";
import type { MacroVariable, TerminalMacro } from "../models/terminalMacro";
import { hasImportedCapabilityField, IMPORTED_CAPABILITY_RESET_NOTICE, stripImportedCapabilityFields } from "../models/terminalMacro";
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
  validateDeviceTemplate,
  validateSavedFilter,
  isValidServerOrigin,
  isValidDetachedServerOrigin
} from "../utils/validation";
import { isValidBinding } from "../macroBindings";
import {
  VALID_MACRO_TRIGGER_SCOPES,
  canonicalMacroBinding,
  canonicalMacroRunTarget,
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
import { upgradeHighlightRules } from "../utils/highlightRuleUpgrade";
import { validateRegexSafety } from "../utils/regexSafety";
import { MAX_SCRIPT_RUNTIME_MS } from "../services/scripts/maxRuntime";
import { MAX_SCRIPT_WAIT_TIMEOUT_MS, MAX_SCRIPT_WAIT_TIMEOUT_SECONDS } from "../services/scripts/defaultTimeout";
import { getConfiguredSettingValue } from "../utils/configurationInspection";
import { configMutationLock } from "../services/configMutationLock";
import {
  coerceRetiredStatusPollSeconds,
  readGlobalRetiredStatusPollValue,
  RETIRED_STATUS_POLL_KEY,
  RETIRED_STATUS_POLL_SECTION
} from "../services/inventory/statusPollSettingMigration";
import {
  EVE_NG_PROVIDER_ID,
  EVE_NG_STATUS_POLL_FIELD_ID,
  EVE_NG_STATUS_POLL_MAX_SECONDS,
  EVE_NG_STATUS_POLL_MIN_SECONDS
} from "../services/inventory/providers/eveNgProvider";

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
  /**
   * DEVICE TEMPLATES (issue #48 PR-T1) — backup-only, EXCLUDED from a share
   * export exactly like `inventorySources` (A-M5): a template is fleet-specific
   * wiring (jump-host ids, auth-profile ids) with no meaning in a stranger's
   * workspace. No secrets, so no vault section.
   */
  deviceTemplates?: DeviceTemplateProfile[];
  /**
   * SAVED FILTER DEFINITIONS (issue #48 PR-E) — backup-only, EXCLUDED from a
   * share export like `inventorySources`/`deviceTemplates`: a saved filter is
   * workspace-specific inventory-import wiring with no meaning in a stranger's
   * workspace. No secrets, so no vault section — the query string is the same
   * non-secret data as a source's own Device Filter field.
   */
  savedFilters?: SavedFilterDefinition[];
  groups?: string[];
  macros?: TerminalMacro[]; // Non-secret fields; secret macros carry `text: ""`
  /** Explicit macro folders (`nexus.macros.folders`, §4.1) — carried exactly as `groups` is. */
  macroFolders?: string[];
  settings?: Record<string, unknown>;
  /**
   * RETIRED LAB-STATUS POLL INTERVAL (review D3) — `true` on every export
   * written by a build that HAS the per-source **Lab Status Poll Interval**
   * field, and absent on every export written before it. It exists for exactly
   * one decision: whether an imported source's MISSING interval means "this
   * export predates the field" (carry the retired global value onto it) or "its
   * owner blanked the field to stop polling" (leave it alone) — two states with
   * the identical shape, since the edit form stores no key at all for a blanked
   * number field.
   *
   * Absence is what the import treats as evidence of a pre-field export, and
   * that is sound because the field and this stamp ship in the SAME build: no
   * release writes exports that know the field but omit the stamp. What makes
   * it better than the per-source absence it replaces is that no action in the
   * UI can produce it — blanking a source's interval removes that source's key
   * and can touch nothing else, while removing this would take a text editor.
   * See `importPredatesPerSourceStatusPoll`.
   */
  inventoryStatusPollPerSource?: boolean;
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
  { section: "nexus.scripts", key: "maxRuntimeMs" },
  // RETIRED (2.8.191) — the global lab-status poll interval, whose value now
  // lives on each EVE-NG source's own Lab Status Poll Interval field. Listed
  // for the same reason the legacy script-timeout key above is: an export taken
  // BEFORE the retirement still holds the user's interval, and import drops
  // every key outside SETTINGS_KEY_SET silently and uncounted — the same silent
  // loss the activation migration exists to prevent. Listing it is also what
  // keeps `readSettings` picking it up on a machine whose activation clear
  // could not write (read-only / policy-managed settings.json), so the value
  // survives into the next export instead of dying with the old machine.
  //
  // Like that key, it is CONSUMED by the import and never written back into
  // settings — see the `RETIRED_STATUS_POLL_FULL_KEY` branch in applySettings
  // and the carry in importMergeReplaceLocked. Writing it would only mint a
  // dead key: the extension must ACTIVATE before its own import command can
  // run, and that activation has already marked the migration done, so the
  // restored key would never be read by anything.
  { section: RETIRED_STATUS_POLL_SECTION, key: RETIRED_STATUS_POLL_KEY }
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
const RETIRED_STATUS_POLL_FULL_KEY = `${RETIRED_STATUS_POLL_SECTION}.${RETIRED_STATUS_POLL_KEY}`;

/**
 * Does this payload predate the per-source Lab Status Poll Interval field —
 * i.e. may the retired GLOBAL interval it carries be applied to the sources it
 * creates? (Review D3.)
 *
 * The question exists because the two payload shapes that matter are the same
 * shape. A source exported before the field HAS no interval; a source whose
 * owner BLANKED the field to stop polling also has none, because the edit form
 * stores no key for an empty number field. Carrying onto the first is the point
 * of the whole mechanism; carrying onto the second re-enables unattended
 * polling somebody deliberately switched off — the exact harm the migration's
 * durable marker prevents locally, arriving through a backup instead.
 *
 * So the gate is payload-wide, and rests on two pieces of evidence that a
 * deliberate blank cannot produce:
 *
 *  1. **The export's own stamp.** `inventoryStatusPollPerSource` is written by
 *     every export from a build that has the field. Blanking a field in the UI
 *     cannot remove it; only hand-editing the JSON can.
 *  2. **Any EVE-NG source in the payload answering the field.** One EVE-NG
 *     source carrying `statusPollSeconds` proves the exporting build knew the
 *     field, so every ABSENT value in that same payload is an answer ("off"),
 *     not a gap. Blanking one source cannot remove the key from the others.
 *     Scoped to EVE-NG because the id is a provider's field name and not a
 *     reserved word — see the note at the check itself.
 *
 * Be straight about the limit: a genuinely old export contains no positive "I
 * predate the field" marker — there was nothing to write one with — so the
 * decision to carry ultimately rests on the ABSENCE of both signals above.
 * That absence is sound rather than circular because the field and the stamp
 * ship in the same build: no released version produces an export that knows the
 * field yet lacks the stamp. The residual case is a payload from an
 * intermediate development build (field present, stamp absent) in which EVERY
 * source's interval was blanked, so signal 2 has nothing to find either. That
 * one is chosen against knowingly, and it is the direction the choice should
 * fall: not carrying is recoverable — the user types the number into the
 * field — while re-enabling polling behind somebody's back is not.
 */
function importPredatesPerSourceStatusPoll(data: NexusConfigExport): boolean {
  if (data.inventoryStatusPollPerSource === true) {
    return false;
  }
  const sources = Array.isArray(data.inventorySources) ? data.inventorySources : [];
  // EVE-NG SOURCES ONLY. `statusPollSeconds` is EVE-NG's field id, not a
  // reserved word: provider registration is a public API and puts no constraint
  // on field ids, so a third-party provider may define one of its own under the
  // same name. Reading the id across every provider would let such a source
  // classify a genuinely OLD backup as post-migration, and the legacy EVE-NG
  // sources in that same backup would silently lose the interval this carry
  // exists to preserve. Only an EVE-NG source answering the field is evidence
  // that the exporting build knew EVE-NG's new field — the same reason the
  // carry itself, and the activation migration, re-check `providerId` before
  // writing an EVE-NG-only field into a source's config.
  return !sources.some(
    (source) =>
      source
      && typeof source === "object"
      && source.providerId === EVE_NG_PROVIDER_ID
      && source.config?.[EVE_NG_STATUS_POLL_FIELD_ID] !== undefined
  );
}

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
    // Upgrade as well as validate. Import is the one path that carries a rule
    // array in from ANOTHER machine — usually an older install, which is
    // exactly where the pre-2.8.187 truncating IPv6 pattern and the
    // pre-2.8.182 nameless rules live. The one-shot activation migration has
    // already run by now, so importing the raw payload would re-pollute global
    // settings with the stale snapshot this release exists to heal, with no
    // second chance to fix it until the next restart.
    const rules = validateAndSanitizeHighlightRules(value);
    return rules ? { ok: true, value: upgradeHighlightRules(rules).rules } : { ok: false };
  },
  "nexus.scripts.maxRuntimeMs": (value) =>
    validBoundedNumber(value, 0, MAX_SCRIPT_RUNTIME_MS) ? { ok: true, value } : { ok: false },
  "nexus.scripts.defaultTimeout": (value) =>
    validBoundedNumber(value, 100, MAX_SCRIPT_WAIT_TIMEOUT_MS) ? { ok: true, value } : { ok: false }
  // No entry for the retired `nexus.inventory.statusPollSeconds`: this table is
  // consulted only for keys that go THROUGH to settings, and that one is
  // consumed by applySettings' own branch instead (which validates it there).
};

/** What `applySettings` extracted but did NOT write to settings. */
interface AppliedSettingsCarry {
  /**
   * The retired global lab-status poll interval, after the migration's own
   * coercion. Present only when the payload carried a valid one; the caller
   * decides which sources (if any) may receive it.
   */
  retiredStatusPollSeconds?: number;
}

function readSettings(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const { section, key } of SETTINGS_KEYS) {
    const config = vscode.workspace.getConfiguration(section);
    const fullKey = `${section}.${key}`;
    // RETIRED LAB-STATUS POLL INTERVAL (review D1) — GLOBAL ONLY, through the
    // migration's own reader. Every other key is captured at its EFFECTIVE
    // scope, which is what a backup of "how this install behaves" should hold.
    // This one is different because of where its value ENDS UP: the import
    // carries it onto inventory sources, and a source is machine-wide. Reading
    // the effective scope here would capture the very workspace-scoped number
    // the activation migration refuses to promote, and the restore would then
    // promote it on the next machine — the outcome the Global-only rule was
    // adopted to remove, re-entering through the export instead of activation.
    const value = fullKey === RETIRED_STATUS_POLL_FULL_KEY
      ? readGlobalRetiredStatusPollValue(config)
      : getConfiguredSettingValue(config, key);
    if (value !== undefined) {
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


/** The result of reading a payload's settings, before anything is written. */
interface PartitionedImportSettings {
  /** Keys destined for `settings.json`, still to be validated at write time. */
  writable: Record<string, unknown>;
  /** Keys consumed here and never written — see `AppliedSettingsCarry`. */
  carry: AppliedSettingsCarry;
  /** Values rejected during the partition; the write phase adds its own. */
  invalidCount: number;
}

/**
 * Reads the payload and decides what each key is, WITHOUT writing anything
 * (review D4). Split out from the write phase because the two have different
 * failure modes and only one of them is fallible: `config.update` rejects on
 * policy-managed or otherwise unwritable configuration, and when the carry was
 * extracted behind those writes, one such rejection threw before it could be
 * returned. The inventory sources are persisted EARLIER in the same import, so
 * a retry in merge mode skips their ids, `importedIds` comes back empty, and
 * the cadence could never be applied by any later run — a partial settings
 * failure stranding freshly imported sources with polling off, for good.
 *
 * Pure: no `vscode` writes, nothing to throw, so a caller can take the carry
 * first and let the writes fail on their own terms.
 */
function partitionImportedSettings(settings: Record<string, unknown>): PartitionedImportSettings {
  const allowedSettings: Record<string, unknown> = {};
  let invalidCount = 0;
  let legacyDefaultTimeoutSeconds: number | undefined;
  let retiredStatusPollSeconds: number | undefined;
  for (const [fullKey, value] of Object.entries(settings)) {
    if (!SETTINGS_KEY_SET.has(fullKey)) {
      continue;
    }

    // RETIRED lab-status poll interval (review C2) — extracted, never written.
    // The activation migration cannot pick this up: activation necessarily
    // happened before this command could run, and a pass that found no key
    // marks itself done, so a key restored here is read by nobody. Bounded
    // exactly as the retired setting itself was, so a hand-edited or corrupt
    // export is skipped and COUNTED rather than silently coerced into a number
    // the user never chose; the coercion below is the migration's own, so an
    // in-range value lands identically whichever path carried it.
    if (fullKey === RETIRED_STATUS_POLL_FULL_KEY) {
      if (validBoundedNumber(value, EVE_NG_STATUS_POLL_MIN_SECONDS, EVE_NG_STATUS_POLL_MAX_SECONDS)) {
        retiredStatusPollSeconds = coerceRetiredStatusPollSeconds(value);
      } else {
        invalidCount++;
      }
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

  return { writable: allowedSettings, carry: { retiredStatusPollSeconds }, invalidCount };
}

/**
 * The fallible half: validates and WRITES what the partition kept, then warns
 * once about everything either half rejected. Rejects exactly as
 * `config.update` does, so an import still reports a settings write it could
 * not make — the caller decides what it has already committed by then.
 */
async function writeImportedSettings(partitioned: PartitionedImportSettings): Promise<void> {
  let invalidCount = partitioned.invalidCount;

  for (const [fullKey, value] of Object.entries(partitioned.writable)) {
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

/**
 * Partition + write, for the callers that have nothing to do with the carry (a
 * share import, which discards it). The import that DOES use the carry calls
 * the two halves itself, so a failed write cannot strand it — see review D4 in
 * `partitionImportedSettings`.
 */
async function applySettings(settings: Record<string, unknown>): Promise<AppliedSettingsCarry> {
  const partitioned = partitionImportedSettings(settings);
  await writeImportedSettings(partitioned);
  return partitioned.carry;
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
  if (obj.deviceTemplates !== undefined && !Array.isArray(obj.deviceTemplates)) {
    return false;
  }
  if (obj.savedFilters !== undefined && !Array.isArray(obj.savedFilters)) {
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
 *
 * ADOPT 1 — `formerlySynced` is sanitized here on the same terms, because it
 * arrives the same way and is read by the same engine: a backup keeps the
 * marker verbatim (full fidelity), so a hand-edited or version-skewed one lands
 * here malformed and would otherwise reach the adoption rule, which decides on
 * `providerId`/`externalId` whether a source may claim an existing record whole.
 * The two strips are independent — a row carrying both malformed loses both and
 * is still kept — because the cost of a strip is only that the field stops being
 * trusted, never that the user loses the server.
 *
 * ADOPT 1 (mutual exclusion) — with ONE coupling between them, in one direction:
 * a marker is dropped when the origin beside it was stripped, however well-formed
 * the marker itself is.
 *
 * `origin` and `formerlySynced` are mutually exclusive by construction — every
 * writer sets one and clears the other — and the engine's first eligibility
 * clause (`origin === undefined`) is what makes a record that somehow holds both
 * inert rather than dangerous. Stripping the origin is exactly what removes that
 * clause's protection: a row arriving with a corrupt origin and an intact marker
 * came in unadoptable and would leave ADOPTABLE, claimable whole — name, address,
 * folder, prune policy included — by a source that never kept it. A sanitizer may
 * cost an untrusted field its trust; it must never let a corrupt payload GAIN
 * authority it did not arrive with.
 *
 * Dropping the marker is the only resolution the evidence supports. The record
 * asserts two contradictory things about who manages it, and the half that would
 * survive is the half that confers something. Repairing instead is not available:
 * the origin is malformed precisely because its own `externalId` cannot be
 * trusted, so there is nothing to re-derive a truthful marker from. The cost is
 * the marker's standing cost — the server stops being adoptable, so a later sync
 * adds a duplicate and says so — and never the server itself.
 *
 * Scoped to the malformed case ON PURPOSE, not widened into "a record may never
 * hold both". A well-formed origin keeps its marker here because nothing has
 * removed the clause that makes it inert, and because a record legitimately holds
 * both for a moment (the server-edit path reattaches a live origin over a snapshot
 * that still carries the marker). Normalizing there would destroy history at a
 * boundary that was only asked to reject what it cannot trust.
 */
async function addServerSanitizingOrigin(server: ServerConfig, add: (entity: ServerConfig) => Promise<void>): Promise<void> {
  let sanitized: ServerConfig = server;
  let originWasStripped = false;
  if (sanitized.origin !== undefined && !isValidServerOrigin(sanitized.origin)) {
    console.warn("[Nexus] Imported server has a malformed origin; stripping it:", JSON.stringify(sanitized.origin));
    const { origin: _origin, ...rest } = sanitized;
    sanitized = rest as ServerConfig;
    originWasStripped = true;
  }
  if (sanitized.formerlySynced !== undefined) {
    const markerIsMalformed = !isValidDetachedServerOrigin(sanitized.formerlySynced);
    if (markerIsMalformed || originWasStripped) {
      console.warn(
        markerIsMalformed
          ? "[Nexus] Imported server has a malformed formerlySynced marker; stripping it:"
          : "[Nexus] Imported server carried a formerlySynced marker beside a malformed origin; stripping the marker too:",
        JSON.stringify(sanitized.formerlySynced)
      );
      const { formerlySynced: _formerlySynced, ...rest } = sanitized;
      sanitized = rest as ServerConfig;
    }
  }
  await add(sanitized);
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

  // ADDRESSLESS (Codex P1 review MINOR-1) — DROP addressless placeholders from a
  // shared export entirely. A share strips `origin` (a synced marker is local
  // only), which would leave an `addressless:true, host:""` record the recipient
  // can never connect to, re-address, or upgrade — and one that violates the
  // "addressless is written ONLY by inventory sync" invariant on their machine.
  // They are meaningless without their source, so they do not travel.
  servers = servers.filter((s) => s.addressless !== true);

  // Second pass: assign new IDs for servers
  for (const s of servers) {
    idMap.set(s.id, randomUUID());
  }

  // Build sanitized auth profiles (redact credentials, keep name)
  //
  // BOTH links are collected (issue #48 §3.1). A profile used ONLY as a server's
  // IPMI credentials is referenced exactly as much as one used for SSH, and
  // collecting only `authProfileId` would leave every such profile out of the
  // bundle while the servers that name it still ship — a link the recipient
  // cannot resolve, on the field the export exists to carry.
  const referencedProfileIds = new Set(
    servers.flatMap((s) => [s.authProfileId, s.ipmiAuthProfileId]).filter(Boolean) as string[]
  );
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
    // Remapped through the SAME idMap, and dropped to `undefined` when the
    // target is not in the export — `remapProxy`'s rule for an out-of-export
    // jump host, for the same reason: the spread below would otherwise carry the
    // SENDER's id verbatim, which on the receiving side either resolves to
    // nothing or (worse) to an unrelated local profile that happens to hold it.
    const newIpmiAuthProfileId = s.ipmiAuthProfileId ? idMap.get(s.ipmiAuthProfileId) : undefined;
    // JUMP-HOST IPMI ROUTING (issue #48 PR-C) — an id reference INTO THE SERVER
    // LIST, so it remaps through the SAME idMap as `proxy.jumpHostId` (every
    // server's new id is already assigned in the second pass above), and takes
    // `remapProxy`'s out-of-export disposition: when the gateway server is not in
    // the bundle the field is dropped to `undefined`, never carried stale. An
    // unset gateway means "the BMC is reachable locally" — a safe working default
    // on the recipient — whereas a stale id can only fail confusingly at run time.
    const newIpmiGatewayServerId = s.ipmiGatewayServerId ? idMap.get(s.ipmiGatewayServerId) : undefined;
    // §B6 — a share export travels to another person/machine; a synced-server marker
    // (sourceId/externalId) names an inventory source that only exists locally and
    // would be meaningless (and misleading) on the receiving end.
    //
    // ADOPT 1 — `formerlySynced` goes with it, for exactly that reason and one
    // more. It is the same kind of local-only reference (sourceId/sourceName name
    // a source that was removed on the EXPORTING machine and never existed on the
    // receiving one), but unlike a dangling `origin` it is not inert: it is the
    // adoption key. Left on a shared record, the recipient's own source — same
    // provider, same device — would silently claim a server it never synced, and
    // take its whole lifecycle including the prune policy. Backups keep the marker
    // (full fidelity, same machine); a share never does.
    return {
      ...s,
      id: newId,
      username: "user",
      keyPath: "",
      proxy: remapProxy(s.proxy, idMap),
      authProfileId: newAuthProfileId,
      ipmiAuthProfileId: newIpmiAuthProfileId,
      ipmiGatewayServerId: newIpmiGatewayServerId,
      origin: undefined,
      formerlySynced: undefined
    };
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
    canonicalMacroVariableTerms(m),
    // Issue #48 — where the macro RUNS is something the runtime can see (a
    // session send versus a local terminal versus a browser window), so two
    // records differing only in `runIn` are two macros and must not collide.
    canonicalMacroRunTarget(m)
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
  // CAPABILITY FLAGS are stripped on EVERY import path — this backup/share path
  // and the legacy-settings absorb in `persistLegacyMigration`
  // (storage/vscodeMacroStore.ts) — from one shared definition
  // (`stripImportedCapabilityFields`, models/terminalMacro.ts). See that
  // module's `IMPORTED_CAPABILITY_FIELDS` doc for why consent never survives an
  // import and why a new flag must join the list as part of adding it. The strip
  // deletes rather than normalizes to `false`, so a re-export carries no decision
  // the importing user never made.
  const macro: TerminalMacro = stripImportedCapabilityFields(raw);
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
): { macros: TerminalMacro[]; unresolvedCount: number; capabilityStripped: boolean } | undefined {
  // New format (version 2): top-level `macros` + id-keyed secret blobs
  if (Array.isArray(data.macros)) {
    const secretBlobs = (decryptedSecrets?.secretMacros as Array<{ id?: string; name?: string; text?: string }> | undefined) ?? [];
    const byId = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const blob of secretBlobs) {
      if (blob.id && typeof blob.text === "string") byId.set(blob.id, blob.text);
      if (blob.name && typeof blob.text === "string") byName.set(blob.name, blob.text);
    }
    // S3 — recorded off the RAW records, before sanitizeImportedMacro strips them,
    // so an imported gateway-routed/credentialed macro is reset-with-notice rather
    // than reset-silently. Presence, not per-macro count: the notice fires once.
    const capabilityStripped = data.macros.some((m) => hasImportedCapabilityField(m));
    let unresolvedCount = 0;
    const macros = data.macros.map<TerminalMacro>((m) => {
      if (m.secret) {
        const plain = (m.id && byId.get(m.id)) ?? (m.name && byName.get(m.name)) ?? "";
        if (!plain) unresolvedCount++;
        return sanitizeImportedMacro({ ...m, text: plain });
      }
      return sanitizeImportedMacro({ ...m });
    });
    return { macros, unresolvedCount, capabilityStripped };
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
    const capabilityStripped = legacy.some((m) => hasImportedCapabilityField(m));
    let unresolvedCount = 0;
    const macros = legacy.map<TerminalMacro>((m) => {
      if (m.secret) {
        const plain = byName.get(m.name ?? "") ?? m.text ?? "";
        if (plain === "") unresolvedCount++;
        return sanitizeImportedMacro({ ...m, text: plain });
      }
      return sanitizeImportedMacro({ ...m });
    });
    return { macros, unresolvedCount, capabilityStripped };
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
  // DEVICE TEMPLATES (PR-T1) — captured in the same lock; no secrets, so no vault section.
  deviceTemplates: DeviceTemplateProfile[];
  // SAVED FILTER DEFINITIONS (PR-E) — captured in the same lock; no secrets.
  savedFilters: SavedFilterDefinition[];
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
    const deviceTemplates = snapshot.deviceTemplates;
    const savedFilters = snapshot.savedFilters;

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
      deviceTemplates,
      savedFilters,
      sourcesWithMissingSecrets
    };
  });
}

/**
 * REVIEW FINDING (P1, cross-instance adoption) took a `registry` parameter here
 * for ONE purpose — the import-rollback path stamped a `formerlySynced` marker
 * and asked the registered provider which DEPLOYMENT the rolled-back servers
 * came from. REVIEW FINDING (P1, the instance guard fed from the wrong place)
 * removed the need: the marker now COPIES `ServerOrigin.syncedInstanceKey` off
 * each server being detached, which is the deployment the sync that created it
 * actually read from, rather than re-deriving one from a source config that may
 * have been repointed since (or, on this path, restored from a backup that
 * describes a different deployment entirely). Nothing in this module consults a
 * provider any more, so the parameter is gone rather than left unused — a
 * threaded-through dependency with no reader is an invitation to give it a
 * second, unexamined job.
 */
export function registerConfigCommands(
  core: NexusCore,
  vault: SecretVault,
  context?: import("vscode").ExtensionContext
): vscode.Disposable[] {
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
          // Review D3 — unconditional, on both export paths, so an import can
          // tell a source with no interval apart from a source whose interval
          // its owner blanked. See the field's contract on NexusConfigExport.
          inventoryStatusPollPerSource: true,
          servers: captured.servers,
          tunnels: snapshot.tunnels,
          serialProfiles: snapshot.serialProfiles,
          localShellProfiles: snapshot.localShellProfiles,
          authProfiles: captured.authProfiles,
          inventorySources: captured.inventorySources,
          deviceTemplates: captured.deviceTemplates,
          savedFilters: captured.savedFilters,
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
      // Stamped like a backup (review D3). A share export carries no
      // `inventorySources`, so nothing in it can receive the retired interval —
      // it is stamped anyway so this build has ONE rule about what its exports
      // say about themselves, not a per-path exemption to remember.
      inventoryStatusPollPerSource: true,
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
      // #84 P1 (Codex, serialization audit) — a share import adds servers/groups/
      // etc. through per-entity full-snapshot writes; serialize it under
      // configMutationLock so a concurrent background port-heal (or any writer)
      // cannot clobber it or be reverted by it. importShareData runs no blocking
      // prompt (only fire-and-forget notifications), so holding the lock across
      // it is safe.
      await configMutationLock.runExclusive(() => importShareData(data));
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

    // REVIEW FINDING (P2) — the ids of the profiles that actually LANDED, which is
    // NOT the auth-profile half of `idMap`. `idMap` is filled in the first pass,
    // before a single record has been validated, so a profile rejected by
    // `validateAuthProfile` still holds a fresh id there — and a server remapped
    // through `idMap` alone arrives linked to a profile that was never imported.
    // Nothing downstream notices: the server persists with a link that resolves to
    // nothing, `SilentAuthSshFactory` finds no profile and silently falls back to
    // the server's own credentials, and no message anywhere says the link is dead.
    // The reachable shape is the one `validateAuthProfile` was taught to reject a
    // round ago (a non-string `keyPath`), but nothing about this is specific to it.
    //
    // WHY AT CONSTRUCTION rather than a post-import sweep like the backup path's:
    // both reach the same end state — no record left pointing at a profile that
    // does not exist — and each expresses that one rule where its own path can. The
    // backup path preserves ids on BOTH sides, so it has no remap to build and the
    // post-import snapshot is the only place a dangle becomes visible; it also has
    // to inspect records it did not write, because merge mode keeps a local record
    // in preference to the payload's. The share path builds every link value itself
    // from a map it owns, so the check belongs there — and keeping it there means a
    // share import still never rewrites a local record the payload never mentioned.
    const importedProfileIds = new Set<string>();

    for (const profile of authProfiles) {
      const newId = idMap.get(profile.id)!;
      const remappedProfile: AuthProfile = {
        ...profile,
        id: newId
      };
      const added = await addIfValid(remappedProfile, validateAuthProfile, (e) => core.addOrUpdateAuthProfile(e));
      if (added) {
        importedProfileIds.add(newId);
      }
      tally(added);
    }

    /**
     * The one lens every profile reference on an imported server passes through:
     * remap through `idMap`, then keep it only if that profile survived import.
     * `undefined` for anything else — a profile absent from the payload, one
     * rejected on import, or an id `idMap` re-pointed at a SERVER because a
     * malformed payload reused it across the two buckets.
     */
    const linkToImportedProfile = (id: string | undefined): string | undefined => {
      if (!id) {
        return undefined;
      }
      const remapped = idMap.get(id);
      return remapped !== undefined && importedProfileIds.has(remapped) ? remapped : undefined;
    };

    /**
     * `origin.syncedAuthProfileId` is a profile reference too — the sync's record of
     * which profile IT linked — and it is the only one nothing here used to remap,
     * so on a payload carrying an origin it named a stranger's id unconditionally.
     * It goes through the same lens as the link for the reason the backup path's
     * sweep drops the two together: a stamp naming a profile that is not here reads
     * as a per-server opt-out nobody chose and locks that server out of retro-apply
     * for good. Passed through untouched when there is no stamp, so a server that
     * never carried one does not acquire the field.
     *
     * REVIEW FINDING (P2) — the gate is `isValidServerOrigin`, not `!== undefined`.
     * `ServerOrigin | undefined` is what the payload DECLARES, not what it can
     * contain: `isValidExport` only checks that `servers` is an array, and
     * `validateServerConfig` deliberately accepts a row whose `origin` is
     * malformed (F13/FIX 5 — a bookkeeping field must not cost a server its
     * record). So `"origin": null` on an otherwise-valid server reaches here, and
     * `origin.syncedAuthProfileId` threw a TypeError that aborted the whole
     * import — with everything imported before it already persisted.
     *
     * Anything this guard rejects is returned UNTOUCHED rather than dropped or
     * repaired here: `addServerSanitizingOrigin` below is the one place that
     * decides what a malformed marker costs (the origin, never the server), and
     * it already handles null the same way it handles a numeric `externalId`.
     * Remapping a stamp on an origin that is about to be stripped whole would be
     * work with no reader anyway.
     */
    const remapOriginStamp = (origin: ServerOrigin | undefined): ServerOrigin | undefined => {
      // REVIEW FINDING (P2, PR #66 Codex round 7) — the guard used to early-return
      // whenever `syncedAuthProfileId === undefined`, which left BOTH
      // `origin.templated` IPMI stamps in the EXPORTER's id namespace on any origin
      // that carried only templated stamps. Proceed when EITHER the SSH auth stamp
      // is set OR the origin carries any templated stamp — an origin whose ONLY
      // stamps are the templated IPMI ones must still be remapped, or its stamps
      // survive import as foreign ids and the template matrix reads a PERMANENT
      // hand divergence (row 6), locking a field that was actually template-owned.
      if (
        !isValidServerOrigin(origin) ||
        (origin.syncedAuthProfileId === undefined && !templatedHasAnyStamp(origin.templated))
      ) {
        return origin;
      }
      // `syncedAuthProfileId` through the SAME lens the SSH auth VALUE uses
      // (`linkToImportedProfile`); `linkToImportedProfile(undefined)` is `undefined`,
      // so an origin carrying only templated stamps keeps `syncedAuthProfileId`
      // absent, exactly as before.
      const next: ServerOrigin = { ...origin, syncedAuthProfileId: linkToImportedProfile(origin.syncedAuthProfileId) };
      // Each templated stamp is remapped through the SAME lens its VALUE passes
      // through on the remapped server below: the auth stamp through
      // `linkToImportedProfile` (FINAL — profiles are fully resolved here), the
      // gateway stamp RAW through `idMap` (mirroring the value's raw remap at the
      // `ipmiGatewayServerId:` line below; the final `linkToImportedServer`
      // narrowing happens in the finalize loop, since the surviving-server set is
      // not known at this point). Collapse the rebuilt bag via `templatedHasAnyStamp`
      // so a template-owned field survives as `cur === stamp` in LOCAL ids and a
      // real divergence is preserved. `formerlySynced` is dropped whole on share
      // import below, so no twin remap is needed here.
      if (origin.templated !== undefined) {
        const templated = cloneTemplatedStamps(origin.templated);
        templated.ipmiAuthProfileId = linkToImportedProfile(origin.templated.ipmiAuthProfileId);
        templated.ipmiGatewayServerId = origin.templated.ipmiGatewayServerId
          ? (idMap.get(origin.templated.ipmiGatewayServerId) ?? undefined)
          : undefined;
        next.templated = templatedHasAnyStamp(templated) ? templated : undefined;
      }
      return next;
    };

    /**
     * The NEW ids of the servers that SURVIVE import — the server analogue of
     * `importedProfileIds`, and the lens the IPMI gateway link passes through (see
     * `linkToImportedServer` below). Built in FULL before any gateway link is
     * finalized so a FORWARD reference (target A whose gateway B sits LATER in the
     * `servers` array) still resolves: the gate is "B survived import", never "B was
     * added before A was reached".
     *
     * Computing the set up front is sound because `validateServerConfig`'s verdict
     * turns only on a server's OWN fields (id/name/host/port/username/authType and
     * the shapes of a handful of optionals) — never on whether its references
     * resolve, and in particular NOT on the VALUE of `ipmiGatewayServerId` (every
     * non-empty string and `undefined` passes identically). So a server's survival
     * is fixed before its gateway link is, and gating that link cannot change which
     * servers survive. Each remapped server is built ONCE here (proxy, profile links
     * and origin already remapped, gateway raw-remapped through `idMap`) and that
     * exact shape validated; the finalize loop below only narrows the gateway field.
     */
    const remappedServers: ServerConfig[] = [];
    const importedServerIds = new Set<string>();
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
      /**
       * ADOPT 1 — the one field a share import DROPS rather than remaps, and
       * deliberately NOT symmetric with `origin` one line below it.
       *
       * A stale `origin` is inert on the recipient: no source here holds that
       * id, nothing on this machine dereferences it, and no sync can act
       * through it. `formerlySynced` is the opposite — it is the adoption key,
       * and `planInventorySync` matches it on `providerId` + `externalId` + the
       * server's CURRENT address, never on `sourceId`. So a marker riding in on
       * a share file is a live claim here: the recipient's own same-provider
       * source would silently take a shared record over whole — name, address,
       * folder, and the prune policy that can later delete it — for a source
       * the recipient never removed and a device they never synced.
       *
       * The provenance it asserts is also false on this machine. The marker
       * means "a source HERE synced this server, and you kept it when you
       * removed that source". The recipient did neither; what they did was
       * accept a file from someone else, which makes the record theirs by hand
       * — and the governing rule is that a server the user made by hand is
       * never adopted. A share file is untrusted third-party content by
       * construction (this path already replaces `username`/`keyPath` for that
       * reason), so the marker is exactly the kind of assertion a trust
       * boundary exists to refuse.
       *
       * `sanitizeForSharing` already strips it on the way out, so a file this
       * extension produced carries none and this costs it nothing. What is left
       * is the untrusted route — a hand-edited share file, or one written by a
       * build predating that export strip — which is the whole reason the check
       * belongs on the import side too.
       *
       * This is not the "an import must never silently delete a record the user
       * still holds" case the auth-profile sweep above is careful about: the
       * marker is bookkeeping, not a credential, and dropping it drops nothing
       * else — the server itself lands intact, with its links remapped.
       *
       * The BACKUP path keeps a well-formed marker on purpose (see
       * `addServerSanitizingOrigin`): a backup restores the same machine's own
       * history, where the marker is true, and stripping it there would make
       * every restored kept server permanently unadoptable.
       */
      const remappedServer: ServerConfig = {
        ...server,
        id: idMap.get(server.id)!,
        proxy: remappedProxy,
        authProfileId: linkToImportedProfile(server.authProfileId),
        // The BMC credential link goes through the same lens: it is a profile
        // reference like any other, and a share bundle's ids are the sender's.
        ipmiAuthProfileId: linkToImportedProfile(server.ipmiAuthProfileId),
        // The IPMI gateway link is a SERVER-LIST reference, not a profile one, so
        // it remaps through the same `idMap` as `proxy.jumpHostId` (server half) —
        // NOT `linkToImportedProfile`. Raw-remapped here; FINALIZED below once the
        // full surviving-server set is known (`linkToImportedServer`), because a
        // raw remap alone keeps a fresh id even for a gateway that failed import.
        ipmiGatewayServerId: server.ipmiGatewayServerId ? (idMap.get(server.ipmiGatewayServerId) ?? undefined) : undefined,
        origin: remapOriginStamp(server.origin),
        formerlySynced: undefined
      };
      remappedServers.push(remappedServer);
      if (validateServerConfig(remappedServer)) {
        importedServerIds.add(remappedServer.id);
      }
    }

    /**
     * The gateway link's analogue of `linkToImportedProfile`, one bucket over: the
     * IPMI gateway is a SERVER-LIST reference, so it remaps through `idMap` (the
     * server half, like `proxy.jumpHostId`) — but the raw remap alone is not
     * enough. `idMap` is filled for EVERY incoming server in the first pass, before
     * a single one is validated, so `idMap.get(gatewayId)` returns a fresh id even
     * when the referenced gateway FAILED `validateServerConfig` and was skipped —
     * the target would then persist a fresh id no imported server holds (still
     * dangling), and because the server and profile halves SHARE `idMap`, a
     * malformed/hand-crafted payload whose gateway id equals a profile id could even
     * resolve cross-namespace to a profile's new id. Keep it ONLY when the remapped
     * id is in the surviving-server set; `undefined` for anything else — gateway
     * absent from the bundle, rejected on import, or a cross-bucket id collision.
     * `undefined` reads as "the BMC is reachable locally", exactly as
     * `resolveIpmiGatewayServer` already treats a dangling id at the run site.
     */
    const linkToImportedServer = (remapped: string | undefined): string | undefined =>
      remapped !== undefined && importedServerIds.has(remapped) ? remapped : undefined;

    for (const remappedServer of remappedServers) {
      // Narrow the gateway VALUE and, the SAME way, its STAMP (PR #66 Codex round
      // 7). `remapOriginStamp` above raw-remapped `origin.templated.ipmiGatewayServerId`
      // through `idMap`, mirroring the value's raw remap; both are FINALIZED here
      // through `linkToImportedServer`, so a gateway whose target did not survive
      // import collapses BOTH value and stamp to `undefined` (no false divergence),
      // and an owned gateway (`cur === stamp` at the source) keeps identical
      // value+stamp — both raw-remapped, both narrowed → equal → still
      // template-owned in LOCAL ids. Collapse the rebuilt bag via
      // `templatedHasAnyStamp`.
      let finalizedOrigin = remappedServer.origin;
      if (finalizedOrigin?.templated?.ipmiGatewayServerId !== undefined) {
        const templated = cloneTemplatedStamps(finalizedOrigin.templated);
        templated.ipmiGatewayServerId = linkToImportedServer(finalizedOrigin.templated.ipmiGatewayServerId);
        finalizedOrigin = { ...finalizedOrigin, templated: templatedHasAnyStamp(templated) ? templated : undefined };
      }
      const finalizedServer: ServerConfig = {
        ...remappedServer,
        ipmiGatewayServerId: linkToImportedServer(remappedServer.ipmiGatewayServerId),
        origin: finalizedOrigin
      };
      tally(await addIfValid(finalizedServer, validateServerConfig, (e) => addServerSanitizingOrigin(e, (s) => core.addOrUpdateServer(s))));
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
      // The retired poll interval this may extract is DROPPED on the share
      // path, and that is the whole point of dropping it: a share export never
      // carries `inventorySources` (§B6/A-M5), so this import creates no
      // source it could belong to, and the only sources on the machine are the
      // importer's own — the exact records the "never re-arm a field the user
      // blanked" rule protects. There is nothing here it may be written to.
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
      // S3 — recorded off the RAW non-secret records (the ones actually imported)
      // before sanitizeImportedMacro strips them, so a shared gateway-routed /
      // credentialed macro is reset-with-notice, not silently. Fired once below.
      const capabilityStripped = incoming.some((m) => hasImportedCapabilityField(m));
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
      // S3 — one-time, non-blocking, once per share import that reset ≥1 macro's
      // capability field.
      if (capabilityStripped) {
        void vscode.window.showInformationMessage(IMPORTED_CAPABILITY_RESET_NOTICE);
      }
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
      // DEVICE TEMPLATES (PR-T1) — no secrets, so a plain record drop. Runs
      // AFTER the sources above so `removeDeviceTemplate`'s templateRules sweep
      // has fewer sources to walk (they are already gone); order is otherwise
      // immaterial since every source is being removed anyway.
      for (const template of snapshot.deviceTemplates) {
        await core.removeDeviceTemplate(template.id);
      }
      // SAVED FILTER DEFINITIONS (PR-E) — no secrets, no references, so a plain
      // record drop; deletion here does NOT sweep any source's stored filter
      // (removeSavedFilter's contract), which is fine in replace mode since every
      // source is being removed above anyway.
      for (const filter of snapshot.savedFilters) {
        await core.removeSavedFilter(filter.id);
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
          ...snapshot.inventorySources.map((s) => s.id),
          // DEVICE TEMPLATES (PR-T1) — join the existing-id set so merge mode
          // never silently overwrites a local template with a same-id one.
          ...snapshot.deviceTemplates.map((t) => t.id),
          // SAVED FILTER DEFINITIONS (PR-E) — same, so a same-id saved filter is
          // not silently overwritten in merge mode.
          ...snapshot.savedFilters.map((f) => f.id)
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
    // DEVICE TEMPLATES (PR-T1) — imported id-preserving like every other bucket.
    const deviceTemplateTally = await importPreservingIds(data.deviceTemplates, existingIds, validateDeviceTemplate, (e) =>
      core.addOrUpdateDeviceTemplate(e)
    );
    // SAVED FILTER DEFINITIONS (PR-E) — imported id-preserving like every other bucket.
    const savedFilterTally = await importPreservingIds(data.savedFilters, existingIds, validateSavedFilter, (e) =>
      core.addOrUpdateSavedFilter(e)
    );
    for (const tally of [serverTally, tunnelTally, serialTally, inventorySourceTally, localShellTally, authProfileTally, deviceTemplateTally, savedFilterTally]) {
      imported += tally.imported;
      skipped += tally.skipped;
    }

    // Clear dangling authProfileId references
    const postImportSnapshot = core.getSnapshot();
    const knownProfileIds = new Set(postImportSnapshot.authProfiles.map((p) => p.id));
    const knownServerIds = new Set(postImportSnapshot.servers.map((s) => s.id));
    for (const server of postImportSnapshot.servers) {
      // Captured as a local so the stamp comparisons below keep narrowing
      // `origin`/`formerlySynced`: `x?.stamp === <string>` proves the container
      // is present, which `x?.stamp === server.authProfileId` (type
      // `string | undefined`) does not.
      const danglingSshProfileId =
        server.authProfileId && !knownProfileIds.has(server.authProfileId) ? server.authProfileId : undefined;
      const sshDangles = danglingSshProfileId !== undefined;
      // The BMC credential link dangles independently of the SSH one — a server
      // can carry either, both, or two different profiles — so it is swept on
      // its own terms rather than as a rider on the SSH clear.
      const danglingIpmiProfileId =
        server.ipmiAuthProfileId && !knownProfileIds.has(server.ipmiAuthProfileId) ? server.ipmiAuthProfileId : undefined;
      const ipmiDangles = danglingIpmiProfileId !== undefined;
      // The BMC jump-host link dangles independently of the auth links — it is a
      // server-list reference (checked against `knownServerIds`, NOT
      // `knownProfileIds`) that has no auth stamp, so it never touches the
      // origin/formerlySynced clears below. A self-referencing gateway keeps its
      // own id in `knownServerIds`, so it is not swept here; the runtime self-ref
      // guard in `resolveIpmiGatewayServer` handles that case.
      const danglingGatewayServerId =
        server.ipmiGatewayServerId && !knownServerIds.has(server.ipmiGatewayServerId) ? server.ipmiGatewayServerId : undefined;
      const gatewayDangles = danglingGatewayServerId !== undefined;
      if (sshDangles || ipmiDangles || gatewayDangles) {
        const cleared: ServerConfig = { ...server };
        if (sshDangles) cleared.authProfileId = undefined;
        if (ipmiDangles) cleared.ipmiAuthProfileId = undefined;
        if (gatewayDangles) cleared.ipmiGatewayServerId = undefined;
        // Same rule as NexusCore.removeAuthProfile: the inventory sync's record
        // that IT applied this profile (origin.syncedAuthProfileId) dies with the
        // link it describes. Left behind, it would read as a per-server opt-out —
        // no `authProfileId`, but a stamp naming a profile — and lock a server
        // nobody hand-configured out of retro-apply for good. Only the stamp
        // naming the very profile being cleared is dropped; a stamp the user has
        // already diverged from is their decision and is left alone.
        //
        // Gated on `sshDangles`: the stamp records an SSH link, so a server
        // reached here only by a dangling BMC link still has a live, resolving
        // `authProfileId` — and clearing its stamp would drop the sync's record
        // of a link that is perfectly intact.
        if (danglingSshProfileId !== undefined && server.origin?.syncedAuthProfileId === danglingSshProfileId) {
          cleared.origin = { ...server.origin, syncedAuthProfileId: undefined };
        }
        // REVIEW FINDING (P1, adoption auth provenance) — and the detached form
        // of that stamp, for the reason NexusCore.removeAuthProfile gives: a
        // kept server's marker carries the removed source's own link record, and
        // adoption restores it into a live origin. Left naming a profile this
        // import has just established does not exist, it would lock the record
        // out of retro-apply the moment it is reclaimed.
        if (danglingSshProfileId !== undefined && server.formerlySynced?.syncedAuthProfileId === danglingSshProfileId) {
          cleared.formerlySynced = { ...server.formerlySynced, syncedAuthProfileId: undefined };
        }
        // BMC VALUE STAMP (issue #48 PR-T3, `origin.templated.ipmiAuthProfileId`)
        // — mirrors NexusCore.removeAuthProfile's BMC stamp clear: the sync's
        // receipt that IT wrote the BMC credential link dies with the link, or it
        // reads as a per-server opt-out (value undefined, stamp naming a profile)
        // and `matrixWrites` locks the field out of even a later override
        // template. Gated on `ipmiDangles` (the BMC id that no longer resolves),
        // INDEPENDENT of the SSH clear above: a server reached here only by a
        // dangling BMC link keeps a live, resolving SSH stamp, and vice versa.
        // Only the stamp naming the very dangling id is dropped. Single-member
        // clear mirrors `dropTemplateProxy` / `clearTemplatedStamps`: rebuild the
        // bag without the member, collapse to `undefined` when empty. Each rebuild
        // chains off `cleared.origin` (not the original `server.origin`) so a
        // server dangling in BOTH the BMC-auth and the gateway stamp loses both —
        // the gateway pass must not resurrect the just-cleared auth member.
        if (danglingIpmiProfileId !== undefined && server.origin?.templated?.ipmiAuthProfileId === danglingIpmiProfileId) {
          const base = cleared.origin ?? server.origin;
          const templated = { ...base.templated };
          delete templated.ipmiAuthProfileId;
          cleared.origin = { ...base, templated: templatedHasAnyStamp(templated) ? templated : undefined };
        }
        if (danglingIpmiProfileId !== undefined && server.formerlySynced?.templated?.ipmiAuthProfileId === danglingIpmiProfileId) {
          const base = cleared.formerlySynced ?? server.formerlySynced;
          const templated = { ...base.templated };
          delete templated.ipmiAuthProfileId;
          cleared.formerlySynced = { ...base, templated: templatedHasAnyStamp(templated) ? templated : undefined };
        }
        // GATEWAY VALUE STAMP (issue #48 PR-T3, `origin.templated.ipmiGatewayServerId`)
        // — mirrors NexusCore.clearGatewayReferencesTo's stamp clear. Gated on
        // `gatewayDangles` (the gateway server id absent from this import), and
        // cleared only when the stamp names that same dangling server id. STAMP
        // ONLY — no `fields.ipmiGatewayServerId` template sweep below, for the
        // same skip-and-warn reason the deletion path gives (template->server refs
        // are validated at sync time, not eagerly rewritten).
        if (danglingGatewayServerId !== undefined && server.origin?.templated?.ipmiGatewayServerId === danglingGatewayServerId) {
          const base = cleared.origin ?? server.origin;
          const templated = { ...base.templated };
          delete templated.ipmiGatewayServerId;
          cleared.origin = { ...base, templated: templatedHasAnyStamp(templated) ? templated : undefined };
        }
        if (danglingGatewayServerId !== undefined && server.formerlySynced?.templated?.ipmiGatewayServerId === danglingGatewayServerId) {
          const base = cleared.formerlySynced ?? server.formerlySynced;
          const templated = { ...base.templated };
          delete templated.ipmiGatewayServerId;
          cleared.formerlySynced = { ...base, templated: templatedHasAnyStamp(templated) ? templated : undefined };
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
    // DEVICE TEMPLATES (PR-T1, §8.2) — post-import dangling sweeps. Read a FRESH
    // snapshot: the source-authProfileId sweep just above may have re-written
    // sources, so the stale `postImportSnapshot` would resurrect a link it just
    // cleared. Checked against post-import state (a reference this machine
    // already satisfies is kept). (a) a template's `fields.authProfileId` naming
    // a profile that was never brought along is cleared, exactly like the source
    // and server links above. (b) a source's `templateRules` entry naming a
    // template that does not exist is removed, so the sync engine never receives
    // a rule it cannot resolve.
    const sweepSnapshot = core.getSnapshot();
    const knownTemplateIds = new Set(sweepSnapshot.deviceTemplates.map((t) => t.id));
    for (const template of sweepSnapshot.deviceTemplates) {
      // A template's SSH `authProfileId` and BMC `ipmiAuthProfileId` (issue #48
      // PR-T3) are independent links into the AuthProfile store — each is swept
      // on its own terms against the same `knownProfileIds` set, and a template
      // dangling in both loses both. No `fields.ipmiGatewayServerId` sweep: that
      // template->server reference is skip-and-warn at sync time, not a dangling
      // import to rewrite here (same rationale as the deletion-path omission).
      const linkedProfileId = template.fields.authProfileId?.value;
      const sshDangles = linkedProfileId !== undefined && !knownProfileIds.has(linkedProfileId);
      const linkedIpmiProfileId = template.fields.ipmiAuthProfileId?.value;
      const ipmiDangles = linkedIpmiProfileId !== undefined && !knownProfileIds.has(linkedIpmiProfileId);
      if (sshDangles || ipmiDangles) {
        let restFields = template.fields;
        if (sshDangles) {
          const { authProfileId: _authProfileId, ...rest } = restFields;
          restFields = rest;
        }
        if (ipmiDangles) {
          const { ipmiAuthProfileId: _ipmiAuthProfileId, ...rest } = restFields;
          restFields = rest;
        }
        await core.addOrUpdateDeviceTemplate({ ...template, fields: restFields });
      }
    }
    for (const source of sweepSnapshot.inventorySources) {
      const rules = source.templateRules;
      if (rules && rules.some((rule) => !knownTemplateIds.has(rule.templateId))) {
        const remaining = rules.filter((rule) => knownTemplateIds.has(rule.templateId));
        await core.addOrUpdateInventorySource({ ...source, templateRules: remaining });
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
      const { macros: incomingMacros, unresolvedCount, capabilityStripped } = incomingResult;
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
      // S3 — one-time, non-blocking, once per import op: a backup/share bundle
      // carried ≥1 macro with a capability field (gateway routing / IPMI
      // credentials) that the strip reset. This is the explicit user-initiated
      // import path only; legacy Settings absorption never shows it.
      if (capabilityStripped) {
        void vscode.window.showInformationMessage(IMPORTED_CAPABILITY_RESET_NOTICE);
      }
    }

    // Apply settings. The READ is separated from the WRITES (review D4): the
    // retired interval below is extracted by the partition, which cannot throw,
    // so a `config.update` that rejects — policy-managed configuration, a
    // settings file something else owns — can no longer take the carry down
    // with it. The sources were persisted earlier in this same import, so a
    // retry in merge mode would skip their ids and leave the cadence
    // unappliable by any later run. The rejection is kept and re-thrown after
    // the carry, so the import still fails exactly where and how it did.
    let settingsCarry: AppliedSettingsCarry = {};
    let settingsWriteError: unknown;
    if (data.settings && typeof data.settings === "object") {
      const partitioned = partitionImportedSettings(data.settings);
      settingsCarry = partitioned.carry;
      try {
        await writeImportedSettings(partitioned);
      } catch (error) {
        settingsWriteError = error;
      }
    }

    /**
     * RETIRED LAB-STATUS POLL INTERVAL (review C2) — carried onto the sources
     * HERE, during the import, because the activation migration provably
     * cannot: the extension has to activate before this command exists to run,
     * and an activation that found no key marks itself done, so a key restored
     * into settings afterwards is read by nothing. Restoring a pre-2.8.191
     * backup on a new machine used to leave polling off with no message and a
     * stale key in the file.
     *
     * WHICH SOURCES: exactly the ones THIS RUN created
     * (`inventorySourceTally.importedIds`) — still EVE-NG on the re-read, and
     * still without an answer of their own. Nothing that was already on this
     * machine is touched, in either mode: replace deleted its sources before
     * importing, and merge skips an id that already exists, so a pre-existing
     * id is never in that list. That is what keeps the durable marker's
     * guarantee intact — a user who turned polling off by BLANKING the field
     * keeps it off, because their source is not one this import created.
     *
     * WHICH PAYLOADS (review D3): only one that shows no sign of coming from a
     * build that HAS the per-source field — no export stamp, and no source in
     * it answering the field. Being in `importedIds` is not enough on its own:
     * a source exported before the field and a source whose owner BLANKED the
     * field to stop polling are the same shape, and replace mode re-creates
     * every source, so restoring your own backup puts the blanked one squarely
     * in that list. `importPredatesPerSourceStatusPoll` carries the full
     * argument, including what it knowingly gives up.
     *
     * A source that reaches the write below came out of a payload from the era
     * when the interval was global, so that number is literally the cadence it
     * was polled at, and it has no answer of its own to overwrite — the
     * per-source re-read still refuses to overwrite one, `0` included, as a
     * rule about answers rather than about vintage. A carried value of 0
     * applies to nothing, exactly as in the migration — it was the shipped
     * default and it polled nothing.
     *
     * Already inside `configMutationLock` (importMergeReplace holds it across
     * this whole function), so no second acquisition: the lock is not
     * reentrant.
     */
    const carriedPollSeconds = settingsCarry.retiredStatusPollSeconds;
    if (
      carriedPollSeconds !== undefined
      && carriedPollSeconds > EVE_NG_STATUS_POLL_MIN_SECONDS
      && importPredatesPerSourceStatusPoll(data)
    ) {
      for (const sourceId of inventorySourceTally.importedIds) {
        // Re-read: the dangling-reference sweeps above rewrite sources, so the
        // record to extend is the live one, not the payload's copy.
        const live = core.getInventorySource(sourceId);
        if (
          !live ||
          live.providerId !== EVE_NG_PROVIDER_ID ||
          live.config[EVE_NG_STATUS_POLL_FIELD_ID] !== undefined
        ) {
          continue;
        }
        await core.addOrUpdateInventorySource({
          ...live,
          config: { ...live.config, [EVE_NG_STATUS_POLL_FIELD_ID]: carriedPollSeconds }
        });
      }
    }

    // Re-thrown HERE and not earlier (review D4): everything above this line is
    // what the failed settings write must not be allowed to strand. Everything
    // below it aborted on a settings write before this change too, so the
    // import fails in exactly the same place it always did.
    if (settingsWriteError !== undefined) {
      throw settingsWriteError;
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
            //
            // ADOPT 1 — and what goes in the origin's place is a "Keep Servers" MARKER,
            // because that is precisely what this disposition already is. Source removed,
            // its servers retained, their origin stripped: field for field the same event as
            // Remove Source → Keep Servers (inventoryCommands.ts), which stamps. Stripping
            // alone made this the ONE detach path that leaves no receipt, so the servers it
            // converts were permanently unadoptable — and the very warning this rollback
            // prints tells the user to "re-import or add it manually", the action a marker is
            // what makes work.
            //
            // The provenance is as real here as on that path and is read from the same place:
            // `origin.externalId` says which device this record was mapped to, and it is
            // trustworthy by the time this loop sees it (addServerSanitizingOrigin strips any
            // origin that is not well-formed, so a surviving one passed `isValidServerOrigin`).
            // Nor does the stamp grant anything new: had the secret restore succeeded, this
            // source would OWN these servers outright. Adoptable-by-offer is strictly less
            // than owned, so a rollback that ends in a marker hands out less authority than
            // the run it is undoing would have.
            //
            // The marker is ASSIGNED, not merged, and that closes a second finding at the
            // same site. A payload can carry a server holding BOTH an origin naming this
            // source AND a stale marker naming a different one (nothing this extension writes
            // produces that, but a hand-edited or version-skewed backup can). The engine's
            // first eligibility clause — `origin === undefined` — is the only thing keeping
            // such a marker inert, so stripping the origin and leaving the marker PROMOTED
            // the record into an adoption candidate for a source that never kept it. Writing
            // this source's own marker over it resolves the contradiction in the only
            // direction the evidence supports.
            //
            // A server carrying `formerlySynced.sourceId === sourceId` and NO origin is
            // deliberately left alone rather than swept. That state is reachable (ids survive
            // import, so restoring an older backup in MERGE mode resurrects this source under
            // its original id while the local servers a previous "Keep Servers" stamped keep
            // their markers — and a backup taken from there carries both), but the marker it
            // already holds is exactly the marker this sweep would write. There is nothing to
            // correct, and rewriting `detachedAt` would restamp a detach that happened long
            // before this import.
            //
            // One timestamp for the whole batch, for the reason the Keep Servers branch gives:
            // these records are detached by a single event, and a per-server Date.now() would
            // imply an ordering that does not exist.
            const detachedAt = Date.now();
            for (const serverId of serverTally.importedIds) {
              const server = core.getServer(serverId);
              const rolledBackOrigin = server?.origin;
              if (!server || rolledBackOrigin === undefined || rolledBackOrigin.sourceId !== sourceId) continue;
              // Both fields come off first, so the marker below is an assignment rather than
              // a merge with whatever the payload happened to carry.
              const { origin: _origin, formerlySynced: _formerlySynced, ...detached } = server;
              // `importedSource` is the record importPreservingIds persisted under this id, so
              // it is present for every id in `importedSourceIds`. If it somehow is not, there
              // is no `sourceName`/`providerId` to stamp a truthful marker from — and a marker
              // that cannot be truthful must not be left behind either, so the server falls
              // back to today's exact behavior: a plain manual server, carrying neither field.
              const converted: ServerConfig = importedSource
                ? {
                    ...detached,
                    formerlySynced: {
                      sourceId,
                      sourceName: importedSource.name,
                      providerId: importedSource.providerId,
                      // REVIEW FINDING (P1, cross-instance adoption), amended by
                      // REVIEW FINDING (P1, the instance guard fed from the wrong
                      // place) — the instance and the auth provenance are COPIED
                      // FROM THE ORIGIN being stripped, on exactly the terms the
                      // Keep Servers stamp in inventoryCommands.ts uses, and for
                      // the same two reasons. The origin is what the sync that
                      // created this server actually recorded; the imported
                      // source record's `config` is only what the backup says it
                      // is TODAY, and a backup can perfectly well carry a source
                      // repointed at a second deployment after the servers beside
                      // it were synced from a first. Re-deriving from that config
                      // (through a provider registry this path may not even have)
                      // would mint an adoption key nothing verified.
                      //
                      // Both omitted rather than written as `undefined`, for the
                      // reason the Keep Servers stamp gives: this object is
                      // persisted verbatim.
                      ...(rolledBackOrigin.syncedInstanceKey !== undefined ? { instanceKey: rolledBackOrigin.syncedInstanceKey } : {}),
                      externalId: rolledBackOrigin.externalId,
                      ...(rolledBackOrigin.syncedAuthProfileId !== undefined
                        ? { syncedAuthProfileId: rolledBackOrigin.syncedAuthProfileId }
                        : {}),
                      // OOB (PR-A REVIEW FINDING) — copied from the origin being
                      // stripped for the same reason the auth provenance above
                      // is, and omitted rather than written as `undefined` for
                      // the same reason: this object is persisted verbatim.
                      ...(rolledBackOrigin.syncedIpmiHost !== undefined
                        ? { syncedIpmiHost: rolledBackOrigin.syncedIpmiHost }
                        : {}),
                      // ALTERNATE HOST (issue #48, Phase 2) — copied from the
                      // origin being stripped for the same reason the auth/OOB
                      // provenance above is, and omitted rather than written as
                      // `undefined` for the same reason: this object is persisted
                      // verbatim.
                      ...(rolledBackOrigin.syncedAltHost !== undefined
                        ? { syncedAltHost: rolledBackOrigin.syncedAltHost }
                        : {}),
                      // TELNET (Phase 0) — the transport receipt, on exactly the terms of
                      // the alternate-host one above: it says whether the `protocol` this
                      // server keeps was the SYNC'S doing or the USER'S, which is the whole
                      // of the `syncOwnsProtocol` write rule. Omitted rather than written as
                      // `undefined` for the reason `instanceKey` is.
                      ...(rolledBackOrigin.syncedProtocol !== undefined ? { syncedProtocol: rolledBackOrigin.syncedProtocol } : {}),
                      // DEVICE TEMPLATES (issue #48 PR-T1, Codex review round 3) —
                      // the template stamps, the fourth part of the origin that
                      // must OUTLIVE the strip, on exactly the terms of the auth/
                      // OOB provenance above. Round 2 added this to the Keep-Servers
                      // detach (inventoryCommands.ts); this rollback-detach site was
                      // the twin that still dropped it, so a server detached HERE
                      // arrived at a later re-adoption looking hand-owned (row 7),
                      // un-reclaimable by an override template. Unlike the scalar
                      // siblings this holds a NESTED `ProxyConfig`, so it is
                      // DEEP-COPIED (`cloneTemplatedStamps`) rather than shared by
                      // reference — the marker is persisted verbatim and must not
                      // alias the live origin's `templated`. Omitted rather than
                      // written as `undefined` for the same reason `instanceKey` is.
                      ...(rolledBackOrigin.templated !== undefined
                        ? { templated: cloneTemplatedStamps(rolledBackOrigin.templated) }
                        : {}),
                      detachedAt
                    }
                  }
                : (detached as ServerConfig);
              try {
                await core.addOrUpdateServer(converted);
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

      // Remove all device templates (PR-T1) and saved filters (PR-E) — the reset
      // promises to delete ALL Nexus data. Sources are already gone above, so
      // removeDeviceTemplate's rule-sweep touches nothing.
      for (const template of snapshot.deviceTemplates) {
        await core.removeDeviceTemplate(template.id);
      }
      for (const filter of snapshot.savedFilters) {
        await core.removeSavedFilter(filter.id);
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

    // #84 P1 (Codex, serialization audit) — the write phase adds folders and
    // servers through per-entity full-snapshot writes; serialize it under
    // configMutationLock (AFTER the confirm modal, no UI held) so a concurrent
    // background port-heal cannot clobber it or be reverted by it.
    await configMutationLock.runExclusive(async () => {
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
    });

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
        // #84 P1 (Codex, serialization audit) — serialize the bulk import write
        // under configMutationLock (after the confirm modal) so a concurrent
        // background port-heal cannot clobber it or be reverted by its
        // full-snapshot write.
        await configMutationLock.runExclusive(() => core.addServersBatch(serverConfigs, folders));
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
      label: "$(sync) Inventory Source…",
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
