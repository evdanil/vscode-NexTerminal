import type { NexusCore } from "../../core/nexusCore";

/**
 * Retire pool entries when a server row disappears, before its id can be
 * recreated with another authenticated route. `invalidate` prevents new
 * leases from reusing the old connection while allowing existing sessions to
 * finish on their already-open transport.
 */
export function watchSshPoolServerRemovals(
  core: Pick<NexusCore, "getSnapshot" | "onDidChange" | "onDidRemoveServer">,
  pool: { invalidate(serverId: string): void }
): () => void {
  let previousIds = new Set(core.getSnapshot().servers.map((server) => server.id));

  const unsubscribeRemoval = core.onDidRemoveServer((serverId) => {
    previousIds.delete(serverId);
    pool.invalidate(serverId);
  });
  const unsubscribeChange = core.onDidChange((snapshot) => {
    const currentIds = new Set(snapshot.servers.map((server) => server.id));
    for (const serverId of previousIds) {
      if (!currentIds.has(serverId)) {
        pool.invalidate(serverId);
      }
    }
    previousIds = currentIds;
  });

  return () => {
    unsubscribeRemoval();
    unsubscribeChange();
  };
}
