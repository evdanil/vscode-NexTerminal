import type {
  ActiveSerialSession,
  ActiveSession,
  ActiveTunnel,
  AuthProfile,
  SerialProfile,
  ServerConfig,
  TunnelProfile,
  TunnelRegistryEntry
} from "../models/config";

export interface ConfigRepository {
  getServers(): Promise<ServerConfig[]>;
  saveServers(servers: ServerConfig[]): Promise<void>;
  getTunnels(): Promise<TunnelProfile[]>;
  saveTunnels(tunnels: TunnelProfile[]): Promise<void>;
  getSerialProfiles(): Promise<SerialProfile[]>;
  saveSerialProfiles(profiles: SerialProfile[]): Promise<void>;
  getGroups(): Promise<string[]>;
  saveGroups(groups: string[]): Promise<void>;
  getAuthProfiles(): Promise<AuthProfile[]>;
  saveAuthProfiles(profiles: AuthProfile[]): Promise<void>;
}

export interface SessionSnapshot {
  servers: ServerConfig[];
  tunnels: TunnelProfile[];
  serialProfiles: SerialProfile[];
  activeSessions: ActiveSession[];
  activeSerialSessions: ActiveSerialSession[];
  activeTunnels: ActiveTunnel[];
  remoteTunnels: TunnelRegistryEntry[];
  explicitGroups: string[];
  authProfiles: AuthProfile[];
  activitySessionIds: ReadonlySet<string>;
}

export interface TunnelRegistryStore {
  getEntries(): Promise<TunnelRegistryEntry[]>;
  saveEntries(entries: TunnelRegistryEntry[]): Promise<void>;
}
