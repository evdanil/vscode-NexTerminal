import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { CommandContext } from "../../src/commands/types";
import { registerServerCommands, formValuesToServer, formValuesToProxy, preserveLinkedServerCredentials, syncProxyPasswordSecret } from "../../src/commands/serverCommands";
import type { ServerConfig, TunnelProfile } from "../../src/models/config";
import { FolderTreeItem } from "../../src/ui/nexusTreeProvider";
import { readFile } from "node:fs/promises";
import { defaultSshDir, deployPublicKeyToRemote, findLocalKeyPairs, generateKeyPair } from "../../src/services/ssh/deploySshKey";
import { passphraseSecretKey, passwordSecretKey, proxyPasswordSecretKey } from "../../src/services/ssh/silentAuth";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowWarningMessage = vi.fn();

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
    showInputBox: vi.fn(),
    showOpenDialog: vi.fn(),
    withProgress: vi.fn()
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

interface Harness {
  ctx: CommandContext;
  stopTunnel: ReturnType<typeof vi.fn>;
  disconnectPool: ReturnType<typeof vi.fn>;
  removeServer: ReturnType<typeof vi.fn>;
  addOrUpdateServer: ReturnType<typeof vi.fn>;
  terminalDispose: ReturnType<typeof vi.fn>;
  secretDelete: ReturnType<typeof vi.fn>;
  secretStore: ReturnType<typeof vi.fn>;
}

function setupHarness(options: {
  activeTunnels: Array<{ id: string; profileId: string; serverId: string }>;
  profiles: TunnelProfile[];
  servers?: ServerConfig[];
  confirmRemove?: boolean;
}): Harness {
  let snapshot = {
    servers: options.servers ?? [makeServer()],
    tunnels: options.profiles,
    serialProfiles: [],
    activeSessions: [],
    activeSerialSessions: [],
    activeTunnels: options.activeTunnels.map((t) => ({
      id: t.id,
      profileId: t.profileId,
      serverId: t.serverId
    })),
    remoteTunnels: [],
    explicitGroups: [],
    authProfiles: [],
    activitySessionIds: new Set()
  };

  const stopTunnel = vi.fn(async (activeTunnelId: string) => {
    snapshot = {
      ...snapshot,
      activeTunnels: snapshot.activeTunnels.filter((t) => t.id !== activeTunnelId)
    };
  });
  const disconnectPool = vi.fn();
  const removeServer = vi.fn(async () => {});
  const addOrUpdateServer = vi.fn(async () => {});
  const secretDelete = vi.fn(async () => {});
  const secretStore = vi.fn(async () => {});

  const terminalDispose = vi.fn();
  const terminalsByServer = new Map<string, Set<{ dispose: () => void }>>();
  terminalsByServer.set("srv-1", new Set([{ dispose: terminalDispose }]));

  const core = {
    getServer: vi.fn((id: string) => snapshot.servers.find((s) => s.id === id)),
    getTunnel: vi.fn((id: string) => snapshot.tunnels.find((t) => t.id === id)),
    getSnapshot: vi.fn(() => snapshot),
    isServerConnected: vi.fn(() => false),
    removeServer,
    addOrUpdateServer
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
    highlighter: {} as any,
    sftpService: {} as any,
    fileExplorerProvider: {} as any,
    secretVault: {
      get: vi.fn(async () => undefined),
      store: secretStore,
      delete: secretDelete
    },
    registrySync: undefined
  };

  mockShowWarningMessage.mockResolvedValue(options.confirmRemove === false ? undefined : "Remove");

  return { ctx, stopTunnel, disconnectPool, removeServer, addOrUpdateServer, terminalDispose, secretDelete, secretStore };
}

describe("server disconnect with tunnel autoStop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
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
    vi.mocked(defaultSshDir).mockReturnValue("/home/user/.ssh");
    vi.mocked(vscode.window.withProgress as any).mockImplementation(async (_options: unknown, task: () => Promise<unknown>) => task());
  });

  it("deploys selected key and switches server to key auth", async () => {
    const { ctx, addOrUpdateServer, secretDelete } = setupHarness({ profiles: [], activeTunnels: [] });
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
      .mockResolvedValueOnce("Switch to key auth")
      .mockResolvedValueOnce("Remove stored password");

    registerServerCommands(ctx);
    const deployCmd = registeredCommands.get("nexus.server.deployKey");
    expect(deployCmd).toBeDefined();

    await deployCmd!("srv-1");

    expect((ctx.sshFactory as any).connect).toHaveBeenCalledWith(expect.objectContaining({ id: "srv-1" }));
    expect(deployPublicKeyToRemote).toHaveBeenCalledWith(connection, "ssh-ed25519 AAAA user@example");
    expect(addOrUpdateServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "srv-1",
        authType: "key",
        keyPath: "/home/user/.ssh/id_ed25519"
      })
    );
    expect(secretDelete).toHaveBeenCalledWith(passwordSecretKey("srv-1"));
    expect(connection.dispose).toHaveBeenCalledTimes(1);
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
    vi.mocked(vscode.window.showInformationMessage as any).mockResolvedValueOnce("Switch to key auth");

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
