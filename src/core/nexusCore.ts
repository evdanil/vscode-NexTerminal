import type {
  ActiveSerialSession,
  ActiveSession,
  ActiveTunnel,
  SerialProfile,
  ServerConfig,
  TunnelProfile
} from "../models/config";
import type { ConfigRepository, SessionSnapshot } from "./contracts";

type NexusListener = (snapshot: SessionSnapshot) => void;

export class NexusCore {
  private readonly listeners = new Set<NexusListener>();
  private readonly servers = new Map<string, ServerConfig>();
  private readonly tunnels = new Map<string, TunnelProfile>();
  private readonly serialProfiles = new Map<string, SerialProfile>();
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly activeSerialSessions = new Map<string, ActiveSerialSession>();
  private readonly activeTunnels = new Map<string, ActiveTunnel>();
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

  public async addGroup(name: string): Promise<void> {
    this.explicitGroups.add(name);
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

  private emitChanged(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
