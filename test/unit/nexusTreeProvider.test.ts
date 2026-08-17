import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { FolderTreeItem, LocalShellProfileTreeItem, LocalShellSessionTreeItem, NexusTreeProvider, SerialProfileTreeItem, SerialSessionTreeItem, ServerTreeItem, SessionTreeItem } from "../../src/ui/nexusTreeProvider";
import { TUNNEL_DRAG_MIME } from "../../src/ui/dndMimeTypes";
import type { LocalShellProfile, SerialProfile, ServerConfig, TunnelProfile } from "../../src/models/config";

vi.mock("vscode", () => ({
  TreeItem: class {
    public id?: string;
    public tooltip?: string;
    public description?: string;
    public contextValue?: string;
    public iconPath?: unknown;
    public constructor(
      public readonly label: string,
      public readonly collapsibleState?: number
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    public constructor(
      public readonly id: string,
      public readonly color?: unknown
    ) {}
  },
  ThemeColor: class {
    public constructor(public readonly id: string) {}
  },
  EventEmitter: class {
    private listeners: Array<(value: unknown) => void> = [];
    public readonly event = (listener: (value: unknown) => void) => {
      this.listeners.push(listener);
    };
    public fire(value: unknown): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }
  },
  DataTransferItem: class {
    public constructor(private readonly value: string) {}
    public async asString(): Promise<string> {
      return this.value;
    }
  },
  Uri: {
    from: (components: { scheme: string; authority?: string; path?: string }) => ({
      scheme: components.scheme,
      authority: components.authority ?? "",
      path: components.path ?? "",
      toString: () => `${components.scheme}://${components.authority ?? ""}${components.path ?? ""}`
    })
  },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: () => undefined }))
  }
}));

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Server 1",
    host: "example.com",
    port: 22,
    username: "dev",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

function makeTunnel(overrides: Partial<TunnelProfile> = {}): TunnelProfile {
  return {
    id: "t-1",
    name: "Tunnel 1",
    localPort: 8080,
    remoteIP: "127.0.0.1",
    remotePort: 80,
    autoStart: false,
    ...overrides
  };
}

function makeTransfer(items: Record<string, string>) {
  return {
    get: (mime: string) => {
      const value = items[mime];
      if (value === undefined) {
        return undefined;
      }
      return {
        asString: async () => value
      };
    }
  };
}

describe("NexusTreeProvider tunnel DnD extraction", () => {
  const onTunnelDropped = vi.fn(async () => {});
  const onItemGroupChanged = vi.fn(async () => {});
  const onFolderMoved = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts JSON payload and starts tunnel on target server", async () => {
    const provider = new NexusTreeProvider({
      onTunnelDropped,
      onItemGroupChanged,
      onFolderMoved
    });
    provider.setSnapshot({
      servers: [makeServer()],
      tunnels: [makeTunnel({ id: "t-1" })],
      serialProfiles: [],
      activeSessions: [],
      activeSerialSessions: [],
      activeTunnels: [],
      remoteTunnels: [],
      explicitGroups: [],
      authProfiles: [],
      activitySessionIds: new Set(),
      focusedSessionId: undefined
    });

    const target = new ServerTreeItem(makeServer(), false);
    const payload = JSON.stringify({ type: "tunnelProfile", id: "t-1" });
    await provider.handleDrop(target, makeTransfer({ [TUNNEL_DRAG_MIME]: payload }) as any);

    expect(onTunnelDropped).toHaveBeenCalledTimes(1);
    expect(onTunnelDropped).toHaveBeenCalledWith("srv-1", "t-1");
  });

  it("falls back to raw text/plain tunnel id", async () => {
    const provider = new NexusTreeProvider({
      onTunnelDropped,
      onItemGroupChanged,
      onFolderMoved
    });
    provider.setSnapshot({
      servers: [makeServer()],
      tunnels: [makeTunnel({ id: "t-raw" })],
      serialProfiles: [],
      activeSessions: [],
      activeSerialSessions: [],
      activeTunnels: [],
      remoteTunnels: [],
      explicitGroups: [],
      authProfiles: [],
      activitySessionIds: new Set(),
      focusedSessionId: undefined
    });

    const target = new ServerTreeItem(makeServer(), false);
    await provider.handleDrop(target, makeTransfer({ "text/plain": "t-raw" }) as any);

    expect(onTunnelDropped).toHaveBeenCalledTimes(1);
    expect(onTunnelDropped).toHaveBeenCalledWith("srv-1", "t-raw");
  });

  it("ignores unknown raw text/plain id", async () => {
    const provider = new NexusTreeProvider({
      onTunnelDropped,
      onItemGroupChanged,
      onFolderMoved
    });
    provider.setSnapshot({
      servers: [makeServer()],
      tunnels: [makeTunnel({ id: "known" })],
      serialProfiles: [],
      activeSessions: [],
      activeSerialSessions: [],
      activeTunnels: [],
      remoteTunnels: [],
      explicitGroups: [],
      authProfiles: [],
      activitySessionIds: new Set(),
      focusedSessionId: undefined
    });

    const target = new ServerTreeItem(makeServer(), false);
    await provider.handleDrop(target, makeTransfer({ "text/plain": "unknown" }) as any);

    expect(onTunnelDropped).not.toHaveBeenCalled();
  });
});

describe("NexusTreeProvider folder collapse state", () => {
  const callbacks = {
    onTunnelDropped: vi.fn(async () => {}),
    onItemGroupChanged: vi.fn(async () => {}),
    onFolderMoved: vi.fn(async () => {})
  };

  function makeProvider(): NexusTreeProvider {
    const provider = new NexusTreeProvider(callbacks);
    provider.setSnapshot({
      servers: [
        makeServer({ id: "s1", name: "A", group: "Production" }),
        makeServer({ id: "s2", name: "B", group: "Staging" })
      ],
      tunnels: [],
      serialProfiles: [],
      activeSessions: [],
      activeSerialSessions: [],
      activeTunnels: [],
      remoteTunnels: [],
      explicitGroups: [],
      authProfiles: [],
      activitySessionIds: new Set(),
      focusedSessionId: undefined
    });
    return provider;
  }

  it("creates FolderTreeItem with Expanded state by default", () => {
    const provider = makeProvider();
    const children = provider.getChildren(undefined) as FolderTreeItem[];
    const folder = children.find((c) => c instanceof FolderTreeItem);
    expect(folder).toBeDefined();
    expect(folder!.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
  });

  it("creates FolderTreeItem with Collapsed state after collapseFolder", () => {
    const provider = makeProvider();
    provider.collapseFolder("Production");
    const children = provider.getChildren(undefined) as FolderTreeItem[];
    const prod = children.find((c) => c instanceof FolderTreeItem && c.folderPath === "Production");
    const staging = children.find((c) => c instanceof FolderTreeItem && c.folderPath === "Staging");
    expect(prod!.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect(staging!.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
  });

  it("expandFolder restores Expanded state", () => {
    const provider = makeProvider();
    provider.collapseFolder("Production");
    provider.expandFolder("Production");
    const children = provider.getChildren(undefined) as FolderTreeItem[];
    const prod = children.find((c) => c instanceof FolderTreeItem && c.folderPath === "Production");
    expect(prod!.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
  });

  it("getCollapsedFolders returns current collapsed paths", () => {
    const provider = makeProvider();
    expect(provider.getCollapsedFolders()).toEqual([]);
    provider.collapseFolder("Production");
    provider.collapseFolder("Staging");
    expect(provider.getCollapsedFolders().sort()).toEqual(["Production", "Staging"]);
  });

  it("loadCollapsedFolders restores collapsed state", () => {
    const provider = makeProvider();
    provider.loadCollapsedFolders(["Production"]);
    const children = provider.getChildren(undefined) as FolderTreeItem[];
    const prod = children.find((c) => c instanceof FolderTreeItem && c.folderPath === "Production");
    const staging = children.find((c) => c instanceof FolderTreeItem && c.folderPath === "Staging");
    expect(prod!.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect(staging!.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    expect(provider.getCollapsedFolders()).toEqual(["Production"]);
  });

  it("loadCollapsedFolders replaces previous state", () => {
    const provider = makeProvider();
    provider.collapseFolder("Production");
    provider.loadCollapsedFolders(["Staging"]);
    expect(provider.getCollapsedFolders()).toEqual(["Staging"]);
  });
});

describe("NexusTreeProvider folder contexts and filtering", () => {
  const callbacks = {
    onTunnelDropped: vi.fn(async () => {}),
    onItemGroupChanged: vi.fn(async () => {}),
    onFolderMoved: vi.fn(async () => {})
  };

  it("marks only direct-server folders as folderWithServers", () => {
    const provider = new NexusTreeProvider(callbacks);
    provider.setSnapshot({
      servers: [makeServer({ id: "s1", group: "Parent/Child" })],
      tunnels: [],
      serialProfiles: [],
      activeSessions: [],
      activeSerialSessions: [],
      activeTunnels: [],
      remoteTunnels: [],
      explicitGroups: [],
      authProfiles: [],
      activitySessionIds: new Set(),
      focusedSessionId: undefined
    });

    const rootChildren = provider.getChildren(undefined) as FolderTreeItem[];
    const parent = rootChildren.find((c) => c instanceof FolderTreeItem && c.folderPath === "Parent");
    expect(parent).toBeDefined();
    expect(parent!.contextValue).toBe("nexus.folder");

    const childChildren = provider.getChildren(parent!) as FolderTreeItem[];
    const child = childChildren.find((c) => c instanceof FolderTreeItem && c.folderPath === "Parent/Child");
    expect(child).toBeDefined();
    expect(child!.contextValue).toBe("nexus.folderWithServers");
  });

  it("keeps serial-only folders as nexus.folder", () => {
    const provider = new NexusTreeProvider(callbacks);
    provider.setSnapshot({
      servers: [],
      tunnels: [],
      serialProfiles: [{
        id: "sp1",
        name: "UART 1",
        group: "Lab",
        path: "COM4",
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        rtscts: false
      }],
      activeSessions: [],
      activeSerialSessions: [],
      activeTunnels: [],
      remoteTunnels: [],
      explicitGroups: [],
      authProfiles: [],
      activitySessionIds: new Set(),
      focusedSessionId: undefined
    });

    const rootChildren = provider.getChildren(undefined) as FolderTreeItem[];
    const folder = rootChildren.find((c) => c instanceof FolderTreeItem && c.folderPath === "Lab");
    expect(folder).toBeDefined();
    expect(folder!.contextValue).toBe("nexus.folder");
  });

  it("places local shell profiles in folders and filters by local shell name", () => {
    const provider = new NexusTreeProvider(callbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      localShellProfiles: [
        makeLocalShell({ id: "local-prod", name: "Prod Local", group: "Lab" }),
        makeLocalShell({ id: "local-dev", name: "Dev Local", group: "Lab" })
      ]
    });

    provider.setFilter("prod");

    const rootChildren = provider.getChildren(undefined) as FolderTreeItem[];
    const folder = rootChildren.find((c) => c instanceof FolderTreeItem && c.folderPath === "Lab");
    expect(folder).toBeDefined();
    const folderChildren = provider.getChildren(folder!) as LocalShellProfileTreeItem[];
    expect(folderChildren.filter((c) => c instanceof LocalShellProfileTreeItem).map((item) => item.profile.id)).toEqual(["local-prod"]);
  });

  it("filters folder hierarchy by matching server name or host", () => {
    const provider = new NexusTreeProvider(callbacks);
    provider.setSnapshot({
      servers: [
        makeServer({ id: "s1", name: "Prod API", host: "prod.example", group: "Team/Prod" }),
        makeServer({ id: "s2", name: "Dev API", host: "dev.example", group: "Team/Dev" })
      ],
      tunnels: [],
      serialProfiles: [],
      activeSessions: [],
      activeSerialSessions: [],
      activeTunnels: [],
      remoteTunnels: [],
      explicitGroups: [],
      authProfiles: [],
      activitySessionIds: new Set(),
      focusedSessionId: undefined
    });

    provider.setFilter("prod");

    const rootChildren = provider.getChildren(undefined) as FolderTreeItem[];
    const team = rootChildren.find((c) => c instanceof FolderTreeItem && c.folderPath === "Team");
    expect(team).toBeDefined();

    const teamChildren = provider.getChildren(team!) as FolderTreeItem[];
    const childFolders = teamChildren
      .filter((c): c is FolderTreeItem => c instanceof FolderTreeItem)
      .map((c) => c.folderPath);
    expect(childFolders).toContain("Team/Prod");
    expect(childFolders).not.toContain("Team/Dev");
  });

  it("orders servers and sibling folders numerically instead of lexicographically", () => {
    const provider = new NexusTreeProvider(callbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [
        makeServer({ id: "s10", name: "A10" }),
        makeServer({ id: "s2", name: "A2" }),
        makeServer({ id: "s1", name: "A1" }),
        makeServer({ id: "s-site10", name: "site10-router", group: "Site10" }),
        makeServer({ id: "s-site2", name: "site2-router", group: "Site2" })
      ]
    });

    const rootChildren = provider.getChildren(undefined);
    const serverNames = rootChildren
      .filter((c): c is ServerTreeItem => c instanceof ServerTreeItem)
      .map((c) => c.server.name);
    expect(serverNames).toEqual(["A1", "A2", "A10"]);

    const folderPaths = rootChildren
      .filter((c): c is FolderTreeItem => c instanceof FolderTreeItem)
      .map((c) => c.folderPath);
    expect(folderPaths).toEqual(["Site2", "Site10"]);
  });
});

function makeSerial(overrides: Partial<SerialProfile> = {}): SerialProfile {
  return {
    id: "sp-1",
    name: "Serial 1",
    path: "COM4",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    rtscts: false,
    ...overrides
  };
}

function makeLocalShell(overrides: Partial<LocalShellProfile> = {}): LocalShellProfile {
  return {
    id: "local-1",
    name: "Local 1",
    launchMode: "custom",
    shellPath: "/bin/bash",
    ...overrides
  };
}

function emptySnapshot() {
  return {
    servers: [] as ServerConfig[],
    tunnels: [] as TunnelProfile[],
    serialProfiles: [] as SerialProfile[],
    localShellProfiles: [] as LocalShellProfile[],
    activeSessions: [] as any[],
    activeSerialSessions: [] as any[],
    activeLocalShellSessions: [] as any[],
    activeTunnels: [] as any[],
    remoteTunnels: [] as any[],
    explicitGroups: [] as string[],
    authProfiles: [] as any[],
    activitySessionIds: new Set(),
    focusedSessionId: undefined as string | undefined
  };
}

const noopCallbacks = {
  onTunnelDropped: vi.fn(async () => {}),
  onItemGroupChanged: vi.fn(async () => {}),
  onFolderMoved: vi.fn(async () => {})
};

describe("NexusTreeProvider stable IDs", () => {
  it("ServerTreeItem ID does not change with connection state", () => {
    const server = makeServer({ id: "s1" });
    const disconnected = new ServerTreeItem(server, false);
    const connected = new ServerTreeItem(server, true);
    expect(disconnected.id).toBe("server:s1");
    expect(connected.id).toBe("server:s1");
    expect(disconnected.id).toBe(connected.id);
  });

  it("ADDRESSLESS (Codex P1) — renders an addressless server with a ' (no address)' description and does not crash on the empty host (⊘ the default `user@` + empty host reads as a broken addressed server)", () => {
    const item = new ServerTreeItem(makeServer({ id: "s1", host: "", port: 0, addressless: true, origin: { sourceId: "src", externalId: "e1", syncedAt: 1 } }), false);
    expect(item.description).toContain("(no address)");
    // The empty host is not dangled after an "@" as though it were a real host.
    expect(item.description).not.toMatch(/@\s*\(/);
    expect(() => item.tooltip).not.toThrow();
  });

  it("an addressed synced server keeps its normal user@host description with no (no address) suffix", () => {
    const item = new ServerTreeItem(makeServer({ id: "s2", host: "10.0.0.5", origin: { sourceId: "src", externalId: "e2", syncedAt: 1 } }), false);
    expect(item.description).toContain("@10.0.0.5");
    expect(item.description).not.toContain("(no address)");
  });

  it("ServerTreeItem shows the IPMI/BMC address on its own tooltip line, only when set (issue #48)", () => {
    // Not part of the SSH connection, so it must not be folded into the
    // `user@host:port` summary — and a server with no BMC gets no line at all.
    const withBmc = new ServerTreeItem(makeServer({ id: "s1", ipmiHost: "10.0.0.99" }), false);
    expect(withBmc.tooltip).toContain("\nIPMI/BMC: 10.0.0.99");

    const without = new ServerTreeItem(makeServer({ id: "s2" }), false);
    expect(without.tooltip).not.toContain("IPMI/BMC");
  });

  it("D3 — appends the linked IPMI Auth Profile name to the IPMI line, mirroring the SSH [auth: …] idiom", () => {
    const withProfile = new ServerTreeItem(
      makeServer({ id: "s1", ipmiHost: "10.0.0.99" }),
      false,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      "BMC accounts"
    );
    expect(withProfile.tooltip).toContain("\nIPMI/BMC: 10.0.0.99 [auth: BMC accounts]");

    // No linked profile → no suffix, just the host.
    const noProfile = new ServerTreeItem(makeServer({ id: "s2", ipmiHost: "10.0.0.99" }), false);
    expect(noProfile.tooltip).toContain("\nIPMI/BMC: 10.0.0.99");
    expect(noProfile.tooltip).not.toContain("[auth:");
  });

  it("SerialProfileTreeItem ID does not change with connection state", () => {
    const profile = makeSerial({ id: "sp1" });
    const disconnected = new SerialProfileTreeItem(profile, "disconnected");
    const connected = new SerialProfileTreeItem(profile, "connected");
    expect(disconnected.id).toBe("serial:sp1");
    expect(connected.id).toBe("serial:sp1");
    expect(disconnected.id).toBe(connected.id);
  });

  it("LocalShellProfileTreeItem ID does not change with connection state", () => {
    const profile = makeLocalShell({ id: "local-1" });
    const disconnected = new LocalShellProfileTreeItem(profile, false);
    const connected = new LocalShellProfileTreeItem(profile, true);
    expect(disconnected.id).toBe("localShell:local-1");
    expect(connected.id).toBe("localShell:local-1");
    expect(disconnected.id).toBe(connected.id);
  });

  it("ServerTreeItem opens profile quick actions on click", () => {
    const server = makeServer({ id: "s1" });
    const item = new ServerTreeItem(server, false);

    expect(item.command).toEqual({
      command: "nexus.profile.actions",
      title: "Profile Actions",
      arguments: [item]
    });
  });

  it("SerialProfileTreeItem opens profile quick actions on click", () => {
    const profile = makeSerial({ id: "sp1" });
    const item = new SerialProfileTreeItem(profile, "connected");

    expect(item.command).toEqual({
      command: "nexus.profile.actions",
      title: "Profile Actions",
      arguments: [item]
    });
  });

  it("LocalShellProfileTreeItem opens profile quick actions on click", () => {
    const profile = makeLocalShell({ id: "local-1" });
    const item = new LocalShellProfileTreeItem(profile, true);

    expect(item.command).toEqual({
      command: "nexus.profile.actions",
      title: "Profile Actions",
      arguments: [item]
    });
    expect((item.iconPath as { id: string }).id).toBe("terminal");
    expect(item.description).toBe("/bin/bash");
  });

  it("marks smart-follow serial profiles in the description", () => {
    const profile = makeSerial({ id: "sp-smart", mode: "smartFollow" });
    const item = new SerialProfileTreeItem(profile, "disconnected");
    expect(item.description).toContain("Smart Follow");
    expect((item.iconPath as { id: string }).id).toBe("sync");
  });

  it("marks waiting smart-follow serial profiles distinctly", () => {
    const profile = makeSerial({ id: "sp-smart", mode: "smartFollow" });
    const item = new SerialProfileTreeItem(profile, "waiting");
    expect(item.contextValue).toBe("nexus.serialProfileWaiting");
    expect(item.description).toContain("Waiting for port");
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
  });

  it("B5/m7 — a synced server gets a ' (synced)' description suffix and tooltip line, but contextValue is UNCHANGED (load-bearing: package.json's context menus match it verbatim)", () => {
    const synced = makeServer({ id: "s1", origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000 } });
    const manual = makeServer({ id: "s2" });

    const syncedItem = new ServerTreeItem(synced, false, undefined, true, undefined, undefined, "My NetBox");
    const manualItem = new ServerTreeItem(manual, false);
    const syncedConnected = new ServerTreeItem(synced, true, undefined, true, undefined, undefined, "My NetBox");

    // Kills reverting the idiom back to "· synced" (a description suffix
    // wired to the old separator would still read as "synced" but fail this
    // exact-string check).
    expect(syncedItem.description).toBe("dev@example.com (synced)");
    expect(manualItem.description).toBe("dev@example.com");
    expect(syncedItem.tooltip).toContain('Synced from "My NetBox"');
    expect(manualItem.tooltip).not.toContain("Synced from");

    // The load-bearing assertion: a synced server's contextValue must match
    // exactly what an ordinary server's does (package.json's menus key off
    // "nexus.server" / "nexus.serverConnected" verbatim) — a distinct value
    // here would silently drop every context-menu entry for synced servers.
    expect(syncedItem.contextValue).toBe("nexus.server");
    expect(syncedItem.contextValue).toBe(manualItem.contextValue);
    expect(syncedConnected.contextValue).toBe("nexus.serverConnected");
  });

  it("m7 — the tooltip falls back to the generic 'Synced from inventory' line when the source name can't be resolved (source removed, origin left dangling)", () => {
    const synced = makeServer({ id: "s1", origin: { sourceId: "source-gone", externalId: "device:1", syncedAt: 1000 } });

    // No sourceName argument passed — mirrors what NexusTreeProvider.toServerItem
    // computes when snapshot.inventorySources has no entry for origin.sourceId.
    const item = new ServerTreeItem(synced, false);

    expect(item.tooltip).toContain("Synced from inventory");
    expect(item.tooltip).not.toContain('Synced from ""');
  });
});

describe("NexusTreeProvider getParent", () => {
  it("returns undefined for root-level folder", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({ ...emptySnapshot(), servers: [makeServer({ id: "s1", group: "Root" })] });
    const folder = new FolderTreeItem("Root", "Root");
    expect(provider.getParent(folder)).toBeUndefined();
  });

  it("returns parent FolderTreeItem for nested folder", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({ ...emptySnapshot(), servers: [makeServer({ id: "s1", group: "A/B/C" })] });
    const child = new FolderTreeItem("A/B/C", "C");
    const parent = provider.getParent(child) as FolderTreeItem;
    expect(parent).toBeInstanceOf(FolderTreeItem);
    expect(parent.folderPath).toBe("A/B");
    expect(parent.id).toBe("folder:A/B");
  });

  it("returns FolderTreeItem for server with group", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    const server = makeServer({ id: "s1", group: "Prod" });
    provider.setSnapshot({ ...emptySnapshot(), servers: [server] });
    const item = new ServerTreeItem(server, false);
    const parent = provider.getParent(item) as FolderTreeItem;
    expect(parent).toBeInstanceOf(FolderTreeItem);
    expect(parent.folderPath).toBe("Prod");
  });

  it("returns undefined for root-level server", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    const server = makeServer({ id: "s1" });
    provider.setSnapshot({ ...emptySnapshot(), servers: [server] });
    const item = new ServerTreeItem(server, false);
    expect(provider.getParent(item)).toBeUndefined();
  });

  it("returns FolderTreeItem for serial profile with group", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    const profile = makeSerial({ id: "sp1", group: "Lab" });
    provider.setSnapshot({ ...emptySnapshot(), serialProfiles: [profile] });
    const item = new SerialProfileTreeItem(profile, "disconnected");
    const parent = provider.getParent(item) as FolderTreeItem;
    expect(parent).toBeInstanceOf(FolderTreeItem);
    expect(parent.folderPath).toBe("Lab");
  });

  it("returns ServerTreeItem for SessionTreeItem", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    const server = makeServer({ id: "s1" });
    const session = { id: "sess-1", serverId: "s1", terminalName: "bash", startedAt: 0 };
    provider.setSnapshot({ ...emptySnapshot(), servers: [server], activeSessions: [session] });
    const item = new SessionTreeItem(session);
    const parent = provider.getParent(item) as ServerTreeItem;
    expect(parent).toBeInstanceOf(ServerTreeItem);
    expect(parent.server.id).toBe("s1");
  });

  it("returns SerialProfileTreeItem for SerialSessionTreeItem", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    const profile = makeSerial({ id: "sp1" });
    const session = { id: "ss-1", profileId: "sp1", terminalName: "serial", startedAt: 0 };
    provider.setSnapshot({ ...emptySnapshot(), serialProfiles: [profile], activeSerialSessions: [session] });
    const item = new SerialSessionTreeItem(session);
    const parent = provider.getParent(item) as SerialProfileTreeItem;
    expect(parent).toBeInstanceOf(SerialProfileTreeItem);
    expect(parent.profile.id).toBe("sp1");
  });

  it("returns LocalShellProfileTreeItem for LocalShellSessionTreeItem", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    const profile = makeLocalShell({ id: "local-1" });
    const session = { id: "local-session-1", profileId: "local-1", terminalName: "local", startedAt: 0 };
    provider.setSnapshot({ ...emptySnapshot(), localShellProfiles: [profile], activeLocalShellSessions: [session] });
    const item = new LocalShellSessionTreeItem(session);
    const parent = provider.getParent(item) as LocalShellProfileTreeItem;
    expect(parent).toBeInstanceOf(LocalShellProfileTreeItem);
    expect(parent.profile.id).toBe("local-1");
  });
});

describe("NexusTreeProvider large tree", () => {
  it("returns all items across deeply nested folders with 100 servers", () => {
    const folders = ["DC1", "DC1/Rack1", "DC1/Rack2", "DC2", "DC2/Rack1", "DC2/Rack2", "DC2/Rack2/Shelf1"];
    const servers: ServerConfig[] = [];
    for (let i = 0; i < 100; i++) {
      const group = folders[i % folders.length];
      servers.push(makeServer({ id: `s-${i}`, name: `Server ${i}`, group }));
    }

    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({ ...emptySnapshot(), servers });

    // Collect all servers by recursively walking the tree
    const allFound: ServerTreeItem[] = [];
    function walk(element?: any) {
      const children = provider.getChildren(element) as any[];
      for (const child of children) {
        if (child instanceof ServerTreeItem) {
          allFound.push(child);
        } else if (child instanceof FolderTreeItem) {
          walk(child);
        }
      }
    }
    walk(undefined);

    expect(allFound).toHaveLength(100);
    const ids = new Set(allFound.map((s) => s.server.id));
    expect(ids.size).toBe(100);
  });

  it("returns consistent items before and after filter toggle", () => {
    const servers = [
      makeServer({ id: "s1", name: "Alpha", group: "A/B" }),
      makeServer({ id: "s2", name: "Beta", group: "A/B" }),
      makeServer({ id: "s3", name: "Gamma", group: "A/C" })
    ];
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({ ...emptySnapshot(), servers });

    function collectAll(): string[] {
      const result: string[] = [];
      function walk(element?: any) {
        const children = provider.getChildren(element) as any[];
        for (const child of children) {
          if (child instanceof ServerTreeItem) {
            result.push(child.server.id);
          } else if (child instanceof FolderTreeItem) {
            walk(child);
          }
        }
      }
      walk(undefined);
      return result.sort();
    }

    const before = collectAll();
    provider.setFilter("alpha");
    provider.clearFilter();
    const after = collectAll();

    expect(before).toEqual(after);
  });
});

describe("NexusTreeProvider getParent/getChildren ID consistency", () => {
  it("getParent returns items with IDs matching getChildren output", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    const server = makeServer({ id: "s1", name: "Web", group: "DC/Rack1" });
    const session = { id: "sess-1", serverId: "s1", terminalName: "bash", startedAt: 0 };
    provider.setSnapshot({ ...emptySnapshot(), servers: [server], activeSessions: [session] });

    // Walk the tree and build a map of child -> parent ID from getChildren
    const parentIdByChildId = new Map<string, string | undefined>();
    function walk(element?: any, parentId?: string) {
      const children = provider.getChildren(element) as any[];
      for (const child of children) {
        parentIdByChildId.set(child.id, parentId);
        walk(child, child.id);
      }
    }
    walk(undefined, undefined);

    // Verify getParent returns matching IDs for every node
    function walkAndVerify(element?: any) {
      const children = provider.getChildren(element) as any[];
      for (const child of children) {
        const parent = provider.getParent(child) as any;
        const expectedParentId = parentIdByChildId.get(child.id);
        if (expectedParentId === undefined) {
          expect(parent).toBeUndefined();
        } else {
          expect(parent).toBeDefined();
          expect(parent.id).toBe(expectedParentId);
        }
        walkAndVerify(child);
      }
    }
    walkAndVerify(undefined);

    // Ensure we actually checked something
    expect(parentIdByChildId.size).toBeGreaterThanOrEqual(4); // DC, DC/Rack1, server, session
  });

  it("getParent returns undefined for orphaned SessionTreeItem", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot(emptySnapshot()); // no servers in snapshot
    const orphanSession = new SessionTreeItem({ id: "sess-orphan", serverId: "deleted-server", terminalName: "bash", startedAt: 0 });
    expect(provider.getParent(orphanSession)).toBeUndefined();
  });

  it("getParent returns undefined for orphaned SerialSessionTreeItem", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot(emptySnapshot()); // no profiles in snapshot
    const orphanSession = new SerialSessionTreeItem({ id: "ss-orphan", profileId: "deleted-profile", terminalName: "serial", startedAt: 0 });
    expect(provider.getParent(orphanSession)).toBeUndefined();
  });
});

describe("NexusTreeProvider description visibility", () => {
  it("hides server description when showTreeDescriptions is false", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => key === "showTreeDescriptions" ? false : undefined
    } as any);
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({ ...emptySnapshot(), servers: [makeServer()] });
    const children = provider.getChildren(undefined) as ServerTreeItem[];
    const server = children.find((c) => c instanceof ServerTreeItem);
    expect(server!.description).toBeUndefined();
  });

  it("shows server description when showTreeDescriptions is true", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => key === "showTreeDescriptions" ? true : undefined
    } as any);
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({ ...emptySnapshot(), servers: [makeServer()] });
    const children = provider.getChildren(undefined) as ServerTreeItem[];
    const server = children.find((c) => c instanceof ServerTreeItem);
    expect(server!.description).toBe("dev@example.com");
  });

  it("shows resolved auth profile details in server description", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => key === "showTreeDescriptions" ? true : undefined
    } as any);
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [makeServer({ authProfileId: "ap-1", username: "stored-user" })],
      authProfiles: [{ id: "ap-1", name: "Production Auth", username: "deploy", authType: "password" }]
    });
    const children = provider.getChildren(undefined) as ServerTreeItem[];
    const server = children.find((c) => c instanceof ServerTreeItem);
    expect(server!.description).toBe("deploy@example.com (Production Auth)");
    expect(server!.tooltip).toContain("[auth: Production Auth]");
  });

  // REVIEW FINDING (P2) — the sidebar reads a linked profile's username through
  // the shared ownership rule, so it names the account a connection will
  // actually use. Reading `authProfile.username` directly rendered an imported
  // profile's whitespace-only username, i.e. "@example.com" with no account at
  // all, over a server that connects perfectly well as its own user.
  it("shows the server's own username when the linked profile supplies only whitespace (kills displaying the profile's username on the strength of the link alone)", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => key === "showTreeDescriptions" ? true : undefined
    } as any);
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [makeServer({ authProfileId: "ap-blank", username: "stored-user" })],
      authProfiles: [{ id: "ap-blank", name: "Imported", username: "   ", authType: "password" }]
    });
    const children = provider.getChildren(undefined) as ServerTreeItem[];
    const server = children.find((c) => c instanceof ServerTreeItem);
    expect(server!.description).toBe("stored-user@example.com (Imported)");
    expect(server!.tooltip).toContain("stored-user@example.com:22");
  });

  it("m7 — resolves the synced tooltip's source name from snapshot.inventorySources by origin.sourceId, and falls back to the generic line when the source is gone (kills a hardcoded 'Synced from inventory' that never looks at the source record)", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => (key === "showTreeDescriptions" ? true : undefined)
    } as any);
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [
        makeServer({ id: "s1", name: "synced-live", origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 } }),
        makeServer({ id: "s2", name: "synced-orphaned", origin: { sourceId: "source-gone", externalId: "device:2", syncedAt: 1 } })
      ],
      inventorySources: [
        { id: "source-1", providerId: "netbox", name: "My NetBox", targetFolder: "", prunePolicy: "orphan", defaultUsername: "admin", config: {}, secretFieldIds: [] }
      ]
    } as any);
    const children = provider.getChildren(undefined) as ServerTreeItem[];
    const live = children.find((c) => c instanceof ServerTreeItem && c.server.id === "s1") as ServerTreeItem;
    const orphaned = children.find((c) => c instanceof ServerTreeItem && c.server.id === "s2") as ServerTreeItem;

    // If the fix were reverted (tooltip always says "Synced from inventory"
    // regardless of the live source record), this would read identically to
    // the fallback case below and fail to distinguish a real source name.
    expect(live.tooltip).toContain('Synced from "My NetBox"');
    // The source record for "source-gone" doesn't exist — fallback, not a
    // blank/undefined name rendered literally.
    expect(orphaned.tooltip).toContain("Synced from inventory");
    expect(orphaned.tooltip).not.toContain('Synced from "');
  });

  it("hides serial profile description when showTreeDescriptions is false", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => key === "showTreeDescriptions" ? false : undefined
    } as any);
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({ ...emptySnapshot(), serialProfiles: [makeSerial()] });
    const children = provider.getChildren(undefined) as SerialProfileTreeItem[];
    const serial = children.find((c) => c instanceof SerialProfileTreeItem);
    expect(serial!.description).toBeUndefined();
  });
});

describe("NexusTreeProvider session activity indicators", () => {
  it("SessionTreeItem shows yellow icon when session has activity", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [makeServer()],
      activeSessions: [{ id: "sess-1", serverId: "srv-1", terminalName: "Nexus SSH: S1", startedAt: 0 }],
      activitySessionIds: new Set(["sess-1"])
    });
    const server = (provider.getChildren(undefined) as ServerTreeItem[]).find((c) => c instanceof ServerTreeItem)!;
    const sessions = provider.getChildren(server) as SessionTreeItem[];
    expect(sessions).toHaveLength(1);
    const icon = sessions[0].iconPath as { id: string; color?: { id: string } };
    expect(icon.id).toBe("terminal");
    expect(icon.color).toBeDefined();
    expect(icon.color!.id).toBe("terminal.ansiYellow");
  });

  it("SessionTreeItem shows default icon when session has no activity", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [makeServer()],
      activeSessions: [{ id: "sess-1", serverId: "srv-1", terminalName: "Nexus SSH: S1", startedAt: 0 }],
      activitySessionIds: new Set()
    });
    const server = (provider.getChildren(undefined) as ServerTreeItem[]).find((c) => c instanceof ServerTreeItem)!;
    const sessions = provider.getChildren(server) as SessionTreeItem[];
    const icon = sessions[0].iconPath as { id: string; color?: unknown };
    expect(icon.id).toBe("terminal");
    expect(icon.color).toBeUndefined();
  });

  it("SessionTreeItem focuses the matching SSH terminal on click", () => {
    const session = { id: "sess-1", serverId: "srv-1", terminalName: "Nexus SSH: S1", startedAt: 0 };
    const item = new SessionTreeItem(session);

    expect(item.command).toEqual({
      command: "nexus.focusSessionTerminal",
      title: "Focus Terminal",
      arguments: ["sess-1", "ssh"]
    });
  });

  it("SerialSessionTreeItem shows yellow icon when session has activity", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      serialProfiles: [makeSerial()],
      activeSerialSessions: [{ id: "ss-1", profileId: "sp-1", terminalName: "Nexus Serial: S1", startedAt: 0 }],
      activitySessionIds: new Set(["ss-1"])
    });
    const profile = (provider.getChildren(undefined) as SerialProfileTreeItem[]).find((c) => c instanceof SerialProfileTreeItem)!;
    const sessions = provider.getChildren(profile) as SerialSessionTreeItem[];
    expect(sessions).toHaveLength(1);
    const icon = sessions[0].iconPath as { id: string; color?: { id: string } };
    expect(icon.id).toBe("terminal");
    expect(icon.color).toBeDefined();
    expect(icon.color!.id).toBe("terminal.ansiYellow");
  });

  it("SerialSessionTreeItem shows default icon when session has no activity", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      serialProfiles: [makeSerial()],
      activeSerialSessions: [{ id: "ss-1", profileId: "sp-1", terminalName: "Nexus Serial: S1", startedAt: 0 }],
      activitySessionIds: new Set()
    });
    const profile = (provider.getChildren(undefined) as SerialProfileTreeItem[]).find((c) => c instanceof SerialProfileTreeItem)!;
    const sessions = provider.getChildren(profile) as SerialSessionTreeItem[];
    const icon = sessions[0].iconPath as { id: string; color?: unknown };
    expect(icon.id).toBe("terminal");
    expect(icon.color).toBeUndefined();
  });

  it("shows waiting serial sessions and profiles as waiting instead of connected", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      serialProfiles: [makeSerial({ mode: "smartFollow" })],
      activeSerialSessions: [{ id: "ss-1", profileId: "sp-1", terminalName: "Nexus Serial: S1", startedAt: 0, status: "waiting" }],
      activitySessionIds: new Set()
    });
    const profile = (provider.getChildren(undefined) as SerialProfileTreeItem[]).find((c) => c instanceof SerialProfileTreeItem)!;
    expect(profile.contextValue).toBe("nexus.serialProfileWaiting");
    const sessions = provider.getChildren(profile) as SerialSessionTreeItem[];
    expect(sessions[0].description).toBe("waiting for port");
  });

  it("SerialSessionTreeItem focuses the matching serial terminal on click", () => {
    const session = { id: "ss-1", profileId: "sp-1", terminalName: "Nexus Serial: S1", startedAt: 0 };
    const item = new SerialSessionTreeItem(session);

    expect(item.command).toEqual({
      command: "nexus.focusSessionTerminal",
      title: "Focus Terminal",
      arguments: ["ss-1", "serial"]
    });
  });

  it("LocalShellSessionTreeItem focuses the matching local shell terminal on click", () => {
    const session = { id: "local-session-1", profileId: "local-1", terminalName: "Nexus Local Shell: Local 1", startedAt: 0 };
    const item = new LocalShellSessionTreeItem(session);

    expect(item.command).toEqual({
      command: "nexus.focusSessionTerminal",
      title: "Focus Terminal",
      arguments: ["local-session-1", "localShell"]
    });
  });

  it("SessionTreeItem description is '▶ active' when isFocused is true", () => {
    const session = { id: "sess-focused", serverId: "srv-1", terminalName: "bash", startedAt: 0 };
    const item = new SessionTreeItem(session, false, true);
    expect(item.description).toBe("▶ active");
  });

  it("SessionTreeItem description is 'active' when isFocused is false", () => {
    const session = { id: "sess-1", serverId: "srv-1", terminalName: "bash", startedAt: 0 };
    const item = new SessionTreeItem(session, false, false);
    expect(item.description).toBe("active");
  });

  it("SerialSessionTreeItem description is '▶ active' when isFocused is true and connected", () => {
    const session = { id: "ss-focused", profileId: "sp-1", terminalName: "serial", startedAt: 0 };
    const item = new SerialSessionTreeItem(session, false, true);
    expect(item.description).toBe("▶ active");
  });

  it("SerialSessionTreeItem description is '▶ waiting for port' when isFocused is true and waiting", () => {
    const session = { id: "ss-focused", profileId: "sp-1", terminalName: "serial", startedAt: 0, status: "waiting" as const };
    const item = new SerialSessionTreeItem(session, false, true);
    expect(item.description).toBe("▶ waiting for port");
  });

  it("getChildren sets isFocused=true on the matching session", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [makeServer()],
      activeSessions: [{ id: "sess-1", serverId: "srv-1", terminalName: "bash", startedAt: 0 }],
      focusedSessionId: "sess-1"
    });
    const server = (provider.getChildren(undefined) as ServerTreeItem[]).find((c) => c instanceof ServerTreeItem)!;
    const sessions = provider.getChildren(server) as SessionTreeItem[];
    expect(sessions[0].description).toBe("▶ active");
  });

  it("getChildren sets isFocused=false on a non-focused session", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [makeServer()],
      activeSessions: [{ id: "sess-1", serverId: "srv-1", terminalName: "bash", startedAt: 0 }],
      focusedSessionId: "other-session"
    });
    const server = (provider.getChildren(undefined) as ServerTreeItem[]).find((c) => c instanceof ServerTreeItem)!;
    const sessions = provider.getChildren(server) as SessionTreeItem[];
    expect(sessions[0].description).toBe("active");
  });

  it("getChildren sets isFocused=true on the matching serial session", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      serialProfiles: [makeSerial()],
      activeSerialSessions: [{ id: "ss-1", profileId: "sp-1", terminalName: "serial", startedAt: 0 }],
      focusedSessionId: "ss-1"
    });
    const profile = (provider.getChildren(undefined) as SerialProfileTreeItem[]).find((c) => c instanceof SerialProfileTreeItem)!;
    const sessions = provider.getChildren(profile) as SerialSessionTreeItem[];
    expect(sessions[0].description).toBe("▶ active");
  });

  it("getChildren sets isFocused=false on a non-focused serial session", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      serialProfiles: [makeSerial()],
      activeSerialSessions: [{ id: "ss-1", profileId: "sp-1", terminalName: "serial", startedAt: 0 }],
      focusedSessionId: "other-session"
    });
    const profile = (provider.getChildren(undefined) as SerialProfileTreeItem[]).find((c) => c instanceof SerialProfileTreeItem)!;
    const sessions = provider.getChildren(profile) as SerialSessionTreeItem[];
    expect(sessions[0].description).toBe("active");
  });

  it("getChildren returns multiple local shell sessions for one saved profile", () => {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      localShellProfiles: [makeLocalShell()],
      activeLocalShellSessions: [
        { id: "local-session-1", profileId: "local-1", terminalName: "Nexus Local Shell: Local 1", startedAt: 0 },
        { id: "local-session-2", profileId: "local-1", terminalName: "Nexus Local Shell: Local 1", startedAt: 1 }
      ],
      focusedSessionId: "local-session-2"
    });
    const profile = (provider.getChildren(undefined) as LocalShellProfileTreeItem[]).find((c) => c instanceof LocalShellProfileTreeItem)!;
    expect(profile.contextValue).toBe("nexus.localShellProfileConnected");
    const sessions = provider.getChildren(profile) as LocalShellSessionTreeItem[];
    expect(sessions).toHaveLength(2);
    expect(sessions[0].description).toBe("active");
    expect(sessions[1].description).toBe("▶ active");
  });
});

describe("FolderTreeItem — parameterised contextValue/id (§4.10)", () => {
  it("defaults preserve the Connectivity Hub's existing behaviour exactly", () => {
    const item = new FolderTreeItem("Cisco", "Cisco");
    expect(item.contextValue).toBe("nexus.folder");
    expect(item.id).toBe("folder:Cisco");
  });

  it("hasDirectServers still selects nexus.folderWithServers when contextValue is not overridden", () => {
    const item = new FolderTreeItem("Cisco", "Cisco", undefined, true);
    expect(item.contextValue).toBe("nexus.folderWithServers");
  });

  it("an explicit contextValue and idPrefix override both — used by the Macros view (§4.10) to reuse this class", () => {
    const item = new FolderTreeItem("Cisco", "Cisco", undefined, false, "nexus.folder.macros", "macro-folder");
    expect(item.contextValue).toBe("nexus.folder.macros");
    expect(item.id).toBe("macro-folder:Cisco");
    // And critically: this contextValue must NOT match the six menu entries
    // gated on the unanchored /^nexus\.macro/ prefix (§4.10's actual bug).
    expect(/^nexus\.macro/.test(item.contextValue!)).toBe(false);
  });
});

/**
 * LIVE STATUS (Phase 2) — the running-lab affordances on the Command Center
 * tree: a green running dot + " (running)" on a running server, a dim dot on a
 * stopped EVE node, and the nexus-status: resourceUri that lets the decoration
 * provider paint the ▶ badge. A server with no status (non-EVE) is unchanged.
 */
describe("ServerTreeItem inventory status affordance", () => {
  function itemWithStatus(status: "running" | "stopped" | undefined): ServerTreeItem {
    return new ServerTreeItem(makeServer({ id: "s1" }), false, undefined, true, undefined, undefined, undefined, undefined, status);
  }

  it("a running server gets a green dot and a ' (running)' description suffix (⊘ no affordance leaves the user unable to see which lab is up)", () => {
    const item = itemWithStatus("running");
    expect((item.iconPath as { color: { id: string } }).color.id).toBe("charts.green");
    expect(item.description).toContain("(running)");
  });

  it("a stopped EVE node gets a dim dot and NO '(running)' suffix (⊘ a green dot on a stopped node is a lie; a running suffix on a stopped node likewise)", () => {
    const item = itemWithStatus("stopped");
    expect((item.iconPath as { color: { id: string } }).color.id).toBe("descriptionForeground");
    expect(item.description).not.toContain("(running)");
  });

  it("a server with NO status keeps the plain connect icon and no status suffix (⊘ applying a status dot to a non-EVE server invents state it does not have)", () => {
    const item = itemWithStatus(undefined);
    expect((item.iconPath as { id: string }).id).toBe("debug-disconnect");
    expect((item.iconPath as { color: { id: string } }).color.id).toBe("testing.iconQueued");
    expect(item.description).not.toContain("(running)");
  });

  function connectedItemWithStatus(status: "running" | "stopped"): ServerTreeItem {
    return new ServerTreeItem(makeServer({ id: "c" }), true, undefined, true, undefined, undefined, undefined, undefined, status);
  }

  it("P3-6: a CONNECTED running EVE node keeps its connected (plug) icon; the running state is carried by the '(running)' description, not by replacing the icon (⊘ swapping the plug for a status dot regresses the connected affordance)", () => {
    const item = connectedItemWithStatus("running");
    expect((item.iconPath as { id: string }).id).toBe("plug");
    expect((item.iconPath as { color: { id: string } }).color.id).toBe("testing.iconPassed");
    expect(item.description).toContain("(running)");
  });

  it("P3-6: a CONNECTED stopped EVE node keeps its connected icon and shows no dim dot and no '(running)' suffix", () => {
    const item = connectedItemWithStatus("stopped");
    expect((item.iconPath as { id: string }).id).toBe("plug");
    expect((item.iconPath as { color: { id: string } }).color.id).toBe("testing.iconPassed");
    expect(item.description).not.toContain("(running)");
  });

  it("threads status from the snapshot and stamps a nexus-status: resourceUri on both the running server and its lab folder (⊘ no resourceUri means the decoration provider can never match the row)", async () => {
    const provider = new NexusTreeProvider({
      onTunnelDropped: vi.fn(async () => {}),
      onItemGroupChanged: vi.fn(async () => {}),
      onFolderMoved: vi.fn(async () => {})
    });
    provider.setSnapshot({
      servers: [makeServer({ id: "s1", group: "LabA" })],
      tunnels: [],
      serialProfiles: [],
      localShellProfiles: [],
      activeSessions: [],
      activeSerialSessions: [],
      activeLocalShellSessions: [],
      activeTunnels: [],
      remoteTunnels: [],
      explicitGroups: ["LabA"],
      authProfiles: [],
      activitySessionIds: new Set(),
      serverStatus: new Map([["s1", "running"]]),
      focusedSessionId: undefined,
      inventorySources: [],
      deviceTemplates: [],
      savedFilters: []
    } as unknown as import("../../src/core/contracts").SessionSnapshot);

    const roots = (await provider.getChildren()) as Array<FolderTreeItem>;
    const folder = roots.find((i) => i instanceof FolderTreeItem) as FolderTreeItem & { resourceUri?: { scheme: string } };
    expect(folder).toBeDefined();
    expect(folder.resourceUri?.scheme).toBe("nexus-status");

    const children = (await provider.getChildren(folder)) as Array<ServerTreeItem & { resourceUri?: { scheme: string } }>;
    const serverItem = children.find((c) => c instanceof ServerTreeItem);
    expect(serverItem).toBeDefined();
    expect(serverItem!.resourceUri?.scheme).toBe("nexus-status");
    expect((serverItem!.iconPath as { color: { id: string } }).color.id).toBe("charts.green");
  });
});

/**
 * BMC-menu gating (task #27, Phase 2) — a server with an ipmiHost gets an
 * `.ipmi` marker appended to its contextValue so the two BMC menu entries can
 * require it; the base string is UNCHANGED so every other server menu (matched
 * by /^nexus\.server(Connected)?(\.ipmi)?$/) keeps working.
 */
describe("ServerTreeItem BMC ipmi contextValue marker", () => {
  it("appends .ipmi when the server has a non-blank ipmiHost, for both connected states (⊘ no marker means the BMC entries cannot be gated per-server)", () => {
    expect(new ServerTreeItem(makeServer({ id: "a", ipmiHost: "10.0.0.9" }), false).contextValue).toBe("nexus.server.ipmi");
    expect(new ServerTreeItem(makeServer({ id: "b", ipmiHost: "10.0.0.9" }), true).contextValue).toBe("nexus.serverConnected.ipmi");
  });

  it("leaves the base contextValue untouched when ipmiHost is absent or blank (⊘ appending .ipmi to a non-BMC server would show BMC actions that can only fail)", () => {
    expect(new ServerTreeItem(makeServer({ id: "a" }), false).contextValue).toBe("nexus.server");
    expect(new ServerTreeItem(makeServer({ id: "b", ipmiHost: "   " }), false).contextValue).toBe("nexus.server");
    expect(new ServerTreeItem(makeServer({ id: "c" }), true).contextValue).toBe("nexus.serverConnected");
  });
});
