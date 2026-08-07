import type { PtyOutputObserver } from "../services/macroAutoTrigger";
import type * as vscode from "vscode";

export type AuthType = "password" | "key" | "agent";
export type TunnelConnectionMode = "isolated" | "shared" | "ask";
export type ResolvedTunnelConnectionMode = Exclude<TunnelConnectionMode, "ask">;
export type TunnelType = "local" | "reverse" | "dynamic";
export type SerialParity = "none" | "even" | "odd" | "mark" | "space";
export type SerialDataBits = 5 | 6 | 7 | 8;
export type SerialStopBits = 1 | 2;
export type SerialProfileMode = "standard" | "smartFollow";
export type SerialSessionStatus = "connected" | "waiting";
export type LocalShellLaunchMode = "vscodeProfile" | "custom";

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

/** Marks a server as materialized by an inventory sync rather than added by hand. */
export interface ServerOrigin {
  sourceId: string; // InventorySourceConfig.id
  externalId: string; // InventoryDevice.externalId within that source
  syncedAt: number;
}

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
  legacyAlgorithms?: boolean;
  openFileExplorerOnFirstConnect?: boolean;
  proxy?: ProxyConfig;
  authProfileId?: string;  // references AuthProfile.id; credentials resolved at connection time
  origin?: ServerOrigin;
}

/**
 * Shallow-plus-one-level clone: ServerConfig's own fields are primitives, but
 * `proxy` and `origin` are nested objects, so a plain `{...server}` would
 * still share those two references with the source. Used by
 * NexusCore.applyInventorySyncPlan to capture a structural snapshot of each
 * batch-written server AT WRITE TIME, before any later in-place mutation
 * (e.g. _renameFolderPath rewriting `server.group` on the very same object)
 * can change what the live map entry looks like out from under it.
 */
export function cloneServerConfig(server: ServerConfig): ServerConfig {
  return {
    ...server,
    proxy: server.proxy ? { ...server.proxy } : server.proxy,
    origin: server.origin ? { ...server.origin } : server.origin
  };
}

function proxyConfigsEqual(a: ProxyConfig | undefined, b: ProxyConfig | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  switch (a.type) {
    case "ssh":
      return a.jumpHostId === (b as SshJumpProxy).jumpHostId;
    case "socks5":
    case "http": {
      const other = b as Socks5Proxy | HttpConnectProxy;
      return a.host === other.host && a.port === other.port && a.username === other.username;
    }
  }
}

function serverOriginsEqual(a: ServerOrigin | undefined, b: ServerOrigin | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.sourceId === b.sourceId && a.externalId === b.externalId && a.syncedAt === b.syncedAt;
}

/**
 * Field-wise structural comparison — the ServerConfig counterpart of
 * inventory.ts's sourceConfigUnchanged. Used (instead of `===`) wherever a
 * rollback needs to tell "still exactly what we wrote" apart from "changed
 * since, even if it's the same object reference" — see FINDING 2 in
 * NexusCore.applyInventorySyncPlan: _renameFolderPath and
 * removeFolderCascade both mutate `server.group` IN PLACE on the object
 * already sitting in the servers map, so a reference check (`a === b`) stays
 * true across that mutation and would wrongly call the entry "unchanged".
 */
export function serverConfigsEqual(a: ServerConfig, b: ServerConfig): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.group === b.group &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    a.authType === b.authType &&
    a.keyPath === b.keyPath &&
    a.isHidden === b.isHidden &&
    a.logSession === b.logSession &&
    a.multiplexing === b.multiplexing &&
    a.legacyAlgorithms === b.legacyAlgorithms &&
    a.openFileExplorerOnFirstConnect === b.openFileExplorerOnFirstConnect &&
    a.authProfileId === b.authProfileId &&
    proxyConfigsEqual(a.proxy, b.proxy) &&
    serverOriginsEqual(a.origin, b.origin)
  );
}

/**
 * Field-wise rollback merge for applyInventorySyncPlan's conditional restore
 * (REVIEW FINDING 1 / P2). Used only for a batch-UPDATED record (one that
 * existed before the batch touched it) whose current live entry has diverged
 * from `batchSnapshot` — the structural snapshot captured at write time —
 * because of a concurrent in-place mutation (e.g. _renameFolderPath /
 * removeFolderCascade rewriting `.group`) or a concurrent replace while this
 * batch's persist was still in flight.
 *
 * Without this, the caller's only options were "restore `prior` wholesale"
 * (which would also revert the concurrent edit — wrong) or "leave `current`
 * alone" (which keeps the REJECTED batch write's fields, e.g. a bogus host
 * from a sync that just failed to persist — also wrong). This merges the two:
 * for each of ServerConfig's own fields, a field that the concurrent mutation
 * actually touched (current differs from what THIS batch wrote) keeps its
 * CURRENT value; every other field falls back to `prior` (the pre-batch
 * value), discarding the batch's now-rejected write for that field.
 *
 * Only meaningful when `prior` is defined — a batch-CREATED record has no
 * pre-batch state to fall back to (see the call site in
 * NexusCore.applyInventorySyncPlan, which keeps `current` as-is instead of
 * calling this for that case).
 */
export function mergeServerConfigFields(prior: ServerConfig, batchSnapshot: ServerConfig, current: ServerConfig): ServerConfig {
  const merged: ServerConfig = { ...prior };
  if (current.name !== batchSnapshot.name) merged.name = current.name;
  if (current.group !== batchSnapshot.group) merged.group = current.group;
  if (current.host !== batchSnapshot.host) merged.host = current.host;
  if (current.port !== batchSnapshot.port) merged.port = current.port;
  if (current.username !== batchSnapshot.username) merged.username = current.username;
  if (current.authType !== batchSnapshot.authType) merged.authType = current.authType;
  if (current.keyPath !== batchSnapshot.keyPath) merged.keyPath = current.keyPath;
  if (current.isHidden !== batchSnapshot.isHidden) merged.isHidden = current.isHidden;
  if (current.logSession !== batchSnapshot.logSession) merged.logSession = current.logSession;
  if (current.multiplexing !== batchSnapshot.multiplexing) merged.multiplexing = current.multiplexing;
  if (current.legacyAlgorithms !== batchSnapshot.legacyAlgorithms) merged.legacyAlgorithms = current.legacyAlgorithms;
  if (current.openFileExplorerOnFirstConnect !== batchSnapshot.openFileExplorerOnFirstConnect) {
    merged.openFileExplorerOnFirstConnect = current.openFileExplorerOnFirstConnect;
  }
  if (current.authProfileId !== batchSnapshot.authProfileId) merged.authProfileId = current.authProfileId;
  if (!proxyConfigsEqual(current.proxy, batchSnapshot.proxy)) {
    merged.proxy = current.proxy ? { ...current.proxy } : current.proxy;
  }
  if (!serverOriginsEqual(current.origin, batchSnapshot.origin)) {
    merged.origin = current.origin ? { ...current.origin } : current.origin;
  }
  // id never changes across a rollback merge — always prior's (== current's,
  // == batchSnapshot's; the map key this is stored under is invariant).
  merged.id = prior.id;
  return merged;
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

export interface SerialDeviceHint {
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
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
  mode?: SerialProfileMode;
  deviceHint?: SerialDeviceHint;
}

export interface LocalShellProfile {
  id: string;
  name: string;
  group?: string;
  launchMode: LocalShellLaunchMode;
  vscodeProfileName?: string;
  shellPath?: string;
  shellArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  startupCommand?: string;
}

/**
 * Narrow runtime handle exposed by SshPty / SmartSerialPty / SerialPty. Consumers
 * include the script runtime (observe I/O, write programmatically, lock input),
 * terminal tab commands (reset screen), and the extension deactivate hook
 * (flush a farewell banner before the host tears down).
 */
export interface SessionPtyHandle {
  addOutputObserver(observer: PtyOutputObserver): vscode.Disposable;
  setInputBlocked(blocked: boolean): void;
  /**
   * Write text to the underlying transport (SSH stream or serial port) on behalf of a script.
   * Bypasses the user-input lock (scripts own the lock) but silently no-ops if the session is
   * disconnected — the runtime's NexusCore.onDidChange subscription surfaces ConnectionLost.
   */
  writeProgrammatic(data: string): void;
  /**
   * Clear the visible terminal screen while preserving scrollback history. Emits the
   * clear-screen escape through the PTY's local `writeEmitter` only — never to the
   * remote transport (SSH stream or serial port), so the remote shell state and any
   * connected device remain untouched.
   */
  resetTerminal(): void;
  /**
   * Write a final farewell banner and tear down the transport while keeping the
   * terminal tab visible. Used when the extension host is shutting down (reload,
   * disable, update) so the user sees a clear message instead of a silently hung
   * tab. Implementations MUST NOT fire `closeEmitter` or call `dispose()`.
   */
  markShuttingDown(reason: string): void;
}

export interface ActiveSession {
  id: string;
  serverId: string;
  terminalName: string;
  startedAt: number;
  pty?: SessionPtyHandle;
}

export interface ActiveSerialSession {
  id: string;
  profileId: string;
  terminalName: string;
  startedAt: number;
  status?: SerialSessionStatus;
  pty?: SessionPtyHandle;
}

export interface ActiveLocalShellSession {
  id: string;
  profileId: string;
  terminalName: string;
  startedAt: number;
  pty?: SessionPtyHandle;
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
  // Key passphrase stored in SecretVault under "auth-profile-passphrase-{id}"
}

export function resolveTunnelType(profile: TunnelProfile): TunnelType {
  return profile.tunnelType ?? "local";
}

export function resolveSerialProfileMode(profile: Pick<SerialProfile, "mode">): SerialProfileMode {
  return profile.mode ?? "standard";
}
