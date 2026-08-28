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
    showInformationMessage: vi.fn()
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
    expect(written("rangeEnd")).toBe("192.168.2.253");
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
