import * as vscode from "vscode";
import type { SessionSnapshot } from "../core/contracts";
import type { ActiveSession, ServerConfig } from "../models/config";

const TUNNEL_DRAG_MIME = "application/vnd.nexus.tunnelProfile";

class GroupTreeItem extends vscode.TreeItem {
  public constructor(public readonly groupName: string) {
    super(groupName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "nexus.group";
    this.id = `group:${groupName}`;
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

export class ServerTreeItem extends vscode.TreeItem {
  public constructor(public readonly server: ServerConfig, connected: boolean) {
    super(server.name, connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = `server:${server.id}`;
    this.tooltip = `${server.username}@${server.host}:${server.port}`;
    this.description = `${server.username}@${server.host}`;
    this.contextValue = connected ? "nexus.session" : "nexus.server";
    this.iconPath = new vscode.ThemeIcon(connected ? "plug" : "debug-disconnect");
  }
}

class SessionTreeItem extends vscode.TreeItem {
  public constructor(public readonly session: ActiveSession) {
    super(session.terminalName, vscode.TreeItemCollapsibleState.None);
    this.id = `session:${session.id}`;
    this.contextValue = "nexus.session";
    this.description = "active";
    this.iconPath = new vscode.ThemeIcon("terminal");
  }
}

type NexusTreeItem = GroupTreeItem | ServerTreeItem | SessionTreeItem;

export class NexusTreeProvider
  implements vscode.TreeDataProvider<NexusTreeItem>, vscode.TreeDragAndDropController<NexusTreeItem>
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<NexusTreeItem | undefined>();
  private snapshot: SessionSnapshot = {
    servers: [],
    tunnels: [],
    activeSessions: [],
    activeTunnels: []
  };

  public readonly dragMimeTypes = [TUNNEL_DRAG_MIME];
  public readonly dropMimeTypes = [TUNNEL_DRAG_MIME];

  public constructor(
    private readonly onTunnelDropped: (serverId: string, tunnelProfileId: string) => Promise<void>
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
      return this.getRootItems();
    }
    if (element instanceof GroupTreeItem) {
      return this.snapshot.servers
        .filter((server) => server.group === element.groupName && !server.isHidden)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((server) => this.toServerItem(server));
    }
    if (element instanceof ServerTreeItem) {
      return this.snapshot.activeSessions
        .filter((session) => session.serverId === element.server.id)
        .map((session) => new SessionTreeItem(session));
    }
    return [];
  }

  public async handleDrag(
    _source: readonly NexusTreeItem[],
    _dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    return;
  }

  public async handleDrop(target: NexusTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    if (!(target instanceof ServerTreeItem)) {
      return;
    }
    const transfer = dataTransfer.get(TUNNEL_DRAG_MIME);
    if (!transfer) {
      return;
    }
    const tunnelProfileId = await transfer.asString();
    await this.onTunnelDropped(target.server.id, tunnelProfileId);
  }

  private getRootItems(): NexusTreeItem[] {
    const groupNames = new Set<string>();
    const ungrouped: ServerConfig[] = [];
    for (const server of this.snapshot.servers) {
      if (server.isHidden) {
        continue;
      }
      if (server.group) {
        groupNames.add(server.group);
      } else {
        ungrouped.push(server);
      }
    }

    const groupItems = [...groupNames].sort((a, b) => a.localeCompare(b)).map((group) => new GroupTreeItem(group));
    const serverItems = ungrouped.sort((a, b) => a.name.localeCompare(b.name)).map((server) => this.toServerItem(server));
    return [...groupItems, ...serverItems];
  }

  private toServerItem(server: ServerConfig): ServerTreeItem {
    const connected = this.snapshot.activeSessions.some((session) => session.serverId === server.id);
    return new ServerTreeItem(server, connected);
  }
}
