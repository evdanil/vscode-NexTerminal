import type { AuthProfile, ProxyConfig, ResolvedTunnelConnectionMode, ServerConfig, TunnelProfile } from "./config";
import {
  applyAuthProfile,
  resolveServerProtocol,
  resolveTunnelLocalBindAddress,
  resolveTunnelLocalTargetIP,
  resolveTunnelRemoteBindAddress,
  resolveTunnelType
} from "./config";

/**
 * "Effective connection descriptors": the resolved values a start attempt will
 * actually use, not the stored representation. A pending start is cancelled only
 * when the descriptor captured at its beginning differs from the descriptor
 * recomputed from the live records, so an explicit default and an absent value
 * (or a rename, folder move, notes edit) can never read as a change, and a value
 * the attempt does not use can never cancel it.
 *
 * Secrets are deliberately NOT part of a descriptor: a saved SSH password, key
 * passphrase or proxy password lives in SecretStorage, not in ServerConfig or
 * ProxyConfig, and these fences compare configuration records. A secret changed
 * mid-start therefore does not cancel it; the new value is used at the next
 * login. test/unit/startDescriptors.test.ts pins that no secret-bearing field
 * enters a descriptor.
 *
 * The field classification is pinned by test/unit/startDescriptors.test.ts,
 * which lists every ServerConfig and TunnelProfile key: adding a field fails
 * that test until someone decides whether the connect path, the tunnel path or
 * neither reads it.
 *
 * Pure and vscode-free: runtime inputs (the pool's multiplexing default, the
 * effective tunnel mode) are passed in the same way the runtime receives them.
 */

export interface ConnectDescriptorInputs {
  /**
   * Looks up the linked auth profile (NexusCore.getAuthProfile). The descriptor
   * is built from the EFFECTIVE server — profile applied, exactly as
   * SilentAuthSshFactory.resolveServer applies it — so editing the profile's
   * username, auth type or key path changes it even though the id is the same.
   * Absent lookup or a deleted profile leaves the server's own fields.
   */
  authProfileLookup?: (id: string) => AuthProfile | undefined;
  /**
   * Looks up a jump-host server by id (NexusCore.getServer). A jump hop is part
   * of the connection, so its own effective transport fields count, recursively.
   * A missing hop is a distinct value, not a crash.
   */
  serverLookup?: (id: string) => ServerConfig | undefined;
  /** `SshPoolControl.multiplexingDefault` — the pool's captured default. */
  multiplexingDefault?: boolean;
}

function proxyDescriptor(proxy: ProxyConfig | undefined, inputs: ConnectDescriptorInputs, visited: ReadonlySet<string>): unknown {
  if (!proxy) return null;
  if (proxy.type !== "ssh") {
    // An empty username is "no proxy auth" at runtime, the same as absent.
    return [proxy.type, proxy.host, proxy.port, proxy.username || null];
  }
  const hop = inputs.serverLookup?.(proxy.jumpHostId);
  if (!hop) return ["ssh", proxy.jumpHostId, "missing"];
  // ProxySshFactory rejects a cycle; the descriptor terminates on one with a
  // sentinel so it stays finite and stable.
  if (visited.has(hop.id)) return ["ssh", proxy.jumpHostId, "cycle"];
  const hopMultiplexed = hop.multiplexing ?? inputs.multiplexingDefault ?? true;
  const hopAltHost = typeof hop.altHost === "string" && hop.altHost.trim() !== "" ? hop.altHost.trim() : null;
  return [
    "ssh",
    proxy.jumpHostId,
    // The hop's own effective transport (its profile applied, its own proxy or
    // jump), and — because a jump hop always leases the pool unless multiplexing
    // is off for it — its multiplexing and, when pooled, its alternate host.
    transportDescriptor(hop, inputs, visited),
    hopMultiplexed,
    hopMultiplexed ? hopAltHost : null
  ];
}

/** Server fields the SSH transport (login identity, key file, proxy, connector) reads; never secrets. */
function transportDescriptor(
  rawServer: ServerConfig,
  inputs: ConnectDescriptorInputs,
  visited: ReadonlySet<string> = new Set()
): unknown[] {
  const profile = rawServer.authProfileId ? inputs.authProfileLookup?.(rawServer.authProfileId) : undefined;
  const server = applyAuthProfile(rawServer, profile);
  const chain = new Set(visited).add(server.id);
  return [
    server.id,
    server.host,
    server.port,
    server.addressless ?? false,
    resolveServerProtocol(server),
    server.username,
    server.authType,
    // The key file is read only by a key login, judged on the EFFECTIVE auth type.
    server.authType === "key" ? server.keyPath || null : null,
    // The link itself, so switching profiles cancels; the profile's supplied
    // fields are already folded into the values above. And which credential scope
    // is actually selected, mirroring SilentAuthSshFactory.resolveServer: the
    // profile-scoped password/passphrase key only when the link is set AND the
    // profile was found, the server-scoped key otherwise. A profile that vanishes
    // (another window between removeAuthProfile's two saves) can leave every
    // effective field equal to the server's own yet switch the credential source.
    rawServer.authProfileId || null,
    profile !== undefined,
    Boolean(server.legacyAlgorithms),
    proxyDescriptor(server.proxy, inputs, chain)
  ];
}

/** What a terminal connect uses; includes the alternate host SshPty falls back to. */
export function connectDescriptor(server: ServerConfig, inputs: ConnectDescriptorInputs = {}): string {
  // TelnetPty dials host:port and reads nothing else, so SSH-only fields
  // (credentials, proxy, key, alt host, multiplexing) must not cancel a telnet
  // connect — for example the auth-profile removal sweep or an inventory sync
  // writing username/proxy during the dial.
  if (resolveServerProtocol(server) === "telnet") {
    return JSON.stringify([server.id, server.host, server.port, server.addressless ?? false, "telnet"]);
  }
  const altHost = typeof server.altHost === "string" && server.altHost.trim() !== "" ? server.altHost.trim() : null;
  return JSON.stringify([
    transportDescriptor(server, inputs),
    altHost,
    server.multiplexing ?? inputs.multiplexingDefault ?? true
  ]);
}

export interface TunnelDescriptorInputs extends ConnectDescriptorInputs {
  /** The effective mode for this attempt, after `resolveTunnelConnectionMode`. */
  mode: ResolvedTunnelConnectionMode | "ask";
}

/**
 * What a tunnel start uses. A tunnel never dials `altHost` itself: an isolated
 * one goes through ProxySshFactory to the primary host, and a shared one with
 * multiplexing off bypasses the pool. But a shared, multiplexed tunnel leases
 * the pool entry keyed by server id, and a terminal's alternate-host fallback
 * (SshPty, sshPty.ts) can have established that entry against `altHost`, so an
 * `altHost` edit changes which endpoint the lease reaches; it counts only when
 * the pool is used. Multiplexing itself matters only when the mode is shared.
 */
export function tunnelStartDescriptor(
  profile: TunnelProfile,
  server: ServerConfig,
  inputs: TunnelDescriptorInputs
): string {
  const type = resolveTunnelType(profile);
  const mode = type === "reverse" ? "shared" : inputs.mode;
  let route: unknown[];
  switch (type) {
    case "dynamic":
      route = [resolveTunnelLocalBindAddress(profile)];
      break;
    case "reverse":
      route = [profile.remotePort, resolveTunnelRemoteBindAddress(profile), resolveTunnelLocalTargetIP(profile)];
      break;
    default:
      route = [profile.remoteIP, profile.remotePort, resolveTunnelLocalBindAddress(profile)];
      break;
  }
  const multiplexed = mode === "shared" ? server.multiplexing ?? inputs.multiplexingDefault ?? true : null;
  const altHost = typeof server.altHost === "string" && server.altHost.trim() !== "" ? server.altHost.trim() : null;
  return JSON.stringify([
    profile.id,
    type,
    mode,
    profile.localPort,
    route,
    transportDescriptor(server, inputs),
    multiplexed,
    // Only a pooled lease can inherit an alternate-host connection.
    multiplexed === true ? altHost : null
  ]);
}
