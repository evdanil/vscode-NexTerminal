import { describe, expect, it, vi } from "vitest";

/**
 * PER-SOURCE SYNC ON THE FOLDER ROW (follow-up #43) — THE JOIN, tested end to
 * end rather than assumed.
 *
 * The claim the feature rests on: VS Code hands a `view/item/context` command
 * the TREE ITEM itself (never a string), and `resolveSourceIdArg` reads
 * `sourceId` off an object — so putting a `sourceId` on the folder row is the
 * whole of the wiring for the row's own command, `nexus.inventory.syncFolderSource`.
 * That claim spans two modules that no other test loads together, and it is
 * exactly the kind of thing that reads as obviously true and is off by one
 * property name.
 *
 * The same item is also what VS Code hands the Hub TOOLBAR's Sync Inventory Now
 * (`nexus.inventory.syncNow`) whenever that row was the last one focused — a
 * `view/title` command receives the tree's focused element — so the toolbar id
 * must NOT read it, and the last describe below drives both registered
 * handlers with the real row to hold the two apart.
 *
 * So: build a REAL `FolderTreeItem` through the REAL `NexusTreeProvider`, hand
 * it to the REAL `resolveSourceIdArg` and the REAL registered handlers, and
 * assert which source each one acts on.
 *
 * The `vscode` mock below is the union of what the two modules touch at import
 * and call time — deliberately minimal, and deliberately not shared with the
 * other suites' mocks so neither can drift into covering for this one.
 */
vi.mock("vscode", () => ({
  TreeItem: class {
    public id?: string;
    public tooltip?: string;
    public description?: string;
    public contextValue?: string;
    public iconPath?: unknown;
    public resourceUri?: unknown;
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
    public readonly event = (): void => {};
    public fire(): void {}
    public dispose(): void {}
  },
  Uri: {
    from: (components: { scheme: string; authority?: string; path?: string }) => ({
      scheme: components.scheme,
      authority: components.authority ?? "",
      path: components.path ?? "",
      toString: () => `${components.scheme}://${components.authority ?? ""}${components.path ?? ""}`
    })
  },
  commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })), executeCommand: vi.fn() },
  window: {
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    withProgress: vi.fn(),
    showTextDocument: vi.fn(),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() }))
  },
  workspace: { getConfiguration: vi.fn(() => ({ get: () => undefined })), openTextDocument: vi.fn() },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ViewColumn: { One: 1 }
}));

import * as vscode from "vscode";
import { registerInventoryCommands, resolveSourceIdArg } from "../../src/commands/inventoryCommands";
import { NexusCore } from "../../src/core/nexusCore";
import { InventoryProviderRegistry } from "../../src/services/inventory/providerRegistry";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { FolderTreeItem, NexusTreeProvider } from "../../src/ui/nexusTreeProvider";
import { InventorySourceItem } from "../../src/ui/settingsTreeProvider";
import type { ServerConfig } from "../../src/models/config";

const noopCallbacks = {
  onTunnelDropped: vi.fn(async () => {}),
  onItemGroupChanged: vi.fn(async () => {}),
  onFolderMoved: vi.fn(async () => {})
};

function server(group: string): ServerConfig {
  return { id: `s-${group}`, name: group, host: "10.0.0.1", port: 22, username: "u", authType: "agent", isHidden: false, group };
}

function source(id: string, targetFolder: string, providerId = "eve-ng") {
  return { id, providerId, name: id, targetFolder, prunePolicy: "orphan" as const, defaultUsername: "admin", config: {}, secretFieldIds: [] };
}

function folderRow(path: string, sources: unknown[]): FolderTreeItem {
  const provider = new NexusTreeProvider(noopCallbacks);
  provider.setSnapshot({
    servers: [server("Lab")],
    tunnels: [],
    serialProfiles: [],
    localShellProfiles: [],
    activeSessions: [],
    activeSerialSessions: [],
    activeLocalShellSessions: [],
    activeTunnels: [],
    remoteTunnels: [],
    explicitGroups: [],
    authProfiles: [],
    inventorySources: sources,
    activitySessionIds: new Set(),
    focusedSessionId: undefined
  } as never);
  const row = (provider.getChildren(undefined) as FolderTreeItem[]).find((c) => c instanceof FolderTreeItem && c.folderPath === path);
  expect(row).toBeDefined();
  return row!;
}

describe("the folder row's inline sync action reaches nexus.inventory.syncFolderSource with the right source", () => {
  it("resolveSourceIdArg pulls the source id straight off the real tree item the menu passes it (⊘ naming the property anything resolveSourceIdArg does not read — `inventorySourceId`, `sourceIds` — makes the icon open the source picker instead of syncing the folder's own source, with no error to say so)", () => {
    const row = folderRow("Lab", [source("src-1", "Lab")]);
    expect(resolveSourceIdArg(row)).toBe("src-1");
  });

  it("resolves to `undefined` — 'ask me' — for an AMBIGUOUS folder that TWO sources target, so a click cannot sync whichever the snapshot happens to list first (⊘ `find`/`some` instead of a count stamps the first source's id on the row and silently syncs the wrong lab on every click)", () => {
    // BOTH sources target the folder the row is actually built for — the row is
    // keyed by the server's group, so pointing them at some other name would
    // make this the "no source targets this folder" case all over again and the
    // ambiguity would never be exercised.
    expect(resolveSourceIdArg(folderRow("Lab", [source("src-1", "Lab"), source("src-2", "Lab")]))).toBeUndefined();
  });

  it("resolves to `undefined` for a folder NO source targets (⊘ a stale id left on an unrelated row would sync a source the user never picked)", () => {
    expect(resolveSourceIdArg(folderRow("Lab", [source("src-1", "Shared")]))).toBeUndefined();
    expect(resolveSourceIdArg(folderRow("Lab", []))).toBeUndefined();
  });
});

/**
 * Which source each registered handler acts on is read off the first thing
 * `syncNow` does with a resolved source: look its provider up. Neither provider
 * is registered, so a handler that resolved a source stops at once with that
 * provider's "not available" error — naming WHICH source it resolved — while a
 * handler that resolved none opens the picker (two sources, so it cannot
 * auto-select) and stops when the picker is dismissed. No sync ever runs.
 */
describe("Sync Inventory Now: the Hub toolbar id ignores the focused folder VS Code injects; the row id honours it", () => {
  const SOURCES = [source("src-1", "Lab", "prov-lab"), source("src-2", "Other", "prov-other")];

  async function registerWithTwoSources(): Promise<(id: string) => (arg?: unknown) => unknown> {
    vi.clearAllMocks();
    const core = new NexusCore(new InMemoryConfigRepository());
    await core.initialize();
    for (const s of SOURCES) {
      await core.addOrUpdateInventorySource(s);
    }
    const vault = { get: vi.fn(async () => undefined), store: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    registerInventoryCommands(core, new InventoryProviderRegistry(), vault as never, { teardownServerRuntime: vi.fn(async () => {}) });
    return (id) => {
      const handler = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([command]) => command === id)?.[1];
      expect(handler, `${id} is registered`).toBeDefined();
      return handler as (arg?: unknown) => unknown;
    };
  }

  const providerMissing = (providerId: string) => expect.stringContaining(`Inventory provider "${providerId}" is not available`);
  const pickerTitles = () => vi.mocked(vscode.window.showQuickPick).mock.calls.map((call) => (call[1] as { title?: string } | undefined)?.title);

  it("nexus.inventory.syncNow (the toolbar) opens the source picker when handed the focused folder row, rather than syncing that folder's source (⊘ reading `sourceId` off the argument silently syncs whichever folder was clicked last)", async () => {
    const handler = await registerWithTwoSources();
    const row = folderRow("Lab", SOURCES);
    expect(row.sourceId).toBe("src-1");

    await handler("nexus.inventory.syncNow")(row);

    expect(pickerTitles()).toEqual(["Select Inventory Source"]);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalledWith(providerMissing("prov-lab"));
  });

  it("nexus.inventory.syncNow still syncs a Settings source row's own source — its inline Sync button; the Settings view has no toolbar sync, so that item can only come from its own row", async () => {
    const handler = await registerWithTwoSources();

    await handler("nexus.inventory.syncNow")(new InventorySourceItem("src-2", "src-2", "desc"));

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(providerMissing("prov-other"));
  });

  it("nexus.inventory.syncNow still syncs the source a bare id string names — the manage hub, the add/edit-source follow-ups and the device-template editor all call it that way", async () => {
    const handler = await registerWithTwoSources();

    await handler("nexus.inventory.syncNow")("src-2");

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(providerMissing("prov-other"));
  });

  it("nexus.inventory.syncFolderSource (the folder row's icon and right-click entry) syncs the row's own source without asking", async () => {
    const handler = await registerWithTwoSources();

    await handler("nexus.inventory.syncFolderSource")(folderRow("Lab", SOURCES));

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(providerMissing("prov-lab"));
  });

  it("nexus.inventory.syncFolderSource on a row that names no source falls back to the picker instead of throwing", async () => {
    const handler = await registerWithTwoSources();

    // Two sources share "Lab", so the row is withheld a source id.
    const ambiguous = folderRow("Lab", [source("src-1", "Lab"), source("src-2", "Lab")]);
    expect(ambiguous.sourceId).toBeUndefined();

    await handler("nexus.inventory.syncFolderSource")(ambiguous);

    expect(pickerTitles()).toEqual(["Select Inventory Source"]);
  });

  it("nexus.inventory.syncFolderSource with no argument at all falls back to the picker", async () => {
    const handler = await registerWithTwoSources();

    await handler("nexus.inventory.syncFolderSource")();

    expect(pickerTitles()).toEqual(["Select Inventory Source"]);
  });
});
