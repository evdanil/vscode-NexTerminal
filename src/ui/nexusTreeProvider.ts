import * as vscode from "vscode";
import type { SessionSnapshot } from "../core/contracts";
import type { ActiveSerialSession, ActiveSession, ProxyConfig, SerialProfile, ServerConfig } from "../models/config";
import { getAncestorPaths, folderDisplayName, isDescendantOrSelf } from "../utils/folderPaths";
import { toParityCode } from "../utils/helpers";
import { TUNNEL_DRAG_MIME, ITEM_DRAG_MIME } from "./dndMimeTypes";

export class FolderTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly folderPath: string,
    displayName: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded
  ) {
    super(displayName, collapsibleState);
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
    this.id = `server:${server.id}:${connected ? "on" : "off"}`;
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
type DragItemType = "server" | "serial" | "folder";
interface DragItemPayload {
  type: DragItemType;
  id: string;
}

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
    const items: DragItemPayload[] = [];
    for (const item of source) {
      if (item instanceof ServerTreeItem) {
        items.push({ type: "server", id: item.server.id });
      } else if (item instanceof SerialProfileTreeItem) {
        items.push({ type: "serial", id: item.profile.id });
      } else if (item instanceof FolderTreeItem) {
        items.push({ type: "folder", id: item.folderPath });
      }
    }
    if (items.length > 0) {
      dataTransfer.set(ITEM_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify(items)));
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
    const parsedItems = this.parseDragItems(raw);
    if (parsedItems.length === 0) {
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

    const knownFolderPaths = this.collectKnownFolderPaths();
    const knownServerIds = new Set(this.snapshot.servers.map((server) => server.id));
    const knownSerialIds = new Set(this.snapshot.serialProfiles.map((profile) => profile.id));

    for (const item of parsedItems) {
      if (item.type === "folder") {
        if (!knownFolderPaths.has(item.id)) {
          continue;
        }
        // Reject dropping a folder into itself or a descendant
        if (targetPath && isDescendantOrSelf(targetPath, item.id)) {
          continue;
        }
        await this.callbacks.onFolderMoved(item.id, targetPath);
      } else if (item.type === "server") {
        if (!knownServerIds.has(item.id)) {
          continue;
        }
        await this.callbacks.onItemGroupChanged(item.type, item.id, targetPath);
      } else if (item.type === "serial") {
        if (!knownSerialIds.has(item.id)) {
          continue;
        }
        await this.callbacks.onItemGroupChanged(item.type, item.id, targetPath);
      }
    }
  }

  private parseDragItems(raw: string): DragItemPayload[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const result: DragItemPayload[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const type = (item as { type?: unknown }).type;
      const id = (item as { id?: unknown }).id;
      if ((type === "server" || type === "serial" || type === "folder") && typeof id === "string") {
        const normalizedId = id.trim();
        if (normalizedId.length > 0) {
          result.push({ type, id: normalizedId });
        }
      }
    }
    return result;
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

  private collectKnownFolderPaths(): Set<string> {
    const paths = new Set<string>();
    for (const group of this.snapshot.explicitGroups) {
      for (const ancestor of getAncestorPaths(group)) {
        paths.add(ancestor);
      }
    }
    for (const server of this.snapshot.servers) {
      if (!server.group) {
        continue;
      }
      for (const ancestor of getAncestorPaths(server.group)) {
        paths.add(ancestor);
      }
    }
    for (const profile of this.snapshot.serialProfiles) {
      if (!profile.group) {
        continue;
      }
      for (const ancestor of getAncestorPaths(profile.group)) {
        paths.add(ancestor);
      }
    }
    return paths;
  }

  private getFolderChildren(parentPath: string | undefined): NexusTreeItem[] {
    // Collect all folder paths from explicitGroups + item groups, synthesizing ancestors
    const allPaths = this.collectKnownFolderPaths();

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
      .map((p) => new FolderTreeItem(
        p,
        folderDisplayName(p),
        this.collapsedFolders.has(p)
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded
      ));

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
