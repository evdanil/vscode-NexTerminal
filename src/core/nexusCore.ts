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
  // TOMBSTONE (rollback-vs-live-close race) — set while applyInventorySyncPlan
  // has captured pre-batch session state and is awaiting its persist. Session
  // lifecycle callbacks (onSessionClosed -> unregisterSession) are NOT
  // serialized against this window by configMutationLock, so a terminal the
  // user closes while the batch's save is in flight legitimately removes its
  // session bookkeeping concurrently with the batch. If that save then fails
  // and applyInventorySyncPlan rolls back, it must NOT resurrect a session
  // that was tombstoned during the window: unregisterSession records here any
  // session id it removes while inventorySyncApplyInFlight is true, and
  // applyInventorySyncPlan consults this set before re-inserting a captured
  // session or restoring focusedSessionId to one. Scoped to
  // applyInventorySyncPlan only — no other mutator sets or reads this.
  private inventorySyncApplyInFlight = false;
  private readonly inventorySyncTombstonedSessionIds = new Set<string>();

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
   * ITEM B (empty-folder GC) — called synchronously from within
   * applyInventorySyncPlan's mutation phase, AFTER the batch's own
   * upserts/removes have already been applied to `this.servers` (so
   * emptiness reflects the POST-sync state, not the pre-sync one). Removes
   * explicit folders that are:
   *   - in `ownedCandidates` (REVIEW FINDING 1, P2 — the source's OWN prior
   *     `managedFolders`, minus the folders this very sync still names OR
   *     still occupies with its own devices). A folder never named by any of
   *     this source's own past applies is NEVER a candidate here, however
   *     empty it is — it might be a manually-created folder the user
   *     deliberately keeps empty (e.g. a staging area under the same
   *     targetFolder), or one owned by a completely different source. GC only
   *     ever reclaims a folder that this source itself created and has since
   *     stopped naming/occupying,
   *   - not in `crossSourceProtectedPaths` (any path another source currently
   *     manages, or has as an ancestor of a managed path, or that sits under
   *     another source's own configured `targetFolder` — REVIEW FINDING 2,
   *     P2, and its CROSS-SOURCE TARGET-ROOT extension; see
   *     applyInventorySyncPlan's call site for the full derivation) — never
   *     sweeps cross-owned territory out from under a still-live claim.
   *     REVIEW FINDING 1 (P2, retain candidates the GC did not actually
   *     remove) — a candidate skipped for THIS reason is deliberately handled
   *     the exact same way as an occupied one: this method simply never adds
   *     it to the returned `removed` set, so the caller's bookkeeping
   *     (`retainedGcCandidates` at the call site) keeps remembering it until
   *     the protection genuinely lifts and a later apply finds it reclaimable,
   *
   *     TARGET-EDIT FIX — `ownedCandidates` is evaluated at EACH candidate's
   *     OWN path, not filtered to live under the CURRENT `targetFolder`. A
   *     candidate drawn from `previousManagedFolders` was stamped relative to
   *     whatever `targetFolder` was in effect on the sync that created it,
   *     which can differ from the CURRENT `targetFolder` when the source's
   *     `targetFolder` was edited between syncs (e.g. "NetBox" -> "Infra") —
   *     restricting candidates to `startsWith(targetFolder + "/")` would
   *     silently exclude every folder still sitting under the OLD target
   *     (e.g. "NetBox/RackA"), so it could never be reclaimed even after it
   *     goes empty, and the very next restamp of `managedFolders` (see the
   *     call site) then replaces the set with only new-target paths —
   *     permanently losing the cleanup opportunity for the old target's tree.
   *     The `targetFolder` parameter is kept only to protect the CURRENT
   *     target's own root from ever being reclaimed (see below); it is no
   *     longer used to restrict WHICH candidates are considered,
   *   - not in `keepFolders` (the application's own `folders` list, with
   *     ancestors included) — a folder this very sync still names must never
   *     be GC'd out from under it just because it happens to be empty this
   *     run (this is implied by `ownedCandidates` already excluding the new
   *     managed set, kept here too as defense-in-depth),
   *   - not equal to `targetFolder` itself — the CURRENT target's own root
   *     always survives, even if it happens to appear in `ownedCandidates`.
   *     Under normal stamping this never happens (`newManagedFolders` and
   *     `previousManagedFolders` both only ever hold paths STRICTLY under
   *     their respective target, so a target's own root is never itself a
   *     member — see the call site), but a source whose `targetFolder` is
   *     edited to a value that happens to equal a PREVIOUS candidate path
   *     (e.g. old target "A" with candidate "A/B", then `targetFolder`
   *     edited to "A/B") could otherwise coincide with it; this check is the
   *     backstop,
   *   - structurally well-formed and already in normalized form (own path
   *     has a "/", `normalizeFolderPath` accepts it unchanged) — defensive
   *     only. Every candidate a REAL sync ever stamps into `managedFolders`
   *     is a strict descendant of some non-root `targetFolder` (root-target
   *     sources never ACCUMULATE `managedFolders` themselves — `newManaged
   *     Folders` is unconditionally empty whenever the CURRENT `targetFolder`
   *     is "", see the call site — so a legitimately-stamped candidate always
   *     has at least one "/"; a root-targeted source's `previousManagedFolders`
   *     can still be non-empty for exactly one apply, right after it was
   *     retargeted away from a non-root value, and those inherited candidates
   *     are still multi-segment), but `validateInventorySource` accepts ANY
   *     string array for `managedFolders`, so a legacy/imported source
   *     record could carry an arbitrary (even single-segment, root-level)
   *     path here. A single-segment candidate is treated the same as a
   *     root-level folder and skipped, mirroring the "never sweep a
   *     root-level folder" rule applied to normal target folders, and
   *   - completely empty: no server (ANY origin — manual or synced from a
   *     DIFFERENT source), serial profile, or local-shell profile currently
   *     assigned to it, AND no descendant folder that is itself still
   *     present.
   *
   * Processes candidates deepest-first (most path segments first) so a
   * folder that becomes empty only because ALL of its children were removed
   * earlier in this SAME pass is itself removed too — "no non-empty
   * descendant" is evaluated against what remains after this pass's own
   * removals, not against the pre-GC tree.
   *
   * Entity coverage: ServerConfig, SerialProfile, and LocalShellProfile are
   * the only three record types that carry a `group` participating in
   * `this.explicitGroups` (see removeFolderCascade / _renameFolderPath /
   * getItemsInFolder above, which enumerate exactly these three). Terminal
   * macros also have a folder concept, but it is a COMPLETELY SEPARATE
   * list (`nexus.macros.folders`, owned by `services/macroFolders.ts`) that
   * NexusCore never reads or writes — nothing of theirs lives in
   * `this.explicitGroups`, so there is nothing to check here.
   *
   * Only ever DELETES from `this.explicitGroups` and returns exactly the set
   * of paths it removed; persisting the result and restoring any of the
   * returned ids on a rolled-back persist is the caller's job (see
   * applyInventorySyncPlan's rollback, which extends its existing
   * `addedExplicitGroups` conditional-restore machinery to a mirrored
   * `removedEmptyGroups` one for exactly this reason).
   */
  private pruneEmptyFoldersUnderTarget(
    targetFolder: string,
    keepFolders: ReadonlySet<string>,
    ownedCandidates: ReadonlySet<string>,
    crossSourceProtectedPaths: ReadonlySet<string>
  ): Set<string> {
    const removed = new Set<string>();
    const candidates = [...ownedCandidates]
      .filter((candidate) => {
        if (candidate === targetFolder || keepFolders.has(candidate)) {
          return false;
        }
        if (crossSourceProtectedPaths.has(candidate)) {
          // REVIEW FINDING 2 (P2, cross-source ownership) + its
          // CROSS-SOURCE TARGET-ROOT extension — another source still
          // manages this path exactly, has it as an ancestor of a managed
          // path, or has it under its own configured targetFolder. Skipped,
          // not removed — the caller's bookkeeping decides separately
          // whether to keep remembering it (see REVIEW FINDING 1, P2 at the
          // call site).
          return false;
        }
        if (!candidate.includes("/")) {
          // Defensive: a legitimately-stamped candidate is always strictly
          // under SOME non-root target and therefore always has a "/" — see
          // the doc above. A single-segment path only reaches here via a
          // legacy/imported record with a hand-edited `managedFolders`
          // array; refuse to touch it, same as a root-level folder.
          return false;
        }
        if (normalizeFolderPath(candidate) !== candidate) {
          // Defensive: same legacy/imported-record concern — only act on
          // candidates already in normalized form.
          return false;
        }
        return this.explicitGroups.has(candidate);
      })
      .sort((a, b) => b.split("/").length - a.split("/").length);

    for (const candidate of candidates) {
      if (!this.explicitGroups.has(candidate)) {
        continue; // already removed earlier in this same pass (shouldn't happen — candidates are deduped — stays defensive)
      }
      // F4 — an occupant at an IMPLICIT descendant path (a hand-typed group
      // like "NetBox/RackA/Special" that was never itself added to
      // explicitGroups) must still protect "NetBox/RackA" from being GC'd:
      // exact-match alone missed this, since nothing ever creates an
      // explicit folder entry for "Special" the way the tree UI would for a
      // folder a user actually browsed to. Every group at or under
      // `candidate` (candidate itself, or any "candidate/..." descendant,
      // implicit or explicit) counts as occupying it.
      const occupiesCandidate = (group: string | undefined): boolean =>
        group !== undefined && (group === candidate || group.startsWith(`${candidate}/`));
      let occupied = false;
      for (const server of this.servers.values()) {
        if (occupiesCandidate(server.group)) {
          occupied = true;
          break;
        }
      }
      if (!occupied) {
        for (const profile of this.serialProfiles.values()) {
          if (occupiesCandidate(profile.group)) {
            occupied = true;
            break;
          }
        }
      }
      if (!occupied) {
        for (const profile of this.localShellProfiles.values()) {
          if (occupiesCandidate(profile.group)) {
            occupied = true;
            break;
          }
        }
      }
      if (occupied) {
        continue;
      }
      const descendantPrefix = `${candidate}/`;
      let hasDescendant = false;
      for (const group of this.explicitGroups) {
        if (group !== candidate && group.startsWith(descendantPrefix)) {
          hasDescendant = true;
          break;
        }
      }
      if (hasDescendant) {
        continue;
      }
      this.explicitGroups.delete(candidate);
      removed.add(candidate);
    }
    return removed;
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
   *
   * ITEM B (empty-folder GC) — also returns `removedEmptyFolderCount`: how
   * many explicit folders `pruneEmptyFoldersUnderTarget` removed as part of
   * this same batch (see that method's doc; always 0 in "absent" mode). A
   * root-targeted (`targetFolder === ""`) source never GCs anything IT
   * SEEDED — it never accumulates `managedFolders` in the first place — but
   * CAN still be nonzero for one that was just retargeted TO root: candidates
   * inherited from its previous non-root target are still processed (REVIEW
   * FINDING 1, P2), only ever at their own multi-segment path, never at the
   * root level. Zero in every case this method predates this feature.
   */
  public async applyInventorySyncPlan(
    apply: InventorySyncApplication
  ): Promise<{ skippedCount: number; removedServerIds: string[]; removedEmptyFolderCount: number }> {
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
    // FINDING 3 — sessions are restored on rollback with no reference/
    // presence check like servers/groups get below (a concurrent addGroup or
    // addOrUpdateServer can't touch these session maps). But unlike servers
    // or groups, session removal here CAN be raced by something outside this
    // serialized command path: NexusCore.unregisterSession (the public API
    // fired by the terminal-close -> onSessionClosed handler) is NOT gated
    // by configMutationLock, so a terminal the user closes for real while
    // this batch's persist is in flight can legitimately remove one of these
    // very sessions in between the capture below and the rollback further
    // down. See the TOMBSTONE mechanism (inventorySyncApplyInFlight /
    // inventorySyncTombstonedSessionIds) guarding the rollback below — a
    // session torn down that way is excluded from restoration rather than
    // resurrected.
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
    // ITEM B — every folder (with ancestors) this application's own `folders`
    // list touches, whether newly added above or already present. GC below
    // must never remove one of these even if it turns out empty this run —
    // this sync itself still names it.
    const applicationFolderSet = new Set<string>();

    for (const folder of apply.folders) {
      const normalized = normalizeFolderPath(folder);
      if (!normalized) {
        continue;
      }
      for (const ancestor of getAncestorPaths(normalized)) {
        applicationFolderSet.add(ancestor);
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
    // OWNERSHIP FIX (USE is not ownership) — a folder the user pre-created by
    // hand (e.g. "NetBox/RackA" made via the tree UI before this source ever
    // synced) that a sync merely PLACES a device into must never enter
    // `managedFolders` on that basis alone: the sync didn't create it, so it
    // doesn't own it, and it must never become GC-eligible later just because
    // the device that happens to sit there moves away. Ownership can only
    // come from two places: (a) a path this apply itself just ADDED to
    // `explicitGroups` (it didn't exist before — this apply's own act of
    // syncing brought it into being), or (b) a path this source already
    // owned on a PRIOR apply (`previousManagedFolders`) that is still in
    // actual use by this source (current footprint or this apply's own
    // `folders` list) — carrying ownership forward, not re-deriving it from
    // occupancy alone.
    //
    // `sourceOwnedFootprint` — walk `this.servers` (already mutated above)
    // for every record this source currently owns (`origin?.sourceId ===
    // apply.sourceId`) and collect its group plus all ancestors, restricted
    // to strictly-under-`targetFolder`. This is USE, not ownership by
    // itself — see below, it only ever re-affirms a folder already in
    // `previousManagedFolders`, it never seeds a brand-new one.
    const sourceOwnedFootprint = new Set<string>();
    if (source && source.targetFolder !== "") {
      const prefix = `${source.targetFolder}/`;
      for (const server of this.servers.values()) {
        if (server.origin?.sourceId !== apply.sourceId || !server.group) {
          continue;
        }
        for (const ancestor of getAncestorPaths(server.group)) {
          if (ancestor.startsWith(prefix)) {
            sourceOwnedFootprint.add(ancestor);
          }
        }
      }
    }
    // `applicationFolderSetFiltered` — this apply's own `folders` list (with
    // ancestors), restricted to strictly-under-`targetFolder`. Covers a
    // folder this apply just created but which is momentarily empty (e.g. a
    // fresh orphan destination with nothing moved into it yet on THIS apply)
    // — same role `applicationFolderSet` played before this fix, just scoped
    // to the target.
    const applicationFolderSetFiltered =
      source && source.targetFolder !== ""
        ? new Set([...applicationFolderSet].filter((f) => f.startsWith(`${source.targetFolder}/`)))
        : new Set<string>();
    // `previousManagedFolders` — what this source owned coming INTO this
    // apply (empty for a legacy record or a source's first-ever non-"absent"
    // apply — nothing to carry forward yet).
    const previousManagedFolders = new Set(source?.managedFolders ?? []);
    // `createdThisApply` — paths THIS apply's own `folders` list caused to be
    // newly added to `explicitGroups` (see `addedExplicitGroups` above),
    // restricted to strictly-under-`targetFolder`. This is the ONLY source of
    // brand-new ownership: a path already present in `explicitGroups` before
    // this apply ran — pre-created by the user, or owned by a different
    // source — is never in `addedExplicitGroups`, however this apply's own
    // footprint or `folders` list happens to use it.
    const createdThisApply =
      source && source.targetFolder !== ""
        ? new Set([...addedExplicitGroups].filter((f) => f.startsWith(`${source.targetFolder}/`)))
        : new Set<string>();
    // This REPLACES the source's previous `managedFolders` wholesale — it is
    // NOT an accumulating history. `newManagedFolders` = (paths this source
    // already owned that are still in actual use) UNION (paths this apply
    // just created). A previously-owned path no longer in use (occupied by
    // none of this source's own devices AND not named by this apply's own
    // `folders` list — e.g. a renamed rack) drops out here, becoming a GC
    // candidate below. A path merely USED (footprint) but never OWNED
    // (neither previously-managed nor newly-created) never enters the set at
    // all — see the fix comment above; this is what makes a user-pre-created
    // folder immune to GC forever, exactly as it must be.
    const currentFootprintOrNamed = new Set([...sourceOwnedFootprint, ...applicationFolderSetFiltered]);
    const newManagedFolders: Set<string> =
      source && source.targetFolder !== ""
        ? new Set([...[...previousManagedFolders].filter((f) => currentFootprintOrNamed.has(f)), ...createdThisApply])
        : new Set<string>();
    // `gcOwnedCandidates` — the previous managed set MINUS the new one:
    // folders this source itself OWNED (not merely used) on some prior sync
    // and has now stopped naming/occupying. Only these are eligible for GC
    // below; a folder never in the source's own managed history (hand-created
    // by the user, or owned by a DIFFERENT source under the same
    // targetFolder) is never touched, however empty it is.
    //
    // REVIEW FINDING 2 (P2, cross-source ownership) — two sources can target
    // overlapping trees and both legitimately manage the very same folder
    // (e.g. two NetBox sources pointed at the same "NetBox" targetFolder,
    // each syncing devices into "NetBox/RackA"). If source X drops the folder
    // from its own managed set while it's momentarily empty, GC must not
    // reclaim it out from under source Y, which still names it. Exclude from
    // removal (see `pruneEmptyFoldersUnderTarget` below) any path that is
    // EXACTLY managed by another source, OR is an ANCESTOR of a path another
    // source manages — deleting an ancestor would orphan that other source's
    // chain even though the ancestor itself isn't in the other source's set
    // verbatim.
    //
    // CROSS-SOURCE TARGET-ROOT FIX — `managedFolders` is deliberately never
    // stamped with a source's own `targetFolder` root (see
    // `pruneEmptyFoldersUnderTarget`'s doc — a target's own root is never a
    // member of its own managed set). That is correct for a source's OWN GC,
    // but it left a gap here: another source's `targetFolder` can be pointed
    // at a folder THIS source owns (e.g. source A created "NetBox/RackA" via
    // its own sync; source B is later configured with `targetFolder ===
    // "NetBox/RackA"` and simply hasn't synced any device into it yet, so
    // `managedFolders` for B is still empty). Checking only `managedFolders`
    // means B's own configured root carries no protection at all — A
    // abandoning its last device leaves "NetBox/RackA" a GC candidate for A,
    // and it gets deleted out from under B's still-live configuration, even
    // though B never got a chance to sync anything into it. Fold every OTHER
    // source's own non-root `targetFolder` (plus its ancestors) into the same
    // protected set — a configured target root is a live claim on that
    // folder regardless of whether that source has synced into it yet. A
    // root-targeted (`targetFolder === ""`) other source contributes nothing
    // here, exactly like it never accumulates `managedFolders` itself.
    //
    // `otherSourcesExactManagedFolders` — REVIEW FINDING 1 (P2, retain
    // candidates the GC did not actually remove) needs this SEPARATELY from
    // `otherSourcesProtectedPaths` below: see that finding's note on
    // `retainedGcCandidates` further down for why a candidate EXACTLY present
    // in another source's OWN `managedFolders` must NOT be retained back into
    // THIS source's bookkeeping, even though it is (correctly) never removed
    // here.
    const otherSourcesExactManagedFolders = new Set<string>();
    const otherSourcesProtectedPaths = new Set<string>();
    for (const [otherId, otherSource] of this.inventorySources) {
      if (otherId === apply.sourceId) {
        continue;
      }
      for (const managed of otherSource.managedFolders ?? []) {
        otherSourcesExactManagedFolders.add(managed);
        for (const ancestor of getAncestorPaths(managed)) {
          otherSourcesProtectedPaths.add(ancestor);
        }
      }
      if (otherSource.targetFolder !== "") {
        for (const ancestor of getAncestorPaths(otherSource.targetFolder)) {
          otherSourcesProtectedPaths.add(ancestor);
        }
      }
    }
    // REVIEW FINDING 1 (P2, retain candidates the GC did not actually remove)
    // — `gcOwnedCandidates` used to ALSO subtract `otherSourcesProtectedPaths`
    // here, which meant a candidate deferred by cross-source protection never
    // even reached `pruneEmptyFoldersUnderTarget` — it silently vanished from
    // consideration. That collapsed two different things into one: "must
    // never be REMOVED right now" (still true, and still enforced — see the
    // `pruneEmptyFoldersUnderTarget` call below, which now takes
    // `otherSourcesProtectedPaths` itself and skips a protected candidate the
    // same way it skips an occupied one) versus "this source no longer needs
    // to REMEMBER it created this folder" (false — the source's bookkeeping
    // ownership must survive until the folder is GENUINELY reclaimed; see
    // `retainedGcCandidates` below). `gcOwnedCandidates` now holds every
    // candidate this source has stopped naming/occupying, protected or not —
    // protection is enforced once, inside the prune call, not twice.
    const gcOwnedCandidates = new Set([...previousManagedFolders].filter((f) => !newManagedFolders.has(f)));
    // ITEM B (empty-folder GC) — runs synchronously here, in the mutation
    // phase, AFTER the upserts/removes above so it sees the POST-sync server
    // set. Scoped to non-"absent" applications only (REMOVAL disposition
    // leaves folders alone — the source is gone, there is nothing to sync
    // back into them, and leaving them is the documented, conservative
    // choice) with a live `source` record (guaranteed non-"absent" branch).
    //
    // REVIEW FINDING 1 (P2, root retarget strands old-tree cleanup) — this
    // call is NOT gated on `source.targetFolder !== ""` anymore. Root ("")
    // keeps exactly ONE invariant: it never ACCUMULATES new ownership — see
    // `newManagedFolders` above, which is unconditionally empty for a root
    // target, so a root source's own footprint/folder-list can never seed a
    // future GC candidate, and `pruneEmptyFoldersUnderTarget` independently
    // refuses to ever touch a single-segment (root-level) candidate or one
    // equal to `targetFolder` itself. What root no longer blocks is
    // processing `gcOwnedCandidates` INHERITED from a previous non-root
    // `targetFolder` (e.g. a source retargeted from "NetBox" to "" still
    // carries ["NetBox/RackA"] in `previousManagedFolders` until this apply
    // restamps it) — those candidates are multi-segment by construction and
    // are evaluated at their own path with every existing safety check
    // (occupancy, descendants, cross-source ownership), so gating the whole
    // call on the CURRENT targetFolder being non-root did nothing but strand
    // that one-time cleanup forever the moment `managedFolders` got restamped
    // to `[]` immediately below. "Empty at the top level might be
    // deliberate" is still honored — it just now means "never sweep a
    // root-level folder", not "never run GC for a root-targeted source".
    const removedEmptyGroups: Set<string> =
      apply.expectedSource !== "absent" && source
        ? this.pruneEmptyFoldersUnderTarget(source.targetFolder, applicationFolderSet, gcOwnedCandidates, otherSourcesProtectedPaths)
        : new Set<string>();
    // REVIEW FINDING 1 (P2, retain candidates the GC did not actually
    // remove) — a candidate that fell out of `newManagedFolders` but was NOT
    // actually deleted above (deferred by cross-source protection, still
    // occupied, still has a live descendant, or skipped as
    // defensively-malformed) must not simply vanish from this source's own
    // bookkeeping. Before this fix, `managedFolders` was stamped from
    // `newManagedFolders` alone, so the very next persist silently forgot
    // that this source ever created the folder — if the thing protecting it
    // was later removed or retargeted, nothing remembered the path anymore
    // and it could never be reclaimed ("protection lifts" only held true
    // WITHIN the single apply that observed it).
    //
    // `retainedGcCandidates` = gcOwnedCandidates − actuallyRemoved − (paths
    // EXACTLY present in another source's OWN `managedFolders`). That last
    // subtraction is deliberate and NOT redundant with the
    // `crossSourceProtectedPaths` skip inside `pruneEmptyFoldersUnderTarget`
    // above (which already guarantees this candidate was never actually
    // removed): retaining it here TOO would double-book it. When another
    // source X's own `managedFolders` exactly names this path, X's OWN next
    // apply independently re-diffs it from X's OWN `previousManagedFolders`
    // regardless of whether THIS source also remembers it — X is already the
    // one carrying it forward. Retaining it on THIS source's side as well
    // creates a genuine mutual-retention deadlock: THIS source's retained
    // entry then shows up in X's `otherSourcesProtectedPaths` on X's next
    // apply, deferring X's own reclaim of the very same path, which in turn
    // keeps IT in THIS source's `otherSourcesProtectedPaths` next time round
    // — neither source ever independently lets go, even after BOTH have
    // genuinely stopped naming/occupying it (see
    // nexusCoreInventory.test.ts's "(REVIEW FINDING 2, P2 — cross-source
    // ownership)" and "(old-target co-ownership)" tests, which pin exactly
    // this "reclaimed once BOTH have dropped it" guarantee and would
    // regress into a permanent deadlock without this exclusion). This
    // exclusion does NOT apply to protection arising only from another
    // source's `targetFolder` (not its `managedFolders`) — that source has
    // no `previousManagedFolders` entry for this path to re-diff on its own
    // next sync (it may never have synced anything into it at all), so THIS
    // source retaining the candidate is the ONLY way it is ever revisited —
    // exactly the scenario REVIEW FINDING 1 exists to fix (see
    // nexusCoreInventory.test.ts's "(cross-source target-root protection)"
    // test).
    //
    // A candidate whose folder no longer exists in `explicitGroups` at all
    // (removed through some path other than this GC — e.g. a user's manual
    // "Delete Folder" from the tree UI) is also dropped here rather than
    // retained: there is nothing left to ever reclaim, so bookkeeping a
    // ghost path forever would only grow the set without bound.
    const retainedGcCandidates = new Set(
      [...gcOwnedCandidates].filter(
        (f) => !removedEmptyGroups.has(f) && !otherSourcesExactManagedFolders.has(f) && this.explicitGroups.has(f)
      )
    );
    const stampedManagedFolders = new Set([...newManagedFolders, ...retainedGcCandidates]);
    // FINDING 4 (focus review) — same conditional-restore principle as
    // servers/groups above, applied to focusedSessionId: record what THIS
    // batch's own synchronous mutation phase left focusedSessionId as
    // (removeServerSessions, called from the loop just above, clears it when
    // the focused session belonged to a removed server). A user calling
    // setFocusedSession mid-window — while the persist below is still
    // pending — changes focusedSessionId to something this batch never
    // wrote; rollback must recognize that and leave it alone rather than
    // unconditionally snapping back to priorFocusedSessionId.
    const batchWrittenFocusedSessionId = this.focusedSessionId;
    // REORDER — "absent": there is no source record to bump lastSyncAt on or
    // write an entry for; writtenSourceRecord stays undefined and the
    // inventorySources map (and its rollback below) are left completely
    // alone. The bucket is still included in the persist below (unchanged
    // content), keeping the existing one-persist-one-emit shape intact
    // rather than special-casing the "absent" apply into its own save call.
    //
    // REVIEW FINDING 1 (P2, folder-GC ownership) — `managedFolders` is
    // stamped here, in the SAME object/write as the `lastSyncAt` bump, so it
    // shares that field's revision semantics: this is a routine sync stamp,
    // not a new incarnation of the record, so `revision` is deliberately NOT
    // touched (addOrUpdateInventorySource remains the only place a live
    // record's revision is ever reassigned — see that method's doc).
    const writtenSourceRecord = source
      ? { ...source, lastSyncAt: apply.syncedAt, managedFolders: [...stampedManagedFolders] }
      : undefined;
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
    //
    // TOMBSTONE — from here until this call resolves/rejects, session
    // lifecycle callbacks are NOT serialized against this batch: a terminal
    // the user closes while these saves are pending fires
    // onSessionClosed -> unregisterSession concurrently with this await.
    // Mark the window "in flight" so unregisterSession records any id it
    // genuinely removes during it; the rollback below must not resurrect
    // those ids from priorActiveSessions/priorFocusedSessionId.
    this.inventorySyncApplyInFlight = true;
    this.inventorySyncTombstonedSessionIds.clear();
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
      // ITEM B (empty-folder GC rollback) — mirrors the addedExplicitGroups
      // restore just above, for the OPPOSITE direction: folders THIS batch's
      // GC pass removed must be put back on a rejected persist, but only if
      // nothing concurrent has since re-added the exact same path (e.g. a
      // concurrent addGroup, or a concurrent addOrUpdateServer assigning a
      // server back into it) while the persist above was in flight — a
      // wholesale unconditional re-add would clobber that concurrent state
      // the same way an unconditional restore would for addedExplicitGroups.
      for (const group of removedEmptyGroups) {
        if (!this.explicitGroups.has(group)) {
          this.explicitGroups.add(group);
        }
      }
      // TOMBSTONE — a captured session that was genuinely torn down by
      // unregisterSession during the awaited persist (window opened just
      // above) must NOT be resurrected here: the terminal is actually gone,
      // and re-inserting it would leave isServerConnected/focus pointing at
      // a dead session.
      for (const [sessionId, session] of priorActiveSessions) {
        if (this.inventorySyncTombstonedSessionIds.has(sessionId)) {
          continue;
        }
        this.activeSessions.set(sessionId, session);
        if (priorActivitySessionIds.has(sessionId)) {
          this.activitySessionIds.add(sessionId);
        }
      }
      // FINDING 4 — restore focusedSessionId only if it's still exactly what
      // this batch itself wrote (batchWrittenFocusedSessionId, captured right
      // after the mutation loop above). If a concurrent setFocusedSession
      // moved focus to something else while the persist was pending, that is
      // newer than this batch and must not be clobbered by a rollback of a
      // batch that no longer owns the current value. Tombstone rule still
      // applies on top: never restore focus onto a session that was
      // genuinely torn down during the in-flight window.
      if (this.focusedSessionId === batchWrittenFocusedSessionId) {
        this.focusedSessionId =
          priorFocusedSessionId !== undefined && this.inventorySyncTombstonedSessionIds.has(priorFocusedSessionId)
            ? undefined
            : priorFocusedSessionId;
      }
      // FINDING 2 — source record: nothing in NexusCore ever mutates an
      // InventorySourceConfig object in place (addOrUpdateInventorySource,
      // removeInventorySource, and this method itself only ever call
      // `this.inventorySources.set(id, <new object>)`), so a reference
      // compare here cannot be fooled the way the servers check above could.
      // Restore the source record only if it's still the exact object this
      // batch wrote; a concurrent edit to the same source since must not be
      // clobbered. REORDER — "absent": writtenSourceRecord is undefined, so
      // this is a no-op, exactly matching "nothing was written, nothing to
      // roll back". REVIEW FINDING 1 (P2, folder-GC ownership) —
      // `managedFolders` rides along for free here: `source!` is the whole
      // pre-apply record (this apply's mutation phase only ever builds a
      // NEW `writtenSourceRecord` object — see above — it never mutates
      // `source` in place), so restoring it wholesale also reverts
      // `managedFolders` to its pre-apply value, exactly as it must on a
      // rejected persist.
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
      // TOMBSTONE — apply has now definitively failed and rolled back; close
      // the window and drop any recorded ids (they've been consulted above
      // and must not leak into a later, unrelated apply).
      this.inventorySyncApplyInFlight = false;
      this.inventorySyncTombstonedSessionIds.clear();
      throw firstRejection.reason;
    }
    // TOMBSTONE — apply succeeded; close the window (nothing to roll back,
    // so any recorded ids are moot).
    this.inventorySyncApplyInFlight = false;
    this.inventorySyncTombstonedSessionIds.clear();
    this.emitChanged();
    return { skippedCount, removedServerIds: [...removeServerIds], removedEmptyFolderCount: removedEmptyGroups.size };
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
    // TOMBSTONE — an applyInventorySyncPlan batch is mid-flight (see field
    // doc above): record that this session was genuinely torn down during
    // the window, so a subsequent rollback in that batch does not resurrect
    // it from its pre-batch capture.
    if (this.inventorySyncApplyInFlight) {
      this.inventorySyncTombstonedSessionIds.add(sessionId);
    }
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
