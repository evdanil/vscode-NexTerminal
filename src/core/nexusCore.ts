import { randomUUID } from "node:crypto";
import {
  cloneServerConfig,
  mergeServerConfigFields,
  serverConfigsEqual,
  type ActiveLocalShellSession,
  type ActiveSerialSession,
  type ActiveSession,
  type ActiveTunnel,
  type AuthProfile,
  type LocalShellProfile,
  type SerialProfile,
  type ServerConfig,
  type TunnelProfile,
  type TunnelRegistryEntry
} from "../models/config";
import { sourceConfigUnchanged, type InventorySourceConfig } from "../models/inventory";
import type { ConfigRepository, SessionSnapshot } from "./contracts";
import { normalizeFolderPath, isDescendantOrSelf, parentPath, folderDisplayName, getAncestorPaths } from "../utils/folderPaths";

type NexusListener = (snapshot: SessionSnapshot) => void;

/**
 * Result of a sync engine run (see services/inventory/syncEngine.ts), reduced
 * to exactly what NexusCore needs to mutate in one atomic batch: which
 * servers to upsert/remove and which folders must exist. Defined here (not
 * in syncEngine.ts) because NexusCore is the sole writer that consumes it;
 * syncEngine imports the type back for planToApplication()'s return type.
 */
export interface InventorySyncApplication {
  sourceId: string;
  syncedAt: number; // -> source.lastSyncAt
  upsertServers: ServerConfig[]; // adds + update "after" + orphan "after"
  removeServerIds: string[];
  folders: string[]; // ensure these + ancestors exist as explicit groups
  // FINDINGS D/E — the source record exactly as it stood when this
  // application's plan was computed (the fetch-time snapshot). Compared
  // synchronously against the CURRENT map entry, before any mutation, in
  // applyInventorySyncPlan — closes the gap between "source still exists" and
  // "source is still the same config" for races that land between plan
  // computation and apply (e.g. a replace-mode config import recreating the
  // same source id mid-sync).
  //
  // REORDER (removeSource Findings 1/2) — "absent" is the removal-disposition
  // case: the caller (inventoryCommands.ts's removeSource) has ALREADY
  // removed the source record via removeInventorySource() before calling
  // this method to dispose of the servers it owned (delete / strip origin),
  // so apply.sourceId is expected to name NO current source at all. The
  // semantics differ from the normal case: proceed only if the sources map
  // truly has no entry for apply.sourceId; if one exists (a replace-mode
  // import recreated the same id in the gap between the record removal and
  // this call), throw without mutating anything, protecting the NEW source's
  // servers from this now-stale disposition. When "absent", lastSyncAt is
  // never bumped and no source-record entry is written for apply.sourceId
  // (there is nothing to write it onto).
  expectedSource: InventorySourceConfig | "absent";
  // FINDING 2 (removeSource review) — only consulted when expectedSource is
  // "absent". importMergeReplace imports servers BEFORE sources, so a
  // recreated owned server (or one that took over the same id under a NEW
  // source) can land in the window between removeInventorySource and this
  // apply. Each entry in upsertServers is honored only if the server
  // currently in the map is still structurally equal (serverConfigsEqual) to
  // the pre-strip snapshot captured here for its id — otherwise the entry
  // belongs to the new import, not this removal, and applyInventorySyncPlan
  // skips it rather than clobbering it.
  //
  // FINDING 4 (removal-teardown review) — extended to cover removeServerIds
  // too: a delete target is validated the same way (origin.sourceId
  // ownership PLUS, when an entry exists here for its id, structural
  // equality against it) rather than by ownership alone, which a
  // same-id/same-sourceId REPLACEMENT (content changed, identity markers
  // unchanged) could otherwise slip through. Populating an entry for a given
  // remove-target id is optional — callers with no meaningful
  // pre-disposition snapshot to capture (or that never pass this map at all,
  // e.g. syncNow's normal-mode apply) keep the ownership-only check.
  // Absent from a non-"absent" apply.
  expectedBeforeByServerId?: Map<string, ServerConfig>;
}

/**
 * FINDING 1 (removeSource review) — thrown by removeInventorySource(id, expected)
 * when the current record no longer matches `expected` (or is gone). Distinct
 * from a generic persistence failure so the command layer can surface a
 * different, more accurate message ("source changed while removing" vs.
 * "removal did not complete").
 */
export class InventorySourceRemovalMismatchError extends Error {
  public constructor(id: string) {
    super(`Cannot remove inventory source "${id}": the record changed before the removal could complete.`);
    this.name = "InventorySourceRemovalMismatchError";
  }
}

export class NexusCore {
  private readonly listeners = new Set<NexusListener>();
  private readonly servers = new Map<string, ServerConfig>();
  private readonly tunnels = new Map<string, TunnelProfile>();
  private readonly serialProfiles = new Map<string, SerialProfile>();
  private readonly localShellProfiles = new Map<string, LocalShellProfile>();
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly activeSerialSessions = new Map<string, ActiveSerialSession>();
  private readonly activeLocalShellSessions = new Map<string, ActiveLocalShellSession>();
  private readonly activeTunnels = new Map<string, ActiveTunnel>();
  private readonly activitySessionIds = new Set<string>();
  private focusedSessionId: string | undefined = undefined;
  private remoteTunnels: TunnelRegistryEntry[] = [];
  private readonly explicitGroups = new Set<string>();
  private readonly authProfiles = new Map<string, AuthProfile>();
  private readonly inventorySources = new Map<string, InventorySourceConfig>();

  public constructor(private readonly repository: ConfigRepository) {}

  public async initialize(): Promise<void> {
    const [servers, tunnels, serialProfiles, localShellProfiles, groups, authProfiles, inventorySources] = await Promise.all([
      this.repository.getServers(),
      this.repository.getTunnels(),
      this.repository.getSerialProfiles(),
      this.repository.getLocalShellProfiles(),
      this.repository.getGroups(),
      this.repository.getAuthProfiles(),
      this.repository.getInventorySources()
    ]);
    this.servers.clear();
    this.tunnels.clear();
    this.serialProfiles.clear();
    this.localShellProfiles.clear();
    this.explicitGroups.clear();
    this.authProfiles.clear();
    this.inventorySources.clear();
    const normalizedServers = normalizeFileExplorerAutoOpenOwner(servers);
    for (const server of normalizedServers.servers) {
      this.servers.set(server.id, server);
    }
    for (const tunnel of tunnels) {
      this.tunnels.set(tunnel.id, tunnel);
    }
    for (const profile of serialProfiles) {
      this.serialProfiles.set(profile.id, profile);
    }
    for (const profile of localShellProfiles) {
      this.localShellProfiles.set(profile.id, profile);
    }
    for (const group of groups) {
      this.explicitGroups.add(group);
    }
    for (const profile of authProfiles) {
      this.authProfiles.set(profile.id, profile);
    }
    for (const source of inventorySources) {
      this.inventorySources.set(source.id, source);
    }
    if (normalizedServers.changed) {
      await this.repository.saveServers(normalizedServers.servers);
    }
    this.emitChanged();
  }

  public getSnapshot(): SessionSnapshot {
    return {
      servers: [...this.servers.values()],
      tunnels: [...this.tunnels.values()],
      serialProfiles: [...this.serialProfiles.values()],
      localShellProfiles: [...this.localShellProfiles.values()],
      activeSessions: [...this.activeSessions.values()],
      activeSerialSessions: [...this.activeSerialSessions.values()],
      activeLocalShellSessions: [...this.activeLocalShellSessions.values()],
      activeTunnels: [...this.activeTunnels.values()],
      remoteTunnels: [...this.remoteTunnels],
      explicitGroups: [...this.explicitGroups],
      authProfiles: [...this.authProfiles.values()],
      activitySessionIds: new Set(this.activitySessionIds),
      focusedSessionId: this.focusedSessionId,
      inventorySources: [...this.inventorySources.values()]
    };
  }

  public onDidChange(listener: NexusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getServer(id: string): ServerConfig | undefined {
    return this.servers.get(id);
  }

  public getTunnel(id: string): TunnelProfile | undefined {
    return this.tunnels.get(id);
  }

  public getSerialProfile(id: string): SerialProfile | undefined {
    return this.serialProfiles.get(id);
  }

  public getLocalShellProfile(id: string): LocalShellProfile | undefined {
    return this.localShellProfiles.get(id);
  }

  public getAuthProfile(id: string): AuthProfile | undefined {
    return this.authProfiles.get(id);
  }

  public async addOrUpdateAuthProfile(profile: AuthProfile): Promise<void> {
    this.authProfiles.set(profile.id, profile);
    await this.repository.saveAuthProfiles([...this.authProfiles.values()]);
    this.emitChanged();
  }

  public async removeAuthProfile(profileId: string): Promise<void> {
    this.authProfiles.delete(profileId);
    let serversChanged = false;
    for (const [id, server] of this.servers.entries()) {
      if (server.authProfileId === profileId) {
        this.servers.set(id, { ...server, authProfileId: undefined });
        serversChanged = true;
      }
    }
    await this.repository.saveAuthProfiles([...this.authProfiles.values()]);
    if (serversChanged) {
      await this.repository.saveServers([...this.servers.values()]);
    }
    this.emitChanged();
  }

  public getInventorySource(id: string): InventorySourceConfig | undefined {
    return this.inventorySources.get(id);
  }

  /**
   * FINDING A — the map mutation happens first (repo-wide in-memory-first
   * pattern), but a rejected persist here must leave NO trace: the command
   * layer's credential rollback (add/edit) assumes a failed
   * addOrUpdateInventorySource means the source was never created/updated, and
   * an in-memory-only leftover could later be persisted by an unrelated
   * operation (e.g. the next successful saveInventorySources call from a
   * different command). Capture the previous entry (or its absence) before
   * mutating, and restore it on rejection.
   *
   * FINDING 1 (removal-identity review) — every write through this method is
   * a new INCARNATION of the record: a fresh `revision` is assigned here,
   * unconditionally (even if `source` already carries one — e.g. a backup
   * restore replaying an old value), so no call site (addSource, editSource,
   * configCommands' backup import/reset paths, ...) needs to remember to do
   * it itself. This is deliberately the ONLY place a revision is ever
   * (re)assigned to a LIVE record — applyInventorySyncPlan's own lastSyncAt
   * bump below intentionally preserves whatever revision the record already
   * has, since that is not a new incarnation, just a routine sync stamp.
   */
  public async addOrUpdateInventorySource(source: InventorySourceConfig): Promise<void> {
    const hadPrevious = this.inventorySources.has(source.id);
    const previous = this.inventorySources.get(source.id);
    const withRevision: InventorySourceConfig = { ...source, revision: randomUUID() };
    this.inventorySources.set(source.id, withRevision);
    try {
      await this.repository.saveInventorySources([...this.inventorySources.values()]);
    } catch (error) {
      if (hadPrevious) {
        this.inventorySources.set(source.id, previous!);
      } else {
        this.inventorySources.delete(source.id);
      }
      throw error;
    }
    this.emitChanged();
  }

  /**
   * Removes the source record only. Disposition of servers it created
   * (delete / keep / strip origin) is the command layer's job — call
   * applyInventorySyncPlan (or removeServer) first if servers need to change.
   *
   * FINDING A — symmetric with addOrUpdateInventorySource: removeSource's
   * command flow deletes the source's OWN secrets (its inventory-source-*
   * vault keys) BEFORE calling this method, not after — delete-first is the
   * correct order here: if the record delete below rejects, the (restored)
   * record still enumerates those field ids via secretFieldIds, so the
   * command is retryable and will simply attempt the same (now-idempotent)
   * vault deletes again. Restoring the entry on a rejected persist keeps that
   * retry possible — a delete-then-leak here would strand the record deleted
   * in memory while removeInventorySource() never got persisted, and the
   * command layer's own retry logic assumes rejection means "nothing
   * changed".
   *
   * FINDING 1 (removeSource review) — `expected`, when provided, is compared
   * against the CURRENT record SYNCHRONOUSLY (no await between the check and
   * the delete below) via sourceConfigUnchanged plus a name comparison
   * (sourceConfigUnchanged doesn't cover name). This closes a narrower race
   * than the id-recreation case InventorySyncApplication's "absent" semantics
   * guard: a replace-mode import can delete-and-recreate the SAME source id
   * during removeSource's own awaited vault reads/deletes (which run before
   * this call), so an unconditional delete here would silently remove the
   * REPLACEMENT record instead of the one the caller picked. Mismatch or
   * missing record -> throw InventorySourceRemovalMismatchError without
   * mutating anything.
   */
  public async removeInventorySource(id: string, expected?: InventorySourceConfig): Promise<void> {
    if (expected) {
      const current = this.inventorySources.get(id);
      if (!current || !sourceConfigUnchanged(current, expected) || current.name !== expected.name) {
        throw new InventorySourceRemovalMismatchError(id);
      }
    }
    const hadPrevious = this.inventorySources.has(id);
    const previous = this.inventorySources.get(id);
    this.inventorySources.delete(id);
    try {
      await this.repository.saveInventorySources([...this.inventorySources.values()]);
    } catch (error) {
      if (hadPrevious) {
        this.inventorySources.set(id, previous!);
      }
      throw error;
    }
    this.emitChanged();
  }

  /**
   * Applies one computed inventory sync as a single atomic batch: one
   * `saveServers`/`saveGroups`/`saveInventorySources` round-trip, one
   * `emitChanged()` — mirrors `addServersBatch`'s reasoning for why a
   * multi-hundred-device sync must not become N sequential memento flushes.
   *
   * Throws if `apply.sourceId` no longer names a known source (e.g. the
   * source was removed while a sync was in flight) — refuses to partially
   * apply servers on behalf of a source record that will never receive the
   * lastSyncAt update, rather than silently orphaning the write.
   *
   * FINDINGS D/E — also throws if the CURRENT source record no longer
   * matches `apply.expectedSource` (the fetch-time snapshot the plan was
   * computed against). This check runs synchronously, before any mutation
   * below, so it is atomic with the apply itself — no await separates "the
   * record is still the one the plan was computed for" from "the plan gets
   * applied", closing the race a caller-side check (however recent) can never
   * fully close on its own.
   *
   * REORDER — `apply.expectedSource === "absent"` inverts the presence check:
   * this call must throw if a source record for apply.sourceId DOES exist
   * (see the field doc on InventorySyncApplication.expectedSource for why).
   *
   * FINDING 2 (removeSource review) — in "absent" mode, each removeServerIds/
   * upsertServers entry is ALSO validated individually against current state
   * (see the field doc on InventorySyncApplication.expectedBeforeByServerId)
   * before it is allowed to mutate anything; entries that fail are skipped,
   * not thrown on. The returned `skippedCount` tells the caller how many
   * entries were skipped this way (always 0 outside "absent" mode) so it can
   * surface that to the user rather than silently under-reporting the
   * removal's effect.
   *
   * FINDING 3 (removal-teardown review) — also returns `removedServerIds`:
   * the ids actually deleted by THIS call (after the "absent"-mode per-entry
   * filtering above — equal to `apply.removeServerIds` verbatim outside
   * "absent" mode, where every entry is honored unconditionally). Callers
   * that need to clean up state keyed by server id AFTER this call (vault
   * secrets, runtime teardown) must iterate this list, not their own
   * pre-apply candidate list — a candidate this call skipped was never
   * touched and must not have its secrets/sessions torn down either.
   */
  public async applyInventorySyncPlan(apply: InventorySyncApplication): Promise<{ skippedCount: number; removedServerIds: string[] }> {
    const source = this.inventorySources.get(apply.sourceId);
    // FINDING 2 (removeSource review) — the actual entries this call mutates.
    // In the normal (non-"absent") case these are exactly apply's own arrays;
    // in "absent" mode they're filtered below to exclude entries that no
    // longer reflect a server this removal actually owns.
    let removeServerIds = apply.removeServerIds;
    let upsertServers = apply.upsertServers;
    let skippedCount = 0;
    if (apply.expectedSource === "absent") {
      if (source) {
        throw new Error(
          `Cannot apply inventory sync: inventory source "${apply.sourceId}" exists (expected it to already be removed).`
        );
      }
      // FINDING 2 — importMergeReplace imports servers BEFORE sources, so a
      // recreated owned server (or one that simply took over the same id
      // under a NEW source) can land in the window between
      // removeInventorySource and this apply. Validate EACH entry against
      // CURRENT state before mutating it — a mismatch means the entry
      // belongs to the new import, not this stale removal, and must be
      // skipped rather than deleted/overwritten.
      //
      // FINDING 4 (removal-teardown review) — ownership (origin.sourceId
      // match) alone is not enough: a REPLACEMENT server can retain the
      // exact same id and origin.sourceId (e.g. re-synced/re-imported under
      // the same source) while its actual content changed underneath this
      // now-stale removal. When the caller captured a pre-disposition
      // snapshot for this id in `expectedBeforeByServerId` (removeSource's
      // "Delete Servers" flow does, mirroring what it already does for
      // upserts below), the CURRENT record must still be structurally
      // identical to it. Callers that never populate an entry for a given id
      // (e.g. syncNow's normal-mode apply, which doesn't use "absent" mode
      // at all, or any future "absent" caller that genuinely has no
      // pre-disposition snapshot) keep the ownership-only check unchanged —
      // this is a strictly ADDITIONAL check, never a required one.
      const validRemoveIds: string[] = [];
      for (const id of apply.removeServerIds) {
        const current = this.servers.get(id);
        if (!current || current.origin?.sourceId !== apply.sourceId) {
          skippedCount++;
          continue;
        }
        const expectedBefore = apply.expectedBeforeByServerId?.get(id);
        if (expectedBefore && !serverConfigsEqual(current, expectedBefore)) {
          skippedCount++;
          continue;
        }
        validRemoveIds.push(id);
      }
      const validUpserts: ServerConfig[] = [];
      for (const server of apply.upsertServers) {
        const expectedBefore = apply.expectedBeforeByServerId?.get(server.id);
        const current = this.servers.get(server.id);
        if (current && expectedBefore && serverConfigsEqual(current, expectedBefore)) {
          validUpserts.push(server);
        } else {
          skippedCount++;
        }
      }
      removeServerIds = validRemoveIds;
      upsertServers = validUpserts;
    } else {
      if (!source) {
        throw new Error(`Cannot apply inventory sync: unknown inventory source "${apply.sourceId}".`);
      }
      if (!sourceConfigUnchanged(source, apply.expectedSource)) {
        throw new Error(
          `Cannot apply inventory sync: inventory source "${apply.sourceId}" configuration changed since the sync was computed.`
        );
      }
    }
    // ITEM 1 — capture everything this call is about to mutate BEFORE
    // touching it, so a rejected persist below can be rolled back completely.
    // Without this, a half-applied sync (servers deleted/upserted, sessions
    // dropped, lastSyncAt bumped) stayed in memory even though the caller was
    // told the sync failed — and the next unrelated persist (any other
    // saveServers/saveGroups/saveInventorySources call) would flush that
    // half-applied state to disk for real.
    const priorServers = new Map<string, ServerConfig | undefined>();
    const captureServerPrior = (id: string): void => {
      if (!priorServers.has(id)) {
        priorServers.set(id, this.servers.get(id));
      }
    };
    for (const id of removeServerIds) {
      captureServerPrior(id);
    }
    for (const server of upsertServers) {
      captureServerPrior(server.id);
    }
    // removeServerSessions (below) only ever touches activeSessions,
    // activitySessionIds, and focusedSessionId — mirror exactly that here.
    // FINDING 3 — sessions are restored unconditionally on rollback (no
    // reference/presence check like servers/groups get below). Unlike
    // servers or groups, session removal is never raced by another command:
    // active sessions are only ever unregistered via this same serialized
    // command path (removeServerSessions, called only from here), so nothing
    // else can have mutated activeSessions/focusedSessionId for these ids
    // while this batch's persist was in flight.
    const priorFocusedSessionId = this.focusedSessionId;
    const priorActiveSessions = new Map<string, ActiveSession>();
    const priorActivitySessionIds = new Set<string>();
    for (const id of removeServerIds) {
      for (const [sessionId, session] of this.activeSessions.entries()) {
        if (session.serverId === id) {
          priorActiveSessions.set(sessionId, session);
          if (this.activitySessionIds.has(sessionId)) {
            priorActivitySessionIds.add(sessionId);
          }
        }
      }
    }

    // FINDING 3 — track exactly what THIS batch writes, so a rejected persist
    // can roll back conditionally instead of wholesale: another command
    // (addGroup, addOrUpdateServer, ...) can run concurrently while the
    // saves below are pending, and an unconditional restore would erase its
    // newer state along with this batch's own mutations.
    //
    // FINDING 2 — the map holds a structural CLONE of each upserted server
    // (cloneServerConfig), captured at write time, not the live reference.
    // _renameFolderPath and removeFolderCascade both mutate `server.group` IN
    // PLACE on the object already sitting in `this.servers`, so a reference
    // compare (`current === batchValue`) would stay true across that
    // mutation and rollback would wrongly clobber the rename. Comparing the
    // CURRENT entry structurally (serverConfigsEqual) against this frozen
    // snapshot instead correctly treats an in-place-mutated entry as
    // "changed since" and leaves it alone.
    const batchWrittenServers = new Map<string, ServerConfig | undefined>(); // undefined = this batch deleted it
    const addedExplicitGroups = new Set<string>(); // paths this batch added that were NOT already present

    for (const folder of apply.folders) {
      const normalized = normalizeFolderPath(folder);
      if (!normalized) {
        continue;
      }
      for (const ancestor of getAncestorPaths(normalized)) {
        if (!this.explicitGroups.has(ancestor)) {
          this.explicitGroups.add(ancestor);
          addedExplicitGroups.add(ancestor);
        }
      }
    }
    for (const id of removeServerIds) {
      this.servers.delete(id);
      this.removeServerSessions(id);
      batchWrittenServers.set(id, undefined);
    }
    for (const server of upsertServers) {
      this.servers.set(server.id, server);
      batchWrittenServers.set(server.id, cloneServerConfig(server));
    }
    // REORDER — "absent": there is no source record to bump lastSyncAt on or
    // write an entry for; writtenSourceRecord stays undefined and the
    // inventorySources map (and its rollback below) are left completely
    // alone. The bucket is still included in the persist below (unchanged
    // content), keeping the existing one-persist-one-emit shape intact
    // rather than special-casing the "absent" apply into its own save call.
    const writtenSourceRecord = source ? { ...source, lastSyncAt: apply.syncedAt } : undefined;
    if (writtenSourceRecord) {
      this.inventorySources.set(apply.sourceId, writtenSourceRecord);
    }

    // FINDING 1 — keep references to all three save promises and settle ALL
    // of them (Promise.allSettled, not Promise.all) before doing anything
    // else. Promise.all's catch fires the instant the FIRST one rejects,
    // while its siblings (e.g. a slow saveServers carrying this batch's
    // payload) can still be in flight; running the conditional rollback and
    // the compensating re-persist at that point races that slow original —
    // if it resolves and commits AFTER the compensating write lands, disk
    // ends up holding the rejected batch's data instead of the rolled-back
    // state. Awaiting allSettled first guarantees every original has already
    // committed (or definitively failed) before rollback/compensation touch
    // anything, so the compensating write is always the last one to land.
    const results = await Promise.allSettled([
      this.repository.saveServers([...this.servers.values()]),
      this.repository.saveGroups([...this.explicitGroups]),
      this.repository.saveInventorySources([...this.inventorySources.values()])
    ]);
    const firstRejection = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (firstRejection) {
      // FINDING 3 (original) — servers: restore the prior entry only if the
      // current entry is still structurally identical to what this batch
      // wrote (or still absent where this batch deleted it). If a concurrent
      // command changed or mutated it since, a wholesale restore/skip would
      // either erase the concurrent edit or keep the rejected batch write —
      // see REVIEW FINDING 1 below for the merge that replaces the old
      // skip-whole-record behavior in the UPDATE case.
      for (const [id, priorServer] of priorServers) {
        const batchSnapshot = batchWrittenServers.get(id);
        const current = this.servers.get(id);
        if (batchSnapshot === undefined) {
          // This batch deleted the record. Restore it only if nothing has
          // recreated it since (current still absent) — a concurrent
          // recreation is left alone entirely.
          if (current === undefined && priorServer) {
            this.servers.set(id, priorServer);
          }
          continue;
        }
        if (current === undefined) {
          // This batch created/updated the record, but something concurrent
          // deleted it since. Nothing to merge onto — leave it deleted.
          continue;
        }
        if (serverConfigsEqual(current, batchSnapshot)) {
          // Untouched since this batch wrote it: full rollback (restore
          // prior, or delete outright if this batch had created it).
          if (priorServer) {
            this.servers.set(id, priorServer);
          } else {
            this.servers.delete(id);
          }
          continue;
        }
        // REVIEW FINDING 1 (P2) — current differs from what this batch wrote:
        // a concurrent in-place mutation (_renameFolderPath /
        // removeFolderCascade rewriting `.group` on the very same object) or
        // a concurrent replace landed while this batch's persist was still
        // in flight. The old behavior treated this as "not ours anymore" and
        // skipped the WHOLE record — which for an UPDATE left the rejected
        // batch write's untouched fields (host/name/port/origin, ...) in
        // place, and the compensating save below would then persist them
        // even though the command reports failure.
        if (!priorServer) {
          // This batch CREATED the record — there is no pre-batch state to
          // merge the concurrent edit onto. Restoring "prior" here would mean
          // deleting the record outright, destroying the concurrent edit
          // along with the rejected create. Keep the current
          // (concurrently-mutated) entry as-is; this is a deliberate,
          // documented exception to "the rejected batch's fields must not
          // survive" — for a created record there is nothing else for the
          // concurrent edit to attach to.
          continue;
        }
        // This batch UPDATED an existing record: merge field-wise. A field
        // the concurrent edit actually touched (current differs from what
        // this batch wrote) keeps its current value; every other field falls
        // back to the pre-batch value, discarding this batch's rejected
        // write for that field.
        this.servers.set(id, mergeServerConfigFields(priorServer, batchSnapshot, current));
      }
      // FINDING 3 — explicitGroups: this batch only ever ADDS paths, so
      // rollback only removes paths THIS batch added that are still present.
      // A concurrently-added identical path can't be distinguished from ours
      // and is acceptably removed too — but we never do a wholesale set
      // replacement here, which would erase unrelated concurrent addGroup
      // calls entirely.
      for (const group of addedExplicitGroups) {
        this.explicitGroups.delete(group);
      }
      for (const [sessionId, session] of priorActiveSessions) {
        this.activeSessions.set(sessionId, session);
        if (priorActivitySessionIds.has(sessionId)) {
          this.activitySessionIds.add(sessionId);
        }
      }
      this.focusedSessionId = priorFocusedSessionId;
      // FINDING 2 — source record: nothing in NexusCore ever mutates an
      // InventorySourceConfig object in place (addOrUpdateInventorySource,
      // removeInventorySource, and this method itself only ever call
      // `this.inventorySources.set(id, <new object>)`), so a reference
      // compare here cannot be fooled the way the servers check above could.
      // Restore the source record only if it's still the exact object this
      // batch wrote; a concurrent edit to the same source since must not be
      // clobbered. REORDER — "absent": writtenSourceRecord is undefined, so
      // this is a no-op, exactly matching "nothing was written, nothing to
      // roll back".
      if (writtenSourceRecord && this.inventorySources.get(apply.sourceId) === writtenSourceRecord) {
        this.inventorySources.set(apply.sourceId, source!);
      }
      // FINDING 1 — all three original saves above have now settled (we
      // awaited allSettled), so it's safe to best-effort re-persist all three
      // buckets with the (post-rollback) state: one of the originals may
      // still have committed to disk (e.g. saveServers resolved before
      // saveGroups rejected), leaving disk half-applied even though memory
      // was just rolled back (conditionally) to converge with what the
      // caller is about to be told happened. Ignore individual failures — if
      // the store is still down, memory stays authoritative and the next
      // successful persist heals disk.
      await Promise.allSettled([
        this.repository.saveServers([...this.servers.values()]),
        this.repository.saveGroups([...this.explicitGroups]),
        this.repository.saveInventorySources([...this.inventorySources.values()])
      ]);
      throw firstRejection.reason;
    }
    this.emitChanged();
    return { skippedCount, removedServerIds: [...removeServerIds] };
  }

  public isServerConnected(serverId: string): boolean {
    for (const session of this.activeSessions.values()) {
      if (session.serverId === serverId) {
        return true;
      }
    }
    return false;
  }

  public isSerialProfileConnected(profileId: string): boolean {
    for (const session of this.activeSerialSessions.values()) {
      if (session.profileId === profileId) {
        return true;
      }
    }
    return false;
  }

  public isLocalShellProfileConnected(profileId: string): boolean {
    for (const session of this.activeLocalShellSessions.values()) {
      if (session.profileId === profileId) {
        return true;
      }
    }
    return false;
  }

  public async addOrUpdateServer(server: ServerConfig): Promise<void> {
    const next = server.openFileExplorerOnFirstConnect
      ? server
      : { ...server, openFileExplorerOnFirstConnect: undefined };
    if (next.openFileExplorerOnFirstConnect) {
      for (const [id, existing] of this.servers.entries()) {
        if (id !== next.id && existing.openFileExplorerOnFirstConnect) {
          this.servers.set(id, { ...existing, openFileExplorerOnFirstConnect: undefined });
        }
      }
    }
    this.servers.set(next.id, next);
    await this.repository.saveServers([...this.servers.values()]);
    this.emitChanged();
  }

  /**
   * Bulk-add servers (and the folders they live in) with a single persisted
   * write and a single change notification, instead of the N sequential
   * `addOrUpdateServer`/`addGroup` round-trips a per-row loop would cost.
   * VS Code batches memento flushes, so N awaited `globalState.update` calls
   * in a row cost roughly N times a flush interval — for a multi-thousand-row
   * inventory import that reads as a hung window. Intended for bulk import
   * paths; existing single-server callers should keep using addOrUpdateServer.
   *
   * Bulk-imported servers never carry `openFileExplorerOnFirstConnect`, so the
   * cross-server "single auto-open owner" invariant enforced by
   * addOrUpdateServer does not need to be replicated here.
   */
  public async addServersBatch(servers: ServerConfig[], folders: string[] = []): Promise<void> {
    if (servers.length === 0 && folders.length === 0) {
      return;
    }
    for (const folder of folders) {
      const normalized = normalizeFolderPath(folder);
      if (!normalized) {
        continue;
      }
      for (const ancestor of getAncestorPaths(normalized)) {
        this.explicitGroups.add(ancestor);
      }
    }
    if (folders.length > 0) {
      await this.repository.saveGroups([...this.explicitGroups]);
    }
    for (const server of servers) {
      this.servers.set(server.id, server);
    }
    if (servers.length > 0) {
      await this.repository.saveServers([...this.servers.values()]);
    }
    this.emitChanged();
  }

  public async removeServer(serverId: string): Promise<void> {
    this.servers.delete(serverId);
    this.removeServerSessions(serverId);
    await this.repository.saveServers([...this.servers.values()]);
    this.emitChanged();
  }

  public async addOrUpdateTunnel(profile: TunnelProfile): Promise<void> {
    this.tunnels.set(profile.id, profile);
    await this.repository.saveTunnels([...this.tunnels.values()]);
    this.emitChanged();
  }

  public async addOrUpdateSerialProfile(profile: SerialProfile): Promise<void> {
    this.serialProfiles.set(profile.id, profile);
    await this.repository.saveSerialProfiles([...this.serialProfiles.values()]);
    this.emitChanged();
  }

  public async addOrUpdateLocalShellProfile(profile: LocalShellProfile): Promise<void> {
    this.localShellProfiles.set(profile.id, profile);
    await this.repository.saveLocalShellProfiles([...this.localShellProfiles.values()]);
    this.emitChanged();
  }

  public async removeSerialProfile(profileId: string): Promise<void> {
    this.serialProfiles.delete(profileId);
    this.removeSerialProfileSessions(profileId);
    await this.repository.saveSerialProfiles([...this.serialProfiles.values()]);
    this.emitChanged();
  }

  public async removeLocalShellProfile(profileId: string): Promise<void> {
    this.localShellProfiles.delete(profileId);
    this.removeLocalShellProfileSessions(profileId);
    await this.repository.saveLocalShellProfiles([...this.localShellProfiles.values()]);
    this.emitChanged();
  }

  public async removeTunnel(tunnelId: string): Promise<void> {
    this.tunnels.delete(tunnelId);
    for (const [activeId, tunnel] of this.activeTunnels.entries()) {
      if (tunnel.profileId === tunnelId) {
        this.activeTunnels.delete(activeId);
      }
    }
    await this.repository.saveTunnels([...this.tunnels.values()]);
    this.emitChanged();
  }

  public registerSession(session: ActiveSession): void {
    this.activeSessions.set(session.id, session);
    this.emitChanged();
  }

  public registerSerialSession(session: ActiveSerialSession): void {
    this.activeSerialSessions.set(session.id, session);
    this.emitChanged();
  }

  public registerLocalShellSession(session: ActiveLocalShellSession): void {
    this.activeLocalShellSessions.set(session.id, session);
    this.emitChanged();
  }

  /**
   * Returns the active SSH, serial, or Local Shell session with the given id.
   * Callers use this to resolve the {@link SessionPtyHandle} for output observation / input locking.
   */
  public getActiveSessionById(sessionId: string): ActiveSession | ActiveSerialSession | ActiveLocalShellSession | undefined {
    return this.activeSessions.get(sessionId) ?? this.activeSerialSessions.get(sessionId) ?? this.activeLocalShellSessions.get(sessionId);
  }

  public unregisterLocalShellSession(sessionId: string): void {
    if (this.focusedSessionId === sessionId) {
      this.focusedSessionId = undefined;
    }
    this.activeLocalShellSessions.delete(sessionId);
    this.activitySessionIds.delete(sessionId);
    this.emitChanged();
  }

  public unregisterSerialSession(sessionId: string): void {
    if (this.focusedSessionId === sessionId) {
      this.focusedSessionId = undefined;
    }
    this.activeSerialSessions.delete(sessionId);
    this.activitySessionIds.delete(sessionId);
    this.emitChanged();
  }

  public unregisterSession(sessionId: string): void {
    if (this.focusedSessionId === sessionId) {
      this.focusedSessionId = undefined;
    }
    this.activeSessions.delete(sessionId);
    this.activitySessionIds.delete(sessionId);
    this.emitChanged();
  }

  public registerTunnel(tunnel: ActiveTunnel): void {
    this.activeTunnels.set(tunnel.id, tunnel);
    this.emitChanged();
  }

  public updateTunnelTraffic(activeTunnelId: string, bytesIn: number, bytesOut: number): void {
    const tunnel = this.activeTunnels.get(activeTunnelId);
    if (!tunnel) {
      return;
    }
    if (tunnel.bytesIn === bytesIn && tunnel.bytesOut === bytesOut) {
      return;
    }
    tunnel.bytesIn = bytesIn;
    tunnel.bytesOut = bytesOut;
    this.emitChanged();
  }

  public unregisterTunnel(activeTunnelId: string): void {
    this.activeTunnels.delete(activeTunnelId);
    this.emitChanged();
  }

  public markSessionActivity(sessionId: string): void {
    if (!this.hasSession(sessionId) || this.activitySessionIds.has(sessionId)) {
      return;
    }
    this.activitySessionIds.add(sessionId);
    this.emitChanged();
  }

  public clearSessionActivity(sessionId: string): void {
    if (!this.activitySessionIds.has(sessionId)) {
      return;
    }
    this.activitySessionIds.delete(sessionId);
    this.emitChanged();
  }

  public setFocusedSession(sessionId: string | undefined): void {
    if (this.focusedSessionId === sessionId) {
      return;
    }
    this.focusedSessionId = sessionId;
    this.emitChanged();
  }

  public setRemoteTunnels(entries: TunnelRegistryEntry[]): void {
    this.remoteTunnels = entries;
    this.emitChanged();
  }

  public async addGroup(path: string): Promise<void> {
    const normalized = normalizeFolderPath(path);
    if (!normalized) {
      return;
    }
    for (const ancestor of getAncestorPaths(normalized)) {
      this.explicitGroups.add(ancestor);
    }
    await this.repository.saveGroups([...this.explicitGroups]);
    this.emitChanged();
  }

  public async removeExplicitGroup(name: string): Promise<void> {
    this.explicitGroups.delete(name);
    await this.repository.saveGroups([...this.explicitGroups]);
    this.emitChanged();
  }

  public async renameExplicitGroup(oldName: string, newName: string): Promise<void> {
    if (this.explicitGroups.has(oldName)) {
      this.explicitGroups.delete(oldName);
      this.explicitGroups.add(newName);
      await this.repository.saveGroups([...this.explicitGroups]);
      this.emitChanged();
    }
  }

  public async moveFolder(oldPath: string, newParentPath: string | undefined): Promise<void> {
    const leaf = folderDisplayName(oldPath);
    const newPath = newParentPath ? newParentPath + "/" + leaf : leaf;
    const normalized = normalizeFolderPath(newPath);
    if (!normalized) {
      return;
    }
    if (newParentPath && isDescendantOrSelf(newParentPath, oldPath)) {
      return;
    }
    await this._renameFolderPath(oldPath, normalized);
  }

  public async renameFolder(oldPath: string, newName: string): Promise<void> {
    const parent = parentPath(oldPath);
    const newPath = parent ? parent + "/" + newName : newName;
    const normalized = normalizeFolderPath(newPath);
    if (!normalized) {
      return;
    }
    await this._renameFolderPath(oldPath, normalized);
  }

  public async removeFolderCascade(path: string, deleteContents: boolean): Promise<void> {
    const parent = parentPath(path);
    if (deleteContents) {
      for (const [id, server] of this.servers.entries()) {
        if (server.group && isDescendantOrSelf(server.group, path)) {
          this.servers.delete(id);
          this.removeServerSessions(id);
        }
      }
      for (const [id, profile] of this.serialProfiles.entries()) {
        if (profile.group && isDescendantOrSelf(profile.group, path)) {
          this.serialProfiles.delete(id);
          this.removeSerialProfileSessions(id);
        }
      }
      for (const [id, profile] of this.localShellProfiles.entries()) {
        if (profile.group && isDescendantOrSelf(profile.group, path)) {
          this.localShellProfiles.delete(id);
          this.removeLocalShellProfileSessions(id);
        }
      }
    } else {
      for (const server of this.servers.values()) {
        if (server.group && isDescendantOrSelf(server.group, path)) {
          const suffix = server.group.slice(path.length);
          server.group = parent ? parent + suffix : suffix.slice(1) || undefined;
        }
      }
      for (const profile of this.serialProfiles.values()) {
        if (profile.group && isDescendantOrSelf(profile.group, path)) {
          const suffix = profile.group.slice(path.length);
          profile.group = parent ? parent + suffix : suffix.slice(1) || undefined;
        }
      }
      for (const profile of this.localShellProfiles.values()) {
        if (profile.group && isDescendantOrSelf(profile.group, path)) {
          const suffix = profile.group.slice(path.length);
          profile.group = parent ? parent + suffix : suffix.slice(1) || undefined;
        }
      }
    }
    const reparentedGroups: string[] = [];
    for (const g of this.explicitGroups) {
      if (isDescendantOrSelf(g, path)) {
        this.explicitGroups.delete(g);
        if (!deleteContents && g !== path) {
          const suffix = g.slice(path.length);
          const newGroup = parent ? parent + suffix : suffix.slice(1);
          if (newGroup) {
            reparentedGroups.push(newGroup);
          }
        }
      }
    }
    for (const g of reparentedGroups) {
      this.explicitGroups.add(g);
    }
    await Promise.all([
      this.repository.saveServers([...this.servers.values()]),
      this.repository.saveSerialProfiles([...this.serialProfiles.values()]),
      this.repository.saveLocalShellProfiles([...this.localShellProfiles.values()]),
      this.repository.saveGroups([...this.explicitGroups])
    ]);
    this.emitChanged();
  }

  public getItemsInFolder(path: string, recursive: boolean): { servers: ServerConfig[]; serialProfiles: SerialProfile[]; localShellProfiles: LocalShellProfile[] } {
    const servers: ServerConfig[] = [];
    const profiles: SerialProfile[] = [];
    const localShellProfiles: LocalShellProfile[] = [];
    for (const server of this.servers.values()) {
      if (!server.group) {
        continue;
      }
      if (recursive ? isDescendantOrSelf(server.group, path) : server.group === path) {
        servers.push(server);
      }
    }
    for (const profile of this.serialProfiles.values()) {
      if (!profile.group) {
        continue;
      }
      if (recursive ? isDescendantOrSelf(profile.group, path) : profile.group === path) {
        profiles.push(profile);
      }
    }
    for (const profile of this.localShellProfiles.values()) {
      if (!profile.group) {
        continue;
      }
      if (recursive ? isDescendantOrSelf(profile.group, path) : profile.group === path) {
        localShellProfiles.push(profile);
      }
    }
    return { servers, serialProfiles: profiles, localShellProfiles };
  }

  private async _renameFolderPath(oldPath: string, newPath: string): Promise<void> {
    // Remap all explicitGroups entries
    const toAdd: string[] = [];
    for (const g of this.explicitGroups) {
      if (isDescendantOrSelf(g, oldPath)) {
        this.explicitGroups.delete(g);
        toAdd.push(newPath + g.slice(oldPath.length));
      }
    }
    for (const g of toAdd) {
      this.explicitGroups.add(g);
    }
    // Ensure ancestors of newPath exist
    for (const ancestor of getAncestorPaths(newPath)) {
      this.explicitGroups.add(ancestor);
    }

    // Remap all item groups
    for (const server of this.servers.values()) {
      if (server.group && isDescendantOrSelf(server.group, oldPath)) {
        server.group = newPath + server.group.slice(oldPath.length);
      }
    }
    for (const profile of this.serialProfiles.values()) {
      if (profile.group && isDescendantOrSelf(profile.group, oldPath)) {
        profile.group = newPath + profile.group.slice(oldPath.length);
      }
    }
    for (const profile of this.localShellProfiles.values()) {
      if (profile.group && isDescendantOrSelf(profile.group, oldPath)) {
        profile.group = newPath + profile.group.slice(oldPath.length);
      }
    }

    await Promise.all([
      this.repository.saveServers([...this.servers.values()]),
      this.repository.saveSerialProfiles([...this.serialProfiles.values()]),
      this.repository.saveLocalShellProfiles([...this.localShellProfiles.values()]),
      this.repository.saveGroups([...this.explicitGroups])
    ]);
    this.emitChanged();
  }

  private emitChanged(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private hasSession(sessionId: string): boolean {
    return this.activeSessions.has(sessionId) || this.activeSerialSessions.has(sessionId) || this.activeLocalShellSessions.has(sessionId);
  }

  private removeServerSessions(serverId: string): void {
    for (const [sessionId, session] of this.activeSessions.entries()) {
      if (session.serverId === serverId) {
        if (this.focusedSessionId === sessionId) {
          this.focusedSessionId = undefined;
        }
        this.activeSessions.delete(sessionId);
        this.activitySessionIds.delete(sessionId);
      }
    }
  }

  private removeSerialProfileSessions(profileId: string): void {
    for (const [sessionId, session] of this.activeSerialSessions.entries()) {
      if (session.profileId === profileId) {
        if (this.focusedSessionId === sessionId) {
          this.focusedSessionId = undefined;
        }
        this.activeSerialSessions.delete(sessionId);
        this.activitySessionIds.delete(sessionId);
      }
    }
  }

  private removeLocalShellProfileSessions(profileId: string): void {
    for (const [sessionId, session] of this.activeLocalShellSessions.entries()) {
      if (session.profileId === profileId) {
        if (this.focusedSessionId === sessionId) {
          this.focusedSessionId = undefined;
        }
        this.activeLocalShellSessions.delete(sessionId);
        this.activitySessionIds.delete(sessionId);
      }
    }
  }
}

function normalizeFileExplorerAutoOpenOwner(servers: ServerConfig[]): { servers: ServerConfig[]; changed: boolean } {
  let ownerId: string | undefined;
  for (const server of servers) {
    if (server.openFileExplorerOnFirstConnect) {
      ownerId = server.id;
    }
  }
  if (!ownerId) {
    return { servers, changed: false };
  }

  let changed = false;
  const normalized = servers.map((server) => {
    if (server.id === ownerId || !server.openFileExplorerOnFirstConnect) {
      return server;
    }
    changed = true;
    return { ...server, openFileExplorerOnFirstConnect: undefined };
  });
  return { servers: normalized, changed };
}
