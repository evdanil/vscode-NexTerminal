import { describe, expect, it } from "vitest";
import { computeSyncPlan, type InventorySyncPlan } from "../../src/services/inventory/syncEngine";
import {
  clearTemplatedStamps,
  planManualTemplateApply,
  templateAppliedFields,
  TEMPLATABLE_FIELD_ORDER,
  TEMPLATE_FIELD_SHORT_LABELS,
  type TemplatableField
} from "../../src/services/inventory/templateApply";
import { deterministicServerId } from "../../src/services/inventory/deterministicId";
import {
  templatedStampsEqual,
  cloneServerConfig,
  type AuthProfile,
  type ServerConfig,
  type ServerOrigin
} from "../../src/models/config";
import type { InventoryDevice, InventorySourceConfig, InventoryTree, TemplateRule } from "../../src/models/inventory";
import type { DeviceTemplateProfile } from "../../src/models/deviceTemplate";
import { validateDeviceTemplate } from "../../src/utils/validation";

/**
 * DEVICE TEMPLATES (issue #48 PR-T3, §14 reserved slots) — the two id-reference
 * template fields `ipmiAuthProfileId` and `ipmiGatewayServerId`. Both are
 * TEMPLATE-ONLY, `origin.templated`-value-stamped, reference-validated
 * skip-and-warn. Each fixture is built to FAIL against the specific wrong
 * implementation its "Kills:" note names (CLAUDE.md testing convention).
 */

// --------- helpers (mirroring deviceTemplateEngine.test.ts) ---------
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

function bystanderServer(id: string, name = id): ServerConfig {
  return { id, name, host: "1.2.3.4", port: 22, username: "root", authType: "agent", isHidden: false };
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
}

function plan(opts: PlanOpts): InventorySyncPlan {
  return computeSyncPlan({
    source: opts.source,
    tree: tree(opts.devices),
    currentServers: opts.servers ?? [],
    now: 5000,
    templatesById: new Map((opts.templates ?? []).map((t) => [t.id, t] as const)),
    authProfilesById: new Map((opts.authProfiles ?? []).map((p) => [p.id, p] as const))
  });
}

function addFor(p: InventorySyncPlan): ServerConfig {
  expect(p.adds.length).toBe(1);
  return p.adds[0];
}

function afterFor(p: InventorySyncPlan, serverId: string): ServerConfig | undefined {
  return p.updates.find((u) => u.before.id === serverId)?.after;
}

// Live profiles / servers the ipmi references resolve against.
const PA1 = authProfile("pa-1");
const PA2 = authProfile("pa-2");
const GW1 = bystanderServer("gw-1", "gateway-1");
const GW2 = bystanderServer("gw-2", "gateway-2");

// ============================================================================
// FALSIFICATION-CRITICAL: cascade per-field winner + stamp (mirror fixture 15/16)
// ============================================================================
describe("PR-T3 IPMI slots — cascade winners + stamps", () => {
  it("row 1 fresh add: a catch-all template writes BOTH ipmi fields + stamps them", () => {
    const t = template({
      ipmiAuthProfileId: { mode: "fill", value: PA1.id },
      ipmiGatewayServerId: { mode: "fill", value: GW1.id }
    });
    const p = plan({
      source: makeSource({ templateRules: [rule(t.id)] }),
      devices: [makeDevice()],
      servers: [GW1],
      templates: [t],
      authProfiles: [PA1]
    });
    const add = addFor(p);
    expect(add.ipmiAuthProfileId).toBe(PA1.id);
    expect(add.ipmiGatewayServerId).toBe(GW1.id);
    // Kills "field written but not stamped": the ownership stamp must be present.
    expect(add.origin?.templated?.ipmiAuthProfileId).toBe(PA1.id);
    expect(add.origin?.templated?.ipmiGatewayServerId).toBe(GW1.id);
  });

  it("per-field cascade: a narrower rule overrides ONLY ipmiAuthProfileId; the gateway keeps the broad rule's value (mirror 15)", () => {
    const broad = template(
      { ipmiAuthProfileId: { mode: "fill", value: PA1.id }, ipmiGatewayServerId: { mode: "fill", value: GW1.id } },
      "broad",
      "Broad"
    );
    const narrow = template({ ipmiAuthProfileId: { mode: "override", value: PA2.id } }, "narrow", "Narrow");
    const p = plan({
      source: makeSource({ templateRules: [rule(broad.id), rule(narrow.id, { filter: "role=switch" })] }),
      devices: [makeDevice({ attributes: { role: ["switch"] } })],
      servers: [GW1],
      templates: [broad, narrow],
      authProfiles: [PA1, PA2]
    });
    const add = addFor(p);
    // Distinct ids so winner-takes-all-fields diverges visibly from per-field.
    expect(add.ipmiAuthProfileId).toBe(PA2.id); // narrow wins auth
    expect(add.ipmiGatewayServerId).toBe(GW1.id); // broad still supplies gateway
    expect(add.origin?.templated?.ipmiAuthProfileId).toBe(PA2.id);
    expect(add.origin?.templated?.ipmiGatewayServerId).toBe(GW1.id);
  });

  it("winner flip on update rewrites ONE field, leaves the other's value AND stamp untouched (mirror 16)", () => {
    // Server already sync-owns both ipmi fields from an earlier sync.
    const server = ownedServer(
      { ipmiAuthProfileId: PA1.id, ipmiGatewayServerId: GW1.id },
      { syncedAt: 1000, templated: { ipmiAuthProfileId: PA1.id, ipmiGatewayServerId: GW1.id } }
    );
    const broad = template(
      { ipmiAuthProfileId: { mode: "override", value: PA1.id }, ipmiGatewayServerId: { mode: "override", value: GW1.id } },
      "broad",
      "Broad"
    );
    const narrow = template({ ipmiAuthProfileId: { mode: "override", value: PA2.id } }, "narrow", "Narrow");
    const p = plan({
      source: makeSource({ templateRules: [rule(broad.id), rule(narrow.id, { filter: "role=switch" })] }),
      devices: [makeDevice({ attributes: { role: ["switch"] } })],
      servers: [server, GW1],
      templates: [broad, narrow],
      authProfiles: [PA1, PA2]
    });
    const after = afterFor(p, server.id);
    expect(after).toBeDefined();
    expect(after!.ipmiAuthProfileId).toBe(PA2.id); // rewritten (row 3)
    expect(after!.origin?.templated?.ipmiAuthProfileId).toBe(PA2.id);
    // Kills "re-decide/re-stamp all fields when one winner changes":
    expect(after!.ipmiGatewayServerId).toBe(GW1.id);
    expect(after!.origin?.templated?.ipmiGatewayServerId).toBe(GW1.id);
  });
});

// ============================================================================
// Fill-write-once + hand-edit-wins (mirror 6/6b/9)
// ============================================================================
describe("PR-T3 IPMI slots — mode gate & hand edits", () => {
  it("row 3 override rewrites a sync-owned gateway; a FILL winner leaves it (mode gate)", () => {
    const base = ownedServer(
      { ipmiGatewayServerId: GW1.id },
      { syncedAt: 1000, templated: { ipmiGatewayServerId: GW1.id } }
    );
    const overrideT = template({ ipmiGatewayServerId: { mode: "override", value: GW2.id } }, "ov", "Ov");
    const fillT = template({ ipmiGatewayServerId: { mode: "fill", value: GW2.id } }, "fi", "Fi");

    const pOverride = plan({
      source: makeSource({ templateRules: [rule(overrideT.id)] }),
      devices: [makeDevice()],
      servers: [cloneServerConfig(base), GW1, GW2],
      templates: [overrideT],
      authProfiles: []
    });
    const afterOv = afterFor(pOverride, base.id);
    expect(afterOv!.ipmiGatewayServerId).toBe(GW2.id); // row 3 override
    expect(afterOv!.origin?.templated?.ipmiGatewayServerId).toBe(GW2.id);

    const pFill = plan({
      source: makeSource({ templateRules: [rule(fillT.id)] }),
      devices: [makeDevice()],
      servers: [cloneServerConfig(base), GW1, GW2],
      templates: [fillT],
      authProfiles: []
    });
    // Kills "fill behaving like override": a fill winner must NOT move a configured value.
    const afterFi = afterFor(pFill, base.id);
    if (afterFi !== undefined) {
      expect(afterFi.ipmiGatewayServerId).toBe(GW1.id);
      expect(afterFi.origin?.templated?.ipmiGatewayServerId).toBe(GW1.id);
    }
  });

  it("row 7 hand value (stamp absent) is untouched even by override", () => {
    const server = ownedServer(
      { ipmiGatewayServerId: GW1.id }, // hand value, NO templated stamp
      { syncedAt: 1000 }
    );
    const overrideT = template({ ipmiGatewayServerId: { mode: "override", value: GW2.id } });
    const p = plan({
      source: makeSource({ templateRules: [rule(overrideT.id)] }),
      devices: [makeDevice()],
      servers: [server, GW1, GW2],
      templates: [overrideT],
      authProfiles: []
    });
    const after = afterFor(p, server.id);
    if (after !== undefined) {
      expect(after.ipmiGatewayServerId).toBe(GW1.id); // hand value kept
    }
  });

  // FIX 5 #3 — row-2 opt-out coverage gap. `cur` unset + stamp present means the
  // user CLEARED a template-applied BMC link; that field must stay unset under BOTH
  // fill and override (the template is not allowed to re-fill an opt-out), and the
  // stamp is carried forward so the opt-out survives. Kills a wrong `applyId` that
  // re-fills a user-cleared link (e.g. `cur === undefined ? write : …`).
  it("row 2 opt-out: cur unset + stamp present leaves ipmiGatewayServerId unwritten under fill AND override, stamp carried", () => {
    const base = ownedServer({}, { syncedAt: 1000, templated: { ipmiGatewayServerId: GW1.id } });
    for (const mode of ["fill", "override"] as const) {
      const t = template({ ipmiGatewayServerId: { mode, value: GW2.id } });
      const p = plan({
        source: makeSource({ templateRules: [rule(t.id)] }),
        devices: [makeDevice()],
        servers: [cloneServerConfig(base), GW1, GW2],
        templates: [t],
        authProfiles: []
      });
      const record = afterFor(p, base.id) ?? base;
      expect(record.ipmiGatewayServerId).toBeUndefined(); // row 2 leaves — never re-filled
      expect(record.origin?.templated?.ipmiGatewayServerId).toBe(GW1.id); // opt-out stamp carried
    }
  });

  it("row 2 opt-out: cur unset + stamp present leaves ipmiAuthProfileId unwritten under fill AND override, stamp carried", () => {
    const base = ownedServer({}, { syncedAt: 1000, templated: { ipmiAuthProfileId: PA1.id } });
    for (const mode of ["fill", "override"] as const) {
      const t = template({ ipmiAuthProfileId: { mode, value: PA2.id } });
      const p = plan({
        source: makeSource({ templateRules: [rule(t.id)] }),
        devices: [makeDevice()],
        servers: [cloneServerConfig(base)],
        templates: [t],
        authProfiles: [PA1, PA2]
      });
      const record = afterFor(p, base.id) ?? base;
      expect(record.ipmiAuthProfileId).toBeUndefined();
      expect(record.origin?.templated?.ipmiAuthProfileId).toBe(PA1.id);
    }
  });

  it("row 5 release keeps value AND stamp when the template detaches", () => {
    const server = ownedServer(
      { ipmiAuthProfileId: PA1.id },
      { syncedAt: 1000, templated: { ipmiAuthProfileId: PA1.id } }
    );
    // No rules this run — the field is no longer templated.
    const p = plan({
      source: makeSource({ templateRules: [] }),
      devices: [makeDevice()],
      servers: [server],
      authProfiles: [PA1]
    });
    const after = afterFor(p, server.id);
    // Either unchanged (no update) or carried forward — but value + stamp must survive.
    const record = after ?? server;
    expect(record.ipmiAuthProfileId).toBe(PA1.id);
    expect(record.origin?.templated?.ipmiAuthProfileId).toBe(PA1.id);
  });
});

// ============================================================================
// FALSIFICATION-CRITICAL: reference-validation skip-and-warn
// ============================================================================
describe("PR-T3 IPMI slots — reference validation (skip-and-warn)", () => {
  it("ipmiAuthProfileId naming a deleted profile is skipped + warns; the OTHER field still applies", () => {
    const t = template({
      ipmiAuthProfileId: { mode: "override", value: "ghost-profile" }, // not in authProfilesById
      multiplexing: { mode: "override", value: true }
    });
    const p = plan({
      source: makeSource({ templateRules: [rule(t.id)] }),
      devices: [makeDevice()],
      servers: [],
      templates: [t],
      authProfiles: [] // ghost-profile does not resolve
    });
    const add = addFor(p);
    // Kills "writes the dead id": the field must be dropped to none.
    expect(add.ipmiAuthProfileId).toBeUndefined();
    expect(add.origin?.templated?.ipmiAuthProfileId).toBeUndefined();
    // The device's other fields proceed.
    expect(add.multiplexing).toBe(true);
    // Kills "silent drop": one plan warning naming the template AND the exact
    // disposition (FIX 5 #6 — matcher tightened to the near-exact warning text so
    // it cannot pass on an unrelated warning that merely says "ipmi").
    expect(
      p.warnings.some(
        (w) => /Device template "T"/.test(w) && /IPMI auth profile that no longer exists/.test(w) && /skipped/.test(w)
      )
    ).toBe(true);
  });

  it("ipmiGatewayServerId resolving to no live server is skipped + warns; the OTHER field still applies", () => {
    const t = template({
      ipmiGatewayServerId: { mode: "override", value: "ghost-server" }, // no such live server
      legacyAlgorithms: { mode: "override", value: true }
    });
    const p = plan({
      source: makeSource({ templateRules: [rule(t.id)] }),
      devices: [makeDevice()],
      servers: [], // ghost-server absent
      templates: [t],
      authProfiles: []
    });
    const add = addFor(p);
    expect(add.ipmiGatewayServerId).toBeUndefined();
    expect(add.origin?.templated?.ipmiGatewayServerId).toBeUndefined();
    expect(add.legacyAlgorithms).toBe(true);
    // FIX 5 #6 — tightened to the near-exact dangling-gateway warning text.
    expect(
      p.warnings.some(
        (w) => /Device template "T"/.test(w) && /IPMI gateway server that no longer exists/.test(w) && /skipped/.test(w)
      )
    ).toBe(true);
  });
});

// ============================================================================
// Model comparators / clone / tooltip
// ============================================================================
describe("PR-T3 IPMI slots — model bookkeeping", () => {
  it("templatedStampsEqual distinguishes each ipmi stamp", () => {
    expect(templatedStampsEqual({ ipmiAuthProfileId: "a" }, { ipmiAuthProfileId: "b" })).toBe(false);
    expect(templatedStampsEqual({ ipmiGatewayServerId: "g1" }, { ipmiGatewayServerId: "g2" })).toBe(false);
    expect(templatedStampsEqual({ ipmiAuthProfileId: "a" }, { ipmiAuthProfileId: "a" })).toBe(true);
    // present vs absent is a difference (rollback must see it)
    expect(templatedStampsEqual({ ipmiGatewayServerId: "g1" }, {})).toBe(false);
  });

  it("cloneServerConfig carries the ipmi stamps and does not alias", () => {
    const s = ownedServer(
      { ipmiAuthProfileId: "a", ipmiGatewayServerId: "g" },
      { templated: { ipmiAuthProfileId: "a", ipmiGatewayServerId: "g" } }
    );
    const c = cloneServerConfig(s);
    expect(c.origin?.templated?.ipmiAuthProfileId).toBe("a");
    expect(c.origin?.templated?.ipmiGatewayServerId).toBe("g");
    // FIX 5 #4 — exercise the "does not alias" half: mutating the clone's stamp
    // record must NOT reach back into the original (a shallow clone that aliased
    // `origin.templated` would let this write corrupt `s`).
    c.origin!.templated!.ipmiAuthProfileId = "z";
    expect(s.origin?.templated?.ipmiAuthProfileId).toBe("a");
  });

  it("templateAppliedFields lists an ipmi field when cur === stamp, drops it when hand-edited", () => {
    const applied = templateAppliedFields({
      ipmiAuthProfileId: "a",
      ipmiGatewayServerId: "g",
      origin: { sourceId: "s", externalId: "e", syncedAt: 1, templated: { ipmiAuthProfileId: "a", ipmiGatewayServerId: "g" } }
    } as Pick<ServerConfig, "ipmiAuthProfileId" | "ipmiGatewayServerId" | "origin"> as never);
    expect(applied).toContain("ipmiAuthProfileId");
    expect(applied).toContain("ipmiGatewayServerId");

    const handEdited = templateAppliedFields({
      ipmiAuthProfileId: "hand",
      ipmiGatewayServerId: "g",
      origin: { sourceId: "s", externalId: "e", syncedAt: 1, templated: { ipmiAuthProfileId: "a", ipmiGatewayServerId: "g" } }
    } as never);
    expect(handEdited).not.toContain("ipmiAuthProfileId"); // cur !== stamp
    expect(handEdited).toContain("ipmiGatewayServerId");
  });

  it("short labels exist", () => {
    expect(TEMPLATE_FIELD_SHORT_LABELS.ipmiAuthProfileId).toBe("IPMI Auth Profile");
    expect(TEMPLATE_FIELD_SHORT_LABELS.ipmiGatewayServerId).toBe("IPMI Gateway");
  });
});

// ============================================================================
// §3.4 sync-plan PROVENANCE report (PR #66 Codex round 2) — the two IPMI fields
// must appear in the report's ordered enumeration, or an IPMI-only template write
// is approved with no provenance line at all.
// ============================================================================
describe("PR-T3 IPMI slots — sync-plan provenance report", () => {
  it("renders a provenance line for an IPMI-only template write (kills a report fieldOrder that omits the IPMI fields)", () => {
    const t = template({
      ipmiAuthProfileId: { mode: "fill", value: PA1.id },
      ipmiGatewayServerId: { mode: "fill", value: GW1.id }
    });
    const p = plan({
      source: makeSource({ templateRules: [rule(t.id)] }),
      devices: [makeDevice()],
      servers: [GW1],
      templates: [t],
      authProfiles: [PA1]
    });
    // A fresh add whose ONLY template writes are the two IPMI fields. Against the
    // pre-fix five-field report order these produced NO provenance line at all
    // (`parts` stayed empty → the server was skipped), hiding from the approver
    // which template supplied the BMC links they are consenting to.
    expect(p.warnings.some((w) => w.includes(`${TEMPLATE_FIELD_SHORT_LABELS.ipmiGatewayServerId} ← "T"`))).toBe(true);
    expect(p.warnings.some((w) => w.includes(`${TEMPLATE_FIELD_SHORT_LABELS.ipmiAuthProfileId} ← "T"`))).toBe(true);
  });

  it("TEMPLATABLE_FIELD_ORDER covers every templatable field (kills a drifted ordered enumeration)", () => {
    // The shared enumeration and the label map must name the same set; a field
    // added to one but not the other is exactly the drift this fix removed.
    expect([...TEMPLATABLE_FIELD_ORDER].sort()).toEqual(
      (Object.keys(TEMPLATE_FIELD_SHORT_LABELS) as TemplatableField[]).sort()
    );
  });
});

// ============================================================================
// validateDeviceTemplate
// ============================================================================
describe("PR-T3 IPMI slots — validation", () => {
  it("accepts well-formed ipmi fields", () => {
    expect(
      validateDeviceTemplate({
        id: "t",
        name: "T",
        fields: {
          ipmiAuthProfileId: { mode: "fill", value: "pa" },
          ipmiGatewayServerId: { mode: "override", value: "gw" }
        }
      })
    ).toBe(true);
  });
  it("rejects a malformed {mode, value:42} on ipmiAuthProfileId (drops whole template)", () => {
    expect(
      validateDeviceTemplate({ id: "t", name: "T", fields: { ipmiAuthProfileId: { mode: "fill", value: 42 } } })
    ).toBe(false);
  });
  it("rejects a malformed {mode, value:42} on ipmiGatewayServerId", () => {
    expect(
      validateDeviceTemplate({ id: "t", name: "T", fields: { ipmiGatewayServerId: { mode: "override", value: 42 } } })
    ).toBe(false);
  });
  // FIX 5 #7 — an empty-string value is not a valid id reference: `isNonEmptyString`
  // rejects it, dropping the whole template (mirrors the `value:42` cases above).
  it("rejects an empty-string value on ipmiAuthProfileId (drops whole template)", () => {
    expect(
      validateDeviceTemplate({ id: "t", name: "T", fields: { ipmiAuthProfileId: { mode: "fill", value: "" } } })
    ).toBe(false);
  });
  it("rejects an empty-string value on ipmiGatewayServerId (drops whole template)", () => {
    expect(
      validateDeviceTemplate({ id: "t", name: "T", fields: { ipmiGatewayServerId: { mode: "fill", value: "" } } })
    ).toBe(false);
  });
});

// ============================================================================
// FALSIFICATION-CRITICAL: manual folder apply (stamp-clearing + dead-ref skip)
// ============================================================================
describe("PR-T3 IPMI slots — manual folder apply", () => {
  it("applies both ipmi fields and clears their stamps (row 7 hand-owned)", () => {
    const s = ownedServer(
      {},
      { syncedAt: 1000, templated: { ipmiAuthProfileId: "old", ipmiGatewayServerId: "oldgw" } }
    );
    const t = template({
      ipmiAuthProfileId: { mode: "override", value: PA1.id },
      ipmiGatewayServerId: { mode: "override", value: GW1.id }
    });
    const p = planManualTemplateApply({
      template: t,
      servers: [s],
      sourceDefaultUsername: () => "admin",
      authProfile: (id) => (id === PA1.id ? PA1 : undefined),
      hasServer: (id) => id === GW1.id
    });
    const w = p.serverWrites.find((x) => x.serverId === s.id);
    expect(w?.ipmiAuthProfileId).toBe(PA1.id);
    expect(w?.ipmiGatewayServerId).toBe(GW1.id);
    expect(w?.writtenFields).toContain("ipmiAuthProfileId");
    expect(w?.writtenFields).toContain("ipmiGatewayServerId");
    // Kills "manual path preserves stamps": the written stamps must be cleared.
    const cleared = clearTemplatedStamps(s.origin, w!.writtenFields);
    expect(cleared?.templated?.ipmiAuthProfileId).toBeUndefined();
    expect(cleared?.templated?.ipmiGatewayServerId).toBeUndefined();
  });

  it("skips a dead ipmiAuthProfileId reference with a modal note; applies the live gateway", () => {
    const s = ownedServer({}, { syncedAt: 1000 });
    const t = template({
      ipmiAuthProfileId: { mode: "override", value: "ghost" },
      ipmiGatewayServerId: { mode: "override", value: GW1.id }
    });
    const p = planManualTemplateApply({
      template: t,
      servers: [s],
      sourceDefaultUsername: () => "admin",
      authProfile: () => undefined, // ghost resolves to nothing
      hasServer: (id) => id === GW1.id
    });
    const w = p.serverWrites.find((x) => x.serverId === s.id);
    expect(w?.ipmiAuthProfileId).toBeUndefined();
    expect(w?.ipmiGatewayServerId).toBe(GW1.id);
    // FIX 5 #6 — tightened to the near-exact manual dangling-profile warning text.
    expect(
      p.warnings.some(
        (warn) => /Device template "T"/.test(warn) && /IPMI auth profile that no longer exists/.test(warn) && /skipped/.test(warn)
      )
    ).toBe(true);
  });

  it("value semantics: fill writes where unset, skips where set", () => {
    const unsetServer = ownedServer({ id: "u" }, { syncedAt: 1000 });
    const setServer = ownedServer({ id: "sset", ipmiGatewayServerId: GW2.id }, { syncedAt: 1000 });
    const t = template({ ipmiGatewayServerId: { mode: "fill", value: GW1.id } });
    const p = planManualTemplateApply({
      template: t,
      servers: [unsetServer, setServer],
      sourceDefaultUsername: () => "admin",
      authProfile: () => undefined,
      hasServer: (id) => id === GW1.id
    });
    expect(p.serverWrites.find((x) => x.serverId === "u")?.ipmiGatewayServerId).toBe(GW1.id);
    expect(p.serverWrites.find((x) => x.serverId === "sset")).toBeUndefined();
    expect(p.ipmiGatewayServerId?.willSet).toBe(1);
    expect(p.ipmiGatewayServerId?.skipped).toBe(1);
  });
});

// ============================================================================
// FALSIFICATION-CRITICAL: FIX 2 — self-gateway skip + warn (a server must not be
// its own IPMI gateway). Mirrors the proxy self-reference skip on both paths.
// ============================================================================
describe("PR-T3 IPMI slots — FIX 2 self-gateway skip (sync path)", () => {
  it("a catch-all gateway override that names the gateway host self-skips ONLY that host; siblings still get it written+stamped", () => {
    // The gateway host is itself one of the synced devices; its (deterministic)
    // server id is what a catch-all/override gateway rule would stamp onto every
    // matched device — including the host itself.
    const gwId = deterministicServerId("source-1", "device:gw");
    const t = template({ ipmiGatewayServerId: { mode: "override", value: gwId } });
    const p = plan({
      source: makeSource({ templateRules: [rule(t.id)] }),
      devices: [
        makeDevice({ externalId: "device:gw", name: "gw-host" }),
        makeDevice({ externalId: "device:1", name: "core-sw-1" })
      ],
      servers: [],
      templates: [t],
      authProfiles: []
    });
    const gwAdd = p.adds.find((a) => a.id === gwId);
    const targetId = deterministicServerId("source-1", "device:1");
    const targetAdd = p.adds.find((a) => a.id === targetId);
    expect(gwAdd).toBeDefined();
    expect(targetAdd).toBeDefined();
    // Kills d512258 (writes the self-id): the host must NOT be its own gateway.
    expect(gwAdd!.ipmiGatewayServerId).toBeUndefined();
    expect(gwAdd!.origin?.templated?.ipmiGatewayServerId).toBeUndefined();
    // The other matched server still gets the (valid, non-self) gateway.
    expect(targetAdd!.ipmiGatewayServerId).toBe(gwId);
    expect(targetAdd!.origin?.templated?.ipmiGatewayServerId).toBe(gwId);
    // Kills "silent self-skip": one warning naming the template + the host.
    expect(
      p.warnings.some((w) => /Device template "T"/.test(w) && /"gw-host"/.test(w) && /its own IPMI gateway/.test(w))
    ).toBe(true);
  });
});

describe("PR-T3 IPMI slots — FIX 2 self-gateway skip (manual folder apply)", () => {
  it("applying a gateway template to a folder containing the designated gateway host skips that host; siblings applied", () => {
    const gwHost = bystanderServer("gw-host", "gateway-host");
    const sibling = bystanderServer("srv-1", "sibling");
    const t = template({ ipmiGatewayServerId: { mode: "override", value: gwHost.id } });
    const p = planManualTemplateApply({
      template: t,
      servers: [gwHost, sibling],
      sourceDefaultUsername: () => "admin",
      authProfile: () => undefined,
      hasServer: (id) => id === gwHost.id // the gateway ref itself resolves (not dangling)
    });
    // The host self-skips: no write for it.
    expect(p.serverWrites.find((x) => x.serverId === gwHost.id)).toBeUndefined();
    // The sibling is applied.
    expect(p.serverWrites.find((x) => x.serverId === sibling.id)?.ipmiGatewayServerId).toBe(gwHost.id);
    // Kills d512258 (no self-skip → willSet 2 / skipped 0, no warning): the self is
    // counted in `skipped` (surfaced in the consent modal) + one warning.
    expect(p.ipmiGatewayServerId?.willSet).toBe(1);
    expect(p.ipmiGatewayServerId?.skipped).toBe(1);
    expect(
      p.warnings.some((w) => /Device template "T"/.test(w) && /"gateway-host"/.test(w) && /its own IPMI gateway/.test(w))
    ).toBe(true);
  });
});

// ============================================================================
// FALSIFICATION-CRITICAL: PR-T3 review round 3 (Codex) — the same-sync-pruned IPMI
// gateway survivor pass is a REJECT (drop value+stamp+provenance,
// survivor-guarded-restore, "not applied" warning), NOT the old FIX-3 "warn only,
// keep the write". Rationale: `applyInventorySyncPlan` upserts then force-clears any
// gateway ref (and its stamp) that names a delete-pruned server, so a kept-B plan
// preview + §3.4 provenance line promise a mutation that never survives. The plan's
// `after.ipmiGatewayServerId` must equal the post-apply state — a survivor or
// undefined. These fixtures REPLACE the old FIX-3 warn-only test, which asserted the
// now-wrong keep-the-write behavior (kept B + stamp + provenance, warned "remains
// until reclaimed"). Each is built to FAIL against c8850df (CLAUDE.md non-vacuity).
// ============================================================================
describe("PR-T3 IPMI slots — round 3 same-sync-pruned gateway REJECT", () => {
  // A gateway server sync-owned by this source whose device is absent this fetch, so
  // under prunePolicy:"delete" it delete-prunes. The §5.3 dangling check passed (it
  // was a live current server), so composition wrote+stamped its id onto the target.
  function prunedGateway(id: string, externalId: string): ServerConfig {
    return ownedServer(
      { id, name: id, group: "NetBox" },
      { sourceId: "source-1", externalId, syncedAt: 1000 }
    );
  }

  it("ADD path — a fresh add whose template writes gateway B (delete-pruned same sync): B is REJECTED → after.ipmiGatewayServerId undefined, no stamp, NO §3.4 gateway provenance line, and a 'not applied' warning names the template (kills c8850df, which kept B + stamp + provenance and warned 'remains until reclaimed')", () => {
    const gw = prunedGateway("gw-id", "device:gw");
    const t = template({ ipmiGatewayServerId: { mode: "override", value: "gw-id" } });
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule(t.id)] }),
      devices: [makeDevice({ externalId: "device:1", name: "core-sw-1" })], // gw device gone
      servers: [gw],
      templates: [t],
      authProfiles: []
    });
    // gw is delete-pruned this run.
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === "gw-id")).toBe(true);
    const targetId = deterministicServerId("source-1", "device:1");
    const targetAdd = p.adds.find((a) => a.id === targetId)!;
    expect(targetAdd).toBeDefined();
    // REJECT: value dropped, stamp cleared — byte-identical to post-apply state.
    expect(targetAdd.ipmiGatewayServerId).toBeUndefined();
    expect(targetAdd.origin?.templated?.ipmiGatewayServerId).toBeUndefined();
    // Provenance dropped: no gateway §3.4 line for this record. The gateway short
    // label is "IPMI Gateway"; the record's own name would front a provenance line.
    expect(p.warnings.some((w) => /\bIPMI Gateway ←/.test(w))).toBe(false);
    // "not applied" warning naming the template and this record.
    expect(
      p.warnings.some(
        (w) =>
          /Device template "T"/.test(w) &&
          /IPMI gateway/i.test(w) &&
          /will not survive this sync/.test(w) &&
          /was not applied/.test(w) &&
          /"core-sw-1"/.test(w)
      )
    ).toBe(true);
  });

  it("UPDATE override MOVE, prior survives — before.gateway = A_live (survivor, template-owned), override writes B (pruned): after RESTORED to A_live + its stamp, gateway provenance dropped, warning present; gateway-only change COLLAPSES the update to unchanged (kills c8850df keep-B, and kills leaving a now-no-op update in the plan)", () => {
    const gwLive = GW1; // a plain live server, never pruned — the still-valid prior gateway A_live
    const gwPruned = prunedGateway("gw-b", "device:gwb"); // B, delete-pruned this run
    // The target already carries A_live as a template-owned (stamped) gateway.
    const s = ownedServer(
      { ipmiGatewayServerId: gwLive.id },
      { externalId: "device:1", templated: { ipmiGatewayServerId: gwLive.id } }
    );
    const t = template({ ipmiGatewayServerId: { mode: "override", value: "gw-b" } }); // gateway is the ONLY write
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule(t.id)] }),
      devices: [makeDevice({ externalId: "device:1", name: "core-sw-1" })], // device:gwb absent → B pruned
      servers: [s, gwLive, gwPruned],
      templates: [t],
      authProfiles: []
    });
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === "gw-b")).toBe(true);
    const sId = deterministicServerId("source-1", "device:1");
    // Gateway was the only change → restoring A_live reverts it → update collapsed.
    expect(afterFor(p, sId)).toBeUndefined();
    expect(p.updates.some((u) => u.before.id === sId)).toBe(false);
    expect(p.unchangedCount).toBe(1); // s is the only owned device; gw-b is pruned
    expect(
      p.warnings.some(
        (w) => /Device template "T"/.test(w) && /will not survive this sync/.test(w) && /was not applied/.test(w)
      )
    ).toBe(true);
  });

  it("UPDATE override MOVE, prior survives, OTHER field also changed — before.gateway = A_live, override writes B (pruned) AND a rename lands: after RESTORED to A_live + stamp, the rename kept, update STAYS in `updates`, unchangedCount untouched (kills a collapse that fires when other fields genuinely changed, and confirms the restore path)", () => {
    const gwLive = GW1;
    const gwPruned = prunedGateway("gw-b", "device:gwb");
    const s = ownedServer(
      { name: "old-name", ipmiGatewayServerId: gwLive.id },
      { externalId: "device:1", templated: { ipmiGatewayServerId: gwLive.id } }
    );
    const t = template({ ipmiGatewayServerId: { mode: "override", value: "gw-b" } });
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule(t.id)] }),
      devices: [makeDevice({ externalId: "device:1", name: "core-sw-1" })], // rename old-name → core-sw-1
      servers: [s, gwLive, gwPruned],
      templates: [t],
      authProfiles: []
    });
    const sId = deterministicServerId("source-1", "device:1");
    const after = afterFor(p, sId)!;
    expect(after).toBeDefined(); // update kept — the rename genuinely changed
    expect(after.ipmiGatewayServerId).toBe(gwLive.id); // restored to the still-valid prior gateway
    expect(after.origin?.templated?.ipmiGatewayServerId).toBe(gwLive.id); // stamp follows the restored value
    expect(after.name).toBe("core-sw-1"); // the genuine change intact
    expect(p.unchangedCount).toBe(0);
  });

  it("SURVIVOR GUARD — before.gateway = A_pruned (ALSO delete-pruned this run), override writes B (pruned): after is UNDEFINED (NOT restored to A_pruned), stamp cleared. This is the case that fails if you blindly mirror proxy's unconditional restore (kills restoring a prior gateway that is itself being pruned — which would re-create the plan/apply mismatch)", () => {
    const gwPriorPruned = prunedGateway("gw-a", "device:gwa"); // A_pruned — delete-pruned this run
    const gwNewPruned = prunedGateway("gw-b", "device:gwb"); // B — delete-pruned this run
    const s = ownedServer(
      { ipmiGatewayServerId: "gw-a" },
      { externalId: "device:1", templated: { ipmiGatewayServerId: "gw-a" } }
    );
    const t = template({ ipmiGatewayServerId: { mode: "override", value: "gw-b" } });
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule(t.id)] }),
      devices: [makeDevice({ externalId: "device:1", name: "core-sw-1" })], // both gwa + gwb devices absent
      servers: [s, gwPriorPruned, gwNewPruned],
      templates: [t],
      authProfiles: []
    });
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === "gw-a")).toBe(true);
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === "gw-b")).toBe(true);
    const sId = deterministicServerId("source-1", "device:1");
    const after = afterFor(p, sId);
    // The prior A_pruned is NOT a survivor → the guard drops rather than restores.
    // `after.ipmiGatewayServerId` is always survivor-or-undefined post-reject.
    if (after !== undefined) {
      expect(after.ipmiGatewayServerId).toBeUndefined();
      expect(after.origin?.templated?.ipmiGatewayServerId).toBeUndefined();
    } else {
      // Update may collapse to unchanged if before also had no other diff and
      // before.gateway (gw-a) matches the dropped undefined... but before carried
      // gw-a, so after (undefined) differs and the update is kept. Guard the branch
      // regardless — the observable invariant is "never gw-a, never gw-b".
      expect(after).toBeDefined();
    }
    // Neither pruned gateway is written anywhere in the plan's surviving adds/updates.
    for (const rec of [...p.adds, ...p.updates.map((u) => u.after)]) {
      expect(rec.ipmiGatewayServerId).not.toBe("gw-a");
      expect(rec.ipmiGatewayServerId).not.toBe("gw-b");
    }
  });

  it("NEGATIVE — a written gateway that SURVIVES is kept + stamped + provenance intact, no warning (regression: the reject pass must not touch a valid write)", () => {
    const s = ownedServer({}, { externalId: "device:1" });
    const t = template({ ipmiGatewayServerId: { mode: "fill", value: GW1.id } });
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule(t.id)] }),
      devices: [makeDevice({ externalId: "device:1", name: "core-sw-1" })],
      servers: [s, GW1], // GW1 is a live bystander → survivor
      templates: [t],
      authProfiles: []
    });
    const sId = deterministicServerId("source-1", "device:1");
    const after = afterFor(p, sId)!;
    expect(after.ipmiGatewayServerId).toBe(GW1.id);
    expect(after.origin?.templated?.ipmiGatewayServerId).toBe(GW1.id);
    // provenance line for the survivor gateway is present.
    expect(p.warnings.some((w) => /\bIPMI Gateway ←/.test(w))).toBe(true);
    expect(p.warnings.some((w) => /was not applied/.test(w))).toBe(false);
  });

  it("NEGATIVE — a HAND-set gateway (no matching stamp) pointing at a pruned server is left alone (§8.4 — not this pass's job)", () => {
    const gwPruned = prunedGateway("gw-b", "device:gwb");
    // s carries gw-b as a HAND value (no origin.templated stamp for the gateway).
    const s = ownedServer({ name: "old-name", ipmiGatewayServerId: "gw-b" }, { externalId: "device:1" });
    // A template that writes some OTHER field so this is an update, but does NOT
    // write the gateway → gateway is not in `ipmiGatewayTemplateNameByServerId`.
    const t = template({ multiplexing: { mode: "fill", value: true } });
    const p = plan({
      source: makeSource({ prunePolicy: "delete", templateRules: [rule(t.id)] }),
      devices: [makeDevice({ externalId: "device:1", name: "core-sw-1" })],
      servers: [s, gwPruned],
      templates: [t],
      authProfiles: []
    });
    const sId = deterministicServerId("source-1", "device:1");
    const after = afterFor(p, sId)!;
    expect(after).toBeDefined();
    // Hand gateway untouched — reject pass is stamp-gated and template-write-gated.
    expect(after.ipmiGatewayServerId).toBe("gw-b");
    expect(p.warnings.some((w) => /was not applied/.test(w))).toBe(false);
  });
});

// ============================================================================
// FALSIFICATION-CRITICAL: PR-T3 review round 4 (Codex) — the RETAINED-gateway
// sibling of round 3's written-gateway reject. A server carrying a TEMPLATE-OWNED
// gateway from an EARLIER sync that THIS run does NOT re-write (row-4 unchanged
// winner / row-5 after the rule disappears) is absent from
// `ipmiGatewayTemplateNameByServerId`, so round 3's written pass skips it. If that
// retained gateway names a server delete-pruned this same sync, the plan preview
// keeps value+stamp with no warning, but `applyInventorySyncPlan`'s
// `clearGatewayReferencesTo` wipes both → preview lies. This gateway PART 2 pass
// (mirroring proxy PART 2a/2b) drops the retained dangling gateway in the preview
// so it matches the post-apply state. Each fixture is built to FAIL against
// 60812e8 (which has no retained-gateway pass). Deliberate divergence from proxy:
// NO self-gateway drop (a self-gateway is a survivor + harmless local — negative
// test below proves it).
// ============================================================================
describe("PR-T3 IPMI slots — round 4 retained same-sync-pruned gateway cleanup", () => {
  // A gateway server sync-owned by this source whose device is absent this fetch,
  // so under prunePolicy:"delete" it delete-prunes — a non-survivor.
  function prunedGateway(id: string, externalId: string): ServerConfig {
    return ownedServer({ id, name: id, group: "NetBox" }, { sourceId: "source-1", externalId, syncedAt: 1000 });
  }

  it("RETAINED update-in-place — S RETAINS a template-owned gateway → GW (row-5 carry, no rule writes it), GW delete-pruned this sync, AND S is RENAMED (unrelated update) → after.ipmiGatewayServerId ABSENT, stamp cleared, rename preserved, one 'was removed' warning (kills 60812e8, which retains the dangling gateway on the already-planned update)", () => {
    const gw = prunedGateway("gw-ret", "device:gwret");
    // S: retained template-owned gateway → gw (value === stamp). NO template rule
    // writes the gateway this run, so it is a row-5 receipt round 3's written pass
    // never inspects. A rename is the unrelated change that puts S in `updates`.
    const s = ownedServer(
      { name: "old-name", ipmiGatewayServerId: "gw-ret" },
      { externalId: "device:1", templated: { ipmiGatewayServerId: "gw-ret" } }
    );
    const p = plan({
      source: makeSource({ prunePolicy: "delete" }), // no template rules — the gateway is a retained receipt
      devices: [makeDevice({ externalId: "device:1", name: "core-sw-1" })], // rename old-name → core-sw-1; device:gwret absent → gw pruned
      servers: [s, gw]
    });
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === "gw-ret")).toBe(true);
    const sId = deterministicServerId("source-1", "device:1");
    const after = afterFor(p, sId);
    expect(after).toBeDefined(); // the rename kept S in updates
    expect(after!.name).toBe("core-sw-1"); // the unrelated change preserved
    expect(after!.ipmiGatewayServerId).toBeUndefined(); // THE FIX: retained dangling gateway dropped IN PLACE
    expect("ipmiGatewayServerId" in after!).toBe(false); // absent, never a written undefined
    expect(after!.origin?.templated?.ipmiGatewayServerId).toBeUndefined(); // the ownership stamp cleared with it
    expect(
      p.warnings.some((w) => /IPMI gateway/i.test(w) && /will not survive this sync/.test(w) && /was removed/.test(w))
    ).toBe(true);
  });

  it("RETAINED unplanned promotion — an otherwise-UNCHANGED S retaining a template-owned dangling gateway is PROMOTED to a new update dropping it (value absent, stamp cleared), warning present, unchangedCount decremented by exactly 1 (kills 60812e8, which leaves S unchanged with a dangling gateway)", () => {
    const gw = prunedGateway("gw-ret", "device:gwret");
    const s = ownedServer(
      { ipmiGatewayServerId: "gw-ret" },
      { externalId: "device:1", templated: { ipmiGatewayServerId: "gw-ret" } }
    );
    const p = plan({
      source: makeSource({ prunePolicy: "delete" }),
      devices: [makeDevice({ externalId: "device:1", name: "core-sw-1" })], // S name/endpoint unchanged → counted unchanged
      servers: [s, gw]
    });
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === "gw-ret")).toBe(true);
    const sId = deterministicServerId("source-1", "device:1");
    const after = afterFor(p, sId);
    expect(after).toBeDefined(); // promoted to a new update
    expect(after!.ipmiGatewayServerId).toBeUndefined();
    expect("ipmiGatewayServerId" in after!).toBe(false);
    expect(after!.origin?.templated?.ipmiGatewayServerId).toBeUndefined();
    expect(p.unchangedCount).toBe(0); // counted unchanged (tally 1), then decremented by exactly 1 on promotion
    expect(
      p.warnings.some((w) => /IPMI gateway/i.test(w) && /will not survive this sync/.test(w) && /was removed/.test(w))
    ).toBe(true);
  });

  it("BOTH proxy+gateway dangling on ONE unplanned server — exactly ONE update entry, BOTH dropped, unchangedCount decremented by exactly 1 (NOT 2): proves no double-promotion (kills 60812e8, where the gateway is never dropped)", () => {
    // One pruned server that is BOTH S's jump-host proxy AND its IPMI gateway.
    const dangler = prunedGateway("dangler", "device:dangler");
    const s = ownedServer(
      { proxy: { type: "ssh", jumpHostId: "dangler" }, ipmiGatewayServerId: "dangler" },
      {
        externalId: "device:1",
        templated: { proxy: { type: "ssh", jumpHostId: "dangler" }, ipmiGatewayServerId: "dangler" }
      }
    );
    const p = plan({
      source: makeSource({ prunePolicy: "delete" }),
      devices: [makeDevice({ externalId: "device:1", name: "core-sw-1" })], // S unchanged; device:dangler absent → pruned
      servers: [s, dangler]
    });
    expect(p.prunes.some((pr) => pr.policy === "delete" && pr.server.id === "dangler")).toBe(true);
    const sId = deterministicServerId("source-1", "device:1");
    // Exactly ONE update entry for S — proxy PART 2b promoted it, gateway PART 2a
    // cleaned the gateway on that SAME entry (fresh planned-set skip prevents a
    // second promotion).
    const sUpdates = p.updates.filter((u) => u.before.id === sId);
    expect(sUpdates.length).toBe(1);
    const after = sUpdates[0].after;
    expect(after.proxy).toBeUndefined(); // proxy dropped by proxy PART 2b
    expect(after.ipmiGatewayServerId).toBeUndefined(); // gateway dropped by gateway PART 2a
    expect(after.origin?.templated?.proxy).toBeUndefined();
    expect(after.origin?.templated?.ipmiGatewayServerId).toBeUndefined();
    expect(p.unchangedCount).toBe(0); // counted unchanged (tally 1), decremented ONCE — not twice
  });

  it("NEGATIVE — a retained gateway pointing at a SURVIVOR is untouched, NOT promoted, not warned (regression: an unchanged server stays unchanged)", () => {
    const s = ownedServer(
      { ipmiGatewayServerId: GW1.id }, // GW1 is a live bystander → survivor
      { externalId: "device:1", templated: { ipmiGatewayServerId: GW1.id } }
    );
    const p = plan({
      source: makeSource({ prunePolicy: "delete" }),
      devices: [makeDevice({ externalId: "device:1", name: "core-sw-1" })],
      servers: [s, GW1]
    });
    const sId = deterministicServerId("source-1", "device:1");
    expect(afterFor(p, sId)).toBeUndefined(); // no update — nothing to clean
    expect(p.unchangedCount).toBe(1);
    expect(p.warnings.some((w) => /was removed/.test(w))).toBe(false);
  });

  it("NEGATIVE — a HAND-set gateway (no matching stamp) pointing at a pruned server is left alone (§8.4)", () => {
    const gw = prunedGateway("gw-ret", "device:gwret");
    // S carries gw-ret as a HAND value — NO origin.templated stamp for the gateway.
    const s = ownedServer({ ipmiGatewayServerId: "gw-ret" }, { externalId: "device:1", templated: undefined });
    const p = plan({
      source: makeSource({ prunePolicy: "delete" }),
      devices: [makeDevice({ externalId: "device:1", name: "core-sw-1" })],
      servers: [s, gw]
    });
    const sId = deterministicServerId("source-1", "device:1");
    const record = afterFor(p, sId) ?? s;
    expect(record.ipmiGatewayServerId).toBe("gw-ret"); // hand gateway kept — §8.4
    expect(p.warnings.some((w) => /was removed/.test(w))).toBe(false);
  });

  it("NEGATIVE (no-self-drop divergence) — a retained SELF-gateway (ipmiGatewayServerId === own id, stamped) is LEFT ALONE and NOT promoted (a self-gateway is a survivor + harmless local; proves the deliberate divergence from the proxy self-drop)", () => {
    const sId = deterministicServerId("source-1", "device:1");
    // S's retained template-owned gateway points at ITSELF. Unlike a self-proxy
    // (which proxy PART 2 drops as a §5.3 circular ref), a self-gateway is a
    // survivor and resolves harmlessly to local — so it must be retained.
    const s = ownedServer(
      { id: sId, ipmiGatewayServerId: sId },
      { externalId: "device:1", templated: { ipmiGatewayServerId: sId } }
    );
    const p = plan({
      source: makeSource({ prunePolicy: "delete" }),
      devices: [makeDevice({ externalId: "device:1", name: "core-sw-1" })], // S unchanged
      servers: [s]
    });
    // NOT promoted — no update, self-gateway retained.
    expect(afterFor(p, sId)).toBeUndefined();
    expect(p.unchangedCount).toBe(1);
    expect(p.warnings.some((w) => /was removed/.test(w))).toBe(false);
    // The retained self-gateway value + stamp survive untouched.
    expect(s.ipmiGatewayServerId).toBe(sId);
    expect(s.origin?.templated?.ipmiGatewayServerId).toBe(sId);
  });
});
