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

const STARTER_SCRIPT_TEMPLATE = `/**
 * @nexus-script
 * @name {{NAME}}
 * @description A new Nexus automation script.
 */

// Write to the terminal with send / sendLine; wait for output with expect / waitFor.
// Full API reference: ./types/nexus-scripts.d.ts

const prompt = await expect(/[$#] $/, { timeout: 10_000 });
log.info("shell ready:", prompt.text);

await sendLine("uname -a");
const out = await expect(/[$#] $/, { timeout: 5_000 });
log.info("uname:", out.before.trim());
`;

async function createNewScript(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showInformationMessage("Open a folder to author and run Nexus scripts.");
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: "Name for the new Nexus script",
    placeHolder: "my-procedure",
    validateInput: (value) => {
      if (!value) return "Name is required";
      if (!/^[A-Za-z0-9._-]+$/.test(value)) return "Use letters, digits, '.', '_', or '-' only";
      return undefined;
    }
  });
  if (!name) return;
  const scriptsPath = vscode.workspace.getConfiguration("nexus.scripts").get<string>("path", ".nexus/scripts");
  const target = vscode.Uri.joinPath(folder.uri, scriptsPath, `${name}.js`);
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, scriptsPath));
  } catch {
    /* idempotent */
  }
  try {
    await vscode.workspace.fs.stat(target);
    void vscode.window.showWarningMessage(`${name}.js already exists. Opening the existing file.`);
  } catch {
    const body = STARTER_SCRIPT_TEMPLATE.replace("{{NAME}}", name);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(body));
  }
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc);
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
    }),

    vscode.commands.registerCommand("nexus.script.new", async () => {
      await createNewScript();
    })
  ];
}
