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
 *  - `Host a b c` fans out: each non-wildcard, non-negated pattern becomes its
 *    own entry sharing the block's settings.
 *  - Wildcard patterns (`*`, `?`) are defaults blocks, not hosts — skipped and
 *    counted. Negated patterns (`!foo`) are skipped.
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
 * through verbatim), `CanonicalizeHostname`, multiple accumulating
 * `IdentityFile` lines (first wins, like every other keyword here), and
 * per-host options beyond the five read below.
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
  /** `Host` patterns skipped for containing `*` or `?` (a defaults block). */
  wildcardPatternCount: number;
  /** `Host` patterns skipped for being negated (`!foo`). */
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
  /** Includes skipped because the file (or every glob match) could not be read. */
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
 * Split an argument list on whitespace, honouring double quotes so a quoted
 * path with spaces survives (`IdentityFile "~/my keys/id_ed25519"`), honouring
 * backslash escapes, and dropping an unquoted `#` comment and everything after
 * it.
 *
 * A `#` that OPENS a token is a comment; one inside a token is not. That is
 * OpenSSH's rule (the comment check happens only while it is skipping the
 * whitespace before a token), so `Host web#1` keeps its `#` and `Host web # prod`
 * does not.
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
 *  - `\"` never opens or closes a quoted run; it is a literal `"`.
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
  let quoted = false;
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
        next === "\\" || next === '"' || next === "'" || (!quoted && (next === " " || next === "\t"));
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
    if (ch === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && (ch === " " || ch === "\t")) {
      flush();
      continue;
    }
    if (!quoted && ch === "#" && !started) {
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

function normalizePort(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const port = Number.parseInt(raw, 10);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * One entry plus the bit {@link mergeByAlias} needs and callers must not see:
 * whether the block actually spelled out a `HostName`.
 *
 * {@link SshConfigEntry.host} cannot answer that on its own, because a block
 * without a `HostName` carries the alias there as a FALLBACK. A fallback must
 * lose to a later block's real `HostName`; a value must not.
 */
interface RawEntry {
  entry: SshConfigEntry;
  hostExplicit: boolean;
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
  if (first.entry.port === undefined && later.entry.port !== undefined) {
    first.entry.port = later.entry.port;
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
        hostExplicit: hostName !== undefined
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

    if (keyword === "host") {
      closeBlock();
      inMatchBlock = false;
      if (args.length === 0) {
        result.issues.push({ line: lineNumber, text: trimmed, reason: "Host directive has no patterns" });
        continue;
      }
      const aliases: string[] = [];
      for (const pattern of args) {
        if (pattern.startsWith("!")) {
          // A negation subtracts from a pattern set; on its own it names no host.
          result.negatedPatternCount++;
          continue;
        }
        if (isWildcardPattern(pattern)) {
          // `Host *` and friends are defaults blocks applied to other hosts.
          result.wildcardPatternCount++;
          continue;
        }
        aliases.push(pattern);
      }
      if (aliases.length > 0) {
        block = { aliases, line: lineNumber, values: new Map(), valueLines: new Map(), seen: new Set() };
      }
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
    if (args.length === 0) {
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

/**
 * Resolve one `Include` pattern to an absolute path (or a directory + glob).
 *
 * OpenSSH's rule, and it is NOT the intuitive one: a pattern without a leading
 * `/` resolves against `~/.ssh/`, never against the directory of the file doing
 * the including. So `Include config.d/*` inside `/etc/ssh/ssh_config` still
 * looks in `~/.ssh/config.d/` for a user config read.
 */
function resolveIncludePath(pattern: string): string {
  const expanded = expandHome(pattern);
  if (expanded.startsWith("/") || path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.normalize(path.join(os.homedir(), ".ssh", expanded));
}

function hasGlobChars(value: string): boolean {
  return /[*?[]/.test(value);
}

/**
 * glob(3) basename matcher: `*`, `?` and `[...]` (with `!`/`^` negation).
 *
 * No `**` — glob(3) has no such operator and neither does OpenSSH's include
 * matching; `**` here is just two adjacent `*`, which cannot cross `/` because
 * this only ever runs against a single basename.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        source += "\\[";
        continue;
      }
      let cls = pattern.slice(i + 1, close);
      let negated = false;
      if (cls.startsWith("!") || cls.startsWith("^")) {
        negated = true;
        cls = cls.slice(1);
      }
      source += `[${negated ? "^" : ""}${cls.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

/** Everything the include assembler threads through the recursion. */
interface AssemblyContext {
  io: SshConfigIo;
  result: SshConfigParseResult;
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
  const resolved = resolveIncludePath(pattern);
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

  const names = await ctx.io.readDir(dir);
  const re = globToRegExp(base);
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
 * Read `filePath` and return its lines with every `Include` line REPLACED by
 * the lines of the file(s) it names, recursively.
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
async function assembleDocument(ctx: AssemblyContext, filePath: string, depth: number): Promise<AssembledLine[]> {
  const text = await ctx.io.readFile(filePath);
  if (text === undefined) {
    ctx.result.issues.push({ file: filePath, line: 0, text: "", reason: `could not read "${filePath}"` });
    ctx.result.includeMissingCount++;
    return [];
  }

  const lines = splitConfigLines(text);
  const assembled: AssembledLine[] = [];

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
        assembled.push({ text: lines[i], file: filePath, line: lineNumber });
        continue;
      }

      // The `Include` line itself is consumed: what takes its place is the
      // included text, at exactly this position. Position decides which value
      // wins, so nothing may be appended or hoisted.
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
          assembled.push(...(await assembleDocument(ctx, target, depth + 1)));
        }
      }
    }
  } finally {
    ctx.stack.delete(filePath);
  }

  return assembled;
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
  const ctx: AssemblyContext = { io, result, stack: new Set(), inMatchBlock: false };

  const assembled = await assembleDocument(ctx, absoluteRoot, 0);
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
