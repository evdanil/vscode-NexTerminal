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
