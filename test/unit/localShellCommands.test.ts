import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMacros = vi.hoisted(() => [] as any[]);
const mockExistingPaths = vi.hoisted(() => new Set<string>());
const mockExecFileSync = vi.hoisted(() => vi.fn());
const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockCreateTerminal = vi.fn(() => ({ show: vi.fn(), sendText: vi.fn(), dispose: vi.fn(), name: "Nexus Local Shell: Dev" }));
const mockExecuteCommand = vi.fn();
const mockPickScriptFromWorkspace = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowQuickPick = vi.fn();
const mockGetConfiguration = vi.fn();
const closeTerminalListeners: Array<(terminal: unknown) => void> = [];
const openTerminalListeners: Array<(terminal: unknown) => void> = [];
const mockTerminals: unknown[] = [];
let mockWorkspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;

function normalizeMockPath(value: string): string {
  return value.replace(/\//g, "\\").toLowerCase();
}

function markPathExists(value: string): void {
  mockExistingPaths.add(normalizeMockPath(value));
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
}

vi.mock("node:fs", () => ({
  existsSync: (value: string) => mockExistingPaths.has(normalizeMockPath(String(value)))
}));

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args)
}));

vi.mock("../../src/macroSettings", () => ({
  getMacros: () => mockMacros
}));

vi.mock("../../src/services/scripts/scriptPicker", () => ({
  pickScriptFromWorkspace: (...args: unknown[]) => mockPickScriptFromWorkspace(...args)
}));

vi.mock("vscode", () => ({
  EventEmitter: class<T> {
    private readonly listeners: Array<(event: T) => void> = [];
    public event = (listener: (event: T) => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    };
    public fire(event: T): void {
      for (const listener of this.listeners) listener(event);
    }
    public dispose(): void {
      this.listeners.length = 0;
    }
  },
  Disposable: class {
    public constructor(private readonly fn: () => void) {}
    public dispose(): void {
      this.fn();
    }
  },
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
    getConfiguration: (...args: unknown[]) => mockGetConfiguration(...args),
    get workspaceFolders() {
      return mockWorkspaceFolders;
    }
  },
  ConfigurationTarget: { Global: 1 },
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
  resolveLocalShellLaunchOptions
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
      unregisterLocalShellSession: vi.fn(),
      onDidChange: vi.fn(() => vi.fn())
    },
    localShellTerminals: new Map(),
    focusedTerminal: undefined,
    extensionPath: "/ext",
    globalStoragePath: "/gs",
    globalState: {
      get: vi.fn(() => false),
      update: vi.fn()
    },
    terminalRegistry: {
      register: vi.fn()
    },
    macroAutoTrigger: {
      createObserver: vi.fn(() => ({ onOutput: vi.fn(), pauseIntervalMacros: vi.fn(), dispose: vi.fn() }))
    }
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

describe("resolveLocalShellLaunchOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMacros.length = 0;
    mockExistingPaths.clear();
    mockExecFileSync.mockReset();
    mockWorkspaceFolders = undefined;
    mockPickScriptFromWorkspace.mockReset();
    registeredCommands.clear();
    closeTerminalListeners.length = 0;
    openTerminalListeners.length = 0;
    mockTerminals.length = 0;
    mockGetConfiguration.mockImplementation((section: string) => ({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (section === "terminal.integrated" && key === "profiles.linux") {
          return {
            Bash: {
              path: "${env:SHELL_ROOT}/bash",
              args: ["--rcfile", "${workspaceFolder:api}/.bashrc", "~/literal"],
              env: { DEV: "${env:DEV_VALUE}", REMOVE_ME: null }
            },
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

  it("lists configured VS Code terminal profile names with explicit or resolvable source shell paths", () => {
    markPathExists("/usr/bin/bash");
    markPathExists("C:\\Program Files\\Git\\bin\\bash.exe");

    expect(getConfiguredVscodeTerminalProfileNames()).toEqual(["Auto", "Bash"]);
  });

  it("resolves explicit VS Code terminal profiles to launch options", () => {
    process.env.SHELL_ROOT = "/usr/bin";
    process.env.DEV_VALUE = "1";
    mockWorkspaceFolders = [
      { uri: { fsPath: "/repo/app" }, name: "app" },
      { uri: { fsPath: "/repo/api" }, name: "api" }
    ] as any;
    const options = resolveLocalShellLaunchOptions(makeProfile({
      launchMode: "vscodeProfile",
      vscodeProfileName: "Bash",
      shellPath: undefined,
      shellArgs: undefined
    }));

    expect(options).toMatchObject({
      shellPath: "/usr/bin/bash",
      shellArgs: ["--rcfile", "/repo/api/.bashrc", `${process.env.HOME ?? ""}/literal`],
      env: { DEV: "1", REMOVE_ME: null }
    });
  });

  it("chooses the first existing path from VS Code profile path arrays", () => {
    process.env.windir = "C:\\Windows";
    markPathExists("C:\\Windows\\System32\\cmd.exe");
    mockGetConfiguration.mockImplementation((section: string) => ({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (section === "terminal.integrated" && key === "profiles.linux") {
          return {
            "Command Prompt": {
              path: ["${env:windir}\\Sysnative\\cmd.exe", "${env:windir}\\System32\\cmd.exe"]
            }
          };
        }
        return fallback;
      })
    }));

    const options = resolveLocalShellLaunchOptions(makeProfile({
      launchMode: "vscodeProfile",
      vscodeProfileName: "Command Prompt",
      shellPath: undefined,
      shellArgs: undefined
    }));

    expect(options.shellPath).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("resolves configured PowerShell source profiles to a launchable shell path", () => {
    process.env.windir = "C:\\Windows";
    markPathExists("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    mockGetConfiguration.mockImplementation((section: string) => ({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (section === "terminal.integrated" && key === "profiles.linux") {
          return {
            PowerShell: { source: "PowerShell" }
          };
        }
        return fallback;
      })
    }));

    expect(getConfiguredVscodeTerminalProfileNames()).toEqual(["PowerShell"]);
    const options = resolveLocalShellLaunchOptions(makeProfile({
      launchMode: "vscodeProfile",
      vscodeProfileName: "PowerShell",
      shellPath: undefined
    }));

    expect(options.shellPath).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("adds detected WSL distro profiles on Windows", () => {
    process.env.windir = "C:\\Windows";
    markPathExists("C:\\Windows\\System32\\wsl.exe");
    mockExecFileSync.mockReturnValueOnce(Buffer.from("Ubuntu\r\n", "utf8"));
    mockGetConfiguration.mockImplementation((section: string) => ({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (section === "terminal.integrated" && key === "profiles.windows") {
          return {};
        }
        return fallback;
      })
    }));

    withPlatform("win32", () => {
      expect(getConfiguredVscodeTerminalProfileNames()).toContain("Ubuntu (WSL)");
      const options = resolveLocalShellLaunchOptions(makeProfile({
        launchMode: "vscodeProfile",
        vscodeProfileName: "Ubuntu (WSL)",
        shellPath: undefined
      }));

      expect(options).toMatchObject({
        shellPath: "C:\\Windows\\System32\\wsl.exe",
        shellArgs: ["-d", "Ubuntu"]
      });
    });
  });

  it("does not treat arbitrary missing profile names as WSL profiles", () => {
    process.env.windir = "C:\\Windows";
    markPathExists("C:\\Windows\\System32\\wsl.exe");
    mockGetConfiguration.mockImplementation((section: string) => ({
      get: vi.fn((_key: string, fallback?: unknown) => {
        if (section === "terminal.integrated") return {};
        return fallback;
      })
    }));

    withPlatform("win32", () => {
      expect(() => resolveLocalShellLaunchOptions(makeProfile({
        launchMode: "vscodeProfile",
        vscodeProfileName: "Not A Real Profile",
        shellPath: undefined
      }))).toThrow(/was not found for this platform/i);
    });
  });

  it("expands common local shell working-directory variables before launching", () => {
    mockWorkspaceFolders = [{ uri: { fsPath: "/repo/project" } }];

    const options = resolveLocalShellLaunchOptions(makeProfile({
      cwd: "${workspaceFolder}/tools"
    }));

    expect(options.cwd).toBe("/repo/project/tools");
  });

  it("expands environment, workspace, named workspace, and home variables in custom shell path, args, and cwd", () => {
    process.env.NEXUS_TEST_SHELL = "/opt/shells/zsh";
    mockWorkspaceFolders = [
      { uri: { fsPath: "/repo/app" }, name: "app" },
      { uri: { fsPath: "/repo/tools" }, name: "tools" }
    ] as any;

    const options = resolveLocalShellLaunchOptions(makeProfile({
      shellPath: "${env:NEXUS_TEST_SHELL}",
      shellArgs: ["--init-file", "${workspaceFolder:tools}/zshrc", "~/arg"],
      cwd: "${workspaceFolder}/src"
    }));

    expect(options.shellPath).toBe("/opt/shells/zsh");
    expect(options.shellArgs).toEqual(["--init-file", "/repo/tools/zshrc", `${process.env.HOME ?? ""}/arg`]);
    expect(options.cwd).toBe("/repo/app/src");
  });

  it("does not resolve unsupported source-only VS Code terminal profiles to launch options", () => {
    expect(() => resolveLocalShellLaunchOptions(makeProfile({
      launchMode: "vscodeProfile",
      vscodeProfileName: "Auto",
      shellPath: undefined
    }))).toThrow(/does not expose a launchable executable path/i);
  });
});

describe("registerLocalShellCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMacros.length = 0;
    mockExistingPaths.clear();
    mockExecFileSync.mockReset();
    mockWorkspaceFolders = undefined;
    mockPickScriptFromWorkspace.mockReset();
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

  it("opens a custom local shell with an extension-owned PTY", async () => {
    const terminal = { show: vi.fn(), dispose: vi.fn(), name: "Nexus Local Shell: Dev" };
    mockCreateTerminal.mockReturnValueOnce(terminal);
    const ctx = makeCtx();

    registerLocalShellCommands(ctx);
    await registeredCommands.get("nexus.localShell.connect")!("local-1");

    expect(mockCreateTerminal).toHaveBeenCalledWith(expect.objectContaining({
      name: "Nexus Local Shell: Dev",
      pty: expect.objectContaining({
        handleInput: expect.any(Function),
        markShuttingDown: expect.any(Function)
      }),
      iconPath: expect.objectContaining({ id: "terminal" })
    }));
    expect(ctx.core.registerLocalShellSession).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "local-1",
      terminalName: "Nexus Local Shell: Dev",
      pty: expect.objectContaining({
        handleInput: expect.any(Function)
      })
    }));
    expect(ctx.localShellTerminals.size).toBe(1);
    expect(ctx.focusedTerminal).toBe(terminal);
    expect(ctx.terminalRegistry.register).toHaveBeenCalledWith(
      terminal,
      expect.objectContaining({ handleInput: expect.any(Function) })
    );
  });

  it("warns before opening a local shell when all-terminal auto-trigger macros already exist", async () => {
    mockMacros.push({ name: "Password prompt", text: "secret\n", triggerPattern: "[Pp]assword:" });
    mockShowWarningMessage.mockResolvedValueOnce("Review Macros");
    const ctx = makeCtx();

    registerLocalShellCommands(ctx);
    await registeredCommands.get("nexus.localShell.connect")!("local-1");

    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Existing \"All terminals\" macros can also run in Local Shell sessions."),
      "Review Macros",
      "Disable Globally",
      "Continue"
    );
    expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.macro.editor");
    expect(ctx.globalState.update).not.toHaveBeenCalled();
    expect(mockCreateTerminal).not.toHaveBeenCalled();
    expect(ctx.localShellTerminals.size).toBe(0);
  });

  it("rejects unsupported source-only VS Code terminal profiles with explicit Custom Shell guidance", async () => {
    const ctx = makeCtx(makeProfile({
      launchMode: "vscodeProfile",
      vscodeProfileName: "PowerShell",
      shellPath: undefined,
      shellArgs: undefined
    }));

    registerLocalShellCommands(ctx);
    await registeredCommands.get("nexus.localShell.connect")!("local-1");

    expect(mockCreateTerminal).not.toHaveBeenCalled();
    expect(mockExecuteCommand).not.toHaveBeenCalledWith("workbench.action.terminal.newWithProfile", expect.anything());
    expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Choose Custom Shell and enter the command"));
    expect(ctx.localShellTerminals.size).toBe(0);
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

  it("unregisters local shell sessions on early PTY termination while leaving the terminal visible", async () => {
    const terminal = { show: vi.fn(), sendText: vi.fn(), dispose: vi.fn(), name: "Nexus Local Shell: Dev" };
    mockCreateTerminal.mockReturnValueOnce(terminal);
    const ctx = makeCtx();

    registerLocalShellCommands(ctx);
    await registeredCommands.get("nexus.localShell.connect")!("local-1");
    const sessionId = [...ctx.localShellTerminals.keys()][0];
    const pty = (mockCreateTerminal.mock.calls[0][0] as { pty: unknown }).pty;

    (pty as any).earlyTerminateEmitter.fire({ code: 2 });

    expect(ctx.localShellTerminals.has(sessionId)).toBe(false);
    expect(ctx.core.unregisterLocalShellSession).toHaveBeenCalledWith(sessionId);
    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it("opens a local shell profile and runs a picked compatible script against the new session", async () => {
    const terminal = { show: vi.fn(), dispose: vi.fn(), name: "Nexus Local Shell: Dev" };
    const scriptUri = { fsPath: "/ws/.nexus/scripts/local.js" };
    mockCreateTerminal.mockImplementationOnce((options: { pty: unknown }) => {
      setImmediate(() => (options.pty as any).startupCompleteEmitter.fire());
      return terminal;
    });
    mockPickScriptFromWorkspace.mockResolvedValueOnce(scriptUri);
    const ctx = {
      ...makeCtx(),
      scriptRuntimeManager: {
        runScript: vi.fn(async () => "run-1")
      }
    } as any;

    registerLocalShellCommands(ctx);
    await registeredCommands.get("nexus.localShell.runWithScript")!("local-1");

    const sessionId = [...ctx.localShellTerminals.keys()][0];
    expect(mockPickScriptFromWorkspace).toHaveBeenCalledWith(ctx.globalStoragePath, "local");
    expect(ctx.scriptRuntimeManager.runScript).toHaveBeenCalledWith(scriptUri, sessionId);
  });

  it("does not run a picked script when the new local shell terminates during startup", async () => {
    const terminal = { show: vi.fn(), dispose: vi.fn(), name: "Nexus Local Shell: Dev" };
    const scriptUri = { fsPath: "/ws/.nexus/scripts/local.js" };
    mockCreateTerminal.mockImplementationOnce((options: { pty: unknown }) => {
      setImmediate(() => (options.pty as any).earlyTerminateEmitter.fire({ code: 2 }));
      return terminal;
    });
    mockPickScriptFromWorkspace.mockResolvedValueOnce(scriptUri);
    const ctx = {
      ...makeCtx(),
      scriptRuntimeManager: {
        runScript: vi.fn(async () => "run-1")
      }
    } as any;

    registerLocalShellCommands(ctx);
    await registeredCommands.get("nexus.localShell.runWithScript")!("local-1");

    expect(mockPickScriptFromWorkspace).toHaveBeenCalledWith(ctx.globalStoragePath, "local");
    expect(ctx.scriptRuntimeManager.runScript).not.toHaveBeenCalled();
    expect(ctx.localShellTerminals.size).toBe(0);
    expect(ctx.core.unregisterLocalShellSession).toHaveBeenCalled();
    expect(terminal.dispose).not.toHaveBeenCalled();
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
