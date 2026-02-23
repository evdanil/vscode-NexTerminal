import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import { registerServerCommands } from "../../src/commands/serverCommands";
import type { ServerConfig, TunnelProfile } from "../../src/models/config";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowWarningMessage = vi.fn();

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
  terminalDispose: ReturnType<typeof vi.fn>;
}

function setupHarness(options: {
  activeTunnels: Array<{ id: string; profileId: string; serverId: string }>;
  profiles: TunnelProfile[];
  confirmRemove?: boolean;
}): Harness {
  let snapshot = {
    servers: [makeServer()],
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
    explicitGroups: []
  };

  const stopTunnel = vi.fn(async (activeTunnelId: string) => {
    snapshot = {
      ...snapshot,
      activeTunnels: snapshot.activeTunnels.filter((t) => t.id !== activeTunnelId)
    };
  });
  const disconnectPool = vi.fn();
  const removeServer = vi.fn(async () => {});

  const terminalDispose = vi.fn();
  const terminalsByServer = new Map<string, Set<{ dispose: () => void }>>();
  terminalsByServer.set("srv-1", new Set([{ dispose: terminalDispose }]));

  const core = {
    getServer: vi.fn((id: string) => snapshot.servers.find((s) => s.id === id)),
    getTunnel: vi.fn((id: string) => snapshot.tunnels.find((t) => t.id === id)),
    getSnapshot: vi.fn(() => snapshot),
    isServerConnected: vi.fn(() => false),
    removeServer
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
    registrySync: undefined
  };

  mockShowWarningMessage.mockResolvedValue(options.confirmRemove === false ? undefined : "Remove");

  return { ctx, stopTunnel, disconnectPool, removeServer, terminalDispose };
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
    const { ctx, stopTunnel, disconnectPool, removeServer } = setupHarness({
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
    expect(removeServer).toHaveBeenCalledWith("srv-1");
  });
});
