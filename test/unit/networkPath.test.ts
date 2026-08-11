import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSFER_TUNING,
  NETWORK_TRANSFER_TUNING,
  getUNCHost,
  isUNCAccessError,
  isWindowsNetworkPath,
  recordBlockedUNCHost,
  resolveTransferTuning,
  type BlockedUNCHosts
} from "../../src/utils/networkPath";

describe("isWindowsNetworkPath (T-N1)", () => {
  it("recognizes every Windows network-path spelling on win32", () => {
    expect(isWindowsNetworkPath("\\\\nas\\share\\f", "win32")).toBe(true);
    expect(isWindowsNetworkPath("//nas/share/f", "win32")).toBe(true);
    expect(isWindowsNetworkPath("\\\\?\\UNC\\nas\\s\\f", "win32")).toBe(true);
    expect(isWindowsNetworkPath("\\\\.\\UNC\\nas\\s\\f", "win32")).toBe(true);
  });

  it("does not treat a drive-letter path as a network path", () => {
    expect(isWindowsNetworkPath("C:\\f", "win32")).toBe(false);
  });

  it("never treats a POSIX path as a network path, even a double-slash one", () => {
    // Rooted at platform, not at the string: `//foo` is an ordinary path on
    // Linux/macOS and must not get the throttled profile there.
    expect(isWindowsNetworkPath("\\\\nas\\s", "linux")).toBe(false);
    expect(isWindowsNetworkPath("//nas/s", "linux")).toBe(false);
    expect(isWindowsNetworkPath("/home/dev/f", "linux")).toBe(false);
  });
});

describe("resolveTransferTuning (T-N1)", () => {
  it("throttles concurrency for UNC sources and keeps ssh2's defaults elsewhere", () => {
    expect(resolveTransferTuning("\\\\nas\\share\\big.bin", "win32")).toEqual(NETWORK_TRANSFER_TUNING);
    expect(resolveTransferTuning("\\\\nas\\share\\big.bin", "win32").concurrency).toBe(8);
    expect(resolveTransferTuning("C:\\big.bin", "win32")).toEqual(DEFAULT_TRANSFER_TUNING);
    expect(resolveTransferTuning("C:\\big.bin", "win32").concurrency).toBe(64);
    expect(resolveTransferTuning("/tmp/big.bin", "linux")).toEqual(DEFAULT_TRANSFER_TUNING);
  });
});

describe("getUNCHost (T-N2)", () => {
  it("extracts the host from each UNC root form", () => {
    expect(getUNCHost("\\\\192.168.2.10\\share\\a.txt")).toBe("192.168.2.10");
    expect(getUNCHost("\\\\?\\UNC\\srv\\s\\f")).toBe("srv");
    expect(getUNCHost("\\\\.\\UNC\\srv\\s\\f")).toBe("srv");
    expect(getUNCHost("//srv/share/f")).toBe("srv");
  });

  it("returns undefined for non-UNC paths", () => {
    expect(getUNCHost("C:\\f")).toBeUndefined();
    expect(getUNCHost("/home/dev/f")).toBeUndefined();
    // Host present but no path component — not something we can probe.
    expect(getUNCHost("\\\\srv")).toBeUndefined();
  });
});

describe("isUNCAccessError (T-N3)", () => {
  it("matches the Node error code VS Code's UNC restriction raises", () => {
    expect(isUNCAccessError(Object.assign(new Error("nope"), { code: "ERR_UNC_HOST_NOT_ALLOWED" }))).toBe(true);
  });

  it("does NOT match on message text — the laundered workspace.fs error must not trip it", () => {
    // This is the shape `vscode.workspace.fs` produces for the very same
    // failure: the real code is replaced with "Unknown" and the original text
    // appended. An implementation that string-matched the message would fire
    // here, then break the day VS Code rewords the message.
    const laundered = Object.assign(
      new Error(
        "UNC host '192.168.2.10' access is not allowed. Please update the 'security.allowedUNCHosts' setting if you want to allow this host."
      ),
      { code: "Unknown" }
    );
    expect(isUNCAccessError(laundered)).toBe(false);
  });

  it("is false for unrelated errors and non-objects", () => {
    expect(isUNCAccessError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isUNCAccessError(new Error("plain"))).toBe(false);
    expect(isUNCAccessError(undefined)).toBe(false);
    expect(isUNCAccessError("ERR_UNC_HOST_NOT_ALLOWED")).toBe(false);
  });
});

describe("recordBlockedUNCHost (T-N4)", () => {
  it("collapses spellings that differ only in case into one entry", () => {
    const collected: BlockedUNCHosts = new Map();

    expect(recordBlockedUNCHost(collected, "\\\\NAS\\share\\a.txt")).toBe(true);
    expect(recordBlockedUNCHost(collected, "\\\\nas\\share\\b.txt")).toBe(true);

    // Windows treats these as one host, so one operation must produce one
    // consent flow — not one per spelling.
    expect(collected.size).toBe(1);
  });

  it("keeps the first spelling seen, so messages echo what the user typed", () => {
    const collected: BlockedUNCHosts = new Map();

    recordBlockedUNCHost(collected, "\\\\NAS\\share\\a.txt");
    recordBlockedUNCHost(collected, "\\\\nas\\share\\b.txt");

    expect([...collected.values()]).toEqual([{ host: "NAS", probePath: "\\\\NAS\\share\\a.txt" }]);
  });

  it("keeps genuinely different hosts apart", () => {
    const collected: BlockedUNCHosts = new Map();

    recordBlockedUNCHost(collected, "\\\\nas\\share\\a.txt");
    recordBlockedUNCHost(collected, "\\\\backup\\share\\a.txt");

    expect([...collected.keys()]).toEqual(["nas", "backup"]);
  });

  it("records nothing for a path with no UNC host", () => {
    const collected: BlockedUNCHosts = new Map();

    expect(recordBlockedUNCHost(collected, "C:\\local\\a.txt")).toBe(false);
    expect(collected.size).toBe(0);
  });
});
