import { describe, expect, it } from "vitest";
import {
  MAX_DHCP_POOL_SIZE,
  parseDhcpConfig,
  parseNetworkServerConfigs,
  type ValidationResult,
  validateDhcpFormInput,
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
});
