import { beforeEach, describe, expect, it, vi } from "vitest";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockCreateTerminal = vi.fn(() => ({ show: vi.fn(), sendText: vi.fn(), dispose: vi.fn(), name: "Nexus Local Shell: Dev" }));
const mockExecuteCommand = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowQuickPick = vi.fn();
const mockGetConfiguration = vi.fn();
const closeTerminalListeners: Array<(terminal: unknown) => void> = [];
const openTerminalListeners: Array<(terminal: unknown) => void> = [];
const mockTerminals: unknown[] = [];

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: (...args: unknown[]) => mockExecuteCommand(...args)
  },
  window: {
    get terminals() {
      return mockTerminals;
    },
    createTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showInformationMessage: vi.fn(),
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
    showInputBox: vi.fn(),
    onDidOpenTerminal: vi.fn((listener: (terminal: unknown) => void) => {
      openTerminalListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onDidCloseTerminal: vi.fn((listener: (terminal: unknown) => void) => {
      closeTerminalListeners.push(listener);
      return { dispose: vi.fn() };
    })
  },
  workspace: {
    getConfiguration: (...args: unknown[]) => mockGetConfiguration(...args)
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
  }
}));

import * as vscode from "vscode";
import {
  formValuesToLocalShell,
  getConfiguredVscodeTerminalProfileNames,
  registerLocalShellCommands,
  resolveLocalShellTerminalOptions
} from "../../src/commands/localShellCommands";
import type { LocalShellProfile } from "../../src/models/config";

function makeProfile(overrides: Partial<LocalShellProfile> = {}): LocalShellProfile {
  return {
    id: "local-1",
    name: "Dev",
    launchMode: "custom",
    shellPath: "/bin/bash",
    shellArgs: ["--login"],
    cwd: "/workspace",
    startupCommand: "echo ready",
    ...overrides
  };
}

function makeCtx(profile = makeProfile()) {
  return {
    core: {
      getLocalShellProfile: vi.fn(() => profile),
      getSnapshot: vi.fn(() => ({
        localShellProfiles: [profile],
        activeLocalShellSessions: []
      })),
      addOrUpdateLocalShellProfile: vi.fn(),
      removeLocalShellProfile: vi.fn(),
      registerLocalShellSession: vi.fn(),
      unregisterLocalShellSession: vi.fn()
    },
    localShellTerminals: new Map(),
    focusedTerminal: undefined
  } as any;
}

describe("formValuesToLocalShell", () => {
  it("normalizes group values and splits arguments one per line", () => {
    const profile = formValuesToLocalShell({
      name: "Dev Shell",
      launchMode: "custom",
      shellPath: " /bin/zsh ",
      shellArgs: " --login \n\n -i ",
      cwd: " ~/repo ",
      startupCommand: " npm test ",
      group: " Labs / Local "
    });

    expect(profile).toMatchObject({
      name: "Dev Shell",
      launchMode: "custom",
      shellPath: "/bin/zsh",
      shellArgs: ["--login", "-i"],
      cwd: "~/repo",
      startupCommand: "npm test",
      group: "Labs/Local"
    });
  });

  it("requires a VS Code profile name in VS Code profile launch mode", () => {
    expect(formValuesToLocalShell({ name: "Dev", launchMode: "vscodeProfile" })).toBeUndefined();
  });
});

describe("resolveLocalShellTerminalOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    closeTerminalListeners.length = 0;
    openTerminalListeners.length = 0;
    mockTerminals.length = 0;
    mockGetConfiguration.mockImplementation((section: string) => ({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (section === "terminal.integrated" && key === "profiles.linux") {
          return {
            Bash: { path: "/usr/bin/bash", args: ["--login"], env: { DEV: "1", REMOVE_ME: null } },
            Auto: { source: "Git Bash" }
          };
        }
        if (section === "nexus.terminal" && key === "openLocation") {
          return "editor";
        }
        return fallback;
      })
    }));
  });

  it("lists configured VS Code terminal profile names for form suggestions", () => {
    expect(getConfiguredVscodeTerminalProfileNames()).toEqual(["Auto", "Bash"]);
  });

  it("resolves explicit VS Code terminal profiles to TerminalOptions", () => {
    const options = resolveLocalShellTerminalOptions(makeProfile({
      launchMode: "vscodeProfile",
      vscodeProfileName: "Bash",
      shellPath: undefined,
      shellArgs: undefined
    }));

    expect(options).toMatchObject({
      shellPath: "/usr/bin/bash",
      shellArgs: ["--login"],
      env: { DEV: "1", REMOVE_ME: null }
    });
  });

  it("does not resolve source-only VS Code terminal profiles to TerminalOptions", () => {
    expect(() => resolveLocalShellTerminalOptions(makeProfile({
      launchMode: "vscodeProfile",
      vscodeProfileName: "Auto",
      shellPath: undefined
    }))).toThrow(/does not define an explicit shell path/i);
  });
});

describe("registerLocalShellCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    closeTerminalListeners.length = 0;
    openTerminalListeners.length = 0;
    mockTerminals.length = 0;
    mockGetConfiguration.mockImplementation((section: string) => ({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (section === "nexus.terminal" && key === "openLocation") return "editor";
        if (section === "terminal.integrated" && key === "profiles.linux") {
          return {
            PowerShell: { source: "PowerShell" }
          };
        }
        return fallback;
      })
    }));
  });

  it("opens a custom local shell with TerminalOptions and sends the startup command", async () => {
    const terminal = { show: vi.fn(), sendText: vi.fn(), dispose: vi.fn(), name: "Nexus Local Shell: Dev" };
    mockCreateTerminal.mockReturnValueOnce(terminal);
    const ctx = makeCtx();

    registerLocalShellCommands(ctx);
    await registeredCommands.get("nexus.localShell.connect")!("local-1");

    expect(mockCreateTerminal).toHaveBeenCalledWith(expect.objectContaining({
      name: "Nexus Local Shell: Dev",
      shellPath: "/bin/bash",
      shellArgs: ["--login"],
      cwd: "/workspace",
      iconPath: expect.objectContaining({ id: "terminal" })
    }));
    expect(terminal.sendText).toHaveBeenCalledWith("echo ready");
    expect(ctx.core.registerLocalShellSession).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "local-1",
      terminalName: "Nexus Local Shell: Dev"
    }));
    expect(ctx.localShellTerminals.size).toBe(1);
    expect(ctx.focusedTerminal).toBe(terminal);
  });

  it("opens source-only VS Code terminal profiles through VS Code profile command", async () => {
    const terminal = { show: vi.fn(), sendText: vi.fn(), dispose: vi.fn(), name: "PowerShell" };
    mockExecuteCommand.mockImplementation(async (command: string) => {
      if (command === "workbench.action.terminal.newWithProfile") {
        mockTerminals.push(terminal);
        for (const listener of openTerminalListeners) {
          listener(terminal);
        }
      }
    });
    const ctx = makeCtx(makeProfile({
      launchMode: "vscodeProfile",
      vscodeProfileName: "PowerShell",
      shellPath: undefined,
      shellArgs: undefined
    }));

    registerLocalShellCommands(ctx);
    await registeredCommands.get("nexus.localShell.connect")!("local-1");

    expect(mockCreateTerminal).not.toHaveBeenCalled();
    expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.terminal.newWithProfile", {
      profileName: "PowerShell",
      location: "editor"
    });
    expect(terminal.sendText).toHaveBeenCalledWith("echo ready");
    expect(ctx.core.registerLocalShellSession).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "local-1",
      terminalName: "Nexus Local Shell: Dev"
    }));
    expect(ctx.localShellTerminals.size).toBe(1);
    expect(ctx.focusedTerminal).toBe(terminal);
  });

  it("unregisters local shell sessions when their terminal closes", async () => {
    const terminal = { show: vi.fn(), sendText: vi.fn(), dispose: vi.fn(), name: "Nexus Local Shell: Dev" };
    mockCreateTerminal.mockReturnValueOnce(terminal);
    const ctx = makeCtx();

    registerLocalShellCommands(ctx);
    await registeredCommands.get("nexus.localShell.connect")!("local-1");
    const sessionId = [...ctx.localShellTerminals.keys()][0];

    closeTerminalListeners[0](terminal);

    expect(ctx.localShellTerminals.has(sessionId)).toBe(false);
    expect(ctx.core.unregisterLocalShellSession).toHaveBeenCalledWith(sessionId);
  });

  it("routes Add Local Shell to the unified local shell add form", async () => {
    const ctx = makeCtx();
    registerLocalShellCommands(ctx);

    await registeredCommands.get("nexus.localShell.add")!();

    expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.profile.add", {
      addMode: "localShell",
      profileType: "localShell"
    });
  });
});
