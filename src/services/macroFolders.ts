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
import {
  getAncestorPaths,
  normalizeFolderPath,
  normalizeOptionalFolderPath,
  MAX_FOLDER_PATH_LENGTH
} from "../utils/folderPaths";
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
 * How the Macro Editor's **Folder** field represents a stored `group`.
 *
 * There is exactly one function for this because two callers must agree on it
 * byte-for-byte: `macroEditorHtml.ts` renders `value` into the input, and
 * `macroEditorPanel.ts` compares the submitted text against the same `value`
 * to decide whether the user touched the field at all. If those two ever
 * disagreed, an untouched field would read as edited and the save would
 * rewrite (or delete) a stored folder path the user never looked at — which
 * is precisely the defect this helper exists to close: the editor sanitized
 * an unrenderable group to an EMPTY field, the webview posted `group: null`,
 * and saving a name change silently destroyed the stored value, making
 * §4.9.3's "storage is never rewritten" false on the most ordinary write path.
 *
 * The four states:
 *
 * - `empty` — no stored group. The field is blank; typing a path assigns one.
 * - `valid` — the stored group normalizes. Rendered as-is.
 * - `unrenderable` — a stored string that does NOT normalize (`Cisco\Routers`
 *   typed with a Windows separator, a `..` segment, over-depth). It is
 *   rendered **raw** so the user can see and fix the thing that is keeping the
 *   macro at the root. Saving it unchanged preserves it byte-for-byte; saving
 *   it CHANGED runs the normal grammar, so any edit forces an explicit,
 *   validated decision.
 * - `oversize` — a stored string longer than `MAX_FOLDER_PATH_LENGTH`. It is
 *   deliberately NOT rendered: a pathological `"a".repeat(8_000_000)` group
 *   (reachable from a hand-edited settings.json via the legacy-absorption
 *   path) must never reach the DOM. The field is blank and a notice explains
 *   that the stored value is kept; **Move to Folder → (root)** clears it.
 *
 * `value` is trimmed because the webview trims before posting, so an untrimmed
 * baseline could never compare equal to what comes back. The length check runs
 * BEFORE `trim()` for the same O(1) reason `normalizeFolderPath` does it —
 * trimming an eight-megabyte string to discover it is too long is the cost the
 * bound exists to avoid.
 */
export interface MacroFolderField {
  /** Exactly what the Folder input renders — and the baseline for "untouched". */
  readonly value: string;
  readonly state: "empty" | "valid" | "unrenderable" | "oversize";
}

export function macroFolderField(rawGroup: unknown): MacroFolderField {
  if (typeof rawGroup !== "string") {
    // A non-string group never reaches here from the store (`dropNonPathGroup`
    // strips it at ingest), and there is no path in it to preserve anyway.
    return { value: "", state: "empty" };
  }
  if (rawGroup.length > MAX_FOLDER_PATH_LENGTH) {
    return { value: "", state: "oversize" };
  }
  const trimmed = rawGroup.trim();
  if (trimmed.length === 0) {
    return { value: "", state: "empty" };
  }
  return {
    value: trimmed,
    state: normalizeFolderPath(trimmed) === undefined ? "unrenderable" : "valid"
  };
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
