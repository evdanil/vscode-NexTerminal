import * as vscode from "vscode";
import type { ServerConfig } from "../models/config";
import { resolveBmcWebProtocol } from "../models/config";
import { resolveProfileTokens } from "../services/profileTokens";
import type { TerminalMacro } from "../models/terminalMacro";
import { profileTokenServer, resolveIpmiTerminalEnv } from "./ipmiCredentials";
import {
  openServerAdvancedEdit,
  reportProfileTokenError,
  resolveIpmiGatewayServer,
  resolveMacroBrowserUrl,
  resolveServerSessionTarget
} from "./serverMacroCommands";
import { pickServer, toServerFromArg } from "./serverCommands";
import type { CommandContext } from "./types";

/**
 * The two one-click BMC actions on a server (issue #48 §3.6) — the operations
 * everyone performs, without going through the macro picker to perform them.
 *
 * NOTHING HERE IS A SECOND IMPLEMENTATION. Both commands are the shipped IPMI
 * templates' own flow with the picker removed: the same `${profile.…}`
 * substitution chokepoint (so a hostile synced `ipmiHost` is refused here
 * exactly as it is in a macro run), the same typed refusals with the same Edit
 * Server route, and the same credential pathway (`resolveIpmiTerminalEnv` —
 * environment, never argv).
 *
 * CONSENT: THE COMMAND *IS* THE CONSENT. `TerminalMacro.provideIpmiCredentials`
 * exists because a stored macro RECORD can arrive from elsewhere carrying a
 * pre-armed capability; a command invocation cannot. Picking "Connect BMC Serial
 * Console" on a specific server, in this installation, right now, is a stronger
 * consent signal than a checkbox ticked once — and there is no record here to
 * import, share or restore, so `IMPORTED_CAPABILITY_FIELDS` and its reasoning
 * are untouched and unaffected by these commands.
 *
 * MENU PLACEMENT: unconditional on server items, like "Run Macro on Server…".
 * Hiding the entry on a server with no BMC configured would mean encoding IPMI
 * state into the tree item's `contextValue`, which ~15 anchored `when` regexes
 * match against (the B5 constraint in ui/nexusTreeProvider.ts). The standing
 * rule is "pickers flag, menus don't hide", so an unconfigured server gets an
 * actionable refusal naming the field and where to set it.
 */

/**
 * The SOL command line, in the shipped template's exact shape — `-E` (read the
 * password from the environment) and no `-P`, so the secret never touches argv,
 * the scrollback, or `TerminalCaptureBuffer`.
 *
 * The leading space is deliberate and matches the shipped templates: it keeps
 * the line out of shell history under `HISTCONTROL=ignorespace`. The trailing
 * newline executes it — this command's whole purpose is to be one click.
 */
export const BMC_SOL_COMMAND =
  " ipmitool -I lanplus -H ${profile.ipmiHost} -U ${profile.ipmiUsername} -E sol activate\n";

/**
 * The SOL command line for the GATEWAY path (issue #48 PR-C, §3.6). `-a` instead
 * of `-E`: env injection cannot cross to a remote shell, so ipmitool prompts for
 * the password itself on the bastion tty (no echo, nothing stored) — the same
 * shape as the shipped "IPMI SOL (via jump host)" template. NO `-E`, NO `-P`, and
 * nothing about the secret ever reaches this string, so the §3.5 no-secret-in-
 * `sendText` invariant holds on this path by construction.
 */
export const BMC_SOL_COMMAND_GATEWAY =
  " ipmitool -I lanplus -H ${profile.ipmiHost} -U ${profile.ipmiUsername} -a sol activate\n";

/**
 * The web-console URL template. The scheme is chosen by the server's
 * `bmcWebProtocol` through `resolveBmcWebProtocol()` and interpolated as one of
 * TWO known literals — never the stored string itself, which would let an
 * imported record pick the scheme outright.
 *
 * Built as a token template and run through `resolveProfileTokens` in URL form
 * rather than string-concatenated, which buys three things the concatenation
 * would each have to re-implement: the address charset check, the typed "not
 * set" refusal, and IPv6 bracketing of the authority (`fe80::1` →
 * `https://[fe80::1]/`, without which `new URL()` reads the address's colons as
 * a port).
 */
export function bmcWebConsoleTemplate(server: Pick<ServerConfig, "bmcWebProtocol">): string {
  return `${resolveBmcWebProtocol(server)}://\${profile.ipmiHost}/`;
}

/** The server this invocation is aimed at: the tree item's, or the one the user picks. */
async function resolveTargetServer(ctx: CommandContext, arg?: unknown): Promise<ServerConfig | undefined> {
  return toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
}

/**
 * `nexus.server.connectBmcSol` — "Connect BMC Serial Console".
 *
 * Order of operations matters and mirrors the macro path's: the command line is
 * resolved (and can be refused) BEFORE any credential is read or prompted for
 * and before any terminal exists, so a server missing its IPMI host or auth
 * profile costs the user one error message and nothing else.
 */
export async function connectBmcSol(ctx: CommandContext, arg?: unknown): Promise<void> {
  const server = await resolveTargetServer(ctx, arg);
  if (!server) {
    return;
  }

  // JUMP-HOST IPMI ROUTING (issue #48 PR-C, §3.6). When the target names a
  // reachable IPMI gateway, this command honors it exactly as a
  // `route: "ipmiGateway"` macro does — no opt-in flag question arises, because
  // the command has no independent identity to carry one on, and choosing it
  // against a gateway-configured server IS the request to reach that BMC by its
  // configured route. Env injection cannot cross to the gateway shell, so the
  // `-a` form is used (ipmitool prompts on the bastion) and NO credential is read
  // or prompted for here — the §3.5 no-secret invariant holds by construction.
  const gateway = resolveIpmiGatewayServer(ctx, server);
  if (gateway) {
    const routed = resolveProfileTokens(BMC_SOL_COMMAND_GATEWAY, profileTokenServer(ctx, server), { form: "command" });
    if (!routed.ok) {
      await reportProfileTokenError(routed.error, server, { subject: "Connect BMC Serial Console", outcome: "run" });
      return;
    }
    // The same routing step a macro takes — deliver into a session terminal of
    // the gateway (connect-first confirm, connect-failed/timeout split, pinned
    // target all carried over), no macro picker. `send` is the terminal's own
    // `sendText(text, false)`; the command's trailing newline executes it.
    const target = await resolveServerSessionTarget(ctx, gateway, { name: "BMC Serial Console" } as TerminalMacro);
    if (!target) {
      return;
    }
    await target.send(routed.text);
    return;
  }

  const resolution = resolveProfileTokens(BMC_SOL_COMMAND, profileTokenServer(ctx, server), { form: "command" });
  if (!resolution.ok) {
    // Subject-phrased: a menu click has no macro, so the refusal names the command
    // that needed the field, not "this macro" (C1).
    await reportProfileTokenError(resolution.error, server, { subject: "Connect BMC Serial Console", outcome: "run" });
    return;
  }

  // D2 — the same vault password the macro path titles "IPMI password for …";
  // the field family is "IPMI", so both prompts use it rather than drifting to "BMC".
  const credential = await resolveIpmiTerminalEnv(ctx, server, { purpose: "IPMI" });
  if (credential.kind === "cancelled") {
    vscode.window.setStatusBarMessage(`BMC console for "${server.name}" cancelled — nothing was run.`, 4000);
    return;
  }

  const terminal = vscode.window.createTerminal({
    name: `Nexus BMC: ${server.name}`,
    env: credential.env
  });
  terminal.show();
  // `false`: the template's own trailing newline is what executes the line —
  // the same contract every macro send here honours.
  terminal.sendText(resolution.text, false);
}

/**
 * `nexus.server.openBmcWebConsole` — "Open BMC Web Console".
 *
 * No auto-login (manufacturer-specific, and explicitly not wanted), no tunnel:
 * this opens the BMC's own address in the user's browser, which is also why it
 * has none of the certificate-mismatch and absolute-redirect problems a tunnelled
 * console would.
 */
export async function openBmcWebConsole(ctx: CommandContext, arg?: unknown): Promise<void> {
  const server = await resolveTargetServer(ctx, arg);
  if (!server) {
    return;
  }

  const resolution = resolveProfileTokens(bmcWebConsoleTemplate(server), profileTokenServer(ctx, server), {
    form: "url"
  });
  if (!resolution.ok) {
    await reportProfileTokenError(resolution.error, server, { subject: "Open BMC Web Console", outcome: "opened" });
    return;
  }

  // The same http/https whitelist every browser macro passes, asked of the
  // finished URL rather than assumed from the template: `${profile.ipmiHost}`
  // has already been charset-checked, and this is the second, structural check
  // that what came out is a URL an external open may be handed.
  const url = resolveMacroBrowserUrl(resolution.text);
  if (!url) {
    // C5 — every missing-piece BMC error carries the same Edit Server (Advanced
    // expanded) repair the token refusals do; the message already names the field.
    const action = await vscode.window.showErrorMessage(
      `The IPMI / BMC Host of "${server.name}" does not form a usable web address. Check it under Advanced options in the server form. Nothing was opened.`,
      "Edit Server"
    );
    if (action === "Edit Server") {
      await openServerAdvancedEdit(server);
    }
    return;
  }

  const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
  if (!opened) {
    // `openExternal` resolving `false` is a real outcome (no handler, or the
    // user dismissed the trust prompt) and must never be reported as a success.
    void vscode.window.showWarningMessage(`Could not open the BMC web console for "${server.name}".`);
  }
}

export function registerBmcCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.server.connectBmcSol", (arg?: unknown) => connectBmcSol(ctx, arg)),
    vscode.commands.registerCommand("nexus.server.openBmcWebConsole", (arg?: unknown) => openBmcWebConsole(ctx, arg))
  ];
}
