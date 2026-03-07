import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { FolderTreeItem, NexusTreeProvider, SerialProfileTreeItem, SerialSessionTreeItem, ServerTreeItem, SessionTreeItem } from "../../src/ui/nexusTreeProvider";
import { TUNNEL_DRAG_MIME } from "../../src/ui/dndMimeTypes";
import type { SerialProfile, ServerConfig, TunnelProfile } from "../../src/models/config";

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
      activitySessionIds: new Set()
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
      activitySessionIds: new Set()
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
      activitySessionIds: new Set()
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
      activitySessionIds: new Set()
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
      activitySessionIds: new Set()
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
      activitySessionIds: new Set()
    });

    const rootChildren = provider.getChildren(undefined) as FolderTreeItem[];
    const folder = rootChildren.find((c) => c instanceof FolderTreeItem && c.folderPath === "Lab");
    expect(folder).toBeDefined();
    expect(folder!.contextValue).toBe("nexus.folder");
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
      activitySessionIds: new Set()
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

function emptySnapshot() {
  return {
    servers: [] as ServerConfig[],
    tunnels: [] as TunnelProfile[],
    serialProfiles: [] as SerialProfile[],
    activeSessions: [] as any[],
    activeSerialSessions: [] as any[],
    activeTunnels: [] as any[],
    remoteTunnels: [] as any[],
    explicitGroups: [] as string[],
    authProfiles: [] as any[],
    activitySessionIds: new Set()
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

  it("SerialProfileTreeItem ID does not change with connection state", () => {
    const profile = makeSerial({ id: "sp1" });
    const disconnected = new SerialProfileTreeItem(profile, false);
    const connected = new SerialProfileTreeItem(profile, true);
    expect(disconnected.id).toBe("serial:sp1");
    expect(connected.id).toBe("serial:sp1");
    expect(disconnected.id).toBe(connected.id);
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
    const item = new SerialProfileTreeItem(profile, false);
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
});
