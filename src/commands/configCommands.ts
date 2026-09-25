import { createHash, randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { AuthProfile, LocalShellProfile, ProxyConfig, ServerConfig, ServerOrigin, TunnelProfile, SerialProfile } from "../models/config";
import { authProfileNeedsServerKeyPath, cloneTemplatedStamps, templatedHasAnyStamp } from "../models/config";
import type { InventorySourceConfig, InventorySourceValues, TemplateRule } from "../models/inventory";
import { inventorySecretKey } from "../models/inventory";
import type { DeviceTemplateProfile, TemplateField } from "../models/deviceTemplate";
import type { LocalServerConfig } from "../models/localServer";
import type { DhcpConfigProfile, TftpConfigProfile } from "../models/networkServerProfile";
import type { SavedFilterDefinition } from "../models/savedFilter";
import type { MacroVariable, TerminalMacro } from "../models/terminalMacro";
import { hasImportedCapabilityField, IMPORTED_CAPABILITY_RESET_NOTICE, stripImportedCapabilityFields } from "../models/terminalMacro";
import { isValidVariableName, MAX_MACRO_VARIABLES, withRedactedVariables } from "../services/macroVariables";
import { sanitizeMacroFolderList, sanitizeMacroGroup } from "../services/macroFolders";
import type { SecretVault } from "../services/ssh/contracts";
import {
  deleteServerSecrets,
  passwordSecretKey,
  passphraseSecretKey,
  proxyPasswordSecretKey,
  authProfilePasswordSecretKey,
  authProfilePassphraseSecretKey
} from "../services/ssh/silentAuth";
import { validateAuthProfile } from "../utils/validation";
import { encrypt, decrypt, type EncryptedPayload } from "../utils/configCrypto";
import { parseMobaxtermSessions, type ImportedSession } from "../utils/mobaxtermParser";
import { parseSshConfig, resolveSshConfig, type SshConfigParseResult } from "../utils/sshConfigParser";
import { convertSshConfig, localLoginName, type SshConfigImportedSession } from "../utils/sshConfigImport";
import { createSshConfigIo } from "../services/ssh/sshConfigIo";
import {
  readKnownHostFingerprints,
  restoreKnownHostFingerprints,
  sanitizeKnownHostFingerprints
} from "../services/ssh/vscodeHostKeyVerifier";
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
  validateLocalServerConfig,
  validateTftpConfigProfile,
  validateDhcpConfigProfile,
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
import { ORPHAN_FOLDER_NAME } from "../services/inventory/syncEngine";
import { GNS3_PROVIDER_ID, GNS3_STATUS_POLL_FIELD_ID } from "../services/inventory/providers/gns3Provider";
import { NETBOX_PROVIDER_ID } from "../services/inventory/providers/netboxProvider";
import { PROXMOX_PROVIDER_ID, PROXMOX_STATUS_POLL_FIELD_ID } from "../services/inventory/providers/proxmoxProvider";

interface NexusConfigExport {
  version: 1 | 2;
  exportType?: "backup" | "share";
  exportedAt: string;
  servers?: ServerConfig[];
  tunnels?: TunnelProfile[];
  serialProfiles?: SerialProfile[];
  /**
   * In a backup, each record travels WITHOUT its `env` — the map goes in
   * `encryptedSecrets.localShellEnv`, keyed by profile id, for the reason
   * `localServers` gives. Backups taken before 2.8.243 carry `env` here in the
   * clear, and still import. A share export drops it (`sanitizeForSharing`).
   */
  localShellProfiles?: LocalShellProfile[];
  authProfiles?: AuthProfile[];
  /**
   * INVENTORY SOURCES. A backup carries them at full fidelity, with their
   * secrets under `encryptedSecrets.inventorySourceSecrets`.
   *
   * A share export carries them too, as a CACHE of the sender's synced tree:
   * each synced server keeps its `origin`, remapped onto the shipped source's
   * fresh id, so the recipient's source OWNS those rows from the moment of
   * import and its first sync updates them in place instead of adding copies.
   * What the source record loses on the way is everything that is the
   * sender's rather than the source's — credentials (never in this file at
   * all), the sender's usernames, trust stamps and bookkeeping, and the
   * sender's opt-ins to insecure TLS and unattended polling. A link to a key
   * profile — on the source, a template or a row the sync linked — is left out
   * with its stamp, because the profile arrives with no key file
   * (`linkSyncAuthProfile`). Which fields travel at all is the `SHARED_*_RULES`
   * tables; what is rewritten, and why, is in `sanitizeForSharing`. The import
   * applies the same rules and the config rule (`sanitizeSharedSourceConfig`)
   * again, since a share file is untrusted input.
   */
  inventorySources?: InventorySourceConfig[];
  /**
   * DEVICE TEMPLATES (issue #48 PR-T1). No secrets, so no vault section. A
   * backup carries them verbatim. A share carries only the ones the shipped
   * sources' `templateRules` name, and the import lands only the ones named by
   * a source it imports (`templateIdsNamedBySources`) — with fresh ids, so those rules still
   * resolve, every id reference (auth profile, IPMI gateway, jump host)
   * remapped into the bundle or dropped — the auth profile also when it is a
   * key profile, which arrives with no key file (`linkSyncAuthProfile`) — and a
   * proxy's username removed as it is on a server's proxy.
   */
  deviceTemplates?: DeviceTemplateProfile[];
  /**
   * SAVED FILTER DEFINITIONS (issue #48 PR-E). No secrets, so no vault section —
   * the query string is the same non-secret data as a source's own Device
   * Filter field, which a share carries anyway. Both export paths carry them;
   * a share gives each a fresh id.
   */
  savedFilters?: SavedFilterDefinition[];
  /**
   * LOCAL SERVER PROFILES — backup-only, EXCLUDED from a share export: an
   * executable path, a working directory and environment variables describe
   * THIS machine and mean nothing (or something unsafe) on a stranger's. Each
   * record travels WITHOUT its `env`: variables routinely carry tokens and
   * passwords, so the whole map goes in `encryptedSecrets.localServerEnv`
   * (keyed by profile id) and is put back on import. Absent from every backup
   * written before 2.8.243 — see the replace-mode note in importMergeReplaceLocked.
   */
  localServers?: LocalServerConfig[];
  /**
   * SAVED TFTP / DHCP PROFILES — backup-only, EXCLUDED from a share export.
   * They are bench presets for this machine's own interfaces and address plan
   * (a TFTP root path, a bind address, a pool, MAC reservations), so a share has
   * nothing portable to offer; keeping them out also keeps the share path's
   * scope where it was. No secrets, so no vault section — `leaseStorePath` is a
   * machine-local path that never travels with a profile (see
   * `captureDhcpProfileBody`), and import strips it.
   */
  tftpProfiles?: TftpConfigProfile[];
  dhcpProfiles?: DhcpConfigProfile[];
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

/**
 * Runtime teardown the config-wide commands need but must not own: this module
 * writes configuration and never holds a process or a daemon. Wired in
 * extension.ts; optional so the commands still register without it (tests,
 * and any host that runs neither manager). Both must resolve, never reject.
 */
export interface ConfigRuntimeHooks {
  /**
   * Stop one Local Server — its process, any pending auto-restart, its
   * terminals — BEFORE its profile is removed (`stopLocalServerForRemoval`).
   * Called with `configMutationLock` held; must not take it.
   */
  stopLocalServer(configId: string): Promise<void>;
  /** Stop every running embedded TFTP/DHCP service (`stopRunningNetworkServices`). */
  stopNetworkServices(): Promise<void>;
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

// Contributed settings whose value is an array or an object, which SettingMeta's scalar type
// system cannot describe. They are edited in the Network Servers settings form (a
// WebviewFormPanel that parses them out of textareas), exactly as
// `nexus.terminal.highlighting.rules` is edited in the highlight rule editor rather than the
// Settings panel. Backup/export must still carry them, so they join SETTINGS_KEYS here and
// each gets a shape validator in SPECIAL_SETTING_VALIDATORS below — without one,
// validateSettingUpdate would reject them on import as "Unknown Nexus setting".
const FORM_EDITED_SETTING_KEYS: Array<{ section: string; key: string }> = [
  { section: "nexus.networkServers", key: "dhcp.dns" },
  { section: "nexus.networkServers", key: "dhcp.tftpServerAddresses" },
  { section: "nexus.networkServers", key: "dhcp.vendorSpecificOptions" },
  { section: "nexus.networkServers", key: "dhcp.static" }
];

// Derived from SETTINGS_META (single source of truth for contributed settings) plus the
// form-edited and import-compat extras above, so adding a setting only requires editing
// settingsMetadata.ts. EXTRA_IMPORT_KEYS stays last so the legacy-timeout ordering above holds.
// The SETTINGS_KEYS ⊇ SETTINGS_META invariant is asserted in configImportExport.test.ts.
export const SETTINGS_KEYS: Array<{ section: string; key: string }> = [
  ...SETTINGS_META.map((m) => ({ section: m.section, key: m.key })),
  ...FORM_EDITED_SETTING_KEYS,
  ...EXTRA_IMPORT_KEYS
];

const SETTINGS_KEY_SET = new Set(SETTINGS_KEYS.map(({ section, key }) => `${section}.${key}`));

/**
 * Per-setting policy for the clear-text share format. Backups intentionally do
 * not use this table: they preserve settings under the existing encrypted
 * backup contract. Anything not explicitly marked `share` stays on the sender;
 * a future or hand-added key therefore defaults to local-only.
 *
 * Keep one decision for every SETTINGS_KEYS entry. The equality test beside
 * the SETTINGS_KEYS coverage tests makes a newly added setting wait for review
 * here instead of silently broadening the share format.
 */
export const SHARE_SETTINGS_POLICY: Readonly<Record<string, "share" | "local">> = Object.freeze({
  // Capture, retention caps, and the destination are local privacy/disk policy.
  "nexus.logging.sessionTranscripts": "local",
  "nexus.logging.sessionLogDirectory": "local",
  "nexus.logging.maxFileSizeMb": "local",
  "nexus.logging.maxRotatedFiles": "local",
  "nexus.logging.terminalOutputTrace": "local",

  // Connection pooling changes which sessions share a transport, so that
  // isolation choice stays local; timeouts and terminal preferences travel.
  "nexus.ssh.multiplexing.enabled": "local",
  "nexus.ssh.multiplexing.idleTimeout": "local",
  "nexus.ssh.trustNewHosts": "local",
  "nexus.ssh.connectionTimeout": "share",
  "nexus.ssh.keepaliveInterval": "share",
  "nexus.ssh.keepaliveCountMax": "share",
  "nexus.ssh.terminalType": "share",
  "nexus.ssh.proxyTimeout": "share",

  // Tunnel connection reuse/isolation and listener address belong to this host.
  "nexus.tunnel.defaultConnectionMode": "local",
  "nexus.tunnel.defaultBindAddress": "local",
  "nexus.tunnel.socks5HandshakeTimeout": "share",

  // UI and terminal interaction preferences.
  "nexus.terminal.openLocation": "share",
  "nexus.ui.showTreeDescriptions": "share",
  "nexus.terminal.keyboardPassthrough": "share",
  "nexus.terminal.passthroughKeys": "share",

  // Cache freshness and one-shot operation timeouts travel. Memory budgets,
  // background polling/watch mode, recursive-delete ceilings, and sudo policy
  // are local because they control this host's workload or safety boundaries.
  "nexus.sftp.cacheTtlSeconds": "share",
  "nexus.sftp.maxCacheEntries": "local",
  "nexus.sftp.autoRefreshInterval": "local",
  "nexus.sftp.remoteWatchMode": "local",
  "nexus.sftp.maxOpenFileSizeMB": "local",
  "nexus.sftp.operationTimeout": "share",
  "nexus.sftp.commandTimeout": "share",
  "nexus.sftp.deleteDepthLimit": "local",
  "nexus.sftp.deleteOperationLimit": "local",
  "nexus.sftp.sudo.enabled": "local",
  "nexus.sftp.sudo.rememberPasswordForSession": "local",

  // Highlighting rules are portable user preferences. Macro activation,
  // cooldown, and prompt context are local automation safeguards.
  "nexus.terminal.highlighting.enabled": "share",
  "nexus.terminal.macros.autoTrigger": "local",
  "nexus.terminal.macros.defaultCooldown": "local",
  "nexus.terminal.macros.bufferLength": "local",

  // Wait-time preference travels. Script watchdog/read budgets, paths, and
  // automation policy stay with the recipient's machine.
  "nexus.serial.rpcTimeout": "share",
  "nexus.scripts.path": "local",
  "nexus.scripts.defaultTimeoutSeconds": "share",
  "nexus.scripts.maxRuntimeSeconds": "local",
  "nexus.scripts.maxReadSizeMb": "local",
  "nexus.scripts.macroPolicy": "local",
  "nexus.settingsGuard.enabled": "local",

  // Network-server settings are all bound to this machine's live interfaces,
  // local files, exposure policy, or address plan; keep the whole group local.
  "nexus.networkServers.verboseMode": "local",
  "nexus.networkServers.engine": "local",
  "nexus.networkServers.tftp.root": "local",
  "nexus.networkServers.tftp.interface": "local",
  "nexus.networkServers.tftp.port": "local",
  "nexus.networkServers.tftp.allowWrite": "local",
  "nexus.networkServers.dhcp.interface": "local",
  "nexus.networkServers.dhcp.rangeStart": "local",
  "nexus.networkServers.dhcp.rangeEnd": "local",
  "nexus.networkServers.dhcp.subnet": "local",
  "nexus.networkServers.dhcp.gateway": "local",
  "nexus.networkServers.dhcp.leaseTimeSec": "local",
  "nexus.networkServers.dhcp.serverId": "local",
  "nexus.networkServers.dhcp.broadcast": "local",
  "nexus.networkServers.dhcp.bootFileName": "local",
  "nexus.networkServers.dhcp.nextServer": "local",
  "nexus.networkServers.dhcp.autoLinkTftp": "local",
  "nexus.networkServers.dhcp.allowRelayAgents": "local",
  "nexus.networkServers.dhcp.vendorClassId": "local",
  "nexus.networkServers.dhcp.dns": "local",
  "nexus.networkServers.dhcp.tftpServerAddresses": "local",
  "nexus.networkServers.dhcp.vendorSpecificOptions": "local",
  "nexus.networkServers.dhcp.static": "local",

  // Restart thresholds describe local processes and stay with their host.
  "nexus.localServers.defaultMaxAutoRestarts": "local",
  "nexus.localServers.stableRuntimeMs": "local",
  "nexus.localServers.initialBackoffMs": "local",
  "nexus.localServers.maxBackoffMs": "local",

  // Import compatibility keys are policy-reviewed too. The retired poll key
  // is consumed only by backup migration and is deliberately never shared.
  "nexus.terminal.highlighting.rules": "share",
  "nexus.scripts.defaultTimeout": "share",
  "nexus.scripts.maxRuntimeMs": "local",
  "nexus.inventory.statusPollSeconds": "local"
});

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

function validStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Shape check for `nexus.networkServers.dhcp.vendorSpecificOptions`, mirroring the
 * contributed JSON schema: a list of `{ subOption, value }` pairs whose codes are in
 * 1–254 (0 is PAD and 255 is END, so neither can carry a value). The encoder
 * (`encodeVendorSpecificInfo`) still skips individual entries it cannot fit on the wire,
 * so this only has to keep a structurally wrong value out of settings.json.
 */
function validVendorSpecificOptions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const record = entry as Record<string, unknown>;
      return validBoundedNumber(record.subOption, 1, 254) && typeof record.value === "string";
    })
  );
}

function validStaticReservations(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((ip) => typeof ip === "string")
  );
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
    validBoundedNumber(value, 100, MAX_SCRIPT_WAIT_TIMEOUT_MS) ? { ok: true, value } : { ok: false },
  "nexus.networkServers.dhcp.dns": (value) => (validStringArray(value) ? { ok: true, value } : { ok: false }),
  "nexus.networkServers.dhcp.tftpServerAddresses": (value) =>
    validStringArray(value) ? { ok: true, value } : { ok: false },
  "nexus.networkServers.dhcp.vendorSpecificOptions": (value) =>
    validVendorSpecificOptions(value) ? { ok: true, value } : { ok: false },
  "nexus.networkServers.dhcp.static": (value) => (validStaticReservations(value) ? { ok: true, value } : { ok: false })
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
  for (const key of ["localServers", "tftpProfiles", "dhcpProfiles"] as const) {
    if (obj[key] !== undefined && !Array.isArray(obj[key])) {
      return false;
    }
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
    // A file is untrusted: a `null` (or any non-object) entry is a record that
    // cannot be imported, not a reason to throw halfway through an import —
    // in replace mode, after the wipe has already run.
    if (typeof item !== "object" || item === null) {
      tally.skipped++;
      continue;
    }
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

/**
 * THE READABLE-HALF SEAL (Codex P1 on PR #168). A backup keeps its secrets in
 * `encryptedSecrets` and every record they belong to — a Local Server's
 * command, a server's host, a Local Shell's path — in the readable half beside
 * it, joined only by profile id. Encrypting the secrets kept them private but
 * did not stop anyone holding the file from rewriting the record they are
 * restored onto: point a server at another host, or a Local Server at another
 * program, keep the id, and a restore handed the saved password or the
 * protected environment to the rewritten record. That is a property of the
 * whole format rather than of one collection, so the fix is format-wide too:
 * the encrypted section carries a SHA-256 of the readable half, and import
 * refuses a file whose readable half no longer matches — before anything on
 * this machine changes.
 *
 * Why a digest inside the ciphertext rather than GCM associated data: older
 * builds decrypt without associated data, so binding it into the tag would make
 * every new backup undecryptable there. A digest they do not know about is an
 * ignored key. And because the digest lives INSIDE the authenticated section,
 * it cannot be stripped or recomputed without the password: making the readable
 * half look like an older, unsealed backup does not skip the check.
 *
 * What it does not cover, by construction: a backup made before 2.8.243 has no
 * seal and imports as it always did; and a file whose encrypted section has
 * been removed altogether carries no secrets to hand to anything — it imports
 * as the plain, unauthenticated export it has become.
 */
const CLEAR_PART_SEAL_VERSION = 1;

/**
 * Deterministic JSON: object keys sorted, no whitespace. Only ever applied to a
 * value that has already been through `JSON.parse(JSON.stringify(…))`, so no
 * `undefined`, function or non-finite number reaches it, and the export side
 * and the import side see exactly the same tree — the file's own spacing and
 * key order (which anything re-saving the JSON may change) do not matter.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 (hex) of everything in a backup except `encryptedSecrets`. */
function clearPartDigest(backup: object): string {
  const { encryptedSecrets: _sealed, ...readable } = JSON.parse(JSON.stringify(backup)) as Record<string, unknown>;
  return createHash("sha256").update(canonicalJson(readable), "utf8").digest("hex");
}

/**
 * Checks the seal a decrypted backup carries against the file's readable half.
 * `unsealed` — no seal: a backup from before 2.8.243, imported as it always was.
 * `unsupported` — a seal from a newer format this build cannot check.
 */
function checkClearPartSeal(backup: object, secrets: Record<string, unknown>): "unsealed" | "intact" | "changed" | "unsupported" {
  const seal = secrets.clearPartSeal;
  if (seal === undefined) {
    return "unsealed";
  }
  if (typeof seal !== "object" || seal === null) {
    return "changed";
  }
  const { version, sha256 } = seal as { version?: unknown; sha256?: unknown };
  if (typeof version !== "number" || typeof sha256 !== "string") {
    return "changed";
  }
  if (version !== CLEAR_PART_SEAL_VERSION) {
    return "unsupported";
  }
  return sha256 === clearPartDigest(backup) ? "intact" : "changed";
}

/**
 * The Replace-mode guard for the collections Replace clears only when the file
 * carries them (Codex P1 on PR #168). A carried list with entries of which NONE
 * can be imported would have its local counterpart deleted and nothing put in
 * its place, so it is named here and the import refused before anything is
 * removed. An EMPTY list is a deliberate answer — the backup of a machine with
 * none — and still clears. Runs after the same preparation the import applies
 * (env restored, folder normalised, lease path stripped) and assigns a missing
 * id exactly as `importPreservingIds` would, so "importable" means what the
 * import itself will decide.
 */
function unusableCarriedCollections(data: NexusConfigExport): string[] {
  const carried: Array<[string, readonly unknown[] | undefined, (item: unknown) => boolean]> = [
    ["Local Server", data.localServers, validateLocalServerConfig],
    ["saved TFTP profile", data.tftpProfiles, validateTftpConfigProfile],
    ["saved DHCP profile", data.dhcpProfiles, validateDhcpConfigProfile]
  ];
  const importable = (item: unknown, validate: (item: unknown) => boolean): boolean => {
    if (typeof item !== "object" || item === null) return false;
    ensureId(item as Record<string, unknown>);
    return validate(item);
  };
  return carried
    .filter(([, items, validate]) => Array.isArray(items) && items.length > 0 && !items.some((item) => importable(item, validate)))
    .map(([label]) => label);
}

/**
 * Splits each profile's environment off for the encrypted section of a backup.
 * Local Shell and Local Server profiles both carry an `env` map, and variables
 * routinely hold tokens and passwords, so the readable half of the file gets
 * each record WITHOUT it and `encryptedSecrets` gets the maps, keyed by profile
 * id. A profile with no variables contributes no entry.
 */
function splitEnvIntoSecrets<T extends { id: string; env?: Record<string, unknown> }>(
  profiles: readonly T[]
): { clear: Array<Omit<T, "env">>; envById: Record<string, T["env"]> } {
  // Prototype-free: a profile id is data from a file, and `__proto__` is a
  // legal one — on a plain object that assignment hits the prototype setter
  // and the environment silently vanishes from the backup.
  const envById: Record<string, T["env"]> = Object.create(null) as Record<string, T["env"]>;
  const clear = profiles.map((profile) => {
    const { env, ...clearRecord } = profile;
    if (env && Object.keys(env).length > 0) {
      envById[profile.id] = env;
    }
    return clearRecord;
  });
  return { clear, envById };
}

/**
 * The import half of {@link splitEnvIntoSecrets}: puts each profile's
 * environment back from the encrypted section, in place and BEFORE validation.
 *
 * Looked up by the id the FILE carries — before `ensureId` could mint a new
 * one. A profile skipped later (merge mode, an id already here) never lands, so
 * its environment is discarded with it rather than written anywhere. The map is
 * shape-checked with the rest of the record by the collection's validator. A
 * profile the encrypted section has nothing for keeps whatever `env` it carries
 * in the clear: every Local Shell profile in a backup taken before 2.8.243 has
 * its variables there, and they import exactly as they always did.
 */
function restoreEnvFromSecrets(profiles: readonly unknown[] | undefined, envById: unknown): void {
  if (!profiles || typeof envById !== "object" || envById === null || Array.isArray(envById)) {
    return;
  }
  const envs = envById as Record<string, unknown>;
  for (const profile of profiles) {
    if (typeof profile !== "object" || profile === null) continue;
    const record = profile as Record<string, unknown>;
    if (typeof record.id === "string" && Object.prototype.hasOwnProperty.call(envs, record.id)) {
      record.env = envs[record.id];
    }
  }
}

/**
 * Readies a backup's Local Server profiles for `importPreservingIds`, in place
 * (the same discipline as `sanitizeImportedInventorySources`, and for the same
 * reason it runs BEFORE validation).
 *
 * 1. Puts each profile's environment back (`restoreEnvFromSecrets`).
 * 2. Normalises `group` the way every other writer of this field does
 *    (`formValuesToLocalServer`, the move commands): trimmed and canonical, and
 *    a path that could never have been saved — `..`, a backslash, over-depth —
 *    drops the profile to the root rather than rejecting it, as
 *    `sanitizeMacroGroup` does for macros. A blank `group` becomes "no folder";
 *    left as `""` it would fail validation and cost the user the profile.
 */
function prepareImportedLocalServers(
  servers: LocalServerConfig[] | undefined,
  envByServerId: unknown
): LocalServerConfig[] | undefined {
  if (!servers) {
    return servers;
  }
  restoreEnvFromSecrets(servers, envByServerId);
  for (const server of servers) {
    if (typeof server !== "object" || server === null) continue;
    const record = server as unknown as Record<string, unknown>;
    const group = normalizeOptionalFolderPath(record.group);
    if (typeof group === "string") {
      record.group = group;
    } else {
      delete record.group;
    }
  }
  return servers;
}

/**
 * Strips `config.leaseStorePath` from a backup's DHCP profiles, in place and
 * BEFORE validation. It is the lease file of the machine that took the backup
 * — a path this extension resolves per machine and never stores in a profile
 * (`captureDhcpProfileBody`) — so it has nothing to say here, and a malformed
 * one must not be able to reject the profile around it.
 */
function sanitizeImportedDhcpProfiles(profiles: DhcpConfigProfile[] | undefined): DhcpConfigProfile[] | undefined {
  for (const profile of profiles ?? []) {
    if (typeof profile !== "object" || profile === null) continue;
    const config = (profile as unknown as Record<string, unknown>).config;
    if (typeof config === "object" && config !== null) {
      delete (config as Record<string, unknown>).leaseStorePath;
    }
  }
  return profiles;
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
  inventorySources: InventorySourceConfig[];
  deviceTemplates: DeviceTemplateProfile[];
  savedFilters: SavedFilterDefinition[];
}

/**
 * A proxy as a share carries it, in BOTH directions — one rule for a server's
 * own proxy, its `origin.templated.proxy` stamp and a device template's, so a
 * template-owned proxy still equals its stamp on the other side. Rebuilt from
 * its declared members only: an SSH jump host re-pointed through `linkServer`
 * (the proxy is dropped when the jump host is not in the bundle); a SOCKS5 or
 * HTTP proxy reduced to type, host and port, so the proxy login never travels
 * and a hand-edited file cannot land one either. Anything that is not a proxy
 * this build knows is returned as it is, for the validators to judge.
 */
function remapProxy(proxy: ProxyConfig | undefined, linkServer: (id: string) => string | undefined): ProxyConfig | undefined {
  if (typeof proxy !== "object" || proxy === null) {
    return proxy;
  }
  switch (proxy.type) {
    case "ssh": {
      const jumpHostId = typeof proxy.jumpHostId === "string" ? linkServer(proxy.jumpHostId) : undefined;
      return jumpHostId ? { type: "ssh", jumpHostId } : undefined; // Jump host not in the bundle
    }
    case "socks5":
    case "http":
      return { type: proxy.type, host: proxy.host, port: proxy.port };
    default:
      return proxy;
  }
}

/**
 * The username a share writes wherever the sender's own would have gone: each
 * server's `username`, each shipped auth profile's, an inventory source's
 * `defaultUsername`, and a synced server's `origin.syncedUsername`. One value,
 * because the stamp and the field it describes must stay EQUAL: a cached row
 * whose username differs from its stamp reads as hand-edited on the recipient,
 * and never takes the auth profile they later link on its source.
 */
const SHARED_USERNAME = "user";

/**
 * SHARE SCRUBS — what a share clears from the records it still carries whole
 * (servers, serial and Local Shell profiles, settings; rebuilding them from
 * rules tables like the inventory records is #179). Applied in BOTH
 * directions: `sanitizeForSharing` on the way out, and `importShareData` again
 * before validation, because a share file is untrusted and a hand-edited or
 * older one could carry anything the export clears. One function per record,
 * so the two sides cannot drift apart.
 *
 * Tunnels need none, and macros are already symmetric: a secret macro is left
 * out in both directions, and a masked variable's default is removed by
 * `withRedactedVariables` on the way out and by `sanitizeImportedMacro`, which
 * removes more, on the way in.
 */

/**
 * A server: every `username` becomes SHARED_USERNAME and `keyPath` is blanked —
 * the sender's login and where their key file is — and `formerlySynced`, the
 * adoption key, never travels (see the ADOPT 1 note in `importShareData`).
 */
function scrubSharedServer(server: ServerConfig): ServerConfig {
  const { formerlySynced: _adoptionKey, ...kept } = server;
  return { ...kept, username: SHARED_USERNAME, keyPath: "" };
}

/** A serial profile: `deviceHint`, the identity of the sender's USB adapter that Smart Follow learned. */
function scrubSharedSerialProfile(profile: SerialProfile): SerialProfile {
  const { deviceHint: _learned, ...kept } = profile;
  return kept;
}

/**
 * A Local Shell profile: the working directory, the startup command — which
 * runs the moment the profile opens — and the environment variables, which
 * routinely carry tokens (issue #159).
 */
function scrubSharedLocalShellProfile(profile: LocalShellProfile): LocalShellProfile {
  const { cwd: _cwd, startupCommand: _startupCommand, env: _env, ...kept } = profile;
  return kept;
}

/**
 * Share only explicitly approved portable preferences. The share importer calls
 * this again on input so old and hand-edited files cannot overwrite local
 * security choices, paths, network plans, or future unknown settings.
 */
function scrubSharedSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [fullKey, value] of Object.entries(settings)) {
    if (SHARE_SETTINGS_POLICY[fullKey] === "share") {
      scrubbed[fullKey] = value;
    }
  }
  return scrubbed;
}

/**
 * What a share does with each field of the inventory records it carries, in
 * BOTH directions — the export applies it, and the import applies it again,
 * because a share file is untrusted and a hand-edited one could put back
 * anything the export removed.
 *
 *  - `"keep"` — copied as it is;
 *  - `"drop"` — never travels;
 *  - a function — a rewrite that needs nothing but the record, applied by
 *    `shareRecord` itself, identically on both sides, so neither can forget it;
 *  - `"link"` — a rewrite that needs the side's own context (a fresh id, an id
 *    map, a policy only the import applies). `shareRecord` demands a linker for
 *    every `"link"` field from each caller, and the compiler enforces it.
 *
 * An ALLOWLIST, and typed so that a field added to one of these models fails
 * the build here until someone decides what a share does with it. A spread
 * would ship it by default — and the fields most likely to be added are
 * exactly the kind that must not travel: another trust stamp, another consent
 * record, more sync bookkeeping. A key the model does not declare is not copied
 * in either direction, and neither is one inside the nested records rebuilt
 * here (template rules, template field wrappers, proxies).
 */
type ShareRule<T, K extends keyof T> = "keep" | "drop" | "link" | ((value: T[K], record: T) => T[K] | undefined);
type ShareRules<T> = { readonly [K in keyof T]-?: ShareRule<T, K> };
type LinkedKeys<T, R> = { [K in keyof T & keyof R]-?: R[K] extends "link" ? K : never }[keyof T & keyof R];
type ShareLinks<T, R> = { [K in LinkedKeys<T, R>]: (value: T[K], record: T) => T[K] | undefined };

/** `record` rebuilt by `rules` (see `ShareRule`); a field whose outcome is `undefined` is left out. */
function shareRecord<T extends object, R extends ShareRules<T>>(record: T, rules: R, links: ShareLinks<T, R>): Partial<T> {
  const shared: Partial<T> = {};
  const linkers = links as unknown as Record<keyof T, (value: unknown, record: T) => unknown>;
  for (const key of Object.keys(rules) as Array<keyof T>) {
    const rule = rules[key] as ShareRule<T, keyof T>;
    if (rule === "drop") {
      continue;
    }
    const value = Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
    const next = rule === "keep" ? value : rule === "link" ? linkers[key](value, record) : rule(value as T[keyof T], record);
    if (next !== undefined) {
      shared[key] = next as T[keyof T];
    }
  }
  return shared;
}

/** How a share reaches the records it links to, on the side applying the rules. */
interface ShareLenses {
  linkProfile(id: string): string | undefined;
  linkServer(id: string): string | undefined;
  /**
   * Whether the profile arrives as a key profile with no key file —
   * `authProfileNeedsServerKeyPath` asked of the profile as it lands on the
   * other side, not as it is here. See `linkSyncAuthProfile`.
   */
  arrivesNeedingServerKey(id: string): boolean;
}

/**
 * KEY PROFILES — a profile link the inventory sync acts on (a source's
 * `authProfileId`, a device template's `fields.authProfileId`), through
 * `linkProfile`, or `undefined` when that profile arrives with no key file.
 *
 * A share strips every key path, so every key profile it carries arrives with
 * no key file, and the sync engine treats one as unusable: it refuses to link
 * it, warns on every sync that it has no key file, and unlinks every server an
 * earlier sync linked to it (AUTH 2b, `decideSourceAuthRollback` in
 * services/inventory/syncEngine.ts). Shipped, the source's or a template's link
 * would make the recipient's first sync unlink every cached row it reaches.
 * Left out, the rows stay as they are, and the recipient links a profile with
 * a key file on the source or the template — the profile itself still travels
 * (see `sanitizeForSharing`), so that can be this one once they give it theirs.
 *
 * Decided by the engine's own predicate on the profile as it LANDS — rebuilt
 * by `SHARED_AUTH_PROFILE_RULES`, so with no key path in either direction — so
 * the share and the engine cannot disagree about which profiles those are. A
 * password profile never matches — the engine does not read the saved
 * password, so one that lands without it (they never travel) is linked
 * exactly as before.
 */
function linkSyncAuthProfile(id: string | undefined, lenses: ShareLenses): string | undefined {
  return id === undefined || lenses.arrivesNeedingServerKey(id) ? undefined : lenses.linkProfile(id);
}

/**
 * KEY PROFILES — whether a cached row's own sync link is one the engine would
 * unlink on arrival, so the share leaves it out: the link still exactly as the
 * sync wrote it (`authProfileId` equal to `origin.syncedAuthProfileId`, AUTH
 * 2b's ownership clause) to a profile that arrives with no key file. AUTH 2b
 * spares a server that brings a key file of its own, but a share blanks every
 * server's key path, so no cached row does.
 *
 * The link and its stamp go TOGETHER, so the row arrives as one the sync never
 * linked — the state retro-apply fills when the recipient links a profile on
 * the source. Without its stamp, the link would read as one made by hand, which
 * no sync moves; without the link, the stamp would read as a per-server opt-out,
 * which no sync fills. Every other link to such a profile travels: a hand-made
 * one, or a stamp whose link the sender removed (an opt-out), is not the
 * engine's to undo, and the IPMI profile link is never checked for a key file.
 */
function syncAuthLinkArrivesNeedingServerKey(server: Pick<ServerConfig, "authProfileId" | "origin">, lenses: ShareLenses): boolean {
  const id = server.authProfileId;
  return typeof id === "string" && server.origin?.syncedAuthProfileId === id && lenses.arrivesNeedingServerKey(id);
}

/**
 * An auth profile as a share carries it, in both directions. Its secrets
 * (password, passphrase) live in the vault and never in the record; what the
 * record itself gives away is the sender's login and where their key file is,
 * so `username` becomes SHARED_USERNAME, like every username a share carries,
 * and `keyPath` never travels — which is also why every key profile arrives
 * with no key file (`linkSyncAuthProfile`). A member the model does not declare
 * (a stored `token`, a field a later build adds) is copied in neither
 * direction.
 */
const SHARED_AUTH_PROFILE_RULES = {
  id: "link",
  name: "keep",
  username: () => SHARED_USERNAME,
  authType: "keep",
  keyPath: "drop"
} satisfies ShareRules<AuthProfile>;

const SHARED_SOURCE_RULES = {
  id: "link",
  providerId: "keep",
  name: "keep",
  targetFolder: "keep",
  // The export keeps it; the import turns `delete` into `orphan` (and counts
  // it for the completion message) — see `importShareData`.
  prunePolicy: "link",
  defaultUsername: () => SHARED_USERNAME,
  config: (config, source) =>
    typeof config === "object" && config !== null && !Array.isArray(config)
      ? sanitizeSharedSourceConfig(source.providerId, config, source.secretFieldIds)
      : config,
  secretFieldIds: "keep",
  lastSyncAt: "drop",
  revision: "drop",
  providerFingerprint: "drop",
  managedFolders: "drop",
  authProfileId: "link",
  templateRules: "link"
} satisfies ShareRules<InventorySourceConfig>;

const SHARED_ORIGIN_RULES = {
  sourceId: "link",
  externalId: "keep",
  syncedAt: "keep",
  // The contract says a provider must never put a secret here, but nothing
  // enforces it: a third-party `instanceKey` can hand back `https://user:token@…`.
  // Cleaned rather than dropped — dropped, the recipient's first sync would
  // stamp every cached row afresh, an update apiece.
  syncedInstanceKey: (key) => (typeof key === "string" ? stripUrlUserinfo(key) : key),
  // In lockstep with `username`, which becomes SHARED_USERNAME beside it.
  syncedUsername: (username) => (username === undefined ? undefined : SHARED_USERNAME),
  syncedAuthProfileId: "link",
  syncedIpmiHost: "keep",
  syncedAltHost: "keep",
  syncedProtocol: "keep",
  syncedHost: "keep",
  syncedPort: "keep",
  templated: "link"
} satisfies ShareRules<ServerOrigin>;

const SHARED_TEMPLATED_STAMP_RULES = {
  proxy: "link",
  multiplexing: "keep",
  legacyAlgorithms: "keep",
  logSession: "keep",
  ipmiAuthProfileId: "link",
  ipmiGatewayServerId: "link"
} satisfies ShareRules<NonNullable<ServerOrigin["templated"]>>;

const SHARED_TEMPLATE_RULES = {
  id: "link",
  name: "keep",
  revision: "drop",
  fields: "link"
} satisfies ShareRules<DeviceTemplateProfile>;

const SHARED_TEMPLATE_FIELD_WRAPPER_RULES = {
  mode: "keep",
  value: "link"
} satisfies ShareRules<TemplateField<unknown>>;

/** A boolean template field: its wrapper rebuilt, its value as it is. */
const shareTemplateFlag = (field: TemplateField<boolean> | undefined): TemplateField<boolean> | undefined =>
  shareTemplateField(field, (value) => value);

const SHARED_TEMPLATE_FIELD_RULES = {
  proxy: "link",
  authProfileId: "link",
  multiplexing: shareTemplateFlag,
  legacyAlgorithms: shareTemplateFlag,
  logSession: shareTemplateFlag,
  ipmiAuthProfileId: "link",
  ipmiGatewayServerId: "link"
} satisfies ShareRules<DeviceTemplateProfile["fields"]>;

const SHARED_TEMPLATE_RULE_RULES = {
  id: "keep",
  filter: "keep",
  templateId: "link"
} satisfies ShareRules<TemplateRule>;

const SHARED_SAVED_FILTER_RULES = {
  id: "link",
  name: "keep",
  filter: "keep"
} satisfies ShareRules<SavedFilterDefinition>;

/**
 * The built-in inventory providers — the only ones whose config field ids
 * `sanitizeSharedSourceConfig` may interpret. A field id is not a reserved word:
 * provider registration is a public API, so a third-party provider's
 * `allowInsecureTls` or `username` can mean something else entirely and is
 * carried verbatim (the reason `importPredatesPerSourceStatusPoll` scopes
 * `statusPollSeconds` to EVE-NG). Held to `createBuiltInProviders` by test, so
 * a new built-in cannot ship outside it.
 */
const BUILT_IN_INVENTORY_PROVIDER_IDS: ReadonlySet<string> = new Set([
  NETBOX_PROVIDER_ID,
  EVE_NG_PROVIDER_ID,
  PROXMOX_PROVIDER_ID,
  GNS3_PROVIDER_ID
]);

/**
 * A string that parses as a URL carrying userinfo, without it — anything else
 * untouched. `https://user:token@netbox` is a credential typed into a
 * NON-secret field (`netboxInstanceKey` names the case), and a share file
 * promises its credentials are stripped. `href` normalizes on the way out (a
 * lower-cased host, a bare origin gaining its "/"), which every provider's own
 * base-URL normalizer already absorbs.
 */
function stripUrlUserinfo(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (parsed.username === "" && parsed.password === "") {
    return value;
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

/**
 * An inventory source's non-secret provider config as it may cross a share, in
 * either direction: `sanitizeForSharing` applies it on the way out, and
 * `importShareData` applies it again on the way in, because a share file is
 * untrusted input and a hand-edited one could restore anything the export
 * removed. Returns a copy.
 *
 * Every provider: URL userinfo is removed from any string value, and a value
 * under one of the source's own `secretFieldIds` is removed outright. Secrets
 * live in the vault and never in `config`, so that second rule removes nothing
 * a working source holds; it is there so a value that ever did land there (a
 * hand-edited record, a provider that once declared the field as plain text)
 * cannot ride out in a file promised to carry no credentials.
 *
 * Built-in providers only (see `BUILT_IN_INVENTORY_PROVIDER_IDS`), three fields
 * that record the SENDER's decisions rather than anything about the source:
 *  - `allowInsecureTls` is reset to `false`. Carried as `true`, a file could
 *    switch certificate checking off for the credentials the recipient is about
 *    to type into Edit Source. A self-signed server fails the first sync with
 *    the certificate hint, which names the option, so turning it back on is a
 *    decision the recipient makes knowingly.
 *  - `statusPollSeconds` is removed (absent = off). Polling is an opt-in to
 *    unattended requests from this machine to a lab server — the field sits
 *    under Advanced for that reason — and the sender's opt-in is not the
 *    recipient's. For a GNS3 2.2 server without authentication, nothing else
 *    would stand between the import and the first poll.
 *  - `username` (EVE-NG, GNS3) is removed. It is a login name, and a share
 *    rewrites every username it carries; the recipient enters their own in Edit
 *    Source with the password they must supply there anyway.
 */
function sanitizeSharedSourceConfig(providerId: unknown, config: InventorySourceValues, secretFieldIds: unknown): InventorySourceValues {
  const next: InventorySourceValues = { ...config };
  if (Array.isArray(secretFieldIds)) {
    for (const fieldId of secretFieldIds) {
      if (typeof fieldId === "string") {
        delete next[fieldId];
      }
    }
  }
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "string") {
      const stripped = stripUrlUserinfo(value);
      if (stripped !== value) {
        next[key] = stripped;
      }
    }
  }
  if (typeof providerId === "string" && BUILT_IN_INVENTORY_PROVIDER_IDS.has(providerId)) {
    if (next.allowInsecureTls !== undefined) {
      next.allowInsecureTls = false;
    }
    for (const fieldId of [EVE_NG_STATUS_POLL_FIELD_ID, PROXMOX_STATUS_POLL_FIELD_ID, GNS3_STATUS_POLL_FIELD_ID]) {
      delete next[fieldId];
    }
    delete next.username;
  }
  return next;
}

/**
 * The template ids the sources' `templateRules` name — the only device
 * templates a share carries, in either direction: the export asks it of the
 * sources it ships, the import of the sources it will import, already rebuilt
 * and validated. A template no source uses does nothing on the other side, and
 * its name, proxy and profile links are the sender's business rather than part
 * of the cache.
 */
function templateIdsNamedBySources(sources: readonly InventorySourceConfig[]): Set<string> {
  return new Set(sources.flatMap((source) => (source.templateRules ?? []).map((rule) => rule.templateId)));
}

/**
 * A source's `templateRules` with each rule rebuilt from its declared members
 * and re-pointed at its template's id in the bundle, and a rule whose template
 * did not travel (or did not land) dropped: the engine skips-and-warns on a
 * rule it cannot resolve on every sync, which is noise about a template the
 * recipient never had. `undefined` when nothing is left — absent and `[]` both
 * mean "no rules". A non-array value is returned as-is for
 * `validateInventorySource` to judge.
 */
function remapSharedTemplateRules(
  rules: TemplateRule[] | undefined,
  linkTemplate: (id: string) => string | undefined
): TemplateRule[] | undefined {
  if (!Array.isArray(rules)) {
    return rules;
  }
  const kept = rules.flatMap((rule: unknown) => {
    if (typeof rule !== "object" || rule === null) {
      return [];
    }
    const templateId = (rule as TemplateRule).templateId;
    const linked = typeof templateId === "string" ? linkTemplate(templateId) : undefined;
    return linked === undefined
      ? []
      : [shareRecord(rule as TemplateRule, SHARED_TEMPLATE_RULE_RULES, { templateId: () => linked }) as TemplateRule];
  });
  return kept.length > 0 ? kept : undefined;
}

/**
 * One device-template field's `{ mode, value }` wrapper, rebuilt from its
 * declared members with `mapValue` applied to the value — or `undefined`, which
 * removes the field ("this template says nothing about it"), when the value
 * maps to nothing. A wrapper that is not an object is returned as it is, for
 * `validateDeviceTemplate` to judge.
 */
function shareTemplateField<V>(field: TemplateField<V> | undefined, mapValue: (value: V) => V | undefined): TemplateField<V> | undefined {
  if (typeof field !== "object" || field === null) {
    return field;
  }
  const value = mapValue(field.value);
  return value === undefined
    ? undefined
    : (shareRecord(field as TemplateField<unknown>, SHARED_TEMPLATE_FIELD_WRAPPER_RULES, { value: () => value }) as TemplateField<V>);
}

/**
 * A device template's `fields`, every wrapper rebuilt and every id reference
 * re-pointed through `lenses` — profile links through `linkProfile`, the IPMI
 * gateway and a jump host through `linkServer` — or the field removed. A value
 * of the wrong type is left in place for `validateDeviceTemplate` to judge.
 */
function remapSharedTemplateFields(fields: DeviceTemplateProfile["fields"], lenses: ShareLenses): DeviceTemplateProfile["fields"] {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return fields;
  }
  const linkId = (link: (id: string) => string | undefined) => (value: string) => (typeof value === "string" ? link(value) : value);
  return shareRecord(fields, SHARED_TEMPLATE_FIELD_RULES, {
    proxy: (field) => shareTemplateField(field, (proxy) => remapProxy(proxy, lenses.linkServer)),
    authProfileId: (field) => shareTemplateField(field, linkId((id) => linkSyncAuthProfile(id, lenses))),
    ipmiAuthProfileId: (field) => shareTemplateField(field, linkId(lenses.linkProfile)),
    ipmiGatewayServerId: (field) => shareTemplateField(field, linkId(lenses.linkServer))
  });
}

/**
 * A synced server's `origin` as a share carries it, in BOTH directions — the
 * export calls this with the file's ids, the import with this machine's.
 * `sourceId` becomes the id the source has on the other side (which is what
 * makes that source own the row), and every stamp moves in LOCKSTEP with the
 * value beside it, since a stamp is the sync's record of what it last wrote and
 * a value that no longer equals its stamp reads as a hand edit the sync then
 * leaves alone for good:
 *  - `syncedUsername` becomes SHARED_USERNAME where present, because `username`
 *    does; an absent stamp falls back to the source's `defaultUsername`, which
 *    is SHARED_USERNAME too;
 *  - `syncedAuthProfileId` and the `templated` IPMI stamps go through the lens
 *    their values use, and `templated.proxy` through `remapProxy`, exactly as
 *    the server's own proxy does; `syncedAuthProfileId` is dropped with the
 *    link it records when `dropAuthLink` says the server's link is left out
 *    (`syncAuthLinkArrivesNeedingServerKey`);
 *  - `syncedInstanceKey` loses any URL userinfo (see `SHARED_ORIGIN_RULES`);
 *  - the address stamps, `externalId` and `syncedAt` are kept as they are.
 * A `templated` bag with nothing left in it is dropped.
 */
function shareOrigin(origin: ServerOrigin, sourceId: string, lenses: ShareLenses, dropAuthLink: boolean): ServerOrigin {
  return shareRecord(origin, SHARED_ORIGIN_RULES, {
    sourceId: () => sourceId,
    syncedAuthProfileId: (id) => (id === undefined || dropAuthLink ? undefined : lenses.linkProfile(id)),
    templated: (stamps) => {
      if (stamps === undefined) {
        return undefined;
      }
      const shared = shareRecord(stamps, SHARED_TEMPLATED_STAMP_RULES, {
        proxy: (proxy) => remapProxy(proxy, lenses.linkServer),
        ipmiAuthProfileId: (id) => (id === undefined ? undefined : lenses.linkProfile(id)),
        ipmiGatewayServerId: (id) => (id === undefined ? undefined : lenses.linkServer(id))
      });
      return templatedHasAnyStamp(shared) ? shared : undefined;
    }
  }) as ServerOrigin;
}

export function sanitizeForSharing(
  servers: ServerConfig[],
  tunnels: TunnelProfile[],
  serialProfiles: SerialProfile[],
  localShellProfiles: LocalShellProfile[],
  settings: Record<string, unknown> = {},
  authProfiles: AuthProfile[] = [],
  macros: TerminalMacro[] = [],
  inventorySources: InventorySourceConfig[] = [],
  deviceTemplates: DeviceTemplateProfile[] = [],
  savedFilters: SavedFilterDefinition[] = []
): SanitizedSnapshot {
  const idMap = new Map<string, string>();

  // First pass: assign new IDs for auth profiles
  for (const p of authProfiles) {
    idMap.set(p.id, randomUUID());
  }

  // Sources and templates get fresh ids BEFORE any server is built, so a synced
  // server's `origin.sourceId` and a source's `templateRules` can be re-pointed
  // at them. Maps of their own rather than `idMap`: nothing in the server or
  // profile buckets may ever resolve to one of these.
  const sourceIdMap = new Map(inventorySources.map((source) => [source.id, randomUUID()] as const));
  // Only the templates a source's rule names travel (`templateIdsNamedBySources`),
  // filtered before anything is collected from them — a profile only an unused
  // template links then stays behind too.
  const usedTemplateIds = templateIdsNamedBySources(inventorySources);
  deviceTemplates = deviceTemplates.filter((template) => usedTemplateIds.has(template.id));
  const templateIdMap = new Map(deviceTemplates.map((template) => [template.id, randomUUID()] as const));

  // A synced server keeps its `origin` only when the source it names travels
  // with it. One whose source is gone on THIS machine (a dangling origin) would
  // arrive owned by nothing, and could never be owned or adopted there either.
  const originShips = (s: ServerConfig): boolean => s.origin !== undefined && sourceIdMap.has(s.origin.sourceId);

  // ADDRESSLESS (Codex P1 review MINOR-1) — a placeholder travels only WITH its
  // origin. Its source then owns it on the recipient, whose first sync fills in
  // the address when the device has one. Without the origin it would be an
  // `addressless: true, host: ""` record nothing can ever connect to, re-address
  // or upgrade, and it would break the "addressless is written ONLY by inventory
  // sync" invariant on the recipient's machine — so it is dropped.
  servers = servers.filter((s) => s.addressless !== true || originShips(s));

  // Second pass: assign new IDs for servers
  for (const s of servers) {
    idMap.set(s.id, randomUUID());
  }

  // Build sanitized auth profiles (redact credentials, keep name)
  //
  // EVERY reference is collected, because a link to a profile left out of the
  // bundle arrives as a link to nothing. Both server links (issue #48 §3.1 — a
  // profile used ONLY as a server's IPMI credentials is referenced exactly as
  // much as one used for SSH); a source's link, which a server-only collection
  // would miss whenever no server names that profile yet; each template's two;
  // and the sync's two stamps on a shipped origin — dropped rather than
  // remapped, a stamp naming a profile the sync linked would read as "the sync
  // never linked one", and undo the per-server opt-out it records.
  //
  // A key profile ships even when the only links to it are the ones the share
  // leaves out because it arrives with no key file (`linkSyncAuthProfile`):
  // it is what the recipient gives their own key file and links on the source.
  const referencedProfileIds = new Set(
    [
      ...servers.flatMap((s) => [
        s.authProfileId,
        s.ipmiAuthProfileId,
        ...(originShips(s) ? [s.origin?.syncedAuthProfileId, s.origin?.templated?.ipmiAuthProfileId] : [])
      ]),
      ...inventorySources.map((source) => source.authProfileId),
      ...deviceTemplates.flatMap((template) => [template.fields.authProfileId?.value, template.fields.ipmiAuthProfileId?.value])
    ].filter(Boolean) as string[]
  );
  const shippedProfiles = new Map<string, AuthProfile>(); // this machine's id → the profile as the file carries it
  const newAuthProfiles = authProfiles
    .filter((p) => referencedProfileIds.has(p.id))
    .map((p) => {
      const shipped = shareRecord(p, SHARED_AUTH_PROFILE_RULES, { id: () => idMap.get(p.id)! }) as AuthProfile;
      shippedProfiles.set(p.id, shipped);
      return shipped;
    });
  /**
   * Every profile reference passes through here: the profile's id in the
   * bundle, or `undefined` when the profile is not in it — the sender's id
   * verbatim would, on the receiving side, resolve to nothing or (worse) to an
   * unrelated local profile that happens to hold it.
   */
  const linkToShippedProfile = (id: string | undefined): string | undefined => (id ? shippedProfiles.get(id)?.id : undefined);
  /** The file's ids: a profile in the bundle, a server in the bundle, or nothing — and each profile as the file carries it. */
  const lenses: ShareLenses = {
    linkProfile: linkToShippedProfile,
    linkServer: (id) => idMap.get(id),
    arrivesNeedingServerKey: (id) => authProfileNeedsServerKeyPath(shippedProfiles.get(id))
  };

  // DEVICE TEMPLATES — fresh ids, no `revision` (NexusCore mints one on every
  // write), every reference re-pointed into the bundle or removed, and a proxy
  // through `remapProxy`, the rule a server's own proxy takes.
  const newDeviceTemplates: DeviceTemplateProfile[] = deviceTemplates.map(
    (template) =>
      shareRecord(template, SHARED_TEMPLATE_RULES, {
        id: () => templateIdMap.get(template.id)!,
        fields: (fields) => remapSharedTemplateFields(fields, lenses)
      }) as DeviceTemplateProfile
  );

  // INVENTORY SOURCES — see `NexusConfigExport.inventorySources`; which fields
  // travel at all, and what the rewrites are, is `SHARED_SOURCE_RULES`. Why:
  //  - `lastSyncAt`: the recipient's tree would say "synced 3d ago" of a source
  //    that has never synced there. How old the cache is lives on each row's
  //    `origin.syncedAt`, which does travel.
  //  - `providerFingerprint`: the sender's answer about the provider extension
  //    registered on the SENDER's machine. Absent means ungated, and the
  //    recipient's first successful sync stamps their own; carried, it could
  //    raise "Provider looks different…" about a source that holds no
  //    credentials at all.
  //  - `managedFolders`: which folders the sender's syncs created, i.e. which
  //    ones they may delete when empty. The recipient's first sync records its
  //    own, exactly as the backup import's `sanitizeImportedInventorySources`
  //    arranges.
  //  - `revision`: an incarnation token; NexusCore mints one on every write.
  //  - `defaultUsername` becomes SHARED_USERNAME, matching the servers.
  //  - `config` passes `sanitizeSharedSourceConfig`.
  // `secretFieldIds` travels: it names the credential fields (never their
  // values), and the recipient's Sync Now and status poll read it to know which
  // credentials are still missing. `prunePolicy` travels as it is; the import
  // decides what a `delete` becomes.
  const newInventorySources: InventorySourceConfig[] = inventorySources.map(
    (source) =>
      shareRecord(source, SHARED_SOURCE_RULES, {
        id: () => sourceIdMap.get(source.id)!,
        prunePolicy: (policy) => policy,
        authProfileId: (id) => linkSyncAuthProfile(id, lenses),
        templateRules: (rules) => remapSharedTemplateRules(rules, (id) => templateIdMap.get(id))
      }) as InventorySourceConfig
  );

  const newServers = servers.map((s) => {
    const newId = idMap.get(s.id)!;
    // A row whose origin travels loses the sync's own link to a key profile
    // together with its stamp (`syncAuthLinkArrivesNeedingServerKey`). A row
    // whose origin does not arrives as a server no source owns, which the sync
    // never unlinks, so it keeps its link as any hand-made server does.
    const dropAuthLink = originShips(s) && syncAuthLinkArrivesNeedingServerKey(s, lenses);
    const newAuthProfileId = dropAuthLink ? undefined : linkToShippedProfile(s.authProfileId);
    const newIpmiAuthProfileId = linkToShippedProfile(s.ipmiAuthProfileId);
    // JUMP-HOST IPMI ROUTING (issue #48 PR-C) — an id reference INTO THE SERVER
    // LIST, so it remaps through the SAME idMap as `proxy.jumpHostId` (every
    // server's new id is already assigned in the second pass above), and takes
    // `remapProxy`'s out-of-export disposition: when the gateway server is not in
    // the bundle the field is dropped to `undefined`, never carried stale. An
    // unset gateway means "the BMC is reachable locally" — a safe working default
    // on the recipient — whereas a stale id can only fail confusingly at run time.
    const newIpmiGatewayServerId = s.ipmiGatewayServerId ? idMap.get(s.ipmiGatewayServerId) : undefined;
    // `origin` travels when its source does (`shareOrigin`); a dangling one is
    // dropped (see `originShips`).
    //
    // ADOPT 1 — `formerlySynced` never travels, and the two are deliberately not
    // treated alike. A shipped origin names a source that travels in the SAME
    // file and lands with a fresh id, so on the recipient it owns exactly the rows
    // it owned here, and nothing else. The marker is the adoption key: it names a
    // source removed on THIS machine, and on the recipient's it would let their
    // OWN pre-existing source of the same provider silently claim a server it
    // never synced — and take its whole lifecycle, prune policy included. Backups
    // keep the marker (full fidelity, same machine); a share never does.
    return {
      ...scrubSharedServer(s),
      id: newId,
      proxy: remapProxy(s.proxy, lenses.linkServer),
      authProfileId: newAuthProfileId,
      ipmiAuthProfileId: newIpmiAuthProfileId,
      ipmiGatewayServerId: newIpmiGatewayServerId,
      origin: originShips(s) ? shareOrigin(s.origin!, sourceIdMap.get(s.origin!.sourceId)!, lenses, dropAuthLink) : undefined
    };
  });

  // SAVED FILTERS — a name and a query string, both the same class of data as a
  // source's own filter field; only the id is new.
  const newSavedFilters: SavedFilterDefinition[] = savedFilters.map(
    (filter) => shareRecord(filter, SHARED_SAVED_FILTER_RULES, { id: () => randomUUID() }) as SavedFilterDefinition
  );

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
    return { ...scrubSharedSerialProfile(p), id: newId };
  });

  const newLocalShellProfiles = localShellProfiles.map((p) => {
    const newId = randomUUID();
    idMap.set(p.id, newId);
    return { ...scrubSharedLocalShellProfile(p), id: newId };
  });

  const sanitizedMacros = macros
    .filter((m) => !m.secret)
    // fresh ids for share exports; variable declarations normalized so a masked
    // variable's plaintext `default` never leaves this machine in a share file.
    .map((m) => withRedactedVariables({ ...m, id: randomUUID() }));

  // Sanitize paths from the settings snapshot.
  const sanitizedSettings = scrubSharedSettings(settings);

  return {
    servers: newServers,
    tunnels: newTunnels,
    serialProfiles: newSerialProfiles,
    localShellProfiles: newLocalShellProfiles,
    authProfiles: newAuthProfiles,
    macros: sanitizedMacros,
    settings: sanitizedSettings,
    inventorySources: newInventorySources,
    deviceTemplates: newDeviceTemplates,
    savedFilters: newSavedFilters
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
 * local shell profiles, Local Server profiles, saved TFTP/DHCP profiles, and
 * explicit groups are NOT captured here — none of them are vault-backed
 * (exportBackup reads those straight off `core.getSnapshot()`; a Local
 * Server's environment rides in the encrypted section but lives on the
 * profile record, not in the vault), so there is nothing for this lock to
 * protect there. Nor are the trusted SSH host keys, which live in globalState
 * and are written by the host-key verifier, which never takes this lock.
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
  context?: import("vscode").ExtensionContext,
  runtime?: ConfigRuntimeHooks
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
        // shell profiles, Local Server profiles, saved TFTP/DHCP profiles,
        // explicit groups) — none of which are vault-backed.
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

        // LOCAL SHELL and LOCAL SERVER profiles — the profile lists go in the
        // clear like every other collection; each profile's environment does
        // not (see `NexusConfigExport.localServers` / `.localShellProfiles`).
        // Both halves come from the SAME snapshot, so a profile and its
        // variables are one generation.
        const localShells = splitEnvIntoSecrets(snapshot.localShellProfiles);
        const localServers = splitEnvIntoSecrets(snapshot.localServers);
        secrets.localShellEnv = localShells.envById;
        secrets.localServerEnv = localServers.envById;
        // TRUSTED SSH HOST KEYS — in the encrypted section for INTEGRITY more than
        // secrecy: the section is authenticated (AES-GCM), so nobody holding the
        // file but not the password can swap in a key that a Replace restore
        // would then trust without the changed-key warning. It also keeps the
        // list of every host this machine has connected to — including ones no
        // profile names any more — out of the readable half of the file.
        if (context?.globalState) {
          secrets.knownHostFingerprints = readKnownHostFingerprints(context.globalState);
        }

        const clearPart: NexusConfigExport = {
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
          localShellProfiles: localShells.clear,
          authProfiles: captured.authProfiles,
          inventorySources: captured.inventorySources,
          deviceTemplates: captured.deviceTemplates,
          savedFilters: captured.savedFilters,
          localServers: localServers.clear,
          tftpProfiles: snapshot.tftpProfiles,
          dhcpProfiles: snapshot.dhcpProfiles,
          groups: snapshot.explicitGroups,
          macros: nonSecretForTopLevel,
          macroFolders: getMacroFolders(),
          settings // no longer contains nexus.terminal.macros
        };
        // The seal goes INSIDE the encrypted section; see CLEAR_PART_SEAL_VERSION.
        secrets.clearPartSeal = { version: CLEAR_PART_SEAL_VERSION, sha256: clearPartDigest(clearPart) };
        const encryptedSecrets = encrypt(JSON.stringify(secrets), masterPassword);
        const exportData: NexusConfigExport = { ...clearPart, encryptedSecrets };

        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file("nexus-backup.json"),
          filters: { "JSON Files": ["json"] },
          title: "Save Encrypted Backup"
        });
        if (!uri) return;

        const json = JSON.stringify(exportData, null, 2);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(json, "utf8"));

        const count =
          captured.servers.length +
          snapshot.tunnels.length +
          snapshot.serialProfiles.length +
          snapshot.localShellProfiles.length +
          captured.authProfiles.length +
          snapshot.localServers.length +
          snapshot.tftpProfiles.length +
          snapshot.dhcpProfiles.length;
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
      allMacros,
      snapshot.inventorySources,
      snapshot.deviceTemplates,
      snapshot.savedFilters
    );

    // Backup-only, deliberately absent here: Local Server profiles (this
    // machine's executables, paths and environment), saved TFTP/DHCP profiles
    // (this bench's interfaces and address plan) and trusted SSH host keys
    // (this machine's trust decisions). Inventory sources, the device templates
    // their rules use and saved filters DO travel, sanitized, as a cache of the
    // synced tree. See each field on NexusConfigExport.
    const exportData: NexusConfigExport = {
      version: 2,
      exportType: "share",
      exportedAt: new Date().toISOString(),
      // Stamped like a backup (review D3): every export this build writes says
      // it knows the per-source Lab Status Poll Interval, which is also why the
      // share import can discard the retired global interval outright.
      inventoryStatusPollPerSource: true,
      servers: sanitized.servers,
      tunnels: sanitized.tunnels,
      serialProfiles: sanitized.serialProfiles,
      localShellProfiles: sanitized.localShellProfiles,
      authProfiles: sanitized.authProfiles.length > 0 ? sanitized.authProfiles : undefined,
      inventorySources: sanitized.inventorySources.length > 0 ? sanitized.inventorySources : undefined,
      deviceTemplates: sanitized.deviceTemplates.length > 0 ? sanitized.deviceTemplates : undefined,
      savedFilters: sanitized.savedFilters.length > 0 ? sanitized.savedFilters : undefined,
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

    // Counted off what was WRITTEN: a placeholder whose source is gone here is
    // left out of the file, so the snapshot would over-count.
    const count =
      sanitized.servers.length +
      sanitized.tunnels.length +
      sanitized.serialProfiles.length +
      sanitized.localShellProfiles.length +
      sanitized.authProfiles.length;
    const excludedSecretCount = allMacros.filter((m) => m.secret).length;
    const sourceNote =
      sanitized.inventorySources.length > 0
        ? ` and ${plural(sanitized.inventorySources.length, "inventory source")} (without credentials)`
        : "";
    const base = `Exported ${count} profiles${sourceNote} for sharing to ${uri.fsPath}`;
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
      if (typeof decryptedSecrets !== "object" || decryptedSecrets === null || Array.isArray(decryptedSecrets)) {
        void vscode.window.showErrorMessage("Incorrect password or corrupted backup.");
        return;
      }
      // Checked against `data` exactly as parsed — the import below mutates it.
      const seal = checkClearPartSeal(data, decryptedSecrets);
      if (seal === "changed") {
        void vscode.window.showErrorMessage(
          "This backup was changed after it was created: its readable part no longer matches the part its master password protects, so nothing was imported. Import the file exactly as it was saved, or take a new backup."
        );
        return;
      }
      if (seal === "unsupported") {
        void vscode.window.showErrorMessage(
          "This backup was sealed by a newer version of Nexus, which this version cannot check, so nothing was imported. Update Nexus and import it again."
        );
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
    if (sniff === "ssh-config") {
      const choice = await vscode.window.showErrorMessage(
        "That file isn't a Nexus export — it looks like an SSH config.",
        "Import as SSH Config"
      );
      if (choice === "Import as SSH Config") await applySshConfigText(text);
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
    const deviceTemplates = data.deviceTemplates ?? [];
    const inventorySources = data.inventorySources ?? [];
    const savedFilters = data.savedFilters ?? [];

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

    // REVIEW FINDING (P2) — the profiles that actually LANDED, by id, which is
    // NOT the auth-profile half of `idMap`. `idMap` is filled in the first pass,
    // before a single record has been validated, so a profile rejected by
    // `validateAuthProfile` still holds a fresh id there — and a server remapped
    // through `idMap` alone arrives linked to a profile that was never imported.
    // Nothing downstream notices: the server persists with a link that resolves to
    // nothing, `SilentAuthSshFactory` finds no profile and silently falls back to
    // the server's own credentials, and no message anywhere says the link is dead.
    // A reachable shape is an `authType` this build does not know; nothing about
    // this is specific to it.
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
    const importedProfiles = new Map<string, AuthProfile>();

    // Each profile is rebuilt by the export's own rules (`SHARED_AUTH_PROFILE_RULES`)
    // before validation: a hand-edited file cannot land a login, a key path or a
    // member the model does not declare, and a malformed key path cannot cost
    // the profile.
    for (const profile of authProfiles) {
      const newId = idMap.get(profile.id)!;
      const remappedProfile = shareRecord(profile, SHARED_AUTH_PROFILE_RULES, { id: () => newId }) as AuthProfile;
      const added = await addIfValid(remappedProfile, validateAuthProfile, (e) => core.addOrUpdateAuthProfile(e));
      if (added) {
        importedProfiles.set(newId, remappedProfile);
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
      return remapped !== undefined && importedProfiles.has(remapped) ? remapped : undefined;
    };

    /**
     * This machine's ids, for the share rules (`ShareLenses`): a profile that
     * LANDED, and a server's fresh id, raw — the IPMI gateway is narrowed to the
     * servers that survive in the finalize loop below; a jump host, like the
     * value it mirrors, is not. A profile is judged for a key file as it landed:
     * rebuilt by `SHARED_AUTH_PROFILE_RULES`, so with none.
     */
    const lenses: ShareLenses = {
      linkProfile: (id) => linkToImportedProfile(id),
      linkServer: (id) => idMap.get(id),
      arrivesNeedingServerKey: (id) => {
        const landed = linkToImportedProfile(id);
        return landed !== undefined && authProfileNeedsServerKeyPath(importedProfiles.get(landed));
      }
    };

    // DEVICE TEMPLATES and INVENTORY SOURCES — decided before either is written,
    // because a template comes in only when a source that LANDS names it (the
    // export's own rule, `templateIdsNamedBySources`), and a source lands with
    // its rules pointing at the templates that land. So, in three steps:
    //  1. every template is rebuilt and validated: the ones that could land;
    //  2. every source is rebuilt, its rules linked to those, and validated: the
    //     ones that will land;
    //  3. the templates those sources name are written, then the sources.
    // A template no landing source names — named by no source, or only by one
    // the import rejects — is skipped and counted, rather than left behind with
    // a name, a proxy and profile links nothing uses. Deciding from the file's
    // sources before validating them is what let one through.
    //
    // A template gets a fresh id and loses `revision` before validation
    // (NexusCore mints one on every write, and a malformed one must not cost the
    // template); every reference is re-pointed through the lens its bucket uses.
    // The IPMI gateway is remapped raw, not narrowed to the servers that
    // survive: templates land before servers, and a template naming a server
    // that is not here is skip-and-warn at sync time — the disposition the
    // backup import relies on.
    const validTemplates = new Map<string, DeviceTemplateProfile>(); // payload id → the template as it would land
    for (const template of deviceTemplates) {
      if (typeof template !== "object" || template === null || typeof template.id !== "string" || validTemplates.has(template.id)) {
        skipped++;
        continue;
      }
      const newTemplateId = randomUUID();
      const remappedTemplate = shareRecord(template, SHARED_TEMPLATE_RULES, {
        id: () => newTemplateId,
        fields: (fields) => remapSharedTemplateFields(fields, lenses)
      }) as DeviceTemplateProfile;
      if (validateDeviceTemplate(remappedTemplate)) {
        validTemplates.set(template.id, remappedTemplate);
      } else {
        skipped++;
      }
    }

    // INVENTORY SOURCES — before the servers, whose `origin` must name a source
    // that LANDED (`linkToImportedSource`). Each arrives with a fresh id and no
    // credentials: nothing below writes the vault, so the recipient's Sync Now
    // refuses with "Missing saved credential … edit the source to re-enter it"
    // until they have typed their own into Edit Source.
    //
    // `SHARED_SOURCE_RULES` — the export's own rules — rebuild each source, so
    // `lastSyncAt`, `revision`, `managedFolders` and `providerFingerprint` are
    // gone BEFORE validation — as `sanitizeImportedInventorySources` arranges
    // for a backup — and a malformed one cannot cost the source. A share file is
    // untrusted, and a hand-edited one must not be able to smuggle a trust stamp
    // or folder-deletion authority onto this machine. `sanitizeForSharing` never
    // writes them; applying the same rules here is what makes that a guarantee
    // rather than a habit of our own exporter — `defaultUsername` becomes
    // SHARED_USERNAME and the config rule runs again for the same reason.
    //
    // REMOVED-DEVICE POLICY: `delete` arrives as `orphan`. The rows arrive OWNED,
    // and the recipient's credentials may see less of the source than the
    // sender's did — so their first sync could prune cached rows whose devices
    // they simply cannot see, and `delete` would delete them. `orphan` moves them
    // aside instead, and a device that reappears moves back. `keep` and `orphan`
    // travel as they are. The completion message says when this happened.
    //
    // A source whose id in the file is already held by one that will land is
    // skipped and counted — the first valid one wins, as for templates. The
    // file's rows name their source by that id, so two landing under it would
    // split the cache: the rows follow one, and the other's first sync adds
    // every device again.
    const landingSources: Array<{ payloadId: unknown; record: InventorySourceConfig; deletePolicy: boolean }> = [];
    const landingPayloadIds = new Set<string>();
    for (const source of inventorySources) {
      if (typeof source !== "object" || source === null || (typeof source.id === "string" && landingPayloadIds.has(source.id))) {
        skipped++;
        continue;
      }
      const newSourceId = randomUUID();
      const remappedSource = shareRecord(source, SHARED_SOURCE_RULES, {
        id: () => newSourceId,
        prunePolicy: (policy) => (policy === "delete" ? "orphan" : policy),
        authProfileId: (id) => linkSyncAuthProfile(id, lenses),
        templateRules: (rules) => remapSharedTemplateRules(rules, (id) => validTemplates.get(id)?.id)
      }) as InventorySourceConfig;
      if (validateInventorySource(remappedSource)) {
        landingSources.push({ payloadId: source.id, record: remappedSource, deletePolicy: source.prunePolicy === "delete" });
        if (typeof source.id === "string") {
          landingPayloadIds.add(source.id);
        }
      } else {
        skipped++;
      }
    }

    // Every rule a landing source kept names a template in `validTemplates`, and
    // all of those are written here, so each of its rules resolves.
    const usedTemplateIds = templateIdsNamedBySources(landingSources.map((landing) => landing.record));
    let importedTemplateCount = 0;
    for (const template of validTemplates.values()) {
      if (usedTemplateIds.has(template.id)) {
        await core.addOrUpdateDeviceTemplate(template);
        importedTemplateCount++;
      } else {
        skipped++;
      }
    }

    const sourceIdMap = new Map<string, string>(); // payload id → id of a source that LANDED
    const importedSourceIds: string[] = [];
    let deletePoliciesOrphaned = 0;
    for (const { payloadId, record, deletePolicy } of landingSources) {
      await core.addOrUpdateInventorySource(record);
      if (typeof payloadId === "string") {
        sourceIdMap.set(payloadId, record.id);
      }
      importedSourceIds.push(record.id);
      if (deletePolicy) {
        deletePoliciesOrphaned++;
      }
    }

    /**
     * The one rule a share import applies to a server's `origin`, and the
     * `linkToImportedProfile` lens one bucket over: the origin is KEPT only when
     * the source it names LANDED in this same import, re-pointed at that source's
     * fresh id (with every stamp rebuilt by `shareOrigin`), and dropped
     * whole otherwise. Kept, it makes the imported source own the row, so that
     * source's first sync updates it in place. Dropped are a malformed origin, one
     * whose source was rejected, and one naming a source the file does not carry
     * at all — a hand-edited file, or a share written before shares carried
     * sources — each of which would otherwise leave a row owned by nothing: never
     * synced, never pruned, never adoptable, for as long as it lives.
     *
     * The stamps are rebuilt by `shareOrigin`, the function the export uses, so
     * a hand-edited file cannot put back what the export removes, and each stamp
     * passes through the lens its value does — the reason a stamp naming a
     * profile that did not land is dropped with the link it records, rather than
     * left as a per-server opt-out nobody chose. The gate is `isValidServerOrigin`
     * and not `!== undefined`: `"origin": null` on an otherwise-valid server
     * reaches here (`validateServerConfig` accepts a malformed origin so a
     * bookkeeping field cannot cost a server its record), and reading a stamp off
     * it threw a TypeError that aborted the whole import halfway.
     */
    const linkToImportedSource = (origin: ServerOrigin | undefined, dropAuthLink: boolean): ServerOrigin | undefined => {
      if (!isValidServerOrigin(origin)) {
        return undefined;
      }
      const sourceId = sourceIdMap.get(origin.sourceId);
      if (sourceId === undefined) {
        return undefined;
      }
      return shareOrigin(origin, sourceId, lenses, dropAuthLink);
    };

    /**
     * The NEW ids of the servers that SURVIVE import — the server analogue of
     * `importedProfiles`, and the lens the IPMI gateway link passes through (see
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
      // The sync's own link to a key profile that landed with no key file is
      // left out with its stamp, exactly as on export — and only on a row that
      // keeps its origin, the one kind of row the sync would unlink.
      const syncAuthLinkUnusable = syncAuthLinkArrivesNeedingServerKey(server, lenses);
      const origin = linkToImportedSource(server.origin, syncAuthLinkUnusable);
      // ADDRESSLESS — a placeholder lands only WITH an origin. Without one it is
      // an `addressless: true, host: ""` record nothing can connect to or fill
      // in, and one that breaks "addressless is written ONLY by inventory sync"
      // on this machine. So it is skipped, and counted in the completion message.
      if (server.addressless === true && origin === undefined) {
        skipped++;
        continue;
      }
      /**
       * ADOPT 1 — `formerlySynced`, which `scrubSharedServer` drops rather than
       * remaps, deliberately NOT symmetric with `origin` below.
       *
       * An `origin` that survives `linkToImportedSource` names a source that
       * travelled in this same file and has just landed with a fresh id, so it
       * gives that source exactly the rows it owned on the sender's machine and
       * nothing else. `formerlySynced` is different in kind — it is the adoption
       * key, and `planInventorySync` matches it on `providerId` + `externalId` +
       * the server's CURRENT address, never on `sourceId`. So a marker riding in
       * on a share file is a live claim on records it never names: the
       * recipient's own PRE-EXISTING same-provider source would silently take a
       * shared record over whole — name, address, folder, and the prune policy
       * that can later delete it — for a source the recipient never removed and
       * a device they never synced.
       *
       * The provenance it asserts is also false on this machine. The marker
       * means "a source HERE synced this server, and you kept it when you
       * removed that source". The recipient did neither; what they did was
       * accept a file from someone else, which makes the record theirs by hand
       * — and the governing rule is that a server the user made by hand is
       * never adopted. A share file is untrusted third-party content by
       * construction (the same scrub replaces every server's `username` and
       * `keyPath` for that reason), so the marker is exactly the kind of assertion a trust
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
        // The export's own scrub, again: every username becomes SHARED_USERNAME —
        // a cached row's moving with the `syncedUsername` stamp `shareOrigin` has
        // just rewritten — the key path is blanked, and `formerlySynced` dropped.
        ...scrubSharedServer(server),
        id: idMap.get(server.id)!,
        proxy: remapProxy(server.proxy, lenses.linkServer),
        authProfileId: origin !== undefined && syncAuthLinkUnusable ? undefined : linkToImportedProfile(server.authProfileId),
        // The BMC credential link goes through the same lens: it is a profile
        // reference like any other, and a share bundle's ids are the sender's.
        ipmiAuthProfileId: linkToImportedProfile(server.ipmiAuthProfileId),
        // The IPMI gateway link is a SERVER-LIST reference, not a profile one, so
        // it remaps through the same `idMap` as `proxy.jumpHostId` (server half) —
        // NOT `linkToImportedProfile`. Raw-remapped here; FINALIZED below once the
        // full surviving-server set is known (`linkToImportedServer`), because a
        // raw remap alone keeps a fresh id even for a gateway that failed import.
        ipmiGatewayServerId: server.ipmiGatewayServerId ? (idMap.get(server.ipmiGatewayServerId) ?? undefined) : undefined,
        origin
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
      // 7). `shareOrigin` above raw-remapped `origin.templated.ipmiGatewayServerId`
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
      const remappedProfile: SerialProfile = { ...scrubSharedSerialProfile(profile), id: randomUUID() };
      tally(await addIfValid(remappedProfile, validateSerialProfile, (e) => core.addOrUpdateSerialProfile(e)));
    }
    for (const profile of localShellProfiles) {
      ensureId(profile as unknown as Record<string, unknown>);
      const remappedProfile: LocalShellProfile = { ...scrubSharedLocalShellProfile(profile), id: randomUUID() };
      tally(await addIfValid(remappedProfile, validateLocalShellProfile, (e) => core.addOrUpdateLocalShellProfile(e)));
    }
    // SAVED FILTERS — a name and a query string; only the id is new. Built field
    // by field so nothing else a hand-edited file puts beside them lands.
    let importedFilterCount = 0;
    for (const filter of savedFilters) {
      if (typeof filter !== "object" || filter === null) {
        skipped++;
        continue;
      }
      const remappedFilter: SavedFilterDefinition = { id: randomUUID(), name: filter.name, filter: filter.filter };
      if (await addIfValid(remappedFilter, validateSavedFilter, (e) => core.addOrUpdateSavedFilter(e))) {
        importedFilterCount++;
      } else {
        skipped++;
      }
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
      // path. A share carries sources now, but every build that writes them
      // also stamps the file `inventoryStatusPollPerSource` — so for any share
      // this build wrote, `importPredatesPerSourceStatusPoll` would refuse the
      // carry anyway, and the sources' intervals are removed on the way out
      // regardless (`sanitizeSharedSourceConfig`). What is left is a
      // hand-edited file, and for that the choice falls where the carry's own
      // doc says it must: not carrying is recoverable, while re-enabling
      // polling on a lab box behind somebody's back is not. The sources already
      // on this machine are the importer's own — the exact records the "never
      // re-arm a field the user blanked" rule protects.
      await applySettings(scrubSharedSettings(data.settings));
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
    // Counts only — a name from the file never reaches this message. Profiles
    // lead, as they always have, unless the file landed only inventory records,
    // where "0 profiles" would read as if nothing had.
    const landed: string[] = [];
    if (imported > 0 || importedSourceIds.length + importedTemplateCount + importedFilterCount === 0) {
      landed.push(`${imported} profiles`);
    }
    if (importedSourceIds.length > 0) landed.push(plural(importedSourceIds.length, "inventory source"));
    if (importedTemplateCount > 0) landed.push(plural(importedTemplateCount, "device template"));
    if (importedFilterCount > 0) landed.push(plural(importedFilterCount, "saved filter"));
    const summary = `Imported ${
      landed.length > 1 ? `${landed.slice(0, -1).join(", ")} and ${landed[landed.length - 1]}` : landed[0]
    }${skipNote}.`;
    if (importedSourceIds.length === 0) {
      void vscode.window.showInformationMessage(summary);
      return;
    }
    // Sources arrive with no credentials, so the one thing the recipient has to
    // do next is Edit Source — offered as a button (with the source already
    // chosen when there is only one) rather than described. Never awaited: the
    // configMutationLock is held across this function, and a notification with a
    // button stays up until someone answers it.
    //
    // Credentials are asked for only from a source that uses saved ones — its
    // `secretFieldIds`, the credential fields the sender actually saved. One that
    // declares none (a GNS3 2.2 server without authentication) syncs as it
    // arrives, so for it the remedy is a review, not credentials it has none of.
    // Counts only: nothing from the file reaches this message.
    const sourceCount = importedSourceIds.length;
    const needingCredentials = landingSources.filter((landing) => landing.record.secretFieldIds.length > 0).length;
    const credentialNote =
      needingCredentials === sourceCount
        ? `${sourceCount === 1 ? "The source arrives" : "Sources arrive"} without credentials — add yours in Edit Inventory Source before syncing.`
        : needingCredentials === 0
          ? `${sourceCount === 1 ? "The source uses" : "The sources use"} no saved credentials — review ${sourceCount === 1 ? "it" : "them"} in Edit Inventory Source before syncing.`
          : `${needingCredentials} of the ${sourceCount} sources ${needingCredentials === 1 ? "arrives without the credentials it uses" : "arrive without the credentials they use"} — add yours in Edit Inventory Source before syncing, and review the other ${sourceCount - needingCredentials === 1 ? "one" : sourceCount - needingCredentials} there too.`;
    const policyNote =
      deletePoliciesOrphaned > 0
        ? ` Removed-Device Policy arrived${sourceCount === 1 ? "" : ` on ${plural(deletePoliciesOrphaned, "source")}`} as Delete and was set to move servers to the "${ORPHAN_FOLDER_NAME}" subfolder instead, so a first sync that sees fewer devices than the sender's did deletes nothing — change it in Edit Inventory Source.`
        : "";
    const editSource = "Edit Inventory Source";
    void vscode.window
      .showInformationMessage(
        `${summary} ${credentialNote}${policyNote}`,
        editSource
      )
      .then((choice) => {
        if (choice === editSource) {
          void vscode.commands.executeCommand("nexus.inventory.editSource", sourceCount === 1 ? importedSourceIds[0] : undefined);
        }
      });
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

    // Prepared BEFORE the replace-mode wipe so the guard below judges each
    // entry exactly as the import will; see `unusableCarriedCollections`.
    data.localServers = prepareImportedLocalServers(data.localServers, decryptedSecrets?.localServerEnv);
    data.dhcpProfiles = sanitizeImportedDhcpProfiles(data.dhcpProfiles);
    if (mode === "replace") {
      const unusable = unusableCarriedCollections(data);
      if (unusable.length > 0) {
        const lists = unusable.length === 1
          ? `${unusable[0]} list has`
          : `${unusable.slice(0, -1).join(", ")} and ${unusable[unusable.length - 1]} lists have`;
        void vscode.window.showErrorMessage(
          `Nothing was imported: the backup's ${lists} entries, but none that can be imported, so Replace would delete yours and restore none. Import it with Merge to keep yours, or use another backup.`
        );
        return;
      }
    }

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
      // LOCAL SERVERS and SAVED TFTP/DHCP PROFILES — replaced only when the
      // payload CARRIES the collection, unlike the buckets above, which Replace
      // wipes whatever the file holds. These three first entered the backup in
      // 2.8.243, so every older backup lacks the key, and wiping on its account
      // would destroy local data the file never claimed to replace — the same
      // rule, for the same reason, as the macro-folder clear below ("Nothing
      // was replaced; nothing should have been cleared"). A backup from this
      // build always carries all three arrays, empty or not, so restoring one
      // still replaces them wholesale.
      //
      // A Local Server is stopped before its profile goes, exactly as Remove
      // Local Server does (`stopLocalServerForRemoval`) — a deleted profile must
      // not leave its process running with no row to stop it from. Nothing is
      // STARTED on the way back in: a restored profile is configuration only.
      if (Array.isArray(data.localServers)) {
        for (const server of snapshot.localServers) {
          await runtime?.stopLocalServer(server.id);
          await core.removeLocalServerConfig(server.id);
        }
      }
      // A saved profile owns no runtime state (see NexusCore.removeTftpProfile),
      // so replacing them never touches a running service.
      if (Array.isArray(data.tftpProfiles)) {
        for (const profile of snapshot.tftpProfiles) {
          await core.removeTftpProfile(profile.id);
        }
      }
      if (Array.isArray(data.dhcpProfiles)) {
        for (const profile of snapshot.dhcpProfiles) {
          await core.removeDhcpProfile(profile.id);
        }
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
          ...snapshot.savedFilters.map((f) => f.id),
          // LOCAL SERVERS / SAVED TFTP-DHCP PROFILES — same rule: a local record
          // wins over a same-id one from the file (and so does its environment).
          ...snapshot.localServers.map((c) => c.id),
          ...snapshot.tftpProfiles.map((p) => p.id),
          ...snapshot.dhcpProfiles.map((p) => p.id)
        ])
      : new Set<string>();

    let imported = 0;
    let skipped = 0;
    // id-PRESERVING import (distinct from the share path's fresh-id remap): each entity keeps
    // its id and is skipped when that id already exists. Same shape across every bucket.
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
    // Environment restored from the encrypted section first; see `restoreEnvFromSecrets`.
    restoreEnvFromSecrets(data.localShellProfiles, decryptedSecrets?.localShellEnv);
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
    // LOCAL SERVERS — environment restored from the encrypted section and the
    // folder normalised at the top of this function; see
    // `prepareImportedLocalServers`. Importing a profile never starts it.
    const localServerTally = await importPreservingIds(data.localServers, existingIds, validateLocalServerConfig, (e) =>
      core.addOrUpdateLocalServerConfig(e)
    );
    // SAVED TFTP / DHCP PROFILES — configuration only; a restore never writes
    // them into `nexus.networkServers.*` (that is Apply Profile's job) and never
    // starts a service.
    const tftpProfileTally = await importPreservingIds(data.tftpProfiles, existingIds, validateTftpConfigProfile, (e) =>
      core.addOrUpdateTftpProfile(e)
    );
    const dhcpProfileTally = await importPreservingIds(data.dhcpProfiles, existingIds, validateDhcpConfigProfile, (e) =>
      core.addOrUpdateDhcpProfile(e)
    );
    for (const tally of [
      serverTally,
      tunnelTally,
      serialTally,
      inventorySourceTally,
      localShellTally,
      authProfileTally,
      deviceTemplateTally,
      savedFilterTally,
      localServerTally,
      tftpProfileTally,
      dhcpProfileTally
    ]) {
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
    let hostKeyConflicts = 0;
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
        // more cleanly, but importPreservingIds is the generic shared path every imported
        // bucket goes through — special-casing the ordering there for inventory sources alone
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
      // TRUSTED SSH HOST KEYS — only when the backup carries a usable set: an
      // older backup has none, a set whose every entry is malformed counts as
      // none, and "no set" must not read as "trust nothing" in replace mode.
      // Merge keeps this machine's key wherever the two disagree and counts it
      // for the summary; see `restoreKnownHostFingerprints`.
      const incomingHostKeys = sanitizeKnownHostFingerprints(decryptedSecrets.knownHostFingerprints);
      if (context?.globalState && incomingHostKeys) {
        hostKeyConflicts = (await restoreKnownHostFingerprints(context.globalState, incomingHostKeys, mode)).conflicts;
      }
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
    // A replace-mode import rewrites the whole config — a payload carrying no
    // profiles empties the tree, and a filter left set would render the "No
    // matches found" row over a genuinely empty hub instead of the first-run
    // onboarding. Same contract as Complete Reset: bulk wipes clear the Hub
    // filter (via the command, so the nexus.filterActive title-bar icon swaps
    // back). Merge mode only unions and leaves the filter alone.
    if (mode === "replace") {
      await vscode.commands.executeCommand("nexus.filter.clear");
    }
    // Merge never overwrites a trusted host key (see restoreKnownHostFingerprints);
    // saying so is what keeps that from reading as a restore that silently failed.
    const hostKeyNote = hostKeyConflicts > 0
      ? ` Kept the locally trusted SSH host key for ${plural(hostKeyConflicts, "host")} where the backup holds a different key.`
      : "";
    void vscode.window.showInformationMessage(
      `Imported ${plural(imported, "profile")}${mode === "replace" ? " (replaced existing)" : ""}${skipNote}${restoredFileNote}.${hostKeyNote}`
    );
  }

  async function completeReset(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      "This will permanently delete ALL servers, tunnels, serial profiles, local shell profiles, Local Server profiles, " +
        "saved TFTP/DHCP profiles, inventory sources, device templates, saved filters, macros, groups, and saved passwords, " +
        "and reset every Nexus setting. Running Local Servers and TFTP/DHCP services are stopped before their configuration is removed. " +
        "This cannot be undone.",
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

    // The TFTP/DHCP services go first, and OUTSIDE the lock: stopping one is a
    // round trip to the daemon process, and it depends on no config the lock
    // protects. See `stopRunningNetworkServices` for why a reset stops them.
    await runtime?.stopNetworkServices();

    // CONFIG MUTATION LOCK — both confirmations have already resolved above;
    // everything from here down is the mutation phase, with no further
    // interactive UI, so it's safe to hold the lock across all of it. See
    // importMergeReplace's doc comment for the race class this closes against
    // inventoryCommands' critical sections.
    await configMutationLock.runExclusive(async () => {
      const snapshot = core.getSnapshot();

      // Delete all passwords/passphrases first (before removing servers)
      for (const server of snapshot.servers) {
        await deleteServerSecrets(vault, server.id);
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

      // Local Server profiles (issue #149) — each stopped first, as Remove Local
      // Server does, so no process outlives the profile it was started from.
      for (const server of snapshot.localServers) {
        await runtime?.stopLocalServer(server.id);
        await core.removeLocalServerConfig(server.id);
      }
      // Saved TFTP/DHCP profiles (issue #149) — configuration only; the running
      // services were stopped above, before the lock.
      for (const profile of snapshot.tftpProfiles) {
        await core.removeTftpProfile(profile.id);
      }
      for (const profile of snapshot.dhcpProfiles) {
        await core.removeDhcpProfile(profile.id);
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

      // Reset the Hub filter too — it is view state that outlives the config
      // it filtered, and a wipe that leaves it set would empty the tree under
      // an active filter, rendering the "No matches found" row over a
      // genuinely empty hub instead of the first-run onboarding. Via the
      // command so the title-bar icon (nexus.filterActive) swaps back as well.
      await vscode.commands.executeCommand("nexus.filter.clear");
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
    noun: string = "SSH session",
    /**
     * Extra lines under the confirm modal's question. Omitted by MobaXterm and
     * SecureCRT, and the options object is built without the key at all when it
     * is — their modal call is unchanged, argument for argument.
     */
    detail?: string,
    /**
     * P1 (Codex, #146) — the LAST word on which sessions get written, applied
     * INSIDE `configMutationLock` rather than by the caller beforehand.
     *
     * The ssh-config route skips hosts you already have. Deciding that before
     * the confirm modal, as it first did, left a real window: two imports in
     * one window — the first-run offer and a palette invocation, say — both
     * snapshot the same "what exists", the modal awaits a human in between,
     * and both then write, duplicating every row the lock was supposed to
     * protect. Serializing the WRITES does nothing if the decision about what
     * to write was already made outside the lock.
     *
     * Omitted by MobaXterm and SecureCRT, whose rows are written exactly as
     * before.
     */
    filterBeforeWrite?: (sessions: ImportedSession[]) => ImportedSession[],
    /**
     * A second modal button that inspects rather than imports — the
     * ssh-config branch's "Show Skipped Lines", mirroring the inventory
     * importer's. Choosing it runs the action and RETURNS: nothing is written,
     * and the user re-runs the command once they have looked. Omitted by
     * MobaXterm and SecureCRT, whose modal keeps exactly the one button it
     * always had.
     */
    extraAction?: { label: string; run: () => Promise<void> }
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
      detail ? { modal: true, detail } : { modal: true },
      ...(extraAction ? ["Import", extraAction.label] : ["Import"])
    );
    if (extraAction && confirm === extraAction.label) {
      await extraAction.run();
      return;
    }
    if (confirm !== "Import") return;

    // #84 P1 (Codex, serialization audit) — the write phase adds folders and
    // servers through per-entity full-snapshot writes; serialize it under
    // configMutationLock (AFTER the confirm modal, no UI held) so a concurrent
    // background port-heal cannot clobber it or be reverted by it.
    let written = result.sessions.length;
    await configMutationLock.runExclusive(async () => {
      // Re-decided here, under the lock, against state read here — see
      // `filterBeforeWrite`.
      const sessions = filterBeforeWrite ? filterBeforeWrite(result.sessions) : result.sessions;
      written = sessions.length;
      for (const folder of result.folders) {
        await core.addGroup(folder);
      }
      for (const session of sessions) {
        await core.addOrUpdateServer({
          id: randomUUID(),
          name: session.name,
          host: session.host,
          port: session.port,
          username: session.username,
          // Default, not a constant: MobaXterm and SecureCRT set neither field
          // and must keep producing exactly the password-auth rows they always
          // have. The ssh-config importer sets both, because an IdentityFile
          // host imported as password auth prompts for a password that does
          // not exist (see ImportedSession.authType).
          authType: session.authType ?? "password",
          keyPath: session.keyPath,
          isHidden: false,
          group: session.folder || undefined
        });
      }
    });

    if (written === 0) {
      // Everything the modal offered turned out to be present by the time the
      // lock was taken — a concurrent import won the race. Saying "Imported 0"
      // would read as a failure; nothing was wrong and nothing was lost.
      void vscode.window.showInformationMessage(
        `Nothing to import from ${sourceName} — every host was already in Nexus.`
      );
      return;
    }
    void vscode.window.showInformationMessage(
      `Imported ${written} ${pluralizeNoun(noun, written)} from ${sourceName}.`
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
    if (sniff === "ssh-config") {
      const choice = await vscode.window.showErrorMessage(message, "Import as SSH Config");
      if (choice === "Import as SSH Config") await applySshConfigText(text);
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
    if (sniff === "ssh-config") {
      // Without this branch the inventory parser reads `Host lab` positionally
      // and creates a server named `lab` whose HOST is the literal word `Host`
      // — a row that looks imported and can never connect.
      const choice = await vscode.window.showErrorMessage(
        "This looks like an SSH config file (~/.ssh/config), not a host list.",
        "Import as SSH Config",
        "Import as Host List Anyway"
      );
      if (choice === "Import as SSH Config") await applySshConfigText(text);
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

  /**
   * SSH config (`~/.ssh/config`) import: shared tail for the dialog, the
   * one-time detection offer, and every cross-branch reroute. Takes an
   * already-parsed result because the reroute paths hold BYTES, not a path.
   *
   * DECISION — RE-IMPORT SKIPS WHAT ALREADY EXISTS, it does not add it twice.
   * `applyImportedSessions` mints a fresh `randomUUID()` per row with no
   * dedupe, which never bit MobaXterm or SecureCRT: those are once-per-user
   * migrations off a file you export by hand. An ssh config is the opposite —
   * it lives at a stable path, Nexus offers to import it on first run, and
   * `Nexus: Import from SSH Config` sits in the palette forever. "Import
   * twice" is the normal case here, and doing it twice must not double every
   * server. So this route filters against existing servers on
   * host+port+username (host case-insensitively) before the tail ever sees
   * them — the same key the inventory importer dedupes on, chosen to match so
   * two bulk importers do not disagree about what "already have it" means.
   * Disclosure alone ("this ADDS, it does not merge") was the alternative and
   * is worse: it makes the user the deduplicator, on a file whose whole appeal
   * is that they never have to maintain it.
   *
   * WHAT THE SKIP DOES AND DOES NOT COVER (Codex P1, #146 — an earlier version
   * of this comment claimed more than it delivered, so the limit is stated
   * here rather than left to be rediscovered).
   *
   * WITHIN one window it is now exact: the filter is re-evaluated inside
   * `configMutationLock`, against state read inside the lock, so two imports
   * racing each other — the first-run offer and a palette invocation, with a
   * human-paced modal in between — cannot both decide to write the same host.
   *
   * ACROSS windows it is best-effort, and cannot be more than that here.
   * `core.getSnapshot()` reads this window's in-memory state; it does not
   * re-read `globalState`, and `globalState` offers no compare-and-set (see
   * the doc comment atop `vscodeConfigRepository.ts`). So a second window
   * importing the same file at the same moment may not see the first window's
   * servers, may re-add them, and its full-snapshot save may land on top of
   * the first's. That is the same last-writer-wins exposure every other
   * multi-window write in this extension carries, not one this importer
   * introduces — and `onConcurrentOverwrite` is what surfaces it. Two windows
   * importing one file in the same few seconds is not a case worth a
   * distributed lock; it IS a case worth not claiming to have solved.
   *
   * THE KEY IS host+port+username, AND IT IS A RE-IMPORT CHECK ONLY (Codex P2,
   * #146 — an earlier version of this comment said the opposite of the code AND
   * of the docs, so it is spelled out).
   *
   * It compares candidates against what is ALREADY STORED. It does not collapse
   * candidates against each other: two aliases in one file pointing at the same
   * host:port:user (`web` and `web-alias`) import as TWO servers, because one
   * `Host` block becomes one server — the promise docs/import-export.md and
   * the SSH Config File… bullet of functional-documentation §4.10 both make.
   * The alias is the name the user types, so dropping one of them loses a
   * handle they use daily, and the "duplicate differing only by name" it
   * avoids is not a cost worth that.
   *
   * The two rules compose without a special case: a second import of the same
   * file finds both aliases' keys already stored and skips both.
   */
  async function applySshConfigResult(parsed: SshConfigParseResult): Promise<void> {
    // THE DEFAULT USERNAME IS ASKED FOR WHEN THERE IS NO LOCAL ONE TO USE.
    // `localLoginName()` deliberately answers "" when the uid has no passwd
    // entry and neither `$USER` nor `$USERNAME` is set — a plain container —
    // and "" is not a username that can be STORED: `validateServerConfig`
    // requires a non-empty one for ssh, so `VscodeConfigRepository.getServers`
    // drops every such row on the next read. Imported like that, the servers
    // appear in the tree, connect for the session, and are simply gone after
    // the next window reload, with only a `console.warn` anywhere.
    //
    // Prompting rather than dropping those hosts: they are hosts the user
    // asked to import, and one answer covers all of them. Same shape as the
    // inventory importer's default-username prompt, including Esc and a blank
    // answer both cancelling the whole import — a cancelled prompt must never
    // fall through to writing the rows it exists to make valid.
    //
    // Outside `configMutationLock` (which `applyImportedSessions` takes later,
    // after its own modal): an input box is interactive UI and the lock is
    // never held across one.
    let defaultUsername = localLoginName();
    if (!defaultUsername) {
      // Counted on the real parse result rather than guessed from `entries`:
      // only the conversion knows which blocks survive token expansion, and
      // only those become rows that need a username.
      const missing = convertSshConfig(parsed).missingUsernameCount;
      if (missing > 0) {
        const username = await vscode.window.showInputBox({
          title: "Default SSH Username",
          prompt: `Applied to the ${missing} ${pluralizeNoun("host", missing)} in this SSH config that set no User`,
          value: mostCommonUsername(core.getSnapshot().servers),
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
    }

    const converted = convertSshConfig(parsed, { defaultUsername });

    // One key shape, used twice: once now to tell the user what the import
    // will skip, and again under the write lock to decide what it actually
    // writes. The second is authoritative — see `filterBeforeWrite`.
    const existingServerKeys = (): Set<string> =>
      new Set(
        core.getSnapshot().servers.map((server) => `${server.host.toLowerCase()}|${server.port}|${server.username}`)
      );
    const keyOf = (session: ImportedSession): string =>
      `${session.host.toLowerCase()}|${session.port}|${session.username}`;
    const skipExisting = (candidates: SshConfigImportedSession[]): SshConfigImportedSession[] => {
      const existing = existingServerKeys();
      return candidates.filter((session) => !existing.has(keyOf(session)));
    };

    // For the MODAL only. The write-time filter below re-runs against the full
    // candidate set, not this one — see the call to `applyImportedSessions`.
    const sessions = skipExisting(converted.sessions);
    const dedupedCount = converted.sessions.length - sessions.length;

    // Said plainly rather than as "no hosts found (N skipped)", which reads as
    // a failed parse of a file that in fact parsed perfectly.
    if (sessions.length === 0 && dedupedCount > 0) {
      const verb = dedupedCount === 1 ? "is" : "are";
      void vscode.window.showInformationMessage(
        `All ${dedupedCount} ${pluralizeNoun("host", dedupedCount)} in your SSH config ${verb} already in Nexus — nothing to import.`
      );
      return;
    }

    // COUNTED OVER `sessions`, NOT OVER EVERY CANDIDATE. The headline above the
    // detail counts the deduped list, so a total taken over all candidates
    // disagrees with it: re-import a config whose one unexpandable-IdentityFile
    // host is already in Nexus and `converted.droppedIdentityFileCount` says
    // "1 host will use password auth" about a host this import is not writing.
    // That is why the losses are flags on each session and not just totals.
    const droppedIdentityFiles = sessions.filter((session) => session.droppedIdentityFile).length;
    const droppedProxyJumps = sessions.filter((session) => session.droppedProxyJump).length;

    const detailLines: string[] = [];
    if (dedupedCount > 0) {
      detailLines.push(`${dedupedCount} ${pluralizeNoun("host", dedupedCount)} you already have will be skipped.`);
    }
    if (droppedIdentityFiles > 0) {
      // Named, because the user asked for key auth and is getting a password
      // prompt instead; the remedy is one field in the profile editor.
      detailLines.push(
        `${droppedIdentityFiles} ${pluralizeNoun("host", droppedIdentityFiles)} will use password auth: ` +
          "their IdentityFile uses an ssh token Nexus cannot expand. Set the key path on the profile afterwards."
      );
    }
    if (droppedProxyJumps > 0) {
      // A ProxyJump host imported as a direct connection is the one loss here
      // that shows up as nothing at all: the profile looks right and every
      // connect to its private address times out with no hint why. Nexus has
      // native jump hosts, so the remedy is real and one form away — this says
      // where, rather than describing a feature the reader has to go find.
      detailLines.push(
        `${droppedProxyJumps} ${pluralizeNoun("host", droppedProxyJumps)} will import as a direct connection: ` +
          "their ProxyJump is not imported. Set Proxy to \"SSH Jump Host\" and pick the Jump Host Server on the profile afterwards."
      );
    }
    if (parsed.issues.length > 0) {
      detailLines.push(
        `${parsed.issues.length} ${pluralizeNoun("line", parsed.issues.length)} could not be parsed.`
      );
    }

    await applyImportedSessions(
      { sessions, skippedCount: converted.skippedCount, folders: [] },
      "your SSH config",
      "file",
      // Names what was ACTUALLY skipped: defaults blocks (`Host *`), negations,
      // `Match` blocks and `%`-token drops. The default "non-SSH" would be a
      // lie about a file in which every entry is an SSH host.
      "wildcard or unsupported",
      "SSH host",
      detailLines.length > 0 ? detailLines.join("\n") : undefined,
      // Codex P2 (#146) — deliberately ignores what it is handed and re-derives
      // from `converted.sessions`, the COMPLETE candidate set. Filtering the
      // already-filtered list would leave the pre-modal snapshot still deciding
      // what CAN be written: a host removed from `sessions` because a matching
      // server existed is gone for good, so if that server is DELETED while the
      // modal is open, the import silently skips a host the user does have in
      // their config and does not have in Nexus. Re-deriving means the only
      // snapshot that decides anything is the one taken inside the lock.
      () => skipExisting(converted.sessions),
      // The same escape hatch the inventory importer offers, on the same
      // button, for the same class of thing: lines the parser could not read
      // (a bad `Port`, an `Include` it could not follow). It is offered only
      // when there ARE such lines, and the detail above states the count it
      // corresponds to — a button opening an empty document would be worse
      // than none. It deliberately does NOT claim to explain the "wildcard or
      // unsupported" figure: a `Host *` defaults block is not a line that
      // failed, it is a block with nothing to import, and there is no remedy
      // to name for it.
      parsed.issues.length > 0
        ? { label: "Show Skipped Lines", run: () => openInventoryIssuesDocument(parsed.issues) }
        : undefined
    );
  }

  /**
   * Reroute tail: parse already-acquired ssh-config TEXT.
   *
   * `Include` cannot be followed from bytes — the resolver needs the root's own
   * path to resolve relative include patterns against, and a reroute arrives
   * with the file already read past a different branch's dialog. Rather than
   * silently importing a subset, say so and name the route that does follow
   * them; that route exists, is one command away, and needs nothing the user
   * does not already have.
   */
  async function applySshConfigText(text: string): Promise<void> {
    const parsed = parseSshConfig(text);
    if (parsed.includes.length > 0) {
      const count = parsed.includes.length;
      void vscode.window.showWarningMessage(
        `${count} Include ${pluralizeNoun("directive", count)} in this file ${count === 1 ? "was" : "were"} not followed. ` +
          "Run Nexus: Import from SSH Config and pick the file again to import the hosts they hold."
      );
    }
    await applySshConfigResult(parsed);
  }

  /**
   * "Declared SSH config but the content disagrees" fallback — same contract as
   * every other branch: a confidently different signature gets a one-click
   * reroute with the same bytes, and the everything-else class gets the plain
   * error because there is no other signature to reroute to.
   */
  async function reportSshConfigFormatMismatch(text: string, sniff: SniffedFormat): Promise<void> {
    const message = "This doesn't look like an SSH config file — no Host or HostName line found.";
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
    if (sniff === "mobaxterm") {
      const choice = await vscode.window.showErrorMessage(message, "Import as MobaXterm");
      if (choice === "Import as MobaXterm") await applyMobaxtermText(text);
      return;
    }
    void vscode.window.showErrorMessage(message);
  }

  /**
   * Only a genuinely URI-shaped argument pre-resolves the path. VS Code hands a
   * command whatever the invoking surface passes — a tree item from a menu, a
   * string from a keybinding `args` — and treating one of those as a file would
   * stat nonsense instead of opening the dialog the user expects.
   */
  function asFileUri(arg: unknown): vscode.Uri | undefined {
    return typeof (arg as vscode.Uri | undefined)?.fsPath === "string" ? (arg as vscode.Uri) : undefined;
  }

  /**
   * `nexus.config.import.sshConfig`. With `preResolvedUri` (the one-time offer,
   * which already found and parsed `~/.ssh/config`) the file dialog is skipped
   * entirely — re-asking for a path the caller just handed over is the kind of
   * step that makes an offer not worth accepting.
   */
  async function importSshConfig(preResolvedUri?: vscode.Uri): Promise<void> {
    let uri = preResolvedUri;
    if (!uri) {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        // Opens in ~/.ssh, where the file this command exists for lives.
        defaultUri: vscode.Uri.file(defaultSshDir()),
        // NO extension filter: `~/.ssh/config` has no extension at all, so an
        // extension-based filter would hide it behind a dropdown change.
        filters: { "All Files": ["*"] },
        title: "Import from SSH Config"
      });
      if (!uris || uris.length === 0) return;
      uri = uris[0];
    }

    // Stat first and reject WITHOUT reading — the guard importHostListFile uses.
    // (importMobaxterm has no size check at all; that is the gap, not the pattern.)
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > INVENTORY_MAX_BYTES) {
      void vscode.window.showErrorMessage("The SSH config exceeds the 2 MB size limit.");
      return;
    }

    const raw = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(raw).toString("utf8");

    // REFUSE ONLY ON A POSITIVE SIGNATURE OF A DIFFERENT FORMAT (Codex P1,
    // #146). `host-list` is the catch-all — it means "no opinion", not "not an
    // ssh config" — and the sniffer's own contract is to CONTRADICT a format
    // the user already declared, never to choose one. Requiring a positive
    // `ssh-config` match inverted that and refused two configs that are
    // perfectly valid:
    //
    //   - a root that is only `Include config.d/*`, a common modern layout,
    //     which has no `Host` line anywhere in the file the user picked;
    //   - one written with lowercase `host`, which ssh(1) accepts and this
    //     parser accepts, but which is deliberately NOT a positive ssh-config
    //     signature (see `SSH_CONFIG_HOST_RE` — a whitespace-delimited host
    //     list's `host name user port` header would otherwise be misread as an
    //     ssh config, and that trade is the right way round).
    //
    // The first of those could also dead-end the one-time offer: it follows
    // includes, so it can find hosts, say so, and then have this gate refuse
    // the file when the user clicks Import.
    const sniff = sniffImportFormat(text);
    if (sniff !== "ssh-config" && sniff !== "host-list") {
      await reportSshConfigFormatMismatch(text, sniff);
      return;
    }

    // Re-read through the resolver rather than parsing `text`: only the
    // resolver follows `Include`, and it needs the root PATH to resolve
    // relative include patterns against. Every read it makes — root included —
    // goes through the same stat-first ceiling as the check above, so the
    // second read cannot exceed what the first one just cleared.
    const parsed = await resolveSshConfig(uri.fsPath, createSshConfigIo(INVENTORY_MAX_BYTES));

    // The "is this even an ssh config?" question, asked AFTER the parse rather
    // than before it. The sniffer cannot answer it for the two shapes above —
    // an include-only root has no `Host` line to see, and a lowercase one is
    // deliberately not a positive signature — but the RESOLVER can, because it
    // has followed the includes the sniffer could not. Zero blocks from a file
    // the sniffer had no opinion about is the CSV-picked-by-mistake case, and
    // it keeps the message that names the problem instead of the vaguer "no
    // hosts found", which reads as an empty config rather than a wrong file.
    //
    // NOT entry count. An earlier version of this check keyed on
    // `parsed.entries.length === 0` and explained itself by asserting that a
    // config of nothing but `Host *` parses to one entry. It does not — the
    // parser SKIPS wildcard blocks, so it parses to zero — and that assertion
    // was written without being checked, which made the check report "this is
    // not an SSH config" for two files that plainly are: a lowercase `host *`
    // defaults-only config, and an include-only root whose fragments hold
    // nothing but defaults.
    //
    // What separates "wrong file" from "valid config with nothing to import"
    // is whether the parser RECOGNISED any ssh-config grammar at all, not
    // whether that grammar yielded importable hosts.
    //
    // Asked of the parser, which is the only layer that can answer it. The
    // first attempt at this check assembled the predicate HERE, out of
    // `entries`, the skip counters and `includes.length` — and `includes` is
    // returned EMPTY by contract, because the resolver swallows those lines
    // into the splice. So an include-only root whose glob directory happens to
    // be empty came back all-zero on every term and a valid config was called
    // the wrong kind of file. That was the same mistake as the entry-count
    // version it replaced: reaching for a signal that does not survive the
    // layer it is read from. `sawSshGrammar` is ORed across the whole walk and
    // exists precisely so this caller has something that does.
    if (sniff === "host-list" && !parsed.sawSshGrammar) {
      await reportSshConfigFormatMismatch(text, sniff);
      return;
    }

    await applySshConfigResult(parsed);
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
    value?:
      | "clipboard"
      | "hostListFile"
      | "inventorySource"
      | "mobaxterm"
      | "securecrtXml"
      | "securecrtFolder"
      | "sshConfig"
      | "nexusExport";
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
    // Appended rather than inserted: the three rows above are where migrating
    // users already look, and re-ranking them to promote a new one moves a
    // target people have learned.
    {
      label: "$(key) SSH Config File…",
      description: "Hosts from ~/.ssh/config, with their IdentityFile keys",
      value: "sshConfig"
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
      case "sshConfig":
        await importSshConfig();
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
    // The argument is how the one-time offer skips the file dialog for a path
    // it has already resolved; anything that isn't a URI opens the dialog.
    vscode.commands.registerCommand("nexus.config.import.sshConfig", (arg?: unknown) => importSshConfig(asFileUri(arg))),
    vscode.commands.registerCommand("nexus.config.import.inventory", importInventory),
    vscode.commands.registerCommand("nexus.config.completeReset", completeReset)
  ];
}
