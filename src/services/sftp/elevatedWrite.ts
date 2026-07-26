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

/**
 * Thrown when sudo's own policy check refuses the install outright (sudoers denial).
 * This happens before the target's `cat` redirect ever runs, so the target path is
 * never touched — no partial-write risk, unlike ElevatedInstallFailedError below.
 */
export class SudoNotPermittedError extends Error {
  public constructor(public readonly detail: string) {
    super("Elevation refused: this account is not permitted to run sudo on the remote host.");
    this.name = "SudoNotPermittedError";
  }
}

/**
 * Thrown for install-phase failures with no specific sudo-policy classification: an
 * unrecognized non-zero exit (the `cat` redirect itself may have started and failed
 * partway — disk full, target directory gone, etc.) or the exec channel throwing
 * outright (timeout, dropped connection) before any exit status was even observed.
 * Either way the target may already be partially written.
 */
export class ElevatedInstallFailedError extends Error {
  public constructor(detail: string) {
    super(`Elevated save failed: ${detail}`);
    this.name = "ElevatedInstallFailedError";
  }
}

function assertValidRemotePath(remotePath: string, label: string): void {
  if (!remotePath || !remotePath.startsWith("/")) {
    throw new Error(`Invalid ${label} path: must be a non-empty absolute path`);
  }
}

/** Builds the /tmp staging path for an elevated write. Always /tmp: the target's own directory may itself be root-owned. */
export function buildTempStagePath(token: string): string {
  return `/tmp/.nexus-elevated-${token}`;
}

/**
 * Builds the sudo command that installs the staged temp file over the target path.
 * `cat < temp > target` writes through the target's existing inode when it already
 * exists, so mode, owner, ACLs, SELinux context, and hard links all survive
 * untouched — a umask has no effect on a file the redirect doesn't create.
 *
 * There is deliberately no `[ -e target ]` existence check anymore. An earlier round
 * moved that check from a boolean the caller resolved via a separate `stat` (done
 * before the possibly-slow staging upload — a cross-network race) into `[ -e ]` run
 * inside this same shell, which shrank the window but didn't close it: if the target
 * is deleted or log-rotated away between `[ -e ]` succeeding and the `>` redirect
 * opening the file microseconds later, the redirect creates the file itself under
 * root's *default* umask, so the "exists" branch's no-chmod path never applies and a
 * target that should come back at `createMode` (0600, 0640, ...) can come back 0644.
 * Setting the shell's own umask to `0666 & ~createMode` before the redirect runs
 * closes this for good: umask only ever governs permission bits on a file the
 * redirect *creates*, and has zero effect on one that already exists — there is no
 * longer a branch to race, because there is no longer a branch.
 *
 * Known limitation, intentionally not solved here: umask's own base is 0666, so this
 * can only ever narrow or preserve read/write bits — it can never grant execute. If
 * a target that had mode 0755 is concurrently deleted/rotated away and this recreates
 * it, the file comes back at `createMode` (644 by default) rather than 0755: strictly
 * narrower, never wider, and only in the already-anomalous concurrently-deleted case.
 * Do not "fix" this by resurrecting an existence check — that's exactly the race this
 * replaced.
 *
 * The inner script is escaped once for its own path arguments, then the whole inner
 * script is escaped again as a single argument to `/bin/sh -c`. This second pass is
 * required because `SshConnection.exec` sends this whole string through the remote
 * login shell exactly once before `/bin/sh -c` ever sees it — that outer parse
 * strips one layer of literal quoting, so without the second escape the paths would
 * reach `/bin/sh -c` unquoted (a root command-injection hole for any path containing
 * shell metacharacters, e.g. `;`).
 *
 * `interactive` picks the sudo auth flag: `-S` reads a password from stdin if sudo
 * asks for one; `-n` refuses immediately instead of asking. Defaults to `true` (`-S`)
 * so every existing caller that doesn't pass this argument keeps its prior behavior.
 */
export function buildSudoInstallCommand(tempPath: string, targetPath: string, createMode = 0o644, interactive = true): string {
  assertValidRemotePath(tempPath, "temp");
  assertValidRemotePath(targetPath, "target");
  const temp = shellEscape(tempPath);
  const target = shellEscape(targetPath);
  const umask = (0o666 & ~createMode).toString(8);
  const inner = `(umask ${umask}; cat < ${temp} > ${target})`;
  // -S reads a password from stdin if sudo asks for one; -n refuses immediately
  // instead of asking, which is exactly what makes the no-password attempt below
  // safe to use as its own probe (see runElevatedInstall).
  const authFlag = interactive ? "-S" : "-n";
  return `sudo ${authFlag} -p '' -- /bin/sh -c ${shellEscape(inner)}`;
}

/** Defence in depth: the password should only ever travel over stdin, but a remote
 * PAM module or shell could in principle echo it into stderr. Strip it from any
 * detail string before it reaches an Error that ends up in a showErrorMessage toast. */
function redactPassword(text: string, password?: string): string {
  return password ? text.split(password).join("***") : text;
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

/** Runs the sudo install, piping the password on stdin only — never in the command string or argv. */
export async function runElevatedInstall(
  exec: ElevatedExec,
  args: { tempPath: string; targetPath: string; password?: string; createMode?: number }
): Promise<void> {
  // Whether a password was supplied IS the probe: with none, -n makes sudo refuse
  // up front (before the target is ever touched) instead of asking, so the caller
  // can safely attempt the install non-interactively and treat a password-required
  // failure as "now prompt and retry" rather than needing a separate probe command
  // (see sudoElevationBroker.saveElevated, Codex round 6 finding 2).
  const interactive = args.password !== undefined;
  const command = buildSudoInstallCommand(args.tempPath, args.targetPath, args.createMode, interactive);
  const stdin = interactive ? `${args.password}\n` : undefined;
  let result: ElevatedExecResult;
  try {
    result = await exec(command, stdin);
  } catch (error) {
    // The exec channel itself failed (timeout, dropped connection) before any exit
    // status came back — we can't tell whether the target's cat redirect started.
    throw new ElevatedInstallFailedError(
      redactPassword(error instanceof Error ? error.message : String(error), args.password)
    );
  }
  const failure = classifySudoFailure(result);
  switch (failure.kind) {
    case "none":
      return;
    case "password-required":
      throw new SudoPasswordRequiredError();
    case "not-permitted":
      throw new SudoNotPermittedError(redactPassword(failure.detail, args.password));
    case "no-sudo":
      throw new Error("sudo is not available on the remote host.");
    case "requires-tty":
      throw new Error(
        "The remote sudoers policy requires a TTY (requiretty), so an elevated save can't run over SFTP. " +
        "Ask an admin to add \"Defaults:<username> !requiretty\" for this account, or edit the file from a terminal on the remote host instead."
      );
    case "unknown":
      // Non-interactive (-n) reinterpretation: -n's own semantics mean sudo either
      // succeeds, refuses for a reason we already classified above (sudoers denial,
      // missing sudo), or refuses because it would otherwise have prompted for a
      // password — there is no fourth outcome. So an "unknown" failure on this path
      // can only be the third case, just phrased in stderr our English-only regexes
      // don't recognize (e.g. a non-English sudo/PAM locale — LANG=de_DE, fr_FR,
      // ja_JP, ...). Treating it as password-required is also safe from a
      // partial-write standpoint: -n guarantees sudo refuses before the target's cat
      // redirect ever opens, so the target is guaranteed untouched — unlike a truly
      // unknown interactive failure below, where the redirect may already have run.
      // Do NOT extend this to the interactive (-S, password supplied) path: there an
      // "unknown" failure really is unknown (the redirect may have started), so the
      // partial-write warning stays appropriate.
      if (!interactive) {
        throw new SudoPasswordRequiredError();
      }
      throw new ElevatedInstallFailedError(
        redactPassword(failure.detail, args.password) || `sudo exited with code ${result.exitCode}`
      );
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
