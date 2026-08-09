import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import { NexusCore } from "../../src/core/nexusCore";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import { authProfilePasswordSecretKey, passwordSecretKey } from "../../src/services/ssh/silentAuth";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { registerAuthProfileCommands } from "../../src/commands/authProfileCommands";
import { configMutationLock } from "../../src/services/configMutationLock";
import { FolderTreeItem, ServerTreeItem } from "../../src/ui/nexusTreeProvider";
import { AuthProfileEditorPanel } from "../../src/ui/authProfileEditorPanel";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowQuickPick = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockWithProgress = vi.fn();
const mockOpen = vi.fn();
const mockOpenNew = vi.fn();

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
  EventEmitter: class {
    public readonly event = vi.fn();
    public fire = vi.fn();
  },
  ProgressLocation: { Notification: 15 }
}));

vi.mock("../../src/ui/authProfileEditorPanel", () => ({
  AuthProfileEditorPanel: {
    open: (...args: unknown[]) => mockOpen(...args),
    openNew: (...args: unknown[]) => mockOpenNew(...args)
  }
}));

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "s1",
    name: "Server 1",
    host: "example.com",
    port: 22,
    username: "old-user",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

function makeAuthProfile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return {
    id: "ap1",
    name: "Prod Auth",
    username: "root",
    authType: "password",
    ...overrides
  };
}

async function setupContext(options?: {
  servers?: ServerConfig[];
  authProfiles?: AuthProfile[];
  withVault?: boolean;
  initialSecrets?: Record<string, string>;
}): Promise<{
  ctx: CommandContext;
  core: NexusCore;
  repo: InMemoryConfigRepository;
  vault:
    | {
        get: ReturnType<typeof vi.fn>;
        store: ReturnType<typeof vi.fn>;
        delete: ReturnType<typeof vi.fn>;
      }
    | undefined;
}> {
  const repo = new InMemoryConfigRepository(
    options?.servers ?? [],
    [],
    [],
    [],
    options?.authProfiles ?? []
  );
  const core = new NexusCore(repo);
  await core.initialize();

  const secretState = new Map<string, string>(Object.entries(options?.initialSecrets ?? {}));
  const vault = options?.withVault === false
    ? undefined
    : {
        get: vi.fn(async (key: string) => secretState.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secretState.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          secretState.delete(key);
        })
      };

  const ctx: CommandContext = {
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
    highlighter: {} as any,
    sftpService: {} as any,
    fileExplorerProvider: {} as any,
    secretVault: vault as any,
    registrySync: undefined
  };

  return { ctx, core, repo, vault };
}

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
 * still awaiting its I/O" phase every one of these races needs to be pinned
 * against rather than raced for.
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
  return mockShowWarningMessage.mock.calls
    .filter((call) => call.length === 1)
    .map((call) => String(call[0]));
}

describe("authProfileCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    mockWithProgress.mockImplementation(async (_opts: unknown, task: () => Promise<void>) => task());
  });

  it("add command opens editor in new mode", async () => {
    const { ctx } = await setupContext();
    registerAuthProfileCommands(ctx);

    const cmd = registeredCommands.get("nexus.authProfile.add");
    expect(cmd).toBeDefined();
    cmd!();

    expect(mockOpenNew).toHaveBeenCalledWith(ctx.core, ctx.secretVault);
  });

  it("manage command opens editor", async () => {
    const { ctx } = await setupContext();
    registerAuthProfileCommands(ctx);

    const cmd = registeredCommands.get("nexus.authProfile.manage");
    expect(cmd).toBeDefined();
    cmd!();

    expect(mockOpen).toHaveBeenCalledWith(ctx.core, ctx.secretVault);
  });

  it("applies auth profile to folder stores reference, not credentials", async () => {
    const { ctx, core } = await setupContext({
      withVault: false,
      servers: [makeServer({ id: "s1", group: "Prod" }), makeServer({ id: "s2", group: "Other", username: "stay" })],
      authProfiles: [makeAuthProfile({ id: "ap1", username: "new-user", authType: "key", keyPath: "/keys/id_ed25519" })]
    });
    registerAuthProfileCommands(ctx);

    mockShowQuickPick.mockResolvedValue({ profile: core.getAuthProfile("ap1") });
    mockShowWarningMessage.mockResolvedValue("Link");

    const cmd = registeredCommands.get("nexus.authProfile.applyToFolder");
    expect(cmd).toBeDefined();
    await cmd!(new FolderTreeItem("Prod"));

    // Should store reference, NOT copy credentials
    expect(core.getServer("s1")?.authProfileId).toBe("ap1");
    expect(core.getServer("s1")?.username).toBe("old-user"); // unchanged
    expect(core.getServer("s2")?.authProfileId).toBeUndefined(); // not in folder
  });

  it("applyToServer stores authProfileId reference without copying password", async () => {
    const profile = makeAuthProfile({ id: "ap1", username: "deploy", authType: "password" });
    const server = makeServer({ id: "s1", username: "old" });
    const { ctx, core, vault } = await setupContext({
      servers: [server],
      authProfiles: [profile],
      withVault: true,
      initialSecrets: { [authProfilePasswordSecretKey("ap1")]: "profile-pass" }
    });
    registerAuthProfileCommands(ctx);

    mockShowQuickPick.mockResolvedValue({ profile });

    const applyToServer = registeredCommands.get("nexus.authProfile.applyToServer");
    expect(applyToServer).toBeDefined();
    await applyToServer!(new ServerTreeItem(server));

    // Should store reference, NOT copy credentials or password
    expect(core.getServer("s1")?.authProfileId).toBe("ap1");
    expect(core.getServer("s1")?.username).toBe("old"); // unchanged
    expect(vault?.store).not.toHaveBeenCalledWith(passwordSecretKey("s1"), expect.anything());
  });

  it("formats key auth profiles in auth profile quick picks with the key file name", async () => {
    const profile = makeAuthProfile({
      id: "ap1",
      name: "Shared Key",
      username: "deploy",
      authType: "key",
      keyPath: "/keys/id_ed25519"
    });
    const server = makeServer({ id: "s1", username: "old" });
    const { ctx } = await setupContext({
      servers: [server],
      authProfiles: [profile]
    });
    registerAuthProfileCommands(ctx);

    mockShowQuickPick.mockResolvedValue({ profile });

    const applyToServer = registeredCommands.get("nexus.authProfile.applyToServer");
    expect(applyToServer).toBeDefined();
    await applyToServer!(new ServerTreeItem(server));

    expect(mockShowQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ label: "Shared Key — key — deploy — id_ed25519" })
      ]),
      expect.any(Object)
    );
  });

  it("offers the auth profile QuickPick in natural (numeric) name order", async () => {
    const server = makeServer({ id: "s1", username: "old" });
    const { ctx } = await setupContext({
      servers: [server],
      authProfiles: [
        makeAuthProfile({ id: "ap10", name: "A10", username: "u" }),
        makeAuthProfile({ id: "ap2", name: "A2", username: "u" }),
        makeAuthProfile({ id: "ap1", name: "A1", username: "u" })
      ]
    });
    registerAuthProfileCommands(ctx);
    mockShowQuickPick.mockResolvedValue(undefined);

    const applyToServer = registeredCommands.get("nexus.authProfile.applyToServer");
    expect(applyToServer).toBeDefined();
    await applyToServer!(new ServerTreeItem(server));

    const items = mockShowQuickPick.mock.calls[0][0] as Array<{ profile: AuthProfile }>;
    expect(items.map((item) => item.profile.name)).toEqual(["A1", "A2", "A10"]);
  });
});

/**
 * REVIEW FINDING — the Apply Auth Profile commands described state sampled at
 * one moment and then wrote from those PRE-MODAL copies: no re-resolve of the
 * profile, no re-derivation of the affected set, and no `configMutationLock`.
 * Three things went wrong, and each test below pins one of them against the
 * specific wrong implementation that produced it:
 *
 *   * a profile DELETED while the modal (or the wait for the lock) was open
 *     linked a DANGLING id onto every server in the folder — permanently, since
 *     `removeAuthProfile`'s own reference clearing has already run by then and
 *     nothing revisits the record afterwards;
 *   * a server EDITED in that window was reverted, because the whole stale
 *     record was written back around the one field this command owns (and a
 *     server REMOVED in that window was recreated by the same spread);
 *   * the count and the profile name the user consented to no longer described
 *     what was written.
 *
 * Every concurrent operation here is GATED — it parks in a deferred prompt or
 * inside the lock and is released by the test — so it is guaranteed to land in
 * the window under test rather than usually winning a race.
 */
describe("Apply Auth Profile — the disclosure is re-checked and the write re-derived (REVIEW FINDING)", () => {
  const DELETED_DURING_MODAL =
    'Auth profile "Prod Auth" was deleted while the confirmation was open — nothing was linked. Choose another profile.';

  beforeEach(() => {
    vi.clearAllMocks();
    mockShowQuickPick.mockReset();
    mockShowWarningMessage.mockReset();
    mockShowInformationMessage.mockReset();
    registeredCommands.clear();
    mockWithProgress.mockImplementation(async (_opts: unknown, task: () => Promise<void>) => task());
  });

  async function folderFixture(servers: ServerConfig[], profileName = "Prod Auth") {
    const fixture = await setupContext({
      withVault: false,
      servers,
      authProfiles: [makeAuthProfile({ id: "ap1", name: profileName })]
    });
    registerAuthProfileCommands(fixture.ctx);
    mockShowQuickPick.mockResolvedValue({ profile: fixture.core.getAuthProfile("ap1") });
    return fixture;
  }

  function applyToFolder(folderPath: string): Promise<unknown> {
    const cmd = registeredCommands.get("nexus.authProfile.applyToFolder");
    expect(cmd).toBeDefined();
    return Promise.resolve(cmd!(new FolderTreeItem(folderPath)));
  }

  function applyToServer(server: ServerConfig): Promise<unknown> {
    const cmd = registeredCommands.get("nexus.authProfile.applyToServer");
    expect(cmd).toBeDefined();
    return Promise.resolve(cmd!(new ServerTreeItem(server)));
  }

  it("names the servers it is about to link with the right number, singular and plural (the disclosure the checks below are compared against)", async () => {
    const one = await folderFixture([makeServer({ id: "s1", group: "Prod" })]);
    mockShowWarningMessage.mockResolvedValue(undefined); // Cancel — nothing is written.
    await applyToFolder("Prod");
    expect(modalCalls()[0][0]).toBe(
      'Link "Prod Auth" to 1 server in "Prod"?\nThis links their credentials to the auth profile.'
    );
    expect(one.core.getServer("s1")?.authProfileId).toBeUndefined();

    mockShowWarningMessage.mockClear();
    registeredCommands.clear();
    await folderFixture([
      makeServer({ id: "s1", group: "Prod" }),
      makeServer({ id: "s2", name: "Server 2", group: "Prod/Edge" })
    ]);
    mockShowWarningMessage.mockResolvedValue(undefined);
    await applyToFolder("Prod");
    expect(modalCalls()[0][0]).toBe(
      'Link "Prod Auth" to 2 servers in "Prod"?\nThis links their credentials to the auth profile.'
    );
  });

  it("refuses when the profile was deleted while the confirmation modal was open, instead of linking a dangling id onto every server in the folder (kills writing from the pre-modal profile copy with no re-resolve)", async () => {
    const { core, repo } = await folderFixture([
      makeServer({ id: "s1", group: "Prod" }),
      makeServer({ id: "s2", name: "Server 2", group: "Prod/Edge" })
    ]);

    const modal = deferred<string>();
    mockShowWarningMessage.mockReturnValueOnce(modal.promise);
    const run = applyToFolder("Prod");
    await settle();
    expect(modalCalls()).toHaveLength(1);

    // The deletion completes IN FULL while the modal sits open. Its own
    // reference sweep finds nothing to clear (no server is linked yet), which
    // is exactly why the write that follows is not self-healing: the id it
    // writes resolves to nothing, and nothing ever comes back for it.
    await core.removeAuthProfile("ap1");

    modal.resolve("Link");
    await run;

    expect(core.getServer("s1")?.authProfileId).toBeUndefined();
    expect(core.getServer("s2")?.authProfileId).toBeUndefined();
    // On disk too, not just in memory.
    expect((await repo.getServers()).map((s) => s.authProfileId)).toEqual([undefined, undefined]);
    expect(refusals()).toEqual([DELETED_DURING_MODAL]);
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("queues its whole write behind an in-flight locked section and refuses when that section deleted the profile (kills the lock-free write, which commits before any concurrent holder can)", async () => {
    const { core } = await folderFixture([makeServer({ id: "s1", group: "Prod" })]);
    mockShowWarningMessage.mockResolvedValue("Link");

    const gated = gatedLockedWrite(configMutationLock, () => core.removeAuthProfile("ap1"));
    await settle();

    const run = applyToFolder("Prod");
    await settle();

    // THE KILL. The quick pick and the modal have both answered by now, so a
    // lock-free implementation has already finished writing "ap1" onto s1 at
    // this point — before the holder it should have been queued behind has even
    // started its body.
    expect(modalCalls()).toHaveLength(1);
    expect(core.getServer("s1")?.authProfileId).toBeUndefined();

    gated.release();
    await gated.done;
    await run;

    expect(core.getServer("s1")?.authProfileId).toBeUndefined();
    expect(refusals()).toEqual([DELETED_DURING_MODAL]);
  });

  it("still links when a server in the folder was edited while the modal was open, applying only the field it owns onto the edited record (kills writing back the whole stale pre-modal record, and kills aborting on any concurrent change)", async () => {
    const { core } = await folderFixture([
      makeServer({ id: "s1", group: "Prod" }),
      makeServer({ id: "s2", name: "Server 2", group: "Prod/Edge" })
    ]);

    const modal = deferred<string>();
    mockShowWarningMessage.mockReturnValueOnce(modal.promise);
    const run = applyToFolder("Prod");
    await settle();

    // A rename + port change of a server the modal counted — the affected SET
    // is unchanged, so this must not refuse; it must merge.
    await core.addOrUpdateServer({ ...core.getServer("s1")!, name: "Renamed 1", port: 2222 });

    modal.resolve("Link");
    await run;

    // The link landed...
    expect(core.getServer("s1")?.authProfileId).toBe("ap1");
    expect(core.getServer("s2")?.authProfileId).toBe("ap1");
    // ...and the concurrent edit survived it. A `{ ...preModalServer,
    // authProfileId }` write reverts both of these to "Server 1" / 22.
    expect(core.getServer("s1")?.name).toBe("Renamed 1");
    expect(core.getServer("s1")?.port).toBe(2222);
    expect(refusals()).toEqual([]);
    expect(mockShowInformationMessage).toHaveBeenCalledWith('Linked auth profile "Prod Auth" to 2 servers.');
  });

  it("refuses when a server left the folder while the modal was open, rather than linking a server the confirmation no longer covers (kills writing the stale affected set)", async () => {
    const { core } = await folderFixture([
      makeServer({ id: "s1", group: "Prod" }),
      makeServer({ id: "s2", name: "Server 2", group: "Prod" })
    ]);

    const modal = deferred<string>();
    mockShowWarningMessage.mockReturnValueOnce(modal.promise);
    const run = applyToFolder("Prod");
    await settle();

    await core.addOrUpdateServer({ ...core.getServer("s2")!, group: "Other" });

    modal.resolve("Link");
    await run;

    // The departed server is the one the stale-set implementation links anyway.
    expect(core.getServer("s2")?.authProfileId).toBeUndefined();
    expect(core.getServer("s1")?.authProfileId).toBeUndefined();
    expect(refusals()).toEqual([
      'The servers in "Prod" changed while the confirmation was open — nothing was linked. ' +
        'Run Apply Auth Profile again to see which servers "Prod Auth" would be linked to now.'
    ]);
  });

  it("refuses when the folder's membership was swapped for a different set of the SAME size (kills comparing only the disclosed count)", async () => {
    const { core } = await folderFixture([
      makeServer({ id: "s1", group: "Prod" }),
      makeServer({ id: "s2", name: "Server 2", group: "Prod" }),
      makeServer({ id: "s3", name: "Server 3", group: "Other" })
    ]);

    const modal = deferred<string>();
    mockShowWarningMessage.mockReturnValueOnce(modal.promise);
    const run = applyToFolder("Prod");
    await settle();
    expect(modalCalls()[0][0]).toContain("2 servers");

    // One out, one in: still "2 servers in Prod", a different two.
    await core.addOrUpdateServer({ ...core.getServer("s2")!, group: "Other" });
    await core.addOrUpdateServer({ ...core.getServer("s3")!, group: "Prod" });

    modal.resolve("Link");
    await run;

    expect(core.getServer("s1")?.authProfileId).toBeUndefined();
    expect(core.getServer("s2")?.authProfileId).toBeUndefined();
    expect(core.getServer("s3")?.authProfileId).toBeUndefined();
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toContain('The servers in "Prod" changed');
  });

  it("refuses when the profile was renamed while the confirmation was open, quoting the name the modal used (kills checking only that the profile still exists and the set is unchanged)", async () => {
    const { core } = await folderFixture([makeServer({ id: "s1", group: "Prod" })]);

    const modal = deferred<string>();
    mockShowWarningMessage.mockReturnValueOnce(modal.promise);
    const run = applyToFolder("Prod");
    await settle();

    await core.addOrUpdateAuthProfile({ ...core.getAuthProfile("ap1")!, name: "Staging Auth" });

    modal.resolve("Link");
    await run;

    expect(core.getServer("s1")?.authProfileId).toBeUndefined();
    expect(refusals()).toEqual([
      'Auth profile "Prod Auth" changed while the confirmation was open — nothing was linked. ' +
        "Run Apply Auth Profile again to review what it would link now."
    ]);
  });

  it("applyToServer refuses when the profile was deleted while the picker was open, instead of linking a dangling id onto the server (kills writing from the pre-pick profile copy)", async () => {
    const { ctx, core, repo } = await setupContext({
      withVault: false,
      servers: [makeServer({ id: "s1" })],
      authProfiles: [makeAuthProfile({ id: "ap1", name: "Prod Auth" })]
    });
    registerAuthProfileCommands(ctx);
    const server = core.getServer("s1")!;
    const profile = core.getAuthProfile("ap1")!;

    // The picker's item list is built from the snapshot BEFORE it opens, so a
    // pick resolving after the deletion still hands back this stale object —
    // exactly what happens in the product.
    const pick = deferred<{ profile: AuthProfile }>();
    mockShowQuickPick.mockReturnValueOnce(pick.promise);
    const run = applyToServer(server);
    await settle();

    await core.removeAuthProfile("ap1");

    pick.resolve({ profile });
    await run;

    expect(core.getServer("s1")?.authProfileId).toBeUndefined();
    expect((await repo.getServers())[0].authProfileId).toBeUndefined();
    expect(refusals()).toEqual([
      'Auth profile "Prod Auth" was deleted while it was being chosen — nothing was linked. Choose another profile.'
    ]);
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("applyToServer does not resurrect a server that was removed while the picker was open (kills addOrUpdateServer re-creating the record from the stale copy)", async () => {
    const { ctx, core, repo } = await setupContext({
      withVault: false,
      servers: [makeServer({ id: "s1" })],
      authProfiles: [makeAuthProfile({ id: "ap1", name: "Prod Auth" })]
    });
    registerAuthProfileCommands(ctx);
    const server = core.getServer("s1")!;
    const profile = core.getAuthProfile("ap1")!;

    const pick = deferred<{ profile: AuthProfile }>();
    mockShowQuickPick.mockReturnValueOnce(pick.promise);
    const run = applyToServer(server);
    await settle();

    await core.removeServer("s1");

    pick.resolve({ profile });
    await run;

    expect(core.getServer("s1")).toBeUndefined();
    expect(await repo.getServers()).toEqual([]);
    expect(refusals()).toEqual([
      '"Server 1" was removed while the auth profile was being chosen — nothing was linked.'
    ]);
  });

  it("applyToServer applies only the field it owns onto a server edited while the picker was open (kills writing back the whole stale record)", async () => {
    const { ctx, core } = await setupContext({
      withVault: false,
      servers: [makeServer({ id: "s1" })],
      authProfiles: [makeAuthProfile({ id: "ap1", name: "Prod Auth" })]
    });
    registerAuthProfileCommands(ctx);
    const server = core.getServer("s1")!;
    const profile = core.getAuthProfile("ap1")!;

    const pick = deferred<{ profile: AuthProfile }>();
    mockShowQuickPick.mockReturnValueOnce(pick.promise);
    const run = applyToServer(server);
    await settle();

    await core.addOrUpdateServer({ ...core.getServer("s1")!, name: "Renamed 1", port: 2222 });

    pick.resolve({ profile });
    await run;

    expect(core.getServer("s1")?.authProfileId).toBe("ap1");
    expect(core.getServer("s1")?.name).toBe("Renamed 1");
    expect(core.getServer("s1")?.port).toBe(2222);
    expect(refusals()).toEqual([]);
    expect(mockShowInformationMessage).toHaveBeenCalledWith('Linked auth profile "Prod Auth" to "Renamed 1".');
  });

  it("applyToServer queues its write behind an in-flight locked section and refuses when that section deleted the profile (kills the lock-free single-server write)", async () => {
    const { ctx, core } = await setupContext({
      withVault: false,
      servers: [makeServer({ id: "s1" })],
      authProfiles: [makeAuthProfile({ id: "ap1", name: "Prod Auth" })]
    });
    registerAuthProfileCommands(ctx);
    const server = core.getServer("s1")!;
    mockShowQuickPick.mockResolvedValue({ profile: core.getAuthProfile("ap1") });

    const gated = gatedLockedWrite(configMutationLock, () => core.removeAuthProfile("ap1"));
    await settle();

    const run = applyToServer(server);
    await settle();

    // THE KILL, as in the folder case: the picker has already answered, so a
    // lock-free implementation has written "ap1" onto s1 by now.
    expect(core.getServer("s1")?.authProfileId).toBeUndefined();

    gated.release();
    await gated.done;
    await run;

    expect(core.getServer("s1")?.authProfileId).toBeUndefined();
    expect(refusals()).toEqual([
      'Auth profile "Prod Auth" was deleted while it was being chosen — nothing was linked. Choose another profile.'
    ]);
  });
});
