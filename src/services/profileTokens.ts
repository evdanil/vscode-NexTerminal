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
import { MACRO_PLACEHOLDER_SOURCE } from "./macroVariables";

export const PROFILE_TOKEN_WHITELIST = ["host", "port", "username", "name", "ipmiHost", "ipmiUsername"] as const;

export type ProfileTokenName = (typeof PROFILE_TOKEN_WHITELIST)[number];

/**
 * WHAT A TOKEN RESOLVES AGAINST — deliberately NOT `ServerConfig` itself.
 *
 * Two of the six tokens are not raw fields of the record: `username` is the one
 * a CONNECTION would use (the linked auth profile's, where it supplies one —
 * see `effectiveServerUsername`), and `ipmiUsername` lives on a different
 * record entirely (the profile named by `ServerConfig.ipmiAuthProfileId`). The
 * caller that has a `NexusCore` assembles both (`profileTokenServer` in
 * commands/serverMacroCommands.ts); this module stays pure and `vscode`-free
 * and only ever reads the facts it is handed.
 *
 * Every member is optional even where `ServerConfig`'s is required, so a
 * `ServerConfig` is assignable as-is — the shape only ever gets fields ADDED —
 * and an absent one lands in `rawTokenValue`'s "not set" arm, which is the
 * typed `missing` refusal rather than the string `"undefined"` on a command
 * line.
 */
export interface ProfileTokenFacts {
  host?: string;
  port?: number;
  username?: string;
  name?: string;
  ipmiHost?: string;
  /** The linked IPMI auth profile's username; see `ServerConfig.ipmiAuthProfileId`. */
  ipmiUsername?: string;
}

/** Display names used in error text — what the user sees on the server form. */
const PROFILE_TOKEN_FIELD_LABELS: Record<ProfileTokenName, string> = {
  host: "Host",
  port: "Port",
  username: "Username",
  name: "Name",
  ipmiHost: "IPMI / BMC Host",
  ipmiUsername: "IPMI Username"
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
  ipmiHost: "under Advanced options in the server form",
  // Names the FIELD to set, not the value: `ipmiUsername` is not a field of the
  // server at all — it is the linked profile's username — so "add it in the
  // server form" would send the user looking for a text box that does not exist.
  ipmiUsername:
    "by choosing an IPMI Auth Profile (one whose Username is filled in) under Advanced options in the server form"
};

/**
 * What IS allowed, per token — the half of a charset refusal that lets the user
 * fix it. Naming only what is forbidden leaves them guessing which of the
 * characters they typed was the problem.
 */
const ADDRESS_GUIDANCE =
  'Use the address only — letters, digits, ".", "-", "_" and ":" — without a scheme like https:// or a path. ' +
  'Square brackets are accepted only as a whole bracketed IPv6 literal, e.g. [fe80::1] or [fe80::1]:623.';

const USERNAME_GUIDANCE =
  'Use letters, digits, ".", "_" and "-", with at most one "@" between name and realm ' +
  "(e.g. admin, or user@REALM.EXAMPLE.COM). " +
  'A leading or trailing "@" is refused.';

const PROFILE_TOKEN_CHARSET_GUIDANCE: Record<ProfileTokenName, string> = {
  host: ADDRESS_GUIDANCE,
  ipmiHost: ADDRESS_GUIDANCE,
  port: "Use the port number only — digits, nothing else.",
  username: USERNAME_GUIDANCE,
  // Same rule, one record further away: the value comes from the linked IPMI
  // auth profile, so the repair is in that profile's own editor.
  ipmiUsername: `${USERNAME_GUIDANCE} Edit the linked IPMI auth profile to fix it.`,
  name:
    'Use letters, digits, spaces and ".", "-", "_", "/", ":", "," and "+" only — accents are fine. ' +
    "Every other punctuation mark is refused, because some shell reads it as syntax. " +
    "Rename the server, or write $${profile.name} to send the token text literally."
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

/**
 * WHAT THE RESOLVED TEXT IS, so a value can be written in the form that
 * destination requires.
 *
 *   `"command"` — a shell command line (a session send or a `localTerminal`
 *                 macro). The default, and byte-for-byte what every build before
 *                 this context existed produced.
 *   `"url"`     — the whole text is parsed as a URL (`runIn: "browser"`).
 *
 * The ONLY difference is IPv6 bracketing — see `substitutionValue()`. The
 * charset checks are identical in both forms: what a value is ALLOWED to be
 * does not depend on where it is going (an address that carries shell syntax is
 * refused for a URL too, since `${profile.host}` in a URL's path lands in a
 * command line the moment someone changes `runIn`).
 */
export type ProfileTokenForm = "command" | "url";

export interface ProfileTokenContext {
  /** Defaults to `"command"` — the pre-existing behaviour, unchanged. */
  form?: ProfileTokenForm;
}

function isProfileTokenName(name: string): name is ProfileTokenName {
  return (PROFILE_TOKEN_WHITELIST as readonly string[]).includes(name);
}

/**
 * Address charset for the host-like tokens: letters, digits, `.`, `-`, `_` and
 * `:`. Deliberately narrower than "valid hostname" — the point is not to
 * validate DNS, it is that nothing which survives this can act as shell syntax.
 *
 * NOTE what is NOT in this set and never has been: `*`, `?`, `~`, `%`, `!`, `#`
 * and `^`. Every hole this PR's review found in the old `name` BLACKLIST was
 * already unreachable here, because this is a positive charset — which is
 * precisely the argument that eventually flipped `name` to one too (see
 * `NAME_CHARSET`). `[` and `]` are the exception that had to be handled
 * separately — see `isAddressValue()`.
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
 *
 * EXPORTED so the inventory sync engine can ask the SAME question of an
 * out-of-band address before it writes one into `ipmiHost` (a value the
 * substitution chokepoint below would then refuse on every single run, with
 * nothing on screen connecting it to the NetBox device it came from). Use time
 * remains the enforcement point — this is a warn-and-skip, not a second source
 * of truth, which is exactly why the engine calls THIS function rather than
 * carrying a stricter rule of its own.
 */
export function isAddressValue(value: string): boolean {
  if (value.includes("[") || value.includes("]")) {
    const match = BRACKETED_ADDRESS.exec(value);
    return match !== null && isIpv6Literal(match[1]);
  }
  return ADDRESS_CHARSET.test(value);
}
const DIGITS_ONLY = /^[0-9]+$/;
/**
 * Usernames: letters, digits, `.`, `_` and `-`, plus at most one `@` BETWEEN two
 * nonempty components — `user`, `user@REALM`, `svc-acct@corp.example.com`. Enough
 * for every real account name including the email-style realm form, and nothing a
 * shell reads as syntax. A username reaches a LOCAL command line through the
 * shipped ipmitool template (`-U ${profile.username}`) and arrives in the config
 * from inventory sync (`syncEngine.ts` writes `after.username` straight from the
 * endpoint), from backup import, and from a LINKED AUTH PROFILE, so it needs the
 * same use-time check as the address fields.
 *
 * REVIEW FINDING (P2) — WHY `@` IS POSITIONAL AND NOT MERELY A MEMBER. This used
 * to be `/^[A-Za-z0-9._@\-]+$/`, i.e. `@` anywhere, and it was documented as the
 * "narrow, load-bearing exception" to `NAME_CHARSET` dropping `@` for PowerShell
 * SPLATTING (see the `@` paragraph there). The exception's argument was that a
 * username is a single word with no space, so it "cannot become `@name` as its
 * own argument" — but that reasoning silently assumed a position the rule never
 * enforced. A username of `@args` IS a whole word beginning with `@`: dropped
 * into `ipmitool -U ${profile.username}` under PowerShell it splats the session
 * variable `$args`, expanding data from outside the value into the command's
 * argument list. That is exactly the capability `@` was refused from `name` for,
 * reached through the field that kept it.
 *
 * So the rule now says what the exception always meant: one `@`, never leading,
 * never trailing, never repeated. `user@REALM` keeps working — splatting needs
 * the `@` at the START of a word, and this grammar guarantees at least one name
 * character before it. `a@b@c` goes too: no real account form needs it, and a
 * whitelist's default answer to an unargued shape is no.
 */
const USERNAME_CHARSET = /^[A-Za-z0-9._\-]+(?:@[A-Za-z0-9._\-]+)?$/;
/**
 * `name` IS A POSITIVE CHARSET — Unicode letters, marks and digits, a space, and
 * eight punctuation marks that survive bash, zsh, PowerShell and cmd.exe. It was
 * a BLACKLIST until the review finding recorded at the bottom of this comment,
 * and the flip is the finding's real conclusion; the blacklist's history is kept
 * below because it is the evidence for why.
 *
 * WHY THE BLACKLIST LOST. Four rounds of review, four single-character holes, in
 * a rule whose whole job is to have no holes:
 *
 *   1. `(` `)` `{` `}` — PowerShell evaluates a parenthesised subexpression in
 *      ARGUMENT position, and `.{…}` invokes a scriptblock using a `.` that has
 *      to stay legal. `Write-Output (Start-Process calc)` ran calc.
 *   2. `%` and `!` — cmd.exe expands `%VAR%` while PARSING (`%COMSPEC% /c calc`),
 *      and interactive bash expands `!!` into a previous command line, that
 *      line's punctuation included.
 *   3. `*` `?` `[` `]` `~` — POSIX pathname expansion replaces the word with
 *      matching FILENAMES before anything runs, and tilde expansion replaces one
 *      character with a home-directory path. The earlier rationale had weighed
 *      `[abc]` only as a PowerShell type literal and never as a glob.
 *   4. `#` — not execution and not expansion but TRUNCATION: a comment in
 *      interactive bash and in PowerShell, so `tool ${profile.name} --dry-run`
 *      silently drops the author's own flag.
 *
 *   5. `^` — and this one is what forced the flip. The list explicitly ARGUED
 *      that `^` was safe, reasoning only about cmd.exe (an escape character can
 *      remove meaning, never add it) and calling it "an ordinary character" in
 *      bash. It is not: at the START OF A LINE, bash performs QUICK SUBSTITUTION,
 *      where `^old^new^` is shorthand for `!!:s/old/new/` — it rewrites the
 *      PREVIOUS history entry and executes the result. A name of
 *      `^echo SAFE MODE^printf PWNED^` at the start of a `localTerminal` macro
 *      line runs the rewritten command. Confirmed empirically against
 *      interactive bash 5.2.
 *
 * Every one of those is the same shape: a character nobody had thought about, in
 * a shell role nobody had enumerated, reaching a default configuration. Mean-
 * while the three tokens that use a POSITIVE charset (`host`, `port`,
 * `username`) have produced ZERO findings across the same review — not because
 * anyone reasoned better about them, but because a whitelist's default answer to
 * an un-enumerated character is NO. That is the property this rule needed and a
 * blacklist structurally cannot have: a blacklist is only as good as the
 * exhaustiveness of a metacharacter survey across four shells, and five rounds
 * of evidence say that survey does not converge.
 *
 * THE BAR, unchanged, now applied to decide what gets IN rather than what stays
 * out: "can this ONE character, from inside a substituted value, cause
 * EXECUTION, EXPANSION or TRUNCATION in a DEFAULT-configuration shell?" The
 * shells are bash, zsh (macOS's default login shell since Catalina, so a
 * `localTerminal` macro lands in it on every stock Mac), PowerShell and cmd.exe.
 * A character earns a place only if the answer is no in ALL FOUR.
 *
 * WHAT IS ALLOWED, and why each one clears all four shells:
 *
 *   LETTERS, MARKS, DIGITS (`\p{L}\p{M}\p{N}`, hence the `u` flag) — data, in
 *   every shell. The Unicode classes are what keep `Ærø-Süd` and `Ünit` working;
 *   `\p{M}` is there so a decomposed accent (`U+0301` after a base letter) is not
 *   refused for being a combining mark rather than a letter.
 *
 *   SPACE — separates one argument from the next, which is exactly what a
 *   multi-word label is FOR ("Core Switch DC1"). It cannot introduce a word that
 *   was not already in the value.
 *
 *   `.` — inert in argument position everywhere. At the start of a COMMAND it
 *   sources a file in bash/zsh and dot-sources in PowerShell, but that is a value
 *   standing where a command goes, which is the macro template's choice and out
 *   of scope here exactly as it is for `host` (`10.0.0.1` at command position is
 *   likewise just a template mistake). Non-negotiable in practice: every
 *   site-code label has dots.
 *
 *   `-` — inert in all four. It can make a value LOOK like an option to the
 *   invoked program, but that is the program's argument parsing, not the shell's
 *   syntax, and `Rack A - Spare` is an ordinary label.
 *
 *   `_` — inert in all four; a word character everywhere.
 *
 *   `/` — a path separator, and nothing expands it: with glob syntax refused
 *   there is no pattern for it to be part of. `Rack 4 / Ünit 2` is a label, not a
 *   path. (Command position, as for `.`, is the template's business.)
 *
 *   `:` — inert in an argument for bash, zsh and PowerShell (bash's `:` is the
 *   null command, only at command position; PowerShell's scope/drive qualifiers
 *   need a `$`, refused). cmd.exe's `::` comment is a LABEL, recognised only as
 *   the FIRST token of a command. Also required for symmetry with
 *   `ADDRESS_CHARSET`, and site labels use it ("DC1: Core Switch").
 *
 *   `,` — inert in bash and zsh outside brace expansion, whose `{`/`}` are
 *   refused. PowerShell's array operator and cmd.exe's delimiter role can both
 *   SPLIT one word into two, but a space already does that and is allowed, so
 *   splitting is a consequence of free-form labels rather than a new capability:
 *   neither can introduce text the value did not contain.
 *
 *   `+` — inert in all four. Nothing in bash, zsh, PowerShell argument mode or
 *   cmd gives it a parsing role.
 *
 * WHAT WAS A CANDIDATE AND WAS DROPPED — the whitelist earning its keep:
 *
 *   `=` — DROPPED because of zsh, which is the shell this file had never
 *   considered. `=command` EXPANSION is on by default (the `EQUALS` option): at
 *   word start, `=ls` expands to `/bin/ls`. One character, one path substituted
 *   from `$PATH`, in the DEFAULT shell of every stock macOS. (bash's assignment
 *   form is only a prefix of a command word, and cmd treats `=` as a delimiter —
 *   but zsh alone is disqualifying.)
 *
 *   `@` — DROPPED because of PowerShell SPLATTING. `@name` in argument position
 *   inserts the contents of the session variable `name` into the command's
 *   arguments, which is expansion of data from outside the value — the same class
 *   as cmd's `%VAR%`. Its other `@` forms (`@(…)`, `@{…}`, `@'…'@`) all need a
 *   second character that is already refused, but splatting needs only `@` plus
 *   name characters. Nothing about a display label needs `@`, so the whitelist's
 *   default answer stands. (`USERNAME_CHARSET` keeps `@` on purpose: `user@REALM`
 *   is a real account form. That exception is now POSITIONAL — one `@`, never
 *   leading or trailing — because "a username is one word, so it cannot become
 *   `@name`" was an assumption the old charset never enforced: `@args` is one
 *   word too. See `USERNAME_CHARSET`. It is a narrow, load-bearing exception with
 *   its edge closed, not an inconsistency to copy here.)
 *
 *   `^` — DROPPED, per the finding above.
 *
 * ACCEPTED CONSEQUENCES, stated rather than discovered later:
 *
 *   Symbols outside letters/marks/digits are now refused — emoji, `°`, `€`, `×`,
 *   `&` (which was already out). A name like `Rack 20°C` stops resolving and the
 *   error names the allowed set. That is the whitelist behaving as designed: a
 *   character nobody has argued for is refused by default, and the fix is a
 *   rename or `$${profile.name}` for the literal token. Widening the class later
 *   is one edit plus the per-character argument above — the same bar every
 *   character here had to clear.
 *
 *   Only U+0020 counts as a space; U+00A0 and other Unicode separators are
 *   refused. They are invisible in a form field, and "looks identical, behaves
 *   differently" is the last property this rule should have.
 *
 *   CONTROL CHARACTERS fall out for free — none of them is a letter, a mark, a
 *   digit or one of the eight punctuation marks. `validateTokenValue()` still
 *   checks `CONTROL_CHARS` first for every token, so the refusal does not depend
 *   on this observation, but the two now agree instead of overlapping by luck.
 *
 * The per-character essays that used to fill the rest of this comment are gone;
 * the numbered history above is their summary, and the whitelist above is what
 * replaced their conclusions. Under a positive charset every one of those
 * characters is refused for the same reason — it is not on the list — so the
 * essays no longer carry a rule, only a lesson, and the lesson is the numbered
 * list.
 */
const NAME_CHARSET = /^[\p{L}\p{M}\p{N} ._\-\/:,+]+$/u;
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
 * Command Prompt, on macOS is zsh, and on a session terminal is an interactive
 * remote shell — so "reads as syntax" means the UNION of what bash, zsh,
 * PowerShell and cmd.exe read as syntax, not what bash alone does (see
 * `NAME_CHARSET`).
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
 * `port`, a real-username charset for `username`, and a letters-digits-and-eight-
 * punctuation-marks charset for the free-form `name` (see `NAME_CHARSET` — it
 * used to be a blacklist, and the four rounds of holes that cost are recorded
 * there). EVERY token is now a positive charset; nothing here is a blacklist.
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
    case "ipmiUsername":
      // The same charset for the same reason: `-U ${profile.ipmiUsername}` is a
      // local command line, and this value arrives from an auth profile that a
      // backup import can write anything into.
      return USERNAME_CHARSET.test(value);
    case "name":
      return NAME_CHARSET.test(value);
    default:
      // A token added to the whitelist without a rule of its own refuses rather
      // than passes: the charset decision is part of adding it, not optional.
      return false;
  }
}

/**
 * REVIEW FINDING (P2) — A BARE IPv6 HOST BROKE EVERY BROWSER MACRO. `host` and
 * `ipmiHost` accept an UNBRACKETED IPv6 literal (`fe80::1`) — they have to: that
 * is the form an SSH host takes, the form inventory sync writes, and the form
 * `-H fe80::1` needs on an `ipmitool` command line. But the shipped "Launch IPMI
 * web console" macro is `https://${profile.ipmiHost}/` with `runIn: "browser"`,
 * and substituting the bare literal there yields `https://fe80::1/`, which is
 * not a URL: the colons parse as a port, `new URL()` throws, and
 * `resolveMacroBrowserUrl()` refuses the run with "its text is not an http://
 * or https:// URL — Edit Macro". That points at the wrong repair entirely. The
 * macro text is correct, the server record is correct; only the FORM of the
 * value is wrong for the destination, and the destination is the one thing the
 * substitution site knows.
 *
 * So the bracketing happens HERE rather than as a post-hoc patch of the finished
 * URL. A post-hoc fix would have to re-find which span of the resolved text came
 * from which token — the information this function has for free.
 *
 * REVIEW FINDING (P2) — BRACKETS BELONG TO THE AUTHORITY, NOT TO THE URL. The
 * first version of this function bracketed EVERY bare-IPv6 `host`/`ipmiHost` in
 * URL form regardless of WHERE the token sat, and a URL is not uniformly a place
 * where an IPv6 address wants brackets. Only the AUTHORITY component (the
 * `host[:port]` between `://` and the next `/`, `?` or `#`) has the grammar that
 * requires them — RFC 3986's `IP-literal` exists to stop the address's colons
 * from being read as the port delimiter, and that ambiguity only exists there.
 * Everywhere else the address is ordinary data:
 *
 *   `https://gateway/connect?target=${profile.host}` with `fe80::1` became
 *   `?target=[fe80::1]`, and the brackets are now part of the VALUE the gateway
 *   receives — a corrupted parameter, silently, with no error anywhere.
 *
 * So the decision is per-MATCH, not per-run: `authoritySpans()` computes the
 * authority region(s) of the AUTHOR-OWNED template text once, before any
 * substitution, and each match is bracketed only if its offset falls inside one.
 * Two tokens in one template are decided independently — an authority token is
 * bracketed while a query token in the same macro is not.
 *
 * The template text is the right thing to parse, and the resolved text is not:
 * the template is written by the macro's author, so its `/`, `?` and `#` are
 * structure, whereas a substituted value could contribute characters that only
 * LOOK like structure. Parsing before substitution also means a value can never
 * move the boundary that decides its own treatment.
 *
 * NO PARSEABLE SCHEME → NO BRACKETING ANYWHERE. A URL-form macro whose text has
 * no `scheme://` is not a URL, and `resolveMacroBrowserUrl()` already refuses it
 * with an actionable "not an http:// or https:// URL — Edit Macro". Guessing at
 * an authority in text that has no scheme would only change WHICH wrong thing
 * that error describes. "Has a scheme" includes one a MACRO VARIABLE supplies
 * (`${scheme}://…`) — see `authorityCandidates()`.
 *
 * WHAT IS AND IS NOT BRACKETED, and why the test is `isIpv6Literal()` on the raw
 * value rather than "contains a colon":
 *
 *   `fe80::1`            → `[fe80::1]`             a bare literal; the bug.
 *   `[fe80::1]`          → unchanged                already bracketed — bracketing
 *                                                   again gives `[[fe80::1]]`.
 *   `[fe80::1]:623`      → unchanged                already a valid authority.
 *   `bmc.example.com:8443` → unchanged              HAS A COLON and is not IPv6:
 *                                                   it is host:port, and
 *                                                   `[bmc.example.com:8443]`
 *                                                   would break a URL that works
 *                                                   today.
 *   `10.0.0.9`, any name → unchanged                not IPv6 at all.
 *
 * `isIpv6Literal()` is the same structural parse the bracketed-value check uses,
 * so "what counts as IPv6" has exactly one definition in this file.
 *
 * COMMAND FORM IS UNTOUCHED — `-H fe80::1` is what ipmitool wants, and adding
 * brackets there would break the shipped SOL template. That is why this takes a
 * form rather than always bracketing.
 */
function substitutionValue(
  token: ProfileTokenName,
  value: string,
  form: ProfileTokenForm,
  inAuthority: boolean
): string {
  if (form !== "url" || !inAuthority || (token !== "host" && token !== "ipmiHost")) {
    return value;
  }
  return isIpv6Literal(value) ? `[${value}]` : value;
}

/**
 * `scheme://` — RFC 3986's `scheme` production (a letter, then letters, digits,
 * `+`, `-`, `.`) followed by the authority's `//`. Deliberately not restricted to
 * http/https: this only decides WHERE the authority is, and the scheme check
 * that decides whether the URL may be opened at all lives in
 * `resolveMacroBrowserUrl()`.
 */
const URL_SCHEME_PREFIX = /[A-Za-z][A-Za-z0-9+.\-]*:\/\//g;

/** Half-open `[start, end)` offsets of an authority component in the template. */
interface AuthoritySpan {
  start: number;
  end: number;
}

/**
 * One place an authority COULD begin: `matchStart` is where the thing that
 * introduces it (a literal scheme, or a macro-variable placeholder standing in
 * for one) starts, and `start` is the first character after its `://`.
 */
interface AuthorityCandidate {
  matchStart: number;
  start: number;
}

/**
 * REVIEW FINDING (P2) — A SCHEME CAN COME FROM A MACRO VARIABLE, and scanning
 * only for a LITERAL `scheme://` made the authority invisible when it did.
 *
 *   `${scheme}://${profile.ipmiHost}/`, with `scheme` declared as a macro
 *   variable the user answers with `https`, has no literal scheme at all. The
 *   profile pass therefore opened NO span, left a bare `fe80::1` unbracketed, and
 *   the later variable pass produced `https://fe80::1/` — which `new URL()`
 *   rejects, so `resolveMacroBrowserUrl()` refused the run with "not an http://
 *   or https:// URL — Edit Macro". The macro text is right, the server record is
 *   right, and the message points at neither.
 *
 * The two passes run in a fixed order (profile tokens, then variables), so the
 * profile pass can see the SHAPE the variable pass will produce even though it
 * cannot see the value: a placeholder immediately followed by `://` becomes a
 * scheme delimiter, wherever the answer comes from. The placeholder grammar is
 * imported from `macroVariables.ts` rather than re-derived here — one definition
 * of what a placeholder is, so the two files cannot drift about it.
 *
 * AN ESCAPED PLACEHOLDER DOES NOT COUNT. `$${scheme}://…` renders to the literal
 * text `${scheme}://…` (see `substituteMacroVariables()`), and a literal `${…}`
 * is not a scheme — bracketing there would corrupt text that was never a URL.
 * The escape is read from group 1 of the shared pattern, exactly as both passes
 * read it.
 *
 * A PROFILE TOKEN BEFORE `://` IS DELIBERATELY NOT A CANDIDATE. `${profile.x}://`
 * is not matched by the literal scan either (`{` is outside RFC 3986's scheme
 * charset), so this is an exclusion, not an oversight: no whitelisted token is a
 * URL scheme — they are a host, a port, a username and a display name — and a
 * macro would have to store the string `https` in one of those fields for the
 * shape to mean anything. Nothing in the product produces that, and admitting it
 * would widen the rule for a case with no user.
 */
function authorityCandidates(text: string): AuthorityCandidate[] {
  const candidates: AuthorityCandidate[] = [];

  const scheme = new RegExp(URL_SCHEME_PREFIX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = scheme.exec(text)) !== null) {
    candidates.push({ matchStart: match.index, start: match.index + match[0].length });
  }

  const placeholder = new RegExp(MACRO_PLACEHOLDER_SOURCE, "g");
  while ((match = placeholder.exec(text)) !== null) {
    if (match[1] === "$") continue; // escaped — renders literal, so it is no scheme
    const after = match.index + match[0].length;
    if (text.startsWith("://", after)) {
      candidates.push({ matchStart: match.index, start: after + "://".length });
    }
  }

  // Left to right, so the "already inside an authority" test below only ever has
  // to look at the span it most recently opened.
  candidates.sort((a, b) => a.matchStart - b.matchStart || a.start - b.start);
  return candidates;
}

/**
 * Every authority region of `text`: from just after a `scheme://` up to the next
 * `/`, `?` or `#`, or the end of the string. Computed on the TEMPLATE, before
 * substitution — see the comment on `substitutionValue()` for why that is the
 * only text with the authority to say where the authority is.
 *
 * A profile token cannot contain `/`, `?` or `#` (`PROFILE_TOKEN_SOURCE` allows
 * only `${profile.<word>}`), so a token that STARTS inside a span is wholly
 * inside it, and an unsubstituted token can never hide a delimiter. The same is
 * true of a macro-variable placeholder, whose grammar is `$name` / `${name}`.
 *
 * A candidate that BEGINS inside a span already opened is dropped — a `//` (or a
 * `$name://`) within an authority is not a second URL. That is also what makes
 * the two scanners in `authorityCandidates()` safe to merge: the bare form
 * `$s://` is matched BOTH as a placeholder (from the `$`) and, by coincidence of
 * character classes, as the literal scheme `s://`, and the duplicate collapses
 * here because the second candidate starts inside the span the first opened.
 */
function authoritySpans(text: string): AuthoritySpan[] {
  const spans: AuthoritySpan[] = [];
  for (const candidate of authorityCandidates(text)) {
    const open = spans[spans.length - 1];
    if (open !== undefined && candidate.matchStart < open.end) continue;

    const start = candidate.start;
    let end = text.length;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "/" || ch === "?" || ch === "#") {
        end = i;
        break;
      }
    }
    spans.push({ start, end });
  }
  return spans;
}

function isInAuthority(spans: AuthoritySpan[], offset: number): boolean {
  return spans.some((span) => offset >= span.start && offset < span.end);
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
function rawTokenValue(token: ProfileTokenName, server: ProfileTokenFacts): string {
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
  /**
   * Offset of `full` in the ORIGINAL text — the template, since the walker never
   * rescans what a rewriter produced. That is what lets a rewriter ask where in
   * the author's text this occurrence sits (see `authoritySpans()`).
   */
  index: number;
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
      index: match.index,
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
 *
 * `context.form` decides how an accepted value is WRITTEN, never whether it is
 * accepted — see `substitutionValue()`. It defaults to `"command"`, so every
 * existing call site keeps its exact previous output.
 */
export function resolveProfileTokens(
  text: string,
  server: ProfileTokenFacts,
  context: ProfileTokenContext = {}
): ProfileTokenOutcome {
  const form: ProfileTokenForm = context.form ?? "command";
  const serverName = typeof server.name === "string" && server.name.trim() !== "" ? server.name : "this server";
  const unknownTokens: string[] = [];
  const seenUnknown = new Set<string>();
  // Computed once, from the template, and only when it can matter. Command form
  // never brackets, so it never needs to know where a URL's authority would be.
  const spans = form === "url" ? authoritySpans(text) : [];

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
    return substitutionValue(match.token, value, form, isInAuthority(spans, match.index));
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
