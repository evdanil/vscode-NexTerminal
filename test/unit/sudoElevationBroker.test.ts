import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockShowWarningMessage = vi.fn();
const mockShowInputBox = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockSetStatusBarMessage = vi.fn();
const mockExecuteCommand = vi.fn();

let sudoEnabled = true;
let rememberPassword = false;

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showInputBox: (...args: unknown[]) => mockShowInputBox(...args),
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    setStatusBarMessage: (...args: unknown[]) => mockSetStatusBarMessage(...args),
  },
  commands: {
    executeCommand: (...args: unknown[]) => mockExecuteCommand(...args),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (key: string, def: unknown) => {
        if (key === "sudo.enabled") return sudoEnabled;
        if (key === "sudo.rememberPasswordForSession") return rememberPassword;
        return def;
      },
    })),
  },
}));

import { SudoElevationBroker, GRACE_WINDOW_MS } from "../../src/services/sftp/sudoElevationBroker";
import {
  ElevatedInstallFailedError,
  SudoNotPermittedError,
  SudoPasswordRequiredError,
} from "../../src/services/sftp/elevatedWrite";
import type { ServerConfig } from "../../src/models/config";

const testServer: ServerConfig = {
  id: "srv-1",
  name: "Test Server",
  host: "example.com",
  port: 22,
  username: "dev",
  authType: "password",
  isHidden: false,
};

function createMockSftp() {
  return {
    writeFileElevated: vi.fn(),
  };
}

describe("SudoElevationBroker", () => {
  let sftp: ReturnType<typeof createMockSftp>;
  let broker: SudoElevationBroker;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sudoEnabled = true;
    rememberPassword = false;
    sftp = createMockSftp();
    broker = new SudoElevationBroker(sftp as any, (id: string) => (id === testServer.id ? testServer : undefined));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("confirmElevation", () => {
    it("shows a modal warning and resolves true only when 'Save as Root' is chosen", async () => {
      mockShowWarningMessage.mockResolvedValue("Save as Root");

      await expect(broker.confirmElevation("srv-1", "/etc/hosts")).resolves.toBe(true);

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("/etc/hosts"),
        { modal: true },
        "Save as Root"
      );
    });

    it("names the server, not just 'the remote host', so a multi-server user knows which file (P5)", async () => {
      mockShowWarningMessage.mockResolvedValue(undefined);

      await broker.confirmElevation("srv-1", "/etc/hosts");

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        "Permission denied writing /etc/hosts on Test Server. Retry the save with sudo?",
        { modal: true },
        "Save as Root"
      );
    });

    it("falls back to the raw serverId when the server is unknown", async () => {
      mockShowWarningMessage.mockResolvedValue(undefined);

      await broker.confirmElevation("unknown-server", "/etc/hosts");

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("unknown-server"),
        { modal: true },
        "Save as Root"
      );
    });

    it("resolves false when the user dismisses the modal", async () => {
      mockShowWarningMessage.mockResolvedValue(undefined);

      await expect(broker.confirmElevation("srv-1", "/etc/hosts")).resolves.toBe(false);
    });

    it("skips the modal entirely (returns false) when sudo.enabled is false", async () => {
      sudoEnabled = false;

      await expect(broker.confirmElevation("srv-1", "/etc/hosts")).resolves.toBe(false);
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });
  });

  describe("saveElevated", () => {
    it("writes without a password when the optimistic non-interactive attempt succeeds", async () => {
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(true);

      expect(mockShowInputBox).not.toHaveBeenCalled();
      expect(sftp.writeFileElevated).toHaveBeenCalledWith("srv-1", "/etc/hosts", expect.any(Buffer), { createMode: undefined });
      expect(mockSetStatusBarMessage).toHaveBeenCalledWith(expect.stringContaining("hosts"), 4000);
    });

    it("passes the caller-supplied knownMode through as createMode when the optimistic attempt succeeds (P3)", async () => {
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"), 0o640);

      expect(sftp.writeFileElevated).toHaveBeenCalledWith("srv-1", "/etc/hosts", expect.any(Buffer), { createMode: 0o640 });
    });

    it("prompts for a sudo password only when the optimistic (no-password) attempt reports one is required", async () => {
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // optimistic attempt: sudo -n refuses
        .mockResolvedValueOnce(undefined); // interactive retry with the prompted password

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(true);

      expect(mockShowInputBox).toHaveBeenCalledTimes(1);
      expect(mockShowInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ password: true, ignoreFocusOut: true, prompt: expect.stringContaining("dev@example.com") })
      );
      expect(sftp.writeFileElevated).toHaveBeenCalledWith("srv-1", "/etc/hosts", expect.any(Buffer), { password: "s3cret", createMode: undefined });
    });

    it("uses the house password-prompt style: 'Sudo Password: <server name>' title, and explains why a second password is needed (P5)", async () => {
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError())
        .mockResolvedValueOnce(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));

      expect(mockShowInputBox).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Sudo Password: Test Server",
          prompt: "Enter the sudo password for dev@example.com to save this file as root",
        })
      );
    });

    it("falls back to the raw serverId in the prompt when the server is unknown", async () => {
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError())
        .mockResolvedValueOnce(undefined);

      await broker.saveElevated("unknown-server", "/etc/hosts", Buffer.from("x"));

      expect(mockShowInputBox).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining("unknown-server") }));
    });

    it("re-prompts once when the sudo password is rejected, then succeeds", async () => {
      mockShowInputBox.mockResolvedValueOnce("bad").mockResolvedValueOnce("good");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // optimistic attempt
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // interactive attempt, wrong password
        .mockResolvedValueOnce(undefined); // interactive retry, correct password

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(true);

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(2, "srv-1", "/etc/hosts", expect.any(Buffer), { password: "bad", createMode: undefined });
      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(3, "srv-1", "/etc/hosts", expect.any(Buffer), { password: "good", createMode: undefined });
    });

    it("labels the retry prompt as a rejected password, not an identical unlabelled re-ask (P4a)", async () => {
      mockShowInputBox.mockResolvedValueOnce("bad").mockResolvedValueOnce("good");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError())
        .mockRejectedValueOnce(new SudoPasswordRequiredError())
        .mockResolvedValueOnce(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));

      const [firstPrompt] = mockShowInputBox.mock.calls[0];
      const [secondPrompt] = mockShowInputBox.mock.calls[1];
      expect(firstPrompt.prompt).not.toContain("Incorrect password");
      expect(secondPrompt.prompt).toBe(
        "Incorrect password. If this host is configured with rootpw (or targetpw), sudo wants the root password, not yours. " +
        "Enter the sudo password for dev@example.com to save this file as root"
      );
    });

    it("mentions the rootpw/targetpw hint on the retry prompt only, not the first prompt (#31 live-testing follow-up)", async () => {
      mockShowInputBox.mockResolvedValueOnce("bad").mockResolvedValueOnce("good");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError())
        .mockRejectedValueOnce(new SudoPasswordRequiredError())
        .mockResolvedValueOnce(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));

      const [firstPrompt] = mockShowInputBox.mock.calls[0];
      const [secondPrompt] = mockShowInputBox.mock.calls[1];
      expect(firstPrompt.prompt).not.toMatch(/rootpw|targetpw/i);
      expect(secondPrompt.prompt).toContain("Incorrect password.");
      expect(secondPrompt.prompt).toMatch(/rootpw/i);
    });

    it("gives up with an error notification after the retry also fails, without re-prompting a third time", async () => {
      mockShowInputBox.mockResolvedValueOnce("bad").mockResolvedValueOnce("bad2");
      sftp.writeFileElevated.mockRejectedValue(new SudoPasswordRequiredError()); // persistent: covers the optimistic attempt too

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
      expect(mockShowErrorMessage).toHaveBeenCalledTimes(1);
    });

    it("returns false without writing a password when the password prompt is cancelled", async () => {
      sftp.writeFileElevated.mockRejectedValueOnce(new SudoPasswordRequiredError()); // optimistic attempt
      mockShowInputBox.mockResolvedValue(undefined);

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);

      // Called once, for the optimistic attempt that triggered the (then-cancelled) prompt — never again.
      expect(sftp.writeFileElevated).toHaveBeenCalledTimes(1);
      expect(mockShowErrorMessage).not.toHaveBeenCalled();
    });

    it("returns false without writing a password when an empty password is submitted", async () => {
      sftp.writeFileElevated.mockRejectedValueOnce(new SudoPasswordRequiredError()); // optimistic attempt
      mockShowInputBox.mockResolvedValue("");

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);
      expect(sftp.writeFileElevated).toHaveBeenCalledTimes(1);
    });

    it("caches the password across calls when rememberPasswordForSession is true", async () => {
      rememberPassword = true;
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // 1st save's optimistic attempt
        .mockResolvedValue(undefined); // 1st save's interactive write, then the 2nd save's cached-password reuse

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      await broker.saveElevated("srv-1", "/etc/other", Buffer.from("y")); // already has a cached password -> skips the optimistic attempt entirely

      expect(mockShowInputBox).toHaveBeenCalledTimes(1);
      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(3, "srv-1", "/etc/other", expect.any(Buffer), { password: "s3cret", createMode: undefined });
    });

    it("does not cache the password past the grace window when rememberPasswordForSession is false", async () => {
      rememberPassword = false;
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 1: optimistic attempt
        .mockResolvedValueOnce(undefined) // save 1: interactive write
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 2 (past the grace window): optimistic attempt
        .mockResolvedValueOnce(undefined); // save 2: interactive write

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      vi.advanceTimersByTime(GRACE_WINDOW_MS + 1);
      await broker.saveElevated("srv-1", "/etc/other", Buffer.from("y"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
    });

    it("reports that elevated saves are disabled, offering an Open Settings button (P5), and never attempts a write", async () => {
      sudoEnabled = false;
      mockShowErrorMessage.mockResolvedValue(undefined);

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);

      expect(sftp.writeFileElevated).not.toHaveBeenCalled();
      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        "Elevated saves are disabled (nexus.sftp.sudo.enabled is off).",
        "Open Settings"
      );
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    it("opens the sudo.enabled setting when the disabled toast's Open Settings button is clicked (P5)", async () => {
      sudoEnabled = false;
      mockShowErrorMessage.mockResolvedValue("Open Settings");

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));

      expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.openSettings", "nexus.sftp.sudo.enabled");
    });

    it("surfaces a not-permitted sudo failure naming the user and host, with the real detail appended, and no double prefix (P5)", async () => {
      sftp.writeFileElevated.mockRejectedValue(new SudoNotPermittedError("not in sudoers"));

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);

      expect(mockShowInputBox).not.toHaveBeenCalled();
      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        "dev@example.com is not permitted to run sudo for this file on Test Server. Check the remote sudoers policy — " +
        "this can also happen with per-command restrictions rather than a full ban. not in sudoers"
      );
      const [message] = mockShowErrorMessage.mock.calls[0];
      expect(message).not.toMatch(/^Elevated save failed:/);
    });

    it("appends a partial-write warning for install-phase (unclassified) failures, since the temp file was already staged (P5)", async () => {
      sftp.writeFileElevated.mockRejectedValue(new ElevatedInstallFailedError("sudo exited with code 1"));

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        "Elevated save failed: sudo exited with code 1 The file may be partially written — keep the editor open and retry the save."
      );
    });

    it("does not append a partial-write warning to a generic (staging-phase) failure", async () => {
      sftp.writeFileElevated.mockRejectedValue(new Error("ENOSPC: no space left on device"));

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);

      expect(mockShowErrorMessage).toHaveBeenCalledWith("Elevated save failed: ENOSPC: no space left on device");
    });

    it("falls through to an interactive password prompt when the optimistic non-interactive attempt reports a password is required (P4b)", async () => {
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError())
        .mockResolvedValueOnce(undefined);
      mockShowInputBox.mockResolvedValue("s3cret");

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(true);

      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(1, "srv-1", "/etc/hosts", expect.any(Buffer), { createMode: undefined });
      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(2, "srv-1", "/etc/hosts", expect.any(Buffer), { password: "s3cret", createMode: undefined });
      expect(mockShowInputBox).toHaveBeenCalledTimes(1);
      expect(mockShowErrorMessage).not.toHaveBeenCalled();
    });

    it("never includes the password in any error message shown to the user", async () => {
      mockShowInputBox.mockResolvedValue("s3cret-value");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // optimistic attempt, falls through to the prompt
        .mockRejectedValue(new Error("disk full")); // interactive write fails on an unrelated error

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(1);
      for (const call of mockShowErrorMessage.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("s3cret-value");
      }
    });
  });

  describe("rememberPasswordForSession toggled off mid-session (Codex round 3 finding A)", () => {
    it("re-prompts immediately instead of reusing a password cached while remembrance was on", async () => {
      rememberPassword = true;
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 1: optimistic attempt
        .mockResolvedValueOnce(undefined) // save 1: interactive write
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 2 (past grace, remembrance off): optimistic attempt
        .mockResolvedValueOnce(undefined); // save 2: interactive write

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      expect(mockShowInputBox).toHaveBeenCalledTimes(1);

      rememberPassword = false;
      vi.advanceTimersByTime(GRACE_WINDOW_MS + 1);
      await broker.saveElevated("srv-1", "/etc/other", Buffer.from("y"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
    });

    it("drops the previously cached password (not just skips reading it), so re-enabling remembrance does not resurrect it", async () => {
      rememberPassword = true;
      mockShowInputBox.mockResolvedValueOnce("first").mockResolvedValueOnce("second").mockResolvedValueOnce("third");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 1 ("first"): optimistic attempt
        .mockResolvedValueOnce(undefined) // save 1: interactive write
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 2 ("second"): optimistic attempt
        .mockResolvedValueOnce(undefined) // save 2: interactive write
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 3 ("third"): optimistic attempt
        .mockResolvedValueOnce(undefined); // save 3: interactive write

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x")); // caches "first"

      rememberPassword = false;
      vi.advanceTimersByTime(GRACE_WINDOW_MS + 1);
      await broker.saveElevated("srv-1", "/etc/a", Buffer.from("y")); // must re-prompt, must not cache "second"

      rememberPassword = true;
      vi.advanceTimersByTime(GRACE_WINDOW_MS + 1);
      await broker.saveElevated("srv-1", "/etc/b", Buffer.from("z")); // cache must be empty -> re-prompt for "third"

      expect(mockShowInputBox).toHaveBeenCalledTimes(3);
      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(6, "srv-1", "/etc/b", expect.any(Buffer), { password: "third", createMode: undefined });
    });
  });

  describe("the grace window and the remember-off cache clear interacting with the optimistic attempt (Codex round 5, updated for round 6 finding 2)", () => {
    it("drops the session-cached password before a later save runs, so re-enabling remembrance does not resurrect it — independent of the still-open grace window", async () => {
      // Defensive: a failing assertion partway through this test (expected pre-fix) can leave a
      // queued mockResolvedValueOnce unconsumed on this shared mock — clearAllMocks() in beforeEach
      // does not drain pending "once" implementations, only call history. Reset it so this test
      // can't leak state into whichever test runs next.
      mockShowInputBox.mockReset();
      rememberPassword = true;
      mockShowInputBox.mockResolvedValueOnce("first");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 1: optimistic attempt
        .mockResolvedValueOnce(undefined); // save 1: interactive write, caches "first" (session + grace)

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      expect(mockShowInputBox).toHaveBeenCalledTimes(1);

      rememberPassword = false; // drops the session cache...
      sftp.writeFileElevated.mockResolvedValueOnce(undefined); // ...but the grace window (independent of the setting) is still open, so no optimistic attempt at all

      await broker.saveElevated("srv-1", "/etc/other", Buffer.from("y"));
      expect(mockShowInputBox).toHaveBeenCalledTimes(1); // reused the grace-cached password, no prompt

      rememberPassword = true;
      vi.advanceTimersByTime(GRACE_WINDOW_MS + 1); // now past the grace window from save 1's "first" entry too
      mockShowInputBox.mockResolvedValueOnce("second");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 3: optimistic attempt
        .mockResolvedValueOnce(undefined); // save 3: interactive write

      await broker.saveElevated("srv-1", "/etc/b", Buffer.from("z")); // both caches empty -> re-prompt, not reuse "first"

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
      expect(sftp.writeFileElevated).toHaveBeenLastCalledWith("srv-1", "/etc/b", expect.any(Buffer), { password: "second", createMode: undefined });
    });

    it("leaves a cached password intact across a later save when remembrance stays on (no regression)", async () => {
      mockShowInputBox.mockReset();
      rememberPassword = true;
      mockShowInputBox.mockResolvedValueOnce("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 1: optimistic attempt
        .mockResolvedValue(undefined); // save 1's interactive write, then every later reuse

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x")); // caches "s3cret"

      await broker.saveElevated("srv-1", "/etc/other", Buffer.from("y")); // remembrance still on -> reuses the session cache, no optimistic attempt

      await broker.saveElevated("srv-1", "/etc/b", Buffer.from("z")); // should reuse the cache, no new prompt

      expect(mockShowInputBox).toHaveBeenCalledTimes(1);
      expect(sftp.writeFileElevated).toHaveBeenLastCalledWith("srv-1", "/etc/b", expect.any(Buffer), { password: "s3cret", createMode: undefined });
    });
  });

  describe("clearCachedPassword", () => {
    it("drops the cached password for a server, forcing a re-prompt on the next save", async () => {
      rememberPassword = true;
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 1: optimistic attempt
        .mockResolvedValueOnce(undefined) // save 1: interactive write
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 2 (after clear): optimistic attempt
        .mockResolvedValueOnce(undefined); // save 2: interactive write

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      broker.clearCachedPassword("srv-1");
      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
    });
  });

  describe("dispose (P8)", () => {
    it("clears every cached password, forcing a re-prompt for any server on the next save", async () => {
      rememberPassword = true;
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 1: optimistic attempt
        .mockResolvedValueOnce(undefined) // save 1: interactive write
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 2 (after dispose): optimistic attempt
        .mockResolvedValueOnce(undefined); // save 2: interactive write

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      broker.dispose();
      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
    });
  });

  describe("grace window (Codex round 6 finding 1)", () => {
    it("does not re-prompt for a second elevated write on the same server within the grace window, even when rememberPasswordForSession is off", async () => {
      rememberPassword = false;
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 1: optimistic attempt
        .mockResolvedValueOnce(undefined) // save 1: interactive write, opens the grace window
        .mockResolvedValueOnce(undefined); // save 2: reuses the grace-cached password directly, no optimistic attempt

      await broker.saveElevated("srv-1", "/etc/sshd_config2", Buffer.from("create"));
      await broker.saveElevated("srv-1", "/etc/sshd_config2", Buffer.from("content"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(1);
      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(3, "srv-1", "/etc/sshd_config2", expect.any(Buffer), { password: "s3cret", createMode: undefined });
    });

    it("prompts again for an elevated write more than the grace window after the previous one", async () => {
      rememberPassword = false;
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 1: optimistic attempt
        .mockResolvedValueOnce(undefined) // save 1: interactive write
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 2 (past the window): optimistic attempt
        .mockResolvedValueOnce(undefined); // save 2: interactive write

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      vi.advanceTimersByTime(GRACE_WINDOW_MS + 1);
      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("y"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
    });

    it("does not extend the window on reuse — it is fixed from entry time, not sliding", async () => {
      rememberPassword = false;
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 1: optimistic attempt, opens the window at t=0
        .mockResolvedValueOnce(undefined) // save 1: interactive write
        .mockResolvedValueOnce(undefined) // save 2 (still within window): reuse, no optimistic attempt
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 3 (past the ORIGINAL window): optimistic attempt
        .mockResolvedValueOnce(undefined); // save 3: interactive write

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x")); // t=0, prompts, window opens
      vi.advanceTimersByTime(GRACE_WINDOW_MS - 10_000);
      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("y")); // reuses; must NOT push expiry out
      vi.advanceTimersByTime(11_000); // now well past the ORIGINAL window if it weren't extended
      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("z"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(2); // 1 initial + 1 re-prompt after true expiry
    });

    it("clears the grace entry on clearCachedPassword (disconnect), forcing a re-prompt even inside the window", async () => {
      rememberPassword = false;
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 1: optimistic attempt
        .mockResolvedValueOnce(undefined) // save 1: interactive write
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 2 (after clear): optimistic attempt
        .mockResolvedValueOnce(undefined); // save 2: interactive write

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      broker.clearCachedPassword("srv-1");
      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("y"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
    });

    it("clears the grace entry on dispose, forcing a re-prompt even inside the window", async () => {
      rememberPassword = false;
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 1: optimistic attempt
        .mockResolvedValueOnce(undefined) // save 1: interactive write
        .mockRejectedValueOnce(new SudoPasswordRequiredError()) // save 2 (after dispose): optimistic attempt
        .mockResolvedValueOnce(undefined); // save 2: interactive write

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      broker.dispose();
      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("y"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
    });
  });
});
