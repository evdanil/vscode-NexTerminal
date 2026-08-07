import { describe, expect, it, vi } from "vitest";
import { InventorySourceRemovalMismatchError, NexusCore, type InventorySyncApplication } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { validateInventorySource, validateServerConfig } from "../../src/utils/validation";
import type { ServerConfig } from "../../src/models/config";
import type { InventorySourceConfig } from "../../src/models/inventory";

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
