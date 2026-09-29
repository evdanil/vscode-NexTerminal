import type { NexusCore } from "../../core/nexusCore";
import { authProfileOwnedCredentials, proxyConfigsEqual, type AuthProfile } from "../../models/config";
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
  core: Pick<NexusCore, "onDidMutateConnectionConfig" | "getSnapshot" | "bumpConnectionGeneration">,
  pool: { invalidate(serverId: string): void },
  /**
   * Called synchronously when a server's proxy endpoint changes, so the
   * endpoint-specific saved proxy password can be made unusable before any
   * connect that starts ahead of the persistence await reads it.
   */
  onProxyChanged?: (serverId: string) => void
): () => void {
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

  return core.onDidMutateConnectionConfig((mutation) => {
    const invalidated = new Set<string>();
    if (mutation.kind === "server") {
      indexServer(mutation.id, mutation.next);
      if (mutation.prev && mutation.next && !proxyConfigsEqual(mutation.prev.proxy, mutation.next.proxy)) {
        onProxyChanged?.(mutation.id);
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
    // Every invalidation also advances the server's connection generation, so a
    // pending start that saw an A -> B -> A change (equal descriptors) still cancels.
    for (const id of invalidated) {
      pool.invalidate(id);
      core.bumpConnectionGeneration(id);
    }
    for (const dependentId of ridersFromIndex(ridersOf, invalidated)) {
      pool.invalidate(dependentId);
      core.bumpConnectionGeneration(dependentId);
    }
  });
}
