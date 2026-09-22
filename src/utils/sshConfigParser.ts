import * as os from "node:os";
import * as path from "node:path";

/**
 * OpenSSH client-config (`~/.ssh/config`) reader for the import flows.
 *
 * Split in two layers on purpose:
 *
 *  1. {@link parseSshConfig} is PURE — string in, result out. No `fs`, no
 *     `vscode`, no I/O of any kind. `Include` directives come back as DATA
 *     ({@link SshConfigParseResult.includes}); this layer resolves nothing.
 *  2. {@link resolveSshConfig} follows those includes by TEXTUAL SPLICE: every
 *     `Include` line is replaced by the lines of the file(s) it names,
 *     recursively, and the assembled document is parsed ONCE. Every byte it
 *     reads goes through an injected {@link SshConfigIo}, so tests need no
 *     module mocking — they hand in a Map-backed io object. Each assembled line
 *     keeps a back-pointer to its real (file, line) so entries and issues still
 *     report coordinates a user can open.
 *
 * This is an IMPORTER, not `ssh(1)`. Where real OpenSSH would `fatal()` (a
 * missing include, a bad port, a too-deep include chain) we record an issue,
 * bump a counter and carry on: a user importing 200 hosts should not lose all
 * of them to one typo on line 3.
 *
 * Semantics deliberately mirrored from OpenSSH's `readconf.c`:
 *
 *  - Keywords are case-insensitive.
 *  - FIRST value wins per keyword ("first obtained value ... will be used" —
 *    ssh_config(5)). This is the opposite of most config formats and the single
 *    easiest thing to get backwards. It is per KEYWORD, not per block: when the
 *    same alias appears in two `Host` blocks, ssh keeps the first value obtained
 *    for each option across BOTH, so the blocks merge rather than the later one
 *    being discarded (see {@link mergeByAlias}).
 *  - `Host a b c` fans out: each non-wildcard pattern the line does not also
 *    negate becomes its own entry sharing the block's settings.
 *  - Wildcard patterns (`*`, `?`) are defaults blocks, not hosts — skipped and
 *    counted. A negated pattern (`!foo`) names no host itself AND SUBTRACTS:
 *    `Host foo bar !foo` applies to `bar` alone, so `foo` is not imported.
 *  - `Match` blocks are skipped wholesale: their conditions (`exec`, `host`,
 *    `originalhost`, ...) cannot be evaluated statically at import time.
 *  - `Include` is TEXTUAL. readconf.c reads the included file's lines in place,
 *    inside whatever block is open at the `Include` line — which is why
 *    ssh_config(5) says it "may appear inside a Match or Host block to perform
 *    conditional inclusion". So directives before an included file's first
 *    `Host` line belong to the INCLUDING block, and an included file that opens
 *    its own `Host` block ends the enclosing one for the lines that follow it
 *    back in the parent — and, symmetrically, a `Match` an included file leaves
 *    open still covers the parent's following lines. The one deliberate
 *    departure: an `Include` that lands inside a `Match` block is not followed,
 *    wherever that `Match` was opened (see {@link assembleDocument}).
 *  - A block with no `HostName` uses the ALIAS as the host — that is what ssh
 *    itself does, so such blocks are real, connectable hosts and must not be
 *    dropped.
 *
 * Not modelled (all of it lives outside what an import needs): `%`-token
 * expansion in `HostName`/`ProxyJump`/`IdentityFile` (`%h`, `%p`, `%r` come
 * through verbatim), `CanonicalizeHostname`, and per-host options beyond the
 * five read below.
 *
 * ONE DELIBERATE DEPARTURE FROM ssh(1), stated plainly because it is a choice
 * and not an oversight: OpenSSH ACCUMULATES `IdentityFile` — every line adds
 * another key to the list it will try — while this parser keeps only the FIRST,
 * like every other keyword. An imported server row holds ONE key path, so the
 * alternative on offer is not "all of them" but "the last one silently
 * replacing the first". Later paths are dropped without an issue: they are
 * valid config, not a mistake the user should be sent to fix.
 */

/** A single importable host derived from one `Host` pattern. */
export interface SshConfigEntry {
  /** The `Host` pattern this entry came from — the stable identity ssh knows it by. */
  alias: string;
  /** `HostName` when the block declared one, otherwise the alias itself. */
  host: string;
  port?: number;
  user?: string;
  proxyJump?: string;
  identityFile?: string;
  /** 1-based line of the `Host` directive within {@link source}. */
  line: number;
  /** Absolute path of the file the block came from; only {@link resolveSshConfig} sets it. */
  source?: string;
}

/** An `Include` directive, verbatim. Resolving it is not this layer's job. */
export interface SshConfigInclude {
  /** 1-based line of the `Include` directive. */
  line: number;
  /** Every pattern on the line, in order — `Include a b` yields two. */
  patterns: string[];
}

/** One thing the input got wrong that did not stop the parse. */
export interface SshConfigParseIssue {
  /** 1-based line within {@link file}, or 0 for a whole-file problem (unreadable include). */
  line: number;
  /** The offending text, trimmed. Empty for whole-file problems. */
  text: string;
  reason: string;
  /** Absolute path of the file; only {@link resolveSshConfig} sets it. */
  file?: string;
}

export interface SshConfigParseResult {
  entries: SshConfigEntry[];
  /** `Include` directives encountered, in source order. Data only. */
  includes: SshConfigInclude[];
  issues: SshConfigParseIssue[];
  /**
   * True once ANY line anywhere in the walk was recognised as ssh_config
   * grammar: a `Host` or `Match` header, an `Include`, or one of the keywords
   * this parser models ({@link SINGLE_VALUE_KEYWORDS}). It answers exactly one
   * question — "is this file even an ssh config?" — and nothing about whether
   * there was anything worth importing.
   *
   * IT EXISTS BECAUSE EVERY OTHER FIELD A CALLER MIGHT ASK THAT WITH IS EMPTIED
   * OR CONSUMED BY THE TIME THE CALLER SEES IT. {@link resolveSshConfig} swallows
   * `Include` lines into the splice and returns `includes` EMPTY by contract, and
   * a config whose grammar is all defaults and includes yields no `entries` and
   * no wildcard/negated/Match counts either. An include-only root whose glob
   * directory is empty therefore comes back all-zero, and a caller sniffing on
   * those fields calls a perfectly valid config the wrong kind of file.
   *
   * So it is ORed across the whole walk, never reset per file, and is set by the
   * include assembler for the `Include` lines the splice consumes as well as by
   * the parse of the assembled document. Consequently:
   *  - an include-only root whose includes resolve to nothing → true;
   *  - a defaults-only `Host *` config → true;
   *  - a CSV host list or a MobaXterm INI body → false (their lines are either
   *    unparseable as directives or carry keywords this parser does not model).
   */
  sawSshGrammar: boolean;
  /** `Host` patterns skipped for containing `*` or `?` (a defaults block). */
  wildcardPatternCount: number;
  /**
   * `Host` patterns that were negations (`!foo`) — the `!` patterns themselves,
   * which name no host. The aliases a negation CANCELLED are counted nowhere:
   * they were never patterns of their own.
   */
  negatedPatternCount: number;
  /** `Match` blocks skipped whole. */
  matchBlockCount: number;
  /**
   * Repeated-alias blocks that contributed NOTHING — every keyword they set had
   * already been obtained from an earlier block, so under first-value-wins they
   * are dead text.
   *
   * A repeated block that filled in a field the earlier one left unset is NOT
   * counted: it was MERGED, not skipped (see {@link mergeByAlias}), and calling
   * it skipped would tell the user a host was lost when its settings were kept.
   */
  duplicateAliasCount: number;
  /**
   * Includes that contributed no text: the named file could not be read, or the
   * pattern named no readable file at all — an empty glob expansion, a glob in a
   * directory component, or a bracket expression that does not compile.
   */
  includeMissingCount: number;
  /** Includes refused for exceeding {@link MAX_INCLUDE_DEPTH}. */
  includeDepthExceededCount: number;
  /**
   * Includes refused for naming a file already open further up the include
   * chain — a real cycle (`a` → `a`, or `a` → `b` → `a`). A file included twice
   * along different branches is NOT a cycle and is expanded both times.
   */
  includeCycleCount: number;
}

/** All file access {@link resolveSshConfig} performs, injected so tests stay pure. */
export interface SshConfigIo {
  /** File contents, or `undefined` when it does not exist / cannot be read. Must not throw. */
  readFile(filePath: string): Promise<string | undefined>;
  /** Entry names (basenames) directly inside `dir`; `[]` when it cannot be listed. Must not throw. */
  readDir(dir: string): Promise<string[]>;
}

/** OpenSSH's `MAX_READCONF_DEPTH` (readconf.c). The root file is depth 0. */
export const MAX_INCLUDE_DEPTH = 16;

const SINGLE_VALUE_KEYWORDS = new Set(["hostname", "port", "user", "proxyjump", "identityfile"]);

interface BlockState {
  /** Aliases this block feeds, in `Host`-line order. */
  aliases: string[];
  line: number;
  values: Map<string, string>;
  /** Line each kept value came from, for issue reporting. */
  valueLines: Map<string, number>;
  /** Keywords already seen in this block — the mechanism behind first-value-wins. */
  seen: Set<string>;
}

/**
 * Split an argument list on whitespace, honouring quotes so a quoted path with
 * spaces survives (`IdentityFile "~/my keys/id_ed25519"`), honouring backslash
 * escapes, and dropping an unquoted `#` comment and everything after it.
 *
 * A `#` that OPENS a token is a comment; one inside a token is not. That is
 * OpenSSH's rule (the comment check happens only while it is skipping the
 * whitespace before a token), so `Host web#1` keeps its `#` and `Host web # prod`
 * does not.
 *
 * BOTH QUOTE CHARACTERS QUOTE. `argv_split()` keeps ONE `quote` variable
 * holding the character that opened the current quoted run — `"` or `'` — so
 * the two are symmetric, and everything below follows from that single variable
 * rather than from a rule invented here:
 *  - A quote only OPENS a run while no run is open, and only the SAME character
 *    closes it. So a `"` inside single quotes and a `'` inside double quotes are
 *    ordinary literal characters: `IdentityFile "/tmp/it's here"` is one token,
 *    `/tmp/it's here`.
 *  - A quote may open a run MID-token, and the run ending does not end the
 *    token: `IdentityFile /tmp/'my key'.pub` is `/tmp/my key.pub`, exactly one
 *    argument. The quotes are delimiters, never content.
 *  - Single quotes are NOT shell-style literal runs. `\\`, `\"` and `\'` are
 *    still recognised escapes inside them (see below); only `\ `/`\<tab>` stop
 *    being recognised inside quotes, either kind, because a quoted space needs
 *    no escape.
 * The first of those was checked against OpenSSH 9.6: `IdentityFile '/tmp/my key'`
 * makes `ssh -G -F <file> host` report `identityfile /tmp/my key`. The other two
 * are read off `argv_split()`'s own control flow rather than from a run, so if
 * one is ever found to differ, that function is the authority — not this list.
 *
 * ONE DELIBERATE LENIENCY: `argv_split()` FAILS the whole line on an unterminated
 * quote, and readconf.c then `fatal()`s the config. Here an unterminated quote
 * simply ends with the line, emitting the token it had accumulated — an importer
 * that threw away 200 hosts over one stray `"` would be obeying ssh(1) at the
 * user's expense. This is the only place the split deviates.
 *
 * ESCAPES ARE SELECTIVE, and deliberately so. OpenSSH splits a config line with
 * `argv_split()` (misc.c), which drops the backslash for exactly five escapes —
 * `\\`, `\"`, `\'`, and, OUTSIDE quotes, `\ ` and `\<tab>` — and treats every
 * other `\X` as an "unrecognised escape": the backslash is KEPT and `X` is then
 * handled as an ordinary character. Copying that set rather than stripping every
 * backslash is what keeps a Windows path readable: `C:\Users\me\.ssh\id_rsa` has
 * no recognised escape in it, so it survives whole, which is also what
 * `ssh -G` reports for it. A blanket "drop the backslash" rule would hand the
 * connector `C:Usersme.sshid_rsa`.
 *
 * Consequences worth stating, because each one is a decision:
 *  - An escape is consumed BEFORE the whitespace and comment boundaries are
 *    applied, which is the actual bug this rule exists to fix:
 *    `IdentityFile /tmp/my\ key` is one token, `/tmp/my key`.
 *  - Escapes are processed inside quotes too, but only `\\`, `\"` and `\'` are
 *    recognised there — an escaped space inside quotes is an unrecognised escape
 *    (the space needs no escaping there), so `"my\ key"` keeps its backslash.
 *  - `\"` and `\'` never open or close a quoted run; each is a literal quote.
 *  - A trailing backslash at end of line is an unrecognised escape with nothing
 *    after it: it stays in the token as a literal `\`. ssh_config has no
 *    line-continuation syntax, so there is nothing else it could mean.
 *  - `\#` is an unrecognised escape, so it yields `\#` and not `#`. It does stop
 *    the `#` starting a comment, but only because the backslash has already
 *    opened the token — not because the escape was honoured. Matching OpenSSH
 *    here beats inventing a nicer rule: a user who writes `\#` in a path gets
 *    from us exactly the path ssh would use.
 */
function tokenizeArgs(rest: string): string[] {
  const tokens: string[] = [];
  let current = "";
  /**
   * The quote character that opened the run currently open, or "" outside
   * quotes — `argv_split()`'s `quote`, which is a CHAR and not a flag for
   * exactly this reason: only the character that opened a run can close it.
   */
  let quote = "";
  let started = false;

  const flush = (): void => {
    if (started) {
      tokens.push(current);
      current = "";
      started = false;
    }
  };

  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "\\") {
      const next = rest[i + 1];
      const recognised =
        next === "\\" || next === '"' || next === "'" || (quote === "" && (next === " " || next === "\t"));
      if (recognised) {
        // Consumed here, so the escaped character can no longer end the token.
        current += next;
        i++;
      } else {
        // Unrecognised escape (including a trailing backslash): OpenSSH keeps
        // the backslash and re-reads the next character as an ordinary one.
        current += ch;
      }
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (quote === "") {
        // Opens a run — mid-token is fine, the quotes are delimiters not content.
        quote = ch;
        started = true;
        continue;
      }
      if (quote === ch) {
        // Only the character that opened the run closes it.
        quote = "";
        started = true;
        continue;
      }
      // The OTHER quote character inside a run: an ordinary literal, falling
      // through to be appended below.
    }
    if (quote === "" && (ch === " " || ch === "\t")) {
      flush();
      continue;
    }
    if (quote === "" && ch === "#" && !started) {
      break;
    }
    current += ch;
    started = true;
  }
  flush();

  return tokens;
}

/** `Keyword value`, `Keyword=value` and `Keyword = value` are all legal. */
const KEYWORD_LINE_RE = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*=?[ \t]*(.*)$/;

/** One classified source line. */
type ConfigLine =
  | { kind: "blank" }
  | { kind: "malformed"; text: string }
  | { kind: "directive"; keyword: string; spelling: string; args: string[]; text: string };

/**
 * Classify one raw line: blank/comment, unparseable, or a directive.
 *
 * Shared by both layers on purpose, and that sharing is now a CORRECTNESS
 * requirement rather than tidiness. The include assembler tracks `Host`/`Match`
 * transitions as it emits lines, and the single parse of the assembled document
 * tracks them again over the very same lines; the two must classify every line
 * identically or the assembler will splice an `Include` the parser then treats
 * as `Match`-nested (or the reverse). One function, one answer.
 */
function readConfigLine(raw: string): ConfigLine {
  const text = raw.trim();
  if (text === "" || text.startsWith("#")) {
    return { kind: "blank" };
  }
  const match = text.match(KEYWORD_LINE_RE);
  if (!match) {
    return { kind: "malformed", text };
  }
  return { kind: "directive", keyword: match[1].toLowerCase(), spelling: match[1], args: tokenizeArgs(match[2]), text };
}

function isWildcardPattern(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

/**
 * Does an ssh HOST pattern match a host name?
 *
 * Deliberately NOT {@link globToRegExp}, which compiles FILE globs for
 * `Include` expansion: there `/` is a path separator (`*` is `[^/]*`) and
 * `[...]` is a character class. ssh's host matching is `match_pattern()`
 * (match.c), which knows `*` and `?` and nothing else — a bracket is an
 * ordinary character there — and has no notion of a separator, a host name
 * being one flat string. Borrowing the file-glob compiler would give `[` a
 * meaning ssh does not give it and would stop `!*` cancelling an alias that
 * happens to contain a slash.
 *
 * Case-insensitive, as `match_pattern()` is. Note that {@link mergeByAlias}
 * still keys on the exact alias string, so `Host Foo` and `Host foo` remain two
 * entries — a separate, known departure, not one this function creates.
 */
function matchesHostPattern(pattern: string, host: string): boolean {
  // Every character is escaped before the two wildcards are re-introduced, so
  // the source is always a valid regex and this cannot throw.
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(host);
}

function normalizePort(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const port = Number.parseInt(raw, 10);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * One entry plus the two bits {@link mergeByAlias} needs and callers must not
 * see: whether the block actually spelled out a `HostName`, and whether it
 * spelled out a `Port`.
 *
 * {@link SshConfigEntry.host} cannot answer the first on its own, because a
 * block without a `HostName` carries the alias there as a FALLBACK. A fallback
 * must lose to a later block's real `HostName`; a value must not.
 */
interface RawEntry {
  entry: SshConfigEntry;
  hostExplicit: boolean;
  /**
   * Whether the block spelled out a `Port` AT ALL — true even when the value
   * was rejected by {@link normalizePort}.
   *
   * {@link SshConfigEntry.port} cannot answer that either: a Port that was never
   * written and one written as `notanumber` are both `undefined` there. Inside
   * ONE block `block.seen` already stops a second `Port` from taking a bad
   * first one's place; without this bit the very same two lines split across
   * two blocks sharing an alias behave the opposite way, and the policy stated
   * in {@link parseSshConfig}'s `closeBlock` holds on one path and not the
   * other.
   */
  portObtained: boolean;
}

/**
 * Fill every field `first` still has unset from `later`, and report whether
 * anything moved.
 *
 * Fields already set are never touched: first-value-wins is the rule being
 * implemented here, not an obstacle to it.
 */
function mergeInto(first: RawEntry, later: RawEntry): boolean {
  let merged = false;

  // The alias-as-host fallback is not a value OpenSSH "obtained", so a later
  // block's real HostName still wins it — `ssh -G` reports that HostName.
  if (!first.hostExplicit && later.hostExplicit) {
    first.entry.host = later.entry.host;
    first.hostExplicit = true;
    merged = true;
  }
  // An invalid Port was still OBTAINED: first-obtained-value is about the
  // keyword appearing, not about the value proving usable, and the block that
  // wrote it already got its issue. So the latch moves even when the value it
  // carries is `undefined` — that is what stops a later block filling a slot
  // the earlier one already claimed and badly spelled.
  if (!first.portObtained && later.portObtained) {
    first.entry.port = later.entry.port;
    first.portObtained = true;
    // Counted as a contribution even when no usable value moved: the keyword
    // this block set had NOT been obtained before, so the block is not the dead
    // text {@link SshConfigParseResult.duplicateAliasCount} claims to count.
    merged = true;
  }
  if (first.entry.user === undefined && later.entry.user !== undefined) {
    first.entry.user = later.entry.user;
    merged = true;
  }
  if (first.entry.proxyJump === undefined && later.entry.proxyJump !== undefined) {
    first.entry.proxyJump = later.entry.proxyJump;
    merged = true;
  }
  if (first.entry.identityFile === undefined && later.entry.identityFile !== undefined) {
    first.entry.identityFile = later.entry.identityFile;
    merged = true;
  }

  return merged;
}

/**
 * Fold repeated `Host` aliases into one entry the way OpenSSH reads them, and
 * count only the repeats that turned out to be dead text.
 *
 * ssh(1) does NOT pick one block and discard the rest. First-match-wins is per
 * OPTION, not per block: "the first obtained value for each parameter" is kept,
 * across every block whose pattern matches. For
 *
 *     Host foo
 *       HostName example.test
 *     Host foo
 *       User bob
 *
 * `ssh -G -F <file> foo` reports BOTH `hostname example.test` AND `user bob`.
 * Dropping the later block wholesale (what this used to do) imported `foo` with
 * no user, and lost a later `Port` or `IdentityFile` exactly as quietly.
 *
 * So a repeated alias MERGES into the first entry: fields still unset are
 * filled, fields already set are left alone. The entry keeps the FIRST block's
 * `line`/`source` — that is the block that named the host, and the coordinate a
 * user opening the file wants.
 *
 * Runs once, inside {@link parseSshConfig}. Because {@link resolveSshConfig}
 * splices every include into ONE document and parses that document a single
 * time, this pass is already the global one: a repeated alias arriving from an
 * included file merges through this very code, with no cross-file second pass
 * whose count would have to be reconciled with this one.
 */
function mergeByAlias(raw: RawEntry[]): { entries: SshConfigEntry[]; duplicateAliasCount: number } {
  const kept: SshConfigEntry[] = [];
  const byAlias = new Map<string, RawEntry>();
  let duplicateAliasCount = 0;

  for (const candidate of raw) {
    const first = byAlias.get(candidate.entry.alias);
    if (first === undefined) {
      byAlias.set(candidate.entry.alias, candidate);
      // Pushed by reference on purpose: a later block merges INTO this object.
      kept.push(candidate.entry);
      continue;
    }
    if (!mergeInto(first, candidate)) {
      // Nothing of this block survived first-value-wins, so it really was
      // skipped — the only case the counter now claims.
      duplicateAliasCount++;
    }
  }

  return { entries: kept, duplicateAliasCount };
}

function emptyResult(): SshConfigParseResult {
  return {
    entries: [],
    includes: [],
    issues: [],
    sawSshGrammar: false,
    wildcardPatternCount: 0,
    negatedPatternCount: 0,
    matchBlockCount: 0,
    duplicateAliasCount: 0,
    includeMissingCount: 0,
    includeDepthExceededCount: 0,
    includeCycleCount: 0
  };
}

/**
 * Split config text into lines the way both layers must agree on.
 *
 * BOM first, then CRLF — a BOM'd CRLF file is the normal shape of a config
 * copied off Windows, and both must survive to reach the keyword regex.
 *
 * Shared with the include assembler on purpose: a line's index here IS its
 * reported line number, so if the two layers split differently every issue and
 * entry coming out of an included file points at the wrong line.
 */
function splitConfigLines(text: string): string[] {
  return text.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
}

/**
 * Parse one OpenSSH client config. PURE — no I/O, no `vscode`, no `fs`.
 *
 * `Include` directives are returned untouched in {@link SshConfigParseResult.includes};
 * call {@link resolveSshConfig} if you want them followed.
 */
export function parseSshConfig(text: string): SshConfigParseResult {
  const result = emptyResult();
  const lines = splitConfigLines(text);

  const rawEntries: RawEntry[] = [];
  let block: BlockState | undefined;
  // True while inside a `Match` block: every directive up to the next `Host`
  // or `Match` is conditional, so none of it (Includes included) is imported.
  let inMatchBlock = false;

  const closeBlock = (): void => {
    if (!block) {
      return;
    }
    const hostName = block.values.get("hostname");
    const rawPort = block.values.get("port");
    // Validated only AFTER first-value-wins has picked the value: a bad first
    // Port must not let a later Port quietly take its place.
    const port = rawPort === undefined ? undefined : normalizePort(rawPort);
    if (rawPort !== undefined && port === undefined) {
      result.issues.push({
        line: block.valueLines.get("port") ?? block.line,
        text: rawPort,
        reason: `Port "${rawPort}" is not a number in 1-65535`
      });
    }
    for (const alias of block.aliases) {
      rawEntries.push({
        entry: {
          alias,
          // No HostName means ssh connects to the alias itself — a real host, not a stub.
          host: hostName ?? alias,
          port,
          user: block.values.get("user"),
          proxyJump: block.values.get("proxyjump"),
          identityFile: block.values.get("identityfile"),
          line: block.line
        },
        hostExplicit: hostName !== undefined,
        portObtained: rawPort !== undefined
      });
    }
    block = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const parsed = readConfigLine(lines[i]);
    if (parsed.kind === "blank") {
      continue;
    }
    if (parsed.kind === "malformed") {
      result.issues.push({ line: lineNumber, text: parsed.text, reason: "line does not start with a keyword" });
      continue;
    }

    const { keyword, args, text: trimmed } = parsed;

    // Set before any of the branches below, and before the `Match` skip: a
    // keyword this parser knows is ssh-config grammar whether or not the line
    // it sits on yields anything importable. See SshConfigParseResult.sawSshGrammar.
    if (keyword === "host" || keyword === "match" || keyword === "include" || SINGLE_VALUE_KEYWORDS.has(keyword)) {
      result.sawSshGrammar = true;
    }

    if (keyword === "host") {
      closeBlock();
      inMatchBlock = false;
      if (args.length === 0) {
        result.issues.push({ line: lineNumber, text: trimmed, reason: "Host directive has no patterns" });
        continue;
      }
      if (args.every((pattern) => pattern === "")) {
        // `Host ""` is a token that names nothing, so the line is as empty-handed
        // as a bare `Host` and takes the same issue rather than inventing a
        // second wording for one condition.
        result.issues.push({ line: lineNumber, text: trimmed, reason: "Host directive has no patterns" });
        continue;
      }
      // Two passes, because a negation applies to the WHOLE line wherever it sits
      // on it: `Host foo bar !foo` and `Host !foo foo bar` both leave ssh
      // applying the block to `bar` alone.
      const negated: string[] = [];
      const positives: string[] = [];
      for (const pattern of args) {
        if (pattern === "") {
          // A quoted empty token names no host; it is neither a wildcard nor a
          // negation, so it is counted as neither.
          continue;
        }
        if (pattern.startsWith("!")) {
          result.negatedPatternCount++;
          negated.push(pattern.slice(1));
          continue;
        }
        if (isWildcardPattern(pattern)) {
          // `Host *` and friends are defaults blocks applied to other hosts.
          result.wildcardPatternCount++;
          continue;
        }
        positives.push(pattern);
      }
      // A negation SUBTRACTS from the set the positive patterns build — that is
      // the whole of what `!` does — so an alias any negation matches is not
      // imported at all: the block never applies to it, and importing it would
      // hand the user the excluded host with the exception's destination, user
      // and key. Negations may be globs themselves, so `!*.internal` cancels
      // `db.internal`.
      //
      // A cancelled alias is counted nowhere. `negatedPatternCount` counts the
      // `!` patterns, which is what its name and doc say, and a second counter
      // would change a result shape the import commands already read.
      const aliases = positives.filter((alias) => !negated.some((pattern) => matchesHostPattern(pattern, alias)));
      if (aliases.length > 0) {
        block = { aliases, line: lineNumber, values: new Map(), valueLines: new Map(), seen: new Set() };
      }
      // No block is opened when nothing survives — every pattern a wildcard, or
      // every alias cancelled. The directives that follow then fall through the
      // `!block` branch below as globals and import nothing, which is correct:
      // there is no host left for them to describe.
      continue;
    }

    if (keyword === "match") {
      closeBlock();
      inMatchBlock = true;
      result.matchBlockCount++;
      continue;
    }

    if (inMatchBlock) {
      continue;
    }

    if (keyword === "include") {
      if (args.length === 0) {
        result.issues.push({ line: lineNumber, text: trimmed, reason: "Include directive has no path" });
        continue;
      }
      // Recorded at its own line so the resolver can splice the included
      // content exactly here — position decides which value wins.
      result.includes.push({ line: lineNumber, patterns: args });
      continue;
    }

    if (!SINGLE_VALUE_KEYWORDS.has(keyword)) {
      continue;
    }
    if (!block) {
      // A pre-`Host` directive is a global default, the same role `Host *`
      // plays; it belongs to no alias, so there is nothing to import.
      continue;
    }
    if (args.length === 0 || args[0] === "") {
      // `IdentityFile ""` obtains nothing: a quoted empty token names no file, no
      // user and no port, so it takes the same issue as the bare keyword. Not
      // marking the keyword seen is the point — a later line in the block is
      // still free to supply the real value, exactly as if this line were absent.
      result.issues.push({ line: lineNumber, text: trimmed, reason: `${parsed.spelling} has no value` });
      continue;
    }
    if (block.seen.has(keyword)) {
      // First obtained value wins (ssh_config(5)) — later ones are dead text.
      continue;
    }
    block.seen.add(keyword);
    block.values.set(keyword, args[0]);
    block.valueLines.set(keyword, lineNumber);
  }

  closeBlock();

  const merged = mergeByAlias(rawEntries);
  result.entries = merged.entries;
  result.duplicateAliasCount = merged.duplicateAliasCount;

  return result;
}

/**
 * Expand a leading `~`.
 *
 * Copied verbatim from `expandHome` in `src/services/local/localServerManager.ts:157`
 * — the repo has four separate `~` expanders (there, `localShellCommands.ts:302`,
 * `authProfileLabel.ts:12` and `TftpAdapter.ts:86`) and no shared util. That one
 * is the right one to copy because its lookahead `(?=\/|\\|$)` refuses to touch
 * `~user/...`, which expands to ANOTHER user's home and must not silently become
 * ours. Deliberately not extracted into a shared helper: unifying four callers
 * with four different edge-case histories is a separate change.
 */
function expandHome(value: string): string {
  return value.replace(/^~(?=\/|\\|$)/, os.homedir());
}

/** The system-wide config directory, and the include base for a read rooted in it. */
const SYSTEM_CONFIG_DIR = "/etc/ssh";

/**
 * The directory a relative `Include` path resolves against for this walk.
 *
 * ssh_config(5): a file named without a leading `/` is assumed to be in
 * `~/.ssh` when included from a USER configuration file, and in `/etc/ssh` when
 * included from the SYSTEM one. Neither is the directory of the file doing the
 * including — that is the intuitive rule, and it is the wrong one.
 *
 * Which of the two applies is a property of the WALK, not of the file holding
 * the `Include`: a file the system config pulls in is still part of a system
 * read wherever it lives. So it is decided once, from the root this import was
 * pointed at, and carried on {@link AssemblyContext}. The file dialog will
 * happily hand us `/etc/ssh/ssh_config`, so this is a path users reach.
 */
function includeBaseFor(absoluteRoot: string): string {
  return absoluteRoot === SYSTEM_CONFIG_DIR || absoluteRoot.startsWith(`${SYSTEM_CONFIG_DIR}/`)
    ? SYSTEM_CONFIG_DIR
    : path.join(os.homedir(), ".ssh");
}

/**
 * Resolve one `Include` pattern to an absolute path (or a directory + glob),
 * against the walk's base (see {@link includeBaseFor}).
 */
function resolveIncludePath(pattern: string, base: string): string {
  const expanded = expandHome(pattern);
  if (expanded.startsWith("/") || path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.normalize(path.join(base, expanded));
}

function hasGlobChars(value: string): boolean {
  return /[*?[]/.test(value);
}

/**
 * glob(3) basename matcher: `*`, `?` and `[...]` (with `!`/`^` negation).
 *
 * No `**` — glob(3) has no such operator and neither does OpenSSH's include
 * matching; `**` here is just two adjacent `*`. What actually keeps an include
 * inside one directory is the CALLER: {@link expandIncludePattern} globs the
 * basename alone, against the direct children {@link SshConfigIo.readDir}
 * reports, and never descends. The `[^/]` in the two wildcard branches is belt
 * and braces for an `io` that broke that contract and returned a path — under
 * the contract it cannot be told apart from `.`, so no test can pin it.
 *
 * TOTAL BY CONTRACT: returns `undefined` for a pattern that cannot be compiled
 * rather than letting `new RegExp` throw. A bracket expression is copied into
 * the regex source largely as written, and JavaScript rejects some classes
 * glob(3) merely finds unsatisfiable — `[z-a]` is `SyntaxError: Range out of
 * order in character class`. That throw used to escape {@link expandIncludePattern},
 * {@link assembleDocument} and {@link resolveSshConfig} in turn, rejecting the
 * whole import over one `Include config.d/[z-a]` line that ssh(1) itself accepts
 * and simply matches nothing with. Callers treat `undefined` as "matches
 * nothing" and record an issue, which is both what OpenSSH does and what this
 * module does with every other bad input.
 */
function globToRegExp(pattern: string): RegExp | undefined {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "[") {
      // glob(3) scans the set in this order, and the order is the whole of the
      // rule: an optional leading `!`/`^` negates, and a `]` in FIRST position
      // after it is an ordinary member, not the terminator. So the search for
      // the terminator starts past both.
      let cursor = i + 1;
      let negated = false;
      if (pattern[cursor] === "!" || pattern[cursor] === "^") {
        negated = true;
        cursor++;
      }
      const clsStart = cursor;
      if (pattern[cursor] === "]") {
        cursor++;
      }
      const close = pattern.indexOf("]", cursor);
      if (close === -1) {
        // Unterminated — which is what `[!]` and `[]` are once the first `]` is
        // read as a member. glob(3) then treats the `[` as an ordinary
        // character, so the pattern matches itself literally. Taking the `!` as
        // a negation of an empty set instead compiles `[^]`, which in JavaScript
        // matches ANY character: `Include config.d/[!]` would quietly pull in
        // every one-character file in the directory.
        source += "\\[";
        continue;
      }
      const cls = pattern.slice(clsStart, close);
      // The class is copied into the regex source as written, so the two
      // characters that would end or escape it there have to be escaped here.
      source += `[${negated ? "^" : ""}${cls.replace(/[\\\]]/g, "\\$&")}]`;
      i = close;
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`${source}$`);
  } catch {
    // Only a bracket expression can get us here: every other branch above
    // either emits a fixed fragment or escapes the character it copies.
    return undefined;
  }
}

/** Everything the include assembler threads through the recursion. */
interface AssemblyContext {
  io: SshConfigIo;
  result: SshConfigParseResult;
  /**
   * THE assembled document, appended to in place by every level of the
   * recursion. One array, never merged from children — see
   * {@link assembleDocument} for why returning per-file arrays was a rejection
   * waiting to happen.
   */
  out: AssembledLine[];
  /**
   * Directory a relative `Include` resolves against for this walk, fixed once
   * from the root path ({@link includeBaseFor}).
   */
  includeBase: string;
  /**
   * Absolute paths on the ACTIVE recursion stack — the cycle guard. A path is
   * added when the assembler enters that file and removed when it leaves, so a
   * file can only collide with itself while it is still open further up the
   * chain. That is what a cycle is.
   *
   * It is deliberately NOT a whole-walk "already seen" set. Under the splice an
   * include contributes its directives to whatever block is open at the
   * `Include` line, so
   *
   *     Host a
   *       Include common
   *     Host b
   *       Include common
   *
   * must expand `common` TWICE — OpenSSH applies it to both hosts. A global set
   * would skip the second expansion as a "cycle" and import `b` with different
   * credentials than ssh(1) uses, silently.
   */
  stack: Set<string>;
  /**
   * True while the assembler sits between a `Match` line and the next `Host` or
   * `Match` — including when that `Match` arrived from a file spliced earlier.
   *
   * Block state has to live on the CONTEXT, not per file, because the splice is
   * textual: an included file that opens a `Match` and never closes it leaves
   * the parent's following lines inside that `Match`, exactly as if the lines
   * had been typed there. An `Include` reached in that state is one OpenSSH
   * applies conditionally, so it must not be followed. Discovering includes by
   * re-parsing each file standalone (what this replaced) cannot see state that
   * leaked across a splice boundary and would follow it.
   */
  inMatchBlock: boolean;
}

function addIssue(ctx: AssemblyContext, file: string, line: number, text: string, reason: string): void {
  ctx.result.issues.push({ file, line, text, reason });
}

/**
 * Expand one include pattern to the concrete files it names, newest-first order
 * being irrelevant — glob(3) returns sorted matches and so do we, because with
 * first-value-wins the ORDER of two matching files decides which one's settings
 * survive, and that must not depend on the filesystem's readdir order.
 */
async function expandIncludePattern(
  ctx: AssemblyContext,
  includingFile: string,
  line: number,
  pattern: string
): Promise<string[]> {
  const resolved = resolveIncludePath(pattern, ctx.includeBase);
  const slash = Math.max(resolved.lastIndexOf("/"), resolved.lastIndexOf(path.sep));
  const dir = slash >= 0 ? resolved.slice(0, slash) || path.sep : ".";
  const base = slash >= 0 ? resolved.slice(slash + 1) : resolved;

  if (!hasGlobChars(base)) {
    if (hasGlobChars(dir)) {
      // Deliberate limit: only the basename is globbed. A wildcard in a
      // directory component is reported rather than silently matching nothing.
      addIssue(ctx, includingFile, line, pattern, `Include path "${pattern}" globs a directory component, which is not expanded`);
      ctx.result.includeMissingCount++;
      return [];
    }
    return [resolved];
  }

  if (hasGlobChars(dir)) {
    addIssue(ctx, includingFile, line, pattern, `Include path "${pattern}" globs a directory component, which is not expanded`);
    ctx.result.includeMissingCount++;
    return [];
  }

  const re = globToRegExp(base);
  if (re === undefined) {
    // ssh(1) accepts a config holding an uncompilable class and the include
    // simply matches nothing, so this is the same outcome as a glob with no
    // matches — issue, count, carry on — and never a rejected import.
    addIssue(ctx, includingFile, line, pattern, `Include pattern "${pattern}" is not a valid glob and matched no files`);
    ctx.result.includeMissingCount++;
    return [];
  }

  const names = await ctx.io.readDir(dir);
  // glob(3): a leading `.` is never matched by a wildcard — only by a pattern
  // that spells the dot out. Without this, `Include config.d/*` would suck in
  // editor backups and `.git` droppings.
  const allowDotfiles = base.startsWith(".");
  const matches = names
    .filter((name) => (allowDotfiles || !name.startsWith(".")) && re.test(name))
    .sort()
    .map((name) => path.join(dir, name));

  if (matches.length === 0) {
    addIssue(ctx, includingFile, line, pattern, `Include pattern "${pattern}" matched no files`);
    ctx.result.includeMissingCount++;
  }

  return matches;
}

/** One line of the assembled document, tagged with where it really came from. */
interface AssembledLine {
  text: string;
  /** Absolute path of the file this line was read from. */
  file: string;
  /** 1-based line number WITHIN that file. */
  line: number;
}

/**
 * Read `filePath` and APPEND its lines to {@link AssemblyContext.out}, with
 * every `Include` line REPLACED by the lines of the file(s) it names,
 * recursively.
 *
 * Children append to that one shared array rather than returning their own,
 * and that is a CONTRACT requirement, not a micro-optimisation. Splicing a
 * child's lines in with `assembled.push(...child)` spreads them as call
 * arguments, and V8 rejects a spread of that size — measured on Node 22:
 * 100,000 elements fine, 150,000 `RangeError: Maximum call stack size
 * exceeded`. An included file of 150,000 lines is about 150 KB, far inside the
 * 2 MiB the import commands cap a config at, so an ordinary (if large)
 * generated `config.d` file made {@link resolveSshConfig} REJECT — and its
 * caller, having been promised it never does, has no catch and imports zero
 * hosts. Only included files could hit it: the root's own lines are pushed one
 * at a time, which is why the contract test never caught this.
 *
 * This is the whole point of the module's second layer, and the reason it is a
 * splice rather than a per-file parse. `Include` in OpenSSH is textual: the
 * included file's lines are read in place, inside the block that was open at
 * the `Include` line. So
 *
 *     Host foo
 *       Include foo.conf          # foo.conf holds only: HostName example.test
 *
 * gives `foo` that `HostName` — `ssh -G foo` prints `hostname example.test`.
 * Parsing each included file as a standalone document (what this replaced)
 * discards every directive ahead of its first `Host` line, which for the config
 * above is all of them, and `foo` imports with its alias as its host.
 *
 * Include DISCOVERY therefore happens here, line by line, rather than by
 * re-parsing each file on its own: this loop tracks `Host`/`Match` transitions
 * in {@link AssemblyContext.inMatchBlock} as it emits, so it knows the block
 * state OpenSSH would be in at every `Include` line — including a `Match` that
 * an earlier splice left open. An `Include` reached inside a `Match` is copied
 * through verbatim instead of being expanded; the single parse of the assembled
 * document then skips it along with the rest of the conditional block, because
 * it re-derives the same state from the same lines. Following it would import
 * hosts gated behind a condition nobody evaluated.
 *
 * A `Match` opened by an included file is allowed to LEAK back into the parent
 * rather than being force-closed at end-of-include. That is textual-splice
 * fidelity: readconf.c has one `Match` state machine over one stream of lines
 * and no notion of a file boundary closing a block.
 *
 * Entries, issues and counters all come from the single parse of the assembled
 * document, so nothing here is counted twice.
 */
async function assembleDocument(ctx: AssemblyContext, filePath: string, depth: number): Promise<void> {
  const text = await ctx.io.readFile(filePath);
  if (text === undefined) {
    ctx.result.issues.push({ file: filePath, line: 0, text: "", reason: `could not read "${filePath}"` });
    ctx.result.includeMissingCount++;
    return;
  }

  const lines = splitConfigLines(text);

  ctx.stack.add(filePath);
  try {
    for (let i = 0; i < lines.length; i++) {
      const lineNumber = i + 1;
      const parsed = readConfigLine(lines[i]);

      if (parsed.kind === "directive") {
        if (parsed.keyword === "host") {
          // A `Host` line ends a `Match` block even when it names no pattern —
          // parseSshConfig clears the flag before validating the arguments, and
          // the two must stay in step.
          ctx.inMatchBlock = false;
        } else if (parsed.keyword === "match") {
          ctx.inMatchBlock = true;
        }
      }

      // Everything that is not a followable `Include` is copied through, and
      // the single parse of the assembled document has the last word on it:
      // a malformed line, an `Include` with no path and an `Include` inside a
      // `Match` all get their issue (or their silence) from there, once.
      const followable =
        parsed.kind === "directive" && parsed.keyword === "include" && !ctx.inMatchBlock && parsed.args.length > 0;
      if (!followable) {
        ctx.out.push({ text: lines[i], file: filePath, line: lineNumber });
        continue;
      }

      // The `Include` line itself is consumed: what takes its place is the
      // included text, at exactly this position. Position decides which value
      // wins, so nothing may be appended or hoisted.
      //
      // Which is also why the grammar signal has to be raised HERE and not left
      // to the single parse of the assembled document: this line is about to
      // stop existing, and if its includes resolve to nothing the document can
      // end up empty. An include-only root is still unmistakably an ssh config.
      ctx.result.sawSshGrammar = true;
      for (const pattern of parsed.args) {
        if (depth + 1 > MAX_INCLUDE_DEPTH) {
          // OpenSSH fatals here ("Too many recursive configuration includes").
          // An importer stops descending and keeps what it already has.
          addIssue(
            ctx,
            filePath,
            lineNumber,
            pattern,
            `Include "${pattern}" skipped: nesting deeper than ${MAX_INCLUDE_DEPTH} levels`
          );
          ctx.result.includeDepthExceededCount++;
          continue;
        }

        const targets = await expandIncludePattern(ctx, filePath, lineNumber, pattern);
        for (const target of targets) {
          if (ctx.stack.has(target)) {
            // OpenSSH has no cycle guard — it relies on the depth cap and blows
            // up on a self-include. Refusing a file that is already open
            // further up the chain stops the loop far earlier. Only that case
            // is refused: a file included twice along DIFFERENT branches is not
            // a cycle, and under the splice its second expansion carries real
            // directives into a different open block (see
            // {@link AssemblyContext.stack}).
            addIssue(ctx, filePath, lineNumber, pattern, `Include "${target}" skipped: already open (cycle)`);
            ctx.result.includeCycleCount++;
            continue;
          }
          await assembleDocument(ctx, target, depth + 1);
        }
      }
    }
  } finally {
    ctx.stack.delete(filePath);
  }
}

/**
 * Read `rootPath` and everything it includes, through `io`.
 *
 * Never throws and never rejects for bad input: an unreadable root, a missing
 * include, a glob that matches nothing and a cycle all land as issues plus a
 * counter, and whatever parsed successfully still comes back.
 */
export async function resolveSshConfig(rootPath: string, io: SshConfigIo): Promise<SshConfigParseResult> {
  const result = emptyResult();
  const absoluteRoot = path.resolve(expandHome(rootPath));
  // The stack starts empty: assembleDocument pushes each file as it enters it,
  // root included, so `Include config` inside ~/.ssh/config is still a cycle.
  const ctx: AssemblyContext = {
    io,
    result,
    out: [],
    includeBase: includeBaseFor(absoluteRoot),
    stack: new Set(),
    inMatchBlock: false
  };

  await assembleDocument(ctx, absoluteRoot, 0);
  const assembled = ctx.out;
  const parsed = parseSshConfig(assembled.map((line) => line.text).join("\n"));

  // Every line number that parse produced indexes the ASSEMBLED document, which
  // exists nowhere on disk. Translate each one back before it reaches a caller:
  // an issue at line 41 of a file the user can open is actionable, an issue at
  // line 41 of a document only this function ever saw is not.
  const originOf = (line: number): AssembledLine | undefined => assembled[line - 1];

  for (const entry of parsed.entries) {
    const origin = originOf(entry.line);
    result.entries.push(
      origin === undefined ? { ...entry, source: absoluteRoot } : { ...entry, line: origin.line, source: origin.file }
    );
  }
  for (const issue of parsed.issues) {
    const origin = originOf(issue.line);
    result.issues.push(
      origin === undefined ? { ...issue, file: absoluteRoot } : { ...issue, line: origin.line, file: origin.file }
    );
  }

  // ORed, not assigned: the assembler already raised this for every `Include`
  // line the splice consumed, and those lines are not in the parsed document.
  result.sawSshGrammar = result.sawSshGrammar || parsed.sawSshGrammar;
  result.wildcardPatternCount += parsed.wildcardPatternCount;
  result.negatedPatternCount += parsed.negatedPatternCount;
  result.matchBlockCount += parsed.matchBlockCount;
  result.duplicateAliasCount += parsed.duplicateAliasCount;
  // `includes` stays empty by contract: this layer's job is that no unfollowed
  // include is left to report. The only `Include` lines that survive the splice
  // sit inside a `Match` block, and the pure parser does not report those
  // either.

  return result;
}
