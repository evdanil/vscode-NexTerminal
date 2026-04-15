import * as vscode from "vscode";
import type { ScriptRuntimeManager } from "../services/scripts/scriptRuntimeManager";
import { parseScriptHeader } from "../services/scripts/scriptHeader";

/**
 * Gate for authoring commands (New Script, anything that writes inside the
 * workspace). Running an existing .js script does NOT need a workspace — users
 * can open a script file directly and run it. Only the authoring surfaces need
 * somewhere to put new files / jsconfig scaffolding.
 */
function requireWorkspaceOrNotify(): boolean {
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) return true;
  void vscode.window.showInformationMessage("Open a folder to author and run Nexus scripts.");
  return false;
}

/**
 * Structural check for a URI — `instanceof vscode.Uri` is unreliable across module
 * boundaries (the Uri emitted by the tree view provider may not be the same class
 * as the one re-exported into a command callback), so we use duck-typing instead.
 */
function isUriLike(x: unknown): x is vscode.Uri {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as { fsPath?: unknown }).fsPath === "string" &&
    typeof (x as { scheme?: unknown }).scheme === "string"
  );
}

/**
 * Unwrap whatever VS Code handed to a script command's first argument into a Uri.
 *
 * Call sites we have to tolerate:
 *   - Command Palette → no argument (returns undefined, caller should prompt).
 *   - CodeLens → passes `document.uri` (a real Uri).
 *   - Tree view inline / context menu → passes the tree element, i.e. our
 *     `ScriptNode { kind, uri, name, … }`. The `uri` field is where the real Uri is.
 *   - Explorer right-click (future) → passes a Uri-like with `resourceUri`.
 *   - External automation → may pass a string path (handle as `Uri.file`).
 */
function toScriptUri(arg: unknown): vscode.Uri | undefined {
  if (!arg) return undefined;
  if (isUriLike(arg)) return arg;
  if (typeof arg === "string" && arg.length > 0) {
    try {
      return vscode.Uri.file(arg);
    } catch {
      return undefined;
    }
  }
  if (typeof arg === "object") {
    const maybe = arg as { uri?: unknown; resourceUri?: unknown };
    if (isUriLike(maybe.uri)) return maybe.uri;
    if (isUriLike(maybe.resourceUri)) return maybe.resourceUri;
  }
  return undefined;
}

/**
 * Resolve a script URI for the Palette "Run" flow.
 *
 * Order: (1) if the user's active editor is a JS file that *is* a Nexus script
 * (has `@nexus-script` marker), use that — this matches the user's intent when
 * they just hit "Run" with the script open in front of them. (2) Otherwise
 * fall back to an open-file dialog pointed at the configured scripts directory.
 */
async function pickScriptFile(): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor;
  if (active && active.document.languageId === "javascript") {
    try {
      const header = parseScriptHeader(active.document.getText());
      if (header.marker) return active.document.uri;
    } catch {
      // Fall through to the dialog.
    }
  }
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
  // Prefer the "instanceof Error" narrowing so the editor gives you full
  // access to .message / .stack without complaining under checkJs.
  // Documented codes (Timeout / ConnectionLost / Stopped / Cancelled) live
  // on the thrown object — see docs/scripting.md "Error handling".
  const message = err instanceof Error ? err.message : String(err);
  log.error("script failed:", message);
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

/**
 * Resolve the Nexus session id for a given VS Code `Terminal`, or undefined
 * if the terminal isn't a Nexus-managed session (could be a plain shell, the
 * serial sidecar host's stdio, etc.). Used by `nexus.script.runQuick` to
 * auto-pick the currently focused terminal when the user hits the tree view's
 * inline ▶ play button. Passed in from extension.ts where the two terminal
 * maps live.
 */
export type TerminalToSessionResolver = (
  terminal: vscode.Terminal | undefined
) => string | undefined;

export function registerScriptCommands(
  manager: ScriptRuntimeManager,
  outputChannel: vscode.OutputChannel,
  resolveSessionForTerminal?: TerminalToSessionResolver
): vscode.Disposable[] {
  return [
    // Running a script does NOT require an open workspace — users can open a .js
    // file directly (from disk, from an editor draft, over SSH-Remote) and run it.
    vscode.commands.registerCommand("nexus.script.run", async (arg?: unknown) => {
      const target = toScriptUri(arg) ?? (await pickScriptFile());
      if (!target) return;
      try {
        await manager.runScript(target);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to start script: ${message}`);
      }
    }),

    // Quick-run: if the user has a Nexus terminal focused, bind the script to that
    // session without the picker. Falls back to the normal picker flow when no
    // terminal is focused, or when the focused terminal isn't a Nexus session
    // (plain shell, etc.). This is wired to the Scripts tree view's inline
    // ▶ play button; the CodeLens / Palette / right-click menu keep the
    // explicit picker behaviour because those contexts aren't a user telling us
    // "the terminal I'm looking at is where I want this to run".
    vscode.commands.registerCommand("nexus.script.runQuick", async (arg?: unknown) => {
      const target = toScriptUri(arg) ?? (await pickScriptFile());
      if (!target) return;
      const sessionId = resolveSessionForTerminal?.(vscode.window.activeTerminal);
      try {
        await manager.runScript(target, sessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to start script: ${message}`);
      }
    }),

    vscode.commands.registerCommand("nexus.script.runWithTarget", async (arg: unknown, sessionId: string) => {
      const target = toScriptUri(arg);
      if (!target || !sessionId) return;
      try {
        await manager.runScript(target, sessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to start script: ${message}`);
      }
    }),

    vscode.commands.registerCommand("nexus.script.stop", async (arg?: unknown) => {
      // Stop can be invoked from (1) Palette — no arg; (2) tree view — passes ScriptNode;
      // (3) status bar tooltip / keybinding — passes the sessionId string directly.
      let target: string | undefined;
      if (typeof arg === "string") {
        target = arg;
      } else {
        const nodeUri = toScriptUri(arg);
        if (nodeUri) {
          const match = manager.getRuns().find((r) => r.scriptPath === nodeUri.fsPath);
          target = match?.sessionId;
        }
      }
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

    vscode.commands.registerCommand("nexus.script.delete", async (arg?: unknown) => {
      const uri = toScriptUri(arg);
      if (!uri) return;
      await deleteScript(uri);
    }),

    vscode.commands.registerCommand("nexus.script.openScriptsFolder", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showInformationMessage(
          "Open a folder to see the Nexus scripts directory — it lives at <workspace>/" +
            vscode.workspace.getConfiguration("nexus.scripts").get<string>("path", ".nexus/scripts")
        );
        return;
      }
      const scriptsPath = vscode.workspace
        .getConfiguration("nexus.scripts")
        .get<string>("path", ".nexus/scripts");
      const target = vscode.Uri.joinPath(folder.uri, scriptsPath);
      try {
        await vscode.workspace.fs.createDirectory(target);
      } catch {
        // Already exists — that's the normal case.
      }
      await vscode.env.openExternal(target);
    })
  ];
}
