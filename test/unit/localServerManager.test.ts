/**
 * @author kanekitakitos
 *
 * Unit tests for LocalServerManager: workspace-trust gating, typed error
 * codes, single-flight enforcement, and lexical scope validation for
 * workspace-relative cwds.
 *
 * PTY spawning / auto-restart backoff integration is deliberately NOT
 * exercised here: those paths are gated by the Rust sidecar binary and
 * are covered by the smokeLocalPty + localShellPty suites (same native
 * sidecar). This module only tests the manager's *policy* layer — the
 * same layer that throws LocalServerError before any child process is
 * ever created.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import type { LocalServerConfig } from "../../src/models/localServer";
import { LocalServerError } from "../../src/models/localServer";
import { LocalServerManager } from "../../src/services/local/localServerManager";
import { LocalShellPty } from "../../src/services/local/localShellPty";

function normalizeMockPath(value: string): string {
  return value.replace(/\//g, "\\").toLowerCase();
}

const mockPathExists = vi.hoisted(() => new Set<string>());
const mockConfig = vi.hoisted(() => new Map<string, unknown>());
const createTerminalMock = vi.fn(() => ({
  show: vi.fn(),
  dispose: vi.fn(),
  processId: Promise.resolve(9999),
  creationOptions: { name: "Nexus" }
}));

const mockStatEntries = vi.hoisted(() => new Map<string, "dir" | "file">());

vi.mock("node:fs", () => ({
  existsSync: (value: string) => mockPathExists.has(normalizeMockPath(String(value))),
  statSync: (value: string) => {
    const kind = mockStatEntries.get(normalizeMockPath(String(value)));
    if (!kind) {
      const err = new Error(`ENOENT: no such file or directory, stat '${value}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    }
    return {
      isDirectory: () => kind === "dir",
      isFile: () => kind === "file"
    };
  }
}));

// Replace the LocalShellPty class itself with a no-op that still exposes
// the event handlers the manager wires up. This keeps the suite focused
// on the manager's input validation / policy layer and side-steps the
// native binary requirement.
vi.mock("../../src/services/local/localShellPty", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/local/localShellPty")>();
  return {
    ...actual,
    resolveLocalPtySidecarPath: (extPath: string) =>
      path.join(extPath, "dist", "native", "local-pty", "test-arch", "nexus-local-pty-mock"),
    LocalShellPty: vi.fn(function MockLocalShellPty() {
      const handlers = new Map<string, Array<(e?: unknown) => void>>();
      return {
        onDidWrite: vi.fn((l: () => void) => {
          if (!handlers.has("write")) handlers.set("write", []);
          handlers.get("write")!.push(l);
          return { dispose: vi.fn() };
        }),
        onDidClose: vi.fn((l: () => void) => {
          if (!handlers.has("close")) handlers.set("close", []);
          handlers.get("close")!.push(l);
          return { dispose: vi.fn() };
        }),
        onDidTerminateEarly: vi.fn((l: () => void) => {
          if (!handlers.has("term")) handlers.set("term", []);
          handlers.get("term")!.push(l);
          return { dispose: vi.fn() };
        }),
        onDidStartupComplete: vi.fn((l: () => void) => {
          if (!handlers.has("startup")) handlers.set("startup", []);
          handlers.get("startup")!.push(l);
          queueMicrotask(() => l());
          return { dispose: vi.fn() };
        }),
        open: vi.fn(),
        close: vi.fn(),
        handleInput: vi.fn(),
        setDimensions: vi.fn(),
        markShuttingDown: vi.fn(),
        lockInput: vi.fn(),
        resetState: vi.fn(),
        dispose: vi.fn()
      };
    })
  };
});

vi.mock("vscode", () => {
  const listeners: Array<(t: unknown) => void> = [];
  return {
    EventEmitter: class<T> {
      private readonly ls: Array<(e: T) => void> = [];
      public event = (l: (e: T) => void) => {
        this.ls.push(l);
        return { dispose: vi.fn() };
      };
      public fire(e: T): void {
        for (const l of this.ls) l(e);
      }
    },
    Disposable: class {
      public constructor(private readonly fn: () => void) {}
      public dispose(): void {
        this.fn();
      }
    },
    TerminalLocation: { Panel: 1 },
    Pseudoterminal: class {},
    commands: { executeCommand: vi.fn() },
    window: {
      createTerminal: (..._args: unknown[]) => createTerminalMock(..._args),
      onDidCloseTerminal: (l: (t: unknown) => void) => {
        listeners.push(l);
        return { dispose: vi.fn() };
      },
      showErrorMessage: vi.fn()
    },
    workspace: {
      get isTrusted() {
        return mockConfig.get("isTrusted") ?? true;
      },
      get workspaceFolders() {
        const folders = mockConfig.get("workspaceFolders");
        if (folders === undefined) return undefined;
        return folders as Array<{ uri: { fsPath: string } }>;
      },
      getConfiguration: (_section: string) => ({
        get: <T>(key: string, fallback: T): T => {
          const value = mockConfig.get(key);
          return (value === undefined ? fallback : value) as T;
        }
      })
    },
    ThemeColor: class {},
    ThemeIcon: class { public constructor(_id: string, _color?: unknown) {} }
  };
});

function fakeCore() {
  return {
    updateLocalServerSessionStatus: vi.fn(),
    setLocalServerLastExitCode: vi.fn(),
    registerLocalServerSession: vi.fn(),
    unregisterLocalServerSession: vi.fn(),
    incrementLocalServerRestartAttempts: vi.fn(() => 1),
    resetLocalServerRestartAttempts: vi.fn(),
    getActiveSessionById: vi.fn(() => undefined),
    getLocalServer: vi.fn()
  } as any;
}

function fakeManager(overrides?: Partial<ConstructorParameters<typeof LocalServerManager>[0]>) {
  return new LocalServerManager({
    core: fakeCore(),
    extensionPath: "/tmp/nexus-ext",
    terminals: new Map(),
    terminalRegistry: undefined as any,
    outputChannel: { appendLine: vi.fn() },
    highlighter: undefined as any,
    diagnostics: vi.fn(),
    ...overrides
  });
}

function baseConfig(partial: Partial<LocalServerConfig> = {}): LocalServerConfig {
  return {
    id: "cfg-1",
    name: "Test Server",
    executable: "node",
    ...partial
  };
}

describe("LocalServerManager — workspace trust gating", () => {
  beforeEach(() => {
    mockConfig.clear();
    mockPathExists.clear();
  });

  it("refuses start() with WorkspaceUntrusted when workspace.isTrusted === false", () => {
    mockConfig.set("isTrusted", false);
    const manager = fakeManager();
    const promise = manager.start(baseConfig());
    return expect(promise).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LocalServerError);
      expect((err as LocalServerError).code).toBe("WorkspaceUntrusted");
      return true;
    });
  });

  it("allows start() to proceed past trust gating when workspace.isTrusted === true", () => {
    mockConfig.set("isTrusted", true);
    // Use a bare command so ExecutableNotFound does not fire. The PTY
    // layer is mocked above so no binary is actually resolved.
    const manager = fakeManager();
    return expect(manager.start(baseConfig())).resolves.toBeTypeOf("string");
  });
});

function markAsDir(p: string): void {
  mockPathExists.add(normalizeMockPath(p));
  mockStatEntries.set(normalizeMockPath(p), "dir");
}
function markAsFile(p: string): void {
  mockPathExists.add(normalizeMockPath(p));
  mockStatEntries.set(normalizeMockPath(p), "file");
}

describe("LocalServerManager — input validation & typed error codes", () => {
  beforeEach(() => {
    mockConfig.clear();
    mockPathExists.clear();
    mockStatEntries.clear();
    mockConfig.set("isTrusted", true);
  });

  it("throws ExecutableNotFound when the executable is an explicit path that does not exist", () => {
    const cfg = baseConfig({ executable: "/opt/nonexistent/bin/server" });
    const manager = fakeManager();
    return expect(manager.start(cfg)).rejects.toSatisfy((err: unknown) => {
      expect((err as LocalServerError).code).toBe("ExecutableNotFound");
      return true;
    });
  });

  it("treats bare command names (no separators / drive letter) as PATH lookups and skips the path-exists check", () => {
    const cfg = baseConfig({ executable: "python3" });
    const manager = fakeManager();
    return expect(manager.start(cfg)).resolves.toBeTypeOf("string");
  });

  it("throws PathOutsideScope when restrictToWorkspaceRoots=true and cwd escapes lexical scope", () => {
    const root = path.resolve(os.tmpdir(), "nexus-workspace");
    mockConfig.set("workspaceFolders", [{ uri: { fsPath: root } }]);
    mockConfig.set("nexus.localServers.restrictToWorkspaceRoots", true);
    // Using path.resolve we still need the raw ".." segments to be lexically
    // outside the root; "../../outside-root" is scope-escaping by design.
    const cfg = baseConfig({
      executable: "node",
      cwd: path.join(root, "..", "..", "outside-root")
    });
    const manager = fakeManager();
    return expect(manager.start(cfg)).rejects.toSatisfy((err: unknown) => {
      expect((err as LocalServerError).code).toBe("PathOutsideScope");
      return true;
    });
  });

  it("allows cwd inside workspace roots when restrictToWorkspaceRoots=true", () => {
    const root = path.resolve(os.tmpdir(), "nexus-workspace-2");
    mockConfig.set("workspaceFolders", [{ uri: { fsPath: root } }]);
    mockConfig.set("nexus.localServers.restrictToWorkspaceRoots", true);
    const cwd = path.join(root, "apps", "api");
    markAsDir(cwd);
    const cfg = baseConfig({ executable: "node", cwd });
    const manager = fakeManager();
    return expect(manager.start(cfg)).resolves.toBeTypeOf("string");
  });

  it("throws ServerAlreadyRunning on the second start() for the same config id", async () => {
    const manager = fakeManager();
    const cfg = baseConfig();
    const first = await manager.start(cfg);
    expect(first).toBeTypeOf("string");
    return expect(manager.start(cfg)).rejects.toSatisfy((err: unknown) => {
      expect((err as LocalServerError).code).toBe("ServerAlreadyRunning");
      return true;
    });
  });
});

describe("LocalServerManager — placeholder expansion (resolveLocalServerLaunchOptions)", () => {
  beforeEach(() => {
    mockConfig.clear();
    mockPathExists.clear();
    mockStatEntries.clear();
    mockConfig.set("isTrusted", true);
  });

  it("expands ~ to os.homedir() at the start of executable paths", async () => {
    const exe = path.join(os.homedir(), "bin", "node");
    const cwd = path.join(os.homedir(), "projects", "demo");
    markAsFile(exe);
    markAsDir(cwd);
    const manager = fakeManager();
    const cfg = baseConfig({ executable: path.join("~", "bin", "node"), cwd });
    await expect(manager.start(cfg)).resolves.toBeTypeOf("string");
  });

  it("expands ${workspaceFolder} to the first workspace folder", async () => {
    const root = path.resolve(os.tmpdir(), "nexus-expand");
    mockConfig.set("workspaceFolders", [{ uri: { fsPath: root } }]);
    const cwd = path.join(root, "services", "web");
    markAsDir(cwd);
    const manager = fakeManager();
    const cfg = baseConfig({ executable: "node", cwd: "${workspaceFolder}/services/web" });
    await expect(manager.start(cfg)).resolves.toBeTypeOf("string");
  });

  it("expands ${env:VAR} references against the real process.env", async () => {
    const marker = `nexus-test-${Date.now()}`;
    process.env.__NEXUS_TEST_MARKER__ = marker;
    try {
      const manager = fakeManager();
      // Simple case — args contains the env var. Exercising the branch
      // without throwing confirms the substitution path ran before the
      // policy layer returned.
      const cfg = baseConfig({ executable: "node", args: ["--env=${env:__NEXUS_TEST_MARKER__}"] });
      await expect(manager.start(cfg)).resolves.toBeTypeOf("string");
    } finally {
      delete process.env.__NEXUS_TEST_MARKER__;
    }
  });
});

describe("LocalServerManager — lifecycle cleanup (dispose / stopAll)", () => {
  beforeEach(() => {
    mockConfig.clear();
    mockPathExists.clear();
    mockStatEntries.clear();
    mockConfig.set("isTrusted", true);
  });

  it("stopAll() runs cleanly even when no sessions are running", () => {
    const manager = fakeManager();
    expect(() => manager.stopAll()).not.toThrow();
  });

  it("dispose() is idempotent and never throws", () => {
    const manager = fakeManager();
    manager.dispose();
    expect(() => manager.dispose()).not.toThrow();
  });
});

/**
 * THE ENV TEXTAREA'S THREE-STATE CONTRACT, END TO END.
 *
 * `splitEnvFromTextarea` records three distinct intents — `KEY=null` unsets,
 * `KEY=undefined` inherits, `KEY=` sets an empty string — and the sidecar wire
 * format preserves all three (JSON.stringify drops `undefined` keys, keeps
 * `null`, keeps `""`). Between them sits `expandEnv`, and `expandValue` maps a
 * blank string to `undefined`: an empty string handed in came out the far side
 * as "inherit", the one state it was not. Fixing only the parser would have
 * left `KEY=` still unexpressible, so this asserts what the PTY is actually
 * handed rather than what the parser produced.
 */
describe("LocalServerManager — env pass-through preserves unset / inherit / empty-string", () => {
  beforeEach(() => {
    mockConfig.clear();
    mockPathExists.clear();
    mockStatEntries.clear();
    mockConfig.set("isTrusted", true);
    vi.mocked(LocalShellPty).mockClear();
  });

  it("hands the pty an empty string for KEY=, null for an unset, and undefined for an inherit", async () => {
    const manager = fakeManager();
    await manager.start(
      baseConfig({
        executable: "node",
        env: { EMPTY: "", WILDCARD: null, INHERIT: undefined, REAL: "value" }
      })
    );

    const options = vi.mocked(LocalShellPty).mock.calls[0][0] as {
      env?: Record<string, string | null | undefined>;
    };
    expect(options.env).toBeDefined();
    // The regression: this was `undefined` before, i.e. indistinguishable from
    // INHERIT, so `KEY=` could never set a variable to "".
    expect(options.env!.EMPTY).toBe("");
    expect(options.env!.WILDCARD).toBeNull();
    expect(options.env!.INHERIT).toBeUndefined();
    expect(options.env!.REAL).toBe("value");
  });

  it("keeps the three states distinct once serialized for the sidecar", async () => {
    const manager = fakeManager();
    await manager.start(
      baseConfig({ executable: "node", env: { EMPTY: "", WILDCARD: null, INHERIT: undefined } })
    );
    const options = vi.mocked(LocalShellPty).mock.calls[0][0] as { env?: Record<string, unknown> };
    // This is exactly what LocalShellPty.sendFrame writes: `undefined` drops
    // out (inherit), `null` survives (unset), `""` survives (set to empty).
    const onTheWire = JSON.parse(JSON.stringify({ env: options.env })) as {
      env: Record<string, unknown>;
    };
    expect(Object.prototype.hasOwnProperty.call(onTheWire.env, "INHERIT")).toBe(false);
    expect(onTheWire.env.WILDCARD).toBeNull();
    expect(onTheWire.env.EMPTY).toBe("");
  });
});

/**
 * STOPPING A SERVER THAT IS MID-BACKOFF.
 *
 * When an auto-restart profile crashes, handleExit() schedules a retry (up to
 * a 30s backoff) and cleanupSession() unregisters the session. For that whole
 * window the config has no session and no terminal entry, so it reads as "not
 * running" everywhere — while a timer is quietly waiting to spawn it again.
 *
 * `start()` has always called that timer off, which is why palette Restart
 * behaved. Nothing else did, so a Stop issued during the window reported "not
 * running" and returned, and the process came back seconds later.
 */
describe("LocalServerManager — cancelPendingRestart", () => {
  beforeEach(() => {
    mockConfig.clear();
    mockPathExists.clear();
    mockStatEntries.clear();
    mockConfig.set("isTrusted", true);
    vi.mocked(LocalShellPty).mockClear();
    createTerminalMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Fires the pty's close listener for the Nth spawn, as a crash would. */
  function crash(spawnIndex: number, code: number): void {
    const pty = vi.mocked(LocalShellPty).mock.results[spawnIndex].value as {
      onDidClose: { mock: { calls: Array<[(code: number) => void]> } };
    };
    pty.onDidClose.mock.calls[0][0](code);
  }

  async function startCrashLooping(): Promise<{ manager: LocalServerManager; core: ReturnType<typeof fakeCore> }> {
    const core = fakeCore();
    core.getLocalServer = vi.fn(() => baseConfig({ autoRestart: true }));
    const manager = fakeManager({ core, terminals: new Map() });
    await manager.start(baseConfig({ autoRestart: true }));
    crash(0, 1);
    return { manager, core };
  }

  it("respawns after the backoff when nothing calls the restart off", async () => {
    // The control case. Without it, the assertion below cannot tell a
    // cancelled restart apart from a restart that was never scheduled.
    vi.useFakeTimers();
    await startCrashLooping();
    expect(createTerminalMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(createTerminalMock).toHaveBeenCalledTimes(2);
  });

  it("reports that a restart was pending, and keeps the process from coming back", async () => {
    vi.useFakeTimers();
    const { manager } = await startCrashLooping();
    expect(manager.cancelPendingRestart("cfg-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(createTerminalMock).toHaveBeenCalledTimes(1);
  });

  it("reports false when there was nothing pending, so a caller can tell the two apart", () => {
    const manager = fakeManager();
    expect(manager.cancelPendingRestart("cfg-1")).toBe(false);
  });

  it("is what start() uses, so a user-initiated start still pre-empts a pending retry", async () => {
    vi.useFakeTimers();
    const { manager } = await startCrashLooping();
    await manager.start(baseConfig({ autoRestart: true }));
    expect(createTerminalMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    // The scheduled retry must not add a third terminal on top of the manual start.
    expect(createTerminalMock).toHaveBeenCalledTimes(2);
  });
});
