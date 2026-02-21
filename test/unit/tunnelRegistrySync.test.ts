import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { ActiveTunnel, TunnelRegistryEntry } from "../../src/models/config";
import { TunnelRegistrySync } from "../../src/services/tunnel/tunnelRegistrySync";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { InMemoryTunnelRegistryStore } from "../../src/storage/inMemoryTunnelRegistryStore";

function makeTunnel(overrides: Partial<ActiveTunnel> = {}): ActiveTunnel {
  return {
    id: "active-1",
    profileId: "t1",
    serverId: "s1",
    localPort: 8080,
    remoteIP: "10.0.0.5",
    remotePort: 3306,
    connectionMode: "shared",
    tunnelType: "local",
    startedAt: Date.now(),
    bytesIn: 0,
    bytesOut: 0,
    ...overrides
  };
}

function makeEntry(overrides: Partial<TunnelRegistryEntry> = {}): TunnelRegistryEntry {
  return {
    profileId: "t1",
    serverId: "s1",
    localPort: 8080,
    remoteIP: "10.0.0.5",
    remotePort: 3306,
    connectionMode: "shared",
    tunnelType: "local",
    startedAt: Date.now(),
    ownerSessionId: "other-session",
    ...overrides
  };
}

describe("TunnelRegistrySync", () => {
  let store: InMemoryTunnelRegistryStore;
  let core: NexusCore;
  let sync: TunnelRegistrySync;
  const probePort = vi.fn<(port: number) => Promise<boolean>>();

  beforeEach(async () => {
    vi.useFakeTimers();
    store = new InMemoryTunnelRegistryStore();
    core = new NexusCore(new InMemoryConfigRepository());
    await core.initialize();
    probePort.mockResolvedValue(false);
    sync = new TunnelRegistrySync(store, core, "my-session", probePort);
  });

  afterEach(() => {
    sync.dispose();
    vi.useRealTimers();
  });

  it("registers and unregisters a tunnel", async () => {
    await sync.initialize();
    const tunnel = makeTunnel();
    await sync.registerTunnel(tunnel);

    const entries = await store.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].profileId).toBe("t1");
    expect(entries[0].ownerSessionId).toBe("my-session");

    await sync.unregisterTunnel("t1");
    expect(await store.getEntries()).toHaveLength(0);
  });

  it("cleanupOwnEntries removes only own entries", async () => {
    await store.saveEntries([
      makeEntry({ ownerSessionId: "my-session", profileId: "t1" }),
      makeEntry({ ownerSessionId: "other-session", profileId: "t2" })
    ]);
    probePort.mockResolvedValue(true);
    await sync.initialize();
    await sync.cleanupOwnEntries();

    const entries = await store.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].ownerSessionId).toBe("other-session");
  });

  it("syncNow populates remoteTunnels in NexusCore", async () => {
    const remoteEntry = makeEntry({ ownerSessionId: "other-session" });
    await store.saveEntries([remoteEntry]);
    probePort.mockResolvedValue(true);

    await sync.initialize();

    const snapshot = core.getSnapshot();
    expect(snapshot.remoteTunnels).toHaveLength(1);
    expect(snapshot.remoteTunnels[0].profileId).toBe("t1");
  });

  it("does not include own entries in remoteTunnels", async () => {
    await store.saveEntries([makeEntry({ ownerSessionId: "my-session" })]);
    await sync.initialize();

    expect(core.getSnapshot().remoteTunnels).toHaveLength(0);
  });

  it("checkRemoteOwnership returns entry when port is alive", async () => {
    await store.saveEntries([makeEntry()]);
    probePort.mockResolvedValue(true);
    await sync.initialize();

    const result = await sync.checkRemoteOwnership("t1", 8080);
    expect(result).toBeDefined();
    expect(result?.ownerSessionId).toBe("other-session");
  });

  it("checkRemoteOwnership returns undefined when port is dead", async () => {
    await store.saveEntries([makeEntry()]);
    probePort.mockResolvedValue(false);
    await sync.initialize();

    const result = await sync.checkRemoteOwnership("t1", 8080);
    expect(result).toBeUndefined();
  });

  it("checkRemoteOwnership ignores own entries", async () => {
    await store.saveEntries([makeEntry({ ownerSessionId: "my-session" })]);
    probePort.mockResolvedValue(true);
    await sync.initialize();

    const result = await sync.checkRemoteOwnership("t1", 8080);
    expect(result).toBeUndefined();
  });

  it("checkRemoteOwnership matches by localPort even with different profileId", async () => {
    await store.saveEntries([makeEntry({ profileId: "t-other", localPort: 8080 })]);
    probePort.mockResolvedValue(true);
    await sync.initialize();

    const result = await sync.checkRemoteOwnership("t1", 8080);
    expect(result).toBeDefined();
  });

  it("syncWithProbe cleans stale remote entries", async () => {
    await store.saveEntries([makeEntry()]);
    probePort.mockResolvedValue(false);
    await sync.initialize();

    // After initialize (which does syncWithProbe), stale entry should be cleaned
    const entries = await store.getEntries();
    expect(entries).toHaveLength(0);
    expect(core.getSnapshot().remoteTunnels).toHaveLength(0);
  });

  it("self-heals missing own entries during syncFast", async () => {
    await sync.initialize();

    // Register a tunnel locally
    core.registerTunnel(makeTunnel());

    // syncNow triggers syncFast which should re-register the missing entry
    await sync.syncNow();

    const entries = await store.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].ownerSessionId).toBe("my-session");
  });

  it("registerTunnel sets lastSeen timestamp", async () => {
    await sync.initialize();
    const tunnel = makeTunnel();
    await sync.registerTunnel(tunnel);

    const entries = await store.getEntries();
    expect(entries[0].lastSeen).toBeDefined();
    expect(typeof entries[0].lastSeen).toBe("number");
  });

  it("syncFast refreshes lastSeen on own active entries", async () => {
    await sync.initialize();
    const tunnel = makeTunnel();
    await sync.registerTunnel(tunnel);
    core.registerTunnel(tunnel);

    const entriesBefore = await store.getEntries();
    const initialLastSeen = entriesBefore[0].lastSeen!;

    // Advance time and sync
    vi.advanceTimersByTime(5_000);
    await sync.syncNow();

    const entriesAfter = await store.getEntries();
    expect(entriesAfter[0].lastSeen).toBeGreaterThan(initialLastSeen);
  });

  it("checkRemoteOwnership detects stale reverse tunnel entries", async () => {
    // Create a reverse tunnel entry with an old lastSeen
    const staleTime = Date.now() - 200_000; // well past the threshold
    await store.saveEntries([
      makeEntry({ tunnelType: "reverse", lastSeen: staleTime })
    ]);
    await sync.initialize();

    const result = await sync.checkRemoteOwnership("t1", 8080);
    expect(result).toBeUndefined();
  });

  it("checkRemoteOwnership trusts fresh reverse tunnel entries", async () => {
    await store.saveEntries([
      makeEntry({ tunnelType: "reverse", lastSeen: Date.now() })
    ]);
    await sync.initialize();

    const result = await sync.checkRemoteOwnership("t1", 8080);
    expect(result).toBeDefined();
  });

  it("syncWithProbe evicts stale reverse tunnel entries", async () => {
    const staleTime = Date.now() - 200_000;
    await store.saveEntries([
      makeEntry({ tunnelType: "reverse", lastSeen: staleTime })
    ]);
    await sync.initialize();

    // syncWithProbe runs during initialize — stale reverse entry should be cleaned
    const entries = await store.getEntries();
    expect(entries).toHaveLength(0);
    expect(core.getSnapshot().remoteTunnels).toHaveLength(0);
  });

  it("syncWithProbe keeps fresh reverse tunnel entries", async () => {
    await store.saveEntries([
      makeEntry({ tunnelType: "reverse", lastSeen: Date.now() })
    ]);
    probePort.mockResolvedValue(true);
    await sync.initialize();

    const entries = await store.getEntries();
    expect(entries).toHaveLength(1);
    expect(core.getSnapshot().remoteTunnels).toHaveLength(1);
  });

  it("reverse entries without lastSeen use startedAt for staleness", async () => {
    // Simulate a pre-heartbeat entry (no lastSeen) with old startedAt
    const oldStart = Date.now() - 200_000;
    await store.saveEntries([
      makeEntry({ tunnelType: "reverse", startedAt: oldStart })
    ]);
    await sync.initialize();

    // Should be evicted since startedAt is too old
    const entries = await store.getEntries();
    expect(entries).toHaveLength(0);
  });
});
