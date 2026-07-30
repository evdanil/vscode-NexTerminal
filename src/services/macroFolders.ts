/**
 * Pure helpers for macro folders (§4.1, §4.2 of
 * docs/plans/2026-07-30-macro-script-folders.md). No `vscode` import — safe to
 * import from both the UI layer (macroTreeProvider.ts, macroEditorHtml.ts) and
 * the command layer (macroCommands.ts) without pulling `vscode` into either.
 *
 * §4.2 — `group` is untrusted at every read site: a hand-edited settings.json
 * (absorbed on every activation) or a value already sitting in `MACROS_KEY`
 * can carry a non-string, `".."`, over-depth, or otherwise malformed `group`.
 * `sanitizeMacroGroup()` is the single chokepoint every read site and every
 * ingest path must run untrusted input through — never a bare `macro.group`
 * truthy check.
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
 * Normalizes a macro's untrusted `group` in place at an ingest chokepoint
 * (mirrors `withRedactedVariables()`'s role for `variables`). Returns a new
 * object only when the value actually changes, matching
 * `withRedactedVariables()`'s identity-preserving convention.
 *
 * Shared by every `MacroStore` implementation's `save()` — Fix 5 (§4.2)
 * requires `group` to be sanitized identically regardless of which store is
 * active, the same way `sanitizeMacroFolderList()` is shared for the explicit
 * folder list.
 */
export function withNormalizedGroup<T extends Pick<TerminalMacro, "group">>(macro: T): T {
  const normalized = sanitizeMacroGroup(macro.group);
  if (normalized === macro.group) return macro;
  if (normalized === undefined) {
    if (macro.group === undefined) return macro;
    const { group: _drop, ...rest } = macro;
    return rest as T;
  }
  return { ...macro, group: normalized };
}

/**
 * Sanitizes a persisted/imported explicit-folder list: drops non-strings and
 * structurally invalid paths, dedupes, keeps no ordering guarantee (callers
 * sort as needed). Mirrors the "filter to strings, normalise, drop the rest"
 * rule §4.2 states for `nexus.macros.folders`.
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
