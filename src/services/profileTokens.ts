/**
 * Pure scan/substitute/validate helpers for PROFILE tokens — `${profile.host}`,
 * `${profile.ipmiHost}`, … — resolved against the server profile a macro is run
 * against. No `vscode` import, directly unit-testable, and deliberately built to
 * the same rules as `macroVariables.ts` (which this runs BEFORE): a pre-pass
 * that fills profile facts in, followed by the existing prompt walk for
 * anything the user still has to type.
 *
 * WHY THE DOT NAMESPACE. A declared macro variable's name is
 * `/^[A-Za-z_][A-Za-z0-9_]{0,31}$/` — no dots — and the placeholder regex in
 * macroVariables.ts only matches that same character class. So `${profile.host}`
 * cannot collide with any macro variable, is passed through verbatim by every
 * build that predates this file, and needs no precedence rule against a
 * user-declared `host`: the two are different tokens and both keep working in
 * the same macro (`$host` still prompts, `${profile.host}` still resolves).
 *
 * WHY A WHITELIST, not "any field of ServerConfig". Auto-mapping every field
 * would put `keyPath`, `authProfileId`, internal ids and inventory-sync
 * bookkeeping into command lines. The list below is the curated set; adding to
 * it later is one line plus a charset decision.
 */
import { serializeForInlineScript } from "../ui/shared/inlineScriptData";
import type { ServerConfig } from "../models/config";

export const PROFILE_TOKEN_WHITELIST = ["host", "port", "username", "name", "ipmiHost"] as const;

export type ProfileTokenName = (typeof PROFILE_TOKEN_WHITELIST)[number];

/** Display names used in error text — what the user sees on the server form. */
const PROFILE_TOKEN_FIELD_LABELS: Record<ProfileTokenName, string> = {
  host: "Host",
  port: "Port",
  username: "Username",
  name: "Name",
  ipmiHost: "IPMI / BMC Host"
};

/**
 * WHERE the field lives on the server form, so a "not set" refusal can send the
 * user to the right place. `ipmiHost` is `advanced: true`
 * (ui/formDefinitions.ts), so the form opens with it COLLAPSED — an error that
 * says only "Edit Server" lands on a form where the field is not visible.
 */
const PROFILE_TOKEN_FIELD_LOCATION: Record<ProfileTokenName, string> = {
  host: "in the server form",
  port: "in the server form",
  username: "in the server form",
  name: "in the server form",
  ipmiHost: "under Advanced options in the server form"
};

/**
 * What IS allowed, per token — the half of a charset refusal that lets the user
 * fix it. Naming only what is forbidden leaves them guessing which of the
 * characters they typed was the problem.
 */
const ADDRESS_GUIDANCE =
  'Use the address only — letters, digits, ".", "-", "_" and ":" — without a scheme like https:// or a path. ' +
  'Square brackets are accepted only as a whole bracketed IPv6 literal, e.g. [fe80::1] or [fe80::1]:623.';

const PROFILE_TOKEN_CHARSET_GUIDANCE: Record<ProfileTokenName, string> = {
  host: ADDRESS_GUIDANCE,
  ipmiHost: ADDRESS_GUIDANCE,
  port: "Use the port number only — digits, nothing else.",
  username: 'Use letters, digits, ".", "_", "-" and "@" only.',
  name:
    'Remove $, `, %, "!", "~", "*", "?", quotes, ";", "|", "&", "<", ">", "\\", parentheses, square brackets and ' +
    'braces from the name — spaces, "/", ".", "^" and accents are fine.'
};

/** The server-form label for a token, so pickers and errors name the same field. */
export function profileTokenLabel(token: ProfileTokenName): string {
  return PROFILE_TOKEN_FIELD_LABELS[token];
}

/**
 * `\$(\$?)\{profile\.(name)\}` — group 1 is the optional escape `$`, group 2 the
 * token name. Braced form only: a bare `$profile.host` is already meaningful to
 * the existing engine (it parses as the variable `profile` followed by the
 * literal `.host`), and quietly re-interpreting it here would change what an
 * existing macro sends.
 */
export const PROFILE_TOKEN_SOURCE = String.raw`\$(\$?)\{profile\.([A-Za-z][A-Za-z0-9_]*)\}`;

function profileTokenRegex(): RegExp {
  // Fresh instance per call — never share a single RegExp's `lastIndex` across calls.
  return new RegExp(PROFILE_TOKEN_SOURCE, "g");
}

export type ProfileTokenErrorKind = "missing" | "invalid";

export interface ProfileTokenError {
  kind: ProfileTokenErrorKind;
  /** The whitelisted token that could not be resolved. */
  token: ProfileTokenName;
  /** `ServerConfig.name` of the profile the run was aimed at. */
  serverName: string;
  /** Ready-to-show sentence; never contains the macro text. */
  message: string;
}

export interface ProfileTokenResolution {
  text: string;
  /**
   * Token names that are NOT whitelisted and were therefore left verbatim, in
   * first-appearance order. A warning, never a failure: an unknown token is
   * indistinguishable from text the user meant literally, and refusing the run
   * would make a typo fatal.
   */
  unknownTokens: string[];
}

export type ProfileTokenOutcome =
  | ({ ok: true } & ProfileTokenResolution)
  | { ok: false; error: ProfileTokenError };

function isProfileTokenName(name: string): name is ProfileTokenName {
  return (PROFILE_TOKEN_WHITELIST as readonly string[]).includes(name);
}

/**
 * Address charset for the host-like tokens: letters, digits, `.`, `-`, `_` and
 * `:`. Deliberately narrower than "valid hostname" — the point is not to
 * validate DNS, it is that nothing which survives this can act as shell syntax.
 *
 * NOTE what is NOT in this set and never has been: `*`, `?` and `~`. The glob
 * and tilde expansions that `NAME_FORBIDDEN_CHARS` now refuses were already
 * unreachable here, because this is a positive charset rather than a blacklist.
 * `[` and `]` are the exception that had to be handled separately — see
 * `isAddressValue()`.
 */
const ADDRESS_CHARSET = /^[A-Za-z0-9._\-:]+$/;

/**
 * REVIEW FINDING (P1) — `[` and `]` USED TO BE PLAIN MEMBERS OF
 * `ADDRESS_CHARSET`, anywhere in the value. They are there for bracketed IPv6
 * (`[fe80::1]`), but "anywhere" also admits `[abc]`, which is a POSIX BRACKET
 * EXPRESSION: substituted unquoted into a `localTerminal` macro it undergoes
 * pathname expansion and, if a file named `a`, `b` or `c` exists in the
 * terminal's working directory, the shell replaces the argument with that
 * filename. At command position that selects what runs. A host arrives from
 * inventory sync and from backup import, so this is attacker-supplied input.
 *
 * The fix keeps IPv6 working by accepting brackets ONLY as the whole value's
 * shape — a bracketed IPv6 literal with an optional `:port` suffix — and
 * refusing any other value that contains a bracket at all (`a[b]c`, `[abc]`,
 * a stray `[`). The content inside the brackets is then STRUCTURALLY validated
 * as IPv6 (`isIpv6Literal`) rather than merely charset-checked: `[abc]` is
 * built entirely out of hex digits, so a charset of "hex digits, colons and
 * dots" would have admitted the exact value this finding is about.
 *
 * THE OPTIONAL `:port` SUFFIX IS ACCEPTED, and that is a deliberate call rather
 * than an oversight. `ServerConfig.port` is a separate numeric field, so the
 * SSH `host` never needs one — but `ipmiHost` shares this rule and reaches a
 * URL through the shipped `https://${profile.ipmiHost}/` browser macro, where a
 * BMC on a non-standard port is ordinary. The unbracketed equivalent
 * (`bmc.example.com:8443`) is accepted by `ADDRESS_CHARSET` today and stays
 * accepted, so refusing `[fe80::1]:8443` would be arbitrary. A port suffix is
 * digits — it adds no expansion surface.
 *
 * RESIDUAL, stated honestly: a strictly-validated bracketed IPv6 literal is
 * still, character for character, a bracket expression — `[::1]` would match a
 * file named `1` or `:` in the working directory. What that can do is bounded
 * to swapping in a ONE-CHARACTER filename drawn from hex digits, `:` and `.`,
 * as the value of an argument; it cannot introduce a metacharacter, a second
 * word, or a path (the expansion result is a name from the directory listing,
 * and this pattern can only ever match single-character names). Removing even
 * that would mean refusing bracketed IPv6 outright, which breaks the field's
 * documented purpose.
 */
const BRACKETED_ADDRESS = /^\[([^\[\]]+)\](?::([0-9]{1,5}))?$/;
const IPV4_DOTTED_QUAD = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const IPV6_HEXTET = /^[0-9A-Fa-f]{1,4}$/;

/**
 * Structural IPv6 check — groups of 1–4 hex digits, at most one `::`
 * compression, and an optional trailing dotted-quad (`::ffff:10.0.0.1`) which
 * occupies two groups. Uncompressed forms must have exactly 8 groups;
 * compressed forms fewer than 8, since `::` has to stand for at least one.
 *
 * Written out rather than expressed as one regex because the regex for this is
 * unreadable and this is a security boundary: the thing it exists to reject
 * (`[abc]`, all hex digits, a valid bracket expression and not an address) is
 * exactly the case a sloppy pattern lets through.
 */
function isIpv6Literal(value: string): boolean {
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const compressed = halves.length === 2;

  // A dotted-quad tail is only legal at the very END of the address.
  const countGroups = (side: string, isLast: boolean): number | null => {
    if (side === "") return 0;
    const groups = side.split(":");
    let count = 0;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const atEnd = isLast && i === groups.length - 1;
      if (group.includes(".")) {
        if (!atEnd || !IPV4_DOTTED_QUAD.test(group)) return null;
        count += 2;
        continue;
      }
      if (!IPV6_HEXTET.test(group)) return null;
      count += 1;
    }
    return count;
  };

  const left = countGroups(halves[0], !compressed);
  if (left === null) return false;
  if (!compressed) return left === 8;
  const right = countGroups(halves[1], true);
  if (right === null) return false;
  return left + right < 8;
}

/**
 * `host` / `ipmiHost`: the plain charset, plus bracketed IPv6 as a whole-value
 * exception. A value carrying a bracket ANYWHERE has to be that exception in
 * full — there is no "mostly a hostname with brackets in it" form to allow.
 */
function isAddressValue(value: string): boolean {
  if (value.includes("[") || value.includes("]")) {
    const match = BRACKETED_ADDRESS.exec(value);
    return match !== null && isIpv6Literal(match[1]);
  }
  return ADDRESS_CHARSET.test(value);
}
const DIGITS_ONLY = /^[0-9]+$/;
/**
 * Usernames: letters, digits, `.`, `_`, `-` and `@` — enough for every real
 * account name including the email-style `user@realm` form, and nothing a shell
 * reads as syntax. A username reaches a LOCAL command line through the shipped
 * ipmitool template (`-U ${profile.username}`) and arrives in the config from
 * inventory sync (`syncEngine.ts` writes `after.username` straight from the
 * endpoint) and from backup import, so it needs the same use-time check as the
 * address fields.
 */
const USERNAME_CHARSET = /^[A-Za-z0-9._@\-]+$/;
/**
 * `name` is a genuinely free-form label — "Rack 4 / Ünit 2" must keep working —
 * so it gets a blacklist rather than a charset: everything a shell would read as
 * syntax is refused, while spaces, accents, "/" and "." are not.
 *
 * REVIEW FINDING (P1) — PARENTHESES AND BRACES ARE REFUSED, which means
 * "Core Switch (DC1)" no longer resolves. The shell this list has to survive is
 * not only bash: a `localTerminal` macro's resolved text goes to a FRESH
 * `vscode.window.createTerminal()`, whose default shell on Windows is
 * PowerShell, and PowerShell evaluates a parenthesised subexpression even in
 * ARGUMENT position — `Write-Output (Start-Process calc)` starts calc before
 * Write-Output is ever handed an argument. A server name arrives from a backup
 * import and from inventory sync, so `(Start-Process calc)` is a value someone
 * else can put in the config, and it used no character this list refused.
 *
 * BRACES go with them, for the invocation one character away: `{ … }` is a
 * scriptblock literal, and the operators that RUN one are `&` (already refused)
 * and `.` — and `.` has to stay legal, every site-code-ish label has dots. So
 * `.{Start-Process calc}` executes wherever the token starts a statement, out of
 * characters this list used to permit. A display name needs neither form.
 *
 * REVIEW FINDING (P1) — SQUARE BRACKETS ARE NOW REFUSED, REVERSING the decision
 * this comment used to record. The earlier reasoning ran: "`[Type]::Member` puts
 * PowerShell into expression mode, but a type literal is not by itself an
 * invocation — reaching a method needs `(` or `{`, and both are gone; what is
 * left is at worst a glob pattern in a POSIX shell. Neither runs anything."
 *
 * The second half of that sentence is the mistake. It weighed a POSIX glob only
 * as a PATTERN and never asked what pathname expansion DOES with one, which is
 * to consult the working directory and REPLACE the word with the names it
 * matched. No method call, no PowerShell, no second character needed: `[abc]`
 * at command position in a `localTerminal` macro becomes the file `a`, `b` or
 * `c` if one exists in the terminal's cwd, and the shell then executes it.
 * "Neither runs anything" was true of the type literal and false of the glob,
 * and the glob is the one that reaches a default bash.
 *
 * SO `*`, `?`, `[` AND `]` ALL GO — the whole of POSIX glob syntax, held to the
 * same "one character causes expansion in a default shell" bar that took `%` and
 * `!`. `*` and `?` are worse than brackets in argument position, where one word
 * expands into as MANY operands as there are matching files: a name of `*`
 * pasted after a command turns `cmd ${profile.name}` into `cmd` applied to every
 * file in the directory.
 *
 * `~` GOES WITH THEM. Tilde expansion is not glob, but it is the same shape of
 * bug: one character, at word start, in a default shell, expanding into a path
 * that is not what the value says. A blacklist cannot condition on whether the
 * value happens to land at a word start in the macro's text, so it goes
 * unconditionally.
 *
 * `/`, `.`, SPACES AND ACCENTS STAY LEGAL. With glob syntax gone they are inert
 * text — `Rack 4 / Ünit 2` is a label, not a path, because nothing expands it.
 * A name that is a LITERAL path or command (`/bin/sh`, `reboot`) placed at
 * command position still runs, but that is the macro author choosing to put a
 * display name where a command goes; it is not this charset converting data into
 * syntax, and refusing `/` or `.` would break every site-code label without
 * closing anything. Out of scope here, as it is for `host` (`10.0.0.1` at
 * command position is likewise just a template mistake).
 *
 * REVIEW FINDING (P1) — `%` IS REFUSED, because the third default shell had not
 * been accounted for. `terminal.integrated.defaultProfile.windows` can be
 * Command Prompt (it is on plenty of machines, and it was the VS Code default
 * before PowerShell took over), and cmd.exe expands `%VAR%` while PARSING the
 * line, before anything is executed: a name of `%COMSPEC% /c calc` becomes
 * `C:\Windows\system32\cmd.exe /c calc` and runs, at command position, using no
 * character this list refused. Same reachability as the rest — a name arrives
 * from inventory sync and from backup import.
 *
 * THE STANDARD APPLIED to cmd.exe's other two active characters — "can this
 * character ALONE cause execution or expansion in a DEFAULT-configuration
 * shell?":
 *
 *   `!` IS REFUSED. Delayed expansion (`!VAR!`) is indeed off by default in
 *   cmd, so cmd is not the reason. Bash is: history expansion is ON by default
 *   in every INTERACTIVE bash, and an interactive shell is exactly what a macro
 *   send lands in. `!` starts an event designator (`!!`, `!string`, `!-2`), and
 *   what it splices in is a PREVIOUS COMMAND LINE — text that may itself carry
 *   `;` or `|`, so a name of `DC1!!` can execute the tail of whatever the user
 *   ran last. That is expansion into executable syntax from one character, so it
 *   goes, on the same reasoning that took the parentheses. (`!` followed by a
 *   space or by end-of-line is inert, but a blacklist cannot condition on what
 *   follows the value in the macro's text.)
 *
 *   `^` IS NOT REFUSED. It is cmd's ESCAPE character, and escaping only ever
 *   REMOVES a metacharacter's meaning — `^` cannot turn plain text into syntax,
 *   and `^^` is a literal caret. Its other role, line continuation at end of
 *   line, can only JOIN the macro's own next line onto this one, which turns a
 *   second command into arguments of the first rather than introducing anything
 *   new (and control characters, newlines included, are refused in the value
 *   itself). In bash and PowerShell `^` is an ordinary character. Nothing it can
 *   do meets the bar, and "Rack 4 ^ Spare" stays a legal label.
 */
const NAME_FORBIDDEN_CHARS = /["'$`;|&<>\\(){}%!*?\[\]~]/;
/**
 * Refused in EVERY token, no exceptions. `$` and a backtick are what turn a
 * substituted value into syntax rather than data — for the shell, and for this
 * extension's own second pass: `runMacroOnServer` hands the resolved text to
 * `resolveMacroText`, which re-scans it for `$name` placeholders, so a profile
 * value able to carry a `$` could splice a prompted secret's value into the
 * command. This invariant is what makes that re-scan safe (and what lets the
 * substitution loop below treat every value as opaque).
 */
const SHELL_EXPANSION_CHARS = /[$`]/;
/** C0 and C1 control characters, `\n` / `\r` included. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
/** Same class, global — used to render an offending value inside an error message. */
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * THE INJECTION DEFENSE, and the reason it lives at the substitution site
 * rather than at the server form.
 *
 * These values are not only user-typed: `host` arrives from inventory sync and
 * every field of a server record arrives from backup import, so "it was checked
 * when it was saved" is not true of the records that matter. The resolved text
 * then goes to a LOCAL shell (a `localTerminal` macro running `ipmitool`), where
 * a host of `1.2.3.4; rm -rf ~` is command execution on the user's own machine.
 * WHICH local shell is not ours to choose: a fresh `vscode.window.createTerminal()`
 * uses the configured default profile, which on Windows is PowerShell or
 * Command Prompt and on a session terminal is an interactive remote shell — so
 * "reads as syntax" means the UNION of what bash, PowerShell and cmd.exe read as
 * syntax, not what bash alone does (see `NAME_FORBIDDEN_CHARS`).
 *
 * The answer is a charset, not quoting: quoting rules differ per shell, and a
 * half-implemented quoter creates confidence it cannot back. So a value that
 * cannot be safely interpolated REFUSES THE RUN — it is never warned about and
 * substituted anyway, and never silently emptied (an empty `-H` argument is its
 * own failure mode).
 *
 * EVERY token is checked — there is no "it is only a label" exemption, because
 * every token ends up in the same command line. Control characters are refused
 * throughout (an embedded newline executes whatever follows it, no shell
 * metacharacter required), and so are `$` and a backtick (see
 * `SHELL_EXPANSION_CHARS`). On top of that each token gets the narrowest rule
 * its content allows: an address charset for `host`/`ipmiHost`, digits for
 * `port`, a real-username charset for `username`, and — because a display name
 * is genuinely free-form — a metacharacter blacklist for `name`.
 */
function validateTokenValue(token: ProfileTokenName, value: string): boolean {
  if (CONTROL_CHARS.test(value) || SHELL_EXPANSION_CHARS.test(value)) {
    return false;
  }
  switch (token) {
    case "host":
    case "ipmiHost":
      return isAddressValue(value);
    case "port":
      return DIGITS_ONLY.test(value);
    case "username":
      return USERNAME_CHARSET.test(value);
    case "name":
      return !NAME_FORBIDDEN_CHARS.test(value);
    default:
      // A token added to the whitelist without a rule of its own refuses rather
      // than passes: the charset decision is part of adding it, not optional.
      return false;
  }
}

/** The offending value, made safe and short enough to show inside a notification. */
function displayValue(value: string): string {
  // Control characters are why some values are refused; printing them raw would
  // reflow the notification (or hide the problem entirely), so they are shown as
  // a visible placeholder instead.
  const printable = value.replace(CONTROL_CHARS_GLOBAL, "·");
  return printable.length > 64 ? `${printable.slice(0, 64)}…` : printable;
}

/** The raw string a whitelisted token stands for, or `""` when the field carries nothing usable. */
function rawTokenValue(token: ProfileTokenName, server: Pick<ServerConfig, ProfileTokenName>): string {
  if (token === "port") {
    // Typed `number`, but a foreign record can carry anything; a non-number is
    // "not set" rather than `"undefined"` on a command line.
    return typeof server.port === "number" && Number.isFinite(server.port) ? String(server.port) : "";
  }
  const value = server[token] as unknown;
  return typeof value === "string" ? value.trim() : "";
}

function missingError(token: ProfileTokenName, serverName: string): ProfileTokenError {
  return {
    kind: "missing",
    token,
    serverName,
    message:
      `"${serverName}" has no ${PROFILE_TOKEN_FIELD_LABELS[token]} set, but this macro uses \${profile.${token}}. ` +
      `Add it ${PROFILE_TOKEN_FIELD_LOCATION[token]}. Nothing was sent.`
  };
}

function invalidError(token: ProfileTokenName, serverName: string, value: string): ProfileTokenError {
  return {
    kind: "invalid",
    token,
    serverName,
    message:
      `The ${PROFILE_TOKEN_FIELD_LABELS[token]} of "${serverName}" ("${displayValue(value)}") has characters that ` +
      `can't be placed in a command or URL. ${PROFILE_TOKEN_CHARSET_GUIDANCE[token]} Nothing was sent.`
  };
}

/**
 * One matched `${profile.…}` / `$${profile.…}` occurrence, as the shared walker
 * below hands it to a rewriter.
 */
interface ProfileTokenMatch {
  /** The whole matched token, the escape `$` included. */
  full: string;
  /** True for the `$${profile.x}` form — the documented "send the literal token" escape. */
  escaped: boolean;
  /** The dotted name as written, whitelisted or not. */
  name: string;
  /** The whitelisted token this names, or `undefined` when it names none. */
  token?: ProfileTokenName;
  /**
   * THE SINGLE DEFINITION OF WHAT UNESCAPING MEANS — `full` with one leading `$`
   * removed. Both rewriters below take it from here rather than each computing
   * their own `slice(1)`, so "what an escape turns into" cannot drift between
   * the server path (`resolveProfileTokens`) and every other send path
   * (`unescapeProfileTokens`).
   */
  unescaped: string;
}

/** A rewriter's refusal, carrying whatever the caller wants to report. */
interface ProfileTokenRefusal<E> {
  refuse: E;
}

type ProfileTokenRewrite<E> = { ok: true; text: string } | { ok: false; error: E };

/**
 * Walks every `${profile.…}` occurrence in `text` and rebuilds the string from
 * what `rewrite` returns for each one. The ONE place the scan lives, so every
 * caller inherits the same discipline:
 *
 *   - a FRESH regex per call — a shared `lastIndex` across calls is a bug
 *     factory;
 *   - output built by APPENDING TO AN ARRAY and joining, never
 *     `text.replace(re, value)` (JavaScript expands `$&`, `` $` ``, `$'`, `$1`
 *     and `$$` inside a string replacement, so a stored value could splice
 *     surrounding text into the result);
 *   - whatever a rewriter pushes is never rescanned.
 *
 * A rewriter returning `{ refuse }` ABORTS the walk — nothing after the
 * offending token is examined, which is what makes "refuse the whole run" a
 * single early return rather than a post-hoc check.
 */
function rewriteProfileTokens<E>(
  text: string,
  rewrite: (match: ProfileTokenMatch) => string | ProfileTokenRefusal<E>
): ProfileTokenRewrite<E> {
  const out: string[] = [];
  let lastIndex = 0;

  const re = profileTokenRegex();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const full = match[0];
    const name = match[2];
    const replacement = rewrite({
      full,
      escaped: match[1] === "$",
      name,
      token: isProfileTokenName(name) ? name : undefined,
      unescaped: full.slice(1)
    });

    out.push(text.slice(lastIndex, match.index));
    lastIndex = match.index + full.length;

    if (typeof replacement !== "string") {
      return { ok: false, error: replacement.refuse };
    }
    out.push(replacement);
  }
  out.push(text.slice(lastIndex));

  return { ok: true, text: out.join("") };
}

/**
 * Rewrites `$${profile.x}` → `${profile.x}` and touches nothing else — the
 * server-INDEPENDENT half of `resolveProfileTokens`, for every send path that
 * has no server to resolve against.
 *
 * WHY THIS EXISTS. `$${profile.host}` is documented to send the literal
 * `${profile.host}`, but that unescape used to live only inside
 * `resolveProfileTokens`, which only `runMacroOnServer` calls. A macro whose
 * text contains ONLY escaped tokens is (correctly) not redirected to that
 * command — `hasProfileTokens()` ignores escapes, because an escaped token
 * constrains nothing about which server the macro can run on — so it went out
 * through the ordinary session path with BOTH dollars intact. The macro variable
 * engine cannot fix that either: its placeholder grammar has no dots, so
 * `$${profile.host}` matches nothing there.
 *
 * AN UNESCAPED `${profile.x}` IS LEFT ALONE, and so is an escaped token that
 * names nothing whitelisted (`$${profile.keyPath}` stays as written). Both
 * rules are `resolveProfileTokens`'s, reached through the same walker: an
 * unknown token is verbatim whether escaped or not, so a name outside the
 * whitelist reads identically on every path.
 */
export function unescapeProfileTokens(text: string): string {
  const rewritten = rewriteProfileTokens<never>(text, (match) =>
    match.escaped && match.token !== undefined ? match.unescaped : match.full
  );
  // The rewriter above never refuses; the branch exists only to satisfy the
  // shared return type.
  return rewritten.ok ? rewritten.text : text;
}

/**
 * Substitutes `${profile.*}` tokens in `text` against `server`.
 *
 * The scan itself is `rewriteProfileTokens()` — shared with
 * `unescapeProfileTokens()` so the two cannot disagree about what an escape (or
 * an unknown token) means. It mirrors `substituteMacroVariables()` line for
 * line, and for the same security reason: the output is built by APPENDING TO
 * AN ARRAY and joining, never `text.replace(re, value)`. In string-replacement
 * mode JavaScript interprets `$&`, `` $` ``, `$'`, `$1` and `$$` inside the
 * REPLACEMENT — a stored value containing those would splice surrounding text
 * into the result. Array-append treats every profile value as opaque and never
 * rescans it.
 *
 * That opacity holds only for THIS pass. `runMacroOnServer` hands the resolved
 * text to `resolveMacroText`, which scans it again for `$name` placeholders, so
 * the array-append rule alone would not stop a profile value from introducing a
 * `$` that the SECOND pass expands (into a prompted secret's value, say). What
 * makes the pipeline safe end to end is the invariant enforced by
 * `validateTokenValue()`: no substituted value can ever contain `$` or a
 * backtick. Relaxing that charset means revisiting the second pass.
 *
 *   token not whitelisted → push the match verbatim (escaped or not) + warn
 *   escaped (`$${…}`)     → push the match minus one leading `$`
 *   field empty/absent    → refuse the whole run  (typed `missing` error)
 *   field fails charset   → refuse the whole run  (typed `invalid` error)
 *   otherwise             → push the field's value
 *
 * Refusals are checked only for tokens that actually appear UNESCAPED: a macro
 * documenting `$${profile.ipmiHost}` must not be unrunnable on a server that
 * has no IPMI host.
 */
export function resolveProfileTokens(
  text: string,
  server: Pick<ServerConfig, ProfileTokenName>
): ProfileTokenOutcome {
  const serverName = typeof server.name === "string" && server.name.trim() !== "" ? server.name : "this server";
  const unknownTokens: string[] = [];
  const seenUnknown = new Set<string>();

  const rewritten = rewriteProfileTokens<ProfileTokenError>(text, (match) => {
    if (match.token === undefined) {
      // Verbatim whether escaped or not — the same rule the variable engine
      // applies to an undeclared name, so an unknown token reads identically in
      // both passes (and in `unescapeProfileTokens`, which shares this walker).
      if (!seenUnknown.has(match.name)) {
        seenUnknown.add(match.name);
        unknownTokens.push(match.name);
      }
      return match.full;
    }

    if (match.escaped) {
      return match.unescaped;
    }

    const value = rawTokenValue(match.token, server);
    if (value === "") {
      return { refuse: missingError(match.token, serverName) };
    }
    if (!validateTokenValue(match.token, value)) {
      return { refuse: invalidError(match.token, serverName, value) };
    }
    return value;
  });

  return rewritten.ok
    ? { ok: true, text: rewritten.text, unknownTokens }
    : { ok: false, error: rewritten.error };
}

/**
 * The whitelisted tokens `text` uses UNESCAPED, in first-appearance order —
 * what a picker needs to say "this macro needs an IPMI host" before the user
 * commits to running it. Unknown tokens are not reported here (they resolve to
 * themselves and constrain nothing).
 */
export function profileTokensUsed(text: string): ProfileTokenName[] {
  const used: ProfileTokenName[] = [];
  const seen = new Set<string>();
  const re = profileTokenRegex();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[1] === "$") continue;
    const name = match[2];
    if (!isProfileTokenName(name) || seen.has(name)) continue;
    seen.add(name);
    used.push(name);
  }
  return used;
}

/**
 * The message shown when a macro tries to do both — shared by the macro
 * editor's live warning, its save-time check, and the host's re-validation, so
 * the three cannot drift. Auto-firing is the reason: a rule compiled from
 * terminal output has no server to resolve `${profile.…}` against, so it would
 * send the literal token text.
 */
export const PROFILE_TOKEN_TRIGGER_CONFLICT_MESSAGE =
  "Macros using ${profile...} tokens resolve against a chosen server, so they cannot auto-trigger. Remove the trigger pattern or the profile tokens.";

/** Does `text` reference any profile token at all (used to sort pickers)? */
export function hasProfileTokens(text: string): boolean {
  return profileTokensUsed(text).length > 0;
}

/**
 * Webview-JS twin of `profileTokensUsed()` plus the unknown-token list, built
 * on the `macroVariablesWebviewJs()` precedent (services/macroVariables.ts):
 * the regex and the whitelist are INTERPOLATED from the definitions above, so
 * the macro editor's live hints cannot drift from what a run actually does.
 * Returns `{ used, unknown }` — whitelisted tokens the text resolves, and
 * `${profile.…}` names that will be sent as-is (typically a typo).
 */
export function profileTokensWebviewJs(): string {
  // No leading newline — see macroVariablesWebviewJs() for why (the call site is
  // indented and a whitespace-only line fails `git diff --check` on the snapshot).
  return `var PROFILE_TOKEN_NAMES = ${JSON.stringify(PROFILE_TOKEN_WHITELIST)};
      function scanProfileTokens(text) {
        var re = new RegExp(${serializeForInlineScript(PROFILE_TOKEN_SOURCE)}, "g");
        var used = [];
        var unknown = [];
        var seenUsed = Object.create(null);
        var seenUnknown = Object.create(null);
        var match;
        while ((match = re.exec(text)) !== null) {
          if (match[1] === "$") continue;
          var name = match[2];
          if (PROFILE_TOKEN_NAMES.indexOf(name) !== -1) {
            if (!seenUsed[name]) { seenUsed[name] = true; used.push(name); }
          } else if (!seenUnknown[name]) {
            seenUnknown[name] = true;
            unknown.push(name);
          }
        }
        return { used: used, unknown: unknown };
      }
`;
}
