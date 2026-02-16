import type {
  ActiveSerialSession,
  ActiveSession,
  ActiveTunnel,
  SerialProfile,
  ServerConfig,
  TunnelProfile
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
}

export interface SessionSnapshot {
  servers: ServerConfig[];
  tunnels: TunnelProfile[];
  serialProfiles: SerialProfile[];
  activeSessions: ActiveSession[];
  activeSerialSessions: ActiveSerialSession[];
  activeTunnels: ActiveTunnel[];
  explicitGroups: string[];
}
