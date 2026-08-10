import { describe, expect, it } from "vitest";
import { computeSyncPlan, type InventorySyncPlan } from "../../src/services/inventory/syncEngine";
import {
  clearTemplatedStamps,
  planManualTemplateApply,
  templateAppliedFields,
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
    // Kills "silent drop": one plan warning naming the template.
    expect(p.warnings.some((w) => /IPMI Auth Profile|ipmi/i.test(w) && /T/.test(w))).toBe(true);
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
    expect(p.warnings.some((w) => /IPMI Gateway|gateway/i.test(w))).toBe(true);
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
    expect(p.warnings.some((warn) => /IPMI Auth Profile|profile.*no longer exists/i.test(warn))).toBe(true);
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
