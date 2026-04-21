import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import { registerServerCommands } from "../../src/commands/serverCommands";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockCreateTerminal = vi.fn();
const mockWithProgress = vi.fn(async (_options: unknown, task: () => Promise<unknown>) => task());

vi.mock("../../src/logging/sessionTranscriptLogger", () => ({
  createSessionTranscript: vi.fn(() => undefined)
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
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInputBox: vi.fn(),
    showOpenDialog: vi.fn(),
    showErrorMessage: vi.fn(),
    withProgress: (...args: unknown[]) => mockWithProgress(...args),
    createTerminal: (...args: unknown[]) => mockCreateTerminal(...args)
  },
  workspace: {
    getConfiguration: vi.fn((section?: string) => ({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (section === "nexus.logging" && key === "sessionTranscripts") {
          return true;
        }
        if (section === "nexus.ssh" && key === "terminalType") {
          return "xterm-256color";
        }
        if (section === "nexus.terminal" && key === "openLocation") {
          return "panel";
        }
        return fallback;
      })
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
  EventEmitter: class MockEventEmitter<T> {
    private listeners = new Set<(value: T) => void>();

    public readonly event = (listener: (value: T) => void): { dispose: () => void } => {
      this.listeners.add(listener);
      return {
        dispose: () => {
          this.listeners.delete(listener);
        }
      };
    };

    public fire(value?: T): void {
      for (const listener of this.listeners) {
        listener(value as T);
      }
    }

    public dispose(): void {
      this.listeners.clear();
    }
  }
}));

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("server terminal focus tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("treats a newly shown SSH terminal as focused before initial data arrives", async () => {
    const server = {
      id: "srv-1",
      name: "Server 1",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password" as const,
      isHidden: false
    };
    const stream = new PassThrough();
    const connection = {
      openShell: vi.fn(async () => stream),
      getBanner: vi.fn(() => undefined),
      onClose: vi.fn(() => () => {}),
      dispose: vi.fn()
    };
    const core = {
      getServer: vi.fn(() => server),
      getSnapshot: vi.fn(() => ({
        servers: [server],
        tunnels: [],
        serialProfiles: [],
        activeSessions: [],
        activeSerialSessions: [],
        activeTunnels: [],
        remoteTunnels: [],
        explicitGroups: [],
        authProfiles: [],
        activitySessionIds: new Set<string>(),
        focusedSessionId: undefined
      })),
      registerSession: vi.fn(),
      unregisterSession: vi.fn(),
      markSessionActivity: vi.fn(),
      clearSessionActivity: vi.fn(),
      isServerConnected: vi.fn(() => true)
    };
    const terminal = {
      name: "Nexus SSH: Server 1",
      show: vi.fn(),
      dispose: vi.fn()
    };
    mockCreateTerminal.mockImplementation(({ pty }: { pty: { open(): void } }) => {
      terminal.show.mockImplementation(() => {
        pty.open();
      });
      return terminal;
    });

    const ctx: CommandContext = {
      core: core as any,
      tunnelManager: { stop: vi.fn() } as any,
      serialSidecar: {} as any,
      sshFactory: { connect: vi.fn(async () => connection) } as any,
      sshPool: { disconnect: vi.fn() } as any,
      loggerFactory: { create: vi.fn(() => ({ log: vi.fn(), close: vi.fn() })) } as any,
      sessionLogDir: "",
      terminalsByServer: new Map(),
      sessionTerminals: new Map(),
      serialTerminals: new Map(),
      highlighter: { apply: vi.fn((text: string) => text) } as any,
      macroAutoTrigger: { createObserver: vi.fn(() => undefined) } as any,
      sftpService: {} as any,
      fileExplorerProvider: {} as any,
      focusedTerminal: undefined,
      activityIndicators: new Map()
    };

    registerServerCommands(ctx);
    const connectCommand = registeredCommands.get("nexus.server.connect");
    expect(connectCommand).toBeDefined();

    await connectCommand!("srv-1");
    await flushAsync();

    stream.push("hello");
    await flushAsync();

    expect(ctx.focusedTerminal).toBe(terminal as any);
    expect(core.markSessionActivity).not.toHaveBeenCalled();
  });
});
