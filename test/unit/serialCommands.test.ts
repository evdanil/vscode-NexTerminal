import { beforeEach, describe, expect, it, vi } from "vitest";

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
    showErrorMessage: vi.fn()
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(() => true)
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
  EventEmitter: class {
    public readonly event = vi.fn();
    public fire = vi.fn();
    public dispose = vi.fn();
  }
}));

import { formValuesToSerial, registerSerialCommands } from "../../src/commands/serialCommands";

describe("formValuesToSerial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("normalizes valid group values", () => {
    const serial = formValuesToSerial({
      name: "USB Console",
      path: "COM3",
      group: "  Lab / Rack  "
    });
    expect(serial).toBeDefined();
    expect(serial!.group).toBe("Lab/Rack");
  });

  it("rejects invalid non-empty group values", () => {
    const serial = formValuesToSerial({
      name: "USB Console",
      path: "COM3",
      group: "/"
    });
    expect(serial).toBeUndefined();
  });

  it("defaults connection mode to standard", () => {
    const serial = formValuesToSerial({
      name: "USB Console",
      path: "COM3"
    });
    expect(serial?.mode).toBe("standard");
  });

  it("preserves smart-follow metadata on edit", () => {
    const serial = formValuesToSerial(
      {
        name: "USB Console",
        path: "COM9",
        mode: "smartFollow"
      },
      {
        id: "sp1",
        deviceHint: { serialNumber: "ABC123", vendorId: "1111" }
      }
    );
    expect(serial).toMatchObject({
      id: "sp1",
      path: "COM9",
      mode: "smartFollow",
      deviceHint: { serialNumber: "ABC123", vendorId: "1111" }
    });
  });
});

describe("registerSerialCommands smart-follow lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("blocks standard serial connects while a smart-follow session is active", async () => {
    const profile = {
      id: "sp1",
      name: "USB Console",
      path: "COM3",
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      rtscts: false,
      mode: "standard"
    };
    const ctx = {
      core: {
        getSerialProfile: vi.fn(() => profile)
      },
      serialSidecar: {} as any,
      loggerFactory: { create: vi.fn() } as any,
      macroAutoTrigger: { createObserver: vi.fn() } as any,
      sessionLogDir: "",
      serialTerminals: new Map(),
      highlighter: {} as any,
      focusedTerminal: undefined,
      activityIndicators: new Map(),
      smartSerialLock: {
        profileId: "smart-1",
        sessionId: "session-1",
        terminal: { show: vi.fn() } as any
      }
    } as any;

    registerSerialCommands(ctx);
    const connectCommand = registeredCommands.get("nexus.serial.connect");
    expect(connectCommand).toBeDefined();

    await connectCommand!("sp1");

    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      "A Smart Follow serial profile is active. Disconnect it before opening a standard serial session."
    );
  });
});
