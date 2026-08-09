import type { AuthProfile, DetachedServerOrigin, ServerConfig, ServerOrigin } from "../../models/config";
import { authProfileNeedsServerKeyPath, serverOriginStampsEqual } from "../../models/config";
import type { InventoryDevice, InventorySourceConfig, InventoryTree } from "../../models/inventory";
import type { InventorySyncApplication } from "../../core/nexusCore";
import { normalizeFolderPath } from "../../utils/folderPaths";
import { isAddressValue } from "../profileTokens";
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
   * Anything but `"adopt"` — declined, or nobody asked — is today's behavior
   * field for field on the PLAN: every host:port collision renders the existing
   * duplicate warning and increments `manualDuplicateCount`, and no record
   * changes ownership. It is NOT bit-for-bit on `warnings`, deliberately: a
   * marker that matched and could not be acted on is reported in every state
   * (see the warnings at the end of the adoption block, and the REVIEW FINDING
   * on `InventoryAdoptionChoice` for why declining does not silence them).
   *
   * The engine NEVER decides this for itself. Adoption hands an existing
   * record's whole lifecycle — its name, address, folder, and the source's
   * prune policy, `delete` included — to the source, which is a decision only
   * the user can make. The caller asks once per sync run and feeds the answer to
   * every recompute; that is also why `adoptionCandidates` is computed
   * regardless of this answer, since the plan the caller asks FROM is one
   * computed before there is an answer at all.
   */
  adoptionChoice?: InventoryAdoptionChoice;
  /**
   * ADOPT 1 / REVIEW FINDING (P1, cross-instance adoption) — WHICH DEPLOYMENT of
   * `source.providerId` this sync is talking to, as
   * `resolveProviderInstanceKey(provider, source.config)` reports it
   * (models/inventory.ts). Compared against `formerlySynced.instanceKey` to
   * decide adoption eligibility.
   *
   * SUPPLIED BY THE CALLER, for the reason `authProfile` is: only the provider
   * can derive it, and this function is pure with no registry access. Derived
   * FRESH from the source config each plan is computed against — never stamped
   * on the source record — so it always describes the endpoint the fetch that
   * produced `tree` actually came from, and cannot be left behind by an edit or
   * forged by a hand-written import that changes `config` without changing a
   * cached copy beside it.
   *
   * `undefined` means "this provider offers no instance identity" (it does not
   * implement `instanceKey`, or its answer was rejected — see
   * `resolveProviderInstanceKey`). NOTHING IS ADOPTED in that state: see the
   * eligibility rule in the device loop for why the alternative — falling back to
   * the provider id — is the defect this input exists to remove.
   */
  providerInstanceKey?: string;
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
 *  - `undefined` — the question was never put.
 *
 * THE ENGINE ACTS ON `"adopt"` AND ONLY ON IT: `"decline"` and `undefined`
 * produce identical plans, warnings included. Both values are still carried
 * because the CALLER's states are genuinely different (dismissing the question
 * aborts the run; declining proceeds to the preview), and a plan computed from
 * the answer the user actually gave is the one the preview is allowed to render.
 *
 * REVIEW FINDING (P2, refusal warnings for non-candidates) — `"decline"` used to
 * silence the ambiguity and moved-address refusals as well, on the reasoning
 * that a user who has just answered the question does not need it explained back
 * to them. That reasoning does not survive contact with the branch structure it
 * was written for: the question counts and names CLEAN CANDIDATES ONLY, and a
 * clean candidate takes the adoption branch, so the only devices those warnings
 * were ever about are the ones the question never mentioned. A run carrying one
 * clean candidate and one ambiguous or re-addressed match therefore turned an
 * answer about the first into silence about the second, which is the same
 * unexplained duplicate the never-asked case was fixed for. Declining is consent
 * to duplicate the devices that were named; it is not consent to say nothing
 * about the ones that were not.
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
   * ADOPT 1 — every adoption CANDIDATE, in tree order: a device that matches
   * exactly one eligible kept server.
   *
   * Computed REGARDLESS of `adoptionChoice`, because the caller decides whether
   * to put the question to the user from a plan computed BEFORE there is an
   * answer — that is the only plan it has when the question arises. `.length` is
   * the candidate count; `deviceName` is what the question names examples from
   * (callers cap the render at 3, per `pushSkipSummary`'s precedent). On an
   * `"adopt"` run these are exactly the pairs that became adoptions.
   */
  adoptionCandidates: InventoryAdoptionCandidate[];
}

/**
 * ADOPT 1 / REVIEW FINDING (P1, re-ask when adoption candidates change) — ONE
 * adoption candidate, named on BOTH halves of the pairing an adoption would
 * create: the device, and the kept server it would reclaim.
 *
 * PAIR-SHAPED for the reason `adoptionPairKeys` (commands/inventoryCommands.ts)
 * is: the caller captures this set when it puts the adoption question, and an
 * answer collected for one set must never be applied to another. A count is not
 * an identity, and neither half alone is either — the same device can come to
 * claim a different record (a restore or config import replacing the kept
 * server), and the same record can come to be claimed by a different device (a
 * restore rewriting its marker). Both swaps keep the count, and the second keeps
 * the device names the question rendered.
 *
 * It carries the candidate as the plan KNOWS it, not as anything renders it —
 * the caller derives both the question's example names and its captured
 * comparison key from this one field, so the thing that was disclosed and the
 * thing that is compared can never come from two different derivations.
 */
export interface InventoryAdoptionCandidate {
  /** The device's name as the fetched tree reports it — the half the question shows. */
  deviceName: string;
  /** The device's stable identity in the source — what an adoption stamps as `ServerOrigin.externalId`. */
  externalId: string;
  /** `ServerConfig.id` of the kept server this device would reclaim — the record the adoption hands over. */
  serverId: string;
  /**
   * REVIEW FINDING (P2) — true when DECLINING adopts nothing AND adds nothing:
   * the adoptee is itself the record holding `deterministicServerId(source.id,
   * externalId)`, so the add this device would otherwise produce is skipped by
   * the collision fall-through instead (with its own warning). The state a
   * restored ID-preserving backup lands in, and the only state in which the
   * "adds each device as a separate new server" half of the question would be
   * false — which is why the fact rides on the candidate rather than being
   * re-derived by whoever renders it. False means the decline genuinely adds:
   * every other `continue` between here and `adds.push` is upstream of this
   * push, so a candidate with no id collision always reaches the add.
   *
   * NOT part of `adoptionCandidateKeys`, and that is not an oversight: the flag
   * is a pure function of the pair the key already carries (`serverId ===
   * deterministicServerId(source.id, externalId)`), so it cannot change under a
   * captured answer without the pair changing with it.
   */
  separateAddBlocked: boolean;
}

function joinTargetAndRel(targetFolder: string, rel: string | undefined): string | undefined {
  if (!rel) {
    return targetFolder || undefined;
  }
  return targetFolder ? `${targetFolder}/${rel}` : rel;
}

/**
 * Selects the endpoint the sync maps to a server's SSH address: the FIRST
 * endpoint with kind "ssh" and a non-empty host, regardless of its position
 * among the device's other endpoint kinds (`url` is accepted on the tree but
 * never mapped; the management kinds are mapped by the sibling below).
 */
function selectSshEndpoint(device: InventoryDevice) {
  return device.endpoints.find((e) => e.kind === "ssh" && e.host.length > 0);
}

/**
 * Selects the endpoint the sync maps to `ServerConfig.ipmiHost`: the FIRST
 * endpoint with kind "redfish" or "ipmi-sol" and a non-empty host.
 *
 * BOTH KINDS, deliberately. The NetBox provider emits `"redfish"` for `oob_ip`
 * because that address is a generic BMC address and `ipmiHost` documents itself
 * as "IPMI / BMC / Redfish" — but a third-party provider through the public
 * API may reasonably call the same thing `"ipmi-sol"`, and the two must map
 * identically rather than depending on which word a provider author picked.
 *
 * No port handling: `ServerConfig.ipmiHost` is a single string, and every
 * synced value is a bare address. (The field's ADDRESS rule does admit a
 * `host:port` suffix, but only as a HAND-ENTERED shape — nothing on this path
 * ever produces one.)
 */
function selectManagementEndpoint(device: InventoryDevice) {
  return device.endpoints.find((e) => (e.kind === "redfish" || e.kind === "ipmi-sol") && e.host.length > 0);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * OOB — may this sync WRITE `ServerConfig.ipmiHost` on an existing owned
 * server? Asked only when the device actually supplies a management endpoint
 * this fetch; the caller's own `mgmtHost !== undefined` guard is the sixth row
 * of the matrix below.
 *
 * WHICH DISCIPLINE, AND WHY IT IS NOT `host`/`port`'s. Name/host/port/group are
 * "always taken from the device" because no user ever hand-typed them into a
 * synced record — the sync created them. `ipmiHost` is the opposite case: it
 * shipped as a hand-edited field months before any sync could write it, so
 * "device always wins" would clobber every early adopter's manual entry on the
 * first post-upgrade sync, and a device with NO out-of-band endpoint would read
 * as "the field should be empty" and erase one. This is therefore the
 * `syncedUsername`/`syncedAuthProfileId` discipline instead: the stamp records
 * what the SYNC wrote, and the sync writes only where the record still carries
 * exactly that.
 *
 * The whole matrix (`cur` = ownedServer.ipmiHost, `stamp` =
 * origin.syncedIpmiHost, `oob` = this fetch's management host), and what each
 * row is defending against:
 *
 *  1. cur unset,  stamp unset,  oob present  → WRITE + stamp. Never configured:
 *     the fill-it-in state, exactly as `syncedAuthProfileId === undefined &&
 *     authProfileId === undefined` is for retro-apply.
 *  2. cur unset,  stamp set,    oob present  → LEAVE ALONE. The user CLEARED a
 *     value the sync wrote — the per-server opt-out, verbatim from retro-apply's
 *     opt-out clause. Without it, clearing the field is impossible: the next
 *     sync refills it forever.
 *  3. cur === stamp,            oob different → WRITE + re-stamp. Still exactly
 *     what the sync put there, so the sync still owns it and a BMC re-addressed
 *     in NetBox follows.
 *  4. cur ≠ stamp,              oob present  → LEAVE ALONE, carry the stamp
 *     forward. A hand edit, and it is never laundered into the stamp — a stamp
 *     is never inferred from the record's current value, or the edit would read
 *     as "as stamped" one sync later and be overwritten by the sync after that.
 *  5. cur set, stamp unset,     oob present  → LEAVE ALONE. A legacy/Phase-1
 *     hand entry: an ABSENT stamp must not mean "the sync owns this". (The
 *     accepted asymmetry against `syncedUsername`, which falls back to the
 *     source's `defaultUsername` — there is no `defaultIpmiHost` to fall back
 *     to, so absent simply means hands-off.)
 *  6. anything,   anything,     oob ABSENT   → NEVER touch `ipmiHost`; carry the
 *     stamp forward (the caller's guard). Mirrors the provider's own never-drop
 *     stance: losing an address at the source is routine maintenance, not a
 *     deletion. Accepted staleness — a genuinely decommissioned BMC keeps its
 *     last-known address until the user clears it, which is row 2's opt-out.
 *
 * Rows 1 and 3 are the two the sync may write, and both reduce to one question:
 * is the record still carrying exactly what the sync last put there? Rows 2, 4
 * and 5 are the three ways the answer is no.
 */
function syncOwnsIpmiHost(current: string | undefined, stamp: string | undefined): boolean {
  return current === stamp;
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
 * AUTH 2 / REVIEW FINDING (P2, detached auth opt-outs) — "which profile did a
 * SYNC last apply to this server?", asked of an owned server and of a kept one
 * by the one function that can answer for both.
 *
 * WHAT THE ANSWER DECIDES. Beside a cleared `authProfileId`, a defined answer
 * means the sync linked that profile and the USER took it off — the per-server
 * opt-out — while `undefined` means no sync ever put a profile there, which is
 * precisely the state retro-apply exists to fill. Nothing else can tell those
 * two apart: both records carry no link at all.
 *
 * ONE FIELD PER RECORD SHAPE, AND NEVER BOTH. An owned server answers from its
 * `origin` stamp; a kept server — which by definition has no origin — answers
 * from the copy the detach preserved for exactly this reader
 * (`DetachedServerOrigin.syncedAuthProfileId`, models/config.ts). The marker is
 * consulted ONLY in the absence of an origin, which keeps the documented rule
 * that a record carrying both is inert rather than dangerous: an origin-bearing
 * server with a stale marker beside it answers from its origin, exactly as it
 * did before this function existed.
 *
 * THE FINDING THIS CLOSES. Without the marker half, the opt-out survived the
 * detach as data and died as behaviour. A user who cleared a sync-applied
 * profile and THEN removed the source with Keep Servers had it silently
 * re-attached by the adoption — the predicate saw an origin-less record with no
 * link and read it as "never configured" — while the identical clear made after
 * the adoption is respected on every later run. One decision, opposite outcomes,
 * settled by which side of a source removal it happened to fall on. Preserving
 * a receipt and then not reading it is the worst of both: the data says the user
 * opted out and the code overwrites anyway.
 */
function lastSyncAppliedProfileId(server: ServerConfig): string | undefined {
  return server.origin !== undefined ? server.origin.syncedAuthProfileId : server.formerlySynced?.syncedAuthProfileId;
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
 *
 * REVIEW FINDING (P2, detached auth opt-outs) — the "did a sync link one here"
 * clause reads `lastSyncAppliedProfileId`, not the origin stamp directly, so a
 * kept server's answer comes from the receipt the detach preserved rather than
 * from the origin it no longer has. That is the ONE clause an adoptee could
 * previously never fail, and failing it is what makes an opt-out made before the
 * source was removed mean the same thing as one made after. See that function
 * for why absent-marker and absent-stamp must keep reading identically, and the
 * adoption call site for what the restored stamp then does on the NEXT sync.
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
    lastSyncAppliedProfileId(server) === undefined &&
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

/**
 * ADOPT 1 / REVIEW FINDING (P1, cross-instance adoption) — "was this marker left
 * by a source pointed at the SAME provider deployment this sync is talking to?".
 * The single sentence the whole adoption-ownership rule now turns on, extracted
 * so it cannot be written twice and answered two ways.
 *
 * BOTH SIDES MUST BE PRESENT AND EQUAL. Written as a plain `===` this would read
 * `undefined === undefined` as a match, which is precisely the wrong answer in
 * the two states where a key is missing:
 *  - the marker has none — a provider with no instance identity wrote it, or a
 *    build of this unreleased branch from before the field existed did;
 *  - this source has none — `resolveProviderInstanceKey` returned `undefined`,
 *    i.e. the provider does not implement `instanceKey` (or returned something
 *    unusable).
 * In either state Nexus does not know whether the two name the same deployment, and
 * "we cannot tell" must never be spelled the same way as "we checked, they
 * match" — that is the same class of mistake as `providerId`-only matching, just
 * reached by an absent field instead of a coarse one.
 *
 * THE THIRD-PARTY QUESTION, DECIDED HERE AND VISIBLE HERE: a provider that
 * offers no instance identity gets NO adoption, rather than falling back to the
 * old provider-kind check for it. The public provider API is experimental
 * (services/inventory/publicApi.ts) and binds by string id with no publisher
 * check, so the fallback would leave the defect fully intact for exactly the
 * providers Nexus can verify least about, and would do it silently. The cost of
 * refusing is bounded and self-explaining — the sync adds the device as a new
 * server, the plan says why, and no record changes hands — while the cost of the
 * fallback is a server, and its credentials, moving to a source that never
 * synced it. Adoption is a convenience; not losing a record is not. Providers
 * opt back in by implementing one pure method.
 */
function sameProviderInstance(kept: DetachedServerOrigin, providerInstanceKey: string | undefined): boolean {
  return providerInstanceKey !== undefined && kept.instanceKey !== undefined && kept.instanceKey === providerInstanceKey;
}

/**
 * Up to 3 quoted names, in the order they were collected — the example-list
 * shape every aggregate warning in this file uses. Extracted so the adoption
 * refusal summaries (REVIEW FINDING, P1) render their examples exactly as
 * `pushSkipSummary` renders its own, rather than approximately.
 */
function namedExamples(names: string[]): string {
  return names
    .slice(0, 3)
    .map((s) => `"${s}"`)
    .join(", ");
}

/** N1 — appends one summary warning for a category of non-owned device skips, naming up to 3 examples. No-op when the category is empty. */
function pushSkipSummary(warnings: string[], reason: string, examples: string[]): void {
  const count = examples.length;
  if (count === 0) {
    return;
  }
  warnings.push(`${count} device${count === 1 ? "" : "s"} ${reason} and ${count === 1 ? "was" : "were"} skipped (e.g. ${namedExamples(examples)}).`);
}

/**
 * Pure: fetch result (InventoryTree) + current server set -> InventorySyncPlan.
 * No vscode import, no I/O — `now` is injected so callers control the sync
 * timestamp (and tests get determinism).
 */
export function computeSyncPlan(input: ComputeSyncPlanInput): InventorySyncPlan {
  const { source, tree, currentServers, now } = input;
  // ADOPT 1 — the one question the loop below asks of the answer. Declining and
  // never having been asked are deliberately the same thing HERE (see
  // `InventoryAdoptionChoice`): the two differ only to the caller.
  const adoptKeptServers = input.adoptionChoice === "adopt";
  /** REVIEW FINDING (P1) — see `ComputeSyncPlanInput.providerInstanceKey` and `sameProviderInstance`. */
  const providerInstanceKey = input.providerInstanceKey;
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
   * Three clauses scope it:
   *  - `origin === undefined`: a server owned by ANY source (this one, another
   *    live one, or a dangling reference) is never adopted. Two sources tugging
   *    at one record is what the ownership model (F6, first-owner-wins) exists
   *    to prevent, and it also makes a record carrying BOTH `origin` and a stale
   *    marker inert rather than dangerous.
   *  - `providerId`: only a source of the same provider may claim a marker, so a
   *    marker left by one KIND of source can never be claimed by another.
   *  - `instanceKey`: and only a source pointed at the same DEPLOYMENT of that
   *    provider — see `sameProviderInstance` below, which is where the real work
   *    of this rule now lives.
   *
   * REVIEW FINDING (P1, cross-instance adoption) — `providerId` used to be the
   * whole of the identity clause, and it is not enough. `externalId` is unique
   * only within one deployment: two NetBox instances both emit "device:1", and
   * the endpoint corroboration below cannot separate them either, because
   * 10.0.0.1:22 is the most ordinary private endpoint there is. A lab instance
   * beside a production one — this extension's own audience — was therefore
   * enough to make instance B's "device:1 at 10.0.0.1:22" adopt the server
   * instance A had kept, silently transferring a record (and its stored
   * password, passphrase and proxy credentials, which follow the surviving id)
   * to a source that had never seen that machine and whose prune policy could
   * then delete it.
   */
  const keptByExternalId = new Map<string, ServerConfig[]>();
  /**
   * REVIEW FINDING (P1) — the markers this source is REFUSED, not the ones it
   * ignores: same provider, naming a device in this tree, but from a different
   * deployment (or from one nothing recorded). Kept separately from
   * `keptByExternalId` purely so the refusal can EXPLAIN ITSELF — see the
   * aggregate warnings after the device loop. Nothing in this map is ever
   * adoptable; membership is a reason to talk, never a reason to act.
   */
  const foreignInstanceByExternalId = new Map<string, ServerConfig[]>();
  for (const server of currentServers) {
    const kept = server.formerlySynced;
    if (server.origin !== undefined || kept === undefined || kept.providerId !== source.providerId) {
      continue;
    }
    const index = sameProviderInstance(kept, providerInstanceKey) ? keptByExternalId : foreignInstanceByExternalId;
    const bucket = index.get(kept.externalId);
    if (bucket) {
      bucket.push(server);
    } else {
      index.set(kept.externalId, [server]);
    }
  }
  /** ADOPT 1 — see `InventorySyncPlan.adoptionCandidates`. Filled in BOTH modes. */
  const adoptionCandidates: InventoryAdoptionCandidate[] = [];
  /**
   * REVIEW FINDING (P1, cross-instance adoption) — the two refusal buckets, both
   * aggregated into ONE warning each after the loop rather than one line per
   * device. The population here is systematically large in the exact scenario
   * the rule exists for: a second instance of the same provider assigns the same
   * ids from 1, so EVERY device can match a kept marker, and a per-device
   * sentence would bury the rest of the plan under hundreds of identical lines.
   *
   * Both are recorded only for markers whose ADDRESS also still matches the
   * device — the population that would have been adopted if the instance had
   * matched, and therefore the only one whose refusal a user could otherwise
   * mistake for a bug. A kept record from another instance at some unrelated
   * address is not something adoption was ever going to touch, and saying so
   * would be noise about a non-event.
   */
  const instanceMismatchDeviceNames: string[] = [];
  const noInstanceIdentityDeviceNames: string[] = [];
  /** The instances those refused markers DID name, so the warning can show what to compare against. */
  const recordedForeignInstances = new Set<string>();
  let sawUnrecordedInstance = false;

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

    // OOB — the out-of-band management address this fetch offers for
    // `ServerConfig.ipmiHost`, or `undefined` when the device supplies none
    // (matrix row 6 in `syncOwnsIpmiHost`) or supplies one nothing can use.
    //
    // VALIDATED HERE, at sync time, even though USE time remains the real
    // chokepoint (`validateTokenValue`, services/profileTokens.ts, which refuses
    // a hostile value on every single run whatever wrote it). Storing a value
    // that chokepoint will always refuse helps nobody, and this is the only
    // moment at which the user can connect the bad value to the device it came
    // from — after the write it is just a broken field on a server. The SAME
    // validator the chokepoint uses, deliberately: two answers to "is this a
    // legal ipmiHost?" in one codebase is worse than one that is slightly
    // wider than this path needs (it also admits a `:port` suffix, which a
    // synced bare address never carries).
    //
    // The device's SSH mapping is untouched by this — a device whose `oob_ip` is
    // garbage still syncs, it just does not get a BMC address.
    let mgmtHost: string | undefined;
    const mgmtEndpoint = selectManagementEndpoint(device);
    if (mgmtEndpoint) {
      if (isAddressValue(mgmtEndpoint.host)) {
        mgmtHost = mgmtEndpoint.host;
      } else {
        warnings.push(
          `Device "${device.name}" (${device.externalId}) has an out-of-band address that cannot be used ("${mgmtEndpoint.host}") — ignored.`
        );
      }
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
      // device; username only when the endpoint supplies one, and `ipmiHost`
      // only when the sync still owns it. Everything else (authProfileId,
      // keyPath, proxy, multiplexing, isHidden, logSession, ...) is copied
      // untouched from `before`.
      //
      // OOB — decided HERE, before `afterOrigin` is built, so the stamp can go
      // INTO that literal. The retro-apply and rollback branches below both
      // REBUILD the origin as `{ ...afterOrigin, syncedAuthProfileId: … }`, so
      // anything stamped onto `after.origin` between the literal and those
      // branches is silently discarded when either fires. Every stamp the
      // update path writes therefore belongs in the one literal; see
      // `syncOwnsIpmiHost` for the write rule and the whole matrix.
      const takesIpmiHost = mgmtHost !== undefined && syncOwnsIpmiHost(ownedServer.ipmiHost, ownedServer.origin?.syncedIpmiHost);
      const afterOrigin: ServerOrigin = {
        sourceId: source.id,
        externalId: device.externalId,
        syncedAt: now,
        // REVIEW FINDING (P1, adoption instance identity) — REFRESHED from this
        // run, never carried forward. The two stamps below record "what this sync
        // WROTE" and carry forward where it wrote nothing; this one records
        // "which deployment this sync READ the device from", and a sync that
        // reaches this line has read it from `providerInstanceKey` by definition.
        // So there is no carry-forward case: a source repointed from deployment A
        // to B re-stamps every server it still owns on the first sync against B,
        // which is what keeps the marker a later detach copies honest. Writing
        // `undefined` when the provider names no instance is likewise the truth
        // of this run — carrying A forward would re-assert an identity nothing
        // verified, against a config that may since have moved.
        syncedInstanceKey: providerInstanceKey,
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
        syncedAuthProfileId: ownedServer.origin?.syncedAuthProfileId,
        // OOB — the same "records what the sync wrote" discipline one field
        // down: refreshed exactly where this sync writes `ipmiHost` (the
        // `takesIpmiHost` line below), and otherwise carried forward VERBATIM.
        // Carry-forward is load-bearing rather than cosmetic, for the reason
        // spelled out for `syncedAuthProfileId` above: an update fired for a
        // totally unrelated reason — a device renamed at the source — rebuilds
        // `origin` from scratch, and a rebuild that forgot this member would
        // erase the user's cleared-value opt-out (matrix row 2) and let the very
        // next sync refill the field they emptied. Carried forward as
        // `undefined` too, which is what keeps a Phase-1 hand entry hands-off.
        syncedIpmiHost: takesIpmiHost ? mgmtHost : ownedServer.origin?.syncedIpmiHost
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
      if (takesIpmiHost) {
        after.ipmiHost = mgmtHost;
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
      //
      // OOB — `ipmiHost` joins for the same reason `authProfileId` did, and its
      // stamp rides in on the `serverOriginStampsEqual` line, which is what
      // catches AUTH 3a's shape here: an `after` whose only difference is a
      // freshly computed `syncedIpmiHost` must not be discarded as "unchanged",
      // or the server never gains a stamp and every later sync reads it as a
      // hand entry. (Under the matrix the two clauses currently agree on every
      // reachable input — the sync only rewrites a value it still owns, so a
      // changed value implies a changed stamp — and the value clause is kept
      // regardless: it states the plainly-visible half of the change and does
      // not depend on that argument staying true.)
      const changed =
        ownedServer.name !== after.name ||
        ownedServer.host !== after.host ||
        ownedServer.port !== after.port ||
        ownedServer.group !== after.group ||
        ownedServer.authProfileId !== after.authProfileId ||
        ownedServer.ipmiHost !== after.ipmiHost ||
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

    // ADOPT 1 — the kept-server match, and the adoption it can produce.
    //
    // COMPUTED BEFORE THE ID-COLLISION GUARD BELOW, and read by it. Deciding
    // eligibility here does not act on it: nothing between this line and the
    // adoption block writes a record, so the only thing moving the computation up
    // buys is that the collision guard can ask whether the record it is about to
    // refuse IS the adoptee (REVIEW FINDING, P2 — see there).
    //
    // ELIGIBILITY, all of it: the server carries a "Keep Servers" marker naming
    // THIS device, left by a source of this provider pointed at the SAME
    // DEPLOYMENT of it (the index above, and `sameProviderInstance`), AND its
    // CURRENT address is still the device's address. The marker plus the
    // instance establishes identity; the address corroborates it.
    //
    // WHY CORROBORATE AT ALL, now that the instance is checked. The instance key
    // is what makes "device:1" mean one machine instead of one machine per
    // deployment, so it carries the identity argument that the address check
    // used to be asked to carry alone — and could not: `externalId` is unique
    // only within one instance, two NetBox deployments both emit "device:1", and
    // 10.0.0.1:22 is the most ordinary private endpoint there is, so "same id
    // AND same address" was satisfied by a lab instance sitting beside a
    // production one (REVIEW FINDING, P1). The address check stays as a SECOND
    // signal, doing the job it is actually good at: catching a marker that has
    // drifted from the record it describes — a kept server hand-edited to a
    // different host, or a device re-IP'd at the source — where re-linking would
    // point this source at a machine the user has since moved.
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
    // address) fire in EVERY state, whatever the answer — REVIEW FINDING, twice
    // over. They first required the adopt flag, which cannot be set unless the
    // question was asked, which the caller only asks when the plan reports a
    // CANDIDATE — and neither refusal is a candidate. So the exact two shapes
    // this copy was written for (the re-IP'd lab, the accidental second marker)
    // were the two that produced a silent duplicate set. The narrower repair
    // that followed — fire unless the user DECLINED — kept the same defect for
    // the same reason one layer down (REVIEW FINDING, P2): the question names
    // clean candidates only, and a clean candidate never reaches these branches,
    // so declining could only ever silence devices the user was told nothing
    // about. A run with one clean candidate beside one ambiguous match is the
    // whole of it, and it is ordinary. The two-marker state is reachable through
    // this feature's own happy path: Keep Servers → re-add → Add Separately →
    // apply → remove that source with Keep Servers again leaves two markers
    // naming one device at one address.
    const keptMatches = keptByExternalId.get(device.externalId) ?? [];
    const eligibleForAdoption = keptMatches.filter((s) => s.host.toLowerCase() === endpoint.host.toLowerCase() && s.port === port);

    // Never adopt/overwrite a server whose origin doesn't match this
    // source, even if its id happens to collide with the deterministic id
    // this device would produce (hand-imported fragment, or a collision
    // across two different sources sharing a namespace by coincidence).
    //
    // REVIEW FINDING (P2) — ONE record is exempt, and the exemption is written as
    // narrowly as it can be written: the collider must BE the device's uniquely
    // eligible adoptee, compared by object identity against the single entry of
    // `eligibleForAdoption`. Anything wider re-opens the ownership transfer the
    // two P1 findings above spent their whole argument closing, so the shape of
    // this condition is the safety property — not the fact that some exemption
    // exists.
    //
    // WHY IT IS NEEDED. Restore an ID-PRESERVING backup taken while a source was
    // live, then remove that source with Keep Servers and add it back: the kept
    // servers still carry `deterministicServerId(source.id, externalId)` from the
    // sync that created them, and a restored source record carries its original
    // id too. So the id this device computes is already taken — by the very
    // record the marker points at. Refusing there meant the guard treated the
    // intended adoptee as an unrelated collider, skipped before eligibility was
    // ever consulted, and no adoption could be offered at all: the one path that
    // reconnects a restored source to its own servers was closed by a rule about
    // servers belonging to somebody else.
    //
    // WHY IT CANNOT BE WIDENED, clause by clause:
    //  - `eligibleForAdoption.length === 1` — with two eligible records the plan
    //    refuses to guess which is canonical (the ambiguity branch below), so
    //    there is no "that exact server" to exempt and the device is skipped.
    //    Skipped, note, is all it is: the refusal below says WHOSE record the
    //    collider is before it says anything else, so a collider among several
    //    kept copies of this device is never reported as an unrelated one.
    //  - `=== collidingServer` — the collider itself, not merely "some adoptable
    //    server exists for this device". Drop this and a device with an eligible
    //    adoptee ANYWHERE would be allowed to overwrite whatever unrelated record
    //    happens to hold its id, which is precisely the claim the guard exists to
    //    refuse.
    //  - membership in `eligibleForAdoption` already carries the full eligibility
    //    rule — no `origin`, a marker naming this device, this provider, this
    //    deployment, and the device's current address — so the exemption can
    //    never reach a hand-made server, a server owned by another source, or one
    //    kept from a different instance. It is not a second, weaker path to
    //    adoption; it is the same path, unblocked for the record it was about.
    //
    // AND IT STILL SKIPS UNLESS THE ADOPTION ACTUALLY HAPPENS. Passing this guard
    // only lets the device reach the adoption block; if the user declined (or has
    // not been asked yet) the fall-through below re-applies the skip, because the
    // add path would otherwise mint a second record under an id that is already
    // in use.
    const collidingServer = serversById.get(id);
    const collisionIsTheAdoptee = collidingServer !== undefined && eligibleForAdoption.length === 1 && eligibleForAdoption[0] === collidingServer;
    if (collidingServer !== undefined && !collisionIsTheAdoptee) {
      // REVIEW FINDING — THE REFUSAL NAMES THE RECORD IT IS ABOUT, instead of
      // asserting a relationship nothing had checked. "Unrelated" was pushed for
      // EVERY collision the exemption above did not cover, and in three reachable
      // states the record on the other end of the id is the device's own:
      //  - AMBIGUITY PLUS COLLISION. Two kept records claim one device and one of
      //    them holds the id. This guard runs before the ambiguity branch below,
      //    so its sentence is the one the user actually sees — about the very
      //    server their device was last synced onto.
      //  - A RESTORED ID-PRESERVING BACKUP WHOSE DEVICE MOVED. `eligibleForAdoption`
      //    is empty because the address no longer corroborates, so the exemption
      //    cannot apply and the moved-address explanation further down is never
      //    reached either (this branch `continue`s first). The single sentence the
      //    user got called their device's former server unrelated and offered no
      //    repair at all.
      //  - A STALE KEPT COPY HOLDING THE ID while a DIFFERENT kept copy sits at
      //    the device's address — two sources pointed at one deployment, both
      //    removed with Keep Servers, one of them restored under its old id.
      //
      // `keptMatches` is the check that was missing, and it is adoption's own
      // identity rule minus the address corroboration: no `origin`, this provider,
      // this DEPLOYMENT of it, and a marker naming THIS device. Minus the address
      // deliberately — the question this branch asks is "whose record is this?",
      // not "may it be adopted?", and a kept server that has moved is still the
      // record the device came from. A marker from ANOTHER deployment is not in
      // `keptMatches` and therefore keeps the unrelated wording, which is exactly
      // right: under the instance rule (the two P1 findings above) that record
      // belongs to a different machine which merely shares an id, and "unrelated
      // to this device" is what it is. The genuine cases — a hand-imported
      // fragment, a namespace collision across two sources — are untouched, and
      // their sentence stays as pointed as it was.
      //
      // EVERY REPAIR BELOW IS TRACED TO THE STATE IT PRODUCES, not merely offered
      // (an earlier round of this feature shipped advice that only worked from a
      // cancelled sync):
      //  - nothing kept at the device's address: re-pointing the collider makes it
      //    the UNIQUELY eligible adoptee — nothing else is at that address, or
      //    this branch would not have been taken — so the next sync exempts it,
      //    raises the question, and Adopt Existing reclaims it with its saved
      //    credentials. Deleting it instead frees the id and the device is added
      //    fresh. Editing a kept server preserves its marker (serverCommands.ts
      //    restores `formerlySynced` from the live record), which is what makes
      //    the first half of that advice work at all.
      //  - one kept copy at the device's address that is NOT the collider:
      //    deleting the collider leaves nothing holding the id, so the remaining
      //    copy becomes an ordinary candidate on the next run. The device is NOT
      //    adopted onto it today, deliberately — the exemption's shape is the
      //    safety property, and the collision fall-through's "reclaim that server"
      //    is only true while the collider IS the adoptee.
      //  - two or more at the device's address: the ambiguity refusal's own
      //    repair, restated for an outcome that is a skip rather than a duplicate,
      //    and reaching past that address because the copy holding the id need not
      //    be one of the ambiguous pair.
      //
      // NONE OF THEM SAYS "CANCEL", unlike the plain ambiguity refusal below:
      // applying this plan does nothing to this device, so the repair is equally
      // good before or after Apply. And the add is not withheld for want of a
      // nicer id — minting a different one would leave the next sync computing the
      // deterministic id again, finding it taken again, and adding another copy on
      // every run.
      const collisionIsOwnKeptRecord = keptMatches.includes(collidingServer);
      if (!collisionIsOwnKeptRecord) {
        warnings.push(`Device "${device.name}" (${device.externalId}) maps to an id already used by unrelated server "${collidingServer.name}" — skipped.`);
      } else if (eligibleForAdoption.length === 0) {
        warnings.push(
          `Device "${device.name}" (${device.externalId}) was previously synced onto server "${collidingServer.name}", which is now at ${collidingServer.host}:${collidingServer.port} while the device is at ${endpoint.host}:${port} — and it still uses the id a new server for this device would need, so the device is skipped rather than added as a new server. Point "${collidingServer.name}" back at ${endpoint.host}:${port} and sync again to reclaim it with Adopt Existing, or delete it and the next sync adds the device fresh.`
        );
      } else if (eligibleForAdoption.length === 1) {
        warnings.push(
          `Device "${device.name}" (${device.externalId}) matches server "${eligibleForAdoption[0].name}" kept from a removed inventory source at ${endpoint.host}:${port}, but server "${collidingServer.name}" — kept from an earlier sync of this same device, now at ${collidingServer.host}:${collidingServer.port} — still uses the id a new server for this device would need, so the device is skipped rather than offered for adoption. Delete "${collidingServer.name}", then sync again and choose Adopt Existing to reclaim "${eligibleForAdoption[0].name}".`
        );
      } else {
        warnings.push(
          `Device "${device.name}" (${device.externalId}) matches ${eligibleForAdoption.length} servers kept from a removed inventory source at ${endpoint.host}:${port}, so Nexus cannot tell which to adopt — and server "${collidingServer.name}", kept from an earlier sync of this same device, still uses the id a new server for this device would need, so the device is skipped rather than added as a duplicate. Remove every server kept for this device except the one at ${endpoint.host}:${port} you want to keep, then sync again and choose Adopt Existing.`
        );
      }
      continue;
    }

    if (eligibleForAdoption.length === 1) {
      const adoptee = eligibleForAdoption[0];
      // Recorded whatever the answer — it changes what the plan DOES with a
      // candidate, never whether it is one. Nothing claims/locks the adoptee
      // here: `device.externalId` is the index key, and the duplicate-externalId
      // guard earlier in this loop already skips any second device carrying the
      // same id, so one kept server can never be reached twice in one plan.
      //
      // BOTH HALVES, recorded where both are in hand (REVIEW FINDING, P1): the
      // adoptee this device resolved to is known right here and nowhere else,
      // and a caller that had only the name could not tell one candidate set
      // from another with the same names in it.
      //
      // THE THIRD HALF (REVIEW FINDING, P2) — whether declining actually yields
      // the separate add the question offers. `collisionIsTheAdoptee` is the
      // exemption evaluated a dozen lines up, reused verbatim rather than
      // re-derived: reaching this push means the guard either found no collider
      // or found this very adoptee holding the id, so the flag is exactly "the
      // adoptee already owns the id an add for this device would need" — and
      // that is precisely the state the fall-through below skips instead of
      // adding. Carried on the candidate so the caller can say so BEFORE the
      // choice, rather than leaving the engine's after-the-fact warning as the
      // only account of a promise it could not keep.
      adoptionCandidates.push({
        deviceName: device.name,
        externalId: device.externalId,
        serverId: adoptee.id,
        separateAddBlocked: collisionIsTheAdoptee
      });
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
          // REVIEW FINDING (P1, adoption instance identity) — this run's
          // deployment, which is by construction the one the marker recorded:
          // `sameProviderInstance` is what put this server in `keptByExternalId`
          // at all, so it is defined and equal to `adoptee.formerlySynced
          // .instanceKey` here. Stamped from `providerInstanceKey` rather than
          // read back off the marker so every origin-writing path in this file
          // states the same thing the same way — the marker is the copy, the
          // origin is the original.
          syncedInstanceKey: providerInstanceKey,
          // AUTH 2a, applied to a record this sync did not create: the stamps
          // record what THIS sync WROTE. It writes `username` only when the
          // endpoint supplies one, so otherwise it stamps none — never
          // `adoptee.username` (which launders the user's hand-picked username
          // into "as stamped", after which the NEXT sync would retro-apply the
          // source's profile over it) and never `source.defaultUsername` (a
          // value this sync did not write onto the record).
          syncedUsername: endpoint.username,
          // REVIEW FINDING (P1, adoption auth provenance) — RESTORED from the
          // marker, which is the removed source's own stamp preserved across the
          // detach (see `DetachedServerOrigin.syncedAuthProfileId`). Still never
          // `adoptee.authProfileId`, for the reason that was always given: a
          // hand-set link is history's doing and recording it would read as an
          // opt-out the user never made. The marker is a different thing — it is
          // a SYNC's record of a SYNC's link, and losing it at the detach is what
          // made an adopted server unrescuable.
          //
          // What it buys, concretely. A kept server that arrives still carrying
          // the profile its former source applied keeps `authProfileId` through
          // the adoption (the `...adoptee` spread — a credential this sync did
          // not choose), and retro-apply below cannot supply the matching stamp
          // because it does not run while a link is set. Stamping `undefined`
          // there produced a record that says "the user linked this", so if that
          // key profile later lost its key file AUTH 2b refused to unlink it and
          // the server could not connect at all, with no sync able to repair it;
          // and clearing the link by hand did not read as an opt-out either, so
          // the next sync reattached it. Restoring makes both rules see what
          // actually happened.
          //
          // Overwritten below if — and only if — retro-apply fires in this same
          // plan, i.e. where this sync actually writes the link itself; the value
          // it writes then is the one that is true of the record afterwards.
          syncedAuthProfileId: adoptee.formerlySynced?.syncedAuthProfileId
          // OOB — deliberately NO `syncedIpmiHost`, and the omission is the
          // conservative answer in both directions. An adoptee is a record the
          // USER kept, and its `ipmiHost` (if any) is a value this source has
          // never written; claiming ownership of it here would be the one field
          // adoption takes over that it has no receipt for — the marker carries
          // no OOB stamp to restore, unlike `syncedAuthProfileId` above. So the
          // record enters the ordinary update path stampless, where an unset
          // `ipmiHost` is filled and stamped on the next sync (matrix row 1)
          // and a value the adoptee brought with it is left alone (row 5).
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
        // identical retro-apply next time. A kept server has no origin, so the
        // username clause falls back to the source's current default and the
        // record degrades to the legacy-server case: agent auth, no key of its
        // own, no link, and a username the source still recognises.
        //
        // REVIEW FINDING (P2, detached auth opt-outs) — WITH ONE CLAUSE THAT AN
        // ADOPTEE CAN NOW FAIL. `lastSyncAppliedProfileId` reads the marker when
        // there is no origin, so a kept server whose sync-applied profile the
        // user CLEARED before the source was removed is refused here, exactly as
        // the same record would be refused on every run after an adoption. The
        // preview's disclosure is not a substitute for that: it says a profile is
        // being applied, never that applying it reverses a choice the user made
        // months ago and has not been reminded of.
        //
        // A record refused here is left in the shape that keeps refusing it: the
        // link stays off, and `adoptionOrigin.syncedAuthProfileId` above has
        // already restored the receipt, so the ordinary update path reads the
        // opt-out from the origin on the next sync without needing the marker
        // that adoption spends.
        if (qualifiesForSourceProfileRetroApply(adoptee, resolvedProfileId, source.defaultUsername)) {
          after.authProfileId = resolvedProfileId;
          after.origin = { ...adoptionOrigin, syncedAuthProfileId: resolvedProfileId };
        }
        // No `changed` comparison, unlike the owned-update path above: gaining
        // `origin` guarantees before !== after, so an adoption is ALWAYS an
        // update and never lands in `unchangedCount`.
        //
        // AUTH 2b/rollback is NOT run on this path, and after the provenance
        // restore above that is a choice rather than a tautology (it used to be
        // the latter: a kept server had no origin, so `decideSourceAuthRollback`
        // answered "none" by construction). An adoptee that arrives still
        // carrying a link the removed source applied is now provably in the
        // sync's own shape — link and stamp both naming the same profile — so if
        // that profile is already unusable, the unlink is one sync away rather
        // than impossible: the record this adoption writes is exactly what the
        // ordinary update path reads on the next run, and it fires there. The
        // one sync of delay buys the same thing deferring retro-apply would have
        // (it is deliberately NOT deferred, two lines below, for the mirror
        // reason): the rollback's disclosure is written about servers "this sync
        // had already linked", which is true of an owned server and not of one
        // this run is meeting for the first time. Nothing is left unrepairable —
        // that was the whole defect — only unrepaired for one run, on a server
        // that was equally unable to connect before the adoption.
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
    } else if (eligibleForAdoption.length >= 2) {
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
    } else if (keptMatches.length > 0) {
      // Identity matched, address did not. Without this the user sees a silent
      // duplicate and concludes adoption is broken; with it, the refusal states
      // its own reason and the repair is obvious (the addresses are both named).
      warnings.push(
        keptMatches.length === 1
          ? `Device "${device.name}" was previously synced onto server "${keptMatches[0].name}", but that server is now at ${keptMatches[0].host}:${keptMatches[0].port} and the device is at ${endpoint.host}:${port} — it will be added as a new server instead.`
          : `Device "${device.name}" was previously synced onto ${keptMatches.length} servers in your list, none of which is still at ${endpoint.host}:${port} — it will be added as a new server instead.`
      );
    } else {
      // REVIEW FINDING (P1, cross-instance adoption) — LAST in the chain, and
      // that position is the rule: a device with an eligible marker (adopted,
      // ambiguous, or re-addressed) has already been decided and explained by
      // one of the branches above, so a stale marker from some other instance is
      // not worth a second sentence about the same device. Only a device whose
      // ONLY same-provider markers are foreign reaches here.
      //
      // Recorded, not pushed: these are aggregated after the loop (see the
      // buckets' declaration). The address filter matches the eligibility rule's
      // corroboration exactly, so what is reported is "this looked adoptable and
      // was refused on instance identity", never "some unrelated old record
      // mentions this device id".
      const foreignAtThisAddress = (foreignInstanceByExternalId.get(device.externalId) ?? []).filter(
        (s) => s.host.toLowerCase() === endpoint.host.toLowerCase() && s.port === port
      );
      if (foreignAtThisAddress.length > 0) {
        if (providerInstanceKey === undefined) {
          // Not "a different instance" — Nexus has no idea WHICH instance this
          // source is, so it cannot claim the marker names another one. The two
          // states get different copy because they have different repairs: this
          // one is the provider author's to fix, the other is the user's.
          noInstanceIdentityDeviceNames.push(device.name);
        } else {
          instanceMismatchDeviceNames.push(device.name);
          for (const foreign of foreignAtThisAddress) {
            const recorded = foreign.formerlySynced?.instanceKey;
            if (recorded === undefined) {
              sawUnrecordedInstance = true;
            } else {
              recordedForeignInstances.add(recorded);
            }
          }
        }
      }
    }

    // REVIEW FINDING (P2) — the other half of the collision exemption above. The
    // guard let this device through ONLY because its uniquely eligible adoptee is
    // the record already holding the id; reaching here means the adoption did not
    // fire, i.e. the user declined or has not been asked yet. The original skip
    // therefore stands, with its original wording: continuing into the add below
    // would push a record whose id is already in use, which is a strictly worse
    // outcome than the duplicate this feature set out to remove — one id, two
    // servers, and whichever the map keeps last silently wins.
    //
    // The device is still counted as a candidate (the adoption block above pushes
    // its name before consulting the answer), so the run that gets the answer
    // recomputes and adopts. That is the whole point: the question can now be
    // asked at all.
    //
    // ITS OWN SENTENCE, not the "unrelated server" one the guard above pushes.
    // The two describe different situations and lead to different repairs: that
    // one is about a record this source has no claim on, while this one is about
    // the very record the device came from, and the user reaching it has just
    // asked for a separate add and is not going to get one. Saying "unrelated"
    // here would be false about the server AND useless about the outcome. Fired
    // whatever the answer, like every other refusal in this block: this one is
    // not even an explanation of adoption, it is the only notice that this device
    // produced nothing at all.
    if (collidingServer !== undefined) {
      warnings.push(
        `Device "${device.name}" (${device.externalId}) was previously synced onto server "${collidingServer.name}", which still uses the id a new server for this device would need — so it is skipped rather than added separately. Sync again and choose Adopt Existing to reclaim that server.`
      );
      continue;
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
      // OOB — the device's out-of-band address, or `undefined` when it supplies
      // none. A new record has nothing to protect, so there is no matrix here:
      // whatever this fetch offers is what the field starts as, and the stamp
      // below records it so every LATER sync has the ownership question already
      // answered.
      ipmiHost: mgmtHost,
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
        // REVIEW FINDING (P1, adoption instance identity) — WHICH DEPLOYMENT this
        // device was read from, recorded on the record itself because
        // `externalId` above means nothing without it and because
        // `source.config` — the only other place the answer lives — is mutable
        // and can be repointed at another deployment before this server is ever
        // synced again. See `ServerOrigin.syncedInstanceKey`; the "Keep Servers"
        // detach copies THIS value into the marker rather than re-deriving one.
        syncedInstanceKey: providerInstanceKey,
        syncedUsername: endpoint.username ?? source.defaultUsername,
        syncedAuthProfileId: resolvedProfileId,
        // Mirrors the `ipmiHost` written above, and recorded UNCONDITIONALLY —
        // `undefined` included — on the same "a source whose devices gain an
        // address later must find the stamps already there" argument the two
        // stamps above are recorded on. A record born with neither value nor
        // stamp is matrix row 1 (fill it in) rather than row 5 (hands off),
        // which is the right state for a server the user has never typed into:
        // an add that supplies no address must not be mistaken for a hand entry.
        syncedIpmiHost: mgmtHost
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

  // REVIEW FINDING (P1, cross-instance adoption) — the refusals, aggregated.
  // Placed with the other summaries, and BEFORE them so the sentence about
  // records that already exist precedes the ones about devices that were
  // skipped. Both are silent when nothing was refused, and both speak whatever
  // the adoption answer was, for the reason the other refusals in that block do
  // (REVIEW FINDING, P2): a device refused on instance identity is never a
  // candidate, so the question the user answered never mentioned it.
  if (instanceMismatchDeviceNames.length > 0) {
    const n = instanceMismatchDeviceNames.length;
    // Distinct recorded instances, capped like every other example list here.
    // "an unrecorded instance" covers a marker that named none at all — a
    // third-party provider without `instanceKey`, or a marker written before
    // this field existed — which is a different thing from naming a different
    // one and must not be printed as an empty pair of quotes.
    const recorded = [...recordedForeignInstances].slice(0, 3).map((key) => `"${key}"`);
    if (sawUnrecordedInstance) {
      recorded.push("an unrecorded instance");
    }
    warnings.push(
      `${n} device${n === 1 ? "" : "s"} ${n === 1 ? "matches a server" : "match servers"} kept from a removed inventory source of this provider, but ${n === 1 ? "that server was" : "those servers were"} synced from ${recorded.join(", ")} rather than this source's "${providerInstanceKey}" — ${n === 1 ? "it" : "they"} will be added as ${n === 1 ? "a new server" : "new servers"} instead (e.g. ${namedExamples(instanceMismatchDeviceNames)}).`
    );
  }
  if (noInstanceIdentityDeviceNames.length > 0) {
    const n = noInstanceIdentityDeviceNames.length;
    warnings.push(
      `${n} device${n === 1 ? "" : "s"} ${n === 1 ? "matches a server" : "match servers"} kept from a removed inventory source, but the "${source.providerId}" provider does not report which instance a device came from, so Nexus cannot tell whether ${n === 1 ? "that server belongs" : "those servers belong"} to this source — ${n === 1 ? "it" : "they"} will be added as ${n === 1 ? "a new server" : "new servers"} instead (e.g. ${namedExamples(noInstanceIdentityDeviceNames)}).`
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
    adoptionCandidates
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
