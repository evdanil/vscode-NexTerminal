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

export interface ConfigRepository {
  getServers(): Promise<ServerConfig[]>;
  saveServers(servers: ServerConfig[]): Promise<void>;
  getTunnels(): Promise<TunnelProfile[]>;
  saveTunnels(tunnels: TunnelProfile[]): Promise<void>;
  getSerialProfiles(): Promise<SerialProfile[]>;
  saveSerialProfiles(profiles: SerialProfile[]): Promise<void>;
  getLocalShellProfiles(): Promise<LocalShellProfile[]>;
  saveLocalShellProfiles(profiles: LocalShellProfile[]): Promise<void>;
  getGroups(): Promise<string[]>;
  saveGroups(groups: string[]): Promise<void>;
  getAuthProfiles(): Promise<AuthProfile[]>;
  saveAuthProfiles(profiles: AuthProfile[]): Promise<void>;
}

export interface SessionSnapshot {
  servers: ServerConfig[];
  tunnels: TunnelProfile[];
  serialProfiles: SerialProfile[];
  localShellProfiles: LocalShellProfile[];
  activeSessions: ActiveSession[];
  activeSerialSessions: ActiveSerialSession[];
  activeLocalShellSessions: ActiveLocalShellSession[];
  activeTunnels: ActiveTunnel[];
  remoteTunnels: TunnelRegistryEntry[];
  explicitGroups: string[];
  authProfiles: AuthProfile[];
  activitySessionIds: ReadonlySet<string>;
  focusedSessionId: string | undefined;
}

export interface TunnelRegistryStore {
  getEntries(): Promise<TunnelRegistryEntry[]>;
  saveEntries(entries: TunnelRegistryEntry[]): Promise<void>;
}
