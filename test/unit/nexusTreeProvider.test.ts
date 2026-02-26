import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { FolderTreeItem, NexusTreeProvider, ServerTreeItem } from "../../src/ui/nexusTreeProvider";
import { TUNNEL_DRAG_MIME } from "../../src/ui/dndMimeTypes";
import type { ServerConfig, TunnelProfile } from "../../src/models/config";

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
      explicitGroups: []
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
      explicitGroups: []
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
      explicitGroups: []
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
      explicitGroups: []
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
