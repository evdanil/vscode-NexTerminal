import * as vscode from "vscode";
import type { SessionSnapshot } from "../core/contracts";
import type { TunnelProfile } from "../models/config";
import { formatBytes } from "../utils/helpers";

const TUNNEL_DRAG_MIME = "application/vnd.nexus.tunnelProfile";

export class TunnelTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly profile: TunnelProfile,
    public readonly activeTunnelId?: string,
    public readonly bytesIn?: number,
    public readonly bytesOut?: number
  ) {
    super(profile.name, vscode.TreeItemCollapsibleState.None);
    this.id = `tunnel:${profile.id}`;
    this.contextValue = activeTunnelId ? "nexus.activeTunnel" : "nexus.tunnel";
    this.iconPath = new vscode.ThemeIcon(activeTunnelId ? "radio-tower" : "debug-start");
    const mode = profile.connectionMode ?? "isolated";
    this.description = activeTunnelId
      ? `${profile.localPort} -> ${profile.remoteIP}:${profile.remotePort} | ${mode} | in ${formatBytes(bytesIn ?? 0)} out ${formatBytes(bytesOut ?? 0)}`
      : `${profile.localPort} -> ${profile.remoteIP}:${profile.remotePort} | ${mode}`;
    this.tooltip = this.description;
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
    activeTunnels: []
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
    return new TunnelTreeItem(profile, active?.id, active?.bytesIn, active?.bytesOut);
  }
}
