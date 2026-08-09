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
import type { CommandContext } from "../../src/commands/types";
import { NexusCore } from "../../src/core/nexusCore";
import { configMutationLock } from "../../src/services/configMutationLock";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";

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
    },
    highlighter: {
      apply: vi.fn((text: string) => text),
      createStream: vi.fn()
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

  it("passes the command context highlighter into the local shell PTY", async () => {
    const terminal = { show: vi.fn(), dispose: vi.fn(), name: "Nexus Local Shell: Dev" };
    mockCreateTerminal.mockReturnValueOnce(terminal);
    const ctx = makeCtx();

    registerLocalShellCommands(ctx);
    await registeredCommands.get("nexus.localShell.connect")!("local-1");

    const pty = (mockCreateTerminal.mock.calls[0][0] as { pty: unknown }).pty;
    expect((pty as any).options.highlighter).toBe(ctx.highlighter);
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

  it("Fix 3 — does not warn when the only all-terminal auto-trigger macro also declares variables (it can never compile to a trigger rule)", async () => {
    mockMacros.push({
      name: "Password prompt",
      text: "secret\n",
      triggerPattern: "[Pp]assword:",
      variables: [{ name: "host" }]
    });
    const terminal = { show: vi.fn(), dispose: vi.fn(), name: "Nexus Local Shell: Dev" };
    mockCreateTerminal.mockReturnValueOnce(terminal);
    const ctx = makeCtx();

    registerLocalShellCommands(ctx);
    await registeredCommands.get("nexus.localShell.connect")!("local-1");

    expect(mockShowWarningMessage).not.toHaveBeenCalled();
    expect(mockCreateTerminal).toHaveBeenCalled();
    expect(ctx.localShellTerminals.size).toBe(1);
  });

  it("Fix 3 — the same macro without `variables` still warns", async () => {
    mockMacros.push({
      name: "Password prompt",
      text: "secret\n",
      triggerPattern: "[Pp]assword:"
    });
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
    expect(mockCreateTerminal).not.toHaveBeenCalled();
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

/** Two macrotask turns — enough for every mocked prompt to settle and the command to park. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Parks INSIDE the lock until released — the "already in the critical section,
 * still awaiting its I/O" phase these races need to be pinned against rather
 * than raced for (copied from test/unit/authProfileCommands.test.ts).
 */
function gatedLockedWrite(
  lock: { runExclusive: <T>(fn: () => Promise<T>) => Promise<T> },
  write: () => Promise<void>
): { done: Promise<void>; release: () => void } {
  const gate = deferred<void>();
  const done = lock.runExclusive(async () => {
    await gate.promise;
    await write();
  });
  return { done, release: () => gate.resolve() };
}

/** The confirmation modal call, told apart from a bare refusal by its `{ modal: true }` options. */
function modalCalls(): unknown[][] {
  return mockShowWarningMessage.mock.calls.filter((call) => {
    const options = call[1];
    return typeof options === "object" && options !== null && (options as { modal?: boolean }).modal === true;
  });
}

/** Every non-modal warning — the refusals this fix introduces. */
function refusals(): string[] {
  return mockShowWarningMessage.mock.calls.filter((call) => call.length === 1).map((call) => String(call[0]));
}

/**
 * REMOVE-MUTATION-RACE FAMILY — nexus.localShell.remove named a profile sampled
 * before its confirmation modal and then closed its terminals and deleted it by
 * id from that pre-modal copy: no lock, no presence re-check, no revalidation of
 * what had been disclosed.
 *
 * Every concurrent operation below is GATED — it parks in a deferred modal or
 * inside the lock and is released by the test — so it is guaranteed to land in
 * the window under test rather than usually winning a race. Each assertion is on
 * PERSISTED state (the repository behind NexusCore), not on a modal having been
 * shown.
 */
describe("nexus.localShell.remove — the disclosure is re-checked under the lock (REMOVE-MUTATION-RACE FAMILY)", () => {
  async function fixture(profiles: LocalShellProfile[]): Promise<{
    core: NexusCore;
    repo: InMemoryConfigRepository;
    dispose: ReturnType<typeof vi.fn>;
    localShellTerminals: Map<string, { terminal: { dispose: () => void }; profileId: string }>;
  }> {
    const repo = new InMemoryConfigRepository([], [], [], [], [], profiles);
    const core = new NexusCore(repo);
    await core.initialize();
    const dispose = vi.fn();
    const localShellTerminals = new Map<string, { terminal: { dispose: () => void }; profileId: string }>();
    localShellTerminals.set("session-1", { terminal: { dispose }, profileId: "local-1" });
    const ctx = {
      core,
      localShellTerminals,
      extensionPath: "/ext",
      globalStoragePath: "/gs",
      globalState: { get: vi.fn(() => false), update: vi.fn() },
      highlighter: {},
      macroAutoTrigger: { createObserver: vi.fn() }
    } as unknown as CommandContext;
    registerLocalShellCommands(ctx);
    return { core, repo, dispose, localShellTerminals };
  }

  function removeLocalShell(id: string): Promise<unknown> {
    const cmd = registeredCommands.get("nexus.localShell.remove");
    expect(cmd).toBeDefined();
    return Promise.resolve(cmd!(id));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    closeTerminalListeners.length = 0;
  });

  it("removes the profile — closing its session terminal and persisting the deletion — when nothing changed while the confirmation was open", async () => {
    const { repo, dispose, localShellTerminals } = await fixture([
      makeProfile(),
      makeProfile({ id: "local-2", name: "Ops" })
    ]);
    mockShowWarningMessage.mockResolvedValue("Remove");

    await removeLocalShell("local-1");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(localShellTerminals.size).toBe(0);
    expect((await repo.getLocalShellProfiles()).map((p) => p.id)).toEqual(["local-2"]);
    expect(refusals()).toEqual([]);
  });

  it("refuses when the profile was renamed while the confirmation was open, rather than deleting a profile under a name the user never agreed to (kills a presence-only re-check)", async () => {
    const { core, repo, dispose } = await fixture([makeProfile()]);

    const modal = deferred<string>();
    mockShowWarningMessage.mockReturnValueOnce(modal.promise);
    const run = removeLocalShell("local-1");
    await settle();
    expect(modalCalls()[0][0]).toBe('Remove local shell profile "Dev" and close all sessions?');

    // Still present under the same id — a presence-only guard sees "yes, still
    // there" and deletes the renamed record, terminals and all.
    await core.addOrUpdateLocalShellProfile({ ...core.getLocalShellProfile("local-1")!, name: "Build Box" });

    modal.resolve("Remove");
    await run;

    expect((await repo.getLocalShellProfiles()).map((p) => p.name)).toEqual(["Build Box"]);
    expect(dispose).not.toHaveBeenCalled();
    // Quoted by the name the MODAL used, not the new one.
    expect(refusals()).toEqual([
      'Local shell profile "Dev" changed while the confirmation was open — ' +
        "nothing was removed. Remove it again to review the current details."
    ]);
  });

  it("reports that the profile was already removed, and does not mistake that for a changed disclosure, when it was deleted while the confirmation was open (kills re-rendering the disclosure off a record that is no longer there)", async () => {
    const { core, repo, dispose } = await fixture([makeProfile(), makeProfile({ id: "local-2", name: "Ops" })]);

    const modal = deferred<string>();
    mockShowWarningMessage.mockReturnValueOnce(modal.promise);
    const run = removeLocalShell("local-1");
    await settle();

    // A replace-mode import's wipe (configCommands' importMergeReplaceLocked
    // deletes every existing profile by id) lands while the modal sits open.
    await core.removeLocalShellProfile("local-1");

    modal.resolve("Remove");
    // The presence re-check has to come FIRST inside the lock: a disclosure
    // re-render that assumes the record is still there dereferences
    // `undefined.name` and rejects this promise with a TypeError.
    await expect(run).resolves.toBeUndefined();

    expect(dispose).not.toHaveBeenCalled();
    expect((await repo.getLocalShellProfiles()).map((p) => p.id)).toEqual(["local-2"]);
    expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalledWith(
      'Local shell profile "Dev" was already removed.'
    );
    expect(refusals()).toEqual([]);
  });

  it("queues its whole mutation behind an in-flight locked section and refuses when that section renamed the profile (kills the lock-free close+delete, which commits before any concurrent holder can)", async () => {
    const { core, repo, dispose } = await fixture([makeProfile()]);
    mockShowWarningMessage.mockResolvedValue("Remove");

    // A replace-mode import / complete reset stand-in: already inside the lock,
    // still awaiting its own I/O.
    const gated = gatedLockedWrite(configMutationLock, async () => {
      await core.addOrUpdateLocalShellProfile({ ...core.getLocalShellProfile("local-1")!, name: "Build Box" });
    });
    await settle();

    const run = removeLocalShell("local-1");
    await settle();

    // THE KILL. The modal has already answered, so a lock-free implementation has
    // finished closing and deleting by now — before the holder it should be queued
    // behind has even started its body.
    expect(modalCalls()).toHaveLength(1);
    expect((await repo.getLocalShellProfiles()).map((p) => p.id)).toEqual(["local-1"]);
    expect(dispose).not.toHaveBeenCalled();

    gated.release();
    await gated.done;
    await run;

    expect((await repo.getLocalShellProfiles()).map((p) => p.name)).toEqual(["Build Box"]);
    expect(dispose).not.toHaveBeenCalled();
    expect(refusals()).toEqual([
      'Local shell profile "Dev" changed while the confirmation was open — ' +
        "nothing was removed. Remove it again to review the current details."
    ]);
  });
});
