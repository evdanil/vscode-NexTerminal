import type { ServerConfig } from "../../models/config";
import { proxyConfigsEqual, resolveServerProtocol } from "../../models/config";

/**
 * Which ServerConfig fields a POOLED (multiplexed) connection is established
 * with. Exhaustive over `keyof ServerConfig`, so a newly added field is a compile
 * error until someone decides whether it belongs here, and
 * test/unit/pooledConnectionParams.test.ts ties this table to the start-descriptor
 * classification so the two cannot drift.
 *
 * Deliberate differences from the start descriptors (which are built from the
 * effective server): this compares RAW stored fields, because it runs per
 * mutation with no auth-profile lookup (a profile edit is handled by its own
 * sweep) and a linked profile's supplied fields are not on the record; `keyPath`
 * counts for any auth type, and `multiplexing` compares the stored value rather
 * than the effective one. Over-invalidating costs only a fresh connection.
 * `id` is identity, never a change; `logSession` is a transcript preference.
 */
export const POOLED_CONNECTION_FIELDS: Record<keyof ServerConfig, boolean> = {
  id: false,
  name: false,
  group: false,
  host: true,
  port: true,
  addressless: true,
  // A jump host switched to Telnet must stop being reachable through a pooled
  // target transport that rides it (ProxySshFactory refuses a Telnet jump).
  protocol: true,
  // SshPty's alternate-host fallback can establish the pooled entry.
  altHost: true,
  username: true,
  authType: true,
  keyPath: true,
  isHidden: false,
  logSession: false,
  multiplexing: true,
  legacyAlgorithms: true,
  ipmiHost: false,
  ipmiAuthProfileId: false,
  bmcWebProtocol: false,
  ipmiGatewayServerId: false,
  openFileExplorerOnFirstConnect: false,
  proxy: true,
  authProfileId: true,
  origin: false,
  formerlySynced: false
};

const POOLED_KEYS = (Object.keys(POOLED_CONNECTION_FIELDS) as Array<keyof ServerConfig>).filter(
  (key) => POOLED_CONNECTION_FIELDS[key]
);

/**
 * Whether a server edit changed any parameter a LIVE pooled (multiplexed) SSH
 * connection was established with — in which case the pool entry for that server id
 * must be invalidated so the next terminal reconnects with the new settings instead
 * of reusing a socket to the old destination / credentials. Driven by
 * POOLED_CONNECTION_FIELDS, so the field list is enforced rather than hand-kept.
 *
 * `altHost` counts for the same reason `host` does (issue #48): the terminal
 * connect-fallback (`SshPty`) can establish the pooled connection against the
 * ALTERNATE address, so a cached connection to the OLD alternate must not be reused.
 * `proxy` is compared structurally (proxyConfigsEqual). Pure and vscode-free; the
 * saved proxy password of an endpoint a server left is cleaned up separately, after
 * persistence, by poolConfigInvalidation.ts.
 */
export function pooledConnectionParamsChanged(prev: ServerConfig, next: ServerConfig): boolean {
  return POOLED_KEYS.some((key) => {
    if (key === "proxy") {
      return !proxyConfigsEqual(prev.proxy, next.proxy);
    }
    if (key === "addressless") {
      return (prev.addressless ?? false) !== (next.addressless ?? false);
    }
    if (key === "protocol") {
      return resolveServerProtocol(prev) !== resolveServerProtocol(next);
    }
    return prev[key] !== next[key];
  });
}

/**
 * The servers whose pooled connection rides one of `changedIds` as a jump host,
 * directly or through further hops (a cycle terminates: each id is visited once).
 * When a jump host's connection params change, its own pool entry is
 * soft-invalidated, but a target's pooled transport was built THROUGH the old
 * jump and would otherwise be reused for the next terminal reconnect or tunnel
 * over that stale route. Soft invalidation keeps live leases running and only
 * makes new acquisitions build a fresh connection over the current route.
 * Linear: one reverse jumpHostId -> dependents index, then a BFS.
 */
export function serversRidingChangedJumps(
  servers: readonly ServerConfig[],
  changedIds: ReadonlySet<string>
): Set<string> {
  const ridersOf = new Map<string, string[]>();
  for (const server of servers) {
    if (server.proxy?.type === "ssh") {
      const riders = ridersOf.get(server.proxy.jumpHostId);
      if (riders) riders.push(server.id);
      else ridersOf.set(server.proxy.jumpHostId, [server.id]);
    }
  }
  return ridersFromIndex(ridersOf, changedIds);
}

/** BFS over a jumpHostId -> riders index. Excludes the seeds; terminates on a cycle. */
export function ridersFromIndex(
  ridersOf: ReadonlyMap<string, Iterable<string>>,
  seeds: ReadonlySet<string>
): Set<string> {
  const affected = new Set<string>();
  const queue = [...seeds];
  for (let i = 0; i < queue.length; i++) {
    for (const rider of ridersOf.get(queue[i]) ?? []) {
      if (!seeds.has(rider) && !affected.has(rider)) {
        affected.add(rider);
        queue.push(rider);
      }
    }
  }
  return affected;
}
