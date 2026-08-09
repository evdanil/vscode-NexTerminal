import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import { NexusCore } from "../../src/core/nexusCore";
import type { ActiveTunnel, TunnelProfile, TunnelRegistryEntry } from "../../src/models/config";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { registerTunnelCommands } from "../../src/commands/tunnelCommands";
import { configMutationLock } from "../../src/services/configMutationLock";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowQuickPick = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();

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
    withProgress: vi.fn()
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
