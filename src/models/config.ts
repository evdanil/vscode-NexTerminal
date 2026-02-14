export type AuthType = "password" | "key" | "agent";
export type TunnelConnectionMode = "isolated" | "shared" | "ask";
export type ResolvedTunnelConnectionMode = Exclude<TunnelConnectionMode, "ask">;

export interface ServerConfig {
  id: string;
  name: string;
  group?: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  keyPath?: string;
  isHidden: boolean;
}

export interface TunnelProfile {
  id: string;
  name: string;
  localPort: number;
  remoteIP: string;
  remotePort: number;
  defaultServerId?: string;
  autoStart: boolean;
  connectionMode?: TunnelConnectionMode;
}

export interface ActiveSession {
  id: string;
  serverId: string;
  terminalName: string;
  startedAt: number;
}

export interface ActiveTunnel {
  id: string;
  profileId: string;
  serverId: string;
  localPort: number;
  remoteIP: string;
  remotePort: number;
  startedAt: number;
  bytesIn: number;
  bytesOut: number;
  connectionMode: ResolvedTunnelConnectionMode;
}
