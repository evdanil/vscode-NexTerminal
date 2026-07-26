/** Signature a piece of import text appears to carry. `"unknown"` is reserved for a
 * future stronger signal; the rules below never emit it — every input that isn't
 * confidently one of the other three still resolves to `"host-list"`. */
export type SniffedFormat = "nexus-json" | "mobaxterm" | "xml" | "host-list" | "unknown";

// MobaXterm's own signature: a `[Bookmarks]` or `[Bookmarks_N]` section header line.
const MOBAXTERM_BOOKMARKS_RE = /^\[Bookmarks(_\d+)?\]\s*$/m;

/**
 * Cheaply guesses the format of import text from its shape alone.
 *
 * This exists only to *contradict* a format the user already declared via the
 * import chooser — never to choose one itself. `host-list` is the everything-else
 * class (no CSV/host-list signature is positive: see docs/plans rationale on
 * `HOST_RE` admitting bracketed IPv6 literals), so it is also what a generic INI,
 * an empty file, or any unrecognized text falls back to — that is intentional,
 * not a false confidence.
 */
export function sniffImportFormat(text: string): SniffedFormat {
  const firstNonWhitespace = text.match(/\S/)?.[0];
  // A brace is checked whether or not the JSON actually parses — a broken Nexus
  // export is still not a host list, so callers must not reroute it into one.
  if (firstNonWhitespace === "{") {
    return "nexus-json";
  }
  if (firstNonWhitespace === "<") {
    return "xml";
  }
  if (MOBAXTERM_BOOKMARKS_RE.test(text)) {
    return "mobaxterm";
  }
  return "host-list";
}
