import { describe, expect, it } from "vitest";
import { computeSyncPlan, type InventorySyncPlan } from "../../src/services/inventory/syncEngine";
import { clearTemplatedStamps } from "../../src/services/inventory/templateApply";
import { deterministicServerId } from "../../src/services/inventory/deterministicId";
import type { AuthProfile, ProxyConfig, ServerConfig, ServerOrigin } from "../../src/models/config";
import type { InventoryDevice, InventorySourceConfig, InventoryTree, TemplateRule } from "../../src/models/inventory";
import type { DeviceTemplateProfile } from "../../src/models/deviceTemplate";

/**
 * DEVICE TEMPLATES (issue #48 PR-T1) — the engine: the §4.3 write matrix + mode
 * gate, the AUTH machinery generalized onto the per-field cascade (§4.4), the
 * widened AUTH 2b rollback set, and the fail-closed filtered-rule skip (§7.2).
 * Each fixture is built to FAIL against the specific wrong implementation its
 * "Kills:" note names.
 */

const P_A: ProxyConfig = { type: "socks5", host: "10.9.9.1", port: 1080 };
const P_B: ProxyConfig = { type: "socks5", host: "10.9.9.2", port: 1080 };
const P_C: ProxyConfig = { type: "socks5", host: "10.9.9.3", port: 1080 };

function makeSource(overrides: Partial<InventorySourceConfig> = {}): InventorySourceConfig {
  return {
    id: "source-1",
    providerId: "netbox",
    name: "NetBox",
    targetFolder: "NetBox",
    prunePolicy: "orphan",
    defaultUsername: "admin",
    config: {},
    secretFieldIds: [],
    ...overrides
  };
}

function makeDevice(overrides: Partial<InventoryDevice> = {}): InventoryDevice {
  return { externalId: "device:1", name: "core-sw-1", endpoints: [{ kind: "ssh", host: "10.0.0.1" }], ...overrides };
}

function tree(devices: InventoryDevice[]): InventoryTree {
  return { contractVersion: 1, devices };
}

function ownedServer(overrides: Partial<ServerConfig> = {}, origin: Partial<ServerOrigin> = {}): ServerConfig {
  return {
    id: deterministicServerId("source-1", overrides.origin?.externalId ?? "device:1"),
    name: "core-sw-1",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    authType: "agent",
    isHidden: false,
    group: "NetBox",
    origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, ...origin },
    ...overrides
  };
}

function template(fields: DeviceTemplateProfile["fields"], id = "tmpl-1", name = "T"): DeviceTemplateProfile {
  return { id, name, fields };
}

function rule(templateId: string, overrides: Partial<TemplateRule> = {}): TemplateRule {
  return { id: `rule-${templateId}`, templateId, ...overrides };
}

function authProfile(id: string, overrides: Partial<AuthProfile> = {}): AuthProfile {
  return { id, name: id.toUpperCase(), username: "svc", authType: "agent", ...overrides };
}

interface PlanOpts {
  source: InventorySourceConfig;
  devices: InventoryDevice[];
  servers?: ServerConfig[];
  templates?: DeviceTemplateProfile[];
  authProfiles?: AuthProfile[];
  authProfile?: AuthProfile;
}

function plan(opts: PlanOpts): InventorySyncPlan {
  return computeSyncPlan({
    source: opts.source,
    tree: tree(opts.devices),
    currentServers: opts.servers ?? [],
    now: 5000,
    authProfile: opts.authProfile,
    templatesById: new Map((opts.templates ?? []).map((t) => [t.id, t] as const)),
    authProfilesById: new Map((opts.authProfiles ?? []).map((p) => [p.id, p] as const))
  });
}

/** The `after` record for a given owned server id, or `undefined` if it was left unchanged. */
function afterFor(p: InventorySyncPlan, serverId: string): ServerConfig | undefined {
  return p.updates.find((u) => u.before.id === serverId)?.after;
}

// -------- Matrix rows 1–7 + mode gate (proxy) --------

describe("device template matrix — non-auth fields", () => {
  it("Fixture 4 — row 1 fill: a fresh unset field gets the fill value written + stamped (kills 'fill never writes')", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [ownedServer({ proxy: undefined }, { templated: undefined })],
      templates: [template({ proxy: { mode: "fill", value: P_A } })]
    });
    const after = afterFor(p, ownedServer().id)!;
    expect(after.proxy).toEqual(P_A);
    expect(after.origin?.templated?.proxy).toEqual(P_A);
  });

  it("Fixture 5 — row 2 opt-out: cur unset with a DIFFERENT stamp present is NOT re-applied (kills a missing opt-out clause)", () => {
    // The stamp is a DIFFERENT value than the template — else 'leave' and
    // 're-apply' would produce identical records.
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [ownedServer({ proxy: undefined }, { templated: { proxy: P_B } })],
      templates: [template({ proxy: { mode: "override", value: P_A } })]
    });
    expect(p.updates.length).toBe(0);
    expect(p.unchangedCount).toBe(1);
  });

  it("Fixture 6 — row 3 override: a still-sync-owned value is rewritten to the edited override value + re-stamped (kills 'write once, never update')", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [ownedServer({ proxy: P_A }, { templated: { proxy: P_A } })],
      templates: [template({ proxy: { mode: "override", value: P_B } })]
    });
    const after = afterFor(p, ownedServer().id)!;
    expect(after.proxy).toEqual(P_B);
    expect(after.origin?.templated?.proxy).toEqual(P_B);
  });

  it("Fixture 6b — MODE GATE: a FILL winner in row-3 position does NOT rewrite (write-once) (kills fill behaving like override)", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [ownedServer({ proxy: P_A }, { templated: { proxy: P_A } })],
      templates: [template({ proxy: { mode: "fill", value: P_B } })]
    });
    // The edited fill value must NOT reach the existing value or stamp.
    expect(p.updates.length).toBe(0);
    expect(p.unchangedCount).toBe(1);
  });

  it("Fixture 7 — row 5: when the rule stops matching, value AND stamp are carried forward (kills 'release clears/reverts')", () => {
    // No template rules this sync = desired none for proxy; force an update via a
    // rename so `after` is observable, then assert the STAMP explicitly (a
    // value-only assertion passes against a stamp-dropping implementation).
    const p = plan({
      source: makeSource(),
      devices: [makeDevice({ name: "renamed-sw" })],
      servers: [ownedServer({ proxy: P_A }, { templated: { proxy: P_A } })]
    });
    const after = afterFor(p, ownedServer().id)!;
    expect(after.name).toBe("renamed-sw");
    expect(after.proxy).toEqual(P_A);
    expect(after.origin?.templated?.proxy).toEqual(P_A);
  });

  it("Fixture 8 — row 6: a hand-edited value (cur ≠ stamp) is kept, the old stamp carried (kills 'override beats everything')", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice({ name: "renamed-sw" })],
      servers: [ownedServer({ proxy: P_C }, { templated: { proxy: P_A } })], // hand value P_C ≠ stamp P_A
      templates: [template({ proxy: { mode: "override", value: P_B } })]
    });
    const after = afterFor(p, ownedServer().id)!;
    expect(after.proxy).toEqual(P_C); // hand value kept
    expect(after.origin?.templated?.proxy).toEqual(P_A); // old stamp carried
  });

  it("Fixture 9 — row 7: a legacy hand value with NO stamp is untouched by override (kills 'absent stamp = sync owns')", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice({ name: "renamed-sw" })],
      servers: [ownedServer({ proxy: P_C }, { templated: undefined })],
      templates: [template({ proxy: { mode: "override", value: P_B } })]
    });
    const after = afterFor(p, ownedServer().id)!;
    expect(after.proxy).toEqual(P_C);
    expect(after.origin?.templated?.proxy).toBeUndefined();
  });

  it("Fixture 10 — a template application otherwise identical to the record still lands in `updates` (kills a forgotten `changed` clause for the value + template stamp)", () => {
    // Device matches the owned server on name/host/port/group, so the ONLY diff
    // is proxy + its stamp. A `changed` clause lacking the new proxy/booleans and
    // the origin-stamp term would silently count this unchanged.
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [ownedServer({ proxy: undefined }, { templated: undefined })],
      templates: [template({ proxy: { mode: "fill", value: P_A } })]
    });
    expect(p.unchangedCount).toBe(0);
    expect(p.updates.length).toBe(1);
    expect(p.updates[0].after.proxy).toEqual(P_A);
  });

  it("Fixture 11 — CARRY-FORWARD: a rename with template stamps present and NO template attached keeps the stamps on after.origin (kills the afterOrigin rebuild forgetting the one-line carry)", () => {
    const p = plan({
      source: makeSource(),
      devices: [makeDevice({ name: "renamed-sw" })],
      servers: [ownedServer({ proxy: P_A, multiplexing: true }, { templated: { proxy: P_A, multiplexing: true } })]
    });
    const after = afterFor(p, ownedServer().id)!;
    expect(after.name).toBe("renamed-sw"); // the unrelated update did fire
    expect(after.origin?.templated?.proxy).toEqual(P_A);
    expect(after.origin?.templated?.multiplexing).toBe(true);
  });

  it("Fixture 3b (matrix) — a boolean stamp of `false` is PRESENT: an override edited to `true` rewrites it (kills a truthiness presence check that would read row 7 and block)", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [ownedServer({ multiplexing: false }, { templated: { multiplexing: false } })],
      templates: [template({ multiplexing: { mode: "override", value: true } })]
    });
    const after = afterFor(p, ownedServer().id)!;
    expect(after.multiplexing).toBe(true);
    expect(after.origin?.templated?.multiplexing).toBe(true);
  });

  it("row 1 fill on the ADD path writes the value + stamp on a fresh record", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice({ externalId: "device:new", name: "new-sw" })],
      servers: [],
      templates: [template({ proxy: { mode: "override", value: P_A }, multiplexing: { mode: "fill", value: false } })]
    });
    expect(p.adds.length).toBe(1);
    expect(p.adds[0].proxy).toEqual(P_A);
    expect(p.adds[0].multiplexing).toBe(false);
    expect(p.adds[0].origin?.templated?.proxy).toEqual(P_A);
    expect(p.adds[0].origin?.templated?.multiplexing).toBe(false);
  });
});

// -------- AUTH cascade (§4.4) --------

describe("device template auth cascade — §4.4", () => {
  it("Fixture 12 — the shared syncedAuthProfileId opt-out blocks a template fill from re-linking a cleared link (kills a parallel stamp namespace)", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice({ name: "renamed-sw" })],
      // user CLEARED the link; the stamp still names A (opt-out).
      servers: [ownedServer({ authProfileId: undefined }, { syncedAuthProfileId: "A" })],
      templates: [template({ authProfileId: { mode: "fill", value: "A" } })],
      authProfiles: [authProfile("A")]
    });
    const after = afterFor(p, ownedServer().id)!;
    expect(after.authProfileId).toBeUndefined();
  });

  it("Fixture 13 — an explicit fill rule (spec 0) beats the implicit source-level rule (spec −1); with no explicit rule the source profile is retro-applied unchanged (kills source outranking explicit, and a legacy retro-apply regression)", () => {
    // Explicit rule names B; source names A.
    const withRule = plan({
      source: makeSource({ authProfileId: "A", templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [ownedServer()],
      templates: [template({ authProfileId: { mode: "fill", value: "B" } })],
      authProfiles: [authProfile("A"), authProfile("B")],
      authProfile: authProfile("A")
    });
    expect(afterFor(withRule, ownedServer().id)!.authProfileId).toBe("B");

    // Sibling: no explicit rule → A written via the six clauses (PR #53 verbatim).
    const noRule = plan({
      source: makeSource({ authProfileId: "A" }),
      devices: [makeDevice()],
      servers: [ownedServer()],
      authProfiles: [authProfile("A")],
      authProfile: authProfile("A")
    });
    expect(afterFor(noRule, ownedServer().id)!.authProfileId).toBe("A");
  });

  it("Fixture 13b — A-M1: a FILL fall-back winner never MOVES a configured sync-owned link; an OVERRIDE fall-back does (kills a fill winner moving a link)", () => {
    const linkedB = ownedServer({ authProfileId: "B" }, { syncedAuthProfileId: "B" });
    // (i) explicit catch-all FILL rule naming A → stays B.
    const explicitFill = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [linkedB],
      templates: [template({ authProfileId: { mode: "fill", value: "A" } })],
      authProfiles: [authProfile("A"), authProfile("B")]
    });
    expect(afterFor(explicitFill, linkedB.id)?.authProfileId ?? "B").toBe("B");

    // (ii) implicit source-level rule (fill) naming A → stays B.
    const implicitFill = plan({
      source: makeSource({ authProfileId: "A" }),
      devices: [makeDevice()],
      servers: [linkedB],
      authProfiles: [authProfile("A")],
      authProfile: authProfile("A")
    });
    expect(afterFor(implicitFill, linkedB.id)?.authProfileId ?? "B").toBe("B");

    // Sibling: an OVERRIDE fall-back rule naming A → link moves to A + re-stamped.
    const override = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [linkedB],
      templates: [template({ authProfileId: { mode: "override", value: "A" } })],
      authProfiles: [authProfile("A"), authProfile("B")]
    });
    const after = afterFor(override, linkedB.id)!;
    expect(after.authProfileId).toBe("A");
    expect(after.origin?.syncedAuthProfileId).toBe("A");
  });

  it("Fixture 14 — a template fill is refused on a server whose username was hand-edited away from the stamp (kills template fill bypassing the six clauses)", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice({ name: "renamed-sw" })],
      servers: [ownedServer({ username: "root" }, { syncedUsername: "admin" })], // hand-edited username
      templates: [template({ authProfileId: { mode: "fill", value: "A" } })],
      authProfiles: [authProfile("A")]
    });
    expect(afterFor(p, ownedServer().id)!.authProfileId).toBeUndefined();
  });

  it("Fixture 14b — A-M2: a keyless key profile applied by a rule TEMPLATE is rolled back, and the warning names the template referrer (kills a rollback set drawn only from the source profile)", () => {
    const keylessB = authProfile("B", { authType: "key", keyPath: undefined });
    const linkedB = ownedServer({ authProfileId: "B" }, { syncedAuthProfileId: "B" });
    for (const sourceHasProfile of [false, true]) {
      const p = plan({
        source: makeSource({
          authProfileId: sourceHasProfile ? "S" : undefined,
          templateRules: [rule("tmpl-1")]
        }),
        devices: [makeDevice()],
        servers: [linkedB],
        templates: [template({ authProfileId: { mode: "fill", value: "B" } })],
        authProfiles: [keylessB, authProfile("S")],
        authProfile: sourceHasProfile ? authProfile("S") : undefined
      });
      const after = afterFor(p, linkedB.id)!;
      expect(after.authProfileId).toBeUndefined(); // unlinked by AUTH 2b
      expect(after.origin?.syncedAuthProfileId).toBeUndefined();
      expect(p.warnings.some((w) => w.includes("device template") && w.includes('"B"'))).toBe(true);
    }

    // Unmapped-pass variant: the device is present but endpoint-less this fetch.
    const unmapped = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice({ endpoints: [] })],
      servers: [linkedB],
      templates: [template({ authProfileId: { mode: "fill", value: "B" } })],
      authProfiles: [keylessB]
    });
    expect(afterFor(unmapped, linkedB.id)!.authProfileId).toBeUndefined();
  });

  it("Fixture 14c — a RETAINED sync-owned link (its rule gone) to a now-keyless profile is rolled back; a hand link is NOT (kills a scan drawn only from current rules, and one that forgets to stay sync-owned)", () => {
    const keylessB = authProfile("B", { authType: "key", keyPath: undefined });
    // Filler owned servers BEFORE the retained-link server, so an accumulate
    // -during-loop implementation visibly fails the mapped pass on ordering.
    const filler1 = ownedServer({ id: deterministicServerId("source-1", "device:f1") }, { externalId: "device:f1" });
    const filler2 = ownedServer({ id: deterministicServerId("source-1", "device:f2") }, { externalId: "device:f2" });
    // K: sync-owned link to B, no key of its own, RULE DELETED (no templateRules).
    const kId = deterministicServerId("source-1", "device:k");
    const K = ownedServer({ id: kId, authProfileId: "B" }, { externalId: "device:k", syncedAuthProfileId: "B" });
    // Hand links to B: NOT unlinked.
    const hId = deterministicServerId("source-1", "device:h");
    const handNoStamp = ownedServer({ id: hId, authProfileId: "B" }, { externalId: "device:h" }); // syncedAuthProfileId absent
    const h2Id = deterministicServerId("source-1", "device:h2");
    const handOtherStamp = ownedServer({ id: h2Id, authProfileId: "B" }, { externalId: "device:h2", syncedAuthProfileId: "C" });

    const p = plan({
      source: makeSource(), // no rule, no source profile references B anywhere
      devices: [
        makeDevice({ externalId: "device:f1", name: "f1", endpoints: [{ kind: "ssh", host: "10.0.0.11" }] }),
        makeDevice({ externalId: "device:f2", name: "f2", endpoints: [{ kind: "ssh", host: "10.0.0.12" }] }),
        makeDevice({ externalId: "device:k", name: "k", endpoints: [{ kind: "ssh", host: "10.0.0.20" }] }),
        makeDevice({ externalId: "device:h", name: "h", endpoints: [{ kind: "ssh", host: "10.0.0.30" }] }),
        makeDevice({ externalId: "device:h2", name: "h2", endpoints: [{ kind: "ssh", host: "10.0.0.31" }] })
      ],
      servers: [filler1, filler2, K, handNoStamp, handOtherStamp],
      authProfiles: [keylessB]
    });
    expect(afterFor(p, kId)!.authProfileId).toBeUndefined(); // retained link rolled back
    expect(p.warnings.some((w) => w.includes("no longer configured") && w.includes('"B"'))).toBe(true);
    // Hand links stay.
    expect((afterFor(p, hId) ?? handNoStamp).authProfileId).toBe("B");
    expect((afterFor(p, h2Id) ?? handOtherStamp).authProfileId).toBe("B");
  });

  it("Fixture 14c (variant) — a retained link left in place by an A-M1 fill swap reaches the same rollback (kills a scan that only reads the current winner)", () => {
    const keylessB = authProfile("B", { authType: "key", keyPath: undefined });
    const kId = deterministicServerId("source-1", "device:k");
    const K = ownedServer({ id: kId, authProfileId: "B" }, { externalId: "device:k", syncedAuthProfileId: "B" });
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice({ externalId: "device:k", name: "k" })],
      servers: [K],
      // A fill rule naming A leaves K's link at B (A-M1), so B is referenced by
      // nothing current — reached only as a retained sync-owned link.
      templates: [template({ authProfileId: { mode: "fill", value: "A" } })],
      authProfiles: [keylessB, authProfile("A")]
    });
    expect(afterFor(p, kId)!.authProfileId).toBeUndefined();
  });

  it("Fixture 14c-bis — a keyless SOURCE profile's existing sync-owned links: no-own-key unlinked (named as source), own-key retained, no new stamp (kills a set built from the post-1b zeroed id)", () => {
    // NOTE: this fixture's pre-pass walks ALL owned servers, so term (c) also
    // reaches S — both routes reach S here. The SOURCE referrer (which comes
    // from term (a), the pre-1b matchedProfile) is what distinguishes them, so
    // that is what is asserted. If a future optimization narrows the pre-pass to
    // mapped servers only, term (a) becomes the sole route for K-when-unmapped.
    const keylessS = authProfile("S", { authType: "key", keyPath: undefined });
    const kId = deterministicServerId("source-1", "device:k");
    const xId = deterministicServerId("source-1", "device:x");
    const K = ownedServer({ id: kId, authProfileId: "S" }, { externalId: "device:k", syncedAuthProfileId: "S" });
    const X = ownedServer({ id: xId, authProfileId: "S", keyPath: "~/.ssh/id_x" }, { externalId: "device:x", syncedAuthProfileId: "S" });

    const runWith = (kEndpointless: boolean): InventorySyncPlan =>
      plan({
        source: makeSource({ authProfileId: "S" }),
        devices: [
          makeDevice({ externalId: "device:k", name: "k", endpoints: kEndpointless ? [] : [{ kind: "ssh", host: "10.0.0.20" }] }),
          makeDevice({ externalId: "device:x", name: "x", endpoints: [{ kind: "ssh", host: "10.0.0.21" }] })
        ],
        servers: [K, X],
        authProfiles: [keylessS],
        authProfile: keylessS
      });

    for (const kEndpointless of [false, true]) {
      const p = runWith(kEndpointless);
      expect(afterFor(p, kId)!.authProfileId).toBeUndefined(); // K unlinked
      expect((afterFor(p, xId) ?? X).authProfileId).toBe("S"); // X retains (own key)
      // No NEW link to S stamped anywhere (AUTH 1b still refuses the keyless stamp).
      expect(p.adds.every((a) => a.authProfileId !== "S")).toBe(true);
      // Warning names S with the SOURCE referrer wording ("servers this source creates").
      expect(p.warnings.some((w) => w.includes('"S"') && w.includes("servers this source creates"))).toBe(true);
    }
  });

  it("Fixture 14d — a sync-time OVERRIDE move onto a keyless profile is judged PER TARGET: own-key moves, no-own-key stays + warns; a FILL rule never stamps it (kills the blanket per-profile refusal and its 'generalize onto fill' inverse)", () => {
    const keylessB = authProfile("B", { authType: "key", keyPath: undefined });
    const xId = deterministicServerId("source-1", "device:x");
    const yId = deterministicServerId("source-1", "device:y");
    const zId = deterministicServerId("source-1", "device:z");
    // X and Y both sync-owned linked to A (row-3 material); X has since gained
    // its own keyPath (a hand edit that leaves the LINK's sync ownership intact).
    const X = ownedServer({ id: xId, authProfileId: "A", keyPath: "~/.ssh/id_x" }, { externalId: "device:x", syncedAuthProfileId: "A" });
    const Y = ownedServer({ id: yId, authProfileId: "A" }, { externalId: "device:y", syncedAuthProfileId: "A" });
    // Z is never-configured (the fill sibling).
    const Z = ownedServer({ id: zId }, { externalId: "device:z" });

    // Override arm: X (own key) and Y (no key) both linked A, override rule → B.
    const direct = computeSyncPlan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      tree: tree([
        makeDevice({ externalId: "device:x", name: "x-r", endpoints: [{ kind: "ssh", host: "10.0.0.21" }] }),
        makeDevice({ externalId: "device:y", name: "y-r", endpoints: [{ kind: "ssh", host: "10.0.0.22" }] })
      ]),
      currentServers: [X, Y],
      now: 5000,
      templatesById: new Map([["tmpl-1", template({ authProfileId: { mode: "override", value: "B" } })]]),
      authProfilesById: new Map([["A", authProfile("A")], ["B", keylessB]])
    });
    // X (own key) moves to B and re-stamps; retained by AUTH 2b (cross-check 14c).
    const afterX = direct.updates.find((u) => u.before.id === xId)!.after;
    expect(afterX.authProfileId).toBe("B");
    expect(afterX.origin?.syncedAuthProfileId).toBe("B");
    // Y (no own key) stays A, un-re-stamped, with a plan warning naming B.
    expect((direct.updates.find((u) => u.before.id === yId)?.after ?? Y).authProfileId).toBe("A");
    expect(direct.warnings.some((w) => w.includes('"B"') && w.includes("left unchanged"))).toBe(true);

    // FILL sibling: the same keyless B named by a fill rule against a
    // never-configured server is NOT stamped (blanket per-profile check stays).
    const fill = computeSyncPlan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      tree: tree([makeDevice({ externalId: "device:z", name: "z-r", endpoints: [{ kind: "ssh", host: "10.0.0.23" }] })]),
      currentServers: [Z],
      now: 5000,
      templatesById: new Map([["tmpl-1", template({ authProfileId: { mode: "fill", value: "B" } })]]),
      authProfilesById: new Map([["B", keylessB]])
    });
    expect((fill.updates.find((u) => u.before.id === zId)?.after ?? Z).authProfileId).toBeUndefined();
  });
});

// -------- Fail-closed filtered-rule skip (§7.2) --------

describe("fail-closed filtered-rule skip — §7.2 rev11", () => {
  it("Fixture 19b — a filtered rule (no matcher in T1) is SKIPPED, a catch-all rule applies, and exactly one warning names the filtered rule (kills treat-unparseable-as-catch-all)", () => {
    // The filtered rule F would WIN proxy if wrongly treated as a catch-all (its
    // id sorts first), and its value differs from the catch-all C's — so the
    // outcome is visibly wrong under the bug.
    const F = template({ proxy: { mode: "override", value: P_B } }, "tmpl-F", "F");
    const C = template({ proxy: { mode: "override", value: P_C } }, "tmpl-C", "C");
    const p = plan({
      source: makeSource({
        templateRules: [
          { id: "aaa", templateId: "tmpl-F", filter: "role=switch" },
          { id: "zzz", templateId: "tmpl-C" }
        ]
      }),
      devices: [makeDevice({ externalId: "device:new", name: "new-sw" })],
      servers: [],
      templates: [F, C]
    });
    expect(p.adds.length).toBe(1);
    expect(p.adds[0].proxy).toEqual(P_C); // C applied; F skipped
    const skipWarnings = p.warnings.filter((w) => w.includes("cannot evaluate") && w.includes("role=switch"));
    expect(skipWarnings.length).toBe(1);
  });
});

// -------- §5.3 proxy reference validation (skip-and-warn) --------

describe("§5.3 proxy reference validation — dangling / self-referential jumpHostId", () => {
  const sshProxy = (jumpHostId: string): ProxyConfig => ({ type: "ssh", jumpHostId });
  // The id a fresh add for the default device:1 will carry — a proxy pointing
  // here routes the server through itself.
  const SELF_ID = deterministicServerId("source-1", "device:1");

  it("Fixture 29 — a catch-all override proxy whose jumpHostId IS the target's own id is SKIPPED per-device, its sibling fields still apply, one self-reference warning (kills 'write the self-proxy')", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()], // fresh add of device:1
      servers: [],
      templates: [template({ proxy: { mode: "override", value: sshProxy(SELF_ID) }, multiplexing: { mode: "fill", value: true } })]
    });
    expect(p.adds.length).toBe(1);
    expect(p.adds[0].proxy).toBeUndefined(); // self-proxy NOT written
    expect(p.adds[0].multiplexing).toBe(true); // sibling field still applied
    const selfWarnings = p.warnings.filter((w) => w.includes("through itself"));
    expect(selfWarnings.length).toBe(1);
  });

  it("Fixture 30 — a catch-all override proxy with a DANGLING jumpHostId is SKIPPED, its sibling fields still apply, one dangling warning (kills 'write the dangling proxy')", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [],
      templates: [template({ proxy: { mode: "override", value: sshProxy("no-such-server") }, multiplexing: { mode: "fill", value: true } })]
    });
    expect(p.adds.length).toBe(1);
    expect(p.adds[0].proxy).toBeUndefined(); // dangling proxy NOT written
    expect(p.adds[0].multiplexing).toBe(true);
    const dangleWarnings = p.warnings.filter((w) => w.includes("jump host no longer exists"));
    expect(dangleWarnings.length).toBe(1);
  });

  it("Fixture 31 — a catch-all override proxy with a VALID, non-self jumpHostId is written unchanged (kills an over-broad skip)", () => {
    const bastion: ServerConfig = {
      id: "bastion-1",
      name: "bastion",
      host: "10.0.0.99",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false
    };
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice({ externalId: "device:2", name: "sw-2" })],
      servers: [bastion],
      templates: [template({ proxy: { mode: "override", value: sshProxy("bastion-1") } })]
    });
    const added = p.adds.find((s) => s.name === "sw-2")!;
    expect(added.proxy).toEqual(sshProxy("bastion-1"));
    expect(p.warnings.filter((w) => w.includes("through itself") || w.includes("jump host no longer exists")).length).toBe(0);
  });

  it("Fixture 32 — an existing sync-owned proxy is KEPT (row 5 carry) when a new override rule's proxy is dangling; 'desired none' is NOT a written undefined (kills clobber-to-undefined)", () => {
    const server = ownedServer({ proxy: P_A }, { templated: { proxy: P_A } }); // sync-owned socks5 proxy
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [server],
      templates: [template({ proxy: { mode: "override", value: sshProxy("no-such-server") } })]
    });
    const after = afterFor(p, server.id) ?? server;
    expect(after.proxy).toEqual(P_A); // existing proxy kept, NOT clobbered to the dangling proxy or to undefined
    expect(after.origin?.templated?.proxy).toEqual(P_A); // stamp carried forward
  });
});

// -------- clearTemplatedStamps (§5.1, unit-tested, wired to nothing) --------

describe("clearTemplatedStamps — §5.1 (manual path helper; not wired in T1)", () => {
  const origin = (): ServerOrigin => ({
    sourceId: "s",
    externalId: "d",
    syncedAt: 1,
    syncedAuthProfileId: "A",
    templated: { proxy: P_A, multiplexing: true }
  });

  it("clears the written non-auth stamps and the auth stamp; drops an emptied templated record", () => {
    const cleared = clearTemplatedStamps(origin(), ["proxy", "multiplexing", "authProfileId"]);
    expect(cleared?.templated).toBeUndefined();
    expect(cleared?.syncedAuthProfileId).toBeUndefined();
  });

  it("is SCOPED to written fields — an unwritten stamp survives (kills a blanket delete of templated)", () => {
    const cleared = clearTemplatedStamps(origin(), ["multiplexing"]);
    expect(cleared?.templated?.proxy).toEqual(P_A);
    expect(cleared?.templated?.multiplexing).toBeUndefined();
    expect(cleared?.syncedAuthProfileId).toBe("A"); // auth not written → stamp kept
  });

  it("is a no-op on a server with no origin", () => {
    expect(clearTemplatedStamps(undefined, ["proxy"])).toBeUndefined();
  });
});
