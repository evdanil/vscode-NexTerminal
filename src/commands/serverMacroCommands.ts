import * as vscode from "vscode";
import type { ServerConfig } from "../models/config";
import { effectiveServerUsername } from "../models/config";
import type { TerminalMacro } from "../models/terminalMacro";
import { macroRunTargetBadge, resolveMacroRunTarget } from "../models/terminalMacro";
import { getMacros } from "../macroSettings";
import { getAssignedBinding } from "../macroBindingHelpers";
import { bindingToDisplayLabel } from "../macroBindings";
import { sanitizeMacroGroup } from "../services/macroFolders";
import { hasProfileTokens, profileTokenLabel, resolveProfileTokens } from "../services/profileTokens";
import type { ProfileTokenError } from "../services/profileTokens";
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
 * Why this macro cannot run against this server, if it cannot. Asked through
 * `resolveProfileTokens` itself rather than a second, parallel rule, so the
 * flag in the picker and the refusal on selection can never disagree; it stops
 * at the first unresolvable token, which is the one the run would refuse on.
 */
function profileTokenIssue(macro: TerminalMacro, server: ServerConfig): ProfileTokenError | undefined {
  const outcome = resolveProfileTokens(macro.text, server);
  return outcome.ok ? undefined : outcome.error;
}

/** The picker's one-line form of an issue; `error.message` is the full sentence shown on selection. */
function issueSummary(issue: ProfileTokenError, server: ServerConfig): string {
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
export function buildServerMacroPicks(macros: readonly TerminalMacro[], server: ServerConfig): ServerMacroPick[] {
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

/** A fresh VS Code terminal, created only once the prompts have resolved. */
function localTerminalTarget(macro: TerminalMacro, server: ServerConfig): MacroSendTarget {
  return {
    description: "a local terminal",
    // Nothing to invalidate: the destination does not exist yet, so it cannot
    // have been closed while the prompts were up.
    isStillValid: () => true,
    send(text: string): boolean {
      const terminal = vscode.window.createTerminal({ name: `Nexus Macro: ${macro.name} (${server.name})` });
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
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return true;
    }
  };
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
 * Connects `server` and waits for the session that connect produced — the same
 * new-session-by-difference watch `connectAndRunScript` uses, because
 * `connectServer` resolves when the terminal exists, not when the SSH session
 * is registered.
 */
async function connectAndAwaitSessionTerminal(
  ctx: CommandContext,
  server: ServerConfig
): Promise<vscode.Terminal | undefined> {
  const preExisting = new Set(
    ctx.core.getSnapshot().activeSessions.filter((s) => s.serverId === server.id).map((s) => s.id)
  );

  let settle: (sessionId: string | undefined) => void = () => {};
  const opened = new Promise<string | undefined>((resolve) => {
    settle = resolve;
  });
  const unsubscribe = ctx.core.onDidChange(() => {
    const session = ctx.core
      .getSnapshot()
      .activeSessions.find((s) => s.serverId === server.id && !preExisting.has(s.id));
    if (session) {
      settle(session.id);
    }
  });
  const timer = setTimeout(() => settle(undefined), CONNECT_SESSION_TIMEOUT_MS);

  try {
    await connectServer(ctx, server.id, { allowAutoFileExplorer: false });
    const sessionId = await opened;
    if (!sessionId) {
      void vscode.window.showWarningMessage(
        `Connected to ${server.name} but no session appeared in time — nothing was sent.`
      );
      return undefined;
    }
    // `registerSession` fires the change event BEFORE the terminal is recorded,
    // both inside one synchronous callback — so this read, which happens in a
    // later microtask, sees it. The server-wide fallback covers a session whose
    // terminal was never recorded at all.
    return ctx.sessionTerminals.get(sessionId) ?? sessionTerminalsFor(ctx, server.id)[0];
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

/**
 * The send target for a `session` macro: a terminal of THIS SERVER's session —
 * never `window.activeTerminal`, which may belong to a different host entirely.
 *
 * Whatever this returns is pinned by reference before the prompt walk starts
 * (§8.1). Every await it performs happens BEFORE that pin, never after.
 */
async function resolveServerSessionTarget(
  ctx: CommandContext,
  server: ServerConfig,
  macro: TerminalMacro
): Promise<MacroSendTarget | undefined> {
  const terminals = sessionTerminalsFor(ctx, server.id);
  if (terminals.length === 1) {
    return terminalSendTarget(terminals[0]);
  }
  if (terminals.length > 1) {
    const picked = await vscode.window.showQuickPick(
      terminals.map((terminal, index) => ({ label: terminal.name, description: `Session ${index + 1}`, terminal })),
      { title: `Run "${macro.name}" on which session?` }
    );
    return picked ? terminalSendTarget(picked.terminal) : undefined;
  }

  const choice = await vscode.window.showWarningMessage(
    `"${server.name}" is not connected. Connect now and run "${macro.name}"?`,
    { modal: true },
    "Connect and Run"
  );
  if (choice !== "Connect and Run") {
    return undefined;
  }
  const terminal = await connectAndAwaitSessionTerminal(ctx, server);
  return terminal ? terminalSendTarget(terminal) : undefined;
}

/** Reports a refused token substitution, offering the repair right where the failure is. */
async function reportProfileTokenError(error: ProfileTokenError, server: ServerConfig): Promise<void> {
  const action = await vscode.window.showErrorMessage(error.message, "Edit Server");
  if (action === "Edit Server") {
    // `expandAdvanced` — "IPMI / BMC Host" is an advanced field, so without it
    // the button lands on a form with the field the error named collapsed out
    // of sight.
    await vscode.commands.executeCommand("nexus.server.edit", { server, expandAdvanced: true });
  }
}

/**
 * The server facts `${profile.*}` resolves against: `server`, with `username`
 * replaced by the one a CONNECTION would actually use.
 *
 * REVIEW FINDING (P2) — a server that links an auth profile keeps its own
 * `username` stored underneath the link, and the connect path
 * (`SilentAuthSshFactory.resolveServer`) logs in as the PROFILE's when the
 * profile supplies one. Reading `server.username` here therefore resolved
 * `${profile.username}` to an account the session is not using — silently wrong
 * in exactly the shipped case this token exists for, `ipmitool -U
 * ${profile.username}`, where the two credentials belong to the same appliance.
 * The precedence is not re-derived: `effectiveServerUsername` (models/config.ts)
 * is the same rule the connect path decides by.
 *
 * Only `username` moves. Every other token is the server's own field, and the
 * ORIGINAL `server` is what the refusal path hands to `nexus.server.edit` — the
 * record the user can actually edit. (A profile-supplied username that fails the
 * charset check is therefore reported against the server whose run it refused,
 * with the repair one hop further on, in the linked auth profile; the message
 * names the offending value, which is what identifies it.)
 */
function profileTokenServer(ctx: CommandContext, server: ServerConfig): ServerConfig {
  const profile = server.authProfileId ? ctx.core.getAuthProfile(server.authProfileId) : undefined;
  const username = effectiveServerUsername(server, profile);
  return username === server.username ? server : { ...server, username };
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

  // Profile tokens are resolved FIRST and synchronously: a macro that cannot be
  // resolved against this server must fail before anything is connected, any
  // terminal is created, and any prompt is shown.
  const resolution = resolveProfileTokens(macro.text, tokenServer);
  if (!resolution.ok) {
    await reportProfileTokenError(resolution.error, server);
    return;
  }
  if (resolution.unknownTokens.length > 0) {
    void vscode.window.setStatusBarMessage(
      `Unknown profile token${resolution.unknownTokens.length === 1 ? "" : "s"} sent as-is: ${resolution.unknownTokens
        .map((token) => `\${profile.${token}}`)
        .join(", ")}`,
      6000
    );
  }

  const runTarget = resolveMacroRunTarget(macro);
  let target: MacroSendTarget | undefined;
  switch (runTarget) {
    case "localTerminal":
      target = localTerminalTarget(macro, server);
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
  await runMacroWithTarget({ ...macro, text: resolution.text }, target);
}

export function registerServerMacroCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.server.runMacro", (arg?: unknown) => runMacroOnServer(ctx, arg))
  ];
}
