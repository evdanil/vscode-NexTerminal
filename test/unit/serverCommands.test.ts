import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { CommandContext } from "../../src/commands/types";
import {
  registerServerCommands,
  authProfileCredentialMirror,
  formValuesToServer,
  formValuesToProxy,
  preserveLinkedServerCredentials,
  syncProxyPasswordSecret,
  teardownServerRuntime
} from "../../src/commands/serverCommands";
import type { AuthProfile, ServerConfig, TunnelProfile } from "../../src/models/config";
import { FolderTreeItem, ServerTreeItem } from "../../src/ui/nexusTreeProvider";
import { readFile } from "node:fs/promises";
import { defaultSshDir, deployPublicKeyToRemote, findLocalKeyPairs, generateKeyPair } from "../../src/services/ssh/deploySshKey";
import { SilentAuthSshFactory, passphraseSecretKey, passwordSecretKey, proxyPasswordSecretKey } from "../../src/services/ssh/silentAuth";
import { SshPty } from "../../src/services/ssh/sshPty";
import { AsyncMutex, configMutationLock } from "../../src/services/configMutationLock";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowWarningMessage = vi.fn();
const mockShowErrorMessage = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn()
}));

vi.mock("../../src/services/ssh/deploySshKey", () => ({
  defaultSshDir: vi.fn(() => "/home/user/.ssh"),
  findLocalKeyPairs: vi.fn(async () => []),
  generateKeyPair: vi.fn(async () => ({
    publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
    privateKeyPath: "/home/user/.ssh/id_ed25519"
  })),
  deployPublicKeyToRemote: vi.fn(async () => ({ alreadyDeployed: false }))
}));

const mockAddOutputObserver = vi.fn((_observer: unknown) => ({ dispose: vi.fn() }));

vi.mock("../../src/services/ssh/sshPty", () => ({
  SshPty: vi.fn(function () { return { addOutputObserver: mockAddOutputObserver }; })
}));

vi.mock("../../src/logging/sessionTranscriptLogger", () => ({
  createSessionTranscript: vi.fn(() => undefined)
}));

vi.mock("../../src/services/scripts/scriptPicker", () => ({
  pickScriptFromWorkspace: vi.fn(async () => ({ fsPath: "/workspace/.nexus/scripts/task.js" }))
}));

const mockWebviewFormPanelOpen = vi.fn();

vi.mock("../../src/ui/webviewFormPanel", () => ({
  WebviewFormPanel: {
    open: (...args: unknown[]) => mockWebviewFormPanelOpen(...args)
  }
}));

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn()
  },
  window: {
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    showInputBox: vi.fn(),
    showOpenDialog: vi.fn(),
    withProgress: vi.fn(),
    createTerminal: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })),
    activeTerminal: undefined as unknown
  },
  env: {
    clipboard: {
      writeText: vi.fn()
    }
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(() => true)
    }))
  },
  Uri: {
    file: (path: string) => ({ fsPath: path, scheme: "file" })
  },
  ProgressLocation: { Notification: 15 },
  TerminalLocation: { Editor: 2, Panel: 1 },
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
  }
}));

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Server 1",
    host: "example.com",
    port: 22,
    username: "dev",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

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

function makeAuthProfile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return {
    id: "ap1",
    name: "Prod Auth",
    username: "root",
    authType: "password",
    ...overrides
  };
}

interface Harness {
  ctx: CommandContext;
  stopTunnel: ReturnType<typeof vi.fn>;
  disconnectPool: ReturnType<typeof vi.fn>;
  removeServer: ReturnType<typeof vi.fn>;
  addOrUpdateServer: ReturnType<typeof vi.fn>;
  addOrUpdateAuthProfile: ReturnType<typeof vi.fn>;
  terminalDispose: ReturnType<typeof vi.fn>;
  secretDelete: ReturnType<typeof vi.fn>;
  secretStore: ReturnType<typeof vi.fn>;
}

function setupHarness(options: {
  activeTunnels: Array<{ id: string; profileId: string; serverId: string }>;
  profiles: TunnelProfile[];
  servers?: ServerConfig[];
  authProfiles?: AuthProfile[];
  confirmRemove?: boolean;
  initialSecrets?: Record<string, string>;
}): Harness {
  let snapshot = {
    servers: options.servers ?? [makeServer()],
    tunnels: options.profiles,
    serialProfiles: [],
    activeSessions: [] as Array<{ id: string; serverId: string; terminalName: string; startedAt: number; pty?: unknown }>,
    activeSerialSessions: [],
    activeTunnels: options.activeTunnels.map((t) => ({
      id: t.id,
      profileId: t.profileId,
      serverId: t.serverId
    })),
    remoteTunnels: [],
    explicitGroups: [],
    localShellProfiles: [] as Array<{ group?: string }>,
    authProfiles: options.authProfiles ?? [],
    activitySessionIds: new Set(),
    focusedSessionId: undefined
  };

  const stopTunnel = vi.fn(async (activeTunnelId: string) => {
    snapshot = {
      ...snapshot,
      activeTunnels: snapshot.activeTunnels.filter((t) => t.id !== activeTunnelId)
    };
  });
  const disconnectPool = vi.fn();
  const removeServer = vi.fn(async (serverId: string) => {
    snapshot = {
      ...snapshot,
      servers: snapshot.servers.filter((item) => item.id !== serverId)
    };
  });
  const addOrUpdateServer = vi.fn(async (server: ServerConfig) => {
    // Mirrors NexusCore.addOrUpdateServer's single-owner enforcement for
    // openFileExplorerOnFirstConnect (see src/core/nexusCore.ts): enabling
    // the flag on this server clears it from whichever other server
    // currently holds it. Kept in sync with production so displaced-owner
    // rollback tests actually exercise a real displacement instead of a
    // mock that never clears anyone.
    let servers = snapshot.servers;
    if (server.openFileExplorerOnFirstConnect) {
      servers = servers.map((existing) =>
        existing.id !== server.id && existing.openFileExplorerOnFirstConnect
          ? { ...existing, openFileExplorerOnFirstConnect: undefined }
          : existing
      );
    }
    snapshot = {
      ...snapshot,
      servers: [...servers.filter((item) => item.id !== server.id), server]
    };
  });
  const addOrUpdateAuthProfile = vi.fn(async (profile: AuthProfile) => {
    snapshot = {
      ...snapshot,
      authProfiles: [...snapshot.authProfiles.filter((item) => item.id !== profile.id), profile]
    };
  });
  const secrets = new Map(Object.entries(options.initialSecrets ?? {}));
  const secretDelete = vi.fn(async (key: string) => {
    secrets.delete(key);
  });
  const secretStore = vi.fn(async (key: string, value: string) => {
    secrets.set(key, value);
  });

  const terminalDispose = vi.fn();
  const terminalsByServer = new Map<string, Set<{ dispose: () => void }>>();
  terminalsByServer.set("srv-1", new Set([{ dispose: terminalDispose }]));
  const changeListeners: Array<(nextSnapshot: typeof snapshot) => void> = [];
  const emitChange = () => {
    for (const listener of changeListeners) {
      listener(snapshot);
    }
  };

  const core = {
    getServer: vi.fn((id: string) => snapshot.servers.find((s) => s.id === id)),
    getAuthProfile: vi.fn((id: string) => snapshot.authProfiles.find((p) => p.id === id)),
    getTunnel: vi.fn((id: string) => snapshot.tunnels.find((t) => t.id === id)),
    getSnapshot: vi.fn(() => snapshot),
    isServerConnected: vi.fn(() => false),
    registerSession: vi.fn((session: { id: string; serverId: string; terminalName: string; startedAt: number; pty?: unknown }) => {
      snapshot = {
        ...snapshot,
        activeSessions: [...snapshot.activeSessions.filter((item) => item.id !== session.id), session]
      };
      emitChange();
    }),
    unregisterSession: vi.fn((sessionId: string) => {
      snapshot = {
        ...snapshot,
        activeSessions: snapshot.activeSessions.filter((item) => item.id !== sessionId)
      };
      emitChange();
    }),
    markSessionActivity: vi.fn(),
    setFocusedSession: vi.fn(),
    onDidChange: vi.fn((listener: (nextSnapshot: typeof snapshot) => void) => {
      changeListeners.push(listener);
      return () => {
        const index = changeListeners.indexOf(listener);
        if (index >= 0) {
          changeListeners.splice(index, 1);
        }
      };
    }),
    removeServer,
    addOrUpdateServer,
    addOrUpdateAuthProfile
  };

  const ctx: CommandContext = {
    core: core as any,
    tunnelManager: { stop: stopTunnel } as any,
    serialSidecar: {} as any,
    sshFactory: {} as any,
    sshPool: { disconnect: disconnectPool } as any,
    loggerFactory: { create: vi.fn() } as any,
    sessionLogDir: "",
    terminalsByServer: terminalsByServer as any,
    sessionTerminals: new Map(),
    serialTerminals: new Map(),
    localShellTerminals: new Map(),
    highlighter: {} as any,
    macroAutoTrigger: {
      createObserver: vi.fn(() => ({})),
      bindObserverToSession: vi.fn()
    } as any,
    sftpService: {
      connect: vi.fn(async () => {}),
      realpath: vi.fn(async () => "/home/dev")
    } as any,
    fileExplorerProvider: {
      getActiveServerId: vi.fn(() => undefined),
      setActiveServer: vi.fn()
    } as any,
    secretVault: {
      get: vi.fn(async (key: string) => secrets.get(key)),
      store: secretStore,
      delete: secretDelete
    },
    registrySync: undefined,
    activityIndicators: new Map(),
    globalStoragePath: "/workspace/global",
    extensionPath: "/workspace/extension",
    globalState: {} as any
  };

  mockShowWarningMessage.mockResolvedValue(options.confirmRemove === false ? undefined : "Remove");

  return {
    ctx,
    stopTunnel,
    disconnectPool,
    removeServer,
    addOrUpdateServer,
    addOrUpdateAuthProfile,
    terminalDispose,
    secretDelete,
    secretStore
  };
}

function latestSshCallbacks(): { onSessionOpened(sessionId: string): void } {
  const calls = vi.mocked(SshPty).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][2] as unknown as { onSessionOpened(sessionId: string): void };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("server disconnect with tunnel autoStop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    (vscode.window as any).activeTerminal = undefined;
  });

  it("routes Add SSH Server to a dedicated SSH add form", async () => {
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [] });

    registerServerCommands(ctx);
    const addCmd = registeredCommands.get("nexus.server.add");
    expect(addCmd).toBeDefined();

    await addCmd!();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("nexus.profile.add", {
      addMode: "ssh",
      profileType: "ssh"
    });
  });

  it("(FINDING 5 — removal-teardown review) teardownServerRuntime tears down a server's runtime state by id alone even after its record no longer exists in NexusCore — it never falls back to an interactive server picker (kills a core.getServer dependency that would otherwise prompt the user)", async () => {
    const profile = makeTunnel({ id: "tp-1", autoStop: false });
    const { ctx, stopTunnel, disconnectPool, terminalDispose } = setupHarness({
      servers: [], // the record is already gone — mirrors removeSource's REORDER (apply first, teardown only the removed ids after)
      profiles: [profile],
      activeTunnels: [{ id: "at-1", profileId: "tp-1", serverId: "srv-1" }]
    });

    await teardownServerRuntime(ctx, "srv-1");

    // Terminal disposed, the tunnel stopped (even with autoStop: false —
    // unlike disconnectServer's own partial stop, teardown always stops
    // everything routed through the server), and the pooled SSH connection
    // disconnected — all purely by serverId, none of it requiring the
    // server record to still exist.
    expect(terminalDispose).toHaveBeenCalled();
    expect(stopTunnel).toHaveBeenCalledWith("at-1");
    expect(disconnectPool).toHaveBeenCalledWith("srv-1");

    // If FINDING 5's fix were reverted (teardownServerRuntime delegates to
    // disconnectServer, whose string-arg branch resolves the server via
    // core.getServer(id) and falls back to an interactive pickServer/
    // showQuickPick prompt when that's undefined — exactly the state a
    // record that's already been removed leaves it in), this call would
    // have popped an interactive picker instead of just tearing down.
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it("(P2 — mid-teardown-recheck review) shouldAbort flipped true WHILE the tunnel-stop await is still pending stops teardown before sshPool.disconnect (kills an unguarded post-await disconnect)", async () => {
    const profile = makeTunnel({ id: "tp-1", autoStop: false });
    const { ctx, stopTunnel, disconnectPool, terminalDispose } = setupHarness({
      servers: [makeServer()],
      profiles: [profile],
      activeTunnels: [{ id: "at-1", profileId: "tp-1", serverId: "srv-1" }]
    });

    // Controllable tunnel-stop promise: teardownServerRuntime's internal
    // Promise.all(tunnelManager.stop(...)) stays pending until resolveStop()
    // is called, giving us a window to flip `aborted` to true WHILE that
    // await is in flight — simulating a replacement server materializing
    // (with its own fresh pooled connection) during exactly that window.
    let resolveStop!: () => void;
    stopTunnel.mockImplementation(() => new Promise<void>((resolve) => { resolveStop = resolve; }));

    let aborted = false;
    const teardownPromise = teardownServerRuntime(ctx, "srv-1", () => aborted);

    // Let the synchronous prefix of teardownServerRuntime run: terminal
    // disposal already happened, and stop() has been invoked (kicking off
    // the pending Promise.all) but not yet resolved.
    await Promise.resolve();
    expect(terminalDispose).toHaveBeenCalled();
    expect(stopTunnel).toHaveBeenCalledWith("at-1");
    expect(disconnectPool).not.toHaveBeenCalled();

    aborted = true;
    resolveStop();
    await teardownPromise;

    // If shouldAbort were only checked before the first await (or not at
    // all), disconnectPool would still fire here once the tunnel-stop
    // promise resolves. The recheck immediately after that await must catch
    // the flip and skip the final disposal step.
    expect(disconnectPool).not.toHaveBeenCalled();
  });

  it("(P2 — mid-teardown-recheck review) shouldAbort false throughout still runs the full teardown, including sshPool.disconnect (unchanged behavior)", async () => {
    const profile = makeTunnel({ id: "tp-1", autoStop: false });
    const { ctx, stopTunnel, disconnectPool, terminalDispose } = setupHarness({
      servers: [makeServer()],
      profiles: [profile],
      activeTunnels: [{ id: "at-1", profileId: "tp-1", serverId: "srv-1" }]
    });

    await teardownServerRuntime(ctx, "srv-1", () => false);

    expect(terminalDispose).toHaveBeenCalled();
    expect(stopTunnel).toHaveBeenCalledWith("at-1");
    expect(disconnectPool).toHaveBeenCalledWith("srv-1");
  });

  it("keeps pool connection when autoStop=false tunnel remains active", async () => {
    const autoStopProfile = makeTunnel({ id: "tp-stop", autoStop: true });
    const keepProfile = makeTunnel({ id: "tp-keep", autoStop: false });
    const { ctx, stopTunnel, disconnectPool } = setupHarness({
      profiles: [autoStopProfile, keepProfile],
      activeTunnels: [
        { id: "at-stop", profileId: "tp-stop", serverId: "srv-1" },
        { id: "at-keep", profileId: "tp-keep", serverId: "srv-1" }
      ]
    });

    registerServerCommands(ctx);
    const disconnectCmd = registeredCommands.get("nexus.server.disconnect");
    expect(disconnectCmd).toBeDefined();

    await disconnectCmd!("srv-1");

    expect(stopTunnel).toHaveBeenCalledTimes(1);
    expect(stopTunnel).toHaveBeenCalledWith("at-stop");
    expect(disconnectPool).not.toHaveBeenCalled();
  });

  it("disconnects pool when no active tunnels remain after stopping auto-stop tunnels", async () => {
    const autoStopProfile = makeTunnel({ id: "tp-stop", autoStop: true });
    const { ctx, stopTunnel, disconnectPool } = setupHarness({
      profiles: [autoStopProfile],
      activeTunnels: [{ id: "at-stop", profileId: "tp-stop", serverId: "srv-1" }]
    });

    registerServerCommands(ctx);
    const disconnectCmd = registeredCommands.get("nexus.server.disconnect");
    expect(disconnectCmd).toBeDefined();

    await disconnectCmd!("srv-1");

    expect(stopTunnel).toHaveBeenCalledTimes(1);
    expect(disconnectPool).toHaveBeenCalledTimes(1);
    expect(disconnectPool).toHaveBeenCalledWith("srv-1");
  });

  it("remove command stops all remaining tunnels, disconnects pool, and disposes terminals via teardownServerRuntime", async () => {
    const autoStopProfile = makeTunnel({ id: "tp-stop", autoStop: true });
    const keepProfile = makeTunnel({ id: "tp-keep", autoStop: false });
    const { ctx, stopTunnel, disconnectPool, removeServer, secretDelete, terminalDispose } = setupHarness({
      profiles: [autoStopProfile, keepProfile],
      activeTunnels: [
        { id: "at-stop", profileId: "tp-stop", serverId: "srv-1" },
        { id: "at-keep", profileId: "tp-keep", serverId: "srv-1" }
      ]
    });

    registerServerCommands(ctx);
    const removeCmd = registeredCommands.get("nexus.server.remove");
    expect(removeCmd).toBeDefined();

    await removeCmd!("srv-1");

    // Terminal disposal is now covered by teardownServerRuntime rather than
    // the old disconnectServer() call — assert it still happens so the
    // replacement doesn't silently drop terminal cleanup on remove.
    expect(terminalDispose).toHaveBeenCalled();
    expect(stopTunnel).toHaveBeenCalledTimes(2);
    expect(stopTunnel).toHaveBeenCalledWith("at-stop");
    expect(stopTunnel).toHaveBeenCalledWith("at-keep");
    expect(disconnectPool).toHaveBeenCalledTimes(1);
    expect(disconnectPool).toHaveBeenCalledWith("srv-1");
    expect(secretDelete).toHaveBeenCalledWith(passwordSecretKey("srv-1"));
    expect(secretDelete).toHaveBeenCalledWith(passphraseSecretKey("srv-1"));
    expect(secretDelete).toHaveBeenCalledWith(proxyPasswordSecretKey("srv-1"));
    expect(removeServer).toHaveBeenCalledWith("srv-1");
  });

  it("(P1, remove-lock-picker-fallback fix) remove command re-checks server presence inside the lock and bails out with an info message — never falls through to an interactive picker or performs any teardown/vault/removal work — when the record was deleted while the confirmation modal or the lock wait was pending", async () => {
    const { ctx, stopTunnel, disconnectPool, removeServer, secretDelete, terminalDispose } = setupHarness({
      profiles: [],
      activeTunnels: []
    });

    registerServerCommands(ctx);
    const removeCmd = registeredCommands.get("nexus.server.remove");
    expect(removeCmd).toBeDefined();

    // Simulate the record having been removed (e.g. by a concurrent
    // inventory sync or another remove) sometime between the initial
    // arg-resolution / confirmation modal and this call's lock acquisition:
    // the FIRST core.getServer lookup (arg resolution, before the
    // confirmation modal) still finds the record, but by the time the
    // locked span's presence re-check runs (the second lookup), the record
    // is gone.
    let getServerCalls = 0;
    (ctx.core.getServer as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      getServerCalls++;
      return getServerCalls === 1 && id === "srv-1" ? makeServer() : undefined;
    });

    await removeCmd!("srv-1");

    // If the fix under test were reverted (the span went straight to
    // disconnectServer/teardown without re-checking presence), this would
    // still call ctx.sshPool.disconnect / stopTunnel / secretDelete /
    // removeServer and — for the real disconnectServer implementation —
    // fall through to an interactive pickServer prompt while still holding
    // configMutationLock. None of that may happen here.
    expect(terminalDispose).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(disconnectPool).not.toHaveBeenCalled();
    expect(secretDelete).not.toHaveBeenCalled();
    expect(removeServer).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("already removed")
    );
  });

  it("(presence-only revalidation fix) remove command's in-lock re-check compares the CURRENT record structurally against the confirmed one — a replace-mode import that recreated a DIFFERENT server under the same id while the confirm modal/lock wait was pending aborts with a distinct message and performs no teardown/vault-delete/removeServer, instead of tearing down the impostor record", async () => {
    const { ctx, stopTunnel, disconnectPool, removeServer, secretDelete, terminalDispose } = setupHarness({
      profiles: [],
      activeTunnels: []
    });

    registerServerCommands(ctx);
    const removeCmd = registeredCommands.get("nexus.server.remove");
    expect(removeCmd).toBeDefined();

    // First core.getServer lookup (arg resolution, before the confirmation
    // modal) returns the record the user actually confirmed removing. By
    // the time the locked span's re-check runs (the second lookup), a
    // replace-mode import — or any other writer that got ahead of this flow
    // in the lock queue — has recreated a DIFFERENT server under the SAME
    // preserved id (same id, different host). A presence-only check (`if
    // (!ctx.core.getServer(server.id))`) would see this as "still there"
    // and barrel ahead into tearing down/deleting credentials for/removing
    // the wrong record.
    const confirmedRecord = makeServer();
    const impostorRecord = makeServer({ host: "attacker.example.com" });
    let getServerCalls = 0;
    (ctx.core.getServer as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      getServerCalls++;
      if (id !== "srv-1") {
        return undefined;
      }
      return getServerCalls === 1 ? confirmedRecord : impostorRecord;
    });

    await removeCmd!("srv-1");

    // If the fix under test were reverted back to the presence-only check,
    // this would proceed straight through teardownServerRuntime, all three
    // secretVault.delete calls, and core.removeServer — tearing down and
    // deleting credentials for a server the user never confirmed removing.
    // None of that may happen here.
    expect(terminalDispose).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(disconnectPool).not.toHaveBeenCalled();
    expect(secretDelete).not.toHaveBeenCalled();
    expect(removeServer).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    // Distinct from the already-removed message — the record is present,
    // just no longer the one the user confirmed.
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("changed since the removal was confirmed")
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("already removed")
    );
  });

  it("(presence-only revalidation fix) remove command's in-lock re-check finds the record structurally identical to the confirmed one and proceeds with the normal teardown/vault-delete/removeServer sequence", async () => {
    const { ctx, stopTunnel, disconnectPool, removeServer, secretDelete, terminalDispose } = setupHarness({
      profiles: [],
      activeTunnels: []
    });

    registerServerCommands(ctx);
    const removeCmd = registeredCommands.get("nexus.server.remove");
    expect(removeCmd).toBeDefined();

    // Both lookups return structurally-equal (but distinct object) records —
    // e.g. a snapshot rebuild that didn't actually change this server. The
    // structural revalidation must treat this as "still the confirmed
    // record" and let the removal proceed, exactly like before the fix.
    let getServerCalls = 0;
    (ctx.core.getServer as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      getServerCalls++;
      if (id !== "srv-1") {
        return undefined;
      }
      return getServerCalls === 1 ? makeServer() : makeServer();
    });

    await removeCmd!("srv-1");

    expect(terminalDispose).toHaveBeenCalled();
    expect(disconnectPool).toHaveBeenCalledWith("srv-1");
    expect(secretDelete).toHaveBeenCalledWith(passwordSecretKey("srv-1"));
    expect(secretDelete).toHaveBeenCalledWith(passphraseSecretKey("srv-1"));
    expect(secretDelete).toHaveBeenCalledWith(proxyPasswordSecretKey("srv-1"));
    expect(removeServer).toHaveBeenCalledWith("srv-1");
    expect(mockShowWarningMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("changed since the removal was confirmed")
    );
  });

  it("(shared-live-reference fix) remove command's in-lock structural revalidation catches an IN-PLACE mutation of the live record (e.g. a folder rename rewriting server.group) made while the confirmation modal was pending — comparing against the live `server` reference would trivially 'match' any mutation applied to that same object, so this aborts with the changed-since-confirmed message and performs no teardown/vault-delete/removeServer", async () => {
    const { ctx, stopTunnel, disconnectPool, removeServer, secretDelete, terminalDispose } = setupHarness({
      profiles: [],
      activeTunnels: []
    });

    registerServerCommands(ctx);
    const removeCmd = registeredCommands.get("nexus.server.remove");
    expect(removeCmd).toBeDefined();

    // The harness's default core.getServer does snapshot.servers.find(...) —
    // both the initial arg-resolution lookup and the in-lock re-check
    // lookup return the SAME live object reference from snapshot.servers,
    // exactly like production's NexusCore.getServer (Map#get returns the
    // map's own object, never a copy). Simulate a concurrent
    // nexus.group.rename mutating server.group ON THAT OBJECT while the
    // confirmation modal is pending, by hooking the mock modal's resolution.
    mockShowWarningMessage.mockImplementationOnce(async () => {
      const live = (ctx.core.getServer as ReturnType<typeof vi.fn>)("srv-1");
      live.group = "renamed-folder";
      return "Remove";
    });

    await removeCmd!("srv-1");

    // If the fix under test were reverted to comparing against the live
    // `server` reference instead of a snapshot captured before the mutation,
    // `currentRecord` and `server` would be the SAME mutated object by the
    // time the in-lock check runs — serverConfigsEqual would trivially
    // report "equal" and the removal would proceed despite the change. With
    // the detached pre-modal snapshot, the mutation is caught and nothing
    // below may run.
    expect(terminalDispose).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(disconnectPool).not.toHaveBeenCalled();
    expect(secretDelete).not.toHaveBeenCalled();
    expect(removeServer).not.toHaveBeenCalled();
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("changed since the removal was confirmed")
    );
  });

  it("clears File Explorer auto-open on duplicated server profiles", async () => {
    const { ctx, addOrUpdateServer } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ openFileExplorerOnFirstConnect: true })]
    });

    registerServerCommands(ctx);
    const duplicateCmd = registeredCommands.get("nexus.server.duplicate");
    expect(duplicateCmd).toBeDefined();

    await duplicateCmd!("srv-1");

    expect(addOrUpdateServer).toHaveBeenCalledWith(expect.objectContaining({
      name: "Server 1 (copy)",
      openFileExplorerOnFirstConnect: undefined
    }));
  });

  it("F6 — duplicating a synced server strips origin (a spread-copy would keep it and collide with the original on the next sync)", async () => {
    const { ctx, addOrUpdateServer } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ origin: { sourceId: "source-1", externalId: "device:1", syncedAt: 1000 } })]
    });

    registerServerCommands(ctx);
    const duplicateCmd = registeredCommands.get("nexus.server.duplicate");
    expect(duplicateCmd).toBeDefined();

    await duplicateCmd!("srv-1");

    const copy = addOrUpdateServer.mock.calls[0][0];
    expect(copy.origin).toBeUndefined();
  });

  it("group disconnect applies only to direct-folder servers and skips hidden ones", async () => {
    const { ctx, disconnectPool } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [
        makeServer({ id: "s-root", group: "Prod" }),
        makeServer({ id: "s-child", group: "Prod/API" }),
        makeServer({ id: "s-hidden", group: "Prod/Secret", isHidden: true }),
        makeServer({ id: "s-other", group: "Staging" })
      ]
    });

    registerServerCommands(ctx);
    const groupDisconnectCmd = registeredCommands.get("nexus.group.disconnect");
    expect(groupDisconnectCmd).toBeDefined();

    await groupDisconnectCmd!(new FolderTreeItem("Prod", "Prod"));

    expect(disconnectPool).toHaveBeenCalledTimes(1);
    expect(disconnectPool).toHaveBeenCalledWith("s-root");
    expect(disconnectPool).not.toHaveBeenCalledWith("s-child");
    expect(disconnectPool).not.toHaveBeenCalledWith("s-hidden");
    expect(disconnectPool).not.toHaveBeenCalledWith("s-other");
  });
});

describe("server test connection command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    (vscode.window as any).activeTerminal = undefined;
    vi.mocked(vscode.window.withProgress as any).mockImplementation(async (_options: unknown, task: () => Promise<unknown>) => task());
  });

  it("connects, disposes the probe connection, and reports success", async () => {
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [] });
    const connection = { dispose: vi.fn() };
    (ctx.sshFactory as any).connect = vi.fn(async () => connection);

    registerServerCommands(ctx);
    const testCmd = registeredCommands.get("nexus.server.testConnection");
    expect(testCmd).toBeDefined();

    await testCmd!("srv-1");

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Testing connection to Server 1..." }),
      expect.any(Function)
    );
    expect((ctx.sshFactory as any).connect).toHaveBeenCalledWith(expect.objectContaining({ id: "srv-1" }));
    expect(connection.dispose).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Connection test succeeded for Server 1.");
  });

  it("shows classified failure details and copies sanitized diagnostics on request", async () => {
    const { ctx } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ name: "Prod", host: "prod.example.com", port: 2222 })]
    });
    (ctx.sshFactory as any).connect = vi.fn(async () => {
      throw new Error("All configured authentication methods failed for password hunter2");
    });
    mockShowErrorMessage.mockResolvedValueOnce("Copy Details");

    registerServerCommands(ctx);
    await registeredCommands.get("nexus.server.testConnection")!("srv-1");

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Authentication failed"),
      "Copy Details"
    );
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledTimes(1);
    const copied = vi.mocked(vscode.env.clipboard.writeText).mock.calls[0][0];
    expect(copied).toContain("Server: Prod");
    expect(copied).toContain("Host: prod.example.com");
    expect(copied).toContain("Port: 2222");
    expect(copied).toContain("Stage: auth");
    expect(copied).toContain("Authentication failed");
    expect(copied).not.toContain("hunter2");
    expect(copied).not.toContain("password hunter2");
  });

  it("falls back to a server QuickPick when no server tree item is supplied", async () => {
    const { ctx } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [
        makeServer({ id: "srv-a", name: "Alpha", host: "alpha.example.com" }),
        makeServer({ id: "srv-b", name: "Beta", host: "beta.example.com" })
      ]
    });
    const connection = { dispose: vi.fn() };
    (ctx.sshFactory as any).connect = vi.fn(async () => connection);
    vi.mocked(vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: "Beta",
      server: makeServer({ id: "srv-b", name: "Beta", host: "beta.example.com" })
    });

    registerServerCommands(ctx);
    await registeredCommands.get("nexus.server.testConnection")!();

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ label: "Beta" })]),
      expect.objectContaining({ title: "Select Nexus Server" })
    );
    expect((ctx.sshFactory as any).connect).toHaveBeenCalledWith(expect.objectContaining({ id: "srv-b" }));
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });

  it("offers the server QuickPick in natural (numeric) name order", async () => {
    const { ctx } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [
        makeServer({ id: "srv-10", name: "A10", host: "a10.example.com" }),
        makeServer({ id: "srv-2", name: "A2", host: "a2.example.com" }),
        makeServer({ id: "srv-1", name: "A1", host: "a1.example.com" })
      ]
    });

    registerServerCommands(ctx);
    await registeredCommands.get("nexus.server.testConnection")!();

    const items = vi.mocked(vscode.window.showQuickPick as any).mock.calls[0][0];
    expect(items.map((item: { label: string }) => item.label)).toEqual(["A1", "A2", "A10"]);
  });
});

describe("formValuesToProxy", () => {
  it("returns undefined for proxyType=none", () => {
    expect(formValuesToProxy({ proxyType: "none" })).toBeUndefined();
  });

  it("returns undefined when proxyType is missing", () => {
    expect(formValuesToProxy({})).toBeUndefined();
  });

  it("parses SSH jump host proxy", () => {
    const result = formValuesToProxy({
      proxyType: "ssh",
      proxyJumpHostId: "srv-jump-123"
    });
    expect(result).toEqual({ type: "ssh", jumpHostId: "srv-jump-123" });
  });

  it("returns undefined for SSH proxy without jump host", () => {
    expect(formValuesToProxy({ proxyType: "ssh", proxyJumpHostId: "" })).toBeUndefined();
  });

  it("parses SOCKS5 proxy", () => {
    const result = formValuesToProxy({
      proxyType: "socks5",
      proxySocks5Host: "proxy.example.com",
      proxySocks5Port: 1080,
      proxySocks5Username: "user1"
    });
    expect(result).toEqual({ type: "socks5", host: "proxy.example.com", port: 1080, username: "user1" });
  });

  it("omits SOCKS5 username when empty", () => {
    const result = formValuesToProxy({
      proxyType: "socks5",
      proxySocks5Host: "proxy.example.com",
      proxySocks5Port: 1080,
      proxySocks5Username: ""
    });
    expect(result).toEqual({ type: "socks5", host: "proxy.example.com", port: 1080 });
  });

  it("parses HTTP CONNECT proxy", () => {
    const result = formValuesToProxy({
      proxyType: "http",
      proxyHttpHost: "corporate-proxy.com",
      proxyHttpPort: 3128,
      proxyHttpUsername: "admin"
    });
    expect(result).toEqual({ type: "http", host: "corporate-proxy.com", port: 3128, username: "admin" });
  });

  it("returns undefined for HTTP proxy without host", () => {
    expect(formValuesToProxy({ proxyType: "http", proxyHttpHost: "", proxyHttpPort: 3128 })).toBeUndefined();
  });

  it("returns undefined for SOCKS5 proxy with invalid port", () => {
    expect(formValuesToProxy({
      proxyType: "socks5",
      proxySocks5Host: "proxy.example.com",
      proxySocks5Port: 0
    })).toBeUndefined();
    expect(formValuesToProxy({
      proxyType: "socks5",
      proxySocks5Host: "proxy.example.com",
      proxySocks5Port: 70000
    })).toBeUndefined();
    expect(formValuesToProxy({
      proxyType: "socks5",
      proxySocks5Host: "proxy.example.com",
      proxySocks5Port: 1080.5
    })).toBeUndefined();
  });

  it("returns undefined for HTTP proxy with invalid port", () => {
    expect(formValuesToProxy({
      proxyType: "http",
      proxyHttpHost: "proxy.example.com",
      proxyHttpPort: 0
    })).toBeUndefined();
    expect(formValuesToProxy({
      proxyType: "http",
      proxyHttpHost: "proxy.example.com",
      proxyHttpPort: 70000
    })).toBeUndefined();
  });
});

describe("formValuesToServer with proxy", () => {
  it("includes proxy config in server when present", () => {
    const server = formValuesToServer({
      name: "Test",
      host: "example.com",
      port: 22,
      username: "root",
      authType: "password",
      proxyType: "socks5",
      proxySocks5Host: "proxy.local",
      proxySocks5Port: 1080
    });
    expect(server).toBeDefined();
    expect(server!.proxy).toEqual({ type: "socks5", host: "proxy.local", port: 1080 });
  });

  it("omits proxy when proxyType is none", () => {
    const server = formValuesToServer({
      name: "Test",
      host: "example.com",
      port: 22,
      username: "root",
      authType: "password",
      proxyType: "none"
    });
    expect(server).toBeDefined();
    expect(server!.proxy).toBeUndefined();
  });
});

describe("formValuesToServer authProfileId", () => {
  it("includes authProfileId when set", () => {
    const server = formValuesToServer({
      name: "Test",
      host: "example.com",
      port: 22,
      username: "root",
      authType: "password",
      authProfileId: "ap-123"
    });
    expect(server).toBeDefined();
    expect(server!.authProfileId).toBe("ap-123");
  });

  it("omits authProfileId when empty string", () => {
    const server = formValuesToServer({
      name: "Test",
      host: "example.com",
      port: 22,
      username: "root",
      authType: "password",
      authProfileId: ""
    });
    expect(server).toBeDefined();
    expect(server!.authProfileId).toBeUndefined();
  });

  it("omits authProfileId when not provided", () => {
    const server = formValuesToServer({
      name: "Test",
      host: "example.com",
      port: 22,
      username: "root",
      authType: "password"
    });
    expect(server).toBeDefined();
    expect(server!.authProfileId).toBeUndefined();
  });
});

describe("formValuesToServer File Explorer auto-open", () => {
  it("maps enabled File Explorer auto-open from form values", () => {
    const server = formValuesToServer({
      name: "Test",
      host: "example.com",
      port: 22,
      username: "root",
      authType: "password",
      openFileExplorerOnFirstConnect: true
    });

    expect(server).toBeDefined();
    expect(server!.openFileExplorerOnFirstConnect).toBe(true);
  });

  it("omits File Explorer auto-open when unchecked", () => {
    const server = formValuesToServer({
      name: "Test",
      host: "example.com",
      port: 22,
      username: "root",
      authType: "password",
      openFileExplorerOnFirstConnect: false
    });

    expect(server).toBeDefined();
    expect(server!.openFileExplorerOnFirstConnect).toBeUndefined();
  });
});

describe("preserveLinkedServerCredentials", () => {
  const fullProfile: AuthProfile = {
    id: "ap-123",
    name: "Production",
    username: "profile-user",
    authType: "password"
  };

  it("preserves existing local credentials when auth profile is linked", () => {
    const existing = makeServer({
      username: "stored-user",
      authType: "key",
      keyPath: "/stored/key"
    });
    const next = makeServer({
      username: "profile-user",
      authType: "password",
      authProfileId: "ap-123"
    });
    // keyPath is preserved here because THIS profile supplies one — see the
    // key-profile-without-a-key case below for the other half of the rule.
    expect(
      preserveLinkedServerCredentials(existing, next, { ...fullProfile, authType: "key", keyPath: "/profile/key" })
    ).toEqual(
      expect.objectContaining({
        username: "stored-user",
        authType: "key",
        keyPath: "/stored/key",
        authProfileId: "ap-123"
      })
    );
  });

  it("leaves standalone servers unchanged", () => {
    const existing = makeServer({ username: "stored-user", authType: "key", keyPath: "/stored/key" });
    const next = makeServer({ username: "edited-user", authType: "password" });
    expect(preserveLinkedServerCredentials(existing, next, undefined)).toEqual(next);
  });

  // REVIEW FINDING (P2) — kills restoring every credential whenever a link
  // exists. The form unlocks exactly the fields the profile does not supply, so
  // restoring those discards the edit the user was invited to make. Each
  // fixture below is built so the wrong implementation VISIBLY differs: the
  // submitted value never equals the stored one.
  it("keeps an edited username under a profile whose own username is blank (kills restoring username unconditionally: the form unlocks that field because the profile fills nothing there, and the old save handed the stored value straight back)", () => {
    const blank: AuthProfile = { id: "ap-blank", name: "Imported", username: "   ", authType: "password" };
    const existing = makeServer({ username: "stored-user", authType: "password" });
    const next = makeServer({ username: "edited-user", authType: "password", authProfileId: "ap-blank" });

    expect(preserveLinkedServerCredentials(existing, next, blank).username).toBe("edited-user");
  });

  it("keeps an edited key path under a key profile that carries none, while still restoring the username and auth type it does supply (kills restoring keyPath unconditionally)", () => {
    const keyless: AuthProfile = { id: "ap-key", name: "Shared Key", username: "profile-user", authType: "key" };
    const existing = makeServer({ username: "stored-user", authType: "password", keyPath: undefined });
    const next = makeServer({
      username: "profile-user",
      authType: "key",
      keyPath: "/home/me/.ssh/edited",
      authProfileId: "ap-key"
    });

    expect(preserveLinkedServerCredentials(existing, next, keyless)).toEqual(
      expect.objectContaining({
        username: "stored-user",
        authType: "password",
        keyPath: "/home/me/.ssh/edited"
      })
    );
  });

  it("keeps every submitted value when the linked id resolves to no profile (kills restoring on the strength of the id alone: with nothing to mirror from, the form opened those fields unlocked and prefilled from the record, so what comes back is the user's own edit)", () => {
    const existing = makeServer({ username: "stored-user", authType: "password", keyPath: "/stored/key" });
    const next = makeServer({
      username: "edited-user",
      authType: "key",
      keyPath: "/edited/key",
      authProfileId: "ap-deleted"
    });

    expect(preserveLinkedServerCredentials(existing, next, undefined)).toEqual(next);
  });
});

/**
 * REVIEW FINDING (P2) — the third layer. The mirror payload IS the webview's
 * ownership record (formHtml's `filledKeysFromValues` rebuilds
 * `profileFilledKeys` from it), so a payload carrying a key the profile does
 * not supply is what locks a field the save then refuses to keep. It must
 * carry exactly `authProfileOwnedCredentials`.
 */
describe("authProfileCredentialMirror", () => {
  it("sends every key a profile supplies", () => {
    const profile: AuthProfile = { id: "ap", name: "Key", username: "root", authType: "key", keyPath: "/keys/id" };
    expect(authProfileCredentialMirror(profile)).toEqual({
      username: "root",
      authType: "key",
      keyPath: "/keys/id"
    });
  });

  it("omits a whitespace-only username (kills sending profile.username unfiltered, which overwrites the username the user typed with whitespace and then locks the field holding it)", () => {
    const profile: AuthProfile = { id: "ap", name: "Imported", username: "   ", authType: "password" };
    expect(authProfileCredentialMirror(profile)).toEqual({ authType: "password" });
  });

  it("omits keyPath for a key profile that carries none (kills sending an empty string, which locks the control the user needs to supply one)", () => {
    const profile: AuthProfile = { id: "ap", name: "Shared Key", username: "root", authType: "key", keyPath: "  " };
    expect(authProfileCredentialMirror(profile)).toEqual({ username: "root", authType: "key" });
  });

  it("answers `undefined` — WebviewFormPanel's 'no answer' — for an id that resolves to nothing", () => {
    expect(authProfileCredentialMirror(undefined)).toBeUndefined();
  });

  it("is what the server edit form actually posts back (kills a form left wired to its own inline payload)", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    mockWebviewFormPanelOpen.mockReset();
    mockWebviewFormPanelOpen.mockReturnValue({ dispose: vi.fn(), onDidDispose: vi.fn() });
    const blank: AuthProfile = { id: "ap-blank", name: "Imported", username: "   ", authType: "password" };
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [], authProfiles: [blank] });

    registerServerCommands(ctx);
    await registeredCommands.get("nexus.server.edit")!("srv-1");
    const options = mockWebviewFormPanelOpen.mock.calls.at(-1)![2] as {
      onAutofill: (key: string, value: string) => Promise<Record<string, string> | undefined>;
    };

    expect(await options.onAutofill("authProfileId", "ap-blank")).toEqual({ authType: "password" });
    expect(await options.onAutofill("authProfileId", "no-such-profile")).toBeUndefined();
  });
});

describe("formValuesToServer group normalization", () => {
  it("normalizes valid group values", () => {
    const server = formValuesToServer({
      name: "Test",
      host: "example.com",
      port: 22,
      username: "root",
      authType: "password",
      group: "  Prod / US-East  "
    });
    expect(server).toBeDefined();
    expect(server!.group).toBe("Prod/US-East");
  });

  it("rejects invalid non-empty group values", () => {
    const server = formValuesToServer({
      name: "Test",
      host: "example.com",
      port: 22,
      username: "root",
      authType: "password",
      group: "/"
    });
    expect(server).toBeUndefined();
  });
});

describe("syncProxyPasswordSecret", () => {
  it("stores SOCKS5 proxy password when username is set and password provided", async () => {
    const { ctx, secretStore } = setupHarness({ profiles: [], activeTunnels: [] });
    await syncProxyPasswordSecret(ctx, "srv-1", {
      proxyType: "socks5",
      proxySocks5Username: "user1",
      proxySocks5Password: "secret-socks5"
    });
    expect(secretStore).toHaveBeenCalledWith(proxyPasswordSecretKey("srv-1"), "secret-socks5");
  });

  it("stores HTTP proxy password when username is set and password provided", async () => {
    const { ctx, secretStore } = setupHarness({ profiles: [], activeTunnels: [] });
    await syncProxyPasswordSecret(ctx, "srv-1", {
      proxyType: "http",
      proxyHttpUsername: "user1",
      proxyHttpPassword: "secret-http"
    });
    expect(secretStore).toHaveBeenCalledWith(proxyPasswordSecretKey("srv-1"), "secret-http");
  });

  it("deletes proxy password when username is removed", async () => {
    const { ctx, secretDelete } = setupHarness({ profiles: [], activeTunnels: [] });
    await syncProxyPasswordSecret(ctx, "srv-1", {
      proxyType: "socks5",
      proxySocks5Username: "",
      proxySocks5Password: ""
    });
    expect(secretDelete).toHaveBeenCalledWith(proxyPasswordSecretKey("srv-1"));
  });

  it("deletes proxy password when proxy is disabled", async () => {
    const { ctx, secretDelete } = setupHarness({ profiles: [], activeTunnels: [] });
    await syncProxyPasswordSecret(ctx, "srv-1", { proxyType: "none" });
    expect(secretDelete).toHaveBeenCalledWith(proxyPasswordSecretKey("srv-1"));
  });

  it("keeps existing secret when password field is blank", async () => {
    const { ctx, secretDelete, secretStore } = setupHarness({ profiles: [], activeTunnels: [] });
    await syncProxyPasswordSecret(ctx, "srv-1", {
      proxyType: "http",
      proxyHttpUsername: "user1",
      proxyHttpPassword: ""
    });
    expect(secretStore).not.toHaveBeenCalled();
    expect(secretDelete).not.toHaveBeenCalled();
  });
});

describe("deploy key command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    (vscode.window as any).activeTerminal = undefined;
    vi.mocked(findLocalKeyPairs).mockReset();
    vi.mocked(generateKeyPair).mockReset();
    vi.mocked(deployPublicKeyToRemote).mockReset();
    vi.mocked(readFile).mockReset();
    vi.mocked(vscode.window.showQuickPick as any).mockReset();
    vi.mocked(vscode.window.showInformationMessage as any).mockReset();
    vi.mocked(vscode.window.showInputBox as any).mockReset();
    vi.mocked(defaultSshDir).mockReturnValue("/home/user/.ssh");
    vi.mocked(findLocalKeyPairs).mockResolvedValue([]);
    vi.mocked(generateKeyPair).mockResolvedValue({
      publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
      privateKeyPath: "/home/user/.ssh/id_ed25519"
    });
    vi.mocked(deployPublicKeyToRemote).mockResolvedValue({ alreadyDeployed: false });
    vi.mocked(vscode.window.withProgress as any).mockImplementation(async (_options: unknown, task: () => Promise<unknown>) => task());
  });

  it("deploys selected key and converts a linked password-profile server to standalone key auth", async () => {
    const passwordProfile = makeAuthProfile({ id: "ap-pass", username: "profile-user", authType: "password" });
    const { ctx, addOrUpdateServer, secretDelete } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ username: "stored-user", authProfileId: "ap-pass" })],
      authProfiles: [passwordProfile]
    });
    const connection = { dispose: vi.fn() };
    (ctx.sshFactory as any).connect = vi.fn(async () => connection);

    vi.mocked(findLocalKeyPairs).mockResolvedValue([
      {
        name: "id_ed25519",
        publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
        privateKeyPath: "/home/user/.ssh/id_ed25519"
      }
    ]);
    vi.mocked(vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: "id_ed25519",
      keyPair: {
        name: "id_ed25519",
        publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
        privateKeyPath: "/home/user/.ssh/id_ed25519"
      }
    });
    vi.mocked(readFile).mockResolvedValueOnce("ssh-ed25519 AAAA user@example");
    vi.mocked(deployPublicKeyToRemote).mockResolvedValueOnce({ alreadyDeployed: false });
    vi.mocked(vscode.window.showInformationMessage as any).mockResolvedValueOnce("Use standalone key");

    registerServerCommands(ctx);
    const deployCmd = registeredCommands.get("nexus.server.deployKey");
    expect(deployCmd).toBeDefined();

    await deployCmd!("srv-1");

    expect((ctx.sshFactory as any).connect).toHaveBeenCalledWith(expect.objectContaining({ id: "srv-1" }));
    expect(deployPublicKeyToRemote).toHaveBeenCalledWith(connection, "ssh-ed25519 AAAA user@example");
    expect(addOrUpdateServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "srv-1",
        username: "profile-user",
        authProfileId: undefined,
        authType: "key",
        keyPath: "/home/user/.ssh/id_ed25519"
      })
    );
    expect(secretDelete).not.toHaveBeenCalledWith(passwordSecretKey("srv-1"));
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });

  // REVIEW FINDING (P2) — the deploy flow's own reader of a linked profile's
  // username. `profile.username ?? server.username` treated whitespace as a
  // usable value, so the converted record was written with a username
  // validateServerConfig rejects: a server that vanishes at the next load.
  it("converts on the server's own username when the linked profile supplies only whitespace (kills `?? server.username` reading a blank profile username as usable)", async () => {
    const blankProfile = makeAuthProfile({ id: "ap-blank", username: "   ", authType: "password" });
    const { ctx, addOrUpdateServer } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ username: "stored-user", authProfileId: "ap-blank" })],
      authProfiles: [blankProfile]
    });
    (ctx.sshFactory as any).connect = vi.fn(async () => ({ dispose: vi.fn() }));

    vi.mocked(findLocalKeyPairs).mockResolvedValue([
      { name: "id_ed25519", publicKeyPath: "/home/user/.ssh/id_ed25519.pub", privateKeyPath: "/home/user/.ssh/id_ed25519" }
    ]);
    vi.mocked(vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: "id_ed25519",
      keyPair: { name: "id_ed25519", publicKeyPath: "/home/user/.ssh/id_ed25519.pub", privateKeyPath: "/home/user/.ssh/id_ed25519" }
    });
    vi.mocked(readFile).mockResolvedValueOnce("ssh-ed25519 AAAA user@example");
    vi.mocked(deployPublicKeyToRemote).mockResolvedValueOnce({ alreadyDeployed: false });
    vi.mocked(vscode.window.showInformationMessage as any).mockResolvedValueOnce("Use standalone key");

    registerServerCommands(ctx);
    await registeredCommands.get("nexus.server.deployKey")!("srv-1");

    expect(addOrUpdateServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "srv-1", username: "stored-user", authType: "key" })
    );
  });

  it("offers to remove a stale server password secret after converting a profile-linked password server", async () => {
    const passwordProfile = makeAuthProfile({ id: "ap-pass", username: "profile-user", authType: "password" });
    const { ctx, addOrUpdateServer, secretDelete } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ username: "stored-user", authProfileId: "ap-pass" })],
      authProfiles: [passwordProfile],
      initialSecrets: { [passwordSecretKey("srv-1")]: "stale-server-secret" }
    });
    const connection = { dispose: vi.fn() };
    (ctx.sshFactory as any).connect = vi.fn(async () => connection);

    vi.mocked(findLocalKeyPairs).mockResolvedValue([
      {
        name: "id_ed25519",
        publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
        privateKeyPath: "/home/user/.ssh/id_ed25519"
      }
    ]);
    vi.mocked(vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: "id_ed25519",
      keyPair: {
        name: "id_ed25519",
        publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
        privateKeyPath: "/home/user/.ssh/id_ed25519"
      }
    });
    vi.mocked(readFile).mockResolvedValueOnce("ssh-ed25519 AAAA user@example");
    vi.mocked(deployPublicKeyToRemote).mockResolvedValueOnce({ alreadyDeployed: false });
    vi.mocked(vscode.window.showInformationMessage as any)
      .mockResolvedValueOnce("Use standalone key")
      .mockResolvedValueOnce("Remove stored password");

    registerServerCommands(ctx);
    const deployCmd = registeredCommands.get("nexus.server.deployKey");
    expect(deployCmd).toBeDefined();

    await deployCmd!("srv-1");

    expect(addOrUpdateServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "srv-1",
        username: "profile-user",
        authProfileId: undefined,
        authType: "key",
        keyPath: "/home/user/.ssh/id_ed25519"
      })
    );
    expect(secretDelete).toHaveBeenCalledWith(passwordSecretKey("srv-1"));
  });

  it("links the server to a selected matching key auth profile", async () => {
    const passwordProfile = makeAuthProfile({ id: "ap-pass", username: "profile-user", authType: "password" });
    const keyProfile = makeAuthProfile({
      id: "ap-key",
      name: "Shared Deploy Key",
      username: "profile-user",
      authType: "key",
      keyPath: "/home/user/.ssh/id_ed25519"
    });
    const { ctx, addOrUpdateServer, secretDelete } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ username: "stored-user", authProfileId: "ap-pass" })],
      authProfiles: [passwordProfile, keyProfile]
    });
    const connection = { dispose: vi.fn() };
    (ctx.sshFactory as any).connect = vi.fn(async () => connection);

    vi.mocked(findLocalKeyPairs).mockResolvedValue([
      {
        name: "id_ed25519",
        publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
        privateKeyPath: "/home/user/.ssh/id_ed25519"
      }
    ]);
    vi.mocked(vscode.window.showQuickPick as any)
      .mockResolvedValueOnce({
        label: "id_ed25519",
        keyPair: {
          name: "id_ed25519",
          publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
          privateKeyPath: "/home/user/.ssh/id_ed25519"
        }
      })
      .mockResolvedValueOnce({ label: "Shared Deploy Key — key — profile-user — id_ed25519", profile: keyProfile });
    vi.mocked(readFile).mockResolvedValueOnce("ssh-ed25519 AAAA user@example");
    vi.mocked(deployPublicKeyToRemote).mockResolvedValueOnce({ alreadyDeployed: false });
    vi.mocked(vscode.window.showInformationMessage as any).mockResolvedValueOnce("Use key auth profile");

    registerServerCommands(ctx);
    const deployCmd = registeredCommands.get("nexus.server.deployKey");
    expect(deployCmd).toBeDefined();

    await deployCmd!("srv-1");

    expect(addOrUpdateServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "srv-1",
        username: "profile-user",
        authProfileId: "ap-key",
        authType: "key",
        keyPath: "/home/user/.ssh/id_ed25519"
      })
    );
    expect(secretDelete).not.toHaveBeenCalledWith(passwordSecretKey("srv-1"));
  });

  it("matches existing key auth profiles even when the key path uses different slash styles", async () => {
    const passwordProfile = makeAuthProfile({ id: "ap-pass", username: "profile-user", authType: "password" });
    const keyProfile = makeAuthProfile({
      id: "ap-key",
      name: "Shared Deploy Key",
      username: "profile-user",
      authType: "key",
      keyPath: "\\home\\user\\.ssh\\id_ed25519"
    });
    const { ctx, addOrUpdateServer } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ username: "stored-user", authProfileId: "ap-pass" })],
      authProfiles: [passwordProfile, keyProfile]
    });
    const connection = { dispose: vi.fn() };
    (ctx.sshFactory as any).connect = vi.fn(async () => connection);

    vi.mocked(findLocalKeyPairs).mockResolvedValue([
      {
        name: "id_ed25519",
        publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
        privateKeyPath: "/home/user/.ssh/id_ed25519"
      }
    ]);
    vi.mocked(vscode.window.showQuickPick as any)
      .mockResolvedValueOnce({
        label: "id_ed25519",
        keyPair: {
          name: "id_ed25519",
          publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
          privateKeyPath: "/home/user/.ssh/id_ed25519"
        }
      })
      .mockResolvedValueOnce({ label: "Shared Deploy Key — key — profile-user — id_ed25519", profile: keyProfile });
    vi.mocked(readFile).mockResolvedValueOnce("ssh-ed25519 AAAA user@example");
    vi.mocked(deployPublicKeyToRemote).mockResolvedValueOnce({ alreadyDeployed: false });
    vi.mocked(vscode.window.showInformationMessage as any).mockResolvedValueOnce("Use key auth profile");

    registerServerCommands(ctx);
    const deployCmd = registeredCommands.get("nexus.server.deployKey");
    expect(deployCmd).toBeDefined();

    await deployCmd!("srv-1");

    expect(addOrUpdateServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "srv-1",
        authProfileId: "ap-key",
        authType: "key",
        keyPath: "/home/user/.ssh/id_ed25519"
      })
    );
  });

  it("creates a new key auth profile, links it, and offers to remove stored standalone password", async () => {
    const { ctx, addOrUpdateServer, addOrUpdateAuthProfile, secretDelete } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ username: "deploy-user", authType: "password" })],
      initialSecrets: { [passwordSecretKey("srv-1")]: "stored-password" }
    });
    const connection = { dispose: vi.fn() };
    (ctx.sshFactory as any).connect = vi.fn(async () => connection);

    vi.mocked(findLocalKeyPairs).mockResolvedValue([
      {
        name: "id_ed25519",
        publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
        privateKeyPath: "/home/user/.ssh/id_ed25519"
      }
    ]);
    vi.mocked(vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: "id_ed25519",
      keyPair: {
        name: "id_ed25519",
        publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
        privateKeyPath: "/home/user/.ssh/id_ed25519"
      }
    });
    vi.mocked(vscode.window.showInputBox as any).mockImplementationOnce(async (options: any) => {
      expect(options.value).toBe("deploy-user — id_ed25519");
      return "Deploy Key Profile";
    });
    vi.mocked(readFile).mockResolvedValueOnce("ssh-ed25519 AAAA user@example");
    vi.mocked(deployPublicKeyToRemote).mockResolvedValueOnce({ alreadyDeployed: false });
    vi.mocked(vscode.window.showInformationMessage as any)
      .mockResolvedValueOnce("Use key auth profile")
      .mockResolvedValueOnce("Remove stored password");

    registerServerCommands(ctx);
    const deployCmd = registeredCommands.get("nexus.server.deployKey");
    expect(deployCmd).toBeDefined();

    await deployCmd!("srv-1");

    expect(addOrUpdateAuthProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Deploy Key Profile",
        username: "deploy-user",
        authType: "key",
        keyPath: "/home/user/.ssh/id_ed25519"
      })
    );
    const createdProfile = addOrUpdateAuthProfile.mock.calls[0][0];
    expect(addOrUpdateServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "srv-1",
        username: "deploy-user",
        authProfileId: createdProfile.id,
        authType: "key",
        keyPath: "/home/user/.ssh/id_ed25519"
      })
    );
    expect(secretDelete).toHaveBeenCalledWith(passwordSecretKey("srv-1"));
  });

  it("still offers conversion choices when the public key is already deployed", async () => {
    const keyProfile = makeAuthProfile({
      id: "ap-key",
      name: "Existing Key",
      username: "deploy-user",
      authType: "key",
      keyPath: "/home/user/.ssh/id_ed25519"
    });
    const { ctx, addOrUpdateServer } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ username: "deploy-user", authType: "password" })],
      authProfiles: [keyProfile]
    });
    const connection = { dispose: vi.fn() };
    (ctx.sshFactory as any).connect = vi.fn(async () => connection);

    vi.mocked(findLocalKeyPairs).mockResolvedValue([
      {
        name: "id_ed25519",
        publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
        privateKeyPath: "/home/user/.ssh/id_ed25519"
      }
    ]);
    vi.mocked(vscode.window.showQuickPick as any)
      .mockResolvedValueOnce({
        label: "id_ed25519",
        keyPair: {
          name: "id_ed25519",
          publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
          privateKeyPath: "/home/user/.ssh/id_ed25519"
        }
      })
      .mockResolvedValueOnce({ label: "Existing Key — key — deploy-user — id_ed25519", profile: keyProfile });
    vi.mocked(readFile).mockResolvedValueOnce("ssh-ed25519 AAAA user@example");
    vi.mocked(deployPublicKeyToRemote).mockResolvedValueOnce({ alreadyDeployed: true });
    vi.mocked(vscode.window.showInformationMessage as any)
      .mockResolvedValueOnce("Use key auth profile")
      .mockResolvedValueOnce(undefined);

    registerServerCommands(ctx);
    const deployCmd = registeredCommands.get("nexus.server.deployKey");
    expect(deployCmd).toBeDefined();

    await deployCmd!("srv-1");

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Public key is already deployed on Server 1. Choose how to use it for future connections.",
      "Use standalone key",
      "Use key auth profile"
    );
    expect(addOrUpdateServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "srv-1",
        authProfileId: "ap-key",
        authType: "key",
        keyPath: "/home/user/.ssh/id_ed25519"
      })
    );
  });

  it("validates generated key name and uses generated private key path", async () => {
    const { ctx, addOrUpdateServer } = setupHarness({ profiles: [], activeTunnels: [] });
    const connection = { dispose: vi.fn() };
    (ctx.sshFactory as any).connect = vi.fn(async () => connection);

    vi.mocked(findLocalKeyPairs).mockResolvedValue([]);
    vi.mocked(vscode.window.showQuickPick as any)
      .mockResolvedValueOnce({ label: "$(add) Generate new ed25519 key", generate: true })
      .mockResolvedValueOnce({ label: "No passphrase", passphrase: "" });
    vi.mocked(vscode.window.showInputBox as any).mockImplementationOnce(async (options: any) => {
      expect(options.validateInput("..")).toContain("cannot");
      expect(options.validateInput("bad/name")).toContain("only contain");
      return "id_custom";
    });
    vi.mocked(generateKeyPair).mockResolvedValueOnce({
      publicKeyPath: "/home/user/.ssh/id_custom.pub",
      privateKeyPath: "/home/user/.ssh/id_custom"
    });
    vi.mocked(readFile)
      .mockResolvedValueOnce("exists")
      .mockResolvedValueOnce("ssh-ed25519 AAAA id_custom");
    vi.mocked(deployPublicKeyToRemote).mockResolvedValueOnce({ alreadyDeployed: false });
    vi.mocked(vscode.window.showInformationMessage as any).mockResolvedValueOnce("Use standalone key");

    registerServerCommands(ctx);
    const deployCmd = registeredCommands.get("nexus.server.deployKey");
    expect(deployCmd).toBeDefined();

    await deployCmd!("srv-1");

    expect(generateKeyPair).toHaveBeenCalledWith({
      sshDir: "/home/user/.ssh",
      name: "id_custom",
      passphrase: ""
    });
    expect(addOrUpdateServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "srv-1",
        authType: "key",
        keyPath: "/home/user/.ssh/id_custom"
      })
    );
  });
});

describe("SSH terminal tab visual differentiation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    (vscode.window as any).activeTerminal = undefined;
    vi.mocked(vscode.window.withProgress as any).mockImplementation(
      async (_options: unknown, task: () => Promise<unknown>) => task()
    );
  });

  it("creates SSH terminal with server icon and cyan color", async () => {
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [] });
    (ctx as any).macroAutoTrigger = { createObserver: vi.fn(() => ({})), bindObserverToSession: vi.fn() };
    (ctx as any).activityIndicators = new Map();
    ctx.core.registerSession = vi.fn();

    registerServerCommands(ctx);
    const connectCmd = registeredCommands.get("nexus.server.connect");
    expect(connectCmd).toBeDefined();

    await connectCmd!("srv-1");

    expect(vscode.window.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        iconPath: expect.objectContaining({ id: "server" }),
        color: expect.objectContaining({ id: "terminal.ansiCyan" })
      })
    );
  });
});

describe("SSH File Explorer auto-open on manual connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    (vscode.window as any).activeTerminal = undefined;
    vi.mocked(vscode.window.withProgress as any).mockImplementation(
      async (_options: unknown, task: () => Promise<unknown>) => task()
    );
  });

  it("opens the File Explorer once after the first successful normal Connect session", async () => {
    const server = makeServer({ openFileExplorerOnFirstConnect: true });
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [], servers: [server] });
    vi.mocked(ctx.fileExplorerProvider.getActiveServerId as any).mockReturnValue("other-server");

    registerServerCommands(ctx);
    const connectCmd = registeredCommands.get("nexus.server.connect");
    expect(connectCmd).toBeDefined();

    await connectCmd!("srv-1");
    const callbacks = latestSshCallbacks();
    callbacks.onSessionOpened("session-1");
    callbacks.onSessionOpened("session-2");
    await flushPromises();

    expect(ctx.sftpService.connect).toHaveBeenCalledTimes(1);
    expect(ctx.sftpService.connect).toHaveBeenCalledWith(server);
    expect(ctx.sftpService.realpath).toHaveBeenCalledWith("srv-1", ".");
    expect(ctx.fileExplorerProvider.setActiveServer).toHaveBeenCalledWith(server, "/home/dev");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("nexusFileExplorer.focus");
  });

  it("does not open the File Explorer when the profile is not enabled", async () => {
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [], servers: [makeServer()] });
    vi.mocked(ctx.fileExplorerProvider.getActiveServerId as any).mockReturnValue("other-server");

    registerServerCommands(ctx);
    const connectCmd = registeredCommands.get("nexus.server.connect");
    await connectCmd!("srv-1");
    latestSshCallbacks().onSessionOpened("session-1");
    await flushPromises();

    expect(ctx.sftpService.connect).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("nexusFileExplorer.focus");
  });

  it("does not reopen the File Explorer when it already targets the same server", async () => {
    const { ctx } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ openFileExplorerOnFirstConnect: true })]
    });
    vi.mocked(ctx.fileExplorerProvider.getActiveServerId as any).mockReturnValue("srv-1");

    registerServerCommands(ctx);
    const connectCmd = registeredCommands.get("nexus.server.connect");
    await connectCmd!("srv-1");
    latestSshCallbacks().onSessionOpened("session-1");
    await flushPromises();

    expect(ctx.sftpService.connect).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("nexusFileExplorer.focus");
  });

  it("does not open the File Explorer for Connect and Run Script", async () => {
    const { ctx } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ openFileExplorerOnFirstConnect: true })]
    });
    ctx.scriptRuntimeManager = { runScript: vi.fn(async () => {}) } as any;
    vi.mocked(ctx.fileExplorerProvider.getActiveServerId as any).mockReturnValue("other-server");

    registerServerCommands(ctx);
    const runWithScriptCmd = registeredCommands.get("nexus.server.runWithScript");
    expect(runWithScriptCmd).toBeDefined();

    await runWithScriptCmd!("srv-1");
    latestSshCallbacks().onSessionOpened("script-session-1");
    await flushPromises();

    expect(ctx.sftpService.connect).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("nexusFileExplorer.focus");
    expect(ctx.scriptRuntimeManager.runScript).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: "/workspace/.nexus/scripts/task.js" }),
      "script-session-1"
    );
  });

  it("does not open the File Explorer for group Connect", async () => {
    const { ctx } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [
        makeServer({
          id: "srv-1",
          group: "Prod",
          openFileExplorerOnFirstConnect: true
        })
      ]
    });
    vi.mocked(ctx.fileExplorerProvider.getActiveServerId as any).mockReturnValue("other-server");

    registerServerCommands(ctx);
    const groupConnectCmd = registeredCommands.get("nexus.group.connect");
    expect(groupConnectCmd).toBeDefined();

    await groupConnectCmd!(new FolderTreeItem("Prod", "Prod"));
    latestSshCallbacks().onSessionOpened("group-session-1");
    await flushPromises();

    expect(ctx.sftpService.connect).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("nexusFileExplorer.focus");
  });

  it("keeps the SSH session registered when automatic File Explorer browse fails", async () => {
    const { ctx } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ openFileExplorerOnFirstConnect: true })]
    });
    vi.mocked(ctx.fileExplorerProvider.getActiveServerId as any).mockReturnValue("other-server");
    vi.mocked(ctx.sftpService.connect as any).mockRejectedValue(new Error("sftp unavailable"));

    registerServerCommands(ctx);
    const connectCmd = registeredCommands.get("nexus.server.connect");
    await connectCmd!("srv-1");
    latestSshCallbacks().onSessionOpened("session-1");
    await flushPromises();

    expect(ctx.core.registerSession).toHaveBeenCalledWith(expect.objectContaining({
      id: "session-1",
      serverId: "srv-1"
    }));
    expect(mockShowErrorMessage).toHaveBeenCalledWith("Failed to browse files on Server 1: sftp unavailable");
  });
});

describe("directory sync (issue #35) — OSC 7 observer + lifecycle holes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    (vscode.window as any).activeTerminal = undefined;
    vi.mocked(vscode.window.withProgress as any).mockImplementation(
      async (_options: unknown, task: () => Promise<unknown>) => task()
    );
  });

  function latestFullCallbacks(): {
    onSessionOpened(sessionId: string): void;
    onSessionClosed(sessionId: string): void;
    onDisconnected?(sessionId: string): void;
  } {
    const calls = vi.mocked(SshPty).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][2] as unknown as {
      onSessionOpened(sessionId: string): void;
      onSessionClosed(sessionId: string): void;
      onDisconnected?(sessionId: string): void;
    };
  }

  it("attaches exactly one OSC 7 observer per connect, bound to the session id once it opens", async () => {
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [] });
    const report = vi.fn();
    (ctx as any).cwdTracker = { report };
    (ctx as any).cwdLastOutputAt = new Map<string, number>();

    registerServerCommands(ctx);
    const connectCmd = registeredCommands.get("nexus.server.connect");
    await connectCmd!("srv-1");

    expect(mockAddOutputObserver).toHaveBeenCalledTimes(1);
    const observer = mockAddOutputObserver.mock.calls[0][0] as {
      onOutput(text: string): void;
      dispose(): void;
    };

    // Output arriving before the session id is bound must not throw and must
    // not report — there is no session key to report against yet (§5.2/§5.4g).
    observer.onOutput("\x1b]7;file://host/tmp\x07");
    expect(report).not.toHaveBeenCalled();
    expect((ctx as any).cwdLastOutputAt.size).toBe(0);

    latestFullCallbacks().onSessionOpened("session-1");

    observer.onOutput("\x1b]7;file://host/var/log\x07");
    expect(report).toHaveBeenCalledWith("session-1", "srv-1", "/var/log", "osc7", "host", expect.any(Number));
    expect((ctx as any).cwdLastOutputAt.get("session-1")).toEqual(expect.any(Number));
  });

  it("records lastOutputAt on every chunk even when the chunk carries no OSC 7 match", async () => {
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [] });
    (ctx as any).cwdTracker = { report: vi.fn() };
    (ctx as any).cwdLastOutputAt = new Map<string, number>();

    registerServerCommands(ctx);
    await registeredCommands.get("nexus.server.connect")!("srv-1");
    const observer = mockAddOutputObserver.mock.calls[0][0] as { onOutput(text: string): void };
    latestFullCallbacks().onSessionOpened("session-1");

    observer.onOutput("plain prompt output, no escape sequence\r\n");

    expect((ctx as any).cwdLastOutputAt.get("session-1")).toEqual(expect.any(Number));
  });

  it("disposes the observer's parser on session teardown so a stranded partial sequence cannot leak into later output", async () => {
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [] });
    const report = vi.fn();
    (ctx as any).cwdTracker = { report };
    (ctx as any).cwdLastOutputAt = new Map<string, number>();

    registerServerCommands(ctx);
    await registeredCommands.get("nexus.server.connect")!("srv-1");
    const observer = mockAddOutputObserver.mock.calls[0][0] as {
      onOutput(text: string): void;
      dispose(): void;
    };
    latestFullCallbacks().onSessionOpened("session-1");

    // Feed a partial OSC 7 sequence (held in the parser's internal carry).
    observer.onOutput("\x1b]7;file://host/tm");
    observer.dispose();
    report.mockClear();

    // Completing the old partial after dispose must NOT produce a match —
    // dispose() resets the parser's carry buffer.
    observer.onOutput("p\x07");
    expect(report).not.toHaveBeenCalled();
  });

  it("re-asserts focus on session open when the session's terminal is the active VS Code terminal (§5.4 hole a)", async () => {
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [] });

    registerServerCommands(ctx);
    await registeredCommands.get("nexus.server.connect")!("srv-1");
    const createdTerminal = vi.mocked(vscode.window.createTerminal).mock.results[0].value;
    (vscode.window as any).activeTerminal = createdTerminal;

    latestFullCallbacks().onSessionOpened("session-1");

    expect(ctx.core.setFocusedSession).toHaveBeenCalledWith("session-1");
  });

  it("does not force focus on session open when another terminal is the active VS Code terminal", async () => {
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [] });
    (vscode.window as any).activeTerminal = { show: vi.fn(), dispose: vi.fn() }; // some other terminal

    registerServerCommands(ctx);
    await registeredCommands.get("nexus.server.connect")!("srv-1");
    latestFullCallbacks().onSessionOpened("session-1");

    expect(ctx.core.setFocusedSession).not.toHaveBeenCalled();
  });

  it("re-asserts focus again on reconnect (same sessionId, terminal re-opens while its tab is active)", async () => {
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [] });

    registerServerCommands(ctx);
    await registeredCommands.get("nexus.server.connect")!("srv-1");
    const createdTerminal = vi.mocked(vscode.window.createTerminal).mock.results[0].value;
    (vscode.window as any).activeTerminal = createdTerminal;

    const callbacks = latestFullCallbacks();
    callbacks.onSessionOpened("session-1"); // first connect
    callbacks.onDisconnected?.("session-1"); // connection lost
    (ctx.core.setFocusedSession as any).mockClear();
    callbacks.onSessionOpened("session-1"); // reconnect: same sessionId, terminal never lost VS Code focus

    expect(ctx.core.setFocusedSession).toHaveBeenCalledWith("session-1");
  });

  it("calls coordinator.onSessionEnded on disconnect, clearing directory-sync state for the session (§5.4 hole b)", async () => {
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [] });
    const onSessionEnded = vi.fn();
    (ctx as any).cwdSyncCoordinator = { onSessionEnded };
    (ctx as any).cwdLastOutputAt = new Map<string, number>([["session-1", 123]]);

    registerServerCommands(ctx);
    await registeredCommands.get("nexus.server.connect")!("srv-1");
    const callbacks = latestFullCallbacks();
    callbacks.onSessionOpened("session-1");

    callbacks.onDisconnected?.("session-1");

    expect(onSessionEnded).toHaveBeenCalledWith("session-1");
    expect((ctx as any).cwdLastOutputAt.has("session-1")).toBe(false);
  });

  it("also calls coordinator.onSessionEnded on a direct session close (no prior disconnect)", async () => {
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [] });
    const onSessionEnded = vi.fn();
    (ctx as any).cwdSyncCoordinator = { onSessionEnded };

    registerServerCommands(ctx);
    await registeredCommands.get("nexus.server.connect")!("srv-1");
    const callbacks = latestFullCallbacks();
    callbacks.onSessionOpened("session-1");

    callbacks.onSessionClosed("session-1");

    expect(onSessionEnded).toHaveBeenCalledWith("session-1");
  });

  it("tolerates a missing cwdTracker/cwdSyncCoordinator (e.g. web extension fallback)", async () => {
    const { ctx } = setupHarness({ profiles: [], activeTunnels: [] });
    // cwdTracker / cwdSyncCoordinator left unset (optional fields)

    registerServerCommands(ctx);
    await expect(registeredCommands.get("nexus.server.connect")!("srv-1")).resolves.toBeUndefined();
    const observer = mockAddOutputObserver.mock.calls[0][0] as { onOutput(text: string): void };
    const callbacks = latestFullCallbacks();

    expect(() => {
      callbacks.onSessionOpened("session-1");
      observer.onOutput("\x1b]7;file://host/var/log\x07");
      callbacks.onDisconnected?.("session-1");
    }).not.toThrow();
  });
});

describe("nexus.server.edit — origin preservation (P1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    mockWebviewFormPanelOpen.mockReset();
    mockWebviewFormPanelOpen.mockReturnValue({ dispose: vi.fn(), onDidDispose: vi.fn() });
  });

  async function submitEdit(
    ctx: CommandContext,
    values: Record<string, unknown>
  ): Promise<void> {
    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    expect(editCmd).toBeDefined();

    await editCmd!("srv-1");

    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };
    await options.onSubmit(values);
  }

  it("keeps the existing server's origin verbatim when editing a synced server, even though other fields change", async () => {
    const origin = { sourceId: "netbox-1", externalId: "device:42", syncedAt: 1000 };
    const { ctx, addOrUpdateServer } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ origin })]
    });

    await submitEdit(ctx, {
      name: "Renamed Server", // edited field, different from "Server 1"
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password"
    });

    expect(addOrUpdateServer).toHaveBeenCalledTimes(1);
    const saved = addOrUpdateServer.mock.calls[0][0] as ServerConfig;
    expect(saved.name).toBe("Renamed Server");
    // This is the assertion that kills the reconstruction-drops-origin bug:
    // formValuesToServer's rebuilt object has no `origin` field at all, so a
    // wrong implementation that saves it verbatim would produce `undefined`
    // here rather than the exact original origin object.
    expect(saved.origin).toEqual(origin);
  });

  it("leaves origin undefined when editing a manually-added (never synced) server", async () => {
    const { ctx, addOrUpdateServer } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer()] // no origin
    });

    await submitEdit(ctx, {
      name: "Renamed Server",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password"
    });

    const saved = addOrUpdateServer.mock.calls[0][0] as ServerConfig;
    expect(saved.origin).toBeUndefined();
  });

  it("does NOT resurrect origin from the form-open snapshot when Remove Source → Keep Servers stripped the live record's origin while the form was open (kills reattaching existing.origin instead of sourcing from the live record)", async () => {
    const origin = { sourceId: "netbox-1", externalId: "device:42", syncedAt: 1000 };
    const { ctx, addOrUpdateServer } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ origin })]
    });

    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    expect(editCmd).toBeDefined();

    // Open the edit form. `existing` is captured here, WITH origin — this
    // is the form-open snapshot a wrong implementation would reattach from.
    await editCmd!("srv-1");
    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };

    // Simulate Remove Source → Keep Servers landing on the LIVE record
    // while the form is still open: the source is gone, so the live server
    // loses its ownership marker, but the record itself survives.
    const liveWithoutOrigin: ServerConfig = { ...makeServer({ origin }), origin: undefined };
    await ctx.core.addOrUpdateServer(liveWithoutOrigin);
    addOrUpdateServer.mockClear(); // only count the edit's own write below

    // Submit the still-open edit form.
    await options.onSubmit({
      name: "Renamed Server",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password"
    });

    expect(addOrUpdateServer).toHaveBeenCalledTimes(1);
    const saved = addOrUpdateServer.mock.calls[0][0] as ServerConfig;
    expect(saved.name).toBe("Renamed Server");
    // Kill check: sourcing origin from `existing` (the form-open snapshot,
    // which still has `origin` set) instead of the live record would leave
    // this equal to `origin` — resurrecting the dead source's ownership
    // marker onto a record it no longer owns. The fix sources from the LIVE
    // record captured inside the mutation lock, which has no origin.
    expect(saved.origin).toBeUndefined();
  });
});

/**
 * REVIEW FINDING (P2) — the END-TO-END consequence of the shared ownership
 * rule, across the two layers that used to disagree about it. Each test drives
 * the real Edit form's onSubmit, reads back the record that was actually
 * persisted, and then hands THAT record to the real SilentAuthSshFactory with
 * the same profile the save saw. Both findings on this branch existed because
 * a fix was verified at one layer while another still disagreed, so neither
 * leg is asserted on its own here.
 */
describe("nexus.server.edit → connect — a profile owns only what it supplies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    mockWebviewFormPanelOpen.mockReset();
    mockWebviewFormPanelOpen.mockReturnValue({ dispose: vi.fn(), onDidDispose: vi.fn() });
  });

  async function submitEdit(ctx: CommandContext, values: Record<string, unknown>): Promise<void> {
    registerServerCommands(ctx);
    await registeredCommands.get("nexus.server.edit")!("srv-1");
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };
    await options.onSubmit(values);
  }

  /** Resolves `server` the way a real connection would, and reports the
   *  ServerConfig the SSH connector was actually handed. */
  async function resolveForConnect(server: ServerConfig, profiles: AuthProfile[]): Promise<ServerConfig> {
    const connection = {
      openShell: vi.fn(), openDirectTcp: vi.fn(), openSftp: vi.fn(), exec: vi.fn(),
      requestForwardIn: vi.fn(), cancelForwardIn: vi.fn(),
      onTcpConnection: vi.fn().mockReturnValue(() => {}), onClose: vi.fn().mockReturnValue(() => {}),
      getBanner: vi.fn().mockReturnValue(undefined), dispose: vi.fn()
    };
    const connector = { connect: vi.fn(async () => connection) };
    const vault = { get: vi.fn(async () => undefined), store: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    const prompt = { prompt: vi.fn(async () => ({ password: "typed", save: false })) };
    const factory = new SilentAuthSshFactory(
      connector as never,
      vault as never,
      prompt as never,
      undefined,
      (id: string) => profiles.find((p) => p.id === id)
    );
    await factory.connect(server);
    return connector.connect.mock.calls[0][0] as ServerConfig;
  }

  it("saves AND then connects with the username you typed under a profile whose own username is blank (kills the save reverting it, and kills the connect overwriting it with the profile's whitespace)", async () => {
    // Reachable only through an imported backup — validateAuthProfile checks
    // length, not content, while the profile editor trims and refuses blanks.
    const blank: AuthProfile = { id: "ap-blank", name: "Imported", username: "   ", authType: "password" };
    const { ctx, addOrUpdateServer } = setupHarness({
      profiles: [],
      activeTunnels: [],
      authProfiles: [blank],
      servers: [makeServer({ username: "stored-user", authType: "password", authProfileId: "ap-blank" })]
    });

    // The form leaves Username editable for this profile (it fills nothing
    // there), so this is a legitimate edit, not a mirror echo.
    await submitEdit(ctx, {
      name: "Server 1",
      host: "example.com",
      port: 22,
      username: "edited-user",
      authType: "password",
      authProfileId: "ap-blank"
    });

    const saved = addOrUpdateServer.mock.calls.at(-1)![0] as ServerConfig;
    expect(saved.username).toBe("edited-user");
    expect(saved.authProfileId).toBe("ap-blank");

    // ...and the connection uses it, rather than the profile's whitespace.
    const resolved = await resolveForConnect(saved, [blank]);
    expect(resolved.username).toBe("edited-user");
  });

  it("saves AND then connects with the key path you chose under a key profile that carries none, while the auth type the profile does supply still comes from the profile", async () => {
    const keyless: AuthProfile = { id: "ap-key", name: "Shared Key", username: "keyuser", authType: "key" };
    const { ctx, addOrUpdateServer } = setupHarness({
      profiles: [],
      activeTunnels: [],
      authProfiles: [keyless],
      // The server's own stored auth type is password — so a connect config
      // that reads "key" can only have come from the profile, and a stored
      // record that reads "key" would mean the mirror echo leaked into the
      // record.
      servers: [makeServer({ username: "stored-user", authType: "password", authProfileId: "ap-key" })]
    });

    await submitEdit(ctx, {
      name: "Server 1",
      host: "example.com",
      port: 22,
      username: "keyuser", // read-only echo of the profile's username
      authType: "key", // read-only echo of the profile's auth type
      keyPath: "/home/me/.ssh/chosen", // editable: this profile has no key path
      authProfileId: "ap-key"
    });

    const saved = addOrUpdateServer.mock.calls.at(-1)![0] as ServerConfig;
    expect(saved.keyPath).toBe("/home/me/.ssh/chosen");
    // The two keys the profile DOES supply keep the server's own stored values
    // underneath the link, so unlinking later restores what it always had.
    expect(saved.username).toBe("stored-user");
    expect(saved.authType).toBe("password");

    const resolved = await resolveForConnect(saved, [keyless]);
    expect(resolved.keyPath).toBe("/home/me/.ssh/chosen");
    expect(resolved.username).toBe("keyuser");
    expect(resolved.authType).toBe("key");
  });
});

describe("nexus.server.edit — record+secret mutation locking (FINDING 2, P2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    mockWebviewFormPanelOpen.mockReset();
    mockWebviewFormPanelOpen.mockReturnValue({ dispose: vi.fn(), onDidDispose: vi.fn() });
  });

  async function submitEdit(
    ctx: CommandContext,
    values: Record<string, unknown>
  ): Promise<void> {
    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    expect(editCmd).toBeDefined();

    await editCmd!("srv-1");

    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };
    await options.onSubmit(values);
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("queues nexus.server.edit's record+proxy-secret mutation behind an in-flight locked backup capture, so the captured server record and its proxy password are a consistent pre-edit pair (kills the unlocked torn pair: new proxy config paired with the old proxy password, or the reverse)", async () => {
    const { ctx, addOrUpdateServer, secretStore } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer()],
      initialSecrets: { [proxyPasswordSecretKey("srv-1")]: "old-proxy-pw" }
    });

    // Same call-ordering spy as test/unit/configMutationLockRace.test.ts —
    // logs when each acquirer's body actually starts/finishes RUNNING
    // (not merely when it's called) while still delegating to the real
    // AsyncMutex, so this exercises the genuine production lock, not a
    // test double.
    const events: string[] = [];
    const labels = ["capture", "edit"];
    let nextLabel = 0;
    const realRunExclusive = AsyncMutex.prototype.runExclusive;
    vi.spyOn(configMutationLock, "runExclusive").mockImplementation(function (
      this: AsyncMutex,
      fn: () => Promise<unknown>
    ) {
      const label = labels[nextLabel] ?? `call-${nextLabel}`;
      nextLabel++;
      return realRunExclusive.call(this, async () => {
        events.push(`${label}:start`);
        try {
          return await fn();
        } finally {
          events.push(`${label}:end`);
        }
      });
    } as typeof configMutationLock.runExclusive);

    // Stand-in for captureBackupStateForExport's own locked span (see
    // configCommands.ts): takes a fresh server snapshot immediately on
    // acquiring the lock, THEN reads that server's proxy-password secret —
    // gated here so the test controls exactly when the read happens.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const capturePromise = configMutationLock.runExclusive(async () => {
      const server = ctx.core.getServer("srv-1")!;
      await gate;
      const proxyPw = await ctx.secretVault!.get(proxyPasswordSecretKey("srv-1"));
      return { server, proxyPw };
    });

    await delay(10);
    expect(events).toEqual(["capture:start"]);

    // Start a full nexus.server.edit submit — new proxy config AND a
    // rotated proxy password — while the capture is still mid-flight
    // (blocked on the gate).
    const editPromise = submitEdit(ctx, {
      name: "Server 1",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password",
      proxyType: "socks5",
      proxySocks5Host: "proxy.example.com",
      proxySocks5Port: 1080,
      proxySocks5Username: "proxyuser",
      proxySocks5Password: "new-proxy-pw"
    });

    // Give the edit's UI-free onSubmit body time to reach its own
    // configMutationLock.runExclusive call — it must queue there, not run
    // its record+secret writes ahead of the still-in-flight capture.
    await delay(10);
    expect(events).toEqual(["capture:start"]);
    expect(addOrUpdateServer).not.toHaveBeenCalled();
    expect(secretStore).not.toHaveBeenCalled();

    // Release the capture's gated read — its critical section can now
    // finish and hand the lock to the queued edit.
    releaseGate();
    const captured = await capturePromise;
    await editPromise;

    expect(events).toEqual(["capture:start", "capture:end", "edit:start", "edit:end"]);

    // The captured pair is CONSISTENT: the server record captured is the
    // PRE-edit one (no proxy config yet), and the secret captured alongside
    // it is that SAME pre-edit generation's password ("old-proxy-pw") —
    // never the pre-edit record paired with the rotated password. If
    // FINDING 2's fix were reverted (addOrUpdateServer + syncProxyPasswordSecret
    // run unlocked, back-to-back, outside configMutationLock), the edit
    // would run to completion immediately after being invoked — well
    // before the capture's gate is ever released — so by the time the
    // gate opens and the capture finally reads the vault, it would read
    // back "new-proxy-pw" instead: a torn pair this assertion catches.
    expect(captured.server.proxy).toBeUndefined();
    expect(captured.proxyPw).toBe("old-proxy-pw");

    // The edit itself was never blocked forever — once the lock freed up
    // it proceeded and took effect: record and secret both reflect the
    // new generation.
    const saved = addOrUpdateServer.mock.calls[0][0] as ServerConfig;
    expect(saved.proxy).toEqual({ type: "socks5", host: "proxy.example.com", port: 1080, username: "proxyuser" });
    expect(secretStore).toHaveBeenCalledWith(proxyPasswordSecretKey("srv-1"), "new-proxy-pw");
  });

  it("restores the prior server record and the prior proxy-secret value when syncProxyPasswordSecret rejects after addOrUpdateServer already committed the new record, and surfaces the failure (kills committed-record-with-old-secret leftover)", async () => {
    const priorProxy = { type: "socks5" as const, host: "old-proxy.example.com", port: 1080, username: "proxyuser" };
    const { ctx, addOrUpdateServer, secretStore } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ proxy: priorProxy })],
      initialSecrets: { [proxyPasswordSecretKey("srv-1")]: "old-proxy-pw" }
    });

    // syncProxyPasswordSecret's store call for the NEW proxy password fails —
    // e.g. the OS keychain rejected the write. Only the first store call
    // (the failing one) is intercepted; the rollback's restoring store call
    // just after uses the harness's normal (succeeding) behavior.
    secretStore.mockRejectedValueOnce(new Error("keychain unavailable"));

    await expect(
      submitEdit(ctx, {
        name: "Server 1",
        host: "example.com",
        port: 22,
        username: "dev",
        authType: "password",
        proxyType: "socks5",
        proxySocks5Host: "new-proxy.example.com", // proxy host CHANGED
        proxySocks5Port: 1080,
        proxySocks5Username: "proxyuser",
        proxySocks5Password: "new-proxy-pw"
      })
    ).rejects.toThrow(/changes were not saved/i);

    // Kill check: a wrong implementation that only surfaces the failure
    // without restoring would leave the NEW record (new-proxy.example.com)
    // committed in core — this assertion fails against that implementation
    // because the surviving record's proxy host would read "new-proxy.example.com"
    // instead of the prior "old-proxy.example.com".
    expect(addOrUpdateServer).toHaveBeenCalledTimes(2);
    const finalRecord = ctx.core.getServer("srv-1");
    expect(finalRecord?.proxy).toEqual(priorProxy);

    // Kill check: a wrong implementation that restores the record but never
    // restores the vault would leave the rotated "new-proxy-pw" behind (the
    // failed store call notwithstanding, a partial-write vault could still
    // have latched it) or leave the key deleted — either way this would not
    // read back the prior "old-proxy-pw".
    const finalSecret = await ctx.secretVault!.get(proxyPasswordSecretKey("srv-1"));
    expect(finalSecret).toBe("old-proxy-pw");
  });

  it("(FINDING 1, P2) restores the LIVE record committed between form-open and lock acquisition, not the stale form-open snapshot, when the secret write then fails", async () => {
    const { ctx, secretStore } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer()],
      initialSecrets: {}
    });

    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    expect(editCmd).toBeDefined();

    // Open the edit form — this synchronously captures `existing` as
    // today's "Server 1" / "example.com" record.
    await editCmd!("srv-1");
    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };

    // Simulate a DIFFERENT edit committing while this form is still open —
    // e.g. another submission, or an inventory sync — landing between
    // form-open and this submission reaching the lock.
    const intervening = makeServer({ name: "Intervening Name", host: "intervening.example.com" });
    await ctx.core.addOrUpdateServer(intervening);

    // Now the proxy-secret write for THIS (stale) submission fails.
    secretStore.mockRejectedValueOnce(new Error("keychain unavailable"));

    await expect(
      options.onSubmit({
        name: "Server 1",
        host: "example.com",
        port: 22,
        username: "dev",
        authType: "password",
        proxyType: "socks5",
        proxySocks5Host: "new-proxy.example.com",
        proxySocks5Port: 1080,
        proxySocks5Username: "proxyuser",
        proxySocks5Password: "new-proxy-pw"
      })
    ).rejects.toThrow(/changes were not saved/i);

    // Kill check: the original implementation captured `priorRecord =
    // existing` (the form-open snapshot) instead of reading
    // ctx.core.getServer(existing.id) inside the lock. Against that
    // implementation, the rollback would restore "Server 1" /
    // "example.com" here, silently erasing the intervening edit. This
    // assertion only passes when the rollback restored the INTERVENING
    // live record instead.
    const finalRecord = ctx.core.getServer("srv-1");
    expect(finalRecord?.name).toBe("Intervening Name");
    expect(finalRecord?.host).toBe("intervening.example.com");
  });

  it("(FINDING 1, P2) removes the record it just created rather than resurrecting the form-open snapshot, when the live record was deleted between form-open and lock acquisition", async () => {
    const { ctx, removeServer, secretStore } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer()],
      initialSecrets: {}
    });

    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    expect(editCmd).toBeDefined();

    await editCmd!("srv-1");
    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };

    // `existing` has already been captured (as "Server 1") synchronously
    // inside editCmd, above. Simulate the record being deleted by
    // something else before this submission reaches the lock: the very
    // next ctx.core.getServer call — the live-record read taken inside
    // the lock, right before this generation's write — returns undefined,
    // as if a concurrent nexus.server.remove had already run.
    vi.mocked(ctx.core.getServer).mockReturnValueOnce(undefined);

    secretStore.mockRejectedValueOnce(new Error("keychain unavailable"));

    await expect(
      options.onSubmit({
        name: "Server 1",
        host: "example.com",
        port: 22,
        username: "dev",
        authType: "password",
        proxyType: "socks5",
        proxySocks5Host: "new-proxy.example.com",
        proxySocks5Port: 1080,
        proxySocks5Username: "proxyuser",
        proxySocks5Password: "new-proxy-pw"
      })
    ).rejects.toThrow(/changes were not saved/i);

    // Kill check: the original implementation would unconditionally call
    // addOrUpdateServer(priorRecord) where priorRecord is the form-open
    // `existing` snapshot — resurrecting "Server 1" even though it was
    // deleted mid-flight, and never calling removeServer at all. This
    // assertion fails against that implementation.
    expect(removeServer).toHaveBeenCalledWith("srv-1");
    const finalRecord = ctx.core.getServer("srv-1");
    expect(finalRecord).toBeUndefined();
  });

  it("(FINDING 2, P2) merges a concurrent rename onto the pre-submission record instead of leaving the whole rejected submission live, when that rename commits while the proxy-secret write is still pending (kills skip-whole-record: the failed edit's new proxy endpoint must NOT survive)", async () => {
    const { ctx, secretStore } = setupHarness({
      profiles: [],
      activeTunnels: [],
      // No proxy configured pre-edit — this is the value the merge must
      // fall back to for the (untouched-by-the-concurrent-rename) proxy
      // field once this submission's own write is rejected.
      servers: [makeServer({ host: "example.com" })],
      initialSecrets: {}
    });

    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    expect(editCmd).toBeDefined();

    await editCmd!("srv-1");
    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };

    // Gate the secret write so a concurrent, unlocked command (simulating
    // nexus.server.rename, which does not take configMutationLock) can
    // commit its own addOrUpdateServer call for this SAME server id
    // between this submission's addOrUpdateServer(updated) and the
    // rejection reaching the rollback's catch block.
    let rejectSecretWrite!: (err: unknown) => void;
    secretStore.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectSecretWrite = reject; })
    );

    const submitPromise = options.onSubmit({
      name: "Server 1",
      // A new host, distinct from the pre-edit "example.com", so a
      // successful merge (falling back to liveRecord for fields the
      // concurrent rename never touched) is distinguishable from a
      // skip-whole-record implementation (which would leave this
      // rejected submission's new host live).
      host: "rejected-edit-host.example.com",
      port: 22,
      username: "dev",
      authType: "password",
      proxyType: "socks5",
      proxySocks5Host: "new-proxy.example.com",
      proxySocks5Port: 1080,
      proxySocks5Username: "proxyuser",
      proxySocks5Password: "new-proxy-pw"
    });

    // Let onSubmit's own addOrUpdateServer(updated) land and its
    // syncProxyPasswordSecret call reach the gated secret write.
    await delay(10);

    // Simulate nexus.server.rename committing while the secret write is
    // still pending — an unlocked addOrUpdateServer call for the same id
    // that only touches `name`, leaving this (about-to-be-rejected)
    // submission's host/proxy fields as they were.
    const renamed = { ...ctx.core.getServer("srv-1")!, name: "Renamed By Concurrent Command" };
    await ctx.core.addOrUpdateServer(renamed);

    rejectSecretWrite(new Error("keychain unavailable"));

    await expect(submitPromise).rejects.toThrow(/changes were not saved/i);

    // Kill check 1 (skip-whole-record): a pre-FINDING-2 implementation
    // detects the divergence (name changed) and skips the record entirely,
    // leaving THIS rejected submission's host and proxy live even though
    // its proxy secret write just failed and was rolled back — a
    // mismatched pair (new proxy endpoint, old/rolled-back secret). The
    // merge must instead fall both fields back to the pre-submission
    // liveRecord, since the concurrent rename never touched them.
    const finalRecord = ctx.core.getServer("srv-1");
    expect(finalRecord?.host).toBe("example.com");
    expect(finalRecord?.proxy).toBeUndefined();

    // Kill check 2 (wholesale restore): a pre-FINDING-1/2 implementation
    // that unconditionally restores `liveRecord` on any secret-write
    // failure would erase the concurrent rename outright. The merge must
    // keep the concurrently-changed field (name) live.
    expect(finalRecord?.name).toBe("Renamed By Concurrent Command");
  });

  it("(FINDING 1, P2) captures the written snapshot BEFORE addOrUpdateServer's own persist is issued, so an in-place mutation landing DURING that pending save is not silently baked into the comparison snapshot (kills the post-await clone: a rename committed mid-persist would otherwise be wiped by a wrongful full restore)", async () => {
    const { ctx, addOrUpdateServer, secretStore } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ host: "example.com" })],
      initialSecrets: {}
    });

    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    expect(editCmd).toBeDefined();

    await editCmd!("srv-1");
    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };

    // Gate addOrUpdateServer's OWN internal persist — mirrors the real
    // NexusCore.addOrUpdateServer, which installs `updated` into the live
    // servers map SYNCHRONOUSLY (this.servers.set(next.id, next)) and only
    // THEN awaits repository.saveServers(...). While that save is still
    // pending, a concurrent in-place mutator (e.g. _renameFolderPath
    // rewriting `.group`, or here a rename touching `.name`) can land on
    // the very same object reference this submission just installed —
    // before serverCommands.ts ever regains control from
    // `await ctx.core.addOrUpdateServer(updated)`.
    const realInstall = addOrUpdateServer.getMockImplementation()!;
    let resolveAdd!: () => void;
    let installedRecord: ServerConfig | undefined;
    addOrUpdateServer.mockImplementationOnce((server: ServerConfig) => {
      // Run the harness's real (synchronous) install so ctx.core.getServer
      // genuinely reflects `server` as live from this point on — mirrors
      // `this.servers.set(next.id, next)` running synchronously before the
      // real addOrUpdateServer awaits repository.saveServers(...). Only the
      // PROMISE this mock returns to serverCommands.ts is deferred, standing
      // in for that still-pending repository write.
      void realInstall(server);
      installedRecord = server;
      return new Promise<void>((resolve) => {
        resolveAdd = resolve;
      });
    });

    const submitPromise = options.onSubmit({
      name: "Server 1",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password",
      proxyType: "socks5",
      proxySocks5Host: "new-proxy.example.com",
      proxySocks5Port: 1080,
      proxySocks5Username: "proxyuser",
      proxySocks5Password: "new-proxy-pw"
    });

    // Let onSubmit reach `await ctx.core.addOrUpdateServer(updated)` — the
    // gated mock above installs the record and then blocks, standing in
    // for the still-pending repository.saveServers(...) call.
    await delay(10);
    expect(installedRecord).toBeDefined();

    // Simulate a concurrent in-place rename landing on the very object this
    // submission just installed, WHILE addOrUpdateServer's own persist is
    // still pending — i.e. before serverCommands.ts has captured anything
    // at all about this generation.
    installedRecord!.name = "Renamed Mid-Persist";

    // Arm the proxy-secret write to fail once addOrUpdateServer resumes,
    // then let addOrUpdateServer's pending persist resolve.
    secretStore.mockRejectedValueOnce(new Error("keychain unavailable"));
    resolveAdd();

    await expect(submitPromise).rejects.toThrow(/changes were not saved/i);

    // Kill check: a post-await snapshot (`cloneServerConfig(updated)` taken
    // AFTER `await ctx.core.addOrUpdateServer(updated)` resolves) would
    // clone the object AFTER the in-place mutation above already landed on
    // it — its `.name` already reads "Renamed Mid-Persist" at clone time.
    // That clone then trivially matches the (identically mutated) live
    // record, so the rollback wrongly concludes "nothing concurrent
    // touched it since this submission's write" and fully restores the
    // PRE-edit liveRecord — silently erasing the rename. Capturing the
    // snapshot BEFORE addOrUpdateServer is ever called means it reflects
    // only what this submission itself set out to write, so the mutation
    // is correctly detected as a divergence and the rename survives
    // (merged in per FINDING 2, keeping this rejected submission's other
    // fields off the live record).
    const finalRecord = ctx.core.getServer("srv-1");
    expect(finalRecord?.name).toBe("Renamed Mid-Persist");
    // And FINDING 2's merge correctly discarded this now-rejected
    // submission's proxy write for the field the mutation never touched.
    expect(finalRecord?.proxy).toBeUndefined();
  });

  it("(P2, edit-rollback reference-sharing review) leaves a concurrent IN-PLACE mutation of the live record intact when the submission enabled openFileExplorerOnFirstConnect — comparing against a live shared reference would trivially 'match' any mutation applied to it (kills the shared-reference comparison: reverted to `serverConfigsEqual(currentRecord, updated)`, this test fails)", async () => {
    const { ctx, secretStore } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ group: "orig-group" })],
      initialSecrets: {}
    });

    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    expect(editCmd).toBeDefined();

    await editCmd!("srv-1");
    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };

    // Gate the proxy-secret write so a concurrent in-place mutation can
    // land on the live record while it's still pending.
    let rejectSecretWrite!: (err: unknown) => void;
    secretStore.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectSecretWrite = reject; })
    );

    const submitPromise = options.onSubmit({
      name: "Server 1",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password",
      // Enabling this flag is what makes NexusCore.addOrUpdateServer store
      // the submitted `updated` object BY REFERENCE (its `next = server`
      // branch, see src/core/nexusCore.ts) — the harness's addOrUpdateServer
      // mock mirrors that by pushing the exact `server` argument into the
      // snapshot array. Required to reproduce the shared-reference hazard.
      openFileExplorerOnFirstConnect: true,
      proxyType: "socks5",
      proxySocks5Host: "new-proxy.example.com",
      proxySocks5Port: 1080,
      proxySocks5Username: "proxyuser",
      proxySocks5Password: "new-proxy-pw"
    });

    // Let onSubmit's own addOrUpdateServer(updated) land — `updated` is now
    // the exact object sitting in the (mock) servers map — and let
    // syncProxyPasswordSecret reach the gated write.
    await delay(10);

    // Simulate a concurrent in-place mutation of the LIVE record — exactly
    // what NexusCore._renameFolderPath does in production: it rewrites
    // `.group` on whatever object is already sitting in the servers map,
    // without replacing the object reference (see
    // src/core/nexusCore.ts:_renameFolderPath). Because addOrUpdateServer
    // stored `updated` itself (not a clone) when the flag is enabled, this
    // mutates the SAME object the onSubmit closure still holds as `updated`.
    const live = ctx.core.getServer("srv-1")!;
    live.group = "renamed-group";

    rejectSecretWrite(new Error("keychain unavailable"));

    await expect(submitPromise).rejects.toThrow(/changes were not saved/i);

    // Kill check: against a reverted implementation that compares
    // `serverConfigsEqual(currentRecord, updated)` — instead of a detached
    // snapshot captured right after the persist — `currentRecord` and
    // `updated` are literally the SAME object here, so the in-place
    // mutation above changed both comparands identically and the equality
    // check trivially holds no matter what changed. The rollback would then
    // wrongly conclude "still owned by this submission" and restore the
    // PRE-edit liveRecord (group: "orig-group"), silently erasing the
    // concurrent rename. This assertion only passes when the rollback
    // compared against a DETACHED snapshot instead and correctly left the
    // concurrently-renamed record alone.
    const finalRecord = ctx.core.getServer("srv-1");
    expect(finalRecord?.group).toBe("renamed-group");
  });

  it("(FINDING 1, P2) still restores the prior record when nothing concurrent touched it (no-concurrent-change case stays green)", async () => {
    const { ctx, secretStore } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer()],
      initialSecrets: {}
    });

    secretStore.mockRejectedValueOnce(new Error("keychain unavailable"));

    await expect(
      submitEdit(ctx, {
        name: "Server 1",
        host: "example.com",
        port: 22,
        username: "dev",
        authType: "password",
        proxyType: "socks5",
        proxySocks5Host: "new-proxy.example.com",
        proxySocks5Port: 1080,
        proxySocks5Username: "proxyuser",
        proxySocks5Password: "new-proxy-pw"
      })
    ).rejects.toThrow(/changes were not saved/i);

    const finalRecord = ctx.core.getServer("srv-1");
    expect(finalRecord?.host).toBe("example.com");
    expect(finalRecord?.proxy).toBeUndefined();
  });

  it("(FINDINGS 2+3, P2) restores the displaced owner's auto-open flag when enabling it elsewhere is rolled back after a failed secret write (kills owner-left-cleared)", async () => {
    const serverA = makeServer({ id: "srv-1", name: "Server A" });
    const serverB = makeServer({ id: "srv-2", name: "Server B", openFileExplorerOnFirstConnect: true });
    const { ctx, secretStore } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [serverA, serverB],
      initialSecrets: {}
    });

    secretStore.mockRejectedValueOnce(new Error("keychain unavailable"));

    await expect(
      submitEdit(ctx, {
        name: "Server A",
        host: "example.com",
        port: 22,
        username: "dev",
        authType: "password",
        openFileExplorerOnFirstConnect: true,
        proxyType: "socks5",
        proxySocks5Host: "new-proxy.example.com",
        proxySocks5Port: 1080,
        proxySocks5Username: "proxyuser",
        proxySocks5Password: "new-proxy-pw"
      })
    ).rejects.toThrow(/changes were not saved/i);

    // Kill check: without capturing/restoring the displaced owner, B stays
    // cleared here — addOrUpdateServer(updated for A) clears B's flag as a
    // side effect of enforcing single ownership, and the rollback (before
    // this fix) only ever restored A's own prior record, never touching B.
    // This assertion fails against that implementation because B's flag
    // would read undefined instead of true.
    const finalA = ctx.core.getServer("srv-1");
    const finalB = ctx.core.getServer("srv-2");
    expect(finalB?.openFileExplorerOnFirstConnect).toBe(true);
    // A is back to its own prior (pre-submission) state: it never owned
    // the flag before this failed submission tried to claim it.
    expect(finalA?.openFileExplorerOnFirstConnect).toBeUndefined();
  });

  it("(FINDINGS 2+3, P2 — sanity) a successful edit that enables the flag leaves the previous owner cleared, as intended (unchanged existing behavior)", async () => {
    const serverA = makeServer({ id: "srv-1", name: "Server A" });
    const serverB = makeServer({ id: "srv-2", name: "Server B", openFileExplorerOnFirstConnect: true });
    const { ctx } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [serverA, serverB],
      initialSecrets: {}
    });

    await submitEdit(ctx, {
      name: "Server A",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password",
      openFileExplorerOnFirstConnect: true
    });

    const finalA = ctx.core.getServer("srv-1");
    const finalB = ctx.core.getServer("srv-2");
    expect(finalA?.openFileExplorerOnFirstConnect).toBe(true);
    expect(finalB?.openFileExplorerOnFirstConnect).toBeUndefined();
  });

  it("(FINDING 1, P2) a rename committed while the pre-write proxy-secret vault.get is still pending survives as the rollback's merge baseline, instead of the rollback restoring the stale pre-rename record (kills baseline-before-vault-read)", async () => {
    const { ctx, secretStore } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ host: "example.com" })],
      initialSecrets: {}
    });

    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    expect(editCmd).toBeDefined();

    await editCmd!("srv-1");
    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };

    // Gate the pre-write proxy-secret vault.get (the priorSecretValue
    // capture) so a concurrent rename can commit while it's still pending —
    // exactly the window FINDING 1 closes by moving liveRecord's capture to
    // AFTER this await instead of before it.
    let resolveGet!: (value: string | undefined) => void;
    ctx.secretVault!.get = vi.fn(
      () => new Promise<string | undefined>((resolve) => { resolveGet = resolve; })
    );

    const submitPromise = options.onSubmit({
      name: "Server 1",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password",
      proxyType: "socks5",
      proxySocks5Host: "new-proxy.example.com",
      proxySocks5Port: 1080,
      proxySocks5Username: "proxyuser",
      proxySocks5Password: "new-proxy-pw"
    });

    // Let onSubmit's body reach the gated vault.get and block there.
    await delay(10);
    expect(ctx.secretVault!.get).toHaveBeenCalled();

    // Simulate nexus.server.rename committing while THIS vault.get is still
    // pending — it doesn't take configMutationLock (see the FINDING 1
    // comment at the call site), so it can land here.
    const renamed = { ...ctx.core.getServer("srv-1")!, name: "Renamed Mid-Vault-Read" };
    await ctx.core.addOrUpdateServer(renamed);

    // Now let the gated vault.get resolve and arm the secret write to fail,
    // forcing the rollback to run.
    secretStore.mockRejectedValueOnce(new Error("keychain unavailable"));
    resolveGet(undefined);

    await expect(submitPromise).rejects.toThrow(/changes were not saved/i);

    // Kill check: against the pre-fix ordering (liveRecord captured BEFORE
    // the vault.get await), liveRecord would have snapshotted "Server 1" —
    // the name still on screen before the rename landed — and the rollback
    // would restore that stale name here instead. This assertion only
    // passes when liveRecord was captured AFTER the vault-read settled, so
    // it already reflects the concurrent rename.
    const finalRecord = ctx.core.getServer("srv-1");
    expect(finalRecord?.name).toBe("Renamed Mid-Vault-Read");
  });

  it("(FINDING 2, P2) renaming the displaced owner while the proxy-secret write is still pending still restores its auto-open flag, merged onto the concurrent rename rather than skipped outright (kills all-or-nothing displaced-owner restore)", async () => {
    const serverA = makeServer({ id: "srv-1", name: "Server A" });
    const serverB = makeServer({ id: "srv-2", name: "Server B", host: "b.example.com", openFileExplorerOnFirstConnect: true });
    const { ctx, secretStore } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [serverA, serverB],
      initialSecrets: {}
    });

    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    expect(editCmd).toBeDefined();

    await editCmd!("srv-1");
    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };

    // Gate the proxy-secret write so a concurrent rename of the displaced
    // owner (B) can commit while it's still pending.
    let rejectSecretWrite!: (err: unknown) => void;
    secretStore.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectSecretWrite = reject; })
    );

    const submitPromise = options.onSubmit({
      name: "Server A",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password",
      openFileExplorerOnFirstConnect: true,
      proxyType: "socks5",
      proxySocks5Host: "new-proxy.example.com",
      proxySocks5Port: 1080,
      proxySocks5Username: "proxyuser",
      proxySocks5Password: "new-proxy-pw"
    });

    // Let addOrUpdateServer(A) land — displacing B's flag — and let
    // syncProxyPasswordSecret reach the gated write.
    await delay(10);

    // Simulate nexus.server.rename committing against B (the displaced
    // owner) while the secret write is still pending — it doesn't take
    // configMutationLock.
    const renamedB = { ...ctx.core.getServer("srv-2")!, name: "Renamed B" };
    await ctx.core.addOrUpdateServer(renamedB);

    rejectSecretWrite(new Error("keychain unavailable"));

    await expect(submitPromise).rejects.toThrow(/changes were not saved/i);

    // Kill check: a whole-record-equality (all-or-nothing) implementation
    // detects the name divergence and skips restoring B's flag entirely —
    // B's flag would read undefined instead of true. The fix restores ONLY
    // the flag onto B's CURRENT (renamed) record instead.
    const finalB = ctx.core.getServer("srv-2");
    expect(finalB?.name).toBe("Renamed B");
    expect(finalB?.openFileExplorerOnFirstConnect).toBe(true);
  });

  it("(FINDING 1, P2) the displaced owner's EXACT-MATCH (unchanged) restore path also skips when another server concurrently claimed the flag while the secret write was still pending (kills exact-match-path blind restore)", async () => {
    const serverA = makeServer({ id: "srv-1", name: "Server A" });
    const serverB = makeServer({ id: "srv-2", name: "Server B", openFileExplorerOnFirstConnect: true });
    const serverC = makeServer({ id: "srv-3", name: "Server C", host: "c.example.com" });
    const { ctx, secretStore } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [serverA, serverB, serverC],
      initialSecrets: {}
    });

    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    expect(editCmd).toBeDefined();

    await editCmd!("srv-1");
    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };

    // Gate the proxy-secret write so a concurrent command can enable the
    // flag on a THIRD server (C) while it's still pending. B (the displaced
    // owner) itself is never touched — its live record stays byte-for-byte
    // what addOrUpdateServer(A) left it, so the rollback's equality check
    // takes the EXACT-MATCH branch, not the divergent/merge branch.
    let rejectSecretWrite!: (err: unknown) => void;
    secretStore.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectSecretWrite = reject; })
    );

    const submitPromise = options.onSubmit({
      name: "Server A",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password",
      openFileExplorerOnFirstConnect: true,
      proxyType: "socks5",
      proxySocks5Host: "new-proxy.example.com",
      proxySocks5Port: 1080,
      proxySocks5Username: "proxyuser",
      proxySocks5Password: "new-proxy-pw"
    });

    // Let addOrUpdateServer(A) land — displacing B's flag — and let
    // syncProxyPasswordSecret reach the gated write.
    await delay(10);

    // Simulate a concurrent command (e.g. another edit) enabling the flag
    // on C while this submission's secret write is still pending — it
    // doesn't take configMutationLock either. Single-owner enforcement in
    // addOrUpdateServer only clears whoever CURRENTLY holds the flag (no
    // one, at this point — B was already cleared), so this cleanly hands
    // the flag to C without touching B.
    await ctx.core.addOrUpdateServer({ ...ctx.core.getServer("srv-3")!, openFileExplorerOnFirstConnect: true });

    rejectSecretWrite(new Error("keychain unavailable"));

    await expect(submitPromise).rejects.toThrow(/changes were not saved/i);

    // Kill check: the pre-fix exact-match branch restores B's flag
    // UNCONDITIONALLY (its currentFlagOwner check only ever guarded the
    // divergent/else branch) — that call would itself clear C's flag via
    // addOrUpdateServer's single-owner enforcement, leaving C cleared and B
    // wrongly restored. The fix hoists the currentFlagOwner check so it
    // guards the exact-match branch too: C, the CURRENT flag owner, keeps
    // it, and B's restore is skipped entirely.
    const finalB = ctx.core.getServer("srv-2");
    const finalC = ctx.core.getServer("srv-3");
    expect(finalC?.openFileExplorerOnFirstConnect).toBe(true);
    expect(finalB?.openFileExplorerOnFirstConnect).toBeUndefined();
  });

  it("(FINDING 3, P2) a server removed concurrently while the proxy-secret restore is pending stays removed, and the vault ends up with no proxy-secret key for its id, instead of an unconditional restore recreating an orphaned secret (kills unconditional restore)", async () => {
    const priorProxy = { type: "socks5" as const, host: "old-proxy.example.com", port: 1080, username: "proxyuser" };
    const { ctx, secretStore } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ proxy: priorProxy })],
      initialSecrets: { [proxyPasswordSecretKey("srv-1")]: "old-proxy-pw" }
    });

    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    expect(editCmd).toBeDefined();

    await editCmd!("srv-1");
    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };

    // Gate the proxy-secret write so a concurrent nexus.server.remove can
    // land against this same server id while it's still pending.
    let rejectSecretWrite!: (err: unknown) => void;
    secretStore.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectSecretWrite = reject; })
    );

    const submitPromise = options.onSubmit({
      name: "Server 1",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password",
      proxyType: "socks5",
      proxySocks5Host: "new-proxy.example.com",
      proxySocks5Port: 1080,
      proxySocks5Username: "proxyuser",
      proxySocks5Password: "new-proxy-pw"
    });

    // Let addOrUpdateServer(updated) land and syncProxyPasswordSecret reach
    // the gated write.
    await delay(10);

    // Simulate nexus.server.remove committing against this SAME server id
    // while the secret write is still pending — it doesn't take
    // configMutationLock either.
    await ctx.core.removeServer("srv-1");

    rejectSecretWrite(new Error("keychain unavailable"));

    await expect(submitPromise).rejects.toThrow(/changes were not saved/i);

    // The record-rollback path correctly leaves the concurrently-deleted
    // server deleted (existing, pre-FINDING-3 behavior).
    expect(ctx.core.getServer("srv-1")).toBeUndefined();

    // Kill check: an unconditional secret restore would still `store` the
    // prior "old-proxy-pw" here, recreating an orphaned vault key for an id
    // that no longer has a record (nexus.server.remove already deleted this
    // key). This assertion fails against that implementation because the
    // vault would read back "old-proxy-pw" instead of undefined.
    const finalSecret = await ctx.secretVault!.get(proxyPasswordSecretKey("srv-1"));
    expect(finalSecret).toBeUndefined();
  });

  it("(FINDING 2, P2) nexus.server.remove's mutation phase queues behind an in-flight nexus.server.edit rollback holding configMutationLock, so remove's teardown/vault-deletes/removeServer are observed strictly after the rollback completes (kills unserialized remove-vs-edit-rollback interleaving)", async () => {
    const { ctx, secretStore, secretDelete, removeServer } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer()],
      initialSecrets: {}
    });

    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    const removeCmd = registeredCommands.get("nexus.server.remove");
    expect(editCmd).toBeDefined();
    expect(removeCmd).toBeDefined();

    await editCmd!("srv-1");
    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };

    // Same call-ordering spy as the other locking tests in this describe
    // block — logs when each acquirer's body actually starts/finishes
    // RUNNING against the REAL shared mutex.
    const events: string[] = [];
    const labels = ["edit", "remove"];
    let nextLabel = 0;
    const realRunExclusive = AsyncMutex.prototype.runExclusive;
    vi.spyOn(configMutationLock, "runExclusive").mockImplementation(function (
      this: AsyncMutex,
      fn: () => Promise<unknown>
    ) {
      const label = labels[nextLabel] ?? `call-${nextLabel}`;
      nextLabel++;
      return realRunExclusive.call(this, async () => {
        events.push(`${label}:start`);
        try {
          return await fn();
        } finally {
          events.push(`${label}:end`);
        }
      });
    } as typeof configMutationLock.runExclusive);

    // Gate the proxy-secret write so the edit's locked span (record write +
    // secret sync attempt + rollback, all one runExclusive call) stays open
    // long enough to start a concurrent remove while it's still mid-flight.
    let rejectSecretWrite!: (err: unknown) => void;
    secretStore.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectSecretWrite = reject; })
    );

    const editPromise = options.onSubmit({
      name: "Server 1",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password",
      proxyType: "socks5",
      proxySocks5Host: "new-proxy.example.com",
      proxySocks5Port: 1080,
      proxySocks5Username: "proxyuser",
      proxySocks5Password: "new-proxy-pw"
    });

    await delay(10);
    expect(events).toEqual(["edit:start"]);

    // Invoke nexus.server.remove now — its own arg-resolution and
    // confirmation modal (stubbed to resolve "Remove" by setupHarness) both
    // resolve OUTSIDE the locked span, but its mutation phase must queue on
    // the SAME configMutationLock the edit rollback is still holding.
    //
    // Pass a ServerTreeItem carrying the PRE-edit record (what the user's
    // context-menu click actually captured, matching toServerFromArg's
    // ServerTreeItem branch which uses arg.server verbatim instead of a
    // live core.getServer lookup) rather than the bare id string. A bare id
    // string would re-resolve via core.getServer AT THIS CALL, which by now
    // already reflects the edit's in-flight (soon to be rolled back) proxy
    // write — an artifact of this test's own orchestration, not something a
    // real click could observe, and exactly the kind of divergence the
    // in-lock structural revalidation (this file's presence-only-revalidation
    // fix tests) is designed to catch. Anchoring on the tree item's
    // pre-edit snapshot keeps this test's actual subject — lock ordering —
    // isolated from that unrelated guard.
    const removePromise = removeCmd!(new ServerTreeItem(makeServer(), false));

    await delay(10);
    expect(events).toEqual(["edit:start"]);
    expect(removeServer).not.toHaveBeenCalled();
    expect(secretDelete).not.toHaveBeenCalled();

    // Release the edit's gated write as a rejection — its rollback runs
    // (still inside the SAME "edit" runExclusive call) and the whole edit
    // call then throws.
    rejectSecretWrite(new Error("keychain unavailable"));

    await expect(editPromise).rejects.toThrow(/changes were not saved/i);
    await removePromise;

    // Kill check: a lock-free (or independently-locked but unserialized)
    // remove would let "remove:start" appear before "edit:end" — e.g.
    // interleaving its own vault.delete calls with the still-in-flight
    // rollback's vault.store, which is exactly the torn-write race this
    // fix closes (remove's key deletion landing before the rollback's
    // store, then the store landing after, leaving an orphaned key). This
    // assertion only passes when remove's mutation phase waited for the
    // rollback's ENTIRE locked span to finish first.
    expect(events).toEqual(["edit:start", "edit:end", "remove:start", "remove:end"]);
    expect(removeServer).toHaveBeenCalledWith("srv-1");
    expect(secretDelete).toHaveBeenCalledWith(passwordSecretKey("srv-1"));
    expect(secretDelete).toHaveBeenCalledWith(passphraseSecretKey("srv-1"));
    expect(secretDelete).toHaveBeenCalledWith(proxyPasswordSecretKey("srv-1"));
  });

  it("(FINDING 2, P2) the edit rollback's post-store presence re-check deletes the just-restored proxy-secret key when the record vanishes between the store landing and the re-check (kills a missing belt-and-braces post-store check)", async () => {
    const priorProxy = { type: "socks5" as const, host: "old-proxy.example.com", port: 1080, username: "proxyuser" };
    const { ctx, secretStore, secretDelete } = setupHarness({
      profiles: [],
      activeTunnels: [],
      servers: [makeServer({ proxy: priorProxy })],
      initialSecrets: { [proxyPasswordSecretKey("srv-1")]: "old-proxy-pw" }
    });

    registerServerCommands(ctx);
    const editCmd = registeredCommands.get("nexus.server.edit");
    expect(editCmd).toBeDefined();

    await editCmd!("srv-1");
    expect(mockWebviewFormPanelOpen).toHaveBeenCalled();
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1)!;
    const options = call[2] as { onSubmit: (v: Record<string, unknown>) => Promise<void> };

    // Capture the harness's persistent default `store` implementation
    // (sets the value into the backing secrets map) BEFORE queuing any
    // once-implementations below — getMockImplementation() returns the
    // FRONT of the once-queue when one is pending, not the persistent
    // default, so this must run first or it would capture the rejection
    // implementation instead.
    const defaultStoreImpl = secretStore.getMockImplementation()!;
    // First store call: the submission's OWN proxy-secret write, which must
    // fail to drive the rollback.
    secretStore.mockRejectedValueOnce(new Error("keychain unavailable"));
    // Second store call: the rollback's restore of the prior proxy
    // password. Let it actually land (mirrors production), THEN simulate a
    // future lock-free deleter slipping the record's removal in during
    // exactly this same write window — belt-and-braces is the only thing
    // standing between this and an orphaned vault key, since
    // configMutationLock only serializes callers that actually take it.
    secretStore.mockImplementationOnce(async (key: string, value: string) => {
      await defaultStoreImpl(key, value);
      await ctx.core.removeServer("srv-1");
    });

    await expect(
      options.onSubmit({
        name: "Server 1",
        host: "example.com",
        port: 22,
        username: "dev",
        authType: "password",
        proxyType: "socks5",
        proxySocks5Host: "new-proxy.example.com",
        proxySocks5Port: 1080,
        proxySocks5Username: "proxyuser",
        proxySocks5Password: "new-proxy-pw"
      })
    ).rejects.toThrow(/changes were not saved/i);

    // The record-rollback logic ran first and (correctly, per its own
    // pre-existing behavior) restored the record — recordStillPresentAfterRollback
    // was true and the store branch ran — but the simulated concurrent
    // deleter then removed it DURING that store call.
    expect(ctx.core.getServer("srv-1")).toBeUndefined();

    // Kill check: without the post-store presence re-check, the rollback
    // would consider its job done the moment `store` resolved, leaving
    // "old-proxy-pw" sitting in the vault under this id even though the
    // record it belongs to no longer exists — an orphaned key. The fix
    // re-checks presence immediately after the store settles and
    // best-effort deletes the key it just wrote when the record is gone.
    expect(secretDelete).toHaveBeenCalledWith(proxyPasswordSecretKey("srv-1"));
    const finalSecret = await ctx.secretVault!.get(proxyPasswordSecretKey("srv-1"));
    expect(finalSecret).toBeUndefined();
  });
});
