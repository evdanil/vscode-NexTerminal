import * as os from "node:os";
import type { AuthType } from "../models/config";
import type { ImportedSession, ImportParseResult } from "./mobaxtermParser";
import type { SshConfigParseResult } from "./sshConfigParser";

/**
 * Turns the parser's {@link SshConfigParseResult} into the shape every other
 * importer already speaks ({@link ImportParseResult}). PURE — no `vscode`, no
 * `fs`; the caller does the reading.
 *
 * Two decisions live here, both of which the parser deliberately left open:
 *
 * 1. **`%` TOKENS ARE EXPANDED, OR THE ENTRY IS DROPPED.** `sshConfigParser`
 *    hands back `HostName` verbatim (see its "Not modelled" note), so a block
 *    reading `HostName %h.example.com` would otherwise become a server whose
 *    host is the literal string `%h.example.com` — a row that looks imported,
 *    sits in the tree, and can never resolve. Only the two tokens an importer
 *    can answer statically are expanded: `%h` (the host ssh was asked for,
 *    which for a `Host` block IS the alias) and `%%` (a literal `%`). Anything
 *    else — `%p`, `%r`, `%n`, `%C`, `%d`, `%u`, `%L`, `%l`, `%i` — depends on
 *    the connection, the local user or the local machine, none of which an
 *    import has. Such an entry is SKIPPED and counted, never imported broken:
 *    a row that is absent is a question the user can answer, a row that is
 *    wrong is a support ticket.
 *
 * 2. **AN UNEXPANDABLE `IdentityFile` COSTS THE KEY, NOT THE HOST.** Same
 *    tokens, different stake: a host with a literal `%d` in its host string
 *    cannot connect at all, whereas a host whose key path we cannot resolve is
 *    still a perfectly good SSH target that falls back to the password prompt —
 *    exactly what every pre-existing importer produces. So the entry survives
 *    with `authType: "password"` and no `keyPath`, and the count is reported
 *    separately so the confirm modal can say so.
 *
 * `~/` in `IdentityFile` is expanded here because nothing downstream does it:
 * `ssh2Connector.ts` passes `server.keyPath` straight to `readFile`, so a
 * stored `~/.ssh/id_ed25519` is an ENOENT at connect time. `~user/...` is left
 * verbatim — it names ANOTHER user's home, and silently substituting ours
 * would hand the wrong key to the wrong host.
 */

export interface SshConfigImportResult extends ImportParseResult {
  /** Entries dropped because a `%` token survived expansion in the host. */
  unsupportedTokenCount: number;
  /** Entries kept, but stripped of an `IdentityFile` a `%` token made unresolvable. */
  droppedIdentityFileCount: number;
}

export interface SshConfigImportOptions {
  /**
   * Username for a block with no `User`. ssh itself uses the local login name
   * there, so that is what the caller passes; injected rather than read here to
   * keep this module pure and its tests independent of the machine.
   */
  defaultUsername?: string;
}

/**
 * Expand the `%` tokens an importer can answer, or return `undefined` when one
 * it cannot answer is present.
 *
 * Scanned left to right precisely so `%%h` is a literal `%h` — the escape has
 * to be consumed before the token check, or an escaped token reads as a real
 * one.
 */
export function expandSshTokens(value: string, alias: string): string | undefined {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "%") {
      out += value[i];
      continue;
    }
    const next = value[i + 1];
    if (next === "%") {
      out += "%";
      i++;
      continue;
    }
    if (next === "h") {
      out += alias;
      i++;
      continue;
    }
    // Every other token, and a trailing bare `%`, is unanswerable at import time.
    return undefined;
  }
  return out;
}

/**
 * Expand a leading `~/`. Same lookahead rule (and same reason) as
 * `expandHome` in `sshConfigParser.ts`: `~user/...` is another user's home and
 * must not quietly become ours.
 */
function expandHome(value: string): string {
  return value.replace(/^~(?=\/|\\|$)/, os.homedir());
}

/** Map parsed ssh-config entries onto importable sessions. */
export function convertSshConfig(
  parsed: SshConfigParseResult,
  options: SshConfigImportOptions = {}
): SshConfigImportResult {
  const sessions: ImportedSession[] = [];
  let unsupportedTokenCount = 0;
  let droppedIdentityFileCount = 0;

  for (const entry of parsed.entries) {
    const host = expandSshTokens(entry.host, entry.alias);
    if (host === undefined || host.trim() === "") {
      unsupportedTokenCount++;
      continue;
    }

    let keyPath: string | undefined;
    if (entry.identityFile !== undefined) {
      const expanded = expandSshTokens(entry.identityFile, entry.alias);
      if (expanded === undefined || expanded.trim() === "") {
        droppedIdentityFileCount++;
      } else {
        keyPath = expandHome(expanded);
      }
    }

    // THE POINT OF THE FEATURE: an `~/.ssh/config` is the canonical KEY-based
    // config, so a row with an IdentityFile must arrive as key auth. Importing
    // it as "password" would prompt every one of these hosts for a password the
    // user does not have and never set.
    const authType: AuthType = keyPath ? "key" : "password";

    sessions.push({
      // The alias is the name the user already knows the host by — `ssh web1`
      // is muscle memory, so `web1` is what the profile is called.
      name: entry.alias,
      host,
      port: entry.port ?? 22,
      username: entry.user ?? options.defaultUsername ?? "",
      // ssh config has no folder concept. Not a gap to fill with a guess.
      folder: "",
      authType,
      keyPath
    });
  }

  return {
    sessions,
    // Everything the user wrote that produced no importable row, under one
    // number the caller labels "wildcard or unsupported": defaults blocks
    // (`Host *`), negations (`!foo`), `Match` blocks (not statically
    // evaluable), and the `%`-token drops decided above.
    skippedCount:
      unsupportedTokenCount +
      parsed.wildcardPatternCount +
      parsed.negatedPatternCount +
      parsed.matchBlockCount,
    folders: [],
    unsupportedTokenCount,
    droppedIdentityFileCount
  };
}

/**
 * The local login name — what ssh itself uses for a block that sets no `User`,
 * so it is the only non-interactive answer that matches what `ssh <alias>`
 * would actually do.
 *
 * Kept out of {@link convertSshConfig} (which takes it as an option) so the
 * conversion stays a pure function of its input and its tests stay independent
 * of the machine they run on. `os.userInfo()` throws when the uid has no passwd
 * entry — a plain container — hence the environment fallback and the final "".
 */
export function localLoginName(): string {
  try {
    return os.userInfo().username || "";
  } catch {
    return process.env.USER || process.env.USERNAME || "";
  }
}
