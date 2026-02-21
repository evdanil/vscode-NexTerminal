import * as vscode from "vscode";
import { SettingsPanel } from "../ui/settingsPanel";
import { SETTINGS_META } from "../ui/settingsMetadata";

export function registerSettingsCommands(
  resolveLogDir: () => string
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.settings.openPanel", (category?: string) => {
      SettingsPanel.open(typeof category === "string" ? category : undefined);
    }),

    vscode.commands.registerCommand("nexus.settings.openJson", () => {
      void vscode.commands.executeCommand("workbench.action.openSettingsJson", {
        revealSetting: { key: "nexus.logging" }
      });
    }),

    vscode.commands.registerCommand("nexus.settings.openLogDir", () => {
      const logDir = resolveLogDir();
      void vscode.env.openExternal(vscode.Uri.file(logDir));
    }),

    vscode.commands.registerCommand("nexus.settings.resetAll", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "Reset all Nexus settings to their defaults?",
        { modal: true },
        "Reset"
      );
      if (confirm === "Reset") {
        for (const meta of SETTINGS_META) {
          const config = vscode.workspace.getConfiguration(meta.section);
          await config.update(meta.key, undefined, vscode.ConfigurationTarget.Global);
        }
        void vscode.window.showInformationMessage("All settings have been reset to defaults.");
      }
    })
  ];
}
