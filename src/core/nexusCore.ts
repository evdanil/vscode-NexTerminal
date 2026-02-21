import type {
  ActiveSerialSession,
  ActiveSession,
  ActiveTunnel,
  SerialProfile,
  ServerConfig,
  TunnelProfile,
  TunnelRegistryEntry
} from "../models/config";
import type { ConfigRepository, SessionSnapshot } from "./contracts";
import { normalizeFolderPath, isDescendantOrSelf, parentPath, folderDisplayName, getAncestorPaths } from "../utils/folderPaths";

type NexusListener = (snapshot: SessionSnapshot) => void;

export class NexusCore {
  private readonly listeners = new Set<NexusListener>();
  private readonly servers = new Map<string, ServerConfig>();
  private readonly tunnels = new Map<string, TunnelProfile>();
  private readonly serialProfiles = new Map<string, SerialProfile>();
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly activeSerialSessions = new Map<string, ActiveSerialSession>();
  private readonly activeTunnels = new Map<string, ActiveTunnel>();
  private remoteTunnels: TunnelRegistryEntry[] = [];
  private readonly explicitGroups = new Set<string>();

  public constructor(private readonly repository: ConfigRepository) {}

  public async initialize(): Promise<void> {
    const [servers, tunnels, serialProfiles, groups] = await Promise.all([
      this.repository.getServers(),
      this.repository.getTunnels(),
      this.repository.getSerialProfiles(),
      this.repository.getGroups()
    ]);
    this.servers.clear();
    this.tunnels.clear();
    this.serialProfiles.clear();
    this.explicitGroups.clear();
    for (const server of servers) {
      this.servers.set(server.id, server);
    }
    for (const tunnel of tunnels) {
      this.tunnels.set(tunnel.id, tunnel);
    }
    for (const profile of serialProfiles) {
      this.serialProfiles.set(profile.id, profile);
    }
    for (const group of groups) {
      this.explicitGroups.add(group);
    }
    this.emitChanged();
  }

  public getSnapshot(): SessionSnapshot {
    return {
      servers: [...this.servers.values()],
      tunnels: [...this.tunnels.values()],
      serialProfiles: [...this.serialProfiles.values()],
      activeSessions: [...this.activeSessions.values()],
      activeSerialSessions: [...this.activeSerialSessions.values()],
      activeTunnels: [...this.activeTunnels.values()],
      remoteTunnels: [...this.remoteTunnels],
      explicitGroups: [...this.explicitGroups]
    };
  }

  public onDidChange(listener: NexusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getServer(id: string): ServerConfig | undefined {
    return this.servers.get(id);
  }

  public getTunnel(id: string): TunnelProfile | undefined {
    return this.tunnels.get(id);
  }

  public getSerialProfile(id: string): SerialProfile | undefined {
    return this.serialProfiles.get(id);
  }

  public isServerConnected(serverId: string): boolean {
    for (const session of this.activeSessions.values()) {
      if (session.serverId === serverId) {
        return true;
      }
    }
    return false;
  }

  public isSerialProfileConnected(profileId: string): boolean {
    for (const session of this.activeSerialSessions.values()) {
      if (session.profileId === profileId) {
        return true;
      }
    }
    return false;
  }

  public async addOrUpdateServer(server: ServerConfig): Promise<void> {
    this.servers.set(server.id, server);
    await this.repository.saveServers([...this.servers.values()]);
    this.emitChanged();
  }

  public async removeServer(serverId: string): Promise<void> {
    this.servers.delete(serverId);
    for (const [sessionId, session] of this.activeSessions.entries()) {
      if (session.serverId === serverId) {
        this.activeSessions.delete(sessionId);
      }
    }
    await this.repository.saveServers([...this.servers.values()]);
    this.emitChanged();
  }

  public async addOrUpdateTunnel(profile: TunnelProfile): Promise<void> {
    this.tunnels.set(profile.id, profile);
    await this.repository.saveTunnels([...this.tunnels.values()]);
    this.emitChanged();
  }

  public async addOrUpdateSerialProfile(profile: SerialProfile): Promise<void> {
    this.serialProfiles.set(profile.id, profile);
    await this.repository.saveSerialProfiles([...this.serialProfiles.values()]);
    this.emitChanged();
  }

  public async removeSerialProfile(profileId: string): Promise<void> {
    this.serialProfiles.delete(profileId);
    for (const [sessionId, session] of this.activeSerialSessions.entries()) {
      if (session.profileId === profileId) {
        this.activeSerialSessions.delete(sessionId);
      }
    }
    await this.repository.saveSerialProfiles([...this.serialProfiles.values()]);
    this.emitChanged();
  }

  public async removeTunnel(tunnelId: string): Promise<void> {
    this.tunnels.delete(tunnelId);
    for (const [activeId, tunnel] of this.activeTunnels.entries()) {
      if (tunnel.profileId === tunnelId) {
        this.activeTunnels.delete(activeId);
      }
    }
    await this.repository.saveTunnels([...this.tunnels.values()]);
    this.emitChanged();
  }

  public registerSession(session: ActiveSession): void {
    this.activeSessions.set(session.id, session);
    this.emitChanged();
  }

  public registerSerialSession(session: ActiveSerialSession): void {
    this.activeSerialSessions.set(session.id, session);
    this.emitChanged();
  }

  public unregisterSerialSession(sessionId: string): void {
    this.activeSerialSessions.delete(sessionId);
    this.emitChanged();
  }

  public unregisterSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    this.emitChanged();
  }

  public registerTunnel(tunnel: ActiveTunnel): void {
    this.activeTunnels.set(tunnel.id, tunnel);
    this.emitChanged();
  }

  public updateTunnelTraffic(activeTunnelId: string, bytesIn: number, bytesOut: number): void {
    const tunnel = this.activeTunnels.get(activeTunnelId);
    if (!tunnel) {
      return;
    }
    tunnel.bytesIn = bytesIn;
    tunnel.bytesOut = bytesOut;
    this.emitChanged();
  }

  public unregisterTunnel(activeTunnelId: string): void {
    this.activeTunnels.delete(activeTunnelId);
    this.emitChanged();
  }

  public setRemoteTunnels(entries: TunnelRegistryEntry[]): void {
    this.remoteTunnels = entries;
    this.emitChanged();
  }

  public async addGroup(path: string): Promise<void> {
    const normalized = normalizeFolderPath(path);
    if (!normalized) {
      return;
    }
    for (const ancestor of getAncestorPaths(normalized)) {
      this.explicitGroups.add(ancestor);
    }
    await this.repository.saveGroups([...this.explicitGroups]);
    this.emitChanged();
  }

  public async removeExplicitGroup(name: string): Promise<void> {
    this.explicitGroups.delete(name);
    await this.repository.saveGroups([...this.explicitGroups]);
    this.emitChanged();
  }

  public async renameExplicitGroup(oldName: string, newName: string): Promise<void> {
    if (this.explicitGroups.has(oldName)) {
      this.explicitGroups.delete(oldName);
      this.explicitGroups.add(newName);
      await this.repository.saveGroups([...this.explicitGroups]);
      this.emitChanged();
    }
  }

  public async moveFolder(oldPath: string, newParentPath: string | undefined): Promise<void> {
    const leaf = folderDisplayName(oldPath);
    const newPath = newParentPath ? newParentPath + "/" + leaf : leaf;
    const normalized = normalizeFolderPath(newPath);
    if (!normalized) {
      return;
    }
    if (newParentPath && isDescendantOrSelf(newParentPath, oldPath)) {
      return;
    }
    await this._renameFolderPath(oldPath, normalized);
  }

  public async renameFolder(oldPath: string, newName: string): Promise<void> {
    const parent = parentPath(oldPath);
    const newPath = parent ? parent + "/" + newName : newName;
    const normalized = normalizeFolderPath(newPath);
    if (!normalized) {
      return;
    }
    await this._renameFolderPath(oldPath, normalized);
  }

  public async removeFolderCascade(path: string, deleteContents: boolean): Promise<void> {
    const parent = parentPath(path);
    if (deleteContents) {
      for (const [id, server] of this.servers.entries()) {
        if (server.group && isDescendantOrSelf(server.group, path)) {
          this.servers.delete(id);
          for (const [sessionId, session] of this.activeSessions.entries()) {
            if (session.serverId === id) {
              this.activeSessions.delete(sessionId);
            }
          }
        }
      }
      for (const [id, profile] of this.serialProfiles.entries()) {
        if (profile.group && isDescendantOrSelf(profile.group, path)) {
          this.serialProfiles.delete(id);
          for (const [sessionId, session] of this.activeSerialSessions.entries()) {
            if (session.profileId === id) {
              this.activeSerialSessions.delete(sessionId);
            }
          }
        }
      }
    } else {
      for (const server of this.servers.values()) {
        if (server.group && isDescendantOrSelf(server.group, path)) {
          server.group = parent;
        }
      }
      for (const profile of this.serialProfiles.values()) {
        if (profile.group && isDescendantOrSelf(profile.group, path)) {
          profile.group = parent;
        }
      }
    }
    for (const g of this.explicitGroups) {
      if (isDescendantOrSelf(g, path)) {
        this.explicitGroups.delete(g);
      }
    }
    await Promise.all([
      this.repository.saveServers([...this.servers.values()]),
      this.repository.saveSerialProfiles([...this.serialProfiles.values()]),
      this.repository.saveGroups([...this.explicitGroups])
    ]);
    this.emitChanged();
  }

  public getItemsInFolder(path: string, recursive: boolean): { servers: ServerConfig[]; serialProfiles: SerialProfile[] } {
    const servers: ServerConfig[] = [];
    const profiles: SerialProfile[] = [];
    for (const server of this.servers.values()) {
      if (!server.group) {
        continue;
      }
      if (recursive ? isDescendantOrSelf(server.group, path) : server.group === path) {
        servers.push(server);
      }
    }
    for (const profile of this.serialProfiles.values()) {
      if (!profile.group) {
        continue;
      }
      if (recursive ? isDescendantOrSelf(profile.group, path) : profile.group === path) {
        profiles.push(profile);
      }
    }
    return { servers, serialProfiles: profiles };
  }

  private async _renameFolderPath(oldPath: string, newPath: string): Promise<void> {
    // Remap all explicitGroups entries
    const toAdd: string[] = [];
    for (const g of this.explicitGroups) {
      if (isDescendantOrSelf(g, oldPath)) {
        this.explicitGroups.delete(g);
        toAdd.push(newPath + g.slice(oldPath.length));
      }
    }
    for (const g of toAdd) {
      this.explicitGroups.add(g);
    }
    // Ensure ancestors of newPath exist
    for (const ancestor of getAncestorPaths(newPath)) {
      this.explicitGroups.add(ancestor);
    }

    // Remap all item groups
    for (const server of this.servers.values()) {
      if (server.group && isDescendantOrSelf(server.group, oldPath)) {
        server.group = newPath + server.group.slice(oldPath.length);
      }
    }
    for (const profile of this.serialProfiles.values()) {
      if (profile.group && isDescendantOrSelf(profile.group, oldPath)) {
        profile.group = newPath + profile.group.slice(oldPath.length);
      }
    }

    await Promise.all([
      this.repository.saveServers([...this.servers.values()]),
      this.repository.saveSerialProfiles([...this.serialProfiles.values()]),
      this.repository.saveGroups([...this.explicitGroups])
    ]);
    this.emitChanged();
  }

  private emitChanged(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
