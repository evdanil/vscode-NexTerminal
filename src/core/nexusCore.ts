import { randomUUID } from "node:crypto";
import {
  cloneServerConfig,
  mergeServerConfigFields,
  resolveServerProtocol,
  serverConfigsEqual,
  templatedHasAnyStamp,
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
import { inventorySourceValuesEqual, sourceConfigUnchanged, type InventorySourceConfig, type InventoryStatusReport } from "../models/inventory";
// PRIMARY HOST/PORT (task #29) — the telnet port-heal reuses the sync engine's
// OWN ownership predicates rather than a local copy, so the "only heal what the
// sync owns" rule can never drift from the sync's own write rule. This is a
// runtime import into syncEngine; the reverse edge (syncEngine → nexusCore) is
// type-only, so there is no runtime cycle.
import { syncOwnsHost, syncOwnsPort } from "../services/inventory/syncEngine";
// P2-1 (review) — the heal validates its own resulting record before persisting,
// so it can NEVER write a host/port that `validateServerConfig` would reject on
// the next reload (the #82 record-drop class). Belt-and-suspenders behind the
// tightened status-report validator, for an untrusted provider that hands a
// report straight in-process without going through validateInventoryStatusReport.
import { validateServerConfig } from "../utils/validation";
import type { DeviceTemplateProfile } from "../models/deviceTemplate";
import type { SavedFilterDefinition } from "../models/savedFilter";
import {
  cloneLocalServerConfig,
  localServerConfigsEqual,
  type ActiveLocalServerSession,
  type LocalServerConfig,
  type LocalServerStatus
} from "../models/localServer";
import type {
  ActiveNetworkServerSession,
  NetworkServerKind,
  NetworkServerRuntimeDetail,
  NetworkServerStatus,
  NetworkServerTransferHistoryEntry
} from "../models/networkServer";
import {
  cloneDhcpProfile,
  cloneTftpProfile,
  type DhcpConfigProfile,
  type TftpConfigProfile
} from "../models/networkServerProfile";
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
  private readonly localServers = new Map<string, LocalServerConfig>();
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly activeSerialSessions = new Map<string, ActiveSerialSession>();
  private readonly activeLocalShellSessions = new Map<string, ActiveLocalShellSession>();
  private readonly activeLocalServerSessions = new Map<string, ActiveLocalServerSession>();
  // Keyed by kind, not by a generated session id: TFTP and DHCP are fixed
  // singletons, so the kind IS the identity. Runtime-only — nothing here is
  // persisted, because their configuration lives in VS Code settings.
  private readonly activeNetworkServerSessions = new Map<NetworkServerKind, ActiveNetworkServerSession>();
  // Persisted, unlike the sessions above: these are named snapshots of the two
  // services' settings, kept in separate maps because TFTP and DHCP presets
  // are independent of each other and share no fields.
  private readonly tftpProfiles = new Map<string, TftpConfigProfile>();
  private readonly dhcpProfiles = new Map<string, DhcpConfigProfile>();
  private readonly activeTunnels = new Map<string, ActiveTunnel>();
  private readonly activitySessionIds = new Set<string>();
  // LIVE STATUS (Phase 2) — runtime-only running/stopped state per server,
  // driven by applyInventoryStatus from a provider's fetchStatus report. NOT
  // persisted (it dies with the window and is re-fetched on demand / poll).
  // `serverStatusSource` records which source each entry came from, so a later
  // apply for that source can drop the entries it no longer reports (including
  // servers pruned or removed) without touching another source's entries.
  private readonly serverStatus = new Map<string, "running" | "stopped">();
  private readonly serverStatusSource = new Map<string, string>();
  // #84 P2 (Codex) — per-source MUTATION EPOCH: a monotonic counter bumped
  // whenever THIS source's servers are mutated+persisted (a sync apply, or the
  // heal's own writes). The refresh path captures it at fetch start and re-checks
  // it inside the heal's lock, so a status report that straddled a completed sync
  // (which bumps the epoch but NOT the config revision — a routine sync only
  // touches lastSyncAt/managedFolders) is dropped instead of persisting a stale
  // console port over the freshly-synced one. A dedicated counter, not
  // `lastSyncAt` (a timestamp can collide and is not bumped by non-sync writes).
  private readonly sourceMutationEpoch = new Map<string, number>();
  private focusedSessionId: string | undefined = undefined;
  private remoteTunnels: TunnelRegistryEntry[] = [];
  private readonly explicitGroups = new Set<string>();
  private readonly authProfiles = new Map<string, AuthProfile>();
  private readonly inventorySources = new Map<string, InventorySourceConfig>();
  private readonly deviceTemplates = new Map<string, DeviceTemplateProfile>();
  private readonly savedFilters = new Map<string, SavedFilterDefinition>();
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
    const [servers, tunnels, serialProfiles, localShellProfiles, localServers, groups, authProfiles, inventorySources, deviceTemplates, savedFilters, tftpProfiles, dhcpProfiles] =
      await Promise.all([
        this.repository.getServers(),
        this.repository.getTunnels(),
        this.repository.getSerialProfiles(),
        this.repository.getLocalShellProfiles(),
        this.repository.getLocalServers(),
        this.repository.getGroups(),
        this.repository.getAuthProfiles(),
        this.repository.getInventorySources(),
        this.repository.getDeviceTemplates(),
        this.repository.getSavedFilters(),
        this.repository.getTftpProfiles(),
        this.repository.getDhcpProfiles()
      ]);
    this.servers.clear();
    this.tunnels.clear();
    this.serialProfiles.clear();
    this.localShellProfiles.clear();
    this.localServers.clear();
    this.explicitGroups.clear();
    this.authProfiles.clear();
    this.inventorySources.clear();
    this.deviceTemplates.clear();
    this.savedFilters.clear();
    this.tftpProfiles.clear();
    this.dhcpProfiles.clear();
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
    for (const server of localServers) {
      this.localServers.set(server.id, server);
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
    for (const template of deviceTemplates) {
      this.deviceTemplates.set(template.id, template);
    }
    for (const filter of savedFilters) {
      this.savedFilters.set(filter.id, filter);
    }
    for (const profile of tftpProfiles) {
      this.tftpProfiles.set(profile.id, profile);
    }
    for (const profile of dhcpProfiles) {
      this.dhcpProfiles.set(profile.id, profile);
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
      localServers: [...this.localServers.values()],
      activeSessions: [...this.activeSessions.values()],
      activeSerialSessions: [...this.activeSerialSessions.values()],
      activeLocalShellSessions: [...this.activeLocalShellSessions.values()],
      activeLocalServerSessions: [...this.activeLocalServerSessions.values()],
      activeNetworkServerSessions: [...this.activeNetworkServerSessions.values()],
      tftpProfiles: [...this.tftpProfiles.values()],
      dhcpProfiles: [...this.dhcpProfiles.values()],
      activeTunnels: [...this.activeTunnels.values()],
      remoteTunnels: [...this.remoteTunnels],
      explicitGroups: [...this.explicitGroups],
      authProfiles: [...this.authProfiles.values()],
      activitySessionIds: new Set(this.activitySessionIds),
      serverStatus: new Map(this.serverStatus),
      focusedSessionId: this.focusedSessionId,
      inventorySources: [...this.inventorySources.values()],
      deviceTemplates: [...this.deviceTemplates.values()],
      savedFilters: [...this.savedFilters.values()]
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

  public getLocalServer(id: string): LocalServerConfig | undefined {
    return this.localServers.get(id);
  }

  public getTftpProfile(id: string): TftpConfigProfile | undefined {
    return this.tftpProfiles.get(id);
  }

  public getDhcpProfile(id: string): DhcpConfigProfile | undefined {
    return this.dhcpProfiles.get(id);
  }

  public getAuthProfile(id: string): AuthProfile | undefined {
    return this.authProfiles.get(id);
  }

  public async addOrUpdateAuthProfile(profile: AuthProfile): Promise<void> {
    this.authProfiles.set(profile.id, profile);
    await this.repository.saveAuthProfiles([...this.authProfiles.values()]);
    this.emitChanged();
  }

  /**
   * Deletes the profile and clears every reference to it, so nothing is left
   * pointing at an id that no longer resolves. Two kinds of holder:
   *
   *   - servers (`ServerConfig.authProfileId`) — cleared in place, as before;
   *   - inventory sources (`InventorySourceConfig.authProfileId`) — cleared
   *     with a FRESH `revision`, because clearing one is a new INCARNATION of
   *     the record in exactly the sense addOrUpdateInventorySource documents.
   *     A sync in flight against the old incarnation must abort on
   *     sourceConfigUnchanged (inventoryCommands' "configuration changed while
   *     syncing" guard) rather than stamp a profile that was just deleted;
   *     reusing the revision would let it through. Only referencing sources are
   *     re-revisioned — churning an unrelated source's revision would abort ITS
   *     in-flight sync for no reason.
   *
   * Persist order is authProfiles -> servers -> inventorySources, each written
   * only when it actually changed, with a single emitChanged() on the way out
   * whether the saves succeeded or threw: the profile record must be gone from
   * disk before the cleared references are, so a rejection midway can never
   * leave references cleared on disk while the profile they pointed at
   * survives.
   *
   * FINDING A — same discipline as addOrUpdateInventorySource: the source map
   * is mutated first (repo-wide in-memory-first pattern), but a rejected
   * saveInventorySources must leave NO trace, or the half-cleared, already
   * re-revisioned records would be silently committed by the next unrelated
   * saveInventorySources call from some other command. Capture the previous
   * entries before mutating and restore them on rejection.
   *
   * FINDING 2 (P2) — that restore covers EVERY failure BEFORE the deletion
   * commits, not just a rejected saveInventorySources. A rejected
   * saveAuthProfiles leaves the sources cleared and re-revisioned in memory
   * while disk still holds both the profile and the links, and the next
   * unrelated inventory-source save from any other command persists the whole
   * map — silently committing a deletion that failed. The restore therefore
   * lives in a catch around all three saves, INSIDE the try/finally that owns
   * the emission, so it always runs before observers are told to re-read (see
   * the emission note below).
   *
   * REVIEW FINDING (P2) — but it is gated on `deletionCommitted`, because past
   * the FIRST save the restore stops being a rollback and becomes corruption.
   * Once saveAuthProfiles resolves the profile record is GONE FROM DISK: putting
   * `authProfileId` back on a source then points memory (and, via the next
   * unrelated saveInventorySources, disk) at a profile that no longer exists
   * anywhere. Every later sync falls back to agent authentication with the
   * dangling-profile warning, and the deletion cannot be retried to fix it —
   * there is no profile left to select, so nothing can reach removeAuthProfile
   * with this id again.
   *
   * Rolling the WHOLE deletion back instead is not available: the profile's
   * vault secrets are deleted by the caller BEFORE this method is entered
   * (AuthProfileEditorPanel's delete handler), so re-saving the record would
   * resurrect a profile whose password and passphrase are already gone —
   * a silently broken credential in place of a missing one.
   *
   * So the two halves of the rule are:
   *   - saveAuthProfiles rejected -> nothing committed; restore the sources so
   *     the map matches disk and the delete stays retryable.
   *   - saveAuthProfiles resolved, a later save rejected -> the deletion HAS
   *     committed; keep the cleared sources. Memory is then correct, and the
   *     "a foreign command's next saveInventorySources persists this map"
   *     property that made a leftover dangerous above is what heals disk here.
   *     The clears not reaching disk in this run is survivable on its own: a
   *     source reloaded with a link to a profile that is gone resolves to
   *     nothing and degrades to agent auth with a warning, which is exactly the
   *     dangling case computeSyncPlan already handles.
   *
   * SERIALIZATION IS THE CALLER'S JOB (FINDING 1, P2). The clears above are
   * persisted as snapshots taken synchronously at each save's call time, so an
   * inventory write that started earlier (applyInventorySyncPlan /
   * addOrUpdateInventorySource, still awaiting its repository write with a
   * PRE-clear snapshot) can commit last and put the cleared references back on
   * disk while memory looks correct. The fix is to serialize this method
   * against those sections under `services/configMutationLock` — but that lock
   * MUST NOT be acquired here: `AsyncMutex` is not re-entrant, and two of the
   * three call sites already hold it (configCommands' importMergeReplaceLocked
   * and completeReset both run their whole mutation phase inside
   * `runExclusive`), so taking it here would deadlock the extension host on a
   * backup restore or a complete reset. The third and only lock-free caller,
   * `AuthProfileEditorPanel`'s delete handler, acquires it around this call
   * instead. Any NEW caller must either already hold `configMutationLock` or
   * acquire it around this call.
   *
   * KNOWN ASYMMETRY, and how the gate above reconciles with it: the
   * `authProfiles` and `servers` in-memory mutations are NOT rolled back when
   * their own saves reject. Those two are the deletion's primary intent rather
   * than incidental reference clearing, and the emission contract below is
   * written around them staying applied — observers are told the profile is
   * gone. The source clears are now held to the SAME standard rather than a
   * different one: they are undone only while the deletion can still be said not
   * to have happened, and from the moment it has, they stay applied exactly like
   * the other two. The asymmetry that remains is only in the one window where
   * the deletion genuinely did not happen.
   */
  public async removeAuthProfile(profileId: string): Promise<void> {
    this.authProfiles.delete(profileId);
    let serversChanged = false;
    for (const [id, server] of this.servers.entries()) {
      // Either link is enough to make this server a reference-holder: a server
      // can name this profile as its SSH credentials, as its BMC credentials
      // (`ipmiAuthProfileId`, issue #48 Phase 3), or as both, and a deletion
      // that only swept the first would leave `${profile.ipmiUsername}` and the
      // credential injection resolving against a profile that no longer exists —
      // silently, on every run, with the server form showing an empty select.
      if (server.authProfileId === profileId || server.ipmiAuthProfileId === profileId) {
        const cleared: ServerConfig = { ...server };
        if (server.authProfileId === profileId) {
          cleared.authProfileId = undefined;
        }
        if (server.ipmiAuthProfileId === profileId) {
          cleared.ipmiAuthProfileId = undefined;
        }
        // The inventory sync's record that IT linked this profile goes with the
        // link. Without this, deleting a profile an inventory source applied
        // would leave every server it owned looking permanently opted OUT (no
        // `authProfileId`, but a stamp naming a profile) — so re-pointing the
        // source at a replacement profile would silently skip exactly the
        // servers the sync itself had configured, which nobody ever hand-edited.
        // This clear is the system's doing, not a user decision, so the stamp
        // must not outlive the link it describes.
        //
        // Scoped to the servers whose `authProfileId` is being cleared here: a
        // server whose link the USER already cleared (stamp names this profile,
        // `authProfileId` already undefined) is not touched, so its opt-out
        // survives the profile's deletion — which is the whole point of it.
        //
        // The `authProfileId === profileId` term is what keeps that scoping true
        // now that this loop can also be entered through `ipmiAuthProfileId`:
        // the stamp records an SSH link, so a server reached here only by its
        // BMC link has had no SSH link cleared and must keep its stamp.
        if (server.authProfileId === profileId && server.origin?.syncedAuthProfileId === profileId) {
          cleared.origin = { ...server.origin, syncedAuthProfileId: undefined };
        }
        // REVIEW FINDING (P1, adoption auth provenance) — the DETACHED form of
        // the same stamp, on a server kept from a removed source
        // (`DetachedServerOrigin.syncedAuthProfileId`). Adoption restores it into
        // a real origin, so a stamp left standing here would name a deleted
        // profile from the moment that server is reclaimed — the permanent
        // opt-out this clear exists to prevent, merely deferred until the marker
        // is cashed in. Scoped identically: only where the link being cleared is
        // the one the stamp names, so a user's own divergence survives.
        if (server.authProfileId === profileId && server.formerlySynced?.syncedAuthProfileId === profileId) {
          cleared.formerlySynced = { ...server.formerlySynced, syncedAuthProfileId: undefined };
        }
        // BMC VALUE STAMP (issue #48 PR-T3, `origin.templated.ipmiAuthProfileId`)
        // — the sync's receipt that IT wrote the BMC credential link on this
        // server, cleared for the SAME reason as the SSH `syncedAuthProfileId`
        // stamp above: left standing after its link is gone it reads as a
        // per-server opt-out (value undefined, stamp still naming a profile), and
        // `matrixWrites` would lock the field out of even a later override
        // template — the carry-forward trap the PR-T3 value stamps otherwise
        // spring on deletion.
        //
        // GATE ASYMMETRY vs the SSH stamp clears above: those gate on
        // `authProfileId === profileId` because `syncedAuthProfileId` records the
        // SSH link. THIS stamp records the BMC link, so it gates on
        // `ipmiAuthProfileId === profileId`. A server reached here only through
        // its SSH link has had no BMC link cleared and must keep its BMC stamp;
        // and a server whose BMC value the USER already hand-cleared (value
        // undefined, stamp still naming this profile, reached here only via its
        // SSH link) keeps it too — that opt-out is deliberate.
        //
        // SINGLE-MEMBER CLEAR — mirrors the sync engine's `dropTemplateProxy` /
        // `clearTemplatedStamps`: rebuild the `templated` bag without the member
        // and collapse it to `undefined` when nothing else is stamped
        // (`templatedHasAnyStamp`). Chained off `cleared.origin` so a server that
        // named this profile on BOTH links loses the SSH stamp AND the BMC stamp.
        if (
          server.ipmiAuthProfileId === profileId &&
          (cleared.origin ?? server.origin)?.templated?.ipmiAuthProfileId === profileId
        ) {
          const baseOrigin = cleared.origin ?? server.origin!;
          const templated = { ...baseOrigin.templated };
          delete templated.ipmiAuthProfileId;
          cleared.origin = { ...baseOrigin, templated: templatedHasAnyStamp(templated) ? templated : undefined };
        }
        // The detached twin (`formerlySynced.templated.ipmiAuthProfileId`) — swept
        // for the reason the SSH `formerlySynced.syncedAuthProfileId` above is:
        // adoption restores the marker into a live origin, so a stamp left naming
        // a deleted profile would be the permanent opt-out this clear prevents,
        // merely deferred until the record is reclaimed. Same BMC-link gate, same
        // single-member mechanics.
        if (
          server.ipmiAuthProfileId === profileId &&
          (cleared.formerlySynced ?? server.formerlySynced)?.templated?.ipmiAuthProfileId === profileId
        ) {
          const baseFormerly = cleared.formerlySynced ?? server.formerlySynced!;
          const templated = { ...baseFormerly.templated };
          delete templated.ipmiAuthProfileId;
          cleared.formerlySynced = {
            ...baseFormerly,
            templated: templatedHasAnyStamp(templated) ? templated : undefined
          };
        }
        this.servers.set(id, cleared);
        serversChanged = true;
      }
    }
    const previousSources = new Map<string, InventorySourceConfig>();
    for (const [id, source] of this.inventorySources.entries()) {
      if (source.authProfileId === profileId) {
        previousSources.set(id, source);
        this.inventorySources.set(id, { ...source, authProfileId: undefined, revision: randomUUID() });
      }
    }
    // DEVICE TEMPLATES (PR-T1, §8.4) — a template's `fields.authProfileId` names
    // this same AuthProfile store, so a deletion must clear it there too: a link
    // naming a profile that no longer exists resolves to nothing on every sync,
    // with nothing on screen to say why. The template is re-revisioned like the
    // sources — but note what that does and does NOT buy in T1. The full mid-sync
    // template-revision drift fast-fail (capturing each referenced template's
    // revision at fetch time and comparing it before apply) is DEFERRED TO T1b,
    // and NOT because no T1 path mutates a template: THIS method re-revisions
    // every template that links the deleted profile, and `removeDeviceTemplate`
    // re-revisions the sources that reference the deleted template — both are
    // reachable in T1. It is deferred because (i) the window is narrow (a
    // `removeAuthProfile` landing mid-apply of an already-in-flight plan),
    // (ii) the worst outcome is a dangling `authProfileId` that degrades to SSH
    // agent auth at connect time — not data loss or a security hole — and
    // (iii) the fuller guard belongs with T1b's template-authoring UI, which is
    // when templates first become user-mutable at all (in T1 they arrive only by
    // import). KNOWN RESIDUAL the T1b guard closes: when a profile is referenced
    // ONLY by a template (never by a `source.authProfileId`), deleting it
    // re-revisions the template but NOT any source, so the shipped
    // `sourceConfigUnchanged` pre-apply guard does not catch it, and it does not
    // self-heal — the profile is not in `profilesNeedingServerKey`, so no AUTH 2b
    // rollback fires; only an override rule or a manual edit reclaims the link.
    // The server-side stamp (`syncedAuthProfileId`) is already handled above via
    // the shared stamp; this is the SOURCE of the link, not the record of it.
    const previousTemplates = new Map<string, DeviceTemplateProfile>();
    for (const [id, template] of this.deviceTemplates.entries()) {
      // A template can name this profile as its SSH `authProfileId`, as its BMC
      // `ipmiAuthProfileId` (issue #48 PR-T3), or as BOTH — each is an
      // independent link into this same AuthProfile store, so each is swept on
      // its own terms and a template naming the profile in both fields loses
      // both. Destructured out (never written `undefined`) exactly like the SSH
      // field, with the same single rollback capture/restore and re-revision.
      const sshLinkMatch = template.fields.authProfileId?.value === profileId;
      const bmcLinkMatch = template.fields.ipmiAuthProfileId?.value === profileId;
      if (sshLinkMatch || bmcLinkMatch) {
        previousTemplates.set(id, template);
        let restFields = template.fields;
        if (sshLinkMatch) {
          const { authProfileId: _authProfileId, ...rest } = restFields;
          restFields = rest;
        }
        if (bmcLinkMatch) {
          const { ipmiAuthProfileId: _ipmiAuthProfileId, ...rest } = restFields;
          restFields = rest;
        }
        this.deviceTemplates.set(id, { ...template, fields: restFields, revision: randomUUID() });
      }
    }
    // The emission is in a `finally`, not on the success path: by the time any
    // of these saves can reject, the profile is already gone from this.authProfiles
    // and the server references are already cleared in memory (and, past the
    // first await, on disk). Returning through a rejection without emitting
    // would leave every observer rendering a profile that no longer exists and
    // links that no longer resolve, until some unrelated change happened to fire
    // an emission. Whatever the in-memory state ends up being — fully applied,
    // or with the inventory-source clears rolled back below — observers are told
    // about it exactly once.
    // The single fact the restore below is gated on: has the profile record
    // itself left disk yet? Set between the save and the next await, so nothing
    // can observe it out of step with what has been persisted.
    let deletionCommitted = false;
    try {
      try {
        await this.repository.saveAuthProfiles([...this.authProfiles.values()]);
        deletionCommitted = true;
        if (serversChanged) {
          await this.repository.saveServers([...this.servers.values()]);
        }
        if (previousSources.size > 0) {
          await this.repository.saveInventorySources([...this.inventorySources.values()]);
        }
        // DEVICE TEMPLATES (PR-T1, §8.4) — last in the ordered persist chain
        // (authProfiles gate -> servers -> inventorySources -> deviceTemplates),
        // written only when it actually changed, on the same "the profile record
        // must leave disk before its references do" argument the sources follow.
        if (previousTemplates.size > 0) {
          await this.repository.saveDeviceTemplates([...this.deviceTemplates.values()]);
        }
      } catch (error) {
        // FINDING A / FINDING 2 — restore the sources for a rejection that
        // happened BEFORE the profile record left disk, then rethrow. A no-op
        // when nothing was cleared (`previousSources` empty), so it needs no
        // guard of its own. This catch is nested inside the emitting try/finally
        // rather than wrapping it, so the restore is complete before the
        // emission fires.
        //
        // REVIEW FINDING (P2) — once `deletionCommitted` is true the restore is
        // SKIPPED: re-linking a source to a profile that no longer exists (and
        // can no longer be deleted again) is worse than leaving the link
        // cleared. See the two-halves rule in the doc comment above.
        if (!deletionCommitted) {
          for (const [id, source] of previousSources) {
            this.inventorySources.set(id, source);
          }
          // DEVICE TEMPLATES (PR-T1, §8.4) — restored on the same pre-commit
          // terms as the sources, and skipped once the deletion has committed
          // for the same reason (re-linking a template to a profile that no
          // longer exists, and can no longer be deleted, is worse than leaving
          // the field cleared).
          for (const [id, template] of previousTemplates) {
            this.deviceTemplates.set(id, template);
          }
        }
        throw error;
      }
    } finally {
      this.emitChanged();
    }
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
    // LIVE STATUS (Phase 2) — a change to the PROVIDER CONFIG (baseUrl,
    // rootFolder, filter, …) invalidates any runtime status: the report was
    // fetched under the old config, so nodes the new config excludes — or the
    // old deployment's nodes entirely — must not keep a stale highlight. Detected
    // by a real config-value change so a no-op edit (or a non-config edit like a
    // rename) does not needlessly clear. Cleared AFTER the persist succeeds.
    const configChanged = hadPrevious && previous !== undefined && !inventorySourceValuesEqual(previous.config, source.config);
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
    if (configChanged) {
      // No separate emit — the emitChanged() below covers the status drop too.
      this.dropInventoryStatusForSource(source.id);
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
    // LIVE STATUS (Phase 2) — the source is gone; drop any runtime status it
    // owned so a removed source leaves no lingering running/stopped highlight.
    // Shares clearInventoryStatus's loop; no extra emit since emitChanged()
    // fires below regardless.
    this.dropInventoryStatusForSource(id);
    this.emitChanged();
  }

  public getDeviceTemplate(id: string): DeviceTemplateProfile | undefined {
    return this.deviceTemplates.get(id);
  }

  /**
   * DEVICE TEMPLATES (PR-T1) — the map mutation happens first (repo-wide
   * in-memory-first pattern), with a rejected persist leaving NO trace, exactly
   * like `addOrUpdateInventorySource`. Every write is a new INCARNATION: a fresh
   * `revision` is assigned here, unconditionally (even if `template` already
   * carries one), so the mid-sync template-revision drift fast-fail can tell an
   * old incarnation from a new one. That comparison itself is DEFERRED TO T1b
   * (see `removeAuthProfile` for why, and for the residual it leaves): T1 mints
   * the revision but does not yet compare it, so this write does not by itself
   * abort an in-flight sync today.
   */
  public async addOrUpdateDeviceTemplate(template: DeviceTemplateProfile): Promise<void> {
    const hadPrevious = this.deviceTemplates.has(template.id);
    const previous = this.deviceTemplates.get(template.id);
    const withRevision: DeviceTemplateProfile = { ...template, revision: randomUUID() };
    this.deviceTemplates.set(template.id, withRevision);
    try {
      await this.repository.saveDeviceTemplates([...this.deviceTemplates.values()]);
    } catch (error) {
      if (hadPrevious) {
        this.deviceTemplates.set(template.id, previous!);
      } else {
        this.deviceTemplates.delete(template.id);
      }
      throw error;
    }
    this.emitChanged();
  }

  /**
   * DEVICE TEMPLATES (PR-T1, §6.2) — remove the template record and clear every
   * `templateRules` entry referencing it on every source (re-revisioned so an
   * in-flight sync aborts). Applied values and stamps on servers are KEPT (row
   * 5: sync-owned, reclaimable) — there is NO server write at delete time, so
   * deletion is O(sources), not O(fleet).
   *
   * PERSIST ORDER (m11) — the `removeAuthProfile` in-memory-first + ordered
   * persist + rollback discipline with `saveDeviceTemplates` in the commit-gate
   * position: capture previous sources -> mutate maps -> saveDeviceTemplates
   * (deletionCommitted flips true here) -> saveInventorySources. A rejection
   * BEFORE the gate restores the captured sources in memory (map matches disk,
   * delete stays retryable); a rejection AFTER it keeps the source clears (the
   * "next foreign saveInventorySources heals disk" property). Emission in a
   * `finally`, once.
   */
  public async removeDeviceTemplate(id: string): Promise<void> {
    const hadPrevious = this.deviceTemplates.has(id);
    const previousTemplate = this.deviceTemplates.get(id);
    this.deviceTemplates.delete(id);
    const previousSources = new Map<string, InventorySourceConfig>();
    for (const [sourceId, source] of this.inventorySources.entries()) {
      const rules = source.templateRules;
      if (rules && rules.some((rule) => rule.templateId === id)) {
        previousSources.set(sourceId, source);
        const remaining = rules.filter((rule) => rule.templateId !== id);
        this.inventorySources.set(sourceId, { ...source, templateRules: remaining, revision: randomUUID() });
      }
    }
    let deletionCommitted = false;
    try {
      try {
        if (hadPrevious) {
          await this.repository.saveDeviceTemplates([...this.deviceTemplates.values()]);
        }
        deletionCommitted = true;
        if (previousSources.size > 0) {
          await this.repository.saveInventorySources([...this.inventorySources.values()]);
        }
      } catch (error) {
        if (!deletionCommitted) {
          if (hadPrevious && previousTemplate !== undefined) {
            this.deviceTemplates.set(id, previousTemplate);
          }
          for (const [sourceId, source] of previousSources) {
            this.inventorySources.set(sourceId, source);
          }
        }
        throw error;
      }
    } finally {
      this.emitChanged();
    }
  }

  public getSavedFilter(id: string): SavedFilterDefinition | undefined {
    return this.savedFilters.get(id);
  }

  /**
   * SAVED FILTER DEFINITIONS (issue #48 PR-E) — the repo-wide in-memory-first +
   * persist + rollback discipline (`addOrUpdateAuthProfile`/
   * `addOrUpdateDeviceTemplate`): the map mutates first, and a rejected persist
   * leaves NO trace (the previous record is restored, or the new one removed) so
   * the next unrelated `saveSavedFilters` from some other command can never
   * silently commit a half-applied change.
   *
   * No `revision` is minted here (unlike device templates / inventory sources): a
   * saved filter is a copy-from template with no in-flight-sync incarnation
   * semantics to fast-fail against — the value is copied into a source's own
   * `config.filter` at pick time and never referenced live.
   */
  public async addOrUpdateSavedFilter(filter: SavedFilterDefinition): Promise<void> {
    const hadPrevious = this.savedFilters.has(filter.id);
    const previous = this.savedFilters.get(filter.id);
    this.savedFilters.set(filter.id, filter);
    try {
      await this.repository.saveSavedFilters([...this.savedFilters.values()]);
    } catch (error) {
      if (hadPrevious) {
        this.savedFilters.set(filter.id, previous!);
      } else {
        this.savedFilters.delete(filter.id);
      }
      throw error;
    }
    this.emitChanged();
  }

  /**
   * SAVED FILTER DEFINITIONS (issue #48 PR-E) — delete a saved filter definition.
   *
   * DELIBERATELY DOES NO SOURCE SWEEP. A saved definition is a template to COPY
   * FROM, not a live reference: picking one fills a source's own `config.filter`
   * with an INDEPENDENT copy of the query string, so a source keeps whatever
   * filter it was last configured with regardless of what happens to the
   * definition it was copied from. Sweeping sources' stored `config.filter` here
   * would silently wipe working filters off unrelated sources — the exact
   * opposite of what a template-library delete should do. So this is a plain
   * record drop with the same in-memory-first + persist + rollback discipline as
   * `addOrUpdateSavedFilter`; a rejected persist restores the deleted record.
   */
  public async removeSavedFilter(id: string): Promise<void> {
    const hadPrevious = this.savedFilters.has(id);
    const previous = this.savedFilters.get(id);
    if (!hadPrevious) {
      return;
    }
    this.savedFilters.delete(id);
    try {
      await this.repository.saveSavedFilters([...this.savedFilters.values()]);
    } catch (error) {
      this.savedFilters.set(id, previous!);
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
    // LIVE STATUS (Phase 2) — capture the runtime status entries this prune is
    // about to drop, so a rejected persist below can restore them alongside the
    // servers they belong to (the rollback envelope otherwise loses the
    // running/stopped highlight even though the server itself comes back).
    const droppedServerStatus = new Map<string, { state: "running" | "stopped"; source: string | undefined }>();
    for (const id of removeServerIds) {
      const priorStatus = this.serverStatus.get(id);
      if (priorStatus !== undefined) {
        droppedServerStatus.set(id, { state: priorStatus, source: this.serverStatusSource.get(id) });
      }
      this.servers.delete(id);
      this.removeServerSessions(id);
      // A pruned server must not leave a ghost status entry (P3-4).
      this.dropServerStatusEntry(id);
      batchWrittenServers.set(id, undefined);
    }
    for (const server of upsertServers) {
      this.servers.set(server.id, server);
      batchWrittenServers.set(server.id, cloneServerConfig(server));
    }
    // DEPENDENT-LINK SWEEP (issue #48 PR-C, PR #65 Codex round 10) — a gateway
    // server pruned by this sync leaves surviving servers with a dangling
    // `ipmiGatewayServerId` that silently degrades gateway routing to local.
    // Sweep it with the SAME shared helper removeServer uses, folded into this
    // method's EXISTING persist/rollback envelope: run it AFTER the deletions and
    // upserts are committed to `this.servers` and BEFORE the single saveServers
    // below, so cleared survivors ride that one persist and one emit — no second
    // write, no second emit. Each swept survivor is also enrolled in this batch's
    // transactional bookkeeping so the conditional rollback restores it exactly
    // like an upsert: capture its PRE-sweep record into `priorServers` (before
    // the helper mutates it — `captureServerPrior` is idempotent, so a survivor
    // already captured as a removed/upserted id keeps its earlier prior), then
    // record the CLEARED record as this batch's write in `batchWrittenServers`.
    // Only `ipmiGatewayServerId` on survivors is touched — every other field, and
    // which servers remain, auth links, and origins, are left exactly as the
    // deletions/upserts above left them.
    const gatewayDeletedIds = new Set(removeServerIds);
    if (gatewayDeletedIds.size > 0) {
      for (const [id, server] of this.servers.entries()) {
        if (server.ipmiGatewayServerId !== undefined && gatewayDeletedIds.has(server.ipmiGatewayServerId)) {
          captureServerPrior(id);
        }
      }
      for (const sweptId of this.clearGatewayReferencesTo(gatewayDeletedIds)) {
        const cleared = this.servers.get(sweptId);
        if (cleared) {
          batchWrittenServers.set(sweptId, cloneServerConfig(cleared));
        }
      }
    }
    // APPLICATION-TIME UPSERTED-GATEWAY REVALIDATION (issue #48 PR-T3, PR #66
    // Codex round 7) — the sync-apply SIBLING of round 6's manual-apply per-write
    // revalidation (deviceTemplateCommands.ts `applyPlanWrites`), same class, same
    // graceful-degradation symptom. `computeSyncPlan` validated each upserted
    // server's `ipmiGatewayServerId` against a `liveServerIds` SNAPSHOT taken at
    // PLAN time (syncEngine.ts). A folder delete (`nexus.group.remove`) does NOT
    // take `configMutationLock` and does not revise the source/template, so it can
    // prune the selected gateway AFTER that snapshot — e.g. from another window
    // while this apply's confirmation modal is open — and the pre-apply guards
    // (`sourceConfigUnchanged` / the "absent" structural checks) still pass. The
    // upsert then lands in `this.servers` above carrying a gateway id that no
    // longer names any server. The `gatewayDeletedIds` sweep just above only
    // covers servers THIS plan removes (`removeServerIds`), so it misses that
    // externally-deleted gateway, the dangling link persists, and IPMI silently
    // falls back to local (`resolveIpmiGatewayServer` treats a dangling id as
    // "reachable locally"). Close it on this path too: after the deletions,
    // upserts, and the removeServerIds-sweep have all landed, revalidate each
    // UPSERTED server against the FINAL `this.servers` and clear a gateway that no
    // longer resolves — folded into this method's EXISTING persist/rollback
    // envelope exactly like the sweep above (capture the PRE-clear record into
    // `priorServers` before mutating — `captureServerPrior` is idempotent, so an
    // upsert already captured at its original value keeps that prior — then record
    // the CLEARED record as this batch's write in `batchWrittenServers`, riding
    // the one `saveServers` + one emit below: NO second write, NO second emit).
    // Only `ipmiGatewayServerId` (+ its stamp under the round-5 gate) on the
    // affected upserts is touched; every other field, which servers remain, auth
    // links, and origins stay exactly as the deletions/upserts left them.
    //
    // `ipmiAuthProfileId` is deliberately NOT revalidated here — auth profiles are
    // validated against the never-pruned profile store; a server-ref (gateway) is
    // the one that races with folder deletion. And folder deletion is NOT
    // serialized (the lower-blast-radius revalidation is the chosen fix, mirroring
    // round 6).
    for (const upserted of upsertServers) {
      const live = this.servers.get(upserted.id);
      // Only a server THIS batch still owns in the live map, whose gateway is set
      // but resolves to no surviving server. A gateway whose target was removed by
      // THIS plan's own `removeServerIds` was already cleared by the sweep above,
      // so `live.ipmiGatewayServerId` reads `undefined` here and it is skipped —
      // no double processing. A gateway still present (`this.servers.has(gw)`) is
      // live and left alone, which is also what keeps a DIVERGED stamp (value
      // present-and-live, stamp naming some other now-absent id) untouched: the
      // value is live, there is nothing to clear, and the round-5 equality gate
      // below never fires on it anyway.
      if (!live || live.ipmiGatewayServerId === undefined || this.servers.has(live.ipmiGatewayServerId)) {
        continue;
      }
      // REVIEW FINDING (PR #66 Codex round 8) — restrict this cleanup to a
      // TEMPLATE-OWNED gateway (the sync's own write: stamp === value, on the live
      // origin OR its detached `formerlySynced` twin). A HAND-configured gateway —
      // unstamped, or a value the user diverged to (`cur !== stamp`) — is §8.4
      // leave-alone: `computeSyncPlan` deliberately carries even an ALREADY-DANGLING
      // hand gateway through unchanged (it degrades to "reachable locally" at
      // runtime), so clearing it during application would silently overwrite a
      // hand-owned field AND make the persisted result diverge from the approved
      // preview, even though nothing was deleted after planning. Round 7's value
      // clear was unconditional here; the stamp clear below was already gated this
      // way, so this lifts the same ownership gate to cover the value — only a
      // gateway the sync wrote and that WENT stale after plan time is cleaned.
      const templateOwnsGateway =
        live.origin?.templated?.ipmiGatewayServerId === live.ipmiGatewayServerId ||
        live.formerlySynced?.templated?.ipmiGatewayServerId === live.ipmiGatewayServerId;
      if (!templateOwnsGateway) {
        continue;
      }
      captureServerPrior(upserted.id);
      // Clear the dangling value and, UNDER THE ROUND-5 EQUALITY GATE, its stamp
      // twin(s). Same mechanics `clearGatewayReferencesTo` uses (stamp === the
      // gateway value being cleared; the `formerlySynced` twin likewise; collapse
      // the bag via `templatedHasAnyStamp`), inlined here rather than shared
      // because that helper gates on membership in a DELETED set while this pass
      // gates on "no longer resolves in the FINAL set" — see round 5's
      // `clearGatewayReferencesTo` doc for why the equality gate (not a membership
      // test) is what preserves a user's real divergence.
      let cleared: ServerConfig = { ...live, ipmiGatewayServerId: undefined };
      if (
        live.origin?.templated?.ipmiGatewayServerId !== undefined &&
        live.origin.templated.ipmiGatewayServerId === live.ipmiGatewayServerId
      ) {
        const templated = { ...live.origin.templated };
        delete templated.ipmiGatewayServerId;
        cleared = {
          ...cleared,
          origin: { ...live.origin, templated: templatedHasAnyStamp(templated) ? templated : undefined }
        };
      }
      if (
        live.formerlySynced?.templated?.ipmiGatewayServerId !== undefined &&
        live.formerlySynced.templated.ipmiGatewayServerId === live.ipmiGatewayServerId
      ) {
        const templated = { ...live.formerlySynced.templated };
        delete templated.ipmiGatewayServerId;
        cleared = {
          ...cleared,
          formerlySynced: { ...live.formerlySynced, templated: templatedHasAnyStamp(templated) ? templated : undefined }
        };
      }
      this.servers.set(upserted.id, cleared);
      batchWrittenServers.set(upserted.id, cloneServerConfig(cleared));
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
    const otherSourcesProtectedPaths = new Set<string>();
    for (const [otherId, otherSource] of this.inventorySources) {
      if (otherId === apply.sourceId) {
        continue;
      }
      for (const managed of otherSource.managedFolders ?? []) {
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
    // `retainedGcCandidates` = gcOwnedCandidates − actuallyRemoved (minus
    // candidates whose folder no longer exists at all — see below). NO
    // carve-out for candidates EXACTLY present in another source's OWN
    // `managedFolders` — round-9 of this fix (see git history) tried
    // excluding those, on the theory that source X's own next sync would
    // independently re-diff the same path from X's OWN
    // `previousManagedFolders`, so THIS source didn't also need to remember
    // it. That reasoning had a hole: `removeInventorySource` deliberately
    // leaves folders alone and just deletes the ownership record (see its
    // doc) — if X is REMOVED rather than re-synced, X's "own next apply"
    // never happens, and a THIS-source candidate excluded from retention on
    // the strength of X's now-deleted claim is forgotten forever; no later
    // sync of any source can ever reclaim it again. Retaining unconditionally
    // (the plain round-9 rule, no carve-out) fixes that — see
    // nexusCoreInventory.test.ts's "(co-owner removed, reclaim survives)"
    // test, which pins exactly this scenario.
    //
    // CONSEQUENCE — two sources that both abandon a co-created path (neither
    // removed, both simply stop naming/occupying it on their own later
    // syncs) now each retain it and each defer on the other's still-retained
    // claim: source A's retained entry shows up in B's
    // `otherSourcesProtectedPaths` on B's next apply (deferring B's reclaim),
    // and B's retained entry likewise defers A's. This is a real,
    // symmetric-lingering limitation — the empty folder stays until either
    // side is REMOVED (lifting its claim entirely) or one side genuinely
    // reclaims the path by naming/occupying it again — but it is bounded and
    // safe: nothing is ever deleted while it lingers (worst case is a leftover
    // empty folder, never data loss), and the retained sets do not grow or
    // flap across repeated syncs — each source's own candidate list is stable
    // once both have abandoned (see nexusCoreInventory.test.ts's "(mutual
    // abandonment lingers, stably)" test, which traces this across multiple
    // syncs of each side). Protection arising from cross-source co-ownership
    // during ACTIVE use (one side still naming/occupying the path) is
    // unaffected by any of this — it was never gated on this exclusion in the
    // first place; see the "(REVIEW FINDING 2, P2 — cross-source ownership)"
    // and "(old-target co-ownership)" tests.
    //
    // A candidate whose folder no longer exists in `explicitGroups` at all
    // (removed through some path other than this GC — e.g. a user's manual
    // "Delete Folder" from the tree UI) is also dropped here rather than
    // retained: there is nothing left to ever reclaim, so bookkeeping a
    // ghost path forever would only grow the set without bound.
    const retainedGcCandidates = new Set(
      [...gcOwnedCandidates].filter((f) => !removedEmptyGroups.has(f) && this.explicitGroups.has(f))
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
      //
      // GROUP-REMAP (P2) — records this batch DELETED are not re-inserted
      // here; they are collected and re-inserted AFTER the folder-restore
      // pass below, because the folder chain their `group` points at has to
      // be judged against the tree as it stands once every other rollback
      // step has run. Nothing between here and there reads `this.servers`
      // (the folder-restore pass looks only at `explicitGroups`), and the
      // whole block is synchronous, so deferring is behavior-neutral for
      // every other participant.
      const pendingRemovedServerRestores: Array<[string, ServerConfig]> = [];
      for (const [id, priorServer] of priorServers) {
        const batchSnapshot = batchWrittenServers.get(id);
        const current = this.servers.get(id);
        if (batchSnapshot === undefined) {
          // This batch deleted the record. Restore it only if nothing has
          // recreated it since (current still absent) — a concurrent
          // recreation is left alone entirely. Presence is re-checked at the
          // deferred re-insert below, which is where the restore happens.
          if (priorServer) {
            pendingRemovedServerRestores.push([id, priorServer]);
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
      //
      // PARENT-CHAIN FIX — presence-of-the-exact-path alone isn't enough.
      // Lock-free tree commands (`_renameFolderPath` / `removeFolderCascade`)
      // are NOT serialized against this batch's pending persist (same window
      // FINDING 3/REVIEW FINDING 2 above already contend with for servers),
      // so the surrounding tree can be renamed or deleted out from under a
      // removed candidate while this save is in flight — e.g. the whole
      // "NetBox" branch renamed to "Lab" while this batch is mid-persist
      // after GC'ing the now-empty "NetBox/RackA". "NetBox/RackA" is still
      // ABSENT from `explicitGroups` at rollback time (it was never
      // recreated at that exact path — it just moved, along with its
      // parent), so the presence check alone would wrongly resurrect a
      // stale, now-orphaned path under a parent tree the user just renamed
      // away, and the compensating re-persist below would then write that
      // resurrection to disk — undoing the user's concurrent rename/delete.
      //
      // A GC candidate is always multi-segment (see
      // `pruneEmptyFoldersUnderTarget`'s doc — a target's own root and any
      // single-segment path are never candidates), so `parentPath` always
      // returns a defined immediate parent here. Restore only if that parent
      // is CURRENTLY in `explicitGroups` — i.e. this candidate's own chain
      // still exists to hang it back off. Process shallowest-first (fewest
      // path segments first) so a parent restored earlier in this SAME loop
      // (e.g. "NetBox/RackA" before "NetBox/RackA/Sub", both GC'd together)
      // is visible to its child's parent check via the ordinary
      // `explicitGroups.has` lookup — no separate "restoring in this pass"
      // bookkeeping needed, the loop's own insertion order provides it.
      //
      // RESIDUAL (documented, acceptable) — a concurrent rename that
      // happens to leave an IDENTICALLY-NAMED parent behind (coincidence,
      // not the same folder) is indistinguishable from "the chain still
      // exists" and this restore proceeds anyway. Bounded and rare; the
      // realistic, common case this guards is exactly the rename/delete
      // scenario above, where the parent is verifiably gone.
      const sortedRemovedEmptyGroups = [...removedEmptyGroups].sort(
        (a, b) => a.split("/").length - b.split("/").length
      );
      for (const group of sortedRemovedEmptyGroups) {
        if (this.explicitGroups.has(group)) {
          continue; // (a) someone re-created this exact path since — leave theirs.
        }
        const parent = parentPath(group);
        if (parent !== undefined && !this.explicitGroups.has(parent)) {
          continue; // (b) the chain this path hung off no longer exists — do not resurrect an orphan.
        }
        this.explicitGroups.add(group);
      }
      // GROUP-REMAP — the parent-chain guard above protects EXPLICIT folder
      // entries only, but the Connection Hub derives a folder from every
      // `server.group` prefix as well (see NexusTreeProvider.computeFolderCache:
      // explicit groups AND every item group contribute ancestors), so a
      // removed server restored with its old `group` resurrects that whole
      // path just as surely as re-adding the explicit entry would. The exact
      // hole: delete-prune removes the last server in the managed folder
      // "NetBox/RackA"; while the persist is pending the user renames
      // "NetBox" -> "Lab" (the rename cannot touch the removed server — it is
      // not in the map at that moment); the persist then fails and the
      // restore puts the server back with group "NetBox/RackA", re-deriving
      // the stale "NetBox" branch the folder-entry guard just refused to
      // re-add.
      //
      // The server itself must ALWAYS come back — dropping it would be data
      // loss, and this batch is supposed to have had NO effect. So the group
      // is REMAPPED instead: onto the deepest still-existing folder on its
      // own chain, or to the root when none of it survived.
      //
      // `survivingFolderPaths` is the folder tree as it stands at this exact
      // point of the rollback (ancestor-closed, exactly how the tree derives
      // it): explicit groups AFTER the guarded restore pass above (so a
      // folder that pass legitimately put back counts as surviving), plus
      // every ancestor chain of the groups of the records currently in the
      // maps — servers as the server-rollback loop above left them, and
      // serial / local-shell profiles, which this batch never touches but
      // which keep a folder just as alive as a server does (same three
      // record types pruneEmptyFoldersUnderTarget counts as occupants).
      //
      // ORDER — the removed servers themselves are NOT in that initial set
      // (this batch deleted them and they have not been re-inserted yet), and
      // that is the deliberate choice: a removed server may never vouch for
      // another removed server's chain, otherwise two servers pruned out of
      // the same concurrently-renamed folder would each certify the other's
      // stale path and the guard would evaporate exactly when it is needed.
      // What a restored server DOES contribute is its FINAL group — the
      // original one when it was judged sound, the remapped one otherwise —
      // so restores are processed shallowest-group-first (ties broken by id,
      // for a fully deterministic outcome): a parent-level server restored
      // into a surviving chain then legitimately extends the tree for its
      // deeper siblings, while a stale chain never enters the set at all.
      //
      // LEAF EXEMPTION — only the STRICT ancestors of a group have to
      // survive; the deepest segment itself may be absent. That mirrors the
      // folder pass above (a child is restorable into a surviving parent) and
      // is what keeps the ordinary case unchanged: the removed server was
      // usually the last occupant of its own folder, so its leaf path is
      // gone precisely BECAUSE of this batch — restoring the server merely
      // re-derives its own folder. A root-level (single-segment) group has no
      // ancestors to judge at all and is likewise always restored as-is —
      // same rule the folder pass applies to a `parentPath` of undefined.
      //
      // RESIDUAL (documented, inherited from the folder pass) — a concurrent
      // rename of the LEAF segment alone, or one that happens to leave an
      // identically-named ancestor behind, is indistinguishable here from
      // "the chain still exists" and the restore proceeds unchanged. The
      // realistic case this guards is an ancestor that is verifiably gone.
      const survivingFolderPaths = new Set<string>();
      const addSurvivingFolderChain = (group: string | undefined): void => {
        if (!group) {
          return;
        }
        for (const ancestor of getAncestorPaths(group)) {
          survivingFolderPaths.add(ancestor);
        }
      };
      for (const group of this.explicitGroups) {
        addSurvivingFolderChain(group);
      }
      for (const server of this.servers.values()) {
        addSurvivingFolderChain(server.group);
      }
      for (const profile of this.serialProfiles.values()) {
        addSurvivingFolderChain(profile.group);
      }
      for (const profile of this.localShellProfiles.values()) {
        addSurvivingFolderChain(profile.group);
      }
      const orderedRemovedServerRestores = [...pendingRemovedServerRestores].sort(
        ([idA, serverA], [idB, serverB]) => {
          const depthA = serverA.group ? serverA.group.split("/").length : 0;
          const depthB = serverB.group ? serverB.group.split("/").length : 0;
          return depthA !== depthB ? depthA - depthB : idA.localeCompare(idB);
        }
      );
      // LIVE STATUS (Phase 2) — restore a pruned server's runtime status
      // entry when (and only when) the server itself is restored below, so the
      // rollback leaves status and server consistent. A server left deleted (a
      // concurrent recreation) keeps its status dropped.
      const restoreDroppedStatus = (id: string): void => {
        const dropped = droppedServerStatus.get(id);
        if (dropped) {
          this.serverStatus.set(id, dropped.state);
          if (dropped.source !== undefined) {
            this.serverStatusSource.set(id, dropped.source);
          }
        }
      };
      for (const [id, priorServer] of orderedRemovedServerRestores) {
        if (this.servers.get(id) !== undefined) {
          continue; // something concurrent recreated this record — leave theirs.
        }
        const group = priorServer.group;
        const parent = group === undefined ? undefined : parentPath(group);
        if (group === undefined || parent === undefined || survivingFolderPaths.has(parent)) {
          // Sound chain (or nothing to judge): restore the captured pre-batch
          // record itself, byte-for-byte, exactly as before this fix.
          this.servers.set(id, priorServer);
          restoreDroppedStatus(id);
          addSurvivingFolderChain(group);
          continue;
        }
        // The chain is stale: walk up to the deepest ancestor that still
        // exists (the set is ancestor-closed, so the first hit going up is
        // the longest surviving prefix); `undefined` — the codebase's
        // representation of "no folder", see _renameFolderPath's own
        // root-remap — when none of it survived.
        const ancestors = getAncestorPaths(group);
        let remappedGroup: string | undefined;
        for (let i = ancestors.length - 2; i >= 0; i--) {
          if (survivingFolderPaths.has(ancestors[i])) {
            remappedGroup = ancestors[i];
            break;
          }
        }
        // Mutate a DETACHED clone only: `priorServer` is the pre-batch record
        // captured by reference, and other rollback branches (and any
        // concurrent holder) must never see a group this pass invented.
        const restored = cloneServerConfig(priorServer);
        restored.group = remappedGroup;
        this.servers.set(id, restored);
        restoreDroppedStatus(id);
        addSurvivingFolderChain(remappedGroup);
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
    // #84 P2 (Codex) — a sync apply mutated+persisted this source's servers.
    // Advance its mutation epoch so a status report captured before this apply,
    // resolving after it, is dropped by the heal's in-lock epoch re-check — even
    // when the config revision is unchanged (a routine sync bumps lastSyncAt /
    // managedFolders, not the revision).
    this.bumpSourceMutationEpoch(apply.sourceId);
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

  /**
   * DEPENDENT-LINK SWEEP (issue #48 PR-C, PR #65 Codex rounds 9-10) — shared
   * primitive behind EVERY server-deletion path. For each SURVIVING server whose
   * `ipmiGatewayServerId` names a server in `deletedServerIds`, clear that link
   * in place so a deletion never leaves a dangling gateway reference behind.
   *
   * Mirrors `removeAuthProfile`'s dependent-link sweep for the sibling
   * server->server reference: same in-memory-first update, same shallow
   * `{ ...server, ipmiGatewayServerId: undefined }` clear (ServerConfig carries
   * no `revision`, so — like the auth sweep's server clear — none is
   * regenerated). This method ONLY mutates `this.servers`; it does NOT persist
   * or emit — every caller folds the swept survivors into its OWN existing
   * single saveServers persist and one-shot emit (so there is never a second
   * write or a second emit), and rollback-bearing callers
   * (applyInventorySyncPlan) capture the returned ids into their transactional
   * bookkeeping. The servers named by `deletedServerIds` are expected to already
   * be gone from `this.servers` at call time, so they are never self-swept.
   *
   * ASYMMETRY WITH `proxy.jumpHostId`, the other server->server reference: the
   * deletion paths intentionally do NOT sweep jumpHostId. A dangling jump host
   * is tolerated and surfaced at connect time (proxySshFactory throws "Jump host
   * server not found"), whereas a dangling gateway is otherwise SILENT —
   * `resolveIpmiGatewayServer` degrades it to "no gateway / run locally" with
   * only a fall-back note, never an error — which is why Codex calls for it to be
   * swept while jumpHostId is left as-is.
   *
   * @returns the ids of the survivors whose gateway link was cleared.
   */
  private clearGatewayReferencesTo(deletedServerIds: Set<string>): string[] {
    const cleared: string[] = [];
    if (deletedServerIds.size === 0) {
      return cleared;
    }
    for (const [id, server] of this.servers.entries()) {
      if (server.ipmiGatewayServerId !== undefined && deletedServerIds.has(server.ipmiGatewayServerId)) {
        let next: ServerConfig = { ...server, ipmiGatewayServerId: undefined };
        // GATEWAY VALUE STAMP (issue #48 PR-T3, `origin.templated.ipmiGatewayServerId`)
        // — the sync's receipt that IT wrote the BMC gateway link, cleared with
        // the link for the reason the auth stamp is cleared in `removeAuthProfile`:
        // a stamp outliving its value reads as a per-server opt-out and
        // `matrixWrites` locks the field out of even a later override template.
        // Scoping falls out for free — the helper is only entered for a server
        // whose gateway VALUE names a deleted server, so a server whose gateway
        // the user already hand-cleared is never reached and its stamp (opt-out)
        // survives, consistent with FIX A. Cleared only when the stamp equals the
        // CURRENT gateway value being cleared (`stamp === server.ipmiGatewayServerId`),
        // i.e. the sync still OWNS the link (cur === stamp) — NOT merely when the
        // stamp names some deleted server. This is what the single-record deletion
        // and the auth-profile paths require, and it matters in a BATCH deletion
        // (folder cascade / inventory prune): a referrer template-stamped with
        // gateway A whose user later hand-changed the value to B, when BOTH A and B
        // are deleted in one batch, would — under a membership test — lose its
        // divergence stamp A along with the value, so the next sync would read it as
        // never-configured and template-write a new gateway over the user's edit.
        // The equality gate preserves the diverged stamp (cur B ≠ stamp A) exactly
        // as row 6 intends. Same single-member mechanics as `removeAuthProfile`
        // (mirror of `dropTemplateProxy` / `clearTemplatedStamps`): rebuild the
        // bag without the member, collapse to `undefined` when nothing else is
        // stamped.
        //
        // STAMP ONLY — NO device-template `fields.ipmiGatewayServerId` sweep here,
        // intentionally: a template->server reference is the design's
        // skip-and-warn-at-sync-time class (servers churn constantly via sync
        // prune; eagerly rewriting user templates on every server deletion would
        // be wrong). This is the SAME rationale as the `jumpHostId`-vs-gateway
        // value asymmetry documented in this method's doc comment — skip-and-warn
        // owns the template field.
        if (
          server.origin?.templated?.ipmiGatewayServerId !== undefined &&
          server.origin.templated.ipmiGatewayServerId === server.ipmiGatewayServerId
        ) {
          const templated = { ...server.origin.templated };
          delete templated.ipmiGatewayServerId;
          next = {
            ...next,
            origin: { ...server.origin, templated: templatedHasAnyStamp(templated) ? templated : undefined }
          };
        }
        // The detached twin, swept the same way and for the same adoption reason
        // as the auth stamp's `formerlySynced` clear — and under the same equality
        // gate (stamp === the current gateway value being cleared), so a user's
        // divergence on a detached record survives a batch deletion too.
        if (
          server.formerlySynced?.templated?.ipmiGatewayServerId !== undefined &&
          server.formerlySynced.templated.ipmiGatewayServerId === server.ipmiGatewayServerId
        ) {
          const templated = { ...server.formerlySynced.templated };
          delete templated.ipmiGatewayServerId;
          next = {
            ...next,
            formerlySynced: { ...server.formerlySynced, templated: templatedHasAnyStamp(templated) ? templated : undefined }
          };
        }
        this.servers.set(id, next);
        cleared.push(id);
      }
    }
    return cleared;
  }

  public async removeServer(serverId: string): Promise<void> {
    this.servers.delete(serverId);
    // LIVE STATUS (Phase 2) — drop any runtime status keyed to the deleted server.
    this.dropServerStatusEntry(serverId);
    // DEPENDENT-LINK SWEEP (issue #48 PR-C, PR #65 Codex round 9, extracted to
    // the shared `clearGatewayReferencesTo` helper in round 10) — clear every
    // OTHER server's `ipmiGatewayServerId` that named the server just deleted,
    // folded into the SINGLE saveServers persist below and the one-shot emit.
    this.clearGatewayReferencesTo(new Set([serverId]));
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

  public async addOrUpdateLocalServerConfig(config: LocalServerConfig): Promise<void> {
    this.localServers.set(config.id, cloneLocalServerConfig(config));
    await this.repository.saveLocalServers([...this.localServers.values()]);
    this.emitChanged();
  }

  public async addOrUpdateTftpProfile(profile: TftpConfigProfile): Promise<void> {
    this.tftpProfiles.set(profile.id, cloneTftpProfile(profile));
    await this.repository.saveTftpProfiles([...this.tftpProfiles.values()]);
    this.emitChanged();
  }

  public async addOrUpdateDhcpProfile(profile: DhcpConfigProfile): Promise<void> {
    this.dhcpProfiles.set(profile.id, cloneDhcpProfile(profile));
    await this.repository.saveDhcpProfiles([...this.dhcpProfiles.values()]);
    this.emitChanged();
  }

  // No session teardown counterpart to removeLocalServerConfig: a profile owns
  // no runtime state, so removing one never touches a live service.
  public async removeTftpProfile(profileId: string): Promise<void> {
    this.tftpProfiles.delete(profileId);
    await this.repository.saveTftpProfiles([...this.tftpProfiles.values()]);
    this.emitChanged();
  }

  public async removeDhcpProfile(profileId: string): Promise<void> {
    this.dhcpProfiles.delete(profileId);
    await this.repository.saveDhcpProfiles([...this.dhcpProfiles.values()]);
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

  public async removeLocalServerConfig(configId: string): Promise<void> {
    this.localServers.delete(configId);
    this.removeLocalServerConfigSessions(configId);
    await this.repository.saveLocalServers([...this.localServers.values()]);
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

  /**
   * #84 P2 (Codex) — the current MUTATION EPOCH for a source (0 if never
   * mutated). The refresh path captures this before its status fetch and the
   * heal re-checks it inside its lock; if it advanced during the fetch, a
   * server-mutating operation for this source (a sync apply, or a prior heal)
   * completed while the fetch was outstanding, so the report may be stale and the
   * heal bails. See `sourceMutationEpoch`.
   */
  public getSourceMutationEpoch(sourceId: string): number {
    return this.sourceMutationEpoch.get(sourceId) ?? 0;
  }

  /** #84 P2 (Codex) — advance a source's mutation epoch after a persisted server write. */
  private bumpSourceMutationEpoch(sourceId: string): void {
    this.sourceMutationEpoch.set(sourceId, this.getSourceMutationEpoch(sourceId) + 1);
  }

  /**
   * LIVE STATUS (Phase 2) — apply one source's fetchStatus report onto the
   * runtime serverStatus map. Each report entry is resolved to a server by its
   * REAL origin identity — a server owned by this source (origin.sourceId ===
   * sourceId) whose origin.externalId matches — which covers both a normal
   * deterministic-id server and an ADOPTED one whose id was preserved (#82).
   * Entries this source previously wrote but no longer reports —
   * pruned nodes, removed servers — are dropped; entries owned by OTHER sources
   * are untouched. One emitChanged() on the way out, like registerSession.
   */
  public applyInventoryStatus(sourceId: string, report: InventoryStatusReport): void {
    // TRUNCATION — a COMPLETE report is authoritative: clear this source's prior
    // entries first, then rebuild, so a node the source stops reporting (a
    // stopped node is still present as "stopped", so absent == removed) drops
    // out. A TRUNCATED report is PARTIAL — nodes beyond the provider's cap are
    // merely absent, not gone — so we MERGE instead: skip the clear and retain
    // the prior status of any entry not in this report, applying only what is
    // present (present entries overwrite below, keeping serverStatusSource ===
    // sourceId consistently for both retained and freshly-applied entries).
    if (!report.truncated) {
      for (const [serverId, owner] of [...this.serverStatusSource]) {
        if (owner === sourceId) {
          this.serverStatus.delete(serverId);
          this.serverStatusSource.delete(serverId);
        }
      }
    }
    // Resolve report entries by the server's REAL origin identity, not by
    // assuming `id === deterministicServerId(sourceId, externalId)`. Adoption
    // (Keep Servers → re-add → Adopt Existing, #82) PRESERVES an adoptee's
    // original id while stamping the NEW source into `origin`, so a deterministic
    // lookup would miss every adopted node. Building the map from servers owned
    // by this source (origin.sourceId === sourceId), keyed by origin.externalId,
    // covers BOTH the deterministic (non-adopted) and the preserved-id (adopted)
    // cases, and inherently keeps the source-ownership scoping.
    const serverIdByExternalId = new Map<string, string>();
    for (const server of this.servers.values()) {
      if (server.origin?.sourceId === sourceId) {
        serverIdByExternalId.set(server.origin.externalId, server.id);
      }
    }
    for (const [externalId, deviceStatus] of Object.entries(report.statuses)) {
      const serverId = serverIdByExternalId.get(externalId);
      if (serverId !== undefined) {
        this.serverStatus.set(serverId, deviceStatus.state);
        this.serverStatusSource.set(serverId, sourceId);
      }
    }
    this.emitChanged();
  }

  /**
   * PRIMARY HOST/PORT (task #29, the deferred D8) — heal a source's TELNET
   * console addresses from its `fetchStatus` report. A provider (EVE-NG
   * Community) that reassigns console ports on node restart surfaces the current
   * `consoleHost`/`consolePort` on each RUNNING node; this persists them onto the
   * owned server so the NEXT connect targets the live port instead of the stale
   * one. `applyInventoryStatus` stays PURE (runtime maps only) — this is the
   * SEPARATE, persisting step the refresh path runs right after it.
   *
   * Heals ONLY where every one of these holds, and the gate is deliberately
   * strict because it WRITES persisted config:
   *  - the node is `state: "running"` and the report carries a fresh
   *    `consoleHost`/`consolePort` (a stopped node reports none);
   *  - the owned server resolves via the SAME origin identity
   *    `applyInventoryStatus` uses (`origin.sourceId === sourceId`, keyed by
   *    `origin.externalId`) — covers adopted, preserved-id servers too;
   *  - the server is TELNET and NOT addressless (an ssh node or a placeholder is
   *    never a console-port node to heal);
   *  - the reported host/port DIFFER from the persisted ones (nothing to do
   *    otherwise); AND
   *  - the sync OWNS them — `syncOwnsHost`/`syncOwnsPort` against
   *    `origin.syncedHost`/`syncedPort`, the sync engine's OWN predicates, so a
   *    HAND-EDITED port is NEVER healed (the whole reason this is gated and not a
   *    blanket overwrite). When a value is healed its stamp is advanced with it,
   *    exactly as the sync's own write would.
   *
   * Respects the truncated-merge: only entries PRESENT in the report are
   * considered, so a partial report never touches the nodes it did not reach.
   * Batches every heal into one persisted write and one `emitChanged`, via
   * `addServersBatch`, to avoid an emit storm across a lab's worth of nodes. An
   * already-open telnet terminal keeps its port — the heal affects the NEXT
   * connect, which is the only place a reassigned port matters.
   */
  public async healSyncedConsolePorts(sourceId: string, report: InventoryStatusReport): Promise<void> {
    // The SAME origin lookup applyInventoryStatus builds (owned-by-this-source,
    // keyed by externalId) — reused rather than duplicated so the two can never
    // resolve a report entry to different servers.
    const serverIdByExternalId = new Map<string, string>();
    for (const server of this.servers.values()) {
      if (server.origin?.sourceId === sourceId) {
        serverIdByExternalId.set(server.origin.externalId, server.id);
      }
    }
    const healed: ServerConfig[] = [];
    for (const [externalId, deviceStatus] of Object.entries(report.statuses)) {
      if (deviceStatus.state !== "running") {
        continue;
      }
      const reportedHost = deviceStatus.consoleHost;
      const reportedPort = deviceStatus.consolePort;
      if (reportedHost === undefined && reportedPort === undefined) {
        continue;
      }
      const serverId = serverIdByExternalId.get(externalId);
      if (serverId === undefined) {
        continue;
      }
      const server = this.servers.get(serverId);
      if (server === undefined || server.origin === undefined) {
        continue;
      }
      if (resolveServerProtocol(server) !== "telnet" || server.addressless === true) {
        continue;
      }
      // Each half heals only when the reported value DIFFERS from the persisted
      // one AND the sync owns it — a hand-edited host/port fails `syncOwns*` and
      // is left exactly as the user set it.
      const healHost =
        reportedHost !== undefined &&
        reportedHost !== server.host &&
        syncOwnsHost(server.host, server.origin.syncedHost, reportedHost);
      const healPort =
        reportedPort !== undefined &&
        reportedPort !== server.port &&
        syncOwnsPort(server.port, server.origin.syncedPort, reportedPort);
      if (!healHost && !healPort) {
        continue;
      }
      const next = cloneServerConfig(server);
      if (healHost && reportedHost !== undefined && next.origin !== undefined) {
        next.host = reportedHost;
        next.origin.syncedHost = reportedHost;
      }
      if (healPort && reportedPort !== undefined && next.origin !== undefined) {
        next.port = reportedPort;
        next.origin.syncedPort = reportedPort;
      }
      // P2-1 (review) — WRITE-SITE DEFENSE. Never persist a record the next reload
      // would reject: a bad host/port that slipped past the report validator (a
      // provider calling this in-process without validateInventoryStatusReport)
      // would otherwise be dropped whole on reload, taking its credentials/tunnels
      // with it. Validating the RESULT — not just the reported field — means the
      // heal structurally cannot write what the sync path never would.
      if (!validateServerConfig(next)) {
        continue;
      }
      healed.push(next);
    }
    if (healed.length === 0) {
      return;
    }
    // addServersBatch is the existing one-save/one-emit batch primitive.
    await this.addServersBatch(healed);
    // #84 P2 (Codex) — a heal mutated+persisted this source's servers; advance
    // the epoch so a concurrent refresh whose fetch straddled this heal re-checks
    // and bails rather than persisting its own (now potentially stale) report.
    this.bumpSourceMutationEpoch(sourceId);
  }

  /**
   * LIVE STATUS (Phase 2) — drop every status entry a source owns, WITHOUT
   * emitting. Returns whether anything changed. Shared by clearInventoryStatus
   * (which emits) and removeInventorySource (which emits once on its own way
   * out), so the two never drift on the clearing rule.
   */
  /**
   * LIVE STATUS (Phase 2) — drop a single server's runtime status entry, WITHOUT
   * emitting. Called from every path that removes a server (manual delete, sync
   * prune) so a gone server never strands a running/stopped highlight; the
   * calling path's own emit covers the change.
   */
  private dropServerStatusEntry(serverId: string): void {
    this.serverStatus.delete(serverId);
    this.serverStatusSource.delete(serverId);
  }

  private dropInventoryStatusForSource(sourceId: string): boolean {
    let changed = false;
    for (const [serverId, owner] of [...this.serverStatusSource]) {
      if (owner === sourceId) {
        this.serverStatus.delete(serverId);
        this.serverStatusSource.delete(serverId);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * LIVE STATUS (Phase 2) — drop every status entry a source owns (used on
   * source removal). Silent when there was nothing to clear, so an unrelated
   * source removal does not churn every tree.
   */
  public clearInventoryStatus(sourceId: string): void {
    if (this.dropInventoryStatusForSource(sourceId)) {
      this.emitChanged();
    }
  }

  public registerSerialSession(session: ActiveSerialSession): void {
    this.activeSerialSessions.set(session.id, session);
    this.emitChanged();
  }

  public registerLocalShellSession(session: ActiveLocalShellSession): void {
    this.activeLocalShellSessions.set(session.id, session);
    this.emitChanged();
  }

  public registerLocalServerSession(session: ActiveLocalServerSession): void {
    this.activeLocalServerSessions.set(session.id, session);
    this.emitChanged();
  }

  /**
   * Returns the active SSH, serial, Local Shell, or Local Server session with the given id.
   * Callers use this to resolve the {@link SessionPtyHandle} for output observation / input locking.
   */
  public getActiveSessionById(sessionId: string): ActiveSession | ActiveSerialSession | ActiveLocalShellSession | ActiveLocalServerSession | undefined {
    return (
      this.activeSessions.get(sessionId) ??
      this.activeSerialSessions.get(sessionId) ??
      this.activeLocalShellSessions.get(sessionId) ??
      this.activeLocalServerSessions.get(sessionId)
    );
  }

  public updateLocalServerSessionStatus(sessionId: string, status: LocalServerStatus): void {
    const existing = this.activeLocalServerSessions.get(sessionId);
    if (!existing) return;
    this.activeLocalServerSessions.set(sessionId, { ...existing, status });
    this.emitChanged();
  }

  public setLocalServerLastExitCode(sessionId: string, exitCode: number | null): void {
    const existing = this.activeLocalServerSessions.get(sessionId);
    if (!existing) return;
    this.activeLocalServerSessions.set(sessionId, { ...existing, lastExitCode: exitCode });
    this.emitChanged();
  }

  public incrementLocalServerRestartAttempts(sessionId: string): number {
    const existing = this.activeLocalServerSessions.get(sessionId);
    if (!existing) return 0;
    const next = existing.restartAttempts + 1;
    this.activeLocalServerSessions.set(sessionId, { ...existing, restartAttempts: next });
    this.emitChanged();
    return next;
  }

  public resetLocalServerRestartAttempts(sessionId: string): void {
    const existing = this.activeLocalServerSessions.get(sessionId);
    if (!existing) return;
    if (existing.restartAttempts === 0) return;
    this.activeLocalServerSessions.set(sessionId, { ...existing, restartAttempts: 0 });
    this.emitChanged();
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

  // ---------------------------------------------------------------------------
  // Embedded network servers (TFTP / DHCP) — runtime state only.
  //
  // There is deliberately NO config half here (no addOrUpdate/remove/rename):
  // these are two fixed singleton services whose settings live in VS Code's own
  // configuration store, so there is nothing for ConfigRepository to persist.
  // ---------------------------------------------------------------------------

  /**
   * Registers (or replaces) the runtime record for a network service.
   * Keyed by kind, so starting `tftp` twice updates one record rather than
   * accumulating sessions.
   */
  public registerNetworkServerSession(session: ActiveNetworkServerSession): void {
    this.activeNetworkServerSessions.set(session.kind, session);
    this.emitChanged();
  }

  public getNetworkServerSession(kind: NetworkServerKind): ActiveNetworkServerSession | undefined {
    return this.activeNetworkServerSessions.get(kind);
  }

  /**
   * Applies a lifecycle transition reported by the daemon.
   *
   * `boundPort` is threaded through here rather than inferred because the
   * adapters fall back to unprivileged ports (69 → 1069, 67 → 1067) when they
   * cannot bind the IANA port — the configured port is frequently NOT the port
   * that ended up serving traffic, and the UI must show the real one.
   *
   * Stamps `startedAt` on the first transition into `running`, and clears the
   * stale `errorMessage` on any non-error transition so a recovered service
   * does not keep rendering a previous failure.
   */
  public updateNetworkServerSessionStatus(
    kind: NetworkServerKind,
    status: NetworkServerStatus,
    options?: { boundPort?: number | null; errorMessage?: string }
  ): void {
    const existing = this.activeNetworkServerSessions.get(kind);
    const base: ActiveNetworkServerSession = existing ?? { kind, status, boundPort: null };
    const next: ActiveNetworkServerSession = {
      ...base,
      status,
      boundPort: options?.boundPort !== undefined ? options.boundPort : base.boundPort,
      errorMessage: status === "error" ? (options?.errorMessage ?? base.errorMessage) : undefined,
      startedAt: status === "running" ? (base.status === "running" ? base.startedAt : Date.now()) : base.startedAt
    };
    this.activeNetworkServerSessions.set(kind, next);
    this.emitChanged();
  }

  /**
   * Replaces the live detail (transfers / leases / counters) for a service.
   *
   * Called on every `runtimeUpdate` push, so it must stay cheap: it swaps the
   * detail object wholesale instead of merging field by field.
   */
  public setNetworkServerRuntimeSnapshot(
    kind: NetworkServerKind,
    detail: NetworkServerRuntimeDetail,
    boundPort?: number | null
  ): void {
    const existing = this.activeNetworkServerSessions.get(kind);
    if (!existing) return;
    this.activeNetworkServerSessions.set(kind, {
      ...existing,
      detail,
      boundPort: boundPort !== undefined ? boundPort : existing.boundPort
    });
    this.emitChanged();
  }

  /**
   * Replaces the completed-transfer history for a service.
   *
   * Separate from {@link setNetworkServerRuntimeSnapshot} because the two have
   * different owners and different lifetimes: the runtime detail is whatever
   * the daemon reports right now, while the history is accumulated host-side by
   * `NetworkServerManager` across the whole run. The manager owns the list and
   * pushes the current value; this method only mirrors it into the snapshot so
   * the tree can render it, and no-ops when the service is not registered.
   *
   * Transient by construction — nothing here reaches `ConfigRepository`.
   *
   * @param kind Which service the history belongs to (TFTP today).
   * @param entries Newest-first history, already capped by the manager.
   */
  public setNetworkServerTransferHistory(
    kind: NetworkServerKind,
    entries: readonly NetworkServerTransferHistoryEntry[]
  ): void {
    const existing = this.activeNetworkServerSessions.get(kind);
    if (!existing) return;
    this.activeNetworkServerSessions.set(kind, { ...existing, transferHistory: entries });
    this.emitChanged();
  }

  public unregisterNetworkServerSession(kind: NetworkServerKind): void {
    if (!this.activeNetworkServerSessions.delete(kind)) return;
    this.emitChanged();
  }

  public unregisterLocalServerSession(sessionId: string): void {
    if (this.focusedSessionId === sessionId) {
      this.focusedSessionId = undefined;
    }
    this.activeLocalServerSessions.delete(sessionId);
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
    // DEPENDENT-LINK SWEEP (issue #48 PR-C, PR #65 Codex round 10) — a gateway
    // server deleted along with its folder leaves surviving servers OUTSIDE the
    // folder with a dangling `ipmiGatewayServerId` that silently degrades gateway
    // routing to local. Collect the ids this cascade deletes and sweep them with
    // the shared helper before the single saveServers persist below, folded into
    // that same one persist and one emit (no second write, no second emit). Only
    // the `deleteContents` branch removes servers; the reparent branch only
    // rewrites `.group`, so nothing is deleted and nothing to sweep there.
    const cascadeDeletedServerIds = new Set<string>();
    if (deleteContents) {
      for (const [id, server] of this.servers.entries()) {
        if (server.group && isDescendantOrSelf(server.group, path)) {
          this.servers.delete(id);
          this.removeServerSessions(id);
          cascadeDeletedServerIds.add(id);
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
      for (const [id, config] of this.localServers.entries()) {
        if (config.group && isDescendantOrSelf(config.group, path)) {
          this.localServers.delete(id);
          this.removeLocalServerConfigSessions(id);
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
      for (const config of this.localServers.values()) {
        if (config.group && isDescendantOrSelf(config.group, path)) {
          const suffix = config.group.slice(path.length);
          config.group = parent ? parent + suffix : suffix.slice(1) || undefined;
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
    // Sweep dangling gateway refs left by the cascade's server deletions (see the
    // note at the top of this method), folded into the persist just below.
    this.clearGatewayReferencesTo(cascadeDeletedServerIds);
    await Promise.all([
      this.repository.saveServers([...this.servers.values()]),
      this.repository.saveSerialProfiles([...this.serialProfiles.values()]),
      this.repository.saveLocalShellProfiles([...this.localShellProfiles.values()]),
      this.repository.saveLocalServers([...this.localServers.values()]),
      this.repository.saveGroups([...this.explicitGroups])
    ]);
    this.emitChanged();
  }

  public getItemsInFolder(path: string, recursive: boolean): { servers: ServerConfig[]; serialProfiles: SerialProfile[]; localShellProfiles: LocalShellProfile[]; localServers: LocalServerConfig[] } {
    const servers: ServerConfig[] = [];
    const profiles: SerialProfile[] = [];
    const localShellProfiles: LocalShellProfile[] = [];
    const localServers: LocalServerConfig[] = [];
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
    for (const config of this.localServers.values()) {
      if (!config.group) {
        continue;
      }
      if (recursive ? isDescendantOrSelf(config.group, path) : config.group === path) {
        localServers.push(config);
      }
    }
    return { servers, serialProfiles: profiles, localShellProfiles, localServers };
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
    for (const config of this.localServers.values()) {
      if (config.group && isDescendantOrSelf(config.group, oldPath)) {
        config.group = newPath + config.group.slice(oldPath.length);
      }
    }

    await Promise.all([
      this.repository.saveServers([...this.servers.values()]),
      this.repository.saveSerialProfiles([...this.serialProfiles.values()]),
      this.repository.saveLocalShellProfiles([...this.localShellProfiles.values()]),
      this.repository.saveLocalServers([...this.localServers.values()]),
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
    return (
      this.activeSessions.has(sessionId) ||
      this.activeSerialSessions.has(sessionId) ||
      this.activeLocalShellSessions.has(sessionId) ||
      this.activeLocalServerSessions.has(sessionId)
    );
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

  private removeLocalServerConfigSessions(configId: string): void {
    for (const [sessionId, session] of this.activeLocalServerSessions.entries()) {
      if (session.configId === configId) {
        if (this.focusedSessionId === sessionId) {
          this.focusedSessionId = undefined;
        }
        this.activeLocalServerSessions.delete(sessionId);
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
