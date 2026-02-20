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
});
