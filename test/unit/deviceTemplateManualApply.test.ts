import { describe, expect, it } from "vitest";
import { computeSyncPlan, type InventorySyncPlan } from "../../src/services/inventory/syncEngine";
import {
  planManualTemplateApply,
  clearTemplatedStamps,
  type ManualApplyPlan
} from "../../src/services/inventory/templateApply";
import { deterministicServerId } from "../../src/services/inventory/deterministicId";
import type { AuthProfile, ProxyConfig, ServerConfig, ServerOrigin } from "../../src/models/config";
import type { InventoryDevice, InventorySourceConfig, InventoryTree, TemplateRule } from "../../src/models/inventory";
import type { DeviceTemplateProfile } from "../../src/models/deviceTemplate";

/**
 * DEVICE TEMPLATES (issue #48 PR-T1b, §7.4) — the MANUAL folder-apply path.
 * Fixtures 23/23b/24/24b/24c/24d of §10, each built to FAIL against the specific
 * wrong implementation its "Kills:" note names. The decision path under test is
 * `planManualTemplateApply` (the one shared with the command), plus the stamp
 * clear (`clearTemplatedStamps`) and, for 23, a subsequent `computeSyncPlan` that
 * proves the field is now row 7.
 */

const P: ProxyConfig = { type: "socks5", host: "10.9.9.1", port: 1080 };
const P_PRIME: ProxyConfig = { type: "socks5", host: "10.9.9.2", port: 1080 };
const P_B: ProxyConfig = { type: "socks5", host: "10.9.9.9", port: 1080 };

function template(fields: DeviceTemplateProfile["fields"], id = "tmpl-1", name = "T"): DeviceTemplateProfile {
  return { id, name, fields };
}

function authProfile(id: string, overrides: Partial<AuthProfile> = {}): AuthProfile {
  return { id, name: id.toUpperCase(), username: "svc", authType: "agent", ...overrides };
}

const KEYLESS = authProfile("keyless", { authType: "key", keyPath: undefined });
const NORMAL = authProfile("normal", { authType: "agent" });

/** Apply the plan's write for one server the way the command does (§7.4). */
function applyManual(server: ServerConfig, plan: ManualApplyPlan): ServerConfig {
  const w = plan.serverWrites.find((x) => x.serverId === server.id);
  if (!w) {
    return server;
  }
  const next: ServerConfig = { ...server };
  if (w.proxy !== undefined) next.proxy = w.proxy;
  if (w.multiplexing !== undefined) next.multiplexing = w.multiplexing;
  if (w.legacyAlgorithms !== undefined) next.legacyAlgorithms = w.legacyAlgorithms;
  if (w.logSession !== undefined) next.logSession = w.logSession;
  if (w.authProfileId !== undefined) next.authProfileId = w.authProfileId;
  const cleared = clearTemplatedStamps(server.origin, w.writtenFields);
  if (cleared === undefined) {
    delete next.origin;
  } else {
    next.origin = cleared;
  }
  return next;
}

interface PlanCtxOverrides {
  sourceDefaultUsername?: (sourceId: string) => string | undefined;
  authProfiles?: AuthProfile[];
  liveServerIds?: string[];
}

function runPlan(template: DeviceTemplateProfile, servers: ServerConfig[], o: PlanCtxOverrides = {}): ManualApplyPlan {
  const byId = new Map((o.authProfiles ?? [KEYLESS, NORMAL]).map((p) => [p.id, p] as const));
  return planManualTemplateApply({
    template,
    servers,
    sourceDefaultUsername: o.sourceDefaultUsername ?? (() => "admin"),
    authProfile: (id) => byId.get(id),
    hasServer: (id) => (o.liveServerIds ? o.liveServerIds.includes(id) : true)
  });
}

// ---- second-sync helpers (fixture 23) -------------------------------------
function makeSource(overrides: Partial<InventorySourceConfig> = {}): InventorySourceConfig {
  return { id: "source-1", providerId: "netbox", name: "NetBox", targetFolder: "NetBox", prunePolicy: "orphan", defaultUsername: "admin", config: {}, secretFieldIds: [], ...overrides };
}
function device(): InventoryDevice {
  return { externalId: "device:1", name: "core-sw-1", endpoints: [{ kind: "ssh", host: "10.0.0.1" }] };
}
function tree(devices: InventoryDevice[]): InventoryTree {
  return { contractVersion: 1, devices };
}
function ownedServer(overrides: Partial<ServerConfig> = {}, origin: Partial<ServerOrigin> = {}): ServerConfig {
  return {
    id: deterministicServerId("source-1", "device:1"),
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
function secondSync(source: InventorySourceConfig, servers: ServerConfig[], templates: DeviceTemplateProfile[], authProfiles: AuthProfile[] = []): InventorySyncPlan {
  return computeSyncPlan({
    source,
    tree: tree([device()]),
    currentServers: servers,
    now: 5000,
    templatesById: new Map(templates.map((t) => [t.id, t] as const)),
    authProfilesById: new Map(authProfiles.map((p) => [p.id, p] as const))
  });
}
function afterFor(p: InventorySyncPlan, id: string): ServerConfig | undefined {
  return p.updates.find((u) => u.before.id === id)?.after;
}

// ---------------------------------------------------------------------------

describe("fixture 23 — manual apply CLEARS the stamps it writes (value == stamp)", () => {
  it("proxy: value equals stamp, stamp becomes absent, and a later OVERRIDE sync leaves the value (row 7)", () => {
    // Sync-owned server: proxy P, templated.proxy P (a previous sync applied T).
    const server = ownedServer({ proxy: P }, { templated: { proxy: P } });
    // The commonest real invocation: manually apply THE SAME template T, whose
    // proxy is OVERRIDE (so the manual apply actually WRITES the field even
    // though the value already equals what is there — value equality is the
    // point, fixture note (i)).
    const T = template({ proxy: { mode: "override", value: P } });
    const plan = runPlan(T, [server]);
    const applied = applyManual(server, plan);

    // (a) the stamp is now ABSENT — not merely "the same as before".
    expect(applied.origin?.templated?.proxy).toBeUndefined();
    expect(applied.proxy).toEqual(P);

    // (b) a subsequent sync whose winner is OVERRIDE with P' != P leaves the
    // proxy at P (row 7). Fixture note (ii): the winner MUST be override, or the
    // mode gate would leave the value alone anyway and the assertion would pass
    // against the broken (stamp-preserving) implementation.
    const T2 = template({ proxy: { mode: "override", value: P_PRIME } }, "tmpl-2");
    const p = secondSync(makeSource({ templateRules: [{ id: "r", templateId: "tmpl-2" }] }), [applied], [T2]);
    expect((afterFor(p, applied.id) ?? applied).proxy).toEqual(P);
  });

  it("auth sibling: writing the auth link clears syncedAuthProfileId, and a later override auth rule does not move it", () => {
    const server = ownedServer({ authProfileId: undefined, username: "admin" }, { syncedUsername: "admin" });
    const T = template({ authProfileId: { mode: "override", value: "normal" } });
    const plan = runPlan(T, [server], { authProfiles: [NORMAL] });
    const applied = applyManual(server, plan);
    expect(applied.authProfileId).toBe("normal");
    expect(applied.origin?.syncedAuthProfileId).toBeUndefined();

    // Next sync: an override auth rule naming a different profile does NOT move
    // the now-hand-owned link (row 7 for auth — stamp absent).
    const T2 = template({ authProfileId: { mode: "override", value: "other" } }, "tmpl-2");
    const p = secondSync(
      makeSource({ templateRules: [{ id: "r", templateId: "tmpl-2" }] }),
      [applied],
      [T2],
      [NORMAL, authProfile("other")]
    );
    expect((afterFor(p, applied.id) ?? applied).authProfileId).toBe("normal");
  });
});

describe("fixture 23b — the stamp clear is scoped to WRITTEN fields", () => {
  it("a skipped fill proxy keeps its stamp; a written multiplexing clears only its own", () => {
    // proxy already set (fill will skip it); multiplexing written.
    const server = ownedServer({ proxy: P, multiplexing: false }, { templated: { proxy: P, multiplexing: false } });
    const T = template({
      proxy: { mode: "fill", value: P }, // server has a proxy → skipped
      multiplexing: { mode: "override", value: true } // written
    });
    const plan = runPlan(T, [server]);
    const applied = applyManual(server, plan);

    // proxy stamp SURVIVES untouched; multiplexing stamp is cleared.
    expect(applied.origin?.templated?.proxy).toEqual(P);
    expect(applied.origin?.templated?.multiplexing).toBeUndefined();
    expect(applied.multiplexing).toBe(true);
  });
});

describe("fixture 24 — mode is honored on the manual path", () => {
  it("fill onto a server with an existing proxy skips; override writes", () => {
    const server = ownedServer({ proxy: P });
    const fill = runPlan(template({ proxy: { mode: "fill", value: P_B } }), [server]);
    expect(fill.proxy?.willSet).toBe(0);
    expect(fill.proxy?.skipped).toBe(1);
    expect(fill.serverWrites).toHaveLength(0);

    const override = runPlan(template({ proxy: { mode: "override", value: P_B } }), [server]);
    expect(override.proxy?.willSet).toBe(1);
    expect(override.serverWrites[0].proxy).toEqual(P_B);
  });
});

describe("fixture 24b — manual auth-FILL honors the six eligibility clauses", () => {
  const authFillTemplate = template({ authProfileId: { mode: "fill", value: "normal" } });

  it("main: empty link but a hand-configured key login → SKIPPED, keyPath untouched, counted 'SSH login already configured' not 'already linked'", () => {
    // Non-synced (hand-created): keyPath + authType key + hand-typed username.
    const server: ServerConfig = {
      id: "srv-hand",
      name: "hand",
      host: "h",
      port: 22,
      username: "operator",
      authType: "key",
      keyPath: "~/.ssh/id_prod",
      isHidden: false
    };
    const plan = runPlan(authFillTemplate, [server], { authProfiles: [NORMAL] });
    expect(plan.auth?.linked).toBe(0);
    expect(plan.auth?.skippedAlreadyLinked).toBe(0);
    expect(plan.auth?.skippedLoginConfigured).toBe(1);
    expect(plan.serverWrites).toHaveLength(0); // keyPath/authType/username untouched
  });

  it("(a) hand-created agent, no key, no origin → skipped (clause 6 has no baseline)", () => {
    const server: ServerConfig = { id: "srv-a", name: "a", host: "h", port: 22, username: "operator", authType: "agent", isHidden: false };
    const plan = runPlan(authFillTemplate, [server], { authProfiles: [NORMAL] });
    expect(plan.auth?.linked).toBe(0);
    expect(plan.auth?.skippedLoginConfigured).toBe(1);
  });

  it("(b) synced server in the add-path shape (agent, no key, username === syncedUsername) → LINKED", () => {
    const server = ownedServer({ id: "srv-b", authProfileId: undefined, username: "admin" }, { syncedUsername: "admin" });
    const plan = runPlan(authFillTemplate, [server], { authProfiles: [NORMAL] });
    expect(plan.auth?.linked).toBe(1);
    expect(plan.serverWrites.find((w) => w.serverId === "srv-b")?.authProfileId).toBe("normal");
  });

  it("(c) synced server whose username was hand-edited away from syncedUsername → skipped", () => {
    const server = ownedServer({ id: "srv-c", authProfileId: undefined, username: "root" }, { syncedUsername: "admin" });
    const plan = runPlan(authFillTemplate, [server], { authProfiles: [NORMAL] });
    expect(plan.auth?.linked).toBe(0);
    expect(plan.auth?.skippedLoginConfigured).toBe(1);
  });

  it("(d) synced server whose source is gone and carries no syncedUsername → skipped, fail closed", () => {
    const server = ownedServer({ id: "srv-d", authProfileId: undefined, username: "admin" }, { syncedUsername: undefined, sourceId: "gone" });
    const plan = runPlan(authFillTemplate, [server], { authProfiles: [NORMAL], sourceDefaultUsername: () => undefined });
    expect(plan.auth?.linked).toBe(0);
    expect(plan.auth?.skippedLoginConfigured).toBe(1);
  });

  it("(e) link unset but syncedAuthProfileId present (row-2 opt-out) → skipped by fill", () => {
    const server = ownedServer({ id: "srv-e", authProfileId: undefined, username: "admin" }, { syncedUsername: "admin", syncedAuthProfileId: "C" });
    const plan = runPlan(authFillTemplate, [server], { authProfiles: [NORMAL] });
    expect(plan.auth?.linked).toBe(0);
    expect(plan.serverWrites).toHaveLength(0);
  });
});

describe("fixture 24c — manual auth-OVERRIDE is deliberately unconstrained", () => {
  it("the same hand-configured servers 24b skips are LINKED under override, and the replacing count is reported", () => {
    const handAgent: ServerConfig = { id: "srv-a", name: "a", host: "h", port: 22, username: "operator", authType: "agent", isHidden: false };
    const handKey: ServerConfig = { id: "srv-hand", name: "hand", host: "h", port: 22, username: "operator", authType: "key", keyPath: "~/.ssh/id_prod", isHidden: false };
    const plan = runPlan(template({ authProfileId: { mode: "override", value: "normal" } }), [handAgent, handKey], { authProfiles: [NORMAL] });
    expect(plan.auth?.linked).toBe(2);
    expect(plan.auth?.replacingHandConfigured).toBe(2);
    expect(plan.auth?.skippedNeedsKey).toBe(0);
  });
});

describe("fixture 24d — keyless key profile judged per TARGET, outcome differs by mode (full 2×2 in one fixture)", () => {
  // X brings its own key; Y none. Both otherwise eligible synced servers.
  const X = ownedServer({ id: "srv-x", authProfileId: undefined, username: "admin", keyPath: "~/.ssh/id_x" }, { syncedUsername: "admin" });
  const Y = ownedServer({ id: "srv-y", authProfileId: undefined, username: "admin" }, { syncedUsername: "admin" });

  it("FILL: X skipped by clause 5 (login configured), Y skipped by usability (needs key), none linked", () => {
    const plan = runPlan(template({ authProfileId: { mode: "fill", value: "keyless" } }), [X, Y], { authProfiles: [KEYLESS] });
    expect(plan.auth?.linked).toBe(0);
    // X: eligibility clause 5 (own key) → counted under "SSH login already configured".
    expect(plan.auth?.skippedLoginConfigured).toBe(1);
    // Y: usability → counted under "profile needs a key file".
    expect(plan.auth?.skippedNeedsKey).toBe(1);
    expect(plan.serverWrites).toHaveLength(0);
  });

  it("OVERRIDE: X LINKED (usable via its own key), Y skipped by usability — same server, opposite outcome", () => {
    const plan = runPlan(template({ authProfileId: { mode: "override", value: "keyless" } }), [X, Y], { authProfiles: [KEYLESS] });
    expect(plan.auth?.linked).toBe(1);
    expect(plan.serverWrites.find((w) => w.serverId === "srv-x")?.authProfileId).toBe("keyless");
    expect(plan.serverWrites.find((w) => w.serverId === "srv-y")).toBeUndefined();
    expect(plan.auth?.skippedNeedsKey).toBe(1); // Y
  });

  it("whitespace sibling: Y' with keyPath '   ' behaves as Y (hasOwnKeyPath trims) in both modes", () => {
    const Yp = ownedServer({ id: "srv-yp", authProfileId: undefined, username: "admin", keyPath: "   " }, { syncedUsername: "admin" });
    const fill = runPlan(template({ authProfileId: { mode: "fill", value: "keyless" } }), [Yp], { authProfiles: [KEYLESS] });
    // A whitespace key is NOT an own key → still fill-eligible, then usability skips it.
    expect(fill.auth?.skippedNeedsKey).toBe(1);
    expect(fill.auth?.skippedLoginConfigured).toBe(0);
    const override = runPlan(template({ authProfileId: { mode: "override", value: "keyless" } }), [Yp], { authProfiles: [KEYLESS] });
    expect(override.auth?.linked).toBe(0);
    expect(override.auth?.skippedNeedsKey).toBe(1);
  });
});
