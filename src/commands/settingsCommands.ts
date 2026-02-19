import * as vscode from "vscode";
import { SettingsPanel } from "../ui/settingsPanel";

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
    })
  ];
}
