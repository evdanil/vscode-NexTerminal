import type { NexusCore } from "../../core/nexusCore";
import { authProfileOwnedCredentials, proxyConfigsEqual, type AuthProfile } from "../../models/config";
import { pooledConnectionParamsChanged, ridersFromIndex } from "./pooledConnectionParams";
import { isPasswordBearingProxy, type PasswordBearingProxy } from "./proxyPasswordKeys";

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
  core: Pick<NexusCore, "onDidMutateConnectionConfig" | "onDidPersistServers" | "isServerBatchActive" | "getServer" | "getSnapshot">,
  pool: { invalidate(serverId: string): void },
  /**
   * Housekeeping for endpoint-keyed proxy passwords (see proxyPasswordKeys.ts).
   * A password is stored per proxy endpoint, so a stale one is never READ for
   * another endpoint and no ordering against connects matters. Once a change is
   * persisted, `deleteEndpoint` is called for each endpoint the server no longer
   * uses; a lost delete leaks nothing readable.
   */
  proxySecrets?: { deleteEndpoint(serverId: string, proxy: PasswordBearingProxy): void }
): () => void {
  /** serverId -> password-bearing endpoints the server left since the last persist. */
  const leftEndpoints = new Map<string, Array<{ proxy: PasswordBearingProxy; removal: boolean }>>();
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

  // Cleanup runs only on the explicit persistence signal (or a batch's end) (never onDidChange, which
  // also fires for sessions, tunnels and focus while a save is pending): an endpoint
  // the persisted record no longer uses has its saved password deleted. A save
  // that fails settles nothing, and a rolled-back edit finds its original
  // endpoint's password untouched, because nothing was deleted before persistence.
  const unsubscribePersisted = proxySecrets
    ? core.onDidPersistServers((persisted) => {
        if (leftEndpoints.size === 0) {
          return;
        }
        const byId = new Map(persisted.map((server) => [server.id, server]));
        for (const [serverId, endpoints] of [...leftEndpoints]) {
          const stored = byId.get(serverId);
          const current = core.getServer(serverId);
          // An endpoint is deletable only when NEITHER the persisted record NOR the
          // in-memory one uses it: the persisted list can predate a later revert that is
          // still waiting for its own save. Endpoints still in use stay listed for the
          // next persist.
          const stillUsed = (endpoint: PasswordBearingProxy): boolean =>
            (stored !== undefined && proxyConfigsEqual(stored.proxy, endpoint)) ||
            (current !== undefined && proxyConfigsEqual(current.proxy, endpoint));
          const batchActive = core.isServerBatchActive();
          const remaining = endpoints.filter(({ proxy: endpoint, removal }) => {
            if (stillUsed(endpoint) || (removal && batchActive)) {
              return true;
            }
            proxySecrets.deleteEndpoint(serverId, endpoint);
            return false;
          });
          if (remaining.length > 0) {
            leftEndpoints.set(serverId, remaining);
          } else {
            leftEndpoints.delete(serverId);
          }
        }
      })
    : undefined;

  const unsubscribeMutations = core.onDidMutateConnectionConfig((mutation) => {
    const invalidated = new Set<string>();
    if (mutation.kind === "server") {
      indexServer(mutation.id, mutation.next);
      const left = mutation.prev?.proxy;
      // Edits AND removals: the endpoint a server leaves is cleaned up after the change is
      // durable, under one rule (see the persistence handler). A removal that is part of a
      // batch (Replace) waits for the batch to end, since the same id may come back on the
      // same endpoint, which keeps the key.
      if (proxySecrets && isPasswordBearingProxy(left) && (mutation.next === undefined || !proxyConfigsEqual(left, mutation.next.proxy))) {
        const list = leftEndpoints.get(mutation.id) ?? [];
        if (!list.some((known) => proxyConfigsEqual(known.proxy, left))) {
          list.push({ proxy: left, removal: mutation.next === undefined });
        }
        leftEndpoints.set(mutation.id, list);
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
