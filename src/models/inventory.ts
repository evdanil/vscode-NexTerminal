import { createHash, randomUUID } from "node:crypto";

export type InventoryEndpointKind = "ssh" | "telnet" | "redfish" | "url" | "ipmi-sol";

/**
 * One way to reach a device. The sync engine maps the FIRST endpoint with
 * kind === "ssh" onto `ServerConfig.host`/`port`, and the FIRST with kind
 * "redfish" or "ipmi-sol" onto `ServerConfig.ipmiHost` (see
 * `selectManagementEndpoint` in services/inventory/syncEngine.ts, and the stamp
 * rules on `ServerOrigin.syncedIpmiHost`).
 *
 * ALTERNATE HOST (issue #48, Phase 2) — the SECOND endpoint with kind === "ssh"
 * carries the ALTERNATE host, mapped onto `ServerConfig.altHost` by
 * `selectAltEndpoint` (with the `ServerOrigin.syncedAltHost` stamp rule twinning
 * `syncedIpmiHost`'s). THE CONVENTION: first ssh = primary host, second ssh =
 * alternate host. All other kinds — and any THIRD-or-later ssh endpoint — are
 * accepted, preserved on the tree, and otherwise unused.
 *
 * TELNET (Phase 0) — the FIRST endpoint with kind === "telnet" maps onto
 * `host`/`port` PLUS `protocol: "telnet"` (see `selectPrimaryEndpoint` in
 * services/inventory/syncEngine.ts, and the `ServerOrigin.syncedProtocol` stamp
 * rule, which twins `syncedAltHost`'s). Its default port is 23, not 22.
 *
 * SSH WINS THE PRIMARY SLOT. A device that reports BOTH an ssh and a telnet
 * endpoint maps to an SSH server, whatever order they are listed in, and its
 * telnet endpoint is then simply unused. This is a deliberate simplification
 * rather than a preference setting: SSH is the protocol with authentication,
 * file transfer and tunnelling, so where a device offers both there is no case
 * for choosing the one that offers none of them — and a device reachable only
 * over telnet (a virtual console server, lab gear) is exactly the population
 * this kind exists for. A user who wants telnet on a dual-stack device switches
 * the server by hand, and the `syncedProtocol` stamp keeps that choice.
 */
export interface InventoryEndpoint {
  kind: InventoryEndpointKind;
  host: string; // hostname or IP, no CIDR suffix
  port?: number; // ssh default 22
  username?: string; // if set, the SOURCE owns username on the mapped server
  attributes?: Record<string, string | number | boolean>; // future kinds; ignored Phase 1
}

export interface InventoryDevice {
  externalId: string; // REQUIRED, stable across syncs, unique within one source
  name: string;
  folderPath?: string; // slash path RELATIVE to source targetFolder; ""/undefined = at targetFolder
  endpoints: InventoryEndpoint[];
  /**
   * DEVICE TEMPLATES (issue #48 PR-T2, §2.2) — provider-supplied MATCHING
   * metadata a template rule's `filter` is evaluated against (client-side, never
   * sent to the provider). String values are single-valued attributes; string[]
   * values are set-valued (a filter condition matches if ANY element matches).
   * Providers SHOULD emit BOTH the display name and the slug of an attribute as
   * elements of one set-valued entry (so a filter copied from a NetBox URL, which
   * speaks slugs, matches the same device a display-name filter does), and MUST
   * omit empty-string values entirely. Additive to contractVersion 1 — absent is
   * valid, and matches only catch-all rules.
   *
   * NAMING ADJACENCY (rev5): this is a DIFFERENT member from
   * `InventoryEndpoint.attributes` above — per-device rather than per-endpoint,
   * `string | string[]` rather than `string | number | boolean`, matched against
   * by rule filters rather than ignored. The two are never merged.
   */
  attributes?: Record<string, string | string[]>;
}

export interface InventoryTree {
  contractVersion: 1;
  devices: InventoryDevice[];
  warnings?: string[]; // provider-side notices surfaced in plan summary
  // FIX 2 — set by a provider when it stopped collecting early because it hit
  // its own hard cap (not because the source ran out of devices). When true,
  // computeSyncPlan skips the prune phase entirely: a capped fetch must never
  // be mistaken for "these devices no longer exist at the source".
  truncated?: boolean;
}

export type InventoryConfigFieldType = "string" | "password" | "number" | "boolean" | "select";

export interface InventoryConfigField {
  id: string;
  label: string;
  type: InventoryConfigFieldType;
  required?: boolean;
  placeholder?: string;
  description?: string;
  /**
   * PRIMARY-IP FAMILY PREFERENCE (issue #48 PR-E, backlog #3) — the closed set of
   * choices for a `type: "select"` field, in the order the dropdown lists them.
   * The stored value is the chosen `value`; the provider is responsible for
   * defaulting an absent/unknown value (a select added to a provider whose older
   * sources predate the field has no stored value on those sources). Ignored for
   * every other field type. The value strings are the same non-secret vocabulary
   * as a string field, so `formValuesToProviderConfig` stores a select exactly as
   * it stores a string.
   */
  options?: { label: string; value: string }[];
}

export type InventorySourceValues = Record<string, string | number | boolean>; // secrets NEVER here
export type InventorySourceSecrets = Record<string, string>; // from SecretStorage

export interface InventoryProvider {
  id: string; // e.g. "netbox"; unique in registry
  label: string;
  configFields: InventoryConfigField[];
  /**
   * DEVICE TEMPLATES (issue #48 PR-T2, §2.2 A-M4) — OPTIONAL. The filter keys
   * this provider's `InventoryDevice.attributes` can carry, so the rule-save flow
   * can warn when a filter uses a key outside this list ("Key 'sites' is not one
   * this source's provider reports…"). The reserved `name` key is provider-agnostic
   * and always available, so a provider that matches only on name may list just
   * `["name"]` (or nothing). A provider that declares NO list gets no key warning
   * (nothing to check against); the sync-time zero-match info covers it instead.
   * Additive, like every provider-contract extension.
   */
  attributeKeys?: string[];
  testConnection(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<void>;
  fetchInventory(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<InventoryTree>;
  /**
   * ADOPT 1 / REVIEW FINDING (P1, cross-instance adoption) — OPTIONAL. A stable
   * key identifying WHICH DEPLOYMENT of this provider `config` points at: not
   * "NetBox", but "the NetBox at https://netbox.example.com". Two sources of the
   * same provider pointing at different deployments must return different keys;
   * the same deployment configured twice (or re-added after removal, which mints
   * a brand-new source id) must return the same one.
   *
   * WHY THE PROVIDER AND NOT THE ENGINE. `InventoryDevice.externalId` is unique
   * only WITHIN one deployment — two NetBox instances both call their first
   * device "device:1" — so adoption (`ServerConfig.formerlySynced`, see
   * models/config.ts) cannot be scoped by provider KIND alone: a lab instance
   * and a production instance answering to the same `providerId` would each be
   * able to claim the other's kept servers, at which point the claiming source's
   * prune policy can delete a record — and its stored credentials — that it has
   * never seen. Which part of a config identifies the deployment is
   * provider-specific (a base URL here, a tenant/region/endpoint triple
   * elsewhere), so only the provider can answer it; the engine and the core
   * cannot reach into `InventorySourceValues` generically.
   *
   * NEVER PUT A SECRET IN IT. The returned key is PERSISTED verbatim on every
   * server the source keeps when it is removed, and travels in exported backups.
   * `secrets` is deliberately not a parameter — the method cannot see the vault
   * — but a non-secret field can still carry one (a base URL typed as
   * `https://user:token@host`), so derive the key from the connection IDENTITY
   * only and strip anything credential-shaped. `createNetboxProvider`'s
   * implementation is the reference: scheme + host + port + path, with userinfo,
   * query and fragment dropped.
   *
   * NOT IMPLEMENTING IT DISABLES ADOPTION for this provider's sources —
   * deliberately. See the eligibility rule in services/inventory/syncEngine.ts
   * for why falling back to the provider id was rejected. Everything else about
   * the provider works unchanged; the sync simply adds a kept server's device as
   * a new server rather than reclaiming it, which is the pre-adoption behaviour.
   *
   * Must be pure and synchronous, must not throw, and must not depend on
   * anything outside `config`. A throw, a non-string, an empty/oversized
   * (> `MAX_INVENTORY_INSTANCE_KEY_LENGTH`) or control-character-bearing return
   * value is treated as "no instance identity" — see
   * `resolveProviderInstanceKey` below, which is the ONLY sanctioned way to call
   * this method.
   */
  instanceKey?(config: InventorySourceValues): string | undefined;
}

/**
 * Upper bound on a provider-supplied instance key, enforced by
 * `resolveProviderInstanceKey`. The key is persisted on every kept server and
 * rendered into plan warnings, so an unbounded string from a third-party
 * provider would bloat globalState (and every backup) once per kept server and
 * could push an unreadable wall of text into the sync preview. 512 characters is
 * far beyond any real endpoint identity — the reference NetBox key is a base URL
 * — while staying obviously finite.
 */
export const MAX_INVENTORY_INSTANCE_KEY_LENGTH = 512;

// Control characters (C0 + DEL) — see resolveProviderInstanceKey.
const INSTANCE_KEY_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * ADOPT 1 / REVIEW FINDING (P1, cross-instance adoption) — the ONE place
 * `InventoryProvider.instanceKey` is invoked, so every caller (the sync path,
 * the "Keep Servers" stamp, the import rollback's stamp) reaches the same
 * verdict from the same code. Two halves of an identity rule that can disagree
 * is how a marker gets written under one notion of "same instance" and read
 * under another.
 *
 * Everything a third-party provider could get wrong degrades to `undefined`,
 * which means "this provider offers no instance identity" and disables adoption
 * for it — never an exception escaping into a sync, and never a partially
 * trusted key:
 *  - no method at all (the common case: a provider written before this existed);
 *  - a method that throws (it runs on the remove-source path, where an
 *    exception would abort a removal that has already asked the user to confirm);
 *  - a non-string, or a string that is empty/blank after trimming — an empty key
 *    would compare equal to another empty key and re-create exactly the
 *    cross-instance collision this whole mechanism removes;
 *  - a key longer than `MAX_INVENTORY_INSTANCE_KEY_LENGTH` (see above);
 *  - a key containing control characters. It is persisted, exported to backups
 *    and rendered into a user-facing warning; a newline or an escape sequence
 *    there is at best unreadable and at worst a way to forge extra lines in the
 *    sync preview.
 *
 * Trimming (rather than rejecting) surrounding whitespace matches how every
 * other config-derived value in this file is normalized, and cannot create a
 * false match: two keys equal after trimming named the same endpoint before it.
 *
 * REVIEW FINDING (P2, defensive copy) — the provider is handed its OWN COPY of
 * `config`, on exactly the terms `cloneForProvider` gives `fetchInventory` and
 * `testConnection` (commands/inventoryCommands.ts). Every caller here passes a
 * LIVE object: `source.config` as stored on the record in NexusCore, or the
 * config of a source record read straight out of core a line earlier. A
 * third-party `instanceKey` that normalizes its argument in place — lowercasing a
 * host, stripping a trailing slash — would therefore mutate stored state with no
 * revision bump behind it, so `sourceConfigUnchanged` still reports the record as
 * the same incarnation and the apply persists the mutated config while the tree
 * it applies was fetched from the original. `structuredClone` is cheap here for
 * the same reason it is there (every value is a string/number/boolean), and it is
 * inside the try so a non-cloneable value smuggled into globalState degrades to
 * "no instance identity" — the safe answer — instead of throwing into a sync or a
 * source removal.
 */
export function resolveProviderInstanceKey(
  provider: Pick<InventoryProvider, "instanceKey">,
  config: InventorySourceValues
): string | undefined {
  if (typeof provider.instanceKey !== "function") {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = provider.instanceKey(structuredClone(config));
  } catch {
    return undefined;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INVENTORY_INSTANCE_KEY_LENGTH || INSTANCE_KEY_CONTROL_CHARS.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export type InventoryErrorKind = "auth" | "network" | "protocol";

export class InventoryProviderError extends Error {
  public constructor(
    public readonly kind: InventoryErrorKind,
    message: string
  ) {
    super(message);
    this.name = "InventoryProviderError";
  }
}

export type InventoryPrunePolicy = "delete" | "orphan" | "keep";

/**
 * DEVICE TEMPLATES (issue #48 PR-T1) — one filter-scoped rule attaching a
 * `DeviceTemplateProfile` to some subset of a source's synced devices.
 *
 * Lives on the SOURCE (not the template) because *which devices get a template*
 * is source vocabulary (`role=switch` is NetBox's dialect), while the template
 * is a provider-agnostic bundle of values two sources can apply under different
 * filters. Rides the source record's existing persistence, `revision`
 * semantics, and backup round-trip.
 */
export interface TemplateRule {
  id: string; // randomUUID — stable identity for warnings/UI, survives reorder
  /**
   * Same query-string syntax as the NetBox Device Filter field
   * ("role=switch&site=syd"). Absent, "", or whitespace-only = catch-all
   * (matches every device). Matched CLIENT-SIDE against device attributes — but
   * the matcher (`deviceMatchesFilter`) and device attributes are PR-T2, so a
   * PR-T1 engine has no way to EVALUATE a real filter and FAILS CLOSED on one
   * (skips the rule with a plan warning; see services/inventory/templateApply.ts
   * and §7.2). Only catch-all rules are honoured until the matcher ships.
   */
  filter?: string;
  templateId: string; // DeviceTemplateProfile.id
}

export interface InventorySourceConfig {
  id: string; // randomUUID at creation
  providerId: string;
  name: string; // user-facing
  targetFolder: string; // normalized, or "" for root (allowed, discouraged)
  prunePolicy: InventoryPrunePolicy; // default "orphan"
  defaultUsername: string; // fallback SSH username applied AT ADD TIME only
  config: InventorySourceValues; // non-secret provider config
  secretFieldIds: string[]; // password-type field ids captured at save time (for cleanup/backup independence from provider registration)
  lastSyncAt?: number;
  // FINDING 1 (removal-identity review) — opaque generation token identifying
  // which INCARNATION of this record this is. Assigned fresh by
  // NexusCore.addOrUpdateInventorySource on EVERY write (every call site —
  // addSource, editSource, backup import/restore, ... — gets a new one for
  // free without needing to remember it itself); NEVER regenerated by
  // applyInventorySyncPlan's own lastSyncAt bump, so a routine sync does not
  // by itself invalidate a caller's already-captured snapshot. Optional for
  // backward compat with records persisted before this field existed — the
  // storage layer backfills a revision for those at LOAD time (see
  // VscodeConfigRepository.getInventorySources / InMemoryConfigRepository's
  // ensureInventorySourceRevision use), never retroactively rewriting disk.
  // See sourceConfigUnchanged() below for how this decides identity once
  // both sides being compared have one.
  revision?: string;
  // ITEM A (provider trust fingerprint) — a stable hash of the PROVIDER's
  // observable shape (label + ordered configFields) at the moment this
  // source was last saved (addSource) or edited (editSource), computed by
  // computeProviderFingerprint() below. VS Code exposes no caller identity
  // for `registerInventoryProvider` (see publicApi.ts's trust-model doc), so
  // this cannot prove WHICH extension is answering to `providerId` — only
  // that the currently-registered provider's declared shape still looks like
  // the one the user last knowingly configured. syncNow compares this
  // against computeProviderFingerprint(currentRegistrant) before reading any
  // vault secret for the source; a mismatch means the id was re-registered
  // (by an update, or by a different extension entirely) with a materially
  // different provider since, and the user is asked to confirm handing that
  // registrant the saved credentials. Optional for backward compatibility —
  // a source saved before this field existed has none; syncNow stamps it
  // silently on that source's first successful sync afterward (nothing to
  // compare it against yet, so no warning is shown).
  providerFingerprint?: string;
  // REVIEW FINDING 1 (P2, folder-GC ownership) — the folder paths (strictly
  // under `targetFolder`, ancestors included) that THIS source's own syncs
  // have created/used, as of the most recent `applyInventorySyncPlan` call
  // (non-"absent" mode only). Recomputed and overwritten wholesale on every
  // such apply — it is a snapshot of "what this sync's own `folders` list
  // named", not an accumulating history — so a folder this source stops
  // naming (e.g. a renamed rack) drops out of the set on the very sync that
  // stops naming it, making it eligible for GC on that same pass.
  //
  // Exists so `pruneEmptyFoldersUnderTarget` can tell "a folder THIS source
  // created and then abandoned" (safe to GC when empty) apart from "a folder
  // that happens to be empty right now" (never safe to GC on that basis
  // alone — it could be a manually-created folder the user deliberately
  // keeps empty, like a staging area, or a folder owned by a DIFFERENT
  // source under the same targetFolder). Only paths ever present in a
  // source's own `managedFolders` are GC candidates for that source; an
  // explicit folder never named by any of this source's applies is never
  // touched, however empty it is.
  //
  // Optional for backward compatibility: a source record persisted before
  // this field existed (or one that has simply never completed a
  // non-"absent" apply) has none. `applyInventorySyncPlan` treats a missing
  // `managedFolders` as an empty set for the purpose of computing GC
  // candidates — so a legacy/first sync stamps the set for the first time
  // but removes NOTHING as a side effect of that stamping (there is no prior
  // set to diff against yet). removeSource deletes the source record
  // wholesale, so `managedFolders` dies with it — any folders it names are
  // left behind, exactly like the rest of the source's bookkeeping (this
  // mirrors the already-documented behavior of leaving synced servers'
  // folders alone on source removal).
  managedFolders?: string[];
  // The auth profile (AuthProfile.id) servers synced from this source connect
  // with. Stamped by the LINK ONLY — the profile's username/authType/keyPath
  // are never copied into the server record, so a profile edit reaches every
  // server it owns without a re-sync (copies rot; a reference cannot).
  //
  // Applied at add time, and — on each sync — retroactively to owned servers
  // still sitting on the never-configured default (authProfileId undefined &&
  // ServerOrigin.syncedAuthProfileId undefined && authType "agent" && keyPath
  // undefined && username still equal to the one the sync itself stamped,
  // ServerOrigin.syncedUsername; exactly the shape the
  // add path writes). Matching the add path's own output is what makes
  // retro-apply safe: a hand-edit to the auth fields OR to the username takes
  // the server out of the set, so a hand-configured server is never re-stamped
  // (the username clause matters because no shipped provider supplies endpoint
  // usernames, so a manual username edit survives every sync and would
  // otherwise still look untouched). The comparison deliberately does NOT use
  // this source's current `defaultUsername`: selecting a profile on the source
  // form mirrors that profile's username INTO `defaultUsername`, so a
  // current-default comparison would treat every already-synced server as
  // hand-edited the moment a profile is linked — defeating retro-apply in its
  // own main flow. Servers synced before `syncedUsername` existed have no stamp
  // and fall back to `defaultUsername`, i.e. the earlier behavior, and are never
  // excluded for lacking it. Changing this field from one profile to another
  // does NOT re-stamp already-linked servers, and clearing it does NOT strip
  // them — both would silently undo a user's per-server decision.
  //
  // The `syncedAuthProfileId` clause is what makes a PER-SERVER opt-out possible
  // (review finding, P2): clearing a source-applied profile in the server editor
  // leaves the record satisfying every other clause, so without a record of what
  // the sync itself linked the next sync simply reattached it. A cleared link now
  // reads as "no profile, against a stamp naming one" and is left alone from then
  // on — including after this field is later pointed at a DIFFERENT profile, since
  // the opt-out is about what the sync last wrote on that server, not about which
  // profile the source currently names.
  //
  // Optional for backward compat, same reasoning as `revision`/
  // `providerFingerprint`/`managedFolders` above: a source saved before this
  // field existed simply has none, and absent means today's pre-feature
  // behavior bit-for-bit (defaultUsername + SSH agent). A dangling reference
  // (profile deleted out from under it) degrades to that same behavior with a
  // warning rather than failing the sync. See computeSyncPlan in
  // services/inventory/syncEngine.ts for both rules.
  authProfileId?: string;
  /**
   * DEVICE TEMPLATES (issue #48 PR-T1) — filter-scoped device-template rules.
   * Optional for backward compat like every post-1.0 source field: absent means
   * "no rules", bit-identical to today. See `TemplateRule` above and
   * `validateInventorySource` (utils/validation.ts) for the tolerant shape
   * clause. The `revision` path already covers live records in
   * `sourceConfigUnchanged`; the structural fallback below gains rule comparison
   * so a legacy-record comparison cannot call a rule-only change "unchanged".
   */
  templateRules?: TemplateRule[];
}

/**
 * DEVICE TEMPLATES (PR-T1) — structural comparison of two `templateRules`
 * lists, used only by `sourceConfigUnchanged`'s legacy-record fallback (live
 * records are decided by revision). Order-sensitive and field-wise: a reorder,
 * an added/removed rule, or a changed filter/templateId is a difference. Absent
 * and `[]` compare equal (both "no rules").
 */
function templateRulesEqual(a: TemplateRule[] | undefined, b: TemplateRule[] | undefined): boolean {
  const ar = a ?? [];
  const br = b ?? [];
  if (ar.length !== br.length) return false;
  return ar.every((rule, i) => rule.id === br[i].id && rule.filter === br[i].filter && rule.templateId === br[i].templateId);
}

/**
 * ITEM A (provider trust fingerprint) — pure hash over exactly the provider
 * shape a user can actually SEE and reason about when they configured a
 * source: its label and its configFields' (id, label, type, required, and —
 * for select fields — their options), in the provider's own declared order.
 * Deliberately excludes
 * testConnection/fetchInventory (functions — not hashable, and not what the
 * user "configured against") and `id` itself (the fingerprint's whole
 * purpose is to detect a DIFFERENT provider answering to the SAME id; hashing
 * the id would make every mismatch invisible). No `vscode` import — callable
 * from models/ and safe for both the command layer and tests.
 *
 * sha256, hex-encoded, truncated to the first 16 characters — this is a
 * drift-detection fingerprint, not a security credential, so collision
 * resistance at full sha256 strength is unnecessary; 16 hex chars (64 bits)
 * is already far more than this UI-facing comparison needs.
 */
export function computeProviderFingerprint(provider: Pick<InventoryProvider, "label" | "configFields">): string {
  const shape = {
    label: provider.label,
    configFields: provider.configFields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type,
      required: field.required === true,
      // SELECT OPTIONS (PR #64 Codex review round 3, P2 — issue #48 PR-E; round
      // 4 P2 corner). Include a SELECT field's options so a change to their
      // label/value/ORDER (with id/label/type/required unchanged) yields a
      // DIFFERENT fingerprint and triggers the provider-change re-confirmation.
      // Normalized to just {label, value} in declared order — only those and
      // their order matter, and any future extra option member cannot perturb the
      // hash. Gated on `type === "select"` because `options` is documented-IGNORED
      // (and never rendered) on non-select fields, yet `validateProviderShape`
      // ACCEPTS a stray `options` member there — so a non-select field always
      // projects `options: undefined` regardless of whether it carries one.
      // JSON.stringify drops undefined members, keeping every non-select field
      // BYTE-IDENTICAL to the pre-round-3 shape — no spurious re-confirmation for
      // existing sources.
      options: field.type === "select" && field.options ? field.options.map((o) => ({ label: o.label, value: o.value })) : undefined
    }))
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

/**
 * SecretStorage key for one (source, field) credential.
 *
 * Name is `${sourceId.length}:${sourceId}:${fieldId}` — mirroring
 * deterministicServerId's scheme — rather than a bare
 * `sourceId-fieldId` concatenation: sourceId is a user-editable inventory
 * source id (not guaranteed `-`-free like a randomUUID), so without a length
 * prefix two different (sourceId, fieldId) splits of the same joined string
 * could collide (e.g. "a-b" + "c" vs "a" + "b-c").
 *
 * fieldId itself does NOT need its own length prefix: the sourceId length
 * prefix already pins the exact split point (read the digits up to the
 * first `:`, then take exactly that many characters as sourceId, then the
 * next `:`), so everything after that second `:` is unambiguously fieldId
 * — even if fieldId itself contains further `:` or `-` characters. Putting
 * fieldId last (rather than first) is what makes this work with only one
 * length prefix.
 */
export function inventorySecretKey(sourceId: string, fieldId: string): string {
  return `inventory-source-${sourceId.length}:${sourceId}:${fieldId}`;
}

/**
 * FINDING 1 — assigns a revision to a source record loaded from persisted
 * storage that predates the `revision` field (a "legacy" record). Called by
 * the repository getters at LOAD time only — never by NexusCore, which
 * regenerates a revision on every WRITE instead (see
 * NexusCore.addOrUpdateInventorySource). Returns the input unchanged (same
 * reference) when a revision is already present, so this is safe to map over
 * every loaded record unconditionally.
 */
export function ensureInventorySourceRevision(source: InventorySourceConfig): InventorySourceConfig {
  return source.revision ? source : { ...source, revision: randomUUID() };
}

/**
 * Exported (not just used by sourceConfigUnchanged below) because
 * inventoryCommands.ts's syncNow also uses it directly to compare the vault
 * secret values captured at fetch time against a re-read taken immediately
 * before apply (FINDING D) — InventorySourceSecrets is structurally a
 * Record<string, string>, a subtype of InventorySourceValues, so this
 * comparator works for both.
 */
export function inventorySourceValuesEqual(a: InventorySourceValues, b: InventorySourceValues): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}

function secretFieldIdsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

/**
 * FINDINGS D/E — compares exactly the InventorySourceConfig fields that feed
 * computeSyncPlan/planToApplication (and the fetchInventory config; secret
 * VALUES are compared separately against the vault — see
 * inventoryCommands.ts's post-teardown check, which core cannot perform
 * itself since it has no vault access). A source record that differs on any
 * of these must not have a tree fetched under the OLD config applied against
 * it, even though its id still exists — e.g. a replace-mode config import can
 * delete and recreate the same source id with an entirely different provider
 * config while a sync is mid-flight.
 *
 * Lives here (not in commands or core) so both `NexusCore.applyInventorySyncPlan`
 * (the atomic, pre-mutation guard) and `inventoryCommands.ts`'s earlier
 * fast-fail checks share one comparator — core must not import from commands.
 *
 * FINDING 1 (removal-identity review) — structural equality alone cannot
 * prove two InventorySourceConfig values are the SAME record incarnation: a
 * replace-mode import can recreate a record with an identical
 * name/providerId/targetFolder/prunePolicy/defaultUsername/config/
 * secretFieldIds while pointing the same field ids at a brand-new vault
 * credential. When BOTH sides carry a `revision` (see the field doc), it
 * REPLACES the structural comparison entirely: equal revisions mean the same
 * incarnation (a legitimate lastSyncAt bump from applyInventorySyncPlan never
 * changes revision, so this still holds true across one), and different
 * revisions mean a different incarnation even when every structural field
 * happens to still match. Only when either side predates the revision field
 * (a legacy record) does this fall back to the old field-by-field structural
 * comparison — the same one used before this finding.
 *
 * `authProfileId` is compared in the structural fallback ONLY, like every
 * other field here: once both sides carry a revision, the revision already
 * decides (every write through NexusCore.addOrUpdateInventorySource assigns a
 * fresh one, so a profile change on a live record is caught there). The
 * fallback needs it so a legacy-record comparison cannot call a profile-only
 * change "unchanged" and let a tree fetched under the old profile apply.
 */
export function sourceConfigUnchanged(a: InventorySourceConfig, b: InventorySourceConfig): boolean {
  if (a.revision !== undefined && b.revision !== undefined) {
    return a.revision === b.revision;
  }
  return (
    a.providerId === b.providerId &&
    a.targetFolder === b.targetFolder &&
    a.prunePolicy === b.prunePolicy &&
    a.defaultUsername === b.defaultUsername &&
    a.authProfileId === b.authProfileId &&
    inventorySourceValuesEqual(a.config, b.config) &&
    secretFieldIdsEqual(a.secretFieldIds, b.secretFieldIds) &&
    // DEVICE TEMPLATES (PR-T1) — compared in the structural fallback ONLY, like
    // every other field here: once both sides carry a revision, the revision
    // already decides (every write through addOrUpdateInventorySource mints a
    // fresh one, so a rule edit on a live record is caught there). The fallback
    // needs it so a legacy-record comparison cannot call a rule-only change
    // "unchanged" and let a tree fetched under the old rules apply.
    templateRulesEqual(a.templateRules, b.templateRules)
  );
}
