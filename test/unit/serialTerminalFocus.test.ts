import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import { registerSerialCommands } from "../../src/commands/serialCommands";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockCreateTerminal = vi.fn();

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
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    createTerminal: (...args: unknown[]) => mockCreateTerminal(...args)
  },
  workspace: {
    getConfiguration: vi.fn((section?: string) => ({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (section === "nexus.logging" && key === "sessionTranscripts") {
          return true;
        }
        if (section === "nexus.terminal" && key === "openLocation") {
          return "panel";
        }
        return fallback;
      })
    }))
  },
  env: {
    clipboard: {
      writeText: vi.fn()
    }
  },
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

function createSerialSidecar(): {
  serialSidecar: CommandContext["serialSidecar"];
  emitData: (sessionId: string, payload: string) => void;
} {
  const listeners = new Set<(sessionId: string, data: Buffer) => void>();
  return {
    serialSidecar: {
      openPort: vi.fn(async () => "serial-1"),
      writePort: vi.fn(async () => {}),
      closePort: vi.fn(async () => {}),
      onDidReceiveData: (listener: (sessionId: string, data: Buffer) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onDidReceiveError: vi.fn(() => () => {}),
      onDidDisconnect: vi.fn(() => () => {})
    } as any,
    emitData: (sessionId: string, payload: string) => {
      for (const listener of listeners) {
        listener(sessionId, Buffer.from(payload, "utf8"));
      }
    }
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("serial terminal focus tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("treats a newly shown serial terminal as focused before initial data arrives", async () => {
    const profile = {
      id: "serial-profile-1",
      name: "USB Console",
      path: "COM9",
      baudRate: 115200,
      dataBits: 8 as const,
      stopBits: 1 as const,
      parity: "none" as const,
      rtscts: false
    };
    const { serialSidecar, emitData } = createSerialSidecar();
    const core = {
      getSerialProfile: vi.fn(() => profile),
      getSnapshot: vi.fn(() => ({
        servers: [],
        tunnels: [],
        serialProfiles: [profile],
        activeSessions: [],
        activeSerialSessions: [],
        activeTunnels: [],
        remoteTunnels: [],
        explicitGroups: [],
        authProfiles: [],
        activitySessionIds: new Set<string>()
      })),
      registerSerialSession: vi.fn(),
      unregisterSerialSession: vi.fn(),
      markSessionActivity: vi.fn(),
      clearSessionActivity: vi.fn(),
      isSerialProfileConnected: vi.fn(() => true)
    };
    const terminal = {
      name: "Nexus Serial: USB Console",
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
      tunnelManager: {} as any,
      serialSidecar,
      sshFactory: {} as any,
      sshPool: {} as any,
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

    registerSerialCommands(ctx);
    const connectCommand = registeredCommands.get("nexus.serial.connect");
    expect(connectCommand).toBeDefined();

    await connectCommand!("serial-profile-1");
    await flushAsync();

    emitData("serial-1", "hello");
    await flushAsync();

    expect(ctx.focusedTerminal).toBe(terminal as any);
    expect(core.markSessionActivity).not.toHaveBeenCalled();
  });
});
