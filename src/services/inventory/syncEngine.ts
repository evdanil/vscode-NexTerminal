import type { AuthProfile, DetachedServerOrigin, ServerConfig, ServerOrigin, ServerProtocol } from "../../models/config";
import { authProfileNeedsServerKeyPath, proxyConfigsEqual, serverOriginStampsEqual, templatedHasAnyStamp } from "../../models/config";
import type { InventoryDevice, InventoryEndpoint, InventorySourceConfig, InventoryTree } from "../../models/inventory";
import type { DeviceTemplateProfile } from "../../models/deviceTemplate";
import type { InventorySyncApplication } from "../../core/nexusCore";
import { normalizeFolderPath } from "../../utils/folderPaths";
import { isAddressValue } from "../profileTokens";
import { deterministicServerId } from "./deterministicId";
import {
  applyTemplateMatrix,
  composeDesiredFields,
  computeProfilesNeedingServerKey,
  decideTemplateAuthWrite,
  deviceMatchesFilter,
  filterLabel,
  prepareTemplateRules,
  selectFieldWinners,
  TEMPLATABLE_FIELD_ORDER,
  TEMPLATE_FIELD_SHORT_LABELS,
  type FieldProvenance,
  type PreparedRule,
  type ProfilesNeedingServerKey,
  type TemplatableField
} from "./templateApply";

export const ORPHAN_FOLDER_NAME = "_orphaned";

/**
 * ADDRESSLESS (Codex P1 on #82) — the sentinel port an addressless placeholder
 * carries. `ServerConfig.port` is a required `number`, so a value is needed;
 * `0` is never a valid connect target (`isValidPort` rejects it), and
 * `validateServerConfig` skips the port check entirely when `addressless` is
 * true, so it never has to pass.
 */
const ADDRESSLESS_PORT = 0;

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
  /**
   * DEVICE TEMPLATES (issue #48 PR-T1) — every `DeviceTemplateProfile` this
   * source's rules might reference, resolved by the caller (the engine is pure
   * and has no core access, same as `authProfile`). Optional: a caller with no
   * templates, or a source with no rules, passes none and the engine behaves
   * bit-for-bit as before.
   */
  templatesById?: Map<string, DeviceTemplateProfile>;
  /**
   * DEVICE TEMPLATES (PR-T1) — the WHOLE auth-profile store (rev3), a superset
   * of `authProfile` (which stays for the source-level slot). The unusable
   * -profile scan can name a profile reachable only through a RETAINED link on
   * an owned server (§4.4), and a profile missing from this map would read as
   * "usable" by omission. The store is a handful of records; passing all of it
   * is cheaper and safer than passing exactly enough. Optional for legacy
   * callers — term (a) of the scan still names the source keyless profile from
   * `authProfile`, so the shipped single-id behaviour is preserved when this is
   * absent.
   */
  authProfilesById?: Map<string, AuthProfile>;
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
 * ALTERNATE HOST (issue #48, Phase 2) — selects the endpoint the sync maps to
 * `ServerConfig.altHost`: the first non-empty ssh endpoint whose host DIFFERS
 * from the primary ssh endpoint's host.
 *
 * THE CONVENTION (models/inventory.ts): the FIRST ssh endpoint is the primary
 * host — `selectSshEndpoint` above — and the alternate is the next one carrying
 * a genuinely different address. The provider (netboxProvider.ts) emits the
 * second ssh endpoint only when the alternate address is present,
 * CIDR-stripped-non-empty and DISTINCT from the primary, so a single-IP device
 * has no second ssh endpoint and this returns `undefined`.
 *
 * REVIEW FIX (issue #48, M3a) — the distinctness check is enforced HERE rather
 * than merely "the SECOND ssh endpoint". `computeSyncPlan` (~1110) RELIES on
 * this selector never handing it an `altHost` equal to the primary `host`; the
 * old `[1]`-after-filter would hand back a self-duplicate whenever a third-party
 * provider emitted two IDENTICAL ssh endpoints (`[A, A, …]` → `A`), persisting a
 * dangling `altHost === host` the connect-fallback would have to guard away. The
 * natural meaning of "alternate" is "an address that is not the primary", so we
 * take the first ssh host that actually differs from `selectSshEndpoint`'s. A
 * THIRD-or-later distinct ssh endpoint is still accepted on the tree and left
 * unused (this returns the first differing one), per the model doc.
 */
function selectAltEndpoint(device: InventoryDevice) {
  const primary = selectSshEndpoint(device);
  return device.endpoints.find((e) => e.kind === "ssh" && e.host.length > 0 && e.host !== primary?.host);
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
/**
 * TELNET (Phase 0) — selects the endpoint the sync maps to a server's TELNET
 * address: the FIRST endpoint with kind "telnet" and a non-empty host.
 */
function selectTelnetEndpoint(device: InventoryDevice) {
  return device.endpoints.find((e) => e.kind === "telnet" && e.host.length > 0);
}

/**
 * TELNET (Phase 0) — the endpoint that becomes `host`/`port`, plus the protocol
 * that goes with it.
 *
 * SSH WINS, whatever order the endpoints are listed in (models/inventory.ts
 * states the convention and why): a device offering both is mapped as SSH — the
 * protocol with authentication, file transfer and tunnelling — and its telnet
 * endpoint is left unused. `undefined` when the device offers neither, which is
 * the "no usable endpoint" skip.
 *
 * The protocol is returned in the SHAPE `ServerConfig.protocol` stores, i.e.
 * `undefined` for SSH rather than `"ssh"`, so the value and its stamp can be
 * written verbatim without a translation step in between.
 */
function selectPrimaryEndpoint(
  device: InventoryDevice
): { endpoint: InventoryEndpoint; protocol: ServerProtocol | undefined; defaultPort: number } | undefined {
  const ssh = selectSshEndpoint(device);
  if (ssh) {
    return { endpoint: ssh, protocol: undefined, defaultPort: 22 };
  }
  const telnet = selectTelnetEndpoint(device);
  if (telnet) {
    return { endpoint: telnet, protocol: "telnet", defaultPort: 23 };
  }
  return undefined;
}

/**
 * TELNET (P1-C, Codex) — the endpoint tuple that AGREES with a given protocol.
 *
 * WHY IT EXISTS. `host`/`port` and `protocol` used to be decided by two
 * independent rules: the endpoint came from `selectPrimaryEndpoint` (ssh wins),
 * the protocol from `syncOwnsProtocol` (which can answer "the user owns this,
 * leave it telnet"). On a device offering BOTH, those two correct answers
 * composed into a broken record — a telnet profile pointed at port 22, which
 * cannot connect and which the next sync would rewrite the same way forever.
 *
 * Returns the endpoint of the wanted transport plus the port to use, or
 * `undefined` when the device offers none of that kind. `undefined` is a real
 * answer, not a failure: the caller's conservative response is to leave the
 * record's address ALONE rather than aim it at the other transport's port.
 */
function selectEndpointForProtocol(
  device: InventoryDevice,
  protocol: ServerProtocol | undefined
): { endpoint: InventoryEndpoint; port: number } | undefined {
  const wantTelnet = protocol === "telnet";
  const endpoint = wantTelnet ? selectTelnetEndpoint(device) : selectSshEndpoint(device);
  if (!endpoint) {
    return undefined;
  }
  const port = endpoint.port ?? (wantTelnet ? 23 : 22);
  return isValidPort(port) ? { endpoint, port } : undefined;
}

/**
 * TELNET (Phase 0) — may this sync WRITE `ServerConfig.protocol` on an existing
 * owned server? A FAITHFUL TWIN of `syncOwnsIpmiHost` / `syncOwnsAltHost`:
 * governed by the SAME matrix documented on the first of them, read with
 * `cur` = the record's resolved protocol, `stamp` = `origin.syncedProtocol`
 * resolved the same way, and `dev` = the protocol this fetch's primary endpoint
 * implies.
 *
 * THE ONE DEVIATION, and it is the whole reason this is a separate function
 * rather than a call to either of those: all three values are compared through
 * their RESOLVED form (absent ≡ `"ssh"`), because `protocol` is a two-valued
 * enum whose absent state is a real value rather than "unset". Rows 1 and 5 of
 * that matrix — "never configured" and "a legacy hand entry" — therefore do not
 * exist here: there is no way to have no protocol, and no build before this one
 * could write anything but SSH, so an absent stamp on an SSH record reads as
 * "the sync wrote ssh", which is exactly what happened.
 *
 * What survives unchanged is the part that matters: row 3 (still exactly what
 * the sync put there ⇒ follow the device), row 4 (a hand flip ⇒ leave alone,
 * carry the stamp forward verbatim, never launder it), and row 5a (the record
 * already agrees with the device ⇒ stamp only, no value change).
 */
function syncOwnsProtocol(
  current: ServerProtocol | undefined,
  stamp: ServerProtocol | undefined,
  dev: ServerProtocol | undefined
): boolean {
  const cur = current === "telnet" ? "telnet" : "ssh";
  return cur === (stamp === "telnet" ? "telnet" : "ssh") || cur === (dev === "telnet" ? "telnet" : "ssh");
}

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
 *  1. cur ABSENT, stamp unset,  oob present  → WRITE + stamp. Never configured:
 *     the fill-it-in state, exactly as `syncedAuthProfileId === undefined &&
 *     authProfileId === undefined` is for retro-apply. "ABSENT" here means
 *     `undefined` OR blank/whitespace-only (REVIEW FINDING, P2): validation
 *     deliberately tolerates that shape (`validateServerConfig`,
 *     utils/validation.ts) and every use site reads a blank as absent
 *     (`resolveProfileTokens` refuses `""` and `undefined` with the same "not
 *     set" error), so this predicate must too — otherwise the one field state
 *     that LOOKS unset everywhere else is the one state the sync can never
 *     repair, misfiling a functionally-unset field as a hand edit (row 4) and
 *     leaving it blank and stampless forever.
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
 *  5a. cur === oob (whatever the stamp)      → the value is ALREADY the device's
 *     address, so there is nothing to write — but the sync RECORDS THE STAMP, a
 *     stamp-only change with no visible field change. This is a REFINEMENT of
 *     rows 4 and 5, not a violation of them: neither row's value is touched, and
 *     "leave the value alone" is exactly what happens. What changes is that
 *     ownership is recorded, so the address follows the BMC the next time NetBox
 *     re-addresses it (row 3) instead of going silently stale forever.
 *
 *     WHY THIS ROW EXISTS. Without it, the likeliest Phase-1 hand entry of all —
 *     the user copied the address out of NetBox and typed it into the server
 *     form — is the one case that can never be repaired: it can never gain a
 *     stamp (rows 4/5 refuse), so when the BMC is later re-addressed the record
 *     keeps the dead address and nothing in the product ever says so. It is also
 *     what makes the `changed` clause's stamps-equal term reachable at all (AUTH
 *     3a's shape: an `after` whose ONLY difference from `before` is a freshly
 *     computed stamp).
 *
 *     THE STAMP IS STILL THE DEVICE'S VALUE, NEVER THE RECORD'S. The trigger is
 *     equality WITH THE DEVICE — `mgmtHost` is what gets stamped, and it is only
 *     stamped because the record already agrees with it. The models/config.ts
 *     rule ("never inferred from the record's current value") therefore holds:
 *     a hand edit to some THIRD value still stamps nothing (row 4).
 *
 *     RESIDUAL, ACCEPTED AND DOCUMENTED (m7 class, the same trade
 *     `syncedUsername`/AUTH 3a makes): a hand-typed value that happens to equal
 *     the device's current `oob_ip` is adopted into sync ownership without the
 *     user asking. The cost is bounded — from then on that field tracks NetBox,
 *     and the user's own value was NetBox's value at the moment they typed it —
 *     and the opt-out is unchanged and one edit away: clear the field, and row 2
 *     keeps it cleared forever.
 *
 *     ROW 2 IS UNREACHABLE FROM HERE BY CONSTRUCTION, which is what keeps the
 *     opt-out intact: this row needs `cur === oob`, and `oob` is a non-empty
 *     string by selection (`selectManagementEndpoint` skips empty hosts), so a
 *     cleared `cur` can never equal it.
 *  6. anything,   anything,     oob ABSENT   → NEVER touch `ipmiHost`; carry the
 *     stamp forward (the caller's guard). Mirrors the provider's own never-drop
 *     stance: losing an address at the source is routine maintenance, not a
 *     deletion. Accepted staleness — a genuinely decommissioned BMC keeps its
 *     last-known address until the user clears it, which is row 2's opt-out.
 *
 * Rows 1, 3 and 5a are the three this answers yes for, and they reduce to one
 * question asked two ways: is the record still carrying exactly what the sync
 * last put there, or exactly what the device says today? Rows 2, 4 and 5 are the
 * ways the answer is no.
 */
function syncOwnsIpmiHost(current: string | undefined, stamp: string | undefined, oob: string): boolean {
  // Blank/whitespace-only reads as absent (row 1's note above). Normalized on
  // ONE side only, and only for blankness: a non-blank value is compared
  // VERBATIM, so a hand edit that merely differs from the stamp by stray
  // whitespace stays a hand edit (row 4) rather than being trimmed into a
  // match. The stamp needs no normalization — it is only ever written from a
  // `selectManagementEndpoint` host, which is non-empty by selection — so a
  // blank `cur` WITH a stamp still equals neither the stamp nor `oob` and row
  // 2's cleared-forever opt-out survives a user who empties the field to `""`.
  const cur = current !== undefined && current.trim() === "" ? undefined : current;
  return cur === stamp || cur === oob;
}

/**
 * ALTERNATE HOST (issue #48, Phase 2) — may this sync WRITE `ServerConfig.altHost`
 * on an existing owned server? A FAITHFUL TWIN of `syncOwnsIpmiHost` above:
 * byte-identical logic, and governed by THE SAME 6-row + 5a matrix documented
 * there — read it VERBATIM with `cur` = `ownedServer.altHost`, `stamp` =
 * `origin.syncedAltHost`, `alt` = this fetch's alternate host. Every clause
 * transfers unchanged:
 *  1. cur ABSENT (undefined OR blank), stamp unset, alt present → WRITE + stamp.
 *  2. cur unset, stamp set (user CLEARED a synced value), alt present → LEAVE
 *     (the per-server opt-out).
 *  3. cur === stamp, alt different → WRITE + re-stamp.
 *  4. cur ≠ stamp (a hand edit), alt present → LEAVE, carry the stamp; never
 *     laundered into the stamp.
 *  5. cur set, stamp unset (a Phase-1 hand entry) → LEAVE; absent stamp is NOT
 *     "the sync owns this".
 *  5a. cur === alt (whatever the stamp) → the value already IS the device's
 *     alternate, so nothing is written but the STAMP is recorded (a stamp-only
 *     change). Row 2 stays unreachable from here — `alt` is non-empty by
 *     selection, so a cleared `cur` can never equal it.
 *  6. alt ABSENT this fetch → NEVER touch; carry the stamp (the caller's
 *     `altHost !== undefined` guard).
 *
 * WHY THIS DISCIPLINE AND NOT `host`/`port`'s: `altHost`, exactly like
 * `ipmiHost`, shipped as a HAND-EDITED field before any sync could write it
 * (Phase 1), so "device always wins" would clobber a manual second address and
 * an absent alternate would read as "the field should be empty". The stamp
 * records what the SYNC wrote; the sync writes only where the record still
 * carries exactly that (or the device's current alternate — row 5a).
 */
function syncOwnsAltHost(current: string | undefined, stamp: string | undefined, alt: string): boolean {
  // Blank/whitespace-only reads as absent, and the comparison is otherwise
  // VERBATIM — the whole rationale (why `cur` is normalized on one side only and
  // only for blankness, why the stamp needs no normalization, why a blank `cur`
  // WITH a stamp survives row 2's opt-out) is `syncOwnsIpmiHost`'s, one function
  // up. This is the same logic on the alternate-host triple.
  const cur = current !== undefined && current.trim() === "" ? undefined : current;
  return cur === stamp || cur === alt;
}

/**
 * PRIMARY HOST (task #29, the deferred #82 P2-3) — may this sync WRITE
 * `ServerConfig.host` on an existing owned server? A VERBATIM copy of
 * `syncOwnsIpmiHost` above — the SAME blank-normalize and the SAME
 * `cur === stamp || cur === dev` — governed by the SAME 6-row + 5a matrix, read
 * with `cur` = the record's `host`, `stamp` = `origin.syncedHost`, `dev` = the
 * address this fetch's chosen endpoint supplies.
 *
 * WHY THIS DISCIPLINE NOW, WHEN `host` USED TO BE "device always wins". This is
 * the DELIBERATE BEHAVIOR CHANGE (task #29): before the `syncedHost` stamp there
 * was no way to tell a hand-edited console address apart from a sync-written one,
 * so the sync wrote the device's `host` UNCONDITIONALLY and stomped every hand
 * edit. The stamp closes exactly the gap `syncedAltHost`/`syncedIpmiHost` close
 * for their fields — a hand-typed value (a stamp the value no longer equals) is
 * now preserved, and only a value still carrying the sync's own last write (or
 * the device's current one, row 5a) is overwritten. The `dev` blank-normalize is
 * inherited too: an addressless placeholder's `host: ""` reads as absent, so its
 * upgrade fills from the device (row 1) rather than reading as a hand entry.
 */
export function syncOwnsHost(current: string | undefined, stamp: string | undefined, dev: string): boolean {
  const cur = current !== undefined && current.trim() === "" ? undefined : current;
  return cur === stamp || cur === dev;
}

/**
 * PRIMARY PORT (task #29) — the numeric twin of `syncOwnsHost` above, on
 * `ServerConfig.port`. Numeric, so there is no whitespace to trim; the
 * `ADDRESSLESS_PORT` (0) sentinel plays the role blank `""` plays for the host
 * and is NORMALIZED TO ABSENT for two reasons the matrix needs:
 *  - FILL-IN (row 1): an addressless placeholder carries `port: 0` with no
 *    stamp; normalizing to `undefined` makes `cur === stamp` (undefined ===
 *    undefined) true, so the upgrade takes the device's port — the numeric
 *    analog of the blank-host fill-in.
 *  - ROW 6 GUARD ("device supplies none"): were `dev` itself the sentinel, an
 *    un-normalized `cur === dev` (0 === 0) would spuriously read as owned; with
 *    `cur` normalized to `undefined` it cannot match a sentinel `dev`, so a
 *    placeholder's 0 never reads as owned by coincidence.
 * `stamp` needs no normalization — the sync only ever writes a real endpoint
 * port (`>= 1`) or leaves it absent, exactly as `syncOwnsIpmiHost`'s stamp is
 * only ever a selected non-empty host.
 */
export function syncOwnsPort(current: number, stamp: number | undefined, dev: number): boolean {
  const cur = current === ADDRESSLESS_PORT ? undefined : current;
  return cur === stamp || cur === dev;
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
 * DEVICE TEMPLATES (PR-T1 / A-M2) — the single `unusableProfileId` widened to a
 * SET (`unusableProfileIds`), so a link applied by a RULE TEMPLATE or by a
 * RETAINED link (whose rule is gone) is rolled back too, not only the
 * source-level profile. Membership selects which servers are examined; the
 * per-server `hasOwnKeyPath` split (`retain-own-key` vs `unlink`) is unchanged.
 *
 * The clauses, and what each refuses to touch:
 *  - `unusableProfileIds.has(server.authProfileId)`: only the keyless-key case.
 *    A DELETED profile never reaches here — NexusCore.removeAuthProfile already
 *    clears link and stamp together — and a healthy profile is not in the set.
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

function decideSourceAuthRollback(server: ServerConfig, unusableProfileIds: ReadonlySet<string>): SourceAuthRollback {
  const id = server.authProfileId;
  if (id === undefined || !unusableProfileIds.has(id) || server.origin?.syncedAuthProfileId !== id) {
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

/**
 * P2-2 (Fable) — how a kept/colliding server's OWN address reads in a refusal
 * warning. An addressless placeholder carries `host: ""` / `port: 0`, which
 * rendered as the nonsense ":0"; it has no address by design, so say so.
 */
function renderServerAddress(server: ServerConfig): string {
  return server.addressless === true ? "(no address)" : `${server.host}:${server.port}`;
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
  // must UNDO. DEVICE TEMPLATES (PR-T1 / A-M2): this single id is now one term of
  // the widened `profilesNeedingServerKey` set (built by the pre-pass below,
  // term (a)), which both rollback passes consume; the source keyless id is
  // recovered for the source-level warning as `sourceUnusableId` at composition
  // time. See `decideSourceAuthRollback` for the per-server rule.
  // The warning below is composed here (where the reason is known) but pushed
  // AFTER both rollback passes, because its closing sentences have to state how
  // many servers this sync actually unlinked and how many it deliberately left
  // linked — numbers only those passes produce. It is then SPLICED back to this
  // position rather than appended, so the ordering users see is unchanged: tree
  // warnings, this one, then per-device warnings.
  const authWarningIndex = warnings.length;
  const emitAuthWarning = source.authProfileId !== undefined && resolvedProfileId === undefined;

  // DEVICE TEMPLATES (issue #48 PR-T2) — the per-field cascade is now PER DEVICE.
  // Rules are PREPARED once (template resolve + filter parse + dangling-template
  // warnings — all device-independent); the winners are resolved inside the
  // device loop, because `deviceMatchesFilter` makes candidacy per-device (PR-T1's
  // fail-closed filtered-rule skip LIFTS here — a filtered rule now applies to the
  // devices it matches). `source.authProfileId` enters each device's cascade as
  // the implicit specificity −1 fill candidate, so PR #53's behaviour falls out
  // unchanged when no explicit rule sets the field.
  const preparedRules = prepareTemplateRules(source.templateRules ?? [], input.templatesById, source.name);
  const prepared: PreparedRule[] = preparedRules.prepared;
  for (const w of preparedRules.warnings) {
    warnings.push(w);
  }
  // §5.3 proxy jump-host resolution set — the OPTIMISTIC first pass (FIX 2, PR
  // #61 Codex review). This set names every id that COULD exist after the sync:
  // the current servers plus the deterministic ids of every device this fetch
  // carries. It admits a reference that WON'T actually survive — an owned jump
  // host this plan prunes under `delete`, or a device row skipped below for an
  // invalid endpoint / port / id collision — so it is NOT the authoritative
  // dangling check. Its job is narrower and still needed: a `jumpHostId` outside
  // even this optimistic set can NEVER resolve (it names nothing this sync knows
  // about), so composition drops such a proxy to "desired none" HERE, which is
  // what gives §4.3 row-5 carry — an existing sync-owned proxy is kept instead of
  // being clobbered by a never-resolvable one (fixture 32). The AUTHORITATIVE
  // check against the definitive post-plan SURVIVOR set (current minus prunes,
  // plus adds, plus adopted ids) runs after the device loop, because prune and
  // per-device skip decisions are only known once the loop has run; it drops the
  // references this optimistic set over-admitted. The two are mutually exclusive
  // by construction — a ref this set rejects never reaches the survivor pass
  // (its desired is already none), and a ref this set admits is the only kind the
  // survivor pass re-examines — so no proxy is warned about twice.
  const liveServerIds = new Set(currentServers.map((s) => s.id));
  for (const device of tree.devices) {
    liveServerIds.add(deterministicServerId(source.id, device.externalId));
  }
  // Resolve an auth-profile id against the WHOLE profile store (falling back to
  // the source's own `matchedProfile` for legacy callers that pass no map, so
  // the implicit rule always resolves). Consumed per device below.
  const resolveAuthProfileById = (id: string): AuthProfile | undefined =>
    input.authProfilesById?.get(id) ?? (matchedProfile?.id === id ? matchedProfile : undefined);

  // The BASELINE cascade — the catch-all-only winners a device carrying NO
  // attributes resolves (only catch-all / name=* rules match it). PR-T2 review
  // (M2): its dangling-reference warnings are emitted ONCE after the device loop,
  // deduped against the per-device path, so a source whose catch-all/implicit
  // template references a dangling jump host or auth profile still warns even when
  // ZERO devices are syncable (the per-device path never runs then). Its
  // provenance / matches / non-auth desired are NOT consumed — the survivor pass
  // is now per-record (PART 1 below) and needs no baseline desired proxy.
  const baselineDevice: Pick<InventoryDevice, "name" | "attributes"> = { name: "", attributes: undefined };
  const baselineCascade = selectFieldWinners(baselineDevice, prepared, source.authProfileId);
  const baselineComposed = composeDesiredFields(
    baselineCascade.winners,
    {
      hasServer: (jumpHostId) => liveServerIds.has(jumpHostId),
      proxyTemplateName: baselineCascade.proxyTemplateName,
      sourceName: source.name
    },
    // PR-T3 — the IPMI reference-validation context; its dangling warnings dedupe
    // against the per-device path and are the sole surface when zero devices sync.
    {
      hasAuthProfile: (pid) => resolveAuthProfileById(pid) !== undefined,
      hasServer: (sid) => liveServerIds.has(sid),
      ipmiAuthProfileTemplateName: baselineCascade.provenance.ipmiAuthProfileId?.templateName,
      ipmiGatewayServerTemplateName: baselineCascade.provenance.ipmiGatewayServerId?.templateName,
      sourceName: source.name
    }
  );

  // DEVICE TEMPLATES (PR-T2) — per-device warning dedupe. The dangling-jump-host
  // and dangling-auth-profile warnings name the TEMPLATE/source, not the device,
  // so they are byte-identical across every device the winner touches; emitting
  // one per device would flood the plan. Device-named warnings (per-field ties,
  // self-reference) are naturally distinct and never routed through this set.
  const templateWarningsSeen = new Set<string>();
  const pushDedupTemplateWarning = (msg: string): void => {
    if (!templateWarningsSeen.has(msg)) {
      templateWarningsSeen.add(msg);
      warnings.push(msg);
    }
  };
  // Zero-match tracking (§2.3): the union of rule ids that matched ANY device this
  // fetch; the complement of `prepared` gets a plan info line after the loop.
  const matchedRuleIds = new Set<string>();
  // §3.4 provenance — per server that received a templated field this run, which
  // rule/template supplied each field. Aggregated into report lines after the loop.
  // PR-T2 review (B2): keyed by serverId and gated on the fields the matrix
  // ACTUALLY WROTE (not the cascade winners) for a device that produces a plan
  // entry, so a hand-edited (row 6) / left (rows 2/4/5/7) / dropped (dangling
  // jump host, keyless auth) field never claims a value flow that did not happen —
  // and the §3.4 line never contradicts the plan's own "not applied" / "kept
  // hand-configured" lines. The survivor pass strips a proxy entry it later
  // restores or drops, keyed by this same serverId.
  const provenanceByServer = new Map<string, { serverName: string; provenance: Partial<Record<TemplatableField, FieldProvenance>> }>();
  // PR-T2 review (B1/MINOR-6) — per-record name of the template that WROTE this
  // run's proxy, so the survivor pass's dangling warning names the template that
  // actually set THIS proxy (per-record), not the baseline catch-all's.
  const proxyTemplateNameByServerId = new Map<string, string>();
  // PR-T3 review FIX 3 — per-record name of the template that WROTE this run's IPMI
  // gateway, so the post-plan survivor pass can name it when the gateway server is
  // delete-pruned in the SAME sync (the §5.3 dangling check ran against the
  // OPTIMISTIC `liveServerIds`, which still admits a same-run delete-prune). Mirrors
  // `proxyTemplateNameByServerId`.
  const ipmiGatewayTemplateNameByServerId = new Map<string, string>();

  const adds: ServerConfig[] = [];
  const updates: Array<{ before: ServerConfig; after: ServerConfig }> = [];
  const prunes: InventorySyncPlan["prunes"] = [];
  let unchangedCount = 0;
  /**
   * Codex round 4 (P2) — the ids of owned servers that actually reached the
   * `unchangedCount++` site (the mapped-update no-change branch, the sole
   * incrementer — adoption is always an update, never counted). The
   * survivor-cleanup promotion loop below reaches ANY owned server not already
   * planned — including one whose device was SKIPPED before that branch (no
   * usable endpoint / invalid port) and so was never counted — and must
   * decrement `unchangedCount` ONLY for servers this set records as counted;
   * an unconditional decrement understates the count or drives it negative.
   */
  const unchangedServerIds = new Set<string>();
  /**
   * AUTH 2b — per-profile counts of the links this plan UNDOES / deliberately
   * LEAVES in place (the server brings its own key file). Keyed by profile id so
   * the source-level warning and the referrer-specific template/retained-link
   * warnings each report only their own profile's servers (§4.4). The warning
   * must not describe a retained server as having no key and falling back to SSH
   * agent authentication.
   */
  const unlinkedByProfile = new Map<string, number>();
  const retainedByProfile = new Map<string, number>();
  /** §4.4 rev7 — servers whose OVERRIDE MOVE onto a keyless profile was refused per target (no own key), by profile id → names. */
  const overrideRefusedByProfile = new Map<string, string[]>();
  const bump = (map: Map<string, number>, id: string): void => {
    map.set(id, (map.get(id) ?? 0) + 1);
  };
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

  // DEVICE TEMPLATES (PR-T1 / §4.4) — the widened unusable-profile set, built by
  // a PRE-PASS over the owned servers BEFORE the device loop (never during it:
  // the mapped rollback runs inside the loop and would read a half-built,
  // order-dependent set). Supersedes the single source-derived id: it also names
  // every rule-template-referenced keyless profile and every keyless profile
  // reachable only through a RETAINED sync-owned link. `matchedProfile` is passed
  // as term (a)'s source profile PRE-1b-zeroing, so a keyless source profile is
  // named here even though it is refused a fresh stamp above.
  const profilesNeedingServerKey: ProfilesNeedingServerKey = computeProfilesNeedingServerKey({
    source,
    ownedServers: [...ownedByExternalId.values()],
    sourceProfile: matchedProfile,
    templatesById: input.templatesById,
    authProfilesById: input.authProfilesById
  });
  const unusableProfileIds = profilesNeedingServerKey.ids;

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
  const emptyNameSkipped: string[] = [];
  const invalidPortSkipped: string[] = [];
  // ADDRESSLESS (Codex P1) — devices with no usable primary endpoint that were
  // NEWLY created as placeholders this run, for one aggregate note.
  const addresslessAdded: string[] = [];
  // P2-3 (Fable) — previously-ADDRESSED servers downgraded to placeholders this
  // sync (their console address blanked). Disclosed as an aggregate parallel to
  // `addresslessAdded`; a stay-addressless server is never added here.
  const downgradedToAddressless: string[] = [];

  // Folder → `group` resolution, shared by the addressed add/update path and the
  // ADDRESSLESS branch (which decides earlier, before the primary-endpoint check
  // where the inline computation used to live). Pure but for the warnings it
  // pushes on an invalid/over-deep path — the exact behaviour the inline block
  // had.
  const resolveDeviceGroup = (device: InventoryDevice): string | undefined => {
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
    if (joined === undefined) {
      return undefined;
    }
    const normalizedJoined = normalizeFolderPath(joined);
    if (normalizedJoined === undefined) {
      warnings.push(`Device "${device.name}" (${device.externalId}) folder path exceeds the maximum depth; placed at the source's target folder.`);
      return source.targetFolder ? source.targetFolder : undefined;
    }
    return normalizedJoined;
  };

  for (const device of tree.devices) {
    if (!device.externalId) {
      warnings.push(`Device "${device.name || "(unnamed)"}" has no device ID and was skipped.`);
      continue;
    }
    presentExternalIds.add(device.externalId);
    // M1 (PR-T2 review) — a rule counts as MATCHED if it matches any device
    // PRESENT in this fetch, even one later skipped for a syncability reason
    // (empty name / no usable endpoint / invalid port / duplicate). The per-device
    // cascade below runs only for SYNCABLE devices, so without this a rule whose
    // only matches are endpoint-less rows (PDUs, patch panels, ...) would falsely
    // report "matched no devices this sync." — a spurious typo alarm on a filter
    // that is in fact matching, just on unsyncable devices.
    for (const pr of prepared) {
      if (pr.isCatchAll || deviceMatchesFilter(device, pr.parsed)) {
        matchedRuleIds.add(pr.rule.id);
      }
    }
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

    // TELNET (Phase 0) — ssh endpoint if the device has one, else its telnet
    // endpoint (see `selectPrimaryEndpoint` for why ssh always wins).
    const primary = selectPrimaryEndpoint(device);

    // P3-4 (Fable) — the invalid-port skip runs BEFORE the OOB extraction below.
    // Hoisting OOB extraction ahead of the addressless branch (Codex P2) also put
    // it ahead of this skip, so a device destined to be skipped for a bad port
    // first pushed an "out-of-band address cannot be used" warning it never did
    // pre-PR. Deciding the skip first keeps a skipped device silent about fields it
    // will never carry. Guarded on `primary`: an addressless device (no primary)
    // has no port to validate and belongs to the branch below.
    if (primary) {
      const primaryPort = primary.endpoint.port ?? primary.defaultPort;
      if (!isValidPort(primaryPort)) {
        if (isOwned) {
          warnings.push(`Device "${device.name}" (${device.externalId}) has an invalid port ${primaryPort} and was skipped.`);
        } else {
          invalidPortSkipped.push(device.name);
        }
        continue;
      }
    }

    // OOB — the out-of-band management address this fetch offers for
    // `ServerConfig.ipmiHost`, or `undefined` when the device supplies none
    // (matrix row 6 in `syncOwnsIpmiHost`) or supplies one nothing can use.
    //
    // EXTRACTED HERE, BEFORE the addressless branch (Codex P2). A device with no
    // ssh/telnet primary endpoint but a redfish/ipmi-sol one is addressless FOR
    // ITS CONSOLE, yet its BMC web-console / locally-executed IPMI needs no
    // primary console address — so the placeholder must still carry this OOB
    // address. Deciding it before the branch lets BOTH the addressless paths and
    // the addressed path below read the one `mgmtHost`.
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

    if (!primary) {
      // ADDRESSLESS (Codex P1 on #82) — a device with NO usable primary endpoint
      // (a stopped EVE node, a VNC/HTML5-console node, a NetBox row with no IP)
      // is no longer skipped: it becomes a VISIBLE addressless placeholder. This
      // is reached only AFTER the empty-name (1116) and duplicate-id (1129)
      // skips, and BEFORE the invalid-port skip below — which is deliberate:
      // addressless is ONLY for a device with no primary endpoint AT ALL, never
      // a swallow for malformed data (a bad name or a bad port stays skipped).
      const ownedForAddressless = ownedByExternalId.get(device.externalId);
      const addresslessGroup = resolveDeviceGroup(device);
      // DEVICE TEMPLATES on ADDRESSLESS (Codex P2-a) — the per-device cascade runs
      // for a placeholder too, so a template's OOB-oriented fields (ipmiAuthProfileId
      // / ipmiGatewayServerId) take effect immediately and the console-inert ones
      // (proxy/multiplexing/legacyAlgorithms/logSession) are applied under their
      // templated stamps for when it later upgrades to addressed. Computed here (not
      // hoisted above the branch) so the invalid-port skip below never runs it —
      // each device runs the cascade in exactly ONE branch. The SSH auth winner
      // (`authProfileId`) is deliberately NOT applied: it is not a templated-stamp
      // field, it is inert without a console, and the addressed update path fills it
      // on upgrade. Only the templated fields flow, via `applyTemplateMatrix`.
      const addresslessCascade = selectFieldWinners(device, prepared, source.authProfileId);
      for (const w of addresslessCascade.warnings) {
        warnings.push(w);
      }
      for (const rid of addresslessCascade.matchedRuleIds) {
        matchedRuleIds.add(rid);
      }
      const addresslessComposed = composeDesiredFields(
        addresslessCascade.winners,
        {
          hasServer: (jumpHostId) => liveServerIds.has(jumpHostId),
          proxyTemplateName: addresslessCascade.proxyTemplateName,
          sourceName: source.name
        },
        {
          hasAuthProfile: (pid) => resolveAuthProfileById(pid) !== undefined,
          hasServer: (sid) => liveServerIds.has(sid),
          ipmiAuthProfileTemplateName: addresslessCascade.provenance.ipmiAuthProfileId?.templateName,
          ipmiGatewayServerTemplateName: addresslessCascade.provenance.ipmiGatewayServerId?.templateName,
          sourceName: source.name
        }
      );
      for (const w of addresslessComposed.warnings) {
        pushDedupTemplateWarning(w);
      }
      const addresslessDesired = addresslessComposed.desired;
      const addresslessProxyTemplateName = addresslessCascade.proxyTemplateName;
      const addresslessGatewayTemplateName = addresslessCascade.provenance.ipmiGatewayServerId?.templateName;
      // P1-C (Fable) — the SSH auth winner, resolved exactly as the addressed path
      // does, so the addressless ADD can write the source-level link (`authProfileId`
      // + `syncedAuthProfileId`). A dangling reference writes no link (and warns for a
      // template referrer); a keyless winner is dropped by the blanket per-profile
      // refusal, mirroring the addressed add. The link is inert while the placeholder
      // is addressless but correct on upgrade, and BMC/IPMI features may read it.
      const addresslessAuthWinnerField = addresslessCascade.winners.authProfileId;
      const addresslessWinnerProfile =
        addresslessAuthWinnerField !== undefined ? resolveAuthProfileById(addresslessAuthWinnerField.value) : undefined;
      if (addresslessAuthWinnerField !== undefined && addresslessWinnerProfile === undefined && !addresslessCascade.authFromImplicit) {
        pushDedupTemplateWarning(
          `A device template rule on "${source.name}" links an auth profile that no longer exists — the auth field was skipped.`
        );
      }
      const addresslessWinnerKeyless =
        addresslessWinnerProfile !== undefined && authProfileNeedsServerKeyPath(addresslessWinnerProfile);
      const addresslessWinnerResolvedId =
        addresslessAuthWinnerField !== undefined && addresslessWinnerProfile !== undefined && !addresslessWinnerKeyless
          ? addresslessAuthWinnerField.value
          : undefined;
      if (ownedForAddressless) {
        // DOWNGRADE / stay-addressless. Decided here so the post-loop rollback
        // pass does not touch this server a second time.
        decidedOwnedExternalIds.add(device.externalId);
        // Protocol on downgrade obeys the SAME ownership discipline the addressed
        // path uses — passing `undefined` as the device protocol (the addressless
        // shape is ssh-default): a sync-owned protocol is cleared to ssh, while a
        // hand-flipped one is left alone with its stamp carried forward verbatim.
        // The actual clear is GATED on `blanksAddress` below (#84 P2) — protocol
        // and host/port are one coherent console endpoint, so the protocol is only
        // reset when the record truly downgrades to the addressless placeholder.
        const takesProtocol = syncOwnsProtocol(
          ownedForAddressless.protocol,
          ownedForAddressless.origin?.syncedProtocol,
          undefined
        );
        // OOB (Codex P2) — an addressless-for-console device can still expose a
        // BMC address, so the downgrade/stay path decides `ipmiHost` under the
        // SAME `syncOwnsIpmiHost` matrix the addressed path uses: it takes the new
        // OOB address only when the sync still owns the field (row 1/3/5a), and
        // otherwise leaves a hand-edited value alone (rows 4/5). When the device
        // supplies NO OOB (`mgmtHost` undefined, matrix row 6) the field and its
        // stamp are carried forward VERBATIM by the `...ownedForAddressless`
        // spread — never touched.
        const takesIpmiHost =
          mgmtHost !== undefined &&
          syncOwnsIpmiHost(ownedForAddressless.ipmiHost, ownedForAddressless.origin?.syncedIpmiHost, mgmtHost);
        // PRIMARY HOST/PORT (task #29, the deferred #82 P2-3) — the console
        // address is only BLANKED to the addressless placeholder shape when the
        // sync still OWNS it. The device offers no console this fetch, so `dev`
        // is the empty host / the `ADDRESSLESS_PORT` sentinel — `syncOwnsHost`/
        // `syncOwnsPort` then answer yes for a sync-owned or already-blank address
        // (matrix rows 1/3/5a) and NO for a value the user hand-typed onto the
        // placeholder (rows 4/5). A hand-typed address is PRESERVED: the server
        // stays addressed-by-hand rather than reverting to "", so `addressless`
        // must be false in that branch. Decided on BOTH components as a unit —
        // the address is owned as a whole — so a hand edit to either half keeps
        // the pair.
        const blanksAddress =
          syncOwnsHost(ownedForAddressless.host, ownedForAddressless.origin?.syncedHost, "") &&
          syncOwnsPort(ownedForAddressless.port, ownedForAddressless.origin?.syncedPort, ADDRESSLESS_PORT);
        // #84 P2 (Codex) — COUPLE the protocol decision to the address decision.
        // host/port and protocol are one coherent console endpoint. When the sync
        // RETAINS a hand-edited endpoint (`blanksAddress` false — the record stays
        // ADDRESSED), the protocol MUST ride with it unchanged: clearing a
        // sync-owned telnet to the ssh default while keeping the telnet host/port
        // would leave the next connect speaking SSH to a telnet endpoint. The
        // protocol is reset (and its stamp dropped) ONLY when the record genuinely
        // converts to the addressless placeholder (`blanksAddress` true), where the
        // ssh-default shape is correct. A hand-flipped protocol (`takesProtocol`
        // false) is left alone on both paths, exactly as before.
        const clearsProtocol = blanksAddress && takesProtocol;
        const afterProtocol = clearsProtocol ? undefined : ownedForAddressless.protocol;
        // DEVICE TEMPLATES (Codex P2-a) — the same matrix the addressed update runs,
        // against the placeholder's own id for the §5.3 self-proxy check. Its
        // `values` are the field writes, its `templated` the carried-forward stamp
        // record; a hand-edited templated field is left untouched (row 4/7).
        const templateMatrix = applyTemplateMatrix(ownedForAddressless, addresslessDesired, {
          targetServerId: ownedForAddressless.id,
          targetServerName: device.name,
          proxyTemplateName: addresslessProxyTemplateName,
          ipmiGatewayTemplateName: addresslessGatewayTemplateName
        });
        for (const w of templateMatrix.warnings) {
          warnings.push(w);
        }
        if (templateMatrix.values.proxy !== undefined && addresslessProxyTemplateName !== undefined) {
          proxyTemplateNameByServerId.set(ownedForAddressless.id, addresslessProxyTemplateName);
        }
        if (templateMatrix.values.ipmiGatewayServerId !== undefined && addresslessGatewayTemplateName !== undefined) {
          ipmiGatewayTemplateNameByServerId.set(ownedForAddressless.id, addresslessGatewayTemplateName);
        }
        const afterOrigin: ServerOrigin = {
          ...ownedForAddressless.origin,
          sourceId: source.id,
          externalId: device.externalId,
          syncedAt: now,
          syncedInstanceKey: providerInstanceKey,
          // Username/auth/alt stamps and their values are carried forward VERBATIM
          // by the `...ownedForAddressless` spread below. `protocol` follows its
          // ownership decision above; `ipmiHost` follows its own, refreshed only
          // where this sync writes the value (the `takesIpmiHost` line below) and
          // otherwise carried forward — including as `undefined`, which keeps a hand
          // entry hands-off (matrix row 5). `templated` is the matrix's carried
          // stamp record (writes folded in), same as the addressed update path.
          syncedProtocol: clearsProtocol ? undefined : ownedForAddressless.origin?.syncedProtocol,
          syncedIpmiHost: takesIpmiHost ? mgmtHost : ownedForAddressless.origin?.syncedIpmiHost,
          // PRIMARY HOST/PORT (task #29) — the same `takes? written : carry`
          // discipline as the stamps above. When the address is BLANKED the sync
          // owns nothing there anymore, so the stamp is dropped to `undefined` (a
          // placeholder owns no address); when a hand-typed address is PRESERVED
          // the existing stamp is carried forward VERBATIM (the ...origin spread
          // already carries it, but pinning it here documents the intent and
          // guards against the spread being reordered). These override the spread.
          syncedHost: blanksAddress ? undefined : ownedForAddressless.origin?.syncedHost,
          syncedPort: blanksAddress ? undefined : ownedForAddressless.origin?.syncedPort,
          templated: templateMatrix.templated
        };
        const after: ServerConfig = {
          ...ownedForAddressless,
          name: device.name,
          group: addresslessGroup,
          // The template field writes (proxy/multiplexing/legacyAlgorithms/logSession
          // /ipmiAuthProfileId/ipmiGatewayServerId) on exactly the rows the matrix
          // owns; a field it did not write is preserved by the spread above.
          ...templateMatrix.values,
          origin: afterOrigin
        };
        // PRIMARY HOST/PORT (task #29) — blank to the placeholder shape only when
        // the sync owns the address; otherwise the ...ownedForAddressless spread
        // preserves the hand-typed host/port and the record stays ADDRESSED (no
        // `addressless` flag), which is why the flag is cleared rather than set.
        if (blanksAddress) {
          after.host = "";
          after.port = ADDRESSLESS_PORT;
          after.addressless = true;
        } else {
          delete after.addressless;
        }
        if (afterProtocol === undefined) {
          delete after.protocol;
        } else {
          after.protocol = afterProtocol;
        }
        // §5.3 REPAIR — the matrix found a template-owned self-proxy and asks for its
        // removal (the stamp is already dropped from `templated`), so both the proxy
        // removal and the stamp change show in the `changed` comparison below.
        if (templateMatrix.clearProxy) {
          delete after.proxy;
        }
        // The value half of the `ipmiHost` decision, on exactly the rows
        // `syncOwnsIpmiHost` answered yes for — a conditional assignment (not a
        // member of the literal) so the `...ownedForAddressless` spread preserves
        // a hand-edited value on the rows this must not touch.
        if (takesIpmiHost) {
          after.ipmiHost = mgmtHost;
        }
        // AUTH 2b on DOWNGRADE (Fable P1-B) — the same keyless-profile rollback the
        // addressed update runs (~2063) and the post-loop pass runs for skipped
        // devices (~3123). This branch marks the device "decided", so the post-loop
        // pass will NOT revisit it; without deciding the rollback HERE an owned
        // placeholder linked to a keyless key profile would stay linked and
        // unusable forever. Decided on `after` and mirroring the addressed path: a
        // usable link rides forward (verdict "none"), a keyless one unlinks (and
        // clears its stamp), and a server bringing its own key is retained.
        const rolledBackProfileId = after.authProfileId;
        const mappedRollback = decideSourceAuthRollback(after, unusableProfileIds);
        if (mappedRollback === "unlink" && rolledBackProfileId !== undefined) {
          after.authProfileId = undefined;
          after.origin = { ...afterOrigin, syncedAuthProfileId: undefined };
          bump(unlinkedByProfile, rolledBackProfileId);
        } else if (mappedRollback === "retain-own-key" && rolledBackProfileId !== undefined) {
          bump(retainedByProfile, rolledBackProfileId);
        }
        // A targeted `changed` check (NOT `serverConfigsEqual`, which compares
        // `syncedAt` and would fire a no-op update on every sync of a stopped
        // node). The origin STAMPS — not `syncedAt` — decide the origin half. The
        // template value fields join the value half (the matrix can move any of
        // them on an otherwise-unchanged placeholder); their stamps ride the
        // `serverOriginStampsEqual` line, exactly as the addressed update path does.
        const changed =
          ownedForAddressless.name !== after.name ||
          ownedForAddressless.host !== after.host ||
          ownedForAddressless.port !== after.port ||
          ownedForAddressless.protocol !== after.protocol ||
          ownedForAddressless.ipmiHost !== after.ipmiHost ||
          ownedForAddressless.group !== after.group ||
          (ownedForAddressless.addressless ?? false) !== (after.addressless ?? false) ||
          // AUTH 2b (Fable P1-B) — an unlink can be the ONLY change (a keyless link
          // rolled back on a placeholder that is otherwise identical), so the
          // authProfileId value joins the value half; its stamp rides the
          // `serverOriginStampsEqual` line below.
          ownedForAddressless.authProfileId !== after.authProfileId ||
          !proxyConfigsEqual(ownedForAddressless.proxy, after.proxy) ||
          ownedForAddressless.multiplexing !== after.multiplexing ||
          ownedForAddressless.legacyAlgorithms !== after.legacyAlgorithms ||
          ownedForAddressless.logSession !== after.logSession ||
          ownedForAddressless.ipmiAuthProfileId !== after.ipmiAuthProfileId ||
          ownedForAddressless.ipmiGatewayServerId !== after.ipmiGatewayServerId ||
          !serverOriginStampsEqual(ownedForAddressless.origin, after.origin);
        if (changed) {
          updates.push({ before: ownedForAddressless, after });
          // P2-3 (Fable) — disclose the loss of a console address, but ONLY when the
          // server was previously ADDRESSED (a real downgrade) AND the address was
          // actually blanked. A stay-addressless server is unchanged in this
          // respect, and a hand-typed address the sync PRESERVED (task #29) did not
          // become addressless at all, so neither must be named every sync.
          if (blanksAddress && ownedForAddressless.addressless !== true) {
            downgradedToAddressless.push(device.name);
          }
          if (addresslessGroup !== undefined) {
            folderSet.add(addresslessGroup);
          }
        } else {
          // P3-1 (Fable) — the no-change twin of the addressed path (~2280): a
          // stay-addressless server the sync left untouched still counts toward the
          // owned total, or the preview totals do not sum and the round-4 promotion
          // decrement gate miscounts.
          unchangedCount++;
          unchangedServerIds.add(ownedForAddressless.id);
        }
      } else {
        // ADD — a fresh addressless placeholder. Minimal on purpose: no console
        // means no secondary addresses or template fields to protect yet; the
        // moment it gains a console the addressed update path fills them.
        //
        // P1-b (Codex review) — the SAME id-collision guard the addressed add
        // path uses (~2142): the addressless branch is reached only when the
        // device is NOT owned, but an UNRELATED record can still hold the
        // deterministic id — the supported ID-preserving Keep-Servers→restore
        // flow, or a hand-imported fragment. Applying the plan does
        // `servers.set(id, …)`, so an unconditional add would REPLACE that
        // record and discard its config. Skip rather than clobber; a later sync
        // where the node gains a console reaches the addressed path, which
        // resolves the collision (adoption) properly.
        const addresslessId = deterministicServerId(source.id, device.externalId);
        if (serversById.has(addresslessId)) {
          warnings.push(
            `Device "${device.name}" (${device.externalId}) has no console address, and its id collides with an existing server — left the existing server in place rather than replacing it with a placeholder.`
          );
          continue;
        }
        // P2-2 (Fable) — a kept placeholder for this device (a "Keep Servers" marker
        // for the same provider deployment) cannot be adopted by address: it has none
        // by design, and adoption corroborates by address. So a fresh placeholder is
        // minted here rather than reclaiming the kept one. WARN so the kept copy is
        // not stranded silently — the addressless ADD otherwise consults only the
        // id-collision map and would leave the user to discover the duplicate.
        const keptForAddressless = keptByExternalId.get(device.externalId) ?? [];
        if (keptForAddressless.length > 0) {
          const keptNames = namedExamples(keptForAddressless.map((s) => s.name));
          warnings.push(
            `Device "${device.name}" (${device.externalId}) has no console address and matches ${keptForAddressless.length === 1 ? "a server" : `${keptForAddressless.length} servers`} kept from a removed inventory source (${keptNames}) — a new placeholder was added because an addressless placeholder cannot be adopted by address. Once the device has a console, re-add the source and choose Adopt Existing, or delete the kept ${keptForAddressless.length === 1 ? "copy" : "copies"}.`
          );
        }
        // DEVICE TEMPLATES (Codex P2-a) — the add matrix, against this fresh id for
        // the §5.3 self-proxy check, exactly as the addressed add path runs it. A
        // fresh record has nothing to protect, so `undefined` owned server ⇒ the
        // template's values are written and stamped verbatim.
        const addMatrix = applyTemplateMatrix(undefined, addresslessDesired, {
          targetServerId: addresslessId,
          targetServerName: device.name,
          proxyTemplateName: addresslessProxyTemplateName,
          ipmiGatewayTemplateName: addresslessGatewayTemplateName
        });
        for (const w of addMatrix.warnings) {
          warnings.push(w);
        }
        if (addMatrix.values.proxy !== undefined && addresslessProxyTemplateName !== undefined) {
          proxyTemplateNameByServerId.set(addresslessId, addresslessProxyTemplateName);
        }
        if (addMatrix.values.ipmiGatewayServerId !== undefined && addresslessGatewayTemplateName !== undefined) {
          ipmiGatewayTemplateNameByServerId.set(addresslessId, addresslessGatewayTemplateName);
        }
        addresslessAdded.push(device.name);
        adds.push({
          id: addresslessId,
          name: device.name,
          host: "",
          port: ADDRESSLESS_PORT,
          addressless: true,
          username: source.defaultUsername ?? "",
          authType: "agent",
          // P1-C (Fable) — the source-level auth LINK (never the profile's
          // credentials, resolved fresh at connect time), exactly as the addressed
          // add writes it. `authType: "agent"` above stays the inert fallback if the
          // profile is later deleted. Undefined when the source/winner has no usable
          // (non-keyless, resolvable) profile — the pre-feature record, field for field.
          authProfileId: addresslessWinnerResolvedId,
          isHidden: false,
          group: addresslessGroup,
          // DEVICE TEMPLATES (Codex P2-a) — the non-auth template field values this
          // fresh placeholder starts with (ipmiAuthProfileId / ipmiGatewayServerId
          // active now; proxy/multiplexing/legacyAlgorithms/logSession inert until it
          // upgrades). Absent when the template sets none of them.
          ...addMatrix.values,
          // OOB (Codex P2) — a placeholder with no console address can still have
          // a BMC one: a BMC web-console / locally-executed IPMI needs no primary
          // console address. A fresh record has nothing to protect, so no matrix —
          // whatever this fetch offers (or `undefined`) is what the field starts
          // as, mirroring the addressed add path.
          ipmiHost: mgmtHost,
          origin: {
            sourceId: source.id,
            externalId: device.externalId,
            syncedAt: now,
            syncedInstanceKey: providerInstanceKey,
            syncedUsername: source.defaultUsername,
            // P1-C (Fable) — mirrors the `authProfileId` written above (the RESOLVED
            // id, `undefined` for a dangling/keyless winner), recorded so a later sync
            // knows the sync put this link here — exactly as the addressed add stamps it.
            syncedAuthProfileId: addresslessWinnerResolvedId,
            // Records the OOB address written above (UNCONDITIONALLY, `undefined`
            // included) so every LATER sync has the ownership question already
            // answered — matrix row 1, exactly as the addressed add path stamps it.
            syncedIpmiHost: mgmtHost,
            syncedProtocol: undefined,
            // PRIMARY HOST/PORT (task #29) — a fresh addressless placeholder owns
            // NO console address yet (its `host: ""` / `port: 0` are the sentinel
            // shape, not a synced value), so both stamps are `undefined`. The
            // moment it gains a console the addressed update path fills and stamps
            // them (matrix row 1 via `syncOwnsHost`'s blank-normalize).
            syncedHost: undefined,
            syncedPort: undefined,
            // The template stamps for the non-auth fields written above, so every
            // LATER sync has the ownership question already answered. Absent when
            // the template set none of them.
            templated: addMatrix.templated
          }
        });
        if (addresslessGroup !== undefined) {
          folderSet.add(addresslessGroup);
        }
      }
      continue;
    }
    // P3-4 (Fable) — the port was already validated (and a bad one skipped) right
    // after `selectPrimaryEndpoint` above, before the OOB extraction, so `port`
    // here is known valid.
    const endpoint = primary.endpoint;
    const deviceProtocol = primary.protocol;
    const port = endpoint.port ?? primary.defaultPort;

    // ALTERNATE HOST (issue #48, Phase 2) — the alternate SSH address this fetch
    // offers for `ServerConfig.altHost`, or `undefined` when the device supplies
    // none (matrix row 6 in `syncOwnsAltHost`). The SECOND ssh endpoint by the
    // convention `selectAltEndpoint` documents. UNLIKE the out-of-band address
    // above it needs NO address-shape validation here: it is an SSH host, and the
    // provider has already CIDR-stripped it and guaranteed it differs from the
    // primary — so it is handled exactly as the primary `endpoint.host` is (which
    // this path never validates either).
    const altEndpoint = selectAltEndpoint(device);
    const altHost = altEndpoint?.host;

    // Folder resolution: device.folderPath is relative to source.targetFolder.
    const group = resolveDeviceGroup(device);

    const id = deterministicServerId(source.id, device.externalId);

    // DEVICE TEMPLATES (PR-T2) — the PER-DEVICE cascade. Candidacy is decided by
    // `deviceMatchesFilter` (inside `selectFieldWinners`), so a filtered rule
    // contributes to THIS device only when it matches; the winners, the composed
    // non-auth desired fields, and the resolved auth winner are all device-scoped
    // from here. Emitted here (not once per source) is what lifts the T1
    // fail-closed skip. The per-field tie warnings name the device and are the
    // authoritative tie signal; the dangling-template/jump-host/auth warnings name
    // the template and are deduped (identical across devices).
    const deviceCascade = selectFieldWinners(device, prepared, source.authProfileId);
    for (const w of deviceCascade.warnings) {
      warnings.push(w); // per-field tie warnings — device-named, each distinct
    }
    for (const rid of deviceCascade.matchedRuleIds) {
      matchedRuleIds.add(rid);
    }
    const deviceComposed = composeDesiredFields(
      deviceCascade.winners,
      {
        hasServer: (jumpHostId) => liveServerIds.has(jumpHostId),
        proxyTemplateName: deviceCascade.proxyTemplateName,
        sourceName: source.name
      },
      // PR-T3 — IPMI reference validation for this device's winners; a dangling
      // id drops the field to none + a deduped warning naming the template.
      {
        hasAuthProfile: (pid) => resolveAuthProfileById(pid) !== undefined,
        hasServer: (sid) => liveServerIds.has(sid),
        ipmiAuthProfileTemplateName: deviceCascade.provenance.ipmiAuthProfileId?.templateName,
        ipmiGatewayServerTemplateName: deviceCascade.provenance.ipmiGatewayServerId?.templateName,
        sourceName: source.name
      }
    );
    const deviceDesiredNonAuth = deviceComposed.desired;
    for (const w of deviceComposed.warnings) {
      pushDedupTemplateWarning(w); // dangling jump host — names the template, identical across devices
    }
    const deviceProxyTemplateName = deviceCascade.proxyTemplateName;
    const deviceAuthWinnerField = deviceCascade.winners.authProfileId;
    const deviceWinnerProfile =
      deviceAuthWinnerField !== undefined ? resolveAuthProfileById(deviceAuthWinnerField.value) : undefined;
    if (deviceAuthWinnerField !== undefined && deviceWinnerProfile === undefined && !deviceCascade.authFromImplicit) {
      pushDedupTemplateWarning(
        `A device template rule on "${source.name}" links an auth profile that no longer exists — the auth field was skipped.`
      );
    }
    // The winner used for WRITES: dropped when it dangles. The add/fill row-1
    // write additionally drops a keyless winner (blanket per-profile refusal),
    // exactly like the source path zeroes a keyless key profile.
    const deviceEffectiveAuthWinner =
      deviceAuthWinnerField !== undefined && deviceWinnerProfile !== undefined
        ? { mode: deviceAuthWinnerField.mode, profileId: deviceAuthWinnerField.value }
        : undefined;
    const deviceWinnerKeyless = deviceWinnerProfile !== undefined && authProfileNeedsServerKeyPath(deviceWinnerProfile);
    const deviceWinnerResolvedId =
      deviceEffectiveAuthWinner !== undefined && !deviceWinnerKeyless ? deviceEffectiveAuthWinner.profileId : undefined;
    // §3.4 provenance (B2, PR-T2 review) — recorded per WRITE, not per winner. A
    // §3.4 line asserts a value FLOWED from a template onto the record, so it is
    // gated on the matrix having ACTUALLY WRITTEN that field for a device that
    // produces a plan entry: a row-6 hand-edit / rows 2/4/5/7 leave nothing to
    // report, and a dangling or keyless winner is dropped before any write. Each
    // write branch below calls this with exactly the fields it wrote; the survivor
    // pass strips a proxy entry it later restores or drops (`dropProxyProvenance`).
    const recordWrittenProvenance = (
      serverId: string,
      serverName: string,
      matrixValues: Partial<Pick<ServerConfig, "proxy" | "multiplexing" | "legacyAlgorithms" | "logSession" | "ipmiAuthProfileId" | "ipmiGatewayServerId">>,
      authWritten: boolean
    ): void => {
      const provenance: Partial<Record<TemplatableField, FieldProvenance>> = {};
      const nonAuthFields: Array<"proxy" | "multiplexing" | "legacyAlgorithms" | "logSession" | "ipmiAuthProfileId" | "ipmiGatewayServerId"> = [
        "proxy",
        "multiplexing",
        "legacyAlgorithms",
        "logSession",
        "ipmiAuthProfileId",
        "ipmiGatewayServerId"
      ];
      for (const f of nonAuthFields) {
        if (matrixValues[f] !== undefined) {
          const entry = deviceCascade.provenance[f];
          if (entry !== undefined) {
            provenance[f] = entry;
          }
        }
      }
      if (authWritten) {
        const entry = deviceCascade.provenance.authProfileId;
        if (entry !== undefined) {
          provenance.authProfileId = entry;
        }
      }
      if (Object.keys(provenance).length > 0) {
        provenanceByServer.set(serverId, { serverName, provenance });
      }
    };

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
      const takesIpmiHost =
        mgmtHost !== undefined && syncOwnsIpmiHost(ownedServer.ipmiHost, ownedServer.origin?.syncedIpmiHost, mgmtHost);
      // ALTERNATE HOST (issue #48, Phase 2) — the twin decision for `altHost`,
      // decided HERE for the same reason `takesIpmiHost` is: its stamp goes INTO
      // the origin literal below, which the retro-apply / rollback branches
      // rebuild. See `syncOwnsAltHost` for the write rule and the whole matrix.
      const takesAltHost =
        altHost !== undefined && syncOwnsAltHost(ownedServer.altHost, ownedServer.origin?.syncedAltHost, altHost);
      // TELNET (Phase 0) — the twin decision for `protocol`, decided HERE for
      // the same reason the two above it are: its stamp goes INTO the origin
      // literal below, which the retro-apply / rollback branches rebuild. No
      // `!== undefined` guard: unlike an address, the device ALWAYS implies a
      // protocol (its primary endpoint is what was just selected), so matrix
      // row 6 — "the device supplies none" — has no counterpart here.
      const takesProtocol = syncOwnsProtocol(
        ownedServer.protocol,
        ownedServer.origin?.syncedProtocol,
        deviceProtocol
      );
      // P1-C (Codex) — decide the ADDRESS against the protocol the record will
      // ACTUALLY end up with, not against the device's preferred endpoint.
      //
      // When the sync owns the protocol this is the primary endpoint and nothing
      // changes. When the USER owns it (a hand-flip the stamp protects), the
      // record keeps its transport, so the address has to come from an endpoint
      // of THAT transport — otherwise a hand-telnet server on a dual-stack
      // device was rewritten to the ssh endpoint's host and port 22, i.e. a
      // telnet profile aimed at the ssh port.
      //
      // NO MATCHING ENDPOINT ⇒ LEAVE THE ADDRESS ALONE. That is the conservative
      // branch and it is deliberate: the alternatives are to clobber the tuple
      // with the other transport's (the bug) or to drop the server (a device
      // that merely stopped advertising one of its two endpoints is not gone).
      // Staleness here is the same accepted trade the `ipmiHost` matrix's row 6
      // makes — the user's own value stands until the user changes it.
      const effectiveProtocol = takesProtocol ? deviceProtocol : ownedServer.protocol;
      const ownedEndpoint = selectEndpointForProtocol(device, effectiveProtocol);
      const ownedHost = ownedEndpoint?.endpoint.host ?? ownedServer.host;
      const ownedPort = ownedEndpoint?.port ?? ownedServer.port;
      // PRIMARY HOST/PORT (task #29) — the twin decision for `host`/`port`,
      // decided HERE for the same reason `takesIpmiHost`/`takesAltHost` are: the
      // stamps go INTO the origin literal below, which the retro-apply / rollback
      // branches rebuild. See `syncOwnsHost`/`syncOwnsPort` for the write rules
      // and the matrix. GATED on `ownedEndpoint !== undefined` — the twin of the
      // `mgmtHost !== undefined` / `altHost !== undefined` guards those two carry:
      // when no endpoint of the record's transport was found `ownedHost`/
      // `ownedPort` fall back to the RECORD'S OWN value, and feeding the record's
      // value in as `dev` would launder it into "owned" (row 5a on the record
      // instead of the device) and re-stamp a hand edit. The P1-C "no matching
      // endpoint ⇒ leave the address alone" branch is therefore a true no-op:
      // both value and stamp carry forward untouched. When the endpoint IS
      // present this is exactly the addressed decision (and the addressless
      // upgrade: `host: ""`/`port: 0` blank-normalize to absent, so the fill-in
      // row takes the device's address).
      const takesHost =
        ownedEndpoint !== undefined && syncOwnsHost(ownedServer.host, ownedServer.origin?.syncedHost, ownedHost);
      const takesPort =
        ownedEndpoint !== undefined && syncOwnsPort(ownedServer.port, ownedServer.origin?.syncedPort, ownedPort);
      // The username rides the SAME endpoint the address came from, and is
      // `undefined` when no endpoint of the record's transport was found — a
      // username belongs to an endpoint, so taking one from an endpoint whose
      // address this update deliberately did NOT take would be incoherent (and
      // would write a credential for the wrong service).
      const ownedEndpointUsername = ownedEndpoint?.endpoint.username;
      // DEVICE TEMPLATES (PR-T1) — the §4.3 matrix for the four non-auth fields.
      // `templateMatrix.templated` is the carried-forward stamp record with the
      // written fields updated (the one-line `templated:` carry-forward
      // load-bearing §5.2 regression lives here — it must go INTO the origin
      // literal, like every other stamp, since the auth branches below rebuild
      // the origin). `templateMatrix.values` are the field writes for `after`.
      //
      // FIX 3 (PR #61 Codex review) — the §5.3 self-reference check inside the
      // matrix compares `proxy.jumpHostId` against `targetServerId`, which must be
      // the id the RECORD carries — `ownedServer.id` — NOT the computed
      // deterministic `id`. The two DIVERGE for an owned server that entered with
      // a preserved id (an adoptee kept its id, or an ID-preserving imported
      // record): passing `id` would let a template proxy whose `jumpHostId ===
      // ownedServer.id` route the server through itself and go uncaught. The add
      // path (~2018) is correct with `id` because a fresh record's id IS the
      // computed `id`; the adoption path uses `adoptee.id`, same reasoning.
      const templateMatrix = applyTemplateMatrix(ownedServer, deviceDesiredNonAuth, {
        targetServerId: ownedServer.id,
        targetServerName: device.name,
        proxyTemplateName: deviceProxyTemplateName,
        // PR-T3 review FIX 2 — names the template for the IPMI-gateway self-skip.
        ipmiGatewayTemplateName: deviceCascade.provenance.ipmiGatewayServerId?.templateName
      });
      for (const w of templateMatrix.warnings) {
        warnings.push(w);
      }
      // PR-T2 review (B1/MINOR-6) — record which template set THIS run's proxy, so
      // the survivor pass can (a) validate it per-record (part 1 owns every written
      // template proxy) and (b) name the right template if its jump host does not
      // survive.
      if (templateMatrix.values.proxy !== undefined && deviceProxyTemplateName !== undefined) {
        proxyTemplateNameByServerId.set(ownedServer.id, deviceProxyTemplateName);
      }
      // PR-T3 review FIX 3 — capture the template that WROTE this run's gateway, for
      // the post-plan survivor pass (same-sync-pruned gateway warning).
      if (templateMatrix.values.ipmiGatewayServerId !== undefined) {
        const gwName = deviceCascade.provenance.ipmiGatewayServerId?.templateName;
        if (gwName !== undefined) {
          ipmiGatewayTemplateNameByServerId.set(ownedServer.id, gwName);
        }
      }
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
        syncedUsername: ownedEndpointUsername ?? ownedServer.origin?.syncedUsername,
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
        syncedIpmiHost: takesIpmiHost ? mgmtHost : ownedServer.origin?.syncedIpmiHost,
        // ALTERNATE HOST (issue #48, Phase 2) — the same "records what the sync
        // wrote" discipline one field down: refreshed exactly where this sync
        // writes `altHost` (the `takesAltHost` line below), and otherwise carried
        // forward VERBATIM — including as `undefined`, which keeps a Phase-1 hand
        // entry hands-off and a cleared-value opt-out (matrix row 2) cleared. The
        // carry-forward is load-bearing for the reason `syncedIpmiHost`'s is: an
        // update fired for an unrelated reason rebuilds this literal from scratch.
        syncedAltHost: takesAltHost ? altHost : ownedServer.origin?.syncedAltHost,
        // TELNET (Phase 0) — the same "records what the sync wrote" discipline
        // one field down: refreshed exactly where this sync writes `protocol`,
        // and otherwise carried forward VERBATIM — including as `undefined`,
        // which is what keeps a hand-flip to telnet hand-owned. Laundering the
        // record's current value into the stamp here would let the sync AFTER
        // this one overwrite the user's choice.
        syncedProtocol: takesProtocol ? deviceProtocol : ownedServer.origin?.syncedProtocol,
        // PRIMARY HOST/PORT (task #29) — the same "records what the sync wrote"
        // discipline one field down: refreshed exactly where this sync writes
        // `host`/`port` (the `takesHost`/`takesPort` lines below), and otherwise
        // carried forward VERBATIM — including as `undefined`, which keeps a
        // hand-edited address hand-owned and a placeholder's absent stamp absent.
        // The carry-forward is load-bearing for the reason `syncedAltHost`'s is:
        // an update fired for an unrelated reason rebuilds this literal from scratch.
        syncedHost: takesHost ? ownedHost : ownedServer.origin?.syncedHost,
        syncedPort: takesPort ? ownedPort : ownedServer.origin?.syncedPort,
        // DEVICE TEMPLATES (PR-T1) — the per-field template stamps, carried
        // forward with this run's writes already folded in by the matrix above.
        // The one-line carry-forward the whole feature turns on (§5.2 / fixture
        // 11): an update fired for an unrelated reason rebuilds this literal from
        // scratch, and a rebuild that dropped this member would erase the fleet's
        // template ownership.
        templated: templateMatrix.templated
      };
      const after: ServerConfig = {
        ...ownedServer,
        name: device.name,
        group,
        ...templateMatrix.values,
        origin: afterOrigin
      };
      // §5.3 REPAIR — the matrix found a TEMPLATE-OWNED self-proxy already on the
      // record and asks for its removal (a value the connect-time circular guard
      // refuses, cleared rather than carried, mirroring the survivor cleanup).
      // The stamp is already dropped (matrix omitted `templated.proxy`), so the
      // `changed` comparison sees both the proxy removal and the stamp change.
      if (templateMatrix.clearProxy) {
        delete after.proxy;
      }
      if (ownedEndpointUsername !== undefined) {
        after.username = ownedEndpointUsername;
      }
      // PRIMARY HOST/PORT (task #29) — the value half of the decision stamped
      // above, on exactly the rows `syncOwnsHost`/`syncOwnsPort` answer yes for,
      // so the record and its stamp can never disagree about who owns the field.
      // Conditional assignments (not members of the literal) so the
      // `...ownedServer` spread PRESERVES a hand-edited address on the rows this
      // must not touch — the deliberate behavior change (host/port were written
      // unconditionally before). The addressless UPGRADE lands here too: a
      // placeholder that gained a console has `takesHost`/`takesPort` true (its
      // blank/sentinel address reads as absent, so the device fills it).
      if (takesHost) {
        after.host = ownedHost;
      }
      if (takesPort) {
        after.port = ownedPort;
      }
      if (takesIpmiHost) {
        after.ipmiHost = mgmtHost;
      }
      // ALTERNATE HOST (issue #48, Phase 2) — the value half of the decision
      // stamped above, on exactly the rows `syncOwnsAltHost` answers yes for, so
      // the record and its stamp can never disagree about who owns the field.
      // A conditional assignment (not a member of the literal) so the `...ownedServer`
      // spread preserves the value on the rows this must not touch.
      if (takesAltHost) {
        after.altHost = altHost;
      }
      // TELNET (Phase 0) — the value half of the decision stamped above, on
      // exactly the rows `syncOwnsProtocol` answers yes for, so the record and
      // its stamp can never disagree about who owns the field. A conditional
      // assignment (not a member of the literal) so the `...ownedServer` spread
      // preserves a hand-flipped protocol on the rows this must not touch.
      if (takesProtocol) {
        after.protocol = deviceProtocol;
      }
      // ADDRESSLESS (Codex P1) — the UPGRADE half: an owned server that was
      // addressless (device just gained a console) becomes addressed here,
      // host/port/protocol already filled above. For a normal addressed server the
      // field was absent, so the clear is a no-op.
      //
      // P1-A (Fable) — clear the flag ONLY when the record actually GAINED an
      // address (`ownedEndpoint !== undefined`). This branch runs whenever the
      // device has a usable PRIMARY endpoint, but `selectEndpointForProtocol`
      // returns undefined when the record's protocol is user-owned (a hand-flip)
      // and the device offers only the OTHER transport — leaving `ownedHost`/
      // `ownedPort` at the record's carried ""/0. Clearing the flag there wrote an
      // invalid `{host:"",port:0}` record with no addressless flag, which
      // `validateServerConfig` rejects and storage silently drops on the next
      // reload. When no address was gained the placeholder stays addressless.
      if (ownedEndpoint !== undefined && after.addressless !== undefined) {
        delete after.addressless;
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
      // argue for) live in `authFillEligible` (services/inventory/templateApply.ts),
      // because the ADOPT 1 branch below asks the same question of a kept server —
      // it runs the SAME `decideTemplateAuthWrite` as of round 3 — and the two must
      // not be able to answer it differently. The reasoning stays HERE, where the
      // rule is applied to the population it was written about.
      //
      // DEVICE TEMPLATES (PR-T1) — this retro-apply is now the FILL branch of the
      // general cascade auth write: the winning candidate is the implicit
      // source-level rule (fill) when no explicit rule sets `authProfileId`, so
      // when there are no template rules this is bit-for-bit the shipped
      // behaviour. `decideTemplateAuthWrite` folds in the override MOVE (rows 3/4,
      // per-target usability) and the fill write-once mode gate; the six-clause
      // fill eligibility is the `authFillEligible` predicate it delegates to.
      const authDecision = decideTemplateAuthWrite(ownedServer, deviceEffectiveAuthWinner, deviceWinnerProfile, source.defaultUsername);
      if (authDecision.kind === "write") {
        after.authProfileId = authDecision.profileId;
        // The stamp is written HERE, in the same breath as the link itself —
        // that is what makes a LATER clear of this link visible to the next sync
        // as an opt-out instead of reading as "never linked" and being
        // reattached forever. `{ ...afterOrigin }` preserves the template stamps.
        after.origin = { ...afterOrigin, syncedAuthProfileId: authDecision.profileId };
      } else if (authDecision.kind === "skip-usability") {
        // §4.4 rev7 — an OVERRIDE move onto a keyless key profile the target
        // cannot satisfy (no own key). The link stays put and un-re-stamped; the
        // plan names the profile and the reason after both rollback passes.
        const names = overrideRefusedByProfile.get(authDecision.profileId) ?? [];
        names.push(ownedServer.name);
        overrideRefusedByProfile.set(authDecision.profileId, names);
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
      //
      // DEVICE TEMPLATES (PR-T1) — decided on `after` (the post-template-write
      // link), not `ownedServer`: an override rule that just moved this server's
      // link to a USABLE profile must not then be second-guessed by a rollback
      // reading the pre-move link. `after` and `ownedServer` differ here only
      // when a template auth write fired, and that write only lands a usable
      // link, so the two agree in every shipped-behaviour case. The set is the
      // widened `profilesNeedingServerKey` (source + template + retained links).
      const rolledBackProfileId = after.authProfileId;
      const mappedRollback = decideSourceAuthRollback(after, unusableProfileIds);
      if (mappedRollback === "unlink" && rolledBackProfileId !== undefined) {
        after.authProfileId = undefined;
        // The stamp goes with the link it describes — leaving it behind would
        // read as a per-server opt-out nobody chose and lock the server out of
        // retro-apply forever, which is exactly the reasoning removeAuthProfile
        // applies when a deleted profile's links are cleared.
        after.origin = { ...afterOrigin, syncedAuthProfileId: undefined };
        bump(unlinkedByProfile, rolledBackProfileId);
      } else if (mappedRollback === "retain-own-key" && rolledBackProfileId !== undefined) {
        bump(retainedByProfile, rolledBackProfileId);
      }

      // ALTERNATE HOST (issue #48, M3b) — enforce the `altHost !== host` invariant
      // `computeSyncPlan` claims (~1110). `selectAltEndpoint` (M3a) guarantees any
      // value THIS sync WRITES already differs from the primary, so the only way
      // `after` can leave here with `altHost === host` is the pure-carry route (b):
      // a device that lost its second address family so the primary `host` flips to
      // the value the CARRIED `altHost` was still holding (matrix row 6 carried the
      // old alternate forward, and `endpoint.host` is now that same address). A
      // dangling self-duplicate is not a value the sync should persist — drop it and
      // clear its stamp so the record and its provenance agree the field is unset.
      // Run AFTER the origin rebuilds above so the stamp clear survives them; the
      // `ipmiHost` paths are deliberately untouched (they carry no such invariant).
      // Self-healing: the run that regains a second family re-fills `altHost` as an
      // ordinary row-1 write.
      // PROVENANCE-GATED (PR #67 Codex round 1, P2) — drop ONLY a value the sync
      // OWNS (`syncedAltHost === altHost`). A HAND-entered `altHost` that a device
      // later reports as its new primary is NOT the sync's to delete: hand edits are
      // untouched (the whole point of `syncOwnsAltHost`), and clearing it would
      // permanently lose the user's fallback if the primary later flips back with no
      // provider-supplied alternate. A hand value that happens to equal `host` stays;
      // `SshPty` simply skips the redundant retry while it does.
      if (
        after.altHost !== undefined &&
        after.altHost === after.host &&
        after.origin !== undefined &&
        after.origin.syncedAltHost === after.altHost
      ) {
        after.altHost = undefined;
        after.origin = { ...after.origin, syncedAltHost: undefined };
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
      // stamp rides in on the `serverOriginStampsEqual` line. The two clauses do
      // NOT agree on every input, and the disagreement is the whole point of the
      // stamp half: matrix row 5a (`syncOwnsIpmiHost`) is a STAMP-ONLY change —
      // a record whose `ipmiHost` already equals the device's out-of-band
      // address gains a `syncedIpmiHost` while every user-visible field, that
      // one included, stays byte-identical. That is AUTH 3a's shape exactly, and
      // dropping such an `after` as "unchanged" would throw the computed stamp
      // away, leaving the server unable to EVER gain one — the field then goes
      // stale the first time NetBox re-addresses the BMC and nothing repairs it.
      // The value clause is kept beside it because it states the plainly-visible
      // half of the change (rows 1 and 3) and does not depend on the stamp
      // comparator's membership list staying correct.
      //
      // DEVICE TEMPLATES (PR-T1) — the four non-auth template value fields join
      // the comparison, because the matrix can now change any of them on an
      // otherwise-unchanged device; the origin half (the `templated` stamps)
      // rides in on the `serverOriginStampsEqual` line, which — like the AUTH 3a
      // shape — can be the ONLY difference between `before` and `after` (a
      // template first attaching, or a stamp-only re-record).
      const changed =
        ownedServer.name !== after.name ||
        ownedServer.host !== after.host ||
        ownedServer.port !== after.port ||
        ownedServer.group !== after.group ||
        // ADDRESSLESS (Codex P1) — the UPGRADE clearing the flag can be the
        // change (host filling always co-changes it here, but pinning the flag
        // makes the intent explicit and covers a value-identical upgrade).
        (ownedServer.addressless ?? false) !== (after.addressless ?? false) ||
        ownedServer.authProfileId !== after.authProfileId ||
        ownedServer.ipmiHost !== after.ipmiHost ||
        // ALTERNATE HOST (issue #48, Phase 2) — joins the value half for the same
        // reason `ipmiHost` does (rows 1 and 3, the plainly-visible change); the
        // stamp-only row 5a rides in on the `serverOriginStampsEqual` line below.
        ownedServer.altHost !== after.altHost ||
        // TELNET (Phase 0) — joins the value half for the same reason `altHost`
        // does: a device that changed transport moves this field and nothing
        // else, and a `changed` check that skipped it would compute the write,
        // discard the update as "unchanged", and leave the record pointing at a
        // protocol the device no longer offers. The stamp-only row rides in on
        // the `serverOriginStampsEqual` line below.
        ownedServer.protocol !== after.protocol ||
        !proxyConfigsEqual(ownedServer.proxy, after.proxy) ||
        ownedServer.multiplexing !== after.multiplexing ||
        ownedServer.legacyAlgorithms !== after.legacyAlgorithms ||
        ownedServer.logSession !== after.logSession ||
        // PR-T3 — the two IPMI id-reference value fields join the value half; the
        // origin half (their `templated` stamps) rides in on serverOriginStampsEqual.
        ownedServer.ipmiAuthProfileId !== after.ipmiAuthProfileId ||
        ownedServer.ipmiGatewayServerId !== after.ipmiGatewayServerId ||
        !serverOriginStampsEqual(ownedServer.origin, after.origin) ||
        (ownedEndpointUsername !== undefined && ownedServer.username !== after.username);
      if (changed) {
        updates.push({ before: ownedServer, after });
        if (group !== undefined) {
          folderSet.add(group);
        }
        // §3.4 (B2) — only the fields the matrix wrote, and the auth link only if
        // it was actually written AND survived any AUTH 2b rollback (a rolled-back
        // link was dropped, so it flowed nowhere).
        recordWrittenProvenance(
          ownedServer.id,
          device.name,
          templateMatrix.values,
          authDecision.kind === "write" && after.authProfileId === authDecision.profileId
        );
      } else {
        unchangedCount++;
        unchangedServerIds.add(ownedServer.id);
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
          `Device "${device.name}" (${device.externalId}) was previously synced onto server "${collidingServer.name}", which is now at ${renderServerAddress(collidingServer)} while the device is at ${endpoint.host}:${port} — and it still uses the id a new server for this device would need, so the device is skipped rather than added as a new server. Point "${collidingServer.name}" back at ${endpoint.host}:${port} and sync again to reclaim it with Adopt Existing, or delete it and the next sync adds the device fresh.`
        );
      } else if (eligibleForAdoption.length === 1) {
        warnings.push(
          `Device "${device.name}" (${device.externalId}) matches server "${eligibleForAdoption[0].name}" kept from a removed inventory source at ${endpoint.host}:${port}, but server "${collidingServer.name}" — kept from an earlier sync of this same device, now at ${renderServerAddress(collidingServer)} — still uses the id a new server for this device would need, so the device is skipped rather than offered for adoption. Delete "${collidingServer.name}", then sync again and choose Adopt Existing to reclaim "${eligibleForAdoption[0].name}".`
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
        //
        // OOB — the ownership matrix, decided HERE for the same reason the
        // update path decides it before its own origin literal: the stamp has to
        // go INTO that literal, because the retro-apply branch below REBUILDS
        // the origin as `{ ...adoptionOrigin, syncedAuthProfileId: … }` and
        // would silently discard anything stamped onto `after.origin`
        // afterwards. The one substitution that makes it the SAME decision on a
        // record this sync did not create: the marker's receipt stands in for
        // the origin stamp, which is precisely what
        // `DetachedServerOrigin.syncedIpmiHost` was added to preserve. See
        // `syncOwnsIpmiHost` for the write rule and the whole matrix.
        const takesIpmiHost =
          mgmtHost !== undefined &&
          syncOwnsIpmiHost(adoptee.ipmiHost, adoptee.formerlySynced?.syncedIpmiHost, mgmtHost);
        // ALTERNATE HOST (issue #48, Phase 2) — the twin decision on an adoptee,
        // the same substitution the OOB one makes: the marker's receipt
        // (`DetachedServerOrigin.syncedAltHost`) stands in for the origin stamp on
        // a record this sync did not create. See `syncOwnsAltHost` for the matrix.
        const takesAltHost =
          altHost !== undefined &&
          syncOwnsAltHost(adoptee.altHost, adoptee.formerlySynced?.syncedAltHost, altHost);
        // TELNET (Phase 0) — the twin decision on an adoptee, with the same
        // substitution: `DetachedServerOrigin.syncedProtocol` stands in for the
        // origin stamp on a record this sync did not create. No `!== undefined`
        // guard — the device always implies a protocol.
        const takesProtocol = syncOwnsProtocol(
          adoptee.protocol,
          adoptee.formerlySynced?.syncedProtocol,
          deviceProtocol
        );
        // FIX 1 (PR #61 Codex review) — APPLY THE TEMPLATE MATRIX ON ADOPTION,
        // mirroring the update path (~1071). An adopted server is OWNED from this
        // point (the same principle the `endpoint.username` and OOB writes below
        // invoke, and the design's "implicit source rule IS the lowest template
        // rule" — source-auth already retro-applies at adoption, so the rest of
        // the cascade must too). Deferring the non-auth writes would leave the
        // adopted server usable with stale proxy/booleans for one whole sync until
        // the next run's update path applies the identical write.
        //
        // `targetServerId: adoptee.id` — the adoptee keeps its own id through
        // adoption, so the §5.3 self-reference check judges the proxy against the
        // record's real id (this is Fix 3's rule on the adoption path). The stamp
        // (`matrix.templated`) goes INTO `adoptionOrigin` below, because the auth
        // branch rebuilds the origin as `{ ...adoptionOrigin, syncedAuthProfileId }`
        // and would silently discard anything stamped onto `after.origin` after the
        // literal — exactly the discipline the OOB/AUTH stamps already follow here.
        // FIX A (PR #61 Codex review round 2) — RESTORE `origin.templated` from
        // the marker BEFORE the matrix runs. The matrix reads ownership off
        // `ownedServer.origin?.templated` (the `carried` baseline), but a kept
        // server has no `origin` at all, so without this every template-managed
        // field would read as `cur set, stamp absent` → row 7 (hand-owned) and an
        // override template could never reclaim or re-stamp it — the auth/OOB
        // receipts closed that failure for their fields, `templated` reopens it
        // for the non-auth ones unless restored here. Feed a synthetic origin
        // carrying only the receipt's `templated` (the sole member the matrix
        // reads from `origin`); the matrix then composes its this-run writes ON
        // TOP of this restored baseline, carrying forward the fields it does not
        // write (a fill winner leaves a configured field; a field the template no
        // longer sets keeps its old stamp). Restored VERBATIM — a marker carrying
        // none yields the unchanged adoptee, bit-identical to a server no template
        // ever touched. No clone needed on this READ-ONLY input: the matrix
        // deep-copies `carried` into its own result, so the receipt is never
        // aliased into `adoptionOrigin.templated`.
        const restoredTemplated = adoptee.formerlySynced?.templated;
        const adopteeForMatrix: ServerConfig =
          restoredTemplated !== undefined
            ? { ...adoptee, origin: { sourceId: source.id, externalId: device.externalId, syncedAt: now, templated: restoredTemplated } }
            : adoptee;
        const templateMatrix = applyTemplateMatrix(adopteeForMatrix, deviceDesiredNonAuth, {
          targetServerId: adoptee.id,
          targetServerName: device.name,
          proxyTemplateName: deviceProxyTemplateName,
          // PR-T3 review FIX 2 — names the template for the IPMI-gateway self-skip.
          ipmiGatewayTemplateName: deviceCascade.provenance.ipmiGatewayServerId?.templateName
        });
        for (const w of templateMatrix.warnings) {
          warnings.push(w);
        }
        // PR-T2 review (B1/MINOR-6) — same per-record proxy-template capture as the
        // owned-update path, keyed by the adoptee's (preserved) id.
        if (templateMatrix.values.proxy !== undefined && deviceProxyTemplateName !== undefined) {
          proxyTemplateNameByServerId.set(adoptee.id, deviceProxyTemplateName);
        }
        // PR-T3 review FIX 3 — same gateway-template capture as the owned-update path.
        if (templateMatrix.values.ipmiGatewayServerId !== undefined) {
          const gwName = deviceCascade.provenance.ipmiGatewayServerId?.templateName;
          if (gwName !== undefined) {
            ipmiGatewayTemplateNameByServerId.set(adoptee.id, gwName);
          }
        }
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
          syncedAuthProfileId: adoptee.formerlySynced?.syncedAuthProfileId,
          // OOB (PR-A REVIEW FINDING; matrix re-run per the Codex round-2
          // finding) — the same "records what the sync wrote" discipline the two
          // stamps above obey, now that `takesIpmiHost` has run the full matrix
          // on this record: written from `mgmtHost` exactly where THIS sync
          // writes `ipmiHost` (the conditional below the literal), and otherwise
          // the marker's receipt RESTORED VERBATIM — including as `undefined`,
          // which is what keeps a hand-typed address hands-off (matrix row 5).
          //
          // An earlier revision stamped nothing here at all and framed that as
          // inherent ("the marker carries no OOB stamp to restore"); it was a
          // DECISION, and it is reversed — `DetachedServerOrigin.syncedIpmiHost`
          // preserves the removed source's own stamp across the detach, so there
          // is a receipt, and it is what lets this record be judged by the same
          // matrix as every owned server.
          //
          // WHY THE ADOPTION APPLIES THE ADDRESS INSTEAD OF ONLY RESTORING THE
          // RECEIPT (REVIEW FINDING, P2) — the `endpoint.username` argument
          // below, verbatim: an adopted server is OWNED from this point, and the
          // ordinary update path writes the device's OOB address onto every
          // owned server whose stamp still matches, so restoring the receipt and
          // stopping there would only defer the identical overwrite to the next
          // sync while leaving one run where the source does not own a field it
          // owns everywhere else. Concretely: a BMC re-addressed in NetBox while
          // the source was detached would leave the adopted server pointing at
          // the dead address for a whole sync, repaired only by the run after
          // the one the user actually approved.
          //
          // Still never `adoptee.ipmiHost`, for the reason that was always
          // given: a hand-typed address is history's doing and recording it
          // would claim an ownership no sync ever had. The marker is a different
          // thing — it is a SYNC's record of what a SYNC wrote — and losing it
          // at the detach is what made an adopted server's BMC address
          // unmaintainable: it arrived looking hand-typed (matrix row 5), so no
          // later sync could follow the BMC when NetBox re-addressed it.
          //
          // A marker carrying none is bit-identical to a server the sync never
          // wrote an address on, and the matrix reads it that way: an unset
          // `ipmiHost` is filled and stamped here (row 1), a value the adoptee
          // brought with it is left alone (row 5) with no stamp invented for it,
          // and a device offering no OOB endpoint at all touches neither (row 6,
          // the `mgmtHost !== undefined` guard) — the receipt simply carries.
          syncedIpmiHost: takesIpmiHost ? mgmtHost : adoptee.formerlySynced?.syncedIpmiHost,
          // ALTERNATE HOST (issue #48, Phase 2) — the same "records what the sync
          // wrote" discipline as `syncedIpmiHost` above, applied to the adoptee:
          // written from `altHost` exactly where THIS sync writes `altHost` (the
          // conditional below the literal), and otherwise the marker's receipt
          // RESTORED VERBATIM — including as `undefined`, which keeps a hand-typed
          // alternate hands-off (matrix row 5). A marker carrying none is
          // bit-identical to a server the sync never wrote a second address on.
          syncedAltHost: takesAltHost ? altHost : adoptee.formerlySynced?.syncedAltHost,
          // TELNET (Phase 0) — the same discipline one field down: written from
          // this fetch's protocol exactly where THIS sync writes `protocol`, and
          // otherwise the marker's receipt RESTORED VERBATIM, which is what
          // keeps a protocol the user flipped before the detach hand-owned.
          syncedProtocol: takesProtocol ? deviceProtocol : adoptee.formerlySynced?.syncedProtocol,
          // PRIMARY HOST/PORT (task #29) — stamped from the ADDRESS THIS ADOPTION
          // WRITES (`endpoint.host` / `port`, the same values assigned onto
          // `after` below), UNCONDITIONALLY, exactly as the add path stamps a
          // fresh record. Unlike `syncedIpmiHost`/`syncedAltHost` — which may or
          // may not be written this run and so restore from the marker receipt —
          // adoption ALWAYS writes `host`/`port` (it only adopts when the record's
          // address already corroborates the device's, up to case), so it
          // genuinely owns the address and stamps it directly. There is no
          // `DetachedServerOrigin` receipt for these (see models/config.ts) and
          // none is needed: the value is the device's by corroboration, so
          // stamping it here is truthful and it spares every adopted server a
          // spurious stamp-only update on its first post-adoption sync (which a
          // `syncedHost: undefined` here would guarantee via matrix row 5a).
          syncedHost: endpoint.host,
          syncedPort: port,
          // FIX 1 — the per-field template stamps for the non-auth fields the
          // matrix above wrote onto this adoptee, folded into the origin literal
          // so the auth-branch rebuild (`{ ...adoptionOrigin, syncedAuthProfileId }`)
          // preserves them, exactly as the update path folds `templateMatrix.templated`
          // into `afterOrigin`. Undefined when the source has no proxy/boolean
          // template winner (the shipped no-template case), which `toEqual` reads
          // as absent.
          templated: templateMatrix.templated
        };
        const after: ServerConfig = {
          ...adoptee,
          name: device.name,
          // Equal to the adoptee's host up to case (the corroboration above),
          // so this only ever re-cases it — the source owns the field.
          host: endpoint.host,
          port,
          group,
          // FIX 1 — the non-auth template field VALUES (proxy / multiplexing /
          // legacyAlgorithms / logSession) the matrix resolved for this adoptee.
          // AFTER `...adoptee` so a template write overrides the spread; a field
          // the matrix left alone (rows 2/4/5/6/7) is absent here and the spread's
          // value stands.
          ...templateMatrix.values,
          origin: adoptionOrigin,
          // MUTUALLY EXCLUSIVE WITH `origin` — and EXPLICIT, because the spread
          // above would otherwise carry the marker onto a now-owned server. A
          // record holding both says two contradictory things about who manages
          // it, and the marker would go on advertising this server for adoption
          // by the next source of the same provider.
          formerlySynced: undefined
        };
        // §5.3 REPAIR — an adopted server whose restored receipt carried a
        // template-owned self-proxy is repaired at adoption, same as the update
        // path: the matrix dropped the stamp and asks the caller to remove the
        // record's `proxy` field (a value the connect-time circular guard refuses).
        if (templateMatrix.clearProxy) {
          delete after.proxy;
        }
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
        // OOB — the value half of the decision stamped above, written on exactly
        // the rows `syncOwnsIpmiHost` answers yes for and skipped on every other,
        // so the record and its stamp can never disagree about who owns the
        // field. Same shape as the username write above and as the update path's
        // own `after.ipmiHost = mgmtHost`: a conditional assignment rather than a
        // member of the literal, because the literal's `...adoptee` spread is
        // what preserves the value on the rows this must not touch.
        if (takesIpmiHost) {
          after.ipmiHost = mgmtHost;
        }
        // ALTERNATE HOST (issue #48, Phase 2) — the value half of the alternate-host
        // decision stamped above, written on exactly the rows `syncOwnsAltHost`
        // answers yes for. Conditional (not in the literal) so the `...adoptee`
        // spread preserves the value on the rows this must not touch.
        if (takesAltHost) {
          after.altHost = altHost;
        }
        // TELNET (Phase 0) — the value half of the protocol decision stamped
        // above, on exactly the rows `syncOwnsProtocol` answers yes for.
        if (takesProtocol) {
          after.protocol = deviceProtocol;
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
        // ADOPTEE CAN NOW FAIL. `authFillEligible`'s opt-out clause reads the
        // preserved `formerlySynced` marker when there is no origin — an owned
        // server answers from its `origin` stamp, a kept one from the copy the
        // detach preserved (`DetachedServerOrigin.syncedAuthProfileId`), and a
        // record carrying both answers from its origin. So a kept server whose
        // sync-applied profile the
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
        //
        // FIX 1 (PR #61 Codex review) / FIX A (round 3) — adoption now runs the
        // FULL auth matrix (FILL + the OVERRIDE MOVE), through the very same
        // `decideTemplateAuthWrite` the update path uses (~1344), instead of the
        // fill-only `qualifiesForSourceProfileRetroApply`. Round 2's restore of the
        // receipt into `adoptionOrigin.syncedAuthProfileId` (above) is what makes
        // the override move REACHABLE here: an adoptee that arrives still carrying
        // the link A a removed source applied is now PROVABLY sync-owned
        // (`authProfileId === origin.syncedAuthProfileId`, both naming A once the
        // stamp is restored), so an OVERRIDE template winner naming a different
        // profile B MOVES A→B at adoption (rows 3/4) exactly as the update path
        // does — no longer left at A until the next sync. This is the auth twin of
        // round 2's non-auth restore, which already lets an override winner reclaim
        // proxy/booleans on adoption; the auth link was simply the one still on the
        // fill-only path. An earlier revision of this comment asserted the move was
        // "structurally unreachable because the adoptee has NO origin" — that
        // premise was true BEFORE the round-2 restore and is now FALSE.
        //
        // The decision reads its ownership fields off an adoption VIEW, `{ ...adoptee,
        // origin: adoptionOrigin }` — the retained link plus the restored stamps — so
        // both the override move's `origin.syncedAuthProfileId === authProfileId`
        // check and the FILL baseline (`origin.syncedUsername ?? source.defaultUsername`,
        // which for every shipped provider — no endpoint username — is exactly the
        // `defaultUsername` the fill-only call passed before) read the receipt rather
        // than a missing origin. `winnerProfile` / `effectiveAuthWinner` are the same
        // inputs the update path consumes, so the gates match it exactly: the FILL
        // write drops a keyless winner per profile (blanket), while the OVERRIDE move
        // gates PER TARGET via `authLinkUsableForTarget` (§4.4 rev7) — a keyless B
        // still links an adoptee bringing its own key, and is refused (with the plan
        // warning) for one that cannot. Semantics that fall out (verify, don't
        // reimplement): override B over a sync-owned link A → move + re-stamp (THE
        // FIX); fill winner over a never-configured server → link (six clauses); fill
        // winner over a configured link → left (write-once); a hand link (stamp absent
        // or ≠ cur) → left even by override (rows 6/7); a user-cleared link (row-2
        // opt-out) → not re-linked by fill, override the deliberate way past.
        //
        // The write + re-stamp land in `after.origin`, rebuilt from `adoptionOrigin`
        // so the round-2 non-auth `templated` stamp folded into it is preserved (not
        // clobbered); a `leave`/`skip-usability` keeps `after.origin === adoptionOrigin`,
        // which already carries the restored auth stamp. This is the ONLY change to
        // the adoption auth path: the AUTH 2b rollback below is still NOT run here and
        // its one-sync deferral is UNCHANGED and still correct — that deferral note now
        // governs only the rollback, never this override move, which fires THIS run.
        const adoptionAuthView: ServerConfig = { ...adoptee, origin: adoptionOrigin };
        const authDecision = decideTemplateAuthWrite(adoptionAuthView, deviceEffectiveAuthWinner, deviceWinnerProfile, source.defaultUsername);
        if (authDecision.kind === "write") {
          after.authProfileId = authDecision.profileId;
          after.origin = { ...adoptionOrigin, syncedAuthProfileId: authDecision.profileId };
        } else if (authDecision.kind === "skip-usability") {
          // §4.4 rev7 — an OVERRIDE move onto a keyless key profile this adoptee
          // cannot satisfy (no own key). The link stays at A and the restored stamp
          // stands; the same post-loop pass (`overrideRefusedByProfile`) names the
          // profile and the reason, exactly as it does for the update path.
          const names = overrideRefusedByProfile.get(authDecision.profileId) ?? [];
          names.push(device.name);
          overrideRefusedByProfile.set(authDecision.profileId, names);
        }
        // ALTERNATE HOST (issue #48, M3b) — the same `altHost !== host` invariant
        // enforcement as the update path (~1660), applied to the adoptee. Adoption
        // writes `host = endpoint.host` while carrying the adoptee's own `altHost`
        // through the `...adoptee` spread, so the pure-carry route (b) can land an
        // `altHost === host` here exactly as it can on an owned update. Drop the
        // dangling self-duplicate and clear its stamp, AFTER the origin rebuilds
        // above so the clear survives them; the `ipmiHost` path is untouched.
        // PROVENANCE-GATED (PR #67 Codex round 1, P2) — same as the owned-update
        // path: drop ONLY a sync-owned duplicate (`syncedAltHost === altHost`), never
        // a hand-entered `altHost` the adoptee brought that now equals the primary.
        if (
          after.altHost !== undefined &&
          after.altHost === after.host &&
          after.origin !== undefined &&
          after.origin.syncedAltHost === after.altHost
        ) {
          after.altHost = undefined;
          after.origin = { ...after.origin, syncedAltHost: undefined };
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
        // §3.4 (B2) — only the fields this adoption actually wrote.
        recordWrittenProvenance(
          adoptee.id,
          device.name,
          templateMatrix.values,
          authDecision.kind === "write" && after.authProfileId === authDecision.profileId
        );
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
          ? `Device "${device.name}" was previously synced onto server "${keptMatches[0].name}", but that server is now at ${renderServerAddress(keptMatches[0])} and the device is at ${endpoint.host}:${port} — it will be added as a new server instead.`
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

    // DEVICE TEMPLATES (PR-T1) — a fresh record is unset in every field, so every
    // desired non-auth field is matrix row 1 (write + stamp, both modes); the
    // link is the cascade winner's keyless-dropped id (§4.5: fresh device → write
    // T + stamp, there is nothing to override yet). `winnerResolvedId` equals the
    // source's own `resolvedProfileId` when no explicit rule sets auth, so a
    // template-less sync adds exactly the record it did before.
    const addMatrix = applyTemplateMatrix(undefined, deviceDesiredNonAuth, {
      targetServerId: id,
      targetServerName: device.name,
      proxyTemplateName: deviceProxyTemplateName,
      // PR-T3 review FIX 2 — names the template for the IPMI-gateway self-skip. A
      // fresh add whose gateway rule matches its own id (a catch-all/override
      // gateway) would otherwise stamp the host with its own id.
      ipmiGatewayTemplateName: deviceCascade.provenance.ipmiGatewayServerId?.templateName
    });
    for (const w of addMatrix.warnings) {
      warnings.push(w);
    }
    // PR-T2 review (B1/MINOR-6) — capture the proxy-template name so the survivor
    // pass validates this fresh add's proxy per-record and names the right template
    // if its jump host does not survive (an add ships a dangling proxy otherwise).
    if (addMatrix.values.proxy !== undefined && deviceProxyTemplateName !== undefined) {
      proxyTemplateNameByServerId.set(id, deviceProxyTemplateName);
    }
    // PR-T3 review FIX 3 — capture the gateway-template name for the survivor pass.
    if (addMatrix.values.ipmiGatewayServerId !== undefined) {
      const gwName = deviceCascade.provenance.ipmiGatewayServerId?.templateName;
      if (gwName !== undefined) {
        ipmiGatewayTemplateNameByServerId.set(id, gwName);
      }
    }
    adds.push({
      id,
      name: device.name,
      host: endpoint.host,
      port,
      // MAJOR-2 (review) — normalized to `""` rather than left `undefined`. A
      // telnet console commonly names no username and its source may carry no
      // default, and a record whose `username` member is absent used to fail
      // `validateServerConfig` — i.e. the sync wrote rows the storage layer then
      // dropped on the next load. The validator tolerates absent for telnet now
      // as well; writing the canonical blank keeps every telnet record — synced
      // or hand-made through the form — the same shape.
      username: endpoint.username ?? source.defaultUsername ?? "",
      authType: "agent",
      // The LINK only — never the profile's username/authType/keyPath. Those
      // are resolved fresh at connect time, so a profile edit reaches every
      // server it owns; a copy taken here would rot the moment the profile
      // changed. `authType: "agent"` above stays inert while the link holds and
      // is the exact fallback if the profile is later deleted, which is why it
      // is still stamped unconditionally. Undefined when the source/winner has no
      // profile or its reference is dangling/keyless — the pre-feature record,
      // field for field.
      authProfileId: deviceWinnerResolvedId,
      isHidden: false,
      group,
      // DEVICE TEMPLATES (PR-T1) — the non-auth template field VALUES (proxy,
      // multiplexing, legacyAlgorithms, logSession) this fresh record starts
      // with; absent when the template sets none of them.
      ...addMatrix.values,
      // OOB — the device's out-of-band address, or `undefined` when it supplies
      // none. A new record has nothing to protect, so there is no matrix here:
      // whatever this fetch offers is what the field starts as, and the stamp
      // below records it so every LATER sync has the ownership question already
      // answered.
      ipmiHost: mgmtHost,
      // ALTERNATE HOST (issue #48, Phase 2) — the device's alternate SSH address,
      // or `undefined` when it supplies none. Same "a fresh record has nothing to
      // protect, so no matrix" reasoning as `ipmiHost` above: whatever this fetch
      // offers is the starting value, and the `syncedAltHost` stamp below records
      // it so every LATER sync has the ownership question already answered.
      altHost,
      // TELNET (Phase 0) — the transport this fetch's primary endpoint implies
      // (`undefined` for ssh, which is what the field stores). A fresh record
      // has nothing to protect, so there is no matrix here: whatever the device
      // says is what the field starts as, and the stamp below records it so
      // every LATER sync has the ownership question already answered.
      protocol: deviceProtocol,
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
        syncedAuthProfileId: deviceWinnerResolvedId,
        // Mirrors the `ipmiHost` written above, and recorded UNCONDITIONALLY —
        // `undefined` included — on the same "a source whose devices gain an
        // address later must find the stamps already there" argument the two
        // stamps above are recorded on. A record born with neither value nor
        // stamp is matrix row 1 (fill it in) rather than row 5 (hands off),
        // which is the right state for a server the user has never typed into:
        // an add that supplies no address must not be mistaken for a hand entry.
        syncedIpmiHost: mgmtHost,
        // ALTERNATE HOST (issue #48, Phase 2) — mirrors the `altHost` written
        // above, recorded UNCONDITIONALLY (`undefined` included) on the same "a
        // source whose devices gain a second address later must find the stamps
        // already there" argument. A record born with neither value nor stamp is
        // matrix row 1 (fill it in), which is the right state for a server the
        // user has never typed a second address into.
        syncedAltHost: altHost,
        // TELNET (Phase 0) — mirrors the `protocol` written above, recorded
        // UNCONDITIONALLY (`undefined`, i.e. ssh, included) on the same "a
        // source whose devices change transport later must find the stamp
        // already there" argument. A record born with value and stamp agreeing
        // is the state the write rule can act on; one born stampless would read
        // as ssh whatever the device said.
        syncedProtocol: deviceProtocol,
        // PRIMARY HOST/PORT (task #29) — mirror the `host`/`port` written above,
        // stamped UNCONDITIONALLY (a fresh record OWNS its address): a record born
        // with value and stamp agreeing is matrix row 1's state the write rule can
        // act on, and every LATER sync then has the ownership question already
        // answered — a hand edit read as hand-owned, an unchanged address followed.
        syncedHost: endpoint.host,
        syncedPort: port,
        // DEVICE TEMPLATES (PR-T1) — the template stamps for the non-auth fields
        // written above (row 1), so every LATER sync has the ownership question
        // already answered. Absent when the template set none of them.
        templated: addMatrix.templated
      }
    });
    if (group !== undefined) {
      folderSet.add(group);
    }
    // §3.4 (B2) — the fresh add's written fields. The link is written iff a usable
    // (non-keyless) winner resolved (`deviceWinnerResolvedId`); the implicit
    // source rule sets no §3.4 entry, so an implicit-only link records nothing.
    recordWrittenProvenance(id, device.name, addMatrix.values, deviceWinnerResolvedId !== undefined);
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
    const unmappedRollback = decideSourceAuthRollback(ownedServer, unusableProfileIds);
    const unmappedProfileId = ownedServer.authProfileId;
    if (unmappedRollback === "retain-own-key") {
      if (unmappedProfileId !== undefined) {
        bump(retainedByProfile, unmappedProfileId);
      }
      continue;
    }
    if (unmappedRollback !== "unlink" || unmappedProfileId === undefined) {
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
    bump(unlinkedByProfile, unmappedProfileId);
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
    // DEVICE TEMPLATES (PR-T1) — the counts are now PER PROFILE: the source
    // warning reports only servers unlinked from / retained on the SOURCE
    // profile, so a template- or retained-link-referenced keyless profile does
    // not inflate this sentence (those get their own referrer-specific warnings
    // below). When the source profile is the only unusable one — the shipped
    // case — these equal the totals and the wording is bit-for-bit unchanged.
    const sourceUnusableId = keylessKeyProfile ? matchedProfile?.id : undefined;
    const clearedLinkCount = sourceUnusableId !== undefined ? (unlinkedByProfile.get(sourceUnusableId) ?? 0) : 0;
    const retainedOwnKeyLinkCount = sourceUnusableId !== undefined ? (retainedByProfile.get(sourceUnusableId) ?? 0) : 0;
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

  // DEVICE TEMPLATES (PR-T1, §4.4 rev7) — referrer-specific AUTH 2b warnings for
  // every keyless profile OTHER than the source's own (which the block above
  // covers). Each names its referrer — a device TEMPLATE, or a RETAINED link an
  // earlier sync applied whose rule is now gone (the case where nothing in the
  // current config explains why the server was linked) — so the repair points at
  // the right editor. Silent unless this sync actually unlinked or retained on
  // that profile.
  const linkNote = (unlinked: number, retained: number): string => {
    const cleared =
      unlinked > 0
        ? ` ${unlinked} server${unlinked === 1 ? "" : "s"} this sync had already linked to it ${unlinked === 1 ? "is" : "are"} unlinked here so ${unlinked === 1 ? "it can connect" : "they can connect"} again; a later sync re-links ${unlinked === 1 ? "it" : "them"} once the profile has a key file.`
        : "";
    const retain =
      retained > 0
        ? ` ${retained} server${retained === 1 ? "" : "s"} this sync had already linked to it ${retained === 1 ? "keeps" : "keep"} the link, because ${retained === 1 ? "it carries a key file of its own" : "they carry key files of their own"} and still ${retained === 1 ? "connects" : "connect"} through the profile.`
        : "";
    return `${cleared}${retain}`;
  };
  for (const [id, ref] of profilesNeedingServerKey.referrer.entries()) {
    if (ref.kind === "source") {
      continue; // handled by the emitAuthWarning block above
    }
    const unlinked = unlinkedByProfile.get(id) ?? 0;
    const retained = retainedByProfile.get(id) ?? 0;
    if (unlinked === 0 && retained === 0) {
      continue;
    }
    const profileName = resolveAuthProfileById(id)?.name ?? id;
    if (ref.kind === "template") {
      warnings.push(
        `The auth profile "${profileName}" applied by a device template rule on "${source.name}" uses private key authentication but has no key file.${linkNote(unlinked, retained)}`
      );
    } else {
      warnings.push(
        `The auth profile "${profileName}" — linked to one or more servers by an earlier sync whose device template rule is no longer configured — uses private key authentication but has no key file.${linkNote(unlinked, retained)}`
      );
    }
  }
  // §4.4 rev7 — an OVERRIDE move refused per target (the profile needs a key file
  // the server does not have). Names the profile and the servers left unchanged.
  for (const [id, names] of overrideRefusedByProfile.entries()) {
    const profileName = resolveAuthProfileById(id)?.name ?? id;
    warnings.push(
      `A device template would apply the auth profile "${profileName}" to ${namedExamples(names)}, but it uses private key authentication and has no key file while ${names.length === 1 ? "that server brings" : "those servers bring"} no key of their own — ${names.length === 1 ? "its link was" : "their links were"} left unchanged.`
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

  // ADDRESSLESS (Codex P1) — replaces the old "no usable endpoint … skipped"
  // summary: those devices are now CREATED as addressless placeholders, so the
  // aggregate note says what happened rather than that they were dropped. One
  // line, never per-device.
  if (addresslessAdded.length > 0) {
    const count = addresslessAdded.length;
    warnings.push(
      `${count} device${count === 1 ? "" : "s"} ${count === 1 ? "has" : "have"} no console address yet and ${count === 1 ? "was" : "were"} added without one (e.g. ${namedExamples(addresslessAdded)}).`
    );
  }
  // P2-3 (Fable) — the downgrade twin of the addressless-added disclosure: name the
  // previously-addressed servers whose console address this sync blanked.
  if (downgradedToAddressless.length > 0) {
    const count = downgradedToAddressless.length;
    warnings.push(
      `${count} previously-addressed server${count === 1 ? "" : "s"} lost ${count === 1 ? "its" : "their"} console address and ${count === 1 ? "was" : "were"} downgraded to ${count === 1 ? "a placeholder" : "placeholders"} (e.g. ${namedExamples(downgradedToAddressless)}).`
    );
  }
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

  // FIX 2 (PR #61 Codex review) — POST-PLAN jump-host survivor validation. The
  // §5.3 dangling check that ran during composition used the OPTIMISTIC
  // `liveServerIds`, which admits a jump host this plan prunes under `delete`
  // policy or a device the loop skipped — so the plan could write a template
  // proxy pointing at a server that will NOT exist after apply. The definitive
  // survivor set is only knowable HERE, once prune and per-device skip decisions
  // are all made.
  //
  // SURVIVORS — the ids that exist after apply, read off the plan structures
  // `planToApplication` itself consumes: `prunes` with `policy: "delete"` are the
  // only servers actually removed (orphan/keep survive in place, and are re-added
  // to `upsertServers`), so a current server survives unless it is a delete-prune;
  // every `adds[].id` is a fresh survivor; and an ADOPTED server is a kept server
  // already in `currentServers` that this run turned into an update, never a
  // prune, so its id is already covered by "current minus deletes" — listed in
  // the comment for completeness, needing no separate collection.
  const deletedServerIds = new Set(prunes.filter((p) => p.policy === "delete").map((p) => p.server.id));
  const survivorIds = new Set<string>();
  for (const s of currentServers) {
    if (!deletedServerIds.has(s.id)) {
      survivorIds.add(s.id);
    }
  }
  for (const a of adds) {
    survivorIds.add(a.id);
  }
  // PR-T3 review round 3 (Codex) — the FIX-3 warn-only gateway survivor pass that
  // once sat HERE has been REPLACED by a REJECT pass and RELOCATED below, right
  // after the proxy update loop and before the shared `collapsedIds` splice, so a
  // gateway-only revert collapses to UNCHANGED through the same machinery the proxy
  // reject feeds. See `rejectWrittenGateway` / `warnWrittenGateway` further down.
  // Why the change: FIX-3 chose "warn only, keep the write" for a same-sync-pruned
  // IPMI gateway — the plan kept `after.ipmiGatewayServerId = B` + its stamp + a §3.4
  // provenance line and merely warned. But `NexusCore.applyInventorySyncPlan` upserts
  // the record (with gateway B) and THEN calls `clearGatewayReferencesTo(deletedIds)`
  // (which, since round-1 FIX B, also wipes the templated stamp) — so B and its stamp
  // are erased the instant they land. The plan preview + provenance line therefore
  // promised a mutation that never survives, and the warning's "remains until it is
  // reclaimed" was false. Aligning the plan with application means the plan's `after`
  // must equal the post-apply state: a non-survivor written gateway is REJECTED, its
  // stamp collapsed, its provenance dropped — exactly like the proxy part-1 pass.
  // PR-T2 review (B2) — a proxy the survivor pass drops or restores did NOT flow
  // from this run's template onto the record, so its §3.4 provenance line must go
  // with it, or the consent report would claim a value flow the plan simultaneously
  // says was "not applied" / "removed". Shared by part 1 and part 2.
  const dropProxyProvenance = (serverId: string): void => {
    const entry = provenanceByServer.get(serverId);
    if (entry !== undefined) {
      delete entry.provenance.proxy;
    }
  };
  // PR-T3 review round 3 — mirror of `dropProxyProvenance` for the gateway field. A
  // gateway the reject pass drops (or restores) did NOT flow from this run's template
  // onto the record, so its §3.4 provenance line must go with it — otherwise the
  // consent report would render a gateway flow the plan simultaneously says was "not
  // applied". (The round-2 fix made gateway provenance render, so dropping it here is
  // what removes the line for a not-applied gateway.)
  const dropGatewayProvenance = (serverId: string): void => {
    const entry = provenanceByServer.get(serverId);
    if (entry !== undefined) {
      delete entry.provenance.ipmiGatewayServerId;
    }
  };
  // PR-T2 review (B1) — deduped by `server::jumpHost`, SHARED across part 1 (this
  // run's WRITTEN proxies) and part 2 (RETAINED proxies), so a single record is
  // never warned about twice for the same dangling jump host.
  const warnedRetainedProxyKeys = new Set<string>();
  // PR-T3 review round 3 — a SEPARATE dedup set for gateway warnings, keyed by
  // `${record.id}::${gatewayId}`. Proxy and gateway keys share the same shape but
  // name different reference kinds; a separate set removes any chance of a
  // cross-field key collision suppressing a legitimate second warning.
  const warnedRetainedGatewayKeys = new Set<string>();

  // PART 1 (PR-T2 review, B1) — per-record survivor validation of the proxies THIS
  // RUN's matrix WROTE. GENERALIZES the round-6 baseline-catch-all pass: every add
  // or update whose proxy the matrix wrote this run is recorded in
  // `proxyTemplateNameByServerId`, so a proxy set by a FILTERED rule is validated
  // exactly like a catch-all one. The old pass gated solely on the BASELINE
  // catch-all cascade's desired proxy, so a proxy a FILTERED rule set never tripped
  // it and fell through to part 2's destructive DROP — data loss on an override
  // MOVE (the pre-existing working proxy A was stripped) and a silent dangling
  // proxy shipped on an add (no warning, connect fails). This pass now OWNS every
  // WRITTEN template proxy; retained proxies (row-5 carry, never written this run,
  // not in the map) are left to part 2.
  //
  // For each such record whose written `after.proxy` is a template-OWNED ssh proxy
  // (`proxyConfigsEqual(cur, stamp)`, so the sync owns it — §8.4) pointing at a
  // NON-survivor jump host, REJECT it as §4.3 row 5 does ("desired none → keep
  // existing"):
  //  - UPDATE: RESTORE the pre-matrix proxy `before.proxy` + before's stamp — a
  //    row-3 override MOVE clobbered a still-working proxy A → B, and A is the value
  //    to fall back to (deleting to absent would strip a working proxy fleet-wide).
  //    A row-1 write on an update has no prior proxy → drops to absent.
  //  - ADD: DROP to absent (nothing beneath to restore) + warn — this is the add
  //    path the old code shipped a dangling proxy on.
  // Self-reference never reaches here: the matrix skips a self-proxy so it is never
  // written, and a record's own id is itself a survivor. The warning names the
  // template that ACTUALLY set THIS proxy per-record (fixes MINOR-6's
  // mis-attribution to the baseline catch-all), deduped by `server::jumpHost`.
  const rejectWrittenProxy = (after: ServerConfig, before: ServerConfig | undefined): string | undefined => {
    const p = after.proxy;
    const stampedProxy = after.origin?.templated?.proxy;
    if (
      p === undefined ||
      p.type !== "ssh" ||
      stampedProxy === undefined ||
      !proxyConfigsEqual(p, stampedProxy) || // §8.4 — template-OWNED only; a hand proxy is left alone
      p.jumpHostId === after.id || // self is always a survivor (owned, not a delete-prune)
      survivorIds.has(p.jumpHostId)
    ) {
      return undefined; // not a written template proxy this pass must reject
    }
    const danglingJumpHostId = p.jumpHostId;
    const priorProxy = before?.proxy; // A on a row-3 override move; undefined on a row-1 write
    const priorStamp = before?.origin?.templated?.proxy;
    if (priorProxy !== undefined) {
      after.proxy = { ...priorProxy }; // restore A (row 5 carry) — never delete a previously-working proxy
    } else {
      delete after.proxy; // nothing prior → absent (never a written `undefined`)
    }
    const origin = after.origin;
    if (origin?.templated !== undefined) {
      const templated = { ...origin.templated };
      if (priorStamp !== undefined) {
        templated.proxy = { ...priorStamp };
      } else {
        delete templated.proxy;
      }
      // PR-T3 — the presence check must see the two IPMI value stamps too, or
      // dropping the proxy would erase a still-valid IPMI stamp with it.
      after.origin = { ...origin, templated: templatedHasAnyStamp(templated) ? templated : undefined };
    }
    // The template's NEW proxy did not flow onto this record — strip its §3.4 line.
    dropProxyProvenance(after.id);
    return danglingJumpHostId;
  };
  const warnWrittenProxy = (record: ServerConfig, jumpHostId: string): void => {
    const warnKey = `${record.id}::${jumpHostId}`;
    if (warnedRetainedProxyKeys.has(warnKey)) {
      return;
    }
    warnedRetainedProxyKeys.add(warnKey);
    // Names the template that ACTUALLY wrote this proxy on this record (MINOR-6).
    const name = proxyTemplateNameByServerId.get(record.id) ?? "?";
    warnings.push(
      `Device template "${name}" on "${source.name}" set a jump-host proxy on "${record.name}" whose jump host will not survive this sync (it is being pruned, or its device was skipped) — the template's new proxy was not applied.`
    );
  };
  for (const a of adds) {
    if (!proxyTemplateNameByServerId.has(a.id)) {
      continue; // this run wrote no proxy on this add
    }
    const rejectedJump = rejectWrittenProxy(a, undefined);
    if (rejectedJump !== undefined) {
      warnWrittenProxy(a, rejectedJump);
    }
  }
  // Codex round 4/6 — NO-OP COLLAPSE (keep the plan counts exact). Restoring A can
  // revert an update whose ONLY change was the proxy A→B, making `after` byte-equal
  // to `before` — a genuine no-op. Remove it from `updates` and count the server
  // UNCHANGED (the round-4 promotion decrement in the other direction); if OTHER
  // fields also changed the update is KEPT and the count is left alone.
  // `unchangedServerIds` is updated so the later promotion loop's decrement gate
  // stays coherent for a collapsed server.
  const updateStillChanged = (before: ServerConfig, after: ServerConfig): boolean =>
    before.name !== after.name ||
    before.host !== after.host ||
    before.port !== after.port ||
    before.group !== after.group ||
    before.authProfileId !== after.authProfileId ||
    before.ipmiHost !== after.ipmiHost ||
    // ALTERNATE HOST (issue #48, Phase 2) — symmetry with the mainline `changed`
    // comparator, which lists `altHost` too; a value write without a stamp write
    // would otherwise be silently collapsed here.
    before.altHost !== after.altHost ||
    !proxyConfigsEqual(before.proxy, after.proxy) ||
    before.multiplexing !== after.multiplexing ||
    before.legacyAlgorithms !== after.legacyAlgorithms ||
    before.logSession !== after.logSession ||
    // PR-T3 review FIX 4 — symmetry with the mainline `changed` comparator (which
    // lists both IPMI value fields). Unexploitable today (every matrix ipmi write
    // also rewrites its stamp, and `serverOriginStampsEqual` below covers stamps),
    // but the "value write ⇒ stamp write" invariant is implicit — a future path
    // writing a value without a stamp would otherwise be silently collapsed here.
    before.ipmiAuthProfileId !== after.ipmiAuthProfileId ||
    before.ipmiGatewayServerId !== after.ipmiGatewayServerId ||
    !serverOriginStampsEqual(before.origin, after.origin) ||
    before.username !== after.username;
  const collapsedIds = new Set<string>();
  for (const u of updates) {
    if (!proxyTemplateNameByServerId.has(u.after.id)) {
      continue; // this run wrote no proxy on this update — a retained proxy is part 2's job
    }
    const rejectedJump = rejectWrittenProxy(u.after, u.before);
    if (rejectedJump !== undefined) {
      warnWrittenProxy(u.after, rejectedJump);
      if (!updateStillChanged(u.before, u.after)) {
        collapsedIds.add(u.before.id);
      }
    }
  }

  // PR-T3 review round 3 (Codex) — SAME-SYNC-PRUNED IPMI GATEWAY reject pass, the
  // exact analogue of the proxy part-1 pass above for the single-id
  // `ipmiGatewayServerId` field. It is RELOCATED here (from where FIX-3's warn-only
  // pass used to sit, above `survivorIds`) so it feeds the SAME `collapsedIds` splice
  // the proxy update loop feeds: a gateway-only revert that makes `after` byte-equal
  // to `before` collapses to UNCHANGED, keeping the plan counts exact.
  //
  // WHY REJECT, NOT WARN-ONLY: `applyInventorySyncPlan` upserts the record and THEN
  // `clearGatewayReferencesTo(deletedIds)` wipes any gateway ref (and, since round-1
  // FIX B, its templated stamp) that names a delete-pruned server. A written gateway
  // B that is delete-pruned this run is therefore erased the instant it lands, so the
  // plan's `after.ipmiGatewayServerId` must equal that post-apply state — a survivor
  // or `undefined`, never a doomed B. Keeping B (the old FIX-3 decision) made the plan
  // preview and the §3.4 provenance line promise a mutation that never survives.
  //
  // THE ONE DELIBERATE DIVERGENCE FROM PROXY — SURVIVOR-GUARDED RESTORE: proxy
  // restores the prior value A UNCONDITIONALLY on a rejected override MOVE. Gateway
  // must NOT: `clearGatewayReferencesTo` force-clears ANY gateway ref in
  // `deletedServerIds`, so restoring a prior gateway that is ITSELF being pruned would
  // just re-create the very plan/apply mismatch this fix removes. The guard
  // (`survivorIds.has(priorGateway)`) restores the prior gateway only when it will
  // still exist after apply; otherwise it drops to `undefined`. This guarantees
  // `after.ipmiGatewayServerId` is always a survivor-or-`undefined` — byte-identical
  // to the post-apply state. Scoped to gateways this run WROTE
  // (`ipmiGatewayTemplateNameByServerId`), so a retained (row-5, not-written-this-run)
  // gateway and a HAND-set gateway (no matching stamp, §8.4) are left untouched.
  const rejectWrittenGateway = (after: ServerConfig, before: ServerConfig | undefined): string | undefined => {
    const gw = after.ipmiGatewayServerId;
    const stampedGw = after.origin?.templated?.ipmiGatewayServerId;
    if (
      gw === undefined ||
      stampedGw === undefined ||
      stampedGw !== gw || // §8.4 — template-OWNED only; a hand-set gateway is left alone
      gw === after.id || // self is always a survivor (FIX 2 skips self at composition; defensive)
      survivorIds.has(gw)
    ) {
      return undefined; // not a written template gateway this pass must reject
    }
    const danglingGatewayId = gw;
    const priorGateway = before?.ipmiGatewayServerId; // A_live on a row-3 override MOVE; undefined on a row-1 write
    // PR-T3 review round 9 (Codex) — read the prior gateway stamp from the live
    // origin OR the DETACHED receipt. On a normal update the stamp sits in
    // `before.origin.templated`; but on an ADOPTION update `before` is the
    // pre-adoption KEPT record whose `origin` is absent and whose value stamp lives
    // in `before.formerlySynced.templated`. Falling back to the detached twin lets a
    // restored template-owned gateway A keep its ownership stamp — without it the
    // restore branch below leaves A stamp-less, so it reads as HAND-configured
    // (`cur !== stamp`) and a later override template could never manage it again.
    // Origin first: on a normal update `before.formerlySynced` is absent so the `??`
    // tail is `undefined` and behavior is byte-identical.
    const priorStamp =
      before?.origin?.templated?.ipmiGatewayServerId ?? before?.formerlySynced?.templated?.ipmiGatewayServerId;
    if (priorGateway !== undefined && survivorIds.has(priorGateway)) {
      // Row-5 carry of a STILL-VALID prior gateway on a row-3 override MOVE. The guard
      // is what distinguishes this from proxy: a prior gateway that is itself pruned is
      // NOT restored (see the divergence note above) — it falls through to the drop.
      after.ipmiGatewayServerId = priorGateway;
    } else {
      delete after.ipmiGatewayServerId; // nothing valid prior → absent (never a written `undefined`)
    }
    const origin = after.origin;
    if (origin?.templated !== undefined) {
      const templated = { ...origin.templated };
      if (priorGateway !== undefined && survivorIds.has(priorGateway) && priorStamp !== undefined) {
        templated.ipmiGatewayServerId = priorStamp; // stamp follows the restored value
      } else {
        delete templated.ipmiGatewayServerId;
      }
      // Same `templatedHasAnyStamp` collapse the proxy reject uses: an emptied bag
      // collapses to `undefined`, while a still-valid `ipmiAuthProfileId`/proxy/other
      // stamp is preserved.
      after.origin = { ...origin, templated: templatedHasAnyStamp(templated) ? templated : undefined };
    }
    // The template's NEW gateway B did not flow onto this record — strip its §3.4 line.
    dropGatewayProvenance(after.id);
    return danglingGatewayId;
  };
  const warnWrittenGateway = (record: ServerConfig, gatewayId: string): void => {
    const warnKey = `${record.id}::${gatewayId}`;
    if (warnedRetainedGatewayKeys.has(warnKey)) {
      return;
    }
    warnedRetainedGatewayKeys.add(warnKey);
    const name = ipmiGatewayTemplateNameByServerId.get(record.id) ?? "?";
    warnings.push(
      `Device template "${name}" on "${source.name}" set an IPMI gateway on "${record.name}" whose gateway server will not survive this sync (it is being pruned) — the template's new IPMI gateway was not applied.`
    );
  };
  for (const a of adds) {
    if (!ipmiGatewayTemplateNameByServerId.has(a.id)) {
      continue; // this run wrote no gateway on this add
    }
    const rejectedGateway = rejectWrittenGateway(a, undefined);
    if (rejectedGateway !== undefined) {
      warnWrittenGateway(a, rejectedGateway);
    }
  }
  for (const u of updates) {
    if (!ipmiGatewayTemplateNameByServerId.has(u.after.id)) {
      continue; // this run wrote no gateway on this update — a retained gateway is out of scope
    }
    const rejectedGateway = rejectWrittenGateway(u.after, u.before);
    if (rejectedGateway !== undefined) {
      warnWrittenGateway(u.after, rejectedGateway);
      // Same no-op collapse the proxy update loop feeds: a gateway-only revert makes
      // `after` byte-equal to `before` (`updateStillChanged` lists `ipmiGatewayServerId`
      // via FIX 4) → the update collapses to UNCHANGED through the shared splice below.
      if (!updateStillChanged(u.before, u.after)) {
        collapsedIds.add(u.before.id);
      }
    }
  }

  if (collapsedIds.size > 0) {
    for (let i = updates.length - 1; i >= 0; i--) {
      if (collapsedIds.has(updates[i].before.id)) {
        const [removed] = updates.splice(i, 1);
        unchangedCount++;
        unchangedServerIds.add(removed.before.id);
      }
    }
  }

  // FIX B (PR #61 Codex review round 2) — the survivor pass above (round 6's
  // part 1) only ever inspects THIS RUN's desired proxy on `adds` + `updates`
  // afters, so it misses two template-owned dangling proxies whose jump host is
  // delete-pruned in the SAME plan:
  //  - an UNCHANGED server (round 2): desired proxy equals its current value and
  //    no other field changes, so it is counted UNCHANGED and is absent from both
  //    arrays; and
  //  - the ROUND 7 GAP: an ALREADY-UPDATED server that RETAINS a template-owned
  //    proxy (§6.3 row-5 carry — its rule was removed, so value + stamp are kept)
  //    while also getting an UNRELATED change this run (a rename, an endpoint
  //    move). Part 1 never looked at the retained proxy (it is not this run's
  //    desired proxy, and may name a different jump host).
  //  - the ROUND 9 GAP: an ADOPTION update carrying the same retained dangling or
  //    self proxy. An adoption is built from `keptByExternalId` and pushed to
  //    `updates`, never entering `ownedByExternalId` — so a prior iteration over
  //    the owned map skipped it and the adopted server shipped a broken proxy.
  //
  // ROUND 9 UNIFICATION — rather than patch the iteration source a 5th time, this
  // pass now iterates the plan's EFFECTIVE post-apply records directly (see the
  // PART 2a / PART 2b blocks below): every `updates` entry's `after` (the union
  // that already holds owned AND adoption updates), plus every owned/kept server
  // in none of adds/updates/prunes (the unplanned set). Any future record source
  // is covered by construction. It cleans the dangling/self retained proxy on the
  // EFFECTIVE record: the `updates` entry's `after` when the server is already
  // being updated (cleaned IN PLACE), else the unplanned owned/kept server
  // (promoted to a new update). Either way the proxy field goes ABSENT and its
  // `templated.proxy` stamp is cleared, so record and ownership receipt stay
  // consistent.
  //
  // WHY A DROP, NOT A ROUND-6 RESTORE. Round 6 (part 1) RESTORES the pre-matrix
  // proxy A because a row-3 override MOVE clobbered a still-working proxy and A is
  // the value to fall back to. A RETAINED proxy has no such fallback: its rule is
  // gone, the stamped value IS the dangling jump host, and there is no prior
  // working value beneath it — so absent is the repair, identical to the
  // unchanged-server promotion and to composition-time §4.3 handling.
  //
  // SCOPE, strictly (§8.4): a TEMPLATE-STAMPED proxy only — `cur.proxy` present,
  // `type:"ssh"`, and `proxyConfigsEqual(cur.proxy, record.origin.templated.proxy)`
  // so the sync still OWNS it (`cur === stamp`). A HAND-SET proxy (stamp absent or
  // ≠) pointing at a pruned jump host — or at itself — is LEFT ALONE — §8.4's
  // deliberate "no sweep on prune" posture — even on a server this run renames.
  //
  // INVALID = jump host is a NON-SURVIVOR **or** the jump host is the record's OWN
  // id (ROUND 8). The record's own id IS a survivor (it is owned, not a delete
  // -prune), so a plain survivor test would treat a self-proxy as valid and retain
  // it forever — but a RETAINED self-proxy no current rule wins is exactly the
  // §5.3 circular reference the connect-time guard refuses. Round 5's MATRIX repair
  // (composition time, `clearProxy`) only fires when there IS a desired proxy this
  // run; this pass additionally cleans the NO-winner retained self case, on both
  // dispositions below. The self-ref case is ALWAYS a drop (a self-proxy has no
  // valid value to restore, the same as a dangling one).
  //
  // DISPOSITION, realized by the two iterations below (no double-handling):
  //  - UPDATE (part 2a, iterate `updates`): clean the proxy on that `after` IN
  //    PLACE — no promotion, no new update. Do NOT touch `unchangedCount`: the
  //    server was already an update, and the round-4 decrement gate only concerns
  //    promotions of servers that were counted unchanged. Adoption updates are
  //    caught HERE (round 9), since they live in `updates`.
  //  - PRUNE / ADD: skipped by the unplanned set's `plannedServerIds` filter — a
  //    delete-prune must never be resurrected as an update (keep/orphan handled in
  //    its own branch), and a fresh add has no retained proxy (its this-run proxy
  //    was validated by round 6 / part 1).
  //  - NOT PLANNED (part 2b): promote to a NEW update dropping the proxy, with the
  //    round-4 `unchangedServerIds` decrement gate (a device SKIPPED this fetch
  //    reaches here without ever hitting `unchangedCount++`, so an unconditional
  //    decrement would understate the count or drive it negative).
  //
  // COMPOSITION WITH ROUND 6 (no double-handling, no double-warning): part 1 runs
  // FIRST and only when `desiredNonAuth.proxy` is itself the dangling reference;
  // after it, an update's `after.proxy` for the this-run-desired case is either a
  // survivor (row-5 carry) or absent, so this pass sees no dangling proxy there
  // and skips. It only catches proxies part 1 didn't look at (retained ones, a
  // different jump host). If a round-6 restore left a STILL-dangling prior proxy A
  // (A itself pruned), this pass correctly drops it — belt-and-suspenders — and
  // warnings are deduped by server + jump host so a single drop is never announced
  // twice.
  //
  // COMPOSITION WITH ROUND 5 (the with-winner self case, no double-handling): the
  // matrix's `clearProxy` (composition time) has already deleted `after.proxy` and
  // dropped its stamp for a server whose DESIRED proxy self-references, so this
  // pass sees `cur === undefined` on that record and skips. Part 2 only reaches a
  // self-proxy that NO current rule sets (a retained §6.3 carry). Together the two
  // now cover the whole proxy-cleanup surface: {dangling, self} × {this-run
  // -written, retained} × {add, update-in-place, unplanned-promote, unchanged} —
  // write-time round 6 + with-winner round-5 self repair for the this-run-written
  // column, this survivor pass (post-plan dangling + retained-self repair) for the
  // retained column.
  const prunedServerIds = new Set<string>();
  for (const pr of prunes) {
    prunedServerIds.add(pr.server.id);
  }
  const addedServerIds = new Set<string>();
  for (const a of adds) {
    addedServerIds.add(a.id);
  }
  // Drops the template-owned proxy off a record: the field goes ABSENT (never a
  // written `undefined`) and the `templated.proxy` stamp is cleared, so the record
  // and its ownership receipt stay consistent. The remaining templated stamps
  // decide whether `templated` survives at all.
  const dropTemplateProxy = (record: ServerConfig): ServerConfig => {
    const origin = record.origin!;
    const templated = origin.templated !== undefined ? { ...origin.templated } : {};
    delete templated.proxy;
    // PR-T3 — the two IPMI value stamps count toward "still stamped" so the proxy
    // drop never silently erases them.
    const { proxy: _droppedProxy, ...withoutProxy } = record;
    return { ...withoutProxy, origin: { ...origin, templated: templatedHasAnyStamp(templated) ? templated : undefined } };
  };
  // ROUND 9 (UNIFICATION) — the single predicate every record source now shares:
  // is a record's EFFECTIVE proxy an INVALID template-OWNED ssh proxy this pass
  // must clean? Both the §8.4 scope (template-STAMPED only —
  // `proxyConfigsEqual(cur, stamp)`, so `cur === stamp` and the sync still OWNS
  // it; a hand-set proxy is left alone) and the §5.3 self-ref-is-a-drop rule live
  // here so no iteration source can diverge. INVALID = the jump host is a
  // NON-survivor OR the jump host is the record's OWN id (a retained self-proxy
  // no rule now sets — the circular reference the connect-time guard refuses).
  // The record's own id is itself a survivor (owned/kept, not a delete-prune), so
  // `!==` excludes self from the survivor skip; without it a self-proxy would read
  // as valid and be retained forever. Returns the self flag for the warning
  // wording, or undefined when there is nothing to clean.
  const invalidTemplateProxy = (record: ServerConfig): { self: boolean; jumpHostId: string } | undefined => {
    const cur = record.proxy;
    const stampedProxy = record.origin?.templated?.proxy;
    if (
      cur === undefined ||
      cur.type !== "ssh" ||
      stampedProxy === undefined ||
      !proxyConfigsEqual(cur, stampedProxy) || // §8.4 — template-stamped proxies only; a hand proxy is left alone
      (cur.jumpHostId !== record.id && survivorIds.has(cur.jumpHostId))
    ) {
      return undefined;
    }
    return { self: cur.jumpHostId === record.id, jumpHostId: cur.jumpHostId };
  };
  const warnRetainedProxy = (record: ServerConfig, self: boolean, jumpHostId: string): void => {
    // Dedupe by server + jump host so a single drop is never announced twice,
    // including across composition with part 1 / round 6 (`warnedRetainedProxyKeys`
    // is the set shared with part 1, declared above).
    const warnKey = `${record.id}::${jumpHostId}`;
    if (warnedRetainedProxyKeys.has(warnKey)) {
      return;
    }
    warnedRetainedProxyKeys.add(warnKey);
    warnings.push(
      self
        ? `Server "${record.name}" on "${source.name}" carries a device-template jump-host proxy that points at itself (a circular proxy no rule now sets) — the proxy field was removed.`
        : `Server "${record.name}" on "${source.name}" carries a device-template jump-host proxy whose jump host will not survive this sync (it is being pruned) — the proxy field was removed.`
    );
  };

  // PART 2 (round 9 UNIFICATION) — iterate the plan's EFFECTIVE post-apply
  // records directly rather than `ownedByExternalId`. The prior code walked the
  // owned-server map, which never contains an ADOPTION update — those are built
  // from `keptByExternalId` and pushed straight to `updates`, so a retained
  // template-owned dangling/self proxy on a freshly-adopted server was never
  // inspected and shipped broken. That was the 5th record-class gap in this
  // cleanup; stop patching the iteration source and unify on the records that
  // actually exist after apply.
  //
  // The effective records that can carry a proxy post-apply are:
  //  - every `updates` entry's `after` — the union that ALREADY holds owned
  //    updates AND adoption updates (part 2a, cleaned IN PLACE); and
  //  - every owned/kept server that is in NONE of adds/updates/prunes — the
  //    UNPLANNED set (an unchanged server, or a device skipped this fetch), still
  //    needing promotion (part 2b).
  // Adds are skipped: a fresh add has no retained proxy, its this-run proxy was
  // validated by part 1 / round 6, and the matrix's round-5 skip means an add
  // can't carry a self-proxy.
  //
  // COMPOSITION WITH PART 1 / ROUND 6 (no double-clean, no double-warn): part 1
  // runs FIRST and RESTORES the pre-matrix proxy for THIS run's rejected desired
  // winner; after it, such an update's `after.proxy` is a survivor (row-5 carry)
  // or absent, so `invalidTemplateProxy` returns undefined and part 2a skips it.
  // Part 2 only drops retained/self proxies part 1 never examined. If a round-6
  // restore left a STILL-dangling prior proxy (the restored value is itself
  // pruned), part 2a correctly drops it — belt-and-suspenders — and warnings
  // dedupe by `server::jumpHost`.

  // PART 2a — every planned update's `after`, cleaned IN PLACE. This is where an
  // ALREADY-UPDATED owned server (round 7 gap) AND an ADOPTION update (round 9
  // gap) are both caught: both live in `updates`. No promotion and no
  // `unchangedCount` change — the server was already an update, and the round-4
  // decrement gate only concerns promotions of counted-unchanged servers.
  for (const u of updates) {
    const invalid = invalidTemplateProxy(u.after);
    if (invalid === undefined) {
      continue;
    }
    warnRetainedProxy(u.after, invalid.self, invalid.jumpHostId);
    u.after = dropTemplateProxy(u.after); // a DROP (retained value IS the dangling/self host — nothing beneath to restore)
    dropProxyProvenance(u.after.id); // B2 — no §3.4 line for a proxy that was removed
  }

  // PART 2b — the UNPLANNED set. Snapshot the planned ids (adds ∪ updates-before
  // ∪ prunes) BEFORE promoting, so an update already handled by part 2a is never
  // re-examined here (its before-id is in the set) and servers promoted below are
  // never revisited. Iterate owned AND kept servers for record-source
  // completeness: a kept (un-adopted) server carries no `origin`, so
  // `invalidTemplateProxy`'s stamp guard makes it a no-op — which keeps the
  // adoption-declined case matching prior behavior (a declined adoptee is never
  // touched) while closing the gap by construction for any future record source.
  const plannedServerIds = new Set<string>();
  for (const id of addedServerIds) {
    plannedServerIds.add(id);
  }
  for (const u of updates) {
    plannedServerIds.add(u.before.id);
  }
  for (const id of prunedServerIds) {
    plannedServerIds.add(id);
  }
  const unplannedCandidates: ServerConfig[] = [
    ...ownedByExternalId.values(),
    ...Array.from(keptByExternalId.values()).flat()
  ];
  for (const candidate of unplannedCandidates) {
    if (plannedServerIds.has(candidate.id)) {
      continue; // already an add / update / prune — handled by part 2a or its own branch
    }
    const invalid = invalidTemplateProxy(candidate);
    if (invalid === undefined) {
      continue;
    }
    warnRetainedProxy(candidate, invalid.self, invalid.jumpHostId);
    // NOT PLANNED — promote to a new proxy-dropping update.
    updates.push({ before: candidate, after: dropTemplateProxy(candidate) });
    dropProxyProvenance(candidate.id); // B2 — no §3.4 line for a proxy that was removed

    // Codex round 4 (P2) — gate the decrement on actually-counted-unchanged. A
    // server whose device was SKIPPED this fetch reaches here without ever having
    // hit `unchangedCount++`, so decrementing for it would understate the count or
    // drive it negative. Only servers this set records left the bucket.
    if (unchangedServerIds.has(candidate.id)) {
      unchangedCount--; // this device was counted unchanged in the loop; it is now an update
    }
  }

  // ==========================================================================
  // GATEWAY PART 2 (Codex round 4, P2) — the RETAINED-gateway sibling of the
  // proxy PART 2 pass above, and the round-4 analog of round 3's WRITTEN-gateway
  // reject (`rejectWrittenGateway` / part 1). This ADDS a parallel gateway pass
  // beside the proxy passes; it does NOT touch any of them (proxy is one of the
  // five protected engine fields).
  //
  // THE GAP round 3 left. Round 3's written pass only inspects gateways THIS
  // RUN's matrix WROTE (`ipmiGatewayTemplateNameByServerId`) — a row-1 write or a
  // row-3 override MOVE. A server that carries a template-OWNED gateway from an
  // EARLIER sync which THIS run does NOT re-write (row-4 unchanged winner, or
  // row-5 after its rule disappears) is absent from that map, so the written
  // pass's `continue` at the top of its `updates` loop (the
  // `!ipmiGatewayTemplateNameByServerId.has(u.after.id)` guard) skips it. If that
  // retained gateway names a server delete-pruned in the SAME sync, the plan
  // preview keeps value + stamp with NO warning — but `applyInventorySyncPlan`
  // then calls `clearGatewayReferencesTo(deletedServerIds)`, which wipes both.
  // Preview lies. This pass closes that gap for retained gateways, exactly as
  // proxy PART 2 closes it for retained proxies.
  //
  // WHY A DROP, NOT A ROUND-3 RESTORE. Round 3 (part 1) RESTORES the pre-matrix
  // gateway A on a rejected override MOVE (survivor-guarded), because A is the
  // still-working value to fall back to. A RETAINED gateway has no such fallback:
  // its rule is gone (or unchanged this run), the stamped value IS the dangling
  // gateway, and there is nothing prior beneath it — so absent is the repair,
  // identical to the unplanned-server promotion.
  //
  // THE ONE DELIBERATE DIVERGENCE FROM PROXY — NO SELF-DROP. `invalidTemplateProxy`
  // additionally flags a retained SELF-proxy (`jumpHost === record.id`), because a
  // circular proxy is the §5.3 reference the connect-time guard refuses. Gateways
  // have NO such rule: a self-gateway (`ipmiGatewayServerId === record.id`) IS a
  // survivor, so `survivorIds.has(cur)` is true and `invalidTemplateGateway`
  // leaves it alone — and that is RIGHT, because a self-gateway resolves
  // harmlessly to "local" at runtime AND `clearGatewayReferencesTo` never clears
  // it (self is not in `deletedServerIds` unless the server itself is pruned, in
  // which case its whole record is gone). Retaining a self-gateway in the preview
  // is therefore already consistent with application — there is no lie to fix.
  // Do NOT invent a circular-reference drop for gateways.
  //
  // ORDERING — this pass is inserted AFTER proxy PART 2 completes. Proxy PART 2b
  // may have PROMOTED unplanned servers into `updates`; this pass must SEE those
  // promotions, so a server dangling on BOTH proxy and gateway is cleaned in the
  // SAME update by GATEWAY PART 2a below, never promoted twice (GATEWAY PART 2b's
  // freshly-recomputed planned set skips it).

  // Drops the template-owned gateway off a record: the `ipmiGatewayServerId` field
  // goes ABSENT (destructured out, never a written `undefined`) and the
  // `templated.ipmiGatewayServerId` stamp is cleared, so the record and its
  // ownership receipt stay consistent. The `templatedHasAnyStamp` collapse keeps a
  // still-valid `ipmiAuthProfileId` / proxy stamp — mirror of `dropTemplateProxy`.
  const dropTemplateGateway = (record: ServerConfig): ServerConfig => {
    // PR #66 Codex round 10 — the ownership stamp can live on the live `origin`
    // OR, for a server KEPT from a removed source (no `origin`), the detached
    // `formerlySynced` receipt. Clear it from whichever receipt holds THIS gateway
    // id, rather than assuming `origin` exists (`dropTemplateProxy` predates the
    // detached-receipt case; gateway must not follow it). Gated on `=== cur` so a
    // divergent stamp on the other receipt is left intact — and so the persisted
    // result matches what `NexusCore.clearGatewayReferencesTo` clears at apply.
    const cur = record.ipmiGatewayServerId;
    const { ipmiGatewayServerId: _droppedGateway, ...withoutGateway } = record;
    let next: ServerConfig = withoutGateway;
    // `cur !== undefined` first so the `=== cur` comparisons narrow the optional
    // chains (this pass only runs for a defined dangling gateway id; the guard makes
    // that explicit to the type checker).
    if (cur !== undefined && record.origin?.templated?.ipmiGatewayServerId === cur) {
      const templated = { ...record.origin.templated };
      delete templated.ipmiGatewayServerId;
      next = { ...next, origin: { ...record.origin, templated: templatedHasAnyStamp(templated) ? templated : undefined } };
    }
    if (cur !== undefined && record.formerlySynced?.templated?.ipmiGatewayServerId === cur) {
      const templated = { ...record.formerlySynced.templated };
      delete templated.ipmiGatewayServerId;
      next = {
        ...next,
        formerlySynced: { ...record.formerlySynced, templated: templatedHasAnyStamp(templated) ? templated : undefined }
      };
    }
    return next;
  };
  // Is a record's EFFECTIVE gateway an INVALID template-OWNED reference this pass
  // must clean? Returns the dangling gateway id, or undefined when there is
  // nothing to clean. INVALID = the gateway is template-OWNED
  // (`record.origin.templated.ipmiGatewayServerId === cur`, §8.4 — a hand-set
  // gateway is left alone) AND names a NON-survivor. NO self-reference handling
  // (the deliberate divergence from `invalidTemplateProxy` — see the header): a
  // self-gateway `cur === record.id` is a survivor, so `survivorIds.has(cur)` is
  // true and it is correctly NOT flagged.
  const invalidTemplateGateway = (record: ServerConfig): string | undefined => {
    const cur = record.ipmiGatewayServerId;
    // PR #66 Codex round 10 — resolve template ownership from the live origin OR
    // the detached `formerlySynced` receipt: a server KEPT from a removed source
    // has no `origin`, so a gateway it template-owns is stamped only on the
    // receipt. Without this, GATEWAY PART 2 emitted neither an update nor a warning
    // for such a survivor, yet `clearGatewayReferencesTo` cleared both its value and
    // detached stamp at apply — the persisted result then differed from the preview.
    const stampedGateway =
      record.origin?.templated?.ipmiGatewayServerId ?? record.formerlySynced?.templated?.ipmiGatewayServerId;
    if (
      cur === undefined ||
      stampedGateway === undefined ||
      stampedGateway !== cur || // §8.4 — template-OWNED only; a hand-set gateway is left alone
      survivorIds.has(cur) // a self-gateway is a survivor → NOT flagged (no self-drop; see header)
    ) {
      return undefined;
    }
    return cur;
  };
  const warnRetainedGateway = (record: ServerConfig, gatewayId: string): void => {
    // Dedupe by `server::gateway` in the SAME `warnedRetainedGatewayKeys` set the
    // round-3 WRITTEN pass uses. Written vs retained are disjoint (a gateway is
    // either written this run or retained, never both), so sharing the set is safe
    // and prevents any cross-pass double-warn on the same reference.
    const warnKey = `${record.id}::${gatewayId}`;
    if (warnedRetainedGatewayKeys.has(warnKey)) {
      return;
    }
    warnedRetainedGatewayKeys.add(warnKey);
    warnings.push(
      `Server "${record.name}" on "${source.name}" carries a device-template IPMI gateway whose gateway server will not survive this sync (it is being pruned) — the IPMI gateway field was removed.`
    );
  };

  // GATEWAY PART 2a — every planned update's `after`, cleaned IN PLACE. Because
  // proxy PART 2b already ran, this `updates` array INCLUDES any proxy-promoted
  // server, so a server dangling on BOTH proxy and gateway is cleaned HERE in its
  // existing update — never re-promoted by GATEWAY PART 2b below. No promotion and
  // no `unchangedCount` change: the server was already an update.
  for (const u of updates) {
    const invalidGateway = invalidTemplateGateway(u.after);
    if (invalidGateway === undefined) {
      continue;
    }
    warnRetainedGateway(u.after, invalidGateway);
    u.after = dropTemplateGateway(u.after); // a DROP (retained value IS the dangling gateway — nothing beneath to restore)
    dropGatewayProvenance(u.after.id); // no §3.4 line for a removed gateway (retained ⇒ usually none; belt-and-suspenders, mirror proxy)
  }

  // GATEWAY PART 2b — the UNPLANNED set. RECOMPUTE `plannedServerIds` FRESH here
  // (adds ∪ CURRENT updates-before ∪ prunes): do NOT reuse proxy PART 2b's
  // snapshot, because proxy PART 2b may have PUSHED new updates after taking it. A
  // server proxy-PART-2b promoted is now in THIS fresh set → skipped here → its
  // gateway was already cleaned by GATEWAY PART 2a → no duplicate update, no
  // double-decrement. Iterate the SAME `unplannedCandidates` (owned ∪ kept) built
  // for the proxy pass — a kept server carries no `origin`, so
  // `invalidTemplateGateway`'s stamp guard makes it a no-op.
  const gatewayPlannedServerIds = new Set<string>();
  for (const id of addedServerIds) {
    gatewayPlannedServerIds.add(id);
  }
  for (const u of updates) {
    gatewayPlannedServerIds.add(u.before.id);
  }
  for (const id of prunedServerIds) {
    gatewayPlannedServerIds.add(id);
  }
  for (const candidate of unplannedCandidates) {
    if (gatewayPlannedServerIds.has(candidate.id)) {
      continue; // already an add / update (incl. a proxy-promoted one) / prune — handled by PART 2a or its own branch
    }
    const invalidGateway = invalidTemplateGateway(candidate);
    if (invalidGateway === undefined) {
      continue;
    }
    warnRetainedGateway(candidate, invalidGateway);
    // NOT PLANNED — promote to a new gateway-dropping update.
    updates.push({ before: candidate, after: dropTemplateGateway(candidate) });
    dropGatewayProvenance(candidate.id);
    // Same decrement gate as proxy PART 2b (Codex round 4): a server whose device
    // was SKIPPED this fetch reaches here without ever hitting `unchangedCount++`,
    // so an unconditional decrement would understate the count or drive it negative.
    if (unchangedServerIds.has(candidate.id)) {
      unchangedCount--; // this device was counted unchanged in the loop; it is now an update
    }
  }

  // M2 (PR-T2 review) — SOURCE-LEVEL dangling-reference warnings, emitted ONCE
  // after the loop and deduped against the per-device path (`pushDedupTemplateWarning`).
  // The per-device dangling warnings only fire for devices the loop reached, so a
  // source whose catch-all/implicit template names a dangling jump host or a
  // deleted auth profile would warn NOWHERE when zero devices are syncable (T1
  // warned once). Running the baseline catch-all cascade's warnings here restores
  // that: when devices DID run, the identical strings are already seen and the
  // dedup swallows these; when none did, this is the only surface.
  for (const w of baselineComposed.warnings) {
    pushDedupTemplateWarning(w);
  }
  const baselineAuthWinner = baselineCascade.winners.authProfileId;
  if (
    baselineAuthWinner !== undefined &&
    !baselineCascade.authFromImplicit &&
    resolveAuthProfileById(baselineAuthWinner.value) === undefined
  ) {
    pushDedupTemplateWarning(
      `A device template rule on "${source.name}" links an auth profile that no longer exists — the auth field was skipped.`
    );
  }

  // DEVICE TEMPLATES (§2.3 A-M4) — ZERO-MATCH info: a rule that matched no device
  // this fetch (a typo that passed every save check) gets one plan info line, the
  // honest surface for a filter that is quietly dead. Catch-all rules match every
  // device, so they only appear here when the tree is empty / all-skipped.
  for (const p of prepared) {
    if (!matchedRuleIds.has(p.rule.id)) {
      warnings.push(`Rule "${filterLabel(p.rule.filter)}" on "${source.name}" matched no devices this sync.`);
    }
  }

  // DEVICE TEMPLATES (§3.4) — plan-report PROVENANCE lines: per (field, rule),
  // aggregated so the plan stays readable at fleet scale. Servers with an
  // identical provenance signature (same fields ← same rules) collapse to one line
  // naming the count and each field's origin. Report-only. PR-T2 review (B2): the
  // entries here are already gated on the matrix's ACTUAL WRITES (a hand-edit / a
  // dropped or restored dangling proxy leaves no entry), so every line names a
  // value that genuinely flowed this run. The implicit source-level auth rule sets
  // no §3.4 entry (`selectFieldWinners` records `implicit: false` on every entry it
  // makes and none at all for the implicit rule), so `FieldProvenance.implicit` is
  // always false here — the former `implicit ? "(source default)"` branches were
  // dead and are removed.
  if (provenanceByServer.size > 0) {
    const groups = new Map<string, { count: number; provenance: Partial<Record<TemplatableField, FieldProvenance>> }>();
    // The canonical field order, shared so a new templatable field (here the two
    // PR-T3 IPMI id references) is never silently omitted from this report again —
    // the former hand-maintained five-field literal collected IPMI provenance but
    // never rendered it, and an IPMI-only write produced no provenance line at all.
    const fieldOrder = TEMPLATABLE_FIELD_ORDER;
    for (const entry of provenanceByServer.values()) {
      const parts: string[] = [];
      for (const field of fieldOrder) {
        const prov = entry.provenance[field];
        if (prov !== undefined) {
          // Codex round 2 #3 — `templateName` and `ruleFilter` are user-controlled free
          // text; the former `${field}=${name}::${filter}` join with `::`/`|` was
          // ambiguous, so distinct signatures collided (template `A::x`+filter `y` vs
          // `A`+`x::y`), merging server counts and mis-attributing writes. Serialize the
          // per-field tuple with JSON.stringify so only genuinely identical provenance
          // signatures collide (same class as round-1 Fix C's encoded tie-break key).
          parts.push(JSON.stringify([field, prov.templateName, prov.ruleFilter ?? null]));
        }
      }
      if (parts.length === 0) {
        continue; // no written template field survived — nothing to report for this server
      }
      const key = JSON.stringify(parts);
      const g = groups.get(key);
      if (g === undefined) {
        groups.set(key, { count: 1, provenance: entry.provenance });
      } else {
        g.count++;
      }
    }
    for (const key of [...groups.keys()].sort()) {
      const g = groups.get(key)!;
      const segments: string[] = [];
      for (const field of fieldOrder) {
        const prov = g.provenance[field];
        if (prov === undefined) {
          continue;
        }
        const origin =
          prov.ruleFilter !== undefined && prov.ruleFilter.trim() !== "" ? `(rule ${prov.ruleFilter})` : "(catch-all rule)";
        segments.push(`${TEMPLATE_FIELD_SHORT_LABELS[field]} ← "${prov.templateName}" ${origin}`);
      }
      if (segments.length > 0) {
        warnings.push(`${g.count} server${g.count === 1 ? "" : "s"}: ${segments.join("; ")}`);
      }
    }
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
    // DEVICE TEMPLATES (§2.2 A-M4) — the device-level `attributes` member: an
    // object whose values are each a string or a string-array; anything else
    // rejects the tree at the provider boundary, consistent with the field checks
    // above. Deliberately scoped to the DEVICE member — the endpoint-level
    // `attributes` (a different member, different value shape) keeps its
    // "preserved, otherwise unused" disposition and is not validated here.
    if (d.attributes !== undefined) {
      if (typeof d.attributes !== "object" || d.attributes === null || Array.isArray(d.attributes)) {
        throw new Error(`devices[${i}].attributes is not an object`);
      }
      for (const [key, value] of Object.entries(d.attributes as Record<string, unknown>)) {
        const ok = typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
        if (!ok) {
          throw new Error(`devices[${i}].attributes["${key}"] is not a string or string array`);
        }
      }
    }
  });
  if (obj.warnings !== undefined && (!Array.isArray(obj.warnings) || !obj.warnings.every((w: unknown) => typeof w === "string"))) {
    throw new Error("warnings is not a string array");
  }
  if (obj.truncated !== undefined && typeof obj.truncated !== "boolean") {
    throw new Error("truncated is not a boolean");
  }
}
