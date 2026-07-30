export const MAX_FOLDER_DEPTH = 10;

/**
 * The ONLY job of this bound is to stop a pathological allocation reaching the
 * rest of the system: depth bounds segment COUNT, so without it a
 * single-segment `group: "X".repeat(8_000_000)` passes every other check and
 * is then split, trimmed, joined, sorted, compared and rendered on every
 * refresh. It is deliberately NOT a naming policy.
 *
 * Why 4096 and not something tighter: it is POSIX `PATH_MAX`, and it is above
 * what a real filesystem could produce at our own depth limit —
 * `MAX_FOLDER_DEPTH` (10) segments of `NAME_MAX` (255) plus 9 separators is
 * 2559 characters. So this cap can never reject a folder path a filesystem
 * would have accepted at the depth we allow, which matters directly for
 * script folders (real directories) and leaves macro groups — free-form
 * strings a user types — comfortably unconstrained.
 *
 * There is deliberately NO separate per-segment cap. A segment can never be
 * longer than the whole path, so a segment cap adds nothing to the bound; the
 * previous `MAX_FOLDER_SEGMENT_LENGTH = 64` / `MAX_FOLDER_PATH_LENGTH = 200`
 * pair was policing naming rather than bounding allocation, and rejected
 * legitimate deep paths (10 levels averaging only 20 characters each already
 * exceeded 200).
 *
 * Shared by every caller of `normalizeFolderPath` — servers, serial and
 * local-shell profiles, macros, scripts, and the SecureCRT/MobaXterm
 * importers all funnel through this one chokepoint.
 */
export const MAX_FOLDER_PATH_LENGTH = 4096;

/**
 * Normalize a folder path: split on "/", trim segments, filter empty,
 * reject ".."/".", reject a backslash in any segment, reject depth >
 * MAX_FOLDER_DEPTH, reject a total length > MAX_FOLDER_PATH_LENGTH.
 * Returns the cleaned path or undefined if invalid.
 */
export function normalizeFolderPath(path: string): string | undefined {
  // Reject BEFORE split()/trim()/join() ever touch an untrusted, potentially
  // huge string: a caller-supplied `group` (or a persisted folder-list entry)
  // is untrusted at every read site (§4.2 of the folders design), and the
  // rejection has to cost O(1), not O(length).
  if (path.length > MAX_FOLDER_PATH_LENGTH) {
    return undefined;
  }
  const segments = path.split("/").map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) {
    return undefined;
  }
  for (const seg of segments) {
    if (seg === ".." || seg === "." || seg.includes("\\")) {
      return undefined;
    }
  }
  if (segments.length > MAX_FOLDER_DEPTH) {
    return undefined;
  }
  return segments.join("/");
}

/**
 * Normalize optional folder input (e.g. form values).
 * - Missing/blank input => undefined
 * - Valid input => normalized path
 * - Invalid non-empty input => null
 */
export function normalizeOptionalFolderPath(input: unknown): string | undefined | null {
  if (typeof input !== "string") {
    return undefined;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeFolderPath(trimmed) ?? null;
}

export const INVALID_FOLDER_PATH_MESSAGE =
  `Invalid folder path. Use up to ${MAX_FOLDER_DEPTH} levels (${MAX_FOLDER_PATH_LENGTH} characters total) and avoid '.', '..', or '\\'.`;

/**
 * True if `candidate` equals `ancestor` or is nested inside it.
 * Safe against prefix collisions (e.g. "Apps" vs "AppServer").
 */
export function isDescendantOrSelf(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(ancestor + "/");
}

/**
 * Return the parent path, or undefined for a root-level path.
 * "A/B/C" -> "A/B", "A" -> undefined
 */
export function parentPath(path: string): string | undefined {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? undefined : path.slice(0, idx);
}

/**
 * Return the display name (leaf segment) of a path.
 * "A/B/C" -> "C"
 */
export function folderDisplayName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Return all ancestor paths including the path itself.
 * "A/B/C" -> ["A", "A/B", "A/B/C"]
 */
export function getAncestorPaths(path: string): string[] {
  const segments = path.split("/");
  const result: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    result.push(segments.slice(0, i + 1).join("/"));
  }
  return result;
}
