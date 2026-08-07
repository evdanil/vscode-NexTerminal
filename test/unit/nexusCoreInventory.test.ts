import { describe, expect, it, vi } from "vitest";
import { NexusCore, type InventorySyncApplication } from "../../src/core/nexusCore";
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
