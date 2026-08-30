/**
 * @author kanekitakitos
 *
 * Unit tests for the CIDR affordance in `src/commands/networkServerSettings.ts`.
 *
 * CIDR is not a stored setting: it is an input shape that derives `subnet`,
 * `rangeStart`, `rangeEnd`, `gateway` and `dns`. So the tests are about the
 * derivation, and two properties of it in particular:
 *  1. The pool starts one *above* the network address and stops short of both
 *     the gateway and the broadcast. An off-by-one here hands out an address no
 *     client may use, or hands the gateway's address to a second host.
 *  2. The gateway matches what `dhcpDerivedAddresses()` produces for the same
 *     network. Two entry points that each computed their own "top usable
 *     address" would agree today and drift the first time one is touched, so the
 *     parity is pinned rather than assumed.
 *
 * `/32`, `/31` and `/0` are asserted on their actual messages: all three are
 * legal CIDR, and a user who typed one needs to be told why *that* network has
 * no pool, not that some range check failed.
 */

import { describe, expect, it } from "vitest";
import {
  dhcpCidrDerivation,
  dhcpCidrProblem,
  dhcpCurrentCidr,
  dhcpDerivedAddresses
} from "../../../src/commands/networkServerSettings";
import { SUGGESTED_CIDR_POOL_CAP } from "../../../src/services/networkServers/networkServerConfigValidation";

describe("dhcpCurrentCidr — reading a CIDR back out of the stored settings", () => {
  it("names the network the configured pool start and mask already describe", () => {
    expect(dhcpCurrentCidr("192.168.2.10", "255.255.255.0")).toBe("192.168.2.0/24");
    expect(dhcpCurrentCidr("10.4.7.55", "255.255.0.0")).toBe("10.4.0.0/16");
  });

  it("falls back to the packaged defaults, so an untouched config still shows a network", () => {
    // No migration: the row renders from settings that already exist.
    expect(dhcpCurrentCidr(undefined, undefined)).toBe("192.168.2.0/24");
  });

  it("uses the mask's own prefix rather than assuming /24", () => {
    expect(dhcpCurrentCidr("10.0.0.130", "255.255.255.192")).toBe("10.0.0.128/26");
    expect(dhcpCurrentCidr("172.16.5.9", "255.255.254.0")).toBe("172.16.4.0/23");
  });

  it("shows nothing when the settings do not describe a network", () => {
    expect(dhcpCurrentCidr("10.0.0.10", "255.0.255.0")).toBeUndefined();
    expect(dhcpCurrentCidr("not-an-ip", "255.255.255.0")).toBeUndefined();
  });
});

describe("dhcpCidrDerivation — the pool a network implies", () => {
  it("derives every address a /24 implies", () => {
    expect(dhcpCidrDerivation("10.0.0.0/24")).toEqual({
      network: "10.0.0.0",
      prefix: 24,
      subnet: "255.255.255.0",
      rangeStart: "10.0.0.1",
      rangeEnd: "10.0.0.253",
      poolCount: 253,
      gateway: "10.0.0.254",
      broadcast: "10.0.0.255",
      dns: ["10.0.0.254"]
    });
  });

  it("starts the pool one above the network address, never on it", () => {
    // The network address is not assignable; a pool that began there would hand
    // out an address the client cannot use.
    const derived = dhcpCidrDerivation("192.168.2.0/24");
    expect(derived?.rangeStart).toBe("192.168.2.1");
    expect(derived?.rangeStart).not.toBe(derived?.network);
  });

  it("ends the pool below both the gateway and the broadcast", () => {
    for (const cidr of ["10.0.0.0/24", "10.0.0.0/29", "10.0.0.0/30", "172.16.0.0/20"]) {
      const derived = dhcpCidrDerivation(cidr)!;
      expect(derived.rangeEnd).not.toBe(derived.broadcast);
      expect(derived.rangeEnd).not.toBe(derived.gateway);
    }
  });

  it("accepts a host address and normalizes it to its network", () => {
    // What `ipconfig` prints, pasted straight in.
    expect(dhcpCidrDerivation("10.0.0.57/24")).toEqual(dhcpCidrDerivation("10.0.0.0/24"));
  });

  it("sizes a /29 to the five addresses left after the gateway", () => {
    expect(dhcpCidrDerivation("10.0.0.0/29")).toMatchObject({
      rangeStart: "10.0.0.1",
      rangeEnd: "10.0.0.5",
      poolCount: 5,
      gateway: "10.0.0.6",
      broadcast: "10.0.0.7"
    });
  });

  it("still finds one address in a /30", () => {
    expect(dhcpCidrDerivation("10.0.0.0/30")).toMatchObject({
      rangeStart: "10.0.0.1",
      rangeEnd: "10.0.0.1",
      poolCount: 1,
      gateway: "10.0.0.2",
      broadcast: "10.0.0.3"
    });
  });

  it("caps a wide network instead of suggesting a pool the size of the subnet", () => {
    const derived = dhcpCidrDerivation("10.0.0.0/16")!;
    expect(derived.poolCount).toBe(SUGGESTED_CIDR_POOL_CAP);
    expect(derived.rangeStart).toBe("10.0.0.1");
    expect(derived.rangeEnd).toBe("10.0.0.254");
    // The mask, gateway and broadcast still describe the whole /16 — only the
    // pool is capped.
    expect(derived.subnet).toBe("255.255.0.0");
    expect(derived.gateway).toBe("10.0.255.254");
    expect(derived.broadcast).toBe("10.0.255.255");
  });

  it("handles a network above the 127/128 signed boundary", () => {
    expect(dhcpCidrDerivation("128.0.0.0/8")).toMatchObject({
      subnet: "255.0.0.0",
      rangeStart: "128.0.0.1",
      gateway: "128.255.255.254",
      broadcast: "128.255.255.255"
    });
  });

  it.each(["10.0.0.0/31", "10.0.0.0/32", "10.0.0.0/0", "10.0.0.0/33", "10.0.0.0", "nonsense"])(
    "derives nothing from %s",
    (text) => {
      expect(dhcpCidrDerivation(text)).toBeUndefined();
    }
  );
});

/**
 * REVIEW FINDING (P1) — the suggested pool must not contain an address this
 * machine already holds.
 *
 * A NIC on 192.168.2.10/24 deriving 192.168.2.1–192.168.2.253 lets the
 * allocator lease 192.168.2.10 to a client, which is an IP conflict with the
 * very machine serving the leases. The settings model one contiguous range with
 * no holes, so the range is moved instead: the start steps over an address
 * sitting on it, and the end stops below the first one above it.
 */
describe("dhcpCidrDerivation — this machine's own addresses stay out of the pool", () => {
  it("stops the pool below a local address that falls inside it", () => {
    const derived = dhcpCidrDerivation("192.168.2.0/24", ["192.168.2.10"])!;
    expect(derived.rangeStart).toBe("192.168.2.1");
    expect(derived.rangeEnd).toBe("192.168.2.9");
    expect(derived.poolCount).toBe(9);
    // The network itself is untouched — only the pool moved.
    expect(derived.subnet).toBe("255.255.255.0");
    expect(derived.gateway).toBe("192.168.2.254");
  });

  it("steps the START over a local address sitting exactly on it", () => {
    // The shrink branch cannot help here: there is nothing below .1 to keep.
    const derived = dhcpCidrDerivation("10.0.0.0/24", ["10.0.0.1"])!;
    expect(derived.rangeStart).toBe("10.0.0.2");
    expect(derived.rangeEnd).toBe("10.0.0.253");
    expect(derived.poolCount).toBe(252);
  });

  it("keeps stepping while the addresses above the start are taken too", () => {
    // Two addresses on one wire is ordinary (a static plus a DHCP lease), so a
    // single step is not enough — and the top of the pool must still stay one
    // below the gateway, never grow onto it.
    const derived = dhcpCidrDerivation("10.0.0.0/24", ["10.0.0.2", "10.0.0.1", "10.0.0.3"])!;
    expect(derived.rangeStart).toBe("10.0.0.4");
    expect(derived.rangeEnd).toBe("10.0.0.253");
    expect(derived.rangeEnd).not.toBe(derived.gateway);
    expect(derived.poolCount).toBe(250);
  });

  it("shrinks once rather than hunting for the largest gap above the hole", () => {
    // .1–.4 is a real pool that keeps rangeStart where the network says it
    // belongs; .6–.253 is bigger but starts somewhere the network did not name.
    const derived = dhcpCidrDerivation("10.0.0.0/24", ["10.0.0.5"])!;
    expect(derived.rangeStart).toBe("10.0.0.1");
    expect(derived.rangeEnd).toBe("10.0.0.4");
  });

  it("derives nothing when this machine occupies every address the pool could use", () => {
    // A /30 has exactly one poolable address (.1 — .2 is the gateway), and it
    // is taken. Same "no usable pool" answer /31 and /32 already get.
    expect(dhcpCidrDerivation("10.0.0.0/30", ["10.0.0.1"])).toBeUndefined();
    // A /29 leaves .1–.5; holding all five is the same dead end.
    expect(
      dhcpCidrDerivation("10.0.0.0/29", ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5"])
    ).toBeUndefined();
  });

  it("ignores addresses on other networks, the all-interfaces blank, and junk", () => {
    // An untouched result, byte for byte — the exclusion must be inert unless
    // something actually collides.
    const plain = dhcpCidrDerivation("10.0.0.0/24");
    expect(dhcpCidrDerivation("10.0.0.0/24", ["192.168.9.5", "", "not-an-ip", "10.1.0.4"])).toEqual(plain);
    // Above the pool but inside the network: the gateway's own address and the
    // ones between it and the pool's end are not in the range either.
    expect(dhcpCidrDerivation("10.0.0.0/24", ["10.0.0.254"])).toEqual(plain);
  });

  it("leaves a capped wide network the same size, only moved", () => {
    // /16 is capped at SUGGESTED_CIDR_POOL_CAP. Stepping the start over a
    // conflict must re-measure the pool from that cap, not shorten it.
    const derived = dhcpCidrDerivation("10.0.0.0/16", ["10.0.0.1"])!;
    expect(derived.rangeStart).toBe("10.0.0.2");
    expect(derived.poolCount).toBe(SUGGESTED_CIDR_POOL_CAP);
    expect(derived.rangeEnd).toBe("10.0.0.255");
  });

  it("is unchanged when no addresses are supplied at all", () => {
    // The feasibility check in dhcpCidrProblem calls it this way.
    expect(dhcpCidrDerivation("192.168.2.0/24", [])).toEqual(dhcpCidrDerivation("192.168.2.0/24"));
  });
});

describe("dhcpCidrDerivation — gateway parity with dhcpDerivedAddresses", () => {
  it.each(["10.0.0.0/24", "192.168.2.0/24", "172.16.0.0/20", "10.1.2.0/29", "10.0.0.0/30", "128.0.0.0/8"])(
    "%s derives the same gateway, broadcast and DNS as the pool-start path",
    (cidr) => {
      const derived = dhcpCidrDerivation(cidr)!;
      // The equivalent settings, entered through the other editor row.
      const viaPoolStart = dhcpDerivedAddresses(derived.rangeStart, derived.subnet);
      expect(viaPoolStart).toBeDefined();
      expect(derived.gateway).toBe(viaPoolStart?.gateway);
      expect(derived.broadcast).toBe(viaPoolStart?.broadcast);
      expect(derived.dns).toEqual(viaPoolStart?.dns);
    }
  );
});

describe("dhcpCidrProblem", () => {
  it("passes a usable network", () => {
    expect(dhcpCidrProblem("10.0.0.0/24")).toBeUndefined();
    expect(dhcpCidrProblem("  192.168.2.130/26 ")).toBeUndefined();
    expect(dhcpCidrProblem("10.0.0.0/30")).toBeUndefined();
  });

  it("says nothing about a blank box, which means 'leave it alone'", () => {
    expect(dhcpCidrProblem("")).toBeUndefined();
    expect(dhcpCidrProblem("   ")).toBeUndefined();
  });

  it("explains /32 as a single address rather than as a range error", () => {
    const problem = dhcpCidrProblem("10.0.0.7/32");
    expect(problem).toBeDefined();
    expect(problem).toContain("single address");
    expect(problem).not.toContain("dotted-quad");
  });

  it("explains /31 as the point-to-point range it is, by name", () => {
    const problem = dhcpCidrProblem("10.0.0.0/31");
    expect(problem).toBeDefined();
    expect(problem).toContain("RFC 3021");
    expect(problem).toContain("point-to-point");
  });

  it("explains /0 as not being a subnet at all", () => {
    const problem = dhcpCidrProblem("0.0.0.0/0");
    expect(problem).toBeDefined();
    expect(problem).toContain("not a subnet");
    // Distinct from the two special cases above, not a shared message.
    expect(problem).not.toContain("RFC 3021");
    expect(problem).not.toContain("single address");
  });

  it("reports a prefix above 32 as a range problem", () => {
    expect(dhcpCidrProblem("10.0.0.0/64")).toContain("between 1 and 30");
  });

  it("names the malformed half rather than the whole entry", () => {
    expect(dhcpCidrProblem("999.0.0.1/24")).toContain("999.0.0.1");
    expect(dhcpCidrProblem("10.0.0.0/abc")).toContain("abc");
    expect(dhcpCidrProblem("10.0.0.0")).toContain("CIDR form");
  });
});

/**
 * REVIEW FINDING (P2) — a network this machine leaves no room in must be
 * refused, not treated as an empty entry.
 *
 * The full form's autofill already derives WITH this machine's addresses
 * excluded, so such a network fills nothing. Without the same exclusion here,
 * the submit check called the network fine and Save wrote the pool the form had
 * been holding all along — the typed network discarded without a word.
 *
 * The argument is optional, and stays optional: the quick editor's live input
 * box passes nothing and must keep passing everything a network can justify,
 * because it validates as the user types and only the network is settled then.
 */
describe("dhcpCidrProblem — this machine's own addresses", () => {
  it("refuses a network whose only poolable address this machine holds", () => {
    // A /30 leaves exactly one address a pool could hand out (.1 — .2 is the
    // gateway), and this machine is on it.
    const problem = dhcpCidrProblem("10.0.0.0/30", ["10.0.0.1"]);
    expect(problem).toBe(
      "10.0.0.0/30 leaves no pool once this machine's own addresses on it are kept out — every address it could hand out is already taken here."
    );
    // Not the generic "does not describe a usable DHCP subnet" — the network is
    // real, and the reason it was refused is about this host, not about it.
    expect(problem).not.toContain("does not describe a usable DHCP subnet");
  });

  it("refuses a /29 whose five poolable addresses are all held here", () => {
    expect(dhcpCidrProblem("10.0.0.0/29", ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5"])).toContain(
      "leaves no pool once this machine's own addresses on it are kept out"
    );
  });

  it("reports the trimmed network, matching every other message this function returns", () => {
    expect(dhcpCidrProblem("  10.0.0.0/30  ", ["10.0.0.1"])).toBe(
      "10.0.0.0/30 leaves no pool once this machine's own addresses on it are kept out — every address it could hand out is already taken here."
    );
  });

  it("passes a network that still has room once this machine is kept out", () => {
    // The pool only moves: .1 is taken, so it starts at .2.
    expect(dhcpCidrProblem("10.0.0.0/24", ["10.0.0.1"])).toBeUndefined();
    // Addresses elsewhere, the all-interfaces blank and junk collide with
    // nothing, so they cannot refuse anything either.
    expect(dhcpCidrProblem("10.0.0.0/30", ["192.168.9.5", "", "not-an-ip"])).toBeUndefined();
    // The /30's gateway is not a poolable address, so holding it costs nothing.
    expect(dhcpCidrProblem("10.0.0.0/30", ["10.0.0.2"])).toBeUndefined();
    expect(dhcpCidrProblem("10.0.0.0/24", [])).toBeUndefined();
  });

  it("still reports the malformed and no-pool prefixes ahead of the occupancy check", () => {
    // The specific message for the shape of the entry wins: someone who typed a
    // /31 needs to hear about the /31, not about their own NICs.
    expect(dhcpCidrProblem("10.0.0.0/31", ["10.0.0.1"])).toContain("RFC 3021");
    expect(dhcpCidrProblem("10.0.0.7/32", ["10.0.0.7"])).toContain("single address");
    expect(dhcpCidrProblem("0.0.0.0/0", ["10.0.0.1"])).toContain("not a subnet");
    expect(dhcpCidrProblem("999.0.0.1/24", ["10.0.0.1"])).toContain("999.0.0.1");
    // Blank is still "leave it alone", not an error, whatever this machine holds.
    expect(dhcpCidrProblem("   ", ["10.0.0.1"])).toBeUndefined();
  });

  it("is byte-for-byte the old function when no addresses are supplied", () => {
    // The quick editor's live `validateInput` calls it exactly this way.
    expect(dhcpCidrProblem("10.0.0.0/30")).toBeUndefined();
    expect(dhcpCidrProblem("10.0.0.0/29")).toBeUndefined();
    expect(dhcpCidrProblem("10.0.0.0/24")).toBeUndefined();
  });
});
