import { describe, expect, it, vi } from "vitest";
import { InventorySourceRemovalMismatchError, NexusCore, type InventorySyncApplication } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { validateInventorySource, validateServerConfig } from "../../src/utils/validation";
import type { ServerConfig, SerialProfile, LocalShellProfile } from "../../src/models/config";
import { computeProviderFingerprint, type InventoryProvider, type InventorySourceConfig } from "../../src/models/inventory";

function makeSourceConfig(overrides: Partial<InventorySourceConfig> = {}): InventorySourceConfig {
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

describe("NexusCore inventory sources", () => {
  it("round-trips inventory sources through the repository; a second core on the same repo also sees them (kills missing persistence/exposure)", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());

    expect(core.getSnapshot().inventorySources).toHaveLength(1);
    expect(core.getInventorySource("source-1")?.name).toBe("NetBox");

    const core2 = new NexusCore(repository);
    await core2.initialize();
    expect(core2.getSnapshot().inventorySources).toHaveLength(1);
    expect(core2.getInventorySource("source-1")?.name).toBe("NetBox");
  });

  it("applyInventorySyncPlan performs exactly one saveServers call, exactly one saveGroups call, and one emission (kills a per-server loop)", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());

    const saveServersSpy = vi.spyOn(repository, "saveServers");
    const saveGroupsSpy = vi.spyOn(repository, "saveGroups");
    const listener = vi.fn();
    core.onDidChange(listener);

    const server: ServerConfig = {
      id: "srv-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000 }
    };
    const application: InventorySyncApplication = {
      sourceId: "source-1",
      syncedAt: 1000,
      upsertServers: [server],
      removeServerIds: ["does-not-exist"],
      folders: ["NetBox/RackA"],
      expectedSource: makeSourceConfig()
    };
    await core.applyInventorySyncPlan(application);

    expect(saveServersSpy).toHaveBeenCalledTimes(1);
    expect(saveGroupsSpy).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.explicitGroups).toEqual(expect.arrayContaining(["NetBox", "NetBox/RackA"]));
  });

  it("folder ancestors: 'A/B/C' registers A, A/B, and A/B/C — and a reload from a second core confirms they were actually persisted (kills missing getAncestorPaths / never-persisting-folders)", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());

    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1000,
      upsertServers: [],
      removeServerIds: [],
      folders: ["A/B/C"],
      expectedSource: makeSourceConfig()
    });

    expect(core.getSnapshot().explicitGroups).toEqual(expect.arrayContaining(["A", "A/B", "A/B/C"]));

    const core2 = new NexusCore(repository);
    await core2.initialize();
    expect(core2.getSnapshot().explicitGroups).toEqual(expect.arrayContaining(["A", "A/B", "A/B/C"]));
  });

  it("removing a server via applyInventorySyncPlan drops its active sessions and clears focus (kills plain delete without removeServerSessions)", async () => {
    const repository = new InMemoryConfigRepository([
      { id: "srv-1", name: "s", host: "h", port: 22, username: "u", authType: "agent", isHidden: false }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());
    core.registerSession({ id: "session-1", serverId: "srv-1", terminalName: "Nexus SSH: s", startedAt: Date.now() });
    core.setFocusedSession("session-1");

    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1000,
      upsertServers: [],
      removeServerIds: ["srv-1"],
      folders: [],
      expectedSource: makeSourceConfig()
    });

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(0);
    expect(snapshot.activeSessions).toHaveLength(0);
    expect(snapshot.focusedSessionId).toBeUndefined();
  });

  it("(F12) writes lastSyncAt on the applied source only — a second source's lastSyncAt is untouched", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig({ id: "source-1", lastSyncAt: 100 }));
    await core.addOrUpdateInventorySource(makeSourceConfig({ id: "source-2", lastSyncAt: 200 }));

    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 5000,
      upsertServers: [],
      removeServerIds: [],
      folders: [],
      expectedSource: makeSourceConfig({ id: "source-1" })
    });

    expect(core.getInventorySource("source-1")?.lastSyncAt).toBe(5000);
    expect(core.getInventorySource("source-2")?.lastSyncAt).toBe(200);
  });

  it("an empty application still bumps lastSyncAt, persists it, and emits exactly once (kills early-return on empty)", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());
    const listener = vi.fn();
    core.onDidChange(listener);

    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 4242,
      upsertServers: [],
      removeServerIds: [],
      folders: [],
      expectedSource: makeSourceConfig()
    });

    expect(core.getInventorySource("source-1")?.lastSyncAt).toBe(4242);
    expect(listener).toHaveBeenCalledTimes(1);

    const core2 = new NexusCore(repository);
    await core2.initialize();
    expect(core2.getInventorySource("source-1")?.lastSyncAt).toBe(4242);
  });

  it("removeInventorySource removes only the source record, leaving servers it created untouched (kills a cascading core method)", async () => {
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s",
        host: "h",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
      }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());

    await core.removeInventorySource("source-1");

    expect(core.getInventorySource("source-1")).toBeUndefined();
    expect(core.getSnapshot().servers).toHaveLength(1);
  });

  it("(F4) applyInventorySyncPlan throws for an unknown sourceId, mutating no server and emitting nothing", async () => {
    const repository = new InMemoryConfigRepository();
    const saveServersSpy = vi.spyOn(repository, "saveServers");
    const core = new NexusCore(repository);
    await core.initialize();
    const listener = vi.fn();
    core.onDidChange(listener);

    const server: ServerConfig = { id: "srv-1", name: "s", host: "h", port: 22, username: "u", authType: "agent", isHidden: false };
    await expect(
      core.applyInventorySyncPlan({
        sourceId: "does-not-exist",
        syncedAt: 1,
        upsertServers: [server],
        removeServerIds: [],
        folders: [],
        expectedSource: makeSourceConfig({ id: "does-not-exist" })
      })
    ).rejects.toThrow();

    expect(core.getSnapshot().servers).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
    expect(saveServersSpy).not.toHaveBeenCalled();
  });

  it("(FINDING A) addOrUpdateInventorySource on a rejected persist rolls back a brand-new source — it does not appear in the snapshot (kills mutate-then-leak)", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    vi.spyOn(repository, "saveInventorySources").mockRejectedValueOnce(new Error("disk full"));

    await expect(core.addOrUpdateInventorySource(makeSourceConfig())).rejects.toThrow("disk full");

    // If the fix were reverted (mutate-then-await, no rollback), the map would
    // still hold the new entry here even though persistence failed.
    expect(core.getInventorySource("source-1")).toBeUndefined();
    expect(core.getSnapshot().inventorySources).toHaveLength(0);
  });

  it("(FINDING A) addOrUpdateInventorySource on a rejected persist restores the PRE-UPDATE source — an edit's old value survives (kills mutate-then-leak on update)", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig({ name: "Original", targetFolder: "Old" }));

    vi.spyOn(repository, "saveInventorySources").mockRejectedValueOnce(new Error("disk full"));
    await expect(
      core.addOrUpdateInventorySource(makeSourceConfig({ name: "Updated", targetFolder: "New" }))
    ).rejects.toThrow("disk full");

    // If the fix were reverted, the in-memory map would keep the rejected
    // "Updated"/"New" values even though the persist never took effect.
    const current = core.getInventorySource("source-1");
    expect(current?.name).toBe("Original");
    expect(current?.targetFolder).toBe("Old");
  });

  it("(FINDING A) removeInventorySource on a rejected persist restores the deleted entry (kills delete-then-leak)", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());

    vi.spyOn(repository, "saveInventorySources").mockRejectedValueOnce(new Error("disk full"));
    await expect(core.removeInventorySource("source-1")).rejects.toThrow("disk full");

    // If the fix were reverted, the entry would stay deleted in memory even
    // though the command layer's secret-cleanup only runs after a resolved
    // removeInventorySource — leaving it permanently unrecoverable in-process.
    expect(core.getInventorySource("source-1")).toBeDefined();
    expect(core.getSnapshot().inventorySources).toHaveLength(1);
  });

  it("(FINDING E) applyInventorySyncPlan throws when the current source record no longer matches expectedSource, mutating and persisting nothing (kills an exists-only check)", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    const staleSnapshot = makeSourceConfig({ targetFolder: "Original" });
    await core.addOrUpdateInventorySource(staleSnapshot);
    // Simulate a replace-mode config import racing the sync: same id, but the
    // record's targetFolder (and thus the plan computed against it) is stale.
    await core.addOrUpdateInventorySource(makeSourceConfig({ targetFolder: "Different" }));

    const saveServersSpy = vi.spyOn(repository, "saveServers");
    const listener = vi.fn();
    core.onDidChange(listener);

    const server: ServerConfig = { id: "srv-1", name: "s", host: "h", port: 22, username: "u", authType: "agent", isHidden: false };
    await expect(
      core.applyInventorySyncPlan({
        sourceId: "source-1",
        syncedAt: 1,
        upsertServers: [server],
        removeServerIds: [],
        folders: [],
        expectedSource: staleSnapshot // the fetch-time snapshot, now stale
      })
    ).rejects.toThrow(/configuration changed/);

    // If the fix were reverted to an exists-only check, this would have
    // applied: the server would be added and lastSyncAt bumped.
    expect(core.getSnapshot().servers).toHaveLength(0);
    expect(core.getInventorySource("source-1")?.lastSyncAt).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    expect(saveServersSpy).not.toHaveBeenCalled();
  });

  it('(REORDER) applyInventorySyncPlan with expectedSource "absent" succeeds when no record exists for sourceId, mutates servers, and does not write a source-record entry (kills an unguarded/incorrectly-blocked absent apply)', async () => {
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s",
        host: "h",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
      }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    // Deliberately no addOrUpdateInventorySource("source-1") — the record is
    // absent, mirroring removeSource calling this AFTER removeInventorySource.
    const listener = vi.fn();
    core.onDidChange(listener);

    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 9999,
      upsertServers: [],
      removeServerIds: ["srv-1"],
      folders: [],
      expectedSource: "absent"
    });

    // Server disposition still applied.
    expect(core.getSnapshot().servers).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(1);
    // No source-record entry was created for the absent id (no lastSyncAt to
    // bump, nothing to enumerate).
    expect(core.getInventorySource("source-1")).toBeUndefined();
    expect(core.getSnapshot().inventorySources).toHaveLength(0);

    // If a wrong implementation ignored "absent" and treated it like a normal
    // apply (or simply skipped the presence semantics entirely), the fetch
    // above of core.getInventorySource("source-1") could still read
    // undefined by coincidence — the disposition mutating servers despite
    // no source ever existing is the assertion that actually exercises the
    // "absent" branch rather than an early throw.
  });

  it('(REORDER) applyInventorySyncPlan with expectedSource "absent" THROWS without mutating when a record still exists for sourceId (kills an unguarded absent-apply that would run a stale disposition against a recreated source\'s servers)', async () => {
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s",
        host: "h",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
      }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    // A replace-mode import recreated "source-1" between the caller's
    // removeInventorySource call and this apply.
    await core.addOrUpdateInventorySource(makeSourceConfig({ id: "source-1", name: "Recreated" }));

    const saveServersSpy = vi.spyOn(repository, "saveServers");
    const listener = vi.fn();
    core.onDidChange(listener);

    await expect(
      core.applyInventorySyncPlan({
        sourceId: "source-1",
        syncedAt: 9999,
        upsertServers: [],
        removeServerIds: ["srv-1"],
        folders: [],
        expectedSource: "absent"
      })
    ).rejects.toThrow();

    // If the fix were reverted (absent-apply proceeds unconditionally, or
    // treats "absent" the same as a normal expectedSource comparison that
    // happens to be skipped), the recreated source's own server would be
    // wrongly deleted here.
    expect(core.getSnapshot().servers).toHaveLength(1);
    expect(core.getServer("srv-1")?.origin?.sourceId).toBe("source-1");
    expect(core.getInventorySource("source-1")?.name).toBe("Recreated");
    expect(listener).not.toHaveBeenCalled();
    expect(saveServersSpy).not.toHaveBeenCalled();
  });

  it('(FINDING 2) absent-mode apply SKIPS a removeServerIds entry whose current owner is a DIFFERENT source — the server survives, and the skip is counted (kills a stale-owned delete)', async () => {
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s",
        host: "h",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        // Recreated by a NEW import under a DIFFERENT source id, landing in
        // the window between removeInventorySource and this stale
        // "absent"-mode disposition apply for the OLD source.
        origin: { sourceId: "source-2", externalId: "device:1", syncedAt: 999 }
      }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    const listener = vi.fn();
    core.onDidChange(listener);

    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 9999,
      upsertServers: [],
      removeServerIds: ["srv-1"],
      folders: [],
      expectedSource: "absent"
    });

    // If FINDING 2's fix were reverted (removeServerIds honored
    // unconditionally in "absent" mode), srv-1 — now owned by source-2 —
    // would be wrongly deleted here.
    expect(core.getServer("srv-1")).toBeDefined();
    expect(core.getServer("srv-1")?.origin?.sourceId).toBe("source-2");
    expect(result.skippedCount).toBe(1);
    // The apply itself still "succeeds" (bucket saves happen, one emission) —
    // it just did nothing for this stale entry.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('(FINDING 4) absent-mode apply SKIPS a removeServerIds entry whose current record differs from its captured expectedBefore snapshot — SAME id, SAME origin.sourceId, but a REPLACEMENT (different host) — the server survives and the skip is counted (kills a sourceId-ownership-only delete check)', async () => {
    const capturedBefore: ServerConfig = {
      id: "srv-1",
      name: "old-name",
      host: "10.0.0.1",
      port: 22,
      username: "u",
      authType: "agent",
      isHidden: false,
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const replaced: ServerConfig = {
      ...capturedBefore,
      host: "10.0.0.99", // a NEW import re-mapped this SAME id (still owned by source-1) to a different device
      origin: { sourceId: "source-1", externalId: "device:99", syncedAt: 500 }
    };
    const repository = new InMemoryConfigRepository([replaced]);
    const core = new NexusCore(repository);
    await core.initialize();
    const listener = vi.fn();
    core.onDidChange(listener);

    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 9999,
      upsertServers: [],
      removeServerIds: ["srv-1"],
      folders: [],
      expectedSource: "absent",
      expectedBeforeByServerId: new Map([["srv-1", capturedBefore]])
    });

    // If FINDING 4's fix were reverted (removeServerIds validated by
    // origin.sourceId ownership alone, ignoring expectedBeforeByServerId),
    // this delete target would be honored — same id, same origin.sourceId —
    // and the REPLACEMENT server (host 10.0.0.99, a different device this
    // stale removal was never computed against) would be wrongly deleted.
    expect(core.getServer("srv-1")).toBeDefined();
    expect(core.getServer("srv-1")?.host).toBe("10.0.0.99");
    expect(core.getServer("srv-1")?.origin?.externalId).toBe("device:99");
    expect(result.skippedCount).toBe(1);
    expect(result.removedServerIds).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('(FINDING 4) absent-mode apply still deletes a removeServerIds entry whose current record still matches its captured expectedBefore snapshot exactly — skippedCount stays 0, and it is reported in removedServerIds', async () => {
    const deletedTarget: ServerConfig = {
      id: "srv-1",
      name: "d",
      host: "h1",
      port: 22,
      username: "u",
      authType: "agent",
      isHidden: false,
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const repository = new InMemoryConfigRepository([deletedTarget]);
    const core = new NexusCore(repository);
    await core.initialize();

    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 9999,
      upsertServers: [],
      removeServerIds: ["srv-1"],
      folders: [],
      expectedSource: "absent",
      expectedBeforeByServerId: new Map([["srv-1", deletedTarget]])
    });

    expect(core.getServer("srv-1")).toBeUndefined();
    expect(result.skippedCount).toBe(0);
    expect(result.removedServerIds).toEqual(["srv-1"]);
  });

  it('(FINDING 2) absent-mode apply SKIPS an origin-strip upsert whose current server was replaced (different host) — not overwritten, and the skip is counted (kills a stale-snapshot overwrite)', async () => {
    const capturedBefore: ServerConfig = {
      id: "srv-1",
      name: "old-name",
      host: "10.0.0.1",
      port: 22,
      username: "u",
      authType: "agent",
      isHidden: false,
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const replaced: ServerConfig = {
      ...capturedBefore,
      host: "10.0.0.99", // a NEW import re-mapped this same id to a different device
      origin: { sourceId: "source-1", externalId: "device:99", syncedAt: 500 }
    };
    const repository = new InMemoryConfigRepository([replaced]);
    const core = new NexusCore(repository);
    await core.initialize();

    const strippedUpsert: ServerConfig = { ...capturedBefore, origin: undefined };
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 9999,
      upsertServers: [strippedUpsert],
      removeServerIds: [],
      folders: [],
      expectedSource: "absent",
      expectedBeforeByServerId: new Map([["srv-1", capturedBefore]])
    });

    // If FINDING 2's fix were reverted (upsertServers applied unconditionally
    // in "absent" mode), the replaced server's host/origin would be
    // overwritten by this stale origin-strip.
    expect(core.getServer("srv-1")?.host).toBe("10.0.0.99");
    expect(core.getServer("srv-1")?.origin?.externalId).toBe("device:99");
    expect(result.skippedCount).toBe(1);
  });

  it('(FINDING 2) absent-mode apply still processes matching entries: a removeServerIds entry still owned by apply.sourceId is deleted, and an origin-strip upsert whose current server still matches its captured snapshot is applied — skippedCount stays 0', async () => {
    const deletedTarget: ServerConfig = {
      id: "srv-delete",
      name: "d",
      host: "h1",
      port: 22,
      username: "u",
      authType: "agent",
      isHidden: false,
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const stripTarget: ServerConfig = {
      id: "srv-strip",
      name: "s",
      host: "h2",
      port: 22,
      username: "u",
      authType: "agent",
      isHidden: false,
      origin: { sourceId: "source-1", externalId: "device:2", syncedAt: 1 }
    };
    const repository = new InMemoryConfigRepository([deletedTarget, stripTarget]);
    const core = new NexusCore(repository);
    await core.initialize();

    const strippedUpsert: ServerConfig = { ...stripTarget, origin: undefined };
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 9999,
      upsertServers: [strippedUpsert],
      removeServerIds: ["srv-delete"],
      folders: [],
      expectedSource: "absent",
      expectedBeforeByServerId: new Map([["srv-strip", stripTarget]])
    });

    expect(core.getServer("srv-delete")).toBeUndefined();
    expect(core.getServer("srv-strip")?.origin).toBeUndefined();
    expect(result.skippedCount).toBe(0);
    expect(result.removedServerIds).toEqual(["srv-delete"]);
  });

  it("(FINDING 1) removeInventorySource(id, expected) throws InventorySourceRemovalMismatchError and mutates nothing when the current record no longer matches `expected` (kills unconditional delete on a replaced record)", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    const pickTimeSnapshot = makeSourceConfig({ targetFolder: "Old" });
    await core.addOrUpdateInventorySource(pickTimeSnapshot);
    // A replace-mode import recreated the SAME source id (same providerId/
    // name) with a different targetFolder — e.g. during a caller's own
    // awaited vault reads/deletes before calling removeInventorySource.
    await core.addOrUpdateInventorySource(makeSourceConfig({ targetFolder: "New" }));

    const saveInventorySourcesSpy = vi.spyOn(repository, "saveInventorySources");
    const listener = vi.fn();
    core.onDidChange(listener);

    await expect(core.removeInventorySource("source-1", pickTimeSnapshot)).rejects.toThrow(InventorySourceRemovalMismatchError);

    // If the fix were reverted (removeInventorySource ignores `expected` and
    // deletes unconditionally), the REPLACEMENT record ("New") would be gone
    // here even though it belongs to a different, newer import.
    expect(core.getInventorySource("source-1")?.targetFolder).toBe("New");
    expect(listener).not.toHaveBeenCalled();
    expect(saveInventorySourcesSpy).not.toHaveBeenCalled();
  });

  it("(FINDING 1 — revision) removeInventorySource(id, expected) throws when the current record is STRUCTURALLY IDENTICAL to `expected` but carries a different revision — a replace-mode import recreating the same values under a new credential (kills structural-equality identity)", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());
    // The exact stored record at pick time — this IS what a caller like
    // removeSource captures via pickInventorySource/getSnapshot.
    const pickTimeSnapshot = core.getInventorySource("source-1")!;

    // A replace-mode import recreates the SAME source id with EVERY
    // structural field identical (name/providerId/targetFolder/prunePolicy/
    // defaultUsername/config/secretFieldIds all match makeSourceConfig()'s
    // defaults) but points the same field ids at a brand-new vault
    // credential underneath — addOrUpdateInventorySource assigns a fresh
    // revision on this write regardless of the structural equality.
    await core.addOrUpdateInventorySource(makeSourceConfig());
    const recreated = core.getInventorySource("source-1")!;
    expect(recreated.revision).toBeDefined();
    expect(recreated.revision).not.toBe(pickTimeSnapshot.revision);
    // Sanity: every OLD structural field this comparator used to check is
    // still identical between the two incarnations.
    expect(recreated.name).toBe(pickTimeSnapshot.name);
    expect(recreated.targetFolder).toBe(pickTimeSnapshot.targetFolder);
    expect(recreated.providerId).toBe(pickTimeSnapshot.providerId);
    expect(recreated.prunePolicy).toBe(pickTimeSnapshot.prunePolicy);
    expect(recreated.defaultUsername).toBe(pickTimeSnapshot.defaultUsername);
    expect(recreated.config).toEqual(pickTimeSnapshot.config);
    expect(recreated.secretFieldIds).toEqual(pickTimeSnapshot.secretFieldIds);

    await expect(core.removeInventorySource("source-1", pickTimeSnapshot)).rejects.toThrow(InventorySourceRemovalMismatchError);

    // If FINDING 1's revision fix were reverted (sourceConfigUnchanged falls
    // straight through to pure structural comparison), every field checked
    // above matches — the OLD structural comparator would wrongly "prove"
    // pickTimeSnapshot is still the current record and delete the
    // REPLACEMENT'S record (and, in the command layer, strand its freshly
    // imported credential) instead of throwing here.
    expect(core.getInventorySource("source-1")).toBeDefined();
    expect(core.getInventorySource("source-1")?.revision).toBe(recreated.revision);
  });

  it("(FINDING 1) removeInventorySource(id, expected) succeeds when the current record still matches `expected`", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    const snapshot = makeSourceConfig();
    await core.addOrUpdateInventorySource(snapshot);

    await expect(core.removeInventorySource("source-1", snapshot)).resolves.toBeUndefined();
    expect(core.getInventorySource("source-1")).toBeUndefined();
  });

  it("(ITEM 1) applyInventorySyncPlan rolls back servers, explicit groups, active sessions, focus, and the source's lastSyncAt when the persist rejects — and emits nothing (kills mutate-then-leak)", async () => {
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s",
        host: "h",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        group: "OldGroup",
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
      },
      { id: "srv-untouched", name: "u2", host: "h2", port: 22, username: "u", authType: "agent", isHidden: false }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig({ lastSyncAt: 100 }));
    core.registerSession({ id: "session-1", serverId: "srv-1", terminalName: "Nexus SSH: s", startedAt: Date.now() });
    core.setFocusedSession("session-1");

    const beforeSnapshot = core.getSnapshot();
    const beforeLastSyncAt = core.getInventorySource("source-1")?.lastSyncAt;

    vi.spyOn(repository, "saveServers").mockRejectedValueOnce(new Error("disk full"));
    const listener = vi.fn();
    core.onDidChange(listener);

    const newServer: ServerConfig = { id: "srv-2", name: "new", host: "h2", port: 22, username: "u", authType: "agent", isHidden: false };
    await expect(
      core.applyInventorySyncPlan({
        sourceId: "source-1",
        syncedAt: 99999,
        upsertServers: [newServer],
        removeServerIds: ["srv-1"],
        folders: ["A/B"],
        expectedSource: makeSourceConfig({ lastSyncAt: 100 })
      })
    ).rejects.toThrow("disk full");

    // If ITEM 1's rollback were reverted (mutate-then-await, no restore on
    // rejection), all of the following would still reflect the half-applied
    // sync even though the caller was told it failed: srv-1 gone, srv-2
    // present, "A/B" registered as an explicit group, the session dropped,
    // focus cleared, and lastSyncAt bumped.
    expect(listener).not.toHaveBeenCalled();
    const after = core.getSnapshot();
    const byId = (list: { id: string }[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(after.servers)).toEqual(byId(beforeSnapshot.servers));
    expect([...after.explicitGroups].sort()).toEqual([...beforeSnapshot.explicitGroups].sort());
    expect(byId(after.activeSessions)).toEqual(byId(beforeSnapshot.activeSessions));
    expect(after.focusedSessionId).toBe(beforeSnapshot.focusedSessionId);
    expect(core.getInventorySource("source-1")?.lastSyncAt).toBe(beforeLastSyncAt);
  });

  it("(TOMBSTONE) a session closed for real while the persist is pending is NOT resurrected by rollback, but a session untouched during the window still is (kills unconditional re-insert of priorActiveSessions/focusedSessionId)", async () => {
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s1",
        host: "h1",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
      },
      {
        id: "srv-2",
        name: "s2",
        host: "h2",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        origin: { sourceId: "source-1", externalId: "device:2", syncedAt: 1 }
      }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());
    core.registerSession({ id: "session-1", serverId: "srv-1", terminalName: "Nexus SSH: s1", startedAt: Date.now() });
    core.registerSession({ id: "session-2", serverId: "srv-2", terminalName: "Nexus SSH: s2", startedAt: Date.now() });
    // Focus sits on session-1 — the one whose terminal the user will close
    // mid-flight below, so the rollback's focusedSessionId restore is
    // exercised too (a focus id pointing at a tombstoned session must not
    // survive rollback).
    core.setFocusedSession("session-1");

    // A controllable, still-pending saveServers so the test can inject the
    // mid-flight unregisterSession call before the persist settles.
    let rejectSave!: (err: unknown) => void;
    const pendingSave = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    vi.spyOn(repository, "saveServers").mockReturnValueOnce(pendingSave);

    const applyPromise = core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1000,
      upsertServers: [],
      removeServerIds: ["srv-1", "srv-2"],
      folders: [],
      expectedSource: makeSourceConfig()
    });

    // The synchronous prefix of applyInventorySyncPlan (capture priors, drop
    // both sessions via removeServerSessions, kick off the saves) has already
    // run by the time the call above returns — it only suspends at the
    // `await Promise.allSettled(...)`. Simulate the user closing session-1's
    // terminal for real during that pending window, exactly like
    // onSessionClosed -> unregisterSession would.
    core.unregisterSession("session-1");

    rejectSave(new Error("disk full"));
    await expect(applyPromise).rejects.toThrow("disk full");

    const after = core.getSnapshot();
    // session-1 was tombstoned by the mid-flight close: rollback must NOT
    // resurrect it, and focus (which pointed at it) must NOT be restored to
    // it either — both would otherwise leave bookkeeping (isServerConnected,
    // focusedSessionId) pointing at a dead terminal.
    expect(after.activeSessions.find((s) => s.id === "session-1")).toBeUndefined();
    expect(core.isServerConnected("srv-1")).toBe(false);
    expect(after.focusedSessionId).toBeUndefined();
    // session-2 was never touched during the window: rollback restores it
    // exactly as before, same as the plain rollback test above.
    expect(after.activeSessions.find((s) => s.id === "session-2")).toBeDefined();
    expect(core.isServerConnected("srv-2")).toBe(true);
  });

  it("(TOMBSTONE sanity) with no mid-window close, both captured sessions and focus are restored on rollback — unchanged from before the tombstone fix", async () => {
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s1",
        host: "h1",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
      },
      {
        id: "srv-2",
        name: "s2",
        host: "h2",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        origin: { sourceId: "source-1", externalId: "device:2", syncedAt: 1 }
      }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());
    core.registerSession({ id: "session-1", serverId: "srv-1", terminalName: "Nexus SSH: s1", startedAt: Date.now() });
    core.registerSession({ id: "session-2", serverId: "srv-2", terminalName: "Nexus SSH: s2", startedAt: Date.now() });
    core.setFocusedSession("session-1");

    vi.spyOn(repository, "saveServers").mockRejectedValueOnce(new Error("disk full"));

    await expect(
      core.applyInventorySyncPlan({
        sourceId: "source-1",
        syncedAt: 1000,
        upsertServers: [],
        removeServerIds: ["srv-1", "srv-2"],
        folders: [],
        expectedSource: makeSourceConfig()
      })
    ).rejects.toThrow("disk full");

    const after = core.getSnapshot();
    expect(after.activeSessions.find((s) => s.id === "session-1")).toBeDefined();
    expect(after.activeSessions.find((s) => s.id === "session-2")).toBeDefined();
    expect(after.focusedSessionId).toBe("session-1");
  });

  it("(FINDING 4) a user focusing a different session mid-window (setFocusedSession, independent of the batch) survives rollback — restore is conditional on the batch's own written value, not unconditional (kills unconditional focus restore)", async () => {
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s1",
        host: "h1",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
      },
      { id: "srv-other", name: "other", host: "h2", port: 22, username: "u", authType: "agent", isHidden: false }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());
    core.registerSession({ id: "session-1", serverId: "srv-1", terminalName: "Nexus SSH: s1", startedAt: Date.now() });
    core.registerSession({ id: "other-session", serverId: "srv-other", terminalName: "Nexus SSH: other", startedAt: Date.now() });
    // Focus starts on session-1 — the batch below removes srv-1, so its own
    // synchronous mutation phase (removeServerSessions) clears focus to
    // undefined as part of the batch write itself.
    core.setFocusedSession("session-1");

    // A controllable, still-pending saveServers so the test can inject the
    // mid-flight setFocusedSession call before the persist settles.
    let rejectSave!: (err: unknown) => void;
    const pendingSave = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    vi.spyOn(repository, "saveServers").mockReturnValueOnce(pendingSave);

    const applyPromise = core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1000,
      upsertServers: [],
      removeServerIds: ["srv-1"],
      folders: [],
      expectedSource: makeSourceConfig()
    });

    // The synchronous prefix of applyInventorySyncPlan (capture priors, drop
    // srv-1's session via removeServerSessions — clearing focus as part of
    // the batch's own write — kick off the saves) has already run by the
    // time the call above returns; it only suspends at the
    // `await Promise.allSettled(...)`. Simulate the user focusing an
    // unrelated, already-open terminal during that pending window — this is
    // independent of the batch, not something it wrote.
    core.setFocusedSession("other-session");

    rejectSave(new Error("disk full"));
    await expect(applyPromise).rejects.toThrow("disk full");

    // If the rollback unconditionally restored priorFocusedSessionId (the
    // bug this test guards against), focus would snap back to "session-1"
    // here, clobbering the user's newer, unrelated focus change.
    const after = core.getSnapshot();
    expect(after.focusedSessionId).toBe("other-session");
  });

  it("(ITEM 1) success path is unchanged: applyInventorySyncPlan still performs exactly one saveServers/saveGroups call and one emission when the persist resolves", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());

    const saveServersSpy = vi.spyOn(repository, "saveServers");
    const saveGroupsSpy = vi.spyOn(repository, "saveGroups");
    const listener = vi.fn();
    core.onDidChange(listener);

    const server: ServerConfig = { id: "srv-1", name: "s", host: "h", port: 22, username: "u", authType: "agent", isHidden: false };
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1000,
      upsertServers: [server],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: makeSourceConfig()
    });

    expect(saveServersSpy).toHaveBeenCalledTimes(1);
    expect(saveGroupsSpy).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(core.getSnapshot().servers).toHaveLength(1);
    expect(core.getInventorySource("source-1")?.lastSyncAt).toBe(1000);
  });

  it("(FINDING 2) a partial persist (saveServers commits, saveGroups rejects) gets compensated after rollback: the repo's LAST persisted servers/groups/sources converge on the restored pre-apply state (kills restore-memory-only, leaving disk half-applied)", async () => {
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s",
        host: "h",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
      }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());

    const servedServers: ServerConfig[][] = [];
    const servedGroups: string[][] = [];
    const servedSources: InventorySourceConfig[][] = [];

    vi.spyOn(repository, "saveServers").mockImplementation(async (servers) => {
      servedServers.push(servers);
    });
    let saveGroupsCallCount = 0;
    vi.spyOn(repository, "saveGroups").mockImplementation(async (groups) => {
      saveGroupsCallCount++;
      if (saveGroupsCallCount === 1) {
        // The batch's own saveGroups call rejects — nothing committed this call.
        throw new Error("disk full");
      }
      servedGroups.push(groups);
    });
    vi.spyOn(repository, "saveInventorySources").mockImplementation(async (sources) => {
      servedSources.push(sources);
    });

    const newServer: ServerConfig = { id: "srv-2", name: "new", host: "h2", port: 22, username: "u", authType: "agent", isHidden: false };
    await expect(
      core.applyInventorySyncPlan({
        sourceId: "source-1",
        syncedAt: 999,
        upsertServers: [newServer],
        removeServerIds: ["srv-1"],
        folders: ["A/B"],
        expectedSource: makeSourceConfig()
      })
    ).rejects.toThrow("disk full");

    // If FINDING 2's compensating persist were reverted (restore memory only,
    // never re-persist), servedServers/servedSources would each have exactly
    // ONE entry — the half-applied one saveServers/saveInventorySources
    // committed during the batch, which would then be the "last" persisted
    // value even though memory was rolled back out from under it.
    expect(servedServers.length).toBeGreaterThanOrEqual(2);
    expect(servedSources.length).toBeGreaterThanOrEqual(2);

    const lastServers = servedServers[servedServers.length - 1];
    const lastSources = servedSources[servedSources.length - 1];
    const lastGroups = servedGroups[servedGroups.length - 1];

    expect(lastServers.map((s) => s.id).sort()).toEqual(["srv-1"]);
    expect(lastGroups).toEqual([]);
    expect(lastSources.find((s) => s.id === "source-1")?.lastSyncAt).toBeUndefined();

    // In-memory state matches what was compensated to disk.
    expect(core.getSnapshot().servers.map((s) => s.id)).toEqual(["srv-1"]);
    expect(core.getInventorySource("source-1")?.lastSyncAt).toBeUndefined();
  });

  it("(REVIEW FINDING 1) originals are settled (allSettled) BEFORE compensating: a fast-rejecting saveGroups can't let a still-pending saveServers land the batch payload AFTER the compensating restore write (kills compensate-before-originals-settle)", async () => {
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s",
        host: "h",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
      }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());

    const originalSaveServers = repository.saveServers.bind(repository);
    let saveServersCallCount = 0;
    const saveOrder: string[] = [];
    vi.spyOn(repository, "saveServers").mockImplementation(async (servers) => {
      saveServersCallCount++;
      if (saveServersCallCount === 1) {
        // The batch's OWN save: settle on a real macrotask (setTimeout),
        // strictly AFTER any purely microtask-driven work — including a
        // buggy (Promise.all + immediate catch) implementation's rollback
        // and compensating writes, which would already be complete by the
        // time a setTimeout(0) callback fires.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await originalSaveServers(servers);
        saveOrder.push(`original:${servers.map((s) => s.id).sort().join(",")}`);
        return;
      }
      await originalSaveServers(servers);
      saveOrder.push(`compensating:${servers.map((s) => s.id).sort().join(",")}`);
    });
    vi.spyOn(repository, "saveGroups").mockRejectedValueOnce(new Error("disk full"));

    const newServer: ServerConfig = { id: "srv-2", name: "new", host: "h2", port: 22, username: "u", authType: "agent", isHidden: false };
    await expect(
      core.applyInventorySyncPlan({
        sourceId: "source-1",
        syncedAt: 999,
        upsertServers: [newServer],
        removeServerIds: ["srv-1"],
        folders: [],
        expectedSource: makeSourceConfig()
      })
    ).rejects.toThrow("disk full");

    // If FINDING 1's fix were reverted (Promise.all + immediate catch), the
    // compensating write would be fired the instant saveGroups rejects —
    // without waiting for the still-pending saveServers call — resolve on a
    // microtask, and land FIRST. The slow original save (carrying the
    // batch's payload: srv-2 present, srv-1 removed) would then land
    // afterwards and overwrite it, leaving the repo's persisted servers
    // wrong even though the caller was told the apply failed.
    const finalServers = await repository.getServers();
    expect(finalServers.map((s) => s.id).sort()).toEqual(["srv-1"]);
    // The recorded write order proves the compensating write happened AFTER
    // the slow original settled, never before it.
    expect(saveOrder).toEqual(["original:srv-2", "compensating:srv-1"]);
  });

  it("(FINDING 3) a concurrent addGroup/addOrUpdateServer landing while the batch's persist is pending survives rollback — restore is conditional, never a wholesale set replacement (kills restore-by-replacing-the-whole-set)", async () => {
    const untouched: ServerConfig = { id: "srv-untouched", name: "u", host: "h3", port: 22, username: "u", authType: "agent", isHidden: false };
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s",
        host: "h",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
      },
      untouched
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());

    // Hold the batch's own saveServers call pending so we can land concurrent
    // commands while applyInventorySyncPlan's Promise.all is still in flight.
    // The next call (from the concurrent addOrUpdateServer below) goes
    // through to the real implementation.
    const originalSaveServers = repository.saveServers.bind(repository);
    let rejectBatchSave!: (err: Error) => void;
    let batchCallSeen = false;
    vi.spyOn(repository, "saveServers").mockImplementation(async (servers) => {
      if (!batchCallSeen) {
        batchCallSeen = true;
        return new Promise<void>((_resolve, reject) => {
          rejectBatchSave = reject;
        });
      }
      return originalSaveServers(servers);
    });

    const newServer: ServerConfig = { id: "srv-2", name: "new", host: "h2", port: 22, username: "u", authType: "agent", isHidden: false };
    const applyPromise = core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 999,
      upsertServers: [newServer],
      removeServerIds: ["srv-1"],
      folders: ["A/B"],
      expectedSource: makeSourceConfig()
    });

    // The batch's synchronous mutations + Promise.all invocation have already
    // run by the time the call above returns control here (async function
    // bodies run synchronously up to their first await).
    await core.addGroup("Unrelated");
    await core.addOrUpdateServer({ ...untouched, name: "renamed" });

    rejectBatchSave(new Error("disk full"));
    await expect(applyPromise).rejects.toThrow("disk full");

    const snapshot = core.getSnapshot();
    // The batch's own mutations were reverted.
    expect(core.getServer("srv-1")).toBeDefined();
    expect(core.getServer("srv-2")).toBeUndefined();
    expect(snapshot.explicitGroups).not.toContain("A");
    expect(snapshot.explicitGroups).not.toContain("A/B");

    // If the fix were reverted to a wholesale restore (explicitGroups.clear()
    // + re-add the pre-batch set; servers restored unconditionally from the
    // pre-batch snapshot), these concurrent mutations — which the batch never
    // touched — would be erased even though they landed after the batch's
    // own mutations. They must survive.
    expect(snapshot.explicitGroups).toContain("Unrelated");
    expect(core.getServer("srv-untouched")?.name).toBe("renamed");
  });

  it("(REVIEW FINDING 2) a concurrent in-place mutation of an upserted server's group (exactly how _renameFolderPath mutates it) survives rollback — comparison is structural, not by reference (kills a reference-identity rollback check)", async () => {
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s",
        host: "h",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        group: "OldGroup",
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
      }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());

    // Hold the batch's own saveServers call pending so a concurrent in-place
    // mutation (as performed by _renameFolderPath / removeFolderCascade,
    // which reassign `server.group` on the SAME object already sitting in
    // NexusCore's servers map) can land while the persist is still in flight.
    // The batch's OWN catch-block compensating re-persist (after rollback)
    // must go through to the real implementation, not hang forever too.
    const originalSaveServers = repository.saveServers.bind(repository);
    let rejectBatchSave!: (err: Error) => void;
    let batchCallSeen = false;
    vi.spyOn(repository, "saveServers").mockImplementation(async (servers) => {
      if (!batchCallSeen) {
        batchCallSeen = true;
        return new Promise<void>((_resolve, reject) => {
          rejectBatchSave = reject;
        });
      }
      return originalSaveServers(servers);
    });

    const upsertedServer: ServerConfig = {
      id: "srv-1",
      name: "s",
      host: "h",
      port: 22,
      username: "u",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 999 }
    };
    const applyPromise = core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 999,
      upsertServers: [upsertedServer],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: makeSourceConfig()
    });

    // The batch's synchronous mutations + save invocation have already run by
    // the time control returns here. The live entry in NexusCore's map is
    // now the exact `upsertedServer` object — mutate its `.group` IN PLACE,
    // precisely like _renameFolderPath does for a folder rename racing this
    // pending persist.
    const liveServer = core.getServer("srv-1")!;
    expect(liveServer).toBe(upsertedServer); // sanity: same reference, as _renameFolderPath would see it
    liveServer.group = "NetBox/RenamedRack";

    rejectBatchSave(new Error("disk full"));
    await expect(applyPromise).rejects.toThrow("disk full");

    // If rollback used a reference check (`current === batchValue`), it would
    // still consider srv-1 "ours" (same object, merely mutated) and clobber
    // the concurrent rename back to the pre-batch "OldGroup". A structural
    // comparison correctly sees the current entry differs from the snapshot
    // captured at write time and leaves the rename alone.
    expect(core.getServer("srv-1")?.group).toBe("NetBox/RenamedRack");
  });

  it("(REVIEW FINDING 1) a concurrent in-place mutation of ONE field (group) during rollback merges field-wise instead of retaining the whole rejected upsert — the rolled-back entry gets the PRIOR host (batch's own change discarded) AND the concurrently-mutated group (kills skip-whole-record)", async () => {
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s",
        host: "h-old",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        group: "OldGroup",
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
      }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());

    // Hold the batch's own saveServers call pending so a concurrent in-place
    // mutation (as performed by _renameFolderPath / removeFolderCascade,
    // which reassign `server.group` on the SAME object already sitting in
    // NexusCore's servers map) can land while the persist is still in
    // flight. The batch's OWN catch-block compensating re-persist (after
    // rollback) must go through to the real implementation, not hang too.
    const originalSaveServers = repository.saveServers.bind(repository);
    let rejectBatchSave!: (err: Error) => void;
    let batchCallSeen = false;
    vi.spyOn(repository, "saveServers").mockImplementation(async (servers) => {
      if (!batchCallSeen) {
        batchCallSeen = true;
        return new Promise<void>((_resolve, reject) => {
          rejectBatchSave = reject;
        });
      }
      return originalSaveServers(servers);
    });

    // This batch intends to change BOTH host and group.
    const upsertedServer: ServerConfig = {
      id: "srv-1",
      name: "s",
      host: "h-new-batch",
      port: 22,
      username: "u",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 999 }
    };
    const applyPromise = core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 999,
      upsertServers: [upsertedServer],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: makeSourceConfig()
    });

    // The batch's synchronous mutations + save invocation have already run by
    // the time control returns here. Mutate ONLY `.group` in place on the
    // live entry, precisely like _renameFolderPath does for a folder rename
    // racing this pending persist — `.host` is left exactly as the batch set
    // it.
    const liveServer = core.getServer("srv-1")!;
    expect(liveServer).toBe(upsertedServer); // sanity: same reference
    liveServer.group = "ConcurrentGroup";

    rejectBatchSave(new Error("disk full"));
    await expect(applyPromise).rejects.toThrow("disk full");

    const rolledBack = core.getServer("srv-1");
    // The concurrently-mutated field survives rollback...
    expect(rolledBack?.group).toBe("ConcurrentGroup");
    // ...but the field the concurrent mutation never touched falls back to
    // the PRE-BATCH value — the batch's own (now-rejected) host change is
    // discarded. A skip-whole-record implementation would instead leave
    // `host` at the batch's rejected "h-new-batch", because it treats any
    // divergence from the batch snapshot (here, just the group mutation) as
    // reason to abandon the whole record and keep `current` untouched.
    expect(rolledBack?.host).toBe("h-old");
    // Unrelated, untouched-since-batch-wrote fields are restored from prior too.
    expect(rolledBack?.name).toBe("s");
    expect(rolledBack?.origin?.syncedAt).toBe(1);
  });

  it("(REVIEW FINDING 1) unchanged-fields rollback still fully restores prior when nothing concurrent touched the record (no divergence from the batch snapshot)", async () => {
    const repository = new InMemoryConfigRepository([
      {
        id: "srv-1",
        name: "s",
        host: "h-old",
        port: 22,
        username: "u",
        authType: "agent",
        isHidden: false,
        group: "OldGroup",
        origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
      }
    ]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());

    vi.spyOn(repository, "saveServers").mockRejectedValueOnce(new Error("disk full"));

    const upsertedServer: ServerConfig = {
      id: "srv-1",
      name: "s",
      host: "h-new-batch",
      port: 22,
      username: "u",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 999 }
    };
    await expect(
      core.applyInventorySyncPlan({
        sourceId: "source-1",
        syncedAt: 999,
        upsertServers: [upsertedServer],
        removeServerIds: [],
        folders: ["NetBox/RackA"],
        expectedSource: makeSourceConfig()
      })
    ).rejects.toThrow("disk full");

    // Nothing concurrent touched srv-1 — the whole prior record is restored,
    // exactly as before this finding's fix (the merge path is only reached
    // when current diverges from the batch snapshot).
    const rolledBack = core.getServer("srv-1");
    expect(rolledBack?.host).toBe("h-old");
    expect(rolledBack?.group).toBe("OldGroup");
    expect(rolledBack?.origin?.syncedAt).toBe(1);
  });

  it("(REVIEW FINDING 1) a batch-CREATED record with a concurrent in-place mutation keeps the current (concurrently-mutated) entry as-is — there is no prior state to merge onto", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig());

    const originalSaveServers = repository.saveServers.bind(repository);
    let rejectBatchSave!: (err: Error) => void;
    let batchCallSeen = false;
    vi.spyOn(repository, "saveServers").mockImplementation(async (servers) => {
      if (!batchCallSeen) {
        batchCallSeen = true;
        return new Promise<void>((_resolve, reject) => {
          rejectBatchSave = reject;
        });
      }
      return originalSaveServers(servers);
    });

    const newServer: ServerConfig = {
      id: "srv-new",
      name: "new",
      host: "h",
      port: 22,
      username: "u",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:2", syncedAt: 999 }
    };
    const applyPromise = core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 999,
      upsertServers: [newServer],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: makeSourceConfig()
    });

    const liveServer = core.getServer("srv-new")!;
    expect(liveServer).toBe(newServer);
    liveServer.group = "ConcurrentGroup";

    rejectBatchSave(new Error("disk full"));
    await expect(applyPromise).rejects.toThrow("disk full");

    // There was no pre-batch record for srv-new to merge concurrent changes
    // onto; deleting it would destroy the concurrent edit along with the
    // rejected create, so the current (concurrently-mutated) entry survives
    // as-is instead.
    const rolledBack = core.getServer("srv-new");
    expect(rolledBack).toBeDefined();
    expect(rolledBack?.group).toBe("ConcurrentGroup");
    expect(rolledBack?.host).toBe("h");
  });
});

describe("applyInventorySyncPlan — empty-folder GC (ITEM B)", () => {
  async function makeCoreWithSource(
    initialServers: ServerConfig[] = [],
    sourceOverrides: Partial<InventorySourceConfig> = {}
  ): Promise<{ core: NexusCore; repository: InMemoryConfigRepository }> {
    const repository = new InMemoryConfigRepository(initialServers);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig(sourceOverrides));
    return { core, repository };
  }

  it("(kills no-GC) a site rename leaves the old folder empty and a fresh sync removes it while the new folder survives", async () => {
    const server: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const { core } = await makeCoreWithSource([server], { targetFolder: "NetBox" });
    // Establish the starting folder tree exactly as a real prior sync would have.
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });
    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackA");

    // The rack was renamed at the source: the device now maps to a new
    // folder; the old one has no servers left in it after this upsert.
    const renamed = { ...server, group: "NetBox/RackB" };
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [renamed],
      removeServerIds: [],
      folders: ["NetBox/RackB"],
      expectedSource: core.getInventorySource("source-1")!
    });

    const groups = core.getSnapshot().explicitGroups;
    expect(groups).not.toContain("NetBox/RackA");
    expect(groups).toContain("NetBox/RackB");
    expect(groups).toContain("NetBox"); // ancestor, still in use
    expect(result.removedEmptyFolderCount).toBe(1);
  });

  it("(kills over-aggressive GC) a folder still holding an unrelated MANUAL server, or a serial profile, survives even though this source's own servers left it", async () => {
    const manualServer: ServerConfig = {
      id: "manual-1",
      name: "hand-added",
      host: "192.168.1.1",
      port: 22,
      username: "root",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA" // no `origin` — added by hand, not by this source
    };
    const owned: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const { core } = await makeCoreWithSource([manualServer, owned], { targetFolder: "NetBox" });
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });

    // This source's own device moves away; the manual server stays behind.
    const moved = { ...owned, group: "NetBox/RackB" };
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [moved],
      removeServerIds: [],
      folders: ["NetBox/RackB"],
      expectedSource: core.getInventorySource("source-1")!
    });

    // If GC checked only servers this source owns (not "any origin"), RackA
    // would be wrongly removed even though the manual server still lives
    // there. It must survive.
    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackA");
    expect(result.removedEmptyFolderCount).toBe(0);
  });

  it("F4 (kills exact-match-only occupancy) a server at an IMPLICIT descendant path protects its ancestor folder even though nothing sits AT the ancestor path exactly", async () => {
    const movingServer: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    // Hand-typed group — never itself passed in a plan's `folders` list, so
    // it never becomes an entry in explicitGroups (mirrors a user typing a
    // group path directly into a server's Folder field rather than picking
    // one from the folder tree).
    const implicitDescendantServer: ServerConfig = {
      id: "manual-1",
      name: "special-unit",
      host: "192.168.1.1",
      port: 22,
      username: "root",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA/Special"
    };
    const { core } = await makeCoreWithSource([movingServer, implicitDescendantServer], { targetFolder: "NetBox" });
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });
    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackA");
    // "NetBox/RackA/Special" was never named in any plan's `folders` list —
    // confirms it's genuinely implicit, not merely untested-for.
    expect(core.getSnapshot().explicitGroups).not.toContain("NetBox/RackA/Special");

    // The source's own device moves away; nothing sits AT "NetBox/RackA"
    // exactly anymore, but implicitDescendantServer still sits underneath it.
    const moved = { ...movingServer, group: "NetBox/RackB" };
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [moved],
      removeServerIds: [],
      folders: ["NetBox/RackB"],
      expectedSource: core.getInventorySource("source-1")!
    });

    // Exact-match-only occupancy would see no server at "NetBox/RackA"
    // exactly (implicitDescendantServer sits at "NetBox/RackA/Special", not
    // an exact match) and wrongly GC it out from under the server still
    // parented there.
    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackA");
    expect(result.removedEmptyFolderCount).toBe(0);
  });

  it("(kills over-aggressive GC / entity coverage) a folder holding only a serial profile, or only a local-shell profile, is NOT removed", async () => {
    const owned: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const serialProfile: SerialProfile = {
      id: "serial-1",
      name: "console",
      group: "NetBox/RackB",
      path: "/dev/ttyUSB0",
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      rtscts: false
    };
    const localShellProfile: LocalShellProfile = {
      id: "shell-1",
      name: "local",
      group: "NetBox/RackC",
      launchMode: "custom"
    };
    const repository = new InMemoryConfigRepository([owned], [], [serialProfile], [], [], [localShellProfile]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig({ targetFolder: "NetBox" }));
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA", "NetBox/RackB", "NetBox/RackC"],
      expectedSource: core.getInventorySource("source-1")!
    });

    // Move the owned server away from RackA; RackB/RackC are never touched
    // by this source's own plan.folders at all on this run, but they must
    // still survive because the serial/local-shell profiles occupy them.
    const moved = { ...owned, group: "NetBox/RackD" };
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [moved],
      removeServerIds: [],
      folders: ["NetBox/RackD"],
      expectedSource: core.getInventorySource("source-1")!
    });

    const groups = core.getSnapshot().explicitGroups;
    expect(groups).not.toContain("NetBox/RackA"); // now genuinely empty
    expect(groups).toContain("NetBox/RackB"); // serial profile still there
    expect(groups).toContain("NetBox/RackC"); // local-shell profile still there
    expect(result.removedEmptyFolderCount).toBe(1);
  });

  it("(kills scope-too-wide GC) a folder OUTSIDE the source's targetFolder is never touched, even if empty and unrelated", async () => {
    const owned: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const { core } = await makeCoreWithSource([owned], { targetFolder: "NetBox" });
    // An unrelated empty folder outside NetBox entirely (e.g. a folder the
    // user made by hand for something else).
    await core.addGroup("Elsewhere/Empty");
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });

    const moved = { ...owned, group: "NetBox/RackB" };
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [moved],
      removeServerIds: [],
      folders: ["NetBox/RackB"],
      expectedSource: core.getInventorySource("source-1")!
    });

    expect(core.getSnapshot().explicitGroups).toContain("Elsewhere/Empty");
    expect(result.removedEmptyFolderCount).toBe(1); // only NetBox/RackA
  });

  it('(kills root-target GC) targetFolder "" never GCs anything, however empty a folder becomes', async () => {
    const owned: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const { core } = await makeCoreWithSource([owned], { targetFolder: "" });
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });

    const moved = { ...owned, group: "RackB" };
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [moved],
      removeServerIds: [],
      folders: ["RackB"],
      expectedSource: core.getInventorySource("source-1")!
    });

    // RackA is now empty but targetFolder is root ("") — GC must not run at all.
    expect(core.getSnapshot().explicitGroups).toContain("RackA");
    expect(result.removedEmptyFolderCount).toBe(0);
  });

  it('("absent" / removal disposition does NOT GC) an owned server stripped of its origin during source removal leaves its now-empty folder untouched', async () => {
    const owned: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const { core } = await makeCoreWithSource([owned], { targetFolder: "NetBox" });
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });
    await core.removeInventorySource("source-1");

    // Removal disposition: delete the owned server entirely — its folder is
    // now empty, but this is an "absent" apply, so GC must not run.
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [],
      removeServerIds: ["device-1"],
      folders: [],
      expectedSource: "absent"
    });

    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackA");
    expect(result.removedEmptyFolderCount).toBe(0);
  });

  it("(kills missing rollback tracking) a folder GC removed is RESTORED when the persist rejects, unless something concurrent re-added it", async () => {
    const owned: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const { core, repository } = await makeCoreWithSource([owned], { targetFolder: "NetBox" });
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });
    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackA");

    vi.spyOn(repository, "saveGroups").mockRejectedValueOnce(new Error("disk full"));

    const moved = { ...owned, group: "NetBox/RackB" };
    await expect(
      core.applyInventorySyncPlan({
        sourceId: "source-1",
        syncedAt: 2,
        upsertServers: [moved],
        removeServerIds: [],
        folders: ["NetBox/RackB"],
        expectedSource: core.getInventorySource("source-1")!
      })
    ).rejects.toThrow("disk full");

    // If the rollback never tracked batch-REMOVED groups (only ADDED ones),
    // "NetBox/RackA" would stay gone even though the whole batch — including
    // the server move that emptied it — was rolled back. It must come back.
    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackA");
    // The rejected batch's own upsert was also rolled back, so the server is
    // still in RackA — consistent with RackA surviving.
    expect(core.getServer("device-1")?.group).toBe("NetBox/RackA");
    // REVIEW FINDING 1 (P2, folder-GC ownership) — the source record's
    // rollback is a wholesale restore of the pre-apply object (see
    // applyInventorySyncPlan's "FINDING 2 — source record" rollback branch),
    // so `managedFolders` must revert to its pre-apply value too: still
    // ["NetBox/RackA"], not the new (empty, since RackA was about to be
    // dropped) set this rejected apply attempted to stamp.
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackA"]);
  });
});

describe("applyInventorySyncPlan — empty-folder GC ownership (REVIEW FINDING 1, P2)", () => {
  async function makeCoreWithSource(
    initialServers: ServerConfig[] = [],
    sourceOverrides: Partial<InventorySourceConfig> = {}
  ): Promise<{ core: NexusCore; repository: InMemoryConfigRepository }> {
    const repository = new InMemoryConfigRepository(initialServers);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig(sourceOverrides));
    return { core, repository };
  }

  it("(kills unowned sweep — THE finding's scenario) a manually-created empty folder under targetFolder, never named by any of this source's applies, survives every sync even though nothing occupies it", async () => {
    const owned: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const { core } = await makeCoreWithSource([owned], { targetFolder: "NetBox" });
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });

    // A user hand-creates an intentionally empty staging folder UNDER the
    // same targetFolder — this source's own plan.folders never names it on
    // any sync, so it never enters managedFolders.
    await core.addGroup("NetBox/Staging");
    expect(core.getSnapshot().explicitGroups).toContain("NetBox/Staging");

    // Run several more syncs, none of which ever touch "NetBox/Staging".
    for (let i = 0; i < 3; i++) {
      const result = await core.applyInventorySyncPlan({
        sourceId: "source-1",
        syncedAt: 2 + i,
        upsertServers: [owned],
        removeServerIds: [],
        folders: ["NetBox/RackA"],
        expectedSource: core.getInventorySource("source-1")!
      });
      // Old (P2) behavior: ANY empty explicit folder strictly under
      // targetFolder was a GC candidate — "NetBox/Staging" would have been
      // swept on the very first of these no-op syncs. It must survive.
      expect(core.getSnapshot().explicitGroups).toContain("NetBox/Staging");
      expect(result.removedEmptyFolderCount).toBe(0);
    }
  });

  it("a folder created by sync A, then absent from sync B's folder set and left empty, is removed (ownership-based GC still reclaims what THIS source abandons)", async () => {
    const owned: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const { core } = await makeCoreWithSource([owned], { targetFolder: "NetBox" });
    // Sync A: creates/uses "NetBox/RackA" — stamps it into managedFolders.
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackA"]);

    // Sync B: the device moves; RackA is no longer named and is now empty.
    const moved = { ...owned, group: "NetBox/RackB" };
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [moved],
      removeServerIds: [],
      folders: ["NetBox/RackB"],
      expectedSource: core.getInventorySource("source-1")!
    });

    expect(core.getSnapshot().explicitGroups).not.toContain("NetBox/RackA");
    expect(result.removedEmptyFolderCount).toBe(1);
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackB"]);
  });

  it("an occupied managed folder is kept, and stays in managedFolders (still named by this sync)", async () => {
    const owned: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const { core } = await makeCoreWithSource([owned], { targetFolder: "NetBox" });
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [owned],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });

    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackA");
    expect(result.removedEmptyFolderCount).toBe(0);
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackA"]);
  });

  it("(legacy source) a source record with no prior managedFolders removes NOTHING on its first sync, and stamps the set for the next one", async () => {
    const owned: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    // Seed explicit groups directly (as a repo predating this feature would
    // have left them), and a source record with no `managedFolders` at all
    // (legacy — never went through this code path before).
    const repository = new InMemoryConfigRepository([owned], [], [], ["NetBox", "NetBox/RackA"]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig({ targetFolder: "NetBox" }));
    expect(core.getInventorySource("source-1")?.managedFolders).toBeUndefined();

    // The device moves away on this "first" (from managedFolders' point of
    // view) sync — RackA is now empty, but there is no prior managed set to
    // diff against, so nothing may be removed.
    const moved = { ...owned, group: "NetBox/RackB" };
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [moved],
      removeServerIds: [],
      folders: ["NetBox/RackB"],
      expectedSource: core.getInventorySource("source-1")!
    });

    // Old (P2) behavior would have swept "NetBox/RackA" here since it's an
    // empty explicit folder strictly under targetFolder with nothing else
    // occupying it. Ownership-based GC must not, on this first stamp.
    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackA");
    expect(result.removedEmptyFolderCount).toBe(0);
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackB"]);

    // Now that the set has been stamped, a later sync abandoning RackB CAN
    // reclaim it.
    const movedAgain = { ...moved, group: "NetBox/RackC" };
    const secondResult = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [movedAgain],
      removeServerIds: [],
      folders: ["NetBox/RackC"],
      expectedSource: core.getInventorySource("source-1")!
    });
    expect(core.getSnapshot().explicitGroups).not.toContain("NetBox/RackB");
    expect(secondResult.removedEmptyFolderCount).toBe(1);
  });

  it("(kills unowned sweep across sources) another source's folder under the same targetFolder — left genuinely EMPTY — survives this source's sync, since its path is only in the OTHER source's managed set", async () => {
    const ownedByA: ServerConfig = {
      id: "device-a",
      name: "sw-a",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:a", syncedAt: 1 }
    };
    const ownedByB: ServerConfig = {
      id: "device-b",
      name: "sw-b",
      host: "10.0.0.2",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackB",
      origin: { sourceId: "source-2", externalId: "device:b", syncedAt: 1 }
    };
    const repository = new InMemoryConfigRepository([ownedByA, ownedByB]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig({ id: "source-1", targetFolder: "NetBox" }));
    await core.addOrUpdateInventorySource(makeSourceConfig({ id: "source-2", targetFolder: "NetBox" }));

    // Each source syncs once, establishing its own managedFolders — RackB is
    // ONLY ever named by source-2's plan.folders, never source-1's.
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });
    await core.applyInventorySyncPlan({
      sourceId: "source-2",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackB"],
      expectedSource: core.getInventorySource("source-2")!
    });
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackA"]);
    expect(core.getInventorySource("source-2")?.managedFolders).toEqual(["NetBox/RackB"]);

    // "NetBox/RackB" becomes genuinely empty WITHOUT going through source-2's
    // own sync (e.g. the device was deleted by hand) — nothing occupies it
    // anymore, so the old (P2) "any empty explicit folder under targetFolder"
    // scan would have swept it on source-1's very next sync.
    await core.removeServer("device-b");
    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackB");

    // source-1 syncs again — its own plan.folders never names "NetBox/RackB"
    // and it was never in source-1's OWN managedFolders, so it must not be
    // touched even though it is empty and strictly under the same
    // targetFolder source-1 is scoped to.
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [ownedByA],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });

    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackB");
    expect(result.removedEmptyFolderCount).toBe(0);
  });

  it("(REVIEW FINDING 1, P2 — no-op syncs must retain ownership) a stable sync that names no folders keeps the unchanged device's folder in managedFolders; a later move can still GC it", async () => {
    const owned: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const { core } = await makeCoreWithSource([], { targetFolder: "NetBox" });

    // Sync A: creates the device, naming its folder.
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [owned],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackA"]);

    // Sync B: a NO-OP sync — the device already matches, so a real
    // computeSyncPlan finds nothing to add/update/orphan and `apply.folders`
    // comes back EMPTY (InventorySyncApplication.folders is populated only
    // from adds/updates/orphans + the orphan targetFolder — see its field
    // doc). A derivation that reads `applicationFolderSet` alone here would
    // empty `managedFolders` on this very call, even though the device is
    // still sitting in "NetBox/RackA" completely unchanged.
    const noop = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [],
      removeServerIds: [],
      folders: [],
      expectedSource: core.getInventorySource("source-1")!
    });
    expect(noop.removedEmptyFolderCount).toBe(0);
    // KILLS mutation-only derivation: under the old (applicationFolderSet-only)
    // code this would be `[]`, since `apply.folders` named nothing this call.
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackA"]);

    // Sync C: the device finally moves away. RackA is now empty and named by
    // neither the footprint nor `folders` this call — it must become a GC
    // candidate and be reclaimed. Under the old derivation this could never
    // happen: the no-op sync at step B would already have dropped RackA from
    // `managedFolders`, so `previousManagedFolders` here would have nothing
    // to diff against and RackA would linger forever.
    const moved = { ...owned, group: "NetBox/RackB" };
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 3,
      upsertServers: [moved],
      removeServerIds: [],
      folders: ["NetBox/RackB"],
      expectedSource: core.getInventorySource("source-1")!
    });

    expect(core.getSnapshot().explicitGroups).not.toContain("NetBox/RackA");
    expect(result.removedEmptyFolderCount).toBe(1);
  });

  it("(REVIEW FINDING 2, P2 — cross-source ownership) a folder both sources manage survives one source dropping it while the other still manages it, and is only GC'd once BOTH have dropped it", async () => {
    const ownedByX: ServerConfig = {
      id: "device-x",
      name: "sw-x",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:x", syncedAt: 1 }
    };
    const repository = new InMemoryConfigRepository([ownedByX]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig({ id: "source-1", targetFolder: "NetBox" }));
    await core.addOrUpdateInventorySource(makeSourceConfig({ id: "source-2", targetFolder: "NetBox" }));

    // Both sources' plans name "NetBox/RackA" on their first sync — X because
    // its device lives there, Y because it targets the same shared folder
    // (e.g. two inventory tools pointed at the same rack) even though it has
    // no device of its own there yet.
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [ownedByX],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });
    await core.applyInventorySyncPlan({
      sourceId: "source-2",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-2")!
    });
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackA"]);
    expect(core.getInventorySource("source-2")?.managedFolders).toEqual(["NetBox/RackA"]);

    // X's device moves away on X's own next sync — RackA becomes genuinely
    // empty (no server, from ANY source, occupies it), and X's OWN managed
    // set drops it too (neither X's footprint nor X's folders name it
    // anymore). An own-set-only GC check would see RackA in X's
    // gcOwnedCandidates, find it empty, and delete it out from under
    // source-2, which still manages it.
    const movedX = { ...ownedByX, group: "NetBox/RackB" };
    const resultX = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [movedX],
      removeServerIds: [],
      folders: ["NetBox/RackB"],
      expectedSource: core.getInventorySource("source-1")!
    });

    // KILLS own-set-only check: RackA survives because source-2 still
    // manages it, even though it is genuinely empty and dropped out of
    // source-1's own managed set on this very call.
    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackA");
    expect(resultX.removedEmptyFolderCount).toBe(0);
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackB"]);
    expect(core.getInventorySource("source-2")?.managedFolders).toEqual(["NetBox/RackA"]);

    // source-2 now drops it too — nothing manages it anymore, and it is
    // still genuinely empty. The very next sync of either source may now
    // reclaim it.
    const resultY = await core.applyInventorySyncPlan({
      sourceId: "source-2",
      syncedAt: 2,
      upsertServers: [],
      removeServerIds: [],
      folders: [],
      expectedSource: core.getInventorySource("source-2")!
    });

    expect(core.getSnapshot().explicitGroups).not.toContain("NetBox/RackA");
    expect(resultY.removedEmptyFolderCount).toBe(1);
  });

  it("(kills new-target-only filtering) editing targetFolder ('NetBox' -> 'Infra') still reclaims the OLD target's now-empty managed folder, and the old target's own root survives untouched", async () => {
    const owned: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const { core } = await makeCoreWithSource([owned], { targetFolder: "NetBox" });
    // Establish the starting folder tree, and stamp "NetBox/RackA" into
    // managedFolders, exactly as a real prior sync would have.
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });
    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackA");
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackA"]);

    // The source's targetFolder is edited (e.g. via Edit Source) — mirrors
    // inventoryCommands.ts's edit flow, which spreads the previous record
    // and only overwrites the fields the form controls, so `managedFolders`
    // rides along unchanged even though `targetFolder` now points elsewhere.
    await core.addOrUpdateInventorySource({ ...core.getInventorySource("source-1")!, targetFolder: "Infra" });
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackA"]);

    // The very next sync moves the device to the NEW target; the OLD
    // target's folder is now genuinely empty and named by neither this
    // sync's `folders` nor this source's own footprint.
    const moved = { ...owned, group: "Infra/RackA" };
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [moved],
      removeServerIds: [],
      folders: ["Infra/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });

    // KILLS new-target-only filtering: a GC restricted to folders under the
    // CURRENT targetFolder ("Infra/...") would never even consider
    // "NetBox/RackA" a candidate, so it would survive here — and the
    // `managedFolders` restamp below then permanently drops it from the
    // set, losing the cleanup opportunity forever.
    const groups = core.getSnapshot().explicitGroups;
    expect(groups).not.toContain("NetBox/RackA");
    expect(groups).toContain("Infra/RackA");
    // The OLD target's own root is never itself a `managedFolders` member
    // (see pruneEmptyFoldersUnderTarget's doc), so it is never a GC
    // candidate at all and survives regardless of occupancy.
    expect(groups).toContain("NetBox");
    expect(result.removedEmptyFolderCount).toBe(1);
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["Infra/RackA"]);
  });

  it("(old-target occupancy) a folder under the OLD target still holding an unrelated manual server survives a targetFolder edit + move", async () => {
    const manualServer: ServerConfig = {
      id: "manual-1",
      name: "hand-added",
      host: "192.168.1.1",
      port: 22,
      username: "root",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA" // no `origin` — added by hand, not by this source
    };
    const owned: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1 }
    };
    const { core } = await makeCoreWithSource([manualServer, owned], { targetFolder: "NetBox" });
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackA"]);

    await core.addOrUpdateInventorySource({ ...core.getInventorySource("source-1")!, targetFolder: "Infra" });

    // This source's own device moves to the new target; the manual server
    // stays behind in the OLD target's folder, which is now a GC candidate
    // (evaluated at its own path, per the fix) but must still survive
    // because it is not actually empty.
    const moved = { ...owned, group: "Infra/RackA" };
    const result = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [moved],
      removeServerIds: [],
      folders: ["Infra/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });

    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackA");
    expect(result.removedEmptyFolderCount).toBe(0);
  });

  it("(old-target co-ownership) a folder under the OLD target still managed by ANOTHER source survives a targetFolder edit + move, and is only GC'd once that other source also drops it", async () => {
    const ownedByX: ServerConfig = {
      id: "device-x",
      name: "sw-x",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "source-1", externalId: "device:x", syncedAt: 1 }
    };
    const repository = new InMemoryConfigRepository([ownedByX]);
    const core = new NexusCore(repository);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeSourceConfig({ id: "source-1", targetFolder: "NetBox" }));
    await core.addOrUpdateInventorySource(makeSourceConfig({ id: "source-2", targetFolder: "NetBox" }));

    // Both sources' plans name "NetBox/RackA" on their first sync.
    await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 1,
      upsertServers: [ownedByX],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });
    await core.applyInventorySyncPlan({
      sourceId: "source-2",
      syncedAt: 1,
      upsertServers: [],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("source-2")!
    });
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["NetBox/RackA"]);
    expect(core.getInventorySource("source-2")?.managedFolders).toEqual(["NetBox/RackA"]);

    // source-1's targetFolder is edited away from "NetBox" entirely.
    await core.addOrUpdateInventorySource({ ...core.getInventorySource("source-1")!, targetFolder: "Infra" });

    // source-1's device moves to the new target — "NetBox/RackA" becomes
    // genuinely empty of source-1's own devices AND drops out of source-1's
    // own managed set, but source-2 still names it.
    const movedX = { ...ownedByX, group: "Infra/RackA" };
    const resultX = await core.applyInventorySyncPlan({
      sourceId: "source-1",
      syncedAt: 2,
      upsertServers: [movedX],
      removeServerIds: [],
      folders: ["Infra/RackA"],
      expectedSource: core.getInventorySource("source-1")!
    });

    // KILLS own-set-only / new-target-only checks: "NetBox/RackA" survives
    // because source-2 still manages it, even though it is genuinely empty
    // and source-1 both dropped it from its own managed set AND retargeted
    // away from "NetBox" entirely on this very call.
    expect(core.getSnapshot().explicitGroups).toContain("NetBox/RackA");
    expect(resultX.removedEmptyFolderCount).toBe(0);
    expect(core.getInventorySource("source-1")?.managedFolders).toEqual(["Infra/RackA"]);
    expect(core.getInventorySource("source-2")?.managedFolders).toEqual(["NetBox/RackA"]);

    // source-2 now drops it too — nothing manages it anymore, and it is
    // still genuinely empty. The very next sync of either source may now
    // reclaim it.
    const resultY = await core.applyInventorySyncPlan({
      sourceId: "source-2",
      syncedAt: 2,
      upsertServers: [],
      removeServerIds: [],
      folders: [],
      expectedSource: core.getInventorySource("source-2")!
    });

    expect(core.getSnapshot().explicitGroups).not.toContain("NetBox/RackA");
    expect(resultY.removedEmptyFolderCount).toBe(1);
  });
});

describe("validateInventorySource", () => {
  const valid: InventorySourceConfig = {
    id: "s1",
    providerId: "netbox",
    name: "NetBox",
    targetFolder: "NetBox",
    prunePolicy: "orphan",
    defaultUsername: "admin",
    config: { baseUrl: "https://netbox.example.com" },
    secretFieldIds: ["apiToken"]
  };

  it("accepts a valid source", () => {
    expect(validateInventorySource(valid)).toBe(true);
  });

  it("accepts a root ('') targetFolder", () => {
    expect(validateInventorySource({ ...valid, targetFolder: "" })).toBe(true);
  });

  it("rejects a missing/empty id, providerId, or name", () => {
    expect(validateInventorySource({ ...valid, id: "" })).toBe(false);
    expect(validateInventorySource({ ...valid, providerId: "" })).toBe(false);
    expect(validateInventorySource({ ...valid, name: "" })).toBe(false);
  });

  it("rejects an invalid prunePolicy", () => {
    expect(validateInventorySource({ ...valid, prunePolicy: "bogus" })).toBe(false);
  });

  it("rejects a missing/empty defaultUsername", () => {
    expect(validateInventorySource({ ...valid, defaultUsername: "" })).toBe(false);
  });

  it("rejects an unnormalizable targetFolder", () => {
    expect(validateInventorySource({ ...valid, targetFolder: "a/../b" })).toBe(false);
  });

  it("rejects a non-object / array config", () => {
    expect(validateInventorySource({ ...valid, config: [] })).toBe(false);
    expect(validateInventorySource({ ...valid, config: "nope" })).toBe(false);
  });

  it("rejects a config value that isn't string|number|boolean", () => {
    expect(validateInventorySource({ ...valid, config: { x: { nested: true } } })).toBe(false);
  });

  it("rejects secretFieldIds that aren't a string array", () => {
    expect(validateInventorySource({ ...valid, secretFieldIds: [1, 2] })).toBe(false);
    expect(validateInventorySource({ ...valid, secretFieldIds: "apiToken" })).toBe(false);
  });

  it("rejects a non-number lastSyncAt", () => {
    expect(validateInventorySource({ ...valid, lastSyncAt: "yesterday" })).toBe(false);
  });

  it("accepts a numeric lastSyncAt", () => {
    expect(validateInventorySource({ ...valid, lastSyncAt: 12345 })).toBe(true);
  });

  it("(ITEM A) accepts a missing providerFingerprint and a non-empty string providerFingerprint", () => {
    expect(validateInventorySource(valid)).toBe(true);
    expect(validateInventorySource({ ...valid, providerFingerprint: "abc123" })).toBe(true);
  });

  it("(ITEM A) rejects a non-string / empty providerFingerprint (kills a missing type/emptiness check)", () => {
    expect(validateInventorySource({ ...valid, providerFingerprint: "" })).toBe(false);
    expect(validateInventorySource({ ...valid, providerFingerprint: 123 })).toBe(false);
  });

  it("(REVIEW FINDING 1, P2) accepts a missing managedFolders and an array of strings, including empty", () => {
    expect(validateInventorySource(valid)).toBe(true);
    expect(validateInventorySource({ ...valid, managedFolders: [] })).toBe(true);
    expect(validateInventorySource({ ...valid, managedFolders: ["NetBox/RackA", "NetBox/RackB"] })).toBe(true);
  });

  it("(REVIEW FINDING 1, P2) rejects a managedFolders that isn't a string array", () => {
    expect(validateInventorySource({ ...valid, managedFolders: [1, 2] })).toBe(false);
    expect(validateInventorySource({ ...valid, managedFolders: "NetBox/RackA" })).toBe(false);
  });
});

describe("computeProviderFingerprint (ITEM A — provider trust fingerprint)", () => {
  function makeProvider(overrides: Partial<InventoryProvider> = {}): InventoryProvider {
    return {
      id: "netbox",
      label: "NetBox",
      configFields: [
        { id: "baseUrl", label: "Base URL", type: "string", required: true },
        { id: "apiToken", label: "API Token", type: "password", required: true }
      ],
      testConnection: async () => {},
      fetchInventory: async () => ({ contractVersion: 1, devices: [] }),
      ...overrides
    };
  }

  it("is deterministic for the same observable shape", () => {
    expect(computeProviderFingerprint(makeProvider())).toBe(computeProviderFingerprint(makeProvider()));
  });

  it("is a 16-character lowercase hex string", () => {
    const fp = computeProviderFingerprint(makeProvider());
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ignores `id` — hashing the id would make a same-id-different-provider swap invisible, defeating the whole point of the check", () => {
    const a = computeProviderFingerprint(makeProvider({ id: "netbox" }));
    const b = computeProviderFingerprint(makeProvider({ id: "totally-different-id" }));
    expect(a).toBe(b);
  });

  it("changes when label changes (kills a fingerprint that ignores label)", () => {
    const a = computeProviderFingerprint(makeProvider({ label: "NetBox" }));
    const b = computeProviderFingerprint(makeProvider({ label: "NetBox v2" }));
    expect(a).not.toBe(b);
  });

  it("changes when a configField is added/removed (kills a fingerprint that ignores configFields)", () => {
    const a = computeProviderFingerprint(makeProvider());
    const b = computeProviderFingerprint(
      makeProvider({ configFields: [{ id: "baseUrl", label: "Base URL", type: "string", required: true }] })
    );
    expect(a).not.toBe(b);
  });

  it("changes when a configField's type or required flag changes, even with the same id/label (kills a fingerprint that only hashes field ids)", () => {
    const a = computeProviderFingerprint(makeProvider());
    const bTypeChanged = computeProviderFingerprint(
      makeProvider({
        configFields: [
          { id: "baseUrl", label: "Base URL", type: "string", required: true },
          { id: "apiToken", label: "API Token", type: "string", required: true } // was "password"
        ]
      })
    );
    const bRequiredChanged = computeProviderFingerprint(
      makeProvider({
        configFields: [
          { id: "baseUrl", label: "Base URL", type: "string", required: true },
          { id: "apiToken", label: "API Token", type: "password", required: false }
        ]
      })
    );
    expect(a).not.toBe(bTypeChanged);
    expect(a).not.toBe(bRequiredChanged);
  });

  it("changes when configField ORDER changes (kills a fingerprint that sorts fields before hashing, losing order sensitivity)", () => {
    const a = computeProviderFingerprint(makeProvider());
    const reordered = computeProviderFingerprint(
      makeProvider({
        configFields: [
          { id: "apiToken", label: "API Token", type: "password", required: true },
          { id: "baseUrl", label: "Base URL", type: "string", required: true }
        ]
      })
    );
    expect(a).not.toBe(reordered);
  });

  it("ignores testConnection/fetchInventory function identity — two structurally-identical providers with different function references fingerprint the same", () => {
    const a = computeProviderFingerprint(makeProvider({ testConnection: async () => {}, fetchInventory: async () => ({ contractVersion: 1, devices: [] }) }));
    const b = computeProviderFingerprint(makeProvider({ testConnection: async () => {}, fetchInventory: async () => ({ contractVersion: 1, devices: [] }) }));
    expect(a).toBe(b);
  });
});

describe("validateServerConfig — origin handling (F13/FIX 5)", () => {
  it("accepts a server with a malformed origin (does not reject the whole row) WITHOUT mutating the input object (kills both 'rejects whole server' and 'validator mutates input')", () => {
    const item = {
      id: "s1",
      name: "Server",
      host: "h",
      port: 22,
      username: "u",
      authType: "agent",
      isHidden: false,
      origin: { sourceId: "src", externalId: "ext", syncedAt: "not-a-number" }
    };
    const originalOrigin = item.origin;
    expect(validateServerConfig(item)).toBe(true);
    // FIX 5 — a type guard must not mutate the value it inspects. Stripping
    // the malformed origin is VscodeConfigRepository.getServers()'s job (see
    // test/unit/vscodeConfigRepository.test.ts), not validateServerConfig's.
    // A reverted fix that goes back to `delete obj.origin` here would make
    // this identity check fail.
    expect((item as { origin?: unknown }).origin).toBe(originalOrigin);
    expect((item as { origin?: unknown }).origin).toEqual({ sourceId: "src", externalId: "ext", syncedAt: "not-a-number" });
  });

  it("keeps a well-formed origin unchanged", () => {
    const item = {
      id: "s1",
      name: "Server",
      host: "h",
      port: 22,
      username: "u",
      authType: "agent",
      isHidden: false,
      origin: { sourceId: "src", externalId: "ext", syncedAt: 1000 }
    };
    expect(validateServerConfig(item)).toBe(true);
    expect((item as { origin?: unknown }).origin).toEqual({ sourceId: "src", externalId: "ext", syncedAt: 1000 });
  });
});
