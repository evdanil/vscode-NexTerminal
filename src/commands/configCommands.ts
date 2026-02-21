import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { ServerConfig, TunnelProfile, SerialProfile } from "../models/config";
import type { SecretVault } from "../services/ssh/contracts";
import { passwordSecretKey, passphraseSecretKey } from "../services/ssh/silentAuth";
import { encrypt, decrypt, type EncryptedPayload } from "../utils/configCrypto";
import { parseMobaxtermSessions } from "../utils/mobaxtermParser";
import { parseSecureCrtDirectory, type SecureCrtFileEntry } from "../utils/securecrtParser";
import { validateServerConfig, validateTunnelProfile, validateSerialProfile } from "../utils/validation";
import { isValidBinding } from "../macroBindings";

interface MacroEntry {
  name?: string;
  text?: string;
  secret?: boolean;
  keybinding?: string;
  [key: string]: unknown;
}

interface NexusConfigExport {
  version: 1;
  exportType?: "backup" | "share";
  exportedAt: string;
  servers: ServerConfig[];
  tunnels: TunnelProfile[];
  serialProfiles: SerialProfile[];
  groups?: string[];
  settings: Record<string, unknown>;
  encryptedSecrets?: EncryptedPayload;
}

export const SETTINGS_KEYS: Array<{ section: string; key: string }> = [
  { section: "nexus.logging", key: "sessionTranscripts" },
  { section: "nexus.logging", key: "sessionLogDirectory" },
  { section: "nexus.logging", key: "maxFileSizeMb" },
  { section: "nexus.logging", key: "maxRotatedFiles" },
  { section: "nexus.tunnel", key: "defaultConnectionMode" },
  { section: "nexus.tunnel", key: "defaultBindAddress" },
  { section: "nexus.terminal", key: "openLocation" },
  { section: "nexus.terminal", key: "keyboardPassthrough" },
  { section: "nexus.terminal", key: "passthroughKeys" },
  { section: "nexus.terminal", key: "macros" },
  { section: "nexus.terminal.highlighting", key: "enabled" },
  { section: "nexus.terminal.highlighting", key: "rules" },
  { section: "nexus.ssh.multiplexing", key: "enabled" },
  { section: "nexus.ssh.multiplexing", key: "idleTimeout" },
  { section: "nexus.sftp", key: "cacheTtlSeconds" },
  { section: "nexus.sftp", key: "maxCacheEntries" },
  { section: "nexus.sftp", key: "autoRefreshInterval" }
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

/** Strip secret macro text from settings to prevent plaintext leaks. */
function stripSecretMacroText(settings: Record<string, unknown>): Record<string, unknown> {
  const macros = settings["nexus.terminal.macros"];
  if (!Array.isArray(macros)) return settings;
  const cleaned = macros.map((m: MacroEntry) =>
    m.secret ? { ...m, text: "" } : m
  );
  return { ...settings, "nexus.terminal.macros": cleaned };
}

async function applySettings(settings: Record<string, unknown>): Promise<void> {
  const allowedSettings: Record<string, unknown> = {};
  for (const [fullKey, value] of Object.entries(settings)) {
    if (SETTINGS_KEY_SET.has(fullKey)) {
      allowedSettings[fullKey] = value;
    }
  }

  // Sanitize imported macro keybinding values
  const macros = allowedSettings["nexus.terminal.macros"];
  if (Array.isArray(macros)) {
    allowedSettings["nexus.terminal.macros"] = (macros as MacroEntry[]).map((macro) => {
      if (!macro || typeof macro !== "object") {
        return macro;
      }
      const safeMacro = { ...macro };
      if (safeMacro.keybinding && (typeof safeMacro.keybinding !== "string" || !isValidBinding(safeMacro.keybinding))) {
        delete safeMacro.keybinding;
      }
      return safeMacro;
    });
  }

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
  return (
    obj.version === 1 &&
    Array.isArray(obj.servers) &&
    Array.isArray(obj.tunnels) &&
    Array.isArray(obj.serialProfiles)
  );
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
  settings: Record<string, unknown>;
}

export function sanitizeForSharing(
  servers: ServerConfig[],
  tunnels: TunnelProfile[],
  serialProfiles: SerialProfile[],
  settings: Record<string, unknown>
): SanitizedSnapshot {
  const idMap = new Map<string, string>();

  const newServers = servers.map((s) => {
    const newId = randomUUID();
    idMap.set(s.id, newId);
    return { ...s, id: newId, username: "user", keyPath: "" };
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
    return { ...p, id: newId };
  });

  // Strip secret macros entirely and sanitize paths
  const sanitizedSettings = { ...settings };
  const macros = sanitizedSettings["nexus.terminal.macros"];
  if (Array.isArray(macros)) {
    sanitizedSettings["nexus.terminal.macros"] = macros.filter(
      (m: MacroEntry) => !m.secret
    );
  }
  if (sanitizedSettings["nexus.logging.sessionLogDirectory"]) {
    sanitizedSettings["nexus.logging.sessionLogDirectory"] = "";
  }

  return {
    servers: newServers,
    tunnels: newTunnels,
    serialProfiles: newSerialProfiles,
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

export function registerConfigCommands(core: NexusCore, vault: SecretVault): vscode.Disposable[] {
  async function exportBackup(): Promise<void> {
    const masterPassword = await promptMasterPassword();
    if (!masterPassword) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Creating encrypted backup\u2026" },
      async () => {
        const snapshot = core.getSnapshot();
        const settings = readSettings();

        // Collect secrets
        const secrets: Record<string, unknown> = { passwords: {}, passphrases: {}, secretMacros: [] };
        const passwords = secrets.passwords as Record<string, string>;
        const passphrases = secrets.passphrases as Record<string, string>;
        for (const server of snapshot.servers) {
          const pw = await vault.get(passwordSecretKey(server.id));
          if (pw) passwords[server.id] = pw;
          const pp = await vault.get(passphraseSecretKey(server.id));
          if (pp) passphrases[server.id] = pp;
        }

        // Collect secret macros
        const macros = settings["nexus.terminal.macros"];
        if (Array.isArray(macros)) {
          secrets.secretMacros = macros.filter((m: MacroEntry) => m.secret);
        }

        const encryptedSecrets = encrypt(JSON.stringify(secrets), masterPassword);

        const exportData: NexusConfigExport = {
          version: 1,
          exportType: "backup",
          exportedAt: new Date().toISOString(),
          servers: snapshot.servers,
          tunnels: snapshot.tunnels,
          serialProfiles: snapshot.serialProfiles,
          groups: snapshot.explicitGroups,
          settings: stripSecretMacroText(settings),
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

        const count = snapshot.servers.length + snapshot.tunnels.length + snapshot.serialProfiles.length;
        void vscode.window.showInformationMessage(`Backup saved with ${count} profiles to ${uri.fsPath}`);
      }
    );
  }

  async function exportShare(): Promise<void> {
    const snapshot = core.getSnapshot();
    const settings = readSettings();

    const sanitized = sanitizeForSharing(
      snapshot.servers,
      snapshot.tunnels,
      snapshot.serialProfiles,
      settings
    );

    const exportData: NexusConfigExport = {
      version: 1,
      exportType: "share",
      exportedAt: new Date().toISOString(),
      servers: sanitized.servers,
      tunnels: sanitized.tunnels,
      serialProfiles: sanitized.serialProfiles,
      groups: snapshot.explicitGroups,
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

    const count = snapshot.servers.length + snapshot.tunnels.length + snapshot.serialProfiles.length;
    void vscode.window.showInformationMessage(`Exported ${count} profiles for sharing to ${uri.fsPath}`);
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

    let imported = 0;
    let skipped = 0;
    for (const server of data.servers) {
      ensureId(server as unknown as Record<string, unknown>);
      const newId = randomUUID();
      idMap.set(server.id, newId);
      server.id = newId;
      if (validateServerConfig(server)) {
        await core.addOrUpdateServer(server);
        imported++;
      } else {
        skipped++;
      }
    }
    for (const tunnel of data.tunnels) {
      ensureId(tunnel as unknown as Record<string, unknown>);
      const newId = randomUUID();
      idMap.set(tunnel.id, newId);
      tunnel.id = newId;
      if (tunnel.defaultServerId) {
        tunnel.defaultServerId = idMap.get(tunnel.defaultServerId) ?? undefined;
      }
      if (validateTunnelProfile(tunnel)) {
        await core.addOrUpdateTunnel(tunnel);
        imported++;
      } else {
        skipped++;
      }
    }
    for (const profile of data.serialProfiles) {
      ensureId(profile as unknown as Record<string, unknown>);
      const newId = randomUUID();
      idMap.set(profile.id, newId);
      profile.id = newId;
      if (validateSerialProfile(profile)) {
        await core.addOrUpdateSerialProfile(profile);
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
      for (const group of snapshot.explicitGroups) {
        await core.removeExplicitGroup(group);
      }
    }

    const existingIds = mode === "merge"
      ? new Set([
          ...snapshot.servers.map((s) => s.id),
          ...snapshot.tunnels.map((t) => t.id),
          ...snapshot.serialProfiles.map((p) => p.id)
        ])
      : new Set<string>();

    let imported = 0;
    let skipped = 0;
    for (const server of data.servers) {
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
    for (const tunnel of data.tunnels) {
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
    for (const profile of data.serialProfiles) {
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

    if (Array.isArray(data.groups)) {
      for (const group of data.groups) {
        if (typeof group === "string" && group) {
          await core.addGroup(group);
        }
      }
    }

    // Apply settings
    if (data.settings && typeof data.settings === "object") {
      const settingsToApply = { ...data.settings };

      // Merge secret macros from decrypted secrets back into settings
      // Replace the stripped placeholder entries with the real secret macros
      if (decryptedSecrets) {
        const secretMacros = decryptedSecrets.secretMacros as MacroEntry[] | undefined;
        if (Array.isArray(secretMacros) && secretMacros.length > 0) {
          const currentMacros = (settingsToApply["nexus.terminal.macros"] as MacroEntry[] | undefined) ?? [];
          const secretByName = new Map(secretMacros.map(m => [m.name, m]));
          const merged = currentMacros.map(m => {
            if (m.secret && m.name && secretByName.has(m.name)) {
              const restored = secretByName.get(m.name)!;
              secretByName.delete(m.name);
              return restored;
            }
            return m;
          });
          // Append any secret macros not found in the settings block
          for (const remaining of secretByName.values()) {
            merged.push(remaining);
          }
          settingsToApply["nexus.terminal.macros"] = merged;
        }
      }

      await applySettings(settingsToApply);
    }

    // Restore passwords/passphrases from decrypted secrets
    if (decryptedSecrets) {
      const passwords = decryptedSecrets.passwords as Record<string, string> | undefined;
      const passphrases = decryptedSecrets.passphrases as Record<string, string> | undefined;
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

    // Remove all groups
    for (const group of snapshot.explicitGroups) {
      await core.removeExplicitGroup(group);
    }

    // Clear macros
    const termConfig = vscode.workspace.getConfiguration("nexus.terminal");
    await termConfig.update("macros", undefined, vscode.ConfigurationTarget.Global);

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
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: "Select SecureCRT Sessions Folder"
    });
    if (!uris || uris.length === 0) return;

    const rootUri = uris[0];
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

    await walkDirectory(rootUri, "");
    const result = parseSecureCrtDirectory(files);

    if (result.sessions.length === 0) {
      const note = result.skippedCount > 0
        ? `No SSH sessions found (${result.skippedCount} non-SSH skipped).`
        : "No SSH sessions found in the selected folder.";
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
