import { describe, expect, it } from "vitest";
import {
  MAX_DHCP_POOL_SIZE,
  parseDhcpConfig,
  parseNetworkServerConfigs,
  sanitizeDhcpConfig,
  sanitizeTftpConfig,
  type ValidationResult,
  validateDhcpFormInput,
  validateTftpFormInput,
} from "../../../src/services/networkServers/networkServerConfigValidation";

function expectValid<T>(result: ValidationResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected a valid result, received: ${result.errors.join("; ")}`);
  }
  return result.value;
}

function expectInvalid<T>(result: ValidationResult<T>, path: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.some((error) => error.includes(path))).toBe(true);
  }
}

const VALID_DHCP = {
  rangeStart: "10.0.0.10",
  rangeEnd: "10.0.0.20",
  subnet: "255.255.255.0",
  gateway: "10.0.0.1",
  dns: ["1.1.1.1", "8.8.8.8"],
  leaseTimeSec: 3600,
  serverId: "10.0.0.1",
  broadcast: "10.0.0.255",
  static: { "AA-BB-CC-DD-EE-FF": "10.0.0.50" },
  bindAddress: "0.0.0.0",
  leaseStorePath: "/tmp/nexus-dhcp.json",
  bootFileName: "boot.bin",
  nextServer: "10.0.0.2",
  tftpServerAddresses: ["10.0.0.2"],
  vendorClassId: "PXEClient",
  vendorSpecificOptions: [{ subOption: 1, value: "controller" }],
};

function staticReservations(count: number): Record<string, string> {
  const reservations: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    const octets = [2, 0, 0, (index >>> 8) & 255, index & 255, 1];
    const mac = octets.map((octet) => octet.toString(16).padStart(2, "0")).join(":");
    reservations[mac] = `10.1.${Math.floor(index / 254)}.${(index % 254) + 1}`;
  }
  return reservations;
}

describe("network-server configuration validation", () => {
  it("uses omitted optional values so adapters retain their documented defaults", () => {
    expect(expectValid(parseNetworkServerConfigs({}))).toEqual({});
    expect(expectValid(parseDhcpConfig({}))).toEqual({});
  });

  it("copies valid DTOs and canonicalizes static reservation MAC addresses", () => {
    const source = { ...VALID_DHCP, dns: [...VALID_DHCP.dns], static: { ...VALID_DHCP.static } };
    const parsed = expectValid(parseDhcpConfig(source));
    expect(parsed.static).toEqual({ "aa:bb:cc:dd:ee:ff": "10.0.0.50" });

    source.dns[0] = "9.9.9.9";
    source.static["AA-BB-CC-DD-EE-FF"] = "10.0.0.99";
    expect(parsed.dns).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(parsed.static).toEqual({ "aa:bb:cc:dd:ee:ff": "10.0.0.50" });
  });

  it.each([
    ["rangeStart", "not-an-ip", "dhcp.rangeStart"],
    ["rangeEnd", "10.0.0.999", "dhcp.rangeEnd"],
    ["subnet", "255.0.255.0", "dhcp.subnet"],
    ["gateway", "10.0.0", "dhcp.gateway"],
    ["serverId", "10.0.0.1.2", "dhcp.serverId"],
    ["broadcast", "300.0.0.1", "dhcp.broadcast"],
    ["bindAddress", "localhost", "dhcp.bindAddress"],
    ["nextServer", "tftp.example.test", "dhcp.nextServer"],
  ])("rejects malformed IPv4 scalar %s", (key, value, path) => {
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, [key]: value }), path);
  });

  it("rejects malformed DNS, option 150, and static reservation addresses", () => {
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, dns: ["1.1.1.1", "bad"] }), "dhcp.dns[1]");
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, tftpServerAddresses: ["bad"] }), "dhcp.tftpServerAddresses[0]");
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, static: { "aa:bb:cc:dd:ee:ff": "bad" } }), "dhcp.static");
  });

  it("requires canonicalizable MAC reservation keys", () => {
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, static: { "aa:bb:cc:dd:ee": "10.0.0.50" } }), "dhcp.static");
    expectInvalid(
      parseDhcpConfig({
        ...VALID_DHCP,
        static: { "AA-BB-CC-DD-EE-FF": "10.0.0.50", "aa:bb:cc:dd:ee:ff": "10.0.0.51" },
      }),
      "dhcp.static",
    );
  });

  it("rejects inverted ranges and caps the effective DHCP pool at the allocator limit", () => {
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, rangeStart: "10.0.0.20", rangeEnd: "10.0.0.10" }), "dhcp.rangeStart");
    expectValid(parseDhcpConfig({ ...VALID_DHCP, rangeStart: "10.0.0.0", rangeEnd: "10.0.255.255" }));
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, rangeStart: "10.0.0.0", rangeEnd: "10.1.0.0" }), "dhcp.rangeEnd");
    expect(MAX_DHCP_POOL_SIZE).toBe(65_536);
  });

  it("requires safe integer port and lease values within their operational bounds", () => {
    expectInvalid(parseNetworkServerConfigs({ tftp: { port: -1 } }), "tftp.port");
    expectInvalid(parseNetworkServerConfigs({ tftp: { port: 1.5 } }), "tftp.port");
    expectInvalid(parseNetworkServerConfigs({ tftp: { port: Number.MAX_SAFE_INTEGER + 1 } }), "tftp.port");
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, leaseTimeSec: 59 }), "dhcp.leaseTimeSec");
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, leaseTimeSec: 604_801 }), "dhcp.leaseTimeSec");
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, leaseTimeSec: 3.5 }), "dhcp.leaseTimeSec");
  });

  it("bounds DHCP strings, address arrays, and option-43 TLV bytes before adapter creation", () => {
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, bootFileName: "x".repeat(256) }), "dhcp.bootFileName");
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, dns: Array.from({ length: 17 }, () => "1.1.1.1") }), "dhcp.dns");
    expectInvalid(
      parseDhcpConfig({ ...VALID_DHCP, vendorSpecificOptions: [{ subOption: 1, value: "x".repeat(254) }] }),
      "dhcp.vendorSpecificOptions",
    );
  });

  it("accepts exact lower and upper operational validation boundaries", () => {
    expectValid(parseNetworkServerConfigs({
      tftp: { root: "x", port: 0, interface: "0.0.0.0" },
      dhcp: {
        ...VALID_DHCP,
        bootFileName: "x".repeat(255),
        leaseTimeSec: 60,
        dns: Array.from({ length: 16 }, () => "1.1.1.1"),
        tftpServerAddresses: Array.from({ length: 16 }, () => "10.0.0.2"),
        vendorSpecificOptions: [{ subOption: 1, value: "x".repeat(253) }],
      },
    }));
    expectValid(parseNetworkServerConfigs({ tftp: { root: "x".repeat(4_096), port: 65_535 } }));
    expectValid(parseDhcpConfig({
      ...VALID_DHCP,
      dns: [],
      tftpServerAddresses: [],
      static: {},
      vendorSpecificOptions: [],
      leaseTimeSec: 604_800,
    }));
  });

  it("rejects values immediately beyond every bounded parser boundary", () => {
    expectInvalid(parseNetworkServerConfigs({ tftp: { root: "x".repeat(4_097), port: 65_536 } }), "tftp");
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, bootFileName: "x".repeat(256) }), "dhcp.bootFileName");
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, dns: Array.from({ length: 17 }, () => "1.1.1.1") }), "dhcp.dns");
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, tftpServerAddresses: Array.from({ length: 17 }, () => "10.0.0.2") }), "dhcp.tftpServerAddresses");
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, leaseTimeSec: 604_801 }), "dhcp.leaseTimeSec");
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, vendorSpecificOptions: [{ subOption: 1, value: "x".repeat(254) }] }), "dhcp.vendorSpecificOptions");
  });

  it("accepts exact static/vendor entry limits and rejects the first excess entry", () => {
    expectValid(parseDhcpConfig({
      ...VALID_DHCP,
      static: staticReservations(1_024),
      vendorSpecificOptions: Array.from({ length: 64 }, (_, index) => ({ subOption: index + 1, value: "x" })),
    }));
    expectInvalid(parseDhcpConfig({ ...VALID_DHCP, static: staticReservations(1_025) }), "dhcp.static");
    expectInvalid(
      parseDhcpConfig({
        ...VALID_DHCP,
        vendorSpecificOptions: Array.from({ length: 65 }, (_, index) => ({ subOption: index + 1, value: "x" })),
      }),
      "dhcp.vendorSpecificOptions",
    );
  });

  it("drops an over-limit vendor TLV field when settings are tolerated", () => {
    const exact = sanitizeDhcpConfig({ vendorSpecificOptions: [{ subOption: 1, value: "x".repeat(253) }] });
    expect(exact.value.vendorSpecificOptions).toEqual([{ subOption: 1, value: "x".repeat(253) }]);
    expect(exact.warnings).toEqual([]);

    const oversize = sanitizeDhcpConfig({ vendorSpecificOptions: [{ subOption: 1, value: "x".repeat(254) }] });
    expect(oversize.value.vendorSpecificOptions).toBeUndefined();
    expect(oversize.warnings.join(" ")).toContain("256 bytes");
  });

  it("returns pathful validation results without coercing hostile root or nested values", () => {
    const hostile = {
      toString(): never {
        throw new Error("unexpected coercion");
      },
      valueOf(): never {
        throw new Error("unexpected coercion");
      },
    };

    expect(() => parseDhcpConfig(hostile)).not.toThrow();
    expectInvalid(parseDhcpConfig({ gateway: hostile }), "dhcp.gateway");
    expect(() => parseNetworkServerConfigs(hostile)).not.toThrow();
    expect(() => sanitizeDhcpConfig(hostile)).not.toThrow();
    expect(() => sanitizeTftpConfig(hostile)).not.toThrow();
    expect(() => sanitizeDhcpConfig({ gateway: hostile })).not.toThrow();
    expect(() => sanitizeTftpConfig({ interface: hostile })).not.toThrow();
    expect(() => validateDhcpFormInput(hostile)).not.toThrow();
    expect(() => validateDhcpFormInput({ gateway: hostile })).not.toThrow();
    expect(validateDhcpFormInput({ gateway: hostile })).toContain("Gateway");
    expect(() => validateTftpFormInput(hostile)).not.toThrow();
    expect(() => validateTftpFormInput({ interface: hostile })).not.toThrow();
  });

  it("uses the shared parser for TFTP form values while reserving port zero for non-form DTOs", () => {
    expect(validateTftpFormInput({ root: "/srv/tftp", port: "69", allowWrite: "on", interface: "192.168.2.1" })).toBeUndefined();
    expect(validateTftpFormInput({ port: "1" })).toBeUndefined();
    expect(validateTftpFormInput({ port: "65535" })).toBeUndefined();
    expect(validateTftpFormInput({ interface: "not-an-ip" })).toContain("Interface");
    expect(validateTftpFormInput({ port: "1.5" })).toContain("Port");
    expect(validateTftpFormInput({ port: "0" })).toContain("between 1 and 65535");
    expect(validateTftpFormInput({ port: "65536" })).toContain("Port");
    expect(validateTftpFormInput({ root: "x".repeat(4_097) })).toContain("Root");
  });

  it("rejects unknown keys at every daemon DTO level", () => {
    expectInvalid(parseNetworkServerConfigs({ ftp: {} }), "configs.ftp");
    expectInvalid(parseNetworkServerConfigs({ dhcp: { ...VALID_DHCP, unexpected: true } }), "dhcp.unexpected");
    expectInvalid(parseNetworkServerConfigs({ tftp: { port: 69, unknown: true } }), "tftp.unknown");
  });

  it("reuses parser field output for the form's first error without changing its existing copy", () => {
    expect(validateDhcpFormInput({ gateway: "not-an-ip" })).toBe(
      'Gateway must be a dotted-quad IPv4 address (got "not-an-ip").',
    );
    expect(validateDhcpFormInput({ rangeStart: "192.168.2.200", rangeEnd: "192.168.2.100" })).toBe(
      "Pool Start (192.168.2.200) must not be higher than Pool End (192.168.2.100).",
    );
  });

  it("treats any explicitly supplied invalid pool count as a form error", () => {
    for (const value of ["not-a-number", Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1.5, 0, -1, 65_537]) {
      expect(validateDhcpFormInput({ poolCount: value })).toMatch(/Pool Count/);
    }
    expect(validateDhcpFormInput({})).toBeUndefined();
    expect(validateDhcpFormInput({ rangeStart: "10.0.0.0", poolCount: 65_536 })).toBeUndefined();
  });
});
