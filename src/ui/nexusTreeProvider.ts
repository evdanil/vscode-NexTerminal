import * as vscode from "vscode";
import type { SessionSnapshot } from "../core/contracts";
import type { ActiveSerialSession, ActiveSession, ProxyConfig, SerialProfile, ServerConfig } from "../models/config";
import { getAncestorPaths, folderDisplayName, isDescendantOrSelf, parentPath as folderParentPath } from "../utils/folderPaths";
import { toParityCode } from "../utils/helpers";
import { TUNNEL_DRAG_MIME, ITEM_DRAG_MIME } from "./dndMimeTypes";

export class FolderTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly folderPath: string,
    displayName: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded,
    hasDirectServers = false
  ) {
    super(displayName, collapsibleState);
    this.contextValue = hasDirectServers ? "nexus.folderWithServers" : "nexus.folder";
    this.id = `folder:${folderPath}`;
    this.tooltip = folderPath;
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

/** @deprecated Use FolderTreeItem instead */
export const GroupTreeItem = FolderTreeItem;
/** @deprecated Use FolderTreeItem instead */
export type GroupTreeItem = FolderTreeItem;

function proxyTooltipSuffix(proxy?: ProxyConfig, serverLookup?: (id: string) => ServerConfig | undefined): string {
  if (!proxy) return "";
  if (proxy.type === "ssh") {
    const jumpName = serverLookup?.(proxy.jumpHostId)?.name ?? proxy.jumpHostId;
    return ` (via jump host "${jumpName}")`;
  }
  if (proxy.type === "socks5") return ` (via SOCKS5 ${proxy.host}:${proxy.port})`;
  if (proxy.type === "http") return ` (via HTTP proxy ${proxy.host}:${proxy.port})`;
  return "";
}

export class ServerTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly server: ServerConfig,
    connected: boolean,
    serverLookup?: (id: string) => ServerConfig | undefined
  ) {
    super(server.name, connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = `server:${server.id}`;
    this.tooltip = `${server.username}@${server.host}:${server.port}${proxyTooltipSuffix(server.proxy, serverLookup)}`;
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
    this.id = `serial:${profile.id}`;
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
  private readonly collapsedFolders = new Set<string>();
  private cachedChildFolderMap = new Map<string | undefined, string[]>();
  private filterText: string = "";
  private snapshot: SessionSnapshot = {
    servers: [],
    tunnels: [],
    serialProfiles: [],
    activeSessions: [],
    activeSerialSessions: [],
    activeTunnels: [],
    remoteTunnels: [],
    explicitGroups: [],
    authProfiles: []
  };

  public readonly dragMimeTypes = [TUNNEL_DRAG_MIME, ITEM_DRAG_MIME];
  public readonly dropMimeTypes = [TUNNEL_DRAG_MIME, ITEM_DRAG_MIME, "text/plain"];

  public constructor(
    private readonly callbacks: NexusTreeCallbacks
  ) {}

  public readonly onDidChangeTreeData: vscode.Event<NexusTreeItem | undefined> =
    this.onDidChangeTreeDataEmitter.event;

  public setSnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    this.computeFolderCache();
    this.refresh();
  }

  public collapseFolder(path: string): void {
    this.collapsedFolders.add(path);
  }

  public expandFolder(path: string): void {
    this.collapsedFolders.delete(path);
  }

  public getCollapsedFolders(): string[] {
    return [...this.collapsedFolders];
  }

  public loadCollapsedFolders(paths: string[]): void {
    this.collapsedFolders.clear();
    for (const p of paths) {
      this.collapsedFolders.add(p);
    }
  }

  public setFilter(text: string): void {
    this.filterText = text.toLowerCase().trim();
    this.refresh();
  }

  public clearFilter(): void {
    this.filterText = "";
    this.refresh();
  }

  public getFilterText(): string {
    return this.filterText;
  }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: NexusTreeItem): vscode.TreeItem {
    return element;
  }

  public getParent(element: NexusTreeItem): vscode.ProviderResult<NexusTreeItem> {
    if (element instanceof FolderTreeItem) {
      const parent = folderParentPath(element.folderPath);
      return parent ? this.makeFolderItem(parent) : undefined;
    }
    if (element instanceof ServerTreeItem) {
      return element.server.group ? this.makeFolderItem(element.server.group) : undefined;
    }
    if (element instanceof SerialProfileTreeItem) {
      return element.profile.group ? this.makeFolderItem(element.profile.group) : undefined;
    }
    if (element instanceof SessionTreeItem) {
      const server = this.snapshot.servers.find((s) => s.id === element.session.serverId);
      return server ? this.toServerItem(server) : undefined;
    }
    if (element instanceof SerialSessionTreeItem) {
      const profile = this.snapshot.serialProfiles.find((p) => p.id === element.session.profileId);
      return profile ? this.toSerialProfileItem(profile) : undefined;
    }
    return undefined;
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
      const tunnelProfileId = await this.extractTunnelProfileId(dataTransfer);
      if (tunnelProfileId) {
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

  private async extractTunnelProfileId(dataTransfer: vscode.DataTransfer): Promise<string | undefined> {
    // Try each MIME type that might carry the tunnel profile ID.
    // Custom MIME data can arrive empty in cross-view transfers, so
    // we try text/plain as a reliable fallback.
    for (const mime of [TUNNEL_DRAG_MIME, "text/plain"]) {
      const item = dataTransfer.get(mime);
      if (!item) {
        continue;
      }
      const raw = await item.asString();
      if (!raw) {
        continue;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.type === "tunnelProfile" && typeof parsed.id === "string" && this.hasTunnelProfileId(parsed.id)) {
          return parsed.id;
        }
      } catch {
        // Non-JSON payloads may come from older/other transfer producers.
        const rawId = raw.trim();
        if (rawId && this.hasTunnelProfileId(rawId)) {
          return rawId;
        }
      }
    }
    return undefined;
  }

  private hasTunnelProfileId(id: string): boolean {
    return this.snapshot.tunnels.some((tunnel) => tunnel.id === id);
  }

  private folderHasMatchingDescendant(folderPath: string): boolean {
    const hasServer = this.snapshot.servers.some((s) => {
      if (s.isHidden || !s.group) return false;
      if (!isDescendantOrSelf(s.group, folderPath)) return false;
      return s.name.toLowerCase().includes(this.filterText) ||
             s.host.toLowerCase().includes(this.filterText);
    });
    if (hasServer) return true;
    return this.snapshot.serialProfiles.some((p) => {
      if (!p.group) return false;
      if (!isDescendantOrSelf(p.group, folderPath)) return false;
      return p.name.toLowerCase().includes(this.filterText);
    });
  }

  private computeFolderCache(): void {
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

    const childFolderMap = new Map<string | undefined, string[]>();
    for (const p of allPaths) {
      const parent = folderParentPath(p);
      const children = childFolderMap.get(parent);
      if (children) {
        children.push(p);
      } else {
        childFolderMap.set(parent, [p]);
      }
    }
    this.cachedChildFolderMap = childFolderMap;
  }

  private makeFolderItem(path: string): FolderTreeItem {
    const hasDirectServers = this.snapshot.servers.some((s) => !s.isHidden && s.group === path);
    return new FolderTreeItem(
      path,
      folderDisplayName(path),
      this.collapsedFolders.has(path)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded,
      hasDirectServers
    );
  }

  private getFolderChildren(parentPath: string | undefined): NexusTreeItem[] {
    const childFolderPaths = this.cachedChildFolderMap.get(parentPath) ?? [];

    // Find direct child items (group matches parentPath exactly, or no group for root)
    const directServers = this.snapshot.servers
      .filter((server) => {
        if (server.isHidden) {
          return false;
        }
        if (parentPath === undefined) {
          if (server.group) return false;
        } else {
          if (server.group !== parentPath) return false;
        }
        if (this.filterText) {
          return server.name.toLowerCase().includes(this.filterText) ||
                 server.host.toLowerCase().includes(this.filterText);
        }
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((server) => this.toServerItem(server));

    const directSerialProfiles = this.snapshot.serialProfiles
      .filter((profile) => {
        if (parentPath === undefined) {
          if (profile.group) return false;
        } else {
          if (profile.group !== parentPath) return false;
        }
        if (this.filterText) {
          return profile.name.toLowerCase().includes(this.filterText);
        }
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((profile) => this.toSerialProfileItem(profile));

    const filteredFolders = this.filterText
      ? childFolderPaths.filter((p) => this.folderHasMatchingDescendant(p))
      : childFolderPaths;

    const folderItems = filteredFolders
      .sort((a, b) => a.localeCompare(b))
      .map((p) => this.makeFolderItem(p));

    return [...folderItems, ...directServers, ...directSerialProfiles];
  }

  private toServerItem(server: ServerConfig): ServerTreeItem {
    const connected = this.snapshot.activeSessions.some((session) => session.serverId === server.id);
    const lookup = (id: string): ServerConfig | undefined => this.snapshot.servers.find((s) => s.id === id);
    return new ServerTreeItem(server, connected, lookup);
  }

  private toSerialProfileItem(profile: SerialProfile): SerialProfileTreeItem {
    const connected = this.snapshot.activeSerialSessions.some((session) => session.profileId === profile.id);
    return new SerialProfileTreeItem(profile, connected);
  }
}
