import type {
  ActiveLocalShellSession,
  ActiveSerialSession,
  ActiveSession,
  ActiveTunnel,
  AuthProfile,
  LocalShellProfile,
  SerialProfile,
  ServerConfig,
  TunnelProfile,
  TunnelRegistryEntry
} from "../models/config";
import { sourceConfigUnchanged, type InventorySourceConfig } from "../models/inventory";
import type { ConfigRepository, SessionSnapshot } from "./contracts";
import { normalizeFolderPath, isDescendantOrSelf, parentPath, folderDisplayName, getAncestorPaths } from "../utils/folderPaths";

type NexusListener = (snapshot: SessionSnapshot) => void;

/**
 * Result of a sync engine run (see services/inventory/syncEngine.ts), reduced
 * to exactly what NexusCore needs to mutate in one atomic batch: which
 * servers to upsert/remove and which folders must exist. Defined here (not
 * in syncEngine.ts) because NexusCore is the sole writer that consumes it;
 * syncEngine imports the type back for planToApplication()'s return type.
 */
export interface InventorySyncApplication {
  sourceId: string;
  syncedAt: number; // -> source.lastSyncAt
  upsertServers: ServerConfig[]; // adds + update "after" + orphan "after"
  removeServerIds: string[];
  folders: string[]; // ensure these + ancestors exist as explicit groups
  // FINDINGS D/E — the source record exactly as it stood when this
  // application's plan was computed (the fetch-time snapshot). Compared
  // synchronously against the CURRENT map entry, before any mutation, in
  // applyInventorySyncPlan — closes the gap between "source still exists" and
  // "source is still the same config" for races that land between plan
  // computation and apply (e.g. a replace-mode config import recreating the
  // same source id mid-sync).
  expectedSource: InventorySourceConfig;
}

export class NexusCore {
  private readonly listeners = new Set<NexusListener>();
  private readonly servers = new Map<string, ServerConfig>();
  private readonly tunnels = new Map<string, TunnelProfile>();
  private readonly serialProfiles = new Map<string, SerialProfile>();
  private readonly localShellProfiles = new Map<string, LocalShellProfile>();
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly activeSerialSessions = new Map<string, ActiveSerialSession>();
  private readonly activeLocalShellSessions = new Map<string, ActiveLocalShellSession>();
  private readonly activeTunnels = new Map<string, ActiveTunnel>();
  private readonly activitySessionIds = new Set<string>();
  private focusedSessionId: string | undefined = undefined;
  private remoteTunnels: TunnelRegistryEntry[] = [];
  private readonly explicitGroups = new Set<string>();
  private readonly authProfiles = new Map<string, AuthProfile>();
  private readonly inventorySources = new Map<string, InventorySourceConfig>();

  public constructor(private readonly repository: ConfigRepository) {}

  public async initialize(): Promise<void> {
    const [servers, tunnels, serialProfiles, localShellProfiles, groups, authProfiles, inventorySources] = await Promise.all([
      this.repository.getServers(),
      this.repository.getTunnels(),
      this.repository.getSerialProfiles(),
      this.repository.getLocalShellProfiles(),
      this.repository.getGroups(),
      this.repository.getAuthProfiles(),
      this.repository.getInventorySources()
    ]);
    this.servers.clear();
    this.tunnels.clear();
    this.serialProfiles.clear();
    this.localShellProfiles.clear();
    this.explicitGroups.clear();
    this.authProfiles.clear();
    this.inventorySources.clear();
    const normalizedServers = normalizeFileExplorerAutoOpenOwner(servers);
    for (const server of normalizedServers.servers) {
      this.servers.set(server.id, server);
    }
    for (const tunnel of tunnels) {
      this.tunnels.set(tunnel.id, tunnel);
    }
    for (const profile of serialProfiles) {
      this.serialProfiles.set(profile.id, profile);
    }
    for (const profile of localShellProfiles) {
      this.localShellProfiles.set(profile.id, profile);
    }
    for (const group of groups) {
      this.explicitGroups.add(group);
    }
    for (const profile of authProfiles) {
      this.authProfiles.set(profile.id, profile);
    }
    for (const source of inventorySources) {
      this.inventorySources.set(source.id, source);
    }
    if (normalizedServers.changed) {
      await this.repository.saveServers(normalizedServers.servers);
    }
    this.emitChanged();
  }

  public getSnapshot(): SessionSnapshot {
    return {
      servers: [...this.servers.values()],
      tunnels: [...this.tunnels.values()],
      serialProfiles: [...this.serialProfiles.values()],
      localShellProfiles: [...this.localShellProfiles.values()],
      activeSessions: [...this.activeSessions.values()],
      activeSerialSessions: [...this.activeSerialSessions.values()],
      activeLocalShellSessions: [...this.activeLocalShellSessions.values()],
      activeTunnels: [...this.activeTunnels.values()],
      remoteTunnels: [...this.remoteTunnels],
      explicitGroups: [...this.explicitGroups],
      authProfiles: [...this.authProfiles.values()],
      activitySessionIds: new Set(this.activitySessionIds),
      focusedSessionId: this.focusedSessionId,
      inventorySources: [...this.inventorySources.values()]
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

  public getLocalShellProfile(id: string): LocalShellProfile | undefined {
    return this.localShellProfiles.get(id);
  }

  public getAuthProfile(id: string): AuthProfile | undefined {
    return this.authProfiles.get(id);
  }

  public async addOrUpdateAuthProfile(profile: AuthProfile): Promise<void> {
    this.authProfiles.set(profile.id, profile);
    await this.repository.saveAuthProfiles([...this.authProfiles.values()]);
    this.emitChanged();
  }

  public async removeAuthProfile(profileId: string): Promise<void> {
    this.authProfiles.delete(profileId);
    let serversChanged = false;
    for (const [id, server] of this.servers.entries()) {
      if (server.authProfileId === profileId) {
        this.servers.set(id, { ...server, authProfileId: undefined });
        serversChanged = true;
      }
    }
    await this.repository.saveAuthProfiles([...this.authProfiles.values()]);
    if (serversChanged) {
      await this.repository.saveServers([...this.servers.values()]);
    }
    this.emitChanged();
  }

  public getInventorySource(id: string): InventorySourceConfig | undefined {
    return this.inventorySources.get(id);
  }

  /**
   * FINDING A — the map mutation happens first (repo-wide in-memory-first
   * pattern), but a rejected persist here must leave NO trace: the command
   * layer's credential rollback (add/edit) assumes a failed
   * addOrUpdateInventorySource means the source was never created/updated, and
   * an in-memory-only leftover could later be persisted by an unrelated
   * operation (e.g. the next successful saveInventorySources call from a
   * different command). Capture the previous entry (or its absence) before
   * mutating, and restore it on rejection.
   */
  public async addOrUpdateInventorySource(source: InventorySourceConfig): Promise<void> {
    const hadPrevious = this.inventorySources.has(source.id);
    const previous = this.inventorySources.get(source.id);
    this.inventorySources.set(source.id, source);
    try {
      await this.repository.saveInventorySources([...this.inventorySources.values()]);
    } catch (error) {
      if (hadPrevious) {
        this.inventorySources.set(source.id, previous!);
      } else {
        this.inventorySources.delete(source.id);
      }
      throw error;
    }
    this.emitChanged();
  }

  /**
   * Removes the source record only. Disposition of servers it created
   * (delete / keep / strip origin) is the command layer's job — call
   * applyInventorySyncPlan (or removeServer) first if servers need to change.
   *
   * FINDING A — symmetric with addOrUpdateInventorySource: removeSource's
   * command flow deletes the source's secrets only after this call succeeds,
   * so a rejected persist here must restore the entry rather than leave it
   * deleted in memory while its secrets are still on disk.
   */
  public async removeInventorySource(id: string): Promise<void> {
    const hadPrevious = this.inventorySources.has(id);
    const previous = this.inventorySources.get(id);
    this.inventorySources.delete(id);
    try {
      await this.repository.saveInventorySources([...this.inventorySources.values()]);
    } catch (error) {
      if (hadPrevious) {
        this.inventorySources.set(id, previous!);
      }
      throw error;
    }
    this.emitChanged();
  }

  /**
   * Applies one computed inventory sync as a single atomic batch: one
   * `saveServers`/`saveGroups`/`saveInventorySources` round-trip, one
   * `emitChanged()` — mirrors `addServersBatch`'s reasoning for why a
   * multi-hundred-device sync must not become N sequential memento flushes.
   *
   * Throws if `apply.sourceId` no longer names a known source (e.g. the
   * source was removed while a sync was in flight) — refuses to partially
   * apply servers on behalf of a source record that will never receive the
   * lastSyncAt update, rather than silently orphaning the write.
   *
   * FINDINGS D/E — also throws if the CURRENT source record no longer
   * matches `apply.expectedSource` (the fetch-time snapshot the plan was
   * computed against). This check runs synchronously, before any mutation
   * below, so it is atomic with the apply itself — no await separates "the
   * record is still the one the plan was computed for" from "the plan gets
   * applied", closing the race a caller-side check (however recent) can never
   * fully close on its own.
   */
  public async applyInventorySyncPlan(apply: InventorySyncApplication): Promise<void> {
    const source = this.inventorySources.get(apply.sourceId);
    if (!source) {
      throw new Error(`Cannot apply inventory sync: unknown inventory source "${apply.sourceId}".`);
    }
    if (!sourceConfigUnchanged(source, apply.expectedSource)) {
      throw new Error(
        `Cannot apply inventory sync: inventory source "${apply.sourceId}" configuration changed since the sync was computed.`
      );
    }
    for (const folder of apply.folders) {
      const normalized = normalizeFolderPath(folder);
      if (!normalized) {
        continue;
      }
      for (const ancestor of getAncestorPaths(normalized)) {
        this.explicitGroups.add(ancestor);
      }
    }
    for (const id of apply.removeServerIds) {
      this.servers.delete(id);
      this.removeServerSessions(id);
    }
    for (const server of apply.upsertServers) {
      this.servers.set(server.id, server);
    }
    this.inventorySources.set(source.id, { ...source, lastSyncAt: apply.syncedAt });
    await Promise.all([
      this.repository.saveServers([...this.servers.values()]),
      this.repository.saveGroups([...this.explicitGroups]),
      this.repository.saveInventorySources([...this.inventorySources.values()])
    ]);
    this.emitChanged();
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

  public isLocalShellProfileConnected(profileId: string): boolean {
    for (const session of this.activeLocalShellSessions.values()) {
      if (session.profileId === profileId) {
        return true;
      }
    }
    return false;
  }

  public async addOrUpdateServer(server: ServerConfig): Promise<void> {
    const next = server.openFileExplorerOnFirstConnect
      ? server
      : { ...server, openFileExplorerOnFirstConnect: undefined };
    if (next.openFileExplorerOnFirstConnect) {
      for (const [id, existing] of this.servers.entries()) {
        if (id !== next.id && existing.openFileExplorerOnFirstConnect) {
          this.servers.set(id, { ...existing, openFileExplorerOnFirstConnect: undefined });
        }
      }
    }
    this.servers.set(next.id, next);
    await this.repository.saveServers([...this.servers.values()]);
    this.emitChanged();
  }

  /**
   * Bulk-add servers (and the folders they live in) with a single persisted
   * write and a single change notification, instead of the N sequential
   * `addOrUpdateServer`/`addGroup` round-trips a per-row loop would cost.
   * VS Code batches memento flushes, so N awaited `globalState.update` calls
   * in a row cost roughly N times a flush interval — for a multi-thousand-row
   * inventory import that reads as a hung window. Intended for bulk import
   * paths; existing single-server callers should keep using addOrUpdateServer.
   *
   * Bulk-imported servers never carry `openFileExplorerOnFirstConnect`, so the
   * cross-server "single auto-open owner" invariant enforced by
   * addOrUpdateServer does not need to be replicated here.
   */
  public async addServersBatch(servers: ServerConfig[], folders: string[] = []): Promise<void> {
    if (servers.length === 0 && folders.length === 0) {
      return;
    }
    for (const folder of folders) {
      const normalized = normalizeFolderPath(folder);
      if (!normalized) {
        continue;
      }
      for (const ancestor of getAncestorPaths(normalized)) {
        this.explicitGroups.add(ancestor);
      }
    }
    if (folders.length > 0) {
      await this.repository.saveGroups([...this.explicitGroups]);
    }
    for (const server of servers) {
      this.servers.set(server.id, server);
    }
    if (servers.length > 0) {
      await this.repository.saveServers([...this.servers.values()]);
    }
    this.emitChanged();
  }

  public async removeServer(serverId: string): Promise<void> {
    this.servers.delete(serverId);
    this.removeServerSessions(serverId);
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

  public async addOrUpdateLocalShellProfile(profile: LocalShellProfile): Promise<void> {
    this.localShellProfiles.set(profile.id, profile);
    await this.repository.saveLocalShellProfiles([...this.localShellProfiles.values()]);
    this.emitChanged();
  }

  public async removeSerialProfile(profileId: string): Promise<void> {
    this.serialProfiles.delete(profileId);
    this.removeSerialProfileSessions(profileId);
    await this.repository.saveSerialProfiles([...this.serialProfiles.values()]);
    this.emitChanged();
  }

  public async removeLocalShellProfile(profileId: string): Promise<void> {
    this.localShellProfiles.delete(profileId);
    this.removeLocalShellProfileSessions(profileId);
    await this.repository.saveLocalShellProfiles([...this.localShellProfiles.values()]);
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

  public registerLocalShellSession(session: ActiveLocalShellSession): void {
    this.activeLocalShellSessions.set(session.id, session);
    this.emitChanged();
  }

  /**
   * Returns the active SSH, serial, or Local Shell session with the given id.
   * Callers use this to resolve the {@link SessionPtyHandle} for output observation / input locking.
   */
  public getActiveSessionById(sessionId: string): ActiveSession | ActiveSerialSession | ActiveLocalShellSession | undefined {
    return this.activeSessions.get(sessionId) ?? this.activeSerialSessions.get(sessionId) ?? this.activeLocalShellSessions.get(sessionId);
  }

  public unregisterLocalShellSession(sessionId: string): void {
    if (this.focusedSessionId === sessionId) {
      this.focusedSessionId = undefined;
    }
    this.activeLocalShellSessions.delete(sessionId);
    this.activitySessionIds.delete(sessionId);
    this.emitChanged();
  }

  public unregisterSerialSession(sessionId: string): void {
    if (this.focusedSessionId === sessionId) {
      this.focusedSessionId = undefined;
    }
    this.activeSerialSessions.delete(sessionId);
    this.activitySessionIds.delete(sessionId);
    this.emitChanged();
  }

  public unregisterSession(sessionId: string): void {
    if (this.focusedSessionId === sessionId) {
      this.focusedSessionId = undefined;
    }
    this.activeSessions.delete(sessionId);
    this.activitySessionIds.delete(sessionId);
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
    if (tunnel.bytesIn === bytesIn && tunnel.bytesOut === bytesOut) {
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

  public markSessionActivity(sessionId: string): void {
    if (!this.hasSession(sessionId) || this.activitySessionIds.has(sessionId)) {
      return;
    }
    this.activitySessionIds.add(sessionId);
    this.emitChanged();
  }

  public clearSessionActivity(sessionId: string): void {
    if (!this.activitySessionIds.has(sessionId)) {
      return;
    }
    this.activitySessionIds.delete(sessionId);
    this.emitChanged();
  }

  public setFocusedSession(sessionId: string | undefined): void {
    if (this.focusedSessionId === sessionId) {
      return;
    }
    this.focusedSessionId = sessionId;
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
          this.removeServerSessions(id);
        }
      }
      for (const [id, profile] of this.serialProfiles.entries()) {
        if (profile.group && isDescendantOrSelf(profile.group, path)) {
          this.serialProfiles.delete(id);
          this.removeSerialProfileSessions(id);
        }
      }
      for (const [id, profile] of this.localShellProfiles.entries()) {
        if (profile.group && isDescendantOrSelf(profile.group, path)) {
          this.localShellProfiles.delete(id);
          this.removeLocalShellProfileSessions(id);
        }
      }
    } else {
      for (const server of this.servers.values()) {
        if (server.group && isDescendantOrSelf(server.group, path)) {
          const suffix = server.group.slice(path.length);
          server.group = parent ? parent + suffix : suffix.slice(1) || undefined;
        }
      }
      for (const profile of this.serialProfiles.values()) {
        if (profile.group && isDescendantOrSelf(profile.group, path)) {
          const suffix = profile.group.slice(path.length);
          profile.group = parent ? parent + suffix : suffix.slice(1) || undefined;
        }
      }
      for (const profile of this.localShellProfiles.values()) {
        if (profile.group && isDescendantOrSelf(profile.group, path)) {
          const suffix = profile.group.slice(path.length);
          profile.group = parent ? parent + suffix : suffix.slice(1) || undefined;
        }
      }
    }
    const reparentedGroups: string[] = [];
    for (const g of this.explicitGroups) {
      if (isDescendantOrSelf(g, path)) {
        this.explicitGroups.delete(g);
        if (!deleteContents && g !== path) {
          const suffix = g.slice(path.length);
          const newGroup = parent ? parent + suffix : suffix.slice(1);
          if (newGroup) {
            reparentedGroups.push(newGroup);
          }
        }
      }
    }
    for (const g of reparentedGroups) {
      this.explicitGroups.add(g);
    }
    await Promise.all([
      this.repository.saveServers([...this.servers.values()]),
      this.repository.saveSerialProfiles([...this.serialProfiles.values()]),
      this.repository.saveLocalShellProfiles([...this.localShellProfiles.values()]),
      this.repository.saveGroups([...this.explicitGroups])
    ]);
    this.emitChanged();
  }

  public getItemsInFolder(path: string, recursive: boolean): { servers: ServerConfig[]; serialProfiles: SerialProfile[]; localShellProfiles: LocalShellProfile[] } {
    const servers: ServerConfig[] = [];
    const profiles: SerialProfile[] = [];
    const localShellProfiles: LocalShellProfile[] = [];
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
    for (const profile of this.localShellProfiles.values()) {
      if (!profile.group) {
        continue;
      }
      if (recursive ? isDescendantOrSelf(profile.group, path) : profile.group === path) {
        localShellProfiles.push(profile);
      }
    }
    return { servers, serialProfiles: profiles, localShellProfiles };
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
    for (const profile of this.localShellProfiles.values()) {
      if (profile.group && isDescendantOrSelf(profile.group, oldPath)) {
        profile.group = newPath + profile.group.slice(oldPath.length);
      }
    }

    await Promise.all([
      this.repository.saveServers([...this.servers.values()]),
      this.repository.saveSerialProfiles([...this.serialProfiles.values()]),
      this.repository.saveLocalShellProfiles([...this.localShellProfiles.values()]),
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

  private hasSession(sessionId: string): boolean {
    return this.activeSessions.has(sessionId) || this.activeSerialSessions.has(sessionId) || this.activeLocalShellSessions.has(sessionId);
  }

  private removeServerSessions(serverId: string): void {
    for (const [sessionId, session] of this.activeSessions.entries()) {
      if (session.serverId === serverId) {
        if (this.focusedSessionId === sessionId) {
          this.focusedSessionId = undefined;
        }
        this.activeSessions.delete(sessionId);
        this.activitySessionIds.delete(sessionId);
      }
    }
  }

  private removeSerialProfileSessions(profileId: string): void {
    for (const [sessionId, session] of this.activeSerialSessions.entries()) {
      if (session.profileId === profileId) {
        if (this.focusedSessionId === sessionId) {
          this.focusedSessionId = undefined;
        }
        this.activeSerialSessions.delete(sessionId);
        this.activitySessionIds.delete(sessionId);
      }
    }
  }

  private removeLocalShellProfileSessions(profileId: string): void {
    for (const [sessionId, session] of this.activeLocalShellSessions.entries()) {
      if (session.profileId === profileId) {
        if (this.focusedSessionId === sessionId) {
          this.focusedSessionId = undefined;
        }
        this.activeLocalShellSessions.delete(sessionId);
        this.activitySessionIds.delete(sessionId);
      }
    }
  }
}

function normalizeFileExplorerAutoOpenOwner(servers: ServerConfig[]): { servers: ServerConfig[]; changed: boolean } {
  let ownerId: string | undefined;
  for (const server of servers) {
    if (server.openFileExplorerOnFirstConnect) {
      ownerId = server.id;
    }
  }
  if (!ownerId) {
    return { servers, changed: false };
  }

  let changed = false;
  const normalized = servers.map((server) => {
    if (server.id === ownerId || !server.openFileExplorerOnFirstConnect) {
      return server;
    }
    changed = true;
    return { ...server, openFileExplorerOnFirstConnect: undefined };
  });
  return { servers: normalized, changed };
}
