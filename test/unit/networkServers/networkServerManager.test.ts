/**
 * @author kanekitakitos
 *
 * Unit tests for NetworkServerManager — the extension-host policy layer that
 * sits between VS Code and the daemon child process.
 *
 * Scope is that policy layer only. The daemon bridge (`NetworkServerDaemonHost`)
 * is replaced with a scripted double, so nothing here spawns a process or binds
 * a UDP port; the real stdin/stdout bridge is covered end-to-end by
 * `test/integration/networkServers/daemonBridge.test.ts`, and the engines
 * themselves by the tftp/dhcp suites. What is exercised here is what the
 * manager alone decides:
 *  - the Workspace Trust gate that must refuse before any RPC is issued;
 *  - settings → adapter-config resolution (blank strings collapsing to
 *    `undefined`, bounded numbers, malformed static-lease entries dropped);
 *  - start/stop/restart happy paths and their NexusCore state fan-out;
 *  - `toNetworkServerError`'s regex classification — each of the four codes is
 *    driven by a message that only that branch matches.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkServerError } from "../../../src/models/networkServer";

const mockConfig = vi.hoisted(() => new Map<string, unknown>());
const hostState = vi.hoisted(() => ({
  instance: undefined as any,
  startServer: undefined as any,
  stopServer: undefined as any,
  restartServer: undefined as any,
  configure: undefined as any,
  getServiceRuntime: undefined as any,
  isRunning: true,
  disposeCalls: 0,
  spawnConfigResolver: undefined as (() => unknown) | undefined
}));

vi.mock("vscode", () => ({
  workspace: {
    get isTrusted() {
      const value = mockConfig.get("isTrusted");
      return value === undefined ? true : value;
    },
    getConfiguration: (section: string) => ({
      get: (key: string, fallback?: unknown) => {
        const value = mockConfig.get(`${section}.${key}`);
        return value === undefined ? fallback : value;
      }
    })
  },
  window: {
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn(), show: vi.fn() }))
  }
}));

vi.mock("../../../src/services/networkServers/daemonHost", () => ({
  NetworkServerDaemonHost: class {
    public constructor(
      public readonly scriptPath: string,
      public readonly options: { resolveSpawnConfig?: () => unknown }
    ) {
      hostState.instance = this;
      hostState.spawnConfigResolver = options.resolveSpawnConfig;
    }
    public get isRunning(): boolean {
      return hostState.isRunning;
    }
    public onDidChangeStatus = vi.fn(() => vi.fn());
    public onDidUpdateRuntime = vi.fn(() => vi.fn());
    public onDidLog = vi.fn(() => vi.fn());
    public onDidExit = vi.fn(() => vi.fn());
    public startServer = (...args: unknown[]) => hostState.startServer(...args);
    public stopServer = (...args: unknown[]) => hostState.stopServer(...args);
    public restartServer = (...args: unknown[]) => hostState.restartServer(...args);
    public configure = (...args: unknown[]) => hostState.configure(...args);
    public getServiceRuntime = (...args: unknown[]) => hostState.getServiceRuntime(...args);
    public dispose = vi.fn(() => {
      hostState.disposeCalls += 1;
    });
  }
}));

import {
  NetworkServerManager,
  readDhcpConfig,
  readNetworkServerConfigs,
  readTftpConfig,
  resolveDhcpLeaseStorePath,
  resolveNetworkServerDaemonPath
} from "../../../src/services/networkServers/networkServerManager";

function fakeCore() {
  const sessions = new Map<string, unknown>();
  return {
    sessions,
    registerNetworkServerSession: vi.fn((session: { kind: string }) => {
      sessions.set(session.kind, session);
    }),
    getNetworkServerSession: vi.fn((kind: string) => sessions.get(kind)),
    updateNetworkServerSessionStatus: vi.fn(),
    setNetworkServerRuntimeSnapshot: vi.fn(),
    unregisterNetworkServerSession: vi.fn()
  } as any;
}

function fakeManager(core = fakeCore()) {
  return new NetworkServerManager({
    core,
    extensionPath: "/tmp/nexus-ext",
    outputChannel: { appendLine: vi.fn(), dispose: vi.fn(), show: vi.fn() } as any
  });
}

function tftpRuntime() {
  return {
    snapshot: { id: "tftp", name: "TFTP Server", port: 69, status: "running" },
    transfers: [],
    root: "/srv/tftp",
    allowWrite: false,
    boundPort: 1069
  };
}

beforeEach(() => {
  mockConfig.clear();
  hostState.isRunning = true;
  hostState.disposeCalls = 0;
  hostState.startServer = vi.fn(async () => undefined);
  hostState.stopServer = vi.fn(async () => undefined);
  hostState.restartServer = vi.fn(async () => undefined);
  hostState.configure = vi.fn(async () => []);
  hostState.getServiceRuntime = vi.fn(async () => tftpRuntime());
});

describe("NetworkServerManager — workspace trust gating", () => {
  it("assertTrusted() throws WorkspaceUntrusted when workspace.isTrusted === false", () => {
    mockConfig.set("isTrusted", false);
    const manager = fakeManager();
    expect(() => manager.assertTrusted()).toThrow(NetworkServerError);
    try {
      manager.assertTrusted();
    } catch (error) {
      expect((error as NetworkServerError).code).toBe("WorkspaceUntrusted");
    }
  });

  it("refuses start()/stop()/restart() in a restricted workspace before any RPC is issued", async () => {
    mockConfig.set("isTrusted", false);
    const manager = fakeManager();
    for (const call of [manager.start("tftp"), manager.stop("dhcp"), manager.restart("tftp")]) {
      await expect(call).rejects.toSatisfy((err: unknown) => {
        expect((err as NetworkServerError).code).toBe("WorkspaceUntrusted");
        return true;
      });
    }
    expect(hostState.startServer).not.toHaveBeenCalled();
    expect(hostState.stopServer).not.toHaveBeenCalled();
    expect(hostState.restartServer).not.toHaveBeenCalled();
  });

  it("allows start() through when the workspace is trusted", async () => {
    mockConfig.set("isTrusted", true);
    const manager = fakeManager();
    await expect(manager.start("tftp")).resolves.toBeUndefined();
    expect(hostState.startServer).toHaveBeenCalledTimes(1);
  });
});

describe("NetworkServerManager — settings resolution", () => {
  it("collapses blank string settings to undefined so adapter defaults survive", () => {
    mockConfig.set("nexus.networkServers.tftp.root", "   ");
    mockConfig.set("nexus.networkServers.tftp.interface", "");
    const config = readTftpConfig();
    expect(config.root).toBeUndefined();
    expect(config.interface).toBeUndefined();
  });

  it("reads and trims configured TFTP values, clamping the port into range", () => {
    mockConfig.set("nexus.networkServers.tftp.root", "  /srv/tftp  ");
    mockConfig.set("nexus.networkServers.tftp.port", 6900);
    mockConfig.set("nexus.networkServers.tftp.allowWrite", true);
    mockConfig.set("nexus.networkServers.tftp.interface", "192.168.2.1");
    const config = readTftpConfig();
    expect(config.root).toBe("/srv/tftp");
    expect(config.port).toBe(6900);
    expect(config.allowWrite).toBe(true);
    expect(config.interface).toBe("192.168.2.1");
  });

  it("falls back to the default port when the configured value is not a finite number", () => {
    mockConfig.set("nexus.networkServers.tftp.port", "not-a-number");
    expect(readTftpConfig().port).toBe(69);
    mockConfig.set("nexus.networkServers.tftp.port", Number.NaN);
    expect(readTftpConfig().port).toBe(69);
  });

  it("drops blank DNS entries and reports undefined for an all-blank array", () => {
    mockConfig.set("nexus.networkServers.dhcp.dns", ["1.1.1.1", "  ", "", "8.8.8.8"]);
    expect(readDhcpConfig().dns).toEqual(["1.1.1.1", "8.8.8.8"]);
    mockConfig.set("nexus.networkServers.dhcp.dns", ["   ", ""]);
    expect(readDhcpConfig().dns).toBeUndefined();
  });

  it("keeps well-formed static lease entries and skips malformed ones", () => {
    mockConfig.set("nexus.networkServers.dhcp.static", {
      "aa:bb:cc:dd:ee:ff": "172.28.1.50",
      "  11:22:33:44:55:66  ": "  172.28.1.51  ",
      "bad:entry": 42,
      "": "172.28.1.52",
      "cc:dd:ee:ff:00:11": "   "
    });
    expect(readDhcpConfig().static).toEqual({
      "aa:bb:cc:dd:ee:ff": "172.28.1.50",
      "11:22:33:44:55:66": "172.28.1.51"
    });
  });

  it("clamps leaseTimeSec into the [60s, 7d] band", () => {
    mockConfig.set("nexus.networkServers.dhcp.leaseTimeSec", 5);
    expect(readDhcpConfig().leaseTimeSec).toBe(60);
    mockConfig.set("nexus.networkServers.dhcp.leaseTimeSec", 99_999_999);
    expect(readDhcpConfig().leaseTimeSec).toBe(604_800);
  });

  it("maps the dhcp `interface` setting onto the engine's bindAddress field", () => {
    mockConfig.set("nexus.networkServers.dhcp.interface", "172.28.1.1");
    expect(readDhcpConfig().bindAddress).toBe("172.28.1.1");
  });

  it("keeps well-formed option 43 sub-options and skips malformed ones", () => {
    mockConfig.set("nexus.networkServers.dhcp.vendorSpecificOptions", [
      { subOption: 1, value: "192.168.2.5" },
      { subOption: 241, value: "0x0A0B" },
      { subOption: 0, value: "pad-is-reserved" },
      { subOption: 255, value: "end-is-reserved" },
      { subOption: 2.5, value: "not-an-integer" },
      { subOption: "3", value: "code-must-be-a-number" },
      { subOption: 4, value: 42 },
      { subOption: 5, value: "" },
      "not-an-object"
    ]);
    expect(readDhcpConfig().vendorSpecificOptions).toEqual([
      { subOption: 1, value: "192.168.2.5" },
      { subOption: 241, value: "0x0A0B" }
    ]);
    mockConfig.set("nexus.networkServers.dhcp.vendorSpecificOptions", []);
    expect(readDhcpConfig().vendorSpecificOptions).toBeUndefined();
  });

  it("auto-links options 66 and 150 to the TFTP interface when neither is set", () => {
    mockConfig.set("nexus.networkServers.tftp.interface", "172.28.1.1");
    const config = readDhcpConfig();
    expect(config.nextServer).toBe("172.28.1.1");
    expect(config.tftpServerAddresses).toEqual(["172.28.1.1"]);
  });

  it("leaves the boot server unset when TFTP binds every interface", () => {
    mockConfig.set("nexus.networkServers.tftp.interface", "0.0.0.0");
    expect(readDhcpConfig().nextServer).toBeUndefined();
    mockConfig.set("nexus.networkServers.tftp.interface", "");
    expect(readDhcpConfig().nextServer).toBeUndefined();
    expect(readDhcpConfig().tftpServerAddresses).toBeUndefined();
  });

  it("never overrides an explicit boot server, and suppresses the link on either key", () => {
    mockConfig.set("nexus.networkServers.tftp.interface", "172.28.1.1");
    mockConfig.set("nexus.networkServers.dhcp.nextServer", "10.0.0.9");
    // The explicit 66 must also stop 150 being auto-filled with a *different*
    // address — two boot servers is worse than one.
    expect(readDhcpConfig()).toMatchObject({ nextServer: "10.0.0.9", tftpServerAddresses: undefined });

    mockConfig.set("nexus.networkServers.dhcp.nextServer", "");
    mockConfig.set("nexus.networkServers.dhcp.tftpServerAddresses", ["10.0.0.9"]);
    expect(readDhcpConfig()).toMatchObject({ nextServer: undefined, tftpServerAddresses: ["10.0.0.9"] });
  });

  it("does not auto-link when autoLinkTftp is disabled", () => {
    mockConfig.set("nexus.networkServers.tftp.interface", "172.28.1.1");
    mockConfig.set("nexus.networkServers.dhcp.autoLinkTftp", false);
    expect(readDhcpConfig().nextServer).toBeUndefined();
    expect(readDhcpConfig().tftpServerAddresses).toBeUndefined();
  });

  it("reads the remaining boot options verbatim", () => {
    mockConfig.set("nexus.networkServers.dhcp.bootFileName", "  ios-image.bin  ");
    mockConfig.set("nexus.networkServers.dhcp.vendorClassId", "ArubaInstantAP");
    const config = readDhcpConfig();
    expect(config.bootFileName).toBe("ios-image.bin");
    expect(config.vendorClassId).toBe("ArubaInstantAP");
  });

  it("readNetworkServerConfigs() bundles both services for the spawn seed", () => {
    mockConfig.set("nexus.networkServers.tftp.port", 6900);
    mockConfig.set("nexus.networkServers.dhcp.rangeStart", "172.28.1.10");
    const configs = readNetworkServerConfigs();
    expect(configs.tftp?.port).toBe(6900);
    expect(configs.dhcp?.rangeStart).toBe("172.28.1.10");
  });

  it("points DHCP at a lease store under global storage, so leases outlive a daemon restart", () => {
    // The daemon has no `vscode` module and cannot resolve this itself; if the
    // host stops threading it through, persistence silently turns off.
    const config = readDhcpConfig("/global-storage");
    expect(config.leaseStorePath).toBe(resolveDhcpLeaseStorePath("/global-storage"));
    expect(resolveDhcpLeaseStorePath("/global-storage")).toMatch(
      /networkServers[\\/]dhcp-leases\.json$/
    );
    expect(readNetworkServerConfigs("/global-storage").dhcp?.leaseStorePath).toBe(config.leaseStorePath);
  });

  it("leaves the lease store unset when there is nowhere to write", () => {
    expect(readDhcpConfig().leaseStorePath).toBeUndefined();
  });

  it("resolves the daemon bundle beneath the extension path, not __dirname", () => {
    expect(resolveNetworkServerDaemonPath("/ext")).toMatch(
      /dist[\\/]services[\\/]networkServers[\\/]networkServerDaemon\.js$/
    );
  });

  it("hands the daemon host a spawn-config resolver rather than a frozen snapshot", () => {
    mockConfig.set("nexus.networkServers.tftp.port", 6900);
    fakeManager();
    const resolver = hostState.spawnConfigResolver!;
    expect(resolver).toBeTypeOf("function");
    expect((resolver() as { tftp?: { port?: number } }).tftp?.port).toBe(6900);
    // Same resolver, later settings — proves the value is read on demand.
    mockConfig.set("nexus.networkServers.tftp.port", 7000);
    expect((resolver() as { tftp?: { port?: number } }).tftp?.port).toBe(7000);
  });
});

describe("NetworkServerManager — lifecycle happy paths", () => {
  it("start() forwards current settings and mirrors runtime into NexusCore", async () => {
    mockConfig.set("nexus.networkServers.tftp.port", 6900);
    mockConfig.set("nexus.networkServers.tftp.allowWrite", true);
    const core = fakeCore();
    const manager = fakeManager(core);

    await manager.start("tftp");

    expect(hostState.startServer).toHaveBeenCalledWith("tftp", expect.objectContaining({ port: 6900, allowWrite: true }));
    expect(core.registerNetworkServerSession).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tftp", status: "stopped" })
    );
    expect(core.updateNetworkServerSessionStatus).toHaveBeenCalledWith("tftp", "starting");
    expect(core.setNetworkServerRuntimeSnapshot).toHaveBeenCalledWith(
      "tftp",
      expect.objectContaining({ root: "/srv/tftp", allowWrite: false, transfers: [] }),
      1069
    );
    expect(core.updateNetworkServerSessionStatus).toHaveBeenCalledWith(
      "tftp",
      "running",
      expect.objectContaining({ boundPort: 1069 })
    );
  });

  it("stop() clears the bound port once the daemon acknowledges", async () => {
    const core = fakeCore();
    const manager = fakeManager(core);
    await manager.stop("dhcp");
    expect(hostState.stopServer).toHaveBeenCalledWith("dhcp");
    expect(core.updateNetworkServerSessionStatus).toHaveBeenCalledWith("dhcp", "stopping");
    expect(core.updateNetworkServerSessionStatus).toHaveBeenCalledWith("dhcp", "stopped", { boundPort: null });
  });

  it("restart() re-reads settings so an edit made while running takes effect", async () => {
    mockConfig.set("nexus.networkServers.tftp.port", 6900);
    const manager = fakeManager();
    await manager.start("tftp");
    mockConfig.set("nexus.networkServers.tftp.port", 7100);
    await manager.restart("tftp");
    expect(hostState.restartServer).toHaveBeenCalledWith("tftp", expect.objectContaining({ port: 7100 }));
  });

  it("syncConfiguration() pushes both services and is a no-op while the daemon is down", async () => {
    const manager = fakeManager();
    await manager.syncConfiguration();
    expect(hostState.configure).toHaveBeenCalledTimes(1);

    hostState.isRunning = false;
    await manager.syncConfiguration();
    expect(hostState.configure).toHaveBeenCalledTimes(1);
  });

  it("syncConfiguration() swallows a daemon failure instead of propagating it", async () => {
    hostState.configure = vi.fn(async () => {
      throw new Error("pipe closed");
    });
    const manager = fakeManager();
    await expect(manager.syncConfiguration()).resolves.toBeUndefined();
  });

  it("refreshRuntime() tolerates an RPC failure without touching core state", async () => {
    hostState.getServiceRuntime = vi.fn(async () => {
      throw new Error("RPC timed out");
    });
    const core = fakeCore();
    const manager = fakeManager(core);
    await expect(manager.refreshRuntime("tftp")).resolves.toBeUndefined();
    expect(core.setNetworkServerRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it("readConfig() returns the TFTP shape for tftp and the DHCP shape for dhcp", () => {
    mockConfig.set("nexus.networkServers.tftp.root", "/srv/tftp");
    mockConfig.set("nexus.networkServers.dhcp.rangeStart", "172.28.1.10");
    const manager = fakeManager();
    expect(manager.readConfig("tftp")).toMatchObject({ root: "/srv/tftp" });
    expect(manager.readConfig("dhcp")).toMatchObject({ rangeStart: "172.28.1.10" });
  });

  it("dispose() tears the daemon down, unregisters both services, and is idempotent", () => {
    const core = fakeCore();
    const manager = fakeManager(core);
    manager.dispose();
    expect(hostState.disposeCalls).toBe(1);
    expect(core.unregisterNetworkServerSession).toHaveBeenCalledWith("tftp");
    expect(core.unregisterNetworkServerSession).toHaveBeenCalledWith("dhcp");
    expect(() => manager.dispose()).not.toThrow();
    expect(hostState.disposeCalls).toBe(1);
  });
});

describe("NetworkServerManager — toNetworkServerError classification", () => {
  async function startFailingWith(message: string): Promise<NetworkServerError> {
    hostState.startServer = vi.fn(async () => {
      throw new Error(message);
    });
    const manager = fakeManager();
    try {
      await manager.start("tftp");
    } catch (error) {
      return error as NetworkServerError;
    }
    throw new Error("start() unexpectedly resolved");
  }

  it("classifies a denied privileged port as PrivilegedPortDenied", async () => {
    const error = await startFailingWith("bind EACCES 0.0.0.0:69");
    expect(error).toBeInstanceOf(NetworkServerError);
    expect(error.code).toBe("PrivilegedPortDenied");
    expect(error.message).toContain("TFTP");
  });

  it("classifies an occupied port as BindFailed", async () => {
    const error = await startFailingWith("bind EADDRINUSE 0.0.0.0:69");
    expect(error.code).toBe("BindFailed");
  });

  it("classifies a daemon that never signalled ready as DaemonNotReady", async () => {
    const error = await startFailingWith("Network servers daemon did not report ready within 10s");
    expect(error.code).toBe("DaemonNotReady");
  });

  it("classifies a missing daemon bundle as DaemonSpawnFailed", async () => {
    const error = await startFailingWith("Network servers daemon script not found: /ext/dist/.../networkServerDaemon.js");
    expect(error.code).toBe("DaemonSpawnFailed");
  });

  it("falls back to BindFailed for an unrecognised failure", async () => {
    const error = await startFailingWith("something else entirely went wrong");
    expect(error.code).toBe("BindFailed");
  });

  it("passes an already-typed NetworkServerError through unchanged", async () => {
    const original = new NetworkServerError("InvalidConfiguration", "range is inverted");
    hostState.startServer = vi.fn(async () => {
      throw original;
    });
    const manager = fakeManager();
    await expect(manager.start("tftp")).rejects.toBe(original);
  });

  it("marks the session as errored before rethrowing", async () => {
    hostState.startServer = vi.fn(async () => {
      throw new Error("bind EADDRINUSE 0.0.0.0:69");
    });
    const core = fakeCore();
    const manager = fakeManager(core);
    await expect(manager.start("tftp")).rejects.toThrow();
    expect(core.updateNetworkServerSessionStatus).toHaveBeenCalledWith(
      "tftp",
      "error",
      expect.objectContaining({ errorMessage: expect.stringContaining("EADDRINUSE") })
    );
  });
});
