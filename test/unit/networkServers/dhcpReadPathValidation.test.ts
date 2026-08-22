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

import { readDhcpConfig } from "../../../src/services/networkServers/networkServerManager";

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

  it("does not report an inversion when one end is blank", () => {
    const warnings = captureWarnings();
    set("rangeStart", "192.168.9.240");
    const config = readDhcpConfig();
    expect(config.rangeStart).toBe("192.168.9.240");
    expect(config.rangeEnd).toBeUndefined();
    expect(warnings.calls()).toHaveLength(0);
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
