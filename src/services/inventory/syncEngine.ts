import type { AuthProfile, ServerConfig, ServerOrigin } from "../../models/config";
import { authProfileNeedsServerKeyPath, serverOriginStampsEqual } from "../../models/config";
import type { InventoryDevice, InventorySourceConfig, InventoryTree } from "../../models/inventory";
import type { InventorySyncApplication } from "../../core/nexusCore";
import { normalizeFolderPath } from "../../utils/folderPaths";
import { deterministicServerId } from "./deterministicId";

export const ORPHAN_FOLDER_NAME = "_orphaned";

export interface ComputeSyncPlanInput {
  source: InventorySourceConfig;
  tree: InventoryTree;
  currentServers: ServerConfig[]; // ALL servers; engine filters by origin itself
  now: number;
  /**
   * The auth profile `source.authProfileId` resolves to, already looked up by
   * the caller — undefined when the source has none, or when the id no longer
   * names a live profile. Resolution lives in the caller for the same reason
   * `now` does: this function is pure and has no core access. The engine still
   * cross-checks the id (see AUTH 1) rather than trusting the pair blindly.
   *
   * REVIEW FINDING (P1) — the WHOLE profile, not the `{ id, name }` pair this
   * used to be. AUTH 1b below has to ask whether the profile can actually be
   * used by a server that carries no key path of its own, and a caller-computed
   * flag would put a precondition the engine depends on outside the engine,
   * where the next call site can forget it — which is exactly how the keyless
   * key profile reached the stamp in the first place. Widening the input does
   * not widen what the engine WRITES: the add/update paths stamp the link and
   * nothing else, which the "link, never copy" assertions pin field by field.
   */
  authProfile?: AuthProfile;
  /**
   * ADOPT 1 — the user's answer to the adoption question, and THREE states
   * rather than two. See `InventoryAdoptionChoice` for what each one means and
   * for why "was asked and said no" must not be spelled the same way as "was
   * never asked" (REVIEW FINDING — the moved-address and ambiguity warnings
   * were keyed on the old boolean, so the two cases the CHANGELOG promises an
   * explanation for were exactly the two that got silence).
   *
   * Undefined — nobody asked — is today's behavior field for field on the PLAN:
   * every host:port collision renders the existing duplicate warning and
   * increments `manualDuplicateCount`, and no record changes ownership. It is
   * NOT bit-for-bit on `warnings`, deliberately: a marker that matched and could
   * not be acted on is reported in that state (see the warnings at the end of
   * the adoption block).
   *
   * The engine NEVER decides this for itself. Adoption hands an existing
   * record's whole lifecycle — its name, address, folder, and the source's
   * prune policy, `delete` included — to the source, which is a decision only
   * the user can make. The caller asks once per sync run and feeds the answer to
   * every recompute; that is also why `adoptionCandidateNames` is computed
   * regardless of this answer, since the plan the caller asks FROM is one
   * computed before there is an answer at all.
   */
  adoptionChoice?: InventoryAdoptionChoice;
}

/**
 * ADOPT 1 — what the user answered when asked whether this source may reclaim
 * the servers a previous source of the same provider synced and they kept.
 *
 *  - `"adopt"` — reclaim them: a planned add whose device matches EXACTLY ONE
 *    eligible kept server becomes an UPDATE of that server instead of a second
 *    server beside it. See the eligibility rule in the device loop;
 *    `ServerConfig.formerlySynced` (models/config.ts) is the marker it reads.
 *  - `"decline"` — the user was asked and chose to add the devices separately.
 *  - `undefined` — the question was never put. Not a synonym for `"decline"`:
 *    the caller only asks when the plan reports at least one CANDIDATE (a
 *    device matching exactly one eligible kept server), so a run whose only
 *    marker matches are ambiguous or re-addressed never raises the question at
 *    all, and those are precisely the matches whose refusal has to explain
 *    itself. `"decline"` therefore suppresses that explanation and `undefined`
 *    does not — the user who has just answered the question does not need to be
 *    told what they answered it about, and the user who was never asked has no
 *    other way to find out why they got a duplicate.
 */
export type InventoryAdoptionChoice = "adopt" | "decline";

export interface InventorySyncPlan {
  sourceId: string;
  syncedAt: number;
  adds: ServerConfig[]; // deterministic ids, authType "agent", origin set, source's auth profile linked when it resolves
  updates: Array<{ before: ServerConfig; after: ServerConfig }>; // full replacement objects
  prunes: Array<
    | { policy: "delete"; server: ServerConfig }
    | { policy: "orphan"; server: ServerConfig; after: ServerConfig } // moved to <targetFolder>/_orphaned
    | { policy: "keep"; server: ServerConfig }
  >;
  unchangedCount: number;
  folders: string[]; // every folder any add/update/orphan lands in, plus targetFolder itself
  warnings: string[]; // duplicate externalIds, invalid folders, id collisions, provider warnings
  hiddenPruneCount: number; // F22: how many entries in `prunes` are hidden servers
  /**
   * FIX 3: how many planned adds collided by host:port with a manual server.
   *
   * ADOPT 1 — on an `adoptionChoice: "adopt"` run this NARROWS to the collisions
   * adoption did not take. An adopted server sits at the device's own endpoint by
   * construction (that is the corroboration rule), so without this narrowing
   * every adoption would ALSO be reported as a duplicate about to be added —
   * describing an add that is not happening.
   */
  manualDuplicateCount: number;
  /**
   * ADOPT 1 — device names, in tree order, of every adoption CANDIDATE: a
   * device that matches exactly one eligible kept server.
   *
   * Computed REGARDLESS of `adoptionChoice`, because the caller decides whether
   * to put the question to the user from a plan computed BEFORE there is an
   * answer — that is the only plan it has when the question arises. `.length` is
   * the candidate count; the names exist so the question can name examples
   * (callers cap the render at 3, per `pushSkipSummary`'s precedent). On an
   * `"adopt"` run these are exactly the devices that became adoptions.
   */
  adoptionCandidateNames: string[];
}

function joinTargetAndRel(targetFolder: string, rel: string | undefined): string | undefined {
  if (!rel) {
    return targetFolder || undefined;
  }
  return targetFolder ? `${targetFolder}/${rel}` : rel;
}

/**
 * Selects the endpoint a Phase-1 sync maps to a server: the FIRST endpoint
 * with kind "ssh" and a non-empty host, regardless of its position among the
 * device's other endpoint kinds (redfish/url/ipmi-sol are accepted on the
 * tree but never mapped).
 */
function selectSshEndpoint(device: InventoryDevice) {
  return device.endpoints.find((e) => e.kind === "ssh" && e.host.length > 0);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * AUTH 2b (REVIEW FINDING, P1) — "can this server supply the key file the
 * profile does not?". The server-side half of `authProfileNeedsServerKeyPath`
 * (models/config.ts), which asks the same question of the profile.
 *
 * Trimmed, for the same reason THE ONE RULE trims the profile's own fields: a
 * blank or whitespace-only path is not a usable key file. `buildConnectConfig`
 * rejects the empty string outright (`Missing keyPath for key auth on …`) and
 * would try to READ a whitespace path, so neither is a server that "brings its
 * own key" — and treating either as one would leave the very server this rule
 * exists to repair unrepaired.
 *
 * REVIEW FINDING (P2) — TYPE-CHECKED before it is trimmed, exactly as THE ONE
 * RULE checks the profile's own `keyPath`. `validateServerConfig`
 * (utils/validation.ts) now enforces `string | undefined` at both boundaries a
 * foreign record can enter through, so a non-string reaching here should be
 * impossible; it is guarded anyway because the cost of being wrong is
 * disproportionate. This branch runs only while planning a sync whose key
 * profile has lost its key file — i.e. exactly when a fleet is already
 * mis-authenticating — and a bare `(server.keyPath ?? "").trim()` would throw
 * a TypeError there, aborting the entire sync AFTER the inventory has been
 * fetched, for one malformed row belonging to a server this plan may not even
 * touch. A non-string is not a usable key file by any reading, so it lands in
 * the same bucket blank already occupies: "this server brings no key of its
 * own", which is survivable and semantically right.
 */
function hasOwnKeyPath(server: ServerConfig): boolean {
  return typeof server.keyPath === "string" && server.keyPath.trim() !== "";
}

/**
 * AUTH 2 — "is this server still EXACTLY what the add path stamps, so the
 * source's profile may be retro-applied to it?". The six clauses and the whole
 * safety argument behind each one live at the update path's call site inside
 * `computeSyncPlan`; that comment block is the authority and is not repeated
 * here.
 *
 * EXTRACTED (ADOPT 1) because the adoption branch asks the same question of an
 * adoptee, and the one thing this rule cannot survive is its two halves
 * drifting — the exact precedent `decideSourceAuthRollback` sets for AUTH 2b,
 * and the reason `hasOwnKeyPath` is already shared between them. Two copies of
 * six clauses is two answers to one question, and a server admitted by one and
 * refused by the other is a server whose link nobody can explain.
 *
 * `defaultUsername` is a parameter rather than a source field read inside, so
 * the FALLBACK stays visible at both call sites: a server carrying no
 * `syncedUsername` stamp — a legacy synced server, or a kept server, which by
 * definition carries no origin at all — is compared against the source's
 * current default, which is the pre-stamp behavior and must never read as
 * "ineligible".
 */
function qualifiesForSourceProfileRetroApply(
  server: ServerConfig,
  resolvedProfileId: string | undefined,
  defaultUsername: string
): boolean {
  const stampedUsername = server.origin?.syncedUsername ?? defaultUsername;
  return (
    resolvedProfileId !== undefined &&
    server.authProfileId === undefined &&
    server.origin?.syncedAuthProfileId === undefined &&
    server.authType === "agent" &&
    !hasOwnKeyPath(server) &&
    server.username === stampedUsername
  );
}

/**
 * AUTH 2b — what this sync must do about ONE owned server's link to a profile
 * that can no longer honour it. Three outcomes, and the two that are not "none"
 * are both reportable: `unlink` is what the sync DID, `retain-own-key` is what
 * it deliberately did NOT do (REVIEW FINDING, P2 — the warning has to tell those
 * apart, because a retained server keeps using the profile and is not on SSH
 * agent authentication).
 *
 * REVIEW FINDING (P1) — extracted from the update loop it used to live inside,
 * because the decision has nothing to do with whether THIS RUN can map the
 * device to a usable endpoint. It reads the server's own three fields and the
 * profile id, so both callers — the mapped path in the loop and the pass over
 * owned servers the loop skipped — reach the same verdict from the same code.
 * Duplicating the clauses instead was the alternative, and the one thing this
 * rule cannot survive is its two halves drifting: `hasOwnKeyPath` is already
 * shared with retro-apply for exactly that reason (a server unlinked by one rule
 * and refused a re-link by another is unlinked forever).
 *
 * The clauses, and what each refuses to touch:
 *  - `unusableProfileId !== undefined`: only the keyless-key case. A DELETED
 *    profile never reaches here — NexusCore.removeAuthProfile already clears link
 *    and stamp together — and a healthy profile has nothing to undo.
 *  - `authProfileId === id && origin.syncedAuthProfileId === id`: the link is
 *    THIS SYNC'S OWN, still exactly as it wrote it. A hand-set link carries no
 *    matching stamp and is not the sync's to clear (the same opt-out rule
 *    retro-apply reads, in the other direction), and a link the user has since
 *    MOVED to another profile is likewise left alone.
 *  - `hasOwnKeyPath`: a server that brings its own key file connects perfectly
 *    well through a keyless key profile (the profile supplies authType and the
 *    passphrase, the server supplies the key) — that is the pairing the ownership
 *    rule exists to allow, so unlinking it would break a working server to fix
 *    one that is not broken. It is `retain-own-key` rather than `none` so the
 *    warning can say so: this server is the exception to the sentence about
 *    synced servers having no key of their own.
 *
 * NOT scoped by `authType`: whatever the server's own type is, the profile
 * overrides it at connect time, so every server that reaches `unlink` is unusable
 * today and lands on its own credentials once unlinked.
 */
type SourceAuthRollback = "unlink" | "retain-own-key" | "none";

function decideSourceAuthRollback(server: ServerConfig, unusableProfileId: string | undefined): SourceAuthRollback {
  if (
    unusableProfileId === undefined ||
    server.authProfileId !== unusableProfileId ||
    server.origin?.syncedAuthProfileId !== unusableProfileId
  ) {
    return "none";
  }
  return hasOwnKeyPath(server) ? "retain-own-key" : "unlink";
}

/**
 * The record AUTH 2b writes when it unlinks: the link gone, and the stamp gone
 * with it. Leaving the stamp behind would read as a per-server opt-out nobody
 * chose and lock the server out of retro-apply forever — the same reasoning
 * removeAuthProfile applies when a deleted profile's links are cleared.
 *
 * Nothing else on the record is touched, which is what makes the unlink safe to
 * apply to a server whose device this sync could not map: it is not a partial
 * device update, it is one field and its receipt.
 */
function withSourceLinkCleared(server: ServerConfig): ServerConfig {
  const origin = server.origin;
  return {
    ...server,
    authProfileId: undefined,
    origin: origin === undefined ? undefined : { ...origin, syncedAuthProfileId: undefined }
  };
}

/** N1 — appends one summary warning for a category of non-owned device skips, naming up to 3 examples. No-op when the category is empty. */
function pushSkipSummary(warnings: string[], reason: string, examples: string[]): void {
  const count = examples.length;
  if (count === 0) {
    return;
  }
  const shown = examples
    .slice(0, 3)
    .map((s) => `"${s}"`)
    .join(", ");
  warnings.push(`${count} device${count === 1 ? "" : "s"} ${reason} and ${count === 1 ? "was" : "were"} skipped (e.g. ${shown}).`);
}

/**
 * Pure: fetch result (InventoryTree) + current server set -> InventorySyncPlan.
 * No vscode import, no I/O — `now` is injected so callers control the sync
 * timestamp (and tests get determinism).
 */
export function computeSyncPlan(input: ComputeSyncPlanInput): InventorySyncPlan {
  const { source, tree, currentServers, now } = input;
  // ADOPT 1 — the tri-state answer, split into the two questions the loop below
  // actually asks of it. `adoptionDeclined` is NOT `!adoptKeptServers`: the
  // third state (never asked) is false for both.
  const adoptKeptServers = input.adoptionChoice === "adopt";
  const adoptionDeclined = input.adoptionChoice === "decline";
  const warnings: string[] = [...(tree.warnings ?? [])];

  // AUTH 1 — the source names a profile by id; the caller supplies the profile
  // it resolved to. The engine only accepts the pair when the two agree.
  //
  // The cross-check is not redundant. The caller resolves against LIVE core
  // state, while the plan is computed against a source SNAPSHOT taken at fetch
  // time (the same snapshot `planToApplication` later hands to
  // applyInventorySyncPlan as `expectedSource`). If the source's profile was
  // edited between those two reads, `input.authProfile` describes a profile
  // this plan is not about, and `source.authProfileId` names one nobody has
  // proven still exists. Stamping either would write an unverified id onto
  // every server in the plan. Both mismatch shapes therefore degrade to the
  // same safe state as a deleted profile: no stamp, plus the warning below —
  // which is exactly what the source-changed-mid-sync abort in
  // inventoryCommands is there to catch a beat later anyway.
  const matchedProfile =
    source.authProfileId !== undefined && input.authProfile?.id === source.authProfileId ? input.authProfile : undefined;

  // AUTH 1b (REVIEW FINDING, P1) — a `key` profile that supplies no key path
  // is not usable BY THIS SOURCE, however live and well-formed it is.
  //
  // Every server this engine writes a link onto has no key path of its own —
  // that is not an accident of the fixtures, it is the two paths' definition.
  // The add path stamps `authType: "agent"` with no `keyPath`, and retro-apply
  // adopts only servers still carrying exactly that (`ownedServer.keyPath ===
  // undefined` is one of its six clauses). Since the profile forces
  // `authType: "key"` at connect time and owns no path
  // (`authProfileNeedsServerKeyPath`, models/config.ts, which also explains why
  // the fix is NOT to weaken the ownership rule), `buildConnectConfig` throws
  // `Missing keyPath for key auth on <server>` for every one of them. Stamping
  // the link would therefore make every server this source syncs unusable —
  // including, through retro-apply, servers that were connecting perfectly
  // well on SSH agent auth a moment earlier.
  //
  // DEGRADE, don't abort: this lands in the SAME state as a dangling profile —
  // no stamp anywhere, so adds keep the pre-feature agent-auth record — plus a
  // warning that says which repair to make. That keeps the two "the link cannot
  // be honoured" cases behaving identically instead of inventing a third
  // outcome, and it never takes a working fleet offline because a profile was
  // edited.
  //
  // Degrading is only half of it, though (REVIEW FINDING, P1): refusing to stamp
  // stops NEW damage, while every server a previous sync already linked stays
  // linked and stays unable to connect. AUTH 2b (`decideSourceAuthRollback`, and
  // the two passes that call it) is the other half — it UNDOES the links this
  // source applied, which is also what makes the warning's "they use SSH agent
  // authentication instead" true of the servers it is describing rather than only
  // of the ones being created right now.
  //
  // The source form rejects this pairing where the user chooses it (see
  // `inventoryAuthProfileRejection` in commands/inventoryCommands.ts), so
  // reaching here means the pairing was made somewhere the form does not
  // govern: the profile had its key path removed AFTER being linked, a backup
  // restored the pair, or the record was written by hand. The form check is the
  // one that can explain itself at the right moment; this one is the one that
  // cannot be bypassed.
  const keylessKeyProfile = matchedProfile !== undefined && authProfileNeedsServerKeyPath(matchedProfile);
  const resolvedProfileId = keylessKeyProfile ? undefined : matchedProfile?.id;
  // AUTH 1c (REVIEW FINDING, P1) — the id whose SOURCE-APPLIED links this plan
  // must UNDO, and `undefined` whenever there is nothing to undo. See
  // `decideSourceAuthRollback` for the per-server rule and why it is scoped this
  // narrowly.
  const unusableProfileId = keylessKeyProfile ? matchedProfile?.id : undefined;
  // The warning below is composed here (where the reason is known) but pushed
  // AFTER both rollback passes, because its closing sentences have to state how
  // many servers this sync actually unlinked and how many it deliberately left
  // linked — numbers only those passes produce. It is then SPLICED back to this
  // position rather than appended, so the ordering users see is unchanged: tree
  // warnings, this one, then per-device warnings.
  const authWarningIndex = warnings.length;
  const emitAuthWarning = source.authProfileId !== undefined && resolvedProfileId === undefined;

  const adds: ServerConfig[] = [];
  const updates: Array<{ before: ServerConfig; after: ServerConfig }> = [];
  const prunes: InventorySyncPlan["prunes"] = [];
  let unchangedCount = 0;
  /** AUTH 2b — how many source-applied links this plan UNDOES (see `decideSourceAuthRollback`). */
  let clearedLinkCount = 0;
  /**
   * AUTH 2b — how many source-applied links this plan deliberately LEAVES IN
   * PLACE because the server brings its own key file (REVIEW FINDING, P2). Those
   * servers go on using the profile, so the warning must not describe them as
   * having no key and falling back to SSH agent authentication.
   */
  let retainedOwnKeyLinkCount = 0;
  const folderSet = new Set<string>();

  const serversById = new Map(currentServers.map((s) => [s.id, s] as const));

  // F6: when two owned servers share an externalId (e.g. post-duplicate
  // legacy state), the first encountered in stable array order wins the
  // "owned" slot; the rest are treated as NOT owned by this source — never
  // pruned, never updated, left exactly as-is.
  const ownedByExternalId = new Map<string, ServerConfig>();
  for (const server of currentServers) {
    if (!server.origin || server.origin.sourceId !== source.id) {
      continue;
    }
    const externalId = server.origin.externalId;
    const existingOwner = ownedByExternalId.get(externalId);
    if (existingOwner) {
      warnings.push(`Multiple servers are linked to device "${externalId}" — using "${existingOwner.name}".`);
      continue;
    }
    ownedByExternalId.set(externalId, server);
  }

  // F5: manual (non-owned-by-this-source) servers indexed by host:port, so a
  // planned add that collides with a hand-added server is flagged — Phase 1
  // never adopts/skips on this, only warns.
  const manualByHostPort = new Map<string, ServerConfig>();
  for (const server of currentServers) {
    if (server.origin?.sourceId === source.id) {
      continue;
    }
    manualByHostPort.set(`${server.host.toLowerCase()}:${server.port}`, server);
  }

  /**
   * ADOPT 1 — the servers this provider's sources have KEPT: records a previous
   * source created and left behind when it was removed with "Keep Servers",
   * indexed by the device each was mapped to (`formerlySynced.externalId`).
   *
   * This index — NOT `manualByHostPort` — is what adoption matches on. The two
   * exist for different questions and must not be conflated: an address
   * collision means "something else already lives here", which is worth a
   * warning; adoption means "this IS the record this device used to be", which
   * only the marker can establish. A hand-made server has no marker and is
   * therefore never adoptable, however exactly its address matches — that is the
   * whole rule, and the reason the index is keyed by device rather than address.
   *
   * Two clauses scope it:
   *  - `origin === undefined`: a server owned by ANY source (this one, another
   *    live one, or a dangling reference) is never adopted. Two sources tugging
   *    at one record is what the ownership model (F6, first-owner-wins) exists
   *    to prevent, and it also makes a record carrying BOTH `origin` and a stale
   *    marker inert rather than dangerous.
   *  - `providerId`: only a source of the same provider may claim a marker.
   *    `externalId` is provider-scoped and nothing more — two NetBox instances
   *    both emit "device:1" — so without this a marker left by one provider's
   *    source could be claimed by an entirely different kind of source.
   */
  const keptByExternalId = new Map<string, ServerConfig[]>();
  for (const server of currentServers) {
    const kept = server.formerlySynced;
    if (server.origin !== undefined || kept === undefined || kept.providerId !== source.providerId) {
      continue;
    }
    const bucket = keptByExternalId.get(kept.externalId);
    if (bucket) {
      bucket.push(server);
    } else {
      keptByExternalId.set(kept.externalId, [server]);
    }
  }
  /** ADOPT 1 — see `InventorySyncPlan.adoptionCandidateNames`. Filled in BOTH modes. */
  const adoptionCandidateNames: string[] = [];

  // m10 — maps externalId -> the first-seen device's name, so a later
  // duplicate's warning can name which device was kept, not just its id.
  const seenExternalIds = new Map<string, string>();
  // FIX 1 — every device with a non-empty externalId that appears anywhere in
  // the fetched tree counts as PRESENT for pruning purposes, even when it is
  // skipped below (empty name / no usable ssh endpoint / invalid port). Only
  // externalIds that are genuinely absent from the tree may be pruned —
  // otherwise a device the provider merely couldn't fully map looks
  // indistinguishable from one that was deleted at the source.
  const presentExternalIds = new Set<string>();
  /**
   * AUTH 2b (REVIEW FINDING, P1) — the externalIds whose owned server the device
   * loop below actually REACHED, i.e. mapped to an endpoint and pushed as an
   * update or counted as unchanged. Its complement (within `presentExternalIds`)
   * is precisely the set of owned servers whose device the source still reports
   * but this run could not map — empty name, no usable SSH endpoint, invalid
   * port, or a duplicate externalId whose first-seen device was itself skipped —
   * and those are the servers the rollback pass after the loop picks up.
   *
   * Recorded per externalId rather than per device so a duplicate device can
   * never make the same owned server decide twice.
   */
  const decidedOwnedExternalIds = new Set<string>();
  let manualDuplicateCount = 0;

  // N1 — a device skip is only reported per-device when it could be masking
  // data loss for a server this source already owns (its externalId matches
  // an owned server — see ownedByExternalId below). NetBox trees legitimately
  // contain many endpoint-less devices (PDUs, patch panels, ...), so every
  // other no-endpoint/empty-name/invalid-port skip is collected here and
  // reported as a single aggregate warning per category instead of drowning
  // the warnings list in one line per device.
  const noEndpointSkipped: string[] = [];
  const emptyNameSkipped: string[] = [];
  const invalidPortSkipped: string[] = [];

  for (const device of tree.devices) {
    if (!device.externalId) {
      warnings.push(`Device "${device.name || "(unnamed)"}" has no device ID and was skipped.`);
      continue;
    }
    presentExternalIds.add(device.externalId);
    const isOwned = ownedByExternalId.has(device.externalId);

    if (!device.name) {
      if (isOwned) {
        warnings.push(`Device "${device.externalId}" has an empty name and was skipped.`);
      } else {
        emptyNameSkipped.push(device.externalId);
      }
      continue;
    }
    const firstSeenName = seenExternalIds.get(device.externalId);
    if (firstSeenName !== undefined) {
      warnings.push(`Duplicate device ID "${device.externalId}" — kept first ("${firstSeenName}").`);
      continue;
    }
    seenExternalIds.set(device.externalId, device.name);

    const endpoint = selectSshEndpoint(device);
    if (!endpoint) {
      if (isOwned) {
        warnings.push(`Device "${device.name}" (${device.externalId}) has no usable SSH endpoint and was skipped.`);
      } else {
        noEndpointSkipped.push(device.name);
      }
      continue;
    }
    const port = endpoint.port ?? 22;
    if (!isValidPort(port)) {
      if (isOwned) {
        warnings.push(`Device "${device.name}" (${device.externalId}) has an invalid port ${port} and was skipped.`);
      } else {
        invalidPortSkipped.push(device.name);
      }
      continue;
    }

    // Folder resolution: device.folderPath is relative to source.targetFolder.
    let rel: string | undefined;
    if (device.folderPath) {
      const normalizedRel = normalizeFolderPath(device.folderPath);
      if (normalizedRel === undefined) {
        warnings.push(`Device "${device.name}" (${device.externalId}) has an invalid folder path "${device.folderPath}"; placed at the source's target folder.`);
      } else {
        rel = normalizedRel;
      }
    }
    const joined = joinTargetAndRel(source.targetFolder, rel);
    let group: string | undefined;
    if (joined === undefined) {
      group = undefined;
    } else {
      const normalizedJoined = normalizeFolderPath(joined);
      if (normalizedJoined === undefined) {
        warnings.push(`Device "${device.name}" (${device.externalId}) folder path exceeds the maximum depth; placed at the source's target folder.`);
        group = source.targetFolder ? source.targetFolder : undefined;
      } else {
        group = normalizedJoined;
      }
    }

    const id = deterministicServerId(source.id, device.externalId);

    const ownedServer = ownedByExternalId.get(device.externalId);
    if (ownedServer) {
      // This owned server is being decided HERE, with a mapped endpoint in hand;
      // the rollback pass after the loop must not decide it a second time.
      decidedOwnedExternalIds.add(device.externalId);
      // Field ownership: only name/host/port/group are always taken from the
      // device; username only when the endpoint supplies one. Everything
      // else (authProfileId, keyPath, proxy, multiplexing, isHidden,
      // logSession, ...) is copied untouched from `before`.
      const afterOrigin: ServerOrigin = {
        sourceId: source.id,
        externalId: device.externalId,
        syncedAt: now,
        // AUTH 2a — `syncedUsername` records what the SYNC wrote, so it is
        // refreshed exactly when this sync writes `username` (the line below:
        // only when the endpoint supplies one) and otherwise carried forward
        // from the previous stamp verbatim — including forward as `undefined`
        // for a server synced before the field existed, which is what keeps
        // that server on the defaultUsername fallback instead of excluding it.
        //
        // The two rejected alternatives, both of which break the rule this
        // field exists to serve:
        //   - `syncedUsername: after.username` (or ownedServer.username) —
        //     records the record's CURRENT value, so the first sync after a
        //     hand-edit would enshrine the hand-edited username as "what the
        //     sync stamped" and the sync after that would adopt the server.
        //     A hand-edit laundered into "untouched" is precisely the hole the
        //     rule exists to close.
        //   - `syncedUsername: source.defaultUsername` unconditionally —
        //     records a value this sync did NOT write onto the record. On a
        //     pre-existing server whose source default has since been rewritten
        //     (the profile-mirroring case) it would backfill the NEW default
        //     over a server still carrying the old one, permanently excluding a
        //     server the fallback adopts correctly today.
        // Nothing infers a stamp that was never taken: absent stays absent.
        syncedUsername: endpoint.username ?? ownedServer.origin?.syncedUsername,
        // AUTH 2c — the auth-profile stamp obeys the SAME "records what the sync
        // wrote" discipline: carried forward verbatim here, and overwritten only
        // where this sync actually writes `authProfileId`, i.e. inside the
        // retro-apply branch below (nowhere else in the update path touches the
        // link). Carry-forward is load-bearing rather than cosmetic: an update
        // fired for a totally unrelated reason — a device renamed at the source —
        // rebuilds `origin` from scratch, and a rebuild that forgot this member
        // would ERASE a user's opt-out and let the very next sync reattach the
        // source's profile.
        //
        // Deliberately NOT `ownedServer.authProfileId`: that is the value the
        // rule audits, so recording it would launder a hand-link into "this is
        // what the sync put here" one sync later.
        syncedAuthProfileId: ownedServer.origin?.syncedAuthProfileId
      };
      const after: ServerConfig = {
        ...ownedServer,
        name: device.name,
        host: endpoint.host,
        port,
        group,
        origin: afterOrigin
      };
      if (endpoint.username !== undefined) {
        after.username = endpoint.username;
      }

      // AUTH 2 — retro-apply. The single exception to the field-ownership rule
      // above, and the only reason servers synced before the source had a
      // profile ever become usable without hand-editing each one.
      //
      // The six clauses below admit exactly one state: a source profile that
      // actually resolves, plus a server still carrying EXACTLY what the add
      // path stamps (see the adds.push near the end of this loop) — agent auth,
      // no key, no profile THIS SYNC PUT THERE OR TOOK AWAY, and the username
      // that sync wrote. That equality is the whole safety argument — it is what
      // lets the condition mean "created by this source and never auth-configured
      // since". Each clause carries its own weight:
      //
      //  - resolvedProfileId !== undefined: a source with no profile, or with a
      //    dangling one, must behave exactly as it did before this feature.
      //    Drop it and clearing the field to (None) — or deleting the profile —
      //    would rewrite every synced server instead of leaving them alone.
      //  - ownedServer.authProfileId === undefined: a server already carrying a
      //    profile is in a DECIDED state, and a hand-link is indistinguishable
      //    from one this source stamped. Drop it and the source wins every A->B
      //    change, silently stomping per-server links (rejected option D).
      //  - ownedServer.origin?.syncedAuthProfileId === undefined: the OPT-OUT
      //    clause (REVIEW FINDING 1, P2). `authProfileId === undefined` alone
      //    cannot tell "the sync never linked anything here" apart from "the sync
      //    linked a profile and the user cleared it in the server editor" — after
      //    such a clear the record satisfies every other clause again (agent
      //    auth, no key, stamped username), so the next sync reattached the
      //    source's profile and a per-server opt-out was impossible. The stamp
      //    records what the sync itself last linked, so a cleared link reads as
      //    `authProfileId === undefined` against a stamp that NAMES a profile:
      //    visibly the user's doing, and left alone from then on.
      //
      //    Together with the clause above this is exactly the reviewer-suggested
      //    "`authProfileId` still equals what the sync stamped", restricted to
      //    the both-undefined branch. The other branch — adopting when the record
      //    still carries the very profile the sync stamped, i.e. re-stamping it
      //    when the SOURCE switches A->B — is deliberately NOT taken: it would
      //    reverse the documented contract that "changing this field from one
      //    profile to another does NOT re-stamp already-linked servers"
      //    (models/inventory.ts), which is a separate behavior change from the
      //    one this finding asks for, and it would silently move a link on a
      //    server whose user re-selected that same profile by hand. A source
      //    switch therefore still leaves already-linked servers alone; the
      //    folder-level Apply Auth Profile command is the deliberate way to move
      //    them.
      //
      //    Servers synced before this stamp existed carry none, which reads the
      //    same as "the sync linked nothing" — both are the state retro-apply is
      //    allowed to fill, so legacy servers are adopted exactly as before and
      //    are never excluded for lacking the field.
      //  - ownedServer.authType === "agent": password/key auth on a synced
      //    server is a working hand-configuration. Drop it and those servers get
      //    a profile bolted on that OVERRIDES their credentials at connect time
      //    (SilentAuthSshFactory resolves the profile before the record's own
      //    fields), i.e. the fix would break exactly the servers already fixed.
      //  - !hasOwnKeyPath(ownedServer): "agent" plus an explicit identity file is
      //    a deliberate agent-with-key setup, not this engine's output. Drop it
      //    and those get re-pointed at the profile too.
      //
      //    REVIEW FINDING (P2) — the SAME predicate AUTH 2b unlinks by, not a
      //    literal `keyPath === undefined`. The two are one question asked twice
      //    ("does this server bring a key file of its own?"), so they must not be
      //    able to answer it differently: a server carrying `keyPath: "   "` is
      //    unlinked by AUTH 2b as bringing no usable key, and a literal-undefined
      //    re-link check then refuses it forever — the unlink stops being
      //    reversible for exactly the shape the UI makes reachable, since a keyless
      //    key profile deliberately leaves Private Key File editable and
      //    `formValuesToServer` (serverCommands.ts) stores any truthy string
      //    verbatim. Normalizing the stored path during the unapply instead was
      //    rejected: it would have this clause keep answering a question it gets
      //    wrong, and it would rewrite a credential field the update path's own
      //    ownership rule promises to copy untouched from `before`.
      //
      //    Widening from "absent" to "no usable path" costs the clause nothing it
      //    was protecting: blank, whitespace and (defensively) non-string are none
      //    of them an identity file — `buildConnectConfig` rejects the empty string
      //    outright and would try to READ a whitespace path — so a server carrying
      //    one is in the add path's shape in every way that decides a connection.
      //  - ownedServer.username === stampedUsername: the one hand-edit the auth
      //    clauses cannot see. No shipped provider emits endpoint usernames
      //    (NetBox does not), so the update path above never overwrites
      //    `username` and a manual username change survives every later sync
      //    while leaving the auth fields untouched. Drop this clause and such a
      //    server is adopted — after which the profile's username OVERRIDES the
      //    one the user typed, at connect time and invisibly (silentAuth
      //    resolves the profile before the record's own fields): a hand-edit
      //    undone by a sync, which is precisely what the other three clauses
      //    exist to prevent.
      //
      // So "every hand-edit escapes" holds only WITH the username clause; the
      // three auth clauses alone do not detect a username edit.
      //
      // `stampedUsername` is what the LAST SYNC WROTE (origin.syncedUsername),
      // not the source's current `defaultUsername`. Comparing against the
      // current default was the obvious reading of "still the source's own
      // default" and it was wrong in the feature's own main flow: choosing an
      // auth profile on the source form MIRRORS that profile's username into
      // `defaultUsername` and saves it. So linking a profile whose username
      // differs from the previous default rewrites the default, and every
      // already-synced server — untouched, still carrying the OLD default —
      // stops matching, is not adopted, stays on broken agent auth, and nothing
      // in the plan preview explains the absence. Recording the stamp moves the
      // comparison onto a value the user's action cannot move underneath it.
      //
      // FALLBACK, and what it means for servers synced by an earlier build:
      // they carry no `syncedUsername` (the field did not exist), so they fall
      // back to `source.defaultUsername` — bit-for-bit the previous behavior,
      // never an exclusion for lacking the field. They therefore keep the
      // residual gap this change closes for everyone else: if the profile you
      // link carries a different username than the source's default did, those
      // specific servers are not adopted and need
      // `nexus.authProfile.applyToFolder` (or one edit each). And the gap stays
      // open for them — the update path only writes `syncedUsername` where it
      // writes `username`, i.e. when the provider supplies an endpoint one, and
      // no shipped provider does; every server ADDED from here on carries its
      // stamp from birth, so the population that can hit this is finite and only
      // ever shrinks.
      //
      // Nothing backfills the field for them, and the two obvious backfills are
      // both worse than the gap. From the record's current username: that value
      // is exactly what the clause is trying to audit, so trusting it turns
      // "hand-edited" into "as stamped" on the next run and hands the fleet's
      // credentials to the profile behind the user's back. From the source's
      // current `defaultUsername`: on the very servers this is meant to help the
      // default has ALREADY been rewritten by the profile mirror, so the
      // backfill writes the new default over a server still carrying the old one
      // and excludes it permanently — turning a gap that a folder-level
      // Apply Auth Profile fixes into one nothing fixes.
      //
      // What none of this catches, by design: a WORKING agent-auth server whose
      // username still matches and whose link the sync never set — that includes
      // one whose HAND-set link the user has since cleared, which is
      // indistinguishable from a never-configured server (both carry no profile
      // and no stamp). It is adopted, and the plan-preview modal disclosing the
      // switch (plus the named list behind Show Warnings) is what makes that
      // consented to rather than silent.
      //
      // If the add path's defaults ever change, this condition must change with
      // it or retro-apply stops matching its own output.
      //
      // The six clauses (and the `stampedUsername` fallback the paragraphs above
      // argue for) live in `qualifiesForSourceProfileRetroApply` at the top of
      // this file, because the ADOPT 1 branch below asks the same question of a
      // kept server and the two must not be able to answer it differently. The
      // reasoning stays HERE, where the rule is applied to the population it was
      // written about; the function carries only a pointer back to it.
      if (qualifiesForSourceProfileRetroApply(ownedServer, resolvedProfileId, source.defaultUsername)) {
        after.authProfileId = resolvedProfileId;
        // The stamp is written HERE and only here on the update path, in the same
        // breath as the link itself — that is what makes a LATER clear of this
        // link visible to the next sync as an opt-out instead of reading as
        // "never linked" and being reattached forever.
        after.origin = { ...afterOrigin, syncedAuthProfileId: resolvedProfileId };
      }

      // AUTH 2b (REVIEW FINDING, P1) — RETRO-UNAPPLY, for the servers this run
      // DID map. Retro-apply above stops this sync from stamping a link the
      // profile cannot honour; on its own that only prevents NEW damage. The
      // servers a PREVIOUS sync linked while the profile still had a key file keep
      // `authProfileId`, because everything the update path builds starts from
      // `ownedServer` — so `SilentAuthSshFactory` still resolves them to
      // `authType: "key"` with no key path anywhere and `buildConnectConfig`
      // throws `Missing keyPath for key auth on <server>` on every connect. The
      // old warning claimed those servers were on SSH agent authentication; they
      // were not connecting at all.
      //
      // WHY CLEAR RATHER THAN ONLY REPORT. Reporting leaves a fleet down until
      // someone repairs the profile, and the sync cannot tell whether that ever
      // happened. Clearing puts each server back on exactly the record the add
      // path gives it — the state it was in and working before the link — and is
      // REVERSIBLE by construction: the stamp goes with the link, so once the
      // profile has a key file again retro-apply's clauses hold and the very next
      // sync re-links it. Nothing is lost that a later sync cannot restore.
      //
      // That reversal is why retro-apply's key clause reads `hasOwnKeyPath` rather
      // than `keyPath === undefined` (REVIEW FINDING, P2 — see its clause list
      // above). Both rules ask this same field the same question, so a server
      // unlinked HERE for bringing no usable key must not then be refused a re-link
      // for carrying one; with the literal check it was, and `keyPath: "   "` — a
      // value the server form can store, because a keyless key profile leaves that
      // control editable on purpose — made the unlink permanent.
      //
      // "Reversible" is scoped to servers still in the shape retro-apply admits,
      // which is the ordinary case: while the link is on, a profile supplying a
      // username and an auth type owns both, so the form locks them and `keyPath`
      // is the one credential field that can move underneath it. A server whose
      // `authType` or `username` diverged some other way (a hand-edited backup, or
      // a profile that supplies no username of its own and so leaves that field
      // editable) is deliberately NOT re-linked — those are the hand-edit clauses
      // doing their job — and lands on its own credentials until Apply Auth Profile
      // is used on it.
      //
      // It is still a credential mutation on existing servers, so it goes through
      // the plan like every other one: it lands in `updates` (AUTH 3's
      // `authProfileId` clause makes it a change), the confirm modal counts it,
      // and Show Warnings names every affected server — the same disclosure the
      // switch list gives the opposite direction.
      //
      // The clauses live in `decideSourceAuthRollback` (top of this file), which
      // the pass after the loop calls with the same server fields and no endpoint
      // at all — that shared verdict is the whole point of the extraction.
      //
      // Only servers whose device is in this fetch are decided at all. One being
      // PRUNED is out of the sync's active set by the policy the user chose —
      // "keep in place" and "move to _orphaned" both mean stop reconfiguring it —
      // and a "delete" prune removes it outright.
      const mappedRollback = decideSourceAuthRollback(ownedServer, unusableProfileId);
      if (mappedRollback === "unlink") {
        after.authProfileId = undefined;
        // The stamp goes with the link it describes — leaving it behind would
        // read as a per-server opt-out nobody chose and lock the server out of
        // retro-apply forever, which is exactly the reasoning removeAuthProfile
        // applies when a deleted profile's links are cleared.
        after.origin = { ...afterOrigin, syncedAuthProfileId: undefined };
        clearedLinkCount++;
      } else if (mappedRollback === "retain-own-key") {
        retainedOwnKeyLinkCount++;
      }

      // AUTH 3 — authProfileId joins the comparison because a retro-apply stamp
      // can be the ONLY difference between `before` and `after` (the device
      // itself is usually identical on the sync that first carries a profile).
      // Without this clause the stamp above is computed and then discarded as
      // "unchanged": the servers stay broken and unchangedCount lies to the
      // plan-preview modal about what the sync is doing.
      //
      // AUTH 3a (REVIEW FINDING 2, P2) — and the ORIGIN STAMPS join it for the
      // same reason one layer down. `after.origin` can carry a stamp the record
      // does not have yet while every user-visible field above is identical: a
      // legacy owned server with no `syncedUsername`, whose provider supplies an
      // endpoint username EQUAL to the one it already has, computes
      // `syncedUsername` for the first time and changes nothing else. Discarding
      // `after` there throws the newly computed stamp away, so that server never
      // gains one — and is then misclassified as hand-edited by every later sync
      // that compares against the source's (by then profile-mirrored) default
      // username, which is exactly the retro-apply gap the stamp exists to close.
      //
      // `serverOriginStampsEqual`, NOT `serverOriginsEqual`: the latter also
      // compares `syncedAt`, which this sync always advances, so using it here
      // would report every owned server as an update on every single sync.
      const changed =
        ownedServer.name !== after.name ||
        ownedServer.host !== after.host ||
        ownedServer.port !== after.port ||
        ownedServer.group !== after.group ||
        ownedServer.authProfileId !== after.authProfileId ||
        !serverOriginStampsEqual(ownedServer.origin, after.origin) ||
        (endpoint.username !== undefined && ownedServer.username !== after.username);
      if (changed) {
        updates.push({ before: ownedServer, after });
        if (group !== undefined) {
          folderSet.add(group);
        }
      } else {
        unchangedCount++;
      }
      continue;
    }

    // Never adopt/overwrite a server whose origin doesn't match this
    // source, even if its id happens to collide with the deterministic id
    // this device would produce (hand-imported fragment, or a collision
    // across two different sources sharing a namespace by coincidence).
    const collidingServer = serversById.get(id);
    if (collidingServer) {
      warnings.push(`Device "${device.name}" (${device.externalId}) maps to an id already used by unrelated server "${collidingServer.name}" — skipped.`);
      continue;
    }

    // ADOPT 1 — the kept-server match, and the adoption it can produce.
    //
    // PLACEMENT IS LOAD-BEARING: strictly AFTER the id-collision guard above. A
    // device whose deterministic id is already taken by an unrelated server is
    // skipped today, and it stays skipped even when an adoptable server is
    // waiting for it — reordering these two would change a corner nobody asked
    // to change, on the strength of a feature about a different problem.
    //
    // ELIGIBILITY, all of it: the server carries this provider's "Keep Servers"
    // marker naming THIS device (the index above), AND its CURRENT address is
    // still the device's address. The marker establishes identity; the address
    // corroborates it.
    //
    // WHY CORROBORATE AT ALL. `externalId` is unique only within one provider
    // INSTANCE: two NetBox deployments both emit "device:1", so a marker left by
    // one could otherwise be claimed by a device from the other — silently
    // handing a server to a source that has never seen that machine. With the
    // address check, a false match needs the same externalId AND the same
    // address across two instances of one provider, which effectively means the
    // same machine.
    //
    // WHAT THIS DELIBERATELY GIVES UP, so nobody "fixes" it by dropping the
    // clause: a device that legitimately CHANGED ADDRESS while the source was
    // removed is NOT reclaimed, and neither is one whose kept server had its
    // host or port hand-edited. Those fall through to a duplicate add — today's
    // behavior — plus the mismatch warning below saying exactly why. That is a
    // deliberate trade of convenience for safety: the owner's rule is that
    // servers the user controls must never be quietly taken over by a source,
    // and a wrong adoption is silent while a refused one is visible and
    // repairable.
    //
    // The CURRENT address is compared, not one recorded at detach time: if the
    // box moved and both the source and the user's record moved with it,
    // adoption should still fire. A recorded address would refuse exactly that
    // case.
    //
    // THE TWO REFUSAL WARNINGS at the end of this block (ambiguous, and moved
    // address) fire in EVERY state except `"decline"` — REVIEW FINDING, and the
    // reason `adoptionChoice` is a tri-state at all. They used to require the
    // adopt flag, which cannot be set unless the question was asked, which the
    // caller only asks when the plan reports a CANDIDATE — and neither refusal
    // is a candidate. So the exact two shapes this copy was written for (the
    // re-IP'd lab, the accidental second marker) were the two that produced a
    // silent duplicate set. The two-marker state is reachable through this
    // feature's own happy path: Keep Servers → re-add → Add Separately → apply →
    // remove that source with Keep Servers again leaves two markers naming one
    // device at one address.
    const keptMatches = keptByExternalId.get(device.externalId) ?? [];
    const eligibleForAdoption = keptMatches.filter((s) => s.host.toLowerCase() === endpoint.host.toLowerCase() && s.port === port);
    if (eligibleForAdoption.length === 1) {
      const adoptee = eligibleForAdoption[0];
      // Recorded whatever the answer — it changes what the plan DOES with a
      // candidate, never whether it is one. Nothing claims/locks the adoptee
      // here: `device.externalId` is the index key, and the duplicate-externalId
      // guard earlier in this loop already skips any second device carrying the
      // same id, so one kept server can never be reached twice in one plan.
      adoptionCandidateNames.push(device.name);
      if (adoptKeptServers) {
        // The adopted record: re-stamping plus ordinary source ownership, NEVER
        // a credential copy. `...adoptee` first is the whole field-ownership
        // rule in one line — id, username, authType, keyPath, authProfileId,
        // proxy, multiplexing, isHidden, logSession and the rest survive
        // byte-for-byte, and only the four fields the source owns on every later
        // sync are taken from the device. The id surviving is what keeps
        // SecretStorage keys (`password-{id}`, passphrase, proxy password),
        // tunnel defaults and other servers' `proxy.jumpHostId` references
        // pointing at this record; mint a new one and the user's saved password
        // is orphaned by a sync that claimed to change nothing but a name.
        const adoptionOrigin: ServerOrigin = {
          sourceId: source.id,
          externalId: device.externalId,
          syncedAt: now,
          // AUTH 2a, applied to a record this sync did not create: the stamps
          // record what THIS sync WROTE. It writes `username` only when the
          // endpoint supplies one, so otherwise it stamps none — never
          // `adoptee.username` (which launders the user's hand-picked username
          // into "as stamped", after which the NEXT sync would retro-apply the
          // source's profile over it) and never `source.defaultUsername` (a
          // value this sync did not write onto the record).
          syncedUsername: endpoint.username,
          // Overwritten below if — and only if — retro-apply fires in this same
          // plan, i.e. where this sync actually writes the link. Never
          // `adoptee.authProfileId`: a kept server's surviving link is history's
          // doing, not this sync's, and recording it would read as an opt-out
          // the user never made.
          syncedAuthProfileId: undefined
        };
        const after: ServerConfig = {
          ...adoptee,
          name: device.name,
          // Equal to the adoptee's host up to case (the corroboration above),
          // so this only ever re-cases it — the source owns the field.
          host: endpoint.host,
          port,
          group,
          origin: adoptionOrigin,
          // MUTUALLY EXCLUSIVE WITH `origin` — and EXPLICIT, because the spread
          // above would otherwise carry the marker onto a now-owned server. A
          // record holding both says two contradictory things about who manages
          // it, and the marker would go on advertising this server for adoption
          // by the next source of the same provider.
          formerlySynced: undefined
        };
        // The ONE field outside the source's four that adoption may overwrite,
        // and the only place the "it keeps its saved credentials" copy could
        // ever fall short (REVIEW FINDING). Kept as-is deliberately, for the
        // same reason retro-apply is allowed on an adoptee two lines below: an
        // adopted server is OWNED from this point, and the ordinary update path
        // writes `endpoint.username` onto every owned server whose endpoint
        // supplies one (see the `changed` comparison above), so refusing here
        // would only defer the identical overwrite to the next sync while
        // leaving one run where the source does not own a field it owns
        // everywhere else.
        //
        // No shipped provider emits endpoint usernames, so this is unreachable
        // today; a third-party provider through the public API can reach it. The
        // disclosure is therefore made where it can be TRUE OF THE ACTUAL PLAN
        // rather than promised in advance: describePlanDetail derives an extra
        // preview line from the adoption pairs whose username actually changes,
        // so the correction reaches the user before Apply, on the plan it
        // applies to (commands/inventoryCommands.ts).
        if (endpoint.username !== undefined) {
          after.username = endpoint.username;
        }
        // AUTH 2 on an adoptee, deliberately allowed. Blocking it for one sync
        // would only move the same disclosed switch to the next run — the server
        // is owned from here on, so the ordinary update path would fire the
        // identical retro-apply next time. Both origin reads inside the
        // predicate are `undefined` for a kept server, so it degrades to exactly
        // the legacy-server case: agent auth, no key of its own, no link, and a
        // username still equal to the source's default.
        if (qualifiesForSourceProfileRetroApply(adoptee, resolvedProfileId, source.defaultUsername)) {
          after.authProfileId = resolvedProfileId;
          after.origin = { ...adoptionOrigin, syncedAuthProfileId: resolvedProfileId };
        }
        // No `changed` comparison, unlike the owned-update path above: gaining
        // `origin` guarantees before !== after, so an adoption is ALWAYS an
        // update and never lands in `unchangedCount`. AUTH 2b/rollback likewise
        // never sees a kept server — `decideSourceAuthRollback` requires
        // `origin.syncedAuthProfileId === unusableProfileId` and a kept server
        // has no origin to carry one, so its verdict is "none" by construction.
        updates.push({ before: adoptee, after });
        if (group !== undefined) {
          folderSet.add(group);
        }
        // Deliberately BEFORE the duplicate warning below: an adopted server is
        // at the device's own endpoint by construction, so it would otherwise
        // warn (and count) that this device "will be added as a duplicate" —
        // describing an add that is not happening.
        continue;
      }
    } else if (!adoptionDeclined && eligibleForAdoption.length >= 2) {
      // AMBIGUITY — adopt NEITHER. Records at one endpoint can differ in every
      // credential the endpoint does not show, so picking "the first in array
      // order" would be a guess about which one the user considers canonical.
      // A duplicate add plus an explanation is the safe floor, and the warning
      // says which repair makes adoption possible.
      //
      // REVIEW FINDING — the repair only works from a CANCELLED sync. Applied
      // first, the device is owned from that moment: the adoption block is
      // unreachable on every later run, so removing the extra copies achieves
      // nothing and the just-created duplicate has to be deleted as well. The
      // sentence therefore leads with Cancel rather than describing a repair
      // that dead-ends for anyone who reads it in the order it is written.
      warnings.push(
        `Device "${device.name}" matches ${eligibleForAdoption.length} servers kept from a removed inventory source at ${endpoint.host}:${port} — Nexus cannot tell which to adopt, so it will be added as a duplicate. Cancel, remove the extra copies, then sync again to adopt.`
      );
    } else if (!adoptionDeclined && keptMatches.length > 0) {
      // Identity matched, address did not. Without this the user sees a silent
      // duplicate and concludes adoption is broken; with it, the refusal states
      // its own reason and the repair is obvious (the addresses are both named).
      warnings.push(
        keptMatches.length === 1
          ? `Device "${device.name}" was previously synced onto server "${keptMatches[0].name}", but that server is now at ${keptMatches[0].host}:${keptMatches[0].port} and the device is at ${endpoint.host}:${port} — it will be added as a new server instead.`
          : `Device "${device.name}" was previously synced onto ${keptMatches.length} servers in your list, none of which is still at ${endpoint.host}:${port} — it will be added as a new server instead.`
      );
    }

    const hostPortKey = `${endpoint.host.toLowerCase()}:${port}`;
    const manualMatch = manualByHostPort.get(hostPortKey);
    if (manualMatch) {
      warnings.push(`Device "${device.name}" matches existing server "${manualMatch.name}" (${endpoint.host}:${port}) — will be added as a duplicate.`);
      manualDuplicateCount++;
    }

    adds.push({
      id,
      name: device.name,
      host: endpoint.host,
      port,
      username: endpoint.username ?? source.defaultUsername,
      authType: "agent",
      // The LINK only — never the profile's username/authType/keyPath. Those
      // are resolved fresh at connect time, so a profile edit reaches every
      // server it owns; a copy taken here would rot the moment the profile
      // changed. `authType: "agent"` above stays inert while the link holds and
      // is the exact fallback if the profile is later deleted, which is why it
      // is still stamped unconditionally. Undefined when the source has no
      // profile or its reference is dangling (AUTH 1) — the pre-feature record,
      // field for field.
      authProfileId: resolvedProfileId,
      isHidden: false,
      group,
      // `syncedUsername` mirrors the `username` two lines above, and
      // `syncedAuthProfileId` mirrors the `authProfileId` above it — the values
      // this sync is writing onto the record, which is what makes a later
      // "still exactly what I stamped" comparison possible (AUTH 2). Both are
      // recorded UNCONDITIONALLY, whether or not the source has a profile today:
      // a source that gains one later must find the stamps already there, and a
      // source that never gains one pays nothing for carrying them.
      //
      // `syncedAuthProfileId` mirrors the RESOLVED id, never `source.authProfileId`
      // — a dangling reference writes no link, so it must record none either, or
      // a server that was never linked would read as one whose link the user
      // cleared and would be locked out of retro-apply forever. When the source
      // has no profile the stamp is `undefined`, i.e. bit-identical to a legacy
      // record, which is the point: both mean "the sync put no profile here".
      origin: {
        sourceId: source.id,
        externalId: device.externalId,
        syncedAt: now,
        syncedUsername: endpoint.username ?? source.defaultUsername,
        syncedAuthProfileId: resolvedProfileId
      }
    });
    if (group !== undefined) {
      folderSet.add(group);
    }
  }

  // AUTH 2b, SECOND PASS (REVIEW FINDING, P1) — the same rollback decision for
  // every owned server the source STILL RECOGNISES but whose device this run
  // could not map to a usable endpoint.
  //
  // The hole this closes: the decision used to live inside the update loop, after
  // four `continue`s that mapping validation reaches first. A device with an
  // empty name, no usable SSH endpoint, an invalid port, or a duplicate
  // externalId whose first-seen copy was itself skipped never got as far as the
  // rollback — so the servers that most need the repair were the ones excluded
  // from it. That is not a corner: the NetBox provider emits a device with ZERO
  // endpoints whenever it has no primary IP (it warns and carries on), and the
  // server for that device is still there from the sync when it did have one.
  // Losing an IP at the source is a routine maintenance state; being unable to
  // connect to every such device until it comes back is not.
  //
  // A SEPARATE PASS rather than a reorder inside the loop, for three reasons:
  //  - It cannot regress the skip semantics. The `continue`s, the warnings they
  //    push and the FIX 1 present/absent bookkeeping are untouched, so a skipped
  //    device still produces no add, no rename, no host/port change and no folder
  //    move — this pass writes exactly one field and its receipt
  //    (`withSourceLinkCleared`) and adds nothing to `folderSet`.
  //  - It cannot double-decide. Reordering would have to run before validation
  //    but after ownership resolution, and a duplicate device would then reach the
  //    same owned server twice; `decidedOwnedExternalIds` makes "the loop already
  //    decided this server" explicit instead of implicit in control flow.
  //  - It states the actual rule. Whether a server's link is honourable has
  //    nothing to do with whether today's fetch could map its device — mixing the
  //    two is the bug, so the fix keeps them apart rather than interleaving them
  //    more carefully.
  //
  // Absent devices stay out, exactly as before: `presentExternalIds` is FIX 1's
  // "the source still reports this device" set, and an owned server missing from
  // it is the prune phase's business under the policy the user chose. A skipped
  // device is likewise still NOT prunable — this pass never touches that set.
  for (const [externalId, ownedServer] of ownedByExternalId.entries()) {
    if (decidedOwnedExternalIds.has(externalId) || !presentExternalIds.has(externalId)) {
      continue;
    }
    const unmappedRollback = decideSourceAuthRollback(ownedServer, unusableProfileId);
    if (unmappedRollback === "retain-own-key") {
      retainedOwnKeyLinkCount++;
      continue;
    }
    if (unmappedRollback !== "unlink") {
      continue;
    }
    // Straight into `updates`, so this unlink is disclosed by the same machinery
    // as the mapped one — the confirm modal's "will stop using auth profile" line,
    // the named list behind Show Warnings, and the drift comparison all derive
    // from `before.authProfileId !== after.authProfileId` and know nothing about
    // which pass produced the pair.
    //
    // `origin.syncedAt` is deliberately NOT advanced: this sync did not map the
    // device, so claiming it did would be the very confusion this pass exists to
    // undo. Nothing reads `syncedAt` for eligibility (`serverOriginStampsEqual`
    // ignores it), and the unlink does not repeat next sync — the link it keys on
    // is gone.
    updates.push({ before: ownedServer, after: withSourceLinkCleared(ownedServer) });
    clearedLinkCount++;
  }

  if (emitAuthWarning) {
    // Deliberately unconditional on counts: even a sync with zero adds, zero
    // updates and zero unlinks must say the link is dead, because the source form
    // still shows a profile selected and nothing else in the sync would
    // contradict it.
    //
    // The unlink sentence is appended only when this sync actually unlinks
    // something, and says what it did rather than what it prevented — the whole
    // point of the finding this closes is that the warning used to describe
    // already-linked servers as being on agent authentication while they were in
    // fact unable to connect at all. Spliced (not pushed) so the position among
    // the other warnings is exactly what it was before the count made the text
    // depend on the loop.
    const clearedNote =
      clearedLinkCount > 0
        ? ` ${clearedLinkCount} server${clearedLinkCount === 1 ? "" : "s"} this sync had already linked to it ${clearedLinkCount === 1 ? "is" : "are"} unlinked here so ${clearedLinkCount === 1 ? "it can connect" : "they can connect"} again; a later sync re-links ${clearedLinkCount === 1 ? "it" : "them"} once the profile has a key file.`
        : "";
    // REVIEW FINDING (P2) — the same discipline for the servers the rollback
    // deliberately LEFT LINKED. The sentence before it is a statement of policy
    // about the records this sync WRITES ("servers this source creates"), which
    // is exactly true of them: the add path stamps agent auth and no key, and
    // retro-apply is refused while the profile is unusable. A server that has
    // since been given a key file of its own is the one case where the policy's
    // premise does not hold — it keeps the profile and goes on connecting through
    // it — so saying nothing would leave the user reading "they use SSH agent
    // authentication instead" about a server that does no such thing, and looking
    // for an unlink that never happened.
    const retainedNote =
      retainedOwnKeyLinkCount > 0
        ? ` ${retainedOwnKeyLinkCount} server${retainedOwnKeyLinkCount === 1 ? "" : "s"} this sync had already linked to it ${retainedOwnKeyLinkCount === 1 ? "keeps" : "keep"} the link, because ${retainedOwnKeyLinkCount === 1 ? "it carries a key file of its own" : "they carry key files of their own"} and still ${retainedOwnKeyLinkCount === 1 ? "connects" : "connect"} through the profile.`
        : "";
    warnings.splice(
      authWarningIndex,
      0,
      keylessKeyProfile && matchedProfile !== undefined
        ? `The auth profile "${matchedProfile.name}" for "${source.name}" uses private key authentication but has no key file — servers this source creates have no key of their own, so the sync does not apply it: they use the default username with SSH agent authentication instead. Add a key file to the profile, or choose another.${clearedNote}${retainedNote}`
        : `The auth profile for "${source.name}" no longer exists — synced servers use the default username with SSH agent authentication. Edit the source to choose another profile.`
    );
  }

  pushSkipSummary(warnings, "had no usable SSH endpoint", noEndpointSkipped);
  pushSkipSummary(warnings, "had an empty name", emptyNameSkipped);
  pushSkipSummary(warnings, "had an invalid port", invalidPortSkipped);

  // FIX 2 — a truncated fetch (provider hit its own hard cap) never reflects
  // the full source inventory: treating the devices it didn't reach as
  // "absent" would prune servers whose devices are simply unseen this sync,
  // not deleted. Skip the whole prune phase and say so.
  if (tree.truncated) {
    warnings.push("Inventory was truncated — prune skipped this sync.");
  } else {
    // FIX 6 — the orphan target folder is constant for the whole sync (it only
    // depends on `source`, never on the individual pruned server), so a
    // normalization failure is computed ONCE up front and reported in a single
    // warning naming the path and how many servers it affected — not once per
    // pruned server. Phrasing is deliberately neutral ("could not be
    // created") since normalizeFolderPath can reject a path for reasons other
    // than exceeding the maximum depth (e.g. invalid segments).
    let orphanGroupForPrune: string | undefined;
    let orphanFallbackCandidate: string | undefined;
    let orphanFallbackCount = 0;
    if (source.prunePolicy === "orphan") {
      const candidate = source.targetFolder ? `${source.targetFolder}/${ORPHAN_FOLDER_NAME}` : ORPHAN_FOLDER_NAME;
      const normalizedCandidate = normalizeFolderPath(candidate);
      if (normalizedCandidate === undefined) {
        orphanFallbackCandidate = candidate;
        orphanGroupForPrune = source.targetFolder ? source.targetFolder : undefined;
      } else {
        orphanGroupForPrune = normalizedCandidate;
      }
    }

    // Prunes: owned servers whose device did not reappear in this fetch.
    for (const [externalId, server] of ownedByExternalId.entries()) {
      if (presentExternalIds.has(externalId)) {
        continue;
      }
      if (source.prunePolicy === "delete") {
        prunes.push({ policy: "delete", server });
      } else if (source.prunePolicy === "orphan") {
        // Origin is KEPT on the orphaned copy: a reappearing device matches by
        // externalId regardless of where the server currently sits, and its
        // group is source-owned so the next sync moves it back automatically.
        prunes.push({ policy: "orphan", server, after: { ...server, group: orphanGroupForPrune } });
        if (orphanGroupForPrune !== undefined) {
          folderSet.add(orphanGroupForPrune);
        }
        if (orphanFallbackCandidate !== undefined) {
          orphanFallbackCount++;
        }
      } else {
        prunes.push({ policy: "keep", server });
      }
    }

    if (orphanFallbackCandidate !== undefined && orphanFallbackCount > 0) {
      warnings.push(
        `The orphan folder path "${orphanFallbackCandidate}" for source "${source.name}" could not be created; ${orphanFallbackCount} orphaned server${orphanFallbackCount === 1 ? " was" : "s were"} left at the source's target folder instead.`
      );
    }
  }

  if (source.targetFolder) {
    folderSet.add(source.targetFolder);
  }

  const hiddenPruneCount = prunes.filter((p) => p.server.isHidden).length;

  return {
    sourceId: source.id,
    syncedAt: now,
    adds,
    updates,
    prunes,
    unchangedCount,
    folders: [...folderSet],
    warnings,
    hiddenPruneCount,
    manualDuplicateCount,
    adoptionCandidateNames
  };
}

/**
 * F19: derives the application entirely from the plan — no targetFolder
 * parameter. FINDINGS D/E — `expectedSource` must be the exact
 * InventorySourceConfig the plan was computed against (the fetch-time
 * snapshot); it flows straight through to `NexusCore.applyInventorySyncPlan`,
 * which throws if the record has since changed.
 */
export function planToApplication(plan: InventorySyncPlan, expectedSource: InventorySourceConfig): InventorySyncApplication {
  const upsertServers: ServerConfig[] = [
    ...plan.adds,
    ...plan.updates.map((u) => u.after),
    ...plan.prunes.filter((p): p is { policy: "orphan"; server: ServerConfig; after: ServerConfig } => p.policy === "orphan").map((p) => p.after)
  ];
  const removeServerIds = plan.prunes.filter((p) => p.policy === "delete").map((p) => p.server.id);
  return {
    sourceId: plan.sourceId,
    syncedAt: plan.syncedAt,
    upsertServers,
    removeServerIds,
    folders: [...plan.folders],
    expectedSource
  };
}

/** Server ids whose secrets (password/passphrase/proxy-password) must be wiped from SecretStorage — "delete" policy only. */
export function prunedServerIdsForSecretCleanup(plan: InventorySyncPlan): string[] {
  return plan.prunes.filter((p) => p.policy === "delete").map((p) => p.server.id);
}

/**
 * F8: runtime shape check for a fetched InventoryTree — providers are
 * external code (built-in or third-party via the public API) and their
 * output must not be trusted at the contract boundary. Throws a plain Error
 * describing exactly which field is wrong; syncNow (Chunk B) wraps the
 * message as an InventoryProviderError("protocol", ...).
 */
export function validateInventoryTree(tree: unknown): asserts tree is InventoryTree {
  if (typeof tree !== "object" || tree === null) {
    throw new Error("tree is not an object");
  }
  const obj = tree as Record<string, unknown>;
  if (obj.contractVersion !== 1) {
    throw new Error(`unsupported contractVersion "${String(obj.contractVersion)}"`);
  }
  if (!Array.isArray(obj.devices)) {
    throw new Error("devices is not an array");
  }
  obj.devices.forEach((device: unknown, i: number) => {
    if (typeof device !== "object" || device === null) {
      throw new Error(`devices[${i}] is not an object`);
    }
    const d = device as Record<string, unknown>;
    if (typeof d.externalId !== "string") {
      throw new Error(`devices[${i}].externalId is not a string`);
    }
    if (typeof d.name !== "string") {
      throw new Error(`devices[${i}].name is not a string`);
    }
    if (d.folderPath !== undefined && typeof d.folderPath !== "string") {
      throw new Error(`devices[${i}].folderPath is not a string`);
    }
    if (!Array.isArray(d.endpoints)) {
      throw new Error(`devices[${i}].endpoints is not an array`);
    }
    d.endpoints.forEach((endpoint: unknown, j: number) => {
      if (typeof endpoint !== "object" || endpoint === null) {
        throw new Error(`devices[${i}].endpoints[${j}] is not an object`);
      }
      const e = endpoint as Record<string, unknown>;
      if (typeof e.kind !== "string") {
        throw new Error(`devices[${i}].endpoints[${j}].kind is not a string`);
      }
      if (typeof e.host !== "string") {
        throw new Error(`devices[${i}].endpoints[${j}].host is not a string`);
      }
      if (e.port !== undefined && typeof e.port !== "number") {
        throw new Error(`devices[${i}].endpoints[${j}].port is not a number`);
      }
      if (e.username !== undefined && typeof e.username !== "string") {
        throw new Error(`devices[${i}].endpoints[${j}].username is not a string`);
      }
    });
  });
  if (obj.warnings !== undefined && (!Array.isArray(obj.warnings) || !obj.warnings.every((w: unknown) => typeof w === "string"))) {
    throw new Error("warnings is not a string array");
  }
  if (obj.truncated !== undefined && typeof obj.truncated !== "boolean") {
    throw new Error("truncated is not a boolean");
  }
}
