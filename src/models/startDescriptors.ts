import type { ProxyConfig, ResolvedTunnelConnectionMode, ServerConfig, TunnelProfile } from "./config";
import {
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
 * The field classification is pinned by test/unit/startDescriptors.test.ts,
 * which lists every ServerConfig and TunnelProfile key: adding a field fails
 * that test until someone decides whether the connect path, the tunnel path or
 * neither reads it.
 *
 * Pure and vscode-free: runtime inputs (the pool's multiplexing default, the
 * effective tunnel mode) are passed in the same way the runtime receives them.
 */

export interface ConnectDescriptorInputs {
  /** `SshPoolControl.multiplexingDefault` — the pool's captured default. */
  multiplexingDefault?: boolean;
}

function proxyDescriptor(proxy: ProxyConfig | undefined): unknown {
  if (!proxy) return null;
  return proxy.type === "ssh"
    ? ["ssh", proxy.jumpHostId]
    : [proxy.type, proxy.host, proxy.port, proxy.username ?? null];
}

/** Server fields the SSH transport (credentials, proxy, connector) reads. */
function transportDescriptor(server: ServerConfig): unknown[] {
  return [
    server.id,
    server.host,
    server.port,
    server.addressless ?? false,
    resolveServerProtocol(server),
    server.username,
    server.authType,
    // Only a key login reads the key file; a stale path on a password or agent
    // server must not cancel a start. (An auth-profile override of the auth type
    // is deliberately not resolved here.)
    server.authType === "key" ? server.keyPath || null : null,
    server.authProfileId || null,
    Boolean(server.legacyAlgorithms),
    proxyDescriptor(server.proxy)
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
    transportDescriptor(server),
    altHost,
    server.multiplexing ?? inputs.multiplexingDefault ?? true
  ]);
}

export interface TunnelDescriptorInputs extends ConnectDescriptorInputs {
  /** The effective mode for this attempt, after `resolveTunnelConnectionMode`. */
  mode: ResolvedTunnelConnectionMode | "ask";
}

/**
 * What a tunnel start uses. Unlike a terminal connect it never dials `altHost`
 * (an isolated tunnel goes through ProxySshFactory to the primary host; a shared
 * one leases the pool), and multiplexing matters only when the pool is used.
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
  return JSON.stringify([
    profile.id,
    type,
    mode,
    profile.localPort,
    route,
    transportDescriptor(server),
    mode === "shared" ? server.multiplexing ?? inputs.multiplexingDefault ?? true : null
  ]);
}
