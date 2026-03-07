import * as vscode from "vscode";
import type { SessionSnapshot } from "../core/contracts";
import type { TunnelProfile } from "../models/config";
import { formatBytes } from "../utils/helpers";
import { formatTunnelRoute } from "../utils/tunnelProfile";
import { TUNNEL_DRAG_MIME } from "./dndMimeTypes";

export { formatTunnelRoute };

export class TunnelTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly profile: TunnelProfile,
    public readonly activeTunnelId?: string,
    public readonly bytesIn?: number,
    public readonly bytesOut?: number,
    public readonly isRemote?: boolean,
    remoteServerName?: string
  ) {
    super(profile.name, vscode.TreeItemCollapsibleState.None);
    this.id = `tunnel:${profile.id}`;
    const routeDesc = formatTunnelRoute(profile);
    if (activeTunnelId) {
      this.contextValue = "nexus.activeTunnel";
      this.iconPath = new vscode.ThemeIcon(
        "circle-filled",
        new vscode.ThemeColor("testing.iconPassed")
      );
      this.description = `${routeDesc} | in ${formatBytes(bytesIn ?? 0)} out ${formatBytes(bytesOut ?? 0)}`;
    } else if (isRemote) {
      this.contextValue = "nexus.remoteTunnel";
      this.iconPath = new vscode.ThemeIcon(
        "circle-filled",
        new vscode.ThemeColor("charts.blue")
      );
      const via = remoteServerName ? ` via ${remoteServerName}` : "";
      this.description = `${routeDesc}${via} (other window)`;
    } else {
      this.contextValue = "nexus.tunnel";
      this.iconPath = new vscode.ThemeIcon(
        "circle-outline",
        new vscode.ThemeColor("descriptionForeground")
      );
      this.description = routeDesc;
    }
    this.tooltip = profile.notes ? `${this.description}\n${profile.notes}` : this.description;
  }
}

export class TunnelTreeProvider
  implements vscode.TreeDataProvider<TunnelTreeItem>, vscode.TreeDragAndDropController<TunnelTreeItem>
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TunnelTreeItem | undefined>();
  private snapshot: SessionSnapshot = {
    servers: [],
    tunnels: [],
    serialProfiles: [],
    activeSessions: [],
    activeSerialSessions: [],
    activeTunnels: [],
    remoteTunnels: [],
    explicitGroups: [],
    authProfiles: [],
    activitySessionIds: new Set()
  };

  public readonly dragMimeTypes = [TUNNEL_DRAG_MIME, "text/plain"];
  public readonly dropMimeTypes: string[] = [];

  public readonly onDidChangeTreeData: vscode.Event<TunnelTreeItem | undefined> =
    this.onDidChangeTreeDataEmitter.event;

  public setSnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    this.refresh();
  }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: TunnelTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): vscode.ProviderResult<TunnelTreeItem[]> {
    return this.snapshot.tunnels
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((profile) => this.toTunnelItem(profile));
  }

  public async handleDrag(source: readonly TunnelTreeItem[], dataTransfer: vscode.DataTransfer): Promise<void> {
    if (source.length === 0) {
      return;
    }
    const payload = JSON.stringify({ type: "tunnelProfile", id: source[0].profile.id });
    dataTransfer.set(TUNNEL_DRAG_MIME, new vscode.DataTransferItem(payload));
    dataTransfer.set("text/plain", new vscode.DataTransferItem(payload));
  }

  public async handleDrop(): Promise<void> {
    return;
  }

  private toTunnelItem(profile: TunnelProfile): TunnelTreeItem {
    const active = this.snapshot.activeTunnels.find((item) => item.profileId === profile.id);
    if (active) {
      return new TunnelTreeItem(profile, active.id, active.bytesIn, active.bytesOut);
    }
    const remote = this.snapshot.remoteTunnels.find((item) => item.profileId === profile.id);
    if (remote) {
      const server = this.snapshot.servers.find((s) => s.id === remote.serverId);
      return new TunnelTreeItem(profile, undefined, undefined, undefined, true, server?.name);
    }
    return new TunnelTreeItem(profile);
  }
}
