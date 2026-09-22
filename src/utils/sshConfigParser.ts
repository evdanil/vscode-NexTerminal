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
 *  2. {@link resolveSshConfig} walks those includes, and every byte it reads
 *     goes through an injected {@link SshConfigIo}. Tests therefore need no
 *     module mocking — they hand in a Map-backed io object.
 *
 * This is an IMPORTER, not `ssh(1)`. Where real OpenSSH would `fatal()` (a
 * missing include, a bad port, a too-deep include chain) we record an issue,
 * bump a counter and carry on: a user importing 200 hosts should not lose all
 * of them to one typo on line 3.
 *
 * Semantics deliberately mirrored from OpenSSH's `readconf.c`:
 *
 *  - Keywords are case-insensitive.
 *  - FIRST value wins per keyword within a block ("first obtained value ...
 *    will be used" — ssh_config(5)). This is the opposite of most config
 *    formats and the single easiest thing to get backwards.
 *  - `Host a b c` fans out: each non-wildcard, non-negated pattern becomes its
 *    own entry sharing the block's settings.
 *  - Wildcard patterns (`*`, `?`) are defaults blocks, not hosts — skipped and
 *    counted. Negated patterns (`!foo`) are skipped.
 *  - `Match` blocks are skipped wholesale: their conditions (`exec`, `host`,
 *    `originalhost`, ...) cannot be evaluated statically at import time.
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
  /** Later blocks dropped because an earlier block already claimed the alias. */
  duplicateAliasCount: number;
  /** Includes skipped because the file (or every glob match) could not be read. */
  includeMissingCount: number;
  /** Includes refused for exceeding {@link MAX_INCLUDE_DEPTH}. */
  includeDepthExceededCount: number;
  /** Includes skipped because that absolute path had already been parsed. */
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
 * path with spaces survives (`IdentityFile "~/my keys/id_ed25519"`), and
 * dropping an unquoted `#` comment and everything after it.
 *
 * OpenSSH's `strdelim()` only treats a `#` that OPENS a token as a comment, so
 * that is the rule here too: `Host web#1` keeps its `#`, `Host web # prod`
 * does not.
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
 * Drop every alias already claimed by an earlier entry (OpenSSH first-match-wins
 * applied to whole blocks) and report how many were dropped.
 *
 * Runs once per file inside {@link parseSshConfig} and again over the spliced
 * stream in {@link resolveSshConfig}. That is safe: "keep the first occurrence"
 * per file followed by "keep the first occurrence" across files removes exactly
 * the set one global pass would, and the two counts sum to the same total.
 */
function dedupeByAlias(entries: SshConfigEntry[]): { entries: SshConfigEntry[]; duplicateAliasCount: number } {
  const kept: SshConfigEntry[] = [];
  const seen = new Set<string>();
  let duplicateAliasCount = 0;

  for (const entry of entries) {
    if (seen.has(entry.alias)) {
      duplicateAliasCount++;
      continue;
    }
    seen.add(entry.alias);
    kept.push(entry);
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
 * Parse one OpenSSH client config. PURE — no I/O, no `vscode`, no `fs`.
 *
 * `Include` directives are returned untouched in {@link SshConfigParseResult.includes};
 * call {@link resolveSshConfig} if you want them followed.
 */
export function parseSshConfig(text: string): SshConfigParseResult {
  const result = emptyResult();
  // BOM first, then CRLF — a BOM'd CRLF file is the normal shape of a config
  // copied off Windows, and both must survive to reach the keyword regex.
  const lines = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");

  const rawEntries: SshConfigEntry[] = [];
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
        alias,
        // No HostName means ssh connects to the alias itself — a real host, not a stub.
        host: hostName ?? alias,
        port,
        user: block.values.get("user"),
        proxyJump: block.values.get("proxyjump"),
        identityFile: block.values.get("identityfile"),
        line: block.line
      });
    }
    block = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    // `Keyword value`, `Keyword=value` and `Keyword = value` are all legal.
    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*)[ \t]*=?[ \t]*(.*)$/);
    if (!match) {
      result.issues.push({ line: lineNumber, text: trimmed, reason: "line does not start with a keyword" });
      continue;
    }

    const keyword = match[1].toLowerCase();
    const args = tokenizeArgs(match[2]);

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
      result.issues.push({ line: lineNumber, text: trimmed, reason: `${match[1]} has no value` });
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

  const deduped = dedupeByAlias(rawEntries);
  result.entries = deduped.entries;
  result.duplicateAliasCount = deduped.duplicateAliasCount;

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

interface WalkContext {
  io: SshConfigIo;
  result: SshConfigParseResult;
  /** Absolute paths already parsed — the cycle guard. */
  visited: Set<string>;
}

function addIssue(ctx: WalkContext, file: string, line: number, text: string, reason: string): void {
  ctx.result.issues.push({ file, line, text, reason });
}

/**
 * Expand one include pattern to the concrete files it names, newest-first order
 * being irrelevant — glob(3) returns sorted matches and so do we, because with
 * first-value-wins the ORDER of two matching files decides which one's settings
 * survive, and that must not depend on the filesystem's readdir order.
 */
async function expandIncludePattern(
  ctx: WalkContext,
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

/**
 * Parse `filePath` and splice each of its includes in at the line it appeared
 * on. Returns entries in final source order, still undeduped — the caller
 * applies first-match-wins over the whole stream.
 */
async function walkFile(ctx: WalkContext, filePath: string, depth: number): Promise<SshConfigEntry[]> {
  const text = await ctx.io.readFile(filePath);
  if (text === undefined) {
    ctx.result.issues.push({ file: filePath, line: 0, text: "", reason: `could not read "${filePath}"` });
    ctx.result.includeMissingCount++;
    return [];
  }

  const parsed = parseSshConfig(text);
  for (const issue of parsed.issues) {
    ctx.result.issues.push({ ...issue, file: filePath });
  }
  ctx.result.wildcardPatternCount += parsed.wildcardPatternCount;
  ctx.result.negatedPatternCount += parsed.negatedPatternCount;
  ctx.result.matchBlockCount += parsed.matchBlockCount;
  // Duplicates this file resolved against itself; cross-file ones are counted
  // by the final pass in resolveSshConfig.
  ctx.result.duplicateAliasCount += parsed.duplicateAliasCount;

  const ordered: SshConfigEntry[] = [];
  let cursor = 0;

  for (const include of parsed.includes) {
    while (cursor < parsed.entries.length && parsed.entries[cursor].line < include.line) {
      ordered.push({ ...parsed.entries[cursor], source: filePath });
      cursor++;
    }

    for (const pattern of include.patterns) {
      if (depth + 1 > MAX_INCLUDE_DEPTH) {
        // OpenSSH fatals here ("Too many recursive configuration includes").
        // An importer stops descending and keeps what it already has.
        addIssue(
          ctx,
          filePath,
          include.line,
          pattern,
          `Include "${pattern}" skipped: nesting deeper than ${MAX_INCLUDE_DEPTH} levels`
        );
        ctx.result.includeDepthExceededCount++;
        continue;
      }

      const targets = await expandIncludePattern(ctx, filePath, include.line, pattern);
      for (const target of targets) {
        if (ctx.visited.has(target)) {
          // OpenSSH has no cycle guard — it relies on the depth cap and blows
          // up on a self-include. Tracking absolute paths stops the loop far
          // earlier. It also catches a benign second include of the same file,
          // which costs nothing: first-match-wins means a re-parse could only
          // ever contribute aliases the first parse already claimed.
          addIssue(ctx, filePath, include.line, pattern, `Include "${target}" skipped: already included (cycle)`);
          ctx.result.includeCycleCount++;
          continue;
        }
        ctx.visited.add(target);
        ordered.push(...(await walkFile(ctx, target, depth + 1)));
      }
    }
  }

  while (cursor < parsed.entries.length) {
    ordered.push({ ...parsed.entries[cursor], source: filePath });
    cursor++;
  }

  return ordered;
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
  const ctx: WalkContext = { io, result, visited: new Set([absoluteRoot]) };

  const ordered = await walkFile(ctx, absoluteRoot, 0);

  const deduped = dedupeByAlias(ordered);
  result.entries = deduped.entries;
  result.duplicateAliasCount += deduped.duplicateAliasCount;

  return result;
}
