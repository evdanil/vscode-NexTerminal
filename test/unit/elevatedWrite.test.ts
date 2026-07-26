import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellEscape } from "../../src/utils/shellEscape";
import {
  buildSudoInstallCommand,
  buildTempStagePath,
  classifySudoFailure,
  ElevatedInstallFailedError,
  isPermissionDeniedError,
  runElevatedInstall,
  SudoNotPermittedError,
  SudoPasswordRequiredError,
} from "../../src/services/sftp/elevatedWrite";

describe("buildTempStagePath", () => {
  it("stages in /tmp keyed only by the random token", () => {
    expect(buildTempStagePath("abc123")).toBe("/tmp/.nexus-elevated-abc123");
  });
});

describe("buildSudoInstallCommand", () => {
  // History: round 3 (Codex finding 1) moved the existence check from a boolean the
  // caller resolved via a separate `stat` (done before the possibly-slow staging
  // upload) into `[ -e target ]` run inside this same sudo shell, closing the
  // cross-network race. Round 4 finding A found that the moved check still races,
  // just over a much smaller window: if the target is deleted/rotated away between
  // `[ -e ]` succeeding and the `>` redirect opening the file microseconds later, the
  // redirect creates the file itself under root's *default* umask — so a target that
  // should come back at a narrow createMode (0600, 0640, ...) can come back 0644.
  // The fix removes the existence check entirely: the shell's umask is set to
  // `0666 & ~createMode` before the redirect runs. umask only ever affects a file
  // the redirect *creates* and has zero effect on a file that already exists, so
  // there is no branch left to race. buildSudoInstallCommand still never takes a
  // targetExists argument (removed in round 3).

  it("does not perform any existence check — umask alone decides the outcome, closing the round-4 race window", () => {
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/hosts");
    expect(cmd).not.toContain("[ -e");
    expect(cmd).not.toContain("if ");
    expect(cmd).not.toContain("chmod");
  });

  it("sets the shell umask derived from the default createMode (644) when none is given", () => {
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/new.conf");
    expect(cmd).toContain("umask 22");
  });

  it("sets the shell umask derived from the caller-supplied createMode instead of the default (P3: preserves a vanished target's prior mode)", () => {
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/rotated.log", 0o640);
    expect(cmd).toContain("umask 26");
    expect(cmd).not.toContain("umask 22");
  });

  it.each([
    [0o600, "66"],
    [0o640, "26"],
    [0o644, "22"],
  ])("derives the umask for mode 0o%o as %s (0666 & ~createMode, regression pin for the formula)", (mode, expectedUmask) => {
    const cmd = buildSudoInstallCommand("/tmp/x", "/etc/hosts", mode);
    expect(cmd).toContain(`umask ${expectedUmask}`);
  });

  it("produces the exact command for the default-mode case (regression pin)", () => {
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/hosts");
    const inner = `(umask 22; cat < ${shellEscape("/tmp/.nexus-elevated-t")} > ${shellEscape("/etc/hosts")})`;
    expect(cmd).toBe(`sudo -S -p '' -- /bin/sh -c ${shellEscape(inner)}`);
  });

  it("wraps the whole inner script in a single outer escape, not the raw shellEscape of each path", () => {
    // The command must be safe against the OUTER shell (sshd's login-shell parse of
    // the whole exec string) stripping one layer of quoting before /bin/sh -c ever
    // sees it. That means the inner umask/cat script — itself built from per-path
    // shellEscape() calls — must be escaped again as a single argument.
    const inner = `(umask 22; cat < ${shellEscape("/tmp/.nexus-elevated-t")} > ${shellEscape("/etc/hosts")})`;
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/hosts");
    expect(cmd).toBe(`sudo -S -p '' -- /bin/sh -c ${shellEscape(inner)}`);
  });

  it("keeps an embedded single quote in a target path inert under the outer escape", () => {
    const cmd = buildSudoInstallCommand("/tmp/x", "/etc/it's.conf");
    const inner = `(umask 22; cat < ${shellEscape("/tmp/x")} > ${shellEscape("/etc/it's.conf")})`;
    expect(cmd).toBe(`sudo -S -p '' -- /bin/sh -c ${shellEscape(inner)}`);
  });

  it("closes a command-injection hole: a target path with shell metacharacters is inert", () => {
    // Verified against a real shell (bash -c) during implementation: with a naive
    // single-escape shape, sshd's outer shell parse strips the literal quotes around
    // the paths before /bin/sh -c ever sees them, so `/etc/x;touch /tmp/pwned` would
    // execute `touch /tmp/pwned` as root. With the double-escape shape below, the
    // whole payload stays a single quoted argument at every parse stage.
    const targetPath = "/etc/x;touch /tmp/pwned";
    const cmd = buildSudoInstallCommand("/tmp/x", targetPath);
    // The payload is nested strictly inside the single outer-escaped argument: no
    // unescaped `;` reaches a shell parse as a command separator.
    const outerArg = cmd.slice(cmd.indexOf("/bin/sh -c ") + "/bin/sh -c ".length);
    expect(outerArg.startsWith("'") && outerArg.endsWith("'")).toBe(true);
    expect(cmd).toContain(shellEscape(targetPath));
  });

  it("keeps a target path with a semicolon, spaces, AND a quote inert through the install (umask-only shape)", () => {
    // Same injection concern as above, exercised against the umask-only inner
    // script now that the `[ -e ]` existence branch is gone. The target's own
    // embedded quote also has to survive the double escape, on top of the
    // semicolon and spaces, so this is checked by full recomputation rather than
    // substring search: a single-escape substring search would false-negative here
    // even on correct output, because the target's internal quote gets doubly
    // re-escaped by the outer pass just like the boundary quotes are.
    const targetPath = "/etc/weird; rm -rf / #'s dir/log.txt";
    const cmd = buildSudoInstallCommand("/tmp/x", targetPath);
    const outerArg = cmd.slice(cmd.indexOf("/bin/sh -c ") + "/bin/sh -c ".length);
    expect(outerArg.startsWith("'") && outerArg.endsWith("'")).toBe(true);
    const target = shellEscape(targetPath);
    const temp = shellEscape("/tmp/x");
    const inner = `(umask 22; cat < ${temp} > ${target})`;
    expect(cmd).toBe(`sudo -S -p '' -- /bin/sh -c ${shellEscape(inner)}`);
  });

  it("rejects paths containing newlines", () => {
    expect(() => buildSudoInstallCommand("/tmp/x", "/etc/a\nb")).toThrow();
  });

  it("rejects empty or non-absolute paths", () => {
    expect(() => buildSudoInstallCommand("", "/etc/hosts")).toThrow();
    expect(() => buildSudoInstallCommand("/tmp/x", "relative/path")).toThrow();
  });

  it("uses -n (non-interactive) when no password is supplied, and -S when one is (Codex round 6 finding 2: the install attempt is its own probe)", () => {
    expect(buildSudoInstallCommand("/tmp/x", "/etc/hosts", 0o644, false)).toContain("sudo -n -p ''");
    expect(buildSudoInstallCommand("/tmp/x", "/etc/hosts", 0o644, true)).toContain("sudo -S -p ''");
  });
});

describe("buildSudoInstallCommand — real shell behavior (Codex round 4 finding A)", () => {
  // These run the generated *inner* script (the part after `/bin/sh -c`, i.e. what
  // sudo would hand to root's shell) through a real /bin/sh against real files on
  // disk — no sudo involved. The property under test is the umask/redirect
  // interaction itself, which doesn't need root to observe: an unprivileged user's
  // shell umask governs files that same user's redirect creates exactly the same
  // way root's umask governs files root's redirect creates.
  function innerScriptFor(tempPath: string, targetPath: string, createMode = 0o644): string {
    const umask = (0o666 & ~createMode).toString(8);
    return `(umask ${umask}; cat < ${shellEscape(tempPath)} > ${shellEscape(targetPath)})`;
  }

  it("leaves an existing target's inode and mode untouched: umask has no effect once the file already exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-elevated-"));
    try {
      const tempPath = join(dir, "staged");
      const targetPath = join(dir, "target");
      writeFileSync(tempPath, "new content");
      writeFileSync(targetPath, "old content");
      chmodSync(targetPath, 0o600);
      const inodeBefore = statSync(targetPath).ino;

      // umask 022 (createMode 644) would widen a 0600 file if it were applied to
      // it — it isn't, because the redirect writes through the existing inode.
      execFileSync("/bin/sh", ["-c", innerScriptFor(tempPath, targetPath, 0o644)]);

      const after = statSync(targetPath);
      expect(after.ino).toBe(inodeBefore);
      expect(after.mode & 0o777).toBe(0o600);
      expect(readFileSync(targetPath, "utf8")).toBe("new content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a new target at exactly createMode via the derived umask when the target doesn't exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-elevated-"));
    try {
      const tempPath = join(dir, "staged");
      const targetPath = join(dir, "target");
      writeFileSync(tempPath, "content");

      execFileSync("/bin/sh", ["-c", innerScriptFor(tempPath, targetPath, 0o640)]);

      expect(statSync(targetPath).mode & 0o777).toBe(0o640);
      expect(readFileSync(targetPath, "utf8")).toBe("content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("classifySudoFailure", () => {
  it.each([
    ["sudo: a password is required", "password-required"],
    ["sudo: no password was supplied", "password-required"],
    ["Sorry, try again.", "password-required"],
    ["user is not in the sudoers file.  This incident will be reported.", "not-permitted"],
    ["bash: sudo: command not found", "no-sudo"],
    ["sudo: no tty present and no askpass program specified", "requires-tty"],
    ["sudo: sorry, you must have a tty to run sudo", "requires-tty"],
    ["something weird", "unknown"],
  ])("classifies %s", (stderr, kind) => {
    expect(classifySudoFailure({ exitCode: 1, stdout: "", stderr }).kind).toBe(kind);
  });

  it("returns none on success", () => {
    expect(classifySudoFailure({ exitCode: 0, stdout: "", stderr: "" }).kind).toBe("none");
  });
});

describe("runElevatedInstall", () => {
  it("pipes the password on stdin, never in the command", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await runElevatedInstall(exec, {
      tempPath: "/tmp/.nexus-elevated-t",
      targetPath: "/etc/hosts",
      password: "s3cret",
    });
    const [command, stdin] = exec.mock.calls[0];
    expect(command).not.toContain("s3cret");
    expect(stdin).toBe("s3cret\n");
  });

  it("omits stdin when no password is supplied", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts" });
    expect(exec.mock.calls[0][1]).toBeUndefined();
  });

  it("throws SudoPasswordRequiredError when the password is rejected", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "Sorry, try again." });
    await expect(
      runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts", password: "bad" })
    ).rejects.toBeInstanceOf(SudoPasswordRequiredError);
  });

  it("surfaces a sudoers rejection as a SudoNotPermittedError with a plain-language message and the raw detail", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "nexus is not in the sudoers file.",
    });
    const promise = runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts" });
    await expect(promise).rejects.toBeInstanceOf(SudoNotPermittedError);
    await expect(promise).rejects.toThrow(/not permitted to run sudo/i);
    await promise.catch((error: SudoNotPermittedError) => {
      expect(error.detail).toBe("nexus is not in the sudoers file.");
    });
  });

  it("surfaces a missing-sudo failure with a plain-language message", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "bash: sudo: command not found" });
    await expect(
      runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts" })
    ).rejects.toThrow(/sudo is not available/i);
  });

  it("surfaces a requiretty failure with a plain-language message and a next step (P5)", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "sudo: no tty present and no askpass program specified",
    });
    await expect(
      runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts" })
    ).rejects.toThrow(/requires a tty/i);
    await expect(
      runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts" })
    ).rejects.toThrow(/requiretty|terminal on the remote host/i);
  });

  it("surfaces an unknown failure as ElevatedInstallFailedError, including the exit code when stderr is empty", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 7, stdout: "", stderr: "" });
    const promise = runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts" });
    await expect(promise).rejects.toBeInstanceOf(ElevatedInstallFailedError);
    await expect(promise).rejects.toThrow("Elevated save failed: sudo exited with code 7");
  });

  it("wraps an exec-channel throw (no exit status at all) as ElevatedInstallFailedError (P5: install-phase, partial-write risk)", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("Command timed out after 30000ms"));
    await expect(
      runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts" })
    ).rejects.toBeInstanceOf(ElevatedInstallFailedError);
  });

  it("redacts the password out of an unknown failure's detail (P8 defence in depth)", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "weird failure near s3cret-value" });
    await expect(
      runElevatedInstall(exec, {
        tempPath: "/tmp/a",
        targetPath: "/etc/hosts",
        password: "s3cret-value",
      })
    ).rejects.toThrow(/\*\*\*/);
  });

  it("resolves without throwing on success", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await expect(
      runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts" })
    ).resolves.toBeUndefined();
  });

  it("picks -n with no password and -S with one, deriving interactive from password presence (Codex round 6 finding 2)", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts" });
    expect(exec.mock.calls[0][0]).toContain("sudo -n");

    exec.mockClear();
    await runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts", password: "x" });
    expect(exec.mock.calls[0][0]).toContain("sudo -S");
  });
});

describe("isPermissionDeniedError", () => {
  it("matches the SSH_FX_PERMISSION_DENIED status code", () => {
    expect(isPermissionDeniedError({ code: 3 })).toBe(true);
  });

  it("matches an EACCES code", () => {
    expect(isPermissionDeniedError({ code: "EACCES" })).toBe(true);
  });

  it("matches a permission denied message when the code is absent", () => {
    expect(isPermissionDeniedError(new Error("Permission denied"))).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isPermissionDeniedError(new Error("No such file"))).toBe(false);
    expect(isPermissionDeniedError({ code: 2 })).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isPermissionDeniedError(undefined)).toBe(false);
    expect(isPermissionDeniedError(null)).toBe(false);
    expect(isPermissionDeniedError("just a string")).toBe(false);
  });
});
