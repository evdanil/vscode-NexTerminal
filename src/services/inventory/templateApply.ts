import type { AuthProfile, ProxyConfig, ServerConfig, ServerOrigin } from "../../models/config";
import { authProfileNeedsServerKeyPath } from "../../models/config";
import type { InventoryDevice, InventorySourceConfig, TemplateRule } from "../../models/inventory";
import type { DeviceTemplateProfile, TemplateField, TemplateFieldMode } from "../../models/deviceTemplate";

/**
 * DEVICE TEMPLATE APPLICATION ENGINE (issue #48 PR-T1) — the pure, `vscode`-free
 * core that `computeSyncPlan` (syncEngine.ts) consumes to apply device
 * templates. Unit-testable in isolation, same constraint as `profileTokens.ts`.
 *
 * TWO LOAD-BEARING TRAPS a future reader must not "simplify" away (§11 risks):
 *
 *  1. MATRIX DRIFT (risk #1). The `templated` write matrix (`applyTemplateMatrix`)
 *     deliberately differs from `host`/`port`'s "device always wins": a value the
 *     sync did not write (rows 6/7) is NEVER overwritten, and a value the sync
 *     wrote and then lost a rule for (row 5) is KEPT, not reverted. On top of
 *     that there is a SECOND axis — the fill/override MODE GATE: row 3 (rewrite a
 *     still-sync-owned value) fires ONLY for an override-mode winner. `fill` is
 *     WRITE-ONCE — it fills a never-configured field and then never rewrites
 *     anything, not even a value the sync itself wrote earlier. State both or
 *     row 5/7 gets "fixed" into clobbering and fill gets "fixed" into override.
 *
 *  2. VALUE-STAMP AMBIGUITY (m7). A stamp records a VALUE, not authorship, so a
 *     hand edit that happens to equal the stamp — including a deliberate
 *     hand-revert to the stamped value — reads as sync-owned and a later override
 *     edit will move it. Inherent to value-stamps, the same trade `syncedUsername`
 *     makes. Accepted; stated so the first support case reads as documented
 *     behaviour rather than a bug.
 *
 * PER-PROFILE vs PER-TARGET (§4.4). Auth handling has two writes facing two
 * different populations: STAMPING a new never-configured link (fill / add-path /
 * row 1) is gated PER PROFILE (its targets provably bring no key of their own,
 * so a keyless key profile is refused wholesale — `authFillEligible` with the
 * keyless id already dropped); MOVING an existing sync-owned link (override rows
 * 3/4) is gated PER TARGET (`authLinkUsableForTarget`), because an existing
 * server can carry its own `keyPath`. `authFillEligible` and
 * `authLinkUsableForTarget` are two predicates ON PURPOSE — merging them
 * recreates the over-strict refusal a prior review round caught.
 */

/** The five v1 templatable fields; the four non-auth ones stamp `origin.templated`. */
export type TemplatableField = "proxy" | "authProfileId" | "multiplexing" | "legacyAlgorithms" | "logSession";

/**
 * §7.3 / §7.4 — the ONE short-label map for templatable field display names,
 * reused by the manual-apply consent modal, the tree tooltip's "Template-applied:"
 * line, and (from PR-T2) the rules picker's `Sets:` detail, so a field is spelled
 * one way everywhere ("Proxy", never also "SSH proxy"). Pure, so tests and the
 * vscode-land consumers share the same table.
 */
export const TEMPLATE_FIELD_SHORT_LABELS: Record<TemplatableField, string> = {
  proxy: "Proxy",
  authProfileId: "Auth Profile",
  multiplexing: "Multiplexing",
  legacyAlgorithms: "Legacy Algorithms",
  logSession: "Session Logging"
};

/** The four non-auth stamp fields, in the order the tooltip lists them. */
const NON_AUTH_TEMPLATABLE_FIELDS = ["proxy", "multiplexing", "legacyAlgorithms", "logSession"] as const;

/**
 * §7.3 (UX-S12) — the non-auth templatable fields a server is CURRENTLY carrying
 * a template value for, i.e. where the record's value still equals the stamp the
 * sync wrote (`cur === origin.templated.X`). Derived purely from record + origin,
 * with NO rule re-evaluation (device attributes are not persisted, §3.4), so it
 * is always truthful about OWNERSHIP even though it cannot name the rule. A field
 * the user has since hand-edited (`cur !== stamp`, row 6) or cleared (row 2) drops
 * out, which is exactly the "your edits override" signal the tooltip needs. Boolean
 * stamps are compared by `=== ` (a PRESENT `false` stamp is a real stamp, m12);
 * proxy by structural equality. `authProfileId` is deliberately NOT included — the
 * SSH auth link already surfaces on its own `[auth: …]` tooltip suffix.
 */
export function templateAppliedFields(server: Pick<ServerConfig, "proxy" | "multiplexing" | "legacyAlgorithms" | "logSession" | "origin">): TemplatableField[] {
  const stamps = server.origin?.templated;
  if (stamps === undefined) {
    return [];
  }
  const applied: TemplatableField[] = [];
  for (const field of NON_AUTH_TEMPLATABLE_FIELDS) {
    if (field === "proxy") {
      if (stamps.proxy !== undefined && proxyEqual(server.proxy, stamps.proxy)) {
        applied.push("proxy");
      }
    } else if (stamps[field] !== undefined && server[field] === stamps[field]) {
      applied.push(field);
    }
  }
  return applied;
}

/**
 * A rule's `filter` is a catch-all (matches every device) when it is absent,
 * empty, or whitespace-only. The cheap PR-T1 predicate: the full parser +
 * matcher (`parseTemplateFilter` / `deviceMatchesFilter`) is PR-T2, so a T1
 * engine only ever asks "is this a real filter it cannot evaluate?" and FAILS
 * CLOSED on one (§7.2 rev11). A build that cannot EVALUATE a filter has no
 * business INTERPRETING one, so this is deliberately not a partial parser.
 */
export function isCatchAllFilter(filter: string | undefined): boolean {
  return filter === undefined || filter.trim() === "";
}

/**
 * DEVICE TEMPLATES (issue #48 PR-T2, §2.3) — a filter parsed into the normalized
 * structure the matcher, specificity, and per-field tie-break all consume.
 *
 * `conditions`: attribute key → OR-set of values. Keys are case-folded to
 * lowercase (m9a) and `tag` is aliased to `tags` (m10, declared ONCE here);
 * values are trimmed + lowercased (§2.3 case-insensitive comparison). A repeated
 * key OR-broadens (`role=switch&role=router`); distinct keys AND. The reserved
 * `name` key's values are `*` globs, not attribute values.
 */
export interface ParsedFilter {
  conditions: Map<string, Set<string>>;
  /** Distinct-key count (§3.1): repeated values on one key count once; a bare `name=*` counts 0 (m9b). */
  specificity: number;
  /** Tie-break key (§3.3): keys sorted, values sorted within key, lowercased. Empty for a catch-all. */
  normalized: string;
  /** Keys carrying an empty value (`role=`) — a dead condition refused at save (§2.3 m9c). */
  emptyValueKeys: string[];
}

/** A `name` OR-set matches every device when one of its globs is a bare `*` (m9b). */
function nameMatchesEverything(values: Set<string>): boolean {
  for (const v of values) {
    if (v === "*") {
      return true;
    }
  }
  return false;
}

/**
 * §2.3 — parse a rule filter into {@link ParsedFilter}. `new URLSearchParams`,
 * case-fold keys (m9a), alias `tag`→`tags` (m10), OR within a repeated key, AND
 * across distinct keys. Empty-valued conditions are surfaced in `emptyValueKeys`
 * for the save layer to reject rather than silently stored. A bare `name=*` (or
 * any filter with zero effective conditions) is catch-all / zero specificity.
 */
export function parseTemplateFilter(filter: string | undefined): ParsedFilter {
  const conditions = new Map<string, Set<string>>();
  const emptyValueKeys = new Set<string>();
  const params = new URLSearchParams(filter ?? "");
  for (const [rawKey, rawValue] of params) {
    let key = rawKey.trim().toLowerCase(); // m9a — case-fold BEFORE distinct-key counting / lookup
    if (key === "") {
      continue;
    }
    if (key === "tag") {
      key = "tags"; // m10 — the filter key is `tag`; the attribute is `tags`. Aliased once, here.
    }
    const value = rawValue.trim().toLowerCase(); // §2.3 — comparison is case-insensitive + trimmed
    if (value === "") {
      emptyValueKeys.add(key); // §2.3 m9c — a condition that can never match; refused at save
      continue;
    }
    let set = conditions.get(key);
    if (set === undefined) {
      set = new Set<string>();
      conditions.set(key, set);
    }
    set.add(value);
  }
  let specificity = 0;
  for (const [key, values] of conditions) {
    if (key === "name" && nameMatchesEverything(values)) {
      continue; // m9b — a match-everything glob constrains nothing
    }
    specificity++;
  }
  const normalized = [...conditions.keys()]
    .sort()
    .map((k) => `${k}=${[...conditions.get(k)!].sort().join(",")}`)
    .join("&");
  return { conditions, specificity, normalized, emptyValueKeys: [...emptyValueKeys] };
}

/** Distinct-key count of a filter string — §3.1 specificity, via {@link parseTemplateFilter}. */
export function filterSpecificity(filter: string | undefined): number {
  return parseTemplateFilter(filter).specificity;
}

/**
 * §2.2/§2.3 — a `name` glob: an ANCHORED regex built by escaping everything
 * except `*` (positive construction — no user regex reaches `RegExp`). Matching
 * is case-insensitive to match the value comparison rule.
 */
function nameGlobMatches(name: string, glob: string): boolean {
  const pattern = "^" + glob.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : "\\" + c)) + "$";
  return new RegExp(pattern, "i").test(name);
}

/**
 * §2.3 — does a device match a parsed filter? AND across distinct keys, OR within
 * a key. The reserved `name` key globs `device.name`; every other key looks up
 * `device.attributes[key]` (string OR string[], set-valued matches if ANY element
 * matches — which gives name-OR-slug for free, §2.2). A key the device has no
 * attribute for fails the condition (the rule does not match). An empty-valued
 * condition can never match, so it fails closed. A filter with zero conditions
 * (catch-all, or a bare `name=*`) matches every device.
 */
export function deviceMatchesFilter(device: Pick<InventoryDevice, "name" | "attributes">, parsed: ParsedFilter): boolean {
  if (parsed.emptyValueKeys.length > 0) {
    return false; // §2.3 m9c — a dead condition slipped past save (import/rollback); never match
  }
  for (const [key, values] of parsed.conditions) {
    if (key === "name") {
      if (![...values].some((glob) => nameGlobMatches(device.name, glob))) {
        return false;
      }
      continue;
    }
    const attr = device.attributes?.[key];
    if (attr === undefined) {
      return false; // §2.3 — no attribute for this key ⇒ condition fails
    }
    const attrValues = (Array.isArray(attr) ? attr : [attr]).map((a) => a.trim().toLowerCase());
    if (![...values].some((v) => attrValues.includes(v))) {
      return false;
    }
  }
  return true;
}

/** A filter's human label for warnings/UI: the raw filter, or "(all devices)" for a catch-all. */
export function filterLabel(filter: string | undefined): string {
  return filter !== undefined && filter.trim() !== "" ? filter : "(all devices)";
}

/**
 * §7.2 (UX-S2) — the live Info-severity description of a filter for the rule
 * InputBox: "role is 'switch' AND site is 'syd'". OR within a key reads "or".
 * Keys sorted for determinism. Empty for a catch-all / zero-condition filter.
 */
export function describeFilterConditions(parsed: ParsedFilter): string {
  const parts: string[] = [];
  for (const key of [...parsed.conditions.keys()].sort()) {
    const values = [...parsed.conditions.get(key)!].sort();
    parts.push(`${key} is ${values.map((v) => `'${v}'`).join(" or ")}`);
  }
  return parts.join(" AND ");
}

/**
 * §2.2 — the filter keys used by a filter that are NOT in the provider's declared
 * `attributeKeys` (case-insensitive). `name` is always known (provider-agnostic).
 * A provider that declares no list yields no unknown keys (nothing to check).
 */
export function unknownFilterKeys(parsed: ParsedFilter, attributeKeys: readonly string[] | undefined): string[] {
  if (attributeKeys === undefined) {
    return [];
  }
  const known = new Set(attributeKeys.map((k) => (k.trim().toLowerCase() === "tag" ? "tags" : k.trim().toLowerCase())));
  known.add("name");
  const unknown: string[] = [];
  for (const key of parsed.conditions.keys()) {
    if (!known.has(key)) {
      unknown.push(key);
    }
  }
  return unknown;
}

/** The per-field winners of the cascade — the {mode, value} each field resolves to. */
export interface CascadeWinners {
  proxy?: TemplateField<ProxyConfig>;
  authProfileId?: TemplateField<string>;
  multiplexing?: TemplateField<boolean>;
  legacyAlgorithms?: TemplateField<boolean>;
  logSession?: TemplateField<boolean>;
}

/** §3.4 — where one field's applied value came from, for the plan-report provenance lines. */
export interface FieldProvenance {
  templateName: string;
  /** The winning rule's raw filter; undefined for a catch-all rule or the implicit source rule. */
  ruleFilter?: string;
  /** True when the value came from the implicit source-level auth rule (§4.2), not an explicit rule. */
  implicit: boolean;
}

export interface CascadeResult {
  winners: CascadeWinners;
  /** True when `winners.authProfileId` came from the IMPLICIT source-level rule (§4.2), not an explicit rule. */
  authFromImplicit: boolean;
  /** Per-field tie warnings (§3.3.2), device-named — the AUTHORITATIVE tie signal. */
  warnings: string[];
  /**
   * The NAME of the template that supplied `winners.proxy`, so the §5.3 proxy
   * reference-validation warnings (dangling jump host / self-reference) can name
   * the template the way the design's house style requires. Undefined when no
   * rule set `proxy`. Stamps record VALUES, not writers (§1.3), so this is used
   * ONLY for the plan warning — it never reaches storage.
   */
  proxyTemplateName?: string;
  /** Rule ids whose filter MATCHED this device (candidates) — for the zero-match info (§2.3). */
  matchedRuleIds: string[];
  /** §3.4 — per applied field, which rule/template supplied it. Report-only, never persisted. */
  provenance: Partial<Record<TemplatableField, FieldProvenance>>;
}

/** A rule with its template resolved and filter pre-parsed — device-independent, so prepared ONCE. */
export interface PreparedRule {
  rule: TemplateRule;
  template: DeviceTemplateProfile;
  parsed: ParsedFilter;
  /** `isCatchAllFilter(rule.filter)` — a catch-all is a candidate for EVERY device without a match test. */
  isCatchAll: boolean;
}

export interface PrepareRulesResult {
  prepared: PreparedRule[];
  /** Dangling-template warnings (once per rule, device-independent). */
  warnings: string[];
}

/**
 * §5.1 — resolve each rule's template and pre-parse its filter, ONCE per source
 * (device-independent). A rule whose `templateId` resolves to nothing is dropped
 * with a warning (AUTH 1's degrade-don't-abort posture). PR-T2: there is NO
 * filtered-rule fail-closed skip here — the matcher exists now, so filtered rules
 * are kept and evaluated per device by {@link selectFieldWinners}. (The skip
 * `selectFieldWinners` used to carry, §7.2 rev11, has LIFTED.)
 */
export function prepareTemplateRules(
  rules: readonly TemplateRule[],
  templatesById: Map<string, DeviceTemplateProfile> | undefined,
  sourceName: string
): PrepareRulesResult {
  const prepared: PreparedRule[] = [];
  const warnings: string[] = [];
  for (const rule of rules) {
    const template = templatesById?.get(rule.templateId);
    if (template === undefined) {
      warnings.push(`A device template rule on "${sourceName}" references a template that no longer exists — the rule was skipped.`);
      continue;
    }
    prepared.push({ rule, template, parsed: parseTemplateFilter(rule.filter), isCatchAll: isCatchAllFilter(rule.filter) });
  }
  return { prepared, warnings };
}

/**
 * The per-field cascade (§3.2) for ONE device — the ONLY resolution algorithm.
 *
 * PR-T2: candidacy is PER DEVICE. A rule is a candidate iff it is a catch-all OR
 * its filter matches this device (`deviceMatchesFilter`). For each templatable
 * field INDEPENDENTLY, among the candidates whose template SETS that field, the
 * winner is the highest specificity (§3.1); a per-field TIE (equal specificity,
 * DISTINCT filters) is broken by normalized-filter lexicographic order then rule
 * `id` (§3.3), and a warning fires unless every tied candidate supplies an
 * identical `{mode, value}` for the field (m9d — an unobservable tie). The
 * implicit source-level auth rule enters at specificity −1, below every explicit
 * rule (§4.2). Per-field independence means a one-field rule never suppresses the
 * other fields a broader rule sets — the owner's driving scenario.
 *
 * Stamps record VALUES, never which rule wrote them (§1.3), so nothing below the
 * composition step sees which rule won a field — the matrix rides the cascade
 * untouched. `provenance` and `matchedRuleIds` are report-only, never persisted.
 */
export function selectFieldWinners(
  device: Pick<InventoryDevice, "name" | "attributes">,
  prepared: readonly PreparedRule[],
  implicitAuthProfileId: string | undefined
): CascadeResult {
  const warnings: string[] = [];
  const matchedRuleIds: string[] = [];
  const candidates: PreparedRule[] = [];
  for (const p of prepared) {
    if (p.isCatchAll || deviceMatchesFilter(device, p.parsed)) {
      candidates.push(p);
      matchedRuleIds.push(p.rule.id);
    }
  }

  const winners: CascadeWinners = {};
  const provenance: Partial<Record<TemplatableField, FieldProvenance>> = {};

  const resolveField = <T>(
    fieldKey: Exclude<TemplatableField, "authProfileId"> | "authProfileId",
    pick: (t: DeviceTemplateProfile) => TemplateField<T> | undefined,
    valuesEqual: (a: T, b: T) => boolean
  ): { field: TemplateField<T>; templateName: string } | undefined => {
    const setters = candidates.filter((c) => pick(c.template) !== undefined);
    if (setters.length === 0) {
      return undefined;
    }
    // Winner: highest specificity, then normalized-filter lex, then rule id — all
    // order-free and stable across reorder / backup round-trips (§3.3).
    const sorted = [...setters].sort((a, b) => {
      if (a.parsed.specificity !== b.parsed.specificity) {
        return b.parsed.specificity - a.parsed.specificity;
      }
      if (a.parsed.normalized !== b.parsed.normalized) {
        return a.parsed.normalized < b.parsed.normalized ? -1 : 1;
      }
      return a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0;
    });
    const winner = sorted[0];
    const winField = pick(winner.template)!;
    // §3.3.2 tie warning: among the SAME top-specificity setters with a DISTINCT
    // normalized filter, if any disagrees on {mode,value} the tie is observable.
    // m9d suppresses it when every tied candidate supplies an identical outcome
    // (a same-filter duplicate — identical `normalized` — is the redundant case
    // the save-time warning covers, and is deliberately excluded here).
    const disagreeing = sorted.find(
      (c) =>
        c !== winner &&
        c.parsed.specificity === winner.parsed.specificity &&
        c.parsed.normalized !== winner.parsed.normalized &&
        !(pick(c.template)!.mode === winField.mode && valuesEqual(pick(c.template)!.value, winField.value))
    );
    if (disagreeing !== undefined) {
      warnings.push(
        `Device "${device.name}": rules "${filterLabel(winner.rule.filter)}" and "${filterLabel(disagreeing.rule.filter)}" tie for ${TEMPLATE_FIELD_SHORT_LABELS[fieldKey]}; applied "${filterLabel(winner.rule.filter)}" (rule order is not used — make one rule more specific to choose deliberately).`
      );
    }
    provenance[fieldKey] = { templateName: winner.template.name, ruleFilter: winner.rule.filter, implicit: false };
    return { field: winField, templateName: winner.template.name };
  };

  const proxyWin = resolveField<ProxyConfig>("proxy", (t) => t.fields.proxy, proxyEqual);
  if (proxyWin !== undefined) {
    winners.proxy = proxyWin.field;
  }
  const proxyTemplateName = proxyWin?.templateName;

  const muxWin = resolveField<boolean>("multiplexing", (t) => t.fields.multiplexing, (a, b) => a === b);
  if (muxWin !== undefined) {
    winners.multiplexing = muxWin.field;
  }
  const legacyWin = resolveField<boolean>("legacyAlgorithms", (t) => t.fields.legacyAlgorithms, (a, b) => a === b);
  if (legacyWin !== undefined) {
    winners.legacyAlgorithms = legacyWin.field;
  }
  const logWin = resolveField<boolean>("logSession", (t) => t.fields.logSession, (a, b) => a === b);
  if (logWin !== undefined) {
    winners.logSession = logWin.field;
  }

  const authWin = resolveField<string>("authProfileId", (t) => t.fields.authProfileId, (a, b) => a === b);
  let authFromImplicit = false;
  if (authWin !== undefined) {
    winners.authProfileId = authWin.field;
  } else if (implicitAuthProfileId !== undefined) {
    // The implicit source-level rule (§4.2): a catch-all FILL rule at
    // specificity −1, below every explicit rule. When no explicit rule sets
    // auth this is the only candidate, and PR #53's behaviour falls out
    // unchanged — fill semantics gated by the six AUTH 2 clauses.
    winners.authProfileId = { mode: "fill", value: implicitAuthProfileId };
    authFromImplicit = true;
    // Deliberately NO provenance entry for the implicit source rule: §3.4
    // provenance is a device-TEMPLATE report ("which rule set this?"), and the
    // implicit source-level auth link is the pre-template PR #53 behaviour, not a
    // template rule — surfacing it would add a line to every source that merely
    // carries a source auth profile and no templates at all.
  }
  return { winners, authFromImplicit, warnings, proxyTemplateName, matchedRuleIds, provenance };
}

/** One non-auth field's composed desired value + the mode that governs its matrix write. */
export interface DesiredField<T> {
  value: T;
  mode: TemplateFieldMode;
}

export interface DesiredNonAuthFields {
  proxy?: DesiredField<ProxyConfig>;
  multiplexing?: DesiredField<boolean>;
  legacyAlgorithms?: DesiredField<boolean>;
  logSession?: DesiredField<boolean>;
}

/**
 * §5.3 proxy reference-validation context. `hasServer` resolves an SSH
 * jump-host reference against the set of servers that will be live after this
 * sync (current servers ∪ this fetch's deterministic adds); a `jumpHostId`
 * outside it is DANGLING. `proxyTemplateName`/`sourceName` name the disposition
 * in the house style. Absent (legacy callers) ⇒ no proxy validation, the
 * shipped behaviour before this guard.
 */
export interface ProxyReferenceContext {
  hasServer: (jumpHostId: string) => boolean;
  proxyTemplateName: string | undefined;
  sourceName: string;
}

export interface ComposedDesiredFields {
  desired: DesiredNonAuthFields;
  /** §5.3 dangling-jump-host skip warnings (device-independent — emitted once). */
  warnings: string[];
}

/**
 * §4.2 layer 2 (mode vs source data), for the four non-auth v1 fields. `srcX`
 * (device/provider-supplied data) is EMPTY for all of them, so this reduces to
 * `desiredX = tmplX.value` carrying `tmplX.mode` for the matrix's row-3 gate.
 * Written explicitly as the layer anyway, because it is where `port` (§4.6) and
 * any future endpoint-supplied field slot in — `desiredPort` would be
 * `override → tmpl, else endpoint.port, else fill → tmpl`.
 *
 * §5.3 REFERENCE VALIDATION (the PR-A §2.4 skip-and-warn posture — storing a
 * value the runtime will refuse helps nobody). A desired SSH-jump proxy whose
 * `jumpHostId` resolves to no live server is DROPPED to "desired none" here plus
 * one plan warning. "Desired none" means the field is NOT A CANDIDATE this run —
 * `desired.proxy` is left UNSET so the matrix carries an existing sync-owned
 * proxy forward (row 5); it never becomes a written `undefined`. The
 * SELF-reference check (`jumpHostId === targetServerId`) is per-device and lives
 * in `applyTemplateMatrix`, because the dangling check is device-independent
 * (resolved once, mirroring the dangling-auth-profile skip) while a
 * self-reference can only be judged against the specific device being written.
 * A resolvable, non-self reference — and any `socks5`/`http` proxy, which carry
 * no server reference — passes through unchanged.
 */
export function composeDesiredFields(winners: CascadeWinners, proxyRef?: ProxyReferenceContext): ComposedDesiredFields {
  const desired: DesiredNonAuthFields = {};
  const warnings: string[] = [];
  if (winners.proxy !== undefined) {
    const value = winners.proxy.value;
    if (value.type === "ssh" && proxyRef !== undefined && !proxyRef.hasServer(value.jumpHostId)) {
      warnings.push(
        `Device template "${proxyRef.proxyTemplateName ?? "?"}" on "${proxyRef.sourceName}" sets a jump-host proxy whose jump host no longer exists — the proxy field was skipped.`
      );
      // desired none — leave `desired.proxy` unset (NOT written undefined).
    } else {
      desired.proxy = { value, mode: winners.proxy.mode };
    }
  }
  if (winners.multiplexing !== undefined) {
    desired.multiplexing = { value: winners.multiplexing.value, mode: winners.multiplexing.mode };
  }
  if (winners.legacyAlgorithms !== undefined) {
    desired.legacyAlgorithms = { value: winners.legacyAlgorithms.value, mode: winners.legacyAlgorithms.mode };
  }
  if (winners.logSession !== undefined) {
    desired.logSession = { value: winners.logSession.value, mode: winners.logSession.mode };
  }
  return { desired, warnings };
}

function proxyEqual(a: ProxyConfig | undefined, b: ProxyConfig | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === "ssh") {
    return b.type === "ssh" && a.jumpHostId === b.jumpHostId;
  }
  return (b.type === "socks5" || b.type === "http") && a.host === b.host && a.port === b.port && a.username === b.username;
}

/**
 * The §4.3 write matrix for ONE non-auth field. Returns whether to WRITE the
 * desired value (and re-stamp); a `false` LEAVES the value and carries its stamp
 * forward. The mode gate lives in the last branch: a still-sync-owned value
 * (`cur === stamp`) whose desired differs is rewritten (row 3) only for an
 * override winner — a fill winner leaves it (write-once).
 *
 *  row 1 — cur unset, stamp absent           → write   (never configured)
 *  row 2 — cur unset, stamp present          → LEAVE   (opt-out: user cleared it)
 *  row 7 — cur set,  stamp absent            → LEAVE   (legacy/hand value)
 *  row 6 — cur ≠ stamp, stamp present        → LEAVE   (hand edit)
 *  row 4 — cur === stamp, desired === cur    → LEAVE   (no-op; stamp already right)
 *  row 3 — cur === stamp, desired ≠ cur      → write iff override, else LEAVE
 */
function matrixWrites<T>(
  curSet: boolean,
  cur: T | undefined,
  stampPresent: boolean,
  stamp: T | undefined,
  desired: DesiredField<T>,
  equal: (a: T | undefined, b: T | undefined) => boolean
): boolean {
  if (!curSet) {
    return !stampPresent; // row 1 writes, row 2 opt-out leaves
  }
  if (!stampPresent) {
    return false; // row 7
  }
  if (!equal(cur, stamp)) {
    return false; // row 6
  }
  if (equal(desired.value, cur)) {
    return false; // row 4
  }
  return desired.mode === "override"; // row 3 mode gate
}

export interface TemplateMatrixResult {
  /** Field values to assign onto the record. */
  values: Partial<Pick<ServerConfig, "proxy" | "multiplexing" | "legacyAlgorithms" | "logSession">>;
  /** The full new `origin.templated` record — carried-forward stamps with the written fields updated. */
  templated: ServerOrigin["templated"];
  /** §5.3 per-device self-reference skip warnings (a proxy routing the target through itself). */
  warnings: string[];
  /**
   * §5.3 REPAIR SIGNAL — the record's own `proxy` field must be REMOVED: a
   * template-owned proxy that resolves to a self-reference this run, repaired
   * rather than carried. Set only when the CURRENT proxy is a template-owned
   * self-proxy (`cur === carried.proxy`, both self-referential ssh) — a state
   * the connect-time circular guard refuses, so carrying it forward (row 5) only
   * re-skips it every sync. `values` never re-writes the field (a self-proxy is
   * never written), so the caller does the removal itself: `delete after.proxy`.
   * A HAND-set self-proxy is left untouched here (§8.4) and this stays falsey.
   */
  clearProxy?: boolean;
}

/**
 * §5.3 self-reference context for ONE target device. `targetServerId` is the id
 * the record will carry (`ownedServer.id` on the update path, the fresh
 * deterministic id on the add path); a desired SSH-jump proxy whose `jumpHostId`
 * equals it would route the server through itself and is skipped per-device.
 * `targetServerName`/`proxyTemplateName` name the disposition. Absent ⇒ no
 * self-reference check (the shipped behaviour before this guard).
 */
export interface ProxySelfReferenceContext {
  targetServerId: string;
  targetServerName: string;
  proxyTemplateName: string | undefined;
}

/**
 * Applies the §4.3 matrix for the four non-auth fields. Shared by the add path
 * (`ownedServer === undefined`: every desired field is row 1 → write + stamp)
 * and the update path (per-field matrix over the existing record). The returned
 * `templated` is the carried-forward stamp record with only the WRITTEN fields
 * updated; a field left alone keeps its carried stamp, and a field with no
 * desired winner is absent from `desired` and so carries forward untouched (row
 * 5). `undefined` when there is nothing to stamp, so the origin's presence
 * semantics stay clean.
 */
export function applyTemplateMatrix(
  ownedServer: ServerConfig | undefined,
  desired: DesiredNonAuthFields,
  proxyRef?: ProxySelfReferenceContext
): TemplateMatrixResult {
  const values: TemplateMatrixResult["values"] = {};
  const warnings: string[] = [];
  let clearProxy = false;
  const carried = ownedServer?.origin?.templated;
  const templated: NonNullable<ServerOrigin["templated"]> = carried
    ? { ...carried, proxy: carried.proxy ? { ...carried.proxy } : carried.proxy }
    : {};

  if (desired.proxy !== undefined) {
    const value = desired.proxy.value;
    // §5.3 SELF-REFERENCE (per-device): a jump host that IS the device being
    // written routes it through itself. Two distinct dispositions here (§5.3 vs
    // survivor-cleanup philosophy):
    //  - The template WANTS to write a self-proxy onto a record that does not
    //    already carry one → SKIP (drop to "desired none"): do NOT write, so any
    //    existing sync-owned proxy carries forward (row 5) rather than being
    //    clobbered, and a HAND-set self-proxy is left alone (§8.4).
    //  - The record ALREADY CARRIES a TEMPLATE-OWNED self-proxy (`cur` a
    //    self-ref ssh proxy AND equal to the carried stamp `origin.templated
    //    .proxy`) → REPAIR: clear the proxy + drop the stamp. Carrying it forward
    //    (row 5) leaves the server routed through itself, which the connect-time
    //    circular guard refuses — re-skipped, never repaired, every sync. Same
    //    posture the survivor cleanup takes for a dangling template-owned jump
    //    host: a template-owned proxy the runtime will refuse is CLEARED, not
    //    carried. Scoped to template-OWNED (`proxyEqual(cur, stamp)`) so a hand
    //    self-proxy stays the connect-time error, untouched (§8.4).
    // The dangling check already ran once in composeDesiredFields.
    if (value.type === "ssh" && proxyRef !== undefined && value.jumpHostId === proxyRef.targetServerId) {
      const cur = ownedServer?.proxy;
      const stamp = carried?.proxy;
      const curIsOwnedSelfProxy =
        cur !== undefined &&
        cur.type === "ssh" &&
        cur.jumpHostId === proxyRef.targetServerId &&
        stamp !== undefined &&
        proxyEqual(cur, stamp); // §8.4 — template-OWNED only; a hand self-proxy is left alone
      if (curIsOwnedSelfProxy) {
        // Repair: drop the stamp (so it is not carried) and signal the caller to
        // remove the record's `proxy` field. `values.proxy` is intentionally NOT
        // set — a self-proxy is never a value to write.
        delete templated.proxy;
        clearProxy = true;
        warnings.push(
          `Device template "${proxyRef.proxyTemplateName ?? "?"}" routed "${proxyRef.targetServerName}" through itself — the invalid proxy was cleared.`
        );
      } else {
        warnings.push(
          `Device template "${proxyRef.proxyTemplateName ?? "?"}" would route "${proxyRef.targetServerName}" through itself — the proxy field was skipped.`
        );
      }
    } else {
      const cur = ownedServer?.proxy;
      const stamp = carried?.proxy;
      const write = ownedServer === undefined ? true : matrixWrites(cur !== undefined, cur, stamp !== undefined, stamp, desired.proxy, proxyEqual);
      if (write) {
        values.proxy = { ...value };
        templated.proxy = { ...value };
      }
    }
  }
  const boolEqual = (a: boolean | undefined, b: boolean | undefined): boolean => a === b;
  const applyBool = (key: "multiplexing" | "legacyAlgorithms" | "logSession"): void => {
    const d = desired[key];
    if (d === undefined) {
      return;
    }
    const cur = ownedServer?.[key];
    const stamp = carried?.[key];
    const write = ownedServer === undefined ? true : matrixWrites(cur !== undefined, cur, stamp !== undefined, stamp, d, boolEqual);
    if (write) {
      values[key] = d.value;
      templated[key] = d.value;
    }
  };
  applyBool("multiplexing");
  applyBool("legacyAlgorithms");
  applyBool("logSession");

  const hasStamp = templated.proxy !== undefined || templated.multiplexing !== undefined || templated.legacyAlgorithms !== undefined || templated.logSession !== undefined;
  return { values, templated: hasStamp ? templated : undefined, warnings, clearProxy };
}

/**
 * "Does this server bring a usable key file of its own?" — trimmed, so a blank
 * or whitespace path (which `buildConnectConfig` rejects) counts as none.
 * templateApply's own copy of the syncEngine predicate, kept here so this module
 * stays free of a cycle back into syncEngine.
 */
export function hasOwnKeyPath(server: Pick<ServerConfig, "keyPath">): boolean {
  return typeof server.keyPath === "string" && server.keyPath.trim() !== "";
}

/**
 * The six AUTH 2 clauses (§4.4) as ONE predicate, so the sync path and the
 * future manual folder-apply (PR-T1b) cannot drift apart. "Is this server still
 * EXACTLY what the add path stamps, so a link may be FILLED onto it?":
 *   (1) a desired link actually resolved,
 *   (2) the link is unset,
 *   (3) no sync ever linked one here (the opt-out clause — origin stamp, or a
 *       kept server's preserved marker),
 *   (4) authType is "agent",
 *   (5) the server brings no key of its own,
 *   (6) the username is still exactly what the sync stamped.
 * `baselineUsername` is a PARAMETER (not a source field read inside) so the
 * fallback stays visible at both call sites: a server carrying no
 * `syncedUsername` stamp is compared against the source's current default.
 */
export function authFillEligible(server: ServerConfig, desiredProfileId: string | undefined, baselineUsername: string): boolean {
  const stampedUsername = server.origin?.syncedUsername ?? baselineUsername;
  const lastSyncApplied = server.origin !== undefined ? server.origin.syncedAuthProfileId : server.formerlySynced?.syncedAuthProfileId;
  return (
    desiredProfileId !== undefined &&
    server.authProfileId === undefined &&
    lastSyncApplied === undefined &&
    server.authType === "agent" &&
    !hasOwnKeyPath(server) &&
    server.username === stampedUsername
  );
}

/**
 * "Can THIS server connect through this profile at all?" (§4.4 rev4/rev7) — a
 * PAIRING question, deliberately SEPARATE from `authFillEligible`'s ownership
 * question. Gates the OVERRIDE MOVE (matrix rows 3/4) and the future manual
 * override path: a keyless key profile still links a target that brings its own
 * key file, and is refused only for one that cannot. On the fill path the
 * disjunct never fires — `authFillEligible` clause 5 has already fixed
 * `hasOwnKeyPath === false` — so it degenerates there to the profile-level
 * `!authProfileNeedsServerKeyPath`; keep the disjunct so the predicate says the
 * true thing at both call sites.
 */
export function authLinkUsableForTarget(profile: AuthProfile | undefined, server: Pick<ServerConfig, "keyPath">): boolean {
  return !authProfileNeedsServerKeyPath(profile) || hasOwnKeyPath(server);
}

export type TemplateAuthDecision =
  | { kind: "write"; profileId: string }
  | { kind: "leave" }
  /** An override move refused because the profile needs a key file the target does not have (§4.4 rev7). */
  | { kind: "skip-usability"; profileId: string };

/**
 * The §4.3/§4.4 auth write decision for one owned server, given the cascade
 * winner for `authProfileId`. `winnerProfile` is the RESOLVED winning profile
 * (may be keyless — the per-target usability gate decides, not a wholesale
 * drop). Returns `write` (link + re-stamp = winner), `leave` (rows 2/5/6/7 or a
 * fill winner over a configured link — write-once), or `skip-usability` (an
 * override move onto a keyless profile the target cannot satisfy).
 *
 * The two writes face two populations (§4.4 three-site table): row 1 (fill /
 * never configured) uses `authFillEligible` with the keyless id already dropped
 * (per profile — those targets provably have no key); rows 3/4 (override move)
 * use `authLinkUsableForTarget` (per target). Never merged.
 */
export function decideTemplateAuthWrite(
  server: ServerConfig,
  winner: { mode: TemplateFieldMode; profileId: string } | undefined,
  winnerProfile: AuthProfile | undefined,
  baselineUsername: string
): TemplateAuthDecision {
  if (winner === undefined) {
    return { kind: "leave" }; // no candidate → keep whatever is there (row 5 for a still-owned link)
  }
  // Row 1 (never configured) — both modes, blanket per-profile keyless gate:
  // a keyless winner drops to `undefined` here, so `authFillEligible`'s clause 1
  // fails and no keyless link is ever STAMPED onto a never-configured server.
  const fillId = authProfileNeedsServerKeyPath(winnerProfile) ? undefined : winner.profileId;
  if (authFillEligible(server, fillId, baselineUsername)) {
    return { kind: "write", profileId: winner.profileId };
  }
  // Override-only — MOVE a sync-owned link (rows 3/4), gated PER TARGET.
  if (winner.mode === "override" && server.authProfileId !== undefined && server.authProfileId === server.origin?.syncedAuthProfileId) {
    if (authLinkUsableForTarget(winnerProfile, server)) {
      return { kind: "write", profileId: winner.profileId };
    }
    return { kind: "skip-usability", profileId: winner.profileId };
  }
  // Rows 6/7 (hand-moved / hand-made link) and a fill winner over any configured
  // link: leave untouched — override never beats a hand edit, fill is write-once.
  return { kind: "leave" };
}

/** Why a profile appears in `profilesNeedingServerKey` — decides the warning's repair pointer. */
export type ProfileReferrer = { kind: "source" } | { kind: "template"; templateName: string } | { kind: "retained-link" };

export interface ProfilesNeedingServerKey {
  /** Profile ids that REQUIRE the server to bring its own key file (keyless key profiles). */
  ids: Set<string>;
  /** Per-id referrer, for the AUTH 2b warning to point the repair at the right editor. */
  referrer: Map<string, ProfileReferrer>;
}

/**
 * §4.4 / A-M2 + rev3 — the PRE-PASS over the source's owned servers that flags
 * every profile REQUIRING THE SERVER TO BRING ITS OWN KEY (a keyless key
 * profile). NOT a set of globally unusable profiles: every consumer (AUTH 2b
 * rollback, the override move) decides per server. Three candidate terms:
 *   (a) the source-level profile (`sourceProfile`), taken BEFORE the AUTH 1b
 *       keyless zeroing — this is where the warning's SOURCE referrer comes
 *       from, and the route that does not depend on the pre-pass's scope;
 *   (b) every rule template's `fields.authProfileId`, as written on the template;
 *   (c) every SYNC-OWNED link on an owned server
 *       (`authProfileId === origin.syncedAuthProfileId`) — the RETAINED links
 *       §4.3 row 5 / §6.3 keep after their rule is gone, which nothing in the
 *       current config references.
 * Sync-owned only (hand links are rows 6/7 — never the sync's to undo).
 *
 * `sourceProfile` is passed explicitly (rather than resolved from the map) so
 * this works for legacy callers that pass no `authProfilesById`: term (a) still
 * names the source keyless profile from `input.authProfile`, exactly the
 * shipped single-id behaviour, and (c)'s links to that same profile resolve
 * through the same fallback.
 */
export function computeProfilesNeedingServerKey(params: {
  source: InventorySourceConfig;
  ownedServers: readonly ServerConfig[];
  sourceProfile: AuthProfile | undefined;
  templatesById: Map<string, DeviceTemplateProfile> | undefined;
  authProfilesById: Map<string, AuthProfile> | undefined;
}): ProfilesNeedingServerKey {
  const { source, ownedServers, sourceProfile, templatesById, authProfilesById } = params;
  const ids = new Set<string>();
  const referrer = new Map<string, ProfileReferrer>();

  const resolveProfile = (id: string): AuthProfile | undefined => {
    const fromMap = authProfilesById?.get(id);
    if (fromMap !== undefined) {
      return fromMap;
    }
    return sourceProfile?.id === id ? sourceProfile : undefined;
  };
  // Referrer priority source > template > retained-link: never demote a
  // more-explicit referrer once recorded.
  const flag = (id: string, ref: ProfileReferrer): void => {
    if (!authProfileNeedsServerKeyPath(resolveProfile(id))) {
      return;
    }
    ids.add(id);
    const existing = referrer.get(id);
    if (existing === undefined || (existing.kind === "retained-link" && ref.kind !== "retained-link") || (existing.kind === "template" && ref.kind === "source")) {
      referrer.set(id, ref);
    }
  };

  if (sourceProfile !== undefined) {
    flag(sourceProfile.id, { kind: "source" });
  }
  for (const rule of source.templateRules ?? []) {
    const template = templatesById?.get(rule.templateId);
    const pid = template?.fields.authProfileId?.value;
    if (pid !== undefined) {
      flag(pid, { kind: "template", templateName: template!.name });
    }
  }
  for (const server of ownedServers) {
    const id = server.authProfileId;
    if (id !== undefined && server.origin?.syncedAuthProfileId === id) {
      flag(id, { kind: "retained-link" });
    }
  }
  return { ids, referrer };
}

/**
 * §5.1 / §7.4 — deletes `templated.X` for each field the MANUAL folder apply
 * writes, and `syncedAuthProfileId` when it writes the auth link, dropping an
 * emptied `templated` record entirely so presence semantics stay clean. The
 * written fields then land in row 7 (value set, stamp absent = hand value),
 * which is what makes a manual apply read as a hand edit to every later sync.
 *
 * SHIPPED HERE, UNIT-TESTED, BUT WIRED TO NOTHING in PR-T1 — its only consumer,
 * the manual command, is PR-T1b. Keeping it out of every sync path is the "only
 * a user action clears a stamp" invariant (§4.3) expressed in the module's API
 * surface: no sync path may call this.
 */
// ---------------------------------------------------------------------------
// §7.4 MANUAL FOLDER APPLY — the pure planner behind `nexus.deviceTemplate
// .applyToFolder`. Kept here (not in the command) so the SAME six-clause
// eligibility (`authFillEligible`) and per-target usability (`authLinkUsableForTarget`)
// the sync engine uses also gate the manual path — "one predicate, two callers"
// (§7.4 / risk 5) — and so the modal's dry-run counts and the actual writes are
// computed from ONE decision, never two that can disagree.
// ---------------------------------------------------------------------------

/** What one server receives from a manual apply — only the fields actually written. */
export interface ManualApplyServerWrite {
  serverId: string;
  proxy?: ProxyConfig;
  multiplexing?: boolean;
  legacyAlgorithms?: boolean;
  logSession?: boolean;
  authProfileId?: string;
  /** The fields written above, in `TemplatableField` terms — fed verbatim to `clearTemplatedStamps`. */
  writtenFields: TemplatableField[];
}

/** Dry-run counts for one value field's consent line. */
export interface ValueFieldPlan {
  mode: TemplateFieldMode;
  willSet: number;
  skipped: number;
}

/** Dry-run counts for the auth link's consent line, skips split by reason (§7.4 UX-S7). */
export interface AuthFieldPlan {
  mode: TemplateFieldMode;
  linked: number;
  /** Fill only — a link is already present (write-once leaves it). */
  skippedAlreadyLinked: number;
  /** Fill only — SSH login was configured by hand (clauses 3/4/5/6, incl. non-synced & fail-closed). */
  skippedLoginConfigured: number;
  /** Both modes — the profile needs a key file this target does not have (§4.4 per-target usability). */
  skippedNeedsKey: number;
  /** Override only — the honest count of hand-configured logins this override replaces. */
  replacingHandConfigured: number;
}

export interface ManualApplyPlan {
  serverWrites: ManualApplyServerWrite[];
  proxy?: ValueFieldPlan;
  multiplexing?: ValueFieldPlan;
  legacyAlgorithms?: ValueFieldPlan;
  logSession?: ValueFieldPlan;
  auth?: AuthFieldPlan;
  /** §5.3 reference-validation warnings — dangling auth profile / jump host / per-target self-proxy. */
  warnings: string[];
}

export interface ManualApplyContext {
  template: DeviceTemplateProfile;
  servers: readonly ServerConfig[];
  /** The `defaultUsername` of the source named by a server's `origin.sourceId`, or `undefined` if that source is gone (fail closed, §7.4 clause 6). */
  sourceDefaultUsername: (sourceId: string) => string | undefined;
  /** Resolve a profile id to the live `AuthProfile` (dangling → undefined). */
  authProfile: (id: string) => AuthProfile | undefined;
  /** Does a live server with this id exist? — §5.3 jump-host dangling check. */
  hasServer: (id: string) => boolean;
}

/**
 * §7.4 clause-6 baseline: for a SYNCED server, `origin.syncedUsername` else the
 * source's current `defaultUsername`; `undefined` when the server is NON-SYNCED
 * (every field was hand-typed — clause 6 cannot pass) or its source is gone
 * (fail closed — refuse rather than guess which account it logs in as).
 */
function manualBaselineUsername(server: ServerConfig, sourceDefaultUsername: (sourceId: string) => string | undefined): string | undefined {
  if (server.origin === undefined) {
    return undefined;
  }
  return server.origin.syncedUsername ?? sourceDefaultUsername(server.origin.sourceId);
}

/**
 * Computes the manual-apply plan for a folder of servers. Value fields
 * (proxy/multiplexing/legacyAlgorithms/logSession): fill writes where unset,
 * override writes over anything. Auth link: FILL runs the six `authFillEligible`
 * clauses then the per-target usability gate (§4.4 composition — for a
 * fill-eligible target usability degenerates to a profile-level keyless check);
 * OVERRIDE is unconstrained except that same per-target usability gate, and is
 * the only mode that can face — and link — an own-key target. Skips are split by
 * reason for the modal; a keyless-key target is always its own line because the
 * repair differs.
 */
export function planManualTemplateApply(ctx: ManualApplyContext): ManualApplyPlan {
  const { template, servers, sourceDefaultUsername, authProfile, hasServer } = ctx;
  const warnings: string[] = [];
  const serverWrites = new Map<string, ManualApplyServerWrite>();
  const writeFor = (id: string): ManualApplyServerWrite => {
    let w = serverWrites.get(id);
    if (w === undefined) {
      w = { serverId: id, writtenFields: [] };
      serverWrites.set(id, w);
    }
    return w;
  };

  const plan: ManualApplyPlan = { serverWrites: [], warnings };

  // ---- Proxy ----------------------------------------------------------------
  const proxyField = template.fields.proxy;
  if (proxyField !== undefined) {
    let proxyValue: ProxyConfig | undefined = proxyField.value;
    // §5.3 dangling jump host — device-independent, checked once; drops the field.
    if (proxyValue.type === "ssh" && !hasServer(proxyValue.jumpHostId)) {
      warnings.push(`Device template "${template.name}" sets a jump-host proxy whose jump host no longer exists — the proxy field was skipped.`);
      proxyValue = undefined;
    }
    if (proxyValue !== undefined) {
      const stats: ValueFieldPlan = { mode: proxyField.mode, willSet: 0, skipped: 0 };
      for (const server of servers) {
        // §5.3 per-device self-reference — a jump host that IS this server.
        if (proxyValue.type === "ssh" && proxyValue.jumpHostId === server.id) {
          warnings.push(`Device template "${template.name}" would route "${server.name}" through itself — the proxy field was skipped.`);
          stats.skipped++;
          continue;
        }
        const write = proxyField.mode === "override" || server.proxy === undefined;
        if (write) {
          const w = writeFor(server.id);
          w.proxy = proxyValue;
          w.writtenFields.push("proxy");
          stats.willSet++;
        } else {
          stats.skipped++;
        }
      }
      plan.proxy = stats;
    }
  }

  // ---- Boolean value fields -------------------------------------------------
  const applyBool = (field: "multiplexing" | "legacyAlgorithms" | "logSession"): ValueFieldPlan | undefined => {
    const tf = template.fields[field];
    if (tf === undefined) {
      return undefined;
    }
    const stats: ValueFieldPlan = { mode: tf.mode, willSet: 0, skipped: 0 };
    for (const server of servers) {
      const write = tf.mode === "override" || server[field] === undefined;
      if (write) {
        const w = writeFor(server.id);
        w[field] = tf.value;
        w.writtenFields.push(field);
        stats.willSet++;
      } else {
        stats.skipped++;
      }
    }
    return stats;
  };
  plan.multiplexing = applyBool("multiplexing");
  plan.legacyAlgorithms = applyBool("legacyAlgorithms");
  plan.logSession = applyBool("logSession");

  // ---- Auth link ------------------------------------------------------------
  const authField = template.fields.authProfileId;
  if (authField !== undefined) {
    const profile = authProfile(authField.value);
    if (profile === undefined) {
      // §5.3 dangling auth profile — drop the field entirely.
      warnings.push(`Device template "${template.name}" links an auth profile that no longer exists — the auth field was skipped.`);
    } else {
      const stats: AuthFieldPlan = {
        mode: authField.mode,
        linked: 0,
        skippedAlreadyLinked: 0,
        skippedLoginConfigured: 0,
        skippedNeedsKey: 0,
        replacingHandConfigured: 0
      };
      for (const server of servers) {
        const baseline = manualBaselineUsername(server, sourceDefaultUsername);
        const fillEligible = baseline !== undefined && authFillEligible(server, profile.id, baseline);
        const usable = authLinkUsableForTarget(profile, server);
        if (authField.mode === "fill") {
          if (!fillEligible) {
            // Eligibility skip, split into the two buckets the modal names.
            if (server.authProfileId !== undefined) {
              stats.skippedAlreadyLinked++;
            } else {
              stats.skippedLoginConfigured++;
            }
            continue;
          }
          // Fill-eligible ⇒ hasOwnKeyPath === false, so usability is the
          // profile-level keyless check (§4.4 composition).
          if (!usable) {
            stats.skippedNeedsKey++;
            continue;
          }
          const w = writeFor(server.id);
          w.authProfileId = profile.id;
          w.writtenFields.push("authProfileId");
          stats.linked++;
        } else {
          // OVERRIDE — unconstrained except the per-target usability gate.
          if (!usable) {
            stats.skippedNeedsKey++;
            continue;
          }
          const w = writeFor(server.id);
          w.authProfileId = profile.id;
          w.writtenFields.push("authProfileId");
          stats.linked++;
          // P1 (adversarial minor 2) — "replacing N hand-configured logins" must
          // count ONLY targets whose current effective login is genuinely
          // hand-configured AND actually changes. Excluded:
          //   - a never-configured (fill-eligible) target — nothing to replace;
          //   - a SYNC-OWNED link (`authProfileId === origin.syncedAuthProfileId`)
          //     — the sync put it there, not the hand, so override is moving a
          //     sync link, not replacing a hand one;
          //   - a target ALREADY linked to this same profile — the write is a
          //     no-op, so it "replaces" nothing.
          const current = server.authProfileId;
          const syncOwned = current !== undefined && current === server.origin?.syncedAuthProfileId;
          const alreadySameProfile = current === profile.id;
          if (!fillEligible && !syncOwned && !alreadySameProfile) {
            stats.replacingHandConfigured++;
          }
        }
      }
      plan.auth = stats;
    }
  }

  plan.serverWrites = [...serverWrites.values()].filter((w) => w.writtenFields.length > 0);
  return plan;
}

export function clearTemplatedStamps(origin: ServerOrigin | undefined, writtenFields: readonly TemplatableField[]): ServerOrigin | undefined {
  if (origin === undefined) {
    return origin;
  }
  const next: ServerOrigin = { ...origin };
  if (writtenFields.includes("authProfileId")) {
    next.syncedAuthProfileId = undefined;
  }
  const templated = origin.templated ? { ...origin.templated } : undefined;
  if (templated !== undefined) {
    for (const field of writtenFields) {
      if (field === "proxy" || field === "multiplexing" || field === "legacyAlgorithms" || field === "logSession") {
        delete templated[field];
      }
    }
    const stillHasStamp =
      templated.proxy !== undefined ||
      templated.multiplexing !== undefined ||
      templated.legacyAlgorithms !== undefined ||
      templated.logSession !== undefined;
    next.templated = stillHasStamp ? templated : undefined;
  }
  return next;
}
