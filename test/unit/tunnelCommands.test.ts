import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import { NexusCore } from "../../src/core/nexusCore";
import type { TunnelProfile } from "../../src/models/config";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { registerTunnelCommands } from "../../src/commands/tunnelCommands";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowQuickPick = vi.fn();

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
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
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
