/** Signature a piece of import text appears to carry. Every input that isn't
 * confidently one of the other four resolves to `"host-list"` — see the doc
 * comment on `sniffImportFormat` for why that class has no positive signature. */
export type SniffedFormat = "nexus-json" | "mobaxterm" | "xml" | "ssh-config" | "host-list";

// MobaXterm's own signature: a `[Bookmarks]` or `[Bookmarks_N]` section header line.
// parseIniSections() trims every line and matches sections by startsWith("Bookmarks")
// (mobaxtermParser.ts) — so this must tolerate the same leading/trailing horizontal
// whitespace and a bare CR, or a file the parser accepts sniffs as "not mobaxterm".
const MOBAXTERM_BOOKMARKS_RE = /^[ \t]*\[Bookmarks(_\d+)?\][ \t]*\r?$/m;

// An OpenSSH client config's own signature: a `Host` or `HostName` directive.
// CASE-SENSITIVE on purpose, although ssh(1) itself is not. The everything-else
// class it has to be told apart from is the host list, and the inventory parser
// accepts a WHITESPACE-run-delimited list with a header row — so a lowercase
// `host name user port` header is a real host list whose first line would
// otherwise match this pattern exactly. Convention does the separating: an ssh
// config is written `Host`, a spreadsheet header is written `host`. A capital-H
// host list that trips this still has the "Import as Host List Anyway" escape
// hatch on the branch that sniffs it, so the cost of being wrong is one click.
const SSH_CONFIG_HOST_RE = /^[ \t]*Host(Name)?[ \t]+\S/m;

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
  // Strip a leading UTF-8 BOM once, up front, so every rule below is BOM-agnostic by
  // construction. parseIniSections() strips the same BOM (mobaxtermParser.ts) before
  // matching sections — without this, a BOM'd MobaXterm export sniffs as host-list
  // (MOBAXTERM_BOOKMARKS_RE only tolerates `[ \t]*` before `[`, not U+FEFF) and
  // importMobaxterm() aborts before the parser, which handles the BOM fine, ever runs.
  const withoutBom = text.replace(/^\uFEFF/, "");
  const firstNonWhitespace = withoutBom.match(/\S/)?.[0];
  // A brace is checked whether or not the JSON actually parses — a broken Nexus
  // export is still not a host list, so callers must not reroute it into one.
  if (firstNonWhitespace === "{") {
    return "nexus-json";
  }
  if (firstNonWhitespace === "<") {
    return "xml";
  }
  if (MOBAXTERM_BOOKMARKS_RE.test(withoutBom)) {
    return "mobaxterm";
  }
  // Last positive signature, ahead of the catch-all: an `~/.ssh/config` used to
  // land in `host-list`, where `Host lab` parsed positionally into a server
  // named `lab` at the host `Host` — a bogus row from a file the user pointed
  // at deliberately.
  if (SSH_CONFIG_HOST_RE.test(withoutBom)) {
    return "ssh-config";
  }
  return "host-list";
}
