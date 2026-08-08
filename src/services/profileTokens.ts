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
/** C0 and C1 control characters, `\n` / `\r` included. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * THE INJECTION DEFENSE, and the reason it lives at the substitution site
 * rather than at the server form.
 *
 * These values are not only user-typed: `host` arrives from inventory sync and
 * every field of a server record arrives from backup import, so "it was checked
 * when it was saved" is not true of the records that matter. The resolved text
 * then goes to a LOCAL shell (a `localTerminal` macro running `ipmitool`), where
 * a host of `1.2.3.4; rm -rf ~` is command execution on the user's own machine.
 *
 * The answer is a charset, not quoting: quoting rules differ per shell, and a
 * half-implemented quoter creates confidence it cannot back. So a value that
 * cannot be safely interpolated REFUSES THE RUN — it is never warned about and
 * substituted anyway, and never silently emptied (an empty `-H` argument is its
 * own failure mode).
 *
 * Control characters are rejected for EVERY token, `name` and `username`
 * included: the resolved text is sent to a terminal, so an embedded newline in
 * any substituted value executes whatever follows it, no shell metacharacter
 * required. Beyond that, `name` is a free-form label (parentheses, spaces and
 * accents are ordinary in it) and is not charset-restricted — a macro author
 * putting a display name inside a command owns the quoting of it, exactly as
 * they own the rest of their template.
 */
function validateTokenValue(token: ProfileTokenName, value: string): boolean {
  if (CONTROL_CHARS.test(value)) {
    return false;
  }
  switch (token) {
    case "host":
    case "ipmiHost":
      return ADDRESS_CHARSET.test(value);
    case "port":
      return DIGITS_ONLY.test(value);
    default:
      return true;
  }
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
    message: `"${serverName}" has no ${PROFILE_TOKEN_FIELD_LABELS[token]} set, but this macro uses \${profile.${token}}. Nothing was sent.`
  };
}

function invalidError(token: ProfileTokenName, serverName: string): ProfileTokenError {
  return {
    kind: "invalid",
    token,
    serverName,
    message: `The ${PROFILE_TOKEN_FIELD_LABELS[token]} of "${serverName}" contains characters that are not safe to place in a command, so \${profile.${token}} was not substituted. Nothing was sent.`
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
 * into the result. Array-append treats every profile value as opaque and
 * never rescans it.
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
      return { ok: false, error: invalidError(name, serverName) };
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

/** Does `text` reference any profile token at all (used to sort pickers)? */
export function hasProfileTokens(text: string): boolean {
  return profileTokensUsed(text).length > 0;
}
