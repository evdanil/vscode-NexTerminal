import type { ServerConfig } from "../../models/config";

/**
 * Whether a server edit changed any parameter a LIVE pooled (multiplexed) SSH
 * connection was established with — in which case the pool entry for that server id
 * must be invalidated so the next terminal reconnects with the new settings instead
 * of reusing a socket to the old destination / credentials.
 *
 * `altHost` is compared for the same reason `host` is (issue #48, PR #67 Codex round
 * 2): the terminal connect-fallback (`SshPty`) can establish the pooled connection
 * against the ALTERNATE address when the primary is unreachable. If `altHost` is later
 * changed by an edit or an inventory sync, a cached connection to the OLD alternate
 * would otherwise be reused — opening a shell on the wrong machine.
 *
 * Pure and vscode-free so it is unit-testable; `extension.ts` calls it from the
 * `onDidChange` handler. The `proxy` term stays a structural (`JSON.stringify`)
 * compare, matching the prior inline predicate exactly; the separate proxy-password
 * clear stays in `extension.ts` (it is a different concern from pool invalidation).
 */
export function pooledConnectionParamsChanged(prev: ServerConfig, next: ServerConfig): boolean {
  return (
    prev.host !== next.host ||
    prev.altHost !== next.altHost ||
    prev.port !== next.port ||
    prev.username !== next.username ||
    prev.authType !== next.authType ||
    prev.keyPath !== next.keyPath ||
    prev.authProfileId !== next.authProfileId ||
    prev.multiplexing !== next.multiplexing ||
    prev.legacyAlgorithms !== next.legacyAlgorithms ||
    JSON.stringify(prev.proxy) !== JSON.stringify(next.proxy)
  );
}

/**
 * The servers whose pooled connection rides one of `changedIds` as a jump host,
 * directly or through further hops (a cycle terminates: each id is visited once).
 * When a jump host's connection params change, its own pool entry is
 * soft-invalidated, but a target's pooled transport was built THROUGH the old
 * jump and would otherwise be reused for the next terminal reconnect or tunnel
 * over that stale route. Soft invalidation keeps live leases running and only
 * makes new acquisitions build a fresh connection over the current route.
 * A linear scan is enough: the servers list is small and this runs on edits.
 */
export function serversRidingChangedJumps(
  servers: readonly ServerConfig[],
  changedIds: ReadonlySet<string>
): Set<string> {
  const affected = new Set<string>();
  let frontier = new Set(changedIds);
  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const server of servers) {
      if (
        server.proxy?.type === "ssh" &&
        frontier.has(server.proxy.jumpHostId) &&
        !changedIds.has(server.id) &&
        !affected.has(server.id)
      ) {
        affected.add(server.id);
        next.add(server.id);
      }
    }
    // Only newly affected servers can lead to further dependents.
    frontier = next;
  }
  return affected;
}
