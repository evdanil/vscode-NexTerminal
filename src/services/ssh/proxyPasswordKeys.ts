import { createHash } from "node:crypto";
import type { HttpConnectProxy, ProxyConfig, ServerConfig, Socks5Proxy } from "../../models/config";
import type { SecretVault } from "./contracts";

/**
 * SecretStorage keys for a server's saved SOCKS5 / HTTP CONNECT proxy password.
 *
 * The password belongs to an ENDPOINT, not to a server: it is what one proxy
 * (type, host, port, user name) accepted. Keying it per server made every proxy
 * edit a race between the edit, the deletion of the old password and any connect
 * or prompt in between. Keyed per endpoint, a password entered for proxy B can
 * never be read while the server points at proxy A, and rolling an edit back
 * simply finds A's own key untouched, so no tombstone, ordering or generation
 * logic is needed. Removing the keys of endpoints a server no longer uses is
 * housekeeping after persistence, not a safety requirement: a stale key is
 * never read for another endpoint.
 *
 * Cross-window writes to one secret key are last-writer-wins, like `globalState`
 * (SecretStorage has no compare-and-swap); this window orders only its own operations
 * (KeySerializedSecretVault). The worst case of a lost race is a password that is
 * missing or is an older one for the SAME endpoint, which shows up as a re-prompt after
 * an authentication failure. Because the key names the endpoint, a password can never
 * be read for, or sent to, a different endpoint.
 *
 * `proxy-password-{serverId}` is the LEGACY per-server key (installs before
 * endpoint keys); it is migrated at activation and still cleared on delete.
 */
export type PasswordBearingProxy = Socks5Proxy | HttpConnectProxy;

/** A socks5/http proxy: the only kinds ProxySshFactory sends a password to (an ssh jump carries none). */
export function isPasswordBearingProxy(proxy: ProxyConfig | undefined): proxy is PasswordBearingProxy {
  return proxy !== undefined && (proxy.type === "socks5" || proxy.type === "http");
}

/** The identity the stored password was entered for: type + host + port + user name. */
function endpointIdentity(proxy: PasswordBearingProxy): string {
  return [proxy.type, proxy.host, String(proxy.port), proxy.username ?? ""].join("\n");
}

/** The per-server key used before endpoint keys existed. */
export function legacyProxyPasswordSecretKey(serverId: string): string {
  return `proxy-password-${serverId}`;
}

/** THE key for a server's proxy password at one endpoint. Every reader, writer and deleter uses this. */
export function proxyPasswordSecretKey(serverId: string, proxy: PasswordBearingProxy): string {
  const hash = createHash("sha256").update(endpointIdentity(proxy)).digest("hex").slice(0, 24);
  return `proxy-password-${serverId}-${hash}`;
}

/**
 * Every endpoint-keyed proxy password key that belongs to `serverId` in `allKeys`. Exact:
 * `proxy-password-{id}-` followed by the 24-hex endpoint hash and nothing else, so a
 * server whose id starts with another's (`srv` and `srv-1`) never matches the wrong keys.
 */
export function endpointProxyPasswordKeysOf(serverId: string, allKeys: readonly string[]): string[] {
  const prefix = `proxy-password-${serverId}-`;
  return allKeys.filter((key) => key.startsWith(prefix) && /^[0-9a-f]{24}$/.test(key.slice(prefix.length)));
}

/** The key for the server's CURRENT proxy, or undefined when it has no password-bearing proxy. */
export function currentProxyPasswordSecretKey(server: Pick<ServerConfig, "id" | "proxy">): string | undefined {
  return isPasswordBearingProxy(server.proxy) ? proxyPasswordSecretKey(server.id, server.proxy) : undefined;
}

/**
 * Activation-time migration of legacy per-server keys, run before anything can
 * connect. The legacy value was valid for the server's CURRENT persisted proxy
 * (the old code deleted it whenever the endpoint changed), so it moves to that
 * endpoint's key and the legacy key is deleted. Idempotent and safe across
 * windows: if the endpoint key already exists the legacy one is just deleted.
 * Residual cross-window risk: SecretStorage has no compare-and-swap, so between the
 * target read and the store another window could save a new password for this exact
 * endpoint and be overwritten by the legacy value. That needs a concurrent save for the
 * same endpoint during this window's activation, and the worst outcome is that the
 * endpoint holds the legacy value, which WAS valid for it: a wrong password fails
 * authentication, which invalidates the saved password and re-prompts. No data is lost
 * and nothing is sent to a different endpoint.
 *
 * Only servers with a password-bearing proxy are visited (an orphan legacy key on
 * any other server can never be read and is still cleared with the server), in
 * bounded parallel so a large inventory does not delay activation.
 */
export async function migrateLegacyProxyPasswords(
  vault: SecretVault,
  servers: readonly Pick<ServerConfig, "id" | "proxy">[]
): Promise<void> {
  const candidates = servers.filter((server) => isPasswordBearingProxy(server.proxy));
  const migrateOne = async (server: Pick<ServerConfig, "id" | "proxy">): Promise<void> => {
    const legacyKey = legacyProxyPasswordSecretKey(server.id);
    try {
      const legacy = await vault.get(legacyKey);
      if (legacy === undefined) {
        return;
      }
      const target = currentProxyPasswordSecretKey(server);
      // Read the target immediately before the store and skip when it exists: a password
      // another window saved for this endpoint meanwhile is newer than the legacy value.
      if (target !== undefined && (await vault.get(target)) === undefined) {
        await vault.store(target, legacy);
      }
      // Delete the legacy key only after the store has resolved, and only if it still holds
      // what was migrated: an older window rewriting it in the meantime keeps its value
      // for the next activation instead of losing it.
      if ((await vault.get(legacyKey)) === legacy) {
        await vault.delete(legacyKey);
      }
    } catch (error) {
      console.warn(`[Nexus] Could not migrate the legacy proxy password for server ${server.id}:`, error);
    }
  };
  const width = 16;
  for (let i = 0; i < candidates.length; i += width) {
    await Promise.all(candidates.slice(i, i + width).map(migrateOne));
  }
}
