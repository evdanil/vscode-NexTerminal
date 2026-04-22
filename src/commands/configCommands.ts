import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { AuthProfile, ServerConfig, TunnelProfile, SerialProfile } from "../models/config";
import type { TerminalMacro } from "../models/terminalMacro";
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
import {
  parseSecureCrtDirectory,
  parseSecureCrtXmlExport,
  type ImportParseResult,
  type SecureCrtFileEntry
} from "../utils/securecrtParser";
import { validateServerConfig, validateTunnelProfile, validateSerialProfile } from "../utils/validation";
import { isValidBinding } from "../macroBindings";
import { getMacros, saveMacros, getActiveMacroStore } from "../macroSettings";

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
  authProfiles?: AuthProfile[];
  groups?: string[];
  macros?: TerminalMacro[]; // Non-secret fields; secret macros carry `text: ""`
  settings?: Record<string, unknown>;
  encryptedSecrets?: EncryptedPayload;
}

export const SETTINGS_KEYS: Array<{ section: string; key: string }> = [
  { section: "nexus.logging", key: "sessionTranscripts" },
  { section: "nexus.logging", key: "sessionLogDirectory" },
  { section: "nexus.logging", key: "maxFileSizeMb" },
  { section: "nexus.logging", key: "maxRotatedFiles" },
  { section: "nexus.ui", key: "showTreeDescriptions" },
  { section: "nexus.tunnel", key: "defaultConnectionMode" },
  { section: "nexus.tunnel", key: "defaultBindAddress" },
  { section: "nexus.terminal", key: "openLocation" },
  { section: "nexus.terminal", key: "keyboardPassthrough" },
  { section: "nexus.terminal", key: "passthroughKeys" },
  { section: "nexus.terminal.macros", key: "autoTrigger" },
  { section: "nexus.terminal.highlighting", key: "enabled" },
  { section: "nexus.terminal.highlighting", key: "rules" },
  { section: "nexus.ssh.multiplexing", key: "enabled" },
  { section: "nexus.ssh.multiplexing", key: "idleTimeout" },
  { section: "nexus.ssh", key: "trustNewHosts" },
  { section: "nexus.sftp", key: "cacheTtlSeconds" },
  { section: "nexus.sftp", key: "maxCacheEntries" },
  { section: "nexus.sftp", key: "autoRefreshInterval" },
  { section: "nexus.sftp", key: "maxOpenFileSizeMB" },
  { section: "nexus.ssh", key: "connectionTimeout" },
  { section: "nexus.ssh", key: "keepaliveInterval" },
  { section: "nexus.ssh", key: "keepaliveCountMax" },
  { section: "nexus.ssh", key: "terminalType" },
  { section: "nexus.ssh", key: "proxyTimeout" },
  { section: "nexus.sftp", key: "operationTimeout" },
  { section: "nexus.sftp", key: "commandTimeout" },
  { section: "nexus.sftp", key: "deleteDepthLimit" },
  { section: "nexus.sftp", key: "deleteOperationLimit" },
  { section: "nexus.tunnel", key: "socks5HandshakeTimeout" },
  { section: "nexus.terminal.macros", key: "defaultCooldown" },
  { section: "nexus.terminal.macros", key: "bufferLength" },
  { section: "nexus.serial", key: "rpcTimeout" },
  { section: "nexus.sftp", key: "remoteWatchMode" },
  { section: "nexus.scripts", key: "path" },
  { section: "nexus.scripts", key: "defaultTimeout" },
  { section: "nexus.scripts", key: "macroPolicy" },
  { section: "nexus.scripts", key: "maxRuntimeMs" }
];

const SETTINGS_KEY_SET = new Set(SETTINGS_KEYS.map(({ section, key }) => `${section}.${key}`));

function readSettings(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const { section, key } of SETTINGS_KEYS) {
    const config = vscode.workspace.getConfiguration(section);
    const value = config.get(key);
    if (value !== undefined) {
      result[`${section}.${key}`] = value;
    }
  }
  return result;
}


async function applySettings(settings: Record<string, unknown>): Promise<void> {
  const allowedSettings: Record<string, unknown> = {};
  for (const [fullKey, value] of Object.entries(settings)) {
    if (SETTINGS_KEY_SET.has(fullKey)) {
      allowedSettings[fullKey] = value;
    }
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
    const config = vscode.workspace.getConfiguration(section);
    await config.update(key, value, vscode.ConfigurationTarget.Global);
  }
}

export function isValidExport(data: unknown): data is NexusConfigExport {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  const profileArrayKeys = ["servers", "tunnels", "serialProfiles", "authProfiles", "macros"] as const;
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

interface SanitizedSnapshot {
  servers: ServerConfig[];
  tunnels: TunnelProfile[];
  serialProfiles: SerialProfile[];
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
  settings: Record<string, unknown>,
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

  const sanitizedMacros = macros
    .filter((m) => !m.secret)
    .map((m) => ({ ...m, id: randomUUID() })); // fresh ids for share exports

  // Sanitize paths from the settings snapshot.
  const sanitizedSettings = { ...settings };
  if (sanitizedSettings["nexus.logging.sessionLogDirectory"]) {
    sanitizedSettings["nexus.logging.sessionLogDirectory"] = "";
  }

  return {
    servers: newServers,
    tunnels: newTunnels,
    serialProfiles: newSerialProfiles,
    authProfiles: newAuthProfiles,
    macros: sanitizedMacros,
    settings: sanitizedSettings
  };
}

async function promptMasterPassword(): Promise<string | undefined> {
  const password = await vscode.window.showInputBox({
    title: "Backup Master Password",
    prompt: "Enter a master password to encrypt your backup",
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

function keyOf(m: TerminalMacro): string {
  return `${m.name}|${m.text}|${m.triggerPattern ?? ""}|${m.keybinding ?? ""}`;
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
        return { ...m, text: plain };
      }
      return { ...m };
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
        return { ...m, text: plain };
      }
      return { ...m };
    });
    return { macros, unresolvedCount };
  }

  return undefined;
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
          secretMacros: []
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
        const nonSecretForTopLevel: TerminalMacro[] = allMacros.map((m) =>
          m.secret ? { ...m, text: "" } : { ...m }
        );
        const secretMacroBlobs = allMacros
          .filter((m) => m.secret && m.id)
          .map((m) => ({ id: m.id!, text: m.text }));

        secrets.secretMacros = secretMacroBlobs;

        const encryptedSecrets = encrypt(JSON.stringify(secrets), masterPassword);

        const exportData: NexusConfigExport = {
          version: 2,
          exportType: "backup",
          exportedAt: new Date().toISOString(),
          servers: snapshot.servers,
          tunnels: snapshot.tunnels,
          serialProfiles: snapshot.serialProfiles,
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

        const count = snapshot.servers.length + snapshot.tunnels.length + snapshot.serialProfiles.length + snapshot.authProfiles.length;
        void vscode.window.showInformationMessage(`Backup saved with ${count} profiles to ${uri.fsPath}`);
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

    const count = snapshot.servers.length + snapshot.tunnels.length + snapshot.serialProfiles.length + sanitized.authProfiles.length;
    const excludedSecretCount = allMacros.filter((m) => m.secret).length;
    const base = `Exported ${count} profiles for sharing to ${uri.fsPath}`;
    const suffix = excludedSecretCount > 0
      ? ` (${excludedSecretCount} secret macro${excludedSecretCount === 1 ? "" : "s"} excluded)`
      : "";
    void vscode.window.showInformationMessage(`${base}${suffix}.`);
  }

  async function importConfig(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { "JSON Files": ["json"] },
      title: "Import Nexus Configuration"
    });
    if (!uris || uris.length === 0) return;

    const raw = await vscode.workspace.fs.readFile(uris[0]);
    let data: unknown;
    try {
      data = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      void vscode.window.showErrorMessage("Invalid JSON file.");
      return;
    }

    if (!isValidExport(data)) {
      void vscode.window.showErrorMessage("Not a valid Nexus configuration file.");
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
        { label: "Merge", description: "Add imported profiles, skip existing IDs", value: "merge" as const },
        { label: "Replace", description: "Clear all existing profiles and import", value: "replace" as const }
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

  async function importShareData(data: NexusConfigExport): Promise<void> {
    // Generate fresh IDs to prevent duplicates on re-import
    const idMap = new Map<string, string>();

    const authProfiles = data.authProfiles ?? [];
    const servers = data.servers ?? [];
    const tunnels = data.tunnels ?? [];
    const serialProfiles = data.serialProfiles ?? [];

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

    for (const profile of authProfiles) {
      const remappedProfile: AuthProfile = {
        ...profile,
        id: idMap.get(profile.id)!
      };
      if (validateAuthProfile(remappedProfile)) {
        await core.addOrUpdateAuthProfile(remappedProfile);
        imported++;
      } else {
        skipped++;
      }
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
      if (validateServerConfig(remappedServer)) {
        await core.addOrUpdateServer(remappedServer);
        imported++;
      } else {
        skipped++;
      }
    }
    for (const tunnel of tunnels) {
      ensureId(tunnel as unknown as Record<string, unknown>);
      const remappedTunnel: TunnelProfile = {
        ...tunnel,
        id: randomUUID(),
        defaultServerId: tunnel.defaultServerId ? idMap.get(tunnel.defaultServerId) ?? undefined : undefined
      };
      if (validateTunnelProfile(remappedTunnel)) {
        await core.addOrUpdateTunnel(remappedTunnel);
        imported++;
      } else {
        skipped++;
      }
    }
    for (const profile of serialProfiles) {
      ensureId(profile as unknown as Record<string, unknown>);
      const remappedProfile: SerialProfile = {
        ...profile,
        id: randomUUID()
      };
      if (validateSerialProfile(remappedProfile)) {
        await core.addOrUpdateSerialProfile(remappedProfile);
        imported++;
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
        const remapped: TerminalMacro = { ...m, id: randomUUID() };
        if (!existingByKey.has(keyOf(remapped))) {
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
          ...snapshot.authProfiles.map((p) => p.id)
        ])
      : new Set<string>();

    let imported = 0;
    let skipped = 0;
    for (const server of data.servers ?? []) {
      ensureId(server as unknown as Record<string, unknown>);
      if (existingIds.has(server.id)) {
        skipped++;
      } else if (!validateServerConfig(server)) {
        skipped++;
      } else {
        await core.addOrUpdateServer(server);
        imported++;
      }
    }
    for (const tunnel of data.tunnels ?? []) {
      ensureId(tunnel as unknown as Record<string, unknown>);
      if (existingIds.has(tunnel.id)) {
        skipped++;
      } else if (!validateTunnelProfile(tunnel)) {
        skipped++;
      } else {
        await core.addOrUpdateTunnel(tunnel);
        imported++;
      }
    }
    for (const profile of data.serialProfiles ?? []) {
      ensureId(profile as unknown as Record<string, unknown>);
      if (existingIds.has(profile.id)) {
        skipped++;
      } else if (!validateSerialProfile(profile)) {
        skipped++;
      } else {
        await core.addOrUpdateSerialProfile(profile);
        imported++;
      }
    }
    for (const profile of data.authProfiles ?? []) {
      ensureId(profile as unknown as Record<string, unknown>);
      if (existingIds.has(profile.id)) {
        skipped++;
      } else if (!validateAuthProfile(profile)) {
        skipped++;
      } else {
        await core.addOrUpdateAuthProfile(profile);
        imported++;
      }
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
    if (decryptedSecrets) {
      const passwords = decryptedSecrets.passwords as Record<string, string> | undefined;
      const passphrases = decryptedSecrets.passphrases as Record<string, string> | undefined;
      const proxyPasswords = decryptedSecrets.proxyPasswords as Record<string, string> | undefined;
      if (passwords) {
        for (const [serverId, pw] of Object.entries(passwords)) {
          await vault.store(passwordSecretKey(serverId), pw);
        }
      }
      if (passphrases) {
        for (const [serverId, pp] of Object.entries(passphrases)) {
          await vault.store(passphraseSecretKey(serverId), pp);
        }
      }
      if (proxyPasswords) {
        for (const [serverId, pw] of Object.entries(proxyPasswords)) {
          await vault.store(proxyPasswordSecretKey(serverId), pw);
        }
      }
      const authProfilePws = decryptedSecrets.authProfilePasswords as Record<string, string> | undefined;
      if (authProfilePws) {
        for (const [profileId, pw] of Object.entries(authProfilePws)) {
          await vault.store(authProfilePasswordSecretKey(profileId), pw);
        }
      }
      const authProfilePassphrases = decryptedSecrets.authProfilePassphrases as Record<string, string> | undefined;
      if (authProfilePassphrases) {
        for (const [profileId, passphrase] of Object.entries(authProfilePassphrases)) {
          await vault.store(authProfilePassphraseSecretKey(profileId), passphrase);
        }
      }
    }

    const skipNote = skipped > 0 ? ` (${skipped} skipped)` : "";
    void vscode.window.showInformationMessage(
      `Imported ${imported} profiles${mode === "replace" ? " (replaced existing)" : ""}${skipNote}.`
    );
  }

  async function completeReset(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      "This will permanently delete ALL servers, tunnels, serial profiles, macros, groups, and saved passwords. This cannot be undone.",
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
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    }

    void vscode.window.showInformationMessage("All Nexus data has been deleted.");
  }

  async function importMobaxterm(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { "MobaXterm INI Files": ["ini"] },
      title: "Import from MobaXterm"
    });
    if (!uris || uris.length === 0) return;

    const raw = await vscode.workspace.fs.readFile(uris[0]);
    const text = Buffer.from(raw).toString("utf8");
    const result = parseMobaxtermSessions(text);

    if (result.sessions.length === 0) {
      const note = result.skippedCount > 0
        ? `No SSH sessions found (${result.skippedCount} non-SSH skipped).`
        : "No SSH sessions found in the selected file.";
      void vscode.window.showWarningMessage(note);
      return;
    }

    const folderNote = result.folders.length > 0 ? ` in ${result.folders.length} folder(s)` : "";
    const skipNote = result.skippedCount > 0 ? ` (${result.skippedCount} non-SSH skipped)` : "";
    const confirm = await vscode.window.showInformationMessage(
      `Found ${result.sessions.length} SSH session(s)${folderNote}${skipNote}. Import?`,
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
      `Imported ${result.sessions.length} SSH session(s) from MobaXterm.`
    );
  }

  async function importSecureCrt(): Promise<void> {
    const sourcePick = await vscode.window.showQuickPick(
      [
        { label: "SecureCRT XML Export File (.xml)", value: "xml" as const },
        { label: "SecureCRT Sessions Folder", value: "folder" as const }
      ],
      { title: "SecureCRT Import Source" }
    );
    if (!sourcePick) return;

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: sourcePick.value === "xml",
      canSelectFolders: sourcePick.value === "folder",
      canSelectMany: false,
      filters: sourcePick.value === "xml" ? { "SecureCRT XML Files": ["xml"] } : undefined,
      title: sourcePick.value === "xml" ? "Select SecureCRT XML Export File" : "Select SecureCRT Sessions Folder"
    });
    if (!uris || uris.length === 0) return;

    const inputUri = uris[0];
    const stat = await vscode.workspace.fs.stat(inputUri);

    let result: ImportParseResult;
    const unsupportedMsg = "Unsupported SecureCRT input. Select a SecureCRT XML export file or Sessions folder.";

    if (sourcePick.value === "folder") {
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
      result = parseSecureCrtDirectory(files);
    } else {
      const isFile = (stat.type & vscode.FileType.File) === vscode.FileType.File;
      if (!isFile || !inputUri.fsPath.toLowerCase().endsWith(".xml")) {
        void vscode.window.showErrorMessage(unsupportedMsg);
        return;
      }
      const raw = await vscode.workspace.fs.readFile(inputUri);
      if (raw.byteLength > 10 * 1024 * 1024) {
        void vscode.window.showErrorMessage("SecureCRT XML file exceeds the 10 MB size limit.");
        return;
      }
      const text = Buffer.from(raw).toString("utf8");
      try {
        result = parseSecureCrtXmlExport(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown parse error";
        void vscode.window.showErrorMessage(`Failed to parse SecureCRT XML: ${message}`);
        return;
      }
    }

    if (result.sessions.length === 0) {
      const note = result.skippedCount > 0
        ? `No SSH sessions found (${result.skippedCount} non-SSH skipped).`
        : `No SSH sessions found in the selected ${sourcePick.value === "xml" ? "file" : "folder"}.`;
      void vscode.window.showWarningMessage(note);
      return;
    }

    const folderNote = result.folders.length > 0 ? ` in ${result.folders.length} folder(s)` : "";
    const skipNote = result.skippedCount > 0 ? ` (${result.skippedCount} non-SSH skipped)` : "";
    const confirm = await vscode.window.showInformationMessage(
      `Found ${result.sessions.length} SSH session(s)${folderNote}${skipNote}. Import?`,
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
      `Imported ${result.sessions.length} SSH session(s) from SecureCRT.`
    );
  }

  return [
    vscode.commands.registerCommand("nexus.config.export", exportShare),
    vscode.commands.registerCommand("nexus.config.export.backup", exportBackup),
    vscode.commands.registerCommand("nexus.config.import", importConfig),
    vscode.commands.registerCommand("nexus.config.import.mobaxterm", importMobaxterm),
    vscode.commands.registerCommand("nexus.config.import.securecrt", importSecureCrt),
    vscode.commands.registerCommand("nexus.config.completeReset", completeReset)
  ];
}
