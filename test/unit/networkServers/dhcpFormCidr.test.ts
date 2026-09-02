/**
 * Unit tests for the full DHCP form's two autofill directions
 * (`dhcpFormAutofillFields` in `src/commands/networkServerSettings.ts`) and for
 * the generic webview plumbing they ride on (`autofill` on a `text` field).
 *
 * The feature already existed in the quick editor. What is being pinned here is
 * that the FORM does the same thing, because the two editors write the same
 * settings and a value that survives a network change in one and is destroyed
 * by it in the other is a defect nobody notices until it is on a bench:
 *
 *  1. The three keys the CIDR *is* — mask, pool start, pool size — are always
 *     filled. Pool SIZE, not pool end: the form has no `rangeEnd` field, so a
 *     fill aimed at that key lands nowhere and quietly leaves the old pool
 *     length over the new network.
 *  2. The two it implies (gateway, broadcast) and the DNS list are replaced
 *     only while blank or still holding what the PREVIOUS network derived.
 *     Both halves are asserted: an ungated implementation destroys a
 *     hand-typed gateway, and an over-gated one leaves the old subnet's
 *     gateway being advertised on the new one.
 *  3. Anything that describes no usable pool fills NOTHING. A partial fill is
 *     worse than none — it leaves the mask on one network and the pool on
 *     another.
 */

import { describe, expect, it } from "vitest";
import {
  dhcpCidrFormFills,
  dhcpFormAutofillFields,
  dhcpInterfaceChoices,
  dhcpInterfaceCidr
} from "../../../src/commands/networkServerSettings";
import type { NetworkInterfaceOption } from "../../../src/commands/networkInterfaceOptions";
import type { FormValues } from "../../../src/ui/formTypes";

/** Enumerated NICs, as `networkInterfaceBindOptions()` would answer. */
const INTERFACES: readonly NetworkInterfaceOption[] = [
  { label: "All interfaces (0.0.0.0)", value: "" },
  { label: "eth0 — 192.168.9.5", value: "192.168.9.5", netmask: "255.255.255.0" },
  { label: "eth1 — 10.0.0.5", value: "10.0.0.5", netmask: "255.255.255.0" },
  { label: "vpn0 — 10.4.7.55", value: "10.4.7.55", netmask: "255.255.254.0" }
];

/** A form sitting on the packaged /24, with nothing hand-set. */
const UNTOUCHED: FormValues = { rangeStart: "192.168.2.10", subnet: "255.255.255.0" };

describe("dhcpCidrFormFills — the keys a network always defines", () => {
  it("fills the mask, the pool start and the pool COUNT", () => {
    const fills = dhcpCidrFormFills("10.0.0.0/24", UNTOUCHED, INTERFACES)!;
    expect(fills.subnet).toBe("255.255.255.0");
    expect(fills.rangeStart).toBe("10.0.0.1");
    // The form asks for a size and computes `rangeEnd` from it on submit.
    // Filling `rangeEnd` instead would write to a key this form does not
    // render: the mask and start would move to 10.0.0.x while Pool Count still
    // showed — and still saved — the old network's length.
    //
    // Four, not the 253 a bare /24 would give: eth1 holds 10.0.0.5 on this
    // machine, so the pool stops below it (see the exclusion suite below).
    expect(fills.poolCount).toBe("4");
    expect(fills).not.toHaveProperty("rangeEnd");
  });

  it("echoes the network back in normalised form, so the row shows what it applied", () => {
    // A start typed as a host address inside the network still names that
    // network; the row must not keep claiming 192.168.2.55/24 afterwards.
    expect(dhcpCidrFormFills("192.168.2.55/24", UNTOUCHED, INTERFACES)?.cidr).toBe("192.168.2.0/24");
  });

  it("respects the prefix it was given rather than assuming /24", () => {
    const fills = dhcpCidrFormFills("10.4.6.0/23", UNTOUCHED, INTERFACES)!;
    expect(fills.subnet).toBe("255.255.254.0");
    expect(fills.rangeStart).toBe("10.4.6.1");
    expect(fills.gateway).toBe("10.4.7.254");
    expect(fills.broadcast).toBe("10.4.7.255");
  });
});

describe("dhcpCidrFormFills — what it may not overwrite", () => {
  it("keeps a gateway the user typed", () => {
    // 192.168.2.1 is not what a pool starting at 192.168.2.10 on /24 derives
    // (that is the TOP usable address, .254), so it is a decision, not a stale
    // suggestion. An implementation that filled gateway unconditionally would
    // destroy it on the way to another network.
    const fills = dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, gateway: "192.168.2.1" }, INTERFACES)!;
    expect(fills).not.toHaveProperty("gateway");
    expect(fills.subnet).toBe("255.255.255.0");
  });

  it("replaces a gateway the PREVIOUS network derived", () => {
    // 192.168.2.254 is exactly what this fill would itself have written for
    // 192.168.2.0/24. Leaving it behind is how a lab that moved subnet ends up
    // advertising the old subnet's router, so the over-cautious "never touch a
    // non-blank field" implementation has to go red here.
    const fills = dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, gateway: "192.168.2.254" }, INTERFACES)!;
    expect(fills.gateway).toBe("10.0.0.254");
  });

  it("applies the same rule to the broadcast address", () => {
    const stale = dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, broadcast: "192.168.2.255" }, INTERFACES)!;
    expect(stale.broadcast).toBe("10.0.0.255");
    const handSet = dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, broadcast: "192.168.2.128" }, INTERFACES)!;
    expect(handSet).not.toHaveProperty("broadcast");
  });

  it("reads the DNS field as the comma-separated list it stands for", () => {
    // Blank is always fair game.
    expect(dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, dns: "  " }, INTERFACES)?.dns).toBe("10.0.0.254");
    // The previous derivation is a one-entry list of the old gateway; matching
    // it as a STRING would fail the moment the user's spacing differed, so the
    // comparison has to be over the parsed entries.
    expect(dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, dns: "192.168.2.254 ," }, INTERFACES)?.dns).toBe(
      "10.0.0.254"
    );
    // A resolver the user named is not a suggestion.
    expect(dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, dns: "1.1.1.1, 8.8.8.8" }, INTERFACES)).not.toHaveProperty(
      "dns"
    );
  });
});

/**
 * REVIEW FINDING (P1) — the Server Identifier (option 54) has to be filled, or a
 * 10.0.0.0/24 lab goes on telling clients to renew against the packaged
 * 192.168.2.1.
 *
 * REVIEW FINDING (P1, second round) — but NOT from the gateway. `DhcpEngine`
 * copies `serverId` verbatim into option 54 and into BOOTP `siaddr`, so it has
 * to be an address this machine actually answers on; the derived gateway is the
 * top usable address of the network, which belongs to the router or to nothing.
 * The two agreed only because the packaged defaults happen to be the same
 * address (DEFAULTS.serverId === DEFAULTS.gateway === 192.168.2.1), and that
 * coincidence does not survive an arbitrary derived network. The fixture is
 * built so the difference is visible: the NIC on 10.0.0.0/24 is 10.0.0.5 while
 * the gateway derives to 10.0.0.254.
 */
describe("dhcpCidrFormFills — the server identifier", () => {
  it("fills it from the NIC that will serve the new pool, not from the gateway", () => {
    // The exact reported case: eth1 holds 10.0.0.5, the derived gateway is
    // 10.0.0.254. Writing the gateway sends renewals — and ZTP siaddr fetches —
    // to an address this machine is not on.
    expect(dhcpCidrFormFills("10.0.0.0/24", UNTOUCHED, INTERFACES)?.serverId).toBe("10.0.0.5");
    expect(dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, serverId: "  " }, INTERFACES)?.serverId).toBe("10.0.0.5");
    // …and the gateway field itself is still the gateway, unchanged.
    expect(dhcpCidrFormFills("10.0.0.0/24", UNTOUCHED, INTERFACES)?.gateway).toBe("10.0.0.254");
  });

  it("uses the bound NIC itself when it is already on the new subnet", () => {
    // The `match` branch, put where a suggestion could not answer at all: TWO
    // NICs are on 10.0.0.0/24 and the service is bound to the second of them.
    // The address the service is bound to IS the address clients see this
    // machine on, so there is nothing ambiguous about it — an implementation
    // that only ever asked suggestBindAddressForPool would fill nothing here,
    // and one that took its first match would fill the wrong NIC.
    const ambiguous: readonly NetworkInterfaceOption[] = [
      ...INTERFACES,
      { label: "eth2 — 10.0.0.6", value: "10.0.0.6", netmask: "255.255.255.0" }
    ];
    const fills = dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, interface: "10.0.0.6" }, ambiguous)!;
    expect(fills.serverId).toBe("10.0.0.6");
  });

  it("fills nothing when no NIC of this machine is on the new network", () => {
    // 172.30.0.0/24 is a perfectly good network that this machine is simply not
    // on. There is no address to advertise, so the setting is left exactly as
    // it stands — including not being filled with the gateway.
    const blank = dhcpCidrFormFills("172.30.0.0/24", UNTOUCHED, INTERFACES)!;
    expect(blank).not.toHaveProperty("serverId");
    // The rest of the network still applies.
    expect(blank.rangeStart).toBe("172.30.0.1");
    expect(blank.gateway).toBe("172.30.0.254");

    const set = dhcpCidrFormFills("172.30.0.0/24", { ...UNTOUCHED, serverId: "192.168.2.1" }, INTERFACES)!;
    expect(set).not.toHaveProperty("serverId");
  });

  it("fills nothing when two NICs are on the new network — that pick is a coin toss", () => {
    const ambiguous: readonly NetworkInterfaceOption[] = [
      ...INTERFACES,
      { label: "eth2 — 10.0.0.6", value: "10.0.0.6", netmask: "255.255.255.0" }
    ];
    expect(dhcpCidrFormFills("10.0.0.0/24", UNTOUCHED, ambiguous)).not.toHaveProperty("serverId");
  });

  /**
   * REVIEW FINDING (P1, third round) — the relay branch's gateway fallback was
   * itself the defect, not merely an unaddressed corner. A server bound at
   * 192.168.1.5 serving 10.0.0.0/24 through a relay was told to advertise
   * 10.0.0.254 as option 54 and BOOTP `siaddr` — the CLIENT subnet's router.
   * Unicast renewals and ZTP image fetches then went to the router rather than
   * to this service. There is no address to derive here: the relayed subnet is
   * one this machine deliberately holds no NIC on, so the configured identifier
   * is the only thing that can name a reachable address, and it is left alone.
   */
  it("writes nothing at all while relay agents are allowed, rather than the client subnet's gateway", () => {
    const fills = dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, allowRelayAgents: true }, INTERFACES)!;
    expect(fills).not.toHaveProperty("serverId");
    // The rest of the network still applies — only option 54 abstains.
    expect(fills.rangeStart).toBe("10.0.0.1");
    expect(fills.gateway).toBe("10.0.0.254");
  });

  it("leaves a configured identifier alone under relay, even one that matches the OLD gateway", () => {
    // The exact value the removed fallback would have claimed as its own stale
    // suggestion: 192.168.2.254 is what the previous /24 derived. Under the old
    // `previous?.gateway` baseline this was replaced with 10.0.0.254; there is
    // no baseline now because there is no fill, so it survives untouched.
    const fills = dhcpCidrFormFills(
      "10.0.0.0/24",
      { ...UNTOUCHED, allowRelayAgents: true, serverId: "192.168.2.254" },
      INTERFACES
    )!;
    expect(fills).not.toHaveProperty("serverId");
  });

  /**
   * REVIEW FINDING (P1, fifth round — relay with an explicit held bind). This
   * test used to assert the opposite — that relay mode filled NOTHING even with
   * an explicit, held bind address — and that assertion was pinning the defect
   * rather than a decision.
   *
   * The blanket relay skip read "a relayed pool is on a wire this machine holds
   * no NIC on, so there is no address to resolve". True of the POOL, false of
   * the BIND: `interface` here names an address this machine currently holds and
   * the socket is about to answer from, and option 54 / BOOTP `siaddr` have to
   * name exactly that. Abstaining left a config advertising whatever stale
   * identifier was configured — including the packaged 192.168.2.1 — on a
   * service reachable at 10.0.0.5.
   *
   * The fixture keeps the discriminator the old test had: the gateway derives to
   * 10.0.0.254, so "fall back to the gateway" is still visibly wrong.
   */
  it("fills it from an explicit, currently-held bind address under relay", () => {
    const fills = dhcpCidrFormFills(
      "10.0.0.0/24",
      { ...UNTOUCHED, allowRelayAgents: true, interface: "10.0.0.5" },
      INTERFACES
    )!;
    expect(fills.serverId).toBe("10.0.0.5");
    // Not the derived gateway, which is the client subnet's router.
    expect(fills.gateway).toBe("10.0.0.254");
  });

  it("fills it from a bind that is OFF the relayed pool's subnet, which is relay's own arrangement", () => {
    // The reported shape: bound to 192.168.9.5, relaying 10.0.0.0/24. Off-subnet
    // is the point under relay, and 192.168.9.5 is still where this service
    // answers. Without the flag this same call fills 10.0.0.5 instead — the NIC
    // on the pool's wire — so the flag genuinely changes the answer.
    const relayed = dhcpCidrFormFills(
      "10.0.0.0/24",
      { ...UNTOUCHED, allowRelayAgents: true, interface: "192.168.9.5" },
      INTERFACES
    )!;
    expect(relayed.serverId).toBe("192.168.9.5");
    const direct = dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, interface: "192.168.9.5" }, INTERFACES)!;
    expect(direct.serverId).toBe("10.0.0.5");
  });

  it("fills nothing under relay for an all-interfaces bind, which names no single address", () => {
    // The "don't guess" half of the fix, and the regression guard on it: eth1 is
    // on 10.0.0.0/24, so an implementation that fell through to the NIC
    // suggestion under relay would fill 10.0.0.5 for all of these.
    for (const bind of [undefined, "", "   ", "0.0.0.0"]) {
      const values: FormValues = { ...UNTOUCHED, allowRelayAgents: true };
      if (bind !== undefined) values.interface = bind;
      expect(dhcpCidrFormFills("10.0.0.0/24", values, INTERFACES)!).not.toHaveProperty("serverId");
    }
  });

  it("fills nothing under relay for a bind no interface here holds", () => {
    // `dhcpInterfaceSubnetStatus` calls any non-blank bind a `match` under relay
    // — it is answering "is off-subnet a fault", not "is this a real address" —
    // so an implementation that delegated to it would advertise 172.30.9.9 and
    // 'eth0', neither of which exists on this machine.
    for (const bind of ["172.30.9.9", "eth0"]) {
      const fills = dhcpCidrFormFills(
        "10.0.0.0/24",
        { ...UNTOUCHED, allowRelayAgents: true, interface: bind },
        INTERFACES
      )!;
      expect(fills).not.toHaveProperty("serverId");
    }
  });

  it("still gates under relay, so a hand-set identifier survives the network change", () => {
    // Forwarding the flag must not turn the relay path into an unconditional
    // write. The bind does not move here, so the previous resolution is also
    // 10.0.0.5; 192.168.2.1 is neither that nor blank, so someone typed it.
    const fills = dhcpCidrFormFills(
      "10.0.0.0/24",
      { ...UNTOUCHED, allowRelayAgents: true, interface: "10.0.0.5", serverId: "192.168.2.1" },
      INTERFACES
    )!;
    expect(fills).not.toHaveProperty("serverId");
  });
});

/**
 * The gate on the fill above, which had to move with it: what counts as "still
 * holding what the PREVIOUS network auto-filled" is now the same NIC resolution
 * run against the previous rangeStart/subnet, not the previous gateway.
 *
 * The fixture puts the previous network on 192.168.9.0/24, where this machine
 * DOES hold an address (eth0, 192.168.9.5) — that is what makes the previous
 * auto-fill resolvable and the two baselines tell different stories.
 */
describe("dhcpCidrFormFills — what counts as a stale server identifier", () => {
  /** A form whose previous network is one this machine is on. */
  const ON_PREVIOUS: FormValues = {
    rangeStart: "192.168.9.10",
    subnet: "255.255.255.0",
    interface: "192.168.9.5"
  };

  it("refreshes one that is still the PREVIOUS network's resolved address", () => {
    // 192.168.9.5 is exactly what this fill would have written while the form
    // was on 192.168.9.0/24. Leaving it behind is a server identifier naming
    // the old wire. Gating on the previous GATEWAY instead would miss it.
    const fills = dhcpCidrFormFills("10.0.0.0/24", { ...ON_PREVIOUS, serverId: "192.168.9.5" }, INTERFACES)!;
    expect(fills.serverId).toBe("10.0.0.5");
  });

  it("keeps the PREVIOUS network's gateway, which this fill would never have written", () => {
    // The discriminating case. Under the old gateway-based gate this value was
    // treated as the fill's own leftover and silently replaced; it is not — no
    // version of this fill writes a gateway to serverId any more, so someone
    // typed it, and a hand-set option 54 has to survive a network change.
    const fills = dhcpCidrFormFills("10.0.0.0/24", { ...ON_PREVIOUS, serverId: "192.168.9.254" }, INTERFACES)!;
    expect(fills).not.toHaveProperty("serverId");
    // …and the rest of the network still applies over it.
    expect(fills.rangeStart).toBe("10.0.0.1");
  });

  it("keeps any other address the user typed", () => {
    const fills = dhcpCidrFormFills("10.0.0.0/24", { ...ON_PREVIOUS, serverId: "192.168.9.99" }, INTERFACES)!;
    expect(fills).not.toHaveProperty("serverId");
  });
});

/**
 * REVIEW FINDING (P1) — the form renders Pool COUNT, not an end, so the
 * previous window's `rangeEnd` is reconstructed from the previous count
 * ({@link dhcpRangeEndForCount}) rather than read from a field that does not
 * exist. That helper returns `undefined` for a blank count, which resolves
 * through `effectiveDhcpRangeEnd` to the packaged end. `FormValues` cannot say
 * whether the blank means the count was just cleared or was never set — the two
 * read identically from it — but the answer is the same either way: the
 * packaged end is the right previous state in both cases, because the
 * alternative is whatever `poolNetwork` widens to when handed nothing at all,
 * which would ask the two sides of the comparison different questions.
 *
 * The previous network sits on the packaged octets (192.168.2.x) precisely so
 * the packaged end (192.168.2.199) lands inside it — the fixture that makes
 * the difference observable, not an arbitrary choice: a previous network on
 * unrelated octets (`ON_PREVIOUS` above, 192.168.9.x) can't be moved by this
 * fix at all, because `poolNetwork`'s own out-of-subnet guard discards a
 * substituted end that doesn't belong to the subnet being asked about and
 * falls back to the subnet's own broadcast regardless — which is exactly why
 * every `ON_PREVIOUS` test above stays green under this fix.
 */
describe("dhcpCidrFormFills — a blank Pool Count still has a known previous end", () => {
  it("resolves the previous network's held NIC instead of finding nothing on it", () => {
    // A /16 so the whole-subnet fallback (192.168.255.255) and the packaged
    // end (192.168.2.199) ask genuinely different questions: eth2 covers the
    // pool up to .199 (its own broadcast is .2.255) but not up to .255.255.
    const values: FormValues = {
      rangeStart: "192.168.2.10",
      subnet: "255.255.0.0",
      serverId: "192.168.2.5"
    };
    const interfaces = [
      ...INTERFACES,
      { label: "eth2 — 192.168.2.5", value: "192.168.2.5", netmask: "255.255.255.0" }
    ];
    const fills = dhcpCidrFormFills("10.0.0.0/24", values, interfaces)!;
    // 192.168.2.5 is exactly what the previous fill would have written under
    // the packaged end — leaving it behind is a server identifier naming the
    // old wire. Under the whole-subnet fallback, no NIC on this machine
    // reaches 192.168.255.255, so the previous resolution finds nothing,
    // "192.168.2.5" is read as hand-set, and this assertion fails.
    expect(fills.serverId).toBe("10.0.0.5");
  });
});

/**
 * REVIEW FINDING (P1) — the form's own derivation must exclude the addresses
 * this machine holds, not just the quick editor's. Both write the same settings.
 */
describe("dhcpCidrFormFills — this machine's own addresses stay out of the pool", () => {
  it("stops the pool below the NIC that is on the new network", () => {
    // eth1 holds 10.0.0.5. Without the exclusion the pool is .1–.253 and the
    // allocator can lease the serving machine's own address.
    const fills = dhcpCidrFormFills("10.0.0.0/24", UNTOUCHED, INTERFACES)!;
    expect(fills.rangeStart).toBe("10.0.0.1");
    expect(fills.poolCount).toBe("4");
  });

  it("steps the start over a NIC sitting on the first host address", () => {
    const onFirstHost: readonly NetworkInterfaceOption[] = [
      { label: "All interfaces (0.0.0.0)", value: "" },
      { label: "eth1 — 10.0.0.1", value: "10.0.0.1", netmask: "255.255.255.0" }
    ];
    const fills = dhcpCidrFormFills("10.0.0.0/24", UNTOUCHED, onFirstHost)!;
    expect(fills.rangeStart).toBe("10.0.0.2");
    expect(fills.poolCount).toBe("252");
  });

  it("fills nothing when this machine leaves the network no poolable address", () => {
    const cramped: readonly NetworkInterfaceOption[] = [
      { label: "eth1 — 10.0.0.1", value: "10.0.0.1", netmask: "255.255.255.252" }
    ];
    // /30: .1 is the only poolable address and this machine holds it.
    expect(dhcpCidrFormFills("10.0.0.0/30", UNTOUCHED, cramped)).toBeUndefined();
  });
});

describe("dhcpCidrFormFills — the NIC that would serve the new network", () => {
  it("offers the single NIC already on the network when the bound one is not", () => {
    const fills = dhcpCidrFormFills(
      "10.0.0.0/24",
      { ...UNTOUCHED, interface: "192.168.9.5" },
      INTERFACES
    )!;
    expect(fills.interface).toBe("10.0.0.5");
  });

  it("says nothing when relayed requests are allowed — being off-subnet is then the point", () => {
    const fills = dhcpCidrFormFills(
      "10.0.0.0/24",
      { ...UNTOUCHED, interface: "192.168.9.5", allowRelayAgents: true },
      INTERFACES
    )!;
    expect(fills).not.toHaveProperty("interface");
    // …and the rest of the fill still happens.
    expect(fills.rangeStart).toBe("10.0.0.1");
  });

  it("says nothing when the service is bound to every interface", () => {
    const fills = dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, interface: "" }, INTERFACES)!;
    expect(fills).not.toHaveProperty("interface");
  });

  it("says nothing when two NICs are on the new network — that pick is a coin toss", () => {
    const ambiguous: readonly NetworkInterfaceOption[] = [
      ...INTERFACES,
      { label: "eth2 — 10.0.0.6", value: "10.0.0.6", netmask: "255.255.255.0" }
    ];
    const fills = dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, interface: "192.168.9.5" }, ambiguous)!;
    expect(fills).not.toHaveProperty("interface");
  });
});

describe("dhcpCidrFormFills — networks that describe no pool", () => {
  it.each(["10.0.0.1/32", "10.0.0.0/31", "0.0.0.0/0", "not-a-network", "10.0.0.0", "10.0.0.0/abc", "10.0.0.0/24/8"])(
    "fills nothing at all for %s",
    (text) => {
      // Not "fills a bit less" — nothing. A subnet mask written without a pool
      // to go with it is a configuration the user never asked for.
      expect(dhcpCidrFormFills(text, UNTOUCHED, INTERFACES)).toBeUndefined();
    }
  );
});

describe("dhcpInterfaceCidr — a NIC as the network it is on", () => {
  it("uses the NIC's own netmask", () => {
    expect(dhcpInterfaceCidr("10.4.7.55", INTERFACES)).toBe("10.4.6.0/23");
    expect(dhcpInterfaceCidr("192.168.9.5", INTERFACES)).toBe("192.168.9.0/24");
  });

  it("answers nothing for a NIC reported without a netmask, rather than guessing one", () => {
    // An older or unusual os.networkInterfaces() report. Assuming /24 here
    // would write a mask the machine never claimed.
    const noMask: readonly NetworkInterfaceOption[] = [{ label: "eth9 — 172.16.4.9", value: "172.16.4.9" }];
    expect(dhcpInterfaceCidr("172.16.4.9", noMask)).toBeUndefined();
  });

  it("answers nothing for the all-interfaces choice and for an address this machine does not hold", () => {
    expect(dhcpInterfaceCidr("", INTERFACES)).toBeUndefined();
    expect(dhcpInterfaceCidr("0.0.0.0", INTERFACES)).toBeUndefined();
    expect(dhcpInterfaceCidr("203.0.113.7", INTERFACES)).toBeUndefined();
  });
});

describe("dhcpFormAutofillFields — the form's single entry point", () => {
  it("derives a whole pool from the NIC the user picked", () => {
    const fills = dhcpFormAutofillFields("interface", "10.4.7.55", UNTOUCHED, INTERFACES)!;
    expect(fills.cidr).toBe("10.4.6.0/23");
    expect(fills.subnet).toBe("255.255.254.0");
    expect(fills.rangeStart).toBe("10.4.6.1");
  });

  it("does not then rebind the interface it was just handed", () => {
    // The picked NIC is already on the derived network, so the off-subnet
    // offer must stay silent — a fill that answered the user's own choice with
    // a different address would be the picker fighting the user.
    const fills = dhcpFormAutofillFields(
      "interface",
      "10.0.0.5",
      { ...UNTOUCHED, interface: "10.0.0.5" },
      INTERFACES
    )!;
    expect(fills).not.toHaveProperty("interface");
  });

  it("no-ops cleanly for a NIC with no usable netmask instead of throwing", () => {
    const noMask: readonly NetworkInterfaceOption[] = [
      { label: "All interfaces (0.0.0.0)", value: "" },
      { label: "eth9 — 172.16.4.9", value: "172.16.4.9" }
    ];
    expect(() => dhcpFormAutofillFields("interface", "172.16.4.9", UNTOUCHED, noMask)).not.toThrow();
    expect(dhcpFormAutofillFields("interface", "172.16.4.9", UNTOUCHED, noMask)).toBeUndefined();
    expect(dhcpFormAutofillFields("interface", "", UNTOUCHED, noMask)).toBeUndefined();
  });

  it("ignores fields this form derives nothing from", () => {
    // Every autofill-capable select in the product posts through the same
    // channel; answering one the DHCP form does not own would write a pool at
    // an unrelated key.
    expect(dhcpFormAutofillFields("authProfileId", "ap1", UNTOUCHED, INTERFACES)).toBeUndefined();
    expect(dhcpFormAutofillFields("gateway", "10.0.0.0/24", UNTOUCHED, INTERFACES)).toBeUndefined();
  });

  it("treats a missing value snapshot as an empty form rather than failing", () => {
    const fills = dhcpFormAutofillFields("cidr", "10.0.0.0/24", undefined, INTERFACES)!;
    expect(fills.rangeStart).toBe("10.0.0.1");
    // Nothing is set, so everything is fair game.
    expect(fills.gateway).toBe("10.0.0.254");
  });
});

/**
 * REVIEW FINDING (P1, third round) — the two triggers that reach
 * `dhcpCidrFormFills` disagree about what the bind address was, and only one of
 * them can use `values.interface` for both sides of the change.
 *
 * A CIDR commit changes that row and nothing else, so the address in the
 * snapshot is the address either side. An INTERFACE selection changes the bind
 * address itself, and the webview applies the selection to the DOM before it
 * posts (`selectCustomOption` runs ahead of `postAutofill`), so by the time the
 * derivation runs `values.interface` already holds the NEW NIC. Resolving the
 * PREVIOUS network's identifier from it therefore answers a question about the
 * new NIC.
 *
 * On two NICs sharing one subnet that is not a near-miss, it is silent
 * breakage: both resolutions land on the new address, the auto-filled
 * identifier still naming the old one fails `isAutoFillable`, it survives as
 * though hand-set, and the socket then answers from .6 while every OFFER tells
 * clients to renew at .5. `previousValue` — the field's value immediately
 * before the selection — is threaded through the round trip for exactly this.
 */
describe("dhcpFormAutofillFields — switching between two NICs on ONE subnet", () => {
  /** Both eth1 and eth2 are on 10.0.0.0/24; nothing else about them differs. */
  const SAME_SUBNET: readonly NetworkInterfaceOption[] = [
    ...INTERFACES,
    { label: "eth2 — 10.0.0.6", value: "10.0.0.6", netmask: "255.255.255.0" }
  ];

  /**
   * The form as the webview posts it for a 10.0.0.5 → 10.0.0.6 selection: the
   * pool is already on 10.0.0.0/24, `serverId` holds what this fill wrote for
   * 10.0.0.5, and `interface` ALREADY reads 10.0.0.6 because the DOM was
   * updated before the message went out. The old address survives only as the
   * fifth argument.
   */
  const AFTER_SELECTING_SIX: FormValues = {
    rangeStart: "10.0.0.1",
    subnet: "255.255.255.0",
    interface: "10.0.0.6",
    serverId: "10.0.0.5"
  };

  it("refreshes the identifier to the NIC now bound, instead of leaving the one it replaced", () => {
    const fills = dhcpFormAutofillFields("interface", "10.0.0.6", AFTER_SELECTING_SIX, SAME_SUBNET, "10.0.0.5")!;
    // The socket is about to bind .6; option 54 and BOOTP siaddr have to say so.
    expect(fills.serverId).toBe("10.0.0.6");
  });

  it("still keeps an identifier the user typed, which no selection ever wrote", () => {
    // The other half of the same gate, on the same fixture: 10.0.0.99 is not
    // what this fill would have written for EITHER NIC, so it is a decision.
    // An implementation that simply always refreshed on an interface change
    // would go green above and destroy this.
    const fills = dhcpFormAutofillFields(
      "interface",
      "10.0.0.6",
      { ...AFTER_SELECTING_SIX, serverId: "10.0.0.99" },
      SAME_SUBNET,
      "10.0.0.5"
    )!;
    expect(fills).not.toHaveProperty("serverId");
  });

  it("falls back to the current address when no previous one is supplied — the CIDR trigger's case", () => {
    // Committing a network cannot move the bind address as a side effect of
    // itself, so that trigger passes nothing and the fallback has to read the
    // current address for both sides. Here that means the identifier standing
    // at .6 is recognised as this fill's own and refreshed for the new network.
    const fills = dhcpFormAutofillFields(
      "cidr",
      "192.168.9.0/24",
      { ...AFTER_SELECTING_SIX, serverId: "10.0.0.6" },
      SAME_SUBNET
    )!;
    expect(fills.serverId).toBe("192.168.9.5");
  });
});

describe("dhcpInterfaceChoices — the picker's pool-subnet annotations", () => {
  it("marks exactly the NICs on the pool's subnet, in the order they were enumerated", () => {
    const choices = dhcpInterfaceChoices(INTERFACES, "10.0.0.10", "255.255.255.0");
    expect(choices.map((choice) => choice.value)).toEqual(["", "192.168.9.5", "10.0.0.5", "10.4.7.55"]);
    expect(choices.map((choice) => choice.description)).toEqual([
      undefined,
      undefined,
      "matches the pool subnet",
      undefined
    ]);
  });

  it("never annotates the all-interfaces choice, which is not one NIC", () => {
    // 0.0.0.0 is inside every network under a loose comparison, so an
    // implementation that compared it like any other address would claim the
    // all-interfaces row matches whatever pool is configured.
    const choices = dhcpInterfaceChoices(INTERFACES, "0.0.0.10", "255.0.0.0");
    expect(choices[0].description).toBeUndefined();
  });

  it("annotates against the POOL's mask, not each NIC's own", () => {
    // vpn0 is on /23. Asked about a /24 pool at 10.4.7.x it matches; asked
    // about one at 10.4.6.x it does not — a comparison run under the NIC's
    // wider mask would call both a match and offer a NIC that cannot serve it.
    expect(dhcpInterfaceChoices(INTERFACES, "10.4.7.10", "255.255.255.0")[3].description).toBe(
      "matches the pool subnet"
    );
    expect(dhcpInterfaceChoices(INTERFACES, "10.4.6.10", "255.255.255.0")[3].description).toBeUndefined();
  });

  it("says nothing at all when the pool's own subnet cannot be worked out", () => {
    const choices = dhcpInterfaceChoices(INTERFACES, "10.0.0.10", "255.0.255.0");
    expect(choices.every((choice) => choice.description === undefined)).toBe(true);
  });
});

/**
 * REVIEW FINDING (P1, carried over from #111) — the two rules above are correct
 * on their own and were wrong together. "Keeps a gateway the user typed" means
 * that address stays in force on the new network; the pool was derived without
 * knowing it, so it could span it. A hand-set gateway of 10.0.0.1 with
 * 10.0.0.0/24 typed in produced a pool of 10.0.0.1-10.0.0.253 AND kept the
 * gateway, so the server could lease the router's address to a client.
 */
describe("dhcpCidrFormFills — a preserved gateway or DNS is not poolable either", () => {
  /** No NIC on 10.0.0.x, so only the preserved values can move the pool. */
  const ELSEWHERE: readonly NetworkInterfaceOption[] = [
    { label: "All interfaces (0.0.0.0)", value: "" },
    { label: "eth0 — 192.168.9.5", value: "192.168.9.5", netmask: "255.255.255.0" }
  ];

  it("builds the pool around a gateway it has just decided to keep", () => {
    const values: FormValues = { ...UNTOUCHED, gateway: "10.0.0.1" };
    const fills = dhcpCidrFormFills("10.0.0.0/24", values, ELSEWHERE)!;
    // The gateway survives, as it must...
    expect(fills).not.toHaveProperty("gateway");
    // ...so the pool has to start above it rather than on it.
    expect(fills.rangeStart).toBe("10.0.0.2");
  });

  it("stops the pool below a preserved DNS server in the middle of it", () => {
    const values: FormValues = { ...UNTOUCHED, dns: "10.0.0.40" };
    const fills = dhcpCidrFormFills("10.0.0.0/24", values, ELSEWHERE)!;
    expect(fills).not.toHaveProperty("dns");
    expect(fills.rangeStart).toBe("10.0.0.1");
    expect(fills.poolCount).toBe("39");
  });

  it("leaves the pool alone when the gateway is one it is about to replace", () => {
    // 192.168.2.254 is the previous network's own derived gateway, so it is
    // overwritten and is not an address on the new wire at all. Reserving it
    // would shrink the pool for no reason.
    const values: FormValues = { ...UNTOUCHED, gateway: "192.168.2.254" };
    const fills = dhcpCidrFormFills("10.0.0.0/24", values, ELSEWHERE)!;
    expect(fills.gateway).toBe("10.0.0.254");
    expect(fills.rangeStart).toBe("10.0.0.1");
    expect(fills.poolCount).toBe("253");
  });

  it("fills nothing when the preserved addresses leave no pool", () => {
    const values: FormValues = { ...UNTOUCHED, gateway: "10.0.0.1" };
    // /30: .1 is the only poolable address and the kept gateway is on it.
    expect(dhcpCidrFormFills("10.0.0.0/30", values, ELSEWHERE)).toBeUndefined();
  });
});

/**
 * REVIEW FINDING (P1, carried over from #111) — with a relay agent in front of
 * the service the pool is deliberately a subnet this machine is NOT on, but
 * picking a bind NIC still ran the full CIDR derivation over that NIC's own
 * local network. Rebinding a server relaying 10.0.0.0/24 from one local address
 * to another silently replaced the relayed pool with the local one.
 */
describe("dhcpFormAutofillFields — an interface change under relay mode", () => {
  /**
   * Two local NICs on the same wire, because the identifier gate compares what
   * each BIND resolves to: a previous address this machine does not hold
   * resolves to nothing, and every refresh below would abstain for that reason
   * rather than for the one under test.
   */
  const RELAY_NICS: readonly NetworkInterfaceOption[] = [
    ...INTERFACES,
    { label: "eth0:1 — 192.168.9.6", value: "192.168.9.6", netmask: "255.255.255.0" }
  ];

  /** Relaying 10.0.0.0/24 while bound to a local 192.168.9.x NIC. */
  const RELAYED: FormValues = {
    rangeStart: "10.0.0.10",
    subnet: "255.255.255.0",
    poolCount: 20,
    allowRelayAgents: true,
    interface: "192.168.9.6"
  };

  it("does not touch the relayed pool, mask, gateway, broadcast or DNS", () => {
    const fills = dhcpFormAutofillFields("interface", "192.168.9.5", RELAYED, RELAY_NICS, "192.168.9.6") ?? {};
    for (const key of ["subnet", "rangeStart", "poolCount", "gateway", "broadcast", "dns", "cidr"]) {
      expect(fills).not.toHaveProperty(key);
    }
  });

  it("still moves an auto-filled Server Identifier onto the new bind address", () => {
    // Option 54 names the address clients reach THIS machine on, which the
    // relay does not change — so a stale one still has to be refreshed.
    const values: FormValues = { ...RELAYED, serverId: "192.168.9.6" };
    const fills = dhcpFormAutofillFields("interface", "192.168.9.5", values, RELAY_NICS, "192.168.9.6")!;
    expect(fills.serverId).toBe("192.168.9.5");
  });

  it("leaves a Server Identifier the user typed alone", () => {
    const values: FormValues = { ...RELAYED, serverId: "172.16.4.4" };
    expect(dhcpFormAutofillFields("interface", "192.168.9.5", values, RELAY_NICS, "192.168.9.6")).toBeUndefined();
  });

  it("still derives the whole network from the CIDR row, which relay does not change", () => {
    // Typing a network under relay is the user naming the client subnet to
    // serve — the one gesture that is MEANT to move the pool.
    const fills = dhcpFormAutofillFields("cidr", "172.16.0.0/24", RELAYED, RELAY_NICS)!;
    expect(fills.subnet).toBe("255.255.255.0");
    expect(fills.rangeStart).toBe("172.16.0.1");
  });

  it("derives the NIC's network as before when relay mode is off", () => {
    const direct: FormValues = { ...RELAYED, allowRelayAgents: false };
    const fills = dhcpFormAutofillFields("interface", "10.0.0.5", direct, RELAY_NICS, "192.168.9.6")!;
    expect(fills.subnet).toBe("255.255.255.0");
    expect(fills.rangeStart).toBe("10.0.0.1");
  });
});
