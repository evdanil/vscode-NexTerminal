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
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import { validateServerConfig } from "../../src/utils/validation";
import { SilentAuthSshFactory } from "../../src/services/ssh/silentAuth";
import { buildConnectConfig } from "../../src/services/ssh/ssh2Connector";
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

/**
 * Runs `server` through the REAL connect path with `profile` linked and returns
 * the ServerConfig that reaches the connector — i.e. the record after
 * `SilentAuthSshFactory.resolveServer` has applied the profile's owned fields.
 *
 * Callers that need the last hop pass the result to ssh2Connector's own
 * `buildConnectConfig`, which is what decides what is actually handed to the SSH
 * server and where a `key` resolution with no key path becomes `Missing keyPath
 * for key auth on <name>`. Stopping at the plan — or even here — is exactly what
 * let a keyless key profile be stamped onto every synced server: each layer was
 * right by its own rule, and only the composition was unusable.
 */
async function resolveThroughConnect(server: ServerConfig, profile: AuthProfile): Promise<ServerConfig> {
  const connection = {
    openShell: () => undefined, openDirectTcp: () => undefined, openSftp: () => undefined, exec: () => undefined,
    requestForwardIn: () => undefined, cancelForwardIn: () => undefined,
    onTcpConnection: () => () => undefined, onClose: () => () => undefined,
    getBanner: () => undefined, dispose: () => undefined
  };
  const connectCalls: ServerConfig[] = [];
  const factory = new SilentAuthSshFactory(
    { connect: async (resolvedServer: ServerConfig) => { connectCalls.push(resolvedServer); return connection; } } as never,
    { get: async () => undefined, store: async () => undefined, delete: async () => undefined } as never,
    { prompt: async () => ({ password: "typed", save: false }) } as never,
    undefined,
    (id: string) => (id === profile.id ? profile : undefined)
  );

  await factory.connect(server);
  return connectCalls[0];
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

  it("ADDRESSLESS (Codex P1) — still skips an empty externalId and an out-of-range port, but the no-primary (redfish-only) device becomes an addressless placeholder rather than being dropped", () => {
    const source = makeSource();
    const tree = makeTree([
      makeDevice({ externalId: "", name: "no-external-id" }),
      makeDevice({ externalId: "device:redfish-only", name: "redfish-only", endpoints: [{ kind: "redfish", host: "10.0.0.2" }] }),
      makeDevice({ externalId: "device:bad-port", name: "bad-port", endpoints: [{ kind: "ssh", host: "10.0.0.3", port: 70000 }] })
    ]);
    const plan = computeSyncPlan({ source, tree, currentServers: [], now: 1000 });
    // Only the no-primary device is created — as an addressless placeholder.
    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].addressless).toBe(true);
    expect(plan.adds[0].origin?.externalId).toBe("device:redfish-only");
    // The malformed rows are still skipped, each with its own warning.
    expect(plan.warnings.some((w) => w.includes("no device ID"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("invalid port"))).toBe(true);
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

  it("(N1 / ADDRESSLESS) many endpoint-less NEW devices become addressless adds with ONE aggregate note, not one warning per device (kills per-device spam)", () => {
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
    expect(plan.adds).toHaveLength(5);
    expect(plan.adds.every((a) => a.addressless === true)).toBe(true);
    const note = plan.warnings.filter((w) => w.toLowerCase().includes("no console address yet"));
    expect(note).toHaveLength(1);
    expect(note[0]).toContain("5");
  });

  it("(N1 / ADDRESSLESS) an endpoint-less OWNED device downgrades in place while an unowned one is added — both addressless, no per-device spam (kills losing the placeholder for the owned one)", () => {
    const source = makeSource();
    const before = makeOwnedServer(); // origin.externalId === "device:1", matches the first device below
    const tree = makeTree([
      makeDevice({ endpoints: [{ kind: "redfish", host: "10.0.0.9" }] }), // externalId "device:1" — owned, downgrades
      makeDevice({ externalId: "device:2", name: "unowned-noendpoint", endpoints: [{ kind: "redfish", host: "10.0.0.9" }] })
    ]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 1000 });
    // Owned device: downgraded to addressless (an update), NOT pruned.
    expect(plan.prunes).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.addressless).toBe(true);
    expect(plan.updates[0].after.origin?.externalId).toBe("device:1");
    // Unowned device: created addressless.
    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].addressless).toBe(true);
    // Only the NEW addressless device is named in the aggregate note (the owned
    // one is an in-place update, not a fresh placeholder).
    const note = plan.warnings.filter((w) => w.toLowerCase().includes("no console address yet"));
    expect(note).toHaveLength(1);
    expect(note[0]).toContain("unowned-noendpoint");
  });

  /**
   * ADDRESSLESS (Codex P1 on #82) — a device with no usable primary endpoint (a
   * stopped EVE node, a VNC-console node, a NetBox row with no IP) now produces
   * a VISIBLE addressless placeholder server instead of being skipped, and
   * upgrades/downgrades in place as the device gains/loses a console — no
   * create/prune churn.
   */
  describe("addressless placeholders", () => {
    const noEndpointDevice = (overrides: Partial<InventoryDevice> = {}) =>
      makeDevice({ endpoints: [{ kind: "redfish", host: "10.0.0.9" }], ...overrides });

    it("CREATES an addressless server for a new endpoint-less device instead of skipping it (⊘ the old skip leaves the device invisible in the tree)", () => {
      const plan = computeSyncPlan({ source: makeSource(), tree: makeTree([noEndpointDevice()]), currentServers: [], now: 5000 });
      expect(plan.adds).toHaveLength(1);
      const [added] = plan.adds;
      expect(added.addressless).toBe(true);
      expect(added.host).toBe("");
      expect(added.id).toBe(deterministicServerId("source-1", "device:1"));
      expect(added.group).toBe("NetBox");
      expect(added.origin?.sourceId).toBe("source-1");
      expect(added.origin?.externalId).toBe("device:1");
      expect(added.origin?.syncedAt).toBe(5000);
      // No console ⇒ ssh-default protocol, unset stamp.
      expect(added.protocol).toBeUndefined();
      expect(added.origin?.syncedProtocol).toBeUndefined();
      // The record the sync writes must survive its own reload.
      expect(validateServerConfig(added)).toBe(true);
    });

    it("UPGRADES an owned addressless server in place when the device gains a console — same id, host filled, flag cleared, no duplicate add (⊘ a create-only path would add a second server for the same device)", () => {
      const before = makeOwnedServer({ host: "", port: 0, addressless: true, origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedProtocol: undefined } });
      const plan = computeSyncPlan({ source: makeSource(), tree: makeTree([makeDevice()]), currentServers: [before], now: 5000 });
      expect(plan.adds).toHaveLength(0);
      expect(plan.updates).toHaveLength(1);
      const after = plan.updates[0].after;
      expect(after.id).toBe(before.id);
      expect(after.host).toBe("10.0.0.1");
      expect(after.port).toBe(22);
      expect(after.addressless ?? false).toBe(false);
      expect(plan.prunes).toHaveLength(0);
    });

    it("DOWNGRADES an owned addressed server to addressless when the device loses its console — keeps the server (does NOT prune), flips the flag, clears the host (⊘ pruning a merely-stopped node destroys the server and its credentials)", () => {
      const before = makeOwnedServer(); // addressed, host 10.0.0.1
      const plan = computeSyncPlan({ source: makeSource(), tree: makeTree([noEndpointDevice()]), currentServers: [before], now: 5000 });
      expect(plan.prunes).toHaveLength(0);
      expect(plan.updates).toHaveLength(1);
      const after = plan.updates[0].after;
      expect(after.addressless).toBe(true);
      expect(after.host).toBe("");
      expect(after.id).toBe(before.id);
    });

    it("re-syncing an already-addressless owned device with no change produces NO update (⊘ churning a no-op update every sync on every stopped node)", () => {
      const before = makeOwnedServer({ host: "", port: 0, addressless: true, origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedProtocol: undefined } });
      const plan = computeSyncPlan({ source: makeSource(), tree: makeTree([noEndpointDevice()]), currentServers: [before], now: 5000 });
      expect(plan.updates).toHaveLength(0);
      expect(plan.prunes).toHaveLength(0);
    });

    it("PRUNES an owned addressless server whose device disappears, exactly like an addressed one (⊘ special-casing addressless out of the prune phase strands deleted placeholders forever)", () => {
      const before = makeOwnedServer({ host: "", port: 0, addressless: true });
      const plan = computeSyncPlan({ source: makeSource({ prunePolicy: "delete" }), tree: makeTree([]), currentServers: [before], now: 5000 });
      expect(plan.prunes.map((p) => p.server.id)).toContain(before.id);
    });

    it("clears a SYNC-OWNED telnet protocol to ssh-default on downgrade, but LEAVES a hand-flipped telnet alone (⊘ forking the protocol stamp logic would either stomp the user's hand-flip or freeze a synced telnet)", () => {
      // Sync-owned telnet (record telnet, stamp telnet) → cleared to ssh-default.
      const syncedTelnet = makeOwnedServer({ protocol: "telnet", origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedProtocol: "telnet" } });
      const p1 = computeSyncPlan({ source: makeSource(), tree: makeTree([noEndpointDevice()]), currentServers: [syncedTelnet], now: 5000 });
      expect(p1.updates[0].after.protocol).toBeUndefined();
      // Hand-flipped telnet (record telnet, stamp ssh/undefined) → kept.
      const handTelnet = makeOwnedServer({ protocol: "telnet", origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedProtocol: undefined } });
      const p2 = computeSyncPlan({ source: makeSource(), tree: makeTree([noEndpointDevice()]), currentServers: [handTelnet], now: 5000 });
      expect(p2.updates[0].after.protocol).toBe("telnet");
    });

    it("STILL skips an endpoint-less device with an empty NAME — addressless is only for a device with no endpoint, never a swallow for the name skip (⊘ addressless creating a nameless placeholder)", () => {
      const plan = computeSyncPlan({ source: makeSource(), tree: makeTree([noEndpointDevice({ name: "" })]), currentServers: [], now: 5000 });
      expect(plan.adds).toHaveLength(0);
    });

    it("STILL skips a device whose endpoint has an INVALID PORT — malformed endpoint data is NOT an addressless placeholder (⊘ addressless swallowing the invalid-port skip)", () => {
      const plan = computeSyncPlan({
        source: makeSource(),
        tree: makeTree([makeDevice({ endpoints: [{ kind: "ssh", host: "10.0.0.1", port: 0 }] })]),
        currentServers: [],
        now: 5000
      });
      expect(plan.adds).toHaveLength(0);
    });
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

/**
 * REVIEW FINDING (P1, adoption instance identity) — `ServerOrigin.syncedInstanceKey`,
 * written by every path that writes an origin.
 *
 * WHY IT IS ON THE SERVER AND NOT THE SOURCE. The source's `config` is mutable:
 * Edit Source can repoint it at another deployment at any moment, and until a
 * sync against the new one succeeds the owned servers' `externalId`s still belong
 * to the OLD deployment. So "which deployment is this source pointed at" and
 * "which deployment did these servers come from" are different questions, and the
 * detach paths need the second one. Reading the first was what let a source of
 * deployment B adopt — and then prune — deployment A's servers and credentials.
 */
describe("computeSyncPlan — the sync records WHICH deployment it read from", () => {
  const INSTANCE_A = "https://netbox.example.com";
  const INSTANCE_B = "https://netbox-lab.example.com";

  it("the add path stamps this run's deployment on every server it creates (kills leaving the origin without it, which leaves every later 'Keep Servers' with nothing to copy — a marker that names no instance is never adoptable)", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice()]),
      currentServers: [],
      now: 1000,
      providerInstanceKey: INSTANCE_A
    });

    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].origin?.syncedInstanceKey).toBe(INSTANCE_A);
  });

  it("BACKFILL — an owned server synced before the field existed gains the stamp on the next sync, as an update, even though nothing else about it changed (kills computing the stamp and then discarding `after` as unchanged: that server would never gain one, and would be permanently unadoptable after a Keep Servers)", () => {
    // Identical to what the device reports in every user-visible field. The stamp
    // is the ONLY difference, which is exactly the state AUTH 3a's reasoning is
    // about one field over.
    const legacy = makeOwnedServer();
    expect(legacy.origin?.syncedInstanceKey).toBeUndefined();

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice()]),
      currentServers: [legacy],
      now: 2000,
      providerInstanceKey: INSTANCE_A
    });

    expect(plan.unchangedCount).toBe(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.origin?.syncedInstanceKey).toBe(INSTANCE_A);
    // Nothing else moved — this is a bookkeeping write, not a device update.
    expect(plan.updates[0].after.name).toBe(legacy.name);
    expect(plan.updates[0].after.host).toBe(legacy.host);
  });

  it("REPOINT — a source now reading from a second deployment re-stamps the servers it still owns, rather than carrying the first deployment's key forward (kills `providerInstanceKey ?? previous`, which would leave a repointed source's servers claiming a deployment this sync did not read them from)", () => {
    const fromA = makeOwnedServer({ origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedInstanceKey: INSTANCE_A } });

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice()]),
      currentServers: [fromA],
      now: 2000,
      providerInstanceKey: INSTANCE_B
    });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.origin?.syncedInstanceKey).toBe(INSTANCE_B);
  });

  it("a provider that names no deployment stamps none, and CLEARS a stamp a previous run wrote (kills carrying an unverified identity forward: the run that cannot name its instance is exactly the run whose config may have moved)", () => {
    const fromA = makeOwnedServer({ origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedInstanceKey: INSTANCE_A } });

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice()]),
      currentServers: [fromA],
      now: 2000,
      providerInstanceKey: undefined
    });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.origin?.syncedInstanceKey).toBeUndefined();
    // And a fresh add from such a provider carries none either.
    const added = computeSyncPlan({ source: makeSource(), tree: makeTree([makeDevice()]), currentServers: [], now: 2000 });
    expect(added.adds[0].origin?.syncedInstanceKey).toBeUndefined();
  });
});

describe("computeSyncPlan — auth profile link", () => {
  // The resolved profile the caller passes in — the WHOLE record, exactly what
  // `resolveSourceAuthProfile` hands over. `name` is used only by the
  // plan-preview modal's copy; `username` is never read by the engine at all
  // (the "link, never copy" assertions below are what pin that); `authType` and
  // `keyPath` are read by AUTH 1b, which is why the narrow `{ id, name }` pair
  // this used to be is no longer enough.
  const profile: AuthProfile = { id: "p1", name: "Lab credentials", username: "labuser", authType: "password" };
  const otherProfile: AuthProfile = { id: "p2", name: "Other", username: "otheruser", authType: "password" };

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
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: otherProfile });

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
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000, authProfile: { ...otherProfile, id: "OTHER", name: "X" } });

    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].authProfileId).toBeUndefined();
    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
    expect(plan.warnings).toContain(DANGLING_WARNING);
  });

  it("the add path records the profile it linked, alongside the username stamp (kills an add that links without recording the link)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const plan = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [], now: 1000, authProfile: profile });

    // Whole-object equality on the origin: the stamp pair IS the retro-apply
    // rule's memory, so a missing member has to fail here and not only in the
    // behavioural round-trips below.
    expect(plan.adds[0].origin).toEqual({
      sourceId: "source-1",
      externalId: "device:1",
      syncedAt: 1000,
      syncedUsername: "admin",
      syncedAuthProfileId: "p1"
    });
  });

  it("the add path records the RESOLVED profile, never the source's dangling reference (kills stamping source.authProfileId, which would lock a never-linked server out of retro-apply)", () => {
    // The source names "p1" but nothing resolved it, so the add writes NO link.
    // Recording "p1" anyway would describe a link that was never made — and the
    // sync after this one, once a real profile is chosen, would read
    // "authProfileId undefined against a stamp naming p1" as the user having
    // cleared a link they never had, and skip the server forever.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const first = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [], now: 1000 }); // unresolved
    expect(first.adds[0].authProfileId).toBeUndefined();
    expect(first.adds[0].origin?.syncedAuthProfileId).toBeUndefined();

    const relinked = makeSource({ authProfileId: "p2", defaultUsername: "admin" });
    const second = computeSyncPlan({
      source: relinked,
      tree: makeTree([makeDevice()]),
      currentServers: [first.adds[0]],
      now: 2000,
      authProfile: otherProfile
    });
    expect(second.updates).toHaveLength(1);
    expect(second.updates[0].after.authProfileId).toBe("p2");
  });

  it("REVIEW FINDING 1 — a per-server clear of the source's profile is honored: the next sync does not reattach it (kills a rule that cannot tell 'never linked' from 'link removed')", () => {
    // Everything else about this record is EXACTLY the add path's output — agent
    // auth, no key path, the username the sync stamped — so every other clause
    // matches and the stamp is the only thing standing between the user's
    // decision and the sync silently undoing it. Without it there is no
    // per-server opt-out at all: the field simply grows back on every sync.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const before = makeOwnedServer({
      authProfileId: undefined,
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin", syncedAuthProfileId: "p1" }
    });
    const plan = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [before], now: 2000, authProfile: profile });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it("REVIEW FINDING 1, end to end — a server the sync just added, whose link the user then clears, is left alone by the very next sync", () => {
    // The full user story rather than a hand-built fixture: sync 1 creates the
    // server with the source's profile, the user clears the Auth Profile field in
    // the server editor (which preserves `origin` verbatim — see the P1 origin
    // restore in serverCommands.ts), sync 2 must not put it back.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const first = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [], now: 1000, authProfile: profile });
    expect(first.adds[0].authProfileId).toBe("p1");

    const cleared: ServerConfig = { ...first.adds[0], authProfileId: undefined };
    const second = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [cleared], now: 2000, authProfile: profile });

    expect(second.updates).toHaveLength(0);
    expect(second.unchangedCount).toBe(1);
  });

  it("retro-apply records the profile it just applied, so clearing THAT link is an opt-out too (kills applying the link without stamping it — the half-fix that leaves the loop open one sync later)", () => {
    // A legacy server (no stamps at all) is adopted on sync 1. If the adoption
    // writes `authProfileId` but not `origin.syncedAuthProfileId`, the record
    // afterwards is indistinguishable from a never-linked one, so the user's
    // clear on sync 2 is invisible and sync 3 reattaches — the finding, moved one
    // sync into the future rather than fixed.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const before = makeOwnedServer({ origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000 } });
    const adopt = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [before], now: 2000, authProfile: profile });

    expect(adopt.updates).toHaveLength(1);
    expect(adopt.updates[0].after.authProfileId).toBe("p1");
    expect(adopt.updates[0].after.origin?.syncedAuthProfileId).toBe("p1");

    const cleared: ServerConfig = { ...adopt.updates[0].after, authProfileId: undefined };
    const after = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [cleared], now: 3000, authProfile: profile });
    expect(after.updates).toHaveLength(0);
    expect(after.unchangedCount).toBe(1);
  });

  it("an update fired for an unrelated reason carries the opt-out stamp forward instead of erasing it (kills a rebuilt origin that forgets the new member)", () => {
    // The device was RENAMED, so `origin` is rebuilt on a sync that has nothing
    // to do with authentication. A rebuild that drops `syncedAuthProfileId`
    // silently converts the user's opt-out back into "never linked", and the sync
    // after this one reattaches the profile.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const before = makeOwnedServer({
      authProfileId: undefined,
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin", syncedAuthProfileId: "p1" }
    });
    const renamed = computeSyncPlan({ source, tree: makeTree([makeDevice({ name: "core-sw-1-renamed" })]), currentServers: [before], now: 2000, authProfile: profile });

    expect(renamed.updates).toHaveLength(1);
    expect(renamed.updates[0].after.name).toBe("core-sw-1-renamed");
    expect(renamed.updates[0].after.authProfileId).toBeUndefined();
    expect(renamed.updates[0].after.origin).toEqual({
      sourceId: "source-1",
      externalId: "device:1",
      syncedAt: 2000,
      syncedUsername: "admin",
      syncedAuthProfileId: "p1"
    });

    // ...and the opt-out is still standing on the sync after that one.
    const next = computeSyncPlan({
      source,
      tree: makeTree([makeDevice({ name: "core-sw-1-renamed" })]),
      currentServers: [renamed.updates[0].after],
      now: 3000,
      authProfile: profile
    });
    expect(next.updates).toHaveLength(0);
    expect(next.unchangedCount).toBe(1);
  });

  it("an opt-out survives the source being pointed at a DIFFERENT profile (kills remembering the opt-out only for the profile the source currently names)", () => {
    // Intended semantics, pinned: the stamp records what the SYNC last wrote on
    // THIS server, not which profile the source happens to name today. A rule
    // phrased as "skip only when the stamp equals the profile being applied"
    // reads p1 !== p2 and reattaches — so a user who opted out would be
    // overruled by an unrelated edit to the source.
    const source = makeSource({ authProfileId: "p2", defaultUsername: "admin" });
    const before = makeOwnedServer({
      authProfileId: undefined,
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin", syncedAuthProfileId: "p1" }
    });
    const plan = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [before], now: 2000, authProfile: otherProfile });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it("a server still carrying the profile the sync stamped is NOT re-stamped when the source switches A -> B (kills replacing the `authProfileId === undefined` clause with bare equality against the stamp)", () => {
    // Intended semantics, pinned: bare "current link still equals the stamp"
    // would match here (both p1) and move the server onto p2 — reversing the
    // documented contract that changing a source's profile never re-stamps
    // already-linked servers, and moving the link of anyone who deliberately
    // re-selected p1 by hand. Only the both-undefined branch of that equality is
    // taken; a source switch is applied through Apply Auth Profile instead.
    const source = makeSource({ authProfileId: "p2", defaultUsername: "admin" });
    const before = makeOwnedServer({
      authProfileId: "p1",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin", syncedAuthProfileId: "p1" }
    });
    const plan = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [before], now: 2000, authProfile: otherProfile });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it("a hand-linked profile is never recorded as the sync's own (kills a stamp inferred from the record's current authProfileId)", () => {
    // The user linked "q" by hand; the sync has never linked anything here. An
    // implementation that records `syncedAuthProfileId: ownedServer.authProfileId`
    // would launder that hand-link into "what the sync put there" — the same
    // failure mode the username stamp already guards against, and the reason the
    // stamp is only ever written where the sync itself writes the link.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const before = makeOwnedServer({ authProfileId: "q" });
    const plan = computeSyncPlan({ source, tree: makeTree([makeDevice({ name: "core-sw-1-renamed" })]), currentServers: [before], now: 2000, authProfile: profile });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.authProfileId).toBe("q");
    expect(plan.updates[0].after.origin?.syncedAuthProfileId).toBeUndefined();
  });

  it("a server synced before EITHER stamp existed is still adopted — an absent syncedAuthProfileId is 'the sync linked nothing', never 'ineligible'", () => {
    // Backward compatibility for the population the feature was written for:
    // `origin` here is the exact three-member shape older builds wrote. A clause
    // that demanded the stamp be PRESENT (or equal to the profile being applied)
    // would refuse every one of them.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const before = makeOwnedServer({ origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000 } });
    expect(before.origin?.syncedAuthProfileId).toBeUndefined();
    const plan = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [before], now: 2000, authProfile: profile });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.authProfileId).toBe("p1");
  });

  it("REVIEW FINDING 2 — a legacy server gains its username stamp even when the endpoint username it computes already equals the one it has (kills a `changed` check that ignores the origin stamp)", () => {
    // The exact discard the finding names: `syncedUsername` is computed for the
    // first time from the endpoint, but name/host/port/group/authProfileId and
    // the username itself are all identical, so a comparison over those fields
    // alone calls the record unchanged and throws the freshly computed stamp
    // away. This server would then never gain one, however many times it syncs.
    const source = makeSource({ authProfileId: undefined, defaultUsername: "admin" });
    const before = makeOwnedServer({ username: "admin", origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000 } });
    const tree = makeTree([makeDevice({ endpoints: [{ kind: "ssh", host: "10.0.0.1", username: "admin" }] })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 2000 });

    expect(plan.updates).toHaveLength(1);
    expect(plan.unchangedCount).toBe(0);
    expect(plan.updates[0].after.origin?.syncedUsername).toBe("admin");
    // Nothing else moved — the stamp is the entire reason this is an update.
    expect(plan.updates[0].after.username).toBe("admin");
    expect(plan.updates[0].after.name).toBe(before.name);
  });

  it("REVIEW FINDING 2, the harm — once that stamp lands, linking a profile with a different username still retro-applies (without it the server is misclassified as hand-edited forever)", () => {
    // Continuation of the case above. The source later gains profile "Lab
    // credentials" (username "labuser"), which the source form mirrors into
    // `defaultUsername`. With the stamp persisted, the comparison runs against
    // "admin" — what the sync actually wrote — and the server is adopted. With
    // the stamp discarded by the previous sync, it falls back to the source's
    // CURRENT default ("labuser"), reads "admin" as a hand-edit, and is skipped
    // on this sync and every later one.
    const source = makeSource({ authProfileId: undefined, defaultUsername: "admin" });
    const before = makeOwnedServer({ username: "admin", origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000 } });
    const tree = makeTree([makeDevice({ endpoints: [{ kind: "ssh", host: "10.0.0.1", username: "admin" }] })]);
    const stamped = computeSyncPlan({ source, tree, currentServers: [before], now: 2000 }).updates[0].after;

    const withProfile = makeSource({ authProfileId: "p1", defaultUsername: "labuser" });
    const plan = computeSyncPlan({ source: withProfile, tree, currentServers: [stamped], now: 3000, authProfile: profile });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.authProfileId).toBe("p1");
    expect(plan.updates[0].after.username).toBe("admin");
  });

  it("a sync that computes no new stamp still reports the server as unchanged (kills comparing origins wholesale — syncedAt advances every run, so every owned server would be an update forever)", () => {
    const source = makeSource({ authProfileId: undefined, defaultUsername: "admin" });
    const before = makeOwnedServer({
      username: "admin",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin", syncedAuthProfileId: undefined }
    });
    const plan = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [before], now: 9999 });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  /**
   * REVIEW FINDING (P2) — the END-TO-END consequence, across the two layers
   * that used to disagree. The sync deliberately writes the SOURCE's default
   * username onto every server it creates and only LINKS the profile; the
   * connect path then substituted the profile's username over the top. For a
   * profile whose username is whitespace (imported backup — validateAuthProfile
   * checks length, not content), that discarded the very fallback
   * `fallbackUsernameForSource` had stored for exactly this profile and offered
   * whitespace to the SSH server instead. Asserting the plan alone would not
   * have caught it: the plan was always right.
   */
  it("a server this sync creates connects as the username the sync wrote, even when the linked profile's own username is whitespace", async () => {
    const blankProfile: AuthProfile = { id: "p1", name: "Imported", username: "   ", authType: "password" };
    const source = makeSource({ authProfileId: "p1", defaultUsername: "labuser" });
    const plan = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]),
      currentServers: [],
      now: 1000,
      authProfile: blankProfile
    });

    const created = plan.adds[0];
    expect(created.username).toBe("labuser");
    expect(created.authProfileId).toBe("p1");

    const resolved = await resolveThroughConnect(created, blankProfile);

    expect(resolved.username).toBe("labuser");
    // The auth type IS supplied by the profile, so the link still does its job:
    // this is what stops synced servers landing on SSH agent auth.
    expect(resolved.authType).toBe("password");
  });

  /**
   * REVIEW FINDING (P1) — AUTH 1b. The same END-TO-END discipline as the test
   * above, for the other shape of profile the editor accepts: `key` auth with
   * no key file.
   *
   * Why the plan alone proves nothing here, and why this is asserted through
   * `buildConnectConfig`: the plan was right by its own rule (link the source's
   * profile), the connect-time resolution was right by ITS own rule (a profile
   * always owns `authType`; it owns no `keyPath`, so the server keeps its own —
   * of which a synced server has none), and the two composed into a server that
   * cannot open a connection at all. Only the function that builds what is
   * actually sent to the SSH server sees it.
   */
  const KEYLESS_KEY_PROFILE: AuthProfile = { id: "p1", name: "Shared Key", username: "keyuser", authType: "key" };

  // Pinned verbatim, same reason as DANGLING_WARNING: this is what the
  // plan-preview modal shows. makeSource()'s name is "NetBox".
  //
  // REVIEW FINDING (P2) — "servers this source CREATES", not "syncs". The
  // sentence is a statement of policy about the records the sync writes, and of
  // those it is exactly true (the add path stamps agent auth and no key path, and
  // retro-apply is refused while the profile is unusable). Said of every server
  // the source has ever synced it was false for the one shape this rule
  // deliberately leaves alone — a server given a key file of its own, which keeps
  // the profile and goes on connecting through it — and that server is now named
  // by its own trailing sentence rather than contradicted by this one.
  const KEYLESS_KEY_WARNING =
    'The auth profile "Shared Key" for "NetBox" uses private key authentication but has no key file — servers this source creates have no key of their own, so the sync does not apply it: they use the default username with SSH agent authentication instead. Add a key file to the profile, or choose another.';

  it("AUTH 1b — a source linked to a key profile with no key file adds servers that can actually open a connection, and says why the link was not used (kills stamping a link whose authType every synced server is unable to satisfy)", async () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "labuser" });
    const plan = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]),
      currentServers: [],
      now: 1000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    const created = plan.adds[0];
    // Degraded to the pre-feature record, field for field — NOT a half-applied
    // link. `authType`/`keyPath` were already these values; the link is what
    // must be absent.
    expect(created.authProfileId).toBeUndefined();
    expect(created.origin?.syncedAuthProfileId).toBeUndefined();
    expect(created.authType).toBe("agent");
    expect(created.username).toBe("labuser");
    expect(plan.warnings).toContain(KEYLESS_KEY_WARNING);

    // THE ASSERTION THAT MATTERS. With the link stamped (the wrong
    // implementation), resolveServer hands back `authType: "key"` with no
    // `keyPath` and this rejects with "Missing keyPath for key auth on
    // core-sw-1" — the fleet-wide unusability this whole feature exists to end,
    // reintroduced through the Auth Profile select.
    const resolved = await resolveThroughConnect(created, KEYLESS_KEY_PROFILE);
    expect(resolved.authType).toBe("agent");
    expect(resolved.keyPath).toBeUndefined();
    const config = await buildConnectConfig(resolved);
    expect(config).toMatchObject({ host: "10.0.0.1", port: 22, username: "labuser" });
    expect(config.privateKey).toBeUndefined();
  });

  it("AUTH 1b — retro-apply leaves a WORKING agent-auth server alone when the source's key profile has no key file, and that server still connects (kills a check that covers only the add path)", async () => {
    // Exactly the server retro-apply exists to adopt: no profile, agent auth,
    // no key path, still on the username the sync stamped. Under the wrong
    // implementation it is adopted — and a server that was connecting fine a
    // moment ago stops being able to connect at all, which is strictly worse
    // than the defect retro-apply was written to repair.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const before = makeOwnedServer();
    const plan = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]),
      currentServers: [before],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
    expect(plan.warnings).toContain(KEYLESS_KEY_WARNING);

    const resolved = await resolveThroughConnect(before, KEYLESS_KEY_PROFILE);
    expect(resolved.authType).toBe("agent");
    expect((await buildConnectConfig(resolved)).privateKey).toBeUndefined();
  });

  it("AUTH 1b applies to the PROFILE's usable key path, not to the presence of the field: a whitespace-only key file is no key file (kills a `profile.keyPath !== undefined` shortcut that diverges from the ownership rule)", () => {
    const source = makeSource({ authProfileId: "p1" });
    const plan = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]),
      currentServers: [],
      now: 1000,
      authProfile: { ...KEYLESS_KEY_PROFILE, keyPath: "   " }
    });

    expect(plan.adds[0].authProfileId).toBeUndefined();
    expect(plan.warnings).toContain(KEYLESS_KEY_WARNING);
  });

  /**
   * REVIEW FINDING (P1) — AUTH 2b, the half AUTH 1b left undone. Refusing to
   * stamp the link stops NEW damage; the servers an EARLIER sync linked (while
   * the profile still had a key file) keep `authProfileId`, because the whole
   * update path is built from `ownedServer`. Those servers cannot open a
   * connection at all, and the warning said they were on SSH agent
   * authentication.
   *
   * Asserted through `buildConnectConfig` at BOTH ends, which is the only place
   * the composition is visible: the record as it stands today throws, the record
   * this plan produces connects.
   */
  const previouslyLinkedServer = (overrides: Partial<ServerConfig> = {}): ServerConfig =>
    makeOwnedServer({
      authProfileId: "p1",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin", syncedAuthProfileId: "p1" },
      ...overrides
    });

  it("AUTH 2b — a server this source linked while the profile still had a key file is UNLINKED once it loses one, so it can open a connection again (kills refusing new stamps while leaving the existing ones in place)", async () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const before = previouslyLinkedServer();

    // The premise, proven rather than assumed: as the record stands, the link
    // resolves to key auth with no key anywhere and the connection cannot be
    // built. This is the state the old warning described as "SSH agent
    // authentication".
    const brokenResolved = await resolveThroughConnect(before, KEYLESS_KEY_PROFILE);
    expect(brokenResolved.authType).toBe("key");
    expect(brokenResolved.keyPath).toBeUndefined();
    await expect(buildConnectConfig(brokenResolved)).rejects.toThrow("Missing keyPath for key auth on core-sw-1");

    const plan = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]),
      currentServers: [before],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    // Under the wrong implementation nothing about this server changes: no
    // update, unchangedCount 1, and it stays unable to connect forever.
    expect(plan.updates).toHaveLength(1);
    expect(plan.unchangedCount).toBe(0);
    const after = plan.updates[0].after;
    expect(after.authProfileId).toBeUndefined();
    // The stamp goes with the link — left behind it would read as a per-server
    // opt-out nobody chose and lock this server out of retro-apply for good.
    expect(after.origin?.syncedAuthProfileId).toBeUndefined();
    // Nothing else about the record is touched by the unlink.
    expect(after.authType).toBe("agent");
    expect(after.username).toBe("admin");
    expect(after.origin?.syncedUsername).toBe("admin");

    // THE ASSERTION THAT MATTERS — the record this plan writes connects.
    const resolved = await resolveThroughConnect(after, KEYLESS_KEY_PROFILE);
    expect(resolved.authType).toBe("agent");
    const config = await buildConnectConfig(resolved);
    expect(config).toMatchObject({ host: "10.0.0.1", port: 22, username: "admin" });
    expect(config.privateKey).toBeUndefined();
  });

  it("AUTH 2b is reversible: once the profile has a key file again, the very next sync re-links the servers it unlinked (kills treating the unlink as a one-way loss the user has to repair server by server)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const unlinked = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]),
      currentServers: [previouslyLinkedServer()],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    }).updates[0].after;

    const repaired: AuthProfile = { ...KEYLESS_KEY_PROFILE, keyPath: "/keys/id_ed25519" };
    const relink = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]),
      currentServers: [unlinked],
      now: 3000,
      authProfile: repaired
    });

    // Retro-apply's six clauses all hold again precisely BECAUSE the unlink
    // cleared the stamp along with the link. Leaving the stamp would make this
    // an opt-out and the server would never come back.
    expect(relink.updates).toHaveLength(1);
    expect(relink.updates[0].after.authProfileId).toBe("p1");
    expect(relink.updates[0].after.origin?.syncedAuthProfileId).toBe("p1");
  });

  /**
   * REVIEW FINDING (P2) — the reversibility promise above, tested on the shape it
   * did not hold for. AUTH 2b decides "brings no usable key of its own" with
   * `hasOwnKeyPath`, so it unlinks a server carrying `keyPath: "   "` — correctly,
   * that is not a key file — while leaving the value where it found it. Retro-apply
   * used to ask the same question with a literal `keyPath === undefined`, which
   * that value does not satisfy, so the unlink was permanent for precisely the
   * servers the unlink is reachable on.
   *
   * Reachable, not hypothetical: a keyless key profile leaves Private Key File
   * EDITABLE on a linked server on purpose (that is the pairing
   * `authProfileNeedsServerKeyPath` exists to allow), and `formValuesToServer`
   * stores any truthy string verbatim — so typing spaces into that control saves
   * exactly this record.
   *
   * A ROUND TRIP rather than a one-way assertion, because either half alone passes
   * against the bug: the unlink was always right, and a re-link asserted on a
   * `keyPath: undefined` server (the test above) was always right too. Only running
   * the sync twice over the same record shows the two rules contradicting each
   * other.
   */
  it("AUTH 2b's reversal holds for the whitespace key path it unlinks on: repair the profile and the next sync re-links that server (kills retro-apply's literal `keyPath === undefined`, which unlinks by one rule and then refuses to re-link by another)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });

    const unlinked = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]),
      currentServers: [previouslyLinkedServer({ keyPath: "   " })],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    }).updates[0].after;
    expect(unlinked.authProfileId).toBeUndefined();
    expect(unlinked.origin?.syncedAuthProfileId).toBeUndefined();
    // The unlink leaves the server's own credential field exactly as it found it —
    // the update path copies `keyPath` untouched from `before`. Normalizing it away
    // here was the other candidate fix, and this assertion pins that it is NOT what
    // makes the re-link below work.
    expect(unlinked.keyPath).toBe("   ");

    const repaired: AuthProfile = { ...KEYLESS_KEY_PROFILE, keyPath: "/keys/id_ed25519" };
    const relink = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]),
      currentServers: [unlinked],
      now: 3000,
      authProfile: repaired
    });

    // Under the wrong implementation this plan is empty — unchangedCount 1 — and
    // the server the sync took the link off never gets it back, on this sync or any
    // later one, however healthy the profile becomes.
    expect(relink.updates).toHaveLength(1);
    expect(relink.unchangedCount).toBe(0);
    expect(relink.updates[0].after.authProfileId).toBe("p1");
    expect(relink.updates[0].after.origin?.syncedAuthProfileId).toBe("p1");
  });

  it("AUTH 2b leaves a HAND-set link alone, and one the user MOVED to another profile (kills a sweep over every server linked to the profile, which would clear a link the sync never applied)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    // Linked by hand: carries the profile but no stamp naming it.
    const handLinked = makeOwnedServer({
      id: deterministicServerId("source-1", "device:1"),
      authProfileId: "p1",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });
    // The sync linked p1 here; the user has since re-pointed it at q.
    const movedByUser = makeOwnedServer({
      id: deterministicServerId("source-1", "device:2"),
      name: "core-sw-2",
      host: "10.0.0.2",
      authProfileId: "q",
      origin: { sourceId: "source-1", externalId: "device:2", syncedAt: 1000, syncedUsername: "admin", syncedAuthProfileId: "p1" }
    });

    const plan = computeSyncPlan({
      source,
      tree: makeTree([makeDevice(), makeDevice({ externalId: "device:2", name: "core-sw-2", endpoints: [{ kind: "ssh", host: "10.0.0.2" }] })]),
      currentServers: [handLinked, movedByUser],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(2);
    // And the warning must not claim an unlink that did not happen.
    expect(plan.warnings).toContain(KEYLESS_KEY_WARNING);
  });

  it("AUTH 2b leaves a server that brings its own key file alone — a keyless key profile plus the server's own key is a working pairing (kills unlinking every source-applied link regardless of what the server can supply)", async () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const withOwnKey = previouslyLinkedServer({ authType: "key", keyPath: "/keys/own_ed25519" });

    const plan = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]),
      currentServers: [withOwnKey],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
    // An over-broad implementation both unlinks this server AND appends
    // "1 server … is unlinked here" to this text, so the absence of that clause
    // is asserted as part of the exact string.
    //
    // REVIEW FINDING (P2) — and the retained clause is asserted verbatim in its
    // place. Under the wrong implementation (the unconditional sentence this
    // replaced) the user is told this server has no key of its own and is using
    // SSH agent authentication; it has one, it is still on the profile, and the
    // whole point of reading this warning is to know which servers the sync
    // touched.
    expect(plan.warnings).toContain(
      `${KEYLESS_KEY_WARNING} 1 server this sync had already linked to it keeps the link, because it carries a key file of its own and still connects through the profile.`
    );

    // Why it must be left alone: the pairing works. The profile supplies the
    // auth type (and its passphrase), the server supplies the key.
    const resolved = await resolveThroughConnect(withOwnKey, KEYLESS_KEY_PROFILE);
    expect(resolved.authType).toBe("key");
    expect(resolved.keyPath).toBe("/keys/own_ed25519");
  });

  it("AUTH 2b treats a whitespace-only key path on the SERVER as no key file, exactly as the ownership rule treats one on the profile (kills a `keyPath !== undefined` shortcut that leaves the broken server broken)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const plan = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]),
      currentServers: [previouslyLinkedServer({ keyPath: "   " })],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.authProfileId).toBeUndefined();
  });

  /**
   * REVIEW FINDING (P2) — the use-site half of the malformed-`keyPath` fix
   * (`validateServerConfig` is the boundary half). The cost of being wrong here
   * is out of all proportion to the field: this branch is only reached while
   * planning a sync whose key profile has lost its key file — i.e. when a fleet
   * is already mis-authenticating and the plan is the repair — and a thrown
   * TypeError takes the WHOLE run down after the inventory has been fetched,
   * for one malformed row that may belong to a server this plan never touches.
   */
  it("AUTH 2b treats a NON-STRING key path on the server as no key file instead of throwing (kills (server.keyPath ?? \"\").trim(): one hand-edited backup row aborts the entire sync, including the repair every other server in it is waiting for)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const malformed = { ...previouslyLinkedServer(), keyPath: 12345 } as unknown as ServerConfig;

    let plan!: ReturnType<typeof computeSyncPlan>;
    expect(() => {
      plan = computeSyncPlan({
        source,
        tree: makeTree([makeDevice()]),
        currentServers: [malformed],
        now: 2000,
        authProfile: KEYLESS_KEY_PROFILE
      });
    }).not.toThrow();

    // …and it lands in the bucket blank already occupies: a server that brings
    // no key of its own, so the unusable link is taken back off it.
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.authProfileId).toBeUndefined();
  });

  /**
   * REVIEW FINDING (P1) — the rollback ran INSIDE the update loop, after four
   * `continue`s that mapping validation reaches first, so it was skipped for
   * exactly the servers most likely to need it.
   *
   * The faithful case, and the reason this is a P1 rather than a curiosity: the
   * NetBox provider emits a device with ZERO endpoints when it has no primary IP
   * (documented, deliberate — it warns and carries on), and the server for that
   * device is still there from the sync when it did have one. So a source whose
   * key profile lost its key file left every de-IP'd device's server linked and
   * unable to connect, with no route back short of hand-editing each one — while
   * the plan's own warning said those servers were on SSH agent authentication.
   *
   * Asserted through `buildConnectConfig` at both ends for the same reason the
   * mapped case is: "still linked" IS the failure, and only the function that
   * builds what is sent to the SSH server can tell a repaired record from a
   * plausible-looking one.
   */
  it("ADDRESSLESS (Codex P1) — an owned server whose device goes no-primary DOWNGRADES to addressless and CARRIES its auth link forward (the keyless-key unlink is deferred to upgrade, when there is actually an address to connect to) — kills unlinking a server that cannot connect anyway", async () => {
    // "delete" rather than the fixture default, so a pass that mistook a
    // downgraded device for an absent one would DELETE this server.
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin", prunePolicy: "delete" });
    const before = previouslyLinkedServer();

    const plan = computeSyncPlan({
      source,
      // Exactly what the provider emits for a device with no primary endpoint,
      // renamed at the source too so the downgrade's name refresh is visible.
      tree: makeTree([makeDevice({ name: "renamed-at-source", endpoints: [] })]),
      currentServers: [before],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    expect(plan.updates).toHaveLength(1);
    const after = plan.updates[0].after;
    // Downgraded, not pruned; keeps its stamps (the spec's "keep the origin +
    // stamps") — the link rides forward rather than being cleared here.
    expect(plan.prunes).toHaveLength(0);
    expect(plan.adds).toHaveLength(0);
    expect(after.addressless).toBe(true);
    expect(after.host).toBe("");
    expect(after.authProfileId).toBe("p1");
    expect(after.origin?.syncedAuthProfileId).toBe("p1");
    // A full update: the source-side rename and folder are applied, syncedAt
    // advances (this sync DID decide the record).
    expect(after.name).toBe("renamed-at-source");
    expect(after.group).toBe("NetBox");
    expect(after.origin?.syncedAt).toBe(2000);
  });

  it("ADDRESSLESS (Codex P1) — the deferred keyless-key unlink FIRES on the addressless→addressed UPGRADE, so the re-started server can open a connection again", async () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    // The server as it sits AFTER a downgrade: addressless, still carrying the
    // keyless-key link.
    const addressless = previouslyLinkedServer({ host: "", port: 0, addressless: true });
    const plan = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]), // device gained an ssh endpoint again
      currentServers: [addressless],
      now: 3000,
      authProfile: KEYLESS_KEY_PROFILE
    });
    expect(plan.updates).toHaveLength(1);
    const after = plan.updates[0].after;
    expect(after.addressless ?? false).toBe(false);
    expect(after.host).toBe("10.0.0.1");
    // The mapped AUTH 2b unlink runs on the addressed upgrade path.
    expect(after.authProfileId).toBeUndefined();
    const resolved = await resolveThroughConnect(after, KEYLESS_KEY_PROFILE);
    expect(resolved.authType).toBe("agent");
    const config = await buildConnectConfig(resolved);
    expect(config).toMatchObject({ host: "10.0.0.1", port: 22, username: "admin" });
  });

  it("AUTH 2b covers the other mapping-validation skips too — an empty device name and an invalid port — without letting either device write anything else (kills a fix that special-cases only the no-endpoint skip)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const emptyNamed = previouslyLinkedServer();
    const badPort = previouslyLinkedServer({
      id: deterministicServerId("source-1", "device:2"),
      name: "core-sw-2",
      host: "10.0.0.2",
      origin: { sourceId: "source-1", externalId: "device:2", syncedAt: 1000, syncedUsername: "admin", syncedAuthProfileId: "p1" }
    });

    const plan = computeSyncPlan({
      source,
      tree: makeTree([
        // Both devices carry a DIFFERENT host (and the second a different name)
        // than the server they own, so any implementation that reaches the
        // rollback by letting a skipped device fall through into the update path
        // shows up as a host change or a rename rather than as a passing test.
        makeDevice({ name: "", endpoints: [{ kind: "ssh", host: "10.9.9.9" }] }),
        makeDevice({ externalId: "device:2", name: "renamed-at-source", endpoints: [{ kind: "ssh", host: "10.9.9.9", port: 0 }] })
      ]),
      currentServers: [emptyNamed, badPort],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    expect(plan.updates).toHaveLength(2);
    for (const update of plan.updates) {
      expect(update.after.authProfileId).toBeUndefined();
      expect(update.after.origin?.syncedAuthProfileId).toBeUndefined();
      expect(update.after.host).toBe(update.before.host);
      expect(update.after.name).toBe(update.before.name);
      expect(update.after.port).toBe(22);
    }
    // The skips themselves are still skips.
    expect(plan.adds).toHaveLength(0);
    expect(plan.warnings).toContain('Device "device:1" has an empty name and was skipped.');
    expect(plan.warnings).toContain('Device "renamed-at-source" (device:2) has an invalid port 0 and was skipped.');
    expect(plan.warnings).toContain(
      `${KEYLESS_KEY_WARNING} 2 servers this sync had already linked to it are unlinked here so they can connect again; a later sync re-links them once the profile has a key file.`
    );
  });

  it("ADDRESSLESS (Codex P1) — an owned server is decided exactly ONCE when its no-primary device is reported twice: the first copy downgrades it, the second is a duplicate (kills a double update / double placeholder)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });

    const plan = computeSyncPlan({
      source,
      // First copy: no endpoint — claims the externalId, downgrading the owned
      // server to addressless. The second copy is then a duplicate.
      tree: makeTree([makeDevice({ endpoints: [] }), makeDevice({ name: "core-sw-1-again" })]),
      currentServers: [previouslyLinkedServer()],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    // Exactly one update for the one owned record — the addressless downgrade —
    // and the link rides forward (not unlinked here; that defers to upgrade).
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.addressless).toBe(true);
    expect(plan.updates[0].after.authProfileId).toBe("p1");
    expect(plan.warnings).toContain('Duplicate device ID "device:1" — kept first ("core-sw-1").');
  });

  it("AUTH 2b still leaves a server whose device is GONE from the fetch to the prune policy (kills a pass over every owned server, which would rewrite the credentials of a server the same plan reports as kept in place)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin", prunePolicy: "keep" });
    const plan = computeSyncPlan({
      source,
      tree: makeTree([]),
      currentServers: [previouslyLinkedServer()],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    expect(plan.updates).toHaveLength(0);
    expect(plan.prunes).toEqual([{ policy: "keep", server: previouslyLinkedServer() }]);
    // Bare: no unlink happened, so the warning must not claim one.
    expect(plan.warnings).toContain(KEYLESS_KEY_WARNING);
  });

  it("ADDRESSLESS (Codex P1) — two owned servers whose devices go no-primary both DOWNGRADE to addressless, each carrying its own auth (a hand-set link and a synced-with-own-key link) forward unchanged (kills clearing a link on the downgrade)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    // Linked by hand: carries the profile but no stamp naming it.
    const handLinked = makeOwnedServer({
      authProfileId: "p1",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });
    // The sync's own link, on a server since given its own key file.
    const withOwnKey = previouslyLinkedServer({
      id: deterministicServerId("source-1", "device:2"),
      name: "core-sw-2",
      host: "10.0.0.2",
      authType: "key",
      keyPath: "/keys/own_ed25519",
      origin: { sourceId: "source-1", externalId: "device:2", syncedAt: 1000, syncedUsername: "admin", syncedAuthProfileId: "p1" }
    });

    const plan = computeSyncPlan({
      source,
      tree: makeTree([makeDevice({ endpoints: [] }), makeDevice({ externalId: "device:2", name: "core-sw-2", endpoints: [] })]),
      currentServers: [handLinked, withOwnKey],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    // Both downgrade to addressless; neither is pruned; each keeps its own link.
    expect(plan.prunes).toHaveLength(0);
    expect(plan.updates).toHaveLength(2);
    const byId = new Map(plan.updates.map((u) => [u.after.id, u.after] as const));
    const a = byId.get(handLinked.id)!;
    const b = byId.get(withOwnKey.id)!;
    expect(a.addressless).toBe(true);
    expect(a.authProfileId).toBe("p1");
    expect(b.addressless).toBe(true);
    expect(b.authProfileId).toBe("p1");
    expect(b.keyPath).toBe("/keys/own_ed25519");
  });

  // Pinned verbatim in both grammatical numbers: this sentence is the finding.
  // The old text told the user that servers already linked to the profile were
  // using SSH agent authentication while they were in fact unable to connect,
  // so what the sync DID about them has to be stated, not implied.
  it("the warning says how many servers this sync unlinked, in the right grammatical number (kills a warning that still claims agent authentication without disclosing the unlink)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const one = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]),
      currentServers: [previouslyLinkedServer()],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });
    expect(one.warnings).toContain(
      `${KEYLESS_KEY_WARNING} 1 server this sync had already linked to it is unlinked here so it can connect again; a later sync re-links it once the profile has a key file.`
    );

    const two = computeSyncPlan({
      source,
      tree: makeTree([
        makeDevice(),
        makeDevice({ externalId: "device:2", name: "core-sw-2", endpoints: [{ kind: "ssh", host: "10.0.0.2" }] })
      ]),
      currentServers: [
        previouslyLinkedServer(),
        makeOwnedServer({
          id: deterministicServerId("source-1", "device:2"),
          name: "core-sw-2",
          host: "10.0.0.2",
          authProfileId: "p1",
          origin: { sourceId: "source-1", externalId: "device:2", syncedAt: 1000, syncedUsername: "admin", syncedAuthProfileId: "p1" }
        })
      ],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });
    expect(two.warnings).toContain(
      `${KEYLESS_KEY_WARNING} 2 servers this sync had already linked to it are unlinked here so they can connect again; a later sync re-links them once the profile has a key file.`
    );
  });

  /**
   * REVIEW FINDING (P2) — the same discipline for the other outcome. The warning
   * stated one policy unconditionally ("servers … have no key of their own …
   * they use the default username with SSH agent authentication instead") while
   * the rollback right above it deliberately LEFT a server linked, still using
   * the profile, because it carries a key file of its own — a state a user
   * reaches simply by giving one synced server its own key after the profile
   * lost its. The reader was told an unlink had happened to a server it had not
   * happened to.
   *
   * Both directions in one plan, because that is where the old text was most
   * wrong and where a partial fix (count the unlinks, say nothing about the
   * retentions) still reads as though every linked server was cleared.
   */
  it("the warning reports the links it deliberately kept as well as the ones it cleared, so neither set is described as the other (kills an unconditional sentence that puts a retained own-key server on SSH agent authentication)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const plan = computeSyncPlan({
      source,
      tree: makeTree([
        makeDevice(),
        makeDevice({ externalId: "device:2", name: "core-sw-2", endpoints: [{ kind: "ssh", host: "10.0.0.2" }] })
      ]),
      currentServers: [
        // No key of its own — unlinked.
        previouslyLinkedServer(),
        // Its own key — the pairing works, so the link stays.
        previouslyLinkedServer({
          id: deterministicServerId("source-1", "device:2"),
          name: "core-sw-2",
          host: "10.0.0.2",
          authType: "key",
          keyPath: "/keys/own_ed25519",
          origin: { sourceId: "source-1", externalId: "device:2", syncedAt: 1000, syncedUsername: "admin", syncedAuthProfileId: "p1" }
        })
      ],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].before.name).toBe("core-sw-1");
    expect(plan.warnings).toContain(
      `${KEYLESS_KEY_WARNING} 1 server this sync had already linked to it is unlinked here so it can connect again; a later sync re-links it once the profile has a key file.` +
        " 1 server this sync had already linked to it keeps the link, because it carries a key file of its own and still connects through the profile."
    );
  });

  it("the retained-link sentence is plural-correct, and appears with no unlink sentence when nothing was unlinked (kills a note welded onto the unlink count)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const ownKey = (externalId: string, name: string, host: string): ServerConfig =>
      previouslyLinkedServer({
        id: deterministicServerId("source-1", externalId),
        name,
        host,
        authType: "key",
        keyPath: "/keys/own_ed25519",
        origin: { sourceId: "source-1", externalId, syncedAt: 1000, syncedUsername: "admin", syncedAuthProfileId: "p1" }
      });

    const plan = computeSyncPlan({
      source,
      tree: makeTree([
        makeDevice(),
        makeDevice({ externalId: "device:2", name: "core-sw-2", endpoints: [{ kind: "ssh", host: "10.0.0.2" }] })
      ]),
      currentServers: [ownKey("device:1", "core-sw-1", "10.0.0.1"), ownKey("device:2", "core-sw-2", "10.0.0.2")],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    expect(plan.updates).toHaveLength(0);
    expect(plan.warnings).toContain(
      `${KEYLESS_KEY_WARNING} 2 servers this sync had already linked to it keep the link, because they carry key files of their own and still connect through the profile.`
    );
  });

  it("the keyless warning keeps its position among the other warnings even though its text now depends on the whole device loop (kills appending it after the per-device warnings)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const plan = computeSyncPlan({
      source,
      // A tree warning first, then a device that produces a per-device warning.
      tree: makeTree([makeDevice(), makeDevice({ externalId: "", name: "no-id" })], ["provider said so"]),
      currentServers: [previouslyLinkedServer()],
      now: 2000,
      authProfile: KEYLESS_KEY_PROFILE
    });

    expect(plan.warnings[0]).toBe("provider said so");
    expect(plan.warnings[1]).toContain("uses private key authentication but has no key file");
    expect(plan.warnings[2]).toBe('Device "no-id" has no device ID and was skipped.');
  });

  it("a key profile that DOES carry a key file is stamped exactly as before, and the synced server connects with that key (kills over-broad rejection of every key profile)", async () => {
    const keyProfile: AuthProfile = { ...KEYLESS_KEY_PROFILE, keyPath: "/keys/id_ed25519" };
    const source = makeSource({ authProfileId: "p1", defaultUsername: "labuser" });
    const plan = computeSyncPlan({
      source,
      tree: makeTree([makeDevice()]),
      currentServers: [],
      now: 1000,
      authProfile: keyProfile
    });

    const created = plan.adds[0];
    expect(created.authProfileId).toBe("p1");
    expect(plan.warnings.some((w) => w.includes("auth profile"))).toBe(false);

    // The link still does its job end to end: key auth, pointed at the
    // profile's key. (`buildConnectConfig` would read that file, so the
    // resolution is where this stops — the point is that `keyPath` is present.)
    const resolved = await resolveThroughConnect(created, keyProfile);
    expect(resolved.authType).toBe("key");
    expect(resolved.keyPath).toBe("/keys/id_ed25519");
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

  it("(FIX 1 / ADDRESSLESS) an owned server whose device is present but has no usable endpoint is NOT pruned — it downgrades to an addressless placeholder instead (kills pruning a merely-stopped device)", () => {
    const source = makeSource({ prunePolicy: "delete" });
    const before = makeOwnedServer();
    // Same externalId as `before`'s origin, still present, but unmappable — this
    // must NOT read as "deleted at the source".
    const tree = makeTree([makeDevice({ endpoints: [{ kind: "redfish", host: "10.0.0.9" }] })]);
    const plan = computeSyncPlan({ source, tree, currentServers: [before], now: 1000 });
    expect(plan.prunes).toHaveLength(0);
    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.addressless).toBe(true);
    expect(plan.updates[0].after.host).toBe("");
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

/**
 * ADOPT-ON-ADD — re-adding a source that was removed with "Keep Servers" may
 * RE-LINK (adopt) the kept records instead of adding duplicates beside them.
 *
 * THE RULE THIS BLOCK EXISTS TO DEFEND: only a server carrying this provider's
 * "Keep Servers" marker (`formerlySynced`) is adoptable, and only while its
 * current address is still the device's. A hand-made server is never adopted,
 * however exactly its address matches — see the headline test (E-7). Address
 * alone was the rejected design: it would let a source take over records the
 * user created, which is the one thing this feature must never do.
 *
 * THE OTHER TRAP: an adopted server and a duplicate-added server look almost
 * identical field by field, so a fixture whose kept server already matches the
 * device's name/username/settings proves nothing. Every "adopted" assertion
 * below pins the server COUNT (`adds.length === 0`, `updates.length === 1`) and
 * the surviving ID (`kept-1`, explicitly NOT the deterministic add-path id),
 * and the canonical fixture is deliberately skewed away from anything the add
 * path could produce: a hand-chosen id, a stale name, an upper-case host, a
 * hand-picked username, password auth, hidden, proxied, in a hand-made folder.
 */
describe("computeSyncPlan — adopt-on-add", () => {
  /** What the ADD path would mint for makeDevice()'s externalId — the id an adoption must NOT produce. */
  const ADD_PATH_ID = deterministicServerId("source-1", "device:1");

  /**
   * REVIEW FINDING (P1, cross-instance adoption) — the NetBox deployment every
   * fixture in this block is about, and `INSTANCE_B` is a SECOND deployment of
   * the same provider. Every kept marker records `INSTANCE_A`, and `planFor`
   * below computes plans for a source pointed at `INSTANCE_A`, so the whole
   * block reads as "one instance, removed and re-added" — and any test that
   * wants the cross-instance case has to say so explicitly.
   */
  const INSTANCE_A = "https://netbox.example.com";
  const INSTANCE_B = "https://netbox-lab.example.com";

  /**
   * `computeSyncPlan` with this block's default provider instance supplied.
   *
   * A default rather than a per-call literal because the instance is a property
   * of the FIXTURE, not of any individual test: these tests are all about one
   * deployment's marker meeting one deployment's source, and spelling that out
   * 25 times would bury the one thing each test actually varies. Tests about the
   * instance rule itself pass `providerInstanceKey` explicitly, and an explicit
   * `undefined` still wins — it is spread over the default, not merged with it.
   */
  function planFor(input: Parameters<typeof computeSyncPlan>[0]) {
    return computeSyncPlan({ providerInstanceKey: INSTANCE_A, ...input });
  }

  /** The receipt "Keep Servers" leaves behind: this device, this provider, this INSTANCE of it, a source that no longer exists. */
  function keptMarker(overrides: Partial<ServerConfig["formerlySynced"] & object> = {}) {
    return {
      sourceId: "removed-source",
      sourceName: "NetBox (removed)",
      providerId: "netbox",
      instanceKey: INSTANCE_A,
      externalId: "device:1",
      detachedAt: 900,
      ...overrides
    };
  }

  function makeKeptServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
    return makeManualServer({
      id: "kept-1",
      name: "old-name",
      host: "LAB-SW-01",
      port: 22,
      username: "handpicked",
      authType: "password",
      isHidden: true,
      proxy: { type: "socks5", host: "127.0.0.1", port: 1080 },
      group: "Hand/Made",
      formerlySynced: keptMarker(),
      ...overrides
    });
  }

  /** The device the marker names, at the kept server's address in the OTHER case, port omitted (must default to 22). */
  function keptDevice(overrides: Partial<InventoryDevice> = {}): InventoryDevice {
    return makeDevice({ endpoints: [{ kind: "ssh", host: "lab-sw-01" }], ...overrides });
  }

  const profile: AuthProfile = { id: "p1", name: "Lab credentials", username: "labuser", authType: "password" };

  /**
   * M27/M29 (review) — THE ADOPTEE TWIN of the update path's protocol matrix.
   * The update path had four discriminating tests and the adoption path none,
   * so both `takesProtocol` forced true and the dropped `syncedProtocol`
   * receipt restore survived the full suite.
   *
   * The substitution that makes it the same decision on a record this sync did
   * not create: `DetachedServerOrigin.syncedProtocol` stands in for the origin
   * stamp. Fixtures are built so the WRONG behaviour visibly changes the
   * outcome, per CLAUDE.md's convention.
   */
  describe("adoption — the protocol write rule and its receipt", () => {
    const telnetDevice = () => keptDevice({ endpoints: [{ kind: "telnet", host: "lab-sw-01" }] });

    // ⊘ M27 — `takesProtocol` forced TRUE. The removed source's sync had
    // written telnet; the user then switched the kept server back to SSH by
    // hand. The device STILL reports telnet only, so an adoption that always
    // takes the device's protocol flips it back — visibly, and against a choice
    // the marker itself proves was the user's.
    it("does NOT stomp a protocol the user changed by hand before the adoption", () => {
      const source = makeSource();
      const kept = makeKeptServer({
        host: "lab-sw-01",
        port: 23,
        protocol: undefined,
        formerlySynced: keptMarker({ syncedProtocol: "telnet" })
      });
      const plan = planFor({ source, tree: makeTree([telnetDevice()]), currentServers: [kept], now: 5000, adoptionChoice: "adopt" });

      expect(plan.updates).toHaveLength(1);
      const after = plan.updates[0].after;
      expect(after.protocol).toBeUndefined();
      // ⊘ M29 — the receipt is RESTORED into the new origin, not dropped.
      // Dropped, the next ordinary sync reads the record as "sync wrote ssh"
      // (an absent stamp resolves to ssh), sees the device saying telnet, and
      // row 3 flips it — the hand edit survives adoption and dies one sync later.
      expect(after.origin?.syncedProtocol).toBe("telnet");
    });

    // The mirror of the test above, and the reason that one is not vacuous: on
    // the SAME device, an adoptee whose protocol still equals what the removed
    // source wrote DOES follow the device. Adoption eligibility corroborates
    // host AND port, so the fixture keeps port 23 fixed and moves only the
    // protocol — which is exactly what isolates the write rule.
    it("DOES take the device's protocol when the kept record still carries what the removed source wrote", () => {
      const source = makeSource();
      const kept = makeKeptServer({
        host: "lab-sw-01",
        port: 23,
        protocol: undefined,
        formerlySynced: keptMarker({ syncedProtocol: undefined })
      });
      const plan = planFor({ source, tree: makeTree([telnetDevice()]), currentServers: [kept], now: 5000, adoptionChoice: "adopt" });

      expect(plan.updates).toHaveLength(1);
      const after = plan.updates[0].after;
      expect(after.protocol).toBe("telnet");
      expect(after.origin?.syncedProtocol).toBe("telnet");
    });

    it("stamps an adoptee whose protocol already agrees with the device", () => {
      const source = makeSource();
      const kept = makeKeptServer({
        host: "lab-sw-01",
        port: 23,
        protocol: "telnet",
        formerlySynced: keptMarker({ syncedProtocol: undefined })
      });
      const plan = planFor({ source, tree: makeTree([telnetDevice()]), currentServers: [kept], now: 5000, adoptionChoice: "adopt" });

      const after = plan.updates[0].after;
      expect(after.protocol).toBe("telnet");
      expect(after.origin?.syncedProtocol).toBe("telnet");
    });

    it("leaves a hand-set telnet protocol alone when the device offers SSH", () => {
      const source = makeSource();
      const kept = makeKeptServer({
        protocol: "telnet",
        formerlySynced: keptMarker({ syncedProtocol: undefined })
      });
      const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [kept], now: 5000, adoptionChoice: "adopt" });

      const after = plan.updates[0].after;
      expect(after.protocol).toBe("telnet");
      // Not laundered into the stamp: the very next sync must still read this
      // as the user's value, not as "what the sync wrote".
      expect(after.origin?.syncedProtocol).toBeUndefined();
    });

    it("adopts an ordinary SSH kept server without inventing a protocol (control)", () => {
      const source = makeSource();
      const plan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [makeKeptServer()],
        now: 5000,
        adoptionChoice: "adopt"
      });

      const after = plan.updates[0].after;
      expect(after.protocol).toBeUndefined();
      expect(after.origin?.syncedProtocol).toBeUndefined();
    });
  });

  it("(E-7) HEADLINE — a hand-made server at the device's exact address is NEVER adopted: no marker, no adoption (kills matching on address, the rejected design)", () => {
    const source = makeSource();
    // Identical to the canonical fixture in every respect EXCEPT the marker.
    const handMade = makeKeptServer({ formerlySynced: undefined });
    const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [handMade], now: 5000, adoptionChoice: "adopt" });

    expect(plan.updates).toHaveLength(0);
    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].id).toBe(ADD_PATH_ID);
    // The user's record is untouched and the collision is disclosed exactly as
    // it is today — no new copy, no new behavior, flag or no flag.
    expect(plan.manualDuplicateCount).toBe(1);
    expect(plan.warnings).toContain('Device "core-sw-1" matches existing server "old-name" (lab-sw-01:22) — will be added as a duplicate.');
    // And no question is ever raised about it.
    expect(plan.adoptionCandidates).toHaveLength(0);
  });

  it("(E-1) flag on: the kept server is UPDATED in place — same id, credentials byte-for-byte, name/host/port/folder from the device, marker cleared (kills the duplicate add, the minted id, and the rebuilt-from-the-add-path record)", () => {
    const source = makeSource();
    const kept = makeKeptServer();
    const plan = planFor({
      source,
      tree: makeTree([keptDevice({ folderPath: "Syd/R1" })]),
      currentServers: [kept],
      now: 5000,
      adoptionChoice: "adopt"
    });

    // The count+id pair IS the test. A duplicate-add implementation leaves the
    // kept server untouched and adds a second one: every "looks adopted" field
    // check below would then pass on the WRONG record.
    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].before.id).toBe("kept-1");
    expect(plan.updates[0].after.id).toBe("kept-1");
    expect(plan.updates[0].after.id).not.toBe(ADD_PATH_ID);

    const after = plan.updates[0].after;
    // Gains: ownership by this source, and the deployment it read the device
    // from (REVIEW FINDING, P1 — `syncedInstanceKey` is what a later detach
    // copies into the marker instead of re-deriving one from a mutable config).
    // The other two stamps record only what THIS sync wrote — it wrote no
    // username (the endpoint supplies none) and no profile link.
    expect(after.origin).toEqual({
      sourceId: "source-1",
      externalId: "device:1",
      syncedAt: 5000,
      syncedInstanceKey: INSTANCE_A,
      syncedUsername: undefined,
      syncedAuthProfileId: undefined
    });
    expect(after.origin?.syncedUsername).toBeUndefined();
    expect(after.origin?.syncedAuthProfileId).toBeUndefined();
    // Loses: the marker. A now-owned server must not go on advertising itself
    // for adoption — and the spread would carry it if nothing cleared it.
    expect(after.formerlySynced).toBeUndefined();
    // Keeps: everything the field-ownership rule refuses to touch.
    expect(after.username).toBe("handpicked");
    expect(after.authType).toBe("password");
    expect(after.proxy).toEqual({ type: "socks5", host: "127.0.0.1", port: 1080 });
    expect(after.isHidden).toBe(true);
    // Takes from the device: name, address, folder.
    expect(after.name).toBe("core-sw-1");
    expect(after.host).toBe("lab-sw-01");
    expect(after.port).toBe(22);
    expect(after.group).toBe("NetBox/Syd/R1");
    expect(plan.folders).toContain("NetBox/Syd/R1");
    // An adoption is never a duplicate and never "unchanged".
    expect(plan.manualDuplicateCount).toBe(0);
    expect(plan.unchangedCount).toBe(0);
    expect(plan.warnings.some((w) => w.includes("duplicate"))).toBe(false);
    expect(plan.adoptionCandidates.map((c) => c.deviceName)).toEqual(["core-sw-1"]);
  });

  it("(E-1c) REVIEW FINDING (P1) — a candidate names BOTH halves of the pairing it offers, each device against ITS OWN adoptee (kills a candidate list of device names alone, which cannot tell one candidate set from another that shares its names, and kills pairing by position in the server list)", () => {
    // Two devices, two adoptees, and the servers deliberately in the OPPOSITE
    // order to the tree: a pairing derived from position rather than from the
    // marker it actually resolved would come out crossed, and every count in
    // the plan would still be right.
    const source = makeSource();
    const secondDevice = makeDevice({ externalId: "device:2", name: "dist-rtr-1", endpoints: [{ kind: "ssh", host: "lab-rtr-01" }] });
    const secondKept = makeKeptServer({ id: "kept-2", name: "spare-rtr", host: "LAB-RTR-01", formerlySynced: keptMarker({ externalId: "device:2" }) });

    // Computed with NO answer, which is the state the caller asks its question
    // from — the pairing has to be knowable before anything is adopted, because
    // that is the moment the consent is collected.
    const plan = planFor({
      source,
      tree: makeTree([keptDevice(), secondDevice]),
      currentServers: [secondKept, makeKeptServer()],
      now: 5000
    });

    expect(plan.adoptionCandidates).toEqual([
      // `separateAddBlocked: false` on both — these kept servers carry
      // hand-chosen ids, so nothing holds the id an add would mint and declining
      // really does add them beside the originals.
      { deviceName: "core-sw-1", externalId: "device:1", serverId: "kept-1", separateAddBlocked: false },
      { deviceName: "dist-rtr-1", externalId: "device:2", serverId: "kept-2", separateAddBlocked: false }
    ]);

    // And an "adopt" run turns each candidate into the update its own pair
    // describes — the property the caller's two guards rely on to compare the
    // same pairing at two different moments without disagreeing.
    const adopted = planFor({
      source,
      tree: makeTree([keptDevice(), secondDevice]),
      currentServers: [secondKept, makeKeptServer()],
      now: 5000,
      adoptionChoice: "adopt"
    });
    expect(adopted.adoptionCandidates).toEqual(plan.adoptionCandidates);
    expect(adopted.updates.map((u) => [u.before.id, u.after.origin?.externalId])).toEqual([
      ["kept-1", "device:1"],
      ["kept-2", "device:2"]
    ]);
  });

  it("(E-1b) a kept server ALREADY identical to the device in every source-owned field is still an update — gaining `origin` is the change (kills mirroring the owned path's AUTH 3 `changed` comparison, which would compute the adoption and discard it as 'unchanged')", () => {
    // The one fixture where "adopted" and "did nothing" look the same on every
    // field the update path compares. Only ownership moves, and if that is
    // dropped the plan reports a no-op while the duplicate the user was trying
    // to avoid is neither added nor resolved.
    const source = makeSource();
    const kept = makeKeptServer({ name: "core-sw-1", host: "lab-sw-01", port: 22, group: "NetBox" });
    const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [kept], now: 5000, adoptionChoice: "adopt" });

    expect(plan.unchangedCount).toBe(0);
    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.id).toBe("kept-1");
    expect(plan.updates[0].after.origin?.sourceId).toBe("source-1");
  });

  it("(E-2) no answer supplied: today's PLAN bit-for-bit — a duplicate add with the verbatim warning — yet the candidate list is still populated (kills a default-adopt answer, and a candidate list computed only for an adopting run)", () => {
    const source = makeSource();
    const kept = makeKeptServer();
    const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [kept], now: 5000 });

    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].id).toBe(ADD_PATH_ID);
    expect(plan.updates).toHaveLength(0);
    expect(plan.manualDuplicateCount).toBe(1);
    expect(plan.warnings).toContain('Device "core-sw-1" matches existing server "old-name" (lab-sw-01:22) — will be added as a duplicate.');
    // A CANDIDATE is never explained away: the two refusal warnings are about
    // matches adoption could not take, and this one it can.
    expect(plan.warnings.some((w) => w.includes("previously synced onto"))).toBe(false);
    expect(plan.warnings.some((w) => w.includes("cannot tell which to adopt"))).toBe(false);
    // The caller decides whether to ASK from this list, so it must be computed
    // whichever way the plan was computed — otherwise the question could never
    // be raised on an unanswered plan, which is the only kind the caller has
    // when it needs to decide.
    expect(plan.adoptionCandidates).toHaveLength(1);
  });

  it("(E-2b) NO ANSWER — the question was never asked: both refusals still explain themselves (kills gating this copy on the adopt answer, which is the pre-fix silence: neither shape is a CANDIDATE, so the caller never raises the question for it and the adopt answer can never be given — a re-addressed or double-marked device produced a duplicate with nothing anywhere saying why)", () => {
    const source = makeSource();

    // Same fixture as E-3's refusal, with no answer supplied: the device moved
    // while detached, which is the case this whole feature was written for.
    const moved = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [makeKeptServer({ host: "10.9.9.9" })], now: 1000 });
    expect(moved.warnings).toContain(
      'Device "core-sw-1" was previously synced onto server "old-name", but that server is now at 10.9.9.9:22 and the device is at lab-sw-01:22 — it will be added as a new server instead.'
    );
    // And it is the ONLY thing said about that device — the address no longer
    // collides, so today's duplicate warning still correctly stays away.
    expect(moved.warnings.filter((w) => w.includes("core-sw-1"))).toHaveLength(1);
    expect(moved.adds).toHaveLength(1);

    // Same fixture as E-6. Two markers naming one device at one address is
    // reachable through this feature's OWN happy path (Keep Servers → re-add →
    // Add Separately → apply → remove with Keep Servers again), and it is never
    // a candidate either, so this run cannot have been asked anything.
    const ambiguous = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [makeKeptServer({ id: "kept-a", name: "copy-a" }), makeKeptServer({ id: "kept-b", name: "copy-b" })],
      now: 1000
    });
    expect(ambiguous.adoptionCandidates).toHaveLength(0);
    expect(ambiguous.warnings.filter((w) => w.includes("core-sw-1"))).toEqual([
      'Device "core-sw-1" matches 2 servers kept from a removed inventory source at lab-sw-01:22 — Nexus cannot tell which to adopt, so it will be added as a duplicate. Cancel, remove the extra copies, then sync again to adopt.',
      // Today's duplicate warning, unchanged, naming the server the
      // single-valued address index names.
      'Device "core-sw-1" matches existing server "copy-b" (lab-sw-01:22) — will be added as a duplicate.'
    ]);
    expect(ambiguous.manualDuplicateCount).toBe(1);
  });

  it("(E-2c) DECLINED — the answer covers the devices the question NAMED and nothing else: the clean candidate is duplicated in silence while the moved and the ambiguous matches beside it still explain themselves (kills suppressing the refusals per-PLAN on `decline`, which answers a question about one device by going quiet about two others the user was never told existed)", () => {
    // THE SHAPE THE FINDING IS ABOUT, and the reason a per-plan flag can never
    // be right: ONE run carrying a clean candidate (device:1 — this is what
    // raises the question at all, so `"decline"` is only reachable here) beside
    // two devices the question never counted or named. A clean candidate takes
    // the adoption branch, so the branches below it are, by construction, about
    // devices the user was told nothing about.
    const source = makeSource();
    const movedDevice = makeDevice({ externalId: "device:2", name: "dist-rtr-1", endpoints: [{ kind: "ssh", host: "10.0.0.2" }] });
    const ambiguousDevice = makeDevice({ externalId: "device:3", name: "acc-sw-1", endpoints: [{ kind: "ssh", host: "10.0.0.3" }] });

    const plan = planFor({
      source,
      tree: makeTree([keptDevice(), movedDevice, ambiguousDevice]),
      currentServers: [
        // The candidate the question was about.
        makeKeptServer(),
        // Identity matches, address does not — re-IP'd while detached.
        makeKeptServer({ id: "kept-2", name: "moved-rtr", host: "10.9.9.9", formerlySynced: keptMarker({ externalId: "device:2" }) }),
        // Two markers naming one device at one address: Nexus refuses to guess.
        makeKeptServer({ id: "kept-3a", name: "copy-a", host: "10.0.0.3", formerlySynced: keptMarker({ externalId: "device:3" }) }),
        makeKeptServer({ id: "kept-3b", name: "copy-b", host: "10.0.0.3", formerlySynced: keptMarker({ externalId: "device:3" }) })
      ],
      now: 1000,
      adoptionChoice: "decline"
    });

    // The question named exactly one device, and it is the only one the answer
    // speaks for: it is duplicated with no adoption commentary of its own.
    expect(plan.adoptionCandidates.map((c) => c.deviceName)).toEqual(["core-sw-1"]);
    expect(plan.warnings.filter((w) => w.includes("core-sw-1"))).toEqual([
      'Device "core-sw-1" matches existing server "old-name" (lab-sw-01:22) — will be added as a duplicate.'
    ]);

    // THE TWO ASSERTIONS THE FINDING TURNS ON. Pre-fix both of these were absent
    // and both devices were added as duplicates with nothing anywhere saying
    // why — the same silence the never-asked case was fixed for, reached by
    // answering a question about a different device.
    expect(plan.warnings).toContain(
      'Device "dist-rtr-1" was previously synced onto server "moved-rtr", but that server is now at 10.9.9.9:22 and the device is at 10.0.0.2:22 — it will be added as a new server instead.'
    );
    expect(plan.warnings).toContain(
      'Device "acc-sw-1" matches 2 servers kept from a removed inventory source at 10.0.0.3:22 — Nexus cannot tell which to adopt, so it will be added as a duplicate. Cancel, remove the extra copies, then sync again to adopt.'
    );

    // Declining changes what is SAID about the candidate, never what is planned:
    // all three devices are added, no record changes ownership.
    expect(plan.adds).toHaveLength(3);
    expect(plan.updates).toHaveLength(0);
    // Two of the three collide by address (the candidate's own record, and the
    // ambiguous pair's); the re-addressed one does not, which is exactly why its
    // refusal sentence is the only thing that can explain its duplicate.
    expect(plan.manualDuplicateCount).toBe(2);
  });

  it("(E-2d) DECLINED and NEVER ASKED produce byte-identical warnings for the non-candidates (kills a partial suppression that merely narrows the per-plan flag: the two states differ to the CALLER, never to a device the question could not have been about)", () => {
    const source = makeSource();
    const movedDevice = makeDevice({ externalId: "device:2", name: "dist-rtr-1", endpoints: [{ kind: "ssh", host: "10.0.0.2" }] });
    const currentServers = [
      makeKeptServer(),
      makeKeptServer({ id: "kept-2", name: "moved-rtr", host: "10.9.9.9", formerlySynced: keptMarker({ externalId: "device:2" }) })
    ];
    const args = { source, tree: makeTree([keptDevice(), movedDevice]), currentServers, now: 1000 };

    const declined = planFor({ ...args, adoptionChoice: "decline" });
    const neverAsked = planFor(args);

    expect(declined.warnings).toEqual(neverAsked.warnings);
    expect(declined.warnings.some((w) => w.includes("dist-rtr-1"))).toBe(true);
  });

  it("(E-3) corroboration: the address must still match, host case-insensitively — a re-addressed kept server is not adopted, and the refusal says why (kills dropping the address check, and a one-sided lowercase)", () => {
    const source = makeSource();

    // Device host upper, kept server host lower — the mirror of E-1's fixture.
    const lowerServer = makeKeptServer({ host: "lab-sw-01" });
    const upperDevice = makeDevice({ endpoints: [{ kind: "ssh", host: "LAB-SW-01" }] });
    const matched = planFor({ source, tree: makeTree([upperDevice]), currentServers: [lowerServer], now: 1000, adoptionChoice: "adopt" });
    expect(matched.adds).toHaveLength(0);
    expect(matched.updates).toHaveLength(1);
    expect(matched.updates[0].before.id).toBe("kept-1");

    // Same marker, same device — but the server has moved. Identity is not
    // enough: this is the clause that stops one provider instance's "device:1"
    // from claiming another instance's kept server.
    const moved = makeKeptServer({ host: "10.9.9.9" });
    const refused = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [moved], now: 1000, adoptionChoice: "adopt" });
    expect(refused.updates).toHaveLength(0);
    expect(refused.adds).toHaveLength(1);
    expect(refused.adoptionCandidates).toHaveLength(0);
    expect(refused.warnings).toContain(
      'Device "core-sw-1" was previously synced onto server "old-name", but that server is now at 10.9.9.9:22 and the device is at lab-sw-01:22 — it will be added as a new server instead.'
    );
    // The address no longer collides, so today's duplicate warning correctly stays away.
    expect(refused.manualDuplicateCount).toBe(0);
  });

  it("(E-3b) the device's port participates in corroboration, and a multi-server mismatch is reported without naming one of them (kills a port-blind address check)", () => {
    const source = makeSource();

    // The device's omitted port defaults to 22 and must not match a kept server on 2222.
    const otherPort = makeKeptServer({ port: 2222 });
    const refused = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [otherPort], now: 1000, adoptionChoice: "adopt" });
    expect(refused.updates).toHaveLength(0);
    expect(refused.adds).toHaveLength(1);
    expect(refused.adoptionCandidates).toHaveLength(0);

    const twoMoved = [makeKeptServer({ id: "kept-a", name: "copy-a", host: "10.9.9.9" }), makeKeptServer({ id: "kept-b", name: "copy-b", host: "10.9.9.8" })];
    const plural = planFor({ source, tree: makeTree([keptDevice()]), currentServers: twoMoved, now: 1000, adoptionChoice: "adopt" });
    expect(plural.updates).toHaveLength(0);
    expect(plural.warnings).toContain(
      'Device "core-sw-1" was previously synced onto 2 servers in your list, none of which is still at lab-sw-01:22 — it will be added as a new server instead.'
    );
  });

  it("(E-8) a marker from a DIFFERENT provider is never claimed (kills matching on externalId alone across provider kinds)", () => {
    const source = makeSource({ providerId: "netbox" });
    const kept = makeKeptServer({ formerlySynced: keptMarker({ providerId: "some-other-provider" }) });
    const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [kept], now: 5000, adoptionChoice: "adopt" });

    expect(plan.updates).toHaveLength(0);
    expect(plan.adds).toHaveLength(1);
    expect(plan.adoptionCandidates).toHaveLength(0);
    // Not even the mismatch note — this marker is not this source's business at all.
    expect(plan.warnings.some((w) => w.includes("previously synced onto"))).toBe(false);
  });

  it("(E-15) HEADLINE for the cross-instance finding — two deployments of ONE provider, same device id, same address: instance B's device does NOT adopt instance A's kept server, and the refusal names both instances (kills the providerId-only identity check, which adopts here because every other clause is satisfied)", () => {
    // The reported scenario, minus nothing: a lab NetBox beside a production
    // one. Both call their first device "device:1" (NetBox numbers from 1), both
    // sit on the same RFC1918 address (10.0.0.1:22 is the most ordinary endpoint
    // there is), and the kept server was left behind by the OTHER instance.
    // Under the old `providerId`-only rule the marker matched, the address
    // corroborated, and this record — with its saved password, passphrase and
    // proxy credentials, which follow the surviving id — changed owner silently.
    const source = makeSource({ providerId: "netbox" });
    const keptFromA = makeKeptServer({ host: "10.0.0.1", formerlySynced: keptMarker({ instanceKey: INSTANCE_A }) });
    const deviceAtB = makeDevice({ endpoints: [{ kind: "ssh", host: "10.0.0.1" }] });

    const plan = planFor({
      source,
      tree: makeTree([deviceAtB]),
      currentServers: [keptFromA],
      now: 5000,
      // The source doing the syncing is the OTHER deployment.
      providerInstanceKey: INSTANCE_B,
      adoptionChoice: "adopt"
    });

    // Nothing changes hands: the user's kept record is untouched and the device
    // arrives as a new server under the add path's own id.
    expect(plan.updates).toHaveLength(0);
    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].id).toBe(ADD_PATH_ID);
    expect(plan.adoptionCandidates).toHaveLength(0);
    // And it is never even OFFERED — an adoption the user could approve is as
    // much a transfer as one that happens by itself, because the question does
    // not say which instance the record came from.
    expect(plan.adoptionCandidates.map((c) => c.deviceName)).toEqual([]);

    // The refusal explains itself, naming BOTH deployments — the one diagnostic
    // that separates "these really are two systems" from "I typed the URL
    // differently this time", which is the only way a user could tell the
    // legitimate re-add case apart from this one.
    expect(plan.warnings).toContain(
      `1 device matches a server kept from a removed inventory source of this provider, but that server was synced from "${INSTANCE_A}" rather than this source's "${INSTANCE_B}" — it will be added as a new server instead (e.g. "core-sw-1").`
    );
    // The address collision is still reported exactly as it is for any other
    // duplicate — the instance line explains, it does not replace.
    expect(plan.manualDuplicateCount).toBe(1);
  });

  it("(E-15b) the SAME deployment re-added under a brand-new source id still adopts — the instance key is what survives the id change, which is the whole point of the feature (kills matching on sourceId, and kills an instance check so strict it defeats the re-add it exists to allow)", () => {
    // The marker names a source id that no longer exists ("removed-source"); the
    // adopting source is "source-1". Nothing about the two records connects them
    // except the provider, the device id, the address — and the deployment.
    const source = makeSource({ id: "source-1", providerId: "netbox" });
    const kept = makeKeptServer();
    expect(kept.formerlySynced?.sourceId).not.toBe(source.id);

    const adopted = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [kept],
      now: 5000,
      providerInstanceKey: INSTANCE_A,
      adoptionChoice: "adopt"
    });
    expect(adopted.adds).toHaveLength(0);
    expect(adopted.updates).toHaveLength(1);
    expect(adopted.updates[0].after.id).toBe("kept-1");
    expect(adopted.adoptionCandidates.map((c) => c.deviceName)).toEqual(["core-sw-1"]);

    // The contrast that makes the assertion above mean something: change ONE
    // character of the instance and the identical fixture stops adopting.
    const refused = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [kept],
      now: 5000,
      providerInstanceKey: INSTANCE_B,
      adoptionChoice: "adopt"
    });
    expect(refused.updates).toHaveLength(0);
    expect(refused.adds).toHaveLength(1);
  });

  it("(E-15c) a marker with NO instance key is never adoptable — including when this source has none either, where a bare `===` would call two absences a match (kills `kept.instanceKey === providerInstanceKey` without the presence checks, the one-line version of this rule that reads `undefined === undefined` as identity)", () => {
    const source = makeSource({ providerId: "netbox" });
    // Written by a build of this branch from before the field existed, or by a
    // provider that names no instance. Every OTHER clause is satisfied: right
    // provider, right device, right address.
    const kept = makeKeptServer({ formerlySynced: keptMarker({ instanceKey: undefined }) });

    const againstKnownInstance = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [kept],
      now: 5000,
      providerInstanceKey: INSTANCE_A,
      adoptionChoice: "adopt"
    });
    expect(againstKnownInstance.updates).toHaveLength(0);
    expect(againstKnownInstance.adds).toHaveLength(1);
    expect(againstKnownInstance.adoptionCandidates).toHaveLength(0);

    // THE KILLER CASE. Both sides absent: a naive equality check matches here
    // and adopts, which is the pre-fix defect reached through a missing field
    // instead of a coarse one — any two providers with no instance identity
    // would pool their kept servers.
    const bothAbsent = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [kept],
      now: 5000,
      providerInstanceKey: undefined,
      adoptionChoice: "adopt"
    });
    expect(bothAbsent.updates).toHaveLength(0);
    expect(bothAbsent.adds).toHaveLength(1);
    expect(bothAbsent.adoptionCandidates).toHaveLength(0);
  });

  it("(E-15d) a provider that reports no instance identity gets NO adoption, and the plan says so in the provider's terms rather than the user's (kills falling back to the provider-kind check when instanceKey is unavailable — the decision this feature makes for third-party providers)", () => {
    const source = makeSource({ providerId: "some-third-party" });
    // A fully-formed marker from a source of this provider, at the device's
    // address. Only the source's own instance identity is missing.
    const kept = makeKeptServer({
      formerlySynced: keptMarker({ providerId: "some-third-party", instanceKey: "recorded-when-it-still-had-one" })
    });

    const plan = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [kept],
      now: 5000,
      providerInstanceKey: undefined,
      adoptionChoice: "adopt"
    });

    expect(plan.updates).toHaveLength(0);
    expect(plan.adds).toHaveLength(1);
    expect(plan.adoptionCandidates).toHaveLength(0);
    // Different copy from the mismatch case, because it has a different repair:
    // this one is the provider author's to fix, not the user's, and claiming
    // "a different instance" would assert something Nexus cannot know.
    expect(plan.warnings).toContain(
      '1 device matches a server kept from a removed inventory source, but the "some-third-party" provider does not report which instance a device came from, so Nexus cannot tell whether that server belongs to this source — it will be added as a new server instead (e.g. "core-sw-1").'
    );
    expect(plan.warnings.some((w) => w.includes("rather than this source's"))).toBe(false);
  });

  it("(E-15e) the instance refusal is ONE aggregate line naming up to 3 devices and the distinct instances involved — not one line per device (kills a per-device warning, which in this rule's own scenario buries the plan under one sentence per device, since a second deployment re-uses every id)", () => {
    const source = makeSource({ providerId: "netbox" });
    // Five devices, five kept records from instance A, all at the addresses
    // instance B reports — i.e. the finding's scenario at fleet scale.
    const devices = [1, 2, 3, 4, 5].map((n) =>
      makeDevice({ externalId: `device:${n}`, name: `sw-${n}`, endpoints: [{ kind: "ssh", host: `10.0.0.${n}` }] })
    );
    const kept = [1, 2, 3, 4, 5].map((n) =>
      makeKeptServer({
        id: `kept-${n}`,
        name: `old-${n}`,
        host: `10.0.0.${n}`,
        formerlySynced: keptMarker({ externalId: `device:${n}`, instanceKey: n === 5 ? "https://third.example.com" : INSTANCE_A })
      })
    );

    const plan = planFor({
      source,
      tree: makeTree(devices),
      currentServers: kept,
      now: 5000,
      providerInstanceKey: INSTANCE_B
    });

    const instanceWarnings = plan.warnings.filter((w) => w.includes("rather than this source's"));
    expect(instanceWarnings).toHaveLength(1);
    expect(instanceWarnings[0]).toBe(
      `5 devices match servers kept from a removed inventory source of this provider, but those servers were synced from "${INSTANCE_A}", "https://third.example.com" rather than this source's "${INSTANCE_B}" — they will be added as new servers instead (e.g. "sw-1", "sw-2", "sw-3").`
    );
    expect(plan.adds).toHaveLength(5);
    expect(plan.updates).toHaveLength(0);
  });

  it("(E-15f) an unrecorded instance is described as unrecorded, never as an empty pair of quotes (kills rendering a missing instanceKey through the same slot as a recorded one)", () => {
    const source = makeSource({ providerId: "netbox" });
    const kept = makeKeptServer({ formerlySynced: keptMarker({ instanceKey: undefined }) });
    const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [kept], now: 5000, providerInstanceKey: INSTANCE_B });

    expect(plan.warnings).toContain(
      `1 device matches a server kept from a removed inventory source of this provider, but that server was synced from an unrecorded instance rather than this source's "${INSTANCE_B}" — it will be added as a new server instead (e.g. "core-sw-1").`
    );
  });

  it("(E-15g) a kept record from another instance at an UNRELATED address says nothing, and a device with an eligible marker says nothing about a foreign one beside it (kills reporting every stale marker that merely shares a device id, which is noise about a non-event)", () => {
    const source = makeSource({ providerId: "netbox" });

    // Same device id, other instance, somewhere else entirely: adoption was
    // never going to touch this record, so there is nothing to explain.
    const elsewhere = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [makeKeptServer({ host: "10.9.9.9", formerlySynced: keptMarker({ instanceKey: INSTANCE_B }) })],
      now: 5000,
      providerInstanceKey: INSTANCE_A
    });
    expect(elsewhere.warnings.some((w) => w.includes("rather than this source's"))).toBe(false);
    expect(elsewhere.warnings.some((w) => w.includes("does not report which instance"))).toBe(false);

    // And a device that DID find its own instance's marker is decided by that;
    // a foreign marker sitting at the same address is not a second story about
    // the same device.
    const adopted = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [
        makeKeptServer({ id: "kept-a", name: "mine" }),
        makeKeptServer({ id: "kept-b", name: "theirs", formerlySynced: keptMarker({ instanceKey: INSTANCE_B }) })
      ],
      now: 5000,
      providerInstanceKey: INSTANCE_A,
      adoptionChoice: "adopt"
    });
    expect(adopted.updates).toHaveLength(1);
    expect(adopted.updates[0].after.id).toBe("kept-a");
    expect(adopted.warnings.some((w) => w.includes("rather than this source's"))).toBe(false);
  });

  it("(E-15h) DECLINED does NOT silence the instance refusals, exactly like the other two (kills suppressing them on the answer: a foreign-instance device is never a candidate, so the question the user answered could not have mentioned it)", () => {
    const source = makeSource({ providerId: "netbox" });
    // The run has to CONTAIN a candidate for `"decline"` to be reachable at all
    // — the caller only asks when the plan reports one — so device:1 is a clean
    // candidate and device:2's only marker is from the other deployment.
    const foreignDevice = makeDevice({ externalId: "device:2", name: "dist-rtr-1", endpoints: [{ kind: "ssh", host: "10.0.0.2" }] });
    const plan = planFor({
      source,
      tree: makeTree([keptDevice(), foreignDevice]),
      currentServers: [
        makeKeptServer(),
        makeKeptServer({
          id: "kept-2",
          name: "theirs",
          host: "10.0.0.2",
          formerlySynced: keptMarker({ externalId: "device:2", instanceKey: INSTANCE_B })
        })
      ],
      now: 5000,
      providerInstanceKey: INSTANCE_A,
      adoptionChoice: "decline"
    });

    expect(plan.adoptionCandidates.map((c) => c.deviceName)).toEqual(["core-sw-1"]);
    expect(plan.warnings).toContain(
      `1 device matches a server kept from a removed inventory source of this provider, but that server was synced from "${INSTANCE_B}" rather than this source's "${INSTANCE_A}" — it will be added as a new server instead (e.g. "dist-rtr-1").`
    );
    // Today's duplicate notice is unaffected — declining changes what is SAID
    // about the device it was asked about, never what the sync plans.
    expect(plan.warnings).toContain('Device "core-sw-1" matches existing server "old-name" (lab-sw-01:22) — will be added as a duplicate.');
    expect(plan.adds).toHaveLength(2);
  });

  it("(E-8b) a marker naming a DIFFERENT device is never claimed (kills falling back to address matching when the externalId does not match)", () => {
    const source = makeSource();
    const kept = makeKeptServer({ formerlySynced: keptMarker({ externalId: "device:999" }) });
    const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [kept], now: 5000, adoptionChoice: "adopt" });

    expect(plan.updates).toHaveLength(0);
    expect(plan.adds).toHaveLength(1);
    expect(plan.adoptionCandidates).toHaveLength(0);
    // It IS still an address collision, so today's duplicate warning fires.
    expect(plan.manualDuplicateCount).toBe(1);
  });

  it("(E-7b) a server carrying BOTH an origin and a marker is never adopted — an owned record is owned (kills eligibility that reads the marker without checking origin)", () => {
    const source = makeSource();
    const foreignWithMarker = makeKeptServer({
      id: "foreign-1",
      origin: { sourceId: "other-source", externalId: "device:1", syncedAt: 1 }
    });
    const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [foreignWithMarker], now: 5000, adoptionChoice: "adopt" });

    expect(plan.updates).toHaveLength(0);
    expect(plan.adds).toHaveLength(1);
    expect(plan.adoptionCandidates).toHaveLength(0);
  });

  it("(E-6) two kept servers naming the same device at its address: NEITHER is adopted, the device is added as a duplicate, and the warning names the count (kills adopt-the-first-in-array-order, and counting an ambiguous device as a candidate)", () => {
    const source = makeSource();
    const first = makeKeptServer({ id: "kept-a", name: "copy-a" });
    const second = makeKeptServer({ id: "kept-b", name: "copy-b" });
    const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [first, second], now: 5000, adoptionChoice: "adopt" });

    expect(plan.updates).toHaveLength(0);
    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].id).toBe(ADD_PATH_ID);
    expect(plan.manualDuplicateCount).toBe(1);
    // EXACT, not a substring: the sentence has to name the population by the
    // rule that actually selects it (a REMOVED inventory source of the same
    // PROVIDER — "a previous sync of this source" was wrong twice over, since
    // the marker index matches by provider and the source doing the adopting may
    // be ninety seconds old), and its repair has to be reachable from where the
    // reader stands — after Apply the device is owned and removing copies
    // achieves nothing.
    expect(plan.warnings).toContain(
      'Device "core-sw-1" matches 2 servers kept from a removed inventory source at lab-sw-01:22 — Nexus cannot tell which to adopt, so it will be added as a duplicate. Cancel, remove the extra copies, then sync again to adopt.'
    );
    // An all-ambiguous plan must not make the caller ask a question adoption
    // could not act on.
    expect(plan.adoptionCandidates).toHaveLength(0);
  });

  it("(E-9) two devices cannot share one kept server: the duplicate-externalId guard skips the second before it ever reaches the match (kills adopting one server twice)", () => {
    const source = makeSource();
    const kept = makeKeptServer();
    // Same externalId — the marker names exactly one device, so this is the ONLY
    // shape in which two devices could contend for one kept server.
    const tree = makeTree([keptDevice(), keptDevice({ name: "core-sw-2" })]);
    const plan = planFor({ source, tree, currentServers: [kept], now: 5000, adoptionChoice: "adopt" });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].before.id).toBe("kept-1");
    expect(plan.updates[0].after.origin?.externalId).toBe("device:1");
    expect(plan.adds).toHaveLength(0);
    expect(plan.adoptionCandidates.map((c) => c.deviceName)).toEqual(["core-sw-1"]);
    expect(plan.warnings.some((w) => w.includes("Duplicate device ID"))).toBe(true);
  });

  it("(E-4) the stamps record what THIS sync wrote, so a hand-picked username is not laundered into 'as stamped' — and the next sync still refuses to retro-apply (kills stamping before.username, and stamping source.defaultUsername)", () => {
    // Everything except the username clause is satisfied, so that clause is the
    // ONLY thing between this server and the source's profile — which is what
    // makes sync 2 a real probe.
    const source = makeSource({ authProfileId: "p1" });
    const kept = makeKeptServer({ username: "handpicked", authType: "agent", isHidden: false, proxy: undefined, keyPath: undefined });

    const first = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [kept],
      now: 5000,
      authProfile: profile,
      adoptionChoice: "adopt"
    });
    expect(first.updates).toHaveLength(1);
    const adopted = first.updates[0].after;
    expect(adopted.origin?.syncedUsername).toBeUndefined();
    expect(adopted.origin?.syncedAuthProfileId).toBeUndefined();
    expect(adopted.authProfileId).toBeUndefined();
    expect(adopted.username).toBe("handpicked");

    // Sync 2, against the record sync 1 would have written: the server is owned
    // now, so it takes the ordinary update path. `syncedUsername` is absent, so
    // the retro-apply comparison falls back to defaultUsername ("admin") and the
    // hand-picked username still reads as a hand-edit — nothing happens.
    const second = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [adopted],
      now: 6000,
      authProfile: profile
    });
    expect(second.updates).toHaveLength(0);
    expect(second.unchangedCount).toBe(1);
  });

  it("(E-5) same-plan retro-apply: a kept server in the add path's exact shape gains the source's profile AND the stamp that records it (kills blocking retro-apply on adoption, and linking without stamping — the opt-out hole)", () => {
    const source = makeSource({ authProfileId: "p1", defaultUsername: "admin" });
    const kept = makeKeptServer({ username: "admin", authType: "agent", isHidden: false, proxy: undefined });
    const plan = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [kept],
      now: 5000,
      authProfile: profile,
      adoptionChoice: "adopt"
    });

    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    const after = plan.updates[0].after;
    expect(after.id).toBe("kept-1");
    expect(after.origin?.sourceId).toBe("source-1");
    expect(after.authProfileId).toBe("p1");
    // The stamp is what makes a LATER hand-clear of this link visible as an
    // opt-out instead of reading as "never linked" and being reattached forever.
    expect(after.origin?.syncedAuthProfileId).toBe("p1");
    // Still no username written by this sync, so still no username stamp.
    expect(after.origin?.syncedUsername).toBeUndefined();
    expect(after.username).toBe("admin");
    expect(after.authType).toBe("agent");
  });

  it("(E-5b) a password-auth kept server gains the origin but NOT the profile link (kills 'adoption always links the source profile')", () => {
    const source = makeSource({ authProfileId: "p1" });
    const kept = makeKeptServer({ username: "admin" }); // authType "password" — the clause that must refuse
    const plan = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [kept],
      now: 5000,
      authProfile: profile,
      adoptionChoice: "adopt"
    });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.origin?.sourceId).toBe("source-1");
    expect(plan.updates[0].after.authProfileId).toBeUndefined();
    expect(plan.updates[0].after.origin?.syncedAuthProfileId).toBeUndefined();
    expect(plan.updates[0].after.authType).toBe("password");
  });

  it("(E-10) a hidden kept server is eligible and stays hidden — isHidden is tree visibility, not identity (kills excluding hidden servers, and un-hiding on adoption)", () => {
    const source = makeSource();
    const kept = makeKeptServer({ isHidden: true });
    const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [kept], now: 5000, adoptionChoice: "adopt" });

    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.id).toBe("kept-1");
    expect(plan.updates[0].after.isHidden).toBe(true);
  });

  it("(E-11) the id-collision guard still runs FIRST: a collided device is skipped even when its kept server is waiting (kills moving the match check ahead of the guard)", () => {
    const source = makeSource();
    // Unrelated server occupying the id this device would mint, at a DIFFERENT
    // address so it is not itself involved in the match.
    const collider = makeManualServer({ id: ADD_PATH_ID, name: "hand-imported", host: "10.9.9.9" });
    const kept = makeKeptServer();
    const plan = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [collider, kept],
      now: 5000,
      adoptionChoice: "adopt"
    });

    expect(plan.updates).toHaveLength(0);
    expect(plan.adds).toHaveLength(0);
    expect(plan.warnings.some((w) => w.includes("already used"))).toBe(true);
    // The candidate bookkeeping sits behind the guard too — a skipped device is
    // not a candidate.
    expect(plan.adoptionCandidates).toHaveLength(0);
  });

  it("(E-12) a keyless key profile (AUTH 1b) is not linked onto a kept server either — adoption reads the RESOLVED id, not the matched profile (kills linking an unusable profile through the new branch)", () => {
    const keyProfile: AuthProfile = { id: "p1", name: "Key profile", username: "admin", authType: "key" };
    const source = makeSource({ authProfileId: "p1" });
    // In the add path's exact shape, so ONLY the AUTH 1b degrade can stop the link.
    const kept = makeKeptServer({ username: "admin", authType: "agent", isHidden: false, proxy: undefined });
    const plan = planFor({
      source,
      tree: makeTree([keptDevice()]),
      currentServers: [kept],
      now: 5000,
      authProfile: keyProfile,
      adoptionChoice: "adopt"
    });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.id).toBe("kept-1");
    expect(plan.updates[0].after.origin?.sourceId).toBe("source-1");
    expect(plan.updates[0].after.authProfileId).toBeUndefined();
    expect(plan.updates[0].after.origin?.syncedAuthProfileId).toBeUndefined();
    expect(plan.warnings.some((w) => w.includes("uses private key authentication but has no key file"))).toBe(true);
  });

  it("(E-13) planToApplication carries an adoption as an ordinary upsert under the SURVIVING id, and removes nothing (kills any 'adoptions need their own application channel' regression)", () => {
    const source = makeSource();
    const kept = makeKeptServer();
    const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [kept], now: 5000, adoptionChoice: "adopt" });
    const application = planToApplication(plan, source);

    expect(application.upsertServers.map((s) => s.id)).toEqual(["kept-1"]);
    expect(application.upsertServers[0].origin?.sourceId).toBe("source-1");
    expect(application.upsertServers[0].formerlySynced).toBeUndefined();
    expect(application.upsertServers[0].username).toBe("handpicked");
    expect(application.removeServerIds).toEqual([]);
  });

  it("(E-14) a kept server whose device is absent from the fetch is NOT pruned — it is nobody's to prune until it is adopted (kills treating markers as ownership)", () => {
    const source = makeSource({ prunePolicy: "delete" });
    const kept = makeKeptServer();
    const plan = planFor({ source, tree: makeTree([]), currentServers: [kept], now: 5000, adoptionChoice: "adopt" });

    expect(plan.prunes).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.adoptionCandidates).toHaveLength(0);
  });

  /**
   * REVIEW FINDING (P1, adoption auth provenance).
   *
   * THE CHAIN, and why the test has to follow all of it. A source with an auth
   * profile syncs a server; the sync stamps both the link (`authProfileId`) and
   * its own receipt for it (`origin.syncedAuthProfileId`). Remove Source → Keep
   * Servers strips the origin — receipt included — but the LINK stays on the
   * record, because it is a credential the sync did not choose to remove. So the
   * kept server carries a profile with nothing left to say who put it there.
   *
   * Adoption then re-stamped an origin whose `syncedAuthProfileId` was
   * unconditionally `undefined` — retro-apply cannot fill it in, since it does
   * not run while `authProfileId` is set — and that record is a lie in the one
   * direction that matters: it reads as "the USER linked this". AUTH 2b unlinks
   * only links it can prove the sync made, so if that profile later lost its key
   * file the adopted server was overridden into key auth with no key anywhere,
   * could not connect at all, and NO SYNC COULD REPAIR IT. The same missing
   * receipt meant clearing the link by hand did not read as an opt-out either, so
   * the next sync reattached it.
   *
   * NON-VACUITY. Asserting only that adoption copies the stamp would pass against
   * a fix that wrote the value somewhere nothing reads. The second plan below is
   * the test: it takes the record the FIRST plan produced, breaks the profile
   * exactly as the reported scenario does, and asserts the rescue actually fires.
   * The control at the end pins that the rescue is the stamp's doing.
   */
  describe("(E-17) a sync-applied auth profile survives the detach and reaches AUTH 2b through the adoption", () => {
    const healthyKeyProfile: AuthProfile = { id: "p1", name: "Lab key", username: "labuser", authType: "key", keyPath: "/keys/id_ed25519" };
    /** The SAME profile after its key file is removed — the state AUTH 2b exists for. */
    const brokenKeyProfile: AuthProfile = { id: "p1", name: "Lab key", username: "labuser", authType: "key" };

    /** A kept server as "Keep Servers" leaves one whose former source had applied `p1`. */
    function keptWithSourceAppliedProfile(overrides: Partial<ServerConfig> = {}): ServerConfig {
      return makeKeptServer({
        username: "labuser",
        authType: "agent",
        keyPath: undefined,
        proxy: undefined,
        isHidden: false,
        // The link the removed source's sync applied, still on the record.
        authProfileId: "p1",
        // ...and its receipt, preserved across the strip.
        formerlySynced: keptMarker({ syncedAuthProfileId: "p1" }),
        ...overrides
      });
    }

    it("adoption restores the removed source's own link receipt onto the new origin (kills stamping `undefined`, which relabels a sync-applied link as the user's and puts it beyond every rule that reads the receipt)", () => {
      const source = makeSource({ authProfileId: "p1" });
      const kept = keptWithSourceAppliedProfile();

      const plan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [kept],
        now: 5000,
        authProfile: healthyKeyProfile,
        adoptionChoice: "adopt"
      });

      expect(plan.updates).toHaveLength(1);
      const after = plan.updates[0].after;
      expect(after.id).toBe("kept-1");
      // The link itself is untouched — adoption never rewrites a credential.
      expect(after.authProfileId).toBe("p1");
      // And the record now says WHO put it there.
      expect(after.origin?.syncedAuthProfileId).toBe("p1");
      expect(after.formerlySynced).toBeUndefined();
    });

    it("THE RESCUE, end to end — the adopted server's link comes back off when that key profile loses its key file (kills a fix that copies the receipt somewhere nothing reads: without it AUTH 2b's verdict is 'none' and the server is stranded on key auth with no key)", () => {
      const source = makeSource({ authProfileId: "p1" });

      // Run 1 — the adoption, while the profile is still usable.
      const adoptionPlan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [keptWithSourceAppliedProfile()],
        now: 5000,
        authProfile: healthyKeyProfile,
        adoptionChoice: "adopt"
      });
      const adopted = adoptionPlan.updates[0].after;

      // Run 2 — same source, same device, but the profile has lost its key file.
      // The server list is exactly what run 1 produced: this is the record the
      // apply would have persisted, not a hand-built approximation of it.
      const rescuePlan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [adopted],
        now: 6000,
        authProfile: brokenKeyProfile
      });

      expect(rescuePlan.updates).toHaveLength(1);
      const rescued = rescuePlan.updates[0].after;
      expect(rescued.id).toBe("kept-1");
      // AUTH 2b: the link the sync applied comes off, and its receipt goes with
      // it so a later sync can put the link back once the profile is repaired.
      expect(rescued.authProfileId).toBeUndefined();
      expect(rescued.origin?.syncedAuthProfileId).toBeUndefined();
      // The record is back in the shape it can actually connect in.
      expect(rescued.authType).toBe("agent");
      expect(rescuePlan.warnings.some((w) => w.includes("unlinked here so it can connect again"))).toBe(true);
    });

    it("CONTROL — a link the USER set on a kept server (no receipt in the marker) is NOT unlinked by the same second run (kills a 'fix' that unlinks on `authProfileId` alone, which would strip a credential the sync never applied)", () => {
      const source = makeSource({ authProfileId: "p1" });
      // Identical in every respect except that the marker carries no receipt:
      // this server's link is the user's own doing, made after the detach.
      const handLinked = keptWithSourceAppliedProfile({ formerlySynced: keptMarker() });

      const adoptionPlan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [handLinked],
        now: 5000,
        authProfile: healthyKeyProfile,
        adoptionChoice: "adopt"
      });
      const adopted = adoptionPlan.updates[0].after;
      expect(adopted.authProfileId).toBe("p1");
      expect(adopted.origin?.syncedAuthProfileId).toBeUndefined();

      const rescuePlan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [adopted],
        now: 6000,
        authProfile: brokenKeyProfile
      });

      // Left exactly as the user set it. The plan still WARNS about the unusable
      // profile — it just does not take a credential decision that was not its own.
      expect(rescuePlan.updates.every((u) => u.after.authProfileId === "p1")).toBe(true);
      expect(rescuePlan.warnings.some((w) => w.includes("uses private key authentication but has no key file"))).toBe(true);
      expect(rescuePlan.warnings.some((w) => w.includes("unlinked here so it can connect again"))).toBe(false);
    });

    it("REVIEW FINDING (P2) — a link the user cleared BEFORE the source was removed is still an opt-out after the adoption: the profile is not re-attached, and the record keeps the receipt that goes on refusing it (kills a retro-apply predicate that reads only `origin`, which sees an origin-less record with no link and calls it never-configured — the same clear made one step later is honoured forever)", () => {
      const source = makeSource({ authProfileId: "p1" });
      const passwordProfile: AuthProfile = { id: "p1", name: "Lab credentials", username: "labuser", authType: "password" };

      // THE RECORD "Keep Servers" LEAVES when the user cleared the link first:
      // no `authProfileId`, and a marker still naming the profile the removed
      // source's sync had applied. `username: "admin"` is makeSource()'s
      // defaultUsername and is what makes this non-vacuous — every OTHER clause
      // of retro-apply passes, so the marker is the only thing that can refuse
      // it. With the record's own "labuser" the username clause would refuse on
      // its own and this would go green against the unfixed predicate.
      const optedOutBeforeRemoval = keptWithSourceAppliedProfile({
        username: "admin",
        authProfileId: undefined,
        formerlySynced: keptMarker({ syncedAuthProfileId: "p1" })
      });

      const plan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [optedOutBeforeRemoval],
        now: 5000,
        authProfile: passwordProfile,
        adoptionChoice: "adopt"
      });

      // The adoption itself still happens — the opt-out is about a credential,
      // not about ownership.
      expect(plan.updates).toHaveLength(1);
      const after = plan.updates[0].after;
      expect(after.id).toBe("kept-1");
      expect(after.origin?.sourceId).toBe("source-1");

      // THE ASSERTION THE FINDING TURNS ON: the profile is NOT put back.
      expect(after.authProfileId).toBeUndefined();
      // And the receipt survives into the origin, so the ordinary update path
      // reads the same opt-out on every later run without the marker adoption
      // has just spent.
      expect(after.origin?.syncedAuthProfileId).toBe("p1");

      // Proven, not assumed: feed the record this plan would persist back into
      // the next sync and the link stays off.
      const nextPlan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [after],
        now: 6000,
        authProfile: passwordProfile
      });
      expect(nextPlan.updates.every((u) => u.after.authProfileId === undefined)).toBe(true);
    });

    it("CONTROL — a kept server whose former source never applied a profile is NOT opted out: the adoption links the new source's profile as it always did (kills a 'fix' that refuses retro-apply on the mere presence of a marker, which would lock every ordinary kept server out of the credential the source exists to supply)", () => {
      const source = makeSource({ authProfileId: "p1" });
      const passwordProfile: AuthProfile = { id: "p1", name: "Lab credentials", username: "labuser", authType: "password" };

      // Identical to the fixture above in every respect except the one that
      // matters: the marker carries no receipt, i.e. no sync ever put a profile
      // on this record. Absent stamp and absent marker-stamp must keep reading
      // the same way — "the sync never linked one here" — or backward compat
      // with pre-field records breaks with it.
      const neverLinked = keptWithSourceAppliedProfile({
        username: "admin",
        authProfileId: undefined,
        formerlySynced: keptMarker()
      });

      const plan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [neverLinked],
        now: 5000,
        authProfile: passwordProfile,
        adoptionChoice: "adopt"
      });

      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0].after.authProfileId).toBe("p1");
      expect(plan.updates[0].after.origin?.syncedAuthProfileId).toBe("p1");
    });

    it("CONTROL — an OWNED server's verdict is unchanged by a stray marker beside its origin (kills reading the marker as a fallback rather than only in the absence of an origin: a record carrying both is documented as inert, and a stale marker must not lock an owned server out of retro-apply)", () => {
      const source = makeSource({ authProfileId: "p1" });
      const passwordProfile: AuthProfile = { id: "p1", name: "Lab credentials", username: "labuser", authType: "password" };

      const ownedWithStrayMarker = makeOwnedServer({
        username: "admin",
        authType: "agent",
        authProfileId: undefined,
        // The origin says no sync ever linked a profile here...
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedInstanceKey: INSTANCE_A },
        // ...while a leftover marker names one. The origin is the authority.
        formerlySynced: keptMarker({ syncedAuthProfileId: "p1" })
      });

      const plan = planFor({
        source,
        tree: makeTree([makeDevice()]),
        currentServers: [ownedWithStrayMarker],
        now: 5000,
        authProfile: passwordProfile
      });

      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0].after.authProfileId).toBe("p1");
    });

    it("a cleared link on an ADOPTED server reads as the per-server opt-out it is, so the next sync does not reattach the profile (kills the stampless adoption's other consequence: the user's only workaround for the stranded server was undone on the following run)", () => {
      const source = makeSource({ authProfileId: "p1" });
      const passwordProfile: AuthProfile = { id: "p1", name: "Lab key", username: "labuser", authType: "password" };

      // `username: "admin"` is makeSource()'s defaultUsername, and it is what
      // makes this fixture non-vacuous: retro-apply's username clause has to PASS
      // so that the receipt is the only thing left deciding. With the record's own
      // "labuser" the mismatch would refuse the re-link on its own and the test
      // would go green against a build that never restored the receipt at all.
      const adopted = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [keptWithSourceAppliedProfile({ username: "admin" })],
        now: 5000,
        authProfile: healthyKeyProfile,
        adoptionChoice: "adopt"
      }).updates[0].after;
      expect(adopted.username).toBe("admin");

      // The user clears the link in the server editor.
      const optedOut: ServerConfig = { ...adopted, authProfileId: undefined };

      // A perfectly healthy profile on the next run — retro-apply's own main flow.
      const nextPlan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [optedOut],
        now: 6000,
        authProfile: passwordProfile
      });

      expect(nextPlan.updates.every((u) => u.after.authProfileId === undefined)).toBe(true);
      expect(nextPlan.adds).toHaveLength(0);
    });

    /** The kept device with an out-of-band endpoint beside its SSH one. */
    function keptDeviceWithOob(oob: string, overrides: Partial<InventoryDevice> = {}): InventoryDevice {
      return keptDevice({ endpoints: [{ kind: "ssh", host: "lab-sw-01" }, { kind: "redfish", host: oob }], ...overrides });
    }

    it("OOB (PR-A REVIEW FINDING) — an adoption RESTORES `syncedIpmiHost` from the marker, and a marker carrying none restores none (kills the receipt-less implementation, under which Remove Source → Keep Servers → re-add → Adopt leaves a SYNC-WRITTEN BMC address looking hand-typed forever)", () => {
      const source = makeSource();

      // What "Keep Servers" leaves behind for a server whose BMC address the
      // removed source's sync had written: the value, and a marker remembering
      // that the SYNC — not the user — put it there.
      const withReceipt = makeKeptServer({ ipmiHost: "10.9.9.9", formerlySynced: keptMarker({ syncedIpmiHost: "10.9.9.9" }) });
      const adopted = planFor({
        source,
        tree: makeTree([keptDeviceWithOob("10.9.9.9")]),
        currentServers: [withReceipt],
        now: 5000,
        adoptionChoice: "adopt"
      }).updates[0].after;

      expect(adopted.id).toBe("kept-1");
      expect(adopted.ipmiHost).toBe("10.9.9.9");
      expect(adopted.origin?.syncedIpmiHost).toBe("10.9.9.9");

      // THE NEAR-MISS, and what keeps the assertion above from being satisfied
      // by an implementation that simply stamps `adoptee.ipmiHost`: an identical
      // record whose marker carries NO receipt holds a hand-typed address, so
      // the adoption must restore nothing and leave it hands-off.
      const handTyped = makeKeptServer({
        id: "kept-2",
        ipmiHost: "192.168.50.5",
        formerlySynced: keptMarker({ externalId: "device:2" })
      });
      const handAdopted = planFor({
        source,
        tree: makeTree([keptDeviceWithOob("10.9.9.9", { externalId: "device:2" })]),
        currentServers: [handTyped],
        now: 5000,
        adoptionChoice: "adopt"
      }).updates[0].after;
      expect(handAdopted.ipmiHost).toBe("192.168.50.5");
      expect(handAdopted.origin?.syncedIpmiHost).toBeUndefined();
    });

    it("OOB (PR-A REVIEW FINDING) — an adopted server whose restored stamp still names its address FOLLOWS the BMC to a new one on the next sync (matrix row 3 — the behaviour the receipt exists to enable; kills the receipt-less implementation on behaviour rather than on data, since the record lands in row 5 and the new address is simply never written)", () => {
      const source = makeSource();
      const withReceipt = makeKeptServer({ ipmiHost: "10.9.9.9", formerlySynced: keptMarker({ syncedIpmiHost: "10.9.9.9" }) });

      const adopted = planFor({
        source,
        tree: makeTree([keptDeviceWithOob("10.9.9.9")]),
        currentServers: [withReceipt],
        now: 5000,
        adoptionChoice: "adopt"
      }).updates[0].after;

      // The BMC is re-addressed in NetBox. Deliberately to a THIRD value rather
      // than back to the adoptee's own: an address that still matched would
      // self-heal through matrix row 5a and the receipt would prove nothing.
      const next = planFor({
        source,
        tree: makeTree([keptDeviceWithOob("10.9.9.50")]),
        currentServers: [adopted],
        now: 6000
      });

      expect(next.updates).toHaveLength(1);
      expect(next.updates[0].after.ipmiHost).toBe("10.9.9.50");
      expect(next.updates[0].after.origin?.syncedIpmiHost).toBe("10.9.9.50");
    });

    it("OOB (CODEX ROUND-2 FINDING) — a BMC re-addressed WHILE THE SOURCE WAS DETACHED is applied BY the adoption, not one sync later (kills the restore-only adoption, which put the receipt back and left the record pointing at the dead address for the whole run the user actually approved)", () => {
      const source = makeSource();

      // The receipt matches the record: the removed source's sync wrote
      // 10.1.1.1 and the detach preserved the proof. Matrix row 3 — the sync
      // still owns this field — and the device now says something else.
      const withReceipt = makeKeptServer({
        ipmiHost: "10.1.1.1",
        formerlySynced: keptMarker({ syncedIpmiHost: "10.1.1.1" })
      });

      const adopted = planFor({
        source,
        tree: makeTree([keptDeviceWithOob("10.2.2.2")]),
        currentServers: [withReceipt],
        now: 5000,
        adoptionChoice: "adopt"
      }).updates[0].after;

      expect(adopted.id).toBe("kept-1");
      expect(adopted.ipmiHost).toBe("10.2.2.2");
      expect(adopted.origin?.syncedIpmiHost).toBe("10.2.2.2");
    });

    it("OOB (CODEX ROUND-2 FINDING) — a hand-typed address with NO receipt survives the adoption untouched and unstamped (kills the over-broad fix `takesIpmiHost = mgmtHost !== undefined`, which would let adoption clobber the one value the whole matrix exists to protect)", () => {
      const source = makeSource();

      // No `syncedIpmiHost` on the marker: nothing ever proved a sync wrote
      // this, so it is a hand entry (matrix row 5) and the device's own address
      // being on offer changes nothing.
      const handTyped = makeKeptServer({
        ipmiHost: "192.168.0.9",
        formerlySynced: keptMarker()
      });

      const adopted = planFor({
        source,
        tree: makeTree([keptDeviceWithOob("10.2.2.2")]),
        currentServers: [handTyped],
        now: 5000,
        adoptionChoice: "adopt"
      }).updates[0].after;

      expect(adopted.id).toBe("kept-1");
      expect(adopted.ipmiHost).toBe("192.168.0.9");
      expect(adopted.origin?.syncedIpmiHost).toBeUndefined();
    });

    it("OOB (CODEX ROUND-2 FINDING) — a device offering NO out-of-band endpoint leaves the field alone AND still carries the receipt (matrix row 6; kills the half-fix `syncedIpmiHost: takesIpmiHost ? mgmtHost : undefined`, which drops the restore on every row the matrix answers no for and re-strands the very server the receipt was added to rescue)", () => {
      const source = makeSource();
      const withReceipt = makeKeptServer({
        ipmiHost: "10.1.1.1",
        formerlySynced: keptMarker({ syncedIpmiHost: "10.1.1.1" })
      });

      // `keptDevice()` — SSH endpoint only, no redfish/ipmi-sol beside it.
      const adopted = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [withReceipt],
        now: 5000,
        adoptionChoice: "adopt"
      }).updates[0].after;

      expect(adopted.id).toBe("kept-1");
      expect(adopted.ipmiHost).toBe("10.1.1.1");
      expect(adopted.origin?.syncedIpmiHost).toBe("10.1.1.1");
    });

    /** The kept device with an ALTERNATE (second) ssh endpoint beside its primary one. */
    function keptDeviceWithAlt(alt: string, overrides: Partial<InventoryDevice> = {}): InventoryDevice {
      return keptDevice({ endpoints: [{ kind: "ssh", host: "lab-sw-01" }, { kind: "ssh", host: alt }], ...overrides });
    }

    it("ALTERNATE HOST (Phase 2) — an adoption RESTORES `syncedAltHost` from the marker, and a marker carrying none restores none (kills a receipt-less adoption, under which Remove Source → Keep Servers → re-add → Adopt leaves a SYNC-WRITTEN alternate host looking hand-typed forever)", () => {
      const source = makeSource();

      const withReceipt = makeKeptServer({ altHost: "2001:db8::9", formerlySynced: keptMarker({ syncedAltHost: "2001:db8::9" }) });
      const adopted = planFor({
        source,
        tree: makeTree([keptDeviceWithAlt("2001:db8::9")]),
        currentServers: [withReceipt],
        now: 5000,
        adoptionChoice: "adopt"
      }).updates[0].after;

      expect(adopted.id).toBe("kept-1");
      expect(adopted.altHost).toBe("2001:db8::9");
      expect(adopted.origin?.syncedAltHost).toBe("2001:db8::9");

      // THE NEAR-MISS: an identical record whose marker carries NO receipt holds
      // a hand-typed alternate, so the adoption must restore nothing and leave it
      // hands-off. Kills an implementation that simply stamps `adoptee.altHost`.
      const handTyped = makeKeptServer({
        id: "kept-2",
        altHost: "192.168.50.5",
        formerlySynced: keptMarker({ externalId: "device:2" })
      });
      const handAdopted = planFor({
        source,
        tree: makeTree([keptDeviceWithAlt("2001:db8::9", { externalId: "device:2" })]),
        currentServers: [handTyped],
        now: 5000,
        adoptionChoice: "adopt"
      }).updates[0].after;
      expect(handAdopted.altHost).toBe("192.168.50.5");
      expect(handAdopted.origin?.syncedAltHost).toBeUndefined();
    });

    it("ALTERNATE HOST (Phase 2) — a re-addressed alternate WHILE THE SOURCE WAS DETACHED is applied BY the adoption, not one sync later (matrix row 3; kills a restore-only adoption that leaves the record on the dead alternate for the run the user approved)", () => {
      const source = makeSource();
      const withReceipt = makeKeptServer({
        altHost: "2001:db8::1",
        formerlySynced: keptMarker({ syncedAltHost: "2001:db8::1" })
      });

      const adopted = planFor({
        source,
        tree: makeTree([keptDeviceWithAlt("2001:db8::2")]),
        currentServers: [withReceipt],
        now: 5000,
        adoptionChoice: "adopt"
      }).updates[0].after;

      expect(adopted.id).toBe("kept-1");
      expect(adopted.altHost).toBe("2001:db8::2");
      expect(adopted.origin?.syncedAltHost).toBe("2001:db8::2");
    });

    it("ALTERNATE HOST (Phase 2) — a hand-typed alternate with NO receipt survives adoption untouched and unstamped (kills the over-broad `takesAltHost = altHost !== undefined`, which would clobber the one value the matrix exists to protect)", () => {
      const source = makeSource();
      const handTyped = makeKeptServer({
        altHost: "192.168.0.9",
        formerlySynced: keptMarker()
      });

      const adopted = planFor({
        source,
        tree: makeTree([keptDeviceWithAlt("2001:db8::2")]),
        currentServers: [handTyped],
        now: 5000,
        adoptionChoice: "adopt"
      }).updates[0].after;

      expect(adopted.id).toBe("kept-1");
      expect(adopted.altHost).toBe("192.168.0.9");
      expect(adopted.origin?.syncedAltHost).toBeUndefined();
    });

    it("ALTERNATE HOST (Phase 2) — a device offering NO alternate leaves the field alone AND still carries the receipt (matrix row 6; kills the half-fix `syncedAltHost: takesAltHost ? altHost : undefined`, which drops the restore on every no-write row)", () => {
      const source = makeSource();
      const withReceipt = makeKeptServer({
        altHost: "2001:db8::1",
        formerlySynced: keptMarker({ syncedAltHost: "2001:db8::1" })
      });

      // `keptDevice()` — a single ssh endpoint, no second one beside it.
      const adopted = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [withReceipt],
        now: 5000,
        adoptionChoice: "adopt"
      }).updates[0].after;

      expect(adopted.id).toBe("kept-1");
      expect(adopted.altHost).toBe("2001:db8::1");
      expect(adopted.origin?.syncedAltHost).toBe("2001:db8::1");
    });
  });

  /**
   * REVIEW FINDING (P2, deterministic-ID collision vs. the adoptee).
   *
   * THE SCENARIO. Restore an ID-preserving backup taken while a source was live,
   * then remove that source with Keep Servers and add it back. The kept servers
   * still carry `deterministicServerId(sourceId, externalId)` — the sync that
   * created them minted it — and the restored source record keeps its original
   * id too, so the id a device computes is ALREADY TAKEN by the very record its
   * marker points at. The collision guard sat before the adoption block and
   * skipped on that, treating the intended adoptee as an unrelated collider, so
   * the plan reported no candidate, the question was never asked, and the one
   * path that reconnects a restored source to its own servers was closed.
   *
   * WHY THE SHAPE OF THE EXEMPTION IS THE SAFETY PROPERTY, and why the fixtures
   * below are built as pairs. A test that only proved "adoption now works when
   * the ids collide" would pass just as happily against an exemption that lets
   * ANY device with an adoptable server somewhere overwrite whatever unrelated
   * record happens to hold its id — which is the ownership transfer the two P1
   * findings above exist to prevent. So every case here is asserted against its
   * near-miss: an unrelated collider with no adoptee, an unrelated collider WITH
   * an adoptee elsewhere, and an ambiguous pair one of which is the collider.
   */
  describe("(E-16) the id-collision guard exempts the adoptee, and only the adoptee", () => {
    /** The kept server as a RESTORED BACKUP leaves it: the marker, and the id its own sync minted. */
    function restoredAdoptee(overrides: Partial<ServerConfig> = {}): ServerConfig {
      return makeKeptServer({ id: ADD_PATH_ID, host: "lab-sw-01", ...overrides });
    }

    it("adopts when the colliding record IS the device's uniquely eligible adoptee (kills the guard that skips a restored backup's own server before eligibility is ever consulted — the state that made an ID-preserving restore unreconnectable)", () => {
      const source = makeSource();
      const kept = restoredAdoptee();
      // The collision is real and is the whole point: this id is exactly what the
      // add path would mint for this device.
      expect(kept.id).toBe(deterministicServerId("source-1", "device:1"));

      const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [kept], now: 5000, adoptionChoice: "adopt" });

      expect(plan.adds).toHaveLength(0);
      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0].after.id).toBe(ADD_PATH_ID);
      expect(plan.updates[0].after.origin?.sourceId).toBe("source-1");
      expect(plan.updates[0].after.formerlySynced).toBeUndefined();
      // Credentials survive, as on every other adoption — the exemption changes
      // which records are REACHABLE, never what adoption does to them.
      expect(plan.updates[0].after.username).toBe("handpicked");
      expect(plan.warnings.some((w) => w.includes("already used by unrelated server"))).toBe(false);
    });

    it("still asks the question first: before an answer the colliding adoptee is a CANDIDATE and nothing is applied (kills an exemption scoped to the adopt flag, which would leave the pre-answer plan empty so the question is never put)", () => {
      const source = makeSource();
      const kept = restoredAdoptee();
      // The plan the caller decides to ASK from is computed with no answer at all.
      const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [kept], now: 5000 });

      expect(plan.adoptionCandidates.map((c) => c.deviceName)).toEqual(["core-sw-1"]);
      // And nothing has happened yet — no adoption, and above all no add under an
      // id that is already in use.
      expect(plan.updates).toHaveLength(0);
      expect(plan.adds).toHaveLength(0);
      // REVIEW FINDING (P2) — the candidate CARRIES the fact that declining
      // cannot add it, which is the same fact the exemption above evaluated. It
      // has to be on the plan the question is asked from: the caller renders its
      // copy from this object and from nothing else, and the DECLINE test below
      // is what proves the flag is true of the outcome rather than merely set.
      expect(plan.adoptionCandidates[0].separateAddBlocked).toBe(true);
    });

    it("a candidate whose adoptee holds a DIFFERENT id is not flagged — the decline really does add it (kills a flag hard-wired to true for every candidate, or derived from 'a kept server exists' rather than from the id collision: the caller would then withdraw the separate-add promise on the ordinary remove-and-re-add run this feature was built for)", () => {
      const source = makeSource();
      // The ordinary shape: a kept server under a hand-chosen id, so nothing
      // holds the id the add path would mint for this device.
      const adoptee = makeKeptServer({ id: "kept-1" });
      expect(adoptee.id).not.toBe(deterministicServerId("source-1", "device:1"));

      const unanswered = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [adoptee], now: 5000 });
      expect(unanswered.adoptionCandidates.map((c) => [c.serverId, c.separateAddBlocked])).toEqual([["kept-1", false]]);

      // THE CORROBORATION, not a second opinion: `false` is a claim about what
      // declining does, so the declined plan has to actually make the add.
      const declined = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [adoptee],
        now: 5000,
        adoptionChoice: "decline"
      });
      expect(declined.adds.map((a) => a.id)).toEqual([deterministicServerId("source-1", "device:1")]);
    });

    it("keeps the unrelated-collision skip exactly as it was when nothing is adoptable (kills widening the exemption to every collision)", () => {
      const source = makeSource();
      // Same id, no marker: a hand-imported fragment, or a coincidental collision
      // across two sources sharing a namespace.
      const collider = makeManualServer({ id: ADD_PATH_ID, name: "someone-elses", host: "lab-sw-01" });

      const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [collider], now: 5000, adoptionChoice: "adopt" });

      expect(plan.adds).toHaveLength(0);
      expect(plan.updates).toHaveLength(0);
      expect(plan.adoptionCandidates).toHaveLength(0);
      expect(plan.warnings).toContain(
        'Device "core-sw-1" (device:1) maps to an id already used by unrelated server "someone-elses" — skipped.'
      );
    });

    it("THE WIDENING KILLER — an unrelated collider is still skipped even when an eligible adoptee for the same device exists at a DIFFERENT id, and that adoptee is not touched (kills `eligibleForAdoption.length === 1` without the `=== collidingServer` clause, which would let a device with an adoptee anywhere walk past a guard about a record it has no claim on)", () => {
      const source = makeSource();
      const collider = makeManualServer({ id: ADD_PATH_ID, name: "someone-elses", host: "10.9.9.9" });
      // Perfectly eligible: right provider, right instance, right device, at the
      // device's address. The ONLY thing standing between it and adoption is that
      // the device's id belongs to somebody else.
      const adoptee = makeKeptServer({ id: "kept-1" });

      const plan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [collider, adoptee],
        now: 5000,
        adoptionChoice: "adopt"
      });

      expect(plan.updates).toHaveLength(0);
      expect(plan.adds).toHaveLength(0);
      expect(plan.adoptionCandidates).toHaveLength(0);
      expect(plan.warnings).toContain(
        'Device "core-sw-1" (device:1) maps to an id already used by unrelated server "someone-elses" — skipped.'
      );
    });

    it("an AMBIGUOUS pair is skipped even when one of the two holds the colliding id, and the refusal names that record as this device's own (kills dropping the uniqueness clause, which would resolve an ambiguity Nexus refuses to resolve by picking whichever record happens to own the id — and kills the guard's blanket 'unrelated server' sentence, which is false about the very server this device was last synced onto and carries no repair)", () => {
      const source = makeSource();
      const first = restoredAdoptee({ name: "restored-copy" });
      const second = makeKeptServer({ id: "kept-2", name: "second-copy", host: "lab-sw-01" });

      const plan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [first, second],
        now: 5000,
        adoptionChoice: "adopt"
      });

      expect(plan.updates).toHaveLength(0);
      expect(plan.adds).toHaveLength(0);
      expect(plan.adoptionCandidates).toHaveLength(0);
      // The COLLISION is what refuses it, not the ambiguity warning: the guard
      // runs first, so its sentence is the ONLY thing said about this device —
      // which is why it has to carry the ambiguity's substance AND the collision's,
      // and why calling "restored-copy" unrelated was false in the one sentence
      // the user gets. `toEqual` on the filtered list, not `toContain`: an
      // implementation that pushed both this and the plain ambiguity refusal
      // would tell the user in the same breath that the device is skipped and
      // that it will be added as a duplicate.
      expect(plan.warnings.filter((w) => w.includes("core-sw-1"))).toEqual([
        'Device "core-sw-1" (device:1) matches 2 servers kept from a removed inventory source at lab-sw-01:22, so Nexus cannot tell which to adopt — and server "restored-copy", kept from an earlier sync of this same device, still uses the id a new server for this device would need, so the device is skipped rather than added as a duplicate. Remove every server kept for this device except the one at lab-sw-01:22 you want to keep, then sync again and choose Adopt Existing.'
      ]);

      // THE REPAIR, TRACED — both ways round, because "the one you want to keep"
      // is offered as a free choice and would be a false one if only the record
      // holding the id could be reclaimed afterwards.
      const keptTheColliding = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [first], now: 6000, adoptionChoice: "adopt" });
      expect(keptTheColliding.adds).toHaveLength(0);
      expect(keptTheColliding.updates.map((u) => u.after.id)).toEqual([ADD_PATH_ID]);

      const keptTheOther = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [second], now: 6000, adoptionChoice: "adopt" });
      expect(keptTheOther.adds).toHaveLength(0);
      expect(keptTheOther.updates.map((u) => u.after.id)).toEqual(["kept-2"]);
    });

    it("a restored id-preserving backup whose DEVICE MOVED is skipped under a sentence naming its own former server, both addresses and the repair (kills the blanket 'unrelated server' wording in the one state where the moved-address explanation can never be reached: the guard continues before it, so the device's own kept record is reported as somebody else's and no repair is given at all)", () => {
      const source = makeSource();
      // The restored backup's own record — it holds the id the add path would
      // mint — but the device has been re-IP'd since, so the address no longer
      // corroborates and `eligibleForAdoption` is empty. Neither the exemption
      // nor the moved-address refusal can fire.
      const movedAway = restoredAdoptee({ host: "10.9.9.9" });
      expect(movedAway.id).toBe(deterministicServerId("source-1", "device:1"));

      const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [movedAway], now: 5000, adoptionChoice: "adopt" });

      // Nothing is added (the id is taken) and nothing is adopted (the address
      // moved) — the bind the sentence has to explain.
      expect(plan.adds).toHaveLength(0);
      expect(plan.updates).toHaveLength(0);
      expect(plan.adoptionCandidates).toHaveLength(0);
      expect(plan.warnings.filter((w) => w.includes("core-sw-1"))).toEqual([
        'Device "core-sw-1" (device:1) was previously synced onto server "old-name", which is now at 10.9.9.9:22 while the device is at lab-sw-01:22 — and it still uses the id a new server for this device would need, so the device is skipped rather than added as a new server. Point "old-name" back at lab-sw-01:22 and sync again to reclaim it with Adopt Existing, or delete it and the next sync adds the device fresh.'
      ]);

      // REPAIR 1, TRACED: the user puts that server back at the device's address
      // (the edit path preserves the marker) and syncs. The collider becomes the
      // uniquely eligible adoptee, so the question is RAISED — which is the whole
      // of the promise — and Adopt Existing reclaims it with its credentials.
      const repaired: ServerConfig = { ...movedAway, host: "lab-sw-01" };
      const asked = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [repaired], now: 6000 });
      expect(asked.adoptionCandidates).toEqual([
        { deviceName: "core-sw-1", externalId: "device:1", serverId: ADD_PATH_ID, separateAddBlocked: true }
      ]);
      const reclaimed = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [repaired], now: 6000, adoptionChoice: "adopt" });
      expect(reclaimed.adds).toHaveLength(0);
      expect(reclaimed.updates).toHaveLength(1);
      expect(reclaimed.updates[0].after.id).toBe(ADD_PATH_ID);
      expect(reclaimed.updates[0].after.username).toBe("handpicked");
      expect(reclaimed.updates[0].after.origin?.sourceId).toBe("source-1");

      // REPAIR 2, TRACED: delete it instead, and the next sync really does add
      // the device fresh — under the very id that record was holding.
      const deleted = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [], now: 6000 });
      expect(deleted.adds.map((a) => a.id)).toEqual([ADD_PATH_ID]);
    });

    it("a STALE kept copy holding the id is named as this device's own record even though a DIFFERENT kept copy is the one at the device's address (kills a discriminator keyed on 'the collider is the adoptee' rather than on 'the collider is a kept record of this device', which reports one of two markers for the same device as unrelated)", () => {
      const source = makeSource();
      // Two sources pointed at one deployment, both removed with Keep Servers;
      // the one restored under its old id is the copy that has since moved.
      const adoptable = makeKeptServer({ id: "kept-1", name: "adoptable-copy" });
      const stale = makeKeptServer({ id: ADD_PATH_ID, name: "stale-copy", host: "10.9.9.9" });

      const plan = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [adoptable, stale], now: 5000, adoptionChoice: "adopt" });

      expect(plan.adds).toHaveLength(0);
      expect(plan.updates).toHaveLength(0);
      expect(plan.adoptionCandidates).toHaveLength(0);
      expect(plan.warnings.filter((w) => w.includes("core-sw-1"))).toEqual([
        'Device "core-sw-1" (device:1) matches server "adoptable-copy" kept from a removed inventory source at lab-sw-01:22, but server "stale-copy" — kept from an earlier sync of this same device, now at 10.9.9.9:22 — still uses the id a new server for this device would need, so the device is skipped rather than offered for adoption. Delete "stale-copy", then sync again and choose Adopt Existing to reclaim "adoptable-copy".'
      ]);

      // THE REPAIR, TRACED: deleting the id-holder leaves the other copy an
      // ordinary candidate, and it is the one the sentence promised to reclaim.
      const repaired = planFor({ source, tree: makeTree([keptDevice()]), currentServers: [adoptable], now: 6000, adoptionChoice: "adopt" });
      expect(repaired.adds).toHaveLength(0);
      expect(repaired.updates.map((u) => u.after.id)).toEqual(["kept-1"]);
      expect(repaired.updates[0].after.origin?.sourceId).toBe("source-1");
    });

    it("DECLINING an exempted collision skips rather than adding — no second record under an id already in use — and says what actually happened (kills falling through into the add path once the guard has been passed, which mints a duplicate id)", () => {
      const source = makeSource();
      const kept = restoredAdoptee();

      const plan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [kept],
        now: 5000,
        adoptionChoice: "decline"
      });

      // THE ASSERTION THAT MATTERS: nothing is added. An add here would carry
      // `ADD_PATH_ID`, i.e. a second server under the id `kept` already holds.
      expect(plan.adds).toHaveLength(0);
      expect(plan.updates).toHaveLength(0);
      // And the user who asked for a separate add is told why they did not get
      // one — in its own words, since calling the record they were just offered
      // "unrelated" would be false about the server and useless about the outcome.
      expect(plan.warnings).toContain(
        'Device "core-sw-1" (device:1) was previously synced onto server "old-name", which still uses the id a new server for this device would need — so it is skipped rather than added separately. Sync again and choose Adopt Existing to reclaim that server.'
      );
      expect(plan.warnings.some((w) => w.includes("already used by unrelated server"))).toBe(false);
    });

    it("a marker from ANOTHER deployment never earns the exemption — the collision skip stands and the record is untouched (kills an exemption that consults the marker without the instance rule, which would hand the cross-instance transfer a second route in)", () => {
      const source = makeSource({ providerId: "netbox" });
      const keptFromB = restoredAdoptee({ formerlySynced: keptMarker({ instanceKey: INSTANCE_B }) });

      const plan = planFor({
        source,
        tree: makeTree([keptDevice()]),
        currentServers: [keptFromB],
        now: 5000,
        providerInstanceKey: INSTANCE_A,
        adoptionChoice: "adopt"
      });

      expect(plan.updates).toHaveLength(0);
      expect(plan.adds).toHaveLength(0);
      expect(plan.adoptionCandidates).toHaveLength(0);
      expect(plan.warnings).toContain(
        'Device "core-sw-1" (device:1) maps to an id already used by unrelated server "old-name" — skipped.'
      );
    });
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
      manualDuplicateCount: 0,
      adoptionCandidates: []
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
      manualDuplicateCount: 0,
      adoptionCandidates: []
    };
    expect(prunedServerIdsForSecretCleanup(plan)).toEqual(["d1"]);
  });
});

/**
 * OOB (issue #48, Phase 2) — NetBox's `oob_ip` reaching `ServerConfig.ipmiHost`
 * through a management endpoint, and the `ServerOrigin.syncedIpmiHost` stamp
 * that decides when the sync may write it.
 *
 * `ipmiHost` is NOT on the host/port "the device always wins" discipline: it
 * shipped as a hand-edited field before any sync could write it, so the rule is
 * the `syncedAuthProfileId` one — the stamp records what the SYNC wrote, and
 * the sync writes only where the record still carries exactly that. There is
 * one fixture per row of that matrix below, each built so the WRONG rule
 * produces a visibly different plan rather than the same one by luck.
 */
describe("computeSyncPlan — oob_ip -> ipmiHost (OOB)", () => {
  const OOB = { kind: "redfish" as const, host: "10.9.9.9" };
  const SSH = { kind: "ssh" as const, host: "10.0.0.1" };

  function deviceWithOob(host = "10.9.9.9"): InventoryDevice {
    return makeDevice({ endpoints: [SSH, { kind: "redfish", host }] });
  }

  /** The one update this plan is expected to contain. */
  function onlyUpdate(plan: InventorySyncPlan) {
    expect(plan.updates).toHaveLength(1);
    return plan.updates[0].after;
  }

  it("ADD PATH: writes the management endpoint into ipmiHost and stamps it, and stamps `undefined` when the device offers none (kills a stampless add, which reads as a hand entry on the very next sync and is never updated again)", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([deviceWithOob(), makeDevice({ externalId: "device:2", name: "no-bmc" })]),
      currentServers: [],
      now: 1000
    });

    expect(plan.adds).toHaveLength(2);
    const [withBmc, withoutBmc] = plan.adds;
    expect(withBmc.ipmiHost).toBe("10.9.9.9");
    expect(withBmc.origin?.syncedIpmiHost).toBe("10.9.9.9");
    // The SSH mapping is untouched by any of this.
    expect(withBmc.host).toBe("10.0.0.1");
    expect(withoutBmc.ipmiHost).toBeUndefined();
    expect(withoutBmc.origin?.syncedIpmiHost).toBeUndefined();
  });

  it("selects `ipmi-sol` endpoints too, and takes the FIRST management endpoint with a non-empty host (kills a redfish-only selector, and kills one that accepts an empty host)", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([
        makeDevice({
          endpoints: [SSH, { kind: "redfish", host: "" }, { kind: "ipmi-sol", host: "10.9.9.9" }, { kind: "redfish", host: "10.9.9.10" }]
        })
      ]),
      currentServers: [],
      now: 1000
    });

    expect(plan.adds[0].ipmiHost).toBe("10.9.9.9");
  });

  it("MATRIX ROW 1 — unset value, unset stamp, endpoint present: writes and stamps (kills 'never write', which leaves the whole feature inert)", () => {
    const owned = makeOwnedServer();
    expect(owned.ipmiHost).toBeUndefined();

    const after = onlyUpdate(
      computeSyncPlan({ source: makeSource(), tree: makeTree([deviceWithOob()]), currentServers: [owned], now: 2000 })
    );

    expect(after.ipmiHost).toBe("10.9.9.9");
    expect(after.origin?.syncedIpmiHost).toBe("10.9.9.9");
  });

  it("MATRIX ROW 2 — unset value, stamp SET (the user cleared a synced address): leaves it cleared and carries the stamp forward (kills an implementation missing the opt-out clause, which refills the field on every sync forever)", () => {
    const owned = makeOwnedServer({
      // Deliberately NOT `ipmiHost: undefined` by accident: the stamp is what
      // makes this "the user emptied a value the sync wrote" rather than "never
      // configured", and it is the only difference from row 1's fixture.
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedIpmiHost: "10.9.9.9" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([deviceWithOob()]),
      currentServers: [owned],
      now: 2000
    });

    // Nothing else about this device changed either, so a correct plan reports
    // it as unchanged — and a broken one has to write the address back to be
    // an update at all.
    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it("MATRIX ROW 1, BLANK VALUE (REVIEW FINDING) — an empty-string ipmiHost with no stamp is ABSENT, not hand-configured: it is filled and stamped (kills the strict `cur === stamp` comparison, under which `\"\"` matches neither the absent stamp nor the non-empty device address and the field is misfiled as a hand edit forever)", () => {
    const owned = makeOwnedServer({
      // The shape `validateServerConfig` deliberately accepts and every use site
      // reads as "not set" — a persisted or imported record whose ipmiHost was
      // emptied to `""` rather than removed. No stamp, so nothing was ever
      // synced here: row 1's state wearing a different spelling.
      ipmiHost: ""
    });

    const after = onlyUpdate(
      computeSyncPlan({ source: makeSource(), tree: makeTree([deviceWithOob()]), currentServers: [owned], now: 2000 })
    );

    expect(after.ipmiHost).toBe("10.9.9.9");
    expect(after.origin?.syncedIpmiHost).toBe("10.9.9.9");
  });

  it("MATRIX ROW 1, WHITESPACE-ONLY VALUE (REVIEW FINDING) — same as the blank one: filled and stamped (kills a fix that only special-cases the exact empty string, leaving a field the user cleared to a stray space unrepairable)", () => {
    const owned = makeOwnedServer({ ipmiHost: "   " });

    const after = onlyUpdate(
      computeSyncPlan({ source: makeSource(), tree: makeTree([deviceWithOob()]), currentServers: [owned], now: 2000 })
    );

    expect(after.ipmiHost).toBe("10.9.9.9");
    expect(after.origin?.syncedIpmiHost).toBe("10.9.9.9");
  });

  it("MATRIX ROW 2, BLANK VALUE (REVIEW FINDING) — a blank value WITH a stamp is still the opt-out: left blank, stamp carried forward (kills the over-fix `blank cur → the sync owns it`, which would refill the field of a user who emptied it to `\"\"` instead of removing it)", () => {
    const owned = makeOwnedServer({
      // The one difference from the row-1 blank fixture above: a stamp, which is
      // what makes this "the user emptied a value the sync wrote".
      ipmiHost: "",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedIpmiHost: "10.1.1.1" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      // Renamed, so the plan carries an update whatever the rule does and the
      // assertions below observe the FIELD rather than the mere presence of a
      // plan entry — the vacuous version of this fixture.
      tree: makeTree([makeDevice({ name: "core-sw-1-renamed", endpoints: [SSH, OOB] })]),
      currentServers: [owned],
      now: 2000
    });

    const after = onlyUpdate(plan);
    expect(after.name).toBe("core-sw-1-renamed");
    expect(after.ipmiHost).toBe("");
    expect(after.ipmiHost).not.toBe("10.9.9.9");
    // Carried forward verbatim: the stamp is never refreshed where nothing was written.
    expect(after.origin?.syncedIpmiHost).toBe("10.1.1.1");
  });

  it("MATRIX ROW 3 — value still equals the stamp, endpoint moved: overwrites and re-stamps (kills 'never overwrite', which strands a re-addressed BMC on its old address)", () => {
    const owned = makeOwnedServer({
      ipmiHost: "10.9.9.9",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedIpmiHost: "10.9.9.9" }
    });

    const after = onlyUpdate(
      computeSyncPlan({
        source: makeSource(),
        tree: makeTree([deviceWithOob("10.9.9.50")]),
        currentServers: [owned],
        now: 2000
      })
    );

    expect(after.ipmiHost).toBe("10.9.9.50");
    expect(after.origin?.syncedIpmiHost).toBe("10.9.9.50");
  });

  it("MATRIX ROW 4 — value HAND-EDITED away from the stamp: the hand edit survives and is never laundered into the stamp (kills 'the device always wins', which is the host/port rule and would clobber the edit)", () => {
    const owned = makeOwnedServer({
      // The sync wrote 10.9.9.9; the user has since retyped it. The device now
      // reports a third value, so all three are distinct and every wrong rule
      // lands on a different one.
      ipmiHost: "192.168.50.5",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedIpmiHost: "10.9.9.9" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      // The device is ALSO renamed, so an update is pushed regardless and the
      // assertion below is about the field rather than about whether the plan
      // contains anything at all — the vacuous version of this fixture.
      tree: makeTree([makeDevice({ name: "core-sw-1-renamed", endpoints: [SSH, { kind: "redfish", host: "10.9.9.50" }] })]),
      currentServers: [owned],
      now: 2000
    });

    const after = onlyUpdate(plan);
    expect(after.name).toBe("core-sw-1-renamed");
    expect(after.ipmiHost).toBe("192.168.50.5");
    // Carried forward VERBATIM — recording the hand-edited value here would make
    // the very next sync read it as "still exactly what I stamped" and overwrite it.
    expect(after.origin?.syncedIpmiHost).toBe("10.9.9.9");
  });

  it("MATRIX ROW 5 — legacy hand-set value with NO stamp: untouched, and it does not acquire a stamp (kills 'absent stamp means the sync owns it', which clobbers every Phase-1 manual entry on the first post-upgrade sync)", () => {
    const owned = makeOwnedServer({
      ipmiHost: "192.168.50.5",
      // A server synced before the stamp existed: the origin has no OOB member
      // at all.
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice({ name: "core-sw-1-renamed", endpoints: [SSH, OOB] })]),
      currentServers: [owned],
      now: 2000
    });

    const after = onlyUpdate(plan);
    expect(after.ipmiHost).toBe("192.168.50.5");
    expect(after.origin?.syncedIpmiHost).toBeUndefined();
  });

  it("MATRIX ROW 5a — a hand-typed value that ALREADY EQUALS the device's out-of-band address gains the stamp while the value stays put: a GENUINE stamp-only update (kills the `cur === stamp`-only gate, under which the likeliest Phase-1 hand entry of all — the address copied out of the NetBox UI — can never be stamped and goes silently stale the first time the BMC is re-addressed)", () => {
    const owned = makeOwnedServer({
      // Typed by hand into the Phase-1 server form, straight out of NetBox, so
      // it is byte-identical to what the device reports — and it carries NO
      // stamp, because no sync ever wrote it. That is row 5's exact shape, and
      // row 5a is the refinement that rescues it.
      ipmiHost: "10.9.9.9",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      // Nothing else about this device moved: same name, same SSH address, same
      // port, same folder, same out-of-band address. The STAMP is the entire
      // difference between `before` and `after`, which is what makes this AUTH
      // 3a's shape rather than row 1's — row 1's fixture changes the value too,
      // so it passes even against an implementation that forgot the stamps-equal
      // term entirely.
      tree: makeTree([deviceWithOob()]),
      currentServers: [owned],
      now: 2000
    });

    expect(plan.updates).toHaveLength(1);
    expect(plan.unchangedCount).toBe(0);
    const { before, after } = plan.updates[0];
    // The VALUE does not move — row 5a refines "leave the value alone", it does
    // not license an overwrite.
    expect(before.ipmiHost).toBe("10.9.9.9");
    expect(after.ipmiHost).toBe("10.9.9.9");
    // ...and OWNERSHIP is now recorded, which is the whole of the change.
    expect(before.origin?.syncedIpmiHost).toBeUndefined();
    expect(after.origin?.syncedIpmiHost).toBe("10.9.9.9");
  });

  it("MATRIX ROW 5a, WHAT THE STAMP THEN BUYS — once stamped, the same record follows the BMC to its new address on the next sync (row 3); without the stamp it is stuck on the old one forever", () => {
    const owned = makeOwnedServer({
      ipmiHost: "10.9.9.9",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });

    // Sync one: the value matches, so the stamp is recorded.
    const stamped = onlyUpdate(
      computeSyncPlan({ source: makeSource(), tree: makeTree([deviceWithOob()]), currentServers: [owned], now: 2000 })
    );
    expect(stamped.origin?.syncedIpmiHost).toBe("10.9.9.9");

    // Sync two, with the BMC re-addressed in NetBox. Feeding sync one's OUTPUT
    // back in is the point: the repair has to survive into the next run's input.
    const followed = onlyUpdate(
      computeSyncPlan({ source: makeSource(), tree: makeTree([deviceWithOob("10.9.9.50")]), currentServers: [stamped], now: 3000 })
    );
    expect(followed.ipmiHost).toBe("10.9.9.50");
    expect(followed.origin?.syncedIpmiHost).toBe("10.9.9.50");
  });

  it("MATRIX ROW 5a, THE ACCEPTED RESIDUAL — a hand edit that lands on the device's own current address IS adopted into sync ownership (the documented m7-class trade, stated as a fixture so the next reader meets it here rather than in the field)", () => {
    const owned = makeOwnedServer({
      // The sync wrote 10.9.9.9 and the user retyped the field — but retyped it
      // to what the device reports TODAY (NetBox moved the BMC, the user
      // followed it by hand before the next sync ran).
      ipmiHost: "10.9.9.50",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedIpmiHost: "10.9.9.9" }
    });

    const after = onlyUpdate(
      computeSyncPlan({ source: makeSource(), tree: makeTree([deviceWithOob("10.9.9.50")]), currentServers: [owned], now: 2000 })
    );

    // The value is untouched (it already agreed with the device) and the stamp
    // now names it, so the sync owns the field from here. The opt-out is
    // unchanged and one edit away: clearing the field lands in row 2 forever.
    expect(after.ipmiHost).toBe("10.9.9.50");
    expect(after.origin?.syncedIpmiHost).toBe("10.9.9.50");
  });

  it("MATRIX ROW 5a NEVER REACHES THE OPT-OUT — a CLEARED value stays cleared whether or not the device still reports the address the stamp names (kills an equal-value rule written against the STAMP — `stamp === oob`, or the blunter `stamp !== undefined` — instead of against the record's own value, either of which re-owns and refills the field the user deliberately emptied)", () => {
    // BOTH shapes of the opt-out in one plan, because the two wrong rules fail
    // on different ones: `stamp === oob` only misfires while the device still
    // reports the old address, and `stamp !== undefined` misfires on both. A
    // fixture carrying only one of them leaves the other rule alive.
    const stampMatchesDevice = makeOwnedServer({
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedIpmiHost: "10.9.9.9" }
    });
    const stampIsStale = makeOwnedServer({
      id: deterministicServerId("source-1", "device:2"),
      name: "core-sw-2",
      origin: { sourceId: "source-1", externalId: "device:2", syncedAt: 1000, syncedIpmiHost: "10.9.9.9" }
    });
    expect(stampMatchesDevice.ipmiHost).toBeUndefined();
    expect(stampIsStale.ipmiHost).toBeUndefined();

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([
        deviceWithOob("10.9.9.9"),
        makeDevice({ externalId: "device:2", name: "core-sw-2", endpoints: [SSH, { kind: "redfish", host: "10.9.9.50" }] })
      ]),
      currentServers: [stampMatchesDevice, stampIsStale],
      now: 2000
    });

    // A correct plan has nothing to say about either server; a broken one has to
    // write the address back to produce an update at all.
    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(2);
  });

  it("MATRIX ROW 6 — endpoint ABSENT this fetch: the sync-owned value is carried forward with its stamp intact (kills 'an absent endpoint clears the field', which erases a BMC address on any NetBox data-quality blip)", () => {
    const owned = makeOwnedServer({
      ipmiHost: "10.9.9.9",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedIpmiHost: "10.9.9.9" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      // Renamed, so the plan carries an update whatever the rule does — the
      // fixture observes the FIELD, not the presence of a plan entry.
      tree: makeTree([makeDevice({ name: "core-sw-1-renamed", endpoints: [SSH] })]),
      currentServers: [owned],
      now: 2000
    });

    const after = onlyUpdate(plan);
    expect(after.ipmiHost).toBe("10.9.9.9");
    expect(after.origin?.syncedIpmiHost).toBe("10.9.9.9");
  });

  it("an ipmiHost write is enough to make an otherwise-identical server an UPDATE rather than unchanged (kills forgetting `ipmiHost` in the `changed` comparison entirely, which would compute a row-1 write and then discard it as 'unchanged')", () => {
    // Nothing else differs: same name, host, port, group, username, no auth
    // profile anywhere. The address and its stamp are the entire change.
    //
    // NOT AUTH 3a's shape, despite an earlier label saying so — the VALUE moves
    // here (undefined -> 10.9.9.9), so the value clause alone carries this
    // fixture and it would pass against an implementation that forgot the
    // stamps-equal term. AUTH 3a's genuine stamp-only shape is the row 5a
    // fixture above, where the value is identical on both sides.
    const owned = makeOwnedServer();

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([deviceWithOob()]),
      currentServers: [owned],
      now: 2000
    });

    expect(plan.updates).toHaveLength(1);
    expect(plan.unchangedCount).toBe(0);
    expect(plan.updates[0].before.ipmiHost).toBeUndefined();
    expect(plan.updates[0].after.ipmiHost).toBe("10.9.9.9");
  });

  it("the OOB write survives a retro-apply in the same plan (kills writing the stamp onto `after.origin` after the literal, which the retro-apply branch's `{ ...afterOrigin }` rebuild silently drops)", () => {
    const profile: AuthProfile = { id: "p1", name: "Fleet", username: "admin", authType: "password" };
    const owned = makeOwnedServer({ origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" } });

    const after = onlyUpdate(
      computeSyncPlan({
        source: makeSource({ authProfileId: "p1" }),
        tree: makeTree([deviceWithOob()]),
        currentServers: [owned],
        now: 2000,
        authProfile: profile
      })
    );

    // Retro-apply fired...
    expect(after.authProfileId).toBe("p1");
    expect(after.origin?.syncedAuthProfileId).toBe("p1");
    // ...and did not take the OOB stamp with it.
    expect(after.ipmiHost).toBe("10.9.9.9");
    expect(after.origin?.syncedIpmiHost).toBe("10.9.9.9");
  });

  it("SYNC-TIME VALIDATION: an out-of-band address the substitution chokepoint would refuse is warned about and NOT written, while the device's SSH mapping proceeds (kills storing a value that can never be used, and kills skipping the whole device over it)", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      // `https://10.9.9.9/` fails the address rule outright (`/` is not in the
      // charset, and a scheme is meaningless in a field substituted into a
      // command line) — the shape a NetBox custom field or a hand-edited
      // `oob_ip` can produce.
      tree: makeTree([makeDevice({ endpoints: [SSH, { kind: "redfish", host: "https://10.9.9.9/" }] })]),
      currentServers: [],
      now: 1000
    });

    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].host).toBe("10.0.0.1");
    expect(plan.adds[0].ipmiHost).toBeUndefined();
    expect(plan.adds[0].origin?.syncedIpmiHost).toBeUndefined();
    expect(plan.warnings.some((w) => w.includes("out-of-band address that cannot be used") && w.includes("https://10.9.9.9/"))).toBe(true);
  });

  it("SYNC-TIME VALIDATION on an owned server: a bad address leaves the existing sync-owned value alone rather than clearing it (kills treating a refused address as 'the device has none, so wipe it')", () => {
    const owned = makeOwnedServer({
      ipmiHost: "10.9.9.9",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedIpmiHost: "10.9.9.9" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice({ name: "core-sw-1-renamed", endpoints: [SSH, { kind: "redfish", host: "10.9.9.9 && rm -rf /" }] })]),
      currentServers: [owned],
      now: 2000
    });

    const after = onlyUpdate(plan);
    expect(after.ipmiHost).toBe("10.9.9.9");
    expect(after.origin?.syncedIpmiHost).toBe("10.9.9.9");
    expect(plan.warnings.some((w) => w.includes("out-of-band address that cannot be used"))).toBe(true);
  });
});

/**
 * ALTERNATE HOST (issue #48, Phase 2) — the provider's SECOND ssh endpoint
 * reaching `ServerConfig.altHost`, and the `ServerOrigin.syncedAltHost` stamp
 * that decides when the sync may write it.
 *
 * `altHost` is a FAITHFUL PARALLEL of `ipmiHost`: it too shipped as a
 * hand-edited field before any sync could write it (Phase 1), so it is on the
 * `syncedAuthProfileId`/`syncedIpmiHost` discipline — the stamp records what the
 * SYNC wrote, and the sync writes only where the record still carries exactly
 * that. There is one fixture per row of `syncOwnsAltHost`'s matrix below (which
 * references `syncOwnsIpmiHost`'s verbatim), each built so the WRONG rule
 * produces a visibly different plan. Unlike `ipmiHost`, `altHost` is a plain SSH
 * host and is NOT run through `isAddressValue`, so the OOB block's two
 * sync-time-validation fixtures have no `altHost` twin.
 */
describe("computeSyncPlan — altHost (alternate host, Phase 2)", () => {
  const PRIMARY = { kind: "ssh" as const, host: "10.0.0.1" };
  const ALT = { kind: "ssh" as const, host: "2001:db8::1" };

  /** A device with the primary ssh endpoint and an alternate (second) ssh endpoint. */
  function deviceWithAlt(alt = "2001:db8::1", overrides: Partial<InventoryDevice> = {}): InventoryDevice {
    return makeDevice({ endpoints: [PRIMARY, { kind: "ssh", host: alt }], ...overrides });
  }

  /** The one update this plan is expected to contain. */
  function onlyUpdate(plan: InventorySyncPlan) {
    expect(plan.updates).toHaveLength(1);
    return plan.updates[0].after;
  }

  it("ADD PATH: writes the alternate endpoint into altHost and stamps it, and stamps `undefined` when the device offers none (kills a stampless add, which reads as a hand entry on the very next sync and is never updated again)", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([deviceWithAlt(), makeDevice({ externalId: "device:2", name: "single-ip" })]),
      currentServers: [],
      now: 1000
    });

    expect(plan.adds).toHaveLength(2);
    const [withAlt, withoutAlt] = plan.adds;
    expect(withAlt.altHost).toBe("2001:db8::1");
    expect(withAlt.origin?.syncedAltHost).toBe("2001:db8::1");
    // The primary SSH mapping is untouched by any of this.
    expect(withAlt.host).toBe("10.0.0.1");
    expect(withoutAlt.altHost).toBeUndefined();
    expect(withoutAlt.origin?.syncedAltHost).toBeUndefined();
  });

  it("selects the SECOND ssh endpoint, never the first (kills a selector that maps the primary onto altHost, and kills one that takes a third-or-later endpoint)", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([
        makeDevice({
          endpoints: [PRIMARY, { kind: "ssh", host: "2001:db8::1" }, { kind: "ssh", host: "2001:db8::ffff" }]
        })
      ]),
      currentServers: [],
      now: 1000
    });

    expect(plan.adds[0].host).toBe("10.0.0.1");
    expect(plan.adds[0].altHost).toBe("2001:db8::1");
  });

  it("MATRIX ROW 1 — unset value, unset stamp, alternate present: writes and stamps (kills 'never write', which leaves the whole feature inert)", () => {
    const owned = makeOwnedServer();
    expect(owned.altHost).toBeUndefined();

    const after = onlyUpdate(
      computeSyncPlan({ source: makeSource(), tree: makeTree([deviceWithAlt()]), currentServers: [owned], now: 2000 })
    );

    expect(after.altHost).toBe("2001:db8::1");
    expect(after.origin?.syncedAltHost).toBe("2001:db8::1");
  });

  it("MATRIX ROW 2 — unset value, stamp SET (the user cleared a synced alternate): leaves it cleared and carries the stamp forward (kills a missing opt-out clause, which refills the field on every sync forever)", () => {
    const owned = makeOwnedServer({
      // The stamp is what makes this "the user emptied a value the sync wrote"
      // rather than "never configured" — the only difference from row 1's fixture.
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedAltHost: "2001:db8::1" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([deviceWithAlt()]),
      currentServers: [owned],
      now: 2000
    });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it("MATRIX ROW 1, BLANK VALUE — an empty-string altHost with no stamp is ABSENT, not hand-configured: filled and stamped (kills a strict `cur === stamp` comparison that misfiles `\"\"` as a hand edit forever)", () => {
    const owned = makeOwnedServer({ altHost: "" });

    const after = onlyUpdate(
      computeSyncPlan({ source: makeSource(), tree: makeTree([deviceWithAlt()]), currentServers: [owned], now: 2000 })
    );

    expect(after.altHost).toBe("2001:db8::1");
    expect(after.origin?.syncedAltHost).toBe("2001:db8::1");
  });

  it("MATRIX ROW 1, WHITESPACE-ONLY VALUE — same as the blank one: filled and stamped (kills a fix that only special-cases the exact empty string)", () => {
    const owned = makeOwnedServer({ altHost: "   " });

    const after = onlyUpdate(
      computeSyncPlan({ source: makeSource(), tree: makeTree([deviceWithAlt()]), currentServers: [owned], now: 2000 })
    );

    expect(after.altHost).toBe("2001:db8::1");
    expect(after.origin?.syncedAltHost).toBe("2001:db8::1");
  });

  it("MATRIX ROW 2, BLANK VALUE — a blank value WITH a stamp is still the opt-out: left blank, stamp carried forward (kills the over-fix `blank cur → the sync owns it`)", () => {
    const owned = makeOwnedServer({
      altHost: "",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedAltHost: "2001:db8::9" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      // Renamed, so an update is pushed whatever the rule does and the assertion
      // observes the FIELD rather than the mere presence of a plan entry.
      tree: makeTree([makeDevice({ name: "core-sw-1-renamed", endpoints: [PRIMARY, ALT] })]),
      currentServers: [owned],
      now: 2000
    });

    const after = onlyUpdate(plan);
    expect(after.name).toBe("core-sw-1-renamed");
    expect(after.altHost).toBe("");
    expect(after.altHost).not.toBe("2001:db8::1");
    expect(after.origin?.syncedAltHost).toBe("2001:db8::9");
  });

  it("MATRIX ROW 3 — value still equals the stamp, alternate moved: overwrites and re-stamps (kills 'never overwrite', which strands a changed alternate on its old address)", () => {
    const owned = makeOwnedServer({
      altHost: "2001:db8::1",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedAltHost: "2001:db8::1" }
    });

    const after = onlyUpdate(
      computeSyncPlan({
        source: makeSource(),
        tree: makeTree([deviceWithAlt("2001:db8::50")]),
        currentServers: [owned],
        now: 2000
      })
    );

    expect(after.altHost).toBe("2001:db8::50");
    expect(after.origin?.syncedAltHost).toBe("2001:db8::50");
  });

  it("MATRIX ROW 4 — value HAND-EDITED away from the stamp: the hand edit survives and is never laundered into the stamp (kills 'the device always wins', the host/port rule)", () => {
    const owned = makeOwnedServer({
      // The sync wrote 2001:db8::1; the user retyped it; the device now reports a
      // third value, so all three are distinct and every wrong rule lands elsewhere.
      altHost: "192.168.50.5",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedAltHost: "2001:db8::1" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice({ name: "core-sw-1-renamed", endpoints: [PRIMARY, { kind: "ssh", host: "2001:db8::50" }] })]),
      currentServers: [owned],
      now: 2000
    });

    const after = onlyUpdate(plan);
    expect(after.name).toBe("core-sw-1-renamed");
    expect(after.altHost).toBe("192.168.50.5");
    // Carried forward VERBATIM — recording the hand-edited value would make the
    // next sync read it as "still exactly what I stamped" and overwrite it.
    expect(after.origin?.syncedAltHost).toBe("2001:db8::1");
  });

  it("MATRIX ROW 5 — legacy hand-set value with NO stamp: untouched, and it does not acquire a stamp (kills 'absent stamp means the sync owns it', which clobbers every Phase-1 manual entry on the first post-upgrade sync)", () => {
    const owned = makeOwnedServer({
      altHost: "192.168.50.5",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice({ name: "core-sw-1-renamed", endpoints: [PRIMARY, ALT] })]),
      currentServers: [owned],
      now: 2000
    });

    const after = onlyUpdate(plan);
    expect(after.altHost).toBe("192.168.50.5");
    expect(after.origin?.syncedAltHost).toBeUndefined();
  });

  it("MATRIX ROW 5a — a hand-typed value that ALREADY EQUALS the device's alternate gains the stamp while the value stays put: a GENUINE stamp-only update (kills the `cur === stamp`-only gate, under which a copied-out-of-NetBox alternate can never be stamped and goes silently stale)", () => {
    const owned = makeOwnedServer({
      altHost: "2001:db8::1",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      // Nothing else moved: same name/host/port/folder/alternate. The STAMP is the
      // entire difference between `before` and `after` (AUTH 3a's shape).
      tree: makeTree([deviceWithAlt()]),
      currentServers: [owned],
      now: 2000
    });

    expect(plan.updates).toHaveLength(1);
    expect(plan.unchangedCount).toBe(0);
    const { before, after } = plan.updates[0];
    expect(before.altHost).toBe("2001:db8::1");
    expect(after.altHost).toBe("2001:db8::1");
    expect(before.origin?.syncedAltHost).toBeUndefined();
    expect(after.origin?.syncedAltHost).toBe("2001:db8::1");
  });

  it("MATRIX ROW 5a, WHAT THE STAMP THEN BUYS — once stamped, the same record follows the alternate to its new address on the next sync (row 3); without the stamp it is stuck forever", () => {
    const owned = makeOwnedServer({
      altHost: "2001:db8::1",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" }
    });

    const stamped = onlyUpdate(
      computeSyncPlan({ source: makeSource(), tree: makeTree([deviceWithAlt()]), currentServers: [owned], now: 2000 })
    );
    expect(stamped.origin?.syncedAltHost).toBe("2001:db8::1");

    // Feeding sync one's OUTPUT back in is the point: the repair must survive.
    const followed = onlyUpdate(
      computeSyncPlan({ source: makeSource(), tree: makeTree([deviceWithAlt("2001:db8::50")]), currentServers: [stamped], now: 3000 })
    );
    expect(followed.altHost).toBe("2001:db8::50");
    expect(followed.origin?.syncedAltHost).toBe("2001:db8::50");
  });

  it("MATRIX ROW 5a NEVER REACHES THE OPT-OUT — a CLEARED value stays cleared whether or not the device still reports the address the stamp names (kills an equal-value rule written against the STAMP instead of the record's own value)", () => {
    const stampMatchesDevice = makeOwnedServer({
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedAltHost: "2001:db8::1" }
    });
    const stampIsStale = makeOwnedServer({
      id: deterministicServerId("source-1", "device:2"),
      name: "core-sw-2",
      origin: { sourceId: "source-1", externalId: "device:2", syncedAt: 1000, syncedAltHost: "2001:db8::1" }
    });
    expect(stampMatchesDevice.altHost).toBeUndefined();
    expect(stampIsStale.altHost).toBeUndefined();

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([
        deviceWithAlt("2001:db8::1"),
        makeDevice({ externalId: "device:2", name: "core-sw-2", endpoints: [PRIMARY, { kind: "ssh", host: "2001:db8::50" }] })
      ]),
      currentServers: [stampMatchesDevice, stampIsStale],
      now: 2000
    });

    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(2);
  });

  it("MATRIX ROW 6 — alternate ABSENT this fetch: the sync-owned value is carried forward with its stamp intact (kills 'an absent alternate clears the field')", () => {
    const owned = makeOwnedServer({
      altHost: "2001:db8::1",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedAltHost: "2001:db8::1" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      // Renamed, single ssh endpoint (no alternate), so the plan carries an update
      // whatever the rule does — the fixture observes the FIELD.
      tree: makeTree([makeDevice({ name: "core-sw-1-renamed", endpoints: [PRIMARY] })]),
      currentServers: [owned],
      now: 2000
    });

    const after = onlyUpdate(plan);
    expect(after.altHost).toBe("2001:db8::1");
    expect(after.origin?.syncedAltHost).toBe("2001:db8::1");
  });

  // A first-seen alternate is SURFACED as an update (it does not vanish into
  // unchangedCount). This is TRUE via the `syncedAltHost` stamp write — every
  // altHost value write also writes its stamp, and `!serverOriginStampsEqual`
  // alone already flags the update — so the fixture asserts exactly that: the
  // field is written AND the plan reports it. It does NOT claim to "kill omitting
  // `altHost` from the `changed` comparator": removing that one clause leaves this
  // (and every altHost fixture) green, because the stamp change re-flags the row.
  // The value clause is defense-in-depth that no fixture can isolate today — every
  // matrix altHost write re-stamps, and the stamp comparator covers stamps — but
  // it guards the implicit "value write ⇒ stamp write" invariant against a future
  // path that writes a value without a stamp (mirror of `updateStillChanged`'s
  // "unexploitable today" note in syncEngine.ts).
  it("a first-seen synced altHost value is surfaced as an update, not folded into unchangedCount", () => {
    const owned = makeOwnedServer();

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([deviceWithAlt()]),
      currentServers: [owned],
      now: 2000
    });

    expect(plan.updates).toHaveLength(1);
    expect(plan.unchangedCount).toBe(0);
    expect(plan.updates[0].before.altHost).toBeUndefined();
    expect(plan.updates[0].after.altHost).toBe("2001:db8::1");
  });

  it("the alternate write survives a retro-apply in the same plan (kills writing the stamp onto `after.origin` after the literal, which the retro-apply branch's `{ ...afterOrigin }` rebuild silently drops)", () => {
    const authProfile: AuthProfile = { id: "p1", name: "Fleet", username: "admin", authType: "password" };
    const owned = makeOwnedServer({ origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedUsername: "admin" } });

    const after = onlyUpdate(
      computeSyncPlan({
        source: makeSource({ authProfileId: "p1" }),
        tree: makeTree([deviceWithAlt()]),
        currentServers: [owned],
        now: 2000,
        authProfile
      })
    );

    // Retro-apply fired...
    expect(after.authProfileId).toBe("p1");
    expect(after.origin?.syncedAuthProfileId).toBe("p1");
    // ...and did not take the alternate-host stamp with it.
    expect(after.altHost).toBe("2001:db8::1");
    expect(after.origin?.syncedAltHost).toBe("2001:db8::1");
  });

  // M3a — `selectAltEndpoint` must pick the first ssh endpoint whose host DIFFERS
  // from the primary, not merely "the second ssh endpoint". A third-party provider
  // emitting two IDENTICAL ssh endpoints must NOT yield `altHost === host`.
  // Against 0f9e47b the `[1]`-after-filter selected the duplicate and the add
  // persisted a self-duplicate `altHost` equal to `host`.
  it("M3a — two IDENTICAL ssh endpoints yield NO altHost (never a self-duplicate altHost === host)", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([
        makeDevice({ endpoints: [PRIMARY, { kind: "ssh", host: "10.0.0.1" }] })
      ]),
      currentServers: [],
      now: 1000
    });

    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].host).toBe("10.0.0.1");
    // The duplicate is rejected — no dangling altHost, and no stamp for one.
    expect(plan.adds[0].altHost).toBeUndefined();
    expect(plan.adds[0].origin?.syncedAltHost).toBeUndefined();
  });

  it("M3a — a distinct alternate is still selected even when an identical duplicate precedes it", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([
        // primary, an identical duplicate of the primary, then a genuinely
        // different address: the first DIFFERING host wins, not the second slot.
        makeDevice({ endpoints: [PRIMARY, { kind: "ssh", host: "10.0.0.1" }, { kind: "ssh", host: "2001:db8::1" }] })
      ]),
      currentServers: [],
      now: 1000
    });

    expect(plan.adds[0].host).toBe("10.0.0.1");
    expect(plan.adds[0].altHost).toBe("2001:db8::1");
  });

  // M3b — the pure-carry route to `altHost === host`: a sync-owned server carrying
  // an alternate, whose device loses its second address family so the primary
  // `host` flips to the value the carried `altHost` was still holding. The engine
  // must drop the now-duplicate `altHost` and clear its stamp rather than persist a
  // dangling `altHost === host`. Against 0f9e47b row 6 carried the alternate forward
  // and `after.altHost` was left equal to `after.host`.
  it("M3b — host flips to the carried altHost's value: the duplicate altHost is dropped and its stamp cleared", () => {
    const owned = makeOwnedServer({
      host: "10.0.0.1",
      altHost: "2001:db8::1",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedAltHost: "2001:db8::1" }
    });

    const after = onlyUpdate(
      computeSyncPlan({
        source: makeSource(),
        // The device now reports a SINGLE ssh endpoint at what used to be the
        // alternate address — its second family is gone, so `host` becomes
        // "2001:db8::1" and the old carried `altHost` would duplicate it.
        tree: makeTree([makeDevice({ endpoints: [{ kind: "ssh", host: "2001:db8::1" }] })]),
        currentServers: [owned],
        now: 2000
      })
    );

    expect(after.host).toBe("2001:db8::1");
    // The duplicate is dropped, not persisted, and its stamp goes with it.
    expect(after.altHost).toBeUndefined();
    expect(after.origin?.syncedAltHost).toBeUndefined();
  });

  // P2 (PR #67 Codex round 1) — the drop must be PROVENANCE-GATED: a HAND-entered
  // `altHost` (no `syncedAltHost` stamp) that a device later reports as its new
  // primary must be PRESERVED, never deleted — hand edits are untouched, and
  // clearing it would permanently lose the user's fallback if the primary flips
  // back with no provider-supplied alternate. Against the unconditional drop this
  // hand value was wiped.
  it("P2 — a HAND-entered altHost the device reports as its new primary is PRESERVED, not dropped (provenance gate)", () => {
    const owned = makeOwnedServer({
      host: "10.0.0.1",
      altHost: "2001:db8::1", // hand-entered
      // Origin carries NO syncedAltHost — the sync does not own this altHost.
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000 }
    });

    const after = onlyUpdate(
      computeSyncPlan({
        source: makeSource(),
        tree: makeTree([makeDevice({ endpoints: [{ kind: "ssh", host: "2001:db8::1" }] })]),
        currentServers: [owned],
        now: 2000
      })
    );

    expect(after.host).toBe("2001:db8::1");
    // Hand value untouched even though it now equals `host`; the sync never owned it.
    expect(after.altHost).toBe("2001:db8::1");
  });
});

/**
 * TELNET (Phase 0) — inventory contract. A device that offers a telnet console
 * and no SSH maps to a telnet server; one that offers both stays SSH. The
 * `syncedProtocol` stamp follows the `syncedAltHost` / `syncedIpmiHost`
 * discipline verbatim: the sync owns the field only while the record still
 * carries exactly what the sync put there (or exactly what the device says
 * today), and a hand-flipped protocol is never stomped.
 */
describe("computeSyncPlan — telnet endpoints", () => {
  const telnetDevice = (overrides: Partial<InventoryDevice> = {}) =>
    makeDevice({ endpoints: [{ kind: "telnet", host: "10.0.0.5" }], ...overrides });

  it("maps a telnet-only device to a telnet server on the telnet default port", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([telnetDevice()]),
      currentServers: [],
      now: 1000
    });

    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].protocol).toBe("telnet");
    expect(plan.adds[0].host).toBe("10.0.0.5");
    // ⊘ An implementation that reuses the SSH default lands every telnet
    // console on port 22, where nothing is listening.
    expect(plan.adds[0].port).toBe(23);
    expect(plan.adds[0].origin?.syncedProtocol).toBe("telnet");
  });

  it("honours an explicit port on a telnet endpoint", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([telnetDevice({ endpoints: [{ kind: "telnet", host: "10.0.0.5", port: 2001 }] })]),
      currentServers: [],
      now: 1000
    });
    expect(plan.adds[0].port).toBe(2001);
  });

  // ⊘ THE PRIMARY RULE. A selector that simply took the first endpoint of
  // either kind would make this device telnet, because the telnet endpoint is
  // listed first.
  it("gives SSH the primary slot when a device offers both", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([
        makeDevice({
          endpoints: [
            { kind: "telnet", host: "10.0.0.5" },
            { kind: "ssh", host: "10.0.0.1" }
          ]
        })
      ]),
      currentServers: [],
      now: 1000
    });

    expect(plan.adds[0].protocol).toBeUndefined();
    expect(plan.adds[0].host).toBe("10.0.0.1");
    expect(plan.adds[0].port).toBe(22);
    expect(plan.adds[0].origin?.syncedProtocol).toBeUndefined();
  });

  it("creates an addressless placeholder for a device that offers neither ssh nor telnet (a url-only console)", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice({ endpoints: [{ kind: "url", host: "https://example" }] })]),
      currentServers: [],
      now: 1000
    });
    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].addressless).toBe(true);
  });

  it("switches an owned server to telnet when the device stops offering SSH", () => {
    const before = makeOwnedServer();
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([telnetDevice()]),
      currentServers: [before],
      now: 2000
    });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].after.protocol).toBe("telnet");
    expect(plan.updates[0].after.origin?.syncedProtocol).toBe("telnet");
  });

  // ⊘ THE STAMP DISCRIMINATOR. The sync wrote telnet; the user switched the
  // record back to SSH by hand. The device STILL reports telnet only, so a
  // "device always wins" implementation flips it back on the very next sync —
  // and the fixture is built so that stomping visibly changes the outcome
  // (protocol telnet vs ssh), not so that both paths agree.
  it("does NOT stomp a protocol the user changed by hand", () => {
    const before = makeOwnedServer({
      host: "10.0.0.5",
      port: 23,
      protocol: undefined, // the user switched it back to SSH
      origin: {
        sourceId: "source-1",
        externalId: "device:1",
        syncedAt: 1000,
        syncedProtocol: "telnet"
      }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([telnetDevice()]),
      currentServers: [before],
      now: 2000
    });

    const after = plan.updates[0]?.after ?? before;
    expect(after.protocol).toBeUndefined();
    // The stamp is carried forward VERBATIM, not re-derived from the record —
    // laundering it into "ssh" would let the sync after this one overwrite the
    // user's choice.
    expect(after.origin?.syncedProtocol).toBe("telnet");
  });

  it("does NOT stomp a hand-set telnet protocol back to SSH", () => {
    const before = makeOwnedServer({
      protocol: "telnet",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedProtocol: undefined }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice()]), // device offers SSH
      currentServers: [before],
      now: 2000
    });

    const after = plan.updates[0]?.after ?? before;
    expect(after.protocol).toBe("telnet");
  });

  it("re-takes ownership when the record still carries exactly what the sync wrote", () => {
    const before = makeOwnedServer({
      host: "10.0.0.5",
      port: 23,
      protocol: "telnet",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedProtocol: "telnet" }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice()]), // the device gained an SSH endpoint
      currentServers: [before],
      now: 2000
    });

    expect(plan.updates[0].after.protocol).toBeUndefined();
    expect(plan.updates[0].after.origin?.syncedProtocol).toBeUndefined();
  });

  it("stamps a legacy owned server whose protocol already agrees with the device", () => {
    const before = makeOwnedServer({
      host: "10.0.0.5",
      port: 23,
      protocol: "telnet",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000 }
    });

    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([telnetDevice()]),
      currentServers: [before],
      now: 2000
    });

    // Stamp-only change: the value does not move, but ownership is recorded so
    // the field can follow the device the next time it changes.
    expect(plan.updates[0].after.protocol).toBe("telnet");
    expect(plan.updates[0].after.origin?.syncedProtocol).toBe("telnet");
  });
});

/**
 * MAJOR-2 (review) — THE WRITER AND THE VALIDATOR MUST AGREE. A record the sync
 * writes that `validateServerConfig` rejects is dropped by
 * `VscodeConfigRepository.getServers()` with only a console warning: the user
 * watches the server sync in, work for the rest of the session, and silently
 * vanish on the next reload — forever, on every re-sync.
 */
describe("computeSyncPlan — every telnet record it writes must validate", () => {
  const telnetTree = () =>
    makeTree([makeDevice({ externalId: "d1", name: "console-1", endpoints: [{ kind: "telnet", host: "10.0.0.5" }] })]);

  // ⊘ The discriminator is the SOURCE with no `defaultUsername`: telnet
  // endpoints legitimately carry no username (console servers, lab gear), so
  // `endpoint.username ?? source.defaultUsername` is `undefined` and the record
  // the sync just wrote fails the guard that decides whether it survives a
  // reload. A fixture with a default username passes either way and proves
  // nothing.
  it("writes a valid record for a telnet device when the source has no default username", () => {
    const source = makeSource({ defaultUsername: undefined as unknown as string });
    const plan = computeSyncPlan({ source, tree: telnetTree(), currentServers: [], now: 1000 });

    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0].protocol).toBe("telnet");
    expect(validateServerConfig(plan.adds[0])).toBe(true);
  });

  it("writes a valid record for a telnet device when the source's default username is blank", () => {
    const source = makeSource({ defaultUsername: "" });
    const plan = computeSyncPlan({ source, tree: telnetTree(), currentServers: [], now: 1000 });
    expect(validateServerConfig(plan.adds[0])).toBe(true);
  });

  it("keeps SSH records subject to the unchanged username rule", () => {
    // An SSH device with no username anywhere is still an invalid record — the
    // relaxation must be scoped to telnet, not a general loosening.
    const source = makeSource({ defaultUsername: undefined as unknown as string });
    const plan = computeSyncPlan({ source, tree: makeTree([makeDevice()]), currentServers: [], now: 1000 });
    expect(plan.adds[0].protocol).toBeUndefined();
    expect(validateServerConfig(plan.adds[0])).toBe(false);
  });

  // MINOR-8 — the "no silent drops" guarantee, stated as a property over every
  // record a telnet sync produces rather than over one hand-picked fixture.
  it("produces only valid records across adds, updates and adoptions", () => {
    const source = makeSource({ defaultUsername: undefined as unknown as string });
    const owned = makeOwnedServer({ host: "10.0.0.5", port: 23, username: "" });
    const tree = makeTree([
      makeDevice({ endpoints: [{ kind: "telnet", host: "10.0.0.5" }] }),
      makeDevice({ externalId: "d2", name: "console-2", endpoints: [{ kind: "telnet", host: "10.0.0.6", port: 2002 }] })
    ]);
    const plan = computeSyncPlan({ source, tree, currentServers: [owned], now: 2000 });

    const written = [...plan.adds, ...plan.updates.map((u) => u.after)];
    expect(written.length).toBeGreaterThan(0);
    for (const record of written) {
      expect(validateServerConfig(record), `sync wrote an invalid record: ${JSON.stringify(record)}`).toBe(true);
    }
  });
});

/**
 * P1-C (Codex) — the protocol and the endpoint tuple must be decided TOGETHER.
 *
 * `takesProtocol` could answer "the user owns this protocol, leave it telnet"
 * while `host`/`port` were taken unconditionally from the inventory-selected
 * endpoint — which for a dual-stack device is the SSH one. The next sync then
 * produced a telnet profile pointed at port 22: a record that cannot connect,
 * assembled out of two individually-correct decisions.
 */
describe("computeSyncPlan — protocol and endpoint are decided coherently", () => {
  const dualStack = () =>
    makeDevice({
      endpoints: [
        { kind: "ssh", host: "10.0.0.1" },
        { kind: "telnet", host: "10.0.0.5", port: 2001 }
      ]
    });

  /** An owned server the user hand-switched to telnet (no stamp ⇒ hand-owned). */
  const handTelnet = (overrides: Partial<ServerConfig> = {}) =>
    makeOwnedServer({
      protocol: "telnet",
      host: "10.0.0.5",
      port: 2001,
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000 },
      ...overrides
    });

  // ⊘ THE FINDING. Pre-fix this produced `{ protocol: "telnet", host: "10.0.0.1",
  // port: 22 }` — the SSH endpoint's tuple under a telnet protocol. The fixture
  // gives the device BOTH endpoints at DIFFERENT addresses and ports, so a
  // mismatched pick is visible in every field.
  it("follows the telnet endpoint for a hand-telnet server on a dual-endpoint device", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([dualStack()]),
      currentServers: [handTelnet({ host: "10.0.0.9", port: 23 })],
      now: 2000
    });

    expect(plan.updates).toHaveLength(1);
    const after = plan.updates[0].after;
    expect(after.protocol).toBe("telnet");
    expect(after.host).toBe("10.0.0.5");
    expect(after.port).toBe(2001);
  });

  // ⊘ The conservative half: the device offers no telnet endpoint at all, so
  // there is no address to follow. Overwriting host/port from the SSH endpoint
  // would leave a telnet profile aimed at the SSH port — the exact broken record
  // this finding is about — so the tuple is left ALONE.
  it("leaves a hand-telnet server's address alone when the device offers no telnet endpoint", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice({ endpoints: [{ kind: "ssh", host: "10.0.0.1" }] })]),
      currentServers: [handTelnet({ host: "10.0.0.9", port: 23 })],
      now: 2000
    });

    const after = plan.updates[0]?.after;
    if (after) {
      expect(after.protocol).toBe("telnet");
      expect(after.host).toBe("10.0.0.9");
      expect(after.port).toBe(23);
    }
    // Whether or not an update is emitted, the record must never end up telnet
    // on the SSH endpoint's tuple.
    expect(after?.host).not.toBe("10.0.0.1");
    expect(after?.port).not.toBe(22);
  });

  it("mirrors the rule for a hand-SSH server on a telnet-only device", () => {
    const owned = makeOwnedServer({
      protocol: undefined,
      host: "10.0.0.9",
      port: 22,
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, syncedProtocol: "telnet" }
    });
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice({ endpoints: [{ kind: "telnet", host: "10.0.0.5" }] })]),
      currentServers: [owned],
      now: 2000
    });

    const after = plan.updates[0]?.after;
    // The user owns "ssh"; the device offers only telnet, so nothing to follow.
    expect(after?.protocol ?? owned.protocol).toBeUndefined();
    expect(after?.host ?? owned.host).toBe("10.0.0.9");
    expect(after?.port ?? owned.port).toBe(22);
  });

  // CONTROL — a sync-owned server still follows the device exactly as before,
  // so the fix is scoped to the hand-owned case and has not frozen addresses.
  it("still moves a sync-owned server's address and protocol with the device", () => {
    const owned = makeOwnedServer({
      host: "10.0.0.99",
      port: 22,
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000 }
    });
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice({ endpoints: [{ kind: "telnet", host: "10.0.0.5" }] })]),
      currentServers: [owned],
      now: 2000
    });

    const after = plan.updates[0].after;
    expect(after.protocol).toBe("telnet");
    expect(after.host).toBe("10.0.0.5");
    expect(after.port).toBe(23);
  });

  it("still follows the SSH endpoint for an ordinary sync-owned SSH server", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([dualStack()]),
      currentServers: [makeOwnedServer({ host: "10.0.0.99" })],
      now: 2000
    });

    const after = plan.updates[0].after;
    expect(after.protocol).toBeUndefined();
    expect(after.host).toBe("10.0.0.1");
    expect(after.port).toBe(22);
  });
});

describe("validateInventoryTree — telnet endpoint kind", () => {
  it("accepts a device whose only endpoint is telnet", () => {
    expect(() =>
      validateInventoryTree({
        contractVersion: 1,
        devices: [{ externalId: "d1", name: "r1", endpoints: [{ kind: "telnet", host: "10.0.0.5", port: 2001 }] }]
      })
    ).not.toThrow();
  });

  // ⊘ A tree that validates but whose telnet endpoint is dropped on the way
  // through would pass the assertion above and still be useless.
  it("carries the accepted telnet endpoint all the way to a mapped server", () => {
    const plan = computeSyncPlan({
      source: makeSource(),
      tree: makeTree([makeDevice({ endpoints: [{ kind: "telnet", host: "10.0.0.5", port: 2001 }] })]),
      currentServers: [],
      now: 1000
    });
    expect(plan.adds[0]).toEqual(expect.objectContaining({ host: "10.0.0.5", port: 2001, protocol: "telnet" }));
  });
});
