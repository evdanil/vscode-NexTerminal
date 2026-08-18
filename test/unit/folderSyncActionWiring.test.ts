import { describe, expect, it, vi } from "vitest";

/**
 * PER-SOURCE SYNC ON THE FOLDER ROW (follow-up #43) — THE JOIN, tested end to
 * end rather than assumed.
 *
 * The claim the feature rests on is that no command-layer change is needed: VS
 * Code hands a `view/item/context` command the TREE ITEM itself (never a
 * string), and `resolveSourceIdArg` already reads `sourceId` off an object — so
 * putting a `sourceId` on the folder row is the whole of the wiring. That claim
 * spans two modules that no other test loads together, and it is exactly the
 * kind of thing that reads as obviously true and is off by one property name.
 *
 * So: build a REAL `FolderTreeItem` through the REAL `NexusTreeProvider`, hand
 * it to the REAL `resolveSourceIdArg`, and assert the id comes back.
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

import { resolveSourceIdArg } from "../../src/commands/inventoryCommands";
import { FolderTreeItem, NexusTreeProvider } from "../../src/ui/nexusTreeProvider";
import type { ServerConfig } from "../../src/models/config";

const noopCallbacks = {
  onTunnelDropped: vi.fn(async () => {}),
  onItemGroupChanged: vi.fn(async () => {}),
  onFolderMoved: vi.fn(async () => {})
};

function server(group: string): ServerConfig {
  return { id: `s-${group}`, name: group, host: "10.0.0.1", port: 22, username: "u", authType: "agent", isHidden: false, group };
}

function source(id: string, targetFolder: string) {
  return { id, providerId: "eve-ng", name: id, targetFolder, prunePolicy: "orphan", defaultUsername: "admin", config: {}, secretFieldIds: [] };
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

describe("the folder row's inline sync action reaches nexus.inventory.syncNow with the right source", () => {
  it("resolveSourceIdArg pulls the source id straight off the real tree item the menu passes it (⊘ naming the property anything resolveSourceIdArg does not read — `inventorySourceId`, `sourceIds` — makes the icon open the source picker instead of syncing the folder's own source, with no error to say so)", () => {
    const row = folderRow("Lab", [source("src-1", "Lab")]);
    expect(resolveSourceIdArg(row)).toBe("src-1");
  });

  it("resolves to `undefined` — 'ask me' — for a folder no single source targets, which is the correct answer for a row that carries no inline icon anyway (⊘ a stale id left on an ambiguous row would sync a source the user never picked)", () => {
    expect(resolveSourceIdArg(folderRow("Lab", [source("src-1", "Shared"), source("src-2", "Shared")]))).toBeUndefined();
    expect(resolveSourceIdArg(folderRow("Lab", []))).toBeUndefined();
  });
});
