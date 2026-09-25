import type { ServerConfig } from "../../models/config";
import { TunnelManager } from "../tunnel/tunnelManager";
import type { SecretVault } from "./contracts";
import { ProxySshFactory, type ProxyPasswordPrompt } from "./proxySshFactory";
import type { SilentAuthSshFactory } from "./silentAuth";
import { SshConnectionPool, type PoolOptions } from "./sshConnectionPool";

export interface SshTransportStackOptions {
  serverLookup: (id: string) => ServerConfig | undefined;
  vault: SecretVault;
  proxyTimeoutMs: number;
  promptProxyPassword?: ProxyPasswordPrompt;
  pool: PoolOptions;
  socks5HandshakeTimeoutMs: number;
}

export interface SshTransportStack {
  proxiedFactory: ProxySshFactory;
  pool: SshConnectionPool;
  tunnelManager: TunnelManager;
}

/**
 * Composes the SSH connection layers `activate()` hands out: credentials
 * (`authFactory`) → the server's Proxy (`proxiedFactory`) → the multiplexing
 * pool. Kept out of `activate()` so the composition itself is testable.
 *
 * `authFactory` is an ingredient here and nothing else. It dials the server's
 * Host directly and never reads its Proxy, so a consumer handed it bypasses a
 * configured jump host, SOCKS5 or HTTP CONNECT proxy — failing where the server
 * is reachable only through the proxy, or succeeding on the direct path the
 * user set the proxy up to avoid. Isolated-mode tunnels were wired that way
 * (issue #148).
 */
export function createSshTransportStack(
  authFactory: SilentAuthSshFactory,
  options: SshTransportStackOptions
): SshTransportStack {
  const proxiedFactory = new ProxySshFactory(
    authFactory,
    options.serverLookup,
    options.vault,
    options.proxyTimeoutMs,
    options.promptProxyPassword
  );
  const pool = new SshConnectionPool(proxiedFactory, options.pool);
  // A jump-host hop is leased from the pool, so everything reaching a target
  // behind a bastion shares one authenticated bastion connection (unless
  // multiplexing is off for the bastion) instead of logging in to it again —
  // and prompting again, for a password or 2FA — on every hop.
  proxiedFactory.setJumpHostConnectionFactory(pool);
  // Isolated mode gets `proxiedFactory`, not the pool: each client needs its
  // own connection to the target — a pool lease would ride the terminal's —
  // but it must still take the server's proxy, including the pooled bastion hop.
  const tunnelManager = new TunnelManager(pool, proxiedFactory, options.socks5HandshakeTimeoutMs, options.serverLookup);
  return { proxiedFactory, pool, tunnelManager };
}
