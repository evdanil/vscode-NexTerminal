/**
 * @author kanekitakitos
 *
 * Unit tests for the off-subnet advisory on the DHCP Pool row
 * (`src/ui/networkServerTreeProvider.ts`).
 *
 * The row is advisory and must stay that way: it annotates a configuration that
 * is legal, startable and — behind a relay agent — correct. So the tests assert
 * the warning's absence at least as carefully as its presence, and pin that the
 * rest of the DHCP branch renders identically either way.
 *
 * The relay fixture is deliberately off-subnet. A same-subnet one would show no
 * warning under an implementation that ignored `allowRelayAgents` entirely, and
 * would therefore prove nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const readDhcpConfig = vi.hoisted(() => vi.fn());
const readTftpConfig = vi.hoisted(() => vi.fn(() => ({ port: 69, allowWrite: false })));
const networkInterfaces = vi.hoisted(() => vi.fn());

vi.mock("node:os", () => ({ networkInterfaces }));

vi.mock("vscode", () => {
  const EventEmitter = vi.fn().mockImplementation(function () {
    return { event: vi.fn(), fire: vi.fn(), dispose: vi.fn() };
  });
  return {
    TreeItem: class {
      public id?: string;
      public description?: string;
      public tooltip?: string;
      public contextValue?: string;
      public iconPath?: unknown;
      public constructor(
        public label: string,
        public collapsibleState?: number
      ) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      public constructor(public id: string) {}
    },
    ThemeColor: class {
      public constructor(public id: string) {}
    },
    EventEmitter
  };
});

vi.mock("../../../src/services/networkServers/networkServerManager", () => ({
  NETWORK_SERVER_KINDS: ["tftp", "dhcp"],
  readDhcpConfig,
  readTftpConfig
}));

import {
  NetworkServerDetailTreeItem,
  NetworkServerRootTreeItem,
  NetworkServerTreeProvider
} from "../../../src/ui/networkServerTreeProvider";

function ipv4(address: string, netmask = "255.255.255.0", internal = false) {
  return { address, netmask, family: "IPv4", internal };
}

/** A pool on 10.0.0.0/24, which the fixtures then bind on or off. */
const POOL = {
  rangeStart: "10.0.0.10",
  rangeEnd: "10.0.0.99",
  subnet: "255.255.255.0",
  gateway: "10.0.0.254"
};

function dhcpRows(config: Record<string, unknown>): NetworkServerDetailTreeItem[] {
  readDhcpConfig.mockReturnValue(config);
  const provider = new NetworkServerTreeProvider();
  const roots = provider.getChildren() as NetworkServerRootTreeItem[];
  const dhcpRoot = roots.find((root) => root.kind === "dhcp")!;
  return provider.getChildren(dhcpRoot) as NetworkServerDetailTreeItem[];
}

function poolRow(config: Record<string, unknown>): NetworkServerDetailTreeItem {
  return dhcpRows(config).find((row) => row.id === "networkServer:dhcp:pool")!;
}

beforeEach(() => {
  readDhcpConfig.mockReset();
  readTftpConfig.mockReturnValue({ port: 69, allowWrite: false });
  networkInterfaces.mockReset();
  networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")], eth1: [ipv4("10.0.0.5")] });
});

describe("DHCP Pool row — off-subnet bind", () => {
  it("marks the row when the bound NIC is not on the pool's subnet", () => {
    const row = poolRow({ ...POOL, bindAddress: "192.168.2.5" });
    expect(row.description).toBe("10.0.0.10 → 10.0.0.99 · ⚠ bound NIC is not on this subnet");
  });

  it("explains it in the tooltip, naming the bound address and the pool's network", () => {
    const tooltip = String(poolRow({ ...POOL, bindAddress: "192.168.2.5" }).tooltip);
    expect(tooltip).toContain("192.168.2.5");
    expect(tooltip).toContain("10.0.0.0/24");
    // The configuration lines it has always shown are still there.
    expect(tooltip).toContain("Subnet: 255.255.255.0");
    expect(tooltip).toContain("Gateway: 10.0.0.254");
  });

  it("changes nothing else about the branch — the warning is advisory only", () => {
    const bound = dhcpRows({ ...POOL, bindAddress: "192.168.2.5" });
    const clean = dhcpRows({ ...POOL, bindAddress: "10.0.0.5" });
    expect(bound.map((row) => row.id)).toEqual(clean.map((row) => row.id));
    expect(bound.find((row) => row.id === "networkServer:dhcp:lease")?.description).toBe(
      clean.find((row) => row.id === "networkServer:dhcp:lease")?.description
    );
  });
});

/**
 * REVIEW FINDING (P2) — an all-interfaces bind used to skip the comparison
 * altogether, so a pool no NIC on this machine can serve was the one broken
 * arrangement this row never mentioned. "Listening everywhere" is not
 * "reachable everywhere": with no address on the pool's wire, the DISCOVERs
 * never arrive.
 */
describe("DHCP Pool row — an all-interfaces bind with no NIC on the pool's subnet", () => {
  /** Nothing on 10.0.0.0/24 — the pool is unreachable however it is bound. */
  function noMatchingNic(): void {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")] });
  }

  it("marks the row", () => {
    noMatchingNic();
    expect(poolRow({ ...POOL }).description).toBe("10.0.0.10 → 10.0.0.99 · ⚠ no NIC is on this subnet");
    expect(poolRow({ ...POOL, bindAddress: "0.0.0.0" }).description).toContain("⚠ no NIC is on this subnet");
  });

  it("explains it in the tooltip without naming a bound address there is none of", () => {
    noMatchingNic();
    const tooltip = String(poolRow({ ...POOL }).tooltip);
    expect(tooltip).toContain("No interface on this machine is on this pool's subnet (10.0.0.0/24).");
    expect(tooltip).not.toContain("The service is bound to");
    // The configuration lines it has always shown are still there.
    expect(tooltip).toContain("Subnet: 255.255.255.0");
  });

  it("stays quiet with relay agents allowed, on the very same fixture", () => {
    noMatchingNic();
    expect(poolRow({ ...POOL, allowRelayAgents: true }).description).toBe("10.0.0.10 → 10.0.0.99");
  });

  it("stays quiet when the pool's own mask is unusable", () => {
    noMatchingNic();
    expect(poolRow({ ...POOL, subnet: "255.0.255.0" }).description).not.toContain("⚠");
  });

  it("changes nothing else about the branch — the warning is advisory only", () => {
    noMatchingNic();
    const warned = dhcpRows({ ...POOL });
    networkInterfaces.mockReturnValue({ eth0: [ipv4("192.168.2.5")], eth1: [ipv4("10.0.0.5")] });
    const clean = dhcpRows({ ...POOL });
    expect(warned.map((row) => row.id)).toEqual(clean.map((row) => row.id));
  });
});

/**
 * REVIEW FINDING — the row demanded that the bound NIC be on-link for the whole
 * ADVERTISED subnet, not for the range the pool really hands out. A pool
 * deliberately confined to part of its subnet is the arrangement that broke:
 * every address it offers is reachable, and the row warned about it anyway.
 *
 * These are the end-to-end half of the fix — the provider has to pass the
 * configured `rangeEnd` down for any of it to reach the sidebar — so each pair
 * moves the pool's range and nothing else.
 */
describe("DHCP Pool row — a range narrower than the subnet it advertises", () => {
  /** 10.0.0.128/25: the lower half of the advertised /24 is not on this link. */
  function halfSubnetNic(): void {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.254", "255.255.255.128")] });
  }

  it("stays quiet for a pool confined to the half the bound NIC is on", () => {
    halfSubnetNic();
    const row = poolRow({ ...POOL, rangeStart: "10.0.0.130", rangeEnd: "10.0.0.200", bindAddress: "10.0.0.254" });
    expect(row.description).toBe("10.0.0.130 → 10.0.0.200");
    expect(String(row.tooltip)).not.toContain("⚠");
  });

  it("stays quiet for an all-interfaces bind over the same pool", () => {
    halfSubnetNic();
    expect(poolRow({ ...POOL, rangeStart: "10.0.0.130", rangeEnd: "10.0.0.200" }).description).not.toContain("⚠");
  });

  it("still warns when the pool's START reaches into the half the NIC is not on", () => {
    halfSubnetNic();
    // One field apart from the fixture above.
    expect(
      poolRow({ ...POOL, rangeStart: "10.0.0.10", rangeEnd: "10.0.0.200", bindAddress: "10.0.0.254" }).description
    ).toContain("⚠ bound NIC is not on this subnet");
  });

  it("still warns when only the pool's END runs past the NIC's link", () => {
    // eth0 is 10.0.0.128/26 — 10.0.0.128 through 10.0.0.191 — and the pool
    // starts inside it either way, so the END is the only thing that moves.
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.130", "255.255.255.192")] });
    const shared = { ...POOL, rangeStart: "10.0.0.130", bindAddress: "10.0.0.130" };
    expect(poolRow({ ...shared, rangeEnd: "10.0.0.190" }).description).not.toContain("⚠");
    expect(poolRow({ ...shared, rangeEnd: "10.0.0.200" }).description).toContain("⚠");
  });
});

describe("DHCP Pool row — when no warning is due", () => {
  it("stays quiet for a NIC on the pool's subnet", () => {
    const row = poolRow({ ...POOL, bindAddress: "10.0.0.5" });
    expect(row.description).toBe("10.0.0.10 → 10.0.0.99");
    expect(String(row.tooltip)).not.toContain("⚠");
  });

  it("stays quiet for an all-interfaces bind that a NIC can actually serve", () => {
    // The shared fixture's eth1 is on 10.0.0.0/24, so every-NIC really does
    // include the pool's wire. The common, correct case.
    expect(poolRow({ ...POOL }).description).not.toContain("⚠");
    expect(poolRow({ ...POOL, bindAddress: "" }).description).not.toContain("⚠");
    expect(poolRow({ ...POOL, bindAddress: "0.0.0.0" }).description).not.toContain("⚠");
  });

  it("stays quiet with relay agents allowed, even though the bind IS off-subnet", () => {
    // Same fixture as the warning case above, one flag apart.
    expect(poolRow({ ...POOL, bindAddress: "192.168.2.5" }).description).toContain("⚠");
    expect(
      poolRow({ ...POOL, bindAddress: "192.168.2.5", allowRelayAgents: true }).description
    ).not.toContain("⚠");
  });

  it("stays quiet for an address no NIC on this machine holds", () => {
    // Off-subnet as well — but "this machine does not have that address" is
    // already reported where the address is shown.
    expect(poolRow({ ...POOL, bindAddress: "172.16.9.9" }).description).not.toContain("⚠");
  });

  it("stays quiet when the pool's own mask is unusable", () => {
    // Non-contiguous: whatever reports the bad mask reports it, and a second
    // message stacked on top would just be noise.
    expect(
      poolRow({ ...POOL, subnet: "255.0.255.0", bindAddress: "192.168.2.5" }).description
    ).not.toContain("⚠");
  });
});
