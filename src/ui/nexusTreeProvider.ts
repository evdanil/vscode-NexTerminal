import * as vscode from "vscode";
import type { SessionSnapshot } from "../core/contracts";
import { authProfileOwnedCredentials, resolveSerialProfileMode, type ActiveLocalShellSession, type ActiveSerialSession, type ActiveSession, type AuthProfile, type LocalShellProfile, type ProxyConfig, type SerialProfile, type SerialSessionStatus, type ServerConfig } from "../models/config";
import type { ActiveLocalServerSession, LocalServerConfig, LocalServerStatus } from "../models/localServer";
import { getAncestorPaths, folderDisplayName, isDescendantOrSelf, parentPath as folderParentPath } from "../utils/folderPaths";
import { templateAppliedFields, TEMPLATE_FIELD_SHORT_LABELS } from "../services/inventory/templateApply";
import { toParityCode } from "../utils/helpers";
import { naturalCompare, naturalComparePath } from "../utils/naturalCompare";
import { TUNNEL_DRAG_MIME, ITEM_DRAG_MIME } from "./dndMimeTypes";

export class FolderTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly folderPath: string,
    displayName: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded,
    hasDirectServers = false,
    // §4.10 of docs/plans/2026-07-30-macro-script-folders.md — both parameterised
    // so the Macros view can reuse this class with `contextValue =
    // "nexus.folder.macros"` (outside the unanchored `/^nexus\.macro/` prefix six
    // menu entries match on) and a distinct id prefix, without duplicating this
    // class. Defaults preserve the Connectivity Hub's existing behavior exactly.
    contextValue?: string,
    idPrefix = "folder"
  ) {
    super(displayName, collapsibleState);
    this.contextValue = contextValue ?? (hasDirectServers ? "nexus.folderWithServers" : "nexus.folder");
    this.id = `${idPrefix}:${folderPath}`;
    this.tooltip = folderPath;
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

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
    serverLookup?: (id: string) => ServerConfig | undefined,
    showDescription = true,
    authProfileName?: string,
    authProfileUsername?: string,
    // m7 — the inventory source's name (looked up by the caller via
    // snapshot.inventorySources against server.origin.sourceId), or undefined
    // when the source no longer exists (removed, but this server's origin
    // wasn't stripped) — the tooltip falls back to a generic line in that case.
    syncedSourceName?: string,
    // D3 — the linked IPMI Auth Profile's name, so the tooltip's IPMI line
    // predicts whether Connect BMC Serial Console will find a username/password
    // or prompt. Resolved by the caller against `server.ipmiAuthProfileId`.
    ipmiAuthProfileName?: string
  ) {
    super(server.name, connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = `server:${server.id}`;
    const displayUsername = authProfileUsername ?? server.username;
    const authSuffix = authProfileName ? ` [auth: ${authProfileName}]` : "";
    // B5 — badge only; contextValue below is UNCHANGED for a synced server. It is
    // matched verbatim (and via /^nexus\.server(Connected)?$/) by every context-menu
    // entry in package.json, so introducing a distinct value here would silently
    // drop every one of those menu entries for synced servers.
    const syncedSuffix = server.origin ? (syncedSourceName ? `\nSynced from "${syncedSourceName}"` : "\nSynced from inventory") : "";
    // Issue #48 — the out-of-band address is not part of the SSH connection, so
    // it gets its own line rather than joining the `user@host:port` summary.
    // D3 — mirror the SSH `authSuffix` idiom so a linked IPMI profile is visible
    // on the IPMI line; shown only when the line itself is (a server with a host).
    const ipmiAuthSuffix = ipmiAuthProfileName ? ` [auth: ${ipmiAuthProfileName}]` : "";
    const ipmiSuffix = typeof server.ipmiHost === "string" && server.ipmiHost.trim() ? `\nIPMI/BMC: ${server.ipmiHost.trim()}${ipmiAuthSuffix}` : "";
    // §7.3 (UX-S12) — one summary line naming the fields still carrying a
    // template value (cur === stamp), via the shared short-label map. Derived
    // purely from record + origin; a hand-edited field drops out, which is the
    // "your edits override" signal. Empty ⇒ no line at all.
    const applied = templateAppliedFields(server);
    const templateSuffix = applied.length > 0
      ? `\nTemplate-applied: ${applied.map((f) => TEMPLATE_FIELD_SHORT_LABELS[f]).join(", ")} (your edits override)`
      : "";
    this.tooltip = `${displayUsername}@${server.host}:${server.port}${proxyTooltipSuffix(server.proxy, serverLookup)}${authSuffix}${ipmiSuffix}${templateSuffix}${syncedSuffix}`;
    const authDesc = authProfileName ? ` (${authProfileName})` : "";
    // m7 — "(synced)" suffix idiom (was "· synced").
    const syncedDesc = server.origin ? " (synced)" : "";
    this.description = showDescription ? `${displayUsername}@${server.host}${authDesc}${syncedDesc}` : undefined;
    this.contextValue = connected ? "nexus.serverConnected" : "nexus.server";
    this.iconPath = new vscode.ThemeIcon(
      connected ? "plug" : "debug-disconnect",
      new vscode.ThemeColor(connected ? "testing.iconPassed" : "testing.iconQueued")
    );
    this.command = {
      command: "nexus.profile.actions",
      title: "Profile Actions",
      arguments: [this]
    };
  }
}

export class SessionTreeItem extends vscode.TreeItem {
  public constructor(public readonly session: ActiveSession, hasActivity = false, isFocused = false) {
    super(session.terminalName, vscode.TreeItemCollapsibleState.None);
    this.id = `session:${session.id}`;
    this.contextValue = "nexus.sessionNode";
    this.description = isFocused ? "▶ active" : "active";
    this.iconPath = new vscode.ThemeIcon(
      "terminal",
      hasActivity ? new vscode.ThemeColor("terminal.ansiYellow") : undefined
    );
    this.command = {
      command: "nexus.focusSessionTerminal",
      title: "Focus Terminal",
      arguments: [session.id, "ssh"]
    };
  }
}

type SerialProfileState = "disconnected" | "waiting" | "connected";

export class SerialProfileTreeItem extends vscode.TreeItem {
  public constructor(public readonly profile: SerialProfile, state: SerialProfileState, showDescription = true) {
    super(profile.name, state === "disconnected" ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
    const smartFollow = resolveSerialProfileMode(profile) === "smartFollow";
    const connectionText = `${profile.path} @ ${profile.baudRate} (${profile.dataBits}${toParityCode(profile.parity)}${profile.stopBits})`;
    const waiting = state === "waiting";
    const connected = state === "connected";
    this.id = `serial:${profile.id}`;
    this.tooltip = smartFollow
      ? `Smart Follow${waiting ? "\nWaiting for port" : ""}\n${connectionText}`
      : `${profile.path} @ ${profile.baudRate}`;
    this.description = showDescription
      ? (smartFollow
          ? `${waiting ? "Smart Follow | Waiting for port | " : "Smart Follow | "}${connectionText}`
          : connectionText)
      : undefined;
    this.contextValue = connected ? "nexus.serialProfileConnected" : waiting ? "nexus.serialProfileWaiting" : "nexus.serialProfile";
    this.iconPath = new vscode.ThemeIcon(
      smartFollow ? "sync" : connected ? "plug" : "debug-disconnect",
      new vscode.ThemeColor(connected ? "testing.iconPassed" : "testing.iconQueued")
    );
    this.command = {
      command: "nexus.profile.actions",
      title: "Profile Actions",
      arguments: [this]
    };
  }
}

export class SerialSessionTreeItem extends vscode.TreeItem {
  public constructor(public readonly session: ActiveSerialSession, hasActivity = false, isFocused = false) {
    super(session.terminalName, vscode.TreeItemCollapsibleState.None);
    const status: SerialSessionStatus = session.status ?? "connected";
    this.id = `serial-session:${session.id}`;
    this.contextValue = "nexus.serialSessionNode";
    this.description = status === "waiting"
      ? (isFocused ? "▶ waiting for port" : "waiting for port")
      : (isFocused ? "▶ active" : "active");
    this.iconPath = new vscode.ThemeIcon(
      "terminal",
      hasActivity ? new vscode.ThemeColor("terminal.ansiYellow") : undefined
    );
    this.command = {
      command: "nexus.focusSessionTerminal",
      title: "Focus Terminal",
      arguments: [session.id, "serial"]
    };
  }
}

export class LocalShellProfileTreeItem extends vscode.TreeItem {
  public constructor(public readonly profile: LocalShellProfile, connected: boolean, showDescription = true) {
    super(profile.name, connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = `localShell:${profile.id}`;
    const description = profile.launchMode === "vscodeProfile"
      ? `VS Code: ${profile.vscodeProfileName ?? ""}`
      : profile.shellPath ?? "";
    this.tooltip = description;
    this.description = showDescription ? description : undefined;
    this.contextValue = connected ? "nexus.localShellProfileConnected" : "nexus.localShellProfile";
    this.iconPath = new vscode.ThemeIcon("terminal");
    this.command = {
      command: "nexus.profile.actions",
      title: "Profile Actions",
      arguments: [this]
    };
  }
}

export class LocalShellSessionTreeItem extends vscode.TreeItem {
  public constructor(public readonly session: ActiveLocalShellSession, isFocused = false) {
    super(session.terminalName, vscode.TreeItemCollapsibleState.None);
    this.id = `local-shell-session:${session.id}`;
    this.contextValue = "nexus.localShellSessionNode";
    this.description = isFocused ? "▶ active" : "active";
    this.iconPath = new vscode.ThemeIcon("terminal");
    this.command = {
      command: "nexus.focusSessionTerminal",
      title: "Focus Terminal",
      arguments: [session.id, "localShell"]
    };
  }
}

function localServerStatusIcon(status: LocalServerStatus): { icon: string; color?: vscode.ThemeColor; description: string } {
  switch (status) {
    case "running":
      return { icon: "debug-start", color: new vscode.ThemeColor("testing.iconPassed"), description: "running" };
    case "starting":
      return { icon: "sync", color: new vscode.ThemeColor("testing.iconQueued"), description: "starting" };
    case "stopping":
      return { icon: "sync", color: new vscode.ThemeColor("testing.iconQueued"), description: "stopping" };
    case "restarting":
      return { icon: "sync~spin", color: new vscode.ThemeColor("testing.iconQueued"), description: "restarting" };
    case "failed":
      return { icon: "error", color: new vscode.ThemeColor("testing.iconFailed"), description: "failed" };
    case "stopped":
    default:
      return { icon: "debug-disconnect", color: new vscode.ThemeColor("testing.iconUnset"), description: "stopped" };
  }
}

export class LocalServerConfigTreeItem extends vscode.TreeItem {
  public constructor(public readonly config: LocalServerConfig, status: LocalServerStatus, hasChildren: boolean, showDescription = true) {
    super(config.name, hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = `localServer:${config.id}`;
    const running = status === "running" || status === "starting" || status === "stopping" || status === "restarting";
    const iconInfo = localServerStatusIcon(status);
    const parts = [config.executable, ...(config.args ?? [])];
    const tooltipLines: string[] = [
      parts.join(" "),
      `Status: ${iconInfo.description}`
    ];
    if (config.cwd) tooltipLines.push(`CWD: ${config.cwd}`);
    if (config.description) tooltipLines.push("", config.description);
    this.tooltip = tooltipLines.join("\n");
    this.description = showDescription
      ? `${iconInfo.description} · ${running ? parts.join(" ") : config.executable}`
      : undefined;
    this.contextValue = running ? "nexus.localServerRunning" : "nexus.localServer";
    this.iconPath = new vscode.ThemeIcon(iconInfo.icon, iconInfo.color);
    this.command = {
      command: "nexus.profile.actions",
      title: "Local Server Actions",
      arguments: [this]
    };
  }
}

export class LocalServerSessionTreeItem extends vscode.TreeItem {
  public constructor(public readonly session: ActiveLocalServerSession, isFocused = false) {
    super(session.terminalName, vscode.TreeItemCollapsibleState.None);
    this.id = `local-server-session:${session.id}`;
    this.contextValue = "nexus.localServerSessionNode";
    const iconInfo = localServerStatusIcon(session.status);
    const exit = typeof session.lastExitCode === "number" ? ` (exit ${session.lastExitCode})` : "";
    const attempts = session.restartAttempts > 0 ? ` · restart ${session.restartAttempts}` : "";
    this.description = `${isFocused ? "▶ " : ""}${iconInfo.description}${exit}${attempts}`;
    this.iconPath = new vscode.ThemeIcon("terminal", iconInfo.color);
    this.command = {
      command: "nexus.focusSessionTerminal",
      title: "Focus Terminal",
      arguments: [session.id, "localServer"]
    };
  }
}

type NexusTreeItem = FolderTreeItem | ServerTreeItem | SessionTreeItem | SerialProfileTreeItem | SerialSessionTreeItem | LocalShellProfileTreeItem | LocalShellSessionTreeItem | LocalServerConfigTreeItem | LocalServerSessionTreeItem;

export interface NexusTreeCallbacks {
  onTunnelDropped(serverId: string, tunnelProfileId: string): Promise<void>;
  onItemGroupChanged(itemType: "server" | "serial" | "localShell" | "localServer", itemId: string, newGroup: string | undefined): Promise<void>;
  onFolderMoved(oldPath: string, newParentPath: string | undefined): Promise<void>;
}

export class NexusTreeProvider
  implements vscode.TreeDataProvider<NexusTreeItem>, vscode.TreeDragAndDropController<NexusTreeItem>
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<NexusTreeItem | undefined>();
  private readonly collapsedFolders = new Set<string>();
  private authProfileById = new Map<string, AuthProfile>();
  private cachedChildFolderMap = new Map<string | undefined, string[]>();
  private filterText: string = "";
  private snapshot: SessionSnapshot & { localServers: LocalServerConfig[]; activeLocalServerSessions: ActiveLocalServerSession[] } = {
    servers: [],
    tunnels: [],
    serialProfiles: [],
    localShellProfiles: [],
    localServers: [],
    activeSessions: [],
    activeSerialSessions: [],
    activeLocalShellSessions: [],
    activeLocalServerSessions: [],
    activeTunnels: [],
    remoteTunnels: [],
    explicitGroups: [],
    authProfiles: [],
    activitySessionIds: new Set(),
    focusedSessionId: undefined,
    inventorySources: [],
    deviceTemplates: [],
    savedFilters: []
  };

  public readonly dragMimeTypes = [TUNNEL_DRAG_MIME, ITEM_DRAG_MIME];
  public readonly dropMimeTypes = [TUNNEL_DRAG_MIME, ITEM_DRAG_MIME, "text/plain"];

  public constructor(
    private readonly callbacks: NexusTreeCallbacks
  ) {}

  public readonly onDidChangeTreeData: vscode.Event<NexusTreeItem | undefined> =
    this.onDidChangeTreeDataEmitter.event;

  public setSnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = {
      ...snapshot,
      localShellProfiles: snapshot.localShellProfiles ?? [],
      activeLocalShellSessions: snapshot.activeLocalShellSessions ?? [],
      localServers: (snapshot as unknown as { localServers?: LocalServerConfig[] }).localServers ?? [],
      activeLocalServerSessions: (snapshot as unknown as { activeLocalServerSessions?: ActiveLocalServerSession[] }).activeLocalServerSessions ?? []
    };
    this.authProfileById = new Map(snapshot.authProfiles.map((profile) => [profile.id, profile]));
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
    if (element instanceof LocalShellProfileTreeItem) {
      return element.profile.group ? this.makeFolderItem(element.profile.group) : undefined;
    }
    if (element instanceof LocalServerConfigTreeItem) {
      return element.config.group ? this.makeFolderItem(element.config.group) : undefined;
    }
    if (element instanceof SessionTreeItem) {
      const server = this.snapshot.servers.find((s) => s.id === element.session.serverId);
      return server ? this.toServerItem(server) : undefined;
    }
    if (element instanceof SerialSessionTreeItem) {
      const profile = this.snapshot.serialProfiles.find((p) => p.id === element.session.profileId);
      return profile ? this.toSerialProfileItem(profile) : undefined;
    }
    if (element instanceof LocalShellSessionTreeItem) {
      const profile = this.snapshot.localShellProfiles.find((p) => p.id === element.session.profileId);
      return profile ? this.toLocalShellProfileItem(profile) : undefined;
    }
    if (element instanceof LocalServerSessionTreeItem) {
      const config = this.snapshot.localServers.find((c) => c.id === element.session.configId);
      return config ? this.toLocalServerItem(config) : undefined;
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
        .map((session) => new SessionTreeItem(session, this.snapshot.activitySessionIds.has(session.id), this.snapshot.focusedSessionId === session.id));
    }
    if (element instanceof SerialProfileTreeItem) {
      return this.snapshot.activeSerialSessions
        .filter((session) => session.profileId === element.profile.id)
        .map((session) => new SerialSessionTreeItem(session, this.snapshot.activitySessionIds.has(session.id), this.snapshot.focusedSessionId === session.id));
    }
    if (element instanceof LocalShellProfileTreeItem) {
      return this.snapshot.activeLocalShellSessions
        .filter((session) => session.profileId === element.profile.id)
        .map((session) => new LocalShellSessionTreeItem(session, this.snapshot.focusedSessionId === session.id));
    }
    if (element instanceof LocalServerConfigTreeItem) {
      return this.snapshot.activeLocalServerSessions
        .filter((session) => session.configId === element.config.id)
        .map((session) => new LocalServerSessionTreeItem(session, this.snapshot.focusedSessionId === session.id));
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
    } else if (item instanceof LocalShellProfileTreeItem) {
      dataTransfer.set(ITEM_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify({ type: "localShell", id: item.profile.id })));
    } else if (item instanceof LocalServerConfigTreeItem) {
      dataTransfer.set(ITEM_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify({ type: "localServer", id: item.config.id })));
    } else if (item instanceof FolderTreeItem) {
      dataTransfer.set(ITEM_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify({ type: "folder", id: item.folderPath })));
    }
  }

  public async handleDrop(target: NexusTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    if (target instanceof ServerTreeItem) {
      const tunnelProfileId = await this.extractTunnelProfileId(dataTransfer);
      if (tunnelProfileId) {
        await this.callbacks.onTunnelDropped(target.server.id, tunnelProfileId);
        return;
      }
    }

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

    let targetPath: string | undefined;
    if (target instanceof FolderTreeItem) {
      targetPath = target.folderPath;
    } else if (target === undefined) {
      targetPath = undefined;
    } else {
      return;
    }

    if (parsed.type === "folder") {
      if (targetPath && isDescendantOrSelf(targetPath, parsed.id)) {
        return;
      }
      await this.callbacks.onFolderMoved(parsed.id, targetPath);
      return;
    }

    if (parsed.type === "server" || parsed.type === "serial" || parsed.type === "localShell" || parsed.type === "localServer") {
      await this.callbacks.onItemGroupChanged(parsed.type as "server" | "serial" | "localShell" | "localServer", parsed.id, targetPath);
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
    }) || this.snapshot.localShellProfiles.some((p) => {
      if (!p.group) return false;
      if (!isDescendantOrSelf(p.group, folderPath)) return false;
      return p.name.toLowerCase().includes(this.filterText);
    }) || this.snapshot.localServers.some((c) => {
      if (!c.group) return false;
      if (!isDescendantOrSelf(c.group, folderPath)) return false;
      return c.name.toLowerCase().includes(this.filterText) ||
             c.executable.toLowerCase().includes(this.filterText);
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
    for (const profile of this.snapshot.localShellProfiles) {
      if (profile.group) {
        for (const ancestor of getAncestorPaths(profile.group)) {
          allPaths.add(ancestor);
        }
      }
    }
    for (const config of this.snapshot.localServers) {
      if (config.group) {
        for (const ancestor of getAncestorPaths(config.group)) {
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
      .sort((a, b) => naturalCompare(a.name, b.name))
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
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((profile) => this.toSerialProfileItem(profile));

    const directLocalShellProfiles = this.snapshot.localShellProfiles
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
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((profile) => this.toLocalShellProfileItem(profile));

    const directLocalServers = this.snapshot.localServers
      .filter((config) => {
        if (parentPath === undefined) {
          if (config.group) return false;
        } else {
          if (config.group !== parentPath) return false;
        }
        if (this.filterText) {
          return config.name.toLowerCase().includes(this.filterText) ||
                 config.executable.toLowerCase().includes(this.filterText);
        }
        return true;
      })
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((config) => this.toLocalServerItem(config));

    const filteredFolders = this.filterText
      ? childFolderPaths.filter((p) => this.folderHasMatchingDescendant(p))
      : childFolderPaths;

    // .slice() before sorting: when no filter is active, filteredFolders aliases
    // the cached array from this.cachedChildFolderMap, and sorting in place would
    // mutate shared cached state.
    const folderItems = filteredFolders
      .slice()
      .sort((a, b) => naturalComparePath(a, b))
      .map((p) => this.makeFolderItem(p));

    return [...folderItems, ...directServers, ...directSerialProfiles, ...directLocalShellProfiles, ...directLocalServers];
  }

  private toServerItem(server: ServerConfig): ServerTreeItem {
    const connected = this.snapshot.activeSessions.some((session) => session.serverId === server.id);
    const lookup = (id: string): ServerConfig | undefined => this.snapshot.servers.find((s) => s.id === id);
    const showDesc = vscode.workspace.getConfiguration("nexus.ui").get<boolean>("showTreeDescriptions", true);
    const authProfile = server.authProfileId ? this.authProfileById.get(server.authProfileId) : undefined;
    // m7 — resolved by origin.sourceId against the live snapshot rather than
    // stored on the server itself, so a source rename is reflected immediately
    // and a removed source (origin left dangling — see B5's tree tooltip doc)
    // falls back to the generic "Synced from inventory" line in ServerTreeItem.
    const syncedSourceName = server.origin
      ? this.snapshot.inventorySources.find((source) => source.id === server.origin!.sourceId)?.name
      : undefined;
    // REVIEW FINDING (P2) — the username shown is the one a connection will
    // actually use, resolved through the shared ownership rule
    // (`authProfileOwnedCredentials`, models/config.ts). Reading
    // `authProfile.username` directly showed an imported profile's
    // whitespace-only username as the server's, rendering "@host:22" in the
    // label and tooltip while the connection uses the server's own username.
    const ipmiAuthProfile = server.ipmiAuthProfileId ? this.authProfileById.get(server.ipmiAuthProfileId) : undefined;
    return new ServerTreeItem(
      server,
      connected,
      lookup,
      showDesc,
      authProfile?.name,
      authProfileOwnedCredentials(authProfile).username,
      syncedSourceName,
      ipmiAuthProfile?.name
    );
  }

  private toSerialProfileItem(profile: SerialProfile): SerialProfileTreeItem {
    const sessions = this.snapshot.activeSerialSessions.filter((session) => session.profileId === profile.id);
    const state: SerialProfileState =
      sessions.some((session) => (session.status ?? "connected") === "connected")
        ? "connected"
        : sessions.length > 0
          ? "waiting"
          : "disconnected";
    const showDesc = vscode.workspace.getConfiguration("nexus.ui").get<boolean>("showTreeDescriptions", true);
    return new SerialProfileTreeItem(profile, state, showDesc);
  }

  private toLocalShellProfileItem(profile: LocalShellProfile): LocalShellProfileTreeItem {
    const connected = this.snapshot.activeLocalShellSessions.some((session) => session.profileId === profile.id);
    const showDesc = vscode.workspace.getConfiguration("nexus.ui").get<boolean>("showTreeDescriptions", true);
    return new LocalShellProfileTreeItem(profile, connected, showDesc);
  }

  private toLocalServerItem(config: LocalServerConfig): LocalServerConfigTreeItem {
    const sessions = this.snapshot.activeLocalServerSessions.filter((session) => session.configId === config.id);
    const status: LocalServerStatus = sessions.length > 0
      ? sessions[0].status
      : "stopped";
    const showDesc = vscode.workspace.getConfiguration("nexus.ui").get<boolean>("showTreeDescriptions", true);
    return new LocalServerConfigTreeItem(config, status, sessions.length > 0, showDesc);
  }
}
