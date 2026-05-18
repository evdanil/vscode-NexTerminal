import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { CommandContext } from "../../src/commands/types";
import { registerServerCommands, formValuesToServer, formValuesToProxy, preserveLinkedServerCredentials, syncProxyPasswordSecret } from "../../src/commands/serverCommands";
import type { AuthProfile, ServerConfig, TunnelProfile } from "../../src/models/config";
import { FolderTreeItem } from "../../src/ui/nexusTreeProvider";
import { readFile } from "node:fs/promises";
import { defaultSshDir, deployPublicKeyToRemote, findLocalKeyPairs, generateKeyPair } from "../../src/services/ssh/deploySshKey";
import { passphraseSecretKey, passwordSecretKey, proxyPasswordSecretKey } from "../../src/services/ssh/silentAuth";
import { SshPty } from "../../src/services/ssh/sshPty";

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

vi.mock("../../src/services/ssh/sshPty", () => ({
  SshPty: vi.fn(() => ({}))
}));

vi.mock("../../src/logging/sessionTranscriptLogger", () => ({
  createSessionTranscript: vi.fn(() => undefined)
}));

vi.mock("../../src/services/scripts/scriptPicker", () => ({
  pickScriptFromWorkspace: vi.fn(async () => ({ fsPath: "/workspace/.nexus/scripts/task.js" }))
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
    createTerminal: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() }))
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
  const removeServer = vi.fn(async () => {});
  const addOrUpdateServer = vi.fn(async (server: ServerConfig) => {
    snapshot = {
      ...snapshot,
      servers: [...snapshot.servers.filter((item) => item.id !== server.id), server]
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

  it("remove command stops all remaining tunnels and disconnects pool", async () => {
    const autoStopProfile = makeTunnel({ id: "tp-stop", autoStop: true });
    const keepProfile = makeTunnel({ id: "tp-keep", autoStop: false });
    const { ctx, stopTunnel, disconnectPool, removeServer, secretDelete } = setupHarness({
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
    expect(preserveLinkedServerCredentials(existing, next)).toEqual(
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
    expect(preserveLinkedServerCredentials(existing, next)).toEqual(next);
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
