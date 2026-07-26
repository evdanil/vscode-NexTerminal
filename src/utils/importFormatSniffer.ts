/** Signature a piece of import text appears to carry. Every input that isn't
 * confidently one of the other three resolves to `"host-list"` — see the doc
 * comment on `sniffImportFormat` for why that class has no positive signature. */
export type SniffedFormat = "nexus-json" | "mobaxterm" | "xml" | "host-list";

// MobaXterm's own signature: a `[Bookmarks]` or `[Bookmarks_N]` section header line.
// parseIniSections() trims every line and matches sections by startsWith("Bookmarks")
// (mobaxtermParser.ts) — so this must tolerate the same leading/trailing horizontal
// whitespace and a bare CR, or a file the parser accepts sniffs as "not mobaxterm".
const MOBAXTERM_BOOKMARKS_RE = /^[ \t]*\[Bookmarks(_\d+)?\][ \t]*\r?$/m;

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
