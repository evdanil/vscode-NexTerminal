export type AuthType = "password" | "key" | "agent";
export type TunnelConnectionMode = "isolated" | "shared" | "ask";
export type ResolvedTunnelConnectionMode = Exclude<TunnelConnectionMode, "ask">;
export type TunnelType = "local" | "reverse" | "dynamic";
export type SerialParity = "none" | "even" | "odd" | "mark" | "space";
export type SerialDataBits = 5 | 6 | 7 | 8;
export type SerialStopBits = 1 | 2;

export interface SshJumpProxy {
  type: "ssh";
  jumpHostId: string;  // references another ServerConfig.id
}

export interface Socks5Proxy {
  type: "socks5";
  host: string;
  port: number;
  username?: string;
  // password stored in SecretStorage: "proxy-password-{serverId}"
}

export interface HttpConnectProxy {
  type: "http";
  host: string;
  port: number;
  username?: string;
  // password stored in SecretStorage: "proxy-password-{serverId}"
}

export type ProxyConfig = SshJumpProxy | Socks5Proxy | HttpConnectProxy;

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
  logSession?: boolean;
  multiplexing?: boolean;  // undefined = follow global, false = always standalone
  proxy?: ProxyConfig;
}

export interface TunnelProfile {
  id: string;
  name: string;
  localPort: number;
  remoteIP: string;
  remotePort: number;
  defaultServerId?: string;
  autoStart: boolean;
  autoStop?: boolean;
  connectionMode?: TunnelConnectionMode;
  tunnelType?: TunnelType;
  remoteBindAddress?: string;
  localTargetIP?: string;
  localBindAddress?: string;
  notes?: string;
  browserUrl?: string;
}

export interface SerialProfile {
  id: string;
  name: string;
  group?: string;
  path: string;
  baudRate: number;
  dataBits: SerialDataBits;
  stopBits: SerialStopBits;
  parity: SerialParity;
  rtscts: boolean;
  logSession?: boolean;
}

export interface ActiveSession {
  id: string;
  serverId: string;
  terminalName: string;
  startedAt: number;
}

export interface ActiveSerialSession {
  id: string;
  profileId: string;
  terminalName: string;
  startedAt: number;
}

export interface TunnelRouteInfo {
  profileId: string;
  serverId: string;
  localPort: number;
  remoteIP: string;
  remotePort: number;
  connectionMode: ResolvedTunnelConnectionMode;
  tunnelType: TunnelType;
  remoteBindAddress?: string;
  localTargetIP?: string;
  localBindAddress?: string;
  startedAt: number;
}

export interface ActiveTunnel extends TunnelRouteInfo {
  id: string;
  bytesIn: number;
  bytesOut: number;
}

export interface TunnelRegistryEntry extends TunnelRouteInfo {
  ownerSessionId: string;
  lastSeen?: number;
}

export interface AuthProfile {
  id: string;       // UUID
  name: string;     // e.g. "Production Servers"
  username: string;
  authType: AuthType;
  keyPath?: string;  // only for authType === "key"
  // Password stored in SecretVault under "auth-profile-password-{id}"
}

export function resolveTunnelType(profile: TunnelProfile): TunnelType {
  return profile.tunnelType ?? "local";
}
