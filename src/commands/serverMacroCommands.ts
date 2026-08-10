import * as vscode from "vscode";
import type { ServerConfig } from "../models/config";
import type { TerminalMacro } from "../models/terminalMacro";
import {
  IPMI_GATEWAY_INERT_CREDENTIALS_HINT,
  macroProvidesIpmiCredentials,
  macroRunTargetBadge,
  resolveMacroRoute,
  resolveMacroRunTarget
} from "../models/terminalMacro";
import { getMacros } from "../macroSettings";
import { getAssignedBinding } from "../macroBindingHelpers";
import { bindingToDisplayLabel } from "../macroBindings";
import { sanitizeMacroGroup } from "../services/macroFolders";
import { formatProfileTokenErrorForCommand, hasProfileTokens, profileTokenLabel, profileTokensUsed, resolveProfileTokens } from "../services/profileTokens";
import type { ProfileTokenError, ProfileTokenErrorCommandSubject, ProfileTokenForm } from "../services/profileTokens";
import { profileTokenServer, resolveIpmiTerminalEnv, type ProfileTokenServer } from "./ipmiCredentials";
import { VARIABLE_MARKER } from "../ui/macroVariableMarker";
import { macroWillPrompt } from "./macroCommands";
import { connectServer, pickServer, toServerFromArg } from "./serverCommands";
import { runMacroWithTarget, terminalSendTarget, type MacroSendTarget } from "./macroVariablePrompt";
import type { CommandContext } from "./types";

/**
 * "Run Macro on Server…" (`nexus.server.runMacro`) — the launch surface for
 * profile-token macros (issue #48).
 *
 * WHY A QUICK PICK AND NOT A SUBMENU: VS Code menus are statically contributed,
 * so no `contributes.submenus` entry can enumerate user-defined macros. One
 * command opening a picker is the platform-idiomatic equivalent, and it is the
 * shape `nexus.server.runWithScript` already uses for "pick a thing to run
 * against this server".
 *
 * WHY THE MENU ENTRY IS NOT PER-SERVER CONDITIONAL: the server tree item's
 * `contextValue` is matched by ~15 anchored `when` regexes in package.json (see
 * the B5 comment in ui/nexusTreeProvider.ts), so adding a variant to express
 * "this server has an IPMI host" would mean rewriting all of them. A macro that
 * needs a field this server lacks is therefore LISTED AND FLAGGED here, and
 * refused with a specific error (plus an Edit Server button) if picked —
 * hiding it would only make the feature undiscoverable.
 */

/** How long to wait for a session after a connect-first confirmation. */
const CONNECT_SESSION_TIMEOUT_MS = 90_000;

interface ServerMacroPick extends vscode.QuickPickItem {
  macro: TerminalMacro;
  /** Why this macro cannot run against the chosen server, if it cannot. */
  issue?: ProfileTokenError;
}

/** §4.8 — folder path goes in `detail`, never `description`. Mirrors `macroFolderDetail` in macroCommands.ts. */
function folderDetail(macro: TerminalMacro): string | undefined {
  const group = sanitizeMacroGroup(macro.group);
  return group ? `Folder: ${group}` : undefined;
}

/**
 * WHAT THE RESOLVED TEXT WILL BE, derived from where this macro runs — the ONE
 * definition, shared by the picker's flag and the run itself.
 *
 * A `browser` macro's text is parsed as a URL, so an address token is written in
 * URL-authority form there (a bare IPv6 literal gets bracketed); everything else
 * is a command line and keeps the raw value. Both call sites read the form from
 * here rather than each deciding: `profileTokenIssue()` and `runMacroOnServer()`
 * already share the token SERVER for the same reason (see `profileTokenServer`),
 * and a form that disagreed would let the picker flag a macro the run accepts,
 * or the reverse.
 */
function profileTokenForm(macro: TerminalMacro): ProfileTokenForm {
  return resolveMacroRunTarget(macro) === "browser" ? "url" : "command";
}

/**
 * Why this macro cannot run against this server, if it cannot. Asked through
 * `resolveProfileTokens` itself rather than a second, parallel rule, so the
 * flag in the picker and the refusal on selection can never disagree; it stops
 * at the first unresolvable token, which is the one the run would refuse on.
 */
function profileTokenIssue(macro: TerminalMacro, server: ProfileTokenServer): ProfileTokenError | undefined {
  const outcome = resolveProfileTokens(macro.text, server, { form: profileTokenForm(macro) });
  return outcome.ok ? undefined : outcome.error;
}

/** The picker's one-line form of an issue; `error.message` is the full sentence shown on selection. */
function issueSummary(issue: ProfileTokenError, server: ProfileTokenServer): string {
  return issue.kind === "missing"
    ? `$(warning) Needs ${profileTokenLabel(issue.token)} on "${server.name}"`
    : `$(warning) "${server.name}" ${profileTokenLabel(issue.token)} cannot be used in a command`;
}

/**
 * The macro picker's items, in display order: macros that reference
 * `${profile.*}` first (they are what this command exists for), each remaining
 * macro in its stored order. `Array.prototype.sort` is stable, so nothing else
 * is reordered.
 *
 * Item shape is deliberately the same as `nexus.macro.run`'s — keybinding
 * prefix, prompt marker, `***` for a secret's value, folder in `detail` — plus
 * the run-target badge and the missing-field flag this command adds. Exported
 * for tests.
 */
export function buildServerMacroPicks(macros: readonly TerminalMacro[], server: ProfileTokenServer): ServerMacroPick[] {
  const items = macros.map((macro): ServerMacroPick => {
    const binding = getAssignedBinding(macro);
    const prefix = binding ? `[${bindingToDisplayLabel(binding)}] ` : "";
    const marker = macroWillPrompt(macro) ? VARIABLE_MARKER : "";
    const badge = macroRunTargetBadge(macro);
    const issue = profileTokenIssue(macro, server);
    const details = [issue ? issueSummary(issue, server) : undefined, folderDetail(macro)];
    return {
      label: `${prefix}${macro.name}`,
      description: `${marker}${badge}${macro.secret ? "***" : macro.text.replace(/\n/g, "\\n")}`,
      detail: details.filter((part): part is string => !!part).join("  •  ") || undefined,
      macro,
      issue
    };
  });
  return items.sort((a, b) => Number(hasProfileTokens(b.macro.text)) - Number(hasProfileTokens(a.macro.text)));
}

/**
 * The http/https whitelist for `runIn: "browser"` macros, following
 * `resolveBrowserUrl` (utils/tunnelProfile.ts) exactly — scheme parsed off a
 * real URL parse, never a prefix match. Returns the URL to open, or `undefined`
 * for anything that is not an http(s) URL: `javascript:`, `file:`, `vscode:`
 * and a bare `10.0.0.1` all land there.
 */
export function resolveMacroBrowserUrl(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const scheme = new URL(trimmed).protocol.replace(/:$/, "");
    if (scheme === "http" || scheme === "https") {
      return trimmed;
    }
  } catch {
    // malformed URL — not openable
  }
  return undefined;
}

/**
 * A fresh VS Code terminal, created only once the prompts have resolved.
 *
 * `env` carries the IPMI credential pair for a macro that opted in
 * (`macroProvidesIpmiCredentials`) — see `resolveIpmiTerminalEnv` for why the
 * password travels this way and never in the text. `undefined` for every other
 * macro, which is the shape every build before this one produced: the option
 * bag is spread conditionally so an unflagged run passes literally
 * `{ name }`, exactly as before.
 */
function localTerminalTarget(
  macro: TerminalMacro,
  server: ServerConfig,
  env?: Record<string, string>
): MacroSendTarget {
  return {
    description: "a local terminal",
    // Nothing to invalidate: the destination does not exist yet, so it cannot
    // have been closed while the prompts were up.
    isStillValid: () => true,
    send(text: string): boolean {
      const terminal = vscode.window.createTerminal({
        name: `Nexus Macro: ${macro.name} (${server.name})`,
        ...(env ? { env } : {})
      });
      terminal.show();
      // `false` — the macro's own trailing newline decides whether the line
      // executes, exactly as it does for a session send.
      terminal.sendText(text, false);
      return true;
    }
  };
}

function browserTarget(macro: TerminalMacro, macroIndex: number): MacroSendTarget {
  return {
    description: "the browser",
    isStillValid: () => true,
    async send(text: string): Promise<boolean> {
      const url = resolveMacroBrowserUrl(text);
      if (!url) {
        // The fix is always in the macro's text, so offer the same one-click
        // route to it that a profile-token refusal offers to the server form.
        const action = await vscode.window.showErrorMessage(
          `"${macro.name}" is set to run in the browser, but its text is not an http:// or https:// URL. Nothing was opened.`,
          "Edit Macro"
        );
        if (action === "Edit Macro") {
          // `{ macro, index }` is the row shape every macro command accepts
          // (`MacroRowLike` in services/macroMutation.ts), so the target is
          // re-resolved against a freshly read array rather than trusted.
          await vscode.commands.executeCommand("nexus.macro.edit", { macro, index: macroIndex });
        }
        return false;
      }
      // REVIEW FINDING (P2) — `openExternal` RESOLVES TO A BOOLEAN, and `false`
      // is a real outcome: the OS handler declined, or the user dismissed the
      // "allow this extension to open a URI?" trust prompt. Returning `true`
      // regardless made `runMacroWithTarget` report "sent to the browser" for a
      // run in which nothing opened. The result is now the send's result — and
      // because a `false` return is deliberately SILENT there ("the target
      // already said why"), saying why is this target's job.
      const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
      if (!opened) {
        void vscode.window.showWarningMessage(`Could not open "${macro.name}" in the browser.`);
        return false;
      }
      return true;
    }
  };
}

/**
 * The "a token went out verbatim" caveat, phrased to be APPENDED to the send
 * confirmation — `undefined` when there is nothing to say.
 *
 * REVIEW FINDING (P2) — this used to be its own `setStatusBarMessage` fired the
 * instant the tokens resolved, which is before the run is committed to anything:
 * the prompt walk, the "connect first?" confirmation and the browser URL check
 * all come after it and all can abort, so the user could be told what "was sent
 * as-is" in a run that sent nothing at all. And in the case where the send DID
 * happen immediately, the success status replaced this one within the same tick,
 * so it was never read anyway. Both failures are fixed by the same move: say it
 * once, with the outcome, and only when there is an outcome to attach it to.
 *
 * Lowercase and unpunctuated — `runMacroWithTarget` appends it as a clause of
 * `Macro "X" sent to Y — ….`
 */
export function unknownTokenNote(unknownTokens: readonly string[]): string | undefined {
  if (unknownTokens.length === 0) {
    return undefined;
  }
  const list = unknownTokens.map((token) => `\${profile.${token}}`).join(", ");
  return unknownTokens.length === 1
    ? `unknown profile token ${list} was sent as-is`
    : `unknown profile tokens ${list} were sent as-is`;
}

/**
 * The IPMI tokens a text uses — the HINT half of the opt-in (issue #48 §3.3).
 * Token usage keeps its hint role and has none of its old authorization role:
 * what it grants is a sentence in the delivery report, never a credential.
 */
function usesIpmiTokens(text: string): boolean {
  return profileTokensUsed(text).some((token) => token === "ipmiHost" || token === "ipmiUsername");
}

/**
 * The caveat for a local-terminal macro that reaches for a BMC but was never
 * ticked to receive its password — appended to the delivery report, exactly like
 * the unknown-token note.
 *
 * DISCOVERABILITY, NOT SILENCE. Such a run is not broken: `ipmitool -E` with no
 * variable in the environment fails with its own message, in the user's own
 * visible terminal. What it cannot say is that Nexus has the password and was
 * not asked to hand it over, which is the one thing the user needs in order to
 * fix it — and where.
 *
 * Lowercase, unpunctuated: it is appended as a clause.
 */
export function ipmiCredentialsOffNote(macro: TerminalMacro): string | undefined {
  if (resolveMacroRunTarget(macro) !== "localTerminal" || macroProvidesIpmiCredentials(macro)) {
    return undefined;
  }
  // C4 — kept short so the actionable tail survives the 4s status bar clip; the
  // fuller explanation now lives in the persistent macro-editor hint (B1). No
  // trailing period: the status line (macroVariablePrompt.ts) adds its own.
  return usesIpmiTokens(macro.text)
    ? 'IPMI credentials were not provided — tick "Provide IPMI credentials" in the macro editor'
    : undefined;
}

/** An `ipmitool …` invocation in a macro's text — at line start or after whitespace. */
const IPMITOOL_COMMAND_RE = /(^|\s)ipmitool\b/;

/**
 * The caveat for a SESSION-target macro whose text reaches for a BMC — it uses an
 * IPMI token or invokes ipmitool — but was typed into the connected SSH session,
 * so it ran on the REMOTE host, not this machine (issue #48 PR-B, "Ogun's case":
 * a legacy session macro running ipmitool got no IPMI messaging at all).
 *
 * A HINT, not a gate. Text/token inspection is sanctioned as a hint only (§3.3),
 * so this never blocks or reroutes the run — it appends one clause pointing at
 * "Run in" in the editor. Kept short because it shares the same 4s status bar the
 * other delivery notes clip in (C4).
 *
 * Lowercase, unpunctuated: appended as a clause, like the sibling notes.
 */
export function sessionIpmiHintNote(macro: TerminalMacro): string | undefined {
  if (resolveMacroRunTarget(macro) !== "session") {
    return undefined;
  }
  return usesIpmiTokens(macro.text) || IPMITOOL_COMMAND_RE.test(macro.text)
    ? 'ran in the SSH session on the remote host — set "Run in" to Local terminal to run ipmitool from this machine'
    : undefined;
}

/**
 * The server a target server routes its IPMI to, or `undefined` when it names no
 * gateway or names one that no longer exists in the snapshot. A dangling id
 * resolves to "no gateway" — the same disposition `remapProxy` gives an
 * out-of-export jump host — so the fall-back rule (run locally, plus a note)
 * catches it exactly as it catches a server with no gateway at all.
 *
 * The ONE read site for `ipmiGatewayServerId` on the run path, so "does this
 * server route to a gateway, and to which one" is decided once.
 */
export function resolveIpmiGatewayServer(ctx: CommandContext, server: ServerConfig): ServerConfig | undefined {
  const id = server.ipmiGatewayServerId;
  // P4/NIT-4 — a server naming ITSELF as its IPMI gateway is treated as no
  // gateway (local delivery). A hand-edited or exported self-reference would
  // otherwise deliver the routed command into the target's OWN session terminal,
  // which is not what "route to the gateway" means and defeats the fall-back rule.
  if (typeof id !== "string" || !id || id === server.id) {
    return undefined;
  }
  return ctx.core.getSnapshot().servers.find((candidate) => candidate.id === id);
}

/**
 * The fall-back note (§4.2 Path B item 0): a macro asked to run on the IPMI
 * gateway, but the target names no reachable gateway, so it runs LOCALLY. Local
 * is the intended destination for a no-gateway server ("unset gateway = the BMC
 * is reachable locally"), not a degradation — the note only keeps the fall-back
 * non-silent. Verbatim copy per the roadmap.
 */
export function noGatewayFallbackNote(
  server: ServerConfig,
  route: "local" | "ipmiGateway",
  gateway: ServerConfig | undefined
): string | undefined {
  // No trailing period: the status line (macroVariablePrompt.ts) adds its own, and
  // the sibling notes are appended as unpunctuated clauses.
  return route === "ipmiGateway" && !gateway
    ? `No IPMI gateway is configured for ${server.name} — running locally`
    : undefined;
}

/**
 * The route re-consent note (§4.2 Path B item 0, rev11): a LOCAL-routed
 * local-terminal macro whose text reaches for a BMC (an IPMI token) runs against
 * a server that HAS a gateway configured — so the command runs on this machine
 * when the BMC may only be reachable from the gateway. Gated on IPMI-token usage
 * exactly like the credentials hint, so it never nags on an unrelated local
 * helper (`ping`, `scp`) that merely happens to sit on a gateway server. Verbatim
 * copy per the roadmap.
 */
export function routeReconsentNote(
  macro: TerminalMacro,
  route: "local" | "ipmiGateway",
  gateway: ServerConfig | undefined
): string | undefined {
  // SCOPED TO LOCAL-TERMINAL MACROS (B1). The route is only ever meaningful on a
  // `localTerminal` macro; every other target has `route` forced to `"local"` by
  // the caller, which would otherwise satisfy the guard below and hand a
  // `session`/`browser` macro this note — false and self-contradictory copy (a
  // session macro already gets `sessionIpmiHintNote`, and a browser macro has no
  // "Run on" field to point at). Gated on the resolved run target like the sibling
  // note helpers so it stays exclusively on the local run path.
  if (resolveMacroRunTarget(macro) !== "localTerminal") {
    return undefined;
  }
  if (route !== "local" || !gateway || !usesIpmiTokens(macro.text)) {
    return undefined;
  }
  // No trailing period: the status line (macroVariablePrompt.ts) adds its own.
  return `This macro runs on this machine. If this BMC is only reachable from ${gateway.name}, set 'Run on: the server's IPMI gateway' in the macro editor`;
}

/**
 * The inert-credentials per-run note (§4.2 Path B item 4): a gateway-routed macro
 * that also has `provideIpmiCredentials` on. Env injection cannot cross to the
 * gateway shell, so the flag is inert and ipmitool's own `-a` prompt supplies the
 * password there instead. Reads the SAME string the editor hint does
 * (`IPMI_GATEWAY_INERT_CREDENTIALS_HINT`) so the two cannot drift.
 */
export function gatewayInertCredentialsNote(macro: TerminalMacro): string | undefined {
  return (macro.provideIpmiCredentials as unknown) === true ? IPMI_GATEWAY_INERT_CREDENTIALS_HINT : undefined;
}

/**
 * ipmitool's `-E` flag as a STANDALONE token, SCOPED to an actual ipmitool
 * invocation — its "read the password from the environment" flag
 * (`IPMITOOL_PASSWORD` / `IPMI_PASSWORD`). `\bipmitool\b` matches the command
 * (word-boundary, so a path prefix `/usr/bin/ipmitool` counts and `ipmitoolx`
 * does not) then, WITHIN THE SAME command segment (`[^;&|\n]*` stops at a `;`,
 * `&`, `|` or newline), a whitespace-delimited standalone `-E` (before whitespace
 * or end of string, so `-Example`/`-Env` do not match).
 *
 * The scoping is what round 4 lacked: a bare `/(?:^|\s)-E(?=\s|$)/` matched any
 * `-E` anywhere in the text, false-positiving on a `-E` owned by a WRAPPER
 * (`sudo -E ipmitool … -a`, where the `-E` is sudo's preserve-environment and
 * ipmitool itself uses `-a` and prompts) or by a PIPED non-ipmitool command
 * (`ipmitool -a … | grep -E …`). Requiring the `-E` to follow `ipmitool` inside
 * the same segment ties it to the invocation that actually reads the env.
 */
// \bipmitool\b, then within the same segment ([^;&|\n]* — cannot cross ; & | or
// an unescaped newline), a -E preceded by HORIZONTAL whitespace ([^\S\n], so a
// bare newline does NOT put a next-line -E on this command) and followed by
// whitespace (incl. the newline that ends the command) or end of string.
const IPMITOOL_ENV_PASSWORD_FLAG_RE = /\bipmitool\b[^;&|\n]*[^\S\n]-E(?=\s|$)/;

/**
 * Whether a command reads the IPMI password from the environment via ipmitool's
 * `-E` flag. This is the real predicate for "this will FAIL on a gateway": the
 * gateway session gets no injected env (the secret never crosses to the remote
 * hop), so a `-E` command exits "password not available" there instead of
 * prompting. A text-derived HINT only (§3.3) — never used for authorization, and
 * the command is neither blocked nor rewritten on its account.
 */
export function commandReadsIpmiEnv(text: string): boolean {
  // Shell line continuation: a backslash immediately before a newline joins the
  // two lines into ONE command, so a -E on a continued line is still an argument
  // of the ipmitool invocation above it. Collapse continuations first (to a
  // space, a safe token separator) so the segment scan sees one line; an
  // UNESCAPED newline stays a real command boundary in the regex above.
  const withoutContinuations = text.replace(/\\\r?\n/g, " ");
  return IPMITOOL_ENV_PASSWORD_FLAG_RE.test(withoutContinuations);
}

/**
 * The `-E`-on-gateway per-run WARNING (PR-C round 4, P2). A gateway-routed command
 * that reads the password from the environment (`-E`) can't get that env on the
 * gateway session, so it FAILS on the bastion rather than prompting — the exact
 * case the inert-credentials note's old "will prompt" copy over-promised. Keyed on
 * the COMMAND, not the credentials flag: `-E` fails whether or not
 * `provideIpmiCredentials` is set, so this fires regardless of the flag and
 * REPLACES the flag-gated inert note when it applies (the two never double-fire).
 *
 * Names the gateway and points at ipmitool's `-a` form (which prompts on the
 * bastion tty) as the fix. Lowercase-leaning, no trailing period: appended as a
 * clause like the sibling notes; the status line adds its own punctuation.
 */
export function gatewayEnvPasswordNote(command: string, gateway: ServerConfig): string | undefined {
  return commandReadsIpmiEnv(command)
    ? `this command reads the IPMI password from the environment (-E), which a gateway session can't provide — it will fail on ${gateway.name}; use ipmitool's -a form so it prompts there instead`
    : undefined;
}

/**
 * The one delivery note built from however many caveats a run collected. Joined
 * with a semicolon rather than a second status message: `runMacroWithTarget`
 * appends ONE clause to the success line, and a second `setStatusBarMessage`
 * would simply replace the first within the same tick (the failure the
 * unknown-token note was moved here to fix).
 */
export function combineDeliveryNotes(...notes: Array<string | undefined>): string | undefined {
  const present = notes.filter((note): note is string => !!note);
  return present.length > 0 ? present.join("; ") : undefined;
}

/** Terminals of this server's live sessions, in session order, closed ones dropped. */
function sessionTerminalsFor(ctx: CommandContext, serverId: string): vscode.Terminal[] {
  return ctx.core
    .getSnapshot()
    .activeSessions.filter((session) => session.serverId === serverId)
    .map((session) => ctx.sessionTerminals.get(session.id))
    .filter((terminal): terminal is vscode.Terminal => terminal !== undefined && terminal.exitStatus === undefined);
}

/**
 * How the wait below ended. The two failures are kept apart because they are
 * different events with different things to say: a connect that was REFUSED is
 * known-over the moment it is refused, while the timeout is the last-resort
 * "nothing has happened for 90 seconds and I cannot tell why".
 */
type ConnectWatchOutcome =
  | { kind: "session"; sessionId: string }
  | { kind: "connect-failed" }
  | { kind: "timeout" };

/**
 * Connects `server` and waits for the session that connect produced — the same
 * new-session-by-difference watch `connectAndRunScript` uses, because
 * `connectServer` resolves when the terminal exists, not when the SSH session
 * is registered.
 *
 * REVIEW FINDING (P2) — A FAILED CONNECT IS NOT A TIMEOUT. `SshPty.start()`
 * catches its own initial-connect errors (services/ssh/sshPty.ts): the terminal
 * stays open holding a "Connection failed / press any key to close" notice, the
 * pty is never disposed and `closeEmitter` never fires, and no session is ever
 * registered. So neither `onDidCloseTerminal` nor `exitStatus` nor the session
 * watch below says anything, and the flow used to sit out the FULL 90 seconds
 * on a refused password before telling the user it had "connected" — with a
 * macro they asked to run still pending on it. `onConnectFailed` (threaded
 * through `ConnectServerOptions`) is that missing signal, and it is the earliest
 * one there is: it fires from the same catch block that decides the connect is
 * over. The timer stays as the fallback for everything it cannot cover — a
 * connect that hangs forever, or a session that registers late.
 */
async function connectAndAwaitSessionTerminal(
  ctx: CommandContext,
  server: ServerConfig
): Promise<vscode.Terminal | undefined> {
  const preExisting = new Set(
    ctx.core.getSnapshot().activeSessions.filter((s) => s.serverId === server.id).map((s) => s.id)
  );

  let settle: (outcome: ConnectWatchOutcome) => void = () => {};
  // First settle wins; the later ones are no-ops on an already-resolved promise.
  const settled = new Promise<ConnectWatchOutcome>((resolve) => {
    settle = resolve;
  });
  const unsubscribe = ctx.core.onDidChange(() => {
    const session = ctx.core
      .getSnapshot()
      .activeSessions.find((s) => s.serverId === server.id && !preExisting.has(s.id));
    if (session) {
      settle({ kind: "session", sessionId: session.id });
    }
  });
  const timer = setTimeout(() => settle({ kind: "timeout" }), CONNECT_SESSION_TIMEOUT_MS);

  try {
    await connectServer(ctx, server.id, {
      allowAutoFileExplorer: false,
      onConnectFailed: () => settle({ kind: "connect-failed" })
    });
    const outcome = await settled;
    if (outcome.kind === "connect-failed") {
      // DELIBERATELY DOES NOT REPEAT THE CAUSE. `SshPty.start()` has already
      // shown "Nexus SSH connection failed for <name>: <reason>", so the only
      // thing left unsaid is the consequence for THIS command — the macro the
      // user asked to run went nowhere. Warning, not error, for the same
      // reason: the error is already on screen.
      void vscode.window.showWarningMessage(`Could not connect to "${server.name}" — nothing was sent.`);
      return undefined;
    }
    if (outcome.kind === "timeout") {
      void vscode.window.showWarningMessage(
        `Connected to ${server.name} but no session appeared in time — nothing was sent.`
      );
      return undefined;
    }
    // `registerSession` fires the change event BEFORE the terminal is recorded,
    // both inside one synchronous callback — so this read, which happens in a
    // later microtask, sees it. The server-wide fallback covers a session whose
    // terminal was never recorded at all.
    return ctx.sessionTerminals.get(outcome.sessionId) ?? sessionTerminalsFor(ctx, server.id)[0];
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

/** Options that only apply when `resolveServerSessionTarget` aims at a GATEWAY. */
export interface ServerSessionTargetOptions {
  /**
   * Reveal the session terminal on delivery (B2). The gateway path is an
   * interactive console whose `-a` password prompt sits hidden until the terminal
   * is focused, so unlike an ordinary session send it must surface it. Left off
   * for ordinary `session` macros, which keep today's non-revealing behavior.
   */
  reveal?: boolean;
  /**
   * The name of the server whose IPMI gateway `server` is, threaded so the
   * connect-first modal can name the routing context (S2): the user acted on
   * "Core Switch", so a bare `"Bastion" is not connected` reads as an unrelated
   * server. Absent for ordinary session callers, which keep today's copy.
   */
  gatewayForName?: string;
}

/**
 * Wraps a session terminal's send so it reveals the terminal first (B2). Reveal
 * is best-effort — a just-closed terminal or a test double may not expose
 * `show()` — and never touches the transport, so the remote shell is untouched.
 */
function revealingSessionTarget(terminal: vscode.Terminal): MacroSendTarget {
  const base = terminalSendTarget(terminal);
  return {
    description: base.description,
    isStillValid: () => base.isStillValid(),
    send(text: string): boolean | Promise<boolean> {
      if (typeof terminal.show === "function") {
        terminal.show();
      }
      return base.send(text);
    }
  };
}

/**
 * The send target for a `session` macro: a terminal of THIS SERVER's session —
 * never `window.activeTerminal`, which may belong to a different host entirely.
 *
 * Whatever this returns is pinned by reference before the prompt walk starts
 * (§8.1). Every await it performs happens BEFORE that pin, never after.
 *
 * `macro` is `Pick<…, "name">` (P6): only the name is read here — for the picker
 * title and the connect-first modal — so a real `TerminalMacro` is not required
 * and the direct BMC command need not cast a name-only object to one.
 */
export async function resolveServerSessionTarget(
  ctx: CommandContext,
  server: ServerConfig,
  macro: Pick<TerminalMacro, "name">,
  options: ServerSessionTargetOptions = {}
): Promise<MacroSendTarget | undefined> {
  const buildTarget = (terminal: vscode.Terminal): MacroSendTarget =>
    options.reveal ? revealingSessionTarget(terminal) : terminalSendTarget(terminal);

  const terminals = sessionTerminalsFor(ctx, server.id);
  if (terminals.length === 1) {
    return buildTarget(terminals[0]);
  }
  if (terminals.length > 1) {
    const picked = await vscode.window.showQuickPick(
      terminals.map((terminal, index) => ({ label: terminal.name, description: `Session ${index + 1}`, terminal })),
      { title: `Run "${macro.name}" on which session?` }
    );
    return picked ? buildTarget(picked.terminal) : undefined;
  }

  // S2 — name the routing context on the gateway path so the modal does not read
  // as a stray, apparently-unrelated server.
  const subject = options.gatewayForName
    ? `"${server.name}" (IPMI gateway for "${options.gatewayForName}")`
    : `"${server.name}"`;
  const choice = await vscode.window.showWarningMessage(
    `${subject} is not connected. Connect now and run "${macro.name}"?`,
    { modal: true },
    "Connect and Run"
  );
  if (choice !== "Connect and Run") {
    return undefined;
  }
  const terminal = await connectAndAwaitSessionTerminal(ctx, server);
  return terminal ? buildTarget(terminal) : undefined;
}

/**
 * Reports a refused token substitution, offering the repair right where the
 * failure is. Exported because the direct BMC commands (`bmcCommands.ts`) refuse
 * through the SAME pathway rather than inventing their own error copy — the
 * fields they need are the fields a macro needs, and the repair is the same form.
 *
 * `subject` re-phrases the message for a menu-invoked command, where the default
 * "…but this macro uses ${profile.X}" is wrong because there is no macro (C1). The
 * macro path passes none and keeps the original copy verbatim.
 */
export async function reportProfileTokenError(
  error: ProfileTokenError,
  server: ServerConfig,
  subject?: ProfileTokenErrorCommandSubject
): Promise<void> {
  const message = subject ? formatProfileTokenErrorForCommand(error, subject) : error.message;
  const action = await vscode.window.showErrorMessage(message, "Edit Server");
  if (action === "Edit Server") {
    await openServerAdvancedEdit(server);
  }
}

/**
 * The "Edit Server" repair route with Advanced options expanded — "IPMI / BMC
 * Host" is an advanced field, so without `expandAdvanced` the button lands on a
 * form with the field the error named collapsed out of sight. Shared by the token
 * refusal above and the BMC web-address error (bmcCommands.ts, C5), so every
 * missing-piece BMC error offers the identical repair (docs/macros.md).
 */
export async function openServerAdvancedEdit(server: ServerConfig): Promise<void> {
  await vscode.commands.executeCommand("nexus.server.edit", { server, expandAdvanced: true });
}

/**
 * The macro the caller already picked, if any. `nexus.macro.run` and the
 * keybinding paths know WHICH macro but not which server, so they redirect here
 * (`runOrSendMacro` in macroCommands.ts) — re-asking for the macro would make
 * the redirect cost the user their own selection.
 *
 * Resolved against the CURRENT list by id where there is one, so the stored
 * record wins over whatever the caller was holding; a caller with no id (or an
 * id that no longer exists) falls back to a shape check on the object itself,
 * which is enough to run it. Anything else — a tree item, a server argument,
 * nothing at all — means "no preselection", and the picker opens as before.
 */
function preselectedMacro(arg: unknown, macros: readonly TerminalMacro[]): TerminalMacro | undefined {
  if (!arg || typeof arg !== "object") {
    return undefined;
  }
  const { macroId, macro } = arg as { macroId?: unknown; macro?: unknown };
  const id = typeof macroId === "string" ? macroId : undefined;
  const candidate = macro && typeof macro === "object" ? (macro as TerminalMacro) : undefined;
  const wantedId = id ?? (typeof candidate?.id === "string" ? candidate.id : undefined);
  if (wantedId) {
    const stored = macros.filter((m) => m.id === wantedId);
    // Exactly one match only: two macros sharing an id is a real state in this
    // codebase (see services/macroMutation.ts), and running "one of them" is
    // the guess that file exists to refuse.
    if (stored.length === 1) return stored[0];
  }
  return typeof candidate?.name === "string" && typeof candidate?.text === "string" ? candidate : undefined;
}

export async function runMacroOnServer(ctx: CommandContext, arg?: unknown): Promise<void> {
  const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
  if (!server) {
    return;
  }

  const macros = getMacros();
  if (macros.length === 0) {
    // The templates are the fastest route to a working profile-token macro, and
    // this command is exactly where someone arrives wanting one.
    const action = await vscode.window.showInformationMessage(
      "No macros yet. The IPMI templates are a good starting point — they fill the BMC address in from the server profile.",
      "Add From Template…",
      "Add Blank Macro"
    );
    if (action === "Add From Template…") {
      await vscode.commands.executeCommand("nexus.macro.addFromTemplate");
    } else if (action === "Add Blank Macro") {
      await vscode.commands.executeCommand("nexus.macro.add");
    }
    return;
  }

  // What the tokens see — `server` plus the linked auth profile's username where
  // there is one. The PICKER is built from it too, so the flag it shows and the
  // refusal on selection cannot disagree.
  const tokenServer = profileTokenServer(ctx, server);

  let macro = preselectedMacro(arg, macros);
  if (!macro) {
    const picked = await vscode.window.showQuickPick(buildServerMacroPicks(macros, tokenServer), {
      title: `Run Macro on "${server.name}"`,
      placeHolder: "Select a macro — ${profile.…} tokens resolve against this server"
    });
    if (!picked) {
      return;
    }
    macro = picked.macro;
  }

  // Read BEFORE the tokens resolve, because it decides how they resolve: a
  // browser macro's text is a URL, and an address token is written in URL form
  // there. `profileTokenForm` is the same function the picker's flag used, so
  // the two cannot answer differently for the same macro.
  const runTarget = resolveMacroRunTarget(macro);

  // Profile tokens are resolved FIRST and synchronously: a macro that cannot be
  // resolved against this server must fail before anything is connected, any
  // terminal is created, and any prompt is shown.
  const resolution = resolveProfileTokens(macro.text, tokenServer, { form: profileTokenForm(macro) });
  if (!resolution.ok) {
    await reportProfileTokenError(resolution.error, server);
    return;
  }
  // JUMP-HOST IPMI ROUTING (issue #48 PR-C). Resolved BEFORE the credential gate
  // and before the dispatch, because it decides both: a gateway-routed macro
  // never prompts for a password (env injection cannot cross to the gateway
  // shell — ipmitool's own `-a` prompt supplies it there), and it is delivered
  // into the GATEWAY's session terminal rather than a local one. The route is
  // meaningful only for a `localTerminal` macro; every other target stays local
  // to its own semantics.
  const route = runTarget === "localTerminal" ? resolveMacroRoute(macro) : "local";
  const gatewayServer = route === "ipmiGateway" ? resolveIpmiGatewayServer(ctx, server) : undefined;
  // A gateway routing actually takes effect only when the target names a gateway
  // that resolves; `route: "ipmiGateway"` with no reachable gateway FALLS BACK to
  // a local terminal (plus the note below), so the credentials flag applies
  // normally there because the terminal really is local.
  const routedToGateway = route === "ipmiGateway" && gatewayServer !== undefined;

  // NOT REPORTED HERE — see `unknownTokenNote`. The caveats ride along with the
  // delivery report, because everything below can still abort.
  const deliveryNote = combineDeliveryNotes(
    unknownTokenNote(resolution.unknownTokens),
    // P1 — the fall-back note comes BEFORE the credentials note: on the
    // route:ipmiGateway-with-no-gateway path both fire, and "running locally"
    // is what makes the following "IPMI credentials were not provided" clause
    // intelligible (they were not provided to a LOCAL run it fell back to).
    noGatewayFallbackNote(server, route, gatewayServer),
    // On the gateway path the "tick Provide IPMI credentials" hint would be wrong
    // (the flag is inert there), so it is replaced by a gateway-specific note; the
    // local and fall-back paths keep the original hint. When the command reads its
    // password from the environment (`-E`), the gateway session can't provide it,
    // so it FAILS there rather than prompting — that case gets an active warning
    // (keyed on the command, not the flag) that REPLACES the inert note, which
    // would otherwise over-promise a prompt that never comes.
    routedToGateway
      ? commandReadsIpmiEnv(resolution.text)
        ? gatewayEnvPasswordNote(resolution.text, gatewayServer!)
        : gatewayInertCredentialsNote(macro)
      : ipmiCredentialsOffNote(macro),
    sessionIpmiHintNote(macro),
    routeReconsentNote(macro, route, resolveIpmiGatewayServer(ctx, server))
  );

  // THE CREDENTIAL GATE (issue #48 §3.3). Three conditions, all required, and
  // token usage is not one of them in either direction: a flagged macro that
  // uses no IPMI token still gets the environment (it may build the address
  // itself), and an unflagged macro that uses every IPMI token gets nothing —
  // and is never prompted, since prompting is the same disclosure decision moved
  // one dialog later.
  //
  // SKIPPED ENTIRELY ON THE GATEWAY PATH (PR-C item 2): the secret must never be
  // typed into a remote shell's history/scrollback, and env injection cannot
  // reach it, so there is nothing to obtain and nothing to prompt for — ipmitool
  // prompts on the bastion. Only a truly-local terminal reads this environment.
  //
  // Resolved BEFORE the target is built and before the prompt walk, so a
  // cancelled credential prompt costs the user nothing: no terminal has been
  // spawned and no variable has been asked for.
  let ipmiEnv: Record<string, string> | undefined;
  if (!routedToGateway && macroProvidesIpmiCredentials(macro)) {
    const credential = await resolveIpmiTerminalEnv(ctx, server, { purpose: "IPMI" });
    if (credential.kind === "cancelled") {
      vscode.window.setStatusBarMessage(`Macro "${macro.name}" cancelled — nothing was sent.`, 4000);
      return;
    }
    ipmiEnv = credential.env;
  }

  let target: MacroSendTarget | undefined;
  switch (runTarget) {
    case "localTerminal":
      // A gateway-routed macro rides a SESSION terminal of the gateway server —
      // SOL is interactive and needs a real PTY, not a fresh local terminal.
      // Tokens are already resolved against the TARGET server (the chokepoint is
      // unchanged); only the destination terminal moves. The connect-first
      // confirmation, the connect-failed-vs-timeout split and the pinned-target
      // discipline all carry over by pointing `resolveServerSessionTarget` at the
      // gateway's own `ServerConfig`.
      target = routedToGateway
        ? await resolveServerSessionTarget(ctx, gatewayServer!, macro, {
            // Reveal the gateway session so the interactive `-a` prompt is
            // visible immediately (B2), and name the routing context in the
            // connect-first modal (S2).
            reveal: true,
            gatewayForName: server.name
          })
        : localTerminalTarget(macro, server, ipmiEnv);
      break;
    case "browser":
      target = browserTarget(macro, macros.indexOf(macro));
      break;
    default:
      target = await resolveServerSessionTarget(ctx, server, macro);
      break;
  }
  if (!target) {
    return;
  }

  // The prompt walk runs on the TOKEN-RESOLVED text, so a `$host` the user
  // declared is still prompted for while `${profile.host}` is already filled in
  // — the two are different placeholders and neither shadows the other.
  await runMacroWithTarget({ ...macro, text: resolution.text }, target, { deliveryNote });
}

export function registerServerMacroCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.server.runMacro", (arg?: unknown) => runMacroOnServer(ctx, arg))
  ];
}
