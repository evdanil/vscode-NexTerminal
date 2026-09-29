import type { NexusCore } from "../../core/nexusCore";
import { pooledConnectionParamsChanged, serversRidingChangedJumps } from "./pooledConnectionParams";

/**
 * Soft-invalidates pooled SSH connections synchronously with each in-memory
 * server or auth-profile mutation, before NexusCore awaits persistence and
 * before any change event. A connect or R reconnect that starts inside that
 * window reads the NEW settings from core, so the pool must already have
 * dropped the entry built from the old ones; otherwise it would be handed the
 * old transport under the new descriptor.
 *
 * Covers, in one place: a server's pooled-connection params changing, a server
 * removal, an auth profile changing or being removed (every server linked to it),
 * and, for each, the servers that ride the invalidated ones as jump hosts
 * (transitively). Soft invalidation leaves live leases running; only new
 * acquisitions build afresh. Extra invalidations (a rollback restoring a record,
 * an add) are harmless: they cost a fresh connection later.
 */
export function watchPoolInvalidationOnConfigMutation(
  core: Pick<NexusCore, "onDidMutateConnectionConfig" | "getSnapshot">,
  pool: { invalidate(serverId: string): void }
): () => void {
  return core.onDidMutateConnectionConfig((mutation) => {
    const invalidated = new Set<string>();
    if (mutation.kind === "server") {
      if (mutation.next === undefined || (mutation.prev && pooledConnectionParamsChanged(mutation.prev, mutation.next))) {
        invalidated.add(mutation.id);
      }
    } else if (mutation.prev !== mutation.next) {
      for (const server of core.getSnapshot().servers) {
        if (server.authProfileId === mutation.id) {
          invalidated.add(server.id);
        }
      }
    }
    if (invalidated.size === 0) {
      return;
    }
    for (const id of invalidated) {
      pool.invalidate(id);
    }
    for (const dependentId of serversRidingChangedJumps(core.getSnapshot().servers, invalidated)) {
      pool.invalidate(dependentId);
    }
  });
}
