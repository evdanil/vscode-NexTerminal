# Device Template Profiles — Design (post-PR #55, subsumes NetBox-polish #2, roadmap OQ4 [IPMI auto-assign], Phase-4 fleet assignment)

Status: design for owner review, REVISED after adversarial design review + UX review (materially changed sections are marked "(rev)"). No code written. All file:line references are against `main` post-PR #55.

---

## TL;DR (rev)

- **New persisted collection `DeviceTemplateProfile`** (`nexus.deviceTemplates`): a named, partial-ServerConfig-shaped record where every set field carries a mode — `fill` (**write-once**: applies only where the field was never configured — it never rewrites an existing value, not even one the sync itself wrote earlier; see §4.3 mode gate) or `override` (beats source data and the sync's own earlier writes, and propagates template edits to still-sync-owned values — but **never** touches a hand edit).
- **Filter-scoped rules live on the inventory source**, not on the template: `InventorySourceConfig.templateRules?: Array<{ id, filter?, templateId }>`. A rule's `filter` uses the same `key=value&key=value` query syntax as the NetBox Device Filter field, matched client-side against new per-device `attributes` (role/site/rack/tenant/status/platform/tags — already on the fetched NetBox rows, zero extra API calls; **display names AND slugs both match**, so filters copied from NetBox URLs work) plus a provider-agnostic `name` glob. **Resolution is a CSS-like per-field cascade (owner decision — v1 requirement):** for EACH templatable field independently, among the matching rules whose template *sets* that field, the most specific wins (specificity = number of distinct filter keys; catch-all = 0). A narrow auth-only rule overrides just the auth field; the broader device profile still supplies every other field. Per-field ties broken deterministically by normalized-filter lexicographic order with a loud sync warning. The stamp design (stamps record *values*, never *which rule* wrote them) is what lets the cascade ride the same matrix with no extra schema.
- **Precedence total order:** hand-edit > template-override > source > template-fill > unset. Enforced by generalizing the `syncedUsername`/`syncedAuthProfileId` stamp discipline ("record what the sync wrote; only rewrite what still matches the stamp", `src/models/config.ts:43-92`): a new grouped `ServerOrigin.templated` record holds one per-field stamp of the exact value the template application last wrote. **`authProfileId` reuses the existing `syncedAuthProfileId` stamp unchanged** — which is what makes per-server opt-outs, `removeAuthProfile` sweeps, and the AUTH 2 clauses work for template-written links without a second mechanism.
- **A filter-bound auth-profile assignment IS just a template that sets only `authProfileId`** — one rule mechanism, not two (owner directive). **PR #53's source-level auth profile is KEPT in storage but re-read as the lowest-precedence implicit rule:** an implicit catch-all *fill* rule for `authProfileId` sitting below every explicit rule in the cascade — which reproduces today's behavior bit-for-bit when no explicit rule sets the field. Storage migration was weighed and rejected: it would rewrite the most intricate reviewed credential machinery in the codebase (AUTH 1/1b/2/2b/3, `src/services/inventory/syncEngine.ts:195-899`) for zero user-visible gain, and old-build backup/downgrade skew on a migrated model silently drops fleet auth assignment — the worst failure class. A later load-time normalization (à la `ensureInventorySourceRevision`, `src/models/inventory.ts:251-253`) can unify storage once templates have soaked.
- **Two application triggers, one engine:** (a) per-source rules applied by every sync inside `computeSyncPlan` (stamped — sync-owned); (b) a manual **"Apply template to folder…"** command (mirrors `nexus.authProfile.applyToFolder`, `src/commands/authProfileCommands.ts:49-78`) that writes values **without stamps** — a manual apply is a user decision and must read as a hand edit to every later sync. This exactly subsumes Ogun's backlog item #2 (bulk proxy to a folder tree), including its "care with sync-owned servers" caveat.
- **v1 field surface:** `proxy`, `authProfileId`, `multiplexing`, `legacyAlgorithms`, `logSession`. Reserved slots that drop in as their PRs land: `ipmiAuthProfileId` (answers the roadmap's open question 4 to Ogun — NetBox auto-assigning the universal IPMI profile is a template field, not a second source-level link), `ipmiGatewayServerId` (Phase 4 fleet-scale assignment). Excluded: `host`/`name`/`ipmiHost` (device identity / sync-owned), `group` (folder placement is the provider's `folderTemplate`'s job), `username`/`authType`/`keyPath` (owned by the auth-profile machinery; templating them would silently perturb the AUTH 2 eligibility clauses), `port` (deferred — see §4.6).
- **Re-sequencing:** PR-A and PR-B ship unchanged (PR-A's `syncedIpmiHost` matrix is the prototype of the per-field stamp discipline). PR-F's filterable select ships early (template pickers reuse it); PR-F's bulk-proxy half is deleted (subsumed). New: PR-T1 (engine core: model + storage + stamps + `computeSyncPlan` wiring, with the per-field cascade as the engine's **only** resolution algorithm from day one — not user-visible on its own), PR-T1b (tri-state template editor + source select + manual folder apply — the feature becomes usable here), PR-T2 (filter rules + device attributes, when the cascade becomes user-visible; "v1" as the owner scoped it = T1+T1b+T2 landed), PR-T3 (IPMI field slots, after PR-B/PR-C).

---

## 1. Data model

### 1.1 `DeviceTemplateProfile` — new file `src/models/deviceTemplate.ts` (pure, no `vscode` import)

```ts
export type TemplateFieldMode = "fill" | "override";

/** One templated field: the value the template supplies and how forcefully. */
export interface TemplateField<T> {
  mode: TemplateFieldMode;
  value: T;
}

export interface DeviceTemplateProfile {
  id: string;        // randomUUID at creation
  name: string;      // user-facing; referenced by id everywhere, so rename is free
  /** Incarnation token, same contract as InventorySourceConfig.revision
   *  (src/models/inventory.ts:97): assigned fresh by NexusCore on every write,
   *  backfilled at load for legacy records. Lets the sync's pre-apply fast-fail
   *  detect "template edited mid-sync" the same way sourceConfigUnchanged
   *  (inventory.ts:313-326) detects a source edit. */
  revision?: string;
  /** A field that is ABSENT is one the template says nothing about.
   *  There is no "clear" mode in v1 (see §11 open question 3). */
  fields: {
    proxy?: TemplateField<ProxyConfig>;
    authProfileId?: TemplateField<string>;   // AuthProfile.id — link only, never copied credentials
    multiplexing?: TemplateField<boolean>;
    legacyAlgorithms?: TemplateField<boolean>;
    logSession?: TemplateField<boolean>;
    // Reserved — added by PR-T3 once PR-B / PR-C land the ServerConfig fields:
    // ipmiAuthProfileId?: TemplateField<string>;
    // ipmiGatewayServerId?: TemplateField<string>;
  };
}
```

Why per-field `{mode, value}` rather than a template-level mode: the owner's ask is explicitly per-field ("specify **if a field** in the template overrides…"), and the realistic template mixes them — override the proxy fleet-wide, but only fill the auth profile where nobody configured one.

### 1.2 Rules — on `InventorySourceConfig` (`src/models/inventory.ts:74-189`)

```ts
// InventorySourceConfig gains:
templateRules?: Array<{
  id: string;         // randomUUID — stable identity for warnings/UI, survives reorder
  /** Same query-string syntax as the NetBox "Device Filter" config field
   *  (src/services/inventory/providers/netboxProvider.ts:38-44):
   *  "role=switch&site=syd". Absent or "" = catch-all (matches every device).
   *  Matched CLIENT-SIDE against InventoryDevice.attributes (§2), never sent
   *  to the provider. */
  filter?: string;
  templateId: string; // DeviceTemplateProfile.id
}>;
```

**Why on the source, not on the template:** a template is a reusable bundle of values ("branch-office defaults"); *which devices get it* is source vocabulary — `role=switch` is NetBox's dialect, and two sources can legitimately apply the same template under different filters. Storing the filter on the template would force one filter per template globally and couple a provider's attribute vocabulary into a provider-agnostic record. Rules ride the source record's existing persistence, `revision` semantics (every `addOrUpdateInventorySource` re-revisions — mid-sync rule edits are caught by the same `sourceConfigUnchanged` guard for free), and backup round-trip.

Optional-for-backward-compat like every post-1.0 source field (`revision`/`providerFingerprint`/`managedFolders`/`authProfileId`, `inventory.ts:97-188`): absent means "no rules", bit-identical to today. `validateInventorySource` (`src/utils/validation.ts:154-238`) gains a tolerant shape clause; `sourceConfigUnchanged`'s structural fallback gains rule comparison (revision path already covers live records).

### 1.3 Stamps — `ServerOrigin.templated` (`src/models/config.ts:39-93`) (rev)

```ts
// ServerOrigin gains:
/**
 * Per-field record of what the sync's TEMPLATE APPLICATION last wrote onto
 * this server — the syncedUsername/syncedAuthProfileId discipline (above),
 * one member per templatable field. A key that is PRESENT means "the sync
 * wrote this field, and this is exactly what it wrote"; a key that is ABSENT
 * means "the sync never wrote this field". Unlike syncedAuthProfileId there
 * is no unconditional-undefined recording: templates never write undefined
 * (no clear mode), so absence is unambiguous. NOTE deliberately excluded:
 * authProfileId — template-written links stamp the EXISTING
 * syncedAuthProfileId member, so opt-out, removeAuthProfile clearing, and
 * the AUTH 2 clauses need no parallel twin.
 */
templated?: {
  proxy?: ProxyConfig;
  multiplexing?: boolean;
  legacyAlgorithms?: boolean;
  logSession?: boolean;
  // future: ipmiAuthProfileId?: string; ipmiGatewayServerId?: string;
};
```

**Why a grouped member rather than flat `syncedProxy`/`syncedMultiplexing`/… siblings:** the single most dangerous forget-point in this codebase is the update path's `afterOrigin` rebuild — an unrelated device rename rebuilds `origin` from scratch, and a member missed there erases a stamp (the exact hazard the `syncedAuthProfileId` carry-forward comment documents, `syncEngine.ts:452-465`). A grouped record is **one** carry-forward line (`templated: ownedServer.origin?.templated`), one clause in `isValidServerOrigin` (`validation.ts:50-74` — malformed `templated` strips the whole origin, same loud disposition), one comparator helper, one deep-copy site. Flat members multiply every one of those by field count, forever.

**Why the stamp does NOT record which template wrote it:** the matrix (§4) never needs to know. Ownership is decided by *value* equality ("is the record still exactly what I wrote?"), and the desired value is recomputed from the current rules every sync. This is also the property that makes the per-field cascade (§3.2) work with no extra schema: no stamp knows about winners, so field A written by rule 1 and field B by rule 2 — or B's winner changing next sync — never touches storage shape (provenance trade-off in §3.4).

**Bookkeeping bill** (the same checklist every ServerConfig/Origin addition pays):
- `serverOriginStampsEqual` (`config.ts:173-182`) gains a `templatedStampsEqual(a.templated, b.templated)` term (structural; `proxy` member compared via `proxyConfigsEqual`, `config.ts:144-156`). `serverOriginsEqual` (`config.ts:184-195`) inherits by construction — "a member added to ServerOrigin can only be forgotten in a single place" (`config.ts:170-172`) — which keeps `mergeServerConfigFields`' conditional origin restore (`config.ts:273-275`) from dropping a fresh stamp on rollback.
- `cloneServerConfig` (`config.ts:136-142`) spreads `origin` one level deep; `templated` is nested (and holds a nested `ProxyConfig`), so the clone must deep-copy it. (The reassuring "a new scalar member is covered" line is the **roadmap's** observation about `syncedIpmiHost` — a scalar — in `issue-48-roadmap.md` §2.3, not anything in `cloneServerConfig`'s own doc; it explicitly does not apply to this nested member.) Same for `mergeServerConfigFields`' origin branch, which copies `{ ...current.origin }` one level (`config.ts:274`).
- `mergeServerConfigFields` value fields: `proxy`, `multiplexing`, `legacyAlgorithms`, `logSession` are already compared field-wise (`config.ts:262-264`, `:270-272`) — no change needed there. `serverConfigsEqual` already covers them too (`config.ts:207-227`).
- **Boolean stamps (m12):** `templated.multiplexing: false` is a PRESENT stamp carrying the value `false`. Every presence check on the stamp record must be `!== undefined` (or a `hasOwnProperty`/`in` check), never truthiness — a truthiness check silently converts "sync wrote false" into "never wrote", flipping matrix rows 3/6 into row 1/7. Called out here because it is the one member shape where the bug is invisible in fixtures that only use `true`.
- `changed` in the update path (`syncEngine.ts:719-726`) gains `!proxyConfigsEqual(ownedServer.proxy, after.proxy)` and the three booleans; the origin half comes free via `serverOriginStampsEqual` (AUTH 3a's stamp-only-change precedent at `syncEngine.ts:704-714` applies verbatim: a template application whose value already equals the record must still land in `updates` to persist the stamp, or the server is stranded stampless forever).

### 1.4 Storage / repository

- New keys and methods: `nexus.deviceTemplates` in `VscodeConfigRepository` (`src/storage/vscodeConfigRepository.ts:15-21` key block; `getDeviceTemplates`/`saveDeviceTemplates` following the `getAuthProfiles` pattern with `validateDeviceTemplate` + load-time `ensureDeviceTemplateRevision`), twin in `InMemoryConfigRepository`, `ConfigRepository` contract widened.
- `NexusCore`: `deviceTemplates: Map<string, DeviceTemplateProfile>`, CRUD (`addOrUpdateDeviceTemplate` re-revisions on every write, like `addOrUpdateInventorySource`), snapshot exposure, `removeDeviceTemplate` sweep (§6.2), `onDidChange` emission.
- No secrets anywhere in a template (see §5.3 on proxy passwords), so backup export needs no new vault section.

---

## 2. Filter metadata — what a rule can match on

### 2.1 What survives into the tree today: almost nothing

`InventoryDevice` is `{ externalId, name, folderPath?, endpoints }` (`src/models/inventory.ts:20-25`). The NetBox provider *reads* site/location/rack/role/tenant off every device row (`deviceVars`, `netboxProvider.ts:373-382`; VM variant `:384-394`) but uses them **only** to render `folderPath` and discards them. Matching on `folderPath` strings would be matching on a lossy, template-mangled projection — not acceptable as the filter substrate.

### 2.2 New: `InventoryDevice.attributes` (rev)

```ts
// models/inventory.ts — InventoryDevice gains:
/** Provider-supplied matching metadata. String values are single-valued
 *  attributes; string[] values are set-valued (a filter condition matches if
 *  ANY element matches). Providers SHOULD emit both the display name and the
 *  slug of an attribute as elements of one set-valued entry, and MUST omit
 *  empty-string values entirely. Additive to contractVersion 1 — absent is valid. */
attributes?: Record<string, string | string[]>;
```

- `validateInventoryTree` (`syncEngine.ts:1019-1072`) gains a tolerant clause (object of string / string-array values; anything else rejects the tree at the provider boundary, consistent with the existing field checks).
- **NetBox provider** populates it in `mapEntry` (`netboxProvider.ts:418-445`) from the same rows the pagination already fetches — **no new API calls**, same argument as PR-A's `oob_ip` (`issue-48-roadmap.md` §2.1). **Both vocabularies are emitted (A-M4):** `deviceVars` extracts display names (`netboxProvider.ts:366-382`), but the NetBox Device Filter field users will copy filters from speaks slugs (`site=syd`, `role=core-switch`), so matching display names alone is a silent-no-op trap. Each of `role`, `site`, `location`, `rack`, `tenant`, `platform` is emitted as a set-valued entry `[displayName, slug]` (deduplicated, empty strings omitted — m9c); `status` emits `[value, label]` (NetBox nests both, and `.value` is the slug-like one); `tags` emits the array of tag names + slugs. Set-valued matching (any element) then gives name-OR-slug matching with **zero special cases in the matcher**. VMs get the same minus rack/location, mirroring `vmVars`' documented asymmetry. This closes what was open question 4 in the first draft: both-sides matching is the v1 default, not an option.
- **Provider-agnostic lowest common denominator:** the reserved filter key `name` matches `device.name` with `*` glob (implemented as an anchored regex built by escaping everything except `*` — the same "positive construction, no user regex" philosophy as the token charsets). Third-party providers that emit no `attributes` still get name-scoped rules; ones that do emit attributes get full vocabulary for free.
- **Key vocabulary declaration (A-M4):** `InventoryProvider` gains optional `attributeKeys?: string[]` (additive, like every provider-contract extension) — the filter keys this provider's `attributes` can carry. The NetBox provider declares its list (`role, site, location, rack, tenant, status, platform, tag, name`). The rule-save flow warns when a filter uses a key outside a declared list ("Key 'sites' is not one this source's provider reports — this rule will never match. Known keys: role, site, …"); providers that declare no list get no key warning (nothing to check against), and the sync-time zero-match info below covers them.

### 2.3 Filter syntax and matching semantics (rev)

- Syntax: exactly the NetBox Device Filter field's `URLSearchParams` syntax (`status=active&site=syd`) — the one query dialect users of this feature have already typed into this extension (`netboxProvider.ts:38-44`). Parsed with `new URLSearchParams(filter)`, like `parseFilter` (`:347-364`).
- Semantics: **repeated key = OR within the key** (`role=switch&role=router`), **distinct keys = AND** — the same semantics NetBox itself gives those queries server-side, so the mental model transfers.
- **Keys are case-folded (lowercased) at parse time (m9a)** — before distinct-key counting, before deduplication, and before attribute lookup, so `Role=switch&role=router` is one key with two OR values, not two keys. Attribute lookup is against lowercased keys; providers emit lowercase keys by contract.
- **`tag` is the filter key; `tags` is the attribute (m10):** the parser aliases filter key `tag` → attribute `tags` (NetBox's own query dialect is `tag=`, and every prompt/docs/warning uses `tag=`). The attribute name stays plural because it holds a set. One alias, declared once in `parseTemplateFilter`, so engine, prompts, and docs agree.
- Value comparison: case-insensitive, trimmed, against attribute values — which carry **both display names and slugs** (§2.2), so either vocabulary matches. For set-valued attributes: condition matches if any element matches.
- **Empty values are rejected at save (m9c):** a condition with an empty value (`role=`) can never match (providers omit empty attributes), so the rule-save flow refuses it with an explanation rather than storing a dead condition. Symmetrically, providers must omit empty-string attribute values, so "attribute present but empty" cannot exist to match against.
- A key the device has no attribute for ⇒ the condition fails (the rule does not match). A filter that parses to zero conditions ⇒ catch-all. **A bare match-everything glob `name=*` also counts as zero conditions (m9b)** — it constrains nothing, so letting it add specificity would be a free rank boost; the filter InputBox's live feedback says so when it sees one ("`name=*` matches every device — it adds no specificity").
- **Zero-match sync info (A-M4):** after the device loop, any rule that matched zero devices this fetch produces a plan-level info line — `Rule "role=swich" on "NetBox prod" matched no devices this sync.` — the honest surface for typos that pass every save-time check.

---

## 3. Rule resolution — specificity, ties, cascade

### 3.1 Specificity (owner directive: most specific wins, not list order) (rev)

**Specificity = number of DISTINCT keys in the filter**, counted after the parse normalizations of §2.3 (keys case-folded, `tag`→`tags` aliased, empty-valued conditions rejected at save, a bare `name=*` counted as zero conditions). `role=switch&site=syd&tag=x` → 3; `role=switch` → 1; catch-all → 0. Repeated values on one key (`role=switch&role=router`) still count that key **once** — an OR *broadens* a condition, it does not make the rule more specific, so letting it add weight would invert the intent (a sloppy 5-way OR outranking a precise single match).

Rejected alternative — weighting some keys higher than others (e.g. `name` > `role`): there is no provider-agnostic ground truth for which attribute is "narrower", and any fixed weighting is a magic table users must memorize. Distinct-key count is explainable in one sentence and computable identically in the engine, the UI sort, and a user's head.

### 3.2 Per-field cascade — the resolution algorithm (owner decision: v1 requirement, not an option) (rev — mode-gate qualifier)

For each device, for **each templatable field X independently**:

```
candidates(X) = matching rules whose template SETS field X
winner(X)     = the candidate with the highest specificity
                (per-field tie-break below if several tie)
tmplX         = winner(X).template.fields.X        // {mode, value}
```

Properties, stated as requirements:

- **A rule that sets only one field never suppresses other fields.** The owner's driving scenario verbatim: a source has a broad device-profile rule and a *more specific* auth-profile-only rule (a template setting only `authProfileId`). The narrow rule wins `authProfileId`; the broad rule still supplies `proxy` and every other field it sets. A filter-bound auth-profile assignment is therefore **not a second mechanism** — it is an ordinary rule whose template happens to set one field.
- **The catch-all / less specific rule supplies every field the more specific rules don't set** — CSS-like fallthrough, per field.
- **Setting a field is what competes.** A template with `fields.proxy` absent is not a candidate for `proxy` at any specificity. (This is why "no clear mode in v1" matters: absence must unambiguously mean "says nothing", or the cascade can't fall through it. An eventual clear mode — §11 open question 3 — would compete like any set field, with value "none".)
- Specificity is computed once per rule (§3.1) and reused for every field; only candidacy differs per field.

**Why the stamp matrix survives the cascade untouched** (the coordinator's explicit concern): the matrix (§4.3) consumes exactly one input per field — `desiredX` — and stamps record *values*, never writers (§1.3). Field A coming from rule 1 and field B from rule 2 is invisible below the composition step. When a later sync changes which rule wins field B only (a new narrower rule added, an attribute changed, the narrow template edited), `desiredB` changes and row 3 rewrites B *iff still sync-owned AND the new winner is override-mode* (a fill winner never rewrites an existing value — §4.3 mode gate / A-M1), while field A's desired is unchanged and rows 4/6 hold it steady. No stamp records "which rule", so no stamp can go stale when rules churn — that is the design property doing the work.

### 3.3 Per-field tie-breaking (rev)

Two candidates for the SAME field with equal specificity:

- **Resolution: deterministic and order-free** — the candidate whose *normalized filter string* (keys sorted, values sorted within key, lowercased) sorts first lexicographically wins that field. NOT stored list order: the owner has made order non-semantic, and a stored-order tiebreak silently reintroduces order semantics behind a UI that says order is cosmetic — a trap that survives export/import and reorder-by-accident. Lexicographic-normalized is stable across reordering and backup round-trips (globalState is per-machine — no `setKeysForSync` exists in `src/` — so the cross-machine consistency channel is backups, not Settings Sync). Note ties are only possible between *distinct filters* (two rules with the identical filter normalize identically — broken by rule `id` as the final, still-deterministic resort, with the save-time warning below making that configuration visibly redundant).
- **Tie warnings are suppressed when the outcome is identical (m9d):** if every tied candidate supplies the same `{mode, value}` for the field, the "tie" is unobservable — warning about it would train users to ignore warnings. The warning fires only when tied candidates actually disagree.
- **User-visible signal, twice:**
  1. *Save time* (rule management flow): when two equal-specificity rules whose templates set an overlapping field are not **provably disjoint**, warn. Provably disjoint is decidable and cheap for this filter language: two rules are disjoint iff they share at least one key whose value sets do not intersect (`role=switch` vs `role=server` — disjoint; `role=switch` vs `site=syd` — can overlap). This is a warning, not a rejection: overlap can be intentional and data-dependent.
  2. *Sync time* (the moment a device actually ties on a field): a plan warning naming the device, the field, and both rules — `Device "sw-9-01": rules "role=switch" and "site=syd" tie for Proxy; applied "role=switch" (rule order is not used — make one rule more specific to choose deliberately).` — surfaced through the existing plan-preview Show Warnings channel.

### 3.4 Per-field provenance — record vs infer (assessed)

"Where did this field's value come from?" has two audiences with different answers:

- **Sync report (plan preview / Show Warnings): inferred at plan time, free.** The engine holds `winner(X)` per device per field while composing, so the plan can carry provenance lines at zero storage cost — `12 servers: Proxy ← "Switch defaults" (rule role=switch); Auth Profile ← "Core auth" (rule role=switch&site=syd)` — aggregated per (field, rule) pair to stay readable at fleet scale. This is the moment the user consents to the write, so it is also the moment provenance matters most. **Ships in PR-T2.**
- **Steady-state tooltip on a server: cannot be inferred, and recording it is not worth its cost in v1.** Inference after the fact is impossible because rule matching needs `device.attributes`, which live on the *fetched tree* and are deliberately not persisted onto `ServerConfig` — re-running the matcher at render time would be matching against data the extension no longer has. Recording it would mean widening each `templated` stamp from a bare value to `{ value, ruleId?, templateId? }`: schema weight in `ServerOrigin`, a comparator that must compare **value only** (or provenance drift breaks ownership decisions — a subtle standing trap), validation clauses, and a record that silently rots when rules/templates are renamed, edited, or deleted (which §6 deliberately allows without touching servers). Decision: **v1 tooltip says "template-applied" per field (derived from `cur === stamp`, always truthful about *ownership*) without naming the rule**; precise provenance lives in the sync report, where it is fresh by construction. The stamp shape can gain an informational, comparator-ignored provenance member later without migration if field-level "which rule?" at rest proves needed — noted in §11.

---

## 4. Precedence + stamp mechanics

### 4.1 The total order, and why

```
hand-edit  >  template-override  >  source  >  template-fill  >  unset
```

- **Hand-edit on top, absolutely.** The owner's "overrides data received from the source" names the *source*, not the user. This is also the only order compatible with the load-bearing repo discipline: sync-adjacent writes may only overwrite what still matches what sync wrote (`config.ts:43-92`). An override mode that beat hand edits would re-clobber a deliberate per-server exception on every sync forever — the defect class the whole stamp system exists to prevent.
- **override > source:** the point of override — "the source says these boxes have no proxy; I know better."
- **source > fill:** the owner's own definition — fill "only applies if the source didn't provide any data."
- **fill > unset:** trivially.

### 4.2 Composition step (per device, per field X)

Runs inside `computeSyncPlan` for every device. Two layers, cleanly separated:

**Layer 1 — cascade (per field):** `tmplX = winner(X)` per §3.2, where the candidate set for `authProfileId` additionally contains the **implicit source-level rule** — `source.authProfileId` (after AUTH 1/1b resolution, `syncEngine.ts:209-256`) read as a catch-all *fill* rule at specificity **−1**, i.e. below every explicit rule including an explicit catch-all. That is the "one rule mechanism, not two" reading of PR #53: the stored field is kept (§8.1), but the engine consumes it as nothing more than the least-specific rule, so a filter-bound auth assignment (an explicit rule) overrides it exactly like it overrides any broader rule.

**Layer 2 — mode vs source data (per field):**

```
srcX  = what the DEVICE/provider itself supplies for X this sync
        (endpoint-derived data — none of the five v1 fields have any; the slot
         exists for future fields like port, where endpoint.port is srcX)

desiredX =
  tmplX set, mode=override  → tmplX.value
  else srcX set             → srcX
  else tmplX set, mode=fill → tmplX.value
  else                      → none
```

With `srcX` empty for every v1 field, layer 2 currently reduces to `desiredX = tmplX.value` — but it is specified now because it is where `port` (§4.6) and any future endpoint-supplied field slot in, and because it fixes the meaning of "source" in the precedence order: *device data from the provider*, not the source-level profile (which is layer-1 material).

Consequence for `authProfileId`: when no explicit rule sets the field anywhere, the implicit rule is the only candidate and **PR #53's behavior falls out unchanged** — fill semantics gated by the AUTH 2 clauses, exactly today's retro-apply.

### 4.3 The write matrix (per field X; `cur` = record value, `stamp` = the per-field stamp — `origin.templated.X`, or `origin.syncedAuthProfileId` for the auth link) (rev)

| # | cur | stamp | desired | action | why |
|---|---|---|---|---|---|
| 1 | unset | absent | set | **write + stamp** | never configured — the retro-apply-eligible state (for `authProfileId`, additionally gated by the AUTH 2 six clauses, §4.4) |
| 2 | unset | present | any | **leave; carry stamp** | user *cleared* a sync-written value — per-server opt-out, verbatim from `syncEngine.ts:499-508` |
| 3 | == stamp | present | set, ≠ cur | **write + re-stamp** | still exactly what sync wrote → sync owns it; this is how template edits, rule flips (device attribute churn), and source-profile changes propagate |
| 4 | == stamp | present | set, == cur | no-op | counted `unchanged` (but see AUTH 3a: if only the stamp is new, it must still land in `updates`) |
| 5 | == stamp | present | **none** | **keep value + keep stamp** | release-keeps: rule stopped matching / template detached or deleted / field unset in template. Reverting fleet config on NetBox attribute churn is dangerous; keeping the stamp keeps the field sync-owned so a future rule can reclaim it (row 3) and the opt-out story (row 2) stays coherent. Mirrors the `syncedIpmiHost` "absent endpoint" row (plan §2.3 row 6) |
| 6 | ≠ stamp | present | any | **leave; carry stamp forward** | hand-edit; never laundered into the stamp (`config.ts:56-60`) |
| 7 | set | absent | any | **leave** | legacy / hand value; absent stamp must never mean "sync owns it" (plan §2.3 row 5's reasoning) |

Deliberately **rejected** for row 5: (a) *clear the stamp* — that converts the value to row 7 (hand-owned), permanently blocking any future template from touching it: a laundering in the opposite direction; (b) *revert the value* — there is nothing to revert `proxy` to (the source supplies none), and reverting on attribute churn takes working fleets off their jump hosts silently.

**Mode gate on row 3 (rev, A-M1 generalized):** row 1 admits both modes, but **row 3 fires only when the winning candidate is `override`-mode — or when `desired` is device-supplied data (layer-2 `srcX`, the `syncedIpmiHost` discipline, which keeps its own row-3 semantics untouched). A `fill`-mode winner in row-3 position LEAVES the value.** Fill is write-once: it fills the never-configured state and then never rewrites anything — not even a value the sync itself wrote earlier. This is forced twice over: (i) for `authProfileId` it is the review-mandated conservative rule (a fill winner must never move a configured link — anything else contradicts the shipped AUTH 2 clauses, `syncEngine.ts:618-624`, and the documented contract that a source-profile change does not re-stamp already-linked servers, `inventory.ts:168-170`); (ii) for every field it is what the mode's own UI copy promises — "Fill writes this value only where the field isn't configured yet. Override also replaces values the source or an earlier sync supplied" (§7.1). Consequence stated plainly: **template edits propagate to existing servers only through override-mode fields** (and to future adds through both); a user who wants fleet-following values chooses override — that is the modes' real difference on the four fields with no source supply.

**Accepted ambiguity (m7):** the stamp records a value, not authorship, so a hand edit that happens to equal the stamp is indistinguishable from sync ownership — including a deliberate hand-*revert* to the stamped value, which silently re-enters sync ownership (row 3 will move it again later), and the tooltip will call it template-applied. This is inherent to value-stamps and is exactly the `syncedUsername` precedent's trade (`config.ts:43-61`); the alternative (authorship tracking per write) is the provenance machinery §3.4 rejects. Accepted — but the engine comment block MUST state it, or the first support case reads as a bug.

### 4.4 `authProfileId` specifics — one stamp, both mechanisms (rev)

- **Fill path** (the winning candidate — explicit rule or the implicit source-level rule — is fill-mode): the existing AUTH 2 block (`syncEngine.ts:617-632`) is kept clause-for-clause and parameterized on `desiredX` instead of `resolvedProfileId`. Its six clauses are: (1) a desired link actually resolved (`desiredX !== undefined` — the generalization of `resolvedProfileId !== undefined`, and yes, this IS the sixth clause: the other five are conditions on the record, this one on the plan), (2) link unset, (3) stamp unset, (4) `authType === "agent"`, (5) `!hasOwnKeyPath`, (6) username still as stamped. They are what make "never auth-configured since add" trustworthy, and a template fill must not be allowed to skip them (a bare row-1 check would re-credential servers whose *other* auth fields were hand-configured — exactly what the clauses exist to catch, `syncEngine.ts:528-565`).
- **THE CONSERVATIVE RULE (A-M1): a fill-mode winner never moves a configured link — sync-owned or not.** Clauses (2)+(3) already say exactly this; the point of restating it is that the cascade must not be read as weakening it: when the per-field winner *changes* (a narrower rule deleted, an attribute flips), the new winner being fill-mode gives it no more power than fill ever has — a link that is set stays where it is, even when `cur === stamp` (§4.3 mode gate). This preserves the shipped contract verbatim: "changing this field from one profile to another does NOT re-stamp already-linked servers" (`inventory.ts:168-170`).
- **Override path** (new, and the only mover of existing links): writes when the AUTH 2 clauses admit (never-configured state) **or** when `cur === stamp` and both are defined (a sync-owned link being moved by an explicitly forceful rule) — rows 1/3/4. A hand-moved link (`cur ≠ stamp`) and a hand-made link (`cur` set, stamp absent) are untouched even by override — rows 6/7.
- **Guards generalize:** the AUTH 1 cross-check ("the caller resolved the profile the plan is actually about", `syncEngine.ts:209-210`) and the AUTH 1b keyless-key refusal (`authProfileNeedsServerKeyPath`, `config.ts:569-572`; engine use at `syncEngine.ts:250-256`) run **per referenced profile** — the input widens from the single `authProfile` to an `authProfilesById` map covering every profile any rule's template references (resolution stays in the caller, cross-check stays in the engine, same reasoning as `ComputeSyncPlanInput`'s doc, `syncEngine.ts:15-31`). A template referencing a keyless key profile degrades exactly like a source referencing one: no stamp, plan warning naming the template.
- **AUTH 2b rollback DOES need a change (A-M2 — the first draft's "needs no change" claim was wrong).** `decideSourceAuthRollback(server, unusableProfileId)` takes a SINGLE unusable id (`syncEngine.ts:143-152`), computed only from the source-level profile (`:250-256`). A profile linked *by a rule template* that later loses its key file would never be rolled back — both rollback passes (`:685-696` mapped, `:834-859` unmapped) would be consulting the wrong id, leaving rule-linked fleets unable to connect with no repair. Fix: widen to `unusableProfileIds: Set<string>` — the keyless-key subset of {the source-level profile} ∪ {every auth profile referenced by any of this source's rule templates} — computed once where AUTH 1b runs today; `decideSourceAuthRollback` tests membership instead of equality; both passes consume the set unchanged otherwise (the stamp-scoped clauses `authProfileId === id && syncedAuthProfileId === id` generalize to "both name the same member of the set"). The warning composition (`:861-899`) is extended to name each unusable profile's *referrer* — the source, or the template(s) — so the repair instruction points at the right editor. Dedicated fixture in §10.
- **Opt-out and deletion sweeps come free:** because the stamp is `syncedAuthProfileId`, `NexusCore.removeAuthProfile`'s link+stamp clearing (`src/core/nexusCore.ts:316-341`) and the backup-import dangling sweep (`src/commands/configCommands.ts:1842-1875`) already handle template-written links correctly, unchanged. (The template-record sweep and its persist-order slot are §8.4/m11 — a separate, genuinely new bill.)

### 4.5 The requested scenario matrix (scenario × mode) (rev — fill column reworked per A-M1's conservative rule / §4.3 mode gate)

For a field with no source supply (`proxy`, the booleans). "T" = template value, "T′" = edited template value:

| scenario | fill | override |
|---|---|---|
| **fresh device** (add path) | record starts unset → write T + stamp (row 1) | same — write T + stamp (there is nothing to override yet) |
| **source-updated** (device renamed / IP changed, template untouched) | `afterOrigin` rebuild carries `templated` forward verbatim; `cur === stamp`, desired == cur → no-op (row 4). The rebuild forgetting the carry-forward is THE regression to test | same |
| **template edited** (T → T′) | **NOT rewritten** — fill is write-once (§4.3 mode gate); the edit reaches only future adds and servers still in the never-configured state. Users who want edits to follow the fleet choose override — this is the modes' real difference | `cur === stamp(T)`, desired T′ → write T′ + re-stamp (row 3) — **on the next sync of each attached source**, not immediately (§6.1) |
| **hand-edited** (user set X to H ≠ T) | `cur(H) ≠ stamp(T)` → leave, carry stamp (row 6); if user *cleared* X: row 2 opt-out, never re-filled | same — **override does not beat hand edits** |
| **template detached** (rule removed / template deleted / device stops matching filter) | desired none → keep value + stamp (row 5); a later re-attach can resume ownership only per the winner's mode (override: rows 3/4; fill: row 4 no-op at best) | same, and an override re-attach resumes full ownership (rows 3/4) |
| **device switches rules** (role changed in NetBox: template A → template B) | new winner is fill → **existing value stays** (mode gate); only never-configured fields take B's values | new winner is override → `cur === stamp(A-val)` rewritten to B-val + re-stamped (row 3); hand-edited fields stay (row 6) |
| **pre-existing value, template newly attached** (server had hand/legacy X before any template) | `cur` set, stamp absent → **leave** (row 7) | **leave** (row 7) — override beats *source*, not users; this row is where people will expect override to win, so both the editor hint and the plan preview pre-empt it (§7.1/§7.3, UX-M2) |

Cascade-specific scenarios (the owner's driving case and its churn variants; rows rewritten per A-M1):

| scenario | outcome |
|---|---|
| **broad device rule (proxy+auth) + narrower auth-only rule** | `authProfileId` desired from the narrow rule; `proxy` (and every other field the broad template sets) desired from the broad rule — both applied, stamped independently. *The* acceptance scenario |
| **later sync: winner of field B flips only** (narrow rule added/edited, or attribute change moves the device into its filter) | `desiredB` changes → **if the new winner is override-mode**, row 3 rewrites B where `curB === stampB`; **if fill-mode, a configured B stays put** (conservative rule). Field A untouched either way (row 4). A hand-edited B stays regardless (row 6) — rule churn never beats hands |
| **narrow override rule linked B, rule deleted, fall-back winner (explicit or implicit) is fill naming A** | **link stays B** — a fill winner never moves a configured link, sync-owned included (A-M1; the shipped "source changes don't re-stamp already-linked servers" contract, `inventory.ts:168-170`). B remains sync-owned (stamp kept), so a later *override* rule can still move it, and a user clear still opts out (row 2). Dedicated fixture in §10 |
| **narrow rule deleted, fall-back winner is override** | row 3 moves sync-owned B to the fall-back's value; hand-set links stay (rows 6/7) |
| **source-level profile set, explicit rule also sets the link** | explicit rule wins (implicit rule is specificity −1) → link written where rows 1 (both modes) / 3 (override only) admit |
| **explicit auth rule stops matching, source-level profile present** | cascade falls back to the implicit **fill** rule → configured links stay exactly where they are (conservative rule); only never-configured servers (AUTH 2 clauses) get the source's profile — bit-identical to today's retro-apply behavior after any rule churn |
| **user cleared a template-written link** | `authProfileId` unset vs `syncedAuthProfileId` naming one → row 2, never reattached by ANY rule at any mode or specificity — the opt-out outranks the whole cascade |

### 4.6 Why `port` is deferred (not refused)

`host`/`port` today follow "always taken from the device" with **no stamp** (`syncEngine.ts:421-424`). A template override on `port` requires moving `port` onto the stamped discipline (otherwise the very next sync writes the endpoint port back), i.e. changing the ownership model of an existing, shipped field — a semantics change with its own matrix and its own migration story for hand-edited ports that today get clobbered by design. Additionally, "fill" for port is unrepresentable against the NetBox provider as shipped: it emits `port: 22` explicitly (`netboxProvider.ts:443`), so "source didn't provide" never occurs without a provider change to leave `port` undefined. Both are solvable; neither should gate v1. The `fields` record slots `port?: TemplateField<number>` in whenever it is picked up.

---

## 5. Application engine placement

### 5.1 New pure module `src/services/inventory/templateApply.ts` (rev)

No `vscode` import (callable from `syncEngine`, unit-testable — same constraint as `profileTokens.ts`). Exports:

- `parseTemplateFilter(filter: string): ParsedFilter` — URLSearchParams → `Map<key, Set<value>>`, plus normalization for tie-break ordering.
- `filterSpecificity(parsed): number` — distinct-key count.
- `deviceMatchesFilter(device, parsed): boolean` — §2.3 semantics, `name` glob included.
- `selectFieldWinners(device, rules, implicitAuthRule, templatesById): { winners: Map<Field, {rule, tmplField}>, warnings: string[] }` — the per-field cascade (§3.2): candidacy per field, specificity, per-field tie-break + tie warning, the implicit source-level auth rule at specificity −1; a rule whose `templateId` resolves to nothing is skipped with a warning (AUTH 1's degrade-don't-abort posture). Also returns per-field provenance for the plan report (§3.4) — computed here, consumed by the preview, never persisted.
- `composeDesiredFields(winners, srcSupplies, ctx): DesiredFields` — §4.2 layer 2, including reference resolution failures (§5.3) which drop the field to "desired none" + warning.
- `applyTemplateMatrix(ownedServer | undefined, desired): { writes, stamps, unchangedStampOnly }` — §4.3 rows including the mode gate (fill write-once), shared by add and update paths.
- `computeUnusableProfileIds(source, rules, templatesById, authProfilesById): Set<string>` — the A-M2 widening: the keyless-key subset of the source-level profile plus every rule-template-referenced auth profile, consumed by both AUTH 2b rollback passes (§4.4).

### 5.2 Wiring into `computeSyncPlan` (`syncEngine.ts:191`) (rev)

- **Input widening** (`ComputeSyncPlanInput`, `:10-32`): `templatesById?: Map<string, DeviceTemplateProfile>`, `authProfilesById?: Map<string, AuthProfile>` (superset of today's single `authProfile`, which remains for the source-level slot; both resolved by the caller in `inventoryCommands.ts`'s fetch step, cross-checked by the engine).
- **Add path** (`:755-794`): after the base record literal is composed, `applyTemplateMatrix(undefined, desired)` merges its writes; the origin literal (`:787-793`) gains `templated: stamps` (only keys actually written — §1.3's presence semantics) and `syncedAuthProfileId` becomes the composed desired link rather than bare `resolvedProfileId`.
- **Update path** (`:416-736`): (i) `afterOrigin` (`:425-466`) carries `templated: ownedServer.origin?.templated` forward verbatim — the one-line load-bearing carry-forward; (ii) the AUTH 2 block is parameterized per §4.4; (iii) after it, `applyTemplateMatrix(ownedServer, desired)` applies the non-auth fields onto `after` + `after.origin.templated`; (iv) `changed` grows per §1.3.
- **AUTH 2b passes** (`:685-696`, `:834-859`): both consume the widened `unusableProfileIds` set (§4.4/A-M2) instead of the single source-derived id; the warning splice (`:861-899`) names each unusable profile's referrer (source vs template) so the repair points at the right editor.
- **Zero-match info (A-M4):** after the device loop, emit one plan info line per rule that matched no device this fetch (§2.3) — computed here because only the loop knows the per-rule match counts.
- **Unmapped-device pass** (`:834-859`) and **prunes**: otherwise untouched. A device the fetch couldn't map is not re-evaluated against rules (no attributes in hand to match with — deciding on stale attributes would be guessing); its stamps carry forward untouched, exactly like the AUTH 2b pass touches only the one field it exists for. Pruned servers are out of the active set by user policy (`syncEngine.ts:680-684`'s reasoning).
- **Mid-sync template drift:** `inventoryCommands.ts`'s existing pre-apply fast-fail (the `sourceConfigUnchanged` family) additionally compares each *referenced* template's `revision` captured at fetch time against the live record before apply; mismatch aborts with "template changed while syncing — run the sync again" (cheap, reuses the pattern; and even without it the system self-heals — a stale write is stamped, so the next sync's row 3 repairs it).

### 5.3 Structured/reference fields — what "override proxy" means

- **`proxy` is written atomically** as a whole `ProxyConfig` (`config.ts:36`) — never a per-member merge. A proxy is one routing decision; merging an `ssh` jump with a stored `socks5` host is nonsense. Equality (matrix and `changed`) via `proxyConfigsEqual`.
- **Jump host reference stability across syncs:** a template's `SshJumpProxy.jumpHostId` typically points at a bastion that itself came from sync — safe, because synced ids are deterministic UUIDv8 over `(sourceId, externalId)` (`src/services/inventory/deterministicId.ts:37-44`, whose doc explicitly names jump-host references as a stability consumer). The reference survives every re-sync; it dies only if the bastion is pruned under `delete` policy.
- **Sync-time reference validation, skip-and-warn** (the PR-A §2.4 posture: storing a value the runtime will refuse helps nobody): a `jumpHostId` that resolves to no live server, or an `authProfileId`/`ipmiAuthProfileId` naming no profile ⇒ that field's desired becomes none for this run + one plan warning naming the template. The device's other fields proceed.
- **Self-reference hard-skip:** the bastion itself will frequently match the same rule (`role=server` matches the jump host too). Writing it a proxy via itself must be skipped per-device (`proxy.jumpHostId === targetServer.id` → skip + warn). Mutual A→B/B→A chains are left to the existing connect-time circular-chain guard (`proxySshFactory`, plan §4.2 item 3) — sync cannot see future topology anyway.
- **Proxy passwords are NOT templatable.** `socks5`/`http` proxy passwords live per-server (`proxy-password-{serverId}`, `config.ts:25`), and a template carries no secrets (no vault section, no export surface, no fleet-wide secret duplication). v1: all three proxy types are structurally templatable; templates supplying `socks5`/`http` with a username get the existing per-connect password prompt behavior; the template editor hints that jump-host proxies are the fleet-friendly shape (and they are Ogun's actual case). See §11 open question 2.

---

## 6. Lifecycle

### 6.1 Template edited (rev)
Takes effect on the **next sync of each source whose rules reference it** — and only through **override-mode fields on existing servers** (row 3); fill-mode fields are write-once, so an edit reaches only future adds and still-never-configured fields (§4.3 mode gate). Hand-edits and opt-outs untouched either way. No immediate retro-push — consistent with how a source's auth-profile change behaves today (applies at sync), and it keeps every fleet mutation inside the plan-preview/consent machinery instead of inventing a second, previewless write path. Save toast (UX-S8): `Device template "Switch defaults" saved. Changes apply on each source's next sync.` with a **`Sync Affected Sources`** button that runs the sync (with its normal plan preview) for every source whose rules reference this template.

### 6.2 Template deleted (rev)
`NexusCore.removeDeviceTemplate(id)`: remove the record; clear every `templateRules` entry referencing it on every source (re-revision). **Applied values and stamps on servers are kept** (row 5: sync-owned, reclaimable). No server write at delete time at all — deletion is O(sources), not O(fleet). **Persist order (m11):** the `removeAuthProfile` in-memory-first + ordered-persist + rollback discipline (`nexusCore.ts:237-314`) applies with `saveDeviceTemplates` in the commit-gate position: capture previous sources → mutate maps → `saveDeviceTemplates` (deletionCommitted flips true here) → `saveInventorySources`; a rejection before the gate restores the captured sources in memory, a rejection after it keeps the clears (the "foreign save heals disk" argument holds identically). Emission in a `finally`, once.

### 6.3 Source detached from template (rule removed / select cleared)
Applied values kept, **stamps kept** — not released. Releasing (clearing) stamps would launder sync-written values into row 7 hand-owned, permanently fencing them off from any future template; keeping them costs nothing and preserves both the opt-out semantics and reclaimability. (If the owner wants an explicit "detach and release to hand-ownership" affordance, it is a deliberate command, not a side effect — §11 open question 1.)

### 6.4 Device stops matching (attribute churn) (rev)
Row 5 per field: value + stamp kept. Device starts matching a different rule: an **override-mode** winner rewrites still-owned fields to the new template (row 3); a fill-mode winner leaves configured fields alone (§4.3 mode gate). Both covered in the scenario matrix and the test fixtures.

---

## 7. UI (rev — UX review integrated; adopted copy is quoted verbatim)

**Progressive-disclosure ladder (UX-S11), the section's governing rule:** each surface teaches only its own level — the source form's select teaches "this source's servers get this template's settings"; the template editor teaches modes and the three invariants; the rules picker teaches specificity; the filter InputBox teaches filter syntax. Cascade vocabulary never appears above rung 3 (the rules picker). Every copy item below is placed on its rung.

**Terminology (UX-M6):** the feature is called a **device template** on first mention on every surface ("template" alone thereafter). The Auth Profiles settings-tree row's description changes from "reusable credential templates" to **"reusable SSH credentials"** so "template" means exactly one thing in the product.

### 7.1 Template CRUD and the tri-state editor (rev)
- Commands (UX-S9): **`New Device Template`** (`nexus.deviceTemplate.add`), **`Manage Device Templates`** (`nexus.deviceTemplate.manage`) — palette + a Settings-tree row beside Auth Profiles: icon `layers`, description **"Apply shared settings to servers synced from inventory"**. Editor built on the existing form framework — no new webview machinery.
- **Editor intro block** (UX-M1) — a `type: "html"` block at the top of the form stating the three invariants together, before any control:
  > *"A device template applies these settings to servers synced from inventory. Three rules always hold: **your own edits win** — a template never changes a value you set by hand; **clearing a template-applied value opts that server out** — it won't be re-applied; **changes apply on each source's next sync**, not immediately."*
- **Tri-state editor without a second server form:** each templatable field gets a companion mode select and shows its value control(s) only when the mode is not "Not set" — `visibleWhen` already supports value arrays (`{ field: "mode_proxy", value: ["fill", "override"] }`, `src/ui/formTypes.ts:1-6`, array usage precedent in `formDefinitions.ts:741`). Mode-select copy (UX-M1, verbatim):
  - Options: **`Not set`** / **`Fill — only where nothing is set`** / **`Override — replace source and sync values`**.
  - Shared hint: *"Fill writes this value only where the field isn't configured yet. Override also replaces values the source or an earlier sync supplied. Neither mode ever changes a value you set yourself — your own edits always win."*
  - Auth-profile field's hint: *"Fill links this profile only on servers whose SSH login was never configured by hand. Override also moves servers a sync previously linked — but never a link you chose yourself."*
  - Row-7 pre-emption (UX-M2), shown `visibleWhen` mode = override: *"Values a server already had before any template applied count as hand-configured and are kept. To replace those deliberately, use Apply Device Template to Folder."*
- **Value controls are the existing definition builders, with two required parameter extensions (UX-M4, m13):** `proxyFields(seed, servers, vw)` already threads visibility through every sub-field (`formDefinitions.ts:434-506`) but hardcodes `advanced: true` on every descriptor — reused here with a new `advanced?: boolean` override (else the template editor's main content hides behind the Advanced chevron). `authProfileSelectField` (`formDefinitions.ts:161-186`) hardcodes `autofill: true` and the key `"authProfileId"` (`:173-185`) — reuse needs an options extension (`{ key?, autofill?: false, advanced? }`); trivial, but it is a builder change, not drop-in reuse as the first draft claimed. Nothing on this form is profile-owned, so no lock/mirror machinery. The booleans are one checkbox each.
- The source form's template select carries a `Create new device template…` option via the established `__create__` convention (`formDefinitions.ts:170`).
- **Empty state** (UX-M5): the manage hub with zero templates shows a constructive placeholder — *"No device templates yet. A device template applies shared settings — proxy, auth profile, and more — to servers synced from inventory."* with a **`New Device Template`** button — never the legacy dead-end idiom ("No X configured. Create one first.", `authProfileCommands.ts:12-15`).
- All template/rule pickers adopt PR-F1's filterable select when it lands (shared control, per the roadmap's interplay note).

### 7.2 Source attachment and rules (rev)
- **v1 (PR-T1b):** one "Device Template" select on the source form (sibling to the Auth Profile select, `formDefinitions.ts:957-961`), reading/writing a single catch-all rule in `templateRules`. Hint (UX-S10, no cascade vocabulary — rung 1): *"Servers synced from this source also receive this device template's settings. Your own per-server edits always win."* The schema is the full rule array from day one — the select is just a view over `rules.length <= 1` — so multi-rule needs no migration.
- **Multi-rule fallback on the source form (UX-M3 — data-integrity, not polish):** when `templateRules.length > 1`, the select is REPLACED by a read-only `type: "html"` line — *"3 template rules are configured for this source. Manage them with **Edit Template Rules…**"* — and no template key is submitted with the form. A Save through a single-select over a multi-rule set would silently destroy the rule list; omitting the key from submission makes that impossible by construction.
- **PR-T2: "Edit Template Rules…"** (UX-S9 title) on the source context menu — a QuickPick-driven management flow (list → add/edit/remove), matching the codebase's sequential-prompt precedents rather than building a dynamic list editor into the static form framework.
  - Picker `placeHolder` = the one-breath cascade explanation (UX-S3, verbatim — rung 3, the one place cascade vocabulary lives): *"Most specific rule wins, per setting — a narrow rule overrides only the settings its template sets; broader rules still supply the rest. Order here doesn't matter."*
  - Rule items are three-slot (UX-S1): `label` = the filter (or *"(all devices)"*), `description` = `→ Switch defaults`, `detail` = `Specificity 2  •  Sets: Auth Profile, Proxy` — using a shared short-label map for field names (the same map §7.3's tooltip and the plan lines use, so "Proxy" is spelled one way everywhere). List sorted by specificity descending.
  - Filter entry (UX-S2): an InputBox whose prompt names the key vocabulary (*"Keys: role, site, location, rack, tenant, status, platform, tag, name — e.g. role=switch&site=syd"*) with **live Info-severity feedback** via the validation channel: *"Matches devices where role is 'switch' AND site is 'syd' — specificity 2"*; Warning severity for unknown keys (§2.2) and empty values (§2.3); the `name=*` zero-specificity note (§2.3).
  - **Implicit floor row is actionable** (UX-S4): when the source-level auth profile is set, the list's last row is `label` = *"(all devices — source default)"*, `description` = `→ auth profile "Datacenter root"`, `detail` = *"Fill • Overridden by any rule that sets Auth Profile"*; selecting it routes to `editSource` (where that field lives) instead of doing nothing.
  - **Zero-template empty state** (UX-M5): adding a rule when no template exists does not dead-end — the template pick step offers *"No device templates yet — create one now"*, runs the inline create, and **continues the rule flow** with the new template selected.
  - Save-time warnings: per-field overlap (§3.3) and unknown-key (§2.2), Warning severity, non-blocking except empty values (§2.3, blocking).

### 7.3 On-server indication and sync-report copy (rev)
- **Tree tooltip** (UX-S12): one summary line, not per-field prose — `Template-applied: Proxy, Multiplexing (your edits override)` — listing the fields where `cur` still equals its stamp, via the shared short-label map. Derived purely from record + origin (no rule re-evaluation at render time — always truthful about *ownership*, which is what the user needs when deciding whether an edit will stick; per §3.4 it deliberately does not name the rule).
- **Plan preview modal** (UX-S6/M2): gains the line *"12 servers will receive device template settings."* and, when row 7 skipped anything, *"3 servers kept hand-configured values — templates never overwrite your own edits."*
- **Show Warnings** carries: (a) per-field × per-rule provenance aggregation with **every affected server named** (§3.4); (b) the row-7 detail — counted heading, per-server field lists, and the trailing pointer *"To apply the template to these servers deliberately, use Apply Device Template to Folder."* (UX-M2); (c) the six specified warning strings — per-field tie (§3.3's example), dangling jump host, dangling auth profile, dangling template, self-proxy skip (§5.3), save-time overlap echo — plus the zero-match info (§2.3).
- **Edit Server form hint** (UX-S5): a field that is currently template-applied renders with the appended hint *"This value was applied by a device template. Changing it here makes your value permanent — future syncs and template edits will leave it alone."* Still no lock, no badge — template values are *editable by design* (editing one is precisely the hand-edit opt-out, row 6); locking would misstate the contract.

### 7.4 Manual bulk apply (subsumes backlog #2) (rev)
**`Apply Device Template`** (`nexus.deviceTemplate.applyToFolder`, UX-S9 title) on folder items, mirroring `nexus.authProfile.applyToFolder` (`authProfileCommands.ts:49-78`): pick template → consent modal → apply with progress.
- **Consent modal** (UX-S7): per-field dry-run lines — e.g. *"Proxy (Override): 14 servers will be set, 0 skipped"* / *"Auth Profile (Fill): 3 servers will be linked, 11 skipped (already configured)"* — closing with, verbatim: *"Values applied here count as your own edits — future inventory syncs will not change them."*
- **Zero-template state** (UX-M5): invoking with no templates shows a modal offering **`New Device Template`** instead of a dead-end warning.
- **Ownership rule for the manual path:** writes values, **never stamps**. A manual apply is a user decision; stamping it would let the next sync silently rewrite what the user just explicitly chose (and non-synced servers have no `origin` to stamp anyway — `ServerOrigin` requires `sourceId`/`externalId`, `config.ts:39-42`). Mode semantics degrade coherently without stamps: fill = write only where the field is unset; override = write over whatever is there (the user is the hand, so "hand-edit wins" is satisfied by the consent modal). Covers Ogun's folder-scoped bulk-proxy ask exactly, including sync-owned servers — after a manual apply their values differ from stamps, so syncs leave them alone (row 6).
- **Named workflow consequence (m8):** the tempting bootstrap — manually apply template T to a folder, *then* attach T as a rule on the source — leaves those servers permanently outside sync ownership: their values are bit-identical to the template but stampless (row 7), so future edits to T never reach them. The consent modal's closing line above is the honest statement of this; the constructive escape is an explicit **"adopt into sync ownership"** command (the consent mirror of §6.3's detach-and-release) — proposed as §11 open question 6, with this documented warning as the v1 posture.

### 7.5 Future options (UX NICE items — recorded, not committed)
N1 one-time first-sync tip after a template first applies; N2 session-scoped attribute-value picker assist in the filter InputBox (values seen in the last fetch); N3 rule count in the manage-sources hub row; N4 `$(warning)` prefix on tied rules in the rule list.

---

## 8. Migration & compatibility (rev — items 2–4 reworked per A-M5, A-M3, m11)

1. **PR #53 source-level auth profile — keep the STORED field, unify the SEMANTICS.** Per the owner's "one rule mechanism, not two" directive, a filter-bound auth assignment is an ordinary rule whose template sets only `authProfileId`; the stored `source.authProfileId` is consumed by the engine as the implicit specificity −1 catch-all fill rule (§4.2 layer 1) rather than as a separate mechanism. Keeping the stored field buys: zero regression risk in the AUTH machinery, zero old-build skew (an old build ignores `templateRules` and still honors `source.authProfileId` — fleets keep authenticating; a migrated-away field would silently strip fleet auth on old builds reading new state, the worst possible failure). The shared `syncedAuthProfileId` stamp prevents double ownership by construction. Cost accepted: two storage locations express one concept; mitigated in the UI by rendering the implicit rule as a read-only row in the rules list (§7.2). **v2 option** (post-soak): load-time normalization of `source.authProfileId` into a real catch-all rule (the `ensureInventorySourceRevision` pattern) — a storage unification done at the read boundary, never a stored-data big bang.
2. **Backups (rev, A-M5)** (`configCommands.ts`): new `deviceTemplates` bucket in the full-backup export capture (`:1177-1243` region) and import via the existing `importPreservingIds` machinery (`:1836`). Post-import dangling sweeps extend the existing block (`:1842-1875`): `templateRules[].templateId` naming no imported/existing template → rule removed; `template.fields.authProfileId` naming no profile → field cleared (both with re-revision). The **sanitized sharing export is a different story than the first draft claimed:** `sanitizeForSharing` (`configCommands.ts:687-726`; `SanitizedSnapshot` `:661-669`) exports **no inventory sources at all** — there is no rules bucket to remap into. Posture: **`deviceTemplates` are excluded from the share bundle exactly as inventory sources are** — templates are fleet-specific wiring (jump-host ids, auth-profile ids) with no meaning in a stranger's workspace, and excluding them makes the previously-specified id remap moot. One line in the share dialog's "what's not included" note.
3. **Old-build tolerance (rev, A-M3 — the first draft's "no skew" claim was WRONG):** templates live under a new storage key old builds never read, and `templateRules` round-trips untouched on the source record (whole-object storage, the `ipmiHost` precedent, `config.ts:116-119`). **But `origin.templated` does NOT survive an old build that syncs:** the old build's update path rebuilds `origin` from a literal of known members only (`syncEngine.ts:425-466` as of that build), so one sync run on an old build erases `templated` (and `syncedIpmiHost` — same hazard, now annotated in the roadmap) from every device it updates. Back on a new build, those fields read as row 7 — hand-owned, hands-off forever — **silently**. The damage is ownership-only: values survive; per-field recovery is a per-server clear (re-enters row 1) or the §11-proposed adopt command. Not preventable from the new side (an old build cannot carry forward a member it doesn't know). Transport for this skew is a **downgrade or a backup round-trip through an old build** — globalState is per-machine (no `setKeysForSync` in `src/`), so Settings Sync is not a vector. Documented as a known limitation in the PR description and docs.
4. **Deletion sweeps summary (rev, m11):** `removeDeviceTemplate` → rules cleared, server values/stamps kept, ordered persist per §6.2. `removeAuthProfile` grows one clause: clear `fields.authProfileId` from any template referencing the deleted profile (+ revision bump) — servers were already handled by the existing sweep via the shared stamp. **Its slot in the ordered persist chain (`nexusCore.ts:237-314`):** in-memory template clears are captured alongside `previousSources` BEFORE any save; persist order becomes `saveAuthProfiles` (deletionCommitted gate, unchanged) → `saveServers` → `saveInventorySources` → `saveDeviceTemplates`; the pre-commit catch restores captured templates together with captured sources (same rollback, one more map), and post-commit rejections keep the clears (the "next foreign save heals disk" property holds for the templates map identically). `removeServer`/prune-delete of a template-referenced jump host: no sweep (matches current behavior for server-held `proxy.jumpHostId`); the sync-time resolution warning (§5.3) is the honest surface.
5. **Rename:** templates are referenced by id everywhere; rename is a pure label change (auth-profile precedent).

---

## 9. Phased delivery & roadmap re-sequencing (rev — PR-T1 split per review m14)

| PR | Content | Size | Gate |
|---|---|---|---|
| **PR-A** | unchanged (`oob_ip` → `ipmiHost` + `syncedIpmiHost`) — ships first; its §2.3 matrix is the per-field stamp prototype the template matrix generalizes. Now carries the old-build ownership-loss note (A-M3, annotated in the roadmap) | S | none |
| **PR-B** | unchanged (`ipmiAuthProfileId` + token + env injection). **Roadmap open question 4 to Ogun is hereby answered by design:** NetBox auto-assignment of the IPMI profile = a template field (PR-T3), not a second source-level link — the question shrinks to "confirm template assignment is acceptable" | M | none |
| **PR-F1** | filterable/sorted select control only (backlog #4) — pulled forward because every template/rule/jump-host picker reuses it | S | none |
| **PR-T1** | **Engine core (not user-visible on its own):** model + storage + `templated` stamps + comparators/clone/merge/validation + `templateApply.ts` (**with `selectFieldWinners` per-field cascade as the only resolution algorithm — no single-winner interim to delete later**; degenerate until T2's filters) + `computeSyncPlan` wiring incl. the A-M2 `unusableProfileIds` widening + matrix/mode-gate + backup buckets/sweeps/ordered-persist + the full §10 engine test suite | M–L | none |
| **PR-T1b** | **The feature becomes usable:** tri-state template editor (incl. the builder parameter extensions — advanced override, `authProfileSelectField` options, UX-M4/m13) + source-form single select with multi-rule fallback (UX-M3) + manual folder apply with consent modal + empty states + command/settings-tree registration + tooltip summary line. **Backlog #2 is deleted from PR-F — subsumed here** | M | PR-T1 |
| **PR-T2** | Filters make the cascade user-visible: `InventoryDevice.attributes` (names+slugs, A-M4) + NetBox mapping + `attributeKeys` declaration + match/specificity/per-field-tie machinery + rules QuickPick flow (three-slot items, live filter feedback, actionable floor row) + tie/overlap/unknown-key/zero-match warnings + plan-report provenance lines (§3.4). Provider change shares `netboxProvider.ts` with backlog #3 (family preference) — land adjacent to PR-E. **The owner-scoped "v1" = T1+T1b+T2 all landed** | M | PR-T1b |
| **PR-C** | unchanged (`ipmiGatewayServerId` + jump-host SOL) | S–M | Ogun answers 1–3 |
| **PR-T3** | Template slots `ipmiAuthProfileId` + `ipmiGatewayServerId` (field descriptors + stamp members + editor rows; engine is already generic) — the fleet-scale assignment story for Phases 3–4 | S | PR-B and PR-C merged |
| **PR-E** | unchanged (saved import profiles #1 + family preference #3) | S–M | none |
| **PR-D** | unchanged (web console tunnel, on demand) | M | Ogun answer 5 (web console via jump host) |

Suggested order: **PR-A → PR-B ∥ PR-F1 → PR-T1 → PR-T1b → PR-T2 ∥ PR-E → PR-C → PR-T3**, PR-D on demand. Each PR bumps the patch version (CLAUDE.md release rules); implementation is delegated to an Opus sub-agent per the workflow rules.

**v1 cut** in one line: five templatable fields, per-field cascade resolution with the fill-write-once mode gate (engine-complete in T1, usable from T1b, filter-driven from T2), stamped sync application + unstamped manual folder apply, full backup/sweep hygiene — no port, no clear-mode, no persisted per-field provenance, no IPMI slots yet.

---

## 10. Test fixtures — each built to fail against the specific wrong implementation (CLAUDE.md testing convention) (rev)

Model tests (`test/unit/`, config model):
1. Two origins differing **only** in `templated.proxy` (identical everywhere else, including both having `templated` present — the vacuous-fixture trap is a fixture where one side simply lacks the record) → `serverOriginStampsEqual` false. *Kills: comparator never taught the member.*
2. `cloneServerConfig` on a server with `origin.templated.proxy`; mutate the clone's `templated.proxy.jumpHostId` → source unchanged. *Kills: one-level spread sharing the nested record.*
3. **(CORRECTED per m6 — the previous "concurrent edit touched `group`" version was itself vacuous: current and batchSnapshot agreed on the stamp, so comparator membership was unobservable.)** Merge-rollback: `current.origin` differs from `batchSnapshot.origin` **only** in `templated` (a concurrent system-initiated stamp clear landed while the batch's persist was in flight) → `mergeServerConfigFields` keeps **current's** origin (the concurrent change is real). A comparator missing the member calls the two origins equal and restores the pre-batch origin, silently resurrecting the cleared stamp — the observable divergence this fixture exists for. (Same correction applied to the roadmap's `syncedIpmiHost` twin fixture.)
3b. Boolean stamp presence (m12): origin with `templated.multiplexing: false` → treated as PRESENT by the matrix (matching override template's `true` with `cur === false === stamp` → rewritten; a truthiness-checking implementation reads the stamp as absent and row 7 blocks the write). *Kills: truthiness presence checks on boolean stamps.*

Engine matrix tests (`test/unit/`, syncEngine + templateApply) — one per row, each constructed so the wrong rule visibly diverges:
4. Row 1 fill: fresh unset field + matching fill template → written + stamped. *Kills: "fill never writes".*
5. Row 2: `cur` unset, `templated.proxy` present, template still matching → NOT re-applied. *Kills: missing opt-out clause.* (Fixture must stamp a **different** value than the template currently carries, or "re-apply" and "leave" produce identical records when values coincide.)
6. Row 3, override: `cur === stamp`, **override** template edited to a **different** proxy → rewritten + re-stamped. *Kills: "write once, never update" for override.*
6b. **Mode gate (A-M1 generalized):** row-3 position with a **FILL** winner — `cur === stamp`, fill template edited to a different proxy → **NOT rewritten**, value and stamp carried forward. *Kills: fill behaving like override — the mode copy's "only where nothing is set" promise made false.*
7. Row 5: `cur === stamp`, rule no longer matches (attribute changed in fixture tree) → value AND stamp carried forward. *Kills: "release clears/reverts".* Assert the stamp explicitly — value-only assertion passes against stamp-dropping.
8. Row 6: `cur ≠ stamp` (hand-edited proxy), override template supplies a third value → hand value kept, old stamp carried. *Kills: "override beats everything".*
9. Row 7: `cur` set, no stamp (legacy hand value), override template → untouched. *Kills: "absent stamp = sync owns".*
10. AUTH 3a shape: template value already equals record but stamp is new → pair lands in `updates`. *Kills: forgotten `changed` clause — the stamp would be computed and discarded forever.*
11. Carry-forward: device renamed (rebuilds `afterOrigin`) with `templated` stamps present, no template attached this run → stamps survive on `after.origin`. *Kills: the afterOrigin rebuild forgetting the one-line carry.*
12. Shared-stamp opt-out for auth: fill template sets `authProfileId`, previous sync stamped it, user cleared the link → not reattached by the template path. *Kills: a parallel template-stamp namespace that can't see the `syncedAuthProfileId` opt-out.*
13. Implicit-rule precedence: source-level profile A + explicit **fill-mode** auth rule naming profile B, never-configured server → B written (explicit rule beats the implicit one). Sibling: no explicit rule sets auth → A written via the six clauses, bit-identical to PR #53 today. *Kills: source-level profile outranking explicit rules, and any regression of legacy retro-apply.*
13b. **A-M1 fall-back fixture:** sync 1 — an **override** rule links profile B (stamped `syncedAuthProfileId: B`). Sync 2 — that rule deleted; the fall-back winner is a **fill** candidate naming A (run the fixture twice: explicit catch-all fill rule, and the implicit source-level rule) → **link stays B, stamp stays B**. Sibling: fall-back winner is an *override* rule naming A → link moves to A + re-stamped. *Kills: a fill winner moving a configured link — the §4.4/§4.5 contradiction the review caught, and the shipped `inventory.ts:168-170` contract with it.*
14. AUTH 2 clauses preserved under template fill: server with hand-edited username (≠ `syncedUsername`) + fill template auth link → NOT linked. *Kills: template fill bypassing the six clauses.*
14b. **A-M2 rollback-set fixture:** a rule template links profile B; a previous sync applied it (link + stamp = B); B then loses its key file (keyless key profile). Run with the source-level profile absent AND with it present-and-healthy. Next `computeSyncPlan` → the server is **unlinked** by AUTH 2b, and the warning names the *template* as the referrer. Include the unmapped-pass variant (device present in the tree but endpoint-less) so both passes (`syncEngine.ts:685-696`, `:834-859`) are covered. *Kills: `decideSourceAuthRollback` consulting only the source-derived id — rule-linked fleets left permanently unable to connect.*

Cascade / filter / specificity tests:
15. **The owner's acceptance scenario:** broad rule `role=switch` → template setting proxy+auth; narrower rule `role=switch&site=syd` → template setting ONLY auth. Matching device → `authProfileId` from the narrow rule AND `proxy` from the broad rule, both stamped. *Kills: winner-takes-all-fields (the narrow rule suppressing the broad template's proxy) — the exact wrong implementation this decision exists to prevent. Fixture must give the two templates different auth profiles, or narrow-wins and broad-wins read identically.*
16. Per-field winner flip: sync 1 as fixture 15; sync 2 adds an even narrower **override-mode** auth-only rule (or the device gains the matching tag) → auth rewritten (row 3), **proxy untouched and stamp unchanged**. *Kills: any implementation that re-decides or re-stamps all fields when one field's winner changes.*
17. One-field rule never suppresses: auth-only narrow rule matching, broad rule NOT matching (device outside its filter) → auth written, proxy NOT written. *Kills: a matched rule dragging its template's absent fields in as clears/defaults.*
18. Specificity, order-independence: device matching `role=switch` (spec 1) and `role=switch&site=syd` (spec 2), both templates setting proxy → spec-2 value wins; **rule array deliberately stored with spec-1 first**. *Kills: first-match-wins / order-sensitive resolution.*
19. Distinct-key counting: `role=switch&role=router` (one key, two values) vs `site=syd&tag=x` (two keys), both setting proxy → two-key rule wins. *Kills: counting conditions instead of distinct keys.*
20. Per-field tie: two spec-1 rules (`role=switch`, `site=syd`) both setting proxy to **different** values, rules stored in both orders across two runs → same winner both times (normalized-lex) + warning naming the field and both rules; a third field set by only one of them is applied without any tie warning. *Kills: stored-order tiebreak (silently order-semantic), silent ties, and ties reported per-rule instead of per-field.*
20b. Tie-warning suppression (m9d): the same two tied rules supplying an **identical** `{mode, value}` for the field → applied, and NO tie warning emitted. *Kills: warning on unobservable ties.*
20c. Parse cases (m9): (a) `Role=switch&role=router` → ONE key with two OR values, specificity 1 (*kills: case-sensitive key handling*); (b) a filter of only `name=*` → zero conditions, catch-all at specificity 0 (*kills: free rank boost from a match-everything glob*); (c) `role=` refused at rule save with the empty-value message (*kills: storable dead conditions*); (d) filter key `tag=core` matches attribute `tags` (*kills: the tag/tags key mismatch — m10*).
21. Attribute churn: sync 1 role=switch (**override** template A proxy), sync 2 role=server (**override** template B proxy), `cur === stampA` → rewritten to B; sibling fixture with hand-edited proxy → kept. *Kills: match-once-forever and filter-beats-hand respectively.*
22. Provider: NetBox row with role/site/tags → `attributes` populated with BOTH display names and slugs as set values (e.g. `site: ["Sydney", "syd"]`), empty strings omitted; `site=syd` (slug) AND `site=Sydney` (display name) both match the same device (*kills: single-vocabulary matching — A-M4's silent-no-op trap*); `tag=core` matches `tags` carrying core's name or slug.
22b. Zero-match info (A-M4): a rule matching no device in the fixture tree → exactly one plan info line naming the rule and source. *Kills: silent dead rules.*

Manual apply tests:
23. Manual folder apply of template T onto a **sync-owned** server whose rules would compute T′ → next `computeSyncPlan` leaves the manual value (no stamp was written, `cur ≠ stamp`). *Kills: manual path writing stamps.*
24. Manual fill onto a server with an existing proxy → skipped; override → written. *Kills: mode ignored on the manual path.*

Lifecycle/sweep tests:
25. `removeDeviceTemplate` with two sources referencing it → both rules cleared + re-revisioned, server values/stamps untouched; `removeAuthProfile` where a template's `fields.authProfileId` names it → field cleared, and a pre-commit save rejection restores the captured template map alongside the captured sources (m11). *Kills: missing sweeps, and a rollback that restores sources but leaves templates half-cleared. Fixture: the template must be the ONLY referrer, or the sweep's absence hides behind the server-side clear.*
26. Backup round-trip with a template + rule + `templated` stamps → all restored; import missing the template → rule swept, stamps kept. Sanitized share export → **no `deviceTemplates` bucket in the bundle** (A-M5 posture, mirroring the already-absent inventory sources). *Kills: forgotten export bucket / dangling sweep / templates leaking into the share bundle.*

---

## 11. Risks & open questions for the owner (rev)

**Risks**
1. **Matrix drift is the #1 risk**, same as PR-A risk 1: the `templated` discipline deliberately differs from `host`/`port` device-always-wins, and the fill/override mode gate (§4.3) is a second axis a future reader can "simplify" away; the engine comment block must state both or row 5/7 gets "fixed" into clobbering and fill gets "fixed" into override. The tests above are the enforcement.
2. **Row-7 expectation gap:** users will expect *override* to beat pre-existing hand values on first attach. It doesn't (by design). Pre-empted at both moments with the adopted UX-M2 copy — the editor's override-mode hint and the plan preview's "kept hand-configured values" line with the Show Warnings detail pointing at the folder apply — but still worth watching in feedback.
3. **`isValidServerOrigin` blast radius:** a malformed `templated` strips the whole origin (existing loud disposition) — costs sync ownership on corrupt rows. Accepted for consistency; the shape clause must be tolerant of absent members.
4. **Per-field tie-break opacity:** the lexicographic-normalized winner is deterministic but arbitrary; mitigated by the double warning (save-time overlap on shared fields + sync-time per-field tie naming, suppressed when outcomes are identical — m9d). Field-scoped ties should be rare in well-factored rule sets; if practice disagrees, an explicit per-rule priority number is the escape hatch — additive, no migration.
5. **Composition ordering bugs** between the AUTH 2 block and the template writes in the update path — the wiring must compute desired once (cascade → layer 2 → matrix + mode gate) and write once; two writers to `after.authProfileId` in sequence is the regression shape tests 13/13b/15 exist for.
6. **Provenance-at-rest gap:** with the cascade, "which rule set this field?" is answered precisely only in the sync report; the steady-state tooltip can say "template-applied" but not name the rule (§3.4 — device attributes aren't persisted, and stamping provenance rots against rule churn). If users demand field-level provenance at rest, the comparator-ignored informational stamp member is the designed extension point; watch for the ask rather than pre-paying.
7. **Value-stamp ambiguity (m7, accepted):** a hand edit that happens to equal the stamp — including a deliberate hand-*revert* to the stamped value — is indistinguishable from sync ownership: it silently re-enters ownership (a later override edit will move it again) and the tooltip calls it template-applied. Inherent to value-stamps, same trade `syncedUsername` made (`config.ts:43-61`); the engine comment block states it (§4.3) so the first support case reads as documented behavior, not a bug.
8. **Old-build ownership erasure (A-M3, accepted & documented):** one sync on a pre-template build strips `origin.templated` (and `syncedIpmiHost`) from every device it updates — values survive, ownership silently becomes row-7 hand-owned. Not preventable from the new side; §8.3 documents transport (downgrade / backup round-trip; NOT Settings Sync — globalState is per-machine) and recovery (per-server clear, or the adopt command below).

**Open questions**
1. **Release semantics** (§6.3/6.4): "keep value + keep stamp" when a rule stops matching — confirm, or do you want an explicit "detach and release" command as well?
2. **Proxy passwords** (§5.3): templates never carry secrets, so `socks5`/`http` template proxies rely on per-connect prompts. Acceptable, or should v1 restrict template proxies to SSH jump hosts outright?
3. **"Set to none":** should a template be able to *clear* a field (e.g. override `proxy` to "direct connection")? The model reserves `value: ProxyConfig | null` + a null-capable stamp for it, but v1 ships without clearing (it complicates stamp-presence semantics AND the cascade's "absent field = says nothing" fallthrough, §3.2, and no concrete ask exists).
4. **`port` templating** (§4.6): deferred — is there a live need (fleet SSH on a non-22 port) that should pull it forward?
5. **Provenance at rest** (risk 6): is report-time provenance enough for v1, or do you want per-field "set by rule X" surviving on the server record from the start?
6. **"Adopt into sync ownership" command (m8):** the manual-apply-then-attach-rule bootstrap leaves servers permanently outside sync ownership (values equal the template, but stampless — §7.4). Proposed: an explicit per-folder/per-server command that stamps currently-matching values into `templated` (the consent mirror of question 1's detach-and-release), which is also the recovery path for risk 8's old-build erasure. v1 ships the documented workflow warning only — do you want the command in v1.1?

*(The first draft's vocabulary question — display names vs slugs — is closed by design: both match, §2.2/A-M4.)*
