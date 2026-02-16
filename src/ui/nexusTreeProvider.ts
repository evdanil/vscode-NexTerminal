import * as vscode from "vscode";
import type { SessionSnapshot } from "../core/contracts";
import type { ActiveSerialSession, ActiveSession, SerialProfile, ServerConfig } from "../models/config";
import { toParityCode } from "../utils/helpers";

const TUNNEL_DRAG_MIME = "application/vnd.nexus.tunnelProfile";
const ITEM_DRAG_MIME = "application/vnd.nexus.item";

export class GroupTreeItem extends vscode.TreeItem {
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

type NexusTreeItem = GroupTreeItem | ServerTreeItem | SessionTreeItem | SerialProfileTreeItem | SerialSessionTreeItem;

export interface NexusTreeCallbacks {
  onTunnelDropped(serverId: string, tunnelProfileId: string): Promise<void>;
  onItemGroupChanged(itemType: "server" | "serial", itemId: string, newGroup: string | undefined): Promise<void>;
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
    activeTunnels: []
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
      return this.getRootItems();
    }
    if (element instanceof GroupTreeItem) {
      const servers = this.snapshot.servers
        .filter((server) => server.group === element.groupName && !server.isHidden)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((server) => this.toServerItem(server));
      const serialProfiles = this.snapshot.serialProfiles
        .filter((profile) => profile.group === element.groupName)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((profile) => this.toSerialProfileItem(profile));
      return [...servers, ...serialProfiles];
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

    // Handle item (server/serial) drop onto group or root (ungroup)
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
    if (parsed.type !== "server" && parsed.type !== "serial") {
      return;
    }

    let newGroup: string | undefined;
    if (target instanceof GroupTreeItem) {
      newGroup = target.groupName;
    } else if (target === undefined) {
      // Dropped on root — remove from group
      newGroup = undefined;
    } else {
      // Dropped on something else (server, session, etc.) — ignore
      return;
    }

    await this.callbacks.onItemGroupChanged(parsed.type as "server" | "serial", parsed.id, newGroup);
  }

  private getRootItems(): NexusTreeItem[] {
    const groupNames = new Set<string>();
    const ungroupedServers: ServerConfig[] = [];
    const ungroupedSerialProfiles: SerialProfile[] = [];
    for (const server of this.snapshot.servers) {
      if (server.isHidden) {
        continue;
      }
      if (server.group) {
        groupNames.add(server.group);
      } else {
        ungroupedServers.push(server);
      }
    }
    for (const profile of this.snapshot.serialProfiles) {
      if (profile.group) {
        groupNames.add(profile.group);
      } else {
        ungroupedSerialProfiles.push(profile);
      }
    }

    const groupItems = [...groupNames].sort((a, b) => a.localeCompare(b)).map((group) => new GroupTreeItem(group));
    const serverItems = ungroupedServers
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((server) => this.toServerItem(server));
    const serialItems = ungroupedSerialProfiles
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((profile) => this.toSerialProfileItem(profile));
    return [...groupItems, ...serverItems, ...serialItems];
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
