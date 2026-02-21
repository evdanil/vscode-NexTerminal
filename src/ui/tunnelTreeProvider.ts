import * as vscode from "vscode";
import type { SessionSnapshot } from "../core/contracts";
import type { TunnelProfile } from "../models/config";
import { resolveTunnelType } from "../models/config";
import { formatBytes } from "../utils/helpers";

const TUNNEL_DRAG_MIME = "application/vnd.nexus.tunnelProfile";

export function formatTunnelRoute(profile: TunnelProfile): string {
  const type = resolveTunnelType(profile);
  switch (type) {
    case "reverse": {
      const bindAddr = profile.remoteBindAddress ?? "127.0.0.1";
      const targetIP = profile.localTargetIP ?? "127.0.0.1";
      return `R ${profile.remotePort} <- ${targetIP}:${profile.localPort}`;
    }
    case "dynamic":
      return `D :${profile.localPort} SOCKS5`;
    default:
      return `L ${profile.localPort} -> ${profile.remoteIP}:${profile.remotePort}`;
  }
}

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
    explicitGroups: []
  };

  public readonly dragMimeTypes = [TUNNEL_DRAG_MIME];
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
    dataTransfer.set(TUNNEL_DRAG_MIME, new vscode.DataTransferItem(source[0].profile.id));
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
