/**
 * Unit tests for the validating settings read in `readDhcpConfig`
 * (`src/services/networkServers/networkServerManager.ts`).
 *
 * The wrong implementation these exist to kill is the original one: reading
 * every DHCP address with `readOptionalString` and forwarding whatever
 * `settings.json` held. `validateDhcpValues` guards the *form*, and the form is
 * not the only writer — a hand edit, a Settings Sync conflict or another
 * extension can put `192.168.2.` or an inverted pool under these keys without
 * going near it, and that value then reaches both the daemon and the sidebar
 * as the configuration in force. Every assertion below therefore pins a value
 * that a raw read would have returned verbatim.
 *
 * Two fixtures are deliberately adversarial:
 *  - `192.168.2.99` → `192.168.2.100` is a *valid* pool that a lexicographic
 *    string compare orders backwards, so an ordering check written with `>` on
 *    strings would wrongly discard it. Asserting it survives is what makes the
 *    inversion test non-vacuous.
 *  - `192.168.2.200` → `192.168.2.100` is the real inversion, and both ends
 *    must go, since dropping one leaves the survivor paired with a default
 *    from another subnet entirely.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig = vi.hoisted(() => new Map<string, unknown>());

vi.mock("vscode", () => ({
  workspace: {
    isTrusted: true,
    getConfiguration: (section: string) => ({
      get: (key: string, fallback?: unknown) => {
        const value = mockConfig.get(`${section}.${key}`);
        return value === undefined ? fallback : value;
      }
    })
  },
  window: {
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn(), show: vi.fn() }))
  }
}));

vi.mock("../../../src/services/networkServers/daemonHost", () => ({
  NetworkServerDaemonHost: class {
    public onDidChangeStatus = vi.fn(() => vi.fn());
    public onDidUpdateRuntime = vi.fn(() => vi.fn());
    public onDidConnection = vi.fn(() => vi.fn());
    public onDidLog = vi.fn(() => vi.fn());
    public onDidExit = vi.fn(() => vi.fn());
    public dispose = vi.fn();
  }
}));

import { readDhcpConfig, readTftpConfig } from "../../../src/services/networkServers/networkServerManager";

/** Silences (and captures) the one-per-distinct-fault console report. */
function captureWarnings(): { calls: () => string[]; restore: () => void } {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return {
    calls: () => spy.mock.calls.map((call) => String(call[0])),
    restore: () => {
      spy.mockRestore();
    }
  };
}

function set(key: string, value: unknown): void {
  mockConfig.set(`nexus.networkServers.dhcp.${key}`, value);
}

beforeEach(() => {
  mockConfig.clear();
  vi.restoreAllMocks();
});

describe("readDhcpConfig — malformed addresses fall back to the packaged default", () => {
  it("discards a rangeStart that is not a dotted quad", () => {
    const warnings = captureWarnings();
    set("rangeStart", "192.168.2.");
    // A raw read returns the literal "192.168.2." here.
    expect(readDhcpConfig().rangeStart).toBeUndefined();
    expect(warnings.calls().join(" ")).toContain("Pool Start");
    warnings.restore();
  });

  it("discards a rangeEnd with an out-of-range octet", () => {
    const warnings = captureWarnings();
    set("rangeStart", "192.168.2.10");
    set("rangeEnd", "192.168.2.300");
    const config = readDhcpConfig();
    expect(config.rangeEnd).toBeUndefined();
    // The end alone was malformed, so the start — which is fine — is kept.
    expect(config.rangeStart).toBe("192.168.2.10");
    expect(warnings.calls().join(" ")).toContain("Pool End");
    warnings.restore();
  });

  it("validates gateway, server identifier and broadcast on the same terms", () => {
    const warnings = captureWarnings();
    set("gateway", "not-an-ip");
    set("serverId", "10.0.0.1.5");
    set("broadcast", "10.0.0.255");
    const config = readDhcpConfig();
    expect(config.gateway).toBeUndefined();
    expect(config.serverId).toBeUndefined();
    expect(config.broadcast).toBe("10.0.0.255");
    warnings.restore();
  });

  it("discards a netmask whose set bits are not contiguous", () => {
    const warnings = captureWarnings();
    set("subnet", "255.0.255.0");
    expect(readDhcpConfig().subnet).toBeUndefined();
    warnings.restore();
  });

  it("keeps a well-formed netmask", () => {
    set("subnet", "255.255.254.0");
    expect(readDhcpConfig().subnet).toBe("255.255.254.0");
  });

  it("leaves an unset key unset, so the packaged default still applies", () => {
    const config = readDhcpConfig();
    expect(config.rangeStart).toBeUndefined();
    expect(config.rangeEnd).toBeUndefined();
    expect(config.subnet).toBeUndefined();
  });
});

describe("readDhcpConfig — pool ordering", () => {
  it("discards both ends of an inverted pool", () => {
    const warnings = captureWarnings();
    set("rangeStart", "192.168.2.200");
    set("rangeEnd", "192.168.2.100");
    const config = readDhcpConfig();
    expect(config.rangeStart).toBeUndefined();
    expect(config.rangeEnd).toBeUndefined();
    expect(warnings.calls().join(" ")).toContain("empty pool");
    warnings.restore();
  });

  it("keeps a pool that only a string compare would call inverted", () => {
    // "192.168.2.99" > "192.168.2.100" lexicographically; numerically it is not.
    set("rangeStart", "192.168.2.99");
    set("rangeEnd", "192.168.2.100");
    const config = readDhcpConfig();
    expect(config.rangeStart).toBe("192.168.2.99");
    expect(config.rangeEnd).toBe("192.168.2.100");
  });

  it("keeps a single-address pool, where start and end are equal", () => {
    set("rangeStart", "10.0.0.50");
    set("rangeEnd", "10.0.0.50");
    const config = readDhcpConfig();
    expect(config.rangeStart).toBe("10.0.0.50");
    expect(config.rangeEnd).toBe("10.0.0.50");
  });

  it("falls back a lone endpoint that becomes inverted against the adapter default", () => {
    const warnings = captureWarnings();
    set("rangeStart", "192.168.9.240");
    const config = readDhcpConfig();
    expect(config.rangeStart).toBeUndefined();
    expect(config.rangeEnd).toBeUndefined();
    expect(warnings.calls()).toHaveLength(1);
    expect(warnings.calls()[0]).toContain("dhcp.rangeStart");
    expect(warnings.calls()[0]).toContain("empty pool");
    warnings.restore();
  });
});

describe("readDhcpConfig — reporting", () => {
  it("reports a standing fault once rather than on every read", () => {
    const warnings = captureWarnings();
    set("gateway", "10.0.0");
    readDhcpConfig();
    readDhcpConfig();
    readDhcpConfig();
    expect(warnings.calls()).toHaveLength(1);
    warnings.restore();
  });

  it("reports again once the set of faults changes", () => {
    const warnings = captureWarnings();
    set("gateway", "10.0.1");
    readDhcpConfig();
    set("serverId", "10.0.2");
    readDhcpConfig();
    expect(warnings.calls()).toHaveLength(2);
    warnings.restore();
  });

  it("says nothing when every configured value is well formed", () => {
    const warnings = captureWarnings();
    set("rangeStart", "10.0.0.10");
    set("rangeEnd", "10.0.0.200");
    set("subnet", "255.255.255.0");
    set("gateway", "10.0.0.1");
    readDhcpConfig();
    expect(warnings.calls()).toHaveLength(0);
    warnings.restore();
  });
});

describe("readDhcpConfig — shared parser coverage", () => {
  it("keeps valid DNS and option-150 siblings while defaulting malformed values", () => {
    const warnings = captureWarnings();
    set("dns", ["1.1.1.1", "not-an-ip", "8.8.8.8"]);
    set("tftpServerAddresses", ["10.0.0.2", "bad-address"]);

    const config = readDhcpConfig();

    expect(config.dns).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(config.tftpServerAddresses).toEqual(["10.0.0.2"]);
    expect(warnings.calls()).toHaveLength(1);
    expect(warnings.calls()[0]).toContain("dhcp.dns[1]");
    expect(warnings.calls()[0]).toContain("dhcp.tftpServerAddresses[1]");
    warnings.restore();
  });

  it("canonicalizes valid reservations while keeping malformed static siblings out", () => {
    const warnings = captureWarnings();
    set("static", {
      "AA-BB-CC-DD-EE-FF": "10.0.0.50",
      "bad-mac": "10.0.0.51",
      "11:22:33:44:55:66": "not-an-ip"
    });

    expect(readDhcpConfig().static).toEqual({ "aa:bb:cc:dd:ee:ff": "10.0.0.50" });
    expect(warnings.calls()).toHaveLength(1);
    expect(warnings.calls()[0]).toContain("dhcp.static");
    warnings.restore();
  });

  it("drops an over-cap pool back to its adapter defaults and reports it once", () => {
    const warnings = captureWarnings();
    set("rangeStart", "10.0.0.0");
    set("rangeEnd", "10.1.0.0");

    const config = readDhcpConfig();
    expect(config.rangeStart).toBeUndefined();
    expect(config.rangeEnd).toBeUndefined();
    expect(warnings.calls()).toHaveLength(1);
    expect(warnings.calls()[0]).toContain("65,536");
    readDhcpConfig();
    expect(warnings.calls()).toHaveLength(1);
    warnings.restore();
  });

  it("drops a valid low end when a malformed start would pair it with an inverted default", () => {
    const warnings = captureWarnings();
    set("rangeStart", "not-an-ip");
    set("rangeEnd", "192.168.2.1");

    const config = readDhcpConfig();

    expect(config.rangeStart).toBeUndefined();
    expect(config.rangeEnd).toBeUndefined();
    expect(warnings.calls().join(" ")).toContain("dhcp.rangeEnd");
    warnings.restore();
  });

  it("drops a valid distant start when a malformed end would create an over-cap default pool", () => {
    const warnings = captureWarnings();
    set("rangeStart", "10.0.0.10");
    set("rangeEnd", "not-an-ip");

    const config = readDhcpConfig();

    expect(config.rangeStart).toBeUndefined();
    expect(config.rangeEnd).toBeUndefined();
    expect(warnings.calls().join(" ")).toContain("dhcp.rangeStart");
    warnings.restore();
  });

  it("drops a supplied endpoint that conflicts with an omitted default counterpart", () => {
    const warnings = captureWarnings();
    set("rangeEnd", "192.168.2.1");

    const config = readDhcpConfig();

    expect(config.rangeEnd).toBeUndefined();
    expect(warnings.calls().join(" ")).toContain("dhcp.rangeEnd");
    warnings.restore();
  });

  it("keeps exactly 65,536 range addresses but drops 65,537", () => {
    const warnings = captureWarnings();
    set("rangeStart", "10.0.0.0");
    set("rangeEnd", "10.0.255.255");
    expect(readDhcpConfig()).toMatchObject({ rangeStart: "10.0.0.0", rangeEnd: "10.0.255.255" });

    set("rangeEnd", "10.1.0.0");
    expect(readDhcpConfig().rangeStart).toBeUndefined();
    expect(readDhcpConfig().rangeEnd).toBeUndefined();
    expect(warnings.calls().join(" ")).toContain("65,536");
    warnings.restore();
  });

  it("defaults an over-limit vendor TLV aggregate instead of forwarding the parsed entries", () => {
    const warnings = captureWarnings();
    set("vendorSpecificOptions", [{ subOption: 1, value: "x".repeat(254) }]);

    expect(readDhcpConfig().vendorSpecificOptions).toBeUndefined();
    expect(warnings.calls().join(" ")).toContain("256 bytes");
    warnings.restore();
  });
});

describe("readTftpConfig — shared parser coverage", () => {
  it("defaults an invalid interface while warning once", () => {
    const warnings = captureWarnings();
    mockConfig.set("nexus.networkServers.tftp.interface", "not-an-ip");

    expect(readTftpConfig().interface).toBeUndefined();
    expect(readTftpConfig().port).toBe(69);
    expect(warnings.calls()).toHaveLength(1);
    expect(warnings.calls()[0]).toContain("tftp.interface");
    warnings.restore();
  });
});
