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

/** Matches `MAX_FOLDER_DEPTH` in `src/utils/folderPaths.ts` (§5.3). */
export const SCRIPT_SCAN_MAX_DEPTH = 10;

/**
 * Entries examined counts directories AND non-`.js` files — NOT `.js` files
 * themselves. Counting only "uninteresting" entries is deliberate (§5.3):
 * otherwise a directory containing 50,000 unrelated files would cost nothing
 * against the budget while still making every scan enumerate all of them.
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
  /** How many directory / non-.js-file entries were examined before stopping. */
  readonly examined: number;
}

/**
 * Recursively scans `root` for `.js` files and their containing directories,
 * bounded by depth (10) and examined-entry count (500). Never throws — a
 * missing or unreadable directory (including the root itself) yields an empty
 * result, matching the pre-existing "no scripts folder yet" UX in both
 * consumers.
 *
 * Symlinked directories: uses `type & vscode.FileType.Directory` (a bitmask
 * test), NOT `type === vscode.FileType.Directory`, so a symlinked directory —
 * common for NTFS junctions surfaced through WSL2's /mnt/c — is followed as a
 * folder rather than silently skipped. This is safe against symlink cycles
 * because the depth cap (10) bounds recursion regardless of how the cycle is
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
      const isDir = (type & vscode.FileType.Directory) !== 0;

      if (isDir) {
        // Every directory entry counts against the budget, whether or not it
        // ends up skipped — the cost of having enumerated it is real (§5.3).
        examined += 1;
        if (examined > SCRIPT_SCAN_MAX_ENTRIES) {
          truncated = true;
          return;
        }
        if (isSkippedDirName(name)) continue;
        if (folderPath === undefined && name === ROOT_GENERATED_TYPES_DIR) continue;

        const childPath = folderPath ? `${folderPath}/${name}` : name;
        const childDepth = depth + 1;
        folders.push({ uri: vscode.Uri.joinPath(dirUri, name), path: childPath });
        if (childDepth < SCRIPT_SCAN_MAX_DEPTH) {
          await walk(vscode.Uri.joinPath(dirUri, name), childPath, childDepth);
        }
        // At the depth cap: the folder itself is still listed (§5.4 — all
        // directories render regardless of contents), just not descended into.
        continue;
      }

      if (isJsFile(name)) {
        scripts.push({ uri: vscode.Uri.joinPath(dirUri, name), fileName: name, folderPath });
        continue;
      }

      // A non-directory, non-.js entry — counts against the budget too.
      examined += 1;
      if (examined > SCRIPT_SCAN_MAX_ENTRIES) {
        truncated = true;
        return;
      }
    }
  }

  await walk(root, undefined, 0);
  return { scripts, folders, truncated, examined };
}
