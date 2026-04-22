export const MAX_FOLDER_DEPTH = 10;

/**
 * Normalize a folder path: split on "/", trim segments, filter empty,
 * reject ".."/".", reject depth > MAX_FOLDER_DEPTH.
 * Returns the cleaned path or undefined if invalid.
 */
export function normalizeFolderPath(path: string): string | undefined {
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
  `Invalid folder path. Use up to ${MAX_FOLDER_DEPTH} levels and avoid '.', '..', or '\\'.`;

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
