import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import { NexusCore } from "../../src/core/nexusCore";
import type { ActiveTunnel, TunnelProfile, TunnelRegistryEntry } from "../../src/models/config";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { isTunnelStartCurrent, registerTunnelCommands, startTunnel } from "../../src/commands/tunnelCommands";
import type { ServerConfig } from "../../src/models/config";
import { configMutationLock } from "../../src/services/configMutationLock";
import { TunnelStoppedError } from "../../src/services/tunnel/tunnelManager";
import type { NetworkRouteIdentity } from "../../src/services/ssh/sshNetworkRoute";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowQuickPick = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockWithProgress = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn()
  },
  window: {
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
    withProgress: (...args: unknown[]) => mockWithProgress(...args)
  },
  env: {
    clipboard: { writeText: vi.fn() },
    openExternal: vi.fn()
  },
  Uri: { parse: vi.fn((value: string) => value) },
  ProgressLocation: { Notification: 15 },
  EventEmitter: class {
    public readonly event = vi.fn();
    public fire = vi.fn();
  },
  TreeItem: class {
    public id?: string;
    public tooltip?: string;
    public description?: string;
    public contextValue?: string;
    public iconPath?: unknown;
    public constructor(
      public readonly label: string,
      public readonly collapsibleState?: number
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    public constructor(
      public readonly id: string,
      public readonly color?: unknown
    ) {}
  },
  ThemeColor: class {
    public constructor(public readonly id: string) {}
  },
  DataTransferItem: class {
    public constructor(private readonly value: string) {}
    public async asString(): Promise<string> {
      return this.value;
    }
  }
}));

function makeTunnel(overrides: Partial<TunnelProfile> = {}): TunnelProfile {
  return {
    id: "t1",
    name: "Tunnel 1",
    localPort: 8080,
    remoteIP: "127.0.0.1",
    remotePort: 80,
    autoStart: false,
    ...overrides
  };
}

async function setupContext(tunnels: TunnelProfile[]): Promise<CommandContext> {
  const repo = new InMemoryConfigRepository([], tunnels);
  const core = new NexusCore(repo);
  await core.initialize();
  return {
    core,
    tunnelManager: {} as any,
    serialSidecar: {} as any,
    sshFactory: {} as any,
    sshPool: {} as any,
    loggerFactory: {} as any,
    sessionLogDir: "",
    terminalsByServer: new Map() as any,
    sessionTerminals: new Map() as any,
    serialTerminals: new Map() as any,
    localShellTerminals: new Map() as any,
    localServerTerminals: new Map() as any,
    highlighter: {} as any,
    macroAutoTrigger: {} as any,
    sftpService: {} as any,
    fileExplorerProvider: {} as any,
    secretVault: undefined,
    registrySync: undefined,
    activityIndicators: new Map(),
    globalStoragePath: "",
    extensionPath: "",
    globalState: {} as any
  };
}

describe("tunnelCommands pickTunnel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("offers the tunnel QuickPick in natural (numeric) name order", async () => {
    const ctx = await setupContext([
      makeTunnel({ id: "t10", name: "A10" }),
      makeTunnel({ id: "t2", name: "A2" }),
      makeTunnel({ id: "t1", name: "A1" })
    ]);
    registerTunnelCommands(ctx);
    mockShowQuickPick.mockResolvedValue(undefined);

    const copyInfo = registeredCommands.get("nexus.tunnel.copyInfo");
    expect(copyInfo).toBeDefined();
    await copyInfo!();

    const items = mockShowQuickPick.mock.calls[0][0] as Array<{ profile: TunnelProfile }>;
    expect(items.map((item) => item.profile.name)).toEqual(["A1", "A2", "A10"]);
  });
});

/** Two macrotask turns — enough for every mocked prompt to settle and the command to park. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Parks INSIDE the lock until released — the "already in the critical section,
 * still awaiting its I/O" phase these races need to be pinned against rather
 * than raced for (copied from test/unit/authProfileCommands.test.ts).
 */
function gatedLockedWrite(
  lock: { runExclusive: <T>(fn: () => Promise<T>) => Promise<T> },
  write: () => Promise<void>
): { done: Promise<void>; release: () => void } {
  const gate = deferred<void>();
  const done = lock.runExclusive(async () => {
    await gate.promise;
    await write();
  });
  return { done, release: () => gate.resolve() };
}

/** The confirmation modal call, told apart from a bare refusal by its `{ modal: true }` options. */
function modalCalls(): unknown[][] {
  return mockShowWarningMessage.mock.calls.filter((call) => {
    const options = call[1];
    return typeof options === "object" && options !== null && (options as { modal?: boolean }).modal === true;
  });
}

/** Every non-modal warning — the refusals this fix introduces. */
function refusals(): string[] {
  return mockShowWarningMessage.mock.calls.filter((call) => call.length === 1).map((call) => String(call[0]));
}

function makeActiveTunnel(profileId: string): ActiveTunnel {
  return {
    id: "at-1",
    profileId,
    serverId: "srv-1",
    localPort: 8080,
    remoteIP: "127.0.0.1",
    remotePort: 80,
    connectionMode: "shared",
    tunnelType: "local",
    startedAt: Date.now(),
    bytesIn: 0,
    bytesOut: 0
  };
}

function makeRegistryEntry(profileId: string): TunnelRegistryEntry {
  return {
    profileId,
    serverId: "srv-1",
    localPort: 8080,
    remoteIP: "127.0.0.1",
    remotePort: 80,
    connectionMode: "shared",
    tunnelType: "local",
    startedAt: Date.now(),
    ownerSessionId: "other-window"
  };
}

/**
 * REMOVE-MUTATION-RACE FAMILY — nexus.tunnel.remove described state sampled at
 * one moment (the profile's name, and whether the tunnel is running in ANOTHER
 * VS Code window) and then stopped + deleted by id from those pre-modal copies:
 * no lock, no presence re-check, no revalidation of what had been disclosed.
 *
 * Every concurrent operation below is GATED — it parks in a deferred modal or
 * inside the lock and is released by the test — so it is guaranteed to land in
 * the window under test rather than usually winning a race. Each assertion is on
 * PERSISTED state (the repository behind NexusCore), not on a modal having been
 * shown.
 */
describe("nexus.tunnel.remove — the disclosure is re-checked under the lock (REMOVE-MUTATION-RACE FAMILY)", () => {
  async function fixture(tunnels: TunnelProfile[]): Promise<{
    ctx: CommandContext;
    core: NexusCore;
    repo: InMemoryConfigRepository;
    stop: ReturnType<typeof vi.fn>;
  }> {
    const repo = new InMemoryConfigRepository([], tunnels);
    const core = new NexusCore(repo);
    await core.initialize();
    const stop = vi.fn(async () => {});
    const ctx = {
      core,
      tunnelManager: { stop },
      sshFactory: {},
      registrySync: undefined
    } as unknown as CommandContext;
    registerTunnelCommands(ctx);
    return { ctx, core, repo, stop };
  }

  function removeTunnel(id: string): Promise<unknown> {
    const cmd = registeredCommands.get("nexus.tunnel.remove");
    expect(cmd).toBeDefined();
    return Promise.resolve(cmd!(id));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("removes the tunnel — stopping its running local tunnel and persisting the deletion — when nothing changed while the confirmation was open", async () => {
    const { core, repo, stop } = await fixture([makeTunnel(), makeTunnel({ id: "t2", name: "Tunnel 2" })]);
    core.registerTunnel(makeActiveTunnel("t1"));
    mockShowWarningMessage.mockResolvedValue("Remove");

    await removeTunnel("t1");

    expect(stop).toHaveBeenCalledWith("at-1");
    expect((await repo.getTunnels()).map((t) => t.id)).toEqual(["t2"]);
    expect(refusals()).toEqual([]);
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("refuses when the tunnel started running in ANOTHER window while the confirmation was open, instead of removing the profile behind a warning the user was never shown (kills sampling remoteTunnels before the modal and never looking again)", async () => {
    const { core, repo, stop } = await fixture([makeTunnel()]);
    core.registerTunnel(makeActiveTunnel("t1"));

    const modal = deferred<string>();
    mockShowWarningMessage.mockReturnValueOnce(modal.promise);
    const run = removeTunnel("t1");
    await settle();

    // The plain question — this window believes nobody else is running it.
    expect(modalCalls()).toHaveLength(1);
    expect(modalCalls()[0][0]).toBe('Remove tunnel "Tunnel 1"?');

    // TunnelRegistrySync polls on window focus and on its own timer, holding no
    // lock: another window claims the tunnel while the modal sits open. Had the
    // user been asked NOW they would have been told the running tunnel survives
    // the removal — the whole point of the second question.
    core.setRemoteTunnels([makeRegistryEntry("t1")]);

    modal.resolve("Remove");
    await run;

    // The pre-fix implementation stops and deletes here regardless.
    expect((await repo.getTunnels()).map((t) => t.id)).toEqual(["t1"]);
    expect(stop).not.toHaveBeenCalled();
    // Names WHAT changed, not merely that something did: the profile itself is
    // untouched here, so the generic "Tunnel … changed" this used to emit sent
    // the user hunting for a rename that never happened.
    expect(refusals()).toEqual([
      'Tunnel "Tunnel 1" started running in another window while the confirmation was open — ' +
        "nothing was removed. Remove it again to review the current details."
    ]);
  });

  it("names the OTHER direction of the same flip — the tunnel stopped running elsewhere while the confirmation was open — rather than reusing the started-running sentence (kills hardcoding one direction, and kills falling back to the generic changed refusal)", async () => {
    const { core, repo, stop } = await fixture([makeTunnel()]);
    core.registerTunnel(makeActiveTunnel("t1"));
    // This window believes another one is running it, so the modal carries the
    // "won't stop the running tunnel" warning.
    core.setRemoteTunnels([makeRegistryEntry("t1")]);

    const modal = deferred<string>();
    mockShowWarningMessage.mockReturnValueOnce(modal.promise);
    const run = removeTunnel("t1");
    await settle();

    expect(modalCalls()[0][0]).toBe(
      'Tunnel "Tunnel 1" is running in another window. Removing the profile won\'t stop the running tunnel. Remove anyway?'
    );

    // The other window closes its tunnel; TunnelRegistrySync's poll clears it.
    core.setRemoteTunnels([]);

    modal.resolve("Remove");
    await run;

    expect((await repo.getTunnels()).map((t) => t.id)).toEqual(["t1"]);
    expect(stop).not.toHaveBeenCalled();
    expect(refusals()).toEqual([
      'Tunnel "Tunnel 1" stopped running in another window while the confirmation was open — ' +
        "nothing was removed. Remove it again to review the current details."
    ]);
  });

  it("refuses when the tunnel was renamed while the confirmation was open, rather than deleting a profile under a name the user never agreed to (kills a presence-only re-check)", async () => {
    const { core, repo, stop } = await fixture([makeTunnel()]);
    core.registerTunnel(makeActiveTunnel("t1"));

    const modal = deferred<string>();
    mockShowWarningMessage.mockReturnValueOnce(modal.promise);
    const run = removeTunnel("t1");
    await settle();

    // Still present under the same id — a presence-only guard sees "yes, still
    // there" and deletes the renamed record.
    await core.addOrUpdateTunnel({ ...core.getTunnel("t1")!, name: "Prod DB Forward" });

    modal.resolve("Remove");
    await run;

    expect((await repo.getTunnels()).map((t) => t.name)).toEqual(["Prod DB Forward"]);
    expect(stop).not.toHaveBeenCalled();
    // Quoted by the name the MODAL used, not the new one. The GENERIC sentence:
    // the running-elsewhere clause did not move, so the refusal must not claim
    // it did — and it stays generic rather than saying "was renamed" because the
    // check re-renders the whole disclosure and would catch a future third input
    // this wording could not name.
    expect(refusals()).toEqual([
      'Tunnel "Tunnel 1" changed while the confirmation was open — nothing was removed. ' +
        "Remove it again to review the current details."
    ]);
  });

  it("reports that the tunnel was already removed, and does not mistake that for a changed disclosure, when it was deleted while the confirmation was open (kills re-rendering the disclosure off a record that is no longer there)", async () => {
    const { core, repo, stop } = await fixture([makeTunnel(), makeTunnel({ id: "t2", name: "Tunnel 2" })]);
    core.registerTunnel(makeActiveTunnel("t1"));

    const modal = deferred<string>();
    mockShowWarningMessage.mockReturnValueOnce(modal.promise);
    const run = removeTunnel("t1");
    await settle();

    // A replace-mode import's wipe (configCommands' importMergeReplaceLocked
    // deletes every existing tunnel by id) lands while the modal sits open.
    await core.removeTunnel("t1");

    modal.resolve("Remove");
    // The presence re-check has to come FIRST inside the lock: a disclosure
    // re-render that assumes the record is still there dereferences
    // `undefined.name` and rejects this promise with a TypeError.
    await expect(run).resolves.toBeUndefined();

    expect(stop).not.toHaveBeenCalled();
    expect((await repo.getTunnels()).map((t) => t.id)).toEqual(["t2"]);
    expect(mockShowInformationMessage).toHaveBeenCalledWith('Tunnel "Tunnel 1" was already removed.');
    // Distinct from the changed-since-confirmed refusal — the record is gone,
    // not different.
    expect(refusals()).toEqual([]);
  });

  it("queues its whole mutation behind an in-flight locked section and refuses when that section renamed the tunnel (kills the lock-free stop+delete, which commits before any concurrent holder can)", async () => {
    const { core, repo, stop } = await fixture([makeTunnel()]);
    core.registerTunnel(makeActiveTunnel("t1"));
    mockShowWarningMessage.mockResolvedValue("Remove");

    // A replace-mode import / complete reset stand-in: already inside the lock,
    // still awaiting its own I/O.
    const gated = gatedLockedWrite(configMutationLock, async () => {
      await core.addOrUpdateTunnel({ ...core.getTunnel("t1")!, name: "Prod DB Forward" });
    });
    await settle();

    const run = removeTunnel("t1");
    await settle();

    // THE KILL. The modal has already answered, so a lock-free implementation has
    // finished stopping and deleting by now — before the holder it should be
    // queued behind has even started its body.
    expect(modalCalls()).toHaveLength(1);
    expect((await repo.getTunnels()).map((t) => t.id)).toEqual(["t1"]);
    expect(stop).not.toHaveBeenCalled();

    gated.release();
    await gated.done;
    await run;

    expect((await repo.getTunnels()).map((t) => t.name)).toEqual(["Prod DB Forward"]);
    expect(stop).not.toHaveBeenCalled();
    expect(refusals()).toEqual([
      'Tunnel "Tunnel 1" changed while the confirmation was open — nothing was removed. ' +
        "Remove it again to review the current details."
    ]);
  });
});

describe("startTunnel — telnet servers", () => {
  function telnetServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
    return {
      id: "srv-telnet",
      name: "eve-r1",
      host: "10.0.0.1",
      port: 23,
      username: "",
      authType: "password",
      isHidden: false,
      protocol: "telnet",
      ...overrides
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  // ⊘ THE SINGLE CHOKEPOINT. Every route into starting a tunnel — the command,
  // the tree's drag-and-drop of a tunnel profile onto a server, the auto-start
  // sweep on connect, the edit-then-restart path — funnels through this
  // function, so a guard placed anywhere else leaves the others reaching for an
  // SSH connection a telnet server cannot supply.
  it("refuses to start against a telnet server and touches neither the pool nor the manager", async () => {
    const ctx = await setupContext([makeTunnel()]);
    const start = vi.fn();
    const connect = vi.fn();

    await startTunnel(
      ctx.core,
      { start } as never,
      { connect } as never,
      makeTunnel(),
      telnetServer(),
      "isolated"
    );

    expect(start).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Port forwarding is not available for telnet servers")
    );
  });

  it("does not refuse an ordinary SSH server", async () => {
    const ctx = await setupContext([makeTunnel()]);
    await ctx.core.addOrUpdateServer(telnetServer({ protocol: undefined, port: 22 }));
    const start = vi.fn(async () => makeActiveTunnel("t1"));

    await startTunnel(
      ctx.core,
      { start } as never,
      { connect: vi.fn() } as never,
      ctx.core.getTunnel("t1")!,
      ctx.core.getServer("srv-telnet")!,
      "isolated"
    );

    expect(mockShowWarningMessage).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("startTunnel — retired reverse-bind reservations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("warns about an active reverse tunnel in another window before authenticating", async () => {
    const profile = makeTunnel({ tunnelType: "reverse", remotePort: 9000 });
    const ctx = await setupContext([profile]);
    const server: ServerConfig = {
      id: "srv-1", name: "Bastion", host: "10.0.0.1", port: 22,
      username: "ops", authType: "password", isHidden: false
    };
    await ctx.core.addOrUpdateServer(server);
    const registrySync = {
      syncNow: vi.fn(async () => {}),
      checkRemoteOwnership: vi.fn(async () => ({
        ...makeRegistryEntry(profile.id), tunnelType: "reverse" as const
      }))
    };
    const connect = vi.fn();
    const start = vi.fn();

    await startTunnel(
      ctx.core, { start } as never, { connect } as never,
      ctx.core.getTunnel(profile.id)!, ctx.core.getServer(server.id)!, "shared", registrySync as never
    );

    expect(registrySync.checkRemoteOwnership).toHaveBeenCalledWith(profile.id, profile.localPort, undefined);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("already active in another VS Code window"), "Open in Browser"
    );
    expect(mockWithProgress).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("waits for a matching cross-window reservation instead of claiming the tunnel is active", async () => {
    const profile = makeTunnel({ tunnelType: "reverse", remotePort: 9000, remoteBindAddress: "127.0.0.1" });
    const ctx = await setupContext([profile]);
    const server: ServerConfig = {
      id: "srv-1", name: "Bastion", host: "10.0.0.1", port: 22,
      username: "ops", authType: "password", isHidden: false
    };
    await ctx.core.addOrUpdateServer(server);
    const route = { kind: "direct", endpoint: { hosts: ["10.0.0.1"], port: 22 } } as const;
    const start = vi.fn(async (_profile: TunnelProfile, _server: ServerConfig, options: {
      beforeReverseForward?: (route: NetworkRouteIdentity) => Promise<void>;
    }) => {
      await options.beforeReverseForward?.(route);
      return makeActiveTunnel(profile.id);
    });
    const tombstone: TunnelRegistryEntry = {
      ...makeRegistryEntry(profile.id),
      tunnelType: "reverse",
      remotePort: 9000,
      retiredReverseBind: {
        fenceId: "retired-tunnel",
        routeIdentity: JSON.stringify({ kind: "direct", endpoint: { hosts: ["10.0.0.1"], port: 22 } }),
        remotePort: 9000
      }
    };
    let ownershipChecks = 0;
    const registrySync = {
      syncNow: vi.fn(async () => {}),
      checkRemoteOwnership: vi.fn(async (_id: string, _port: number, bind?: unknown) =>
        bind && ownershipChecks++ === 0 ? tombstone : undefined),
      waitForRemoteReverseBindClear: vi.fn(async () => true)
    };
    mockWithProgress.mockImplementation(async (...args: unknown[]) => {
      const task = args[1];
      if (typeof task !== "function") {
        return undefined;
      }
      return (task as (progress: unknown, token: { isCancellationRequested: boolean }) => Promise<unknown>)(
        undefined,
        { isCancellationRequested: false }
      );
    });

    await startTunnel(
      ctx.core, { start } as never, { connect: vi.fn(async () => ({ dispose: vi.fn() })) } as never,
      ctx.core.getTunnel(profile.id)!, ctx.core.getServer(server.id)!, "shared", registrySync as never
    );

    expect(mockWithProgress).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Waiting for remote port 9000 to be released", cancellable: true }),
      expect.any(Function)
    );
    expect(registrySync.waitForRemoteReverseBindClear).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(mockShowWarningMessage).not.toHaveBeenCalledWith(expect.stringContaining("already active"), expect.anything());
  });

  it("waits again when a different reverse-bind fence appears at the ownership recheck", async () => {
    const profile = makeTunnel({ tunnelType: "reverse", remotePort: 9000 });
    const ctx = await setupContext([profile]);
    const server: ServerConfig = {
      id: "srv-1", name: "Bastion", host: "10.0.0.1", port: 22,
      username: "ops", authType: "password", isHidden: false
    };
    await ctx.core.addOrUpdateServer(server);
    const route = { kind: "direct", endpoint: { hosts: ["10.0.0.1"], port: 22 } } as const;
    const fence = (fenceId: string): TunnelRegistryEntry => ({
      ...makeRegistryEntry(profile.id),
      tunnelType: "reverse",
      retiredReverseBind: {
        fenceId,
        routeIdentity: JSON.stringify(route),
        remotePort: 9000
      }
    });
    const owners = [fence("first"), fence("second"), undefined];
    const registrySync = {
      syncNow: vi.fn(async () => {}),
      checkRemoteOwnership: vi.fn(async (_id: string, _port: number, bind?: unknown) =>
        bind ? owners.shift() : undefined),
      waitForRemoteReverseBindClear: vi.fn(async () => true)
    };
    mockWithProgress.mockImplementation(async (...args: unknown[]) => {
      const task = args[1];
      return typeof task === "function"
        ? (task as (progress: unknown, token: { isCancellationRequested: boolean }) => Promise<unknown>)(
            undefined, { isCancellationRequested: false }
          )
        : undefined;
    });
    const start = vi.fn(async (_profile: TunnelProfile, _server: ServerConfig, options: {
      beforeReverseForward?: (route: NetworkRouteIdentity) => Promise<void>;
    }) => {
      await options.beforeReverseForward?.(route);
      return makeActiveTunnel(profile.id);
    });

    await startTunnel(
      ctx.core, { start } as never, { connect: vi.fn(async () => ({ dispose: vi.fn() })) } as never,
      ctx.core.getTunnel(profile.id)!, ctx.core.getServer(server.id)!, "shared", registrySync as never
    );

    expect(registrySync.waitForRemoteReverseBindClear).toHaveBeenCalledTimes(2);
    expect(registrySync.checkRemoteOwnership).toHaveBeenCalledTimes(4);
    expect(start).toHaveBeenCalledOnce();
    expect(mockShowWarningMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("already active"), "Open in Browser"
    );
  });

  it("checks the route captured by the actual reverse-forward candidate after a jump-host edit", async () => {
    const profile = makeTunnel({ tunnelType: "reverse", remotePort: 9000 });
    const ctx = await setupContext([profile]);
    const server: ServerConfig = {
      id: "srv-1", name: "Target", host: "new-route", port: 22,
      username: "ops", authType: "password", isHidden: false
    };
    await ctx.core.addOrUpdateServer(server);
    const oldRoute = { kind: "direct", endpoint: { hosts: ["old-route"], port: 22 } } as const;
    const tombstone = {
      ...makeRegistryEntry(profile.id),
      tunnelType: "reverse" as const,
      retiredReverseBind: {
        fenceId: "old-bind",
        routeIdentity: JSON.stringify(oldRoute),
        remotePort: 9000
      }
    };
    let checks = 0;
    const registrySync = {
      syncNow: vi.fn(async () => {}),
      checkRemoteOwnership: vi.fn(async (_id: string, _port: number, bind: { routeIdentity: unknown }) => {
        if (JSON.stringify(bind?.routeIdentity) !== JSON.stringify(oldRoute)) {
          return undefined;
        }
        return checks++ === 0 ? tombstone : undefined;
      }),
      waitForRemoteReverseBindClear: vi.fn(async () => true)
    };
    const start = vi.fn(async (_profile: TunnelProfile, _server: ServerConfig, options: {
      beforeReverseForward?: (route: NetworkRouteIdentity) => Promise<void>;
    }) => {
      await options.beforeReverseForward?.(oldRoute);
      return makeActiveTunnel(profile.id);
    });
    mockWithProgress.mockImplementation(async (...args: unknown[]) => {
      const task = args[1];
      return typeof task === "function"
        ? (task as (progress: unknown, token: { isCancellationRequested: boolean }) => Promise<unknown>)(
            undefined, { isCancellationRequested: false }
          )
        : undefined;
    });

    await startTunnel(
      ctx.core, { start } as never, { connect: vi.fn(async () => ({ dispose: vi.fn() })) } as never,
      ctx.core.getTunnel(profile.id)!, ctx.core.getServer(server.id)!, "shared", registrySync as never
    );

    expect(registrySync.waitForRemoteReverseBindClear).toHaveBeenCalledOnce();
    expect(registrySync.checkRemoteOwnership).toHaveBeenCalledWith(
      profile.id, profile.localPort, { routeIdentity: oldRoute, remotePort: 9000 }
    );
    expect(start).toHaveBeenCalledOnce();
  });

  it("ends a cross-window reservation wait when the pending reverse start is stopped", async () => {
    const profile = makeTunnel({ tunnelType: "reverse", remotePort: 9000 });
    const ctx = await setupContext([profile]);
    const server: ServerConfig = {
      id: "srv-1", name: "Target", host: "target", port: 22,
      username: "ops", authType: "password", isHidden: false
    };
    await ctx.core.addOrUpdateServer(server);
    const route = { kind: "direct", endpoint: { hosts: ["target"], port: 22 } } as const;
    const registrySync = {
      syncNow: vi.fn(async () => {}),
      checkRemoteOwnership: vi.fn(async (_id: string, _port: number, bind?: unknown) => bind ? ({
        ...makeRegistryEntry(profile.id),
        retiredReverseBind: {
          fenceId: "remote-pending",
          routeIdentity: JSON.stringify(route),
          remotePort: 9000
        }
      }) : undefined),
      waitForRemoteReverseBindClear: vi.fn(async (_bind: unknown, isCancelled: () => boolean) => {
        expect(isCancelled()).toBe(true);
        return false;
      })
    };
    const start = vi.fn(async (_profile: TunnelProfile, _server: ServerConfig, options: {
      beforeReverseForward?: (route: NetworkRouteIdentity, isStopping: () => boolean) => Promise<void>;
    }) => {
      await options.beforeReverseForward?.(route, () => true);
      return makeActiveTunnel(profile.id);
    });
    mockWithProgress.mockImplementation(async (...args: unknown[]) => {
      const task = args[1];
      return typeof task === "function"
        ? (task as (progress: unknown, token: { isCancellationRequested: boolean }) => Promise<unknown>)(
            undefined, { isCancellationRequested: false }
          )
        : undefined;
    });

    await startTunnel(
      ctx.core, { start } as never, { connect: vi.fn(async () => ({ dispose: vi.fn() })) } as never,
      ctx.core.getTunnel(profile.id)!, ctx.core.getServer(server.id)!, "shared", registrySync as never
    );
    expect(registrySync.waitForRemoteReverseBindClear).toHaveBeenCalledOnce();
  });
});

describe("startTunnel — a tunnel stopped before it finished starting", () => {
  const sshServer: ServerConfig = {
    id: "srv-ssh",
    name: "bastion",
    host: "10.0.0.2",
    port: 22,
    username: "ops",
    authType: "password",
    isHidden: false
  };

  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  // The manager rejects start() when stop() swept the tunnel mid-connect (issue
  // #176). That stop was asked for, so it is a cancel: every route that starts
  // a tunnel funnels through here, and none of them may report it as a failure.
  it("resolves quietly, as a cancel", async () => {
    const ctx = await setupContext([makeTunnel()]);
    await ctx.core.addOrUpdateServer(sshServer);
    const start = vi.fn(async () => {
      throw new TunnelStoppedError("Tunnel 1");
    });

    await expect(
      startTunnel(ctx.core, { start } as never, { connect: vi.fn() } as never,
        ctx.core.getTunnel("t1")!, ctx.core.getServer("srv-ssh")!, "isolated")
    ).resolves.toBeUndefined();
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("still fails on any other start error", async () => {
    const ctx = await setupContext([makeTunnel()]);
    await ctx.core.addOrUpdateServer(sshServer);
    const start = vi.fn(async () => {
      throw new Error("listen EADDRINUSE: address already in use 127.0.0.1:8080");
    });

    await expect(
      startTunnel(ctx.core, { start } as never, { connect: vi.fn() } as never,
        ctx.core.getTunnel("t1")!, ctx.core.getServer("srv-ssh")!, "isolated")
    ).rejects.toThrow("EADDRINUSE");
  });
});

describe("startTunnel — profile removed while start is pending", () => {
  const server: ServerConfig = {
    id: "srv-1", name: "Router", host: "10.0.0.1", port: 22,
    username: "ops", authType: "password", isHidden: false
  };

  async function fixture() {
    const ctx = await setupContext([makeTunnel()]);
    await ctx.core.addOrUpdateServer(server);
    return { core: ctx.core, profile: ctx.core.getTunnel("t1")!, server: ctx.core.getServer("srv-1")! };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("does not start an old route after Replace recreates its profile under the same id", async () => {
    const { core, profile, server: capturedServer } = await fixture();
    const sync = deferred<void>();
    const start = vi.fn(async () => makeActiveTunnel("t1"));
    const run = startTunnel(
      core,
      { start } as never,
      { connect: vi.fn() } as never,
      profile,
      capturedServer,
      "isolated",
      { syncNow: () => sync.promise, checkRemoteOwnership: async () => undefined } as never
    );

    await core.removeTunnel("t1");
    await core.addOrUpdateTunnel({ ...profile, remotePort: 443 });
    sync.resolve();
    await run;

    expect(start).not.toHaveBeenCalled();
  });

  it("does not start against a server replaced under the same id", async () => {
    const { core, profile, server: capturedServer } = await fixture();
    const sync = deferred<void>();
    const start = vi.fn(async () => makeActiveTunnel("t1"));
    const run = startTunnel(
      core, { start } as never, { connect: vi.fn() } as never,
      profile, capturedServer, "isolated",
      { syncNow: () => sync.promise, checkRemoteOwnership: async () => undefined } as never
    );

    await core.removeServer("srv-1");
    await core.addOrUpdateServer({ ...capturedServer, host: "10.0.0.2" });
    sync.resolve();
    await run;

    expect(start).not.toHaveBeenCalled();
  });

  it("stops a start that finishes after its profile was deleted", async () => {
    const { core, profile, server: capturedServer } = await fixture();
    const starting = deferred<ActiveTunnel>();
    const start = vi.fn(() => starting.promise);
    const stop = vi.fn(async () => {});
    const run = startTunnel(
      core, { start, stop } as never, { connect: vi.fn() } as never,
      profile, capturedServer, "isolated"
    );

    await core.removeTunnel("t1");
    starting.resolve(makeActiveTunnel("t1"));
    await run;

    expect(stop).toHaveBeenCalledWith("at-1");
  });

  it("keeps a start pending across an equal-content replacement of tunnel and server", async () => {
    const { core, profile, server: capturedServer } = await fixture();
    const sync = deferred<void>();
    const start = vi.fn(async () => makeActiveTunnel("t1"));
    const stop = vi.fn(async () => {});
    const run = startTunnel(
      core, { start, stop } as never, { connect: vi.fn() } as never,
      profile, capturedServer, "isolated",
      { syncNow: () => sync.promise, checkRemoteOwnership: async () => undefined } as never
    );

    await core.addOrUpdateTunnel({ ...profile });
    await core.addOrUpdateServer({ ...capturedServer });
    sync.resolve();
    await run;

    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
  });

  it("does not stop a running start after an equal-content replacement", async () => {
    const { core, profile, server: capturedServer } = await fixture();
    const starting = deferred<ActiveTunnel>();
    const start = vi.fn(() => starting.promise);
    const stop = vi.fn(async () => {});
    const run = startTunnel(
      core, { start, stop } as never, { connect: vi.fn() } as never,
      profile, capturedServer, "isolated"
    );

    await core.addOrUpdateTunnel({ ...profile });
    expect(isTunnelStartCurrent(core, "t1", "srv-1")).toBe(true);
    starting.resolve(makeActiveTunnel("t1"));
    await run;

    expect(stop).not.toHaveBeenCalled();
  });

  it("tells the user a real change cancelled the start and Retry restarts by id", async () => {
    const { core, profile, server: capturedServer } = await fixture();
    const sync = deferred<void>();
    const start = vi.fn(async () => makeActiveTunnel("t1"));
    mockShowWarningMessage.mockResolvedValueOnce("Retry");
    const run = startTunnel(
      core, { start } as never, { connect: vi.fn() } as never,
      profile, capturedServer, "isolated",
      { syncNow: () => sync.promise, checkRemoteOwnership: async () => undefined } as never
    );

    await core.addOrUpdateTunnel({ ...profile, localPort: profile.localPort + 1 });
    sync.resolve();
    await run;
    await Promise.resolve();
    await Promise.resolve();

    expect(start).not.toHaveBeenCalled();
    expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("changed while the tunnel was starting"), "Retry");
    const vscode = await import("vscode");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("nexus.tunnel.start", { profile: { id: "t1" }, serverId: "srv-1" });
  });

  it("warns without Retry and keeps a started tunnel out of the registry check when removed", async () => {
    const { core, profile, server: capturedServer } = await fixture();
    const starting = deferred<ActiveTunnel>();
    const start = vi.fn(() => starting.promise);
    const stop = vi.fn(async () => {});
    const run = startTunnel(
      core, { start, stop } as never, { connect: vi.fn() } as never,
      profile, capturedServer, "isolated"
    );

    await core.removeTunnel("t1");
    expect(isTunnelStartCurrent(core, "t1", "srv-1")).toBe(false);
    starting.resolve(makeActiveTunnel("t1"));
    await run;

    expect(stop).toHaveBeenCalledWith("at-1");
    expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("was removed while the tunnel was starting"));
  });

  it("rejects an in-flight start for a real change via the started-listener predicate", async () => {
    const { core, profile, server: capturedServer } = await fixture();
    const starting = deferred<ActiveTunnel>();
    const run = startTunnel(
      core, { start: () => starting.promise, stop: vi.fn(async () => {}) } as never, { connect: vi.fn() } as never,
      profile, capturedServer, "isolated"
    );

    await core.addOrUpdateTunnel({ ...profile, remotePort: 9999 });
    expect(isTunnelStartCurrent(core, "t1", "srv-1")).toBe(false);
    starting.resolve(makeActiveTunnel("t1"));
    await run;
    expect(isTunnelStartCurrent(core, "t1", "srv-1")).toBe(true);
  });

  it("does not cancel for a folder rename or a notes/browserUrl/autoStart edit, but does for a host change", async () => {
    const { core, profile, server: capturedServer } = await fixture();
    const starting = deferred<ActiveTunnel>();
    const start = vi.fn(() => starting.promise);
    const stop = vi.fn(async () => {});
    const run = startTunnel(
      core, { start, stop } as never, { connect: vi.fn() } as never,
      profile, capturedServer, "isolated"
    );

    await core.addOrUpdateServer({ ...capturedServer, group: "Renamed" });
    await core.addOrUpdateTunnel({ ...profile, notes: "n", browserUrl: "http://x", autoStart: true });
    expect(isTunnelStartCurrent(core, "t1", "srv-1")).toBe(true);
    await core.addOrUpdateServer({ ...capturedServer, group: "Renamed", host: "10.9.9.9" });
    expect(isTunnelStartCurrent(core, "t1", "srv-1")).toBe(false);
    starting.resolve(makeActiveTunnel("t1"));
    await run;
    expect(stop).toHaveBeenCalledWith("at-1");
  });

  it("clears the pending start fence when tunnelManager.start rejects", async () => {
    const { core, profile, server: capturedServer } = await fixture();
    const start = vi.fn(async () => { throw new Error("boom"); });
    await expect(
      startTunnel(core, { start } as never, { connect: vi.fn() } as never, profile, capturedServer, "isolated")
    ).rejects.toThrow("boom");
    // A leaked fence would keep judging this profile by the failed start's snapshot.
    await core.addOrUpdateTunnel({ ...profile, localPort: profile.localPort + 5 });
    expect(isTunnelStartCurrent(core, "t1", "srv-1")).toBe(true);
  });

  it("Retry after a cancelled start targets the server the start was aimed at", async () => {
    const other: ServerConfig = { ...server, id: "srv-2", name: "Other" };
    const ctx = await setupContext([makeTunnel({ defaultServerId: "srv-1", connectionMode: "isolated" })]);
    await ctx.core.addOrUpdateServer(server);
    await ctx.core.addOrUpdateServer(other);
    const start = vi.fn(async () => makeActiveTunnel("t1"));
    ctx.tunnelManager = { start } as never;
    registerTunnelCommands(ctx);
    await registeredCommands.get("nexus.tunnel.start")!({ profile: { id: "t1" }, serverId: "srv-2" });
    expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "srv-2" }), expect.anything());
  });
});
