import * as vscode from "vscode";
import type { ScriptRuntimeManager } from "../services/scripts/scriptRuntimeManager";
import { parseScriptHeader } from "../services/scripts/scriptHeader";
import { resolveScriptsDir } from "../services/scripts/resolveScriptsDir";
import { findHiddenScriptFolderSegment } from "../services/scripts/scriptScanner";
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

const FIRST_PROMPT_COMMENT = `  // The script only sees output that arrives after it starts. On a terminal
  // that is already open, the prompt is on screen and will not come again;
  // under Connect and Run Script… it usually arrives just after the start.
  // So wait briefly, and press Enter for a fresh prompt only if none came —
  // an Enter while the first prompt is on its way leaves a spare one for a
  // later wait to match too early.`;

const IOS_PROMPT_DECLARATION = `// IOS and IOS XE prompts end in ">" or "#" with no trailing space ("Router#");
// the optional space also matches NX-OS-style "switch# ". Adapt it to your device.
const PROMPT = /[>#] ?$/;`;

const API_REFERENCE_COMMENT = "// Full API reference: types/nexus-scripts.d.ts at the top of your scripts folder.";

/**
 * Starter templates for New Script. They are most users' first script, so they
 * follow the scripting guide (docs/scripting.md):
 *
 * - Each opens by waiting briefly for its first prompt and pressing Enter only
 *   if none came. A script sees only output that arrives after it starts, so
 *   on an idle, already-open terminal a plain first wait times out; but an
 *   unconditional Enter leaves a spare prompt when the first one is still on
 *   its way (Connect and Run Script… on SSH / Telnet). Which of the two a run
 *   meets is a race — runScript awaits file reads before it starts watching
 *   the output — so the opening must not depend on the launch path.
 * - The prompt pattern is declared once, as `PROMPT`, and fits the commands the
 *   template sends: a shell prompt ends in "$ " or "# ", an IOS / IOS XE prompt
 *   in ">" or "#" with no trailing space ("Router#").
 * - No local shadows a script API global (a `const prompt` would make
 *   `prompt()` a Match for the rest of the script).
 * - Header tags are read only from the leading JSDoc block, so `@allow-macros`
 *   is explained there, never offered as a line to uncomment in the body.
 */
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
 *
 * To let a macro keep firing while this script runs, add a header line
 * "@allow-macros <macro name>" to this block (tags anywhere else are ignored).
 */

${API_REFERENCE_COMMENT}

// A shell prompt ends in "$ " or "# ". Adapt it to your host.
const PROMPT = /[$#] $/;

try {
${FIRST_PROMPT_COMMENT}
  if (!(await waitFor(PROMPT, { timeout: 2_000 }))) {
    await sendLine("");
    await expect(PROMPT, { timeout: 10_000 });
  }
  log.info("shell ready");

  await sendLine("uname -a");
  const out = await expect(PROMPT, { timeout: 5_000 });
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

${API_REFERENCE_COMMENT}

${IOS_PROMPT_DECLARATION}
const LOGIN = /login:\\s*$/i;

try {
${FIRST_PROMPT_COMMENT}
  if (!(await waitFor(LOGIN, { timeout: 2_000 }))) {
    await sendLine("");
    await expect(LOGIN, { timeout: 30_000 });
  }
  await sendLine("admin");

  await expect(PROMPT, { timeout: 30_000 });
  await sendLine("terminal length 0");

  const ready = await expect(PROMPT, { timeout: 10_000 });
  log.info("ready:", ready.text);
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

${API_REFERENCE_COMMENT}

${IOS_PROMPT_DECLARATION}

try {
${FIRST_PROMPT_COMMENT}
  if (!(await waitFor(PROMPT, { timeout: 2_000 }))) {
    await sendLine("");
    await expect(PROMPT, { timeout: 10_000 });
  }
  // Without this, output longer than a screen stops at --More-- and the
  // wait below times out.
  await sendLine("terminal length 0");
  await expect(PROMPT, { timeout: 10_000 });

  await sendLine("show version");
  const result = await expect(PROMPT, { timeout: 10_000 });
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

${API_REFERENCE_COMMENT}

${IOS_PROMPT_DECLARATION}

try {
${FIRST_PROMPT_COMMENT}
  if (!(await waitFor(PROMPT, { timeout: 2_000 }))) {
    await sendLine("");
    await expect(PROMPT, { timeout: 10_000 });
  }
  await sendLine("terminal length 0");
  await expect(PROMPT, { timeout: 10_000 });

  await sendLine("show running-config");
  const result = await expect(PROMPT, { timeout: 30_000 });
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
  // Fix 7 — a trailing "/" (e.g. the pre-seeded "cisco/" from a folder's
  // context menu, submitted unchanged) has no leaf segment at all:
  // `splitScriptPathSegments` trims it away silently, which previously left
  // `dirSegments` empty and `leaf` equal to what the user actually meant as
  // the FOLDER — creating the script at the scripts ROOT instead of inside
  // the folder that was right-clicked. Reject it outright rather than
  // silently reinterpreting the folder name as a leaf.
  if (raw.trim().endsWith("/")) return undefined;
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
  // Fix 7 — see parseScriptPathInput's comment: a trailing "/" has no leaf.
  if (raw.trim().endsWith("/")) {
    return "Name is required";
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
    const hidden = findHiddenScriptFolderSegment(dirPath);
    if (hidden) {
      return hiddenScriptFolderMessage(hidden);
    }
  }
  return undefined;
}

/**
 * A path the grammar accepts but `scanScriptsDir` will never surface (§5.3's
 * skip list) is not a valid destination: the directory gets created on disk,
 * never renders in the Scripts view, and a second attempt reports "already
 * exists" about a folder the user has no way to see. The rules themselves live
 * with the scanner (`findHiddenScriptFolderSegment`) so the two cannot drift.
 */
function hiddenScriptFolderMessage(segment: string): string {
  return `The Scripts view never shows "${segment}" — folders starting with '.', 'node_modules', and a top-level 'types' folder are skipped. Choose another name.`;
}

function validateNewScriptFolderPath(raw: string): string | undefined {
  if (raw.includes("\\")) {
    return "Use '/' to separate folders, not '\\'.";
  }
  const trimmed = raw.trim();
  if (!trimmed) return "Folder path is required";
  const normalized = normalizeFolderPath(trimmed);
  if (normalized === undefined) {
    return INVALID_FOLDER_PATH_MESSAGE;
  }
  const hidden = findHiddenScriptFolderSegment(normalized);
  if (hidden) {
    return hiddenScriptFolderMessage(hidden);
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
  // Fix 5 — a name that passes validation (e.g. an absolute-looking segment
  // like "C:") can still fail at the filesystem. Without this, that surfaced
  // as VS Code's generic "contributed command failed" with no indication of
  // what went wrong or where.
  try {
    // Recursive (mkdir -p semantics) — also creates any intermediate folders
    // in `dirPath` (§5.7 — "New Script accepts a path, creating intermediate
    // directories").
    await vscode.workspace.fs.createDirectory(targetDir);
    let exists = true;
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      exists = false;
    }
    if (exists) {
      void vscode.window.showWarningMessage(`${leaf}.js already exists. Opening the existing file.`);
    } else {
      const body = template.body.replaceAll("{{NAME}}", leaf);
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(body));
    }
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Failed to create script: ${message}`);
  }
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
  // Fix 5 — a name that passes validation can still fail at the filesystem
  // (permissions, an unsupported path shape, etc.); report it instead of
  // letting it surface as VS Code's generic "contributed command failed".
  try {
    await vscode.workspace.fs.createDirectory(target);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Failed to create folder: ${message}`);
  }
}

function scriptingDocsUrl(): string {
  return repositoryBlobUrl("docs/scripting.md");
}

function scriptExamplesUrl(): string {
  return repositoryTreeUrl("examples/scripts");
}

/**
 * Whether a delete of `uri` can go to the Trash. VS Code refuses a `useTrash`
 * delete on a file system without one ("… via trash because provider does not
 * support it") instead of deleting permanently, and gives an extension no way
 * to ask a file system whether it has one — so this decides from where the
 * file lives. Only the desktop's local disk has a Trash: a `file:` URI in a
 * window with no remote. With a remote (Remote-SSH, WSL, Dev Containers) this
 * extension runs in the remote extension host — it declares no
 * `extensionKind` — where `file:` URIs are the remote's and go through VS
 * Code's remote file system, which has no Trash; any other scheme is that
 * remote file system or one an extension registered, which cannot declare a
 * Trash. Where this is wrong (`remote.extensionKind` forcing Nexus local in a
 * remote window, deleting a `file:` script from global storage) it asks for a
 * permanent delete the user can still decline — it never promises a Trash
 * that is not there.
 */
function canMoveToTrash(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && vscode.env.remoteName === undefined;
}

/**
 * A delete of a file that is not there: the extension host throws a
 * `FileSystemError` whose `code` is "FileNotFound". Read by `code` rather
 * than `instanceof`, like `scriptFs.ts`'s not-found check.
 */
function isFileNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | undefined)?.code === "FileNotFound";
}

async function deleteScript(uri: vscode.Uri, refreshScriptTree?: () => void): Promise<void> {
  if (!uri?.fsPath) return;
  const base = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
  const DELETE_PERMANENTLY = "Delete Permanently";
  // The row the user clicked is stale — deleted outside VS Code, or before
  // the watcher's rescan. What they asked for is already true, and a
  // permanent delete could not succeed either, so say so and rescan.
  const alreadyGone = () => {
    void vscode.window.showInformationMessage(`${base} is already gone.`);
    refreshScriptTree?.();
  };
  if (canMoveToTrash(uri)) {
    const picked = await vscode.window.showWarningMessage(
      `Delete ${base}? It will be moved to the Trash.`,
      { modal: true },
      "Delete"
    );
    if (picked !== "Delete") return;
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
      return;
    } catch (err) {
      if (isFileNotFound(err)) {
        alreadyGone();
        return;
      }
      // The OS Trash can still fail (a mount with no Trash directory), and
      // VS Code then throws rather than deleting permanently. Offer what its
      // own explorer does — a permanent delete behind a second confirmation,
      // since the first one promised the Trash.
      const reason = err instanceof Error ? err.message : String(err);
      const again = await vscode.window.showWarningMessage(
        `${base} could not be moved to the Trash. Delete it permanently instead?`,
        { modal: true, detail: `${reason}\n\nThis cannot be undone.` },
        DELETE_PERMANENTLY
      );
      if (again !== DELETE_PERMANENTLY) return;
    }
  } else {
    const picked = await vscode.window.showWarningMessage(
      `Delete ${base} permanently? This cannot be undone.`,
      { modal: true },
      DELETE_PERMANENTLY
    );
    if (picked !== DELETE_PERMANENTLY) return;
  }
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  } catch (err) {
    if (isFileNotFound(err)) {
      alreadyGone();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Failed to delete script: ${message}`);
  }
}

/**
 * Resolve the Nexus session id for a given VS Code `Terminal`, or undefined
 * if the terminal isn't a session a script can run on (a plain shell, a Local
 * Server terminal, etc.). Used by `nexus.script.runQuick` to auto-pick the
 * currently focused terminal when the user hits the tree view's inline ▶ play
 * button. Passed in from extension.ts where the terminal maps live.
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
    // terminal is focused, or when the focused terminal isn't one a script can
    // run on (plain shell, Local Server, etc.). This is wired to the Scripts tree view's inline
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
      await deleteScript(uri, refreshScriptTree);
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
      // `openExternal` FIRST, and `revealFileInOS` only as the fallback — the
      // opposite of what this used to do, which is why the command opened the
      // wrong folder.
      //
      // `revealFileInOS` is Electron's `shell.showItemInFolder`: it reveals its
      // argument *inside the containing folder* and selects it. Handed a
      // DIRECTORY, it therefore opens that directory's PARENT — for the default
      // `.nexus/scripts` that is `<workspace>/.nexus`, a folder holding no
      // scripts at all, and for the no-workspace fallback it is the extension's
      // global-storage directory, which holds `state.vscdb` and nothing a user
      // would recognise. The command is called Open Scripts Folder and it was
      // never opening the scripts folder.
      //
      // `openExternal` on a `file:` URI opens the directory ITSELF in the OS
      // file manager, which is what the title promises. It is kept honest about
      // its own limit: from a remote window a `file:` URI resolves on the local
      // machine, so if it reports failure the reveal is still tried — landing on
      // the parent is a worse answer than the right one, and a better answer
      // than nothing.
      let opened = false;
      try {
        opened = await vscode.env.openExternal(target);
      } catch {
        opened = false;
      }
      if (!opened) {
        try {
          await vscode.commands.executeCommand("revealFileInOS", target);
        } catch {
          void vscode.window.showWarningMessage(
            `Could not open the scripts folder. It is at: ${target.fsPath}`
          );
        }
      }
    })
  ];
}
