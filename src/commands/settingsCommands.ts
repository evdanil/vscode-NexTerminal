import * as vscode from "vscode";
import type { SettingTreeItem, SettingsTreeProvider } from "../ui/settingsTreeProvider";

export function registerSettingsCommands(
  settingsProvider: SettingsTreeProvider,
  resolveLogDir: () => string
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.settings.edit", async (arg?: unknown) => {
      // If it's an AppearanceTreeItem, open the appearance panel instead
      if (arg instanceof Object && "contextValue" in arg && (arg as { contextValue: string }).contextValue === "nexus.appearance") {
        void vscode.commands.executeCommand("nexus.terminal.appearance");
        return;
      }

      const item = arg instanceof Object && "descriptor" in arg ? (arg as SettingTreeItem) : undefined;
      if (!item) {
        return;
      }

      const { section, key } = item.descriptor;
      const config = vscode.workspace.getConfiguration(section);
      const current = config.get(key);

      let newValue: unknown;

      if (key === "sessionLogDirectory") {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          title: "Select Session Log Directory",
          openLabel: "Select Folder"
        });
        if (!uris || uris.length === 0) {
          return;
        }
        newValue = uris[0].fsPath;
      } else if (key === "sessionTranscripts") {
        const pick = await vscode.window.showQuickPick(
          [
            { label: "On", description: "Log session transcripts by default", value: true },
            { label: "Off", description: "Disable session transcript logging by default", value: false }
          ],
          { title: "Session Transcripts" }
        );
        if (!pick) {
          return;
        }
        newValue = pick.value;
      } else if (key === "defaultConnectionMode") {
        const pick = await vscode.window.showQuickPick(
          [
            { label: "Isolated", description: "Each tunnel gets its own SSH connection (more reliable)", value: "isolated" },
            { label: "Shared", description: "Tunnels share a single SSH connection (lower resource usage)", value: "shared" }
          ],
          { title: "Default Tunnel Connection Mode" }
        );
        if (!pick) {
          return;
        }
        newValue = pick.value;
      } else if (key === "maxFileSizeMb") {
        const input = await vscode.window.showInputBox({
          title: "Max Log File Size (MB)",
          value: String(typeof current === "number" ? current : 10),
          prompt: "Enter a number between 1 and 1024",
          validateInput: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 1 || n > 1024 || Math.floor(n) !== n) {
              return "Must be a whole number between 1 and 1024";
            }
            return null;
          }
        });
        if (input === undefined) {
          return;
        }
        newValue = Number(input);
      } else if (key === "maxRotatedFiles") {
        const input = await vscode.window.showInputBox({
          title: "Max Rotated Files",
          value: String(typeof current === "number" ? current : 1),
          prompt: "Enter a number between 0 and 99",
          validateInput: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0 || n > 99 || Math.floor(n) !== n) {
              return "Must be a whole number between 0 and 99";
            }
            return null;
          }
        });
        if (input === undefined) {
          return;
        }
        newValue = Number(input);
      } else if (key === "openLocation") {
        const pick = await vscode.window.showQuickPick(
          [
            { label: "Panel", description: "Open in the terminal panel (default)", value: "panel" },
            { label: "Editor Tab", description: "Open as an editor tab", value: "editor" }
          ],
          { title: "Terminal Open Location" }
        );
        if (!pick) {
          return;
        }
        newValue = pick.value;
      } else if (key === "enabled" && section === "nexus.terminal.highlighting") {
        const pick = await vscode.window.showQuickPick(
          [
            { label: "On", description: "Highlight patterns in terminal output", value: true },
            { label: "Off", description: "Disable terminal highlighting", value: false }
          ],
          { title: "Terminal Highlighting" }
        );
        if (!pick) {
          return;
        }
        newValue = pick.value;
      } else {
        return;
      }

      await config.update(key, newValue, vscode.ConfigurationTarget.Global);
      settingsProvider.refresh();
    }),

    vscode.commands.registerCommand("nexus.settings.reset", async (arg?: unknown) => {
      const item = arg instanceof Object && "descriptor" in arg ? (arg as SettingTreeItem) : undefined;
      if (!item) {
        return;
      }
      const { section, key } = item.descriptor;
      const config = vscode.workspace.getConfiguration(section);
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);
      settingsProvider.refresh();
    }),

    vscode.commands.registerCommand("nexus.settings.openJson", () => {
      void vscode.commands.executeCommand("workbench.action.openSettingsJson", {
        revealSetting: { key: "nexus.logging" }
      });
    }),

    vscode.commands.registerCommand("nexus.settings.openLogDir", () => {
      const logDir = resolveLogDir();
      void vscode.env.openExternal(vscode.Uri.file(logDir));
    })
  ];
}
