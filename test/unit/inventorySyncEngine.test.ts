import { describe, expect, it } from "vitest";
import {
  computeSyncPlan,
  planToApplication,
  prunedServerIdsForSecretCleanup,
  validateInventoryTree,
  ORPHAN_FOLDER_NAME,
  type InventorySyncPlan
} from "../../src/services/inventory/syncEngine";
import { deterministicServerId } from "../../src/services/inventory/deterministicId";
import { MAX_FOLDER_DEPTH } from "../../src/utils/folderPaths";
import type { ServerConfig } from "../../src/models/config";
import type { InventoryDevice, InventorySourceConfig, InventoryTree } from "../../src/models/inventory";

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
  return {
    externalId: "device:1",
    name: "core-sw-1",
    endpoints: [{ kind: "ssh", host: "10.0.0.1" }],
    ...overrides
  };
}

function makeTree(devices: InventoryDevice[], warnings?: string[]): InventoryTree {
  return { contractVersion: 1, devices, warnings };
}

function makeOwnedServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: deterministicServerId("source-1", "device:1"),
    name: "core-sw-1",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    authType: "agent",
    isHidden: false,
    group: "NetBox",
    origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000 },
    ...overrides
  };
}

function makeManualServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "manual-1",
    name: "manual-server",
    host: "10.0.0.250",
    port: 22,
    username: "root",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

describe("computeSyncPlan — adds", () => {
  it("maps a new device to a deterministic id, agent auth, default username, and the joined target+device folder", () => {
    const source = makeSource({ targetFolder: "NetBox", defaultUsername: "admin" });
    const tree = makeTree([makeDevice({ folderPath: "Syd/R1" })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [], now: 1000 });

    expect(plan.adds).toHaveLength(1);
    const add = plan.adds[0];
    expect(add.id).toBe(deterministicServerId("source-1", "device:1"));
    expect(add.authType).toBe("agent");
    expect(add.username).toBe("admin");
    // Dropping either half of the join (target-only or device-folder-only) fails this.
    expect(add.group).toBe("NetBox/Syd/R1");
    expect(add.isHidden).toBe(false);
    // `syncedUsername` records the username this add just wrote, so a later sync
    // can compare against it instead of the source's current defaultUsername.
    // Whole-object equality on the origin: it is the retro-apply rule's only
    // input besides the auth fields, so a missing or extra member has to fail.
    expect(add.origin).toEqual({ sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" });
  });

  it("maps the ssh endpoint even when a redfish endpoint appears first (kills first-endpoint-regardless-of-kind)", () => {
    const source = makeSource();
    const tree = makeTree([
      makeDevice({
        endpoints: [
          { kind: "redfish", host: "10.0.0.9" },
          { kind: "ssh", host: "10.0.0.1" }
        ]
      })
    ]);
    const plan = computeSyncPlan({ source, tree, currentServers: [], now: 1000 });
    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].host).toBe("10.0.0.1");
  });

  it("skips devices with empty externalId, no usable ssh endpoint, or an out-of-range port — each with a warning, no adds", () => {
    const source = makeSource();
    const tree = makeTree([
      makeDevice({ externalId: "", name: "no-external-id" }),
      makeDevice({ externalId: "device:redfish-only", name: "redfish-only", endpoints: [{ kind: "redfish", host: "10.0.0.2" }] }),
      makeDevice({ externalId: "device:bad-port", name: "bad-port", endpoints: [{ kind: "ssh", host: "10.0.0.3", port: 70000 }] })
    ]);
    const plan = computeSyncPlan({ source, tree, currentServers: [], now: 1000 });
    expect(plan.adds).toHaveLength(0);
    expect(plan.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("root targetFolder (''): a device with no folder gets group undefined, not '' (kills '' + '/' + rel concatenation)", () => {
    const source = makeSource({ targetFolder: "" });
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [], now: 1000 });
    expect(plan.adds[0].group).toBeUndefined();
  });

  it("root targetFolder (''): a device with folderPath 'A/B' gets group exactly 'A/B'", () => {
    const source = makeSource({ targetFolder: "" });
    const tree = makeTree([makeDevice({ folderPath: "A/B" })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [], now: 1000 });
    expect(plan.adds[0].group).toBe("A/B");
  });

  it("an invalid device folderPath falls back to the source's target folder, with a warning (kills unnormalized passthrough)", () => {
    const source = makeSource({ targetFolder: "NetBox" });
    const tree = makeTree([makeDevice({ folderPath: "x/../y" })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [], now: 1000 });
    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].group).toBe("NetBox");
    expect(plan.warnings.some((w) => w.includes("invalid folder path"))).toBe(true);
  });

  it("duplicate externalId in the tree: the first device wins, later ones are skipped with a warning (kills last-wins)", () => {
    const source = makeSource();
    const tree = makeTree([makeDevice({ name: "first-device" }), makeDevice({ name: "second-device" })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [], now: 1000 });
    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].name).toBe("first-device");
    expect(plan.warnings.some((w) => w.includes("Duplicate device ID"))).toBe(true);
  });

  it("(N1) many endpoint-less devices with no owned server produce ONE aggregate warning, not one per device (kills per-device spam)", () => {
    const source = makeSource();
    const devices = Array.from({ length: 5 }, (_, i) =>
      makeDevice({
        externalId: `device:noendpoint-${i}`,
        name: `noendpoint-${i}`,
        endpoints: [{ kind: "redfish", host: "10.0.0.9" }]
      })
    );
    const tree = makeTree(devices);
    const plan = computeSyncPlan({ source, tree, currentServers: [], now: 1000 });
    const endpointWarnings = plan.warnings.filter((w) => w.toLowerCase().includes("no usable ssh endpoint"));
    expect(endpointWarnings).toHaveLength(1);
    expect(endpointWarnings[0]).toContain("5");
  });

  it("(N1) an endpoint-less device whose externalId IS owned still gets a per-device warning naming it (kills over-aggregation losing the protective signal)", () => {
    const source = makeSource();
    const before = makeOwnedServer(); // origin.externalId === "device:1", matches the first device below
    const tree = makeTree([
      makeDevice({ endpoints: [{ kind: "redfish", host: "10.0.0.9" }] }), // externalId "device:1" — owned, no usable ssh endpoint
      makeDevice({ externalId: "device:2", name: "unowned-noendpoint", endpoints: [{ kind: "redfish", host: "10.0.0.9" }] })
    ]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 1000 });
    // Owned device: dedicated per-device warning, naming it explicitly.
    expect(plan.warnings.some((w) => w.includes(`Device "core-sw-1" (device:1) has no usable SSH endpoint and was skipped.`))).toBe(true);
    // Unowned device: no dedicated per-device warning of that form — it's folded
    // into the aggregate instead (its name may still appear as an aggregate example).
    expect(
      plan.warnings.some((w) => w.includes(`Device "unowned-noendpoint" (device:2) has no usable SSH endpoint and was skipped.`))
    ).toBe(false);
    // Aggregate warning covers exactly the one unowned skip, and names it.
    const endpointWarnings = plan.warnings.filter((w) => w.toLowerCase().includes("had no usable ssh endpoint"));
    expect(endpointWarnings).toHaveLength(1);
    expect(endpointWarnings[0]).toContain("1");
    expect(endpointWarnings[0]).toContain("unowned-noendpoint");
  });

  it("skips (never adopts/overwrites) a device whose deterministic id collides with an unrelated server", () => {
    const source = makeSource();
    const collidingId = deterministicServerId("source-1", "device:1");
    const unrelated = makeManualServer({ id: collidingId, name: "hand-imported" });
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [unrelated], now: 1000 });
    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.warnings.some((w) => w.includes("already used"))).toBe(true);
  });
});

describe("computeSyncPlan — updates", () => {
  it("preserves every locally-owned field on update, taking only host from the device", () => {
    const source = makeSource();
    const before = makeOwnedServer({
      host: "10.0.0.99",
      authProfileId: "auth-1",
      keyPath: "/keys/id_rsa",
      proxy: { type: "ssh", jumpHostId: "jump-1" },
      multiplexing: false,
      isHidden: true,
      logSession: true
    });
    const tree = makeTree([makeDevice({ endpoints: [{ kind: "ssh", host: "10.0.0.1" }] })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000 });

    expect(plan.updates).toHaveLength(1);
    const after = plan.updates[0].after;
    expect(after.host).toBe("10.0.0.1");
    expect(after.authProfileId).toBe("auth-1");
    expect(after.keyPath).toBe("/keys/id_rsa");
    expect(after.proxy).toEqual({ type: "ssh", jumpHostId: "jump-1" });
    expect(after.multiplexing).toBe(false);
    expect(after.isHidden).toBe(true);
    expect(after.logSession).toBe(true);
  });

  it("username ownership: an endpoint username overrides; its absence keeps the existing username (never falls back to defaultUsername)", () => {
    const source = makeSource({ defaultUsername: "admin" });

    const withEndpointUsername = makeOwnedServer({ username: "evgeny" });
    const treeWithUsername = makeTree([makeDevice({ endpoints: [{ kind: "ssh", host: "10.0.0.1", username: "netops" }] })]);
    const planWithUsername = computeSyncPlan({ source, tree: treeWithUsername, currentServers: [withEndpointUsername], now: 1000 });
    expect(planWithUsername.updates[0].after.username).toBe("netops");

    const withoutEndpointUsername = makeOwnedServer({ username: "evgeny", host: "10.0.0.5" });
    const treeWithoutUsername = makeTree([makeDevice({ endpoints: [{ kind: "ssh", host: "10.0.0.9" }] })]); // host differs so the device is still an "update"
    const planWithoutUsername = computeSyncPlan({ source, tree: treeWithoutUsername, currentServers: [withoutEndpointUsername], now: 1000 });
    expect(planWithoutUsername.updates[0].after.username).toBe("evgeny");
  });

  it("an identical device produces no add/update, only unchangedCount (kills always-update + syncedAt-refresh-on-unchanged)", () => {
    const source = makeSource();
    const before = makeOwnedServer();
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 99999 });
    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it("a renamed device (same externalId) is an update, not a prune (kills prune-matching-by-name)", () => {
    const source = makeSource();
    const before = makeOwnedServer({ name: "old-name" });
    const tree = makeTree([makeDevice({ name: "new-name" })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 1000 });
    expect(plan.prunes).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.name).toBe("new-name");
  });

  it("a moved device produces an update with the new group, and plan.folders includes it (kills comparing only name/host/port)", () => {
    const source = makeSource({ targetFolder: "NetBox" });
    const before = makeOwnedServer({ group: "NetBox/OldRack" });
    const tree = makeTree([makeDevice({ folderPath: "NewRack" })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 1000 });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.group).toBe("NetBox/NewRack");
    expect(plan.folders).toContain("NetBox/NewRack");
  });

  it("an orphaned server whose device reappears updates back into its normal group (kills matching prune/return by group)", () => {
    const source = makeSource({ targetFolder: "NetBox" });
    const before = makeOwnedServer({ group: `NetBox/${ORPHAN_FOLDER_NAME}` });
    const tree = makeTree([makeDevice({ folderPath: "Syd/R1" })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 1000 });
    expect(plan.prunes).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.group).toBe("NetBox/Syd/R1");
  });
});

describe("computeSyncPlan — auth profile link", () => {
  // The resolved profile the caller passes in. `name` is unused by the engine
  // (it exists for the plan-preview modal's copy) but is carried so the input
  // shape here is the real one callers build.
  const profile = { id: "p1", name: "Lab credentials" };

  // Pinned verbatim (UX report §6). This exact string is what the plan-preview
  // modal surfaces, so a reword is a user-visible copy change and must break a
  // test. makeSource()'s name is "NetBox".
  const DANGLING_WARNING =
    'The auth profile for "NetBox" no longer exists — synced servers use the default username with SSH agent authentication. Edit the source to choose another profile.';

  it("stamps the resolved profile id on adds, and links only — username/authType stay the source's own (kills copying the profile's credentials)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [], now: 1000, authProfile: profile });

    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].authProfileId).toBe("p1");
    // Link, never copy: the profile's own authType/username must NOT be
    // snapshotted into the record (copies rot when the profile is edited).
    expect(plan.adds[0].authType).toBe("agent");
    expect(plan.adds[0].username).toBe("admin");
    expect(plan.adds[0].keyPath).toBeUndefined();
  });

  it("a profile-less source produces the pre-feature add, credential fields untouched, plus the origin's own username stamp, and no auth warning", () => {
    const source = makeSource({ targetFolder: "NetBox", defaultUsername: "admin" });
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [], now: 1000 });

    expect(plan.adds).toHaveLength(1);
    // Whole-object equality: ANY new field or changed default on the
    // profile-less path fails here, not just an accidental profile stamp.
    // `origin.syncedUsername` is the one addition to the pre-feature record and
    // it is bookkeeping, not a credential — it duplicates the `username` the
    // add already wrote so a LATER sync can tell that value apart from a
    // hand-edit. It is written whether or not the source has a profile today,
    // because a source that gains one later must find the stamp already there.
    expect(plan.adds[0]).toEqual({
      id: deterministicServerId("source-1", "device:1"),
      name: "core-sw-1",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });
    expect(plan.warnings.some((w) => w.includes("auth profile"))).toBe(false);
  });

  it("the add path records the ENDPOINT's username when the provider supplies one, matching the username it wrote (kills recording source.defaultUsername unconditionally)", () => {
    const source = makeSource({ defaultUsername: "admin" });
    const tree = makeTree([makeDevice({ endpoints: [{ kind: "ssh", host: "10.0.0.1", username: "svc-netbox" }] })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [], now: 1000, authProfile: profile });

    // The stamp must mirror what the add actually wrote. Recording "admin" here
    // would make the very next sync read this server as hand-edited (its
    // username is "svc-netbox") and refuse to ever adopt it.
    expect(plan.adds[0].username).toBe("svc-netbox");
    expect(plan.adds[0].origin?.syncedUsername).toBe("svc-netbox");
  });

  it("retro-apply: an owned server still on the never-configured agent default is updated with the profile — and surfaces as an update, not unchanged", () => {
    // The owned server maps EXACTLY to what the device produces (same
    // name/host/port/group), so the profile stamp is the ONLY difference the
    // engine can introduce — that is what makes this fixture non-vacuous.
    // makeOwnedServer's origin carries no `syncedUsername` (it models a server
    // synced by a build before that field existed), so the rule's username
    // clause resolves through the defaultUsername FALLBACK; its username
    // "admin" is still makeSource's defaultUsername. See the dedicated
    // fallback/stamp pair below for what each half is load-bearing for.
    const source = makeSource({ authProfileId: "p1" });
    const before = makeOwnedServer();
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: profile });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.authProfileId).toBe("p1");
    // Kills a `changed` comparison that was never extended: the stamp would be
    // computed into `after` and then thrown away as "unchanged".
    expect(plan.unchangedCount).toBe(0);
    // Link, not copy — the record's own credential fields are untouched.
    expect(plan.updates[0].after.username).toBe(before.username);
    expect(plan.updates[0].after.authType).toBe(before.authType);
    expect(plan.updates[0].after.keyPath).toBeUndefined();
  });

  it("retro-apply skips a server already linked to another profile (kills the source-always-wins overwrite)", () => {
    const source = makeSource({ authProfileId: "p1" });
    const before = makeOwnedServer({ authProfileId: "q" });
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: profile });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it("retro-apply skips a server hand-switched to password auth (kills dropping the authType === 'agent' clause)", () => {
    const source = makeSource({ authProfileId: "p1" });
    const before = makeOwnedServer({ authType: "password" });
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: profile });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it("retro-apply skips an agent server carrying an explicit key path (kills dropping the keyPath === undefined clause)", () => {
    const source = makeSource({ authProfileId: "p1" });
    const before = makeOwnedServer({ authType: "agent", keyPath: "/home/u/.ssh/id_ed25519" });
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: profile });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it("retro-apply skips a server whose username was hand-edited away from the source default (kills a rule that checks only the auth fields)", () => {
    // The auth fields here are still EXACTLY the add path's output — no
    // profile, agent auth, no key — so the three auth clauses all match. The
    // username is the only trace of the hand-edit, and it survives every sync:
    // the update path overwrites `username` only when the endpoint supplies
    // one, and no shipped provider does (this device has none). Adopting this
    // server would hand its connections the PROFILE's username instead of the
    // one the user typed (silentAuth resolves the profile first) — a hand-edit
    // silently undone by a sync.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const before = makeOwnedServer({ username: "netops" });
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: profile });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it("retro-apply adopts a server the source's CURRENT default no longer matches, because the stamp records what the sync wrote (kills comparing against source.defaultUsername, which the profile mirror rewrites)", () => {
    // The feature's own main flow, and the reason the stamp exists. The source
    // form mirrors a chosen profile's username into `defaultUsername` and saves
    // it, so linking profile "Lab credentials" (username "labuser") rewrites
    // the default from "admin" to "labuser". This server was synced under the
    // OLD default and never touched since — exactly the fleet the feature is
    // supposed to rescue. Comparing its username against the source's CURRENT
    // default says "hand-edited", leaves it on broken agent auth, and says
    // nothing in the plan preview about why it was skipped.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "labuser" });
    const before = makeOwnedServer({
      username: "admin",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: profile });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.authProfileId).toBe("p1");
    expect(plan.unchangedCount).toBe(0);
    // Adopted, not rewritten: the record keeps the username it was stamped with.
    expect(plan.updates[0].after.username).toBe("admin");
  });

  it("retro-apply skips a server whose username differs from its OWN recorded stamp even when the source's current default happens to match it (kills comparing against source.defaultUsername, which cannot see this hand-edit at all)", () => {
    // The mirror image of the test above, and why the stamp cannot simply be
    // dropped in favour of a looser rule. The user hand-edited this server's
    // username to "labuser", and the source's default was LATER rewritten to
    // "labuser" too (by linking a profile with that username). A
    // current-default comparison reads "labuser" === "labuser" and adopts a
    // server the user configured by hand. The recorded stamp still says the
    // sync wrote "admin", so the edit is visible and the server escapes.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "labuser" });
    const before = makeOwnedServer({
      username: "labuser",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: profile });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it("a server synced before the stamp existed is adopted through the defaultUsername fallback, never excluded for lacking it (kills a strict `username === origin.syncedUsername` rule)", () => {
    // Backward compatibility, stated as a test: `origin` here is the exact
    // three-member shape older builds wrote. A rule that compared against
    // `origin.syncedUsername` alone would read `undefined`, never match any
    // real username, and quietly refuse to adopt every server that existed
    // before this release — the whole population the feature was written for.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const before = makeOwnedServer({
      username: "admin",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000 }
    });
    expect(before.origin?.syncedUsername).toBeUndefined();
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: profile });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.authProfileId).toBe("p1");
    expect(plan.unchangedCount).toBe(0);
  });

  it("the update path carries an existing stamp forward instead of dropping it when it rebuilds origin (kills a rebuilt origin that silently forgets the recorded username)", () => {
    // The device was RENAMED, so this update happens for a reason unrelated to
    // auth and `origin` is rebuilt with a fresh syncedAt. If the rebuild drops
    // `syncedUsername`, the server silently reverts to the defaultUsername
    // fallback — and the next sync after a profile mirror would then fail to
    // adopt it, which is the bug the stamp exists to prevent, reintroduced by a
    // sync that changed nothing about authentication.
    const source = makeSource({ authProfileId: undefined, defaultUsername: "labuser" });
    const before = makeOwnedServer({
      username: "admin",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });
    const tree = makeTree([makeDevice({ name: "core-sw-1-renamed" })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000 });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.name).toBe("core-sw-1-renamed");
    expect(plan.updates[0].after.origin).toEqual({
      sourceId: "source-1",
      externalId: "device:1",
      syncedAt: 2000,
      syncedUsername: "admin"
    });
  });

  it("the update path never re-records the record's CURRENT username over the stamp (kills laundering a hand-edit into 'as stamped' on the next sync)", () => {
    // This server's username was hand-edited to "netops"; the stamp still says
    // the sync wrote "admin". The device was renamed, so an update is produced
    // for an unrelated reason. An implementation that writes
    // `syncedUsername: after.username` (or ownedServer.username) records
    // "netops" here — and the sync AFTER this one then sees username ===
    // stamp, calls the server never-configured, and hands its connections to
    // the profile. The hand-edit would be undone one sync late, which is
    // strictly worse than never having the field.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const before = makeOwnedServer({
      username: "netops",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });
    const tree = makeTree([makeDevice({ name: "core-sw-1-renamed" })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: profile });

    expect(plan.updates).toHaveLength(1);
    // Not adopted on this pass...
    expect(plan.updates[0].after.authProfileId).toBeUndefined();
    // ...and the stamp still remembers what the sync actually wrote, so it is
    // not adopted on the next pass either.
    expect(plan.updates[0].after.username).toBe("netops");
    expect(plan.updates[0].after.origin?.syncedUsername).toBe("admin");
  });

  it("the update path refreshes the stamp exactly when it overwrites the username from the endpoint (kills a carry-forward that never refreshes)", () => {
    // The one case where the sync itself writes `username` on an update: the
    // provider supplied one. The stamp must follow it, or the very next sync
    // would compare the endpoint-owned username against a stale stamp and read
    // the engine's own write as a hand-edit.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const before = makeOwnedServer({
      username: "admin",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });
    const tree = makeTree([makeDevice({ endpoints: [{ kind: "ssh", host: "10.0.0.1", username: "svc-netbox" }] })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: profile });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.username).toBe("svc-netbox");
    expect(plan.updates[0].after.origin?.syncedUsername).toBe("svc-netbox");
  });

  it("changing the source's profile A -> B never re-stamps servers already carrying A", () => {
    const source = makeSource({ authProfileId: "p2" });
    const before = makeOwnedServer({ authProfileId: "p1" });
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: { id: "p2", name: "Other" } });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it("clearing the source's profile to (None) never strips the link from already-linked servers", () => {
    const source = makeSource({ authProfileId: undefined });
    const before = makeOwnedServer({ authProfileId: "p1" });
    const tree = makeTree([makeDevice()]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000 });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it("a dangling profile reference falls back to the pre-feature default on adds, retro-applies nothing, and warns verbatim", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const before = makeOwnedServer(); // bare agent default — a resolved profile WOULD stamp it
    const tree = makeTree([makeDevice(), makeDevice({ externalId: "device:2", name: "new-sw", endpoints: [{ kind: "ssh", host: "10.0.0.2" }] })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000 }); // no authProfile resolved

    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].authProfileId).toBeUndefined();
    expect(plan.adds[0].authType).toBe("agent");
    expect(plan.adds[0].username).toBe("admin");
    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
    expect(plan.warnings).toContain(DANGLING_WARNING);
  });

  it("a resolution whose id does not match source.authProfileId is treated as dangling (kills trusting the caller's profile without the cross-check)", () => {
    const source = makeSource({ authProfileId: "p1" });
    const before = makeOwnedServer();
    const tree = makeTree([makeDevice(), makeDevice({ externalId: "device:2", name: "new-sw", endpoints: [{ kind: "ssh", host: "10.0.0.2" }] })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: { id: "OTHER", name: "X" } });

    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].authProfileId).toBeUndefined();
    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
    expect(plan.warnings).toContain(DANGLING_WARNING);
  });
});

describe("computeSyncPlan — prunes", () => {
  it("delete/orphan/keep policies each produce the matching plan.prunes entry; orphan retains origin", () => {
    const emptyTree = makeTree([]);

    const deleteServer = makeOwnedServer();
    const deletePlan = computeSyncPlan({ source: makeSource({ prunePolicy: "delete" }), tree: emptyTree, currentServers: [deleteServer], now: 1000 });
    expect(deletePlan.prunes).toEqual([{ policy: "delete", server: deleteServer }]);

    const orphanServer = makeOwnedServer();
    const orphanPlan = computeSyncPlan({ source: makeSource({ prunePolicy: "orphan", targetFolder: "NetBox" }), tree: emptyTree, currentServers: [orphanServer], now: 1000 });
    expect(orphanPlan.prunes).toHaveLength(1);
    const orphanPrune = orphanPlan.prunes[0];
    expect(orphanPrune.policy).toBe("orphan");
    if (orphanPrune.policy === "orphan") {
      expect(orphanPrune.after.group).toBe("NetBox/_orphaned");
      // Origin is KEPT (not stripped) — a reappearing device must still match by externalId.
      expect(orphanPrune.after.origin).toEqual(orphanServer.origin);
    }

    const keepServer = makeOwnedServer();
    const keepPlan = computeSyncPlan({ source: makeSource({ prunePolicy: "keep" }), tree: emptyTree, currentServers: [keepServer], now: 1000 });
    expect(keepPlan.prunes).toEqual([{ policy: "keep", server: keepServer }]);
  });

  it("root targetFolder ('') orphan lands directly at '_orphaned'", () => {
    const source = makeSource({ targetFolder: "", prunePolicy: "orphan" });
    const before = makeOwnedServer({ group: undefined });
    const plan = computeSyncPlan({ source, tree: makeTree([]), currentServers: [before], now: 1000 });
    const prune = plan.prunes[0];
    expect(prune.policy).toBe("orphan");
    if (prune.policy === "orphan") {
      expect(prune.after.group).toBe(ORPHAN_FOLDER_NAME);
    }
  });

  it("prune scoping: a foreign-origin server and a no-origin manual server absent from the tree are NOT pruned (kills unfiltered prune)", () => {
    const source = makeSource({ prunePolicy: "delete" });
    const foreign = makeOwnedServer({ id: "foreign-1", origin: { sourceId: "other-source", externalId: "device:1", syncedAt: 1 } });
    const manual = makeManualServer();
    const plan = computeSyncPlan({ source, tree: makeTree([]), currentServers: [foreign, manual], now: 1000 });
    expect(plan.prunes).toHaveLength(0);
  });

  it("(F12) an owned server manually moved OUTSIDE targetFolder is still pruned when its device is absent (kills prune-matching-by-group)", () => {
    const source = makeSource({ targetFolder: "NetBox", prunePolicy: "delete" });
    const before = makeOwnedServer({ group: "SomeOtherFolder/Manual" });
    const plan = computeSyncPlan({ source, tree: makeTree([]), currentServers: [before], now: 1000 });
    expect(plan.prunes).toEqual([{ policy: "delete", server: before }]);
  });

  it("(F10) an orphan folder exceeding the maximum depth falls back to the target folder itself, with a warning (kills unnormalized 11-segment group)", () => {
    const deepTarget = Array.from({ length: MAX_FOLDER_DEPTH }, (_, i) => `L${i}`).join("/");
    const source = makeSource({ targetFolder: deepTarget, prunePolicy: "orphan" });
    const before = makeOwnedServer({ group: deepTarget });
    const plan = computeSyncPlan({ source, tree: makeTree([]), currentServers: [before], now: 1000 });
    const prune = plan.prunes[0];
    expect(prune.policy).toBe("orphan");
    if (prune.policy === "orphan") {
      expect(prune.after.group).toBe(deepTarget);
    }
    expect(plan.warnings.some((w) => w.toLowerCase().includes("orphan"))).toBe(true);
  });

  it("(F22) hiddenPruneCount reflects how many pruned servers are hidden", () => {
    const source = makeSource({ prunePolicy: "keep" });
    const hidden = makeOwnedServer({ id: "hidden-1", isHidden: true, origin: { sourceId: "source-1", externalId: "device:hidden", syncedAt: 1 } });
    const visible = makeOwnedServer({ id: "visible-1", isHidden: false, origin: { sourceId: "source-1", externalId: "device:visible", syncedAt: 1 } });
    const plan = computeSyncPlan({ source, tree: makeTree([]), currentServers: [hidden, visible], now: 1000 });
    expect(plan.hiddenPruneCount).toBe(1);
  });

  it("(FIX 1) an owned server whose device is present in the tree but skipped (no usable ssh endpoint) is NOT pruned (kills pruning skipped-but-present devices)", () => {
    const source = makeSource({ prunePolicy: "delete" });
    const before = makeOwnedServer();
    // Same externalId as `before`'s origin, still present in the fetched tree,
    // but unmappable (no ssh endpoint) — this must NOT read as "deleted at
    // the source".
    const tree = makeTree([makeDevice({ endpoints: [{ kind: "redfish", host: "10.0.0.9" }] })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 1000 });
    expect(plan.prunes).toHaveLength(0);
    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.warnings.some((w) => w.includes("no usable SSH endpoint"))).toBe(true);
  });

  it("(FIX 1) an owned server whose device is present but skipped for an empty name is NOT pruned", () => {
    const source = makeSource({ prunePolicy: "delete" });
    const before = makeOwnedServer();
    const tree = makeTree([makeDevice({ name: "" })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 1000 });
    expect(plan.prunes).toHaveLength(0);
  });

  it("(FIX 1) an owned server whose device is present but skipped for an invalid port is NOT pruned", () => {
    const source = makeSource({ prunePolicy: "delete" });
    const before = makeOwnedServer();
    const tree = makeTree([makeDevice({ endpoints: [{ kind: "ssh", host: "10.0.0.1", port: 999999 }] })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 1000 });
    expect(plan.prunes).toHaveLength(0);
  });

  it("(FIX 1) a device that is genuinely absent from the tree is still pruned (control — the fix must not disable pruning altogether)", () => {
    const source = makeSource({ prunePolicy: "delete" });
    const before = makeOwnedServer();
    const plan = computeSyncPlan({ source, tree: makeTree([]), currentServers: [before], now: 1000 });
    expect(plan.prunes).toEqual([{ policy: "delete", server: before }]);
  });

  it("(FIX 2) a truncated tree skips the prune phase entirely and warns, instead of pruning an absent owned server", () => {
    const source = makeSource({ prunePolicy: "delete" });
    const before = makeOwnedServer();
    const tree: InventoryTree = { contractVersion: 1, devices: [], truncated: true };
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 1000 });
    expect(plan.prunes).toEqual([]);
    expect(plan.warnings.some((w) => w.toLowerCase().includes("truncated") && w.toLowerCase().includes("prune"))).toBe(true);
  });

  it("(FIX 6) the orphan-fallback warning is emitted ONCE per sync (not once per affected server), and its wording doesn't claim 'maximum folder depth' for a generic normalization failure", () => {
    const deepTarget = Array.from({ length: MAX_FOLDER_DEPTH }, (_, i) => `L${i}`).join("/");
    const source = makeSource({ targetFolder: deepTarget, prunePolicy: "orphan" });
    const first = makeOwnedServer({
      id: "orphan-a",
      group: deepTarget,
      origin: { sourceId: "source-1", externalId: "device:orphan-a", syncedAt: 1 }
    });
    const second = makeOwnedServer({
      id: "orphan-b",
      group: deepTarget,
      origin: { sourceId: "source-1", externalId: "device:orphan-b", syncedAt: 1 }
    });
    const plan = computeSyncPlan({ source, tree: makeTree([]), currentServers: [first, second], now: 1000 });

    expect(plan.prunes).toHaveLength(2);
    const orphanFallbackWarnings = plan.warnings.filter((w) => w.toLowerCase().includes("orphan folder path"));
    // A per-server implementation would push this warning twice (once per
    // pruned server); the fix computes and warns about it exactly once.
    expect(orphanFallbackWarnings).toHaveLength(1);
    expect(orphanFallbackWarnings[0]).not.toMatch(/maximum folder depth/i);
    expect(orphanFallbackWarnings[0]).toContain("2");
  });
});

describe("computeSyncPlan — amendments F5/F6", () => {
  it("(F5/FIX 3) a planned add matching a manual server's host:port still adds, warns about the duplicate, and the count is exposed on the plan (not just parseable from warnings text)", () => {
    const source = makeSource();
    const manual = makeManualServer({ host: "10.0.0.1", port: 22 });
    const plan = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [manual], now: 1000 });
    expect(plan.adds).toHaveLength(1);
    expect(plan.warnings.some((w) => w.includes("duplicate"))).toBe(true);
    expect(plan.manualDuplicateCount).toBe(1);
  });

  it("(F5) no duplicate warning when host:port does not match any manual server, and manualDuplicateCount is 0", () => {
    const source = makeSource();
    const manual = makeManualServer({ host: "10.0.0.200", port: 22 });
    const plan = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [manual], now: 1000 });
    expect(plan.warnings.some((w) => w.includes("duplicate"))).toBe(false);
    expect(plan.manualDuplicateCount).toBe(0);
  });

  it("(F6) two owned servers sharing an externalId: the first (stable order) is used and pruned, the second is left untouched (kills pruning/updating both)", () => {
    const source = makeSource({ prunePolicy: "delete" });
    const first = makeOwnedServer({ id: "srv-a", name: "srv-a" });
    const second = makeOwnedServer({ id: "srv-b", name: "srv-b" });
    const plan = computeSyncPlan({ source, tree: makeTree([]), currentServers: [first, second], now: 1000 });
    expect(plan.prunes).toHaveLength(1);
    expect(plan.prunes[0].server.id).toBe("srv-a");
    expect(plan.warnings.some((w) => w.includes("Multiple servers"))).toBe(true);
  });
});

describe("validateInventoryTree", () => {
  it("accepts a minimal valid tree", () => {
    expect(() => validateInventoryTree({ contractVersion: 1, devices: [] })).not.toThrow();
  });

  it("rejects a non-object", () => {
    expect(() => validateInventoryTree(null)).toThrow();
    expect(() => validateInventoryTree("nope")).toThrow();
  });

  it("rejects the wrong contractVersion", () => {
    expect(() => validateInventoryTree({ contractVersion: 2, devices: [] })).toThrow();
  });

  it("rejects non-array devices", () => {
    expect(() => validateInventoryTree({ contractVersion: 1, devices: "nope" })).toThrow();
  });

  it("rejects a device missing externalId or name", () => {
    expect(() => validateInventoryTree({ contractVersion: 1, devices: [{ name: "x", endpoints: [] }] })).toThrow();
    expect(() => validateInventoryTree({ contractVersion: 1, devices: [{ externalId: "1", endpoints: [] }] })).toThrow();
  });

  it("rejects a device with non-array endpoints", () => {
    expect(() => validateInventoryTree({ contractVersion: 1, devices: [{ externalId: "1", name: "x", endpoints: {} }] })).toThrow();
  });

  it("rejects an endpoint missing kind or host", () => {
    expect(() => validateInventoryTree({ contractVersion: 1, devices: [{ externalId: "1", name: "x", endpoints: [{ host: "h" }] }] })).toThrow();
    expect(() => validateInventoryTree({ contractVersion: 1, devices: [{ externalId: "1", name: "x", endpoints: [{ kind: "ssh" }] }] })).toThrow();
  });

  it("rejects malformed warnings", () => {
    expect(() => validateInventoryTree({ contractVersion: 1, devices: [], warnings: [1, 2] })).toThrow();
  });

  it("accepts a fully-populated valid tree", () => {
    expect(() =>
      validateInventoryTree({
        contractVersion: 1,
        devices: [{ externalId: "1", name: "x", folderPath: "A/B", endpoints: [{ kind: "ssh", host: "10.0.0.1", port: 22, username: "u" }] }],
        warnings: ["a warning"]
      })
    ).not.toThrow();
  });
});

describe("planToApplication (F19 — no targetFolder parameter)", () => {
  it("combines adds, update-afters, and orphan-afters into upsertServers; delete prunes become removeServerIds; folders pass through", () => {
    const add: ServerConfig = { id: "a", name: "a", host: "h", port: 22, username: "u", authType: "agent", isHidden: false };
    const updateAfter: ServerConfig = { ...add, id: "b" };
    const updateBefore: ServerConfig = { ...updateAfter, host: "old-host" };
    const orphanAfter: ServerConfig = { ...add, id: "c", group: "_orphaned" };
    const orphanServer: ServerConfig = { ...orphanAfter, group: "X" };
    const deleteServer: ServerConfig = { ...add, id: "d" };
    const keepServer: ServerConfig = { ...add, id: "e" };

    const plan: InventorySyncPlan = {
      sourceId: "source-1",
      syncedAt: 1000,
      adds: [add],
      updates: [{ before: updateBefore, after: updateAfter }],
      prunes: [
        { policy: "orphan", server: orphanServer, after: orphanAfter },
        { policy: "delete", server: deleteServer },
        { policy: "keep", server: keepServer }
      ],
      unchangedCount: 0,
      folders: ["X", "Y"],
      warnings: [],
      hiddenPruneCount: 0,
      manualDuplicateCount: 0
    };

    const expectedSource = makeSource({ id: "source-1" });
    const application = planToApplication(plan, expectedSource);
    expect(application.upsertServers.map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
    expect(application.removeServerIds).toEqual(["d"]);
    expect(application.folders).toEqual(["X", "Y"]);
    expect(application.sourceId).toBe("source-1");
    expect(application.syncedAt).toBe(1000);
    expect(application.expectedSource).toBe(expectedSource);
  });
});

describe("prunedServerIdsForSecretCleanup", () => {
  it("returns only delete-policy server ids (not orphan/keep)", () => {
    const server = (id: string): ServerConfig => ({ id, name: id, host: "h", port: 22, username: "u", authType: "agent", isHidden: false });
    const plan: InventorySyncPlan = {
      sourceId: "s",
      syncedAt: 1,
      adds: [],
      updates: [],
      prunes: [
        { policy: "delete", server: server("d1") },
        { policy: "orphan", server: server("o1"), after: server("o1") },
        { policy: "keep", server: server("k1") }
      ],
      unchangedCount: 0,
      folders: [],
      warnings: [],
      hiddenPruneCount: 0,
      manualDuplicateCount: 0
    };
    expect(prunedServerIdsForSecretCleanup(plan)).toEqual(["d1"]);
  });
});
