import * as os from "node:os";
import type { AuthType } from "../models/config";
import type { ImportedSession, ImportParseResult } from "./mobaxtermParser";
import type { SshConfigParseResult } from "./sshConfigParser";

/**
 * Turns the parser's {@link SshConfigParseResult} into the shape every other
 * importer already speaks ({@link ImportParseResult}). PURE — no `vscode`, no
 * `fs`; the caller does the reading.
 *
 * Five decisions live here, all of which the parser deliberately left open:
 *
 * 1. **`%` TOKENS ARE EXPANDED, OR THE ENTRY IS DROPPED.** `sshConfigParser`
 *    hands back `HostName` verbatim (see its "Not modelled" note), so a block
 *    reading `HostName %h.example.com` would otherwise become a server whose
 *    host is the literal string `%h.example.com` — a row that looks imported,
 *    sits in the tree, and can never resolve. Only the two tokens an importer
 *    can answer statically are expanded: `%h` and `%%` (a literal `%`). What
 *    `%h` stands for depends on WHERE it appears, and OpenSSH is not sloppy
 *    about it: in `HostName` it is the host ssh was asked for, i.e. the alias;
 *    everywhere downstream — `IdentityFile` included — it is the RESOLVED
 *    remote host, i.e. the expanded `HostName`. Both sites are fed the right
 *    value in {@link convertSshConfig}.
 *
 *    Anything else — `%p`, `%r`, `%n`, `%C`, `%d`, `%u`, `%L`, `%l`, `%i` — depends on
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
 * 3. **`IdentityFile none` IS A SENTINEL, NOT A PATH.** ssh_config(5) gives the
 *    argument `none` the meaning "load no identity file", so such a block has
 *    deliberately no key and imports exactly like a block with no `IdentityFile`
 *    line at all: password auth, no `keyPath`. It is NOT counted as a dropped
 *    identity file — see {@link SshConfigImportResult.droppedIdentityFileCount}.
 *
 * 4. **A BLOCK WITH NO USABLE `User` TAKES `defaultUsername`, AND THE CALLER
 *    MUST SUPPLY A NON-EMPTY ONE.** ssh falls back to the local login name
 *    there, which is what {@link localLoginName} answers — but it can answer
 *    `""` (a uid with no passwd entry and no `$USER`, i.e. a plain container),
 *    and `""` is not a username this extension can store: `validateServerConfig`
 *    requires a non-empty one for ssh, and `VscodeConfigRepository.getServers`
 *    DROPS every row that fails it with only a `console.warn`. A row written
 *    with an empty username therefore appears in the tree, connects for that
 *    session, and VANISHES on the next window reload — invisible until then.
 *
 *    This module cannot prompt (it is pure), so it does the next best thing:
 *    it reports {@link SshConfigImportResult.missingUsernameCount}, the number
 *    of importable entries that fell back to the default, so the caller can
 *    ask the user for one BEFORE any row is written. A blank or whitespace-only
 *    `User` (`User ""` parses to the empty string, and `??` would keep it)
 *    counts as "no user" for exactly the same reason.
 *
 * 5. **`ProxyJump` IS NOT IMPORTED, AND THE ENTRY SAYS SO.** Nexus models jump
 *    hosts natively (`proxyJumpHostId`), but mapping an ssh-config `ProxyJump`
 *    onto one needs a rule for a jump target that is itself an alias in the
 *    same file — a design decision, not a conversion. Until there is one, such
 *    a host imports as a DIRECT connection, which for a private-address host
 *    behind a bastion means every connect times out. Silently is the one way
 *    that must not happen, so the entry carries
 *    {@link SshConfigImportedSession.droppedProxyJump} and the confirm modal
 *    names both the loss and the remedy.
 *
 * `~/` in `IdentityFile` is expanded here because nothing downstream does it:
 * `ssh2Connector.ts` passes `server.keyPath` straight to `readFile`, so a
 * stored `~/.ssh/id_ed25519` is an ENOENT at connect time. `~user/...` is left
 * verbatim — it names ANOTHER user's home, and silently substituting ours
 * would hand the wrong key to the wrong host.
 */

/**
 * An importable row plus the two per-entry losses the confirm modal reports.
 *
 * PER-ENTRY, not just totalled, because the modal's headline counts the rows
 * that will actually be WRITTEN — the candidate list minus the hosts already in
 * Nexus — and a total counted over every candidate disagrees with it. Re-import
 * a config whose one unexpandable-IdentityFile host is already present and the
 * total says "1 host will use password auth" about a host this import is not
 * touching.
 */
export interface SshConfigImportedSession extends ImportedSession {
  /**
   * This entry named an `IdentityFile` a `%` token made unresolvable, so it
   * arrives on password auth with no key. Never set for `IdentityFile none` —
   * see {@link SshConfigImportResult.droppedIdentityFileCount}.
   */
  droppedIdentityFile?: boolean;
  /** This entry named a `ProxyJump`, which is not imported (decision 5 above). */
  droppedProxyJump?: boolean;
}

export interface SshConfigImportResult extends ImportParseResult {
  sessions: SshConfigImportedSession[];
  /** Entries dropped because a `%` token survived expansion in the host. */
  unsupportedTokenCount: number;
  /**
   * Entries kept, but stripped of an `IdentityFile` a `%` token made
   * unresolvable — i.e. "this host named a key we could not use".
   *
   * `IdentityFile none` is NOT counted: it names no key on purpose, so there was
   * nothing to lose and nothing for the user to go and fix.
   *
   * TOTALLED OVER EVERY CANDIDATE. A caller reporting it to the user after
   * filtering the candidates (the ssh-config branch skips hosts already in
   * Nexus) must count {@link SshConfigImportedSession.droppedIdentityFile} over
   * what it will write instead.
   */
  droppedIdentityFileCount: number;
  /**
   * Entries kept, but imported as DIRECT connections although they named a
   * `ProxyJump`. Same totalling caveat as `droppedIdentityFileCount`.
   */
  droppedProxyJumpCount: number;
  /**
   * Importable entries that named no usable `User` and therefore took
   * `options.defaultUsername`. Non-zero means the caller's default is what
   * those rows will be stored with — so a caller holding an EMPTY default must
   * obtain one before writing anything (decision 4 above).
   */
  missingUsernameCount: number;
}

/**
 * ssh_config(5)'s "no identity file at all" sentinel. A bare word, not a path:
 * ssh compares the argument as written, so the match is case-sensitive.
 */
const IDENTITY_FILE_NONE = "none";

export interface SshConfigImportOptions {
  /**
   * Username for a block with no `User`. ssh itself uses the local login name
   * there, so that is what the caller passes; injected rather than read here to
   * keep this module pure and its tests independent of the machine.
   *
   * MAY BE EMPTY, and then every entry that needs it lands with `username: ""`,
   * which is a row the storage layer discards on reload. The count is reported
   * as {@link SshConfigImportResult.missingUsernameCount} precisely so a caller
   * can detect that case and ask the user, rather than the conversion guessing
   * or dropping hosts the user asked for (decision 4 in the module comment).
   */
  defaultUsername?: string;
}

/**
 * Expand the `%` tokens an importer can answer, or return `undefined` when one
 * it cannot answer is present.
 *
 * `hostToken` is what `%h` expands to, and the caller decides that per site: the
 * ALIAS when expanding `HostName`, the already-expanded HOST when expanding
 * anything derived from it (`IdentityFile`). This function has no way to tell
 * the two apart, which is why it takes the value rather than the entry.
 *
 * Scanned left to right precisely so `%%h` is a literal `%h` — the escape has
 * to be consumed before the token check, or an escaped token reads as a real
 * one.
 */
export function expandSshTokens(value: string, hostToken: string): string | undefined {
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
      out += hostToken;
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
  const sessions: SshConfigImportedSession[] = [];
  let unsupportedTokenCount = 0;
  let droppedIdentityFileCount = 0;
  let droppedProxyJumpCount = 0;
  let missingUsernameCount = 0;

  for (const entry of parsed.entries) {
    const host = expandSshTokens(entry.host, entry.alias);
    if (host === undefined || host.trim() === "") {
      unsupportedTokenCount++;
      continue;
    }

    let keyPath: string | undefined;
    let droppedIdentityFile = false;
    // `IdentityFile none` is ssh_config(5)'s sentinel for "load no identity
    // file at all" — it is not the name of a file. Treated here as if the block
    // had named no IdentityFile, so the entry falls through to the no-key
    // policy below; left as a path it became `keyPath: "none"`, which the
    // connector then tried to `readFile`, so the profile could not connect.
    //
    // Matched case-sensitively, and only as the whole argument. ssh compares
    // the argument verbatim, and this parser already treats every keyword
    // ARGUMENT as case-sensitive — `readConfigLine` lowercases the KEYWORD and
    // nothing else, so hostnames, users and patterns all keep their case. So
    // `None` stays a path, as do `none.pem` and `/keys/none`.
    //
    // Deliberately NOT counted in `droppedIdentityFileCount`: that number is
    // reported to the user as "we could not use the key this host named", and
    // `none` is the user saying there is no key to use. Counting it would claim
    // a loss that did not happen and send the user looking for a key path to
    // repair.
    if (entry.identityFile !== undefined && entry.identityFile !== IDENTITY_FILE_NONE) {
      // `%h` in IdentityFile is the RESOLVED remote host — the HostName, not the
      // alias (verified with `ssh -vvv`: alias `foo` + `HostName 127.0.0.1` +
      // `IdentityFile /tmp/id_%h` makes ssh read `/tmp/id_127.0.0.1`). Passing
      // the alias here stored a key path that does not exist, and because an
      // IdentityFile makes the profile key-auth, the connection failed on it.
      // `host` above is already expanded, so `%h` in the HostName itself — where
      // it DOES mean the alias — is resolved before it reaches the key path.
      const expanded = expandSshTokens(entry.identityFile, host);
      if (expanded === undefined || expanded.trim() === "") {
        droppedIdentityFileCount++;
        droppedIdentityFile = true;
      } else {
        keyPath = expandHome(expanded);
      }
    }

    // THE POINT OF THE FEATURE: an `~/.ssh/config` is the canonical KEY-based
    // config, so a row that named a USABLE key must arrive as key auth.
    // Importing it as "password" would prompt every one of these hosts for a
    // password the user does not have and never set. The converse is not true:
    // an `IdentityFile` line does not by itself mean key auth — `none` names no
    // key, and a `%`-token path we could not expand leaves none either. Both
    // land on the password prompt, which is exactly what ssh falls back to.
    const authType: AuthType = keyPath ? "key" : "password";

    // A blank `User` is NO user, not a username of zero characters. `User ""`
    // parses to the empty string, and `??` keeps it — which would defeat the
    // caller's default and store a row `validateServerConfig` rejects, i.e. a
    // server that vanishes on the next reload (decision 4).
    const declaredUser = entry.user !== undefined && entry.user.trim() !== "" ? entry.user : undefined;
    if (declaredUser === undefined) {
      missingUsernameCount++;
    }

    // Counted only for entries that actually IMPORT: a host skipped for an
    // unexpandable address lost more than its ProxyJump, and reporting it here
    // would send the user to fix a profile that does not exist.
    const droppedProxyJump = entry.proxyJump !== undefined && entry.proxyJump.trim() !== "";
    if (droppedProxyJump) {
      droppedProxyJumpCount++;
    }

    sessions.push({
      // The alias is the name the user already knows the host by — `ssh web1`
      // is muscle memory, so `web1` is what the profile is called.
      name: entry.alias,
      host,
      port: entry.port ?? 22,
      username: declaredUser ?? options.defaultUsername ?? "",
      // ssh config has no folder concept. Not a gap to fill with a guess.
      folder: "",
      authType,
      keyPath,
      ...(droppedIdentityFile ? { droppedIdentityFile: true } : {}),
      ...(droppedProxyJump ? { droppedProxyJump: true } : {})
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
    droppedIdentityFileCount,
    droppedProxyJumpCount,
    missingUsernameCount
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
 *
 * THAT `""` IS NOT A USABLE DEFAULT, and a caller must not pass it through to
 * {@link convertSshConfig} and write the result: an ssh server with an empty
 * username fails `validateServerConfig`, and `VscodeConfigRepository.getServers`
 * drops such a row on the next read, so the imported servers disappear on the
 * next window reload with nothing but a `console.warn`. Callers ask the user
 * for a default instead — see `missingUsernameCount`.
 */
export function localLoginName(): string {
  try {
    return os.userInfo().username || "";
  } catch {
    return process.env.USER || process.env.USERNAME || "";
  }
}
