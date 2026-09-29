import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { ActiveTunnel, TunnelRegistryEntry } from "../../src/models/config";
import { stopTunnelsForShutdown, TunnelRegistrySync } from "../../src/services/tunnel/tunnelRegistrySync";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { InMemoryTunnelRegistryStore } from "../../src/storage/inMemoryTunnelRegistryStore";
import { VscodeTunnelRegistryStore } from "../../src/storage/vscodeTunnelRegistryStore";

const fakeFenceFiles = vi.hoisted(() => new Map<string, Uint8Array>());
const fakeFenceMtimes = vi.hoisted(() => new Map<string, number>());
const fakeFenceRead = vi.hoisted(() => ({
  beforeRead: undefined as (() => Promise<void>) | undefined,
  failPath: undefined as string | undefined,
  statFailPath: undefined as string | undefined
}));
vi.mock("vscode", () => {
  class FakeFileSystemError extends Error {
    public constructor(public readonly code: string) {
      super(code);
    }
  }
  return {
    FileType: { File: 1, Directory: 2 },
    FileSystemError: FakeFileSystemError,
    Uri: {
      joinPath: (base: { path: string }, ...segments: string[]) => ({
        path: [base.path, ...segments].join("/").replace(/\/+/g, "/")
      })
    },
    workspace: {
      fs: {
        createDirectory: async () => {},
        readDirectory: async (uri: { path: string }) => {
          const prefix = `${uri.path}/`;
          return [...fakeFenceFiles.keys()]
            .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
            .map((path) => [path.slice(prefix.length), 1] as const);
        },
        readFile: async (uri: { path: string }) => {
          const beforeRead = fakeFenceRead.beforeRead;
          fakeFenceRead.beforeRead = undefined;
          await beforeRead?.();
          if (uri.path === fakeFenceRead.failPath) throw new FakeFileSystemError("NoPermissions");
          const value = fakeFenceFiles.get(uri.path);
          if (!value) throw new FakeFileSystemError("FileNotFound");
          return value;
        },
        stat: async (uri: { path: string }) => {
          if (uri.path === fakeFenceRead.statFailPath) throw new FakeFileSystemError("Unavailable");
          if (!fakeFenceFiles.has(uri.path)) throw new FakeFileSystemError("FileNotFound");
          return { mtime: fakeFenceMtimes.get(uri.path) ?? Date.now() };
        },
        writeFile: async (uri: { path: string }, value: Uint8Array) => {
          fakeFenceFiles.set(uri.path, new Uint8Array(value));
          fakeFenceMtimes.set(uri.path, Date.now());
        },
        rename: async (source: { path: string }, target: { path: string }) => {
          const value = fakeFenceFiles.get(source.path);
          if (!value) throw new FakeFileSystemError("FileNotFound");
          fakeFenceFiles.set(target.path, value);
          fakeFenceMtimes.set(target.path, fakeFenceMtimes.get(source.path) ?? Date.now());
          fakeFenceFiles.delete(source.path);
          fakeFenceMtimes.delete(source.path);
        },
        delete: async (uri: { path: string }) => {
          if (!fakeFenceFiles.delete(uri.path)) throw new FakeFileSystemError("FileNotFound");
        }
      }
    }
  };
});

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

function sharedWindowStores(): [VscodeTunnelRegistryStore, VscodeTunnelRegistryStore, () => void, () => void] {
  const persisted = new Map<string, unknown>();
  const makeState = () => {
    const snapshot = new Map(persisted);
    return {
      keys: () => [...snapshot.keys()],
      get: <T>(key: string, defaultValue?: T): T | undefined =>
        snapshot.has(key) ? snapshot.get(key) as T : defaultValue,
      update: async (key: string, value: unknown): Promise<void> => {
        if (value === undefined) snapshot.delete(key);
        else snapshot.set(key, value);
        // VS Code persists the extension's entire Memento object at once.
        persisted.clear();
        for (const [storedKey, storedValue] of snapshot) persisted.set(storedKey, storedValue);
      },
      refresh: () => {
        snapshot.clear();
        for (const [storedKey, storedValue] of persisted) snapshot.set(storedKey, storedValue);
      }
    };
  };
  const ownerState = makeState();
  const otherState = makeState();
  const context = (globalState: ReturnType<typeof makeState>) => ({
    globalState,
    globalStorageUri: { path: "/shared" }
  }) as unknown as ConstructorParameters<typeof VscodeTunnelRegistryStore>[0];
  return [
    new VscodeTunnelRegistryStore(context(ownerState)),
    new VscodeTunnelRegistryStore(context(otherState)),
    otherState.refresh,
    ownerState.refresh
  ];
}

describe("TunnelRegistrySync", () => {
  let store: InMemoryTunnelRegistryStore;
  let core: NexusCore;
  let sync: TunnelRegistrySync;
  const probePort = vi.fn<(port: number) => Promise<boolean>>();

  beforeEach(async () => {
    vi.useFakeTimers();
    fakeFenceFiles.clear();
    fakeFenceMtimes.clear();
    fakeFenceRead.beforeRead = undefined;
    fakeFenceRead.failPath = undefined;
    fakeFenceRead.statFailPath = undefined;
    store = new InMemoryTunnelRegistryStore();
    core = new NexusCore(new InMemoryConfigRepository());
    await core.initialize();
    probePort.mockResolvedValue(false);
    sync = new TunnelRegistrySync(store, core, "my-session", probePort);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("keeps a published fence when another window saves an earlier array snapshot", async () => {
    const [ownerStore, otherStore, , refreshOwner] = sharedWindowStores();
    const owner = new TunnelRegistrySync(ownerStore, core, "owner", probePort);
    const tunnel = makeTunnel({ id: "retired-1", tunnelType: "reverse", remotePort: 9000 });
    await owner.registerTunnel(tunnel);
    const staleSnapshot = await otherStore.getEntries();
    const neverSettles = new Promise<void>(() => {});

    await owner.unregisterTunnel(tunnel.profileId, {
      tunnel,
      retiredReverseBind: {
        fenceId: tunnel.id,
        routeIdentity: { kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } },
        remotePort: tunnel.remotePort,
        settled: neverSettles
      }
    });
    await otherStore.saveEntries(staleSnapshot);
    refreshOwner();

    expect((await ownerStore.getEntries()).map((entry) => entry.retiredReverseBind?.fenceId))
      .toContain(tunnel.id);
  });

  it("does not restore a settled fence when another window saves its old array snapshot", async () => {
    const [ownerStore, otherStore, refreshOther, refreshOwner] = sharedWindowStores();
    const owner = new TunnelRegistrySync(ownerStore, core, "owner", probePort);
    const tunnel = makeTunnel({ id: "retired-1", tunnelType: "reverse", remotePort: 9000 });
    let releaseFence!: () => void;
    const settled = new Promise<void>((resolve) => { releaseFence = resolve; });
    await owner.registerTunnel(tunnel);
    await owner.unregisterTunnel(tunnel.profileId, {
      tunnel,
      retiredReverseBind: {
        fenceId: tunnel.id,
        routeIdentity: { kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } },
        remotePort: tunnel.remotePort,
        settled
      }
    });
    refreshOther();
    const staleSnapshot = await otherStore.getEntries();
    releaseFence();
    await vi.waitFor(async () => expect(await ownerStore.getEntries()).toEqual([]));

    await otherStore.saveEntries(staleSnapshot);
    refreshOwner();
    expect(await ownerStore.getEntries()).toEqual([]);
  });

  it("clears an active row restored by another window before settling its fence", async () => {
    const [ownerStore, otherStore, refreshOther, refreshOwner] = sharedWindowStores();
    const owner = new TunnelRegistrySync(ownerStore, core, "owner", probePort);
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);
    const tunnel = makeTunnel({ id: "retired-1", tunnelType: "reverse", remotePort: 9000 });
    let releaseFence!: () => void;
    const settled = new Promise<void>((resolve) => { releaseFence = resolve; });
    await owner.registerTunnel(tunnel);
    refreshOther();
    const staleActive = await otherStore.getEntries();

    await owner.unregisterTunnel(tunnel.profileId, {
      tunnel,
      retiredReverseBind: {
        fenceId: tunnel.id,
        routeIdentity: { kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } },
        remotePort: tunnel.remotePort,
        settled
      }
    });
    await otherStore.saveEntries(staleActive);
    refreshOwner();
    expect(await ownerStore.getEntries()).toHaveLength(2);

    releaseFence();
    await vi.waitFor(async () => {
      expect((await ownerStore.getEntries()).some((entry) => entry.retiredReverseBind)).toBe(false);
    });
    refreshOther();
    expect(await other.checkRemoteOwnership(tunnel.profileId, tunnel.localPort)).toBeUndefined();
  });

  it("keeps a newer start of the same profile when an older fence settles", async () => {
    const oldTunnel = makeTunnel({ id: "old", tunnelType: "reverse", remotePort: 9000 });
    const replacement = makeTunnel({
      id: "replacement", serverId: "new-route", tunnelType: "reverse", remotePort: 9001,
      startedAt: oldTunnel.startedAt + 1
    });
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    await sync.registerTunnel(oldTunnel);
    await sync.unregisterTunnel(oldTunnel.profileId, {
      tunnel: oldTunnel,
      retiredReverseBind: {
        fenceId: oldTunnel.id,
        routeIdentity: { kind: "direct", endpoint: { hosts: ["old-route"], port: 22 } },
        remotePort: oldTunnel.remotePort,
        settled
      }
    });
    await sync.registerTunnel(replacement);

    settle();
    await vi.waitFor(async () => {
      expect((await store.getEntries()).some((entry) => entry.retiredReverseBind)).toBe(false);
    });
    expect(await store.getEntries()).toEqual([expect.objectContaining({ activeTunnelId: replacement.id })]);
  });

  it("self-heals a missing replacement row while an older same-profile fence remains", async () => {
    const oldTunnel = makeTunnel({ id: "old", tunnelType: "reverse", remotePort: 9000 });
    const replacement = makeTunnel({ id: "replacement", tunnelType: "reverse", remotePort: 9001 });
    await sync.registerTunnel(oldTunnel);
    await sync.unregisterTunnel(oldTunnel.profileId, {
      tunnel: oldTunnel,
      retiredReverseBind: {
        fenceId: oldTunnel.id,
        routeIdentity: { kind: "direct", endpoint: { hosts: ["old-route"], port: 22 } },
        remotePort: oldTunnel.remotePort,
        settled: new Promise<void>(() => {})
      }
    });
    core.registerTunnel(replacement);
    await sync.registerTunnel(replacement);
    await store.saveEntries([]); // another window overwrites the active array

    await sync.syncNow();

    expect((await store.getEntries()).filter((entry) => !entry.retiredReverseBind))
      .toEqual([expect.objectContaining({ activeTunnelId: replacement.id })]);
  });

  it("removes a published fence after settlement even when the active-array save fails", async () => {
    const tunnel = makeTunnel({ id: "retired-1", tunnelType: "reverse", remotePort: 9000 });
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    await sync.registerTunnel(tunnel);
    vi.spyOn(store, "saveEntries").mockRejectedValueOnce(new Error("registry write failed"));

    await expect(sync.unregisterTunnel(tunnel.profileId, {
      tunnel,
      retiredReverseBind: {
        fenceId: tunnel.id,
        routeIdentity: { kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } },
        remotePort: tunnel.remotePort,
        settled
      }
    })).rejects.toThrow("registry write failed");
    expect((await store.getEntries()).some((entry) => entry.retiredReverseBind?.fenceId === tunnel.id)).toBe(true);

    settle();
    await vi.waitFor(async () => expect(await store.getEntries()).toEqual([]));
  });

  it("stops heartbeating a settled fence when its file deletion fails", async () => {
    const tunnel = makeTunnel({ id: "retired-1", tunnelType: "reverse", remotePort: 9000 });
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
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
    const originalSeen = (await store.getEntries())[0].lastSeen;
    const remove = vi.spyOn(store, "removeFence").mockRejectedValueOnce(new Error("disk unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    settle();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    await sync.syncNow();

    expect((await store.getEntries())[0].lastSeen).toBe(originalSeen);
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.initialize();
    expect(await store.getEntries()).toEqual([]);
    log.mockRestore();
  });

  it("removes expired fence files during the slow cross-window sweep", async () => {
    const [ownerStore, otherStore] = sharedWindowStores();
    const stale = makeEntry({
      ownerSessionId: "old-window",
      tunnelType: "reverse",
      lastSeen: Date.now() - 31_000,
      retiredReverseBind: {
        fenceId: "orphan",
        routeIdentity: JSON.stringify({ kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } }),
        remotePort: 9000
      }
    });
    await ownerStore.publishFence(stale);
    await ownerStore.publishFence({
      ...stale,
      lastSeen: Date.now(),
      retiredReverseBind: { ...stale.retiredReverseBind!, fenceId: "live" }
    });
    expect(fakeFenceFiles.size).toBe(2);
    const other = new TunnelRegistrySync(otherStore, core, "new-window", probePort);

    await other.initialize();
    other.dispose();

    expect(fakeFenceFiles.size).toBe(1);
    expect((await otherStore.getEntries()).map((entry) => entry.retiredReverseBind?.fenceId)).toEqual(["live"]);
  });

  it("does not delete a fence refreshed after the stale sweep reads it", async () => {
    const [ownerStore, otherStore] = sharedWindowStores();
    const stale = makeEntry({
      ownerSessionId: "owner",
      tunnelType: "reverse",
      lastSeen: Date.now() - 31_000,
      retiredReverseBind: {
        fenceId: "racing-fence",
        routeIdentity: JSON.stringify({ kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } }),
        remotePort: 9000
      }
    });
    await ownerStore.publishFence(stale);
    const [oldPath, oldContents] = [...fakeFenceFiles.entries()][0];
    const readEntries = otherStore.getEntries.bind(otherStore);
    vi.spyOn(otherStore, "getEntries").mockImplementationOnce(async () => {
      const observed = await readEntries();
      await ownerStore.publishFence({ ...stale, lastSeen: Date.now() });
      // Model a transient owner-side prune failure: the old immutable version
      // remains while the new publication is already visible to other windows.
      fakeFenceFiles.set(oldPath, oldContents);
      return observed;
    });
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);

    await other.initialize();
    other.dispose();

    expect((await otherStore.getEntries()).map((entry) => entry.retiredReverseBind?.fenceId)).toEqual(["racing-fence"]);
    expect(fakeFenceFiles.size).toBe(1);
  });

  it("re-reads fence files when a listed generation is replaced before read", async () => {
    const [ownerStore, otherStore] = sharedWindowStores();
    const first = makeEntry({
      ownerSessionId: "owner", tunnelType: "reverse", remotePort: 9000,
      retiredReverseBind: {
        fenceId: "rotating-fence",
        routeIdentity: JSON.stringify({ kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } }),
        remotePort: 9000
      }
    });
    await ownerStore.publishFence(first);
    fakeFenceRead.beforeRead = async () => {
      await ownerStore.publishFence({
        ...first, lastSeen: Date.now() + 1, remotePort: 9001,
        retiredReverseBind: { ...first.retiredReverseBind!, remotePort: 9001 }
      });
    };

    expect(await otherStore.getEntries()).toMatchObject([{
      retiredReverseBind: { fenceId: "rotating-fence", remotePort: 9001 }
    }]);
  });

  it("moves a stopped port-zero fence to its late allocated port across windows", async () => {
    const [ownerStore, otherStore] = sharedWindowStores();
    const owner = new TunnelRegistrySync(ownerStore, core, "owner", probePort);
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);
    const tunnel = makeTunnel({ id: "port-zero", tunnelType: "reverse", remotePort: 0 });
    const route = { kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } } as const;
    let allocate!: (port: number | undefined) => void;
    let settle!: () => void;
    const allocatedPort = new Promise<number | undefined>((resolve) => { allocate = resolve; });
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    await owner.registerTunnel(tunnel);
    await owner.unregisterTunnel(tunnel.profileId, {
      tunnel,
      retiredReverseBind: {
        fenceId: tunnel.id,
        routeIdentity: route,
        remotePort: 0,
        settled,
        allocatedPort
      }
    });

    await expect(other.checkRemoteOwnership("different-profile", 12345, {
      routeIdentity: route, remotePort: 34567
    })).resolves.toMatchObject({ retiredReverseBind: { fenceId: tunnel.id, remotePort: 0 } });

    allocate(34567);
    await vi.waitFor(async () => {
      expect((await ownerStore.getEntries())[0].retiredReverseBind?.remotePort).toBe(34567);
    });
    await expect(other.checkRemoteOwnership("different-profile", 12345, {
      routeIdentity: route, remotePort: 23456
    })).resolves.toBeUndefined();
    await expect(other.checkRemoteOwnership("different-profile", 12345, {
      routeIdentity: route, remotePort: 34567
    })).resolves.toMatchObject({ retiredReverseBind: { fenceId: tunnel.id, remotePort: 34567 } });

    settle();
    await vi.waitFor(async () => expect(await ownerStore.getEntries()).toEqual([]));
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
    await vi.waitFor(async () => {
      expect((await store.getEntries())[0].retiredReverseBind?.fenceId).toBe(tunnel.id);
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await shuttingDown;
    expect(subscribedWhileStopping).toBe(true);
    expect(stopAll).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect((await store.getEntries())[0].retiredReverseBind?.fenceId).toBe(tunnel.id);
    releaseFence();
    await vi.waitFor(async () => expect(await store.getEntries()).toEqual([]));
  });

  it("waits for fence-file deletion when the transport closes during shutdown", async () => {
    const tunnel = makeTunnel({ id: "retired-1", tunnelType: "reverse", remotePort: 9000 });
    let closeTransport!: () => void;
    const settled = new Promise<void>((resolve) => { closeTransport = resolve; });
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
    let deletionStarted!: () => void;
    const deleting = new Promise<void>((resolve) => { deletionStarted = resolve; });
    let finishDeletion!: () => void;
    const deletionGate = new Promise<void>((resolve) => { finishDeletion = resolve; });
    const originalRemoveFence = store.removeFence.bind(store);
    vi.spyOn(store, "removeFence").mockImplementation(async (fenceId) => {
      deletionStarted();
      await deletionGate;
      await originalRemoveFence(fenceId);
    });
    let cleanupFinished!: () => void;
    const cleaned = new Promise<void>((resolve) => { cleanupFinished = resolve; });
    const originalCleanup = sync.cleanupOwnEntries.bind(sync);
    vi.spyOn(sync, "cleanupOwnEntries").mockImplementation(async () => {
      await originalCleanup();
      cleanupFinished();
    });

    let shutdownFinished = false;
    const shutdown = stopTunnelsForShutdown(async () => {}, () => {}, sync)
      .then(() => { shutdownFinished = true; });
    await cleaned;
    // Closure can arrive after the first second of shutdown work.
    await vi.advanceTimersByTimeAsync(1_001);
    expect(shutdownFinished).toBe(false);

    closeTransport();
    await deleting;
    expect(shutdownFinished).toBe(false);
    finishDeletion();
    await shutdown;
    expect(await store.getEntries()).toEqual([]);
  });

  it("closes pooled transports after stops have published their fences", async () => {
    let stopped = false;
    const closeTransports = vi.fn(() => { expect(stopped).toBe(true); });

    await stopTunnelsForShutdown(
      async () => { stopped = true; },
      () => {},
      sync,
      closeTransports
    );

    expect(closeTransports).toHaveBeenCalledOnce();
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

  it("finds a fresh reverse-bind fence after an expired matching fence", async () => {
    const route = { kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } } as const;
    const fence = (fenceId: string, ownerSessionId: string, lastSeen: number) => makeEntry({
      ownerSessionId,
      tunnelType: "reverse",
      lastSeen,
      retiredReverseBind: {
        fenceId,
        routeIdentity: JSON.stringify(route),
        remotePort: 9000
      }
    });
    await store.publishFence(fence("expired", "crashed-window", Date.now() - 40_000));
    await store.publishFence(fence("fresh", "live-window", Date.now()));

    await expect(sync.checkRemoteOwnership("different-profile", 12345, {
      routeIdentity: route,
      remotePort: 9000
    })).resolves.toMatchObject({ retiredReverseBind: { fenceId: "fresh" } });
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
  const reverseRoute = { kind: "direct", endpoint: { hosts: ["bastion"], port: 22 } } as const;
  const seedRaw = (name: string, contents: string, ageMs: number): string => {
    const path = `/shared/reverse-bind-fences/${name}`;
    fakeFenceFiles.set(path, new TextEncoder().encode(contents));
    fakeFenceMtimes.set(path, Date.now() - ageMs);
    return path;
  };

  it("keeps an unsettled fence live for other windows past the stale threshold", async () => {
    const [ownerStore, otherStore] = sharedWindowStores();
    const owner = new TunnelRegistrySync(ownerStore, core, "owner", probePort);
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);
    const tunnel = makeTunnel({ id: "hb", tunnelType: "reverse", remotePort: 9000 });
    await owner.initialize();
    await owner.unregisterTunnel(tunnel.profileId, {
      tunnel,
      retiredReverseBind: {
        fenceId: tunnel.id, routeIdentity: reverseRoute, remotePort: 9000, settled: new Promise<void>(() => {})
      }
    });
    let cancelled = false;
    let resolved = false;
    void other.waitForRemoteReverseBindClear({ routeIdentity: reverseRoute, remotePort: 9000 }, () => cancelled)
      .then((value) => { resolved = value; });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(await other.checkRemoteOwnership("elsewhere", 1, { routeIdentity: reverseRoute, remotePort: 9000 }))
      .toMatchObject({ retiredReverseBind: { fenceId: "hb" } });
    expect(resolved).toBe(false);
    cancelled = true;
    owner.dispose();
  });

  it("does not let an expired foreign fence block a replacement start", async () => {
    const [ownerStore, otherStore] = sharedWindowStores();
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);
    await ownerStore.publishFence(makeEntry({
      ownerSessionId: "crashed", tunnelType: "reverse", lastSeen: Date.now() - 31_000,
      retiredReverseBind: { fenceId: "dead", routeIdentity: JSON.stringify(reverseRoute), remotePort: 9000 }
    }));
    let result: boolean | undefined;
    void other.waitForRemoteReverseBindClear({ routeIdentity: reverseRoute, remotePort: 9000 }, () => false)
      .then((value) => { result = value; });

    await vi.advanceTimersByTimeAsync(0);

    expect(result).toBe(true);
  });

  it.each([
    ["truncated JSON", "{trunc"],
    ["an empty file", ""],
    ["JSON null", "null"],
    ["a non-fence object", "{\"profileId\":\"t1\"}"]
  ])("skips %s in the fence directory and sweeps it once stale", async (_label, contents) => {
    const [ownerStore, otherStore] = sharedWindowStores();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await ownerStore.publishFence(makeEntry({
      ownerSessionId: "owner", tunnelType: "reverse", lastSeen: Date.now(),
      retiredReverseBind: { fenceId: "good", routeIdentity: JSON.stringify(reverseRoute), remotePort: 9000 }
    }));
    const fresh = seedRaw("fresh--1.json", contents, 0);
    const old = seedRaw("old--1.json", contents, 31_000);
    // A versioned name carries the writer's clock; a recent one keeps the file.
    const versioned = seedRaw(`v--${Date.now().toString().padStart(13, "0")}-000001-abc.json`, contents, 31_000);
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);

    await other.initialize();

    expect((await otherStore.getEntries()).map((entry) => entry.retiredReverseBind?.fenceId)).toEqual(["good"]);
    expect(fakeFenceFiles.has(old)).toBe(false);
    expect(fakeFenceFiles.has(versioned)).toBe(true);
    // A file that just appeared might still be settling; only stale ones go.
    expect(fakeFenceFiles.has(fresh)).toBe(true);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fakeFenceFiles.has(fresh)).toBe(false);
    other.dispose();
    log.mockRestore();
  });

  it("skips a partial fence file so it cannot block a start, and sweeps it once stale", async () => {
    const [ownerStore, otherStore] = sharedWindowStores();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    probePort.mockClear();
    const partial = JSON.stringify({
      profileId: "t1", ownerSessionId: "crashed",
      retiredReverseBind: { fenceId: "partial", routeIdentity: JSON.stringify(reverseRoute), remotePort: 9000 }
    });
    const fresh = seedRaw("partial-fresh--1.json", partial, 0);
    const old = seedRaw("partial-old--1.json", partial, 31_000);
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);

    await other.initialize();

    expect(await otherStore.getEntries()).toEqual([]);
    expect(await other.checkRemoteOwnership("elsewhere", 1, { routeIdentity: reverseRoute, remotePort: 9000 }))
      .toBeUndefined();
    expect(probePort).not.toHaveBeenCalled();
    expect(fakeFenceFiles.has(old)).toBe(false);
    expect(fakeFenceFiles.has(fresh)).toBe(true);
    void ownerStore;
    other.dispose();
    log.mockRestore();
  });

  it("skips a fence file typed as a non-reverse tunnel so it cannot make a start probe a local port", async () => {
    const [, otherStore] = sharedWindowStores();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    probePort.mockClear();
    probePort.mockResolvedValue(true);
    const path = seedRaw("local-typed--1.json", JSON.stringify(makeEntry({
      ownerSessionId: "crashed", tunnelType: "local", localPort: 8080, lastSeen: Date.now(),
      retiredReverseBind: { fenceId: "typed", routeIdentity: JSON.stringify(reverseRoute), remotePort: 9000 }
    })), 0);
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);

    expect(await otherStore.getEntries()).toEqual([]);
    expect(await other.checkRemoteOwnership("elsewhere", 1, { routeIdentity: reverseRoute, remotePort: 9000 }))
      .toBeUndefined();
    expect(probePort).not.toHaveBeenCalled();
    expect(fakeFenceFiles.has(path)).toBe(true);
    probePort.mockResolvedValue(false);
    log.mockRestore();
  });

  it("keeps heartbeating an owned fence while an unrelated fresh fence file is unreadable", async () => {
    const [ownerStore, otherStore] = sharedWindowStores();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = new TunnelRegistrySync(ownerStore, core, "owner", probePort);
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);
    const tunnel = makeTunnel({ id: "held", tunnelType: "reverse", remotePort: 9000 });
    await owner.initialize();
    await owner.unregisterTunnel(tunnel.profileId, {
      tunnel,
      retiredReverseBind: {
        fenceId: tunnel.id, routeIdentity: reverseRoute, remotePort: 9000, settled: new Promise<void>(() => {})
      }
    });
    const ownedLastSeen = (): number => {
      const seen = [...fakeFenceFiles.entries()]
        .filter(([path]) => path.includes("held"))
        .map(([, bytes]) => (JSON.parse(new TextDecoder().decode(bytes)) as { lastSeen: number }).lastSeen);
      return Math.max(...seen);
    };
    fakeFenceRead.failPath = seedRaw("foreign--1.json", "{}", 0);
    await other.initialize();

    await vi.advanceTimersByTimeAsync(25_000);
    await expect(otherStore.getEntries()).rejects.toThrow();
    expect(Date.now() - ownedLastSeen()).toBeLessThan(5_000);

    // Past 30 s the foreign file is stale and skipped; the owned fence must
    // still be live for other windows and must not have been swept.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await other.checkRemoteOwnership("elsewhere", 1, { routeIdentity: reverseRoute, remotePort: 9000 }))
      .toMatchObject({ retiredReverseBind: { fenceId: "held" } });
    expect([...fakeFenceFiles.keys()].some((path) => path.includes("held"))).toBe(true);
    owner.dispose();
    other.dispose();
    log.mockRestore();
  });

  it("does not fail initialize or syncNow when one stale fence file cannot be read", async () => {
    const [ownerStore, otherStore] = sharedWindowStores();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await ownerStore.publishFence(makeEntry({
      ownerSessionId: "owner", tunnelType: "reverse", lastSeen: Date.now(),
      retiredReverseBind: { fenceId: "good", routeIdentity: JSON.stringify(reverseRoute), remotePort: 9000 }
    }));
    fakeFenceRead.failPath = seedRaw("locked--1.json", "{}", 31_000);
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);

    await expect(other.initialize()).resolves.toBeUndefined();
    await expect(other.syncNow()).resolves.toBeUndefined();
    expect((await otherStore.getEntries()).map((entry) => entry.retiredReverseBind?.fenceId)).toEqual(["good"]);
    other.dispose();
    log.mockRestore();
  });

  it("fails closed instead of hiding a fresh fence that cannot be read", async () => {
    const [ownerStore, otherStore] = sharedWindowStores();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fakeFenceRead.failPath = seedRaw("live--1.json", "{}", 1_000);
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);

    await expect(otherStore.getEntries()).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "NoPermissions" })
    });
    await expect(
      other.waitForRemoteReverseBindClear({ routeIdentity: reverseRoute, remotePort: 9000 }, () => false)
    ).rejects.toThrow();
    expect(fakeFenceFiles.has(fakeFenceRead.failPath)).toBe(true);
    void ownerStore;
    log.mockRestore();
  });

  it("fails closed for an unreadable versioned fence whose mtime lags but whose name is current", async () => {
    const [, otherStore] = sharedWindowStores();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const path = seedRaw(`live--${Date.now().toString().padStart(13, "0")}-000001-abc.json`, "{}", 120_000);
    fakeFenceRead.failPath = path;

    await expect(otherStore.getEntries()).rejects.toThrow();
    expect(fakeFenceFiles.has(path)).toBe(true);
    log.mockRestore();
  });

  it("does not consume the one-time warning when only a later registry save fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.fn();
    const warning = new TunnelRegistrySync(store, core, "w", probePort, warn);
    const tunnel = makeTunnel({ id: "w2", tunnelType: "reverse", remotePort: 9001 });
    const options = {
      tunnel,
      retiredReverseBind: { fenceId: "w2", routeIdentity: reverseRoute, remotePort: 9001, settled: new Promise<void>(() => {}) }
    };
    vi.spyOn(store, "saveEntries").mockRejectedValueOnce(new Error("state write failed"));

    await warning.unregisterTunnelAfterStop(tunnel.profileId, options);
    expect(warn).not.toHaveBeenCalled();

    vi.spyOn(store, "publishFence").mockRejectedValue(new Error("disk full"));
    await warning.unregisterTunnelAfterStop(tunnel.profileId, options);
    await warning.unregisterTunnelAfterStop(tunnel.profileId, options);
    expect(warn).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("warns when the registry read fails before the reservation is published", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.fn();
    const warning = new TunnelRegistrySync(store, core, "w", probePort, warn);
    const tunnel = makeTunnel({ id: "w3", tunnelType: "reverse", remotePort: 9002 });
    const options = {
      tunnel,
      retiredReverseBind: { fenceId: "w3", routeIdentity: reverseRoute, remotePort: 9002, settled: new Promise<void>(() => {}) }
    };
    const publish = vi.spyOn(store, "publishFence");
    vi.spyOn(store, "getEntries").mockRejectedValue(new Error("fresh unreadable fence"));

    await warning.unregisterTunnelAfterStop(tunnel.profileId, options);
    await warning.unregisterTunnelAfterStop(tunnel.profileId, options);

    expect(publish).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("warns once when a stopped reverse tunnel's reservation cannot be published", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.fn();
    const warning = new TunnelRegistrySync(store, core, "w", probePort, warn);
    const tunnel = makeTunnel({ id: "w1", tunnelType: "reverse", remotePort: 9000 });
    vi.spyOn(store, "publishFence").mockRejectedValue(new Error("disk full"));
    const options = {
      tunnel,
      retiredReverseBind: { fenceId: "w1", routeIdentity: reverseRoute, remotePort: 9000, settled: new Promise<void>(() => {}) }
    };

    await warning.unregisterTunnelAfterStop(tunnel.profileId, options);
    await warning.unregisterTunnelAfterStop(tunnel.profileId, options);
    await warning.unregisterTunnelAfterStop("t1");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("9000");
    expect(warn.mock.calls[0][0]).toContain("reload this window");
    log.mockRestore();
  });

  it("reports a failing orphan cleanup once per file, not on every poll", async () => {
    const [, otherStore] = sharedWindowStores();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fakeFenceRead.statFailPath = seedRaw(".z.1.tmp", "{", 60_000);
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);

    await other.initialize();
    await vi.advanceTimersByTimeAsync(30_000);
    other.dispose();

    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("does not sweep a temporary file whose embedded writer timestamp is recent despite an old mtime", async () => {
    const [, otherStore] = sharedWindowStores();
    const path = seedRaw(`.x.${Date.now() - 1_000}-abc.tmp`, "{", 60_000);
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);

    await other.initialize();
    other.dispose();

    expect(fakeFenceFiles.has(path)).toBe(true);
  });

  it("initialize survives a failing registry and its timers raise no unhandled rejections", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    vi.spyOn(store, "getEntries").mockRejectedValue(new Error("storage down"));

    await expect(sync.initialize()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(91_000);
    await vi.advanceTimersByTimeAsync(0);
    process.off("unhandledRejection", onUnhandled);

    expect(unhandled).toEqual([]);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("logs instead of rejecting when the registry write after a stop fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const tunnel = makeTunnel({ id: "stopping", tunnelType: "reverse", remotePort: 9000 });
    vi.spyOn(store, "publishFence").mockRejectedValue(new Error("disk full"));

    await expect(sync.unregisterTunnelAfterStop(tunnel.profileId, {
      tunnel,
      retiredReverseBind: {
        fenceId: tunnel.id, routeIdentity: reverseRoute, remotePort: 9000, settled: new Promise<void>(() => {})
      }
    })).resolves.toBeUndefined();
    vi.spyOn(store, "getEntries").mockRejectedValue(new Error("storage down"));
    await expect(sync.unregisterTunnelAfterStop("t1")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it("awaits durable fence publication before the after-stop call resolves", async () => {
    const [ownerStore] = sharedWindowStores();
    const owner = new TunnelRegistrySync(ownerStore, core, "owner", probePort);
    const tunnel = makeTunnel({ id: "ordered", tunnelType: "reverse", remotePort: 9000 });

    await owner.unregisterTunnelAfterStop(tunnel.profileId, {
      tunnel,
      retiredReverseBind: {
        fenceId: tunnel.id, routeIdentity: reverseRoute, remotePort: 9000, settled: new Promise<void>(() => {})
      }
    });

    expect(fakeFenceFiles.size).toBe(1);
  });

  it("forgets a published fence id once its stop succeeds", async () => {
    const [ownerStore] = sharedWindowStores();
    const owner = new TunnelRegistrySync(ownerStore, core, "owner", probePort);
    for (const id of ["done-1", "done-2"]) {
      const tunnel = makeTunnel({ id, tunnelType: "reverse", remotePort: 9000 });
      await owner.unregisterTunnelAfterStop(tunnel.profileId, {
        tunnel,
        retiredReverseBind: {
          fenceId: id, routeIdentity: reverseRoute, remotePort: 9000, settled: new Promise<void>(() => {})
        }
      });
    }

    expect((owner as unknown as { publishedFences: Set<string> }).publishedFences.size).toBe(0);
  });

  it("sweeps stale orphan temporary files but never a fresh in-flight one", async () => {
    const [, otherStore] = sharedWindowStores();
    const stale = seedRaw(".x.1.tmp", "{", 31_000);
    const fresh = seedRaw(".y.2.tmp", "{", 1_000);
    const other = new TunnelRegistrySync(otherStore, core, "other", probePort);

    await other.initialize();
    other.dispose();

    expect(fakeFenceFiles.has(stale)).toBe(false);
    expect(fakeFenceFiles.has(fresh)).toBe(true);
  });
});
