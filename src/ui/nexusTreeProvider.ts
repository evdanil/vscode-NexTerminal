import * as vscode from "vscode";
import type { SessionSnapshot } from "../core/contracts";
import type { ActiveSerialSession, ActiveSession, SerialProfile, ServerConfig } from "../models/config";
import { getAncestorPaths, folderDisplayName, isDescendantOrSelf } from "../utils/folderPaths";
import { toParityCode } from "../utils/helpers";

const TUNNEL_DRAG_MIME = "application/vnd.nexus.tunnelProfile";
const ITEM_DRAG_MIME = "application/vnd.nexus.item";

export class FolderTreeItem extends vscode.TreeItem {
  public constructor(public readonly folderPath: string, displayName: string) {
    super(displayName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "nexus.folder";
    this.id = `folder:${folderPath}`;
    this.tooltip = folderPath;
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

/** @deprecated Use FolderTreeItem instead */
export const GroupTreeItem = FolderTreeItem;
/** @deprecated Use FolderTreeItem instead */
export type GroupTreeItem = FolderTreeItem;

export class ServerTreeItem extends vscode.TreeItem {
  public constructor(public readonly server: ServerConfig, connected: boolean) {
    super(server.name, connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = `server:${server.id}:${connected ? "on" : "off"}`;
    this.tooltip = `${server.username}@${server.host}:${server.port}`;
    this.description = `${server.username}@${server.host}`;
    this.contextValue = connected ? "nexus.serverConnected" : "nexus.server";
    this.iconPath = new vscode.ThemeIcon(
      connected ? "plug" : "debug-disconnect",
      new vscode.ThemeColor(connected ? "testing.iconPassed" : "testing.iconQueued")
    );
  }
}

export class SessionTreeItem extends vscode.TreeItem {
  public constructor(public readonly session: ActiveSession) {
    super(session.terminalName, vscode.TreeItemCollapsibleState.None);
    this.id = `session:${session.id}`;
    this.contextValue = "nexus.sessionNode";
    this.description = "active";
    this.iconPath = new vscode.ThemeIcon("terminal");
  }
}

export class SerialProfileTreeItem extends vscode.TreeItem {
  public constructor(public readonly profile: SerialProfile, connected: boolean) {
    super(profile.name, connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = `serial:${profile.id}:${connected ? "on" : "off"}`;
    this.tooltip = `${profile.path} @ ${profile.baudRate}`;
    this.description = `${profile.path} @ ${profile.baudRate} (${profile.dataBits}${toParityCode(profile.parity)}${profile.stopBits})`;
    this.contextValue = connected ? "nexus.serialProfileConnected" : "nexus.serialProfile";
    this.iconPath = new vscode.ThemeIcon(
      connected ? "plug" : "debug-disconnect",
      new vscode.ThemeColor(connected ? "testing.iconPassed" : "testing.iconQueued")
    );
  }
}

export class SerialSessionTreeItem extends vscode.TreeItem {
  public constructor(public readonly session: ActiveSerialSession) {
    super(session.terminalName, vscode.TreeItemCollapsibleState.None);
    this.id = `serial-session:${session.id}`;
    this.contextValue = "nexus.serialSessionNode";
    this.description = "active";
    this.iconPath = new vscode.ThemeIcon("terminal");
  }
}

type NexusTreeItem = FolderTreeItem | ServerTreeItem | SessionTreeItem | SerialProfileTreeItem | SerialSessionTreeItem;

export interface NexusTreeCallbacks {
  onTunnelDropped(serverId: string, tunnelProfileId: string): Promise<void>;
  onItemGroupChanged(itemType: "server" | "serial", itemId: string, newGroup: string | undefined): Promise<void>;
  onFolderMoved(oldPath: string, newParentPath: string | undefined): Promise<void>;
}

export class NexusTreeProvider
  implements vscode.TreeDataProvider<NexusTreeItem>, vscode.TreeDragAndDropController<NexusTreeItem>
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<NexusTreeItem | undefined>();
  private snapshot: SessionSnapshot = {
    servers: [],
    tunnels: [],
    serialProfiles: [],
    activeSessions: [],
    activeSerialSessions: [],
    activeTunnels: [],
    remoteTunnels: [],
    explicitGroups: []
  };

  public readonly dragMimeTypes = [TUNNEL_DRAG_MIME, ITEM_DRAG_MIME];
  public readonly dropMimeTypes = [TUNNEL_DRAG_MIME, ITEM_DRAG_MIME];

  public constructor(
    private readonly callbacks: NexusTreeCallbacks
  ) {}

  public readonly onDidChangeTreeData: vscode.Event<NexusTreeItem | undefined> =
    this.onDidChangeTreeDataEmitter.event;

  public setSnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    this.refresh();
  }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: NexusTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: NexusTreeItem): vscode.ProviderResult<NexusTreeItem[]> {
    if (!element) {
      return this.getFolderChildren(undefined);
    }
    if (element instanceof FolderTreeItem) {
      return this.getFolderChildren(element.folderPath);
    }
    if (element instanceof ServerTreeItem) {
      return this.snapshot.activeSessions
        .filter((session) => session.serverId === element.server.id)
        .map((session) => new SessionTreeItem(session));
    }
    if (element instanceof SerialProfileTreeItem) {
      return this.snapshot.activeSerialSessions
        .filter((session) => session.profileId === element.profile.id)
        .map((session) => new SerialSessionTreeItem(session));
    }
    return [];
  }

  public async handleDrag(
    source: readonly NexusTreeItem[],
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const item = source[0];
    if (item instanceof ServerTreeItem) {
      dataTransfer.set(ITEM_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify({ type: "server", id: item.server.id })));
    } else if (item instanceof SerialProfileTreeItem) {
      dataTransfer.set(ITEM_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify({ type: "serial", id: item.profile.id })));
    } else if (item instanceof FolderTreeItem) {
      dataTransfer.set(ITEM_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify({ type: "folder", id: item.folderPath })));
    }
  }

  public async handleDrop(target: NexusTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    // Handle tunnel drop onto server
    if (target instanceof ServerTreeItem) {
      const tunnelTransfer = dataTransfer.get(TUNNEL_DRAG_MIME);
      if (tunnelTransfer) {
        const tunnelProfileId = await tunnelTransfer.asString();
        await this.callbacks.onTunnelDropped(target.server.id, tunnelProfileId);
        return;
      }
    }

    // Handle item (server/serial/folder) drop onto folder or root
    const itemTransfer = dataTransfer.get(ITEM_DRAG_MIME);
    if (!itemTransfer) {
      return;
    }
    const raw = await itemTransfer.asString();
    let parsed: { type: string; id: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    // Determine target folder path
    let targetPath: string | undefined;
    if (target instanceof FolderTreeItem) {
      targetPath = target.folderPath;
    } else if (target === undefined) {
      targetPath = undefined;
    } else {
      return;
    }

    if (parsed.type === "folder") {
      // Reject dropping a folder into itself or a descendant
      if (targetPath && isDescendantOrSelf(targetPath, parsed.id)) {
        return;
      }
      await this.callbacks.onFolderMoved(parsed.id, targetPath);
      return;
    }

    if (parsed.type === "server" || parsed.type === "serial") {
      await this.callbacks.onItemGroupChanged(parsed.type as "server" | "serial", parsed.id, targetPath);
    }
  }

  private getFolderChildren(parentPath: string | undefined): NexusTreeItem[] {
    // Collect all folder paths from explicitGroups + item groups, synthesizing ancestors
    const allPaths = new Set<string>();
    for (const g of this.snapshot.explicitGroups) {
      for (const ancestor of getAncestorPaths(g)) {
        allPaths.add(ancestor);
      }
    }
    for (const server of this.snapshot.servers) {
      if (server.group) {
        for (const ancestor of getAncestorPaths(server.group)) {
          allPaths.add(ancestor);
        }
      }
    }
    for (const profile of this.snapshot.serialProfiles) {
      if (profile.group) {
        for (const ancestor of getAncestorPaths(profile.group)) {
          allPaths.add(ancestor);
        }
      }
    }

    // Find direct child folders at this level
    const childFolderNames = new Set<string>();
    const prefix = parentPath ? parentPath + "/" : "";
    const depth = parentPath ? parentPath.split("/").length + 1 : 1;
    for (const p of allPaths) {
      const segments = p.split("/");
      if (segments.length === depth && p.startsWith(prefix)) {
        childFolderNames.add(p);
      }
    }

    // Find direct child items (group matches parentPath exactly, or no group for root)
    const directServers = this.snapshot.servers
      .filter((server) => {
        if (server.isHidden) {
          return false;
        }
        if (parentPath === undefined) {
          return !server.group;
        }
        return server.group === parentPath;
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((server) => this.toServerItem(server));

    const directSerialProfiles = this.snapshot.serialProfiles
      .filter((profile) => {
        if (parentPath === undefined) {
          return !profile.group;
        }
        return profile.group === parentPath;
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((profile) => this.toSerialProfileItem(profile));

    const folderItems = [...childFolderNames]
      .sort((a, b) => a.localeCompare(b))
      .map((p) => new FolderTreeItem(p, folderDisplayName(p)));

    return [...folderItems, ...directServers, ...directSerialProfiles];
  }

  private toServerItem(server: ServerConfig): ServerTreeItem {
    const connected = this.snapshot.activeSessions.some((session) => session.serverId === server.id);
    return new ServerTreeItem(server, connected);
  }

  private toSerialProfileItem(profile: SerialProfile): SerialProfileTreeItem {
    const connected = this.snapshot.activeSerialSessions.some((session) => session.profileId === profile.id);
    return new SerialProfileTreeItem(profile, connected);
  }
}
