/**
 * @author kanekitakitos
 *
 * Unit tests for the CIDR/subnet arithmetic added to
 * `src/services/networkServers/dhcp/engine/dhcpNetworkUtils.ts`.
 *
 * Two wrong implementations are specifically targeted, because both are the
 * obvious first thing to write:
 *  1. `maskToPrefix` as a set-bit count. `255.0.255.0` has sixteen set bits and
 *     is not a subnet, so the fixture asserts `undefined` rather than "not 16" —
 *     a popcount implementation answers `16` and fails here.
 *  2. `isSameSubnet` reading the mask from somewhere other than its argument.
 *     The fixture pairs two addresses that share a network under a NIC's wide
 *     mask but not under the pool's narrow one, so picking the wrong mask flips
 *     the answer instead of quietly agreeing.
 *
 * The `127.255.255.255`/`128.0.0.0` boundary gets its own case: `ipToInt` is
 * signed, and every helper here masks with `>>> 0` so an address above `127.x`
 * cannot be compared (or rendered) as a negative.
 */

import { describe, expect, it } from "vitest";
import {
  isSameSubnet,
  maskToPrefix,
  networkAddress,
  parseCidr,
  prefixToMask
} from "../../../src/services/networkServers/dhcp/engine/dhcpNetworkUtils";

describe("maskToPrefix", () => {
  it.each([
    ["255.255.255.0", 24],
    ["255.255.254.0", 23],
    ["255.255.255.252", 30],
    ["255.255.255.254", 31],
    ["255.255.255.255", 32],
    ["0.0.0.0", 0],
    // The top bit alone — where the signed conversion goes negative.
    ["128.0.0.0", 1],
    ["255.0.0.0", 8]
  ])("reads %s as /%i", (mask, prefix) => {
    expect(maskToPrefix(mask)).toBe(prefix);
  });

  it("refuses a non-contiguous mask outright rather than counting its bits", () => {
    // A popcount implementation answers 16 for both of these.
    expect(maskToPrefix("255.0.255.0")).toBeUndefined();
    expect(maskToPrefix("255.255.0.255")).toBeUndefined();
    expect(maskToPrefix("0.255.255.0")).toBeUndefined();
  });

  it("refuses anything that is not a dotted quad", () => {
    expect(maskToPrefix("24")).toBeUndefined();
    expect(maskToPrefix("255.255.255")).toBeUndefined();
    expect(maskToPrefix("255.255.255.256")).toBeUndefined();
    expect(maskToPrefix("")).toBeUndefined();
  });
});

describe("prefixToMask", () => {
  it.each([
    [0, "0.0.0.0"],
    [1, "128.0.0.0"],
    [8, "255.0.0.0"],
    [24, "255.255.255.0"],
    [30, "255.255.255.252"],
    [32, "255.255.255.255"]
  ])("renders /%i as %s", (prefix, mask) => {
    expect(prefixToMask(prefix)).toBe(mask);
  });

  it("does not let /0 wrap onto /32", () => {
    // `0xffffffff << 32` is `0xffffffff` in JavaScript — the shift count is
    // taken modulo 32 — so an unguarded implementation returns the /32 mask.
    expect(prefixToMask(0)).toBe("0.0.0.0");
    expect(prefixToMask(0)).not.toBe(prefixToMask(32));
  });

  it("refuses a prefix outside 0..32 or one that is not a whole number", () => {
    expect(prefixToMask(-1)).toBeUndefined();
    expect(prefixToMask(33)).toBeUndefined();
    expect(prefixToMask(24.5)).toBeUndefined();
    expect(prefixToMask(Number.NaN)).toBeUndefined();
  });

  it("round-trips through maskToPrefix for every prefix length", () => {
    for (let prefix = 0; prefix <= 32; prefix += 1) {
      expect(maskToPrefix(prefixToMask(prefix)!)).toBe(prefix);
    }
  });
});

describe("networkAddress", () => {
  it("clears the host bits", () => {
    expect(networkAddress("10.0.0.5", "255.255.255.0")).toBe("10.0.0.0");
    expect(networkAddress("192.168.2.130", "255.255.255.192")).toBe("192.168.2.128");
    expect(networkAddress("172.16.9.9", "255.255.0.0")).toBe("172.16.0.0");
  });

  it("renders an address above 127.x as unsigned octets", () => {
    // A signed `>> 24` puts a negative number in the first octet.
    expect(networkAddress("200.100.50.25", "255.255.255.0")).toBe("200.100.50.0");
    expect(networkAddress("128.0.0.5", "255.0.0.0")).toBe("128.0.0.0");
    expect(networkAddress("255.255.255.255", "255.255.255.255")).toBe("255.255.255.255");
  });
});

describe("isSameSubnet", () => {
  it("answers under the mask it is given, not under the wider one either address carries", () => {
    // 10.0.1.20 is a NIC on a /16; the pool lives on 10.0.0.0/24. Under the
    // NIC's own mask the two share a network — under the pool's they do not,
    // and the pool's is the answer that matters.
    expect(isSameSubnet("10.0.1.20", "10.0.0.50", "255.255.0.0")).toBe(true);
    expect(isSameSubnet("10.0.1.20", "10.0.0.50", "255.255.255.0")).toBe(false);
  });

  it("separates the two halves of the 127/128 boundary", () => {
    // The point at which `ipToInt`'s signed conversion flips sign. Both sides
    // are masked unsigned, so the comparison is bit-exact rather than ordered.
    expect(isSameSubnet("127.255.255.10", "128.0.0.10", "255.0.0.0")).toBe(false);
    expect(isSameSubnet("128.0.0.10", "128.255.255.10", "255.0.0.0")).toBe(true);
    expect(networkAddress("128.0.0.10", "255.0.0.0")).toBe("128.0.0.0");
  });

  it("matches an address against itself and against its own network address", () => {
    expect(isSameSubnet("192.168.2.10", "192.168.2.10", "255.255.255.0")).toBe(true);
    expect(isSameSubnet("192.168.2.10", "192.168.2.0", "255.255.255.0")).toBe(true);
  });

  it("reports false rather than matching when an argument does not parse", () => {
    expect(isSameSubnet("not-an-ip", "also-not", "255.255.255.0")).toBe(false);
    expect(isSameSubnet("10.0.0.1", "10.0.0.2", "not-a-mask")).toBe(false);
    expect(isSameSubnet("", "", "")).toBe(false);
  });
});

describe("parseCidr", () => {
  it("parses a network address with its prefix", () => {
    expect(parseCidr("10.0.0.0/24")).toEqual({ network: "10.0.0.0", prefix: 24 });
    expect(parseCidr("192.168.2.0/24")).toEqual({ network: "192.168.2.0", prefix: 24 });
  });

  it("normalizes host bits away instead of refusing the address ipconfig prints", () => {
    expect(parseCidr("10.0.0.5/24")).toEqual({ network: "10.0.0.0", prefix: 24 });
    expect(parseCidr("192.168.2.130/26")).toEqual({ network: "192.168.2.128", prefix: 26 });
    expect(parseCidr("172.16.200.99/16")).toEqual({ network: "172.16.0.0", prefix: 16 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseCidr("  10.0.0.0/24  ")).toEqual({ network: "10.0.0.0", prefix: 24 });
    expect(parseCidr("10.0.0.0 / 24")).toEqual({ network: "10.0.0.0", prefix: 24 });
  });

  it("accepts /31 and /32 — they are legal networks, just not usable pools", () => {
    // Pool usability is the caller's question; this one is pure syntax.
    expect(parseCidr("10.0.0.0/31")).toEqual({ network: "10.0.0.0", prefix: 31 });
    expect(parseCidr("10.0.0.7/32")).toEqual({ network: "10.0.0.7", prefix: 32 });
  });

  it.each([
    ["no slash", "10.0.0.0"],
    ["an empty prefix", "10.0.0.0/"],
    ["a second slash", "10.0.0.0/24/8"],
    ["a prefix of zero", "10.0.0.0/0"],
    ["a prefix above 32", "10.0.0.0/33"],
    ["a three-digit prefix", "10.0.0.0/240"],
    ["a hex prefix", "10.0.0.0/0x18"],
    ["a fractional prefix", "10.0.0.0/24.5"],
    ["a malformed address", "999.0.0.1/24"],
    ["a short address", "10.0.0/24"],
    ["an empty string", ""],
    ["a bare prefix", "/24"]
  ])("refuses %s", (_label, text) => {
    expect(parseCidr(text)).toBeUndefined();
  });
});
