import * as vscode from "vscode";
import type { ScriptRuntimeManager } from "../services/scripts/scriptRuntimeManager";
import { parseScriptHeader } from "../services/scripts/scriptHeader";
import { resolveScriptsDir } from "../services/scripts/resolveScriptsDir";
import { repositoryBlobUrl, repositoryTreeUrl } from "../utils/repositoryLinks";
import { normalizeFolderPath, INVALID_FOLDER_PATH_MESSAGE } from "../utils/folderPaths";

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
 * True when `arg` is a folder `ScriptNode` from the tree view's context menu
 * (`{ kind: "folder"; path; uri; name }` — see `scriptTreeProvider.ts`). Used
 * so "New Script" / "New Folder" invoked from a folder's context menu can
 * pre-seed that folder as the destination (§5.7).
 */
function scriptFolderArgPath(arg: unknown): string | undefined {
  if (!arg || typeof arg !== "object") return undefined;
  const maybe = arg as { kind?: unknown; path?: unknown };
  if (maybe.kind !== "folder") return undefined;
  return typeof maybe.path === "string" ? maybe.path : undefined;
}

/**
 * Resolve a script URI for the Palette "Run" flow.
 *
 * Order: (1) if the user's active editor is a JS file that *is* a Nexus script
 * (has `@nexus-script` marker), use that — this matches the user's intent when
 * they just hit "Run" with the script open in front of them. (2) Otherwise
 * fall back to an open-file dialog pointed at the configured scripts directory.
 */
async function pickScriptFile(globalStoragePath: string): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor;
  if (active && active.document.languageId === "javascript") {
    try {
      const header = parseScriptHeader(active.document.getText());
      if (header.marker) return active.document.uri;
    } catch {
      // Fall through to the dialog.
    }
  }
  const defaultUri = resolveScriptsDir(globalStoragePath);
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    filters: { "Nexus scripts": ["js"] },
    defaultUri,
    title: "Run Nexus script"
  });
  return picked?.[0];
}

type ScriptTemplate = {
  id: string;
  label: string;
  description: string;
  body: string;
};

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: "basic-command",
    label: "Basic command",
    description: "Wait for a shell prompt, run one command, and log output.",
    body: `/**
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
`
  },
  {
    id: "wait-send",
    label: "Wait for prompt then send",
    description: "Wait for login-style prompts and send responses.",
    body: `/**
 * @nexus-script
 * @name {{NAME}}
 * @description Wait for terminal prompts and send responses.
 * @target-type ssh
 */

// Full API reference: ./types/nexus-scripts.d.ts

try {
  await expect(/login:\\s*$/i, { timeout: 30_000 });
  await sendLine("admin");

  await expect(/[$#] $/, { timeout: 30_000 });
  await sendLine("terminal length 0");

  const prompt = await expect(/[$#] $/, { timeout: 10_000 });
  log.info("ready:", prompt.text);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  log.error("script failed:", message);
  throw err;
}
`
  },
  {
    id: "capture-output",
    label: "Capture command output",
    description: "Run a command, capture text before the next prompt, and log it.",
    body: `/**
 * @nexus-script
 * @name {{NAME}}
 * @description Capture output from a Nexus terminal command.
 * @target-type ssh
 */

// Full API reference: ./types/nexus-scripts.d.ts

try {
  await expect(/[$#] $/, { timeout: 10_000 });
  await sendLine("show version");

  const result = await expect(/[$#] $/, { timeout: 10_000 });
  const output = result.before.trim();
  log.info("command output:", output);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  log.error("script failed:", message);
  throw err;
}
`
  },
  {
    id: "backup-running-config",
    label: "Backup running config",
    description: "Disable paging, collect running config, and log the backup text.",
    body: `/**
 * @nexus-script
 * @name {{NAME}}
 * @description Capture a network device running configuration.
 * @target-type ssh
 */

// Full API reference: ./types/nexus-scripts.d.ts

try {
  await expect(/[$#] $/, { timeout: 10_000 });
  await sendLine("terminal length 0");
  await expect(/[$#] $/, { timeout: 10_000 });

  await sendLine("show running-config");
  const result = await expect(/[$#] $/, { timeout: 30_000 });
  const runningConfig = result.before.trim();
  log.info("running config backup:", runningConfig);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  log.error("script failed:", message);
  throw err;
}
`
  }
];

function stripJsExtension(raw: string): string {
  return raw.replace(/\.js$/i, "");
}

/**
 * §5.7 — the path grammar defect v2 introduced: the pre-existing leaf regex
 * (`/^[A-Za-z0-9._-]+$/`) is safe ONLY because the old validator forbade "/"
 * entirely. Once "/" is allowed so New Script can create into a folder
 * (`cisco/backup`), the directory segments must be validated SEPARATELY with
 * `normalizeFolderPath` (which rejects "..", ".", and "\" per segment and caps
 * depth) — the leaf regex alone would accept ".." as a segment, and
 * `Uri.joinPath(scriptsDir, "..", "..", "home", "evgeny", "startup.js")`
 * resolves outside the scripts directory entirely. `\` is rejected up front
 * with an explicit "use /" message, since this user base is on Windows/WSL
 * and will type `cisco\backup`.
 */
export interface ScriptPathParts {
  /** Normalized folder path the leaf lives in, or undefined for the scripts root. */
  dirPath?: string;
  /** The bare script name (no extension, no "/"). */
  leaf: string;
}

function splitScriptPathSegments(raw: string): string[] {
  return stripJsExtension(raw.trim())
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function parseScriptPathInput(raw: string): ScriptPathParts | undefined {
  if (raw.includes("\\")) return undefined;
  const segments = splitScriptPathSegments(raw);
  if (segments.length === 0) return undefined;
  const leaf = segments[segments.length - 1];
  if (!/^[A-Za-z0-9._-]+$/.test(leaf)) return undefined;
  const dirSegments = segments.slice(0, -1);
  if (dirSegments.length === 0) return { leaf };
  const dirPath = normalizeFolderPath(dirSegments.join("/"));
  if (dirPath === undefined) return undefined;
  return { dirPath, leaf };
}

function validateScriptPathInput(raw: string): string | undefined {
  if (raw.includes("\\")) {
    return "Use '/' to separate folders, not '\\'.";
  }
  const segments = splitScriptPathSegments(raw);
  if (segments.length === 0) return "Name is required";
  const leaf = segments[segments.length - 1];
  if (!/^[A-Za-z0-9._-]+$/.test(leaf)) {
    return "Use letters, digits, '.', '_', or '-' for the script name";
  }
  if (segments.length > 1) {
    const dirPath = normalizeFolderPath(segments.slice(0, -1).join("/"));
    if (dirPath === undefined) {
      return INVALID_FOLDER_PATH_MESSAGE;
    }
  }
  return undefined;
}

function validateNewScriptFolderPath(raw: string): string | undefined {
  if (raw.includes("\\")) {
    return "Use '/' to separate folders, not '\\'.";
  }
  const trimmed = raw.trim();
  if (!trimmed) return "Folder path is required";
  if (normalizeFolderPath(trimmed) === undefined) {
    return INVALID_FOLDER_PATH_MESSAGE;
  }
  return undefined;
}

function resolveScriptTemplate(picked: unknown): ScriptTemplate | undefined {
  if (!picked || typeof picked !== "object") return undefined;
  const maybe = picked as { template?: ScriptTemplate; templateId?: string; id?: string; label?: string };
  if (maybe.template) return maybe.template;
  return SCRIPT_TEMPLATES.find(
    (template) => template.id === maybe.templateId || template.id === maybe.id || template.label === maybe.label
  );
}

async function pickScriptTemplate(): Promise<ScriptTemplate | undefined> {
  const picked = await vscode.window.showQuickPick(
    SCRIPT_TEMPLATES.map((template) => ({
      label: template.label,
      description: template.description,
      templateId: template.id,
      template
    })),
    {
      title: "New Nexus Script",
      placeHolder: "Choose a starter template"
    }
  );
  return resolveScriptTemplate(picked);
}

/**
 * @param initialFolder - when invoked from a folder's context menu, the
 * folder-relative path to pre-seed as a `folder/` prefix (§5.7) so the user
 * just types the leaf name.
 */
async function createNewScript(globalStoragePath: string, initialFolder?: string): Promise<void> {
  const template = await pickScriptTemplate();
  if (!template) return;

  const initialValue = initialFolder ? `${initialFolder}/` : "";
  const input = await vscode.window.showInputBox({
    prompt: "Name for the new Nexus script (use / for a folder, e.g. cisco/backup)",
    placeHolder: "my-procedure",
    value: initialValue || undefined,
    valueSelection: initialValue ? [initialValue.length, initialValue.length] : undefined,
    validateInput: validateScriptPathInput
  });
  if (!input) return;
  const parsed = parseScriptPathInput(input);
  if (!parsed) return;
  const { dirPath, leaf } = parsed;
  const scriptsDir = resolveScriptsDir(globalStoragePath);
  const targetDir = dirPath ? vscode.Uri.joinPath(scriptsDir, dirPath) : scriptsDir;
  const target = vscode.Uri.joinPath(targetDir, `${leaf}.js`);
  try {
    // Recursive (mkdir -p semantics) — also creates any intermediate folders
    // in `dirPath` (§5.7 — "New Script accepts a path, creating intermediate
    // directories").
    await vscode.workspace.fs.createDirectory(targetDir);
  } catch {
    /* idempotent */
  }
  try {
    await vscode.workspace.fs.stat(target);
    void vscode.window.showWarningMessage(`${leaf}.js already exists. Opening the existing file.`);
  } catch {
    const body = template.body.replaceAll("{{NAME}}", leaf);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(body));
  }
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc);
}

/**
 * §5.7 — "New Folder" creates a real directory under the scripts root; it
 * renders in the Scripts tree immediately (all directories show, whether or
 * not they contain scripts — §5.4) and survives empty, same as the other two
 * sidebars' folders (§1.1). Naming an existing folder is a no-op with an info
 * message, not an error.
 *
 * @param initialFolder - when invoked from a folder's context menu, seeds a
 * `folder/` prefix so the created folder nests under it.
 */
async function createNewScriptFolder(globalStoragePath: string, initialFolder?: string): Promise<void> {
  const initialValue = initialFolder ? `${initialFolder}/` : "";
  const input = await vscode.window.showInputBox({
    title: "New Script Folder",
    prompt: "Enter a folder path (use / for nested folders)",
    placeHolder: "e.g. cisco/backup",
    value: initialValue || undefined,
    valueSelection: initialValue ? [initialValue.length, initialValue.length] : undefined,
    validateInput: validateNewScriptFolderPath
  });
  if (!input) return;
  const normalized = normalizeFolderPath(input.trim());
  if (!normalized) return;
  const scriptsDir = resolveScriptsDir(globalStoragePath);
  const target = vscode.Uri.joinPath(scriptsDir, normalized);
  try {
    await vscode.workspace.fs.stat(target);
    void vscode.window.showInformationMessage(`Folder "${normalized}" already exists.`);
    return;
  } catch {
    // Doesn't exist yet — fall through and create it.
  }
  await vscode.workspace.fs.createDirectory(target);
}

function scriptingDocsUrl(): string {
  return repositoryBlobUrl("docs/scripting.md");
}

function scriptExamplesUrl(): string {
  return repositoryTreeUrl("examples/scripts");
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
  globalStoragePath: string,
  resolveSessionForTerminal?: TerminalToSessionResolver,
  refreshScriptTree?: () => void
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.script.run", async (arg?: unknown) => {
      const target = toScriptUri(arg) ?? (await pickScriptFile(globalStoragePath));
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
      const target = toScriptUri(arg) ?? (await pickScriptFile(globalStoragePath));
      if (!target) return;
      const sessionId = resolveSessionForTerminal?.(vscode.window.activeTerminal);
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

    // Invoked with no arg from the view-title button / CodeLens / Palette, or
    // with a folder `ScriptNode` from a folder's right-click menu (§5.7) — in
    // the latter case the folder path pre-seeds the input box.
    vscode.commands.registerCommand("nexus.script.new", async (arg?: unknown) => {
      await createNewScript(globalStoragePath, scriptFolderArgPath(arg));
    }),

    // §5.7 — View-title button + folder context menu. Creates a real
    // directory that renders immediately and persists empty (§1.1, §5.4).
    vscode.commands.registerCommand("nexus.script.newFolder", async (arg?: unknown) => {
      await createNewScriptFolder(globalStoragePath, scriptFolderArgPath(arg));
    }),

    // §5.2 — manual rescan button on the Scripts view title bar. Bypasses the
    // watcher's debounce so a user who just renamed a folder outside VS Code
    // doesn't have to wait ~300ms or trigger another filesystem event.
    vscode.commands.registerCommand("nexus.script.refresh", () => {
      refreshScriptTree?.();
    }),

    vscode.commands.registerCommand("nexus.script.openDocs", async () => {
      const url = scriptingDocsUrl();
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand("nexus.script.openExamples", async () => {
      const url = scriptExamplesUrl();
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand("nexus.script.delete", async (arg?: unknown) => {
      const uri = toScriptUri(arg);
      if (!uri) return;
      await deleteScript(uri);
    }),

    // Namespaced wrapper around the built-in `revealInExplorer`. Registering
    // directly under `revealInExplorer` in the manifest silenced the validator
    // warning but risked colliding with VS Code's own palette declaration.
    // Owning a `nexus.*` id + delegating keeps the menu label under our
    // control and avoids any ambiguity.
    vscode.commands.registerCommand("nexus.script.revealInExplorer", async (arg?: unknown) => {
      const uri = toScriptUri(arg);
      if (!uri) return;
      await vscode.commands.executeCommand("revealInExplorer", uri);
    }),

    vscode.commands.registerCommand("nexus.script.edit", async (arg?: unknown) => {
      const uri = toScriptUri(arg);
      if (!uri) return;
      await vscode.commands.executeCommand("vscode.open", uri);
    }),

    vscode.commands.registerCommand("nexus.script.openScriptsFolder", async () => {
      const target = resolveScriptsDir(globalStoragePath);
      try {
        await vscode.workspace.fs.createDirectory(target);
      } catch {
        // Already exists — that's the normal case.
      }
      try {
        await vscode.commands.executeCommand("revealFileInOS", target);
      } catch {
        // revealFileInOS can fail on some platforms (e.g. remote); fall back
        // to openExternal which may open a browser or the OS default handler.
        await vscode.env.openExternal(target);
      }
    })
  ];
}
