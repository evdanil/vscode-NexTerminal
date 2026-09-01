/**
 * @author kanekitakitos
 *
 * Unit tests for the DHCP editor's submit-time sanity checks
 * (`validateDhcpValues` in `src/commands/networkServerCommands.ts`).
 *
 * The function is private, so it is driven where it actually runs: the
 * `onSubmit` handed to `WebviewFormPanel.open`. That is also the behaviour worth
 * pinning — a rejection must THROW out of `onSubmit` (the panel turns that into
 * "Save failed" and keeps the user's input on screen) and must leave the
 * settings untouched, because a half-written pool is worse than an unsaved one.
 *
 * The mirror-image case gets equal weight: blanks are not invalid. A cleared
 * field means "drop the key and use the packaged default", so a form submitted
 * with most fields empty has to save cleanly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const configUpdates = vi.hoisted(() => [] as Array<{ section: string; key: string; value: unknown; target: unknown }>);
const formPanelOpens = vi.hoisted(
  () =>
    [] as Array<{
      id: string;
      definition: unknown;
      handlers: { onSubmit: (values: Record<string, unknown>) => Promise<void> };
    }>
);

vi.mock("vscode", () => ({
  Disposable: class {
    public constructor(private readonly fn: () => void) {}
    public dispose(): void {
      this.fn();
    }
  },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }
  },
  window: {
    showQuickPick: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn()
  },
  workspace: {
    getConfiguration: (section: string) => ({
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn(async (key: string, value: unknown, target: unknown) => {
        configUpdates.push({ section, key, value, target });
      })
    })
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 }
}));

vi.mock("../../../src/ui/webviewFormPanel", () => ({
  WebviewFormPanel: {
    open: (
      id: string,
      definition: unknown,
      handlers: { onSubmit: (values: Record<string, unknown>) => Promise<void> }
    ) => {
      formPanelOpens.push({ id, definition, handlers });
      return Promise.resolve(undefined);
    }
  }
}));

vi.mock("../../../src/ui/formDefinitions", () => ({
  networkServerFormDefinition: vi.fn((kind: string) => ({ title: `${kind} form`, fields: [] }))
}));

// The NIC list the form enumerates on open now reaches the submit check too, so
// it has to be this machine's *fixture* NICs rather than whatever the test
// runner's host happens to hold.
const networkInterfaces = vi.hoisted(() => vi.fn(() => ({}) as Record<string, unknown>));

vi.mock("node:os", () => ({ networkInterfaces }));

/** One external IPv4, shaped as `os.networkInterfaces()` reports it. */
function machineOn(address: string): void {
  networkInterfaces.mockReturnValue({
    eth0: [{ address, family: "IPv4", internal: false, netmask: "255.255.255.0" }]
  });
}

/**
 * Several external IPv4s with masks of their own, for the cases where the
 * NETWORK a NIC is on is the thing under test — `machineOn` hard-codes a /24,
 * which is exactly the mask that always has room.
 */
function machineNics(...entries: ReadonlyArray<{ address: string; netmask: string }>): void {
  networkInterfaces.mockReturnValue(
    Object.fromEntries(
      entries.map((entry, index) => [
        `eth${String(index)}`,
        [{ address: entry.address, family: "IPv4", internal: false, netmask: entry.netmask }]
      ])
    )
  );
}

import * as vscode from "vscode";
import { registerNetworkServerCommands } from "../../../src/commands/networkServerCommands";

const VALID = {
  rangeStart: "192.168.2.10",
  rangeEnd: "192.168.2.199",
  subnet: "255.255.255.0",
  gateway: "192.168.2.1",
  serverId: "192.168.2.1",
  broadcast: "192.168.2.255"
};

function fakeContext() {
  return {
    core: { getNetworkServerSession: vi.fn(() => undefined) },
    networkServerManager: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      readConfig: vi.fn(() => ({ rangeStart: "192.168.2.10" }))
    },
    networkServerOutputChannel: { show: vi.fn() }
  } as any;
}

async function submitDhcp(values: Record<string, unknown>): Promise<void> {
  registerNetworkServerCommands(fakeContext());
  await registeredCommands.get("nexus.networkServer.edit")!("dhcp");
  return formPanelOpens[0].handlers.onSubmit(values);
}

async function submitTftp(values: Record<string, unknown>): Promise<void> {
  registerNetworkServerCommands(fakeContext());
  await registeredCommands.get("nexus.networkServer.edit")!("tftp");
  return formPanelOpens[0].handlers.onSubmit(values);
}

beforeEach(() => {
  registeredCommands.clear();
  configUpdates.length = 0;
  formPanelOpens.length = 0;
  // No external IPv4 unless a test says otherwise, so the exclusion is inert.
  networkInterfaces.mockReturnValue({});
});

describe("DHCP submit validation — accepted input", () => {
  it("saves a fully specified pool", async () => {
    await expect(submitDhcp(VALID)).resolves.toBeUndefined();
    const byKey = (key: string) => configUpdates.find((entry) => entry.key === key)?.value;
    expect(byKey("rangeStart")).toBe("192.168.2.10");
    expect(byKey("subnet")).toBe("255.255.255.0");
    expect(byKey("broadcast")).toBe("192.168.2.255");
  });

  it("validates the form's start-plus-count pool rather than pairing the start with an unrelated default end", async () => {
    await expect(
      submitDhcp({ rangeStart: "10.0.0.10", poolCount: "10", subnet: "255.255.255.0" })
    ).resolves.toBeUndefined();
  });

  it("accepts a start equal to the end (a one-address pool)", async () => {
    await expect(submitDhcp({ rangeStart: "10.0.0.50", rangeEnd: "10.0.0.50" })).resolves.toBeUndefined();
  });

  it("rejects boundary octets when they describe a pool above the allocator cap", async () => {
    await expect(
      submitDhcp({ rangeStart: "0.0.0.0", rangeEnd: "255.255.255.255", subnet: "255.255.255.255" })
    ).rejects.toThrow("DHCP pool size must not exceed 65,536 addresses.");
  });

  it.each(["255.0.0.0", "255.255.128.0", "255.255.255.252", "0.0.0.0"])(
    "accepts the contiguous netmask %s",
    async (subnet) => {
      await expect(submitDhcp({ subnet })).resolves.toBeUndefined();
    }
  );
});

describe("DHCP submit validation — blanks are not invalid", () => {
  it("saves a form whose optional address fields are all empty, clearing their keys", async () => {
    await expect(
      submitDhcp({ rangeStart: "", rangeEnd: "   ", subnet: "", gateway: "   ", serverId: "", broadcast: "" })
    ).resolves.toBeUndefined();
    for (const key of ["rangeStart", "rangeEnd", "subnet", "gateway", "serverId", "broadcast"]) {
      expect(configUpdates.find((entry) => entry.key === key)?.value).toBeUndefined();
    }
  });

  it("rejects a lone endpoint when it becomes inverted against the packaged default", async () => {
    await expect(submitDhcp({ rangeStart: "192.168.2.200", rangeEnd: "" })).rejects.toThrow(
      "Pool Start (192.168.2.200) must not be higher than Pool End (192.168.2.199)."
    );
  });

  it("does not run the netmask check on a blank subnet", async () => {
    await expect(submitDhcp({ subnet: "  " })).resolves.toBeUndefined();
  });
});

describe("DHCP submit validation — rejected input", () => {
  it.each([
    ["rangeStart", "Pool Start"],
    ["rangeEnd", "Pool End"],
    ["subnet", "Subnet Mask"],
    ["gateway", "Gateway"],
    ["serverId", "Server Identifier"],
    ["broadcast", "Broadcast Address"]
  ])("rejects a malformed %s under its own field label", async (key, label) => {
    await expect(submitDhcp({ [key]: "999.1.1.1" })).rejects.toThrow(
      `${label} must be a dotted-quad IPv4 address (got "999.1.1.1").`
    );
  });

  it.each(["not-an-ip", "192.168.2", "192.168.2.1.5", "192.168.2.256", "1.2.3.-4", "192.168.2.01a", "::1"])(
    "rejects %s as a pool start",
    async (rangeStart) => {
      await expect(submitDhcp({ rangeStart })).rejects.toThrow(/dotted-quad IPv4 address/);
    }
  );

  it.each(["255.255.0.15", "255.0.255.0", "0.255.255.0", "255.255.255.253"])(
    "rejects the non-contiguous netmask %s",
    async (subnet) => {
      await expect(submitDhcp({ subnet })).rejects.toThrow(
        `Subnet Mask "${subnet}" is not a valid netmask — its set bits must be contiguous (e.g. 255.255.255.0).`
      );
    }
  );

  it("rejects a pool whose start is higher than its end", async () => {
    await expect(submitDhcp({ rangeStart: "192.168.2.200", rangeEnd: "192.168.2.100" })).rejects.toThrow(
      "Pool Start (192.168.2.200) must not be higher than Pool End (192.168.2.100)."
    );
  });

  it("orders by octet, not by string — .100 is below .99", async () => {
    await expect(submitDhcp({ rangeStart: "10.0.0.100", rangeEnd: "10.0.0.99" })).rejects.toThrow(
      /must not be higher than/
    );
    await expect(submitDhcp({ rangeStart: "10.0.0.99", rangeEnd: "10.0.0.100" })).resolves.toBeUndefined();
  });

  it("catches an inversion that only shows in a higher octet", async () => {
    await expect(submitDhcp({ rangeStart: "10.0.3.10", rangeEnd: "10.0.2.250" })).rejects.toThrow(
      /must not be higher than/
    );
  });

  it("reports the format problem before the ordering one", async () => {
    await expect(submitDhcp({ rangeStart: "10.0.0.999", rangeEnd: "10.0.0.1" })).rejects.toThrow(
      /dotted-quad IPv4 address/
    );
  });

  it("writes no setting at all when validation fails", async () => {
    await expect(submitDhcp({ ...VALID, subnet: "255.255.0.15" })).rejects.toThrow(/contiguous/);
    expect(configUpdates).toEqual([]);
  });

  it.each(["not-a-number", Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1.5, 0, -1, 65_537])(
    "rejects explicit invalid poolCount %s before writing settings",
    async (poolCount) => {
      await expect(submitDhcp({ poolCount })).rejects.toThrow(/Pool Count/);
      expect(configUpdates).toEqual([]);
    }
  );

  it("accepts the exact 65,536-address pool-count boundary", async () => {
    await expect(submitDhcp({ rangeStart: "10.0.0.0", subnet: "255.0.0.0", poolCount: 65_536 })).resolves.toBeUndefined();
  });

  it("rejects malformed DNS before writing any form settings through the shared parser", async () => {
    await expect(submitDhcp({ ...VALID, dns: "1.1.1.1, not-an-ip" })).rejects.toThrow(
      'DNS server must be a dotted-quad IPv4 address (got "not-an-ip").'
    );
    expect(configUpdates).toEqual([]);
  });

  it("rejects malformed static reservations before writing any form settings", async () => {
    await expect(submitDhcp({ ...VALID, static: "AA-BB-CC-DD-EE-FF=10.0.0.50\nbad-mac=10.0.0.51" })).rejects.toThrow(
      /Static reservation MAC addresses/
    );
    expect(configUpdates).toEqual([]);
  });

  it("never offers a restart for a rejected submission", async () => {
    registerNetworkServerCommands(fakeContext());
    await registeredCommands.get("nexus.networkServer.edit")!("dhcp");
    await expect(formPanelOpens[0].handlers.onSubmit({ gateway: "not-an-ip" })).rejects.toThrow();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });
});

/**
 * REVIEW FINDING (P2) — a typed network that leaves this machine no room must
 * fail the save, not pass it silently.
 *
 * The CIDR row's autofill derives with this machine's own addresses excluded,
 * so such a network fills nothing at all: the subnet, pool and gateway rows keep
 * whatever they held. The submit check used to ask only whether the NETWORK
 * described a pool — `10.0.0.0/30` does — so Save then wrote the OLD pool and
 * reported success, and the user's network vanished without a message anywhere.
 * The quick editor warns for exactly this case; the form has to as well.
 *
 * The old settings being written is the tell, which is why the fixture keeps a
 * complete 192.168.2.0/24 pool alongside the rejected 10.0.0.0/30: a bug that
 * "does nothing" here is a bug that persists a pool on a different network.
 */
describe("DHCP submit validation — a network this machine leaves no room in", () => {
  const CIDR_FULLY_TAKEN =
    "10.0.0.0/30 leaves no pool once this machine's own addresses on it are kept out — every address it could hand out is already taken here.";

  it("rejects the network instead of saving the pool the form still held", async () => {
    // A /30 has one poolable address (.1 — .2 is the gateway) and this machine
    // is on it, so the autofill filled nothing and these rows are the ones the
    // form opened with, on a different network entirely.
    machineOn("10.0.0.1");
    await expect(submitDhcp({ ...VALID, cidr: "10.0.0.0/30" })).rejects.toThrow(CIDR_FULLY_TAKEN);
    // Nothing at all reaches settings — not the stale 192.168.2.0/24 pool the
    // silent path used to write, not anything else on the form.
    expect(configUpdates).toEqual([]);
  });

  it("never offers a restart for it either", async () => {
    machineOn("10.0.0.1");
    await expect(submitDhcp({ ...VALID, cidr: "10.0.0.0/30" })).rejects.toThrow();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("saves the same network when this machine is not on its pool", async () => {
    // The gateway is not poolable, so holding it refuses nothing: same CIDR,
    // same form, and the write goes through.
    machineOn("10.0.0.2");
    await expect(submitDhcp({ ...VALID, cidr: "10.0.0.0/30" })).resolves.toBeUndefined();
    expect(configUpdates.find((entry) => entry.key === "rangeStart")?.value).toBe("192.168.2.10");
  });

  it("saves a network with room to spare once this machine is kept out", async () => {
    machineOn("192.168.2.10");
    await expect(submitDhcp({ ...VALID, cidr: "192.168.2.0/24" })).resolves.toBeUndefined();
    expect(configUpdates.find((entry) => entry.key === "subnet")?.value).toBe("255.255.255.0");
  });

  it("still reports the network's own problems ahead of this machine's occupancy", async () => {
    machineOn("10.0.0.1");
    await expect(submitDhcp({ ...VALID, cidr: "10.0.0.0/31" })).rejects.toThrow("RFC 3021");
    await expect(submitDhcp({ ...VALID, cidr: "10.0.0.0" })).rejects.toThrow("CIDR form");
  });

  it("leaves a blank CIDR row meaning 'leave the pool alone', whatever this machine holds", async () => {
    machineOn("10.0.0.1");
    await expect(submitDhcp({ ...VALID, cidr: "  " })).resolves.toBeUndefined();
  });
});

/**
 * REVIEW FINDING (expert review of the 2.8.211 follow-up) — the block above
 * closed this hole for the addresses this MACHINE holds, and the follow-up that
 * taught the CIDR fill to also keep a hand-set gateway or DNS server out of the
 * pool reopened it for those: the fill derived with them excluded, the submit
 * check did not, so a network they crowded out filled nothing and saved
 * cleanly — the same silent discard, reached from the other side.
 *
 * The machine holds nothing on 10.0.0.x in these fixtures, so only the
 * preserved gateway can refuse the network. That is what makes them fail
 * against a check that asks only about own addresses.
 */
describe("DHCP submit validation — a network the preserved settings leave no room in", () => {
  const CIDR_RESERVED_TAKEN =
    "10.0.0.0/30 leaves no pool once the gateway and DNS addresses you set by hand are kept out — every address it could hand out is already spoken for.";

  it("rejects the network instead of saving the pool the form still held", async () => {
    // .1 is the /30's only poolable address, and the gateway on the form is a
    // decision the fill preserves rather than one it would overwrite.
    await expect(submitDhcp({ ...VALID, gateway: "10.0.0.1", cidr: "10.0.0.0/30" })).rejects.toThrow(
      CIDR_RESERVED_TAKEN
    );
    expect(configUpdates).toEqual([]);
  });

  it("applies the same rule to a hand-set DNS server", async () => {
    await expect(submitDhcp({ ...VALID, dns: "10.0.0.1", cidr: "10.0.0.0/30" })).rejects.toThrow(
      CIDR_RESERVED_TAKEN
    );
  });

  it("saves the network when the gateway on it is one the fill would replace", async () => {
    // 192.168.2.254 is what the previous network derives, so it is a stale
    // suggestion, not a reservation — it is about to be overwritten and cannot
    // crowd anything out.
    await expect(
      submitDhcp({ ...VALID, gateway: "192.168.2.254", cidr: "10.0.0.0/30" })
    ).resolves.toBeUndefined();
  });

  it("saves a network with room to spare alongside the preserved gateway", async () => {
    await expect(submitDhcp({ ...VALID, gateway: "10.0.0.1", cidr: "10.0.0.0/24" })).resolves.toBeUndefined();
  });

  it("names this machine's own occupancy first when both would refuse it", async () => {
    // One message per cause, and the one the user cannot edit comes first.
    machineOn("10.0.0.1");
    await expect(submitDhcp({ ...VALID, gateway: "10.0.0.1", cidr: "10.0.0.0/30" })).rejects.toThrow(
      "this machine's own addresses"
    );
  });
});

/**
 * REVIEW FINDING (#111, still open after the 2.8.211 follow-up) — the two blocks
 * above close the silent-discard hole for the network TYPED into the CIDR row.
 * The Interface picker is the form's other way of naming a network and had the
 * same hole, one step earlier: picking a NIC derives that NIC's own CIDR and
 * moves the whole pool onto it, so a NIC whose network can host no pool fills
 * NOTHING — and the webview has already applied the selection to the DOM before
 * it posts. The bind address moves, every pool row keeps the previous network's
 * values, and Save used to persist the new bind beside the old, unrelated pool.
 *
 * The fixtures keep the complete 192.168.2.0/24 pool from `VALID` for the same
 * reason the CIDR blocks do: the bug does not "do nothing", it writes a pool on
 * a network no client of the new bind is on.
 */
describe("DHCP submit validation — a NIC whose own network leaves no room", () => {
  const NIC_FULLY_TAKEN =
    "The interface you picked (10.0.0.1) is on 10.0.0.0/30, which leaves no pool once this machine's own addresses on it are kept out — every address it could hand out is already taken here.";

  it("rejects the bind instead of saving the pool the form still held", async () => {
    // A /30 has one poolable address (.1 — .2 is the gateway) and the NIC being
    // bound to holds it, so the pick filled nothing and every pool row below is
    // still the 192.168.2.0/24 one the form opened with.
    machineNics({ address: "10.0.0.1", netmask: "255.255.255.252" });
    await expect(submitDhcp({ ...VALID, interface: "10.0.0.1" })).rejects.toThrow(NIC_FULLY_TAKEN);
    expect(configUpdates).toEqual([]);
  });

  it("never offers a restart for it either", async () => {
    machineNics({ address: "10.0.0.1", netmask: "255.255.255.252" });
    await expect(submitDhcp({ ...VALID, interface: "10.0.0.1" })).rejects.toThrow();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("saves the same bind when the NIC's own network has room to spare", async () => {
    // Same address, same form, a /24 instead of a /30: the pick derives a pool
    // fine, so nothing here is refused.
    machineNics({ address: "10.0.0.1", netmask: "255.255.255.0" });
    await expect(submitDhcp({ ...VALID, interface: "10.0.0.1" })).resolves.toBeUndefined();
    expect(configUpdates.find((entry) => entry.key === "interface")?.value).toBe("10.0.0.1");
  });

  it("refuses a NIC on a /31, which is CIDR but describes no pool at all", async () => {
    machineNics({ address: "10.0.0.1", netmask: "255.255.255.254" });
    await expect(submitDhcp({ ...VALID, interface: "10.0.0.1" })).rejects.toThrow(
      "The interface you picked (10.0.0.1) is on 10.0.0.0/31, which does not describe a usable DHCP subnet — a /31 or /32 NIC has no host range for a pool to hand out."
    );
  });

  it("says nothing about the all-interfaces bind, which names no one network", async () => {
    machineNics({ address: "10.0.0.1", netmask: "255.255.255.252" });
    await expect(submitDhcp({ ...VALID, interface: "" })).resolves.toBeUndefined();
    await expect(submitDhcp({ ...VALID, interface: "   " })).resolves.toBeUndefined();
    await expect(submitDhcp({ ...VALID, interface: "0.0.0.0" })).resolves.toBeUndefined();
  });

  it("says nothing about an address this machine does not hold", async () => {
    // A different failure mode with a different remedy — the shared parser
    // reports a malformed bind under its own field label, and an address that
    // is simply gone is not something a pool check can speak to. Guessing a
    // mask for it is the thing `dhcpInterfaceCidr` exists to refuse.
    machineNics({ address: "10.0.0.1", netmask: "255.255.255.252" });
    await expect(submitDhcp({ ...VALID, interface: "172.16.5.5" })).resolves.toBeUndefined();
    expect(configUpdates.find((entry) => entry.key === "interface")?.value).toBe("172.16.5.5");
  });

  it("refuses a NIC this machine still holds but cannot mask, unlike one it no longer holds", async () => {
    // The two failure modes `dhcpInterfaceCidr` collapses into one `undefined`
    // look identical from the outside — no CIDR comes back either way — but
    // they are not the same fact: an address gone from the machine altogether
    // is the case above, which the picker deliberately keeps selectable and
    // this check leaves alone. A NIC still live in that same list, reported
    // with no netmask (or an unusable one), is exactly the "bind moved, pool
    // didn't, nobody said anything" defect this whole check exists to close —
    // just for a NIC the platform failed to describe fully rather than one
    // gone missing. Omitting `netmask` entirely is how `os.networkInterfaces()`
    // reports this for real; `networkInterfaceBindOptions()` collapses a blank
    // string to the same `undefined`.
    networkInterfaces.mockReturnValue({
      eth0: [{ address: "10.0.0.1", family: "IPv4", internal: false }]
    });
    await expect(submitDhcp({ ...VALID, interface: "10.0.0.1" })).rejects.toThrow(
      "The interface you picked (10.0.0.1) does not report a usable subnet mask, so its network can't be confirmed — with no mask to derive one from, there is nothing here to check a pool against."
    );
    expect(configUpdates).toEqual([]);
  });

  it("leaves a relayed service alone, whatever its local bind is on", async () => {
    // The carve-out, and not merely a redundant one: with a relay agent in
    // front, the pool is on the CLIENT subnet and the bind is free to sit on a
    // /30 point-to-point uplink that could never host a pool of its own.
    machineNics({ address: "10.0.0.1", netmask: "255.255.255.252" });
    await expect(
      submitDhcp({ ...VALID, interface: "10.0.0.1", allowRelayAgents: true })
    ).resolves.toBeUndefined();
    expect(configUpdates.find((entry) => entry.key === "interface")?.value).toBe("10.0.0.1");
  });

  it("reports the typed CIDR row's own problem ahead of the NIC's", async () => {
    // The row the user just wrote out in full wins: complaining about the
    // network a NIC merely implies answers a question they did not ask.
    machineNics({ address: "10.0.0.1", netmask: "255.255.255.252" });
    await expect(submitDhcp({ ...VALID, interface: "10.0.0.1", cidr: "172.16.0.0/31" })).rejects.toThrow(
      "RFC 3021"
    );
  });
});

/**
 * The same hole reached from the other side, mirroring the CIDR row's own
 * preserved-settings block: the NIC pick derives with a hand-set gateway or DNS
 * server excluded too, so the submit check has to exclude the same set or a
 * network they crowd out fills nothing and saves cleanly.
 *
 * The NIC here is the /30's GATEWAY address, which is not poolable and so
 * refuses nothing on its own — only the preserved gateway can take the one
 * address left. That is what makes these fail against a check that asks about
 * own addresses alone.
 */
describe("DHCP submit validation — a NIC whose network the preserved settings leave no room in", () => {
  const NIC_RESERVED_TAKEN =
    "The interface you picked (10.0.0.2) is on 10.0.0.0/30, which leaves no pool once the gateway and DNS addresses you set by hand are kept out — every address it could hand out is already spoken for.";

  it("rejects the bind instead of saving the pool the form still held", async () => {
    machineNics({ address: "10.0.0.2", netmask: "255.255.255.252" });
    await expect(
      submitDhcp({ ...VALID, interface: "10.0.0.2", gateway: "10.0.0.1" })
    ).rejects.toThrow(NIC_RESERVED_TAKEN);
    expect(configUpdates).toEqual([]);
  });

  it("applies the same rule to a hand-set DNS server", async () => {
    machineNics({ address: "10.0.0.2", netmask: "255.255.255.252" });
    await expect(
      submitDhcp({ ...VALID, interface: "10.0.0.2", dns: "10.0.0.1" })
    ).rejects.toThrow(NIC_RESERVED_TAKEN);
  });

  it("saves the same bind when nothing preserved lands on the NIC's network", async () => {
    // VALID's gateway is preserved too — it is just on 192.168.2.0/24, so it
    // takes nothing away from 10.0.0.0/30 and the /30's own .1 stays poolable.
    machineNics({ address: "10.0.0.2", netmask: "255.255.255.252" });
    await expect(submitDhcp({ ...VALID, interface: "10.0.0.2" })).resolves.toBeUndefined();
    expect(configUpdates.find((entry) => entry.key === "interface")?.value).toBe("10.0.0.2");
  });

  it("names this machine's own occupancy first when both would refuse it", async () => {
    // One message per cause, and the one the user cannot edit comes first —
    // same order the CIDR row uses.
    machineNics({ address: "10.0.0.1", netmask: "255.255.255.252" });
    await expect(
      submitDhcp({ ...VALID, interface: "10.0.0.1", gateway: "10.0.0.1" })
    ).rejects.toThrow("this machine's own addresses");
  });
});

describe("DHCP submit validation — scope", () => {
  it("leaves the TFTP form unvalidated, since it has no address fields", async () => {
    await expect(submitTftp({ root: "/srv/tftp", port: "69" })).resolves.toBeUndefined();
    expect(configUpdates.find((entry) => entry.key === "root")?.value).toBe("/srv/tftp");
  });
});
