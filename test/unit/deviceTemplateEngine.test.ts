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
  adoptionChoice?: "adopt" | "decline";
  providerInstanceKey?: string;
}

function plan(opts: PlanOpts): InventorySyncPlan {
  return computeSyncPlan({
    source: opts.source,
    tree: tree(opts.devices),
    currentServers: opts.servers ?? [],
    now: 5000,
    authProfile: opts.authProfile,
    adoptionChoice: opts.adoptionChoice,
    providerInstanceKey: opts.providerInstanceKey,
    templatesById: new Map((opts.templates ?? []).map((t) => [t.id, t] as const)),
    authProfilesById: new Map((opts.authProfiles ?? []).map((p) => [p.id, p] as const))
  });
}

/** DEVICE_INSTANCE — the NetBox deployment the Fix 1 adoption fixtures record and sync against. */
const DEVICE_INSTANCE = "https://netbox.example.com";

/**
 * A "Keep Servers" kept record: no origin, a `formerlySynced` marker naming this
 * device/provider/instance, at the device's address, agent auth, no key. Adoptable
 * by a source of the same provider+instance when `adoptionChoice: "adopt"`.
 */
function keptServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "kept-1",
    name: "old-name",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    authType: "agent",
    isHidden: false,
    formerlySynced: {
      sourceId: "removed-source",
      sourceName: "NetBox (removed)",
      providerId: "netbox",
      instanceKey: DEVICE_INSTANCE,
      externalId: "device:1",
      detachedAt: 900
    },
    ...overrides
  };
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

// -------- FIX 3 (PR #61 Codex) — update-path self-proxy uses the OWNED record's id --------

describe("FIX 3 — self-proxy detection on the update path uses ownedServer.id, not the deterministic id", () => {
  const sshProxy = (jumpHostId: string): ProxyConfig => ({ type: "ssh", jumpHostId });

  it("Fixture 33 — an owned server whose id was PRESERVED (id ≠ deterministic id) with a catch-all override proxy pointing at its OWN id is SKIPPED as a self-reference; sibling field still applies (kills passing the computed `id`, which writes the self-proxy)", () => {
    // Preserved-id owned server (adoptee kept its id, or an ID-preserving import):
    // ownedServer.id "preserved-id" ≠ deterministicServerId("source-1","device:1").
    const owned = ownedServer({ id: "preserved-id", proxy: undefined }, { templated: undefined });
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()], // maps to the owned server (update path)
      servers: [owned],
      templates: [template({ proxy: { mode: "override", value: sshProxy("preserved-id") }, multiplexing: { mode: "fill", value: true } })]
    });
    const after = afterFor(p, "preserved-id")!;
    expect(after.proxy).toBeUndefined(); // self-proxy NOT written
    expect(after.multiplexing).toBe(true); // sibling field still applied
    expect(p.warnings.filter((w) => w.includes("through itself")).length).toBe(1);
  });
});

// -------- Codex round 5 (P2) — a template-OWNED self-proxy already on the record is REPAIRED, not carried --------

describe("§5.3 repair — a template-owned self-proxy already carried is cleared (not re-skipped forever)", () => {
  const sshProxy = (jumpHostId: string): ProxyConfig => ({ type: "ssh", jumpHostId });
  const SELF_ID = deterministicServerId("source-1", "device:1");

  it("Fixture 45 — an owned server that ALREADY carries a template-owned self-proxy (proxy === origin.templated.proxy, both self-ref) is REPAIRED: after.proxy absent, stamp absent, 'cleared' warning, lands in updates (kills the row-5 carry that keeps a self-proxy the runtime refuses)", () => {
    // Both the live proxy and the stamp are the same self-referential ssh proxy —
    // an owned server imported from a backup written by a buggy earlier build, or
    // an adopted server whose receipt carried one. b3181d3 skips + row-5-carries it.
    const owned = ownedServer({ proxy: sshProxy(SELF_ID) }, { templated: { proxy: sshProxy(SELF_ID) } });
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()], // maps to the owned server (update path)
      servers: [owned],
      templates: [template({ proxy: { mode: "override", value: sshProxy(SELF_ID) } })]
    });
    const after = afterFor(p, SELF_ID);
    expect(after).toBeDefined(); // promoted to an update — the repair lands
    expect(after!.proxy).toBeUndefined(); // self-proxy CLEARED, not carried
    expect(after!.origin?.templated?.proxy).toBeUndefined(); // stamp dropped with it
    expect(p.warnings.filter((w) => w.includes("through itself") && w.includes("was cleared")).length).toBe(1);
    expect(p.warnings.filter((w) => w.includes("the proxy field was skipped")).length).toBe(0);
  });

  it("Fixture 46 — adoption variant: an adoptee whose RESTORED receipt carries a template-owned self-proxy is repaired at adoption (after.proxy absent, stamp absent, 'cleared' warning)", () => {
    const kept = keptServer({
      proxy: sshProxy("kept-1"), // self-referential: jumpHostId === adoptee's own id
      formerlySynced: {
        sourceId: "removed-source",
        sourceName: "NetBox (removed)",
        providerId: "netbox",
        instanceKey: DEVICE_INSTANCE,
        externalId: "device:1",
        templated: { proxy: sshProxy("kept-1") }, // the receipt says the sync wrote it
        detachedAt: 900
      }
    });
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [kept],
      templates: [template({ proxy: { mode: "override", value: sshProxy("kept-1") } })],
      adoptionChoice: "adopt",
      providerInstanceKey: DEVICE_INSTANCE
    });
    const after = afterFor(p, "kept-1")!;
    expect(after.proxy).toBeUndefined(); // repaired at adoption
    expect(after.origin?.templated?.proxy).toBeUndefined();
    expect(p.warnings.filter((w) => w.includes("through itself") && w.includes("was cleared")).length).toBe(1);
  });

  it("Fixture 47 — §8.4 guard: a HAND-set self-proxy (proxy self-ref, origin.templated.proxy ABSENT) is LEFT ALONE — 'skipped' warning, not 'cleared', server unchanged (kills clearing a hand proxy)", () => {
    // proxy is a self-ref but no template stamp names it → not template-owned.
    const owned = ownedServer({ proxy: sshProxy(SELF_ID) }, { templated: undefined });
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [owned],
      templates: [template({ proxy: { mode: "override", value: sshProxy(SELF_ID) } })]
    });
    expect(afterFor(p, SELF_ID)).toBeUndefined(); // untouched — no update
    expect(p.unchangedCount).toBe(1);
    expect(p.warnings.filter((w) => w.includes("the proxy field was skipped")).length).toBe(1);
    expect(p.warnings.filter((w) => w.includes("was cleared")).length).toBe(0);
  });

  it("Fixture 48 — a template-owned NON-self proxy (valid jump host, stamp matches) is carried untouched — the repair branch never fires for it (kills an over-broad clear)", () => {
    const bastion: ServerConfig = { id: "bastion-1", name: "bastion", host: "10.0.0.99", port: 22, username: "admin", authType: "agent", isHidden: false };
    // Owned server carries a template-owned valid ssh proxy; the template still wants it (row 4 no-op).
    const owned = ownedServer({ proxy: sshProxy("bastion-1") }, { templated: { proxy: sshProxy("bastion-1") } });
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [owned, bastion],
      templates: [template({ proxy: { mode: "override", value: sshProxy("bastion-1") } })]
    });
    const after = afterFor(p, SELF_ID);
    // Row 4 no-op → unchanged; the proxy is neither cleared nor re-written.
    expect(after).toBeUndefined();
    expect(p.warnings.filter((w) => w.includes("was cleared") || w.includes("through itself")).length).toBe(0);
  });
});

// -------- FIX 1 (PR #61 Codex) — adoption applies the template matrix + auth winner --------

describe("FIX 1 — adoption branch consumes the template cascade (proxy / booleans / auth), stamped", () => {
  const sshProxy = (jumpHostId: string): ProxyConfig => ({ type: "ssh", jumpHostId });
  const bastion: ServerConfig = { id: "bastion-1", name: "bastion", host: "10.9.9.9", port: 22, username: "admin", authType: "agent", isHidden: false };

  it("Fixture 34 — adopting a kept server under a catch-all OVERRIDE template applies its proxy, boolean and explicit auth link, each STAMPED (kills the shipped 'adoption defers templates' — leaves them unapplied)", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [keptServer(), bastion],
      templates: [
        template({
          proxy: { mode: "override", value: sshProxy("bastion-1") },
          multiplexing: { mode: "override", value: true },
          authProfileId: { mode: "override", value: "p-explicit" }
        })
      ],
      authProfiles: [authProfile("p-explicit")],
      adoptionChoice: "adopt",
      providerInstanceKey: DEVICE_INSTANCE
    });
    const after = afterFor(p, "kept-1")!;
    // Non-auth values applied AND stamped.
    expect(after.proxy).toEqual(sshProxy("bastion-1"));
    expect(after.origin?.templated?.proxy).toEqual(sshProxy("bastion-1"));
    expect(after.multiplexing).toBe(true);
    expect(after.origin?.templated?.multiplexing).toBe(true);
    // Auth link applied AND stamped (the cascade winner, restored into the origin
    // rebuild rather than lost).
    expect(after.authProfileId).toBe("p-explicit");
    expect(after.origin?.syncedAuthProfileId).toBe("p-explicit");
  });

  it("Fixture 35 — adopting under a catch-all FILL template does NOT overwrite the adoptee's existing proxy (fill write-once), but DOES fill an unset boolean (kills applying fill over a configured field on the adoption path)", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [keptServer({ proxy: P_A }), bastion],
      templates: [
        template({
          proxy: { mode: "fill", value: sshProxy("bastion-1") },
          multiplexing: { mode: "fill", value: true }
        })
      ],
      adoptionChoice: "adopt",
      providerInstanceKey: DEVICE_INSTANCE
    });
    const after = afterFor(p, "kept-1")!;
    expect(after.proxy).toEqual(P_A); // existing proxy kept (fill write-once)
    expect(after.origin?.templated?.proxy).toBeUndefined(); // nothing stamped for a field left alone
    expect(after.multiplexing).toBe(true); // unset boolean filled
    expect(after.origin?.templated?.multiplexing).toBe(true);
  });

  it("Fixture 36 — a FILL auth link is NOT applied to an adoptee with a hand-configured login (username ≠ baseline) — the six AUTH 2 clauses hold on the adoption path (kills bypassing eligibility for a fill link)", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [keptServer({ username: "custom" })], // hand-configured login ≠ source default "admin"
      templates: [template({ authProfileId: { mode: "fill", value: "p1" } })],
      authProfiles: [authProfile("p1")],
      adoptionChoice: "adopt",
      providerInstanceKey: DEVICE_INSTANCE
    });
    const after = afterFor(p, "kept-1")!;
    expect(after.authProfileId).toBeUndefined(); // fill refused — the login is hand-configured
    expect(after.origin?.syncedAuthProfileId).toBeUndefined();
  });
});

// -------- FIX A (PR #61 Codex round 2) — the detach preserves `templated`, adoption restores it --------

describe("FIX A — `origin.templated` survives the Keep-Servers detach and is restored on adoption", () => {
  it("Fixture 41 — a kept server whose marker preserves `templated.proxy` = P is re-adopted; an OVERRIDE template that edited the proxy to P′ RECLAIMS it (row 3) and re-stamps (kills the round-2 slip where the stamp was lost and the field read row 7, refusing P′)", () => {
    // The kept record still carries the sync-applied proxy P_A, and the marker
    // preserves that the SYNC wrote it — the receipt member Fix A adds.
    const kept = keptServer({
      proxy: P_A,
      formerlySynced: {
        sourceId: "removed-source",
        sourceName: "NetBox (removed)",
        providerId: "netbox",
        instanceKey: DEVICE_INSTANCE,
        externalId: "device:1",
        templated: { proxy: P_A },
        detachedAt: 900
      }
    });
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [kept],
      templates: [template({ proxy: { mode: "override", value: P_B } })],
      adoptionChoice: "adopt",
      providerInstanceKey: DEVICE_INSTANCE
    });
    const after = afterFor(p, "kept-1")!;
    // Reclaimed: the override winner rewrites the still-sync-owned proxy...
    expect(after.proxy).toEqual(P_B);
    // ...AND re-stamps it, so ownership is preserved for the next sync too.
    expect(after.origin?.templated?.proxy).toEqual(P_B);
  });

  it("Fixture 42 — a HAND-EDITED field the sync never template-managed stays row 7 after adoption; an override does NOT reclaim it (guards against restoring provenance too broadly)", () => {
    // The kept record carries proxy P_A that was NEVER a template write: the
    // marker preserves no `templated` for it (only a boolean stamp, to prove the
    // marker itself is well-formed and does carry templated for other fields).
    const kept = keptServer({
      proxy: P_A,
      formerlySynced: {
        sourceId: "removed-source",
        sourceName: "NetBox (removed)",
        providerId: "netbox",
        instanceKey: DEVICE_INSTANCE,
        externalId: "device:1",
        templated: { multiplexing: true }, // a stamp for a DIFFERENT field — proxy is hand-owned
        detachedAt: 900
      }
    });
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [kept],
      templates: [template({ proxy: { mode: "override", value: P_B } })],
      adoptionChoice: "adopt",
      providerInstanceKey: DEVICE_INSTANCE
    });
    const after = afterFor(p, "kept-1")!;
    // Hand-owned proxy (no proxy stamp in the marker) is left untouched by the override.
    expect(after.proxy).toEqual(P_A);
    expect(after.origin?.templated?.proxy).toBeUndefined();
  });

  it("Fixture 43 — a marker carrying NO `templated` restores none: a fresh template fills an unset field (row 1) and leaves a pre-existing hand value (row 7) (guards the 'restore verbatim, never invent' rule)", () => {
    // No `templated` in the marker at all — bit-identical to a server no template
    // ever touched. The adoptee has a hand proxy P_A (unstamped) and an UNSET
    // multiplexing.
    const kept = keptServer({ proxy: P_A, multiplexing: undefined });
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [kept],
      templates: [
        template({ proxy: { mode: "fill", value: P_B }, multiplexing: { mode: "fill", value: true } })
      ],
      adoptionChoice: "adopt",
      providerInstanceKey: DEVICE_INSTANCE
    });
    const after = afterFor(p, "kept-1")!;
    // Hand proxy left (fill never rewrites a configured field — and nothing was restored to claim it either).
    expect(after.proxy).toEqual(P_A);
    expect(after.origin?.templated?.proxy).toBeUndefined();
    // Unset boolean filled + stamped (row 1).
    expect(after.multiplexing).toBe(true);
    expect(after.origin?.templated?.multiplexing).toBe(true);
  });
});

// -------- FIX A (PR #61 Codex round 3) — adoption applies an OVERRIDE auth winner, not only FILL --------

describe("FIX A (round 3) — adoption runs the full auth matrix: an OVERRIDE winner MOVES a sync-owned link", () => {
  /** A kept record still carrying the sync-applied link A, whose marker preserves that a SYNC linked A. */
  const keptLinkedA = (over: Partial<ServerConfig> = {}, syncedAuthProfileId: string | undefined = "A"): ServerConfig =>
    keptServer({
      authProfileId: "A",
      formerlySynced: {
        sourceId: "removed-source",
        sourceName: "NetBox (removed)",
        providerId: "netbox",
        instanceKey: DEVICE_INSTANCE,
        externalId: "device:1",
        ...(syncedAuthProfileId === undefined ? {} : { syncedAuthProfileId }),
        detachedAt: 900
      },
      ...over
    });

  it("Fixture 44 — a kept server whose marker proves the link A was sync-owned is MOVED A→B by an OVERRIDE template + re-stamped (kills the fill-only adoption path that leaves it at A until the next sync)", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [keptLinkedA()],
      templates: [template({ authProfileId: { mode: "override", value: "B" } })],
      authProfiles: [authProfile("A"), authProfile("B")],
      adoptionChoice: "adopt",
      providerInstanceKey: DEVICE_INSTANCE
    });
    const after = afterFor(p, "kept-1")!;
    // THE FIX — override reclaims the sync-owned link and re-stamps.
    expect(after.authProfileId).toBe("B");
    expect(after.origin?.syncedAuthProfileId).toBe("B");
  });

  it("Fixture 45 — a FILL winner naming B does NOT move the adoptee's configured sync-owned link A (fill write-once — guards the fix over-applying)", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [keptLinkedA()],
      templates: [template({ authProfileId: { mode: "fill", value: "B" } })],
      authProfiles: [authProfile("A"), authProfile("B")],
      adoptionChoice: "adopt",
      providerInstanceKey: DEVICE_INSTANCE
    });
    const after = afterFor(p, "kept-1")!;
    expect(after.authProfileId).toBe("A"); // fill never moves a configured link
    expect(after.origin?.syncedAuthProfileId).toBe("A"); // restored stamp stands
  });

  it("Fixture 46 — a HAND-linked adoptee (marker stamp = C ≠ current link A) is left at A even by an OVERRIDE template (rows 6/7 on the adoption path)", () => {
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [keptLinkedA({}, "C")], // marker says the SYNC linked C; the current A is the user's hand edit
      templates: [template({ authProfileId: { mode: "override", value: "B" } })],
      authProfiles: [authProfile("A"), authProfile("B"), authProfile("C")],
      adoptionChoice: "adopt",
      providerInstanceKey: DEVICE_INSTANCE
    });
    const after = afterFor(p, "kept-1")!;
    expect(after.authProfileId).toBe("A"); // override never moves a hand link
  });

  it("Fixture 47 — the OVERRIDE move onto a KEYLESS profile is judged PER TARGET on adoption: an adoptee with its own key moves to B, one without stays A + warning (§4.4 rev7 on the adoption path)", () => {
    const keylessB = authProfile("B", { authType: "key", keyPath: undefined });
    const keptX = keptLinkedA({ id: "kept-x", host: "10.0.0.21", keyPath: "~/.ssh/id_x" });
    keptX.formerlySynced = { ...keptX.formerlySynced!, externalId: "device:x" };
    const keptY = keptLinkedA({ id: "kept-y", host: "10.0.0.22" });
    keptY.formerlySynced = { ...keptY.formerlySynced!, externalId: "device:y" };
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [
        makeDevice({ externalId: "device:x", name: "x-r", endpoints: [{ kind: "ssh", host: "10.0.0.21" }] }),
        makeDevice({ externalId: "device:y", name: "y-r", endpoints: [{ kind: "ssh", host: "10.0.0.22" }] })
      ],
      servers: [keptX, keptY],
      templates: [template({ authProfileId: { mode: "override", value: "B" } })],
      authProfiles: [authProfile("A"), keylessB],
      adoptionChoice: "adopt",
      providerInstanceKey: DEVICE_INSTANCE
    });
    // X brings its own key → the keyless B is usable for it → moves + re-stamps.
    const afterX = afterFor(p, "kept-x")!;
    expect(afterX.authProfileId).toBe("B");
    expect(afterX.origin?.syncedAuthProfileId).toBe("B");
    // Y brings no key → refused per target → stays A (restored stamp stands) + plan warning.
    const afterY = afterFor(p, "kept-y")!;
    expect(afterY.authProfileId).toBe("A");
    expect(afterY.origin?.syncedAuthProfileId).toBe("A");
    expect(p.warnings.some((w) => w.includes('"B"') && w.includes("left unchanged"))).toBe(true);
  });
});

// -------- FIX 2 (PR #61 Codex) — post-plan jump-host survivor validation --------

describe("FIX 2 — jump-host references validated against the POST-PLAN survivor set", () => {
  const sshProxy = (jumpHostId: string): ProxyConfig => ({ type: "ssh", jumpHostId });
  const JUMP_ID = deterministicServerId("source-1", "device:jump");

  it("Fixture 37 — a template ssh proxy whose jump host is an owned server the SAME plan PRUNES (delete policy) is NOT written to the templated servers; one survivor warning (kills validating against the pre-prune set, which writes the proxy)", () => {
    // The jump host: owned by this source, its device absent from the tree, so it
    // is pruned under delete policy.
    const jumpHost = ownedServer({ id: JUMP_ID }, { externalId: "device:jump" });
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()], // device:1 → fresh add, gets the template proxy → JUMP_ID
      servers: [jumpHost],
      templates: [template({ proxy: { mode: "override", value: sshProxy(JUMP_ID) } })]
    });
    // The jump host is pruned...
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === JUMP_ID)).toBe(true);
    // ...so the freshly-added server's proxy pointing at it is dropped (field absent).
    const added = p.adds.find((s) => s.origin?.externalId === "device:1")!;
    expect(added.proxy).toBeUndefined();
    expect("proxy" in added).toBe(false); // absent, never a written undefined
    expect(added.origin?.templated?.proxy).toBeUndefined();
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(1);
  });

  it("Fixture 38 — a template ssh proxy whose jump host is a device SKIPPED this run (invalid port) is NOT written + one survivor warning (kills counting a skipped device's id as live)", () => {
    const SKIP_ID = deterministicServerId("source-1", "device:skip");
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [
        makeDevice(), // device:1 → add, gets proxy → SKIP_ID
        makeDevice({ externalId: "device:skip", name: "skipme", endpoints: [{ kind: "ssh", host: "10.0.0.9", port: 0 }] }) // invalid port → skipped
      ],
      servers: [],
      templates: [template({ proxy: { mode: "override", value: sshProxy(SKIP_ID) } })]
    });
    const added = p.adds.find((s) => s.origin?.externalId === "device:1")!;
    expect(added.proxy).toBeUndefined();
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(1);
  });

  it("Fixture 39 — a template ssh proxy whose jump host is a device ADDED this run IS written (the freshly-synced jump host survives; kills an over-broad drop)", () => {
    const JUMP2_ID = deterministicServerId("source-1", "device:2");
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [
        makeDevice(), // device:1 → add, gets proxy → device:2's id (survives)
        makeDevice({ externalId: "device:2", name: "jump-2", endpoints: [{ kind: "ssh", host: "10.0.0.2" }] })
      ],
      servers: [],
      templates: [template({ proxy: { mode: "override", value: sshProxy(JUMP2_ID) } })]
    });
    const added = p.adds.find((s) => s.origin?.externalId === "device:1")!;
    expect(added.proxy).toEqual(sshProxy(JUMP2_ID)); // written — the jump host is a fresh add, a survivor
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(0);
  });

  it("Fixture 40 — a HAND-SET proxy (no template stamp) pointing at a pruned server is left UNTOUCHED by the pass, while a template-owned proxy at the same jump host IS dropped (kills touching a proxy the template didn't write this run)", () => {
    const jumpHost = ownedServer({ id: JUMP_ID }, { externalId: "device:jump" });
    // An owned server carrying a HAND-SET ssh proxy → JUMP_ID (no origin.templated stamp).
    // A template boolean write makes it appear in `updates` so its proxy is observable.
    const handServer = ownedServer(
      { id: "hand-1", proxy: sshProxy(JUMP_ID), multiplexing: undefined },
      { externalId: "device:hand" }
    );
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule("tmpl-1")] }),
      devices: [
        makeDevice(), // device:1 → fresh add, template-owned proxy → JUMP_ID (dropped)
        makeDevice({ externalId: "device:hand", name: "hand-dev", endpoints: [{ kind: "ssh", host: "10.0.0.1" }] })
      ],
      servers: [jumpHost, handServer],
      templates: [
        template({ proxy: { mode: "override", value: sshProxy(JUMP_ID) }, multiplexing: { mode: "fill", value: true } })
      ]
    });
    // The hand-set proxy is left exactly as configured (no stamp = not a template write).
    const handAfter = afterFor(p, "hand-1")!;
    expect(handAfter.proxy).toEqual(sshProxy(JUMP_ID));
    expect(handAfter.multiplexing).toBe(true); // the boolean write did land
    // The template-owned proxy on the fresh add is dropped.
    const added = p.adds.find((s) => s.origin?.externalId === "device:1")!;
    expect(added.proxy).toBeUndefined();
  });
});

// -------- Codex round 6 (P1) — an UPDATE whose matrix MOVED a working proxy A→B (B dangling) RESTORES A, does not delete --------

describe("Codex round 6 — the survivor pass RESTORES the pre-matrix proxy A on a rejected override move, instead of deleting to absent", () => {
  const sshProxy = (jumpHostId: string): ProxyConfig => ({ type: "ssh", jumpHostId });
  const S_ID = deterministicServerId("source-1", "device:1");
  const A_JUMP_ID = deterministicServerId("source-1", "device:ajump-unused"); // never a device this run
  const B_JUMP_ID = deterministicServerId("source-1", "device:bjump");

  // A survivor jump host that is NOT a device of this source this run — a plain
  // live server, so it is never pruned and never a template target, only a live id
  // the pre-existing proxy A resolves against.
  const survivorJump = (): ServerConfig => ({
    id: A_JUMP_ID,
    name: "a-jump",
    host: "10.0.0.8",
    port: 22,
    username: "admin",
    authType: "agent",
    isHidden: false
  });

  // B_JUMP: owned by this source, device ABSENT from the tree → delete-pruned this
  // run, hence in the OPTIMISTIC composition set but NOT a post-plan survivor.
  const danglingJump = (): ServerConfig => ownedServer({ id: B_JUMP_ID }, { externalId: "device:bjump" });

  it("Fixture 50 — REGRESSION: S has a working template-owned proxy A; an OVERRIDE template moves it to B; B is delete-pruned → S.after.proxy is RESTORED to A (+ stamp A), not deleted; a survivor warning fires (kills the round-2 delete-to-absent, which strips A fleet-wide)", () => {
    // S already carries a working template-owned proxy A (stamp = A). A boolean
    // template write also lands, so the update SURVIVES the no-op collapse and
    // `after` is observable.
    const s = ownedServer({ proxy: sshProxy(A_JUMP_ID) }, { externalId: "device:1", templated: { proxy: sshProxy(A_JUMP_ID) } });
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()], // device:1 → S; device:bjump absent → B_JUMP delete-pruned
      servers: [s, survivorJump(), danglingJump()],
      templates: [
        template({ proxy: { mode: "override", value: sshProxy(B_JUMP_ID) }, multiplexing: { mode: "fill", value: true } })
      ]
    });
    // B_JUMP is delete-pruned (a non-survivor).
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === B_JUMP_ID)).toBe(true);
    const after = afterFor(p, S_ID)!;
    expect(after).toBeDefined();
    // THE FIX: the pre-matrix proxy A is restored, NOT deleted to absent.
    expect(after.proxy).toEqual(sshProxy(A_JUMP_ID));
    expect(after.origin?.templated?.proxy).toEqual(sshProxy(A_JUMP_ID)); // stamp follows the restored value
    expect(after.multiplexing).toBe(true); // the other template write still landed
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(1);
  });

  it("Fixture 51 — NO-OP COLLAPSE: A→B was the ONLY change; restoring A reverts it → S is removed from `updates` and counted UNCHANGED (kills leaving a now-no-op update in the plan, and kills the round-2 delete which keeps S in updates with proxy absent)", () => {
    const s = ownedServer({ proxy: sshProxy(A_JUMP_ID) }, { externalId: "device:1", templated: { proxy: sshProxy(A_JUMP_ID) } });
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [s, survivorJump(), danglingJump()],
      templates: [template({ proxy: { mode: "override", value: sshProxy(B_JUMP_ID) } })] // proxy is the ONLY change
    });
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === B_JUMP_ID)).toBe(true);
    // Restoring A made after === before → the update collapsed away entirely.
    expect(afterFor(p, S_ID)).toBeUndefined();
    expect(p.updates.some((u) => u.before.id === S_ID)).toBe(false);
    // ...and the server is counted unchanged (S is the only owned device; B_JUMP is pruned).
    expect(p.unchangedCount).toBe(1);
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(1);
  });

  it("Fixture 52 — OTHER FIELD CHANGED: A→B AND a boolean also changed → proxy restored to A, the boolean change kept, S STAYS in `updates`, unchangedCount untouched (kills a collapse that fires when other fields genuinely changed)", () => {
    const s = ownedServer({ proxy: sshProxy(A_JUMP_ID) }, { externalId: "device:1", templated: { proxy: sshProxy(A_JUMP_ID) } });
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [s, survivorJump(), danglingJump()],
      templates: [
        template({ proxy: { mode: "override", value: sshProxy(B_JUMP_ID) }, legacyAlgorithms: { mode: "fill", value: true } })
      ]
    });
    const after = afterFor(p, S_ID)!;
    expect(after).toBeDefined(); // update kept — a genuine field changed
    expect(after.proxy).toEqual(sshProxy(A_JUMP_ID)); // proxy still restored to A
    expect(after.legacyAlgorithms).toBe(true); // the genuine change intact
    expect(p.unchangedCount).toBe(0); // no collapse → count untouched
  });

  it("Fixture 53 — ROW-1 ADD still drops to absent: a FRESH add whose template proxy B is dangling has NO prior proxy → proxy absent, stamp cleared (kills restoring a phantom prior on the add path)", () => {
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()], // device:1 → fresh add; device:bjump absent → B_JUMP pruned
      servers: [danglingJump()], // only the (to-be-pruned) jump host pre-exists
      templates: [template({ proxy: { mode: "override", value: sshProxy(B_JUMP_ID) } })]
    });
    const added = p.adds.find((a) => a.origin?.externalId === "device:1")!;
    expect(added.proxy).toBeUndefined(); // nothing prior to restore → absent
    expect("proxy" in added).toBe(false); // never a written undefined
    expect(added.origin?.templated?.proxy).toBeUndefined();
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(1);
  });
});

// -------- FIX B (PR #61 Codex round 2) — survivor pass covers UNCHANGED template-owned servers --------

describe("FIX B — an UNCHANGED template-owned server whose stamped jump host is pruned is promoted to a proxy-dropping update", () => {
  const sshProxy = (jumpHostId: string): ProxyConfig => ({ type: "ssh", jumpHostId });
  const JUMP_ID = deterministicServerId("source-1", "device:jump");
  const S_ID = deterministicServerId("source-1", "device:1");

  it("Fixture 44 — S has proxy P (ssh, jump J) with a MATCHING `templated.proxy` stamp; the template still wants P (so S is UNCHANGED); the SAME plan delete-prunes J → S is promoted to an update dropping proxy + clearing the stamp + one warning (kills the round-1 pass missing the unchanged case — S keeps a dangling proxy)", () => {
    // J: owned, its device absent from the tree → delete-pruned this run.
    const jumpHost = ownedServer({ id: JUMP_ID }, { externalId: "device:jump" });
    // S: owned + present + otherwise unchanged; its still-sync-owned proxy points at J.
    const s = ownedServer({ proxy: sshProxy(JUMP_ID) }, { externalId: "device:1", templated: { proxy: sshProxy(JUMP_ID) } });
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()], // device:1 → S, still matched → unchanged; device:jump absent → J pruned
      servers: [jumpHost, s],
      // The template still wants exactly P, so S computes no change in the device loop.
      templates: [template({ proxy: { mode: "override", value: sshProxy(JUMP_ID) } })]
    });
    // J is delete-pruned...
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === JUMP_ID)).toBe(true);
    // ...and S — absent from the loop's adds/updates as UNCHANGED — is promoted to an update.
    const after = afterFor(p, S_ID);
    expect(after).toBeDefined();
    expect(after!.proxy).toBeUndefined();
    expect("proxy" in after!).toBe(false); // absent, never a written undefined
    expect(after!.origin?.templated?.proxy).toBeUndefined(); // the ownership stamp cleared with it
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(1);
  });

  it("Fixture 45 — S has a HAND-SET proxy P (ssh, jump J) with NO `templated.proxy` stamp; J is pruned → S is LEFT ALONE, no update, proxy kept (guards §8.4 — the cleanup must not sweep hand proxies)", () => {
    const jumpHost = ownedServer({ id: JUMP_ID }, { externalId: "device:jump" });
    // Hand proxy: value present, NO templated.proxy stamp → row 7, sync does not own it.
    const s = ownedServer({ proxy: sshProxy(JUMP_ID) }, { externalId: "device:1", templated: undefined });
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [jumpHost, s],
      // The template names the same proxy, but with no stamp the loop leaves it (row 7),
      // so S is still UNCHANGED — the only difference from Fixture 44 is the missing stamp.
      templates: [template({ proxy: { mode: "override", value: sshProxy(JUMP_ID) } })]
    });
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === JUMP_ID)).toBe(true);
    // Left entirely alone — no update promoted, so its hand proxy is never touched.
    expect(afterFor(p, S_ID)).toBeUndefined();
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(0);
  });

  it("Fixture 46 — S's stamped jump host J is a device freshly ADDED this run (a survivor, not pruned) → S UNCHANGED, proxy kept, no warning (guards against an over-broad drop)", () => {
    // device:jump is PRESENT → J is a fresh add, hence a survivor.
    const s = ownedServer({ proxy: sshProxy(JUMP_ID) }, { externalId: "device:1", templated: { proxy: sshProxy(JUMP_ID) } });
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule("tmpl-1")] }),
      devices: [
        makeDevice(), // device:1 → S, unchanged
        makeDevice({ externalId: "device:jump", name: "jump", endpoints: [{ kind: "ssh", host: "10.0.0.9" }] }) // fresh add → survivor
      ],
      servers: [s],
      templates: [template({ proxy: { mode: "override", value: sshProxy(JUMP_ID) } })]
    });
    expect(p.adds.some((a) => a.id === JUMP_ID)).toBe(true); // J was added
    // S is left alone: its jump host survives, so there is nothing to clean up.
    expect(afterFor(p, S_ID)).toBeUndefined();
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(0);
  });
});

// -------- Codex round 4 (P2) — the survivor-cleanup decrement must be gated on actually-counted-unchanged --------

describe("Codex round 4 — unchangedCount decrements ONLY for servers that were counted unchanged, never for a skipped-device server", () => {
  const sshProxy = (jumpHostId: string): ProxyConfig => ({ type: "ssh", jumpHostId });
  const JUMP_ID = deterministicServerId("source-1", "device:jump");
  const S_ID = deterministicServerId("source-1", "device:1");
  const U_ID = deterministicServerId("source-1", "device:u");
  const T1_ID = deterministicServerId("source-1", "device:t1");
  const T2_ID = deterministicServerId("source-1", "device:t2");

  it("Fixture 48 — a skipped-device template server promoted by the survivor sweep does NOT decrement unchangedCount (only the genuinely-counted S does); the buggy unconditional decrement drives the count NEGATIVE (kills decrementing for a server that never reached `unchangedCount++`)", () => {
    // No template rules this run — every proxy stamp is a PRE-EXISTING receipt an
    // earlier run's template left, which is exactly what the survivor cleanup
    // sweeps on. So the sweep fires purely off `origin.templated.proxy`, and no
    // this-run override forces a proxy onto the plain baseline server U.
    const source = makeSource({ prunePolicy: "delete" });

    // J — owned, its device ABSENT from the tree → delete-pruned this run, hence
    // a non-survivor every stamped proxy below points at.
    const jumpHost = ownedServer({ id: JUMP_ID }, { externalId: "device:jump" });

    // S — mapped + otherwise unchanged, still carrying its template-stamped
    // proxy → J. It reaches `unchangedCount++` (mapped no-change branch) and is
    // THEN promoted by the sweep, so its decrement is legitimate: net zero.
    const s = ownedServer({ proxy: sshProxy(JUMP_ID) }, { externalId: "device:1", templated: { proxy: sshProxy(JUMP_ID) } });

    // U — a genuinely-unchanged PLAIN server (no proxy, no template stamp). It is
    // counted unchanged and stays unchanged: the true tally is 1.
    const u = ownedServer({ id: U_ID, name: "u-sw", host: "10.0.0.5" }, { externalId: "device:u" });

    // T1 / T2 — owned servers whose devices are SKIPPED this fetch (invalid port),
    // so the device loop hits `continue` before the mapped-update branch and they
    // are NEVER counted at `unchangedCount++`. Both still carry a template-stamped
    // proxy → J, so the survivor sweep promotes them. Decrementing for them (the
    // round-2 bug) subtracts from a bucket they never entered.
    const t1 = ownedServer(
      { id: T1_ID, name: "t1-sw", host: "10.0.0.6", proxy: sshProxy(JUMP_ID) },
      { externalId: "device:t1", templated: { proxy: sshProxy(JUMP_ID) } }
    );
    const t2 = ownedServer(
      { id: T2_ID, name: "t2-sw", host: "10.0.0.7", proxy: sshProxy(JUMP_ID) },
      { externalId: "device:t2", templated: { proxy: sshProxy(JUMP_ID) } }
    );

    const p = plan({
      source,
      devices: [
        makeDevice(), // device:1 → S, mapped + unchanged
        makeDevice({ externalId: "device:u", name: "u-sw", endpoints: [{ kind: "ssh", host: "10.0.0.5" }] }), // U, unchanged
        makeDevice({ externalId: "device:t1", name: "t1-sw", endpoints: [{ kind: "ssh", host: "10.0.0.6", port: 0 }] }), // skipped
        makeDevice({ externalId: "device:t2", name: "t2-sw", endpoints: [{ kind: "ssh", host: "10.0.0.7", port: 0 }] }) // skipped
        // device:jump absent → J delete-pruned
      ],
      servers: [jumpHost, s, u, t1, t2]
    });

    // J is delete-pruned; S, T1, T2 are all promoted to proxy-dropping updates.
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === JUMP_ID)).toBe(true);
    expect(afterFor(p, S_ID)).toBeDefined();
    expect(afterFor(p, T1_ID)).toBeDefined();
    expect(afterFor(p, T2_ID)).toBeDefined();
    // U is left untouched — its device mapped unchanged and it carries no proxy.
    expect(afterFor(p, U_ID)).toBeUndefined();

    // The true tally is exactly 1 (U). S left the unchanged bucket it had entered
    // (net zero); T1/T2 were never in it. The round-2 bug decremented for all
    // three promotions → 1 − 1(S already netted) − 1(T1) − 1(T2) = −1, a count
    // that is not merely understated but IMPOSSIBLE.
    expect(p.unchangedCount).toBe(1);
    expect(p.unchangedCount).toBeGreaterThanOrEqual(0);
  });

  it("Fixture 49 — GUARD: the decrement still fires for a legitimately-counted promoted server (one plain unchanged server + one unchanged template server whose jump host is pruned → count decrements by exactly 1, landing on the plain server's tally)", () => {
    const source = makeSource({ prunePolicy: "delete" });
    const jumpHost = ownedServer({ id: JUMP_ID }, { externalId: "device:jump" });
    // S — counted unchanged, then promoted by the sweep: it MUST decrement.
    const s = ownedServer({ proxy: sshProxy(JUMP_ID) }, { externalId: "device:1", templated: { proxy: sshProxy(JUMP_ID) } });
    // U — genuinely unchanged, the surviving tally of 1.
    const u = ownedServer({ id: U_ID, name: "u-sw", host: "10.0.0.5" }, { externalId: "device:u" });
    const p = plan({
      source,
      devices: [
        makeDevice(),
        makeDevice({ externalId: "device:u", name: "u-sw", endpoints: [{ kind: "ssh", host: "10.0.0.5" }] })
      ],
      servers: [jumpHost, s, u]
    });
    expect(afterFor(p, S_ID)).toBeDefined(); // S promoted
    expect(afterFor(p, U_ID)).toBeUndefined(); // U untouched
    // Both S and U were counted (tally would be 2), then S's promotion decrements
    // exactly once → 1. A fix that over-gated and stopped decrementing for S would
    // leave this at 2; the round-2 bug leaves it at 1 too, so this fixture guards
    // the fix did not lose the legitimate decrement.
    expect(p.unchangedCount).toBe(1);
  });
});

// -------- Codex round 7 (P1) — a RETAINED dangling template proxy on an ALREADY-UPDATED server is cleaned IN PLACE --------

describe("Codex round 7 — the survivor part-2 cleans a retained dangling template proxy on an already-planned UPDATE, instead of skipping it", () => {
  const sshProxy = (jumpHostId: string): ProxyConfig => ({ type: "ssh", jumpHostId });
  const S_ID = deterministicServerId("source-1", "device:1");
  const JUMP_ID = deterministicServerId("source-1", "device:jump"); // owned, device absent → delete-pruned
  const A_JUMP_ID = deterministicServerId("source-1", "device:ajump-unused"); // a plain survivor jump host
  const B_JUMP_ID = deterministicServerId("source-1", "device:bjump"); // owned, device absent → delete-pruned

  // A plain live server (NOT a device of this source this run) that survivor A resolves against.
  const survivorJump = (): ServerConfig => ({
    id: A_JUMP_ID,
    name: "a-jump",
    host: "10.0.0.8",
    port: 22,
    username: "admin",
    authType: "agent",
    isHidden: false
  });

  it("Fixture 54 — THE GAP: S RETAINS a template-owned proxy → J (row-5 carry, no rule sets proxy), J is delete-pruned, AND S is RENAMED this run → the update's after.proxy is ABSENT + stamp cleared + rename preserved + one warning (kills the round-6 `continue` that skips a planned server, leaving the dangling proxy)", () => {
    // J: owned, device absent from the tree → delete-pruned this run.
    const jumpHost = ownedServer({ id: JUMP_ID }, { externalId: "device:jump" });
    // S: retained template-owned proxy → J (proxy === templated.proxy). NO rule
    // sets proxy this run, so it is carried by row 5 — part 1 never looks at it.
    const s = ownedServer({ proxy: sshProxy(JUMP_ID) }, { externalId: "device:1", templated: { proxy: sshProxy(JUMP_ID) } });
    const p = plan({
      source: makeSource({ prunePolicy: "delete" }), // no template rules — the proxy is a retained receipt
      devices: [makeDevice({ name: "renamed-sw" })], // device:1 → S, renamed (unrelated update); device:jump absent → J pruned
      servers: [jumpHost, s]
    });
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === JUMP_ID)).toBe(true);
    const after = afterFor(p, S_ID);
    expect(after).toBeDefined(); // the rename put S in updates
    expect(after!.name).toBe("renamed-sw"); // the unrelated update is preserved
    expect(after!.proxy).toBeUndefined(); // THE FIX: the retained dangling proxy is dropped IN PLACE
    expect("proxy" in after!).toBe(false); // absent, never a written undefined
    expect(after!.origin?.templated?.proxy).toBeUndefined(); // the ownership stamp cleared with it
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(1);
  });

  it("Fixture 55 — ENDPOINT-CHANGE variant: the unrelated update is a host change (not a rename) → same in-place cleanup, endpoint change preserved", () => {
    const jumpHost = ownedServer({ id: JUMP_ID }, { externalId: "device:jump" });
    const s = ownedServer({ proxy: sshProxy(JUMP_ID) }, { externalId: "device:1", templated: { proxy: sshProxy(JUMP_ID) } });
    const p = plan({
      source: makeSource({ prunePolicy: "delete" }),
      devices: [makeDevice({ endpoints: [{ kind: "ssh", host: "10.9.9.9" }] })], // host change → update
      servers: [jumpHost, s]
    });
    const after = afterFor(p, S_ID);
    expect(after).toBeDefined();
    expect(after!.host).toBe("10.9.9.9"); // endpoint change preserved
    expect(after!.proxy).toBeUndefined(); // retained dangling proxy dropped in place
    expect(after!.origin?.templated?.proxy).toBeUndefined();
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(1);
  });

  it("Fixture 56 — NOT-PLANNED still promoted (round-2 path unchanged): a retained dangling proxy with NO other change is promoted to a new update + dropped + unchangedCount decremented (guards the existing path survives the rework)", () => {
    const jumpHost = ownedServer({ id: JUMP_ID }, { externalId: "device:jump" });
    const s = ownedServer({ proxy: sshProxy(JUMP_ID) }, { externalId: "device:1", templated: { proxy: sshProxy(JUMP_ID) } });
    const p = plan({
      source: makeSource({ prunePolicy: "delete" }),
      devices: [makeDevice()], // device:1 → S, name/endpoint unchanged → counted unchanged
      servers: [jumpHost, s]
    });
    const after = afterFor(p, S_ID);
    expect(after).toBeDefined(); // promoted to a new update
    expect(after!.proxy).toBeUndefined();
    expect(after!.origin?.templated?.proxy).toBeUndefined();
    expect(p.unchangedCount).toBe(0); // counted unchanged, then decremented on promotion
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(1);
  });

  it("Fixture 57 — §8.4 HAND proxy on an UPDATED server is LEFT ALONE: S renamed this run carries a HAND-set proxy → J (no templated.proxy stamp), J pruned → proxy KEPT on after, rename applied, no dangling warning (guards the template-owned scope through the in-place path)", () => {
    const jumpHost = ownedServer({ id: JUMP_ID }, { externalId: "device:jump" });
    // Hand proxy: value present, NO templated.proxy stamp → sync does not own it.
    const s = ownedServer({ proxy: sshProxy(JUMP_ID) }, { externalId: "device:1", templated: undefined });
    const p = plan({
      source: makeSource({ prunePolicy: "delete" }),
      devices: [makeDevice({ name: "renamed-sw" })], // rename → S is an update
      servers: [jumpHost, s]
    });
    const after = afterFor(p, S_ID);
    expect(after).toBeDefined();
    expect(after!.name).toBe("renamed-sw"); // the rename landed
    expect(after!.proxy).toEqual(sshProxy(JUMP_ID)); // hand proxy untouched — §8.4
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(0);
  });

  it("Fixture 58 — ROUND-6 COMPOSITION: this run's OVERRIDE proxy A→B (B dangling) AND a rename → round 6 restores A (a survivor), part 2 sees no dangling proxy → proxy is A, rename kept, exactly ONE warning (no double-drop, no double-warn)", () => {
    // S carries a working template-owned proxy A (stamp A). An OVERRIDE moves it to
    // B; B is delete-pruned; and the device is renamed — so both a proxy move and
    // an unrelated change happen at once.
    const s = ownedServer(
      { proxy: sshProxy(A_JUMP_ID) },
      { externalId: "device:1", templated: { proxy: sshProxy(A_JUMP_ID) } }
    );
    const bJump = ownedServer({ id: B_JUMP_ID }, { externalId: "device:bjump" }); // device absent → pruned
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice({ name: "renamed-sw" })], // device:1 → S renamed; device:bjump absent → B pruned
      servers: [s, survivorJump(), bJump],
      templates: [template({ proxy: { mode: "override", value: sshProxy(B_JUMP_ID) } })]
    });
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === B_JUMP_ID)).toBe(true);
    const after = afterFor(p, S_ID);
    expect(after).toBeDefined();
    expect(after!.name).toBe("renamed-sw"); // the rename kept the update alive (no collapse)
    expect(after!.proxy).toEqual(sshProxy(A_JUMP_ID)); // round 6 restored A; part 2 left it (A survives)
    expect(after!.origin?.templated?.proxy).toEqual(sshProxy(A_JUMP_ID)); // A's stamp restored, not cleared
    // Only round 6's aggregate warning — part 2 must NOT add a second.
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(1);
  });
});

// -------- Codex round 8 (P2) — the survivor part-2 cleans a RETAINED template-owned SELF-proxy that no current rule wins --------

describe("Codex round 8 — the survivor part-2 cleans a retained template-owned self-proxy no rule now sets, on both dispositions", () => {
  const sshProxy = (jumpHostId: string): ProxyConfig => ({ type: "ssh", jumpHostId });
  const S_ID = deterministicServerId("source-1", "device:1");

  it("Fixture 60 — NOT-PLANNED promote: S RETAINS a template-owned SELF-proxy (proxy === templated.proxy, jumpHost === own id), NO rule sets proxy, S otherwise unchanged → promoted to a new update, proxy ABSENT + stamp cleared + unchangedCount decremented + one self-reference warning (kills the round-7 guard that treats the record's own id as a survivor and skips the retained self-proxy forever)", () => {
    // A self-referential template-owned proxy retained by §6.3 row-5 carry: its
    // rule was removed (no templateRules), so value + stamp are kept but no
    // current winner sets it. The record's own id IS a survivor, so the round-7
    // survivor test skipped it — leaving a circular proxy the runtime refuses.
    const s = ownedServer({ proxy: sshProxy(S_ID) }, { externalId: "device:1", templated: { proxy: sshProxy(S_ID) } });
    const p = plan({
      source: makeSource(), // no template rules — the proxy is a retained receipt
      devices: [makeDevice()], // device:1 → S, name/endpoint unchanged → counted unchanged
      servers: [s]
    });
    const after = afterFor(p, S_ID);
    expect(after).toBeDefined(); // THE FIX: promoted to a new update instead of skipped-as-survivor
    expect(after!.proxy).toBeUndefined(); // self-proxy DROPPED
    expect("proxy" in after!).toBe(false); // absent, never a written undefined
    expect(after!.origin?.templated?.proxy).toBeUndefined(); // stamp cleared with it
    expect(p.unchangedCount).toBe(0); // counted unchanged, then decremented on promotion
    expect(p.warnings.filter((w) => w.includes("points at itself")).length).toBe(1);
    // The self case is NOT a prune — the dangling wording must not appear.
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(0);
  });

  it("Fixture 61 — IN-PLACE update: the same retained self-proxy on a server also RENAMED this run is cleaned on the existing update's after (proxy absent + stamp cleared + rename preserved + one self warning, unchangedCount untouched) (kills skipping an already-planned update whose retained proxy self-references)", () => {
    const s = ownedServer({ proxy: sshProxy(S_ID) }, { externalId: "device:1", templated: { proxy: sshProxy(S_ID) } });
    const p = plan({
      source: makeSource(),
      devices: [makeDevice({ name: "renamed-sw" })], // rename → S is an update
      servers: [s]
    });
    const after = afterFor(p, S_ID);
    expect(after).toBeDefined();
    expect(after!.name).toBe("renamed-sw"); // the unrelated update is preserved
    expect(after!.proxy).toBeUndefined(); // self-proxy dropped IN PLACE
    expect("proxy" in after!).toBe(false);
    expect(after!.origin?.templated?.proxy).toBeUndefined();
    expect(p.unchangedCount).toBe(0); // S was an update from the start, never counted unchanged
    expect(p.warnings.filter((w) => w.includes("points at itself")).length).toBe(1);
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(0);
  });

  it("Fixture 62 — §8.4 guard: a HAND self-proxy (proxy self-ref, NO templated.proxy stamp), no winner → LEFT ALONE, server unchanged, no warning (kills an over-broad clear that sweeps a hand proxy)", () => {
    const s = ownedServer({ proxy: sshProxy(S_ID) }, { externalId: "device:1", templated: undefined });
    const p = plan({
      source: makeSource(),
      devices: [makeDevice()], // unchanged
      servers: [s]
    });
    expect(afterFor(p, S_ID)).toBeUndefined(); // untouched — no update
    expect(p.unchangedCount).toBe(1);
    expect(p.warnings.filter((w) => w.includes("points at itself")).length).toBe(0);
  });

  it("Fixture 63 — round-5 composition: a DESIRED self-proxy (template override to self, matching stamp) is repaired by the MATRIX at write time; part 2 sees no self-proxy and does NOT double-handle (exactly one 'through itself … was cleared' warning, zero part-2 'points at itself')", () => {
    const s = ownedServer({ proxy: sshProxy(S_ID) }, { externalId: "device:1", templated: { proxy: sshProxy(S_ID) } });
    const p = plan({
      source: makeSource({ templateRules: [rule("tmpl-1")] }),
      devices: [makeDevice()],
      servers: [s],
      templates: [template({ proxy: { mode: "override", value: sshProxy(S_ID) } })]
    });
    const after = afterFor(p, S_ID);
    expect(after).toBeDefined();
    expect(after!.proxy).toBeUndefined();
    expect(after!.origin?.templated?.proxy).toBeUndefined();
    // The matrix's own repair warning, once — and NOT part 2's, which would be a double-handle.
    expect(p.warnings.filter((w) => w.includes("through itself") && w.includes("was cleared")).length).toBe(1);
    expect(p.warnings.filter((w) => w.includes("points at itself")).length).toBe(0);
  });
});

// -------- Codex round 9 (P1) — the survivor part-2 UNIFICATION covers ADOPTION updates (built from keptByExternalId, never in ownedByExternalId) --------

describe("Codex round 9 — the survivor part-2 cleans a retained template-owned proxy on an ADOPTION update, which the ownedByExternalId iteration missed", () => {
  const sshProxy = (jumpHostId: string): ProxyConfig => ({ type: "ssh", jumpHostId });
  const JUMP_ID = deterministicServerId("source-1", "device:jump"); // owned, device absent → delete-pruned

  it("Fixture 64 — ADOPTION + RETAINED DANGLING PROXY: an adopted server whose restored receipt carries a template-owned proxy → J (no current rule wins, so it is a row-5 retained carry), J delete-pruned this plan → the adoption update's after.proxy is ABSENT + stamp cleared + one survivor warning (kills the ownedByExternalId iteration that never sees an adoptee → the proxy ships broken)", () => {
    // J: owned by this source, device absent from the tree → delete-pruned.
    const jumpHost = ownedServer({ id: JUMP_ID, host: "10.0.0.8" }, { externalId: "device:jump" });
    // The adoptee: a kept server whose marker preserves a template-owned proxy → J.
    // With NO template rule this run, the adoption matrix carries the proxy (row 5)
    // and retains the restored stamp — a RETAINED dangling proxy, exactly what part
    // 2 must clean, but on a record that lives in `updates` via adoption, never in
    // the owned map the pre-round-9 loop walked.
    const kept = keptServer({
      proxy: sshProxy(JUMP_ID),
      formerlySynced: {
        sourceId: "removed-source",
        sourceName: "NetBox (removed)",
        providerId: "netbox",
        instanceKey: DEVICE_INSTANCE,
        externalId: "device:1",
        templated: { proxy: sshProxy(JUMP_ID) }, // the receipt says the sync wrote it
        detachedAt: 900
      }
    });
    const p = plan({
      source: makeSource({ prunePolicy: "delete" }), // no template rules — the proxy is a retained receipt
      devices: [makeDevice()], // device:1 → adopts kept-1; device:jump absent → J delete-pruned
      servers: [jumpHost, kept],
      adoptionChoice: "adopt",
      providerInstanceKey: DEVICE_INSTANCE
    });
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === JUMP_ID)).toBe(true);
    const after = afterFor(p, "kept-1");
    expect(after).toBeDefined(); // the adoption put kept-1 in updates
    expect(after!.origin?.externalId).toBe("device:1"); // it really is the adoption update
    expect(after!.proxy).toBeUndefined(); // THE FIX: the retained dangling proxy is cleaned on the adoption update
    expect("proxy" in after!).toBe(false); // absent, never a written undefined
    expect(after!.origin?.templated?.proxy).toBeUndefined(); // the ownership stamp cleared with it
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(1);
  });

  it("Fixture 65 — ADOPTION + RETAINED SELF-PROXY: an adopted server whose restored receipt carries a template-owned SELF-proxy (jumpHost === own id), no current rule wins → the adoption update's after.proxy is ABSENT + stamp cleared + one self-reference warning (kills the ownedByExternalId iteration that skips the adoptee → the circular proxy ships)", () => {
    const kept = keptServer({
      proxy: sshProxy("kept-1"), // self-referential: jumpHostId === adoptee's own id
      formerlySynced: {
        sourceId: "removed-source",
        sourceName: "NetBox (removed)",
        providerId: "netbox",
        instanceKey: DEVICE_INSTANCE,
        externalId: "device:1",
        templated: { proxy: sshProxy("kept-1") },
        detachedAt: 900
      }
    });
    const p = plan({
      source: makeSource(), // no template rules → no winner → the self-proxy is a retained carry (no matrix repair)
      devices: [makeDevice()],
      servers: [kept],
      adoptionChoice: "adopt",
      providerInstanceKey: DEVICE_INSTANCE
    });
    const after = afterFor(p, "kept-1");
    expect(after).toBeDefined();
    expect(after!.origin?.externalId).toBe("device:1");
    expect(after!.proxy).toBeUndefined(); // THE FIX: the retained self-proxy is cleaned on the adoption update
    expect("proxy" in after!).toBe(false);
    expect(after!.origin?.templated?.proxy).toBeUndefined();
    expect(p.warnings.filter((w) => w.includes("points at itself")).length).toBe(1);
    expect(p.warnings.filter((w) => w.includes("will not survive this sync")).length).toBe(0);
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
