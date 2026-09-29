import type { NexusCore } from "../../core/nexusCore";
import { serversRidingChangedJumps } from "./pooledConnectionParams";

/**
 * Retire pool entries when a server row disappears, before its id can be
 * recreated with another authenticated route. `invalidate` prevents new
 * leases from reusing the old connection while allowing existing sessions to
 * finish on their already-open transport.
 *
 * The servers that ride a removed server as a jump host (transitively) are
 * retired too: they keep a dangling `jumpHostId`, and their pooled target
 * transport was built through the deleted bastion, so an R reconnect or a shared
 * tunnel would otherwise keep reusing that stale route and never surface "Jump
 * host server not found". Every removal path (single delete, Delete All Data,
 * a Replace import) reaches this observer through NexusCore.
 */
export function watchSshPoolServerRemovals(
  core: Pick<NexusCore, "getSnapshot" | "onDidChange" | "onDidRemoveServer">,
  pool: { invalidate(serverId: string): void }
): () => void {
  let previousIds = new Set(core.getSnapshot().servers.map((server) => server.id));

  const invalidateWithDependents = (removedIds: ReadonlySet<string>): void => {
    for (const serverId of removedIds) {
      pool.invalidate(serverId);
    }
    for (const dependentId of serversRidingChangedJumps(core.getSnapshot().servers, removedIds)) {
      pool.invalidate(dependentId);
    }
  };
  const unsubscribeRemoval = core.onDidRemoveServer((serverId) => {
    previousIds.delete(serverId);
    invalidateWithDependents(new Set([serverId]));
  });
  const unsubscribeChange = core.onDidChange((snapshot) => {
    const currentIds = new Set(snapshot.servers.map((server) => server.id));
    const removed = new Set([...previousIds].filter((serverId) => !currentIds.has(serverId)));
    if (removed.size > 0) {
      for (const serverId of removed) {
        pool.invalidate(serverId);
      }
      for (const dependentId of serversRidingChangedJumps(snapshot.servers, removed)) {
        pool.invalidate(dependentId);
      }
    }
    previousIds = currentIds;
  });

  return () => {
    unsubscribeRemoval();
    unsubscribeChange();
  };
}
