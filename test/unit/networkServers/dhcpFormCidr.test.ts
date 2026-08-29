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

  it("keeps the gateway fallback while relay agents are allowed", () => {
    // Deliberately unchanged from the round before: with a relay in front there
    // is by design no local NIC on the pool's subnet, and what option 54 should
    // say in that case is a separate question. The one thing pinned here is
    // that this branch did not quietly move with the rest.
    const fills = dhcpCidrFormFills("10.0.0.0/24", { ...UNTOUCHED, allowRelayAgents: true }, INTERFACES)!;
    expect(fills.serverId).toBe("10.0.0.254");
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
