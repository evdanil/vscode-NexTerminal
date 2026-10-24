import { readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { SshAgentUnavailableError } from "./authErrors";

/**
 * Which SSH agent answers an SSH Agent login (`nexus.ssh.agent`).
 *
 * Windows has no `SSH_AUTH_SOCK` by default, so passing the environment
 * through — all Nexus used to do — offered no agent at all: the login fell
 * through to keyboard-interactive where the server offered it, and otherwise
 * failed with ssh2's "All configured authentication methods failed". The two
 * Windows agents are found where they listen instead:
 *
 * - PuTTY's Pageant (0.75 or newer) on a per-user named pipe
 *   `\\.\pipe\pageant.<user>.<hash>` speaking the OpenSSH agent protocol. The
 *   hash comes from per-user key material and can change across reboots, so
 *   it cannot be configured once — it is looked up on every connect. ssh2's own
 *   `"pageant"` agent is never used: it spawns a `pagent.exe` helper that is
 *   not shipped in the bundle.
 * - The Windows OpenSSH Authentication Agent service on
 *   `\\.\pipe\openssh-ssh-agent`.
 *
 * Explicit modes never fall back to another agent: signing with an agent the
 * user did not choose is worse than a clear refusal.
 */
export type SshAgentMode = "auto" | "pageant" | "openssh" | "custom";
export type SshAgentSource = "env" | "pageant" | "openssh" | "custom";

export interface SshAgentLookup {
  readonly platform: NodeJS.Platform;
  readonly env: { readonly [name: string]: string | undefined };
  readonly mode: SshAgentMode;
  readonly customPath: string;
  /** The Windows user name Pageant puts in its pipe name. */
  readonly username: string;
  /** Names in `\\.\pipe\`; only ever called on Windows. */
  readonly listPipes: () => readonly string[];
}

export interface SshAgentChoice {
  /** Socket path or named pipe, as ssh2's `createAgent` takes it. */
  readonly agent: string;
  readonly source: SshAgentSource;
  /** Why this agent, for the Nexus SSH output channel. */
  readonly note: string;
  /**
   * Set when the choice is a guess: the pipe list could not be read, so the
   * OpenSSH pipe is tried blind. Nothing listening there then means no agent
   * was found — this error, which lets the login carry on without one — not a
   * broken agent to refuse the login over.
   */
  readonly ifUnreachable?: SshAgentUnavailableError;
}

/** The trailing backslash is required: without it Node fails to list (ENOTDIR). */
const WINDOWS_PIPE_DIRECTORY = "\\\\.\\pipe\\";
const OPENSSH_AGENT_PIPE_NAME = "openssh-ssh-agent";
export const OPENSSH_AGENT_PIPE = `${WINDOWS_PIPE_DIRECTORY}${OPENSSH_AGENT_PIPE_NAME}`;

/** ssh2 reads this exact value as "spawn pagent.exe", which is not shipped. */
const SSH2_PAGEANT_SENTINEL = "pageant";

const SSH_AGENT_MODES: ReadonlySet<string> = new Set<SshAgentMode>(["auto", "pageant", "openssh", "custom"]);

export const SSH_AGENT_SOURCE_LABELS: Readonly<Record<SshAgentSource, string>> = {
  env: "SSH_AUTH_SOCK",
  pageant: "Pageant",
  openssh: "OpenSSH Authentication Agent",
  custom: "nexus.ssh.agentPath"
};

// The OpenSSH pipe is not the service's alone: other agents, such as
// 1Password's, serve the same `\\.\pipe\openssh-ssh-agent`, so the remedies
// name them too.
const NO_AGENT_ON_WINDOWS =
  "No SSH agent found. Start Pageant (PuTTY 0.75 or newer), or the OpenSSH Authentication Agent service or another agent that provides its pipe (e.g. 1Password), or set nexus.ssh.agent to custom and enter the agent's pipe.";
const NO_SSH_AUTH_SOCK =
  "SSH_AUTH_SOCK is not set for VS Code, so there is no SSH agent to use. Start VS Code from a shell where your agent runs, or set nexus.ssh.agent to custom and enter the agent's socket path.";
const PAGEANT_NOT_RUNNING =
  "Pageant is not running, or it is older than 0.75 and has no named pipe. Start Pageant (0.75 or newer) or change nexus.ssh.agent.";
const OPENSSH_AGENT_NOT_RUNNING =
  "Nothing is listening on the OpenSSH agent pipe (\\\\.\\pipe\\openssh-ssh-agent). Start the OpenSSH Authentication Agent service from Services, or another agent that provides this pipe (e.g. 1Password), or change nexus.ssh.agent.";
const CUSTOM_PATH_EMPTY =
  "nexus.ssh.agent is custom but nexus.ssh.agentPath is empty. Enter the agent's socket or pipe in nexus.ssh.agentPath, or set nexus.ssh.agent to auto.";
const CUSTOM_PATH_PAGEANT =
  'nexus.ssh.agentPath is "pageant", which Nexus cannot use. To use Pageant, set nexus.ssh.agent to pageant.';

const UNUSABLE_REMEDIES: Readonly<Record<SshAgentSource, string>> = {
  // Restarting an agent usually gives it a new socket, which VS Code's
  // environment will not see — so the remedy is the environment itself.
  env: "Start VS Code from a shell where your agent runs, or set nexus.ssh.agent to custom and enter the agent's socket path.",
  pageant: "Restart Pageant and connect again.",
  openssh: "Restart the OpenSSH Authentication Agent service, or the other agent that provides this pipe (e.g. 1Password), and connect again.",
  custom: "Check nexus.ssh.agentPath and that the agent is running, then connect again."
};

export function toSshAgentMode(value: unknown): SshAgentMode {
  return typeof value === "string" && SSH_AGENT_MODES.has(value) ? (value as SshAgentMode) : "auto";
}

export function listWindowsPipes(): string[] {
  return readdirSync(WINDOWS_PIPE_DIRECTORY);
}

/** This machine's lookup for the given settings. */
export function hostSshAgentLookup(settings: { mode: SshAgentMode; customPath: string }): SshAgentLookup {
  let username = "";
  try {
    username = userInfo().username;
  } catch {
    // No account entry for this process: no Pageant pipe can be matched.
  }
  return { ...settings, platform: process.platform, env: process.env, username, listPipes: listWindowsPipes };
}

export function sshAgentUnusableMessage(choice: SshAgentChoice, failure: unknown): string {
  const detail = failure instanceof Error ? failure.message : String(failure);
  return `Could not use the SSH agent at ${choice.agent} (${SSH_AGENT_SOURCE_LABELS[choice.source]}): ${detail}. ${UNUSABLE_REMEDIES[choice.source]}`;
}

export function sshAgentHoldsNoKeysMessage(choice: SshAgentChoice): string {
  // A locked OpenSSH agent also lists no keys, and unlocking is its remedy.
  return `The SSH agent at ${choice.agent} (${SSH_AGENT_SOURCE_LABELS[choice.source]}) holds no keys. Add your key in Pageant (Add Key) or with ssh-add, or unlock the agent (ssh-add -X), then connect again.`;
}

/** The agent for `lookup`, or an `SshAgentUnavailableError` whose message is the remedy. */
export function resolveSshAgent(lookup: SshAgentLookup): SshAgentChoice {
  const windows = lookup.platform === "win32";
  switch (lookup.mode) {
    case "custom": {
      const agent = lookup.customPath.trim();
      if (!agent) {
        throw new SshAgentUnavailableError(CUSTOM_PATH_EMPTY);
      }
      if (windows && agent === SSH2_PAGEANT_SENTINEL) {
        throw new SshAgentUnavailableError(CUSTOM_PATH_PAGEANT);
      }
      return { agent, source: "custom", note: "nexus.ssh.agent is custom" };
    }
    case "pageant":
    case "openssh": {
      if (!windows) {
        throw new SshAgentUnavailableError(
          `nexus.ssh.agent is ${lookup.mode}, which is Windows-only. On this system use auto (SSH_AUTH_SOCK) or custom.`
        );
      }
      return lookup.mode === "pageant" ? explicitPageant(lookup) : explicitOpenSsh(lookup);
    }
    case "auto":
      return autoAgent(lookup, windows);
  }
}

function autoAgent(lookup: SshAgentLookup, windows: boolean): SshAgentChoice {
  const fromEnv = lookup.env.SSH_AUTH_SOCK ?? "";
  const envIsPageantSentinel = windows && fromEnv === SSH2_PAGEANT_SENTINEL;
  if (fromEnv && !envIsPageantSentinel) {
    return { agent: fromEnv, source: "env", note: "auto; from SSH_AUTH_SOCK" };
  }
  if (!windows) {
    throw new SshAgentUnavailableError(NO_SSH_AUTH_SOCK, { proceedWithoutAgent: true });
  }

  const why = envIsPageantSentinel
    ? 'auto; SSH_AUTH_SOCK is "pageant", which Nexus cannot use, so it was ignored'
    : "auto; SSH_AUTH_SOCK unset";
  let names: readonly string[];
  try {
    names = lookup.listPipes();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      agent: OPENSSH_AGENT_PIPE,
      source: "openssh",
      note: `${why}; the named-pipe list could not be read (${reason}), so Pageant was not looked for`,
      ifUnreachable: new SshAgentUnavailableError(NO_AGENT_ON_WINDOWS, { proceedWithoutAgent: true })
    };
  }

  const opensshRunning = hasOpenSshPipe(names);
  const pageant = findPageant(names, lookup.username);
  if (pageant.pipe) {
    const other = opensshRunning
      ? "; the OpenSSH agent is running too — set nexus.ssh.agent to openssh to use it instead"
      : "";
    return { agent: pageant.pipe, source: "pageant", note: `${why}${other}` };
  }
  if (opensshRunning) {
    const skipped =
      pageant.others.length > 0
        ? `Pageant is running for ${owners(pageant.others)}, not "${lookup.username}", so it was not used`
        : `no Pageant pipe for ${lookup.username}`;
    return { agent: OPENSSH_AGENT_PIPE, source: "openssh", note: `${why}; ${skipped}` };
  }
  const message =
    pageant.others.length > 0
      ? pageantForAnotherUser(pageant.others, lookup.username, "start your own Pageant (0.75 or newer) or the OpenSSH Authentication Agent service")
      : NO_AGENT_ON_WINDOWS;
  throw new SshAgentUnavailableError(message, { proceedWithoutAgent: true });
}

function explicitPageant(lookup: SshAgentLookup): SshAgentChoice {
  let names: readonly string[];
  try {
    names = lookup.listPipes();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SshAgentUnavailableError(
      `Could not look for Pageant: the named-pipe list could not be read (${reason}). Set nexus.ssh.agent to custom and enter Pageant's pipe.`,
      { cause: error }
    );
  }
  const pageant = findPageant(names, lookup.username);
  if (!pageant.pipe) {
    throw new SshAgentUnavailableError(
      pageant.others.length > 0
        ? pageantForAnotherUser(pageant.others, lookup.username, "start your own Pageant (0.75 or newer) or change nexus.ssh.agent")
        : PAGEANT_NOT_RUNNING
    );
  }
  return { agent: pageant.pipe, source: "pageant", note: "nexus.ssh.agent is pageant" };
}

function explicitOpenSsh(lookup: SshAgentLookup): SshAgentChoice {
  let names: readonly string[];
  try {
    names = lookup.listPipes();
  } catch (error) {
    // The pipe's name is fixed, so an unreadable list does not stop the
    // attempt: the pre-flight key check says whether anything answers there.
    const reason = error instanceof Error ? error.message : String(error);
    return { agent: OPENSSH_AGENT_PIPE, source: "openssh", note: `nexus.ssh.agent is openssh; the named-pipe list could not be read (${reason})` };
  }
  if (!hasOpenSshPipe(names)) {
    throw new SshAgentUnavailableError(OPENSSH_AGENT_NOT_RUNNING);
  }
  return { agent: OPENSSH_AGENT_PIPE, source: "openssh", note: "nexus.ssh.agent is openssh" };
}

function hasOpenSshPipe(names: readonly string[]): boolean {
  return names.some((name) => name.toLowerCase() === OPENSSH_AGENT_PIPE_NAME);
}

const PAGEANT_PIPE_PREFIX = "pageant.";

/**
 * The user name in a Pageant pipe name `pageant.<user>.<hash>`, or undefined
 * for anything else. The hash is the last dot-separated part (it is hex, so it
 * has no dot of its own) and must be there; its length and alphabet are not
 * assumed. The user name may itself contain dots ("john.smith").
 */
function pageantPipeOwner(name: string): string | undefined {
  if (!name.toLowerCase().startsWith(PAGEANT_PIPE_PREFIX)) {
    return undefined;
  }
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= PAGEANT_PIPE_PREFIX.length || lastDot === name.length - 1) {
    return undefined;
  }
  return name.slice(PAGEANT_PIPE_PREFIX.length, lastDot);
}

/**
 * This user's Pageant pipe, and the Pageant pipes of other user names. Only a
 * pipe whose whole user part equals this account's name (case-insensitively,
 * as Windows compares them) is ever used — user "alice" never gets the pipe of
 * "alice.bob" or "alice2". Two of this user's pipes — two Pageants, or one
 * left behind by another session — are refused rather than one picked: either
 * could be the wrong keys.
 *
 * Another name's pipe may still be this user's own Pageant: PuTTY names the
 * pipe after the user principal name's prefix where Windows has one (domain,
 * Microsoft and Entra accounts), while Node reports the account's SAM name.
 * Whether such a pipe would even let this user in depends on its access rules,
 * which have not been checked on Windows, so it is reported, never used.
 */
function findPageant(names: readonly string[], username: string): { pipe?: string; others: readonly string[] } {
  const mine: string[] = [];
  const others: string[] = [];
  for (const name of names) {
    const owner = pageantPipeOwner(name);
    if (owner !== undefined) {
      (owner.toLowerCase() === username.toLowerCase() ? mine : others).push(name);
    }
  }
  if (mine.length > 1) {
    throw new SshAgentUnavailableError(
      `${mine.length} Pageant pipes are open for ${username}, so Nexus cannot tell which Pageant to use. Close the extra Pageant, or set nexus.ssh.agent to custom and enter the pipe to use.`
    );
  }
  return { ...(mine.length === 1 && { pipe: `${WINDOWS_PIPE_DIRECTORY}${mine[0]}` }), others };
}

function owners(pipes: readonly string[]): string {
  const names = pipes.map((name) => `"${pageantPipeOwner(name)}"`).join(", ");
  return `${pipes.length === 1 ? "user" : "users"} ${names}`;
}

function pageantForAnotherUser(pipes: readonly string[], username: string, otherwise: string): string {
  const paths = pipes.map((name) => `${WINDOWS_PIPE_DIRECTORY}${name}`).join(", ");
  const yours = pipes.length === 1 ? "that Pageant is yours, set nexus.ssh.agent to custom and enter that pipe" : "one of them is yours, set nexus.ssh.agent to custom and enter its pipe";
  return `Pageant is running for ${owners(pipes)}, but this Windows account is "${username}", so Nexus did not use it: ${paths}. If ${yours} (its name can change when Windows restarts); if not, ${otherwise}.`;
}
