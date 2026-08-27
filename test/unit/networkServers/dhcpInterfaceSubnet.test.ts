/**
 * @author kanekitakitos
 *
 * Unit tests for the NIC ↔ pool-subnet comparison in
 * `src/commands/networkServerSettings.ts`.
 *
 * The NIC list is built by calling the real `networkInterfaceBindOptions()`
 * over a mocked `node:os` rather than by handing the functions a literal array.
 * That is the point of several of these fixtures: WSL, Hyper-V and Docker NICs
 * sit on RFC1918 ranges and would match a lab pool with total confidence, so an
 * implementation that re-read `os.networkInterfaces()` for itself — instead of
 * consuming the list the picker already filtered — would suggest one of them.
 * The fixtures put an internal NIC *on the pool's subnet* so that mistake
 * changes the answer instead of being invisible.
 *
 * The other deliberate trap is the mask. Each fake NIC reports a `netmask` of
 * its own, and one fixture puts a NIC on a /16 that contains the pool's /24
 * without being on it: comparing under the NIC's mask says "match", comparing
 * under the pool's says "mismatch", and only the second is the question worth
 * asking.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const networkInterfaces = vi.hoisted(() => vi.fn());

vi.mock("node:os", () => ({ networkInterfaces }));

import { networkInterfaceBindOptions } from "../../../src/commands/networkInterfaceOptions";
import {
  dhcpInterfaceSubnetStatus,
  suggestBindAddressForPool
} from "../../../src/commands/networkServerSettings";

function ipv4(address: string, netmask = "255.255.255.0", internal = false) {
  return { address, netmask, family: "IPv4", internal };
}

/** The same filtered list the pickers use — never a raw `os` read. */
function options() {
  return networkInterfaceBindOptions();
}

beforeEach(() => {
  networkInterfaces.mockReset();
});

describe("dhcpInterfaceSubnetStatus — the all-interfaces bind", () => {
  it.each([
    ["an unset bind address", undefined],
    ["an empty bind address", ""],
    ["whitespace", "   "],
    ["the literal 0.0.0.0", "0.0.0.0"]
  ])("reports %s as all-interfaces even when the pool is somewhere else entirely", (_label, bindAddress) => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    expect(dhcpInterfaceSubnetStatus(bindAddress, "255.255.255.0", "10.0.0.10", options())).toBe("all-interfaces");
  });
});

describe("dhcpInterfaceSubnetStatus — a bound NIC", () => {
  it("matches a NIC on the pool's subnet", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.5")] });
    expect(dhcpInterfaceSubnetStatus("10.0.0.5", "255.255.255.0", "10.0.0.10", options())).toBe("match");
  });

  it("flags a NIC on a different subnet", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    expect(dhcpInterfaceSubnetStatus("192.168.1.20", "255.255.255.0", "10.0.0.10", options())).toBe("mismatch");
  });

  it("compares under the pool's mask, not under the NIC's own wider one", () => {
    // 10.0.1.20/16 contains 10.0.0.0/24 but is not on it. Under the NIC's mask
    // this is a match; under the pool's it is not, and the pool's is what the
    // clients will be told.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.1.20", "255.255.0.0")] });
    expect(dhcpInterfaceSubnetStatus("10.0.1.20", "255.255.255.0", "10.0.0.10", options())).toBe("mismatch");
    // Widen the *pool's* mask and the same pair does match — so the fixture is
    // discriminating rather than simply unmatchable.
    expect(dhcpInterfaceSubnetStatus("10.0.1.20", "255.255.0.0", "10.0.0.10", options())).toBe("match");
  });

  it("falls back to the packaged /24 pool when neither key is set", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")], eth1: [ipv4("10.9.9.9")] });
    expect(dhcpInterfaceSubnetStatus("192.168.2.5", undefined, undefined, options())).toBe("match");
    expect(dhcpInterfaceSubnetStatus("10.9.9.9", undefined, undefined, options())).toBe("mismatch");
  });
});

describe("dhcpInterfaceSubnetStatus — the cases that must stay quiet", () => {
  it("says nothing about a subnet when relay agents are allowed, with a bind that IS off-subnet", () => {
    // The fixture is genuinely off-subnet: a same-subnet one would read as a
    // pass under an implementation that ignored the flag entirely.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    expect(dhcpInterfaceSubnetStatus("192.168.1.20", "255.255.255.0", "10.0.0.10", options(), false)).toBe(
      "mismatch"
    );
    expect(dhcpInterfaceSubnetStatus("192.168.1.20", "255.255.255.0", "10.0.0.10", options(), true)).toBe("match");
  });

  it("reports an address no NIC holds as unknown rather than as a mismatch", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    // 172.16.9.9 is off the pool's subnet too — the point is that "this machine
    // does not have that address" is already reported elsewhere, and stacking a
    // subnet complaint on top of it would be guessing.
    expect(dhcpInterfaceSubnetStatus("172.16.9.9", "255.255.255.0", "10.0.0.10", options())).toBe(
      "unknown-address"
    );
  });

  it("reports an unusable pool mask rather than a mismatch", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    // Non-contiguous, and a bind that would otherwise read as a mismatch.
    expect(dhcpInterfaceSubnetStatus("192.168.1.20", "255.0.255.0", "10.0.0.10", options())).toBe("unusable-mask");
    expect(dhcpInterfaceSubnetStatus("192.168.1.20", "not-a-mask", "10.0.0.10", options())).toBe("unusable-mask");
    expect(dhcpInterfaceSubnetStatus("192.168.1.20", "255.255.255.0", "not-an-ip", options())).toBe("unusable-mask");
  });
});

describe("suggestBindAddressForPool", () => {
  it("suggests the one NIC on the pool's subnet", () => {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("10.0.0.5")],
      "Wi-Fi": [ipv4("192.168.1.20")]
    });
    expect(suggestBindAddressForPool("10.0.0.10", "255.255.255.0", options())).toEqual({
      address: "10.0.0.5",
      ambiguous: false
    });
  });

  it("ignores an internal NIC sitting on the very same subnet", () => {
    // The loopback and the WSL adapter both match the pool here. Only the
    // filtered list the picker offers may be considered, so the external NIC is
    // the answer — and it is unambiguous, because the internal ones were never
    // candidates.
    networkInterfaces.mockReturnValue({
      lo: [ipv4("10.0.0.1", "255.0.0.0", true)],
      "vEthernet (WSL)": [ipv4("10.0.0.99", "255.255.255.0", true)],
      eth0: [ipv4("10.0.0.5")]
    });
    expect(suggestBindAddressForPool("10.0.0.10", "255.255.255.0", options())).toEqual({
      address: "10.0.0.5",
      ambiguous: false
    });
  });

  it("reports two matching NICs as ambiguous instead of quietly picking the first", () => {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("10.0.0.5")],
      eth1: [ipv4("10.0.0.6")]
    });
    const suggestion = suggestBindAddressForPool("10.0.0.10", "255.255.255.0", options());
    expect(suggestion?.ambiguous).toBe(true);
  });

  it("suggests nothing at all when no NIC is on the pool's subnet", () => {
    // Explicitly NOT "the first available interface": binding a lab DHCP server
    // to an arbitrary NIC is the accident this whole comparison exists to avoid.
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.1.20")],
      "Wi-Fi": [ipv4("172.16.4.9", "255.255.0.0")]
    });
    expect(suggestBindAddressForPool("10.0.0.10", "255.255.255.0", options())).toBeUndefined();
  });

  it("never suggests the all-interfaces row", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    // The all-interfaces option carries an empty address, which masks to
    // 0.0.0.0 and would match a 0.0.0.0 pool network under a careless filter.
    expect(suggestBindAddressForPool("0.0.0.5", "255.255.255.0", options())).toBeUndefined();
  });

  it("suggests nothing when the pool's mask is unusable", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.5")] });
    expect(suggestBindAddressForPool("10.0.0.10", "255.0.255.0", options())).toBeUndefined();
  });

  it("suggests nothing when relay agents are allowed", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.5")] });
    expect(suggestBindAddressForPool("10.0.0.10", "255.255.255.0", options(), true)).toBeUndefined();
    // Without the flag the same fixture does produce a suggestion.
    expect(suggestBindAddressForPool("10.0.0.10", "255.255.255.0", options(), false)).toBeDefined();
  });
});

describe("networkInterfaceBindOptions — netmask passthrough", () => {
  it("carries each NIC's own netmask alongside its address", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.1.20", "255.255.0.0")] });
    expect(options()[1]).toEqual({ label: "eth0 — 10.0.1.20", value: "10.0.1.20", netmask: "255.255.0.0" });
  });

  it("omits the key when the platform reports no netmask", () => {
    networkInterfaces.mockReturnValue({ eth0: [{ address: "10.0.1.20", family: "IPv4", internal: false }] });
    expect(options()[1]).toEqual({ label: "eth0 — 10.0.1.20", value: "10.0.1.20" });
  });

  it("leaves the all-interfaces row without one", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.1.20")] });
    expect(options()[0]).toEqual({ label: "All interfaces (0.0.0.0)", value: "" });
  });
});
