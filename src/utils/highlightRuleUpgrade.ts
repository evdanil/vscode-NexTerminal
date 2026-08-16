import type { HighlightRule } from "./highlightRuleValidation";

/**
 * Known-default upgrade for user-saved highlighting rule snapshots.
 *
 * WHY THIS EXISTS. Every Save in the Highlighting Rules editor persists the
 * ENTIRE rule array to global settings, and VS Code does not merge array
 * settings — a user's snapshot fully shadows the package-declared defaults from
 * then on, forever. Two consequences shipped to users:
 *
 *  1. Anyone who saved before v2.8.182 (when labels/descriptions were added)
 *     has a nameless rule list in the editor and no way to get the text back
 *     short of Reset to Defaults, which would also drop their own rules.
 *  2. Anyone who saved before v2.8.187 has one of the two historical IPv6
 *     patterns, both of which truncate a compressed address at the first
 *     hextet after `::` (`fe80::b3ff:fe1e:8329` highlighted as
 *     `fe80::b3ff`). Fixing the shipped default alone would never reach them.
 *
 * The upgrade identifies a rule by its PATTERN STRING alone: color, flags,
 * bold, underline and enabled are all things a user may legitimately have
 * customised, and a matching pattern still means "this is that rule". It is
 * deliberately conservative:
 *
 *  - former default pattern → rewritten to the canonical one;
 *  - label/description → backfilled ONLY where absent or empty, never over a
 *    value the user typed;
 *  - color/flags/bold/underline/enabled → never touched;
 *  - rules → never added and never removed. A snapshot that predates the
 *    v2.8.182 re-add of IPv6/UUID simply lacks them, and that is
 *    indistinguishable from a user having deleted them — deletion wins.
 *
 * When nothing changes it returns the SAME array reference and
 * `changed: false`, which is what lets the activation migration skip the
 * settings write (and therefore avoid rewriting settings.json on every start).
 *
 * This module is vscode-free on purpose so the three call sites (editor read,
 * highlighter reload, activation migration) can all share it and tests can
 * import it without mocks.
 */
export interface DefaultHighlightRuleInfo {
  readonly pattern: string;
  readonly label: string;
  readonly description: string;
  /**
   * The default's own styling and flags. NOT something the upgrade ever
   * writes — they are read only to decide whether the shipped label and
   * description still tell the truth about a rule (see
   * `flagsMatchDefault` / `stylingMatchesDefault`).
   */
  readonly color: string;
  readonly flags: string;
  readonly bold?: boolean;
  readonly underline?: boolean;
}

/**
 * Pinned copy of `contributes.configuration.properties["nexus.terminal.highlighting.rules"].default`
 * (pattern/label/description plus the styling fields the description-backfill
 * gate compares against). Kept as a literal rather than importing package.json
 * so esbuild does not inline the whole 150 KB manifest into the extension
 * bundle. `highlightRuleUpgrade.test.ts` asserts byte-equality with
 * package.json, so the two cannot skew.
 */
export const DEFAULT_HIGHLIGHT_RULE_CATALOG: readonly DefaultHighlightRuleInfo[] = [
  {
    pattern: "\\bCRITICAL\\b|\\bFATAL\\b|\\bPANIC\\b|\\bEMERG(?:ENCY)?\\b",
    label: "Critical / fatal errors",
    description: "CRITICAL, FATAL, PANIC, EMERG(ENCY) — highest-severity log keywords, bold bright red.",
    color: "brightRed",
    flags: "gi",
    bold: true
  },
  {
    pattern: "\\bERR(?:OR)?\\b",
    label: "Errors",
    description: "ERR / ERROR — general error keyword, bold red.",
    color: "red",
    flags: "gi",
    bold: true
  },
  {
    pattern: "\\bFAIL(?:ED|URE)?\\b|\\bABORT(?:ED)?\\b",
    label: "Failures / aborts",
    description: "FAIL(ED/URE), ABORT(ED) — operation failed or was aborted, bold red.",
    color: "red",
    flags: "gi",
    bold: true
  },
  {
    pattern: "\\bWARN(?:ING)?\\b",
    label: "Warnings",
    description: "WARN / WARNING — cautionary log keyword, bold yellow.",
    color: "yellow",
    flags: "gi",
    bold: true
  },
  {
    pattern: "\\bNOTICE\\b",
    label: "Notices",
    description: "NOTICE — informational-but-notable log keyword, cyan.",
    color: "cyan",
    flags: "gi"
  },
  {
    pattern: "\\bINFO\\b",
    label: "Info",
    description: "INFO — routine informational log keyword, cyan.",
    color: "cyan",
    flags: "gi"
  },
  {
    pattern: "\\bDEBUG\\b|\\bTRACE\\b",
    label: "Debug / trace",
    description: "DEBUG, TRACE — low-priority diagnostic keywords, dimmed grey.",
    color: "brightBlack",
    flags: "gi"
  },
  {
    pattern: "\\bOK\\b|\\bPASS(?:ED)?\\b|\\bSUCCESS(?:FUL)?\\b|\\bDONE\\b|\\bLOADED\\b|\\bSTARTED\\b|\\bMOUNTED\\b",
    label: "Success keywords",
    description: "OK, PASS(ED), SUCCESS(FUL), DONE, LOADED, STARTED, MOUNTED — positive outcome keywords, bold green.",
    color: "green",
    flags: "gi",
    bold: true
  },
  {
    pattern: "\\bDENIED\\b|\\bREJECT(?:ED)?\\b|\\bREFUSED\\b|\\bFORBIDDEN\\b|\\bBLOCKED\\b",
    label: "Denied / rejected",
    description: "DENIED, REJECT(ED), REFUSED, FORBIDDEN, BLOCKED — access/action refused, red.",
    color: "red",
    flags: "gi"
  },
  {
    pattern: "\\bACCEPTED\\b|\\bALLOWED\\b|\\bGRANTED\\b|\\bAUTHENTICATED\\b",
    label: "Accepted / granted",
    description: "ACCEPTED, ALLOWED, GRANTED, AUTHENTICATED — access/action allowed, green.",
    color: "green",
    flags: "gi"
  },
  {
    pattern: "\\bTIMEOUT\\b|\\bTIMED OUT\\b|\\bUNREACHABLE\\b|\\bNO ROUTE\\b|\\bRESET\\b|\\bRETRANSMIT\\b|\\bDUPLICATE\\b",
    label: "Timeout / unreachable",
    description: "TIMEOUT, TIMED OUT, UNREACHABLE, NO ROUTE, RESET, RETRANSMIT, DUPLICATE — network/connectivity failure keywords, red.",
    color: "red",
    flags: "gi"
  },
  {
    pattern: "\\bDOWN\\b|\\bINACTIVE\\b|\\bDISABLED\\b|\\bOFFLINE\\b|\\bDEAD\\b",
    label: "Down / inactive (case-sensitive)",
    description: "DOWN, INACTIVE, DISABLED, OFFLINE, DEAD — case-sensitive so lowercase prose words aren't matched, red.",
    color: "red",
    flags: "g"
  },
  {
    pattern: "\\bUP\\b|\\bACTIVE\\b|\\bENABLED\\b|\\bRUNNING\\b|\\bESTABLISHED\\b|\\bCONNECTED\\b|\\bONLINE\\b|\\bALIVE\\b|\\bREACHABLE\\b",
    label: "Up / active (case-sensitive)",
    description: "UP, ACTIVE, ENABLED, RUNNING, ESTABLISHED, CONNECTED, ONLINE, ALIVE, REACHABLE — case-sensitive so lowercase prose words aren't matched, green.",
    color: "green",
    flags: "g"
  },
  {
    pattern: "\\bPENDING\\b|\\bWAITING\\b|\\bLISTENING\\b|\\bSTARTING\\b|\\bRELOADING\\b|\\bSTOPPING\\b",
    label: "Pending / waiting",
    description: "PENDING, WAITING, LISTENING, STARTING, RELOADING, STOPPING — transitional state keywords, yellow.",
    color: "yellow",
    flags: "gi"
  },
  {
    pattern: "\\bDEPRECATED\\b|\\bOBSOLETE\\b",
    label: "Deprecated",
    description: "DEPRECATED, OBSOLETE — flags outdated commands/features, underlined yellow.",
    color: "yellow",
    flags: "gi",
    underline: true
  },
  {
    pattern: "(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}",
    label: "MAC addresses",
    description: "Colon- or hyphen-separated MAC addresses (e.g. aa:bb:cc:dd:ee:ff), magenta.",
    color: "magenta",
    flags: "g"
  },
  {
    pattern: "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(?:/\\d{1,2})?\\b",
    label: "IPv4 addresses",
    description: "IPv4 addresses, optionally with a /prefix (e.g. 10.0.0.1/24), magenta.",
    color: "magenta",
    flags: "g"
  },
  {
    pattern: "\\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\\b|\\b(?:[0-9a-fA-F]{1,4}:){6}(?:\\d{1,3}\\.){3}\\d{1,3}\\b|\\b(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){0,4}:(?:\\d{1,3}\\.){3}\\d{1,3}\\b|\\b(?:[0-9a-fA-F]{1,4}:){1,7}(?::[0-9a-fA-F]{1,4}){1,7}\\b|::(?:[0-9a-fA-F]{1,4}:){0,5}(?:\\d{1,3}\\.){3}\\d{1,3}\\b|::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}\\b|\\b(?:[0-9a-fA-F]{1,4}:){1,7}:(?!:)",
    label: "IPv6 addresses",
    description: "IPv6 addresses, full and compressed (including trailing-compressed forms like fe80:: or 2001:db8::), except the bare all-zeros \"::\" — a lone :: in terminal output is overwhelmingly a C++/Ruby scope operator. Disabled by default — this is one of the two most expensive built-in patterns, since it has to be tried at nearly every character. Enable it from the Highlighting Rules editor if you want it.",
    color: "magenta",
    flags: "g"
  },
  {
    pattern: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
    label: "UUIDs",
    description: "Standard 8-4-4-4-12 hex UUIDs. Disabled by default — this is one of the two most expensive built-in patterns, since it has to be tried at nearly every character. Enable it from the Highlighting Rules editor if you want it.",
    color: "brightBlue",
    flags: "g"
  },
  {
    pattern: "https?://\\S+",
    label: "URLs",
    description: "http(s):// links, underlined blue.",
    color: "blue",
    flags: "gi",
    underline: true
  },
  {
    pattern: "\\b(?:errors|dropped|overruns|collisions|discards|giants|runts|throttles|CRC|frame|ignored|abort|resets|carrier transitions|no buffer|underruns|retransmits|failures|loss):",
    label: "Interface error counters",
    description: "Network-interface error counter labels (errors, dropped, CRC, collisions, overruns, …), red.",
    color: "red",
    flags: "gi"
  },
  {
    pattern: "\\b(?:exit-code|core-dump|signal|timeout|watchdog)\\b",
    label: "Exit-code / signal keywords",
    description: "exit-code, core-dump, signal, timeout, watchdog — process-death diagnostic keywords, red.",
    color: "red",
    flags: "g"
  }
];

const CURRENT_IPV6_PATTERN = DEFAULT_HIGHLIGHT_RULE_CATALOG.find(
  (entry) => entry.label === "IPv6 addresses"
)!.pattern;

/**
 * Historical default patterns that no longer ship, mapped to the canonical
 * pattern that replaces them.
 *
 * v1 shipped from the feature's introduction through v2.8.179. v2 (v1 plus a
 * trailing-`::` alternative) shipped v2.8.180 – v2.8.186. Both carried the
 * same truncation bug. Every one of the other 21 default patterns is unchanged
 * across the whole history, so there is nothing else to map.
 */
const IPV6_PATTERN_V1 =
  "\\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){7}\\b|\\b(?:[0-9a-fA-F]{1,4}:){1,7}:[0-9a-fA-F]{1,4}\\b|::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}\\b";
const IPV6_PATTERN_V2 = `${IPV6_PATTERN_V1}|\\b(?:[0-9a-fA-F]{1,4}:){1,7}:(?!:)`;

export const FORMER_DEFAULT_PATTERNS: Readonly<Record<string, string>> = {
  [IPV6_PATTERN_V1]: CURRENT_IPV6_PATTERN,
  [IPV6_PATTERN_V2]: CURRENT_IPV6_PATTERN
};

const CATALOG_BY_PATTERN = new Map(
  DEFAULT_HIGHLIGHT_RULE_CATALOG.map((entry) => [entry.pattern, entry] as const)
);

// Looked up through a Map, not by indexing the exported Record: `pattern` is
// user-controlled, and indexing a plain object with "constructor" / "toString"
// returns an inherited Object.prototype member rather than undefined — which
// would be read as "this is a former default pattern" and overwrite the rule's
// pattern with a function. Object.entries walks own properties only.
const FORMER_PATTERN_MAP = new Map(Object.entries(FORMER_DEFAULT_PATTERNS));

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.length === 0;
}

/**
 * Flags normalised for comparison: absent means "gi" (exactly what
 * `compileRule` runs a flagless rule with), and character order is
 * insignificant ("ig" is "gi").
 */
function normalizeFlags(flags: string | undefined): string {
  return [...(flags ?? "gi")].sort().join("");
}

/**
 * Whether a rule still MATCHES the way the default it shares a pattern with
 * does. Flags change behaviour, and two shipped labels state theirs outright —
 * "Down / inactive (case-sensitive)" exists precisely because its missing `i`
 * keeps lowercase prose words out. Backfilling that text onto a rule the user
 * flipped to `gi` would be false metadata (and the activation migration would
 * write it to settings permanently), so BOTH label and description backfill
 * require matching flags. The pattern rewrite is exempt: the former IPv6
 * patterns are broken under any flags.
 */
function flagsMatchDefault(rule: HighlightRule, known: DefaultHighlightRuleInfo): boolean {
  return normalizeFlags(rule.flags) === normalizeFlags(known.flags);
}

/**
 * Whether a rule still LOOKS like the default it shares a pattern with.
 *
 * The shipped descriptions describe appearance as well as meaning ("…, bold
 * red.", "…, underlined blue."). A user who recoloured a rule in the editor
 * without naming it would otherwise be handed a description that contradicts
 * what they can see on screen — worse than the blank cell it replaced, because
 * a blank cell does not lie. `label` is exempt from THIS gate — it is the
 * rule's IDENTITY ("Errors"), true whatever colour the user picked — but both
 * fields additionally require matching flags (see `flagsMatchDefault`).
 *
 * Absent bold/underline mean false on both sides — package.json omits them
 * rather than writing `false`, and so does the editor when saving.
 */
function stylingMatchesDefault(rule: HighlightRule, known: DefaultHighlightRuleInfo): boolean {
  return (
    rule.color === known.color &&
    (rule.bold ?? false) === (known.bold ?? false) &&
    (rule.underline ?? false) === (known.underline ?? false)
  );
}

export interface HighlightRuleUpgradeResult {
  rules: HighlightRule[];
  changed: boolean;
}

/**
 * Upgrade a validated rule array in place-of-history. See the module comment
 * for the exact contract; the short version is "rewrite known-former patterns,
 * backfill missing names, touch nothing else".
 */
export function upgradeHighlightRules(rules: HighlightRule[]): HighlightRuleUpgradeResult {
  // Built lazily on the first actual change. The overwhelmingly common call is
  // the no-op one — every reload(), every editor open, every activation after
  // the first — and it must not allocate a fresh array (nor a fresh object per
  // rule) just to hand back something equal to its input.
  let upgraded: HighlightRule[] | undefined;

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const canonicalPattern = FORMER_PATTERN_MAP.get(rule.pattern);
    const pattern = canonicalPattern ?? rule.pattern;
    const known = CATALOG_BY_PATTERN.get(pattern);

    const needsPattern = canonicalPattern !== undefined;
    const sameFlags = known !== undefined && flagsMatchDefault(rule, known);
    const needsLabel = sameFlags && isBlank(rule.label);
    const needsDescription =
      sameFlags && isBlank(rule.description) && stylingMatchesDefault(rule, known!);
    if (!needsPattern && !needsLabel && !needsDescription) {
      continue;
    }

    if (upgraded === undefined) {
      upgraded = rules.slice();
    }
    const next: HighlightRule = { ...rule };
    if (needsPattern) next.pattern = pattern;
    if (needsLabel) next.label = known!.label;
    if (needsDescription) next.description = known!.description;
    upgraded[index] = next;
  }

  // Same reference on a no-op: callers use it to skip a settings write.
  return upgraded === undefined ? { rules, changed: false } : { rules: upgraded, changed: true };
}
