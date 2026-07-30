import * as vscode from "vscode";
import { MAX_FOLDER_DEPTH } from "../../utils/folderPaths";

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
 * IS `MAX_FOLDER_DEPTH` from `src/utils/folderPaths.ts` (§5.3), imported
 * rather than re-declared as its own `10`: the two are not two numbers that
 * happen to be equal, they are one bound seen from two sides —
 * `normalizeFolderPath` is what stops a user creating a folder deeper than
 * this, and this scanner is what has to find what they created. A local
 * literal lets one move without the other, and the failure is silent in both
 * directions (scripts that exist but never render, or a wasted deeper walk).
 *
 * A folder path of exactly this many segments is therefore the deepest one a
 * user can create (New Folder / New Script). Fix 2: the scanner must
 * therefore DESCEND into a folder at exactly this depth (read its own
 * scripts/subfolders), not merely list it — otherwise a script the product
 * itself allowed the user to create is invisible in both the Scripts tree
 * and the picker, with no truncation node and no explanation. A folder found
 * one level beyond this (depth + 1) is still listed (§5.4 — all directories
 * render) but is never descended into.
 */
export const SCRIPT_SCAN_MAX_DEPTH = MAX_FOLDER_DEPTH;

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

/**
 * The first path segment this scanner would skip, or `undefined` if every
 * segment survives — i.e. "would a folder at this path ever appear in the
 * Scripts view?".
 *
 * It lives here, next to the skip rules themselves, because the New Folder /
 * New Script validators are the other half of the same contract: without it
 * they happily accepted `.archive`, `node_modules`, and a root-level `types`,
 * created the real directory on disk, and then never rendered it — after which
 * retrying reported "already exists" about a folder the user cannot see. A
 * second, hand-maintained copy of the rules in `scriptCommands.ts` would have
 * reproduced exactly that the next time either list changed.
 */
export function findHiddenScriptFolderSegment(folderPath: string): string | undefined {
  const segments = folderPath.split("/");
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i];
    if (isSkippedDirName(name)) return name;
    // Root-only, matching the walk: a user's own `cisco/types/` is fine.
    if (i === 0 && name.toLowerCase() === ROOT_GENERATED_TYPES_DIR) return name;
  }
  return undefined;
}

function isJsFile(name: string): boolean {
  // Case-insensitive to match `stripJsExtension`'s `/\.js$/i` in scriptCommands.ts.
  return name.toLowerCase().endsWith(".js");
}

/**
 * A `.js` file found by the scan.
 *
 * Deliberately has no `linked` counterpart to `ScannedFolder.linked`, even
 * though a symlinked `.js` FILE is scanned exactly like a real one (the type
 * test is `isJsFile(name)` on a non-directory entry, which a `File |
 * SymbolicLink` bitmask satisfies). The two cases are not the same size of
 * problem:
 *
 * - A symlinked DIRECTORY hides an unbounded amount of state. The watcher does
 *   not follow it, so scripts created, renamed or deleted anywhere beneath it
 *   never fire an event and the tree keeps serving a listing that has no
 *   relationship to what is on disk. Nothing on screen would say why, hence the
 *   marker and the "press Refresh" tooltip.
 * - A symlinked FILE is a single row whose EXISTENCE is watched normally: the
 *   link itself lives inside the watched root, so creating, renaming or
 *   deleting it is an ordinary directory-entry change and fires an event like
 *   any other file. Only edits made through the link's target go unnoticed, and
 *   the only thing this scanner's consumers re-read from a script's contents is
 *   its `@nexus-script` header — so the visible consequence is a stale label or
 *   `@target-type` on one row, corrected by the same Refresh, and never a script
 *   that silently is not there.
 *
 * Marking every symlinked file would put a warning icon on rows whose worst case
 * is a stale name, which is the kind of noise that teaches people to ignore the
 * marker that does matter. If script CONTENT ever becomes something the tree
 * depends on more strongly, revisit this.
 */
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
  /**
   * This directory is a symlink, or lives underneath one. Reported because the
   * scan and the file-system WATCHER disagree about such a directory: the scan
   * follows it (see `scanScriptsDir`'s doc comment), while VS Code's recursive
   * watcher does not follow links nested inside the folder it watches, so
   * changes made in the link's target fire no event at all. Consumers surface
   * that instead of silently serving a stale listing — see
   * `ScriptTreeProvider.ensureWatcher()` for the full argument.
   *
   * Inherited downward: a plain directory inside a symlinked one is just as
   * unwatched as the link itself, and marking only the link would leave a user
   * who expanded straight into `shared/sub` with no explanation.
   */
  readonly linked: boolean;
}

export interface ScriptScanResult {
  readonly scripts: ScannedScript[];
  readonly folders: ScannedFolder[];
  /** True once the entry-examination budget (§5.3) was hit; the scan stopped early. */
  readonly truncated: boolean;
  /** How many directory / file entries (`.js` scripts included, Fix 3) were examined before stopping. */
  readonly examined: number;
  /**
   * Fix 6 — true if at least one folder was found beyond
   * `SCRIPT_SCAN_MAX_DEPTH` and therefore listed (§5.4 — all directories
   * render) but never descended into. Deliberately separate from
   * `truncated`: that flag means the ENTIRE scan stopped early; this one
   * means one specific branch was cut off while the rest of the tree scanned
   * normally. Conflating the two (or dropping this signal entirely) leaves a
   * legitimately-created depth-11 folder's scripts silently missing from
   * both the Scripts tree and the picker, with no warning node explaining
   * why — Design §5.3 requires truncation to always be announced.
   */
  readonly depthTruncated: boolean;
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
 * Every folder at or below a link is flagged `linked`, because following one is
 * a promise this module can keep and the file-system watcher cannot — see
 * `ScannedFolder.linked` and `ScriptTreeProvider.ensureWatcher()`.
 */
export async function scanScriptsDir(root: vscode.Uri): Promise<ScriptScanResult> {
  const scripts: ScannedScript[] = [];
  const folders: ScannedFolder[] = [];
  let examined = 0;
  let truncated = false;
  let depthTruncated = false;

  async function walk(
    dirUri: vscode.Uri,
    folderPath: string | undefined,
    depth: number,
    insideLink: boolean
  ): Promise<void> {
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
        // Same bitmask discipline as the Directory test above — a symlinked
        // directory reports BOTH bits, so `type === SymbolicLink` would never
        // be true for one.
        const childLinked = insideLink || (type & vscode.FileType.SymbolicLink) !== 0;
        folders.push({ uri: vscode.Uri.joinPath(dirUri, name), path: childPath, linked: childLinked });
        // Fix 2 — `<=`, not `<`: see SCRIPT_SCAN_MAX_DEPTH's doc comment.
        if (childDepth <= SCRIPT_SCAN_MAX_DEPTH) {
          await walk(vscode.Uri.joinPath(dirUri, name), childPath, childDepth, childLinked);
        } else {
          // Fix 6 — the folder itself is still listed (§5.4 — all
          // directories render regardless of contents), just not descended
          // into. That must be visibly different from "nothing here" —
          // record it distinctly from the entry-count `truncated` flag so
          // the tree can render a reason-appropriate warning instead of
          // silently hiding whatever lives inside this folder.
          depthTruncated = true;
        }
        continue;
      }

      if (isJsFile(name)) {
        scripts.push({ uri: vscode.Uri.joinPath(dirUri, name), fileName: name, folderPath });
      }
    }
  }

  // `false`, even when `root` is itself a symlink: `linked` means "outside the
  // reach of the watcher's root", and the watcher's root IS this directory. A
  // marker there would name a condition the user cannot act on.
  await walk(root, undefined, 0, false);
  return { scripts, folders, truncated, examined, depthTruncated };
}
