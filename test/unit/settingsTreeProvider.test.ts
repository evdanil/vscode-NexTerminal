import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetConfiguration, mockOnDidChangeConfiguration } = vi.hoisted(() => ({
  mockGetConfiguration: vi.fn(),
  mockOnDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() }))
}));

vi.mock("vscode", () => {
  const EventEmitter = vi.fn().mockImplementation(function () {
    const listeners: Array<(e: unknown) => void> = [];
    return {
      event: (listener: (e: unknown) => void) => { listeners.push(listener); },
      fire: (e: unknown) => { for (const l of listeners) { l(e); } },
      dispose: vi.fn(),
      _listeners: listeners
    };
  });
  return {
    TreeItem: class {
      label?: string;
      id?: string;
      description?: string;
      contextValue?: string;
      command?: unknown;
      tooltip?: string;
      iconPath?: unknown;
      collapsibleState?: number;
      constructor(label: string, collapsibleState?: number) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(public id: string) {} },
    EventEmitter,
    workspace: {
      getConfiguration: mockGetConfiguration,
      onDidChangeConfiguration: mockOnDidChangeConfiguration
    }
  };
});

import {
  InventorySourceItem,
  InventorySourcesGroupItem,
  SettingsTreeProvider,
  SettingsCategoryItem,
  SettingsValueItem,
  SettingsLinkItem,
  DataManagementGroupItem,
  DataManagementActionItem
} from "../../src/ui/settingsTreeProvider";

function createProvider(): SettingsTreeProvider {
  return new SettingsTreeProvider();
}

interface FakeSource {
  id: string;
  providerId: string;
  name: string;
  lastSyncAt?: number;
}

/** Minimal NexusCore stand-in: a snapshot plus the onDidChange fan-out. */
function makeCore(sources: FakeSource[]) {
  const listeners: Array<() => void> = [];
  return {
    core: {
      getSnapshot: () => ({ inventorySources: sources }),
      onDidChange: (listener: () => void) => {
        listeners.push(listener);
        return () => {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        };
      }
    },
    fire: () => {
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.length
  };
}

const fakeRegistry = {
  get: (id: string) => (id === "eve-ng" ? { label: "EVE-NG" } : id === "netbox" ? { label: "NetBox" } : undefined)
};

function providerWithSources(sources: FakeSource[]): SettingsTreeProvider {
  const { core } = makeCore(sources);
  return new SettingsTreeProvider(core as never, fakeRegistry as never);
}

function groupChildren(provider: SettingsTreeProvider) {
  const group = provider.getChildren().find((r) => r instanceof InventorySourcesGroupItem)!;
  return provider.getChildren(group);
}

function setupDefaultConfig(): void {
  mockGetConfiguration.mockImplementation(() => ({
    get: (key: string) => {
      const defaults: Record<string, unknown> = {
        sessionTranscripts: true,
        sessionLogDirectory: "",
        maxFileSizeMb: 10,
        maxRotatedFiles: 5,
        enabled: true,
        idleTimeout: 30,
        defaultConnectionMode: "shared",
        defaultBindAddress: "",
        openLocation: "panel",
        keyboardPassthrough: true,
        passthroughKeys: ["b", "e"],
        cacheTtlSeconds: 60,
        maxCacheEntries: 500,
        autoRefreshInterval: 0,
        operationTimeout: 30,
        commandTimeout: 300,
        deleteDepthLimit: 100,
        deleteOperationLimit: 10000
      };
      return defaults[key];
    }
  }));
}

describe("SettingsTreeProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultConfig();
  });

  describe("root items", () => {
    it("returns 18 root items", () => {
      const provider = createProvider();
      const roots = provider.getChildren();
      expect(roots).toHaveLength(18);
    });

    it("has 14 category items first with Security & Data after SSH, then Inventory (Phase 2) and the local/network server categories", () => {
      const provider = createProvider();
      const roots = provider.getChildren();
      const categories = roots.filter((r) => r instanceof SettingsCategoryItem);
      expect(categories).toHaveLength(14);
      expect(categories.map((c) => (c as SettingsCategoryItem).categoryKey))
        .toEqual([
          "logging",
          "ssh",
          "securityData",
          "tunnels",
          "terminal",
          "ui",
          "sftp",
          "serial",
          "scripts",
          "inventory",
          "localServers",
          "networkServers",
          "tftpServer",
          "dhcpServer"
        ]);
    });

    it("has 3 root link items for Macros, Auth Profiles and Device Templates — Inventory Sources is a GROUP now, not a link", () => {
      const provider = createProvider();
      const roots = provider.getChildren();
      const links = roots.filter((r) => r instanceof SettingsLinkItem);
      expect(links).toHaveLength(3);
      expect(links.map((link) => link.label)).toEqual(["Macros", "Auth Profiles", "Device Templates"]);
    });

    // §7 UX-M6 — the Auth Profiles row description no longer says "template" so
    // the word means exactly one thing (the device template) in the product.
    it("describes Auth Profiles as reusable SSH credentials (not a template)", () => {
      const provider = createProvider();
      const links = provider.getChildren().filter((r) => r instanceof SettingsLinkItem) as SettingsLinkItem[];
      const authProfiles = links[1];
      expect(authProfiles.label).toBe("Auth Profiles");
      expect(authProfiles.tooltip).toBe("Create and manage reusable SSH credentials");
    });

    // §7.1 — the Device Templates settings-tree row, beside Auth Profiles.
    it("has a Device Templates link pointing at nexus.deviceTemplate.manage with the layers icon", () => {
      const provider = createProvider();
      const links = provider.getChildren().filter((r) => r instanceof SettingsLinkItem) as SettingsLinkItem[];
      const deviceTemplates = links[2];
      expect(deviceTemplates.label).toBe("Device Templates");
      expect(deviceTemplates.command).toEqual({
        command: "nexus.deviceTemplate.manage",
        title: "Device Templates"
      });
      expect((deviceTemplates.iconPath as { id: string }).id).toBe("layers");
      expect(deviceTemplates.tooltip).toBe("Apply shared settings to servers synced from inventory");
    });

    /**
     * Inventory sources used to be ONE row opening the manage QuickPick — the
     * sources themselves were invisible in the tree, so "which sources do I
     * have, and when did each last sync" needed a modal to answer. The group
     * is provider-agnostic: every row is built from the snapshot, never from a
     * provider-specific branch.
     */
    it("renders Inventory Sources as an expandable group, not a link (\u2298 a link cannot show the sources or carry per-source inline actions)", () => {
      const roots = createProvider().getChildren();
      const group = roots.find((r) => r instanceof InventorySourcesGroupItem) as InventorySourcesGroupItem;
      expect(group).toBeDefined();
      expect(group.label).toBe("Inventory Sources");
      expect(group.collapsibleState).toBe(1);
      expect((group.iconPath as { id: string }).id).toBe("server-environment");
      expect(roots.filter((r) => r instanceof SettingsLinkItem).map((l) => l.label)).not.toContain("Inventory Sources");
    });

    it("does not keep Data Management as a root group", () => {
      const provider = createProvider();
      const roots = provider.getChildren();
      const groups = roots.filter((r) => r instanceof DataManagementGroupItem);
      expect(groups).toHaveLength(0);
    });
  });

  describe("category children", () => {
    it("returns 5 children for logging category", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("logging");
      const children = provider.getChildren(category);
      expect(children).toHaveLength(5);
      expect(children.every((c) => c instanceof SettingsValueItem)).toBe(true);
    });

    it("exposes the opt-in terminal output trace in the logging category", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("logging");
      const children = provider.getChildren(category) as SettingsValueItem[];
      expect(children.some((child) => child.label?.includes("Terminal Output Trace"))).toBe(true);
    });

    it("returns 7 children for ssh category after host trust moves to Security & Data", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("ssh");
      const children = provider.getChildren(category);
      expect(children).toHaveLength(7);
    });

    it("returns Trust New Hosts and Data Management under Security & Data", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("securityData");
      const children = provider.getChildren(category);
      expect(children).toHaveLength(2);
      expect(children[0]).toBeInstanceOf(SettingsValueItem);
      expect(children[0].label).toContain("Trust New Hosts");
      expect(children[1]).toBeInstanceOf(DataManagementGroupItem);
    });

    it("returns 3 children for tunnels category", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("tunnels");
      const children = provider.getChildren(category);
      expect(children).toHaveLength(3);
    });

    it("returns 8 children for terminal when passthrough ON", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("terminal");
      const children = provider.getChildren(category);
      expect(children).toHaveLength(8);
    });

    it("returns 7 children for terminal when passthrough OFF (visibleWhen filtering)", () => {
      mockGetConfiguration.mockImplementation(() => ({
        get: (key: string) => {
          if (key === "keyboardPassthrough") return false;
          if (key === "openLocation") return "panel";
          return undefined;
        }
      }));
      const provider = createProvider();
      const category = new SettingsCategoryItem("terminal");
      const children = provider.getChildren(category);
      expect(children).toHaveLength(7);
    });

    it("returns 11 children for sftp", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("sftp");
      const children = provider.getChildren(category);
      expect(children).toHaveLength(11);
    });

    it("includes the operation timeout setting in the sftp category", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("sftp");
      const children = provider.getChildren(category) as SettingsValueItem[];
      expect(children.some((child) => child.label?.includes("Operation Timeout: 30 seconds"))).toBe(true);
    });

    it("shows formatted values in labels", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("logging");
      const children = provider.getChildren(category) as SettingsValueItem[];
      expect(children[0].label).toContain("ON");
      expect(children[2].label).toContain("10 MB");
    });

    it("uses category descriptions as category tooltips", () => {
      const item = new SettingsCategoryItem("securityData");
      expect(item.tooltip).toContain("credentials");
      expect(item.tooltip).toContain("backups");
    });
  });

  describe("data management actions", () => {
    it("returns 5 data management action items", () => {
      const provider = createProvider();
      const dmGroup = new DataManagementGroupItem();
      const children = provider.getChildren(dmGroup);
      expect(children).toHaveLength(5);
      expect(children.every((c) => c instanceof DataManagementActionItem)).toBe(true);
    });

    // The JSON-only importer and the bulk inventory importer used to be separate
    // rows; the unified chooser (nexus.config.import) now covers both, so there is
    // exactly one Import row and no more nexus.config.import.inventory row here.
    it("offers a single unified Import row instead of separate JSON/inventory rows", () => {
      const provider = createProvider();
      const dmGroup = new DataManagementGroupItem();
      const children = provider.getChildren(dmGroup) as InstanceType<typeof DataManagementActionItem>[];

      const importAction = children.find((c) => c.id === "settings-action:nexus.config.import");
      expect(importAction).toBeDefined();
      expect(importAction?.command).toEqual({
        command: "nexus.config.import",
        title: "Import…"
      });
      expect((importAction?.iconPath as { id: string })?.id).toBe("cloud-download");

      expect(children.find((c) => c.id === "settings-action:nexus.config.import.inventory")).toBeUndefined();
    });
  });

  describe("category items", () => {
    it("has correct context value", () => {
      const item = new SettingsCategoryItem("logging");
      expect(item.contextValue).toBe("nexus.settingsCategory");
    });

    it("has correct command to open panel", () => {
      const item = new SettingsCategoryItem("ssh");
      expect(item.command).toEqual({
        command: "nexus.settings.openPanel",
        title: "Open SSH Settings",
        arguments: ["ssh"]
      });
    });

    it("has correct icon", () => {
      const item = new SettingsCategoryItem("logging");
      expect((item.iconPath as { id: string }).id).toBe("output");
    });
  });

  describe("link items", () => {
    it("has correct command for appearance", () => {
      const item = new SettingsLinkItem("Terminal Appearance", "nexus.terminal.appearance", "paintcan", "tip");
      expect(item.command).toEqual({
        command: "nexus.terminal.appearance",
        title: "Terminal Appearance"
      });
    });
  });

  describe("disposal", () => {
    it("can be disposed without error", () => {
      const provider = createProvider();
      expect(() => provider.dispose()).not.toThrow();
    });
  });

  it("refreshes when highlighting rules change", () => {
    const provider = createProvider();
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);

    const configListener = mockOnDidChangeConfiguration.mock.calls[0][0] as (event: { affectsConfiguration: (key: string) => boolean }) => void;
    configListener({
      affectsConfiguration: (key: string) => key === "nexus.terminal.highlighting.rules"
    });

    expect(listener).toHaveBeenCalledWith(undefined);
  });
  describe("inventory sources group", () => {
    it("lists one row per source, in snapshot order, then a trailing Add row", () => {
      const children = groupChildren(
        providerWithSources([
          { id: "s1", providerId: "netbox", name: "Prod NetBox" },
          { id: "s2", providerId: "eve-ng", name: "Lab" }
        ])
      );
      expect(children.map((c) => c.label)).toEqual(["Prod NetBox", "Lab", "Add Inventory Source\u2026"]);
      expect(children.slice(0, 2).every((c) => c instanceof InventorySourceItem)).toBe(true);
      expect((children[2] as SettingsLinkItem).command).toEqual({
        command: "nexus.inventory.addSource",
        title: "Add Inventory Source\u2026"
      });
    });

    it("keeps the group — and its Add row — when there are no sources at all (\u2298 hiding an empty group is a dead end: the one thing to do here is add the first source)", () => {
      const children = groupChildren(providerWithSources([]));
      expect(children).toHaveLength(1);
      expect(children[0].label).toBe("Add Inventory Source\u2026");
    });

    it("describes a row as \"{provider label} \u2014 {absolute last sync}\", resolving the label through the registry", () => {
      const children = groupChildren(
        providerWithSources([
          { id: "s1", providerId: "eve-ng", name: "Lab", lastSyncAt: Date.now() - 3 * 60 * 60_000 },
          { id: "s2", providerId: "netbox", name: "Prod" }
        ])
      );
      // P2-1 \u2014 the row shows an ABSOLUTE timestamp, not a relative age, so it
      // never freezes at a stale "synced Nh ago" (MINOR-8 suppresses the
      // core-event refresh that a relative label would need).
      expect((children[0] as InventorySourceItem).description).toMatch(/^EVE-NG \u2014 synced \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      // \u2298 A row that omits the never-synced case reads as a source that
      // is up to date, which is the opposite of what it is.
      expect((children[1] as InventorySourceItem).description).toBe("NetBox \u2014 never synced");
    });

    /**
     * P2-1 \u2014 the label must NOT drift as wall-clock time advances. MINOR-8's
     * signature-gated refresh fires only when a source record changes, so a
     * relative "synced Nh ago" would freeze at whatever it first rendered.
     */
    it("keeps the last-sync label stable as the clock advances (\u2298 a relative 'synced Nh ago' reads 'just now' at render and never updates, because no refresh fires until the source next changes)", () => {
      vi.useFakeTimers();
      try {
        const syncedAt = new Date("2026-08-17T04:00:00Z").getTime();
        const sources: FakeSource[] = [{ id: "s1", providerId: "eve-ng", name: "Lab", lastSyncAt: syncedAt }];

        vi.setSystemTime(syncedAt);
        const atSync = (groupChildren(providerWithSources(sources))[0] as InventorySourceItem).description;

        vi.setSystemTime(syncedAt + 10 * 60 * 60_000);
        const tenHoursLater = (groupChildren(providerWithSources(sources))[0] as InventorySourceItem).description;

        expect(atSync).toBe(tenHoursLater);
        expect(atSync).not.toMatch(/ago|just now/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to the raw providerId when the registry cannot resolve it \u2014 a source whose provider extension is not installed still has to be visible and removable", () => {
      const children = groupChildren(providerWithSources([{ id: "s1", providerId: "acme-cmdb", name: "Legacy" }]));
      expect((children[0] as InventorySourceItem).description).toBe("acme-cmdb \u2014 never synced");
    });

    it("opens the editor on click and carries the source id as the command argument, so the click edits THIS source rather than re-prompting (\u2298 an argument-less command falls through to the source picker)", () => {
      const [row] = groupChildren(providerWithSources([{ id: "s1", providerId: "eve-ng", name: "Lab" }])) as InventorySourceItem[];
      expect(row.sourceId).toBe("s1");
      expect(row.command).toEqual({
        command: "nexus.inventory.editSource",
        title: "Edit Inventory Source",
        arguments: ["s1"]
      });
    });

    it("tags each row with the contextValue the inline Sync/Edit/Rules/Remove menu entries key on", () => {
      const [row] = groupChildren(providerWithSources([{ id: "s1", providerId: "eve-ng", name: "Lab" }])) as InventorySourceItem[];
      expect(row.contextValue).toBe("nexus.inventorySource");
      expect((row.iconPath as { id: string }).id).toBe("server-environment");
    });

    it("refreshes when the inventory sources change, so a sync or a removal is reflected without reopening the view", () => {
      const sources: FakeSource[] = [{ id: "s1", providerId: "eve-ng", name: "Lab" }];
      const { core, fire } = makeCore(sources);
      const provider = new SettingsTreeProvider(core as never, fakeRegistry as never);
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      // A source's lastSyncAt is stamped by a sync — a real inventory change.
      sources[0] = { ...sources[0], lastSyncAt: 123 };
      fire();
      expect(listener).toHaveBeenCalledWith(undefined);
    });

    /**
     * MINOR-8 — the provider must NOT re-render on every unrelated core event.
     * Subscribing to the whole `onDidChange` firehose meant a terminal or tunnel
     * blink re-ran `getChildren` (a `getConfiguration` read per settings value
     * row) many times a second while idle.
     */
    it("does NOT refresh when a core event leaves the inventory sources unchanged (⊘ firing on every core event re-renders the whole tree on each terminal/tunnel blink)", () => {
      const sources: FakeSource[] = [{ id: "s1", providerId: "eve-ng", name: "Lab", lastSyncAt: 5 }];
      const { core, fire } = makeCore(sources);
      const provider = new SettingsTreeProvider(core as never, fakeRegistry as never);
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      fire(); // unrelated core change; sources identical
      fire();
      expect(listener).not.toHaveBeenCalled();
    });

    it("unsubscribes from core on dispose (\u2298 an un-disposed listener fires into a dead emitter for the rest of the session)", () => {
      const { core, listenerCount } = makeCore([]);
      const provider = new SettingsTreeProvider(core as never, fakeRegistry as never);
      expect(listenerCount()).toBe(1);
      provider.dispose();
      expect(listenerCount()).toBe(0);
    });

    it("still renders the group with just the Add row when constructed without a core (the web-extension / test construction path)", () => {
      const children = groupChildren(createProvider());
      expect(children.map((c) => c.label)).toEqual(["Add Inventory Source\u2026"]);
    });
  });
});
