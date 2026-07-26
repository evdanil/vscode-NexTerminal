import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { SudoElevationBroker } from "../../src/services/sftp/sudoElevationBroker";
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
    probeElevation: vi.fn(),
    writeFileElevated: vi.fn(),
  };
}

describe("SudoElevationBroker", () => {
  let sftp: ReturnType<typeof createMockSftp>;
  let broker: SudoElevationBroker;

  beforeEach(() => {
    vi.clearAllMocks();
    sudoEnabled = true;
    rememberPassword = false;
    sftp = createMockSftp();
    broker = new SudoElevationBroker(sftp as any, (id: string) => (id === testServer.id ? testServer : undefined));
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
    it("writes without a password when sudo -n reports none needed", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "none" });
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(true);

      expect(mockShowInputBox).not.toHaveBeenCalled();
      expect(sftp.writeFileElevated).toHaveBeenCalledWith("srv-1", "/etc/hosts", expect.any(Buffer), { createMode: undefined });
      expect(mockSetStatusBarMessage).toHaveBeenCalledWith(expect.stringContaining("hosts"), 4000);
    });

    it("passes the caller-supplied knownMode through as createMode when sudo -n reports none needed (P3)", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "none" });
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"), 0o640);

      expect(sftp.writeFileElevated).toHaveBeenCalledWith("srv-1", "/etc/hosts", expect.any(Buffer), { createMode: 0o640 });
    });

    it("prompts for a sudo password only when sudo -n reports one is required", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(true);

      expect(mockShowInputBox).toHaveBeenCalledTimes(1);
      expect(mockShowInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ password: true, ignoreFocusOut: true, prompt: expect.stringContaining("dev@example.com") })
      );
      expect(sftp.writeFileElevated).toHaveBeenCalledWith("srv-1", "/etc/hosts", expect.any(Buffer), { password: "s3cret", createMode: undefined });
    });

    it("uses the house password-prompt style: 'Sudo Password: <server name>' title, and explains why a second password is needed (P5)", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));

      expect(mockShowInputBox).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Sudo Password: Test Server",
          prompt: "Enter the sudo password for dev@example.com to save this file as root",
        })
      );
    });

    it("falls back to the raw serverId in the prompt when the server is unknown", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await broker.saveElevated("unknown-server", "/etc/hosts", Buffer.from("x"));

      expect(mockShowInputBox).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining("unknown-server") }));
    });

    it("re-prompts once when the sudo password is rejected, then succeeds", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValueOnce("bad").mockResolvedValueOnce("good");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError())
        .mockResolvedValueOnce(undefined);

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(true);

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(1, "srv-1", "/etc/hosts", expect.any(Buffer), { password: "bad", createMode: undefined });
      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(2, "srv-1", "/etc/hosts", expect.any(Buffer), { password: "good", createMode: undefined });
    });

    it("labels the retry prompt as a rejected password, not an identical unlabelled re-ask (P4a)", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValueOnce("bad").mockResolvedValueOnce("good");
      sftp.writeFileElevated
        .mockRejectedValueOnce(new SudoPasswordRequiredError())
        .mockResolvedValueOnce(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));

      const [firstPrompt] = mockShowInputBox.mock.calls[0];
      const [secondPrompt] = mockShowInputBox.mock.calls[1];
      expect(firstPrompt.prompt).not.toContain("Incorrect password");
      expect(secondPrompt.prompt).toBe("Incorrect password. Enter the sudo password for dev@example.com to save this file as root");
    });

    it("gives up with an error notification after the retry also fails, without re-prompting a third time", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValueOnce("bad").mockResolvedValueOnce("bad2");
      sftp.writeFileElevated.mockRejectedValue(new SudoPasswordRequiredError());

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
      expect(mockShowErrorMessage).toHaveBeenCalledTimes(1);
    });

    it("returns false without writing when the password prompt is cancelled", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValue(undefined);

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);

      expect(sftp.writeFileElevated).not.toHaveBeenCalled();
      expect(mockShowErrorMessage).not.toHaveBeenCalled();
    });

    it("returns false without writing when an empty password is submitted", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValue("");

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);
      expect(sftp.writeFileElevated).not.toHaveBeenCalled();
    });

    it("caches the password across calls when rememberPasswordForSession is true", async () => {
      rememberPassword = true;
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      await broker.saveElevated("srv-1", "/etc/other", Buffer.from("y"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(1);
      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(2, "srv-1", "/etc/other", expect.any(Buffer), { password: "s3cret", createMode: undefined });
    });

    it("does not cache the password when rememberPasswordForSession is false", async () => {
      rememberPassword = false;
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      await broker.saveElevated("srv-1", "/etc/other", Buffer.from("y"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
    });

    it("reports that elevated saves are disabled, offering an Open Settings button (P5), and never probes", async () => {
      sudoEnabled = false;
      mockShowErrorMessage.mockResolvedValue(undefined);

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);

      expect(sftp.probeElevation).not.toHaveBeenCalled();
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
      sftp.probeElevation.mockResolvedValue({ kind: "not-permitted", detail: "not in sudoers" });
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
      sftp.probeElevation.mockResolvedValue({ kind: "none" });
      sftp.writeFileElevated.mockRejectedValue(new ElevatedInstallFailedError("sudo exited with code 1"));

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        "Elevated save failed: sudo exited with code 1 The file may be partially written — keep the editor open and retry the save."
      );
    });

    it("does not append a partial-write warning to a generic (staging-phase) failure", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "none" });
      sftp.writeFileElevated.mockRejectedValue(new Error("ENOSPC: no space left on device"));

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);

      expect(mockShowErrorMessage).toHaveBeenCalledWith("Elevated save failed: ENOSPC: no space left on device");
    });

    it("falls through to an interactive password prompt when the probed 'none' timestamp expires before the install runs (P4b)", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "none" });
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
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValue("s3cret-value");
      sftp.writeFileElevated.mockRejectedValue(new Error("disk full"));

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));

      for (const call of mockShowErrorMessage.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("s3cret-value");
      }
    });
  });

  describe("rememberPasswordForSession toggled off mid-session (Codex round 3 finding A)", () => {
    it("re-prompts immediately instead of reusing a password cached while remembrance was on", async () => {
      rememberPassword = true;
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      expect(mockShowInputBox).toHaveBeenCalledTimes(1);

      rememberPassword = false;
      await broker.saveElevated("srv-1", "/etc/other", Buffer.from("y"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
    });

    it("drops the previously cached password (not just skips reading it), so re-enabling remembrance does not resurrect it", async () => {
      rememberPassword = true;
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValueOnce("first").mockResolvedValueOnce("second").mockResolvedValueOnce("third");
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x")); // caches "first"

      rememberPassword = false;
      await broker.saveElevated("srv-1", "/etc/a", Buffer.from("y")); // must re-prompt, must not cache "second"

      rememberPassword = true;
      await broker.saveElevated("srv-1", "/etc/b", Buffer.from("z")); // cache must be empty -> re-prompt for "third"

      expect(mockShowInputBox).toHaveBeenCalledTimes(3);
      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(3, "srv-1", "/etc/b", expect.any(Buffer), { password: "third", createMode: undefined });
    });
  });

  describe("passwordless fast path (probeElevation \"none\") and the remember-off cache clear (Codex round 5)", () => {
    it("drops a cached password before the fast path runs, so re-enabling remembrance does not resurrect it", async () => {
      // Defensive: a failing assertion partway through this test (expected pre-fix) can leave a
      // queued mockResolvedValueOnce unconsumed on this shared mock — clearAllMocks() in beforeEach
      // does not drain pending "once" implementations, only call history. Reset it so this test
      // can't leak state into whichever test runs next.
      mockShowInputBox.mockReset();
      rememberPassword = true;
      sftp.probeElevation.mockResolvedValueOnce({ kind: "password-required" });
      mockShowInputBox.mockResolvedValueOnce("first");
      sftp.writeFileElevated.mockResolvedValueOnce(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x")); // caches "first"
      expect(mockShowInputBox).toHaveBeenCalledTimes(1);

      rememberPassword = false;
      sftp.probeElevation.mockResolvedValueOnce({ kind: "none" }); // passwordless fast path
      sftp.writeFileElevated.mockResolvedValueOnce(undefined);

      await broker.saveElevated("srv-1", "/etc/other", Buffer.from("y")); // must drop the cache, not just skip it
      expect(mockShowInputBox).toHaveBeenCalledTimes(1); // fast path itself never prompts

      rememberPassword = true;
      sftp.probeElevation.mockResolvedValueOnce({ kind: "password-required" });
      mockShowInputBox.mockResolvedValueOnce("second");
      sftp.writeFileElevated.mockResolvedValueOnce(undefined);

      await broker.saveElevated("srv-1", "/etc/b", Buffer.from("z")); // cache must be empty -> re-prompt, not reuse "first"

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
      expect(sftp.writeFileElevated).toHaveBeenLastCalledWith("srv-1", "/etc/b", expect.any(Buffer), { password: "second", createMode: undefined });
    });

    it("leaves a cached password intact across the fast path when remembrance stays on (no regression)", async () => {
      mockShowInputBox.mockReset();
      rememberPassword = true;
      sftp.probeElevation.mockResolvedValueOnce({ kind: "password-required" });
      mockShowInputBox.mockResolvedValueOnce("s3cret");
      sftp.writeFileElevated.mockResolvedValueOnce(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x")); // caches "s3cret"

      sftp.probeElevation.mockResolvedValueOnce({ kind: "none" });
      sftp.writeFileElevated.mockResolvedValueOnce(undefined);
      await broker.saveElevated("srv-1", "/etc/other", Buffer.from("y")); // fast path, remembrance still on

      sftp.probeElevation.mockResolvedValueOnce({ kind: "password-required" });
      sftp.writeFileElevated.mockResolvedValueOnce(undefined);
      await broker.saveElevated("srv-1", "/etc/b", Buffer.from("z")); // should reuse the cache, no new prompt

      expect(mockShowInputBox).toHaveBeenCalledTimes(1);
      expect(sftp.writeFileElevated).toHaveBeenLastCalledWith("srv-1", "/etc/b", expect.any(Buffer), { password: "s3cret", createMode: undefined });
    });
  });

  describe("clearCachedPassword", () => {
    it("drops the cached password for a server, forcing a re-prompt on the next save", async () => {
      rememberPassword = true;
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      broker.clearCachedPassword("srv-1");
      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
    });
  });

  describe("dispose (P8)", () => {
    it("clears every cached password, forcing a re-prompt for any server on the next save", async () => {
      rememberPassword = true;
      sftp.probeElevation.mockResolvedValue({ kind: "password-required" });
      mockShowInputBox.mockResolvedValue("s3cret");
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));
      broker.dispose();
      await broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"));

      expect(mockShowInputBox).toHaveBeenCalledTimes(2);
    });
  });
});
