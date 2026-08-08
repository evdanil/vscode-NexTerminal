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
const PROFILE_TOKEN_CHARSET_GUIDANCE: Record<ProfileTokenName, string> = {
  host: 'Use the address only — letters, digits, ".", "-", "_", ":" and "[]" for IPv6 — without a scheme like https:// or a path.',
  ipmiHost:
    'Use the address only — letters, digits, ".", "-", "_", ":" and "[]" for IPv6 — without a scheme like https:// or a path.',
  port: "Use the port number only — digits, nothing else.",
  username: 'Use letters, digits, ".", "_", "-" and "@" only.',
  name:
    'Remove $, `, quotes, ";", "|", "&", "<", ">", "\\", parentheses and braces from the name — spaces, ' +
    'square brackets, "/" and accents are fine.'
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
 * Address charset for the host-like tokens: letters, digits, `.`, `-`, `_`, `:`
 * and `[` `]` (bracketed IPv6). Deliberately narrower than "valid hostname" —
 * the point is not to validate DNS, it is that nothing which survives this can
 * act as shell syntax.
 */
const ADDRESS_CHARSET = /^[A-Za-z0-9._:\-\[\]]+$/;
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
 * syntax is refused, while spaces, accents, "/" and square brackets are not.
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
 * SQUARE BRACKETS ARE NOT REFUSED, deliberately. `[Type]::Member` does put
 * PowerShell into expression mode, but a type literal is not by itself an
 * invocation: reaching a method needs `(` (call) or `{` (scriptblock), and both
 * are now gone — what is left is at worst a name that resolves to a type, or a
 * glob pattern in a POSIX shell. Neither runs anything. "Rack A [Spare]" is as
 * ordinary a label as "Rack A - Spare", and `host`/`ipmiHost` keep `[]` for
 * bracketed IPv6, so the rules stay consistent about the same two characters.
 */
const NAME_FORBIDDEN_CHARS = /["'$`;|&<>\\(){}]/;
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
 * uses the platform default, which is PowerShell on Windows — so "reads as
 * syntax" means the union of what bash and PowerShell read as syntax, not what
 * bash alone does (see `NAME_FORBIDDEN_CHARS`).
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
      return ADDRESS_CHARSET.test(value);
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
 * Substitutes `${profile.*}` tokens in `text` against `server`.
 *
 * The algorithm mirrors `substituteMacroVariables()` line for line, and for the
 * same security reason: the output is built by APPENDING TO AN ARRAY and
 * joining, never `text.replace(re, value)`. In string-replacement mode
 * JavaScript interprets `$&`, `` $` ``, `$'`, `$1` and `$$` inside the
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
  const out: string[] = [];
  const unknownTokens: string[] = [];
  const seenUnknown = new Set<string>();
  let lastIndex = 0;

  const re = profileTokenRegex();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const full = match[0];
    const escaped = match[1] === "$";
    const name = match[2];

    out.push(text.slice(lastIndex, match.index));
    lastIndex = match.index + full.length;

    if (!isProfileTokenName(name)) {
      // Verbatim whether escaped or not — the same rule the variable engine
      // applies to an undeclared name, so an unknown token reads identically in
      // both passes.
      out.push(full);
      if (!seenUnknown.has(name)) {
        seenUnknown.add(name);
        unknownTokens.push(name);
      }
      continue;
    }

    if (escaped) {
      out.push(full.slice(1));
      continue;
    }

    const value = rawTokenValue(name, server);
    if (value === "") {
      return { ok: false, error: missingError(name, serverName) };
    }
    if (!validateTokenValue(name, value)) {
      return { ok: false, error: invalidError(name, serverName, value) };
    }
    out.push(value);
  }
  out.push(text.slice(lastIndex));

  return { ok: true, text: out.join(""), unknownTokens };
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
