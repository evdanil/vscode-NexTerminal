/**
 * @author kanekitakitos
 *
 * Domain models for the Local Servers subsystem.
 *
 * A LocalServerConfig describes an arbitrary process (typically a development
 * server, watcher, or long-running worker) that Nexus can start, stop, and
 * monitor from the Connectivity Hub. Unlike SSH targets it runs on the local
 * machine under the current user account; security is therefore enforced at
 * the Workspace Trust boundary — spawning is hard-refused in Restricted Mode.
 *
 * Shapes are additive-only. Every field post-v1 is optional so records written
 * by older builds round-trip cleanly under the whole-object storage discipline
 * (see VscodeConfigRepository: servers and siblings are stored as opaque JSON
 * arrays under a single globalState key).
 */

import type { SessionPtyHandle } from "./config";

export type LocalServerStatus = "stopped" | "starting" | "running" | "stopping" | "failed" | "restarting";

export type LocalServerErrorCode =
  | "ServerAlreadyRunning"
  | "ExecutableNotFound"
  | "SpawnFailed"
  | "PathOutsideScope"
  | "WorkspaceUntrusted"
  | "ServerNotRunning"
  | "InvalidConfiguration"
  | "CwdNotDirectory";

export class LocalServerError extends Error {
  public constructor(
    public readonly code: LocalServerErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "LocalServerError";
  }
}

export interface LocalServerEnvVar {
  key: string;
  value: string;
}

export interface LocalServerConfig {
  id: string;
  name: string;
  group?: string;
  /**
   * Executable path. Accepts bare command names (resolved against $PATH),
   * absolute paths, and workspace-relative paths. Workspace-relative paths
   * are lexical-resolved against workspace roots and rejected if they escape
   * (see resolveLocalServerExecutable in localServerManager).
   */
  executable: string;
  /**
   * Arguments forwarded to the executable. Each entry is a separate argv
   * slot; no shell word-splitting is applied, which avoids the injection
   * surface a naive `executable + " " + args.join(" ")` would open.
   */
  args?: string[];
  /**
   * Working directory for the spawned process. Accepts the same variable
   * expansions Local Shell profiles use (~, ${workspaceFolder}, ${env:...}).
   * Resolved at spawn time (not save time) so workspace relocation does not
   * stale stored values.
   */
  cwd?: string;
  /**
   * Additional environment variables merged over the parent extension-host
   * environment on top. Null/undefined values are explicitly UNSET from the
   * child environment (inherited-variable suppression).
   */
  env?: Record<string, string | null | undefined>;
  /**
   * When true the manager respawns the process after every non-user-initiated
   * exit (crashes, binary updates, OOM kills). Explicit `stop` commands and
   * extension deactivation do NOT trigger auto-restart. Rate-limited with an
   * exponential back-off to avoid fork-bombing a broken binary.
   */
  autoRestart?: boolean;
  /**
   * Upper bound for consecutive auto-restart attempts. Once reached the
   * manager transitions to `failed` and requires a manual `restart` to
   * re-arm. 0 disables the cap (not recommended).
   */
  maxAutoRestarts?: number;
  /**
   * Human-readable description shown in the tree tooltip and the edit form.
   */
  description?: string;
}

export interface ActiveLocalServerSession {
  id: string;
  configId: string;
  terminalName: string;
  status: LocalServerStatus;
  startedAt: number;
  /**
   * Exit code of the most recent run, if the process has ever exited.
   * Undefined while the process is alive or before the first start.
   */
  lastExitCode?: number | null;
  /**
   * Consecutive auto-restart attempts since the last clean exit / manual stop.
   * Reset to 0 on a successful manual start and on any run that stays alive
   * longer than LOCAL_SERVER_STABLE_RUN_MS (see localServerManager).
   */
  restartAttempts: number;
  pty?: SessionPtyHandle;
}

/**
 * Shallow structural clone. LocalServerConfig owns no nested objects beyond
 * `args` (a primitive array), `env` (a string-record), and `group`/`description`
 * string fields; a shallow copy plus array recreation is sufficient for the
 * snapshot discipline NexusCore.applyInventorySyncPlan relies on.
 */
export function cloneLocalServerConfig(config: LocalServerConfig): LocalServerConfig {
  return {
    ...config,
    args: config.args ? [...config.args] : config.args,
    env: config.env ? { ...config.env } : config.env
  };
}

export function localServerConfigsEqual(a: LocalServerConfig, b: LocalServerConfig): boolean {
  if (a.id !== b.id) return false;
  if (a.name !== b.name) return false;
  if (a.group !== b.group) return false;
  if (a.executable !== b.executable) return false;
  if (a.cwd !== b.cwd) return false;
  if (a.autoRestart !== b.autoRestart) return false;
  if (a.maxAutoRestarts !== b.maxAutoRestarts) return false;
  if (a.description !== b.description) return false;
  const aArgs = a.args ?? [];
  const bArgs = b.args ?? [];
  if (aArgs.length !== bArgs.length) return false;
  for (let i = 0; i < aArgs.length; i++) {
    if (aArgs[i] !== bArgs[i]) return false;
  }
  const aEnv = a.env ?? {};
  const bEnv = b.env ?? {};
  const aKeys = Object.keys(aEnv);
  const bKeys = Object.keys(bEnv);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (aEnv[key] !== bEnv[key]) return false;
  }
  return true;
}
