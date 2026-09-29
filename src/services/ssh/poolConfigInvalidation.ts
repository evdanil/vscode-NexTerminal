import type { NexusCore } from "../../core/nexusCore";
import { authProfileOwnedCredentials, proxyConfigsEqual, type AuthProfile, type ProxyConfig } from "../../models/config";
import { pooledConnectionParamsChanged, ridersFromIndex } from "./pooledConnectionParams";

/** What a linked profile contributes to a connection; a rename or an equal reload contributes nothing. */
function authProfileConnectionChanged(prev: AuthProfile | undefined, next: AuthProfile | undefined): boolean {
  if (!prev || !next) {
    return prev !== next;
  }
  return JSON.stringify(authProfileOwnedCredentials(prev)) !== JSON.stringify(authProfileOwnedCredentials(next));
}

/**
 * THE source of pooled-connection invalidation. Soft-invalidates pooled SSH
 * connections synchronously with each in-memory server or auth-profile
 * mutation, before NexusCore awaits persistence and before any change event.
 * That holds for single edits, removals, bulk paths (sync, folder cascade,
 * import, Delete All Data) and `initialize()` (a refresh), which reports each
 * prior record as prev/next once repopulated and before its own awaits. A
 * connect or R reconnect that starts after the mutation reads the NEW settings
 * from core, so the pool has already dropped the entry built from the old ones.
 * There is deliberately no second, emit-time invalidation: it would bump the
 * pool epoch again after a reconnect handshake had started, so that handshake
 * would settle into a mismatch, never be installed, and be repeated (possibly
 * with a second password prompt). In-place mutation of a record object (folder
 * rename touching `group`) is not reported and touches no pooled field.
 *
 * Covers: a server's pooled-connection params changing, a server removal, an
 * auth profile's supplied credentials changing or the profile being removed
 * (every server linked to it), and, for each, the servers that ride the
 * invalidated ones as jump hosts (transitively). Live leases keep running; only
 * new acquisitions build afresh. Extra invalidations (a rollback restoring a
 * record) are harmless: they cost a fresh connection later.
 *
 * Cost: two reverse indexes (jump host -> riders, auth profile -> linked
 * servers) are maintained incrementally, O(1) per mutation, so a mutation costs
 * only the servers it actually invalidates, with no snapshot copy and no scan.
 */
export function watchPoolInvalidationOnConfigMutation(
  core: Pick<NexusCore, "onDidMutateConnectionConfig" | "onDidPersistServers" | "getServer" | "getSnapshot">,
  pool: { invalidate(serverId: string): void },
  /**
   * Endpoint-specific saved proxy password handling, in three reversible steps.
   * `suspect` runs synchronously when a server's proxy changes: reads must stop
   * returning the old password while the change is tentative (a connect ahead of
   * the persistence await must not send it to the new proxy), but nothing is
   * deleted yet. `lift` runs when a later mutation puts back a proxy equal to the
   * original (a rollback of a failed save, a manual revert, A -> B -> A). `commit`
   * runs once the change is persisted (core's onDidPersistServers) and the server's proxy
   * still differs from the original: only then is the password deleted. A save
   * that fails with no rollback mutation leaves the tombstone in place, the safe
   * side: the old password is never sent to the new proxy and is not lost.
   */
  proxySecrets?: { suspect(serverId: string): void; lift(serverId: string): void; commit(serverId: string): void }
): () => void {
  /** serverId -> the proxy that was in place before the first tentative change. */
  const originalProxy = new Map<string, ProxyConfig | undefined>();
  const jumpOf = new Map<string, string>();
  const ridersOf = new Map<string, Set<string>>();
  const profileOf = new Map<string, string>();
  const linkedTo = new Map<string, Set<string>>();

  const link = <K>(
    forward: Map<string, K & string>,
    reverse: Map<string, Set<string>>,
    id: string,
    target: (K & string) | undefined
  ): void => {
    const old = forward.get(id);
    if (old === target) return;
    if (old !== undefined) {
      const set = reverse.get(old);
      set?.delete(id);
      if (set?.size === 0) reverse.delete(old);
      forward.delete(id);
    }
    if (target !== undefined) {
      forward.set(id, target);
      const set = reverse.get(target);
      if (set) set.add(id);
      else reverse.set(target, new Set([id]));
    }
  };
  const indexServer = (id: string, server: { proxy?: { type: string; jumpHostId?: string }; authProfileId?: string } | undefined): void => {
    const jump = server?.proxy?.type === "ssh" ? server.proxy.jumpHostId : undefined;
    link(jumpOf, ridersOf, id, jump);
    link(profileOf, linkedTo, id, server?.authProfileId || undefined);
  };
  for (const server of core.getSnapshot().servers) {
    indexServer(server.id, server);
  }

  // Settled only by the explicit persistence signal (never by onDidChange, which
  // also fires for sessions, tunnels and focus while a save is still pending): a
  // change that reached durable storage commits the deletion if the persisted
  // proxy still differs from the original, and lifts it if it equals it. A save
  // that fails settles nothing; a rollback's restore lifts through the mutation
  // hook above, because the restored proxy equals the original again.
  const unsubscribePersisted = proxySecrets
    ? core.onDidPersistServers((persisted) => {
        if (originalProxy.size === 0) {
          return;
        }
        const byId = new Map(persisted.map((server) => [server.id, server]));
        for (const [serverId, original] of [...originalProxy]) {
          originalProxy.delete(serverId);
          const stored = byId.get(serverId);
          if (stored && proxyConfigsEqual(original, stored.proxy)) {
            proxySecrets.lift(serverId);
          } else {
            proxySecrets.commit(serverId); // durable state no longer has the original proxy (or the server is gone)
          }
        }
      })
    : undefined;

  const unsubscribeMutations = core.onDidMutateConnectionConfig((mutation) => {
    const invalidated = new Set<string>();
    if (mutation.kind === "server") {
      indexServer(mutation.id, mutation.next);
      if (proxySecrets && mutation.next) {
        if (originalProxy.has(mutation.id)) {
          // Already tentative: the original stays the first one; reverting to it lifts.
          if (proxyConfigsEqual(originalProxy.get(mutation.id), mutation.next.proxy)) {
            originalProxy.delete(mutation.id);
            proxySecrets.lift(mutation.id);
          }
        } else if (mutation.prev && !proxyConfigsEqual(mutation.prev.proxy, mutation.next.proxy)) {
          originalProxy.set(mutation.id, mutation.prev.proxy);
          proxySecrets.suspect(mutation.id);
        }
      } else if (proxySecrets && mutation.next === undefined && originalProxy.delete(mutation.id)) {
        // The server is gone: its secrets are removed by the removal flow; nothing tentative remains.
        proxySecrets.commit(mutation.id);
      }
      if (mutation.next === undefined || (mutation.prev && pooledConnectionParamsChanged(mutation.prev, mutation.next))) {
        invalidated.add(mutation.id);
      }
    } else if (authProfileConnectionChanged(mutation.prev, mutation.next)) {
      for (const serverId of linkedTo.get(mutation.id) ?? []) {
        invalidated.add(serverId);
      }
    }
    if (invalidated.size === 0) {
      return;
    }
    for (const id of invalidated) {
      pool.invalidate(id);
    }
    for (const dependentId of ridersFromIndex(ridersOf, invalidated)) {
      pool.invalidate(dependentId);
    }
  });
  return () => {
    unsubscribeMutations();
    unsubscribePersisted?.();
  };
}
