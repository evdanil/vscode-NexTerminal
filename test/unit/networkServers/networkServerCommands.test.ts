/**
 * @author kanekitakitos
 *
 * Unit tests for the Embedded Network Servers command layer
 * (`src/commands/networkServerCommands.ts`).
 *
 * Scope is argument plumbing and UI wiring — the manager, the webview form
 * panel and the settings API are all doubles, so nothing here starts a service
 * (that is `networkServerManager.test.ts`) or renders HTML:
 *  1. Kind resolution: a bare `"tftp"`, a tree item carrying `kind`, a tree
 *     item carrying `session.kind`, and the Command-Palette fallback to a
 *     quick pick (including the cancelled-pick path, which must issue nothing).
 *  2. Failure surfacing: a NetworkServerError is reported with its code
 *     appended, a plain Error without one, and neither is allowed to escape
 *     the command handler.
 *  3. `.edit`: opens the form for the resolved kind, writes every field to the
 *     Global configuration target, parses the `MAC=IP` textarea, and only
 *     offers a restart when the service is actually running.
 *  4. `.inspectLogs`: reveals the shared channel without stealing focus, and
 *     degrades to an information message when no channel is wired.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkServerError } from "../../../src/models/networkServer";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const configUpdates = vi.hoisted(() => [] as Array<{ section: string; key: string; value: unknown; target: unknown }>);
const formPanelOpens = vi.hoisted(
  () =>
    [] as Array<{
      id: string;
      definition: unknown;
      handlers: {
        onSubmit: (values: Record<string, unknown>) => Promise<void>;
        onAutofill?: (
          key: string,
          value: string,
          values?: Record<string, unknown>
        ) => Promise<Record<string, string> | undefined>;
      };
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
      // The DHCP editor seeds its auto-linkable fields from the raw settings
      // rather than from the resolved adapter config, so reads have to answer
      // here too — with the declared default, i.e. "nothing configured".
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
    open: (id: string, definition: unknown, handlers: (typeof formPanelOpens)[number]["handlers"]) => {
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

function fakeManager(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    readConfig: vi.fn((kind: string) => (kind === "tftp" ? { port: 69 } : { rangeStart: "172.28.1.10" })),
    ...overrides
  } as any;
}

function fakeContext(manager: any, extra: Record<string, unknown> = {}) {
  return {
    core: { getNetworkServerSession: vi.fn(() => undefined) },
    networkServerManager: manager,
    networkServerOutputChannel: { show: vi.fn() },
    ...extra
  } as any;
}

function register(ctx: any) {
  registerNetworkServerCommands(ctx);
  return (id: string) => registeredCommands.get(id)!;
}

beforeEach(() => {
  registeredCommands.clear();
  configUpdates.length = 0;
  formPanelOpens.length = 0;
  vi.mocked(vscode.window.showQuickPick).mockReset();
  vi.mocked(vscode.window.showErrorMessage).mockReset();
  vi.mocked(vscode.window.showInformationMessage).mockReset();
});

describe("registerNetworkServerCommands — registration", () => {
  // Six, not five: `quickAdjust` (the Quick Settings pick) is a later addition
  // that is contributed in package.json and implemented in
  // `networkServerQuickAdjust.ts`. It is still not a CRUD surface — there is no
  // add/remove here, because TFTP and DHCP are singletons, not a list the user
  // creates entries in. The profile and transfer commands are registered by
  // their own modules and so are deliberately absent from this assertion.
  it("registers exactly the six singleton-service commands and no CRUD surface", () => {
    const disposables = registerNetworkServerCommands(fakeContext(fakeManager()));
    expect(disposables).toHaveLength(6);
    expect([...registeredCommands.keys()].sort()).toEqual([
      "nexus.networkServer.edit",
      "nexus.networkServer.inspectLogs",
      "nexus.networkServer.quickAdjust",
      "nexus.networkServer.restart",
      "nexus.networkServer.start",
      "nexus.networkServer.stop"
    ]);
  });
});

describe("registerNetworkServerCommands — kind resolution", () => {
  it("accepts a bare kind string", async () => {
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.start")("tftp");
    expect(manager.start).toHaveBeenCalledWith("tftp");
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it("accepts a tree item carrying `kind`", async () => {
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.stop")({ kind: "dhcp" });
    expect(manager.stop).toHaveBeenCalledWith("dhcp");
  });

  it("accepts a tree item carrying a nested `session.kind`", async () => {
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.restart")({ session: { kind: "tftp" } });
    expect(manager.restart).toHaveBeenCalledWith("tftp");
  });

  it("falls back to a quick pick when invoked with no argument (Command Palette)", async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ serviceKind: "dhcp" } as never);
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.start")(undefined);
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ serviceKind: "tftp" }),
        expect.objectContaining({ serviceKind: "dhcp" })
      ]),
      { title: "Start Network Server" }
    );
    expect(manager.start).toHaveBeenCalledWith("dhcp");
  });

  it("does nothing when the quick pick is dismissed", async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined as never);
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.start")(undefined);
    expect(manager.start).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("ignores an unrelated argument object and falls through to the picker", async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined as never);
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.stop")({ kind: "ftp" });
    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(manager.stop).not.toHaveBeenCalled();
  });
});

describe("registerNetworkServerCommands — failure surfacing", () => {
  it("reports a NetworkServerError with its code appended and does not rethrow", async () => {
    const manager = fakeManager({
      start: vi.fn(async () => {
        throw new NetworkServerError("PrivilegedPortDenied", "TFTP could not bind its privileged port");
      })
    });
    const cmd = register(fakeContext(manager));
    await expect(cmd("nexus.networkServer.start")("tftp")).resolves.toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to start network server: TFTP could not bind its privileged port (PrivilegedPortDenied)"
    );
  });

  it("reports a plain Error without a code suffix", async () => {
    const manager = fakeManager({
      stop: vi.fn(async () => {
        throw new Error("pipe closed");
      })
    });
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.stop")("dhcp");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to stop network server: pipe closed");
  });

  it("reports a restart failure under its own prefix", async () => {
    const manager = fakeManager({
      restart: vi.fn(async () => {
        throw new Error("boom");
      })
    });
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.restart")("tftp");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to restart network server: boom");
  });
});

describe("registerNetworkServerCommands — edit", () => {
  it("opens a per-kind form seeded from the manager's current settings", async () => {
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.edit")("tftp");
    expect(manager.readConfig).toHaveBeenCalledWith("tftp");
    expect(formPanelOpens).toHaveLength(1);
    expect(formPanelOpens[0].id).toBe("network-server-edit-tftp");
    expect(formPanelOpens[0].definition).toMatchObject({ title: "tftp form" });
  });

  it("writes every TFTP field to the Global configuration target", async () => {
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.edit")("tftp");
    await formPanelOpens[0].handlers.onSubmit({
      root: "  /srv/tftp  ",
      port: "6900",
      allowWrite: "on",
      interface: "   "
    });

    expect(configUpdates.every((entry) => entry.section === "nexus.networkServers.tftp")).toBe(true);
    expect(configUpdates.every((entry) => entry.target === vscode.ConfigurationTarget.Global)).toBe(true);
    expect(configUpdates).toEqual([
      expect.objectContaining({ key: "root", value: "/srv/tftp" }),
      expect.objectContaining({ key: "port", value: 6900 }),
      expect.objectContaining({ key: "allowWrite", value: true }),
      // Blank clears the key so the packaged default applies again.
      expect.objectContaining({ key: "interface", value: undefined })
    ]);
  });

  it.each([
    ["a malformed interface", { interface: "not-an-ip" }, /Interface/],
    ["a fractional port", { port: "1.5" }, /Port/],
    ["an out-of-range port", { port: "65536" }, /Port/],
    ["an oversized root", { root: "x".repeat(4_097) }, /Root/],
  ])("writes no TFTP settings for %s", async (_label, values, error) => {
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.edit")("tftp");

    await expect(formPanelOpens[0].handlers.onSubmit(values)).rejects.toThrow(error);
    expect(configUpdates).toEqual([]);
  });

  it("parses the DHCP comma list and well-formed MAC=IP reservation textarea", async () => {
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.edit")("dhcp");
    await formPanelOpens[0].handlers.onSubmit({
      rangeStart: "172.28.1.10",
      rangeEnd: "172.28.1.20",
      dns: "1.1.1.1, 8.8.8.8 ,",
      leaseTimeSec: "3600",
      static: ["aa:bb:cc:dd:ee:ff=172.28.1.50", "# a comment", "11:22:33:44:55:66 = 172.28.1.52"].join("\n")
    });

    const byKey = (key: string) => configUpdates.find((entry) => entry.key === key)?.value;
    expect(byKey("dns")).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(byKey("leaseTimeSec")).toBe(3600);
    expect(byKey("static")).toEqual({
      "aa:bb:cc:dd:ee:ff": "172.28.1.50",
      "11:22:33:44:55:66": "172.28.1.52"
    });
    expect(byKey("subnet")).toBeUndefined();
  });

  it("never writes the CIDR row as a setting — it is an input shape, not a key", async () => {
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.edit")("dhcp");
    await formPanelOpens[0].handlers.onSubmit({ cidr: "10.0.0.0/24", rangeStart: "10.0.0.1", poolCount: "253" });

    expect(configUpdates.some((entry) => entry.key === "cidr")).toBe(false);
    // The settings it stands for are what get written.
    expect(configUpdates).toContainEqual(expect.objectContaining({ key: "rangeStart", value: "10.0.0.1" }));
    expect(configUpdates).toContainEqual(expect.objectContaining({ key: "rangeEnd", value: "10.0.0.253" }));
  });

  it("refuses to save a CIDR row that describes no pool, and writes nothing", async () => {
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.edit")("dhcp");

    // The row derived nothing when it was typed, so the rest of the pool still
    // describes the OLD network — every individual field is valid and only the
    // row that produced them is not. Saving anyway would store a configuration
    // the user believes they replaced.
    await expect(
      formPanelOpens[0].handlers.onSubmit({ cidr: "10.0.0.0/31", rangeStart: "192.168.2.10" })
    ).rejects.toThrow(/\/31 is a point-to-point range/);
    expect(configUpdates).toEqual([]);
  });

  it("wires an autofill handler for DHCP that derives the pool a network implies", async () => {
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.edit")("dhcp");

    const onAutofill = formPanelOpens[0].handlers.onAutofill;
    expect(onAutofill, "the DHCP form opened with no autofill handler").toBeDefined();
    const fills = await onAutofill!("cidr", "10.0.0.0/24", {
      rangeStart: "192.168.2.10",
      subnet: "255.255.255.0",
      gateway: "192.168.2.1"
    });
    expect(fills).toMatchObject({ subnet: "255.255.255.0", rangeStart: "10.0.0.1", poolCount: "253" });
    // The hand-set gateway is not in the answer, so the field keeps it.
    expect(fills).not.toHaveProperty("gateway");
    // Nothing is written by an autofill — it fills fields, and Save is still
    // what commits them.
    expect(configUpdates).toEqual([]);
  });

  it("wires no autofill handler for TFTP, which has no pool to derive", async () => {
    const manager = fakeManager();
    const cmd = register(fakeContext(manager));
    await cmd("nexus.networkServer.edit")("tftp");
    expect(formPanelOpens[0].handlers.onAutofill).toBeUndefined();
  });

  it("does not offer a restart when the service is not running", async () => {
    const manager = fakeManager();
    const ctx = fakeContext(manager);
    ctx.core.getNetworkServerSession = vi.fn(() => ({ kind: "tftp", status: "stopped" }));
    const cmd = register(ctx);
    await cmd("nexus.networkServer.edit")("tftp");
    await formPanelOpens[0].handlers.onSubmit({ root: "/srv/tftp" });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(manager.restart).not.toHaveBeenCalled();
  });

  it("offers a restart when the service is running and honours the user's choice", async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("Restart" as never);
    const manager = fakeManager();
    const ctx = fakeContext(manager);
    ctx.core.getNetworkServerSession = vi.fn(() => ({ kind: "tftp", status: "running" }));
    const cmd = register(ctx);
    await cmd("nexus.networkServer.edit")("tftp");
    await formPanelOpens[0].handlers.onSubmit({ root: "/srv/tftp" });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Restart TFTP to apply the new settings?",
      "Restart"
    );
    expect(manager.restart).toHaveBeenCalledWith("tftp");
  });

  it("leaves a running service alone when the restart prompt is dismissed", async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);
    const manager = fakeManager();
    const ctx = fakeContext(manager);
    ctx.core.getNetworkServerSession = vi.fn(() => ({ kind: "dhcp", status: "running" }));
    const cmd = register(ctx);
    await cmd("nexus.networkServer.edit")("dhcp");
    await formPanelOpens[0].handlers.onSubmit({ rangeStart: "172.28.1.10", poolCount: "190" });
    expect(manager.restart).not.toHaveBeenCalled();
  });

  it("surfaces a failure of the post-edit restart instead of leaving it silent", async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("Restart" as never);
    const manager = fakeManager({
      restart: vi.fn(async () => {
        throw new NetworkServerError("BindFailed", "port is already in use");
      })
    });
    const ctx = fakeContext(manager);
    ctx.core.getNetworkServerSession = vi.fn(() => ({ kind: "tftp", status: "running" }));
    const cmd = register(ctx);
    await cmd("nexus.networkServer.edit")("tftp");
    await formPanelOpens[0].handlers.onSubmit({ root: "/srv/tftp" });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to restart network server: port is already in use (BindFailed)"
    );
  });
});

describe("registerNetworkServerCommands — inspectLogs", () => {
  it("reveals the shared channel without stealing focus", async () => {
    const manager = fakeManager();
    const ctx = fakeContext(manager);
    const cmd = register(ctx);
    await cmd("nexus.networkServer.inspectLogs")();
    expect(ctx.networkServerOutputChannel.show).toHaveBeenCalledWith(true);
  });

  it("degrades to an information message when no channel is wired", async () => {
    const manager = fakeManager();
    const cmd = register(fakeContext(manager, { networkServerOutputChannel: undefined }));
    await cmd("nexus.networkServer.inspectLogs")();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Network server diagnostics are not available."
    );
  });
});
