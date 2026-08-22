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

describe("DHCP submit validation — scope", () => {
  it("leaves the TFTP form unvalidated, since it has no address fields", async () => {
    await expect(submitTftp({ root: "/srv/tftp", port: "69" })).resolves.toBeUndefined();
    expect(configUpdates.find((entry) => entry.key === "root")?.value).toBe("/srv/tftp");
  });
});
