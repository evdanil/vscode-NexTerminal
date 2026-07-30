/**
 * Pure helpers for macro folders (§4.1, §4.2 of
 * docs/plans/2026-07-30-macro-script-folders.md). No `vscode` import — safe to
 * import from both the UI layer (macroTreeProvider.ts, macroEditorHtml.ts) and
 * the command layer (macroCommands.ts) without pulling `vscode` into either.
 *
 * §4.2 — `group` is untrusted at every read site: a hand-edited settings.json
 * (absorbed on every activation) or a value already sitting in `MACROS_KEY`
 * can carry a non-string, `".."`, over-depth, or otherwise malformed `group`.
 * `sanitizeMacroGroup()` is the single chokepoint every read site must run it
 * through — never a bare `macro.group` truthy check. The READ site is where
 * the safety lives; ingest deliberately does not re-run the grammar and
 * destroy what it stored (see `dropNonPathGroup()`).
 */
import type { TerminalMacro } from "../models/terminalMacro";
import { getAncestorPaths, normalizeOptionalFolderPath } from "../utils/folderPaths";
import { naturalComparePath } from "../utils/naturalCompare";

/**
 * Canonicalizes an untrusted candidate `group`/folder value: non-string,
 * blank, and structurally invalid paths (`..`, `.`, `\`, over-depth) all
 * collapse to `undefined` — the same canonicalization `""` already gets, so
 * `""` and a missing field are indistinguishable downstream (§4.1).
 */
export function sanitizeMacroGroup(raw: unknown): string | undefined {
  const normalized = normalizeOptionalFolderPath(raw);
  return normalized === null ? undefined : normalized;
}

/** `macro.group`, sanitized (§4.2) — the only way any read site should ever consult it. */
export function macroGroup(macro: Pick<TerminalMacro, "group">): string | undefined {
  return sanitizeMacroGroup(macro.group);
}

/**
 * Ingest guard for `group`. Drops the field only when it holds no path at all
 * (a non-string, or a blank string); every other string is preserved
 * byte-for-byte, whether or not it currently normalizes. Returns a new object
 * only when the value actually changes, matching `withRedactedVariables()`'s
 * identity-preserving convention.
 *
 * This deliberately replaces the earlier `withNormalizedGroup()`, which ran
 * the full `normalizeFolderPath` grammar at ingest and DROPPED anything that
 * failed it. That destroyed user data: a macro whose stored group was merely
 * unrenderable (`"Cisco\\Routers"` typed on Windows, a path over the length
 * cap, a `..` segment) lost its folder assignment permanently — silently, on
 * the next activation, with the drop written straight back to disk. The rule
 * now is:
 *
 * - **Input** is validated (editor form, New Folder box, folder picker,
 *   import) — that is where a user finds out a path is unusable and can fix it.
 * - **Reads** are sanitized (`macroGroup()` / `sanitizeMacroGroup()`) — an
 *   unrenderable group makes the macro display at the root, and
 *   `normalizeFolderPath` rejects an oversized string in O(1) before it can
 *   split/sort/render, so §4.2's "malformed group breaks the sidebar" hazard
 *   stays closed by the read-site chokepoint that always owned it.
 * - **Storage is left alone.** `group` is not a secret; unlike
 *   `withRedactedVariables()` there is nothing to urgently scrub off disk,
 *   so copying that helper's rewrite-on-ingest semantics was a category error.
 *
 * What IS still dropped is a value that cannot express any folder path at all:
 * a non-string, or a string that is blank once trimmed. Neither carries an
 * assignment to preserve — dropping them destroys nothing — while keeping
 * them would make the declared type (`group?: string`) a lie downstream of
 * `getAll()` and would leave `""` and `undefined` as distinct values under a
 * raw `===` (§4.1). That is an in-memory repair of a field that holds nothing,
 * in the same spirit as the duplicate-id repair the stores already perform,
 * not the deletion of a user's folder.
 */
export function dropNonPathGroup<T extends Pick<TerminalMacro, "group">>(macro: T): T {
  const raw = macro.group;
  if (raw === undefined) return macro;
  if (typeof raw === "string" && raw.trim().length > 0) return macro;
  const { group: _drop, ...rest } = macro;
  return rest as T;
}

/**
 * Sanitizes a persisted/imported explicit-folder list: drops non-strings and
 * structurally invalid paths, dedupes, keeps no ordering guarantee (callers
 * sort as needed). Mirrors the "filter to strings, normalise, drop the rest"
 * rule §4.2 states for `nexus.macros.folders`.
 *
 * The asymmetry with `dropNonPathGroup()` above is deliberate, not an
 * oversight. A macro is an object whose folder is one attribute: destroying
 * that attribute destroys part of a record the user still has. An entry in
 * this list IS a folder path and nothing else — an unrenderable one has no
 * representation in the tree at all (there is no "shown at the root" fallback
 * for a folder), so it is a corrupt record rather than a recoverable folder.
 * It is also unreachable from any validated input path, which is why no
 * preserve-the-raw-value machinery is warranted here.
 */
export function sanitizeMacroFolderList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const entry of raw) {
    const normalized = sanitizeMacroGroup(entry);
    if (normalized) out.add(normalized);
  }
  return [...out];
}

/**
 * The rendered folder set: the union of explicit folders and folders derived
 * from macros' `group` values, ancestors included — precisely what
 * `collectGroups()` already does for servers/serial/local-shell profiles
 * (`serverCommands.ts:156-185`). Sorted by `naturalComparePath`, matching that
 * precedent (folder ORDER carries no user intent — unlike macro order, §4.4).
 */
export function collectMacroFolders(
  macros: readonly TerminalMacro[],
  explicitFolders: readonly string[]
): string[] {
  const folders = new Set<string>();
  for (const raw of explicitFolders) {
    const normalized = sanitizeMacroGroup(raw);
    if (!normalized) continue;
    for (const ancestor of getAncestorPaths(normalized)) folders.add(ancestor);
  }
  for (const macro of macros) {
    const group = macroGroup(macro);
    if (!group) continue;
    for (const ancestor of getAncestorPaths(group)) folders.add(ancestor);
  }
  return [...folders].sort((a, b) => naturalComparePath(a, b));
}
