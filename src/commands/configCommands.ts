import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { ServerConfig, TunnelProfile, SerialProfile } from "../models/config";
import { validateServerConfig, validateTunnelProfile, validateSerialProfile } from "../utils/validation";

interface NexusConfigExport {
  version: 1;
  exportedAt: string;
  servers: ServerConfig[];
  tunnels: TunnelProfile[];
  serialProfiles: SerialProfile[];
  groups?: string[];
  settings: Record<string, unknown>;
}

export const SETTINGS_KEYS: Array<{ section: string; key: string }> = [
  { section: "nexus.logging", key: "sessionTranscripts" },
  { section: "nexus.logging", key: "sessionLogDirectory" },
  { section: "nexus.logging", key: "maxFileSizeMb" },
  { section: "nexus.logging", key: "maxRotatedFiles" },
  { section: "nexus.tunnel", key: "defaultConnectionMode" },
  { section: "nexus.terminal", key: "openLocation" },
  { section: "nexus.terminal", key: "keyboardPassthrough" },
  { section: "nexus.terminal", key: "passthroughKeys" },
  { section: "nexus.terminal", key: "macros" },
  { section: "nexus.terminal.highlighting", key: "enabled" },
  { section: "nexus.terminal.highlighting", key: "rules" }
];

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
  for (const [fullKey, value] of Object.entries(settings)) {
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

export function registerConfigCommands(core: NexusCore): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.config.export", async () => {
      const snapshot = core.getSnapshot();
      const exportData: NexusConfigExport = {
        version: 1,
        exportedAt: new Date().toISOString(),
        servers: snapshot.servers,
        tunnels: snapshot.tunnels,
        serialProfiles: snapshot.serialProfiles,
        groups: snapshot.explicitGroups,
        settings: readSettings()
      };

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file("nexus-config.json"),
        filters: { "JSON Files": ["json"] },
        title: "Export Nexus Configuration"
      });
      if (!uri) {
        return;
      }

      const json = JSON.stringify(exportData, null, 2);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(json, "utf8"));

      const count = snapshot.servers.length + snapshot.tunnels.length + snapshot.serialProfiles.length;
      void vscode.window.showInformationMessage(`Exported ${count} profiles to ${uri.fsPath}`);
    }),

    vscode.commands.registerCommand("nexus.config.import", async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: { "JSON Files": ["json"] },
        title: "Import Nexus Configuration"
      });
      if (!uris || uris.length === 0) {
        return;
      }

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

      const mode = await vscode.window.showQuickPick(
        [
          { label: "Merge", description: "Add imported profiles, skip existing IDs", value: "merge" as const },
          { label: "Replace", description: "Clear all existing profiles and import", value: "replace" as const }
        ],
        { title: "Import Mode" }
      );
      if (!mode) {
        return;
      }

      const snapshot = core.getSnapshot();

      if (mode.value === "replace") {
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

      const existingIds = mode.value === "merge"
        ? new Set([
            ...snapshot.servers.map((s) => s.id),
            ...snapshot.tunnels.map((t) => t.id),
            ...snapshot.serialProfiles.map((p) => p.id)
          ])
        : new Set<string>();

      let imported = 0;
      let skipped = 0;
      for (const server of data.servers) {
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

      if (data.settings && typeof data.settings === "object") {
        await applySettings(data.settings);
      }

      const skipNote = skipped > 0 ? ` (${skipped} skipped)` : "";
      void vscode.window.showInformationMessage(
        `Imported ${imported} profiles${mode.value === "replace" ? " (replaced existing)" : ""}${skipNote}.`
      );
    })
  ];
}
