import { describe, expect, it, vi } from "vitest";
// `sanitizeForSharing` lives in configCommands, which imports `vscode` at module
// scope (used only inside functions), so a bare module stub is enough to load it.
vi.mock("vscode", () => ({}));
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { sanitizeForSharing } from "../../src/commands/configCommands";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import type { DeviceTemplateProfile } from "../../src/models/deviceTemplate";
import type { InventorySourceConfig } from "../../src/models/inventory";

/**
 * DEVICE TEMPLATES (issue #48 PR-T1) — §6.2 template deletion sweep, §8.4
 * removeAuthProfile template clause, storage round-trip, and A-M5 share
 * exclusion (fixtures 25, 26).
 */

function source(id: string, overrides: Partial<InventorySourceConfig> = {}): InventorySourceConfig {
  return {
    id,
    providerId: "netbox",
    name: id,
    targetFolder: "NetBox",
    prunePolicy: "orphan",
    defaultUsername: "admin",
    config: {},
    secretFieldIds: [],
    ...overrides
  };
}

function tmpl(id: string, fields: DeviceTemplateProfile["fields"] = {}): DeviceTemplateProfile {
  return { id, name: id, fields };
}

describe("Fixture 25 — removeDeviceTemplate sweep (§6.2)", () => {
  it("clears the referencing rule on EVERY source and re-revisions them, leaving server values/stamps untouched", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateDeviceTemplate(tmpl("T"));
    await core.addOrUpdateInventorySource(source("s1", { templateRules: [{ id: "r1", templateId: "T" }] }));
    await core.addOrUpdateInventorySource(source("s2", { templateRules: [{ id: "r2", templateId: "T" }, { id: "r3", templateId: "other" }] }));
    // A synced server carrying template-applied values + stamps.
    const server: ServerConfig = {
      id: "srv-1",
      name: "sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      proxy: { type: "socks5", host: "10.9.9.1", port: 1080 },
      origin: { sourceId: "s1", externalId: "device:1", syncedAt: 1, templated: { proxy: { type: "socks5", host: "10.9.9.1", port: 1080 } } }
    };
    await core.addOrUpdateServer(server);

    const rev1Before = core.getInventorySource("s1")!.revision;
    const rev2Before = core.getInventorySource("s2")!.revision;

    await core.removeDeviceTemplate("T");

    expect(core.getDeviceTemplate("T")).toBeUndefined();
    // s1's only rule referenced T → cleared; s2 keeps its unrelated rule.
    expect(core.getInventorySource("s1")!.templateRules).toEqual([]);
    expect(core.getInventorySource("s2")!.templateRules).toEqual([{ id: "r3", templateId: "other" }]);
    // Both were re-revisioned (an in-flight sync must abort).
    expect(core.getInventorySource("s1")!.revision).not.toBe(rev1Before);
    expect(core.getInventorySource("s2")!.revision).not.toBe(rev2Before);
    // Server values AND stamps are untouched (row 5: kept, reclaimable).
    const kept = core.getServer("srv-1")!;
    expect(kept.proxy).toEqual({ type: "socks5", host: "10.9.9.1", port: 1080 });
    expect(kept.origin?.templated?.proxy).toEqual({ type: "socks5", host: "10.9.9.1", port: 1080 });
  });

  it("a pre-commit save rejection restores the captured template AND the captured sources (kills a rollback that restores sources but leaves the template half-swept)", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateDeviceTemplate(tmpl("T"));
    await core.addOrUpdateInventorySource(source("s1", { templateRules: [{ id: "r1", templateId: "T" }] }));

    // Reject the commit-gate save (saveDeviceTemplates) → nothing committed.
    vi.spyOn(repo, "saveDeviceTemplates").mockRejectedValueOnce(new Error("disk full"));
    await expect(core.removeDeviceTemplate("T")).rejects.toThrow("disk full");

    expect(core.getDeviceTemplate("T")).toBeDefined(); // template restored
    expect(core.getInventorySource("s1")!.templateRules).toEqual([{ id: "r1", templateId: "T" }]); // rule restored
  });
});

describe("Fixture 25 — removeAuthProfile template clause (§8.4)", () => {
  it("clears a template's fields.authProfileId when the named profile is deleted (kills a sweep that forgets templates)", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    const profile: AuthProfile = { id: "P", name: "P", username: "svc", authType: "agent" };
    await core.addOrUpdateAuthProfile(profile);
    // The template is the ONLY referrer of P — else the sweep hides behind a
    // server-side clear.
    await core.addOrUpdateDeviceTemplate(tmpl("T", { authProfileId: { mode: "fill", value: "P" }, multiplexing: { mode: "override", value: true } }));
    const revBefore = core.getDeviceTemplate("T")!.revision;

    await core.removeAuthProfile("P");

    const swept = core.getDeviceTemplate("T")!;
    expect(swept.fields.authProfileId).toBeUndefined();
    expect(swept.fields.multiplexing).toEqual({ mode: "override", value: true }); // other fields intact
    expect(swept.revision).not.toBe(revBefore); // re-revisioned
  });

  it("(PR-T3) clears a template's fields.ipmiAuthProfileId when the named profile is deleted (kills a sweep that forgets the new BMC template field)", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    const profile: AuthProfile = { id: "P", name: "P", username: "svc", authType: "agent" };
    await core.addOrUpdateAuthProfile(profile);
    await core.addOrUpdateDeviceTemplate(tmpl("T", { ipmiAuthProfileId: { mode: "fill", value: "P" }, multiplexing: { mode: "override", value: true } }));
    const revBefore = core.getDeviceTemplate("T")!.revision;

    await core.removeAuthProfile("P");

    const swept = core.getDeviceTemplate("T")!;
    expect(swept.fields.ipmiAuthProfileId).toBeUndefined();
    expect(swept.fields.multiplexing).toEqual({ mode: "override", value: true }); // other fields intact
    expect(swept.revision).not.toBe(revBefore); // re-revisioned
  });

  it("(PR-T3) a template naming the deleted profile in BOTH authProfileId and ipmiAuthProfileId loses BOTH fields (kills a sweep that clears only one link)", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    const profile: AuthProfile = { id: "P", name: "P", username: "svc", authType: "agent" };
    await core.addOrUpdateAuthProfile(profile);
    await core.addOrUpdateDeviceTemplate(
      tmpl("T", {
        authProfileId: { mode: "fill", value: "P" },
        ipmiAuthProfileId: { mode: "fill", value: "P" },
        logSession: { mode: "override", value: true }
      })
    );

    await core.removeAuthProfile("P");

    const swept = core.getDeviceTemplate("T")!;
    expect(swept.fields.authProfileId).toBeUndefined();
    expect(swept.fields.ipmiAuthProfileId).toBeUndefined();
    expect(swept.fields.logSession).toEqual({ mode: "override", value: true }); // unrelated field intact
  });
});

describe("Fixture 26 — storage round-trip + share exclusion", () => {
  it("a template + source rule + server templated stamp all survive a repository reload", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateDeviceTemplate(tmpl("T", { proxy: { mode: "override", value: { type: "socks5", host: "10.9.9.1", port: 1080 } } }));
    await core.addOrUpdateInventorySource(source("s1", { templateRules: [{ id: "r1", templateId: "T", filter: "role=switch" }] }));
    await core.addOrUpdateServer({
      id: "srv-1",
      name: "sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      origin: { sourceId: "s1", externalId: "device:1", syncedAt: 1, templated: { multiplexing: false } }
    });

    const core2 = new NexusCore(repo);
    await core2.initialize();
    expect(core2.getDeviceTemplate("T")?.fields.proxy?.value).toEqual({ type: "socks5", host: "10.9.9.1", port: 1080 });
    expect(core2.getInventorySource("s1")?.templateRules).toEqual([{ id: "r1", templateId: "T", filter: "role=switch" }]);
    // The boolean-false stamp survives the round trip (present-when-false).
    expect(core2.getServer("srv-1")?.origin?.templated?.multiplexing).toBe(false);
  });

  it("the sanitized SHARE export carries no deviceTemplates bucket (A-M5, mirroring inventory sources)", () => {
    const sanitized = sanitizeForSharing([], [], [], [], {}, [], []);
    expect("deviceTemplates" in sanitized).toBe(false);
    expect("inventorySources" in sanitized).toBe(false);
  });

  it("PR-T3 — a template carrying both IPMI id fields + a server's IPMI stamps survive a repository reload (fixture 26 / F)", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateDeviceTemplate(
      tmpl("Tipmi", {
        ipmiAuthProfileId: { mode: "fill", value: "bmc-prof" },
        ipmiGatewayServerId: { mode: "override", value: "mgmt-host" }
      })
    );
    await core.addOrUpdateServer({
      id: "srv-ipmi",
      name: "sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      ipmiAuthProfileId: "bmc-prof",
      ipmiGatewayServerId: "mgmt-host",
      origin: {
        sourceId: "s1",
        externalId: "device:1",
        syncedAt: 1,
        templated: { ipmiAuthProfileId: "bmc-prof", ipmiGatewayServerId: "mgmt-host" }
      }
    });

    const core2 = new NexusCore(repo);
    await core2.initialize();
    const t = core2.getDeviceTemplate("Tipmi");
    expect(t?.fields.ipmiAuthProfileId).toEqual({ mode: "fill", value: "bmc-prof" });
    expect(t?.fields.ipmiGatewayServerId).toEqual({ mode: "override", value: "mgmt-host" });
    const s = core2.getServer("srv-ipmi");
    expect(s?.ipmiAuthProfileId).toBe("bmc-prof");
    expect(s?.ipmiGatewayServerId).toBe("mgmt-host");
    expect(s?.origin?.templated?.ipmiAuthProfileId).toBe("bmc-prof");
    expect(s?.origin?.templated?.ipmiGatewayServerId).toBe("mgmt-host");
  });
});
