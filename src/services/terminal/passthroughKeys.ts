/**
 * Canonical list of keys that can be passed through to the terminal via Ctrl+<key>.
 * Order is significant — it is preserved in the UI and used as the default set.
 */
export const ALL_PASSTHROUGH_KEYS = ["b", "e", "g", "j", "k", "n", "o", "p", "q", "r", "w"] as const;

const VALID_KEY_SET = new Set<string>(ALL_PASSTHROUGH_KEYS);

/**
 * Normalise the raw `nexus.terminal.passthroughKeys` setting value into a
 * validated, lowercase, deduplicated array.
 *
 * Rules:
 *  - `raw` must be an array of strings whose lowercased values are all in
 *    ALL_PASSTHROUGH_KEYS.  Unrecognised entries are silently dropped.
 *  - If the filtered result is non-empty it is returned (order preserved).
 *  - Otherwise — non-array, empty array, or every entry invalid — the full
 *    default set is returned as a fresh copy so callers may mutate it freely.
 *
 * This function intentionally does NOT import `vscode` so it remains pure and
 * unit-testable without VS Code stubs.
 */
export function sanitizePassthroughKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    // Keep valid entries, lowercased and deduplicated (first-occurrence wins).
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of raw) {
      if (typeof item === "string") {
        const lower = item.toLowerCase();
        if (VALID_KEY_SET.has(lower) && !seen.has(lower)) {
          seen.add(lower);
          result.push(lower);
        }
      }
    }
    if (result.length > 0) {
      return result;
    }
  }
  // Corrupt, empty, or entirely-invalid input → behave as if all keys selected.
  return [...ALL_PASSTHROUGH_KEYS];
}
