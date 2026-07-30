import * as vscode from "vscode";

/**
 * Recursive bounded filesystem scan of the Nexus scripts directory (§5.3, §5.8
 * of docs/plans/2026-07-30-macro-script-folders.md).
 *
 * Shared by `scriptTreeProvider.ts` (the Scripts sidebar) AND `scriptPicker.ts`
 * ("Connect and Run Script…"), each running its own scan — §5.8 explains why
 * sharing the *function* rather than a cache is the right call: sharing a
 * cache would mean the picker importing from `src/ui/` (a layering inversion)
 * and reading a cache that is empty until the Scripts view has first been
 * revealed, and up to ~300ms stale behind the tree's debounce. A ≤500-entry
 * scan on an occasional command invocation is cheap enough that duplicating
 * the (cheap, filesystem-only) walk is the simpler and safer design.
 *
 * This scanner is intentionally filesystem-only — it does NOT read file
 * contents or parse `@nexus-script` headers. That stays the caller's
 * responsibility (the tree provider needs per-node parse errors / running
 * state; the picker needs `@target-type` filtering) so this module has no
 * dependency on `scriptHeader.ts` and stays cheap to call from either side.
 */

/**
 * Matches `MAX_FOLDER_DEPTH` in `src/utils/folderPaths.ts` (§5.3) — a folder
 * path of exactly this many segments is the deepest `normalizeFolderPath`
 * lets a user create (New Folder / New Script). Fix 2: the scanner must
 * therefore DESCEND into a folder at exactly this depth (read its own
 * scripts/subfolders), not merely list it — otherwise a script the product
 * itself allowed the user to create is invisible in both the Scripts tree
 * and the picker, with no truncation node and no explanation. A folder found
 * one level beyond this (depth + 1) is still listed (§5.4 — all directories
 * render) but is never descended into.
 */
export const SCRIPT_SCAN_MAX_DEPTH = 10;

/**
 * Entries examined counts EVERY directory and EVERY file, `.js` scripts
 * included (Fix 3). An earlier version of this scanner exempted `.js` files
 * from the budget — reasoning that only "uninteresting" entries should count
 * — but the expensive work downstream is PER SCRIPT FILE: `ScriptTreeProvider`
 * and `pickScriptFromWorkspace` each `readFile` every script found. Exempting
 * `.js` files let a directory of thousands of bundled scripts skip the
 * budget entirely while still making the tree and the picker issue that many
 * sequential `readFile` calls, repeated after every debounced watcher burst,
 * with no truncation row and no explanation.
 */
export const SCRIPT_SCAN_MAX_ENTRIES = 500;

/**
 * `scriptTypesGenerator.ts` writes exactly `<scriptsDir>/types` — never at any
 * other depth. Skipping "types" as a name at every level would hide a user's
 * own `cisco/types/probe.js`, so this is checked only when `parentPath` is
 * `undefined` (i.e. the entry lives directly under the scripts root).
 */
const ROOT_GENERATED_TYPES_DIR = "types";

function isSkippedDirName(name: string): boolean {
  // Case-insensitive: WSL2 mounts under /mnt/c are case-insensitive, so
  // "Node_Modules" and "node_modules" are the same directory on disk, and a
  // dotfile-style directory could be spelled with any casing of its dot
  // prefix (the dot itself is what matters, not casing of what follows).
  if (name.startsWith(".")) return true;
  if (name.toLowerCase() === "node_modules") return true;
  return false;
}

function isJsFile(name: string): boolean {
  // Case-insensitive to match `stripJsExtension`'s `/\.js$/i` in scriptCommands.ts.
  return name.toLowerCase().endsWith(".js");
}

export interface ScannedScript {
  readonly uri: vscode.Uri;
  /** File name including extension, e.g. "backup.js". */
  readonly fileName: string;
  /** Folder-relative path of the CONTAINING folder, or undefined at the scripts root. */
  readonly folderPath: string | undefined;
}

export interface ScannedFolder {
  readonly uri: vscode.Uri;
  /** Folder-relative path, e.g. "cisco/backup". Never undefined — the scripts root itself is not a "folder" entry. */
  readonly path: string;
}

export interface ScriptScanResult {
  readonly scripts: ScannedScript[];
  readonly folders: ScannedFolder[];
  /** True once the entry-examination budget (§5.3) was hit; the scan stopped early. */
  readonly truncated: boolean;
  /** How many directory / file entries (`.js` scripts included, Fix 3) were examined before stopping. */
  readonly examined: number;
}

/**
 * Recursively scans `root` for `.js` files and their containing directories,
 * bounded by depth and examined-entry count. Never throws — a missing or
 * unreadable directory (including the root itself) yields an empty result,
 * matching the pre-existing "no scripts folder yet" UX in both consumers.
 *
 * Depth: descends into directories up to `SCRIPT_SCAN_MAX_DEPTH` (10) levels
 * deep — a folder at exactly that depth is still fully read (Fix 2); a
 * folder found one level beyond it is listed but never descended into.
 *
 * Entries: every directory and file examined counts against
 * `SCRIPT_SCAN_MAX_ENTRIES` (500), `.js` scripts included (Fix 3) — once
 * exceeded, the scan stops immediately and `examined` reports exactly the
 * cap, never one past it.
 *
 * Symlinked directories: uses `type & vscode.FileType.Directory` (a bitmask
 * test), NOT `type === vscode.FileType.Directory`, so a symlinked directory —
 * common for NTFS junctions surfaced through WSL2's /mnt/c — is followed as a
 * folder rather than silently skipped. This is safe against symlink cycles
 * because the depth cap bounds recursion regardless of how the cycle is
 * formed; the caps here are the loop protection, not symlink detection (§5.3).
 */
export async function scanScriptsDir(root: vscode.Uri): Promise<ScriptScanResult> {
  const scripts: ScannedScript[] = [];
  const folders: ScannedFolder[] = [];
  let examined = 0;
  let truncated = false;

  async function walk(dirUri: vscode.Uri, folderPath: string | undefined, depth: number): Promise<void> {
    if (truncated) return;
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return; // Missing/unreadable directory — nothing to contribute.
    }

    for (const [name, type] of entries) {
      if (truncated) return;

      // Fix 3 — check the budget BEFORE incrementing, and count EVERY entry
      // (directories, .js files, everything else) uniformly. Checking before
      // incrementing means `examined` reports exactly SCRIPT_SCAN_MAX_ENTRIES
      // once truncated, matching the "Stopped after 500" row (an
      // increment-then-compare would report 501 in the tooltip instead).
      if (examined >= SCRIPT_SCAN_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      examined += 1;

      const isDir = (type & vscode.FileType.Directory) !== 0;

      if (isDir) {
        if (isSkippedDirName(name)) continue;
        // Case-insensitive, matching `isSkippedDirName`'s own
        // case-insensitivity (§5.3): on WSL2's case-insensitive /mnt/c mount,
        // a `Types/` directory at the root is the same on-disk directory as
        // `types/`.
        if (folderPath === undefined && name.toLowerCase() === ROOT_GENERATED_TYPES_DIR) continue;

        const childPath = folderPath ? `${folderPath}/${name}` : name;
        const childDepth = depth + 1;
        folders.push({ uri: vscode.Uri.joinPath(dirUri, name), path: childPath });
        // Fix 2 — `<=`, not `<`: see SCRIPT_SCAN_MAX_DEPTH's doc comment.
        if (childDepth <= SCRIPT_SCAN_MAX_DEPTH) {
          await walk(vscode.Uri.joinPath(dirUri, name), childPath, childDepth);
        }
        // Past the cap: the folder itself is still listed (§5.4 — all
        // directories render regardless of contents), just not descended into.
        continue;
      }

      if (isJsFile(name)) {
        scripts.push({ uri: vscode.Uri.joinPath(dirUri, name), fileName: name, folderPath });
      }
    }
  }

  await walk(root, undefined, 0);
  return { scripts, folders, truncated, examined };
}
