import type { NexusCore } from "../../core/nexusCore";
import { authProfileOwnedCredentials, proxyConfigsEqual, type AuthProfile, type ProxyConfig } from "../../models/config";
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
  core: Pick<NexusCore, "onDidMutateConnectionConfig" | "onDidPersistServers" | "onDidEndServerBatch" | "isServerBatchActive" | "getServer" | "getSnapshot">,
  pool: { invalidate(serverId: string): void },
  /**
   * Housekeeping for endpoint-keyed proxy passwords (see proxyPasswordKeys.ts).
   * A password is stored per proxy endpoint, so a stale one is never READ for
   * another endpoint and no ordering against connects matters. `deleteEndpoint` is
   * called for each endpoint the server left once neither the last persisted record
   * nor the in-memory one uses it (settled on a successful save and at a server
   * batch's end, never inside a batch); a lost delete leaks nothing readable.
   */
  proxySecrets?: {
    /**
     * Deletes the saved password of an endpoint the server left, through the key's write
     * queue. `stillUnused()` is evaluated right before the delete executes (after every
     * write issued earlier for that key): it returns false when the endpoint has come back
     * into use (this window's own state moved back, or a reload from another window reached
     * it), and the delete must then be skipped. Resolves true if deleted, false if skipped.
     */
    deleteEndpoint(serverId: string, proxy: PasswordBearingProxy, stillUnused: () => boolean): Promise<boolean>;
  }
): () => void {
  /** serverId -> password-bearing endpoints the server left since the last persist. */
  const leftEndpoints = new Map<string, PasswordBearingProxy[]>();
  /** Endpoints whose delete is queued or running (kept listed until it settles). */
  const deleting: Array<{ serverId: string; proxy: PasswordBearingProxy }> = [];
  /** The servers as last persisted (the latest persistence event), for the delete-time re-check. */
  const lastPersisted = new Map<string, { proxy: ProxyConfig | undefined }>();
  // What is stored right now: the state core loaded when this watcher was attached (initialize()
  // has run), until the first successful save says otherwise. A failed save leaves this alone,
  // so an in-memory change that never reached storage cannot make its old endpoint look unused.
  for (const server of core.getSnapshot().servers) {
    lastPersisted.set(server.id, { proxy: server.proxy });
  }
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

  // Cleanup of the saved password of an endpoint a server left (see the settle rules
  // below): a save that fails settles nothing, and a rolled-back edit finds its
  // original endpoint's password untouched, because nothing was deleted before
  // persistence.
  // An endpoint is in use when the last PERSISTED record or the in-memory one has it.
  const inUse = (serverId: string, endpoint: PasswordBearingProxy): boolean =>
    proxyConfigsEqual(lastPersisted.get(serverId)?.proxy, endpoint) ||
    proxyConfigsEqual(core.getServer(serverId)?.proxy, endpoint);
  const settle = (): void => {
    if (!proxySecrets || leftEndpoints.size === 0 || core.isServerBatchActive()) {
      return;
    }
    for (const [serverId, endpoints] of [...leftEndpoints]) {
      for (const endpoint of endpoints) {
        const queued = deleting.some((d) => d.serverId === serverId && proxyConfigsEqual(d.proxy, endpoint));
        if (queued || inUse(serverId, endpoint)) {
          continue;
        }
        const entry = { serverId, proxy: endpoint };
        deleting.push(entry);
        const forget = (): void => {
          deleting.splice(deleting.indexOf(entry), 1);
        };
        // Re-checked when the delete actually runs, after earlier writes to the key.
        void proxySecrets.deleteEndpoint(serverId, endpoint, () => !inUse(serverId, endpoint)).then(
          (deleted) => {
            forget();
            if (deleted) {
              const rest = (leftEndpoints.get(serverId) ?? []).filter((known) => !proxyConfigsEqual(known, endpoint));
              if (rest.length > 0) leftEndpoints.set(serverId, rest);
              else leftEndpoints.delete(serverId);
            }
          },
          (error) => {
            forget(); // stays listed: retried at the next settle
            console.error("[Nexus] Could not delete a stale proxy password:", error);
          }
        );
      }
    }
  };
  // Settling runs on a SUCCESSFUL save (which also refreshes the persisted view) and on a batch's
  // end (which claims nothing about persistence and uses the persisted view as it stands). Never
  // onDidChange, which also fires for sessions, tunnels and focus while a save is pending. Inside a
  // server batch nothing settles until the batch ends.
  const unsubscribePersisted = proxySecrets
    ? core.onDidPersistServers((persisted) => {
        lastPersisted.clear();
        for (const server of persisted) {
          lastPersisted.set(server.id, { proxy: server.proxy });
        }
        settle();
      })
    : undefined;
  const unsubscribeBatchEnd = proxySecrets ? core.onDidEndServerBatch(settle) : undefined;

  const unsubscribeMutations = core.onDidMutateConnectionConfig((mutation) => {
    const invalidated = new Set<string>();
    if (mutation.kind === "server") {
      indexServer(mutation.id, mutation.next);
      const left = mutation.prev?.proxy;
      // Edits AND removals: the endpoint a server leaves is cleaned up after the change is
      // durable, under one rule (see the persistence handler); inside a server batch it waits
      // for the batch to end.
      if (proxySecrets && isPasswordBearingProxy(left) && (mutation.next === undefined || !proxyConfigsEqual(left, mutation.next.proxy))) {
        const list = leftEndpoints.get(mutation.id) ?? [];
        if (!list.some((known) => proxyConfigsEqual(known, left))) {
          list.push(left);
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
    unsubscribeBatchEnd?.();
  };
}
