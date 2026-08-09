import * as vscode from "vscode";
import type { AuthProfile, ServerConfig } from "../models/config";
import { authProfileOwnedCredentials, effectiveServerUsername } from "../models/config";
import { authProfilePasswordSecretKey } from "../services/ssh/silentAuth";
import type { ProfileTokenFacts } from "../services/profileTokens";
import type { CommandContext } from "./types";

/**
 * The IPMI credential pathway (issue #48 Phase 3) — shared by the macro run path
 * (`nexus.server.runMacro`) and the direct BMC commands (`bmcCommands.ts`), so
 * there is exactly one implementation of "how does the BMC password reach
 * ipmitool".
 *
 * THE ANSWER IS THE TERMINAL'S ENVIRONMENT, NEVER ARGV. `ipmitool -E` reads the
 * password from `IPMITOOL_PASSWORD`, falling back to `IPMI_PASSWORD`, so the
 * secret never enters the resolved macro text — which means it can never reach
 * `sendText`, the remote `ps` table, the terminal scrollback, or this
 * extension's own `TerminalCaptureBuffer` (and from there `nexus.terminal.copyAll`
 * and the clipboard). An environment variable is readable from
 * `/proc/self/environ` by the same OS user only — the same trust boundary the
 * SSH agent socket already sits on — and it dies with the terminal.
 *
 * BOTH VARIABLES ARE SET. ipmitool checks `IPMITOOL_PASSWORD` first and
 * `IPMI_PASSWORD` second (ipmi_main.c); which one a given build honours has
 * drifted across versions, and setting both costs nothing.
 *
 * WHAT IS ACCEPTED, and stated so it is not mistaken for an oversight: the
 * terminal is a shell the user owns, so anything they run in it can read the
 * variable. That is the deliberate trade — it is what makes the flow auditable
 * — and it is bounded by consent: a macro only gets this environment when its
 * `provideIpmiCredentials` flag was ticked IN THIS INSTALLATION (the flag is
 * stripped on every import path), and a direct command only gets it because the
 * user invoked that command on that server.
 */

/** The env pair `ipmitool -E` reads, in the order ipmitool itself consults them. */
export const IPMI_PASSWORD_ENV_VARS = ["IPMITOOL_PASSWORD", "IPMI_PASSWORD"] as const;

/** The linked IPMI auth profile, or `undefined` for no link / a link to nothing. */
export function ipmiAuthProfile(ctx: CommandContext, server: ServerConfig): AuthProfile | undefined {
  return server.ipmiAuthProfileId ? ctx.core.getAuthProfile(server.ipmiAuthProfileId) : undefined;
}

/**
 * The server facts `${profile.*}` resolves against: `server`, plus the two
 * values that are NOT its own fields.
 *
 * `username` becomes the one a CONNECTION would use — a server that links an
 * auth profile keeps its own `username` stored underneath the link, and the
 * connect path (`SilentAuthSshFactory.resolveServer`) logs in as the PROFILE's
 * where the profile supplies one, so reading `server.username` here would
 * resolve `${profile.username}` to an account the session is not using. The
 * precedence is not re-derived: `effectiveServerUsername` is the same rule the
 * connect path decides by.
 *
 * `ipmiUsername` is the IPMI auth profile's username, through
 * `authProfileOwnedCredentials`' "usable value" discipline — so a blank or
 * whitespace username (reachable through a backup import; `validateAuthProfile`
 * only checks length) reads as ABSENT and produces the typed `missing` refusal,
 * rather than an `ipmitool -U  -E` with an empty argument.
 *
 * Everything else is the server's own field, and the ORIGINAL `server` is what
 * a refusal hands to `nexus.server.edit` — the record the user can actually
 * edit.
 */
export type ProfileTokenServer = ServerConfig & Pick<ProfileTokenFacts, "ipmiUsername">;

export function profileTokenServer(ctx: CommandContext, server: ServerConfig): ProfileTokenServer {
  const profile = server.authProfileId ? ctx.core.getAuthProfile(server.authProfileId) : undefined;
  const username = effectiveServerUsername(server, profile);
  const ipmiUsername = authProfileOwnedCredentials(ipmiAuthProfile(ctx, server)).username;
  if (username === server.username && ipmiUsername === undefined) {
    return server;
  }
  return { ...server, username, ipmiUsername };
}

/**
 * How a credential request ended. `cancelled` is a real outcome and must abort
 * the run: the caller asked for a terminal that can authenticate, and one
 * without the variable is not that — `ipmitool -E` would sit there prompting, or
 * fail, in a terminal the user did not ask for.
 */
export type IpmiCredentialOutcome =
  | { kind: "env"; env: Record<string, string> }
  | { kind: "cancelled" };

/**
 * Resolves the BMC password and returns it as the terminal environment to spawn
 * with. NEVER call this without having established consent first (a macro's
 * `macroProvidesIpmiCredentials()`, or the user invoking a BMC command): the
 * prompt below is itself a disclosure decision — a user trained to type the BMC
 * password into whatever box a macro raises is exactly the phishing shape the
 * opt-in exists to prevent — so "prompt, then decide" is not a safe ordering.
 *
 * The stored secret is preferred; the masked prompt is the fallback for a server
 * with no IPMI profile linked, a profile with no stored password, or a vault
 * that is unavailable. The answer is never remembered and never persisted
 * (`macroVariablePrompt.ts`'s discipline for secret variables).
 */
export async function resolveIpmiTerminalEnv(
  ctx: CommandContext,
  server: ServerConfig,
  options: { purpose: string } = { purpose: "IPMI" }
): Promise<IpmiCredentialOutcome> {
  let password: string | undefined;
  const profileId = server.ipmiAuthProfileId;
  if (profileId && ctx.secretVault) {
    try {
      password = await ctx.secretVault.get(authProfilePasswordSecretKey(profileId));
    } catch {
      // A vault read that fails is "no stored password", not a failed run: the
      // masked prompt below still gets the user to a working terminal.
      password = undefined;
    }
  }

  if (!password) {
    const profileName = ipmiAuthProfile(ctx, server)?.name;
    password = await vscode.window.showInputBox({
      title: `${options.purpose} password for "${server.name}"`,
      prompt: profileName
        ? `No password is stored for the "${profileName}" auth profile. It is used for this run only — never saved.`
        : "Used for this run only — never saved. Link an IPMI auth profile in the server form to store it.",
      password: true,
      ignoreFocusOut: true
    });
    if (!password) {
      // ESC, or an empty box: both mean "do not do this", and an empty
      // IPMITOOL_PASSWORD is its own failure mode rather than a neutral one.
      return { kind: "cancelled" };
    }
  }

  const env: Record<string, string> = {};
  for (const name of IPMI_PASSWORD_ENV_VARS) {
    env[name] = password;
  }
  return { kind: "env", env };
}
