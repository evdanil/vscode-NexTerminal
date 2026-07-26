import { shellEscape } from "../../utils/shellEscape";

/** Result of a single command run over the elevated (sudo) exec channel. */
export interface ElevatedExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a remote command over an SSH exec channel, optionally piping stdin (used for the sudo password). */
export type ElevatedExec = (command: string, stdin?: string) => Promise<ElevatedExecResult>;

export type SudoFailure =
  | { kind: "none" }
  | { kind: "password-required" }
  | { kind: "not-permitted"; detail: string }
  | { kind: "no-sudo"; detail: string }
  | { kind: "requires-tty"; detail: string }
  | { kind: "unknown"; detail: string };

// Mirrors the same SFTP status code sftpService.ts defines as SSH_FX_PERMISSION_DENIED.
// Duplicated (not imported) to keep this module's only dependency on shellEscape and
// avoid a circular import — sftpService.ts imports from this module, not the reverse.
const SSH_FX_PERMISSION_DENIED = 3;

const PASSWORD_REQUIRED_RE = /password is required|no password was supplied|sorry, try again|incorrect password/i;
const NOT_PERMITTED_RE = /is not in the sudoers file|not allowed to execute/i;
const NO_SUDO_RE = /command not found|sudo: not found/i;
const REQUIRES_TTY_RE = /no tty present|requires a tty|must have a tty/i;

/** Thrown by runElevatedInstall when sudo needs a password that was missing, empty, or rejected. */
export class SudoPasswordRequiredError extends Error {
  public constructor() {
    super("sudo requires a password to complete this elevated save.");
    this.name = "SudoPasswordRequiredError";
  }
}

function assertValidRemotePath(remotePath: string, label: string): void {
  if (!remotePath || !remotePath.startsWith("/")) {
    throw new Error(`Invalid ${label} path: must be a non-empty absolute path`);
  }
}

/** Builds the /tmp staging path for an elevated write. Always /tmp: the target's own directory may itself be root-owned. */
export function buildTempStagePath(remotePath: string, token: string): string {
  return `/tmp/.nexus-elevated-${token}`;
}

/**
 * Builds the sudo command that installs the staged temp file over the target path.
 * `cat < temp > target` writes through the target's existing inode when it already
 * exists, so mode, owner, ACLs, and hard links survive; a brand new file has no
 * inode to preserve, so it is chmod'd 644 afterward.
 *
 * The inner `cat` script is escaped once for its own path arguments, then the whole
 * inner script is escaped again as a single argument to `/bin/sh -c`. This second
 * pass is required because `SshConnection.exec` sends this whole string through the
 * remote login shell exactly once before `/bin/sh -c` ever sees it — that outer
 * parse strips one layer of literal quoting, so without the second escape the paths
 * would reach `/bin/sh -c` unquoted (a root command-injection hole for any path
 * containing shell metacharacters, e.g. `;`).
 */
export function buildSudoInstallCommand(tempPath: string, targetPath: string, targetExists: boolean): string {
  assertValidRemotePath(tempPath, "temp");
  assertValidRemotePath(targetPath, "target");
  const temp = shellEscape(tempPath);
  const target = shellEscape(targetPath);
  const inner = targetExists
    ? `cat < ${temp} > ${target}`
    : `cat < ${temp} > ${target} && chmod 644 ${target}`;
  return `sudo -S -p '' -- /bin/sh -c ${shellEscape(inner)}`;
}

/** Classifies a completed sudo invocation's result by matching known sudo/PAM stderr phrasing. */
export function classifySudoFailure(result: ElevatedExecResult): SudoFailure {
  if (result.exitCode === 0) {
    return { kind: "none" };
  }
  const stderr = result.stderr;
  if (PASSWORD_REQUIRED_RE.test(stderr)) {
    return { kind: "password-required" };
  }
  if (NOT_PERMITTED_RE.test(stderr)) {
    return { kind: "not-permitted", detail: stderr.trim() };
  }
  if (NO_SUDO_RE.test(stderr)) {
    return { kind: "no-sudo", detail: stderr.trim() };
  }
  if (REQUIRES_TTY_RE.test(stderr)) {
    return { kind: "requires-tty", detail: stderr.trim() };
  }
  return { kind: "unknown", detail: stderr.trim() };
}

/**
 * Runs `sudo -n -v` to check whether elevation is possible without prompting for a
 * password. An unrecognized non-zero exit is treated as password-required rather
 * than unknown: stderr wording varies by locale/distro, and password-required is
 * the correct retryable guess for a failing non-interactive probe.
 */
export async function probeSudoNonInteractive(exec: ElevatedExec): Promise<SudoFailure> {
  const result = await exec("sudo -n -v");
  const failure = classifySudoFailure(result);
  return failure.kind === "unknown" ? { kind: "password-required" } : failure;
}

/** Runs the sudo install, piping the password on stdin only — never in the command string or argv. */
export async function runElevatedInstall(
  exec: ElevatedExec,
  args: { tempPath: string; targetPath: string; targetExists: boolean; password?: string }
): Promise<void> {
  const command = buildSudoInstallCommand(args.tempPath, args.targetPath, args.targetExists);
  const stdin = args.password ? `${args.password}\n` : undefined;
  const result = await exec(command, stdin);
  const failure = classifySudoFailure(result);
  switch (failure.kind) {
    case "none":
      return;
    case "password-required":
      throw new SudoPasswordRequiredError();
    case "not-permitted":
      throw new Error("Elevation refused: this account is not permitted to run sudo on the remote host.");
    case "no-sudo":
      throw new Error("sudo is not available on the remote host.");
    case "requires-tty":
      throw new Error(
        "The remote sudoers policy requires a TTY (requiretty). Elevated save is not possible over SFTP."
      );
    case "unknown":
      throw new Error(`Elevated save failed: ${failure.detail || "sudo exited with code " + result.exitCode}`);
  }
}

/** Detects an SFTP/SSH permission-denied error by status code or message text. Mirrors isMissingPathError's style. */
export function isPermissionDeniedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: number | string; message?: string };
  if (candidate.code === SSH_FX_PERMISSION_DENIED || candidate.code === "EACCES") {
    return true;
  }
  return typeof candidate.message === "string" && /permission denied/i.test(candidate.message);
}
