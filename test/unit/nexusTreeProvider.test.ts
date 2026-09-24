import { readFileSync } from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { FolderTreeItem, LocalShellProfileTreeItem, LocalShellSessionTreeItem, NexusTreeProvider, NoMatchesTreeItem, SerialProfileTreeItem, SerialSessionTreeItem, ServerTreeItem, SessionTreeItem } from "../../src/ui/nexusTreeProvider";
import { TUNNEL_DRAG_MIME } from "../../src/ui/dndMimeTypes";
import type { LocalShellProfile, SerialProfile, ServerConfig, TunnelProfile } from "../../src/models/config";
import { InventoryProviderRegistry } from "../../src/services/inventory/providerRegistry";
import type { InventoryProvider } from "../../src/models/inventory";

// Read for the "No matches found" tooltip check: the tooltip must name a command
// the Hub's title bar really contributes, not a literal copied into this file.
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8"));

vi.mock("vscode", () => ({
  TreeItem: class {
    public id?: string;
    public tooltip?: string;
    public description?: string;
    public contextValue?: string;
    public iconPath?: unknown;
    public command?: unknown;
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
      inventorySources: [],
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
      inventorySources: [],
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
      inventorySources: [],
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
      inventorySources: [],
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
      inventorySources: [],
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
      inventorySources: [],
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
      inventorySources: [],
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

  it("shows a single inert no-matches row when an active filter matches nothing", () => {
    const provider = new NexusTreeProvider(callbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [makeServer({ id: "s1", name: "Prod API", host: "prod.example" })]
    });

    provider.setFilter("zzz-no-match");

    const rootChildren = provider.getChildren(undefined);
    expect(rootChildren).toHaveLength(1);
    const marker = rootChildren[0] as NoMatchesTreeItem;
    expect(marker).toBeInstanceOf(NoMatchesTreeItem);
    expect(marker.label).toBe("No matches found");
    // Inert by construction: no contextValue (no context-menu entries can
    // attach), no command, not expandable.
    expect(marker.contextValue).toBeUndefined();
    expect(marker.command).toBeUndefined();
    expect(marker.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  /**
   * #153 — the tooltip is the row's only guidance, so the way out it names has
   * to exist. "Filter Connectivity Hub" is only the input box's title; the
   * palette entry is plain "Filter", so the old tooltip sent users hunting for
   * a command that is not there. Checked against package.json rather than a
   * literal: the tooltip must name the title of the command the Hub's own title
   * bar shows while a filter is active. ⊘ Restoring the palette-style name
   * fails the absence pin; ⊘ naming a button the title bar does not show fails
   * the contribution cross-check.
   */
  it("names a way out of the filter that the Hub's title bar actually shows, not a palette command that does not exist", () => {
    const provider = new NexusTreeProvider(callbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [makeServer({ id: "s1", name: "Prod API", host: "prod.example" })]
    });
    provider.setFilter("zzz-no-match");
    const marker = provider.getChildren(undefined)[0] as NoMatchesTreeItem;
    const tooltip = String(marker.tooltip);

    const titleMenus: Array<{ command: string; when?: string }> = packageJson.contributes.menus["view/title"];
    const clearEntry = titleMenus.find(
      (m) => m.when?.includes("view == nexusCommandCenter") && /(^|&&\s*)nexus\.filterActive\b/.test(m.when)
    );
    expect(clearEntry).toBeDefined();
    const clearCommand = (packageJson.contributes.commands as Array<{ command: string; title: string }>).find(
      (c) => c.command === clearEntry!.command
    );
    expect(clearCommand).toBeDefined();
    expect(tooltip).toContain(clearCommand!.title);
    expect(tooltip).not.toContain("Filter Connectivity Hub");
    expect(tooltip).not.toMatch(/Run “Nexus:/);
  });

  it("shows no no-matches row while the filter still matches", () => {
    const provider = new NexusTreeProvider(callbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [makeServer({ id: "s1", name: "Prod API" })]
    });

    provider.setFilter("prod");

    const rootChildren = provider.getChildren(undefined);
    expect(rootChildren.some((c) => c instanceof NoMatchesTreeItem)).toBe(false);
    expect(rootChildren.length).toBeGreaterThan(0);
  });

  it("clearing a no-match filter removes the no-matches row", () => {
    const provider = new NexusTreeProvider(callbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [makeServer({ id: "s1", name: "Prod API" })]
    });

    provider.setFilter("zzz-no-match");
    expect(provider.getChildren(undefined).some((c) => c instanceof NoMatchesTreeItem)).toBe(true);

    provider.clearFilter();
    // The unfiltered view is restored: the real profile is back, the marker is gone.
    const restored = provider.getChildren(undefined);
    expect(restored.some((c) => c instanceof NoMatchesTreeItem)).toBe(false);
    expect(restored).toHaveLength(1);
  });

  it("keeps a genuinely empty hub at zero rows so the welcome view still renders", () => {
    // No filter, no profiles at all: zero root children is what makes VS Code
    // show the viewsWelcome onboarding ("Start by adding a connection
    // profile…") — the marker row must never appear in its place.
    const provider = new NexusTreeProvider(callbacks);
    provider.setSnapshot({ ...emptySnapshot() });

    expect(provider.getChildren(undefined)).toEqual([]);
  });

  it("keeps the welcome view when the hub is genuinely empty even with a filter set", () => {
    // The state is reachable without any wipe path: the Filter action is
    // offered unconditionally (package.json title bar and palette), so a user
    // with zero profiles can submit a query and set the filter over an empty
    // hub. The filter is then hiding nothing that exists — the onboarding is
    // the honest view. The guard answers by re-reading the root with the
    // filter lifted: only a hub with SOMETHING gets the marker row.
    const provider = new NexusTreeProvider(callbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [makeServer({ id: "s1", name: "Prod API" })]
    });
    provider.setFilter("zzz-no-match");
    expect(provider.getChildren(undefined).some((c) => c instanceof NoMatchesTreeItem)).toBe(true);

    // Config emptied underneath the still-set filter (delete-all, a complete
    // reset that predates the wipe-path clearing, an import replace).
    provider.setSnapshot({ ...emptySnapshot() });
    expect(provider.getChildren(undefined)).toEqual([]);
  });

  it("restores the filter even when the unfiltered re-read throws", () => {
    // The temporary filter lift in the guard must be exception-safe: a
    // transient throw while materializing the unfiltered read would otherwise
    // strand filterText at "" — the tree silently flips unfiltered,
    // getFilterText() loses the query, and the independently maintained
    // nexus.filterActive context can still show the Clear Filter icon.
    const provider = new NexusTreeProvider(callbacks);
    provider.setSnapshot({
      ...emptySnapshot(),
      servers: [makeServer({ id: "s1", name: "Prod API" })]
    });
    provider.setFilter("zzz-no-match");

    const original = provider["getFolderChildren"].bind(provider);
    let calls = 0;
    provider["getFolderChildren"] = (parentPath?: string) => {
      calls += 1;
      if (calls >= 2) {
        throw new Error("transient read failure");
      }
      return original(parentPath);
    };

    expect(() => provider.getChildren(undefined)).toThrow("transient read failure");
    expect(provider.getFilterText()).toBe("zzz-no-match");
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
    inventorySources: [] as any[],
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

/**
 * NODE CONTROL (Phase 4, task #28; provider-general since Task 9) — a synced
 * server whose origin's provider can control nodes (implements `controlNode`)
 * and whose running/stopped state is KNOWN gets a `.nodeRunning` / `.nodeStopped`
 * marker APPENDED (after any `.ipmi`), so the Start/Stop Node menu entries can
 * be gated by state. The marker is emitted ONLY for a control-capable origin
 * with a known status: a server whose provider has no controlNode (even one
 * that somehow carries a status) and a freshly-synced node with no status yet
 * get NOTHING — the status arrives with the next sync or refresh, so we never
 * offer an
 * action blind. The final constructor arg carries the caller-resolved "this
 * origin's provider has node control" signal. The marker is named for the
 * MECHANISM, not for a provider: it is stamped for any provider implementing
 * `controlNode`, so `.nodeRunning` / `.nodeStopped` reads correctly on an
 * EVE-NG lab node and a Proxmox guest alike.
 */
describe("ServerTreeItem node-control contextValue marker", () => {
  // Positional args: (server, connected, lookup, showDesc, authName, authUser,
  // syncedName, ipmiAuthName, status, hasNodeControl).
  function item(
    opts: { connected?: boolean; ipmiHost?: string; status?: "running" | "stopped"; hasNodeControl?: boolean } = {}
  ): ServerTreeItem {
    return new ServerTreeItem(
      makeServer({ id: "s", ...(opts.ipmiHost ? { ipmiHost: opts.ipmiHost } : {}) }),
      opts.connected ?? false,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      opts.status,
      opts.hasNodeControl
    );
  }

  it("appends .nodeRunning for a control-capable RUNNING server and .nodeStopped for a stopped one (⊘ no marker means Start/Stop can never be gated by state)", () => {
    expect(item({ hasNodeControl: true, status: "running" }).contextValue).toBe("nexus.server.nodeRunning");
    expect(item({ hasNodeControl: true, status: "stopped" }).contextValue).toBe("nexus.server.nodeStopped");
  });

  it("emits NO marker for a control-capable server whose status is UNKNOWN (⊘ offering Start/Stop before a status refresh acts blind)", () => {
    expect(item({ hasNodeControl: true, status: undefined }).contextValue).toBe("nexus.server");
  });

  it("emits NO marker for a server WITHOUT node control even when a status is somehow set (⊘ a status dot on a NetBox server must never light up node control it does not support)", () => {
    expect(item({ hasNodeControl: false, status: "running" }).contextValue).toBe("nexus.server");
    expect(item({ hasNodeControl: undefined, status: "stopped" }).contextValue).toBe("nexus.server");
  });

  it("composes with .ipmi in the fixed order nexus.server[.ipmi][.nodeRunning|.nodeStopped] (⊘ a wrong order or a dropped .ipmi breaks the BMC and node-control gates simultaneously)", () => {
    expect(item({ hasNodeControl: true, status: "running", ipmiHost: "10.0.0.9" }).contextValue).toBe("nexus.server.ipmi.nodeRunning");
    expect(item({ hasNodeControl: true, status: "stopped", ipmiHost: "10.0.0.9" }).contextValue).toBe("nexus.server.ipmi.nodeStopped");
  });

  it("composes with the connected base string (⊘ a connected running node must still expose Stop)", () => {
    expect(item({ connected: true, hasNodeControl: true, status: "running" }).contextValue).toBe("nexus.serverConnected.nodeRunning");
    expect(item({ connected: true, hasNodeControl: true, status: "stopped", ipmiHost: "10.0.0.9" }).contextValue).toBe(
      "nexus.serverConnected.ipmi.nodeStopped"
    );
  });

  /**
   * WEB CONSOLE — the `.webConsole` marker is CAPABILITY-gated and deliberately
   * STATUS-INDEPENDENT, which is the whole point of the feature: an addressless,
   * unpolled guest is exactly the row that needs its hypervisor's console, and a
   * stopped guest's console page is the hypervisor's own honest answer. It sits
   * LAST in the fixed order `nexus.server[Connected][.ipmi][.node*][.webConsole]`.
   */
  describe("the web-console marker", () => {
    function webItem(
      opts: {
        connected?: boolean;
        ipmiHost?: string;
        status?: "running" | "stopped";
        hasNodeControl?: boolean;
        hasWebConsole?: boolean;
      } = {}
    ): ServerTreeItem {
      return new ServerTreeItem(
        makeServer({ id: "s", ...(opts.ipmiHost ? { ipmiHost: opts.ipmiHost } : {}) }),
        opts.connected ?? false,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        opts.status,
        opts.hasNodeControl,
        opts.hasWebConsole
      );
    }

    it("appends .webConsole for a web-console-capable server with NO status at all (⊘ a status-gated marker hides the console from the addressless, unpolled guest the feature exists for)", () => {
      expect(webItem({ hasWebConsole: true }).contextValue).toBe("nexus.server.webConsole");
      expect(webItem({ hasWebConsole: true, status: "stopped" }).contextValue).toBe("nexus.server.webConsole");
    });

    it("emits NO marker without the capability (⊘ a default-true gate offers Open Web Console on every NetBox row and every hand-made server)", () => {
      expect(webItem({}).contextValue).toBe("nexus.server");
      expect(webItem({ hasWebConsole: false, status: "running" }).contextValue).toBe("nexus.server");
    });

    it("sits LAST in the fixed order, after .ipmi and the node-state marker (⊘ any other position makes every anchored server-menu regex miss the row)", () => {
      expect(webItem({ hasWebConsole: true, ipmiHost: "10.0.0.9" }).contextValue).toBe("nexus.server.ipmi.webConsole");
      expect(webItem({ hasWebConsole: true, hasNodeControl: true, status: "running" }).contextValue).toBe(
        "nexus.server.nodeRunning.webConsole"
      );
      expect(
        webItem({ connected: true, hasWebConsole: true, hasNodeControl: true, status: "stopped", ipmiHost: "10.0.0.9" })
          .contextValue
      ).toBe("nexus.serverConnected.ipmi.nodeStopped.webConsole");
    });
  });
});

// SHARED by both marker-wiring describes below (node control and web console):
// one snapshot-driven NexusTreeProvider plus a by-id row lookup, so the two
// capability gates are exercised through the same real `getChildren` path.
function providerWith(
  servers: ServerConfig[],
  inventorySources: Array<{ id: string; providerId: string; name: string }>,
  serverStatus: Map<string, "running" | "stopped">,
  originHasNodeControl?: (providerId: string, externalId: string) => boolean,
  originHasWebConsole?: (providerId: string, externalId: string) => boolean
): NexusTreeProvider {
  const provider = new NexusTreeProvider(noopCallbacks, originHasNodeControl, originHasWebConsole);
  provider.setSnapshot({
    ...emptySnapshot(),
    servers,
    inventorySources: inventorySources.map((s) => ({
      ...s,
      targetFolder: "",
      prunePolicy: "orphan",
      defaultUsername: "admin",
      config: {},
      secretFieldIds: []
    })),
    serverStatus
  } as any);
  return provider;
}

function serverItemById(provider: NexusTreeProvider, id: string): ServerTreeItem {
  const children = provider.getChildren(undefined) as ServerTreeItem[];
  return children.find((c) => c instanceof ServerTreeItem && c.server.id === id) as ServerTreeItem;
}

/**
 * NODE CONTROL (Phase 4, task #28; provider-general since Task 9) — P2 review
 * finding. The direct-constructor tests above pin the marker COMPOSITION but
 * never exercise the SNAPSHOT WIRING that decides `hasNodeControl`: the
 * resolution `snapshot.inventorySources` → origin.sourceId → the injected
 * `originHasNodeControl` predicate → constructor arg lives in `toServerItem`,
 * and without a `getChildren`/`toServerItem` end-to-end test it is entirely
 * unpinned. These tests drive the provider from a real snapshot so the
 * following feature-killing mutations each DIE here:
 *   - the gate hard-coded back to `providerId === "eve-ng"` (a Proxmox guest
 *     loses its marker → Start/Stop dead in the UI for every non-EVE provider),
 *   - the gate ignoring the predicate (any synced origin, e.g. NetBox, lights
 *     up node control it does not support),
 *   - the gate ignoring the DEVICE half of the predicate (a Proxmox-origin
 *     `node/<name>` externalId lights up Start/Stop — an action the provider's
 *     own controlNode always refuses),
 *   - the fail-closed default flipped (a tree built without the predicate
 *     offers node control everywhere, acting blind),
 *   - the predicate/constructor arg dropped at the ServerTreeItem call
 *     (defaults to false) → marker never reaches the item.
 */
describe("NexusTreeProvider node-control marker — end-to-end snapshot wiring", () => {
  it("resolves an eve-ng inventory source through origin.sourceId → predicate → .nodeRunning / .nodeStopped from serverStatus (⊘ a broken resolution, a typo'd 'eve-ng' literal in the fixture or predicate, or a dropped constructor arg leaves the EVE node with no node-control marker)", () => {
    const provider = providerWith(
      [
        makeServer({ id: "run", name: "R1", origin: { sourceId: "eve-src", externalId: "/Lab.unl#1", syncedAt: 1 } }),
        makeServer({ id: "stop", name: "R2", origin: { sourceId: "eve-src", externalId: "/Lab.unl#2", syncedAt: 1 } })
      ],
      [{ id: "eve-src", providerId: "eve-ng", name: "My EVE" }],
      new Map<string, "running" | "stopped">([
        ["run", "running"],
        ["stop", "stopped"]
      ]),
      (providerId) => providerId === "eve-ng"
    );
    expect(serverItemById(provider, "run").contextValue).toBe("nexus.server.nodeRunning");
    expect(serverItemById(provider, "stop").contextValue).toBe("nexus.server.nodeStopped");
  });

  it("stamps the SAME marker for a Proxmox-origin guest whose provider has controlNode (⊘ re-hard-coding the gate to 'eve-ng' strands the implemented Proxmox controlNode behind no menu ever)", () => {
    const provider = providerWith(
      [
        makeServer({ id: "pve-run", name: "VM 105", origin: { sourceId: "pve-src", externalId: "105", syncedAt: 1 } }),
        makeServer({ id: "pve-stop", name: "VM 114", origin: { sourceId: "pve-src", externalId: "114", syncedAt: 1 } })
      ],
      [{ id: "pve-src", providerId: "proxmox", name: "My PVE" }],
      new Map<string, "running" | "stopped">([
        ["pve-run", "running"],
        ["pve-stop", "stopped"]
      ]),
      (providerId) => providerId === "eve-ng" || providerId === "proxmox"
    );
    expect(serverItemById(provider, "pve-run").contextValue).toBe("nexus.server.nodeRunning");
    expect(serverItemById(provider, "pve-stop").contextValue).toBe("nexus.server.nodeStopped");
    // The tooltip's status line follows the same predicate (Task 9) — a
    // Proxmox guest gets the identical line an EVE node has always had.
    expect(serverItemById(provider, "pve-run").tooltip).toContain("Status: running");
  });

  it("gates the marker DEVICE-AWARE within one provider: a Proxmox-origin cluster node (externalId node/pve) with a KNOWN status gets NO marker while a bare-vmid guest with the same status does (⊘ a capability-only gate stamps Start/Stop onto a hypervisor node — the provider's own controlNode refuses node/<name> with a protocol error — and the node keeps its running/offline decoration, which the status description and icon drive independently of the marker)", () => {
    const provider = providerWith(
      [
        makeServer({ id: "pve-node", name: "pve", origin: { sourceId: "pve-src", externalId: "node/pve", syncedAt: 1 } }),
        makeServer({ id: "pve-guest", name: "VM 105", origin: { sourceId: "pve-src", externalId: "105", syncedAt: 1 } })
      ],
      [{ id: "pve-src", providerId: "proxmox", name: "My PVE" }],
      new Map<string, "running" | "stopped">([
        ["pve-node", "running"],
        ["pve-guest", "running"]
      ]),
      (providerId, externalId) => providerId === "proxmox" && /^\d+$/.test(externalId)
    );
    expect(serverItemById(provider, "pve-node").contextValue).toBe("nexus.server");
    expect(serverItemById(provider, "pve-guest").contextValue).toBe("nexus.server.nodeRunning");
  });

  it("emits NO marker for a control-capable origin whose status is UNKNOWN (⊘ the never-act-blind rule must survive the generalization)", () => {
    const provider = providerWith(
      [makeServer({ id: "pve-new", name: "VM 120", origin: { sourceId: "pve-src", externalId: "120", syncedAt: 1 } })],
      [{ id: "pve-src", providerId: "proxmox", name: "My PVE" }],
      new Map<string, "running" | "stopped">(),
      (providerId) => providerId === "proxmox"
    );
    expect(serverItemById(provider, "pve-new").contextValue).toBe("nexus.server");
  });

  it("emits NO marker when NO predicate was injected, even for an eve-ng source (⊘ the fail-closed default must hold: a tree built without the predicate never acts blind)", () => {
    const provider = providerWith(
      [makeServer({ id: "eve", name: "R1", origin: { sourceId: "eve-src", externalId: "/Lab.unl#1", syncedAt: 1 } })],
      [{ id: "eve-src", providerId: "eve-ng", name: "My EVE" }],
      new Map<string, "running" | "stopped">([["eve", "running"]])
    );
    expect(serverItemById(provider, "eve").contextValue).toBe("nexus.server");
  });

  it("emits NO marker for a NON-eve-ng (e.g. netbox) source even when serverStatus carries a state and a predicate is present but false for it (⊘ a gate that ignores the predicate lights up node control on a NetBox-origin server that has no controlNode)", () => {
    const provider = providerWith(
      [makeServer({ id: "nb", name: "N1", origin: { sourceId: "nb-src", externalId: "device:1", syncedAt: 1 } })],
      [{ id: "nb-src", providerId: "netbox", name: "My NetBox" }],
      new Map<string, "running" | "stopped">([["nb", "running"]]),
      (providerId) => providerId === "eve-ng"
    );
    expect(serverItemById(provider, "nb").contextValue).toBe("nexus.server");
  });

  it("survives a THROWING predicate: the row renders with NO marker (fail-closed) and getChildren still returns the tree (⊘ the predicate runs synchronously inside getChildren/toServerItem — an exception would abort the whole Command Center render, not just one row)", () => {
    const provider = providerWith(
      [makeServer({ id: "px", name: "P1", origin: { sourceId: "px-src", externalId: "105", syncedAt: 1 } })],
      [{ id: "px-src", providerId: "proxmox", name: "My PVE" }],
      new Map<string, "running" | "stopped">([["px", "running"]]),
      () => {
        throw new TypeError("faulty third-party capability check");
      }
    );
    const children = provider.getChildren(undefined) as ServerTreeItem[];
    expect(children.length).toBeGreaterThan(0);
    expect(serverItemById(provider, "px").contextValue).toBe("nexus.server");
  });
});

/**
 * LATE PROVIDER REGISTRATION — the two marker gates above answer from the LIVE
 * provider registry at paint time, and a third-party provider registers through
 * the public API whenever its own extension activates, which can be long after
 * the Command Center has painted. VS Code re-asks a tree provider for its items
 * only after `onDidChangeTreeData` fires, so these drive the tree the way VS
 * Code does — the assertion is on what the LAST notified paint produced, not on
 * what a fresh out-of-band `getChildren` would return.
 *
 * This mirrors extension.ts's wiring: the same two predicate closures, over one
 * registry, repainted from `registry.onDidChange`. The markers gate menu
 * entries whose commands are hidden from the palette (they name a row), so a
 * row that never gets restamped has no other route to Start/Stop or Open Web
 * Console at all.
 */
describe("NexusTreeProvider capability markers follow the registry after the first paint", () => {
  function lateProvider(): InventoryProvider {
    return {
      id: "late-pve",
      label: "Late PVE",
      configFields: [],
      testConnection: async () => {},
      fetchInventory: async () => ({ contractVersion: 1, devices: [] }),
      controlNode: async () => {},
      webConsoleUrl: async () => "https://pve.invalid/"
    };
  }

  /**
   * The tree extension.ts builds, plus the paint-on-notify loop VS Code runs:
   * `lastPainted()` is only ever updated from an `onDidChangeTreeData` event.
   */
  function wiredTree(registry: InventoryProviderRegistry) {
    const snapshot = {
      ...emptySnapshot(),
      servers: [makeServer({ id: "vm", name: "VM 105", origin: { sourceId: "src", externalId: "105", syncedAt: 1 } })],
      inventorySources: [
        {
          id: "src",
          providerId: "late-pve",
          name: "Late PVE",
          targetFolder: "",
          prunePolicy: "orphan",
          defaultUsername: "admin",
          config: {},
          secretFieldIds: []
        }
      ],
      serverStatus: new Map<string, "running" | "stopped">([["vm", "running"]])
    } as any;

    const tree = new NexusTreeProvider(
      noopCallbacks,
      (providerId, externalId) => {
        const provider = registry.get(providerId);
        return provider !== undefined && provider.controlNode !== undefined && (provider.canControlNode?.(externalId) ?? true);
      },
      (providerId, externalId) => {
        const provider = registry.get(providerId);
        return provider !== undefined && provider.webConsoleUrl !== undefined && (provider.canWebConsole?.(externalId) ?? true);
      }
    );

    let painted: string | undefined;
    tree.onDidChangeTreeData(() => {
      painted = serverItemById(tree, "vm").contextValue;
    });
    const unsubscribe = registry.onDidChange(() => tree.setSnapshot(snapshot));
    tree.setSnapshot(snapshot);
    return { lastPainted: () => painted, unsubscribe };
  }

  it("stamps .nodeRunning and .webConsole on a row painted BEFORE the provider registered (⊘ a registry with no registration event never repaints the row, and both menu entries stay unreachable for the rest of the session)", () => {
    const registry = new InventoryProviderRegistry();
    const { lastPainted, unsubscribe } = wiredTree(registry);
    expect(lastPainted()).toBe("nexus.server");

    registry.register(lateProvider());

    expect(lastPainted()).toBe("nexus.server.nodeRunning.webConsole");
    unsubscribe();
  });

  it("clears both markers when the registration is disposed (⊘ the same staleness the other way: the row keeps offering Start/Stop and Open Web Console after the provider backing them is gone)", () => {
    const registry = new InventoryProviderRegistry();
    const registration = registry.register(lateProvider());
    const { lastPainted, unsubscribe } = wiredTree(registry);
    expect(lastPainted()).toBe("nexus.server.nodeRunning.webConsole");

    registration.dispose();

    expect(lastPainted()).toBe("nexus.server");
    unsubscribe();
  });
});

/**
 * WEB CONSOLE — the `.webConsole` marker's SNAPSHOT WIRING, the twin of the
 * node-control block above: `snapshot.inventorySources` → origin.sourceId → the
 * injected `originHasWebConsole` predicate → constructor arg. The predicate
 * carries BOTH halves of the capability (does this provider implement
 * `webConsoleUrl` at all, and does it apply to THIS device), so these drive it
 * from a real snapshot and kill:
 *   - a status gate creeping in (the addressless, unpolled guest is precisely
 *     the row the console exists for),
 *   - the gate ignoring the predicate (a NetBox row offering a console its
 *     provider cannot produce),
 *   - the DEVICE half ignored (a Proxmox cluster node offered a guest's noVNC
 *     console, which its provider's own webConsoleUrl refuses outright),
 *   - the fail-closed default flipped (a tree built without the predicate
 *     offering the console everywhere),
 *   - the predicate/constructor arg dropped at the ServerTreeItem call.
 */
describe("NexusTreeProvider web-console marker — end-to-end snapshot wiring", () => {
  it("stamps .webConsole on a capable origin's row with NO status and no node control (⊘ a status-gated or control-coupled marker strands exactly the addressless guest the console is for)", () => {
    const provider = providerWith(
      [makeServer({ id: "pve-guest", name: "VM 105", origin: { sourceId: "pve-src", externalId: "105", syncedAt: 1 } })],
      [{ id: "pve-src", providerId: "proxmox", name: "My PVE" }],
      new Map<string, "running" | "stopped">(),
      undefined,
      (providerId) => providerId === "proxmox"
    );
    expect(serverItemById(provider, "pve-guest").contextValue).toBe("nexus.server.webConsole");
  });

  it("composes with the node-state marker on one row (⊘ the two gates sharing a slot, or the wrong order, makes every anchored menu regex miss a row that has both)", () => {
    const provider = providerWith(
      [makeServer({ id: "pve-run", name: "VM 105", origin: { sourceId: "pve-src", externalId: "105", syncedAt: 1 } })],
      [{ id: "pve-src", providerId: "proxmox", name: "My PVE" }],
      new Map<string, "running" | "stopped">([["pve-run", "running"]]),
      (providerId) => providerId === "proxmox",
      (providerId) => providerId === "proxmox"
    );
    expect(serverItemById(provider, "pve-run").contextValue).toBe("nexus.server.nodeRunning.webConsole");
  });

  it("emits NO marker for a netbox-origin row even with a node-control predicate present (⊘ a gate that ignores the web-console predicate offers a console no provider can produce)", () => {
    const provider = providerWith(
      [makeServer({ id: "nb", name: "N1", origin: { sourceId: "nb-src", externalId: "device:1", syncedAt: 1 } })],
      [{ id: "nb-src", providerId: "netbox", name: "My NetBox" }],
      new Map<string, "running" | "stopped">(),
      () => true,
      (providerId) => providerId === "proxmox"
    );
    expect(serverItemById(provider, "nb").contextValue).toBe("nexus.server");
  });

  it("emits NO marker when NO web-console predicate was injected (⊘ the fail-closed default must hold: a tree built without it never offers a console it cannot back)", () => {
    const provider = providerWith(
      [makeServer({ id: "pve-guest", name: "VM 105", origin: { sourceId: "pve-src", externalId: "105", syncedAt: 1 } })],
      [{ id: "pve-src", providerId: "proxmox", name: "My PVE" }],
      new Map<string, "running" | "stopped">([["pve-guest", "running"]]),
      (providerId) => providerId === "proxmox"
    );
    expect(serverItemById(provider, "pve-guest").contextValue).toBe("nexus.server.nodeRunning");
  });

  it("gates DEVICE-AWARE within one provider: a Proxmox cluster node (externalId node/pve) gets NO marker while a bare-vmid guest on the same source does (⊘ a provider-only gate offers a guest's noVNC console on a hypervisor node, which webConsoleUrl refuses outright)", () => {
    const provider = providerWith(
      [
        makeServer({ id: "pve-node", name: "pve", origin: { sourceId: "pve-src", externalId: "node/pve", syncedAt: 1 } }),
        makeServer({ id: "pve-guest", name: "VM 105", origin: { sourceId: "pve-src", externalId: "105", syncedAt: 1 } })
      ],
      [{ id: "pve-src", providerId: "proxmox", name: "My PVE" }],
      new Map<string, "running" | "stopped">(),
      undefined,
      (providerId, externalId) => providerId === "proxmox" && /^\d+$/.test(externalId)
    );
    expect(serverItemById(provider, "pve-node").contextValue).toBe("nexus.server");
    expect(serverItemById(provider, "pve-guest").contextValue).toBe("nexus.server.webConsole");
  });

  it("survives a THROWING predicate: the row renders with NO marker and getChildren still returns the tree (⊘ the predicate runs synchronously inside getChildren — an exception would abort the whole Command Center render, not just one row)", () => {
    const provider = providerWith(
      [makeServer({ id: "px", name: "P1", origin: { sourceId: "px-src", externalId: "105", syncedAt: 1 } })],
      [{ id: "px-src", providerId: "proxmox", name: "My PVE" }],
      new Map<string, "running" | "stopped">(),
      undefined,
      () => {
        throw new TypeError("faulty third-party capability check");
      }
    );
    const children = provider.getChildren(undefined) as ServerTreeItem[];
    expect(children.length).toBeGreaterThan(0);
    expect(serverItemById(provider, "px").contextValue).toBe("nexus.server");
  });
});

/**
 * NODE CONTROL (Phase 4, task #28; provider-general since Task 9) — M3. A
 * node-control-capable origin's row carries a labeled "Status:" line, so the
 * state the Start/Stop gate reads is visible on the row itself. Rows whose
 * provider has no node control get no such line. hasNodeControl is the final
 * constructor arg.
 */
describe("ServerTreeItem status tooltip line", () => {
  function tip(opts: { status?: "running" | "stopped"; hasNodeControl?: boolean }): string {
    return new ServerTreeItem(
      makeServer({ id: "s", origin: { sourceId: "eve", externalId: "/L.unl#1", syncedAt: 1 } }),
      false, undefined, true, undefined, undefined, undefined, undefined, opts.status, opts.hasNodeControl
    ).tooltip as string;
  }

  it("shows 'Status: running' for a running node on a control-capable origin (⊘ no status line leaves running/stopped undiscoverable in the tooltip)", () => {
    expect(tip({ hasNodeControl: true, status: "running" })).toContain("Status: running");
  });

  it("shows 'Status: stopped' for a stopped node", () => {
    expect(tip({ hasNodeControl: true, status: "stopped" })).toContain("Status: stopped");
  });

  it("shows a bare 'Status: unknown' for a freshly-synced node with no status yet, with NO command hint (⊘ pointing at Refresh Inventory Status is stale advice for BOTH providers now that either sync carries status, and it names a lab a Proxmox cluster does not have)", () => {
    expect(tip({ hasNodeControl: true, status: undefined })).toContain("Status: unknown");
    expect(tip({ hasNodeControl: true, status: undefined })).not.toContain("Refresh Inventory Status");
    // The RETIRED title too: the hint this pins came back twice, and a guard
    // that only knows the current name stops catching a verbatim restore of
    // the old sentence.
    expect(tip({ hasNodeControl: true, status: undefined })).not.toContain("Refresh Lab Status");
    expect(tip({ hasNodeControl: true, status: undefined })).not.toContain("Lab status");
  });

  it("adds NO status line for a server without node control even when a status is set (⊘ a Status line on a NetBox server claims a running/stopped notion its provider never reports)", () => {
    expect(tip({ hasNodeControl: false, status: "running" })).not.toContain("Status:");
  });
});

/**
 * NODE CONTROL (Phase 4, task #28) — M4. Stopped-ness is now load-bearing (it is
 * the premise for "Start Node"), so a stopped node gets an explicit
 * " (stopped)" description suffix mirroring the existing " (running)". A node
 * with no status still gets neither.
 */
describe("ServerTreeItem stopped description suffix", () => {
  function desc(status: "running" | "stopped" | undefined): string | undefined {
    return new ServerTreeItem(makeServer({ id: "s" }), false, undefined, true, undefined, undefined, undefined, undefined, status)
      .description;
  }

  it("appends ' (running)' for a running node and ' (stopped)' for a stopped node (⊘ no stopped suffix leaves a connected+stopped row showing a green plug and a Start menu with no state text)", () => {
    expect(desc("running")).toContain("(running)");
    expect(desc("stopped")).toContain("(stopped)");
    // The two states must be distinct — a stopped node must NOT read as running.
    expect(desc("stopped")).not.toContain("(running)");
  });

  it("appends NEITHER suffix for a node with no status (⊘ a state suffix on a non-status server invents state it lacks)", () => {
    expect(desc(undefined)).not.toContain("(running)");
    expect(desc(undefined)).not.toContain("(stopped)");
  });
});

/**
 * PER-SOURCE SYNC ON THE FOLDER ROW (follow-up #43) — a Command Center folder
 * that is EXACTLY ONE inventory source's `targetFolder` carries an inline sync
 * action for that source, so syncing one source does not mean opening Settings.
 * The row advertises it with a `.syncSource` marker on its `contextValue` and
 * carries the source id the command needs.
 *
 * "EXACTLY ONE" is the whole rule: two sources sharing a target folder make the
 * icon ambiguous (which one would it sync?), so the marker is withheld rather
 * than guessed at.
 */
describe("NexusTreeProvider — the inline sync action on a source's target folder", () => {
  function source(id: string, targetFolder: string, name = id) {
    return { id, providerId: "eve-ng", name, targetFolder, prunePolicy: "orphan", defaultUsername: "admin", config: {}, secretFieldIds: [] };
  }

  function foldersOf(servers: ServerConfig[], inventorySources: unknown[]): Map<string, FolderTreeItem> {
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({ ...emptySnapshot(), servers, inventorySources } as any);
    const found = new Map<string, FolderTreeItem>();
    const walk = (parent: FolderTreeItem | undefined): void => {
      for (const child of provider.getChildren(parent) as FolderTreeItem[]) {
        if (child instanceof FolderTreeItem) {
          found.set(child.folderPath, child);
          walk(child);
        }
      }
    };
    walk(undefined);
    return found;
  }

  it("marks the folder a single source targets, and hangs that source's id on the row so the command receives it (⊘ no marker means no inline icon at all, and no sourceId means the icon opens a picker instead of syncing the source the user clicked)", () => {
    const folders = foldersOf([makeServer({ id: "s1", group: "Lab" })], [source("src-1", "Lab", "My Lab")]);
    const lab = folders.get("Lab")!;
    expect(lab.contextValue).toBe("nexus.folderWithServers.syncSource");
    expect(lab.sourceId).toBe("src-1");
  });

  it("marks a source's target folder that holds no servers directly, keeping the folder/folderWithServers distinction intact (⊘ a marker shape that only composes with one of the two silently drops the icon from every lab-tree parent folder)", () => {
    // "Lab" is an ancestor only — its servers live in "Lab/Site".
    const folders = foldersOf([makeServer({ id: "s1", group: "Lab/Site" })], [source("src-1", "Lab")]);
    expect(folders.get("Lab")!.contextValue).toBe("nexus.folder.syncSource");
    expect(folders.get("Lab")!.sourceId).toBe("src-1");
  });

  it("marks NEITHER when two sources share one targetFolder — ambiguous, so no guess (⊘ a `find`/`some` implementation picks whichever source is listed first and syncs the wrong one, silently, forever)", () => {
    const folders = foldersOf([makeServer({ id: "s1", group: "Shared" })], [source("src-1", "Shared", "A"), source("src-2", "Shared", "B")]);
    expect(folders.get("Shared")!.contextValue).toBe("nexus.folderWithServers");
    expect(folders.get("Shared")!.sourceId).toBeUndefined();
  });

  it("leaves an UNRELATED folder, and a folder NESTED INSIDE a target, unmarked (⊘ a descendant test instead of an equality test puts a sync icon on every lab folder under the target, each claiming to sync the whole source)", () => {
    const folders = foldersOf(
      [makeServer({ id: "s1", group: "Lab/Inner" }), makeServer({ id: "s2", group: "Elsewhere" })],
      [source("src-1", "Lab")]
    );
    expect(folders.get("Lab")!.contextValue).toBe("nexus.folder.syncSource");
    expect(folders.get("Lab/Inner")!.contextValue).toBe("nexus.folderWithServers");
    expect(folders.get("Lab/Inner")!.sourceId).toBeUndefined();
    expect(folders.get("Elsewhere")!.contextValue).toBe("nexus.folderWithServers");
    expect(folders.get("Elsewhere")!.sourceId).toBeUndefined();
  });

  it("marks NOTHING for a source targeting the ROOT (`targetFolder: \"\"`) — there is no folder row to host the icon (⊘ a `startsWith` prefix match instead of an equality test makes the empty string match EVERY folder path in the tree, so a root-targeted source stamps a sync icon on all of them)", () => {
    const folders = foldersOf([makeServer({ id: "s1", group: "Lab" }), makeServer({ id: "s2" })], [source("src-1", "")]);
    expect([...folders.values()].every((f) => f.sourceId === undefined)).toBe(true);
    expect([...folders.values()].every((f) => !String(f.contextValue).includes("syncSource"))).toBe(true);
  });

  // NOT A REGRESSION GUARD, and labelled honestly as such: no plausible
  // implementation of the "exactly one source targets this path" rule fails
  // this, because there is no row to fail on. It documents the tolerance — a
  // targetFolder naming nothing is a no-op rather than an error — and would
  // catch a future version that materialises a phantom folder row purely to
  // host the icon.
  it("tolerates a targetFolder that names no folder in the tree: nothing marked, no row invented, nothing thrown", () => {
    const folders = foldersOf([makeServer({ id: "s1", group: "Lab" })], [source("src-1", "Not/Here")]);
    expect(folders.has("Not/Here")).toBe(false);
    expect(folders.get("Lab")!.contextValue).toBe("nexus.folderWithServers");
  });
});
