import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetConfiguration, mockOnDidChangeConfiguration } = vi.hoisted(() => ({
  mockGetConfiguration: vi.fn(),
  mockOnDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() }))
}));

vi.mock("vscode", () => {
  const EventEmitter = vi.fn().mockImplementation(() => {
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
        autoRefreshInterval: 0
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
    it("returns 9 root items", () => {
      const provider = createProvider();
      const roots = provider.getChildren();
      expect(roots).toHaveLength(9);
    });

    it("has 6 category items first", () => {
      const provider = createProvider();
      const roots = provider.getChildren();
      const categories = roots.filter((r) => r instanceof SettingsCategoryItem);
      expect(categories).toHaveLength(6);
      expect(categories.map((c) => (c as SettingsCategoryItem).categoryKey))
        .toEqual(["logging", "ssh", "tunnels", "terminal", "sftp", "highlighting"]);
    });

    it("has 2 link items for Appearance and Macros", () => {
      const provider = createProvider();
      const roots = provider.getChildren();
      const links = roots.filter((r) => r instanceof SettingsLinkItem);
      expect(links).toHaveLength(2);
      expect(links[0].label).toBe("Terminal Appearance");
      expect(links[1].label).toBe("Macros");
    });

    it("has 1 Data Management group", () => {
      const provider = createProvider();
      const roots = provider.getChildren();
      const groups = roots.filter((r) => r instanceof DataManagementGroupItem);
      expect(groups).toHaveLength(1);
    });
  });

  describe("category children", () => {
    it("returns 4 children for logging category", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("logging");
      const children = provider.getChildren(category);
      expect(children).toHaveLength(4);
      expect(children.every((c) => c instanceof SettingsValueItem)).toBe(true);
    });

    it("returns 2 children for ssh category", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("ssh");
      const children = provider.getChildren(category);
      expect(children).toHaveLength(2);
    });

    it("returns 2 children for tunnels category", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("tunnels");
      const children = provider.getChildren(category);
      expect(children).toHaveLength(2);
    });

    it("returns 3 children for terminal when passthrough ON", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("terminal");
      const children = provider.getChildren(category);
      expect(children).toHaveLength(3);
    });

    it("returns 2 children for terminal when passthrough OFF (visibleWhen filtering)", () => {
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
      expect(children).toHaveLength(2);
    });

    it("returns 3 children for sftp", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("sftp");
      const children = provider.getChildren(category);
      expect(children).toHaveLength(3);
    });

    it("returns 1 child for highlighting", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("highlighting");
      const children = provider.getChildren(category);
      expect(children).toHaveLength(1);
    });

    it("shows formatted values in labels", () => {
      const provider = createProvider();
      const category = new SettingsCategoryItem("logging");
      const children = provider.getChildren(category) as SettingsValueItem[];
      expect(children[0].label).toContain("ON");
      expect(children[2].label).toContain("10 MB");
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
});
