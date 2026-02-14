import type { ActiveSession, ActiveTunnel, ServerConfig, TunnelProfile } from "../models/config";

export interface ConfigRepository {
  getServers(): Promise<ServerConfig[]>;
  saveServers(servers: ServerConfig[]): Promise<void>;
  getTunnels(): Promise<TunnelProfile[]>;
  saveTunnels(tunnels: TunnelProfile[]): Promise<void>;
}

export interface SessionSnapshot {
  servers: ServerConfig[];
  tunnels: TunnelProfile[];
  activeSessions: ActiveSession[];
  activeTunnels: ActiveTunnel[];
}
