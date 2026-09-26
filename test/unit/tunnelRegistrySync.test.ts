import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { ActiveTunnel, TunnelRegistryEntry } from "../../src/models/config";
import { stopTunnelsForShutdown, TunnelRegistrySync } from "../../src/services/tunnel/tunnelRegistrySync";
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

  it("publishes a reverse-bind tombstone across windows until remote cancellation or close is confirmed", async () => {
    let releaseFence!: () => void;
    const settled = new Promise<void>((resolve) => { releaseFence = resolve; });
    const tunnel = makeTunnel({ id: "retired-1", tunnelType: "reverse", remotePort: 9000 });
    const retiredRoute = { kind: "direct", endpoint: { hosts: ["old-primary", "alternate"], port: 22 } } as const;
    const overlappingRoute = { kind: "direct", endpoint: { hosts: ["alternate", "new-primary"], port: 22 } } as const;
    const unrelatedRoute = { kind: "direct", endpoint: { hosts: ["unrelated"], port: 22 } } as const;
    await sync.registerTunnel(tunnel);

    const unregistering = sync.unregisterTunnel("t1", {
      tunnel,
      retiredReverseBind: {
        fenceId: tunnel.id,
        routeIdentity: retiredRoute,
        remotePort: 9000,
        settled
      }
    });
    await vi.waitFor(async () => {
      expect(await store.getEntries()).toHaveLength(1);
      expect((await store.getEntries())[0].retiredReverseBind?.fenceId).toBe(tunnel.id);
    });

    const secondCore = new NexusCore(new InMemoryConfigRepository());
    await secondCore.initialize();
    const secondWindow = new TunnelRegistrySync(store, secondCore, "second-window", probePort);
    await secondWindow.initialize();
    expect(secondCore.getSnapshot().remoteTunnels).toEqual([]);
    await expect(secondWindow.checkRemoteOwnership("t1", 8080, {
      routeIdentity: unrelatedRoute,
      remotePort: 9000
    })).resolves.toBeUndefined();
    await expect(secondWindow.checkRemoteOwnership("different-profile", 9090, {
      routeIdentity: overlappingRoute,
      remotePort: 9000
    })).resolves.toMatchObject({ retiredReverseBind: { fenceId: tunnel.id } });

    let waitResolved = false;
    const waiting = secondWindow.waitForRemoteReverseBindClear(
      { routeIdentity: overlappingRoute, remotePort: 9000 },
      () => false
    ).then((released) => { waitResolved = released; return released; });
    await vi.advanceTimersByTimeAsync(250);
    expect(waitResolved).toBe(false);
    secondWindow.dispose();

    releaseFence();
    await unregistering;
    await vi.advanceTimersByTimeAsync(250);
    await expect(waiting).resolves.toBe(true);
    await vi.waitFor(async () => expect(await store.getEntries()).toEqual([]));
  });

  it("keeps both reverse-bind fences when concurrent stops read the same registry snapshot", async () => {
    const first = makeTunnel({ id: "retired-1", profileId: "t1", tunnelType: "reverse", remotePort: 9000 });
    const second = makeTunnel({ id: "retired-2", profileId: "t2", tunnelType: "reverse", remotePort: 9001 });
    await sync.registerTunnel(first);
    await sync.registerTunnel(second);

    const neverSettles = new Promise<void>(() => {});
    const retire = (tunnel: ActiveTunnel) => sync.unregisterTunnel(tunnel.profileId, {
      tunnel,
      retiredReverseBind: {
        fenceId: tunnel.id,
        routeIdentity: { kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } },
        remotePort: tunnel.remotePort,
        settled: neverSettles
      }
    });

    await Promise.all([retire(first), retire(second)]);
    const entries = await store.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.retiredReverseBind?.fenceId).sort()).toEqual([first.id, second.id]);
  });

  it("does not restore a settled reverse-bind fence from a stale heartbeat snapshot", async () => {
    let releaseFence!: () => void;
    const settled = new Promise<void>((resolve) => { releaseFence = resolve; });
    const tunnel = makeTunnel({ id: "retired-1", tunnelType: "reverse", remotePort: 9000 });
    await sync.initialize();
    await sync.registerTunnel(tunnel);
    await sync.unregisterTunnel(tunnel.profileId, {
      tunnel,
      retiredReverseBind: {
        fenceId: tunnel.id,
        routeIdentity: { kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } },
        remotePort: tunnel.remotePort,
        settled
      }
    });

    const staleSnapshot = await store.getEntries();
    expect(staleSnapshot[0].retiredReverseBind?.fenceId).toBe(tunnel.id);
    let releaseHeartbeatRead!: (entries: TunnelRegistryEntry[]) => void;
    const heartbeatRead = new Promise<TunnelRegistryEntry[]>((resolve) => { releaseHeartbeatRead = resolve; });
    vi.spyOn(store, "getEntries").mockImplementationOnce(() => heartbeatRead);
    const heartbeat = sync.syncNow();

    releaseFence();
    releaseHeartbeatRead(staleSnapshot);
    await heartbeat;
    await vi.waitFor(async () => expect(await store.getEntries()).toEqual([]));
    await sync.syncNow();
    expect(await store.getEntries()).toEqual([]);
  });

  it("keeps an unresolved reverse-bind fence during own-entry shutdown cleanup", async () => {
    let releaseFence!: () => void;
    const settled = new Promise<void>((resolve) => { releaseFence = resolve; });
    const tunnel = makeTunnel({ id: "retired-1", tunnelType: "reverse", remotePort: 9000 });
    await sync.registerTunnel(tunnel);
    await sync.unregisterTunnel(tunnel.profileId, {
      tunnel,
      retiredReverseBind: {
        fenceId: tunnel.id,
        routeIdentity: { kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } },
        remotePort: tunnel.remotePort,
        settled
      }
    });

    await sync.cleanupOwnEntries();
    expect((await store.getEntries())[0].retiredReverseBind?.fenceId).toBe(tunnel.id);
    releaseFence();
    await vi.waitFor(async () => expect(await store.getEntries()).toEqual([]));
  });

  it("keeps the tunnel listener until shutdown stops publish their fences", async () => {
    let releaseFence!: () => void;
    const settled = new Promise<void>((resolve) => { releaseFence = resolve; });
    const tunnel = makeTunnel({ id: "retired-1", tunnelType: "reverse", remotePort: 9000 });
    core.registerTunnel(tunnel);
    await sync.registerTunnel(tunnel);

    let subscribed = true;
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const stopAll = vi.fn(async () => {
      await stopGate;
      if (subscribed) {
        core.unregisterTunnel(tunnel.id);
        await sync.unregisterTunnel(tunnel.profileId, {
          tunnel,
          retiredReverseBind: {
            fenceId: tunnel.id,
            routeIdentity: { kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } },
            remotePort: tunnel.remotePort,
            settled
          }
        });
      }
    });
    const unsubscribe = vi.fn(() => { subscribed = false; });

    const shuttingDown = stopTunnelsForShutdown(stopAll, unsubscribe, sync);
    const subscribedWhileStopping = subscribed;
    releaseStop();
    await shuttingDown;
    expect(subscribedWhileStopping).toBe(true);
    expect(stopAll).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect((await store.getEntries())[0].retiredReverseBind?.fenceId).toBe(tunnel.id);
    releaseFence();
    await vi.waitFor(async () => expect(await store.getEntries()).toEqual([]));
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
