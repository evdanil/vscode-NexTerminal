import { beforeEach, describe, expect, it, vi } from "vitest";

const { fsPromisesMock } = vi.hoisted(() => ({
  fsPromisesMock: { stat: vi.fn() }
}));

vi.mock("node:fs", () => ({
  promises: fsPromisesMock,
  default: { promises: fsPromisesMock }
}));

const mockShowErrorMessage = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockExecuteCommand = vi.fn();
const mockGet = vi.fn();
const mockUpdate = vi.fn();

vi.mock("vscode", () => ({
  window: {
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args)
  },
  workspace: {
    getConfiguration: () => ({
      get: (...args: unknown[]) => mockGet(...args),
      update: (...args: unknown[]) => mockUpdate(...args)
    })
  },
  commands: {
    executeCommand: (...args: unknown[]) => mockExecuteCommand(...args)
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }
}));

import { offerUNCHostRemediation } from "../../src/ui/uncRemediation";

const HOST = "192.168.2.10";
const PROBE_PATH = "\\\\192.168.2.10\\share\\a.txt";

describe("offerUNCHostRemediation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockReturnValue(["existing.host"]);
    mockUpdate.mockResolvedValue(undefined);
    fsPromisesMock.stat.mockResolvedValue({ size: 0 });
  });

  describe("T28 — consent gate: a security setting is never written without explicit modal consent", () => {
    it("(a) dismissing the error toast writes nothing", async () => {
      mockShowErrorMessage.mockResolvedValue(undefined);

      await offerUNCHostRemediation(HOST, PROBE_PATH);

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        `VS Code blocked access to network host "${HOST}" (Windows UNC protection).`,
        "Allow Host…",
        "Open Settings"
      );
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });

    it("(b) clicking Allow Host… but cancelling the modal writes nothing", async () => {
      mockShowErrorMessage.mockResolvedValue("Allow Host…");
      mockShowWarningMessage.mockResolvedValue(undefined);

      await offerUNCHostRemediation(HOST, PROBE_PATH);

      // The modal must name both the host and the setting.
      const [message, options, action] = mockShowWarningMessage.mock.calls[0];
      expect(message).toContain(HOST);
      expect(message).toContain("security.allowedUNCHosts");
      expect(options).toEqual({ modal: true });
      expect(action).toBe("Allow");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("(c) modal Allow appends the host to the global setting, preserving existing entries", async () => {
      mockShowErrorMessage.mockResolvedValue("Allow Host…");
      mockShowWarningMessage.mockResolvedValue("Allow");

      await offerUNCHostRemediation(HOST, PROBE_PATH);

      expect(mockUpdate).toHaveBeenCalledWith("security.allowedUNCHosts", ["existing.host", HOST], 1);
    });

    it("(c) an already-allowed host is not duplicated", async () => {
      mockGet.mockReturnValue(["existing.host", "192.168.2.10"]);
      mockShowErrorMessage.mockResolvedValue("Allow Host…");
      mockShowWarningMessage.mockResolvedValue("Allow");

      await offerUNCHostRemediation(HOST, PROBE_PATH);

      expect(mockUpdate).toHaveBeenCalledWith("security.allowedUNCHosts", ["existing.host", "192.168.2.10"], 1);
    });

    it("(c) an already-allowed host is not duplicated when the existing entry differs in case", async () => {
      // The same-case fixture above passes even against a case-sensitive
      // `includes()`, so it cannot tell the two implementations apart. VS Code
      // lower-cases before matching its allowlist, so re-adding "NAS" next to
      // "nas" would leave a duplicate entry that grants nothing new.
      mockGet.mockReturnValue(["existing.host", "nas"]);
      mockShowErrorMessage.mockResolvedValue("Allow Host…");
      mockShowWarningMessage.mockResolvedValue("Allow");

      await offerUNCHostRemediation("NAS", "\\\\NAS\\share\\a.txt");

      expect(mockUpdate).toHaveBeenCalledWith("security.allowedUNCHosts", ["existing.host", "nas"], 1);
    });

    it("tolerates a non-array current value instead of corrupting the setting", async () => {
      mockGet.mockReturnValue("not-an-array");
      mockShowErrorMessage.mockResolvedValue("Allow Host…");
      mockShowWarningMessage.mockResolvedValue("Allow");

      await offerUNCHostRemediation(HOST, PROBE_PATH);

      expect(mockUpdate).toHaveBeenCalledWith("security.allowedUNCHosts", [HOST], 1);
    });

    it("Open Settings opens the setting and writes nothing", async () => {
      mockShowErrorMessage.mockResolvedValue("Open Settings");

      await offerUNCHostRemediation(HOST, PROBE_PATH);

      expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.openSettings", "security.allowedUNCHosts");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("falls back to Open Settings guidance when the settings write is rejected", async () => {
      mockShowErrorMessage.mockResolvedValueOnce("Allow Host…").mockResolvedValueOnce("Open Settings");
      mockShowWarningMessage.mockResolvedValue("Allow");
      mockUpdate.mockRejectedValue(new Error("write denied by policy"));

      await offerUNCHostRemediation(HOST, PROBE_PATH);

      expect(mockShowErrorMessage).toHaveBeenLastCalledWith(
        expect.stringContaining("write denied by policy"),
        "Open Settings"
      );
      expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.openSettings", "security.allowedUNCHosts");
    });
  });

  describe("T29 — the re-probe decides whether a reload is required", () => {
    beforeEach(() => {
      mockShowErrorMessage.mockResolvedValue("Allow Host…");
      mockShowWarningMessage.mockResolvedValue("Allow");
    });

    it("a succeeding probe reports success and never nags about reloading", async () => {
      fsPromisesMock.stat.mockResolvedValue({ size: 0 });

      await offerUNCHostRemediation(HOST, PROBE_PATH);

      expect(fsPromisesMock.stat).toHaveBeenCalledWith(PROBE_PATH);
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        `Host "${HOST}" allowed. Please repeat the upload/download.`
      );
      expect(mockExecuteCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
    });

    it("a still-failing probe offers Reload Window, and clicking it reloads", async () => {
      // The extension host's allowlist is fixed at spawn, so the settings write
      // alone usually does not unblock the current session.
      fsPromisesMock.stat.mockRejectedValue(
        Object.assign(new Error("still blocked"), { code: "ERR_UNC_HOST_NOT_ALLOWED" })
      );
      mockShowWarningMessage.mockResolvedValueOnce("Allow").mockResolvedValueOnce("Reload Window");

      await offerUNCHostRemediation(HOST, PROBE_PATH);

      expect(mockShowInformationMessage).not.toHaveBeenCalled();
      expect(mockShowWarningMessage).toHaveBeenLastCalledWith(
        expect.stringContaining("only takes effect after the window reloads"),
        "Reload Window"
      );
      expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
    });

    it("declining the reload prompt does not reload", async () => {
      fsPromisesMock.stat.mockRejectedValue(new Error("still blocked"));
      mockShowWarningMessage.mockResolvedValueOnce("Allow").mockResolvedValueOnce(undefined);

      await offerUNCHostRemediation(HOST, PROBE_PATH);

      expect(mockExecuteCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
    });
  });

  it("logs every decision to the diagnostics sink", async () => {
    const diagnostics = vi.fn();
    mockShowErrorMessage.mockResolvedValue(undefined);

    await offerUNCHostRemediation(HOST, PROBE_PATH, diagnostics);

    const logged = diagnostics.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toContain(HOST);
    expect(logged).toContain("dismissed");
  });
});
