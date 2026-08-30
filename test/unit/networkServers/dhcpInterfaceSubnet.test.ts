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
  refreshDhcpServerIdentifier,
  resolveDhcpServerIdentifier,
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
  ])("reports %s as all-interfaces when a NIC on this machine IS on the pool's subnet", (_label, bindAddress) => {
    // eth1 is the one that can serve 10.0.0.0/24; eth0 is there so the fixture
    // is not simply "everything matches".
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")], eth1: [ipv4("10.0.0.5")] });
    expect(dhcpInterfaceSubnetStatus(bindAddress, "255.255.255.0", "10.0.0.10", options())).toBe("all-interfaces");
  });

  /**
   * REVIEW FINDING (P2) — this block previously asserted "all-interfaces even
   * when the pool is somewhere else entirely", which is the defect written down
   * as an expectation. Listening on every NIC does not put the machine on a
   * wire it holds no address on: the fixture below binds everything, offers
   * 10.0.0.x, and has nothing but a 192.168.1.x NIC to offer it from, which is
   * exactly as unreachable as binding that NIC by name — and was the one
   * arrangement reported as clean.
   */
  it.each([
    ["an unset bind address", undefined],
    ["an empty bind address", ""],
    ["whitespace", "   "],
    ["the literal 0.0.0.0", "0.0.0.0"]
  ])("reports %s as off-subnet when NO NIC on this machine is on the pool's subnet", (_label, bindAddress) => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    expect(dhcpInterfaceSubnetStatus(bindAddress, "255.255.255.0", "10.0.0.10", options())).toBe(
      "all-interfaces-off-subnet"
    );
  });

  it("ignores the all-interfaces row itself when looking for a NIC on the subnet", () => {
    // The list's first entry carries an empty address, which masks to 0.0.0.0
    // and would "match" a 0.0.0.0 pool under a careless filter — answering
    // "all-interfaces, fine" for a pool no NIC can serve.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    expect(dhcpInterfaceSubnetStatus("", "255.255.255.0", "0.0.0.5", options())).toBe("all-interfaces-off-subnet");
  });

  it("compares under the pool's mask here too, not under each NIC's own wider one", () => {
    // 10.0.1.20/16 contains 10.0.0.0/24 without being on it — the same trap the
    // bound-NIC case is checked against, applied to the whole list.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.1.20", "255.255.0.0")] });
    expect(dhcpInterfaceSubnetStatus("", "255.255.255.0", "10.0.0.10", options())).toBe("all-interfaces-off-subnet");
    expect(dhcpInterfaceSubnetStatus("", "255.255.0.0", "10.0.0.10", options())).toBe("all-interfaces");
  });

  it("only ever considers the FILTERED list, so a WSL or Docker NIC cannot vouch for the pool", () => {
    // The internal adapter is on the pool's subnet and the real NIC is not.
    // Re-reading os.networkInterfaces() here — or being handed a raw read —
    // would report this unreachable pool as fine.
    networkInterfaces.mockReturnValue({
      "vEthernet (WSL)": [ipv4("10.0.0.99", "255.255.255.0", true)],
      eth0: [ipv4("192.168.1.20")]
    });
    expect(dhcpInterfaceSubnetStatus("", "255.255.255.0", "10.0.0.10", options())).toBe("all-interfaces-off-subnet");
  });

  it("stays quiet with relay agents allowed, even with no NIC on the pool's subnet", () => {
    // The same unreachable fixture as above, one flag apart: a relay agent in
    // front of the service is precisely the case where serving a subnet this
    // machine is not on is the intended configuration.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    expect(dhcpInterfaceSubnetStatus("", "255.255.255.0", "10.0.0.10", options(), false)).toBe(
      "all-interfaces-off-subnet"
    );
    expect(dhcpInterfaceSubnetStatus("", "255.255.255.0", "10.0.0.10", options(), true)).toBe("all-interfaces");
  });

  it("reports an unusable pool mask rather than an off-subnet all-interfaces bind", () => {
    // Non-contiguous, and a NIC list that would otherwise read as off-subnet:
    // there is no subnet to be off, so whatever reports the bad mask reports it.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    expect(dhcpInterfaceSubnetStatus("", "255.0.255.0", "10.0.0.10", options())).toBe("unusable-mask");
    expect(dhcpInterfaceSubnetStatus("", "255.255.255.0", "not-an-ip", options())).toBe("unusable-mask");
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

/**
 * REVIEW FINDING (P2) — masking under the pool's mask alone is only half the
 * question. A NIC on a NARROWER mask than the pool passes that check while its
 * own routing table disagrees: `10.0.0.254/25` is on `10.0.0.128`–`10.0.0.255`,
 * so a client leased `10.0.0.10` out of a `10.0.0.0/24` pool is, to this host,
 * not on the serving link at all. The broadcast DISCOVER still arrives, which is
 * why the arrangement looks configured; the unicast REQUEST/ACK renewal does not
 * come back off that interface.
 */
describe("dhcpInterfaceSubnetStatus — the NIC's own mask has to cover the pool", () => {
  it("flags a NIC on a narrower mask than the pool it would serve", () => {
    // 10.0.0.254 masks into 10.0.0.0/24 exactly as a legitimate NIC would, so
    // the address-only comparison this replaces called it a match.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.254", "255.255.255.128")] });
    expect(dhcpInterfaceSubnetStatus("10.0.0.254", "255.255.255.0", "10.0.0.10", options())).toBe("mismatch");
    // Narrow the POOL to the NIC's own /25 and the same pair is fine — the
    // fixture discriminates on the masks, not on the address.
    expect(dhcpInterfaceSubnetStatus("10.0.0.254", "255.255.255.128", "10.0.0.200", options())).toBe("match");
  });

  it("does not let a narrower NIC vouch for the pool under an all-interfaces bind either", () => {
    // The list-wide half of the same defect: nothing here can serve the /24, so
    // binding everything is as off-subnet as binding that one NIC by name.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.254", "255.255.255.128")] });
    expect(dhcpInterfaceSubnetStatus("", "255.255.255.0", "10.0.0.10", options())).toBe("all-interfaces-off-subnet");
  });

  it("still matches a NIC whose own mask is WIDER than the pool's", () => {
    // 10.0.0.5/16's own link contains every address a 10.0.0.0/24 pool could
    // ever lease, so this machine really is on-link for all of it. Guards
    // against a fix that demanded the two masks be equal.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.5", "255.255.0.0")] });
    expect(dhcpInterfaceSubnetStatus("10.0.0.5", "255.255.255.0", "10.0.0.10", options())).toBe("match");
    expect(dhcpInterfaceSubnetStatus("", "255.255.255.0", "10.0.0.10", options())).toBe("all-interfaces");
  });

  it("still matches the flat single-subnet case, where the two masks are equal", () => {
    // The overwhelming majority of real setups. A stricter-than-intended check
    // would break every one of them.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.5", "255.255.255.0")] });
    expect(dhcpInterfaceSubnetStatus("10.0.0.5", "255.255.255.0", "10.0.0.10", options())).toBe("match");
  });

  it("refuses to call a NIC reported without a netmask a match, rather than assuming one", () => {
    // The address alone would say yes. There is nothing to verify the coverage
    // with, and this file does not guess about a bind — same restraint as
    // suggestBindAddressForPool's refusal to fall back to an arbitrary NIC.
    networkInterfaces.mockReturnValue({ eth0: [{ address: "10.0.0.5", family: "IPv4", internal: false }] });
    expect(dhcpInterfaceSubnetStatus("10.0.0.5", "255.255.255.0", "10.0.0.10", options())).toBe("mismatch");
    expect(dhcpInterfaceSubnetStatus("", "255.255.255.0", "10.0.0.10", options())).toBe("all-interfaces-off-subnet");
  });

  it("refuses one whose reported mask is non-contiguous", () => {
    // A mask that cannot be turned into a prefix length is as unverifiable as a
    // missing one; the pool's own bad mask is reported separately as unusable.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.5", "255.0.255.0")] });
    expect(dhcpInterfaceSubnetStatus("10.0.0.5", "255.255.255.0", "10.0.0.10", options())).toBe("mismatch");
  });
});

describe("suggestBindAddressForPool — the NIC's own mask has to cover the pool", () => {
  it("never offers a NIC on a narrower mask than the pool", () => {
    // The suggestion has to agree with the status above, or the warning fires
    // on a pool the picker is happy to auto-select an address for.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.254", "255.255.255.128")] });
    expect(suggestBindAddressForPool("10.0.0.10", "255.255.255.0", options())).toBeUndefined();
    // The same NIC IS the answer for a pool it actually covers.
    expect(suggestBindAddressForPool("10.0.0.200", "255.255.255.128", options())).toEqual({
      address: "10.0.0.254",
      ambiguous: false
    });
  });

  it("stops a narrower NIC from making a genuine one look ambiguous", () => {
    // eth1 is the only NIC that can serve this /24. Counting eth0 as a second
    // match would report a coin toss and suppress the auto-selection entirely.
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("10.0.0.254", "255.255.255.128")],
      eth1: [ipv4("10.0.0.5", "255.255.255.0")]
    });
    expect(suggestBindAddressForPool("10.0.0.10", "255.255.255.0", options())).toEqual({
      address: "10.0.0.5",
      ambiguous: false
    });
  });

  it("offers a NIC on a wider mask, and none at all for one reported without a mask", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.5", "255.255.0.0")] });
    expect(suggestBindAddressForPool("10.0.0.10", "255.255.255.0", options())?.address).toBe("10.0.0.5");

    networkInterfaces.mockReturnValue({ eth0: [{ address: "10.0.0.5", family: "IPv4", internal: false }] });
    expect(suggestBindAddressForPool("10.0.0.10", "255.255.255.0", options())).toBeUndefined();
  });
});

/**
 * REVIEW FINDING — the coverage check above used to be a PREFIX comparison: the
 * NIC's own mask had to be equal or wider than the pool's, i.e. it had to be
 * on-link for the entire ADVERTISED subnet. That is only the right question for
 * a pool that fills its subnet, and a hand-configured one often does not.
 *
 * The pool the report named — `10.0.0.130`–`10.0.0.200` advertised on a /24 — is
 * served perfectly by a `10.0.0.254/25` NIC: every address it hands out is on
 * `10.0.0.128/25`. Only the lower half of the /24, which the pool never touches,
 * is off-link. `/25 <= /24` is false regardless, so the sidebar warned, the
 * matching-NIC suggestion vanished, and server-ID resolution declined a bind
 * that was never wrong.
 *
 * The window is now compared directly, so each fixture below moves the pool's
 * own extent and nothing else. Where an END alone can decide the answer the NIC
 * is a /26, whose link stops short of the subnet broadcast: with a /25 NIC every
 * end inside the advertised /24 is covered, so a /25 fixture would be answering
 * about the START and reading as though it were about the end.
 */
describe("dhcpInterfaceSubnetStatus — the pool's configured range, not the whole subnet", () => {
  it("accepts the exact arrangement the report named", () => {
    // Pool 10.0.0.130–10.0.0.200 advertised on a /24, served from 10.0.0.128/25.
    // Every address it hands out is on that NIC's own link; only the lower half
    // of the /24, which the pool never touches, is not. `/25 <= /24` is false,
    // so the prefix comparison this replaces called it a mismatch.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.254", "255.255.255.128")] });
    expect(
      dhcpInterfaceSubnetStatus("10.0.0.254", "255.255.255.0", "10.0.0.130", options(), false, "10.0.0.200")
    ).toBe("match");
    // The same NIC and the same advertised subnet, with the pool's START moved
    // into the half it is NOT on: still a mismatch, so the fixture above is
    // discriminating on the pool's extent rather than simply unrejectable.
    expect(
      dhcpInterfaceSubnetStatus("10.0.0.254", "255.255.255.0", "10.0.0.10", options(), false, "10.0.0.200")
    ).toBe("mismatch");
  });

  it("says the same for an all-interfaces bind", () => {
    // The list-wide half of the question: that NIC really can serve this pool,
    // so binding everything reaches it — and cannot for the wider one.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.254", "255.255.255.128")] });
    expect(dhcpInterfaceSubnetStatus("", "255.255.255.0", "10.0.0.130", options(), false, "10.0.0.200")).toBe(
      "all-interfaces"
    );
    expect(dhcpInterfaceSubnetStatus("", "255.255.255.0", "10.0.0.10", options(), false, "10.0.0.200")).toBe(
      "all-interfaces-off-subnet"
    );
  });

  it("turns on the END alone, and falls back to the subnet broadcast without one", () => {
    // eth0 is 10.0.0.128/26 — 10.0.0.128 through 10.0.0.191 — and the pool
    // starts inside that link in all three calls, so ONLY the end can decide.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.130", "255.255.255.192")] });
    expect(
      dhcpInterfaceSubnetStatus("10.0.0.130", "255.255.255.0", "10.0.0.130", options(), false, "10.0.0.190")
    ).toBe("match");
    expect(
      dhcpInterfaceSubnetStatus("10.0.0.130", "255.255.255.0", "10.0.0.130", options(), false, "10.0.0.200")
    ).toBe("mismatch");
    // No end at all is the conservative question — the widest pool that start
    // could imply runs to 10.0.0.255, past this NIC's link — so the caller has
    // to supply the window to get the narrower answer.
    expect(dhcpInterfaceSubnetStatus("10.0.0.130", "255.255.255.0", "10.0.0.130", options())).toBe("mismatch");
  });

  it("refuses an end that inverts the range or does not parse, rather than widening on it", () => {
    // `rangeEnd` is a stored setting, so a hand-edited settings.json or a
    // restored profile can invert it. An inverted window would satisfy the
    // containment test trivially and wave through the very NIC this check
    // exists to catch, so it falls back to the conservative question instead.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.130", "255.255.255.192")] });
    expect(
      dhcpInterfaceSubnetStatus("10.0.0.130", "255.255.255.0", "10.0.0.130", options(), false, "10.0.0.20")
    ).toBe("mismatch");
    expect(
      dhcpInterfaceSubnetStatus("10.0.0.130", "255.255.255.0", "10.0.0.130", options(), false, "not-an-ip")
    ).toBe("mismatch");
    // The same NIC and start with a usable end is a match, so the two above are
    // rejections of the END, not of the fixture.
    expect(
      dhcpInterfaceSubnetStatus("10.0.0.130", "255.255.255.0", "10.0.0.130", options(), false, "10.0.0.190")
    ).toBe("match");
  });

  it("refuses an end that is valid and ordered but sits OUTSIDE the advertised subnet", () => {
    // The other shape a stored `rangeEnd` arrives in from a hand-edited
    // settings.json or a restored profile: left over from a network that was
    // wider before, so it parses and is above the start yet names an address
    // this pool could never hand out.
    //
    // The guard on the inverted case alone let it through, and the damage is the
    // reverse of that one's: `end` is what the NIC has to cover, so a `10.20.x`
    // end demands coverage no NIC on this subnet has. eth0 below is the textbook
    // CORRECT bind — 10.0.0.5 on the very /24 being advertised, on-link for
    // every address in it, the exact pair the prefix check this replaced always
    // accepted — and it was reported as a mismatch, sending the user hunting for
    // a fault in a bind that is beyond reproach.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.5", "255.255.255.0")] });
    expect(
      dhcpInterfaceSubnetStatus("10.0.0.5", "255.255.255.0", "10.0.0.130", options(), false, "10.20.30.40")
    ).toBe("match");
    // Not a fixture that answers "match" whatever it is handed: a NIC that
    // genuinely does not cover the pool still fails, out-of-subnet end and all.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5", "255.255.255.0")] });
    expect(
      dhcpInterfaceSubnetStatus("192.168.2.5", "255.255.255.0", "10.0.0.130", options(), false, "10.20.30.40")
    ).toBe("mismatch");
  });
});

describe("suggestBindAddressForPool — the pool's configured range, not the whole subnet", () => {
  it("offers the NIC that covers the configured range, and stays silent without the end", () => {
    // The suggestion has to agree with the status above or the warning fires on
    // a pool the picker refuses to offer an address for — and vice versa.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.130", "255.255.255.192")] });
    expect(suggestBindAddressForPool("10.0.0.130", "255.255.255.0", options(), false, "10.0.0.190")).toEqual({
      address: "10.0.0.130",
      ambiguous: false
    });
    expect(suggestBindAddressForPool("10.0.0.130", "255.255.255.0", options(), false, "10.0.0.200")).toBeUndefined();
    expect(suggestBindAddressForPool("10.0.0.130", "255.255.255.0", options())).toBeUndefined();
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

/**
 * REVIEW FINDING (P1, fifth round — relay with an explicit held bind).
 *
 * Under `allowRelayAgents` the identifier used to be skipped outright, at all
 * three trigger points independently. The reasoning — "a relayed pool is on a
 * wire this machine holds no NIC on, so there is no address to resolve" — is
 * true of the POOL and false of the BIND. A service bound to a concrete address
 * this machine holds answers from that address whether or not a relay sits in
 * front of it, and option 54 (copied verbatim into BOOTP `siaddr`) has to name
 * the address renewals and ZTP fetches can actually reach.
 *
 * The relay branch is therefore an IDENTITY check on the bind alone, with no
 * subnet comparison — being off-subnet is the whole point under relay — and it
 * is deliberately NOT a delegation to `dhcpInterfaceSubnetStatus`'s own relay
 * branch, which answers `match` for any non-blank string. That branch is asking
 * "is off-subnet a fault", not "does this name an address", so resolving
 * through it would advertise typos and addresses nothing here holds.
 */
describe("resolveDhcpServerIdentifier — the relay branch", () => {
  it("resolves an explicit bind address this machine holds, off the pool's subnet and all", () => {
    // The reported arrangement: bound to 192.168.1.20, relaying 10.0.0.0/24.
    // Without relay this same call resolves nothing (no NIC is on the pool's
    // subnet), so the flag is genuinely what changes the answer here.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    expect(resolveDhcpServerIdentifier("10.0.0.10", "255.255.255.0", "192.168.1.20", options(), true)).toBe(
      "192.168.1.20"
    );
    expect(
      resolveDhcpServerIdentifier("10.0.0.10", "255.255.255.0", "192.168.1.20", options(), false)
    ).toBeUndefined();
  });

  it("does not consult the pool's subnet at all — two NICs on it change nothing", () => {
    // Ambiguity on the pool's subnet is what makes the NON-relay path abstain.
    // Under relay the bind names the answer outright, so the pool's occupancy
    // is irrelevant. Kills "run the ordinary resolution and only skip the
    // subnet warning".
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.1.20")],
      eth1: [ipv4("10.0.0.5")],
      eth2: [ipv4("10.0.0.6")]
    });
    expect(resolveDhcpServerIdentifier("10.0.0.10", "255.255.255.0", "192.168.1.20", options(), true)).toBe(
      "192.168.1.20"
    );
    expect(
      resolveDhcpServerIdentifier("10.0.0.10", "255.255.255.0", "192.168.1.20", options(), false)
    ).toBeUndefined();
  });

  it("resolves nothing for an all-interfaces bind, which names no single address", () => {
    // eth1 is on the pool's subnet, so an implementation that fell through to
    // the NIC suggestion would answer 10.0.0.5 for all four of these.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")], eth1: [ipv4("10.0.0.5")] });
    for (const bind of [undefined, "", "   ", "0.0.0.0"]) {
      expect(resolveDhcpServerIdentifier("10.0.0.10", "255.255.255.0", bind, options(), true)).toBeUndefined();
    }
  });

  it("resolves nothing for a bind no interface here holds, rather than echoing it back", () => {
    // This is the case that makes delegating to `dhcpInterfaceSubnetStatus`'s
    // relay branch wrong: it calls both of these `match`, so a delegating
    // implementation writes them into option 54 and clients renew at an address
    // that exists nowhere.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    expect(dhcpInterfaceSubnetStatus("172.16.9.9", "255.255.255.0", "10.0.0.10", options(), true)).toBe("match");
    expect(resolveDhcpServerIdentifier("10.0.0.10", "255.255.255.0", "172.16.9.9", options(), true)).toBeUndefined();

    expect(dhcpInterfaceSubnetStatus("not-an-ip", "255.255.255.0", "10.0.0.10", options(), true)).toBe("match");
    expect(resolveDhcpServerIdentifier("10.0.0.10", "255.255.255.0", "not-an-ip", options(), true)).toBeUndefined();
  });

  it("answers from the bind even when the pool's own mask is unusable", () => {
    // Nothing in the relay branch depends on the pool parsing, which is the
    // other half of "no subnet comparison": the address is the answer whatever
    // the pool says. Non-relay reports `unusable-mask` and resolves nothing.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    expect(resolveDhcpServerIdentifier("not-an-ip", "255.0.255.0", "192.168.1.20", options(), true)).toBe(
      "192.168.1.20"
    );
    expect(resolveDhcpServerIdentifier("not-an-ip", "255.0.255.0", "192.168.1.20", options(), false)).toBeUndefined();
  });

  it("defaults to the non-relay branch when the flag is omitted", () => {
    // Every pre-existing caller passed four arguments, so the added parameter
    // must not change what they get.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")] });
    expect(resolveDhcpServerIdentifier("10.0.0.10", "255.255.255.0", "192.168.1.20", options())).toBeUndefined();
  });
});

/**
 * The shape the three trigger points now share — the full form's CIDR/NIC
 * autofill, Quick Adjust's Network row and Quick Adjust's Interface row. Each
 * had grown its own copy of "resolve the new state, resolve the one it replaces,
 * write only if what is configured is still the old resolution", which is why
 * the relay defect above had to be found and fixed three times over.
 */
describe("refreshDhcpServerIdentifier — the shared resolve/gate shape", () => {
  /** eth1 and eth2 both on the pool's subnet; eth0 off it. */
  function threeNics(): void {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.1.20")],
      eth1: [ipv4("10.0.0.5")],
      eth2: [ipv4("10.0.0.6")]
    });
  }

  const POOL = { rangeStart: "10.0.0.10", subnet: "255.255.255.0" };

  it("refreshes an identifier that is still the previous state's resolution", () => {
    threeNics();
    expect(
      refreshDhcpServerIdentifier({
        next: { ...POOL, bindAddress: "10.0.0.6" },
        previous: { ...POOL, bindAddress: "10.0.0.5" },
        interfaces: options(),
        allowRelayAgents: false,
        configuredServerId: "10.0.0.5"
      })
    ).toBe("10.0.0.6");
  });

  it("leaves an identifier the previous state would never have resolved to", () => {
    threeNics();
    expect(
      refreshDhcpServerIdentifier({
        next: { ...POOL, bindAddress: "10.0.0.6" },
        previous: { ...POOL, bindAddress: "10.0.0.5" },
        interfaces: options(),
        allowRelayAgents: false,
        configuredServerId: "10.0.0.99"
      })
    ).toBeUndefined();
  });

  it("fills a blank identifier, which is the codebase's 'no opinion' signal", () => {
    threeNics();
    expect(
      refreshDhcpServerIdentifier({
        next: { ...POOL, bindAddress: "10.0.0.6" },
        previous: { ...POOL, bindAddress: "10.0.0.5" },
        interfaces: options(),
        allowRelayAgents: false,
        configuredServerId: undefined
      })
    ).toBe("10.0.0.6");
  });

  it("forwards the relay flag to BOTH resolutions rather than deciding on its own", () => {
    // Off-subnet on both sides, so under relay both resolve and the gate can
    // recognise the old one as its own; a wrapper that abstained on the flag —
    // or that forwarded it to only one of the two calls — answers undefined.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")], eth1: [ipv4("192.168.1.21")] });
    expect(
      refreshDhcpServerIdentifier({
        next: { ...POOL, bindAddress: "192.168.1.21" },
        previous: { ...POOL, bindAddress: "192.168.1.20" },
        interfaces: options(),
        allowRelayAgents: true,
        configuredServerId: "192.168.1.20"
      })
    ).toBe("192.168.1.21");
  });

  it("still gates under relay, so a hand-set identifier survives a rebind", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.1.20")], eth1: [ipv4("192.168.1.21")] });
    expect(
      refreshDhcpServerIdentifier({
        next: { ...POOL, bindAddress: "192.168.1.21" },
        previous: { ...POOL, bindAddress: "192.168.1.20" },
        interfaces: options(),
        allowRelayAgents: true,
        configuredServerId: "192.168.1.99"
      })
    ).toBeUndefined();
  });

  it("answers undefined when the NEXT state resolves nothing, whatever is configured", () => {
    // Ambiguous pool subnet and an off-subnet bind: no confident answer, so the
    // configured value stands even though it is blank and would be fair game.
    threeNics();
    expect(
      refreshDhcpServerIdentifier({
        next: { ...POOL, bindAddress: "192.168.1.20" },
        previous: { ...POOL, bindAddress: "10.0.0.5" },
        interfaces: options(),
        allowRelayAgents: false,
        configuredServerId: undefined
      })
    ).toBeUndefined();
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

/**
 * REVIEW FINDING (P2, carried over from #111) — the module this file exercises
 * documented `networkInterfaceBindOptions()` as already excluding WSL, Hyper-V
 * and Docker adapters. It never did: `ipv4Options` drops `internal` addresses
 * and nothing else, and a hypervisor switch is reported as external. So the one
 * arrangement the comment claimed was impossible — a virtual adapter as the
 * single confident answer for a lab pool — was the one that happened.
 *
 * These fixtures are deliberately NOT marked `internal`, which is what makes
 * them fail against the old implementation instead of being filtered out before
 * the comparison ever sees them.
 */
describe("suggestBindAddressForPool — a virtual adapter is never the confident answer", () => {
  it("declines to auto-select a Docker bridge that is the only NIC on the pool's subnet", () => {
    networkInterfaces.mockReturnValue({
      docker0: [ipv4("172.17.0.1", "255.255.0.0")],
      eth0: [ipv4("192.168.1.20")]
    });
    // Still reported — something IS on that subnet — but never as a NIC to
    // bind to on the user's behalf, which is what `ambiguous` gates.
    expect(suggestBindAddressForPool("172.17.0.10", "255.255.0.0", options())).toEqual({
      address: "172.17.0.1",
      ambiguous: true
    });
  });

  it.each([
    ["a Hyper-V switch by name", "vEthernet (Default Switch)"],
    ["a WSL host link by name", "vEthernet (WSL)"],
    ["a VirtualBox host-only adapter", "vboxnet0"],
    ["a libvirt bridge", "virbr0"],
    ["a VPN tunnel", "tun0"]
  ])("declines %s the same way", (_label, name) => {
    networkInterfaces.mockReturnValue({ [name]: [ipv4("10.0.0.5")] });
    expect(suggestBindAddressForPool("10.0.0.10", "255.255.255.0", options())).toEqual({
      address: "10.0.0.5",
      ambiguous: true
    });
  });

  it("recognises a renamed Hyper-V adapter by its MAC when the name says nothing", () => {
    // A renamed Windows connection keeps its 00:15:5d OUI. Without the MAC arm
    // this fixture is indistinguishable from a physical NIC.
    networkInterfaces.mockReturnValue({
      "Ethernet 3": [{ ...ipv4("10.0.0.5"), mac: "00:15:5d:01:02:03" }]
    });
    expect(suggestBindAddressForPool("10.0.0.10", "255.255.255.0", options())).toEqual({
      address: "10.0.0.5",
      ambiguous: true
    });
  });

  it("lets a physical NIC win outright rather than calling the pair a tie", () => {
    // Both are on the pool's subnet. Counting the bridge as a rival match would
    // report `ambiguous` and suppress the auto-selection of the real answer —
    // the virtual NIC was never a candidate, so this is not a tie.
    networkInterfaces.mockReturnValue({
      docker0: [ipv4("10.0.0.1")],
      eth0: [ipv4("10.0.0.5")]
    });
    expect(suggestBindAddressForPool("10.0.0.10", "255.255.255.0", options())).toEqual({
      address: "10.0.0.5",
      ambiguous: false
    });
  });

  it("leaves the Server Identifier unresolved rather than deriving it from a bridge", () => {
    // One lever, three consumers: `resolveDhcpServerIdentifier` gates on the
    // same `ambiguous` flag, so option 54 stops naming the bridge too.
    networkInterfaces.mockReturnValue({ docker0: [ipv4("10.0.0.1")] });
    expect(resolveDhcpServerIdentifier("10.0.0.10", "255.255.255.0", "", options())).toBeUndefined();
  });

  it("still honours a bind the user made to a virtual adapter themselves", () => {
    // The flag governs suggestion, not use. A VM lab served over a host-only
    // switch is a real setup, and it must not start reporting itself broken.
    networkInterfaces.mockReturnValue({ docker0: [ipv4("10.0.0.1")] });
    expect(dhcpInterfaceSubnetStatus("10.0.0.1", "255.255.255.0", "10.0.0.10", options())).toBe("match");
    expect(resolveDhcpServerIdentifier("10.0.0.10", "255.255.255.0", "10.0.0.1", options())).toBe("10.0.0.1");
  });

  it("keeps a virtual adapter in the picker", () => {
    networkInterfaces.mockReturnValue({ docker0: [ipv4("172.17.0.1", "255.255.0.0")] });
    expect(options().map((option) => option.value)).toContain("172.17.0.1");
  });
});
