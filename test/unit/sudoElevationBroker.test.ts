import { beforeEach, describe, expect, it, vi } from "vitest";

const mockShowWarningMessage = vi.fn();
const mockShowInputBox = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockSetStatusBarMessage = vi.fn();

let sudoEnabled = true;
let rememberPassword = false;

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showInputBox: (...args: unknown[]) => mockShowInputBox(...args),
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    setStatusBarMessage: (...args: unknown[]) => mockSetStatusBarMessage(...args),
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
import { SudoPasswordRequiredError } from "../../src/services/sftp/elevatedWrite";
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

      await expect(broker.confirmElevation("/etc/hosts")).resolves.toBe(true);

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("/etc/hosts"),
        { modal: true },
        "Save as Root"
      );
    });

    it("resolves false when the user dismisses the modal", async () => {
      mockShowWarningMessage.mockResolvedValue(undefined);

      await expect(broker.confirmElevation("/etc/hosts")).resolves.toBe(false);
    });

    it("skips the modal entirely (returns false) when sudo.enabled is false", async () => {
      sudoEnabled = false;

      await expect(broker.confirmElevation("/etc/hosts")).resolves.toBe(false);
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });
  });

  describe("saveElevated", () => {
    it("writes without a password when sudo -n reports none needed", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "none" });
      sftp.writeFileElevated.mockResolvedValue(undefined);

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(true);

      expect(mockShowInputBox).not.toHaveBeenCalled();
      expect(sftp.writeFileElevated).toHaveBeenCalledWith("srv-1", "/etc/hosts", expect.any(Buffer));
      expect(mockSetStatusBarMessage).toHaveBeenCalledWith(expect.stringContaining("hosts"), 4000);
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
      expect(sftp.writeFileElevated).toHaveBeenCalledWith("srv-1", "/etc/hosts", expect.any(Buffer), { password: "s3cret" });
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
      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(1, "srv-1", "/etc/hosts", expect.any(Buffer), { password: "bad" });
      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(2, "srv-1", "/etc/hosts", expect.any(Buffer), { password: "good" });
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
      expect(sftp.writeFileElevated).toHaveBeenNthCalledWith(2, "srv-1", "/etc/other", expect.any(Buffer), { password: "s3cret" });
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

    it("reports that elevated saves are disabled and never probes when nexus.sftp.sudo.enabled is false", async () => {
      sudoEnabled = false;

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);

      expect(sftp.probeElevation).not.toHaveBeenCalled();
      expect(mockShowErrorMessage).toHaveBeenCalledTimes(1);
    });

    it("surfaces a non-password sudo failure (e.g. not permitted) without ever prompting for a password", async () => {
      sftp.probeElevation.mockResolvedValue({ kind: "not-permitted", detail: "not in sudoers" });
      sftp.writeFileElevated.mockRejectedValue(
        new Error("Elevation refused: this account is not permitted to run sudo on the remote host.")
      );

      await expect(broker.saveElevated("srv-1", "/etc/hosts", Buffer.from("x"))).resolves.toBe(false);

      expect(mockShowInputBox).not.toHaveBeenCalled();
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("not permitted to run sudo"));
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
});
