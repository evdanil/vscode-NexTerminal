import { describe, expect, it, vi } from "vitest";
import { shellEscape } from "../../src/utils/shellEscape";
import {
  buildSudoInstallCommand,
  buildTempStagePath,
  classifySudoFailure,
  ElevatedInstallFailedError,
  isPermissionDeniedError,
  probeSudoNonInteractive,
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
  // Codex finding 1: existence used to be a boolean the caller resolved via a
  // separate `stat` before the (possibly slow) staging upload, leaving a window
  // where a deleted/rotated target would still take the "exists" branch and lose
  // its chmod. buildSudoInstallCommand no longer takes a targetExists argument at
  // all — every command below performs the same `[ -e target ]` check inside the
  // remote shell, at install time, where there is no cross-network race window.

  // These four tests split on plain shell-syntax tokens (no quote characters of
  // their own), which survive the outer double-escape unmangled regardless of how
  // the quoted paths in between get escaped — unlike a hand-built expected string,
  // which would have to reproduce that escaping exactly (see the regression-pin and
  // "wraps the whole inner script" tests below for that approach).
  it("decides existence inside the sudo shell, not from a caller-supplied flag", () => {
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/hosts");
    expect(cmd).toMatch(/if \[ -e [^\]]*\/etc\/hosts[^\]]*\]; then cat < /);
  });

  it("redirects through the existing inode when the shell finds the target present, without a chmod on that branch", () => {
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/hosts");
    const thenBranch = cmd.split("]; then cat <")[1]?.split("; else cat <")[0] ?? "";
    expect(thenBranch).toContain("/etc/hosts");
    expect(thenBranch).not.toContain("chmod");
  });

  it("chmods only on the create branch, defaulting to 644 when no mode is given", () => {
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/new.conf");
    const elseBranch = cmd.split("; else cat <")[1] ?? "";
    expect(elseBranch).toContain("&& chmod 644 ");
    expect(elseBranch.trimEnd().endsWith("; fi'")).toBe(true);
  });

  it("chmods to the caller-supplied createMode on the create branch (P3: preserves a vanished target's prior mode)", () => {
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/rotated.log", 0o640);
    const elseBranch = cmd.split("; else cat <")[1] ?? "";
    expect(elseBranch).toContain("&& chmod 640 ");
    expect(elseBranch).not.toContain("644");
  });

  it("produces the exact command for the default-mode case (regression pin)", () => {
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/hosts");
    const inner =
      `if [ -e ${shellEscape("/etc/hosts")} ]; then cat < ${shellEscape("/tmp/.nexus-elevated-t")} > ${shellEscape("/etc/hosts")}; ` +
      `else cat < ${shellEscape("/tmp/.nexus-elevated-t")} > ${shellEscape("/etc/hosts")} && chmod 644 ${shellEscape("/etc/hosts")}; fi`;
    expect(cmd).toBe(`sudo -S -p '' -- /bin/sh -c ${shellEscape(inner)}`);
  });

  it("wraps the whole inner script in a single outer escape, not the raw shellEscape of each path", () => {
    // The command must be safe against the OUTER shell (sshd's login-shell parse of
    // the whole exec string) stripping one layer of quoting before /bin/sh -c ever
    // sees it. That means the inner if/else script — itself built from per-path
    // shellEscape() calls — must be escaped again as a single argument.
    const inner =
      `if [ -e ${shellEscape("/etc/hosts")} ]; then cat < ${shellEscape("/tmp/.nexus-elevated-t")} > ${shellEscape("/etc/hosts")}; ` +
      `else cat < ${shellEscape("/tmp/.nexus-elevated-t")} > ${shellEscape("/etc/hosts")} && chmod 644 ${shellEscape("/etc/hosts")}; fi`;
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/hosts");
    expect(cmd).toBe(`sudo -S -p '' -- /bin/sh -c ${shellEscape(inner)}`);
  });

  it("keeps an embedded single quote in a target path inert under the outer escape", () => {
    const cmd = buildSudoInstallCommand("/tmp/x", "/etc/it's.conf");
    const inner =
      `if [ -e ${shellEscape("/etc/it's.conf")} ]; then cat < ${shellEscape("/tmp/x")} > ${shellEscape("/etc/it's.conf")}; ` +
      `else cat < ${shellEscape("/tmp/x")} > ${shellEscape("/etc/it's.conf")} && chmod 644 ${shellEscape("/etc/it's.conf")}; fi`;
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

  it("keeps a target path with a semicolon, spaces, AND a quote inert through both the existence check and the install (new if/else shape)", () => {
    // Same injection concern as above, but exercising the new `[ -e ... ]` existence
    // test too — a payload could in principle try to break out through either the
    // `[ -e ]` test or the `cat`/`chmod` invocations that follow it. The target's own
    // embedded quote also has to survive the double escape, on top of the semicolon
    // and spaces, so this is checked by full recomputation rather than substring
    // search: a single-escape substring search would false-negative here even on
    // correct output, because the target's internal quote gets doubly re-escaped by
    // the outer pass just like the boundary quotes are.
    const targetPath = "/etc/weird; rm -rf / #'s dir/log.txt";
    const cmd = buildSudoInstallCommand("/tmp/x", targetPath);
    const outerArg = cmd.slice(cmd.indexOf("/bin/sh -c ") + "/bin/sh -c ".length);
    expect(outerArg.startsWith("'") && outerArg.endsWith("'")).toBe(true);
    const target = shellEscape(targetPath);
    const temp = shellEscape("/tmp/x");
    const inner = `if [ -e ${target} ]; then cat < ${temp} > ${target}; else cat < ${temp} > ${target} && chmod 644 ${target}; fi`;
    expect(cmd).toBe(`sudo -S -p '' -- /bin/sh -c ${shellEscape(inner)}`);
  });

  it("rejects paths containing newlines", () => {
    expect(() => buildSudoInstallCommand("/tmp/x", "/etc/a\nb")).toThrow();
  });

  it("rejects empty or non-absolute paths", () => {
    expect(() => buildSudoInstallCommand("", "/etc/hosts")).toThrow();
    expect(() => buildSudoInstallCommand("/tmp/x", "relative/path")).toThrow();
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

describe("probeSudoNonInteractive", () => {
  it("reports none when sudo -n succeeds", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await expect(probeSudoNonInteractive(exec)).resolves.toEqual({ kind: "none" });
    expect(exec).toHaveBeenCalledWith("sudo -n -v");
  });

  it("reports password-required when sudo -n needs a password", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "sudo: a password is required" });
    await expect(probeSudoNonInteractive(exec)).resolves.toEqual({ kind: "password-required" });
  });

  it("treats an unrecognized non-zero exit as password-required, not unknown", async () => {
    // Stderr wording is locale/distro-dependent; for a failing non-interactive probe
    // specifically, password-required is the correct retryable guess even when the
    // text doesn't match a known pattern.
    const exec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });
    await expect(probeSudoNonInteractive(exec)).resolves.toEqual({ kind: "password-required" });
  });

  it("still reports a specific failure kind when stderr matches a known pattern", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "user is not in the sudoers file.",
    });
    await expect(probeSudoNonInteractive(exec)).resolves.toEqual({
      kind: "not-permitted",
      detail: "user is not in the sudoers file.",
    });
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
