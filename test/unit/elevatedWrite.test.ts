import { describe, expect, it, vi } from "vitest";
import { shellEscape } from "../../src/utils/shellEscape";
import {
  buildSudoInstallCommand,
  buildTempStagePath,
  classifySudoFailure,
  isPermissionDeniedError,
  probeSudoNonInteractive,
  runElevatedInstall,
  SudoPasswordRequiredError,
} from "../../src/services/sftp/elevatedWrite";

describe("buildTempStagePath", () => {
  it("stages in /tmp regardless of target directory", () => {
    expect(buildTempStagePath("/etc/nginx/nginx.conf", "abc123")).toBe("/tmp/.nexus-elevated-abc123");
  });
});

describe("buildSudoInstallCommand", () => {
  it("redirects through the existing inode so ownership and mode survive", () => {
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/hosts", true);
    expect(cmd).toBe(
      "sudo -S -p '' -- /bin/sh -c 'cat < '\\''/tmp/.nexus-elevated-t'\\'' > '\\''/etc/hosts'\\'''"
    );
    expect(cmd).not.toContain("chmod");
  });

  it("chmods only when creating a new file", () => {
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/new.conf", false);
    expect(cmd).toBe(
      "sudo -S -p '' -- /bin/sh -c 'cat < '\\''/tmp/.nexus-elevated-t'\\'' > '\\''/etc/new.conf'\\'' && chmod 644 '\\''/etc/new.conf'\\'''"
    );
  });

  it("wraps the whole inner script in a single outer escape, not the raw shellEscape of each path", () => {
    // The command must be safe against the OUTER shell (sshd's login-shell parse of
    // the whole exec string) stripping one layer of quoting before /bin/sh -c ever
    // sees it. That means the inner "cat < temp > target" script — itself built from
    // per-path shellEscape() calls — must be escaped again as a single argument.
    const inner = `cat < ${shellEscape("/tmp/.nexus-elevated-t")} > ${shellEscape("/etc/hosts")}`;
    const cmd = buildSudoInstallCommand("/tmp/.nexus-elevated-t", "/etc/hosts", true);
    expect(cmd).toBe(`sudo -S -p '' -- /bin/sh -c ${shellEscape(inner)}`);
  });

  it("keeps an embedded single quote in a target path inert under the outer escape", () => {
    const cmd = buildSudoInstallCommand("/tmp/x", "/etc/it's.conf", true);
    const inner = `cat < ${shellEscape("/tmp/x")} > ${shellEscape("/etc/it's.conf")}`;
    expect(cmd).toBe(`sudo -S -p '' -- /bin/sh -c ${shellEscape(inner)}`);
  });

  it("closes a command-injection hole: a target path with shell metacharacters is inert", () => {
    // Verified against a real shell (bash -c) during implementation: with the naive
    // single-escape shape, sshd's outer shell parse strips the literal quotes around
    // the paths before /bin/sh -c ever sees them, so `/etc/x;touch /tmp/pwned` would
    // execute `touch /tmp/pwned` as root. With the double-escape shape below, the
    // whole payload stays a single quoted argument at every parse stage.
    const targetPath = "/etc/x;touch /tmp/pwned";
    const cmd = buildSudoInstallCommand("/tmp/x", targetPath, true);
    expect(cmd).toBe(
      "sudo -S -p '' -- /bin/sh -c 'cat < '\\''/tmp/x'\\'' > '\\''/etc/x;touch /tmp/pwned'\\'''"
    );
    // The payload is nested strictly inside the single outer-escaped argument: no
    // unescaped `;` reaches a shell parse as a command separator.
    const outerArg = cmd.slice(cmd.indexOf("/bin/sh -c ") + "/bin/sh -c ".length);
    expect(outerArg.startsWith("'") && outerArg.endsWith("'")).toBe(true);
  });

  it("rejects paths containing newlines", () => {
    expect(() => buildSudoInstallCommand("/tmp/x", "/etc/a\nb", true)).toThrow();
  });

  it("rejects empty or non-absolute paths", () => {
    expect(() => buildSudoInstallCommand("", "/etc/hosts", true)).toThrow();
    expect(() => buildSudoInstallCommand("/tmp/x", "relative/path", true)).toThrow();
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
      targetExists: true,
      password: "s3cret",
    });
    const [command, stdin] = exec.mock.calls[0];
    expect(command).not.toContain("s3cret");
    expect(stdin).toBe("s3cret\n");
  });

  it("omits stdin when no password is supplied", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts", targetExists: true });
    expect(exec.mock.calls[0][1]).toBeUndefined();
  });

  it("throws SudoPasswordRequiredError when the password is rejected", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "Sorry, try again." });
    await expect(
      runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts", targetExists: true, password: "bad" })
    ).rejects.toBeInstanceOf(SudoPasswordRequiredError);
  });

  it("surfaces a sudoers rejection with a plain-language message", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "nexus is not in the sudoers file.",
    });
    await expect(
      runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts", targetExists: true })
    ).rejects.toThrow(/not permitted to run sudo/i);
  });

  it("surfaces a missing-sudo failure with a plain-language message", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "bash: sudo: command not found" });
    await expect(
      runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts", targetExists: true })
    ).rejects.toThrow(/sudo is not available/i);
  });

  it("surfaces a requiretty failure with a plain-language message", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "sudo: no tty present and no askpass program specified",
    });
    await expect(
      runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts", targetExists: true })
    ).rejects.toThrow(/requires a tty/i);
  });

  it("surfaces an unknown failure including the exit code when stderr is empty", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 7, stdout: "", stderr: "" });
    await expect(
      runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts", targetExists: true })
    ).rejects.toThrow("Elevated save failed: sudo exited with code 7");
  });

  it("resolves without throwing on success", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await expect(
      runElevatedInstall(exec, { tempPath: "/tmp/a", targetPath: "/etc/hosts", targetExists: false })
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
