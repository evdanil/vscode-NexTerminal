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
  /**
   * The username the sync itself last WROTE onto this server — `endpoint.username`
   * when the provider supplied one, otherwise the source's `defaultUsername` as of
   * that write. Recorded so a later sync can tell "still exactly what I stamped"
   * apart from "the user edited this", which comparing against the source's
   * *current* `defaultUsername` cannot: linking an auth profile rewrites
   * `defaultUsername` (the source form mirrors the profile's username into it), so
   * that comparison would call every already-synced server hand-edited the moment a
   * profile is chosen. See the AUTH 2 retro-apply rule in
   * services/inventory/syncEngine.ts, which is its only reader.
   *
   * Written ONLY where the sync writes `username` — the add path always, the update
   * path only when the endpoint supplied a username — and never inferred from the
   * record's current value, which would launder a hand-edit into "as stamped".
   *
   * Optional for backward compat: servers synced by a build before this field
   * existed have none, and the rule falls back to `defaultUsername` for them —
   * exactly the pre-existing behavior. Absent must never mean "ineligible".
   */
  syncedUsername?: string;
  /**
   * The auth profile the sync itself last LINKED on this server — the source's
   * resolved profile as of that write, and `undefined` when the sync linked none
   * (a profile-less source, or one whose reference no longer resolves).
   *
   * Recorded so a later sync can tell "the sync's own link, still exactly as
   * written" apart from "the user cleared the source's profile on THIS server".
   * Both leave `authProfileId` undefined, so without the stamp the retro-apply
   * rule reattaches the source's profile on the very next sync and a per-server
   * opt-out is impossible — the record satisfies every other clause again.
   *
   * Written ONLY where the sync writes `authProfileId` — the add path always
   * (whatever the source resolved to, `undefined` included), the update path only
   * when retro-apply actually fires — and never inferred from the record's current
   * value, which would launder a hand-edit into "as stamped" one sync later.
   *
   * Optional for backward compat, exactly like `syncedUsername`: servers synced by
   * a build before this field existed have none, which reads identically to a
   * server the sync deliberately linked nothing on. Both mean "the sync never put
   * a profile here" — precisely the state retro-apply is allowed to fill — so
   * absent must never mean "ineligible".
   *
   * Cleared alongside `authProfileId` by `NexusCore.removeAuthProfile` and by the
   * backup-import dangling sweep (commands/configCommands.ts) when the stamped
   * profile is DELETED: that clear is the system's doing, not a user opt-out, so
   * leaving the stamp behind would permanently exclude a server nobody ever
   * hand-configured. A stamp is only ever left standing against an `authProfileId`
   * the USER moved.
   */
  syncedAuthProfileId?: string;
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

/**
 * Every member of ServerOrigin EXCEPT `syncedAt` — i.e. the ownership key plus
 * the two stamps the sync writes as decision INPUTS for its own next run
 * (`syncedUsername`, `syncedAuthProfileId`).
 *
 * Exists for computeSyncPlan's `changed` check, which must be able to ask "did
 * this sync compute a stamp the record does not already carry?" without asking
 * "is this a different sync run?". `syncedAt` advances on every single run by
 * construction, so comparing origins WHOLESALE there would mark every owned
 * server as an update on every sync forever — a plan preview that always claims
 * to be rewriting the entire fleet, and a persist that always does.
 *
 * `serverOriginsEqual` below is defined in terms of this one so a member added
 * to ServerOrigin can only be forgotten in a single place.
 */
export function serverOriginStampsEqual(a: ServerOrigin | undefined, b: ServerOrigin | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.sourceId === b.sourceId &&
    a.externalId === b.externalId &&
    a.syncedUsername === b.syncedUsername &&
    a.syncedAuthProfileId === b.syncedAuthProfileId
  );
}

function serverOriginsEqual(a: ServerOrigin | undefined, b: ServerOrigin | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  // Every member of ServerOrigin is compared, the `syncedUsername` /
  // `syncedAuthProfileId` stamps included: they are what the retro-apply rule
  // reads, so an origin that differs only there is a materially different
  // record. Leaving either out would let the rollback merge in
  // mergeServerConfigFields call two origins "equal" and drop a freshly written
  // stamp back to the pre-batch one — after which the next sync would compare
  // against a username, or a profile link, the record no longer carries.
  return serverOriginStampsEqual(a, b) && a.syncedAt === b.syncedAt;
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

/**
 * The credential fields a linked auth profile can take over on a server —
 * every key present is one the profile SUPPLIES, carrying the exact value it
 * supplies. A key that is absent is one the server keeps for itself.
 */
export type AuthProfileOwnedCredentials = Partial<Pick<ServerConfig, "username" | "authType" | "keyPath">>;

/**
 * REVIEW FINDING (P2) — THE ONE RULE for "which credential fields does this
 * auth profile actually own?", shared verbatim by all three layers that had
 * each been answering it their own way:
 *
 *   * the CONNECT path — `SilentAuthSshFactory.resolveServer` spreads this
 *     over the server, so an unowned field keeps the server's own value
 *     instead of being blanked by the profile;
 *   * the SAVE path — `preserveLinkedServerCredentials` (serverCommands.ts)
 *     restores ONLY the owned keys from the stored record, so an edit the form
 *     legitimately permitted survives Save;
 *   * the FORM path — `authProfileFilledKeys` (ui/formDefinitions.ts) seeds the
 *     webview's `profileFilledKeys` from this, and the two `onAutofill` mirrors
 *     (`authProfileCredentialMirror` in serverCommands.ts,
 *     `authProfileUsernameMirror` in inventoryCommands.ts) send exactly these
 *     keys, so the webview's own runtime record (`filledKeysFromValues`, which
 *     independently drops blanks) lands on the same set by construction.
 *
 * THE RULE: a profile owns a field only when it supplies a USABLE value for
 * it. Blank and whitespace-only are not usable values — a whitespace username
 * is reachable through an imported backup (`validateAuthProfile` only checks
 * length; the profile editor trims and refuses blanks), and a `key` profile
 * with no `keyPath` is reachable through the editor itself. Owning such a
 * field means overwriting a working credential with one no SSH login can use,
 * locking the form control that could repair it, and reverting the repair if
 * the control was unlocked anyway. `authType` is a closed enum that is never
 * blank, so it is always owned.
 *
 * Values are returned TRIMMED, matching what the profile editor stores and
 * what `authProfileUsernameMirror`/`fallbackUsernameForSource` already showed
 * and saved — so what a form displays is bit-identical to what a connection
 * uses. An `undefined` profile (no link, or an id that resolves to nothing)
 * owns nothing; the caller's own value stands everywhere.
 */
export function authProfileOwnedCredentials(profile: AuthProfile | undefined): AuthProfileOwnedCredentials {
  if (!profile) {
    return {};
  }
  const owned: AuthProfileOwnedCredentials = { authType: profile.authType };
  const username = profile.username.trim();
  if (username !== "") {
    owned.username = username;
  }
  const keyPath = (profile.keyPath ?? "").trim();
  if (keyPath !== "") {
    owned.keyPath = keyPath;
  }
  return owned;
}

/**
 * REVIEW FINDING (P1) — the companion question THE ONE RULE above cannot
 * answer on its own: "can a server that brings NO key path of its own connect
 * through this profile?"
 *
 * `authType` is a closed enum and so is ALWAYS owned — deliberately, and that
 * stays (see below). The consequence is that a `key` profile with no key path
 * forces `authType: "key"` onto every server it is linked to while supplying
 * nothing for `keyPath`; `buildConnectConfig` (services/ssh/ssh2Connector.ts)
 * then throws `Missing keyPath for key auth on <server>` unless the SERVER
 * carries one itself. Such a profile is perfectly legitimate — it is the
 * shared-passphrase, per-server-key-file pattern the server form supports on
 * purpose (`updateProfileManagedFields` in ui/formHtml.ts leaves the Private
 * Key File control editable for exactly this profile, and
 * `preserveLinkedServerCredentials` keeps what you type into it). It is only
 * unusable where the server can have no key path of its own, which is every
 * server an inventory sync creates: the add path stamps the LINK only, with
 * `authType: "agent"` and no `keyPath`, and retro-apply targets precisely the
 * servers that still carry that shape.
 *
 * WHY NOT FIX THIS IN THE OWNERSHIP RULE INSTEAD (i.e. make such a profile own
 * no `authType` either) — three reasons, any one of them decisive:
 *
 *   * It would SILENTLY SUBSTITUTE the credentials the user did not choose.
 *     A synced server whose profile no longer owns `authType` keeps its own
 *     "agent", so the sync's servers go back to SSH-agent auth while the
 *     source's form still says the profile is linked and the profile still
 *     says key auth. Silently connecting with credentials nobody chose is the
 *     defect class this whole feature exists to remove, not a fix for it.
 *   * It would break the legitimate pattern above for every server whose own
 *     `authType` is not already "key". Linking such a profile to a manual
 *     password server plus a key file is a working, intended configuration
 *     today; dropping `authType` ownership turns it into a password login.
 *   * THE ONE RULE is per-field — "does the profile supply a usable value for
 *     THIS field" — and stays answerable from the profile alone. The question
 *     here is about a PAIRING (profile + a server that may or may not have a
 *     key path), so it belongs to whoever decides that pairing, which is what
 *     this predicate is for.
 *
 * Callers: the inventory source form's two persist helpers (reject the link at
 * the moment the user chooses it) and `computeSyncPlan` (refuse to stamp such
 * a link on adds OR through retro-apply, and warn) — see inventoryCommands.ts
 * and services/inventory/syncEngine.ts.
 *
 * Read off `authProfileOwnedCredentials` rather than off `profile.keyPath`
 * directly, so "supplies no usable key path" means exactly what it means
 * everywhere else — a whitespace-only path included.
 */
export function authProfileNeedsServerKeyPath(profile: AuthProfile | undefined): boolean {
  const owned = authProfileOwnedCredentials(profile);
  return owned.authType === "key" && owned.keyPath === undefined;
}

export function resolveTunnelType(profile: TunnelProfile): TunnelType {
  return profile.tunnelType ?? "local";
}

export function resolveSerialProfileMode(profile: Pick<SerialProfile, "mode">): SerialProfileMode {
  return profile.mode ?? "standard";
}
