import type { AuthProfile, ProxyConfig, ServerConfig, ServerOrigin } from "../../models/config";
import { authProfileNeedsServerKeyPath } from "../../models/config";
import type { InventorySourceConfig, TemplateRule } from "../../models/inventory";
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
 * Distinct-key count of a filter — the specificity used to rank cascade
 * candidates (§3.1). PR-T1 STUB: only catch-all (0) is meaningful because
 * filtered rules are skipped before they are ever ranked; the real distinct-key
 * parser lands in PR-T2 with the matcher.
 */
export function filterSpecificity(filter: string | undefined): number {
  return isCatchAllFilter(filter) ? 0 : 0;
}

/** The per-field winners of the cascade — the {mode, value} each field resolves to. */
export interface CascadeWinners {
  proxy?: TemplateField<ProxyConfig>;
  authProfileId?: TemplateField<string>;
  multiplexing?: TemplateField<boolean>;
  legacyAlgorithms?: TemplateField<boolean>;
  logSession?: TemplateField<boolean>;
}

export interface CascadeResult {
  winners: CascadeWinners;
  /** True when `winners.authProfileId` came from the IMPLICIT source-level rule (§4.2), not an explicit rule. */
  authFromImplicit: boolean;
  /** Filtered-rule-skip (fail-closed) and dangling-template warnings, once per rule. */
  warnings: string[];
}

/**
 * The per-field cascade (§3.2) — the ONLY resolution algorithm from day one.
 *
 * PR-T1 is DEGENERATE ON FILTERS. With no matcher, a filtered rule cannot be
 * evaluated, so it is SKIPPED (fail-closed, §7.2) rather than treated as a
 * catch-all — treating an un-evaluable `role=switch` rule as "matches every
 * device" would silently apply it fleet-wide, the exact privilege-escalation
 * shape fail-closed exists to prevent. Only catch-all rules (filter
 * absent/empty/whitespace) participate, plus the implicit source-level auth rule
 * at specificity −1. Because every catch-all matches every device, the winners
 * are DEVICE-INDEPENDENT in T1, so the engine resolves them ONCE per source.
 *
 * PR-T2 adds the `device` argument and `deviceMatchesFilter`, at which point
 * candidacy becomes per-device and filtered rules start applying (their skip
 * warning lifts). The cascade's shape here does not change — only which rules
 * are candidates — because stamps record VALUES, never which rule wrote them
 * (§1.3), so nothing below the composition step can see which rule won a field.
 *
 * Tie-break among catch-all candidates for one field is deterministic — all
 * catch-alls normalize to the empty filter, so the tie resolves on rule `id`
 * lexicographic order (§3.3's final resort). Per-field TIE WARNINGS are PR-T2
 * (they need the general matcher's specificity), so none are emitted here.
 */
export function selectFieldWinners(
  rules: readonly TemplateRule[],
  implicitAuthProfileId: string | undefined,
  templatesById: Map<string, DeviceTemplateProfile> | undefined,
  sourceName: string
): CascadeResult {
  const warnings: string[] = [];
  const resolved: Array<{ rule: TemplateRule; template: DeviceTemplateProfile }> = [];
  for (const rule of rules) {
    if (!isCatchAllFilter(rule.filter)) {
      // FAIL CLOSED (§7.2 rev11) — the matcher is PR-T2, so a build that
      // receives a filtered rule (by import or rollback) skips it with a plan
      // warning rather than acting on scope it cannot establish.
      warnings.push(
        `Rule "${rule.filter}" on "${sourceName}" uses a device filter this version cannot evaluate — the rule was skipped and none of its settings were applied. Update Nexus to use filtered rules.`
      );
      continue;
    }
    const template = templatesById?.get(rule.templateId);
    if (template === undefined) {
      // Degrade, don't abort (AUTH 1's posture) — a rule whose template no
      // longer resolves is skipped, its siblings proceed.
      warnings.push(`A device template rule on "${sourceName}" references a template that no longer exists — the rule was skipped.`);
      continue;
    }
    resolved.push({ rule, template });
  }

  // All catch-alls tie on specificity (0); break by rule id so the winner is
  // order-free and stable across reorder / backup round-trips (§3.3).
  const ordered = [...resolved].sort((a, b) => (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0));

  const winners: CascadeWinners = {};
  const firstSetter = <T>(pick: (t: DeviceTemplateProfile) => TemplateField<T> | undefined): TemplateField<T> | undefined => {
    for (const { template } of ordered) {
      const field = pick(template);
      if (field !== undefined) {
        return field;
      }
    }
    return undefined;
  };
  winners.proxy = firstSetter((t) => t.fields.proxy);
  winners.multiplexing = firstSetter((t) => t.fields.multiplexing);
  winners.legacyAlgorithms = firstSetter((t) => t.fields.legacyAlgorithms);
  winners.logSession = firstSetter((t) => t.fields.logSession);

  const explicitAuth = firstSetter((t) => t.fields.authProfileId);
  let authFromImplicit = false;
  if (explicitAuth !== undefined) {
    winners.authProfileId = explicitAuth;
  } else if (implicitAuthProfileId !== undefined) {
    // The implicit source-level rule (§4.2): a catch-all FILL rule at
    // specificity −1, below every explicit rule. When no explicit rule sets
    // auth this is the only candidate, and PR #53's behaviour falls out
    // unchanged — fill semantics gated by the six AUTH 2 clauses.
    winners.authProfileId = { mode: "fill", value: implicitAuthProfileId };
    authFromImplicit = true;
  }
  return { winners, authFromImplicit, warnings };
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
 * §4.2 layer 2 (mode vs source data), for the four non-auth v1 fields. `srcX`
 * (device/provider-supplied data) is EMPTY for all of them, so this reduces to
 * `desiredX = tmplX.value` carrying `tmplX.mode` for the matrix's row-3 gate.
 * Written explicitly as the layer anyway, because it is where `port` (§4.6) and
 * any future endpoint-supplied field slot in — `desiredPort` would be
 * `override → tmpl, else endpoint.port, else fill → tmpl`.
 */
export function composeDesiredFields(winners: CascadeWinners): DesiredNonAuthFields {
  const desired: DesiredNonAuthFields = {};
  if (winners.proxy !== undefined) {
    desired.proxy = { value: winners.proxy.value, mode: winners.proxy.mode };
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
  return desired;
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
export function applyTemplateMatrix(ownedServer: ServerConfig | undefined, desired: DesiredNonAuthFields): TemplateMatrixResult {
  const values: TemplateMatrixResult["values"] = {};
  const carried = ownedServer?.origin?.templated;
  const templated: NonNullable<ServerOrigin["templated"]> = carried
    ? { ...carried, proxy: carried.proxy ? { ...carried.proxy } : carried.proxy }
    : {};

  if (desired.proxy !== undefined) {
    const cur = ownedServer?.proxy;
    const stamp = carried?.proxy;
    const write = ownedServer === undefined ? true : matrixWrites(cur !== undefined, cur, stamp !== undefined, stamp, desired.proxy, proxyEqual);
    if (write) {
      values.proxy = { ...desired.proxy.value };
      templated.proxy = { ...desired.proxy.value };
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
  return { values, templated: hasStamp ? templated : undefined };
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
