/**
 * @author kanekitakitos
 *
 * Unit tests for the two data-entry shortcuts in
 * `src/commands/networkServerQuickAdjust.ts`: entering a whole network as CIDR,
 * and being told which NIC that network is actually on.
 *
 * The editor is driven the way a user drives it — a scripted quick pick, a
 * scripted input box — because what is worth pinning down here is not the
 * arithmetic (that is `dhcpCidrEntry.test.ts`) but *which settings get written
 * and when*. Three of those are load-bearing:
 *  1. Nothing is written until the confirmation is accepted. Declining leaves
 *     the settings byte-for-byte as they were.
 *  2. A gateway the user typed survives a network change; one the editor itself
 *     suggested for the old network does not.
 *  3. The NIC is offered, never auto-written, and only when exactly one is on
 *     the new subnet.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const networkInterfaces = vi.hoisted(() => vi.fn());

vi.mock("node:os", () => ({ networkInterfaces }));

const settings = new Map<string, unknown>();

vi.mock("vscode", () => ({
  window: {
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn()
  },
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string, fallback?: unknown) => {
        const value = settings.get(`${section}.${key}`);
        return value === undefined ? fallback : value;
      },
      update: async (key: string, value: unknown) => {
        if (value === undefined) settings.delete(`${section}.${key}`);
        else settings.set(`${section}.${key}`, value);
      }
    })
  },
  ConfigurationTarget: { Global: 1 },
  QuickPickItemKind: { Separator: -1 }
}));

import * as vscode from "vscode";
import { openNetworkServerQuickAdjust } from "../../../src/commands/networkServerQuickAdjust";

type Row = { label: string; description?: string; detail?: string; run?: () => Promise<unknown> };

/** Every `showQuickPick` list the editor put up, in order. */
const quickPickCalls: Row[][] = [];
/** Scripted answers to `showQuickPick`, one per call. */
let quickPickScript: Array<(rows: Row[]) => unknown> = [];
/** Scripted answers to `showInputBox`, one per call. */
let inputScript: Array<string | undefined> = [];
/** Options the editor passed to `showInputBox`, for driving `validateInput`. */
const inputCalls: Array<{ title?: string; value?: string; validateInput?: (raw: string) => string | undefined }> = [];

function ipv4(address: string, netmask = "255.255.255.0", internal = false) {
  return { address, netmask, family: "IPv4", internal };
}

/** Picks the row whose label contains `needle`, and runs it. */
function pickRow(needle: string) {
  return (rows: Row[]) => rows.find((row) => row.label.includes(needle));
}

/** The confirm-or-decline pick the auto-fill offer puts up. */
function answerAutoFill(confirmed: boolean) {
  return (rows: Row[]) => rows[confirmed ? 0 : 1];
}

/** Dismisses the pick — how the editor's loop is exited. */
const dismiss = () => undefined;

function seed(values: Record<string, unknown>): void {
  settings.clear();
  for (const [key, value] of Object.entries(values)) {
    settings.set(`nexus.networkServers.dhcp.${key}`, value);
  }
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    isRunning: () => false,
    restart: vi.fn(async () => undefined),
    openFullForm: vi.fn(),
    saveProfile: vi.fn(async () => undefined),
    loadProfile: vi.fn(async () => false),
    ...overrides
  } as never;
}

function written(key: string): unknown {
  return settings.get(`nexus.networkServers.dhcp.${key}`);
}

beforeEach(() => {
  settings.clear();
  quickPickCalls.length = 0;
  inputCalls.length = 0;
  quickPickScript = [];
  inputScript = [];
  networkInterfaces.mockReset();
  networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")] });

  vi.mocked(vscode.window.showQuickPick).mockReset();
  vi.mocked(vscode.window.showQuickPick).mockImplementation((async (rows: Row[]) => {
    quickPickCalls.push(rows);
    const next = quickPickScript.shift();
    return next ? next(rows) : undefined;
  }) as never);

  vi.mocked(vscode.window.showInputBox).mockReset();
  vi.mocked(vscode.window.showInputBox).mockImplementation((async (options: (typeof inputCalls)[number]) => {
    inputCalls.push(options);
    return inputScript.shift();
  }) as never);

  vi.mocked(vscode.window.showInformationMessage).mockReset();
  vi.mocked(vscode.window.showWarningMessage).mockReset();
});

describe("the Network (CIDR) row", () => {
  it("shows the network the stored settings already describe, with nothing migrated", async () => {
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199" });
    quickPickScript = [dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());
    const row = quickPickCalls[0].find((entry) => entry.label.includes("Network (CIDR)"));
    expect(row).toBeDefined();
    expect(row?.description).toBe("192.168.2.0/24");
  });

  it("reads the prefix off an explicit mask rather than assuming /24", async () => {
    seed({ rangeStart: "10.0.0.130", subnet: "255.255.255.192" });
    quickPickScript = [dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());
    expect(quickPickCalls[0].find((entry) => entry.label.includes("Network (CIDR)"))?.description).toBe(
      "10.0.0.128/26"
    );
  });

  it("refuses /31, /32 and /0 in the input box, each in its own words", async () => {
    seed({});
    quickPickScript = [pickRow("Network (CIDR)"), dismiss];
    inputScript = [undefined];
    await openNetworkServerQuickAdjust("dhcp", deps());
    const validate = inputCalls[0].validateInput!;
    expect(validate("10.0.0.0/31")).toContain("RFC 3021");
    expect(validate("10.0.0.7/32")).toContain("single address");
    expect(validate("0.0.0.0/0")).toContain("not a subnet");
    expect(validate("10.0.0.0/24")).toBeUndefined();
    // Escaping the box writes nothing.
    expect([...settings.keys()]).toEqual([]);
  });
});

describe("applying a CIDR", () => {
  it("writes the mask, the pool and the derived addresses once confirmed", async () => {
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("subnet")).toBe("255.255.255.0");
    expect(written("rangeStart")).toBe("10.0.0.1");
    expect(written("rangeEnd")).toBe("10.0.0.253");
    expect(written("gateway")).toBe("10.0.0.254");
    expect(written("broadcast")).toBe("10.0.0.255");
    expect(written("dns")).toEqual(["10.0.0.254"]);
  });

  it("writes nothing at all when the confirmation is declined", async () => {
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(false), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("subnet")).toBeUndefined();
    expect(written("rangeStart")).toBe("192.168.2.10");
    expect(written("rangeEnd")).toBe("192.168.2.199");
    expect(written("gateway")).toBeUndefined();
  });

  it("leaves a hand-set gateway alone while still moving the pool", async () => {
    // 192.168.2.1 is not what this editor would have suggested for the old
    // network (it suggests the top usable address), so it is a decision.
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199", gateway: "192.168.2.1" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("gateway")).toBe("192.168.2.1");
    expect(written("rangeStart")).toBe("10.0.0.1");
    expect(written("subnet")).toBe("255.255.255.0");
  });

  it("replaces a gateway it suggested itself for the previous network", async () => {
    // 192.168.2.254 is exactly what the old /24 derived, i.e. a stale
    // suggestion rather than a decision.
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199", gateway: "192.168.2.254" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("gateway")).toBe("10.0.0.254");
  });

  it("still offers when the network is re-entered unchanged, which is how a drifted pool is straightened out", async () => {
    // Deliberately unlike the plain text rows, which treat an unchanged submit
    // as a no-op: here the pool is inconsistent with the network it is on, and
    // re-entering that network is the only way to say so. Nothing is written
    // without the confirmation, so the row still cannot write by being browsed.
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["192.168.2.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("rangeStart")).toBe("192.168.2.1");
    // …and stops below eth0's own 192.168.2.5 rather than at .253: this is the
    // exact case where re-applying the current network would otherwise widen
    // the pool over the address the service answers from.
    expect(written("rangeEnd")).toBe("192.168.2.4");
  });

  it("does nothing at all when the box is submitted empty", async () => {
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199" });
    quickPickScript = [pickRow("Network (CIDR)"), dismiss];
    inputScript = [""];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("rangeStart")).toBe("192.168.2.10");
    expect(written("subnet")).toBeUndefined();
    // No confirmation was put up either — the second pick is the editor's own
    // list again, not an auto-fill offer.
    expect(quickPickCalls[1].some((row) => row.label.includes("auto-fill"))).toBe(false);
  });

  it("offers a restart only after something was actually written", async () => {
    seed({});
    const restarting = deps({ isRunning: () => true });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(false), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", restarting);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();

    quickPickCalls.length = 0;
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", restarting);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Restart DHCP to apply the new settings?",
      "Restart"
    );
  });
});

/**
 * REVIEW FINDING (P1) — the pool this row writes must not contain an address
 * this machine already holds, or the allocator can lease the DHCP server its
 * own IP. The quick editor derives against the same filtered NIC list the
 * Interface row reads, so the two cannot disagree about what is taken.
 */
describe("applying a CIDR — this machine's own addresses stay out of the pool", () => {
  it("stops the pool below the local address on the network being applied", async () => {
    networkInterfaces.mockReturnValue({ eth1: [ipv4("10.0.0.42")] });
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("rangeStart")).toBe("10.0.0.1");
    expect(written("rangeEnd")).toBe("10.0.0.41");
    // The network itself is untouched — only the pool was moved off .42.
    expect(written("subnet")).toBe("255.255.255.0");
    expect(written("gateway")).toBe("10.0.0.254");
  });

  it("steps the start over a local address sitting on the first host address", async () => {
    networkInterfaces.mockReturnValue({ eth1: [ipv4("10.0.0.1")] });
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("rangeStart")).toBe("10.0.0.2");
    expect(written("rangeEnd")).toBe("10.0.0.253");
  });

  it("writes nothing and says why when this machine leaves the network no pool", async () => {
    // A /30 has one poolable address and eth1 is on it. The input box's
    // validator passes the network — it asks about the network, not about this
    // host — so without a word here the Enter would simply do nothing.
    networkInterfaces.mockReturnValue({ eth1: [ipv4("10.0.0.1", "255.255.255.252")] });
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199" });
    quickPickScript = [pickRow("Network (CIDR)"), dismiss];
    inputScript = ["10.0.0.0/30"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("rangeStart")).toBe("192.168.2.10");
    expect(written("subnet")).toBeUndefined();
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0]).toContain("leaves no pool");
  });

  it("says nothing for a box submitted empty, which still means 'leave it alone'", async () => {
    seed({ rangeStart: "192.168.2.10" });
    quickPickScript = [pickRow("Network (CIDR)"), dismiss];
    inputScript = [""];
    await openNetworkServerQuickAdjust("dhcp", deps());
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
});

/**
 * REVIEW FINDING (P1) — the Server Identifier (option 54) has to follow the
 * network. Without it, applying 10.0.0.0/24 leaves clients being told to renew
 * against the packaged 192.168.2.1, which is not on their wire.
 *
 * REVIEW FINDING (P1, second round) — and it must NOT be taken from the derived
 * gateway. `DhcpEngine` copies `serverId` verbatim into option 54 and into the
 * BOOTP `siaddr` a ZTP client boots from, so it has to name an address this
 * machine actually answers on. The gateway this codebase derives is the top
 * usable address of the network — the router's, or nobody's. The two agreed
 * only because the packaged defaults are one address (DEFAULTS.serverId ===
 * DEFAULTS.gateway === 192.168.2.1).
 *
 * Every fixture below therefore puts a real NIC on the network being applied,
 * at an address that is deliberately NOT the derived gateway: eth1 holds
 * 10.0.0.5 while 10.0.0.0/24 derives 10.0.0.254.
 */
describe("applying a CIDR — the server identifier", () => {
  /** eth0 on the old network, eth1 on the one about to be applied. */
  function twoNics(): void {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.2.5")],
      eth1: [ipv4("10.0.0.5")]
    });
  }

  it("writes the serving NIC's address, not the gateway, while it is unset", async () => {
    twoNics();
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBe("10.0.0.5");
    // The gateway setting is still the gateway — only option 54 moved.
    expect(written("gateway")).toBe("10.0.0.254");
  });

  it("uses the bound NIC itself when it is already on the new subnet", async () => {
    // The `match` branch, put where a suggestion could not answer at all: TWO
    // NICs are on 10.0.0.0/24 and the service is bound to the second of them.
    // An implementation that only ever asked suggestBindAddressForPool would
    // write nothing here, and one that took its first match would write the
    // wrong NIC's address.
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.2.5")],
      eth1: [ipv4("10.0.0.5")],
      eth2: [ipv4("10.0.0.6")]
    });
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199", interface: "10.0.0.6" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBe("10.0.0.6");
  });

  it("leaves it untouched when no NIC of this machine is on the new network", async () => {
    // The default fixture holds only 192.168.2.5. 172.30.0.0/24 is a fine
    // network that this machine is simply not on, so there is no address to
    // advertise — and the gateway is not a stand-in for one. The key is left
    // UNSET, which is the case a fill would always have been free to take: an
    // implementation deriving option 54 from the network writes 172.30.0.254
    // here, an address belonging to nothing.
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["172.30.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBeUndefined();
    // The rest of the network still applied.
    expect(written("rangeStart")).toBe("172.30.0.1");
    expect(written("gateway")).toBe("172.30.0.254");
  });

  it("writes nothing for it when two NICs are on the new network", async () => {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.2.5")],
      eth1: [ipv4("10.0.0.5")],
      eth2: [ipv4("10.0.0.6")]
    });
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBeUndefined();
    expect(written("rangeStart")).toBe("10.0.0.1");
  });

  /**
   * REVIEW FINDING (P1, third round) — the relay branch's gateway fallback was
   * itself the defect. A server bound at 192.168.2.5 serving 10.0.0.0/24
   * through a relay was told to advertise 10.0.0.254 for option 54 and BOOTP
   * `siaddr` — the CLIENT subnet's router, not this service — so unicast
   * renewals and ZTP image fetches went somewhere this server does not answer.
   *
   * REVIEW FINDING (P1, fifth round — relay with an explicit held bind) — the
   * fix for that was a blanket relay skip, which went too far. Relay mode now
   * abstains only where the BIND names no single address of this machine, which
   * is what the three fixtures below have in common: none of them seeds
   * `interface`, so the service binds every NIC and there is no one address for
   * option 54 to name. The gateway is still never a stand-in.
   */
  it("offers nothing for it under relay while the service binds every interface", async () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")] });
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199", allowRelayAgents: true });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBeUndefined();
    // The rest of the network still applied — only option 54 abstained.
    expect(written("rangeStart")).toBe("10.0.0.1");
    expect(written("gateway")).toBe("10.0.0.254");
  });

  it("leaves a configured identifier alone under relay, even one matching the OLD gateway", async () => {
    // 192.168.2.254 is exactly what the previous /24 derived, which is what the
    // removed `previous?.gateway` baseline treated as this offer's own stale
    // suggestion — it was silently replaced by 10.0.0.254. The bind is
    // all-interfaces, so nothing resolves, there is no baseline, and a hand-set
    // option 54 survives.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")] });
    seed({
      rangeStart: "192.168.2.10",
      rangeEnd: "192.168.2.199",
      allowRelayAgents: true,
      serverId: "192.168.2.254"
    });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBe("192.168.2.254");
  });

  it("abstains for an all-interfaces bind under relay even when a NIC IS on the pool's subnet", async () => {
    // eth1 holds 10.0.0.5, so a NIC *suggestion* would succeed. It is not asked
    // for: under relay the bind is the only thing that can name this service's
    // address, and "every interface" names none. Kills falling through to the
    // pool-subnet suggestion under relay, which would write 10.0.0.5 here.
    twoNics();
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199", allowRelayAgents: true });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBeUndefined();
    expect(written("rangeStart")).toBe("10.0.0.1");
  });

  /**
   * REVIEW FINDING (P1, fifth round — relay with an explicit held bind), the
   * half the blanket skip was getting wrong. A service bound to a concrete
   * address this machine holds answers from that address with a relay in front
   * of it just as without one, and option 54 has to say so — otherwise a relayed
   * lab goes on advertising whatever stale identifier is configured.
   */
  it("offers the explicitly bound address under relay when this machine holds it", async () => {
    // Bound to eth0's own 192.168.2.5, relaying 10.0.0.0/24 — deliberately OFF
    // the pool's subnet, which is the arrangement relay exists for. The derived
    // gateway (10.0.0.254) and the pool's NIC (10.0.0.5) are both visibly
    // different answers, so neither wrong implementation can pass.
    twoNics();
    seed({
      rangeStart: "192.168.2.10",
      rangeEnd: "192.168.2.199",
      interface: "192.168.2.5",
      allowRelayAgents: true
    });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBe("192.168.2.5");
    expect(written("gateway")).toBe("10.0.0.254");
  });

  it("offers nothing under relay for a bind address this machine does not hold", async () => {
    // The other guard on "don't guess": the address in the setting is stale (a
    // dock unplugged, a VPN dropped), so it names nothing reachable. Note that
    // `dhcpInterfaceSubnetStatus` calls ANY non-blank bind a `match` under
    // relay, so an implementation that resolved through it would advertise
    // 172.30.9.9 here.
    twoNics();
    seed({
      rangeStart: "192.168.2.10",
      rangeEnd: "192.168.2.199",
      interface: "172.30.9.9",
      allowRelayAgents: true
    });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBeUndefined();
    expect(written("rangeStart")).toBe("10.0.0.1");
  });

  it("still gates the relay offer, so a hand-set identifier survives the network change", async () => {
    // The bind does not move here, so the previous resolution is 192.168.2.5
    // too; 192.168.2.99 is neither that nor blank, so someone typed it. Kills
    // "under relay, always write the bind address".
    twoNics();
    seed({
      rangeStart: "192.168.2.10",
      rangeEnd: "192.168.2.199",
      interface: "192.168.2.5",
      allowRelayAgents: true,
      serverId: "192.168.2.99"
    });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBe("192.168.2.99");
    expect(written("rangeStart")).toBe("10.0.0.1");
  });

  it("writes nothing when the confirmation is declined", async () => {
    twoNics();
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(false), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBeUndefined();
  });
});

/**
 * The gate on the offer above, which had to move with it: what counts as "still
 * holding what the PREVIOUS network auto-filled" is the same NIC resolution run
 * against the previous rangeStart/subnet, not the previous gateway.
 *
 * Both fixtures below hold an address on the OLD network as well as the new
 * one, which is what makes the previous auto-fill resolvable at all and lets
 * the two possible baselines disagree.
 */
describe("applying a CIDR — what counts as a stale server identifier", () => {
  beforeEach(() => {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.2.5")],
      eth1: [ipv4("10.0.0.5")]
    });
  });

  it("replaces one that is still the PREVIOUS network's resolved address", async () => {
    // 192.168.2.5 is exactly what this offer would have written while the
    // config was on 192.168.2.0/24 — a stale suggestion naming the old wire.
    // A gate on the previous GATEWAY would not recognise it and would leave it.
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199", serverId: "192.168.2.5" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBe("10.0.0.5");
  });

  it("keeps the PREVIOUS network's gateway, which this offer would never have written", async () => {
    // The discriminating case for the gate itself. Under the old
    // gateway-based baseline this was treated as the offer's own leftover and
    // silently replaced. No version of this offer writes a gateway to serverId
    // any more, so someone typed it, and a hand-set option 54 has to survive.
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199", serverId: "192.168.2.254" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBe("192.168.2.254");
    // …and the network still applied over it.
    expect(written("rangeStart")).toBe("10.0.0.1");
  });

  it("keeps any other address the user typed", async () => {
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199", serverId: "192.168.2.1" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBe("192.168.2.1");
    expect(written("rangeStart")).toBe("10.0.0.1");
  });
});

describe("the NIC that goes with the new network", () => {
  it("offers the single NIC on the new subnet as part of the same confirmation", async () => {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.2.5")],
      eth1: [ipv4("10.0.0.5")]
    });
    seed({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199", interface: "192.168.2.5" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("10.0.0.5");
  });

  it("does not rebind without the confirmation", async () => {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.2.5")],
      eth1: [ipv4("10.0.0.5")]
    });
    seed({ rangeStart: "192.168.2.10", interface: "192.168.2.5" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(false), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("192.168.2.5");
  });

  it("stays out of it when two NICs are on the new subnet", async () => {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.2.5")],
      eth1: [ipv4("10.0.0.5")],
      eth2: [ipv4("10.0.0.6")]
    });
    seed({ rangeStart: "192.168.2.10", interface: "192.168.2.5" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("192.168.2.5");
    // The rest of the CIDR still applied — only the rebind was withheld.
    expect(written("rangeStart")).toBe("10.0.0.1");
  });

  it("stays out of it when relay agents are allowed, off-subnet bind and all", async () => {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.2.5")],
      eth1: [ipv4("10.0.0.5")]
    });
    seed({ rangeStart: "192.168.2.10", interface: "192.168.2.5", allowRelayAgents: true });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("192.168.2.5");
    expect(written("rangeStart")).toBe("10.0.0.1");
  });

  it("suggests nothing when no NIC is on the new subnet", async () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")] });
    seed({ rangeStart: "192.168.2.10", interface: "192.168.2.5" });
    quickPickScript = [pickRow("Network (CIDR)"), answerAutoFill(true), dismiss];
    inputScript = ["10.0.0.0/24"];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("192.168.2.5");
  });
});

describe("the Interface row", () => {
  it("says which NICs are on the pool's subnet and lifts the single one to the top", async () => {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.2.5")],
      "Wi-Fi": [ipv4("172.16.0.9", "255.255.0.0")],
      eth1: [ipv4("10.0.0.5")]
    });
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99", interface: "192.168.2.5" });
    quickPickScript = [pickRow("Interface"), dismiss, dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    const bindPicker = quickPickCalls[1] as Array<{ label: string; description?: string }>;
    expect(bindPicker[0].label).toBe("All interfaces (0.0.0.0)");
    // Promoted to just below the all-interfaces row, out of its enumeration order.
    expect(bindPicker[1].label).toBe("eth1 — 10.0.0.5");
    expect(bindPicker[1].description).toBe("matches the pool subnet");
    expect(bindPicker.find((row) => row.label.startsWith("eth0"))?.description).toBe("current");
    expect(bindPicker.find((row) => row.label.startsWith("Wi-Fi"))?.description).toBeUndefined();
  });

  it("annotates both matching NICs and promotes neither", async () => {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.2.5")],
      eth1: [ipv4("10.0.0.5")],
      eth2: [ipv4("10.0.0.6")]
    });
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99", interface: "192.168.2.5" });
    quickPickScript = [pickRow("Interface"), dismiss, dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    const bindPicker = quickPickCalls[1] as Array<{ label: string; description?: string }>;
    // Enumeration order, untouched: eth0 is still the first NIC listed.
    expect(bindPicker.map((row) => row.label)).toEqual([
      "All interfaces (0.0.0.0)",
      "eth0 — 192.168.2.5",
      "eth1 — 10.0.0.5",
      "eth2 — 10.0.0.6"
    ]);
    expect(bindPicker[2].description).toBe("matches the pool subnet");
    expect(bindPicker[3].description).toBe("matches the pool subnet");
  });

  it("flags an off-subnet bind in the row's detail line, naming the pool's network", async () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")] });
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99", interface: "192.168.2.5" });
    quickPickScript = [dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    const row = quickPickCalls[0].find((entry) => entry.label.includes("Interface"));
    expect(row?.detail).toContain("not on the pool's subnet (10.0.0.0/24)");
  });

  it("says nothing about the subnet when relay agents are allowed", async () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")] });
    // Deliberately the same off-subnet fixture as the test above.
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99", interface: "192.168.2.5", allowRelayAgents: true });
    quickPickScript = [dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    const row = quickPickCalls[0].find((entry) => entry.label.includes("Interface"));
    expect(row?.detail).not.toContain("not on the pool's subnet");
    expect(row?.detail).toContain("eth0 — current IP 192.168.2.5");
  });

  it("says nothing about the subnet for an all-interfaces bind that a NIC can actually serve", async () => {
    // eth1 IS on 10.0.0.0/24, so binding everything genuinely includes the wire
    // the pool describes. The common, correct case, and it must stay silent.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")], eth1: [ipv4("10.0.0.5")] });
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99" });
    quickPickScript = [dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    const row = quickPickCalls[0].find((entry) => entry.label.includes("Interface"));
    expect(row?.detail).toBe("Every IPv4 address on this machine — no single NIC, so no current IP to show.");
  });

  /**
   * REVIEW FINDING (P2) — the row used to return before the subnet comparison
   * for a blank or 0.0.0.0 bind, so this arrangement (bind everything, offer
   * 10.0.0.x, hold nothing but a 192.168.2.x address) was the one unreachable
   * pool the editor said nothing at all about.
   */
  it("flags an all-interfaces bind when NO NIC on this machine is on the pool's subnet", async () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")] });
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99" });
    quickPickScript = [dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    const row = quickPickCalls[0].find((entry) => entry.label.includes("Interface"));
    expect(row?.detail).toContain("no NIC on this machine is on the pool's subnet (10.0.0.0/24)");
    // The descriptive half of the line is unchanged — the warning is appended.
    expect(row?.detail).toContain("Every IPv4 address on this machine");
  });

  it("says nothing about an unreachable all-interfaces bind when relay agents are allowed", async () => {
    // Deliberately the same unreachable fixture as the test above, one flag apart.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")] });
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99", allowRelayAgents: true });
    quickPickScript = [dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    const row = quickPickCalls[0].find((entry) => entry.label.includes("Interface"));
    expect(row?.detail).toBe("Every IPv4 address on this machine — no single NIC, so no current IP to show.");
  });
});

/**
 * REVIEW FINDING (P1, fourth round) — the Interface row is the third place the
 * bind address moves, and the only one the identifier fix had not reached. The
 * two CIDR rows move the pool under a fixed bind; this row moves the bind under
 * a fixed pool, and option 54 is a function of both. Switching a same-subnet NIC
 * wrote `interface` alone, so a service now bound to 10.0.0.6 kept advertising
 * 10.0.0.5 for renewals and for the BOOTP `siaddr` a ZTP client boots from —
 * an address it no longer answers on.
 *
 * The pool never moves in these fixtures. Only the bind does, which is what
 * makes the two resolutions differ and the tests discriminating.
 */
describe("the Interface row — the server identifier follows the rebind", () => {
  /** eth0 off the pool's subnet, eth1 and eth2 both on it. */
  function threeNics(): void {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("192.168.2.5")],
      eth1: [ipv4("10.0.0.5")],
      eth2: [ipv4("10.0.0.6")]
    });
  }

  it("moves an auto-derived identifier to the newly picked same-subnet NIC", async () => {
    // 10.0.0.5 is exactly what the OLD bind resolved to, i.e. a value this
    // editor would itself have written — stale the moment the bind moves.
    threeNics();
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99", interface: "10.0.0.5", serverId: "10.0.0.5" });
    quickPickScript = [pickRow("Interface"), pickRow("eth2"), dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("10.0.0.6");
    expect(written("serverId")).toBe("10.0.0.6");
  });

  it("fills an unset identifier from the newly picked NIC", async () => {
    threeNics();
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99", interface: "10.0.0.5" });
    quickPickScript = [pickRow("Interface"), pickRow("eth2"), dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("serverId")).toBe("10.0.0.6");
  });

  it("leaves a hand-set identifier alone while still rebinding", async () => {
    // 10.0.0.1 is not what the old bind resolved to (that was 10.0.0.5), so
    // someone typed it — a decision, not a leftover suggestion.
    threeNics();
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99", interface: "10.0.0.5", serverId: "10.0.0.1" });
    quickPickScript = [pickRow("Interface"), pickRow("eth2"), dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("10.0.0.6");
    expect(written("serverId")).toBe("10.0.0.1");
  });

  /**
   * REVIEW FINDING (P1, fifth round — relay with an explicit held bind). This
   * test used to assert the OPPOSITE: that a rebind under relay left `serverId`
   * at the old address. That assertion was pinning the defect, not a decision.
   *
   * The relay carve-out it encoded reasoned "a relayed pool is on a wire this
   * machine holds no NIC on, so no local NIC is the answer" — true of the POOL,
   * false of the BIND. Both `10.0.0.5` and `10.0.0.6` are addresses this machine
   * genuinely holds and the picker only offers held addresses, so after the
   * rebind the socket answers from `.6`. Leaving option 54 and BOOTP `siaddr`
   * naming `.5` is the exact fault this row was added to fix, reintroduced by a
   * flag that says nothing about which address this service answers on.
   */
  it("moves the identifier to the newly picked NIC under relay too, since both addresses are held here", async () => {
    // Same fixture as the first test, one flag apart — and now the same answer,
    // which is the point: the relay flag says clients are reached through a
    // relay, not that this machine stopped having an address.
    threeNics();
    seed({
      rangeStart: "10.0.0.10",
      rangeEnd: "10.0.0.99",
      interface: "10.0.0.5",
      serverId: "10.0.0.5",
      allowRelayAgents: true
    });
    quickPickScript = [pickRow("Interface"), pickRow("eth2"), dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("10.0.0.6");
    expect(written("serverId")).toBe("10.0.0.6");
  });

  it("still leaves a hand-set identifier alone under relay — the gate applies in both modes", async () => {
    // The other half of the fix. Forwarding the relay flag must not turn the
    // rebind into an unconditional write: 10.0.0.1 is not what the old bind
    // resolved to, so someone typed it. Kills "under relay, just write the
    // address that was picked".
    threeNics();
    seed({
      rangeStart: "10.0.0.10",
      rangeEnd: "10.0.0.99",
      interface: "10.0.0.5",
      serverId: "10.0.0.1",
      allowRelayAgents: true
    });
    quickPickScript = [pickRow("Interface"), pickRow("eth2"), dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("10.0.0.6");
    expect(written("serverId")).toBe("10.0.0.1");
  });

  it("follows an OFF-subnet pick under relay, which is the arrangement relay is for", async () => {
    // eth0 is off the pool's subnet, and under relay that is the intended
    // configuration rather than a fault: the DISCOVERs arrive relayed. The
    // service is about to answer from 192.168.2.5, so that is what clients must
    // renew against. Without relay this same pick resolves nothing (see the
    // ambiguity test above), so the flag is genuinely load-bearing here.
    threeNics();
    seed({
      rangeStart: "10.0.0.10",
      rangeEnd: "10.0.0.99",
      interface: "10.0.0.5",
      serverId: "10.0.0.5",
      allowRelayAgents: true
    });
    quickPickScript = [pickRow("Interface"), pickRow("eth0"), dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("192.168.2.5");
    expect(written("serverId")).toBe("192.168.2.5");
  });

  it("writes nothing for it under relay when the pick is all-interfaces, which names no address", async () => {
    // The "don't guess" half of the fix. All-interfaces is not one address, so
    // there is nothing for option 54 to name and the configured value stands.
    threeNics();
    seed({
      rangeStart: "10.0.0.10",
      rangeEnd: "10.0.0.99",
      interface: "10.0.0.5",
      serverId: "10.0.0.5",
      allowRelayAgents: true
    });
    quickPickScript = [pickRow("Interface"), pickRow("All interfaces"), dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBeUndefined();
    expect(written("serverId")).toBe("10.0.0.5");
  });

  it("does not follow an off-subnet pick when the pool's subnet is ambiguous", async () => {
    // eth0 is a real, allowed choice — the picker annotates the matching NICs
    // rather than restricting the list. It is not on the pool's subnet, so the
    // question falls back to "which single NIC is", and eth1/eth2 both are:
    // no confident answer, so the configured identifier survives untouched.
    // Kills "just write the address that was picked", which lands 192.168.2.5
    // in option 54 for a 10.0.0.0/24 pool.
    threeNics();
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99", interface: "10.0.0.5", serverId: "10.0.0.5" });
    quickPickScript = [pickRow("Interface"), pickRow("eth0"), dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("192.168.2.5");
    expect(written("serverId")).toBe("10.0.0.5");
  });

  it("keeps the pool's own NIC on an off-subnet pick when exactly one is on it", async () => {
    // Only eth1 is on 10.0.0.0/24, so the fallback resolves — and resolves to
    // the same address as before. The identifier stays with the wire the pool
    // describes rather than following the bind off it.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")], eth1: [ipv4("10.0.0.5")] });
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99", interface: "10.0.0.5", serverId: "10.0.0.5" });
    quickPickScript = [pickRow("Interface"), pickRow("eth0"), dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("192.168.2.5");
    expect(written("serverId")).toBe("10.0.0.5");
  });

  it("writes neither setting when the picker is dismissed", async () => {
    threeNics();
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99", interface: "10.0.0.5", serverId: "10.0.0.5" });
    quickPickScript = [pickRow("Interface"), dismiss, dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("10.0.0.5");
    expect(written("serverId")).toBe("10.0.0.5");
  });

  it("writes neither setting when the current NIC is re-picked", async () => {
    threeNics();
    seed({ rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99", interface: "10.0.0.5", serverId: "10.0.0.1" });
    quickPickScript = [pickRow("Interface"), pickRow("eth1"), dismiss];
    await openNetworkServerQuickAdjust("dhcp", deps());

    expect(written("interface")).toBe("10.0.0.5");
    // Confirming the bind that is already in force is not an occasion to
    // recompute anything — a hand-set identifier included.
    expect(written("serverId")).toBe("10.0.0.1");
  });
});
