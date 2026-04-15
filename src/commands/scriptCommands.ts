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
 * @target-type ssh
 */

// Full API reference: ./types/nexus-scripts.d.ts
// Uncomment to let a specific macro fire during this run:
// @allow-macros password

try {
  const prompt = await expect(/[$#] $/, { timeout: 10_000 });
  log.info("shell ready:", prompt.text);

  await sendLine("uname -a");
  const out = await expect(/[$#] $/, { timeout: 5_000 });
  log.info("uname:", out.before.trim());
} catch (err) {
  log.error("script failed:", err?.message ?? err);
  throw err;
}
`;

function stripJsExtension(raw: string): string {
  return raw.replace(/\.js$/i, "");
}

async function createNewScript(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showInformationMessage("Open a folder to author and run Nexus scripts.");
    return;
  }
  const input = await vscode.window.showInputBox({
    prompt: "Name for the new Nexus script",
    placeHolder: "my-procedure",
    validateInput: (value) => {
      const stripped = stripJsExtension(value ?? "");
      if (!stripped) return "Name is required";
      if (!/^[A-Za-z0-9._-]+$/.test(stripped)) return "Use letters, digits, '.', '_', or '-' only";
      return undefined;
    }
  });
  if (!input) return;
  const name = stripJsExtension(input);
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

function readRepositoryUrl(): string {
  // Resolve once from package.json; bundler inlines this via require at build time.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../../package.json") as { repository?: { url?: string } };
    const raw = pkg.repository?.url ?? "";
    // git+https://... → https://..., strip .git suffix
    return raw.replace(/^git\+/, "").replace(/\.git$/, "");
  } catch {
    return "https://github.com/evdanil/vscode-NexTerminal";
  }
}

function scriptingDocsUrl(): string {
  const base = readRepositoryUrl();
  return `${base.replace(/\/+$/, "")}/blob/main/docs/scripting.md`;
}

async function deleteScript(uri: vscode.Uri): Promise<void> {
  if (!uri?.fsPath) return;
  const base = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
  const picked = await vscode.window.showWarningMessage(
    `Delete ${base}? This cannot be undone.`,
    { modal: true },
    "Delete"
  );
  if (picked !== "Delete") return;
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Failed to delete script: ${message}`);
  }
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
    }),

    vscode.commands.registerCommand("nexus.script.openDocs", async () => {
      const url = scriptingDocsUrl();
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand("nexus.script.delete", async (uri?: vscode.Uri) => {
      if (!uri) return;
      await deleteScript(uri);
    })
  ];
}
