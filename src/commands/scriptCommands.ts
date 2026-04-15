import * as vscode from "vscode";
import type { ScriptRuntimeManager } from "../services/scripts/scriptRuntimeManager";

function requireWorkspaceOrNotify(): boolean {
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) return true;
  void vscode.window.showInformationMessage("Open a folder to author and run Nexus scripts.");
  return false;
}

async function pickScriptFile(): Promise<vscode.Uri | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const configuredDir = vscode.workspace.getConfiguration("nexus.scripts").get<string>("path", ".nexus/scripts");
  const defaultUri = root ? vscode.Uri.joinPath(root, configuredDir) : undefined;
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    filters: { "Nexus scripts": ["js"] },
    defaultUri,
    title: "Run Nexus script"
  });
  return picked?.[0];
}

export function registerScriptCommands(
  manager: ScriptRuntimeManager,
  outputChannel: vscode.OutputChannel
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.script.run", async (uri?: vscode.Uri) => {
      if (!requireWorkspaceOrNotify()) return;
      const target = uri ?? (await pickScriptFile());
      if (!target) return;
      try {
        await manager.runScript(target);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to start script: ${message}`);
      }
    }),

    vscode.commands.registerCommand("nexus.script.runWithTarget", async (uri: vscode.Uri, sessionId: string) => {
      if (!requireWorkspaceOrNotify()) return;
      if (!uri || !sessionId) return;
      try {
        await manager.runScript(uri, sessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to start script: ${message}`);
      }
    }),

    vscode.commands.registerCommand("nexus.script.stop", async (sessionId?: string) => {
      if (!requireWorkspaceOrNotify()) return;
      let target = sessionId;
      if (!target) {
        const runs = manager.getRuns();
        if (runs.length === 0) {
          void vscode.window.showInformationMessage("No Nexus scripts are running.");
          return;
        }
        if (runs.length === 1) {
          target = runs[0].sessionId;
        } else {
          const picked = await vscode.window.showQuickPick(
            runs.map((r) => ({
              label: r.scriptName,
              description: r.sessionName,
              sessionId: r.sessionId
            })),
            { placeHolder: "Stop which running script?" }
          );
          target = picked?.sessionId;
        }
      }
      if (!target) return;
      try {
        await manager.stopScript(target);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to stop script: ${message}`);
      }
    }),

    vscode.commands.registerCommand("nexus.script.openOutput", () => {
      outputChannel.show(true);
    })
  ];
}
