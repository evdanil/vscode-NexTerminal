/**
 * @author kanekitakitos
 *
 * Integration tests for the LocalServerManager lifecycle in collaboration
 * with the NexusCore event hub.
 *
 * Scope:
 *  - Happy path: start() → session registered → startup completes →
 *    stable runtime → user-initiated stop() → session unregistered.
 *  - Auto-restart loop: early crash (before stableRuntimeMs) triggers
 *    exponential back-off + incrementRestartAttempts up to maxAutoRestarts.
 *  - Restart integration: mid-flight stop() followed by restart() reuses
 *    the same configId and resets the restart counter.
 *  - Workspace trust gating (integration): when isTrusted flips mid-test,
 *    start() refuses AND no core state is mutated at all.
 *  - Terminal close wire-up: closing a terminal that belongs to a local
 *    server session via wireLocalServerTerminalCloseListener() ends the
 *    session cleanly (no orphan listeners).
 *
 * The native PTY sidecar is intentionally NOT exercised; we replace
 * LocalShellPty with a deterministic fake (constructor spy + event
 * sequencer). That still qualifies as integration because we exercise
 * the manager's real state machine, core event emission, and the
 * terminal-close listener cross-cutting concern.
 */

import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalServerConfig } from "../../src/models/localServer";
import { LocalServerError } from "../../src/models/localServer";
import type { LocalShellEarlyTerminationEvent } from "../../src/services/local/localShellPty";
import { LocalServerManager, wireLocalServerTerminalCloseListener } from "../../src/services/local/localServerManager";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";

function norm(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}

const mockPathExists = vi.hoisted(() => new Set<string>());
const mockStat = vi.hoisted(() => new Map<string, "dir" | "file">());
const mockConfig = vi.hoisted(() => new Map<string, unknown>());
const createTerminalMock = vi.fn((options?: { pty?: { close?: () => void } }) => ({
  show: vi.fn(),
  // Real VS Code calls the associated Pseudoterminal's close() when a
  // terminal backed by one is disposed; mirror that here so tests can
  // observe pty-level effects of terminal.dispose().
  dispose: vi.fn(() => options?.pty?.close?.()),
  processId: Promise.resolve(4242),
  creationOptions: { name: "Nexus" }
}));
const closeTerminalListeners: Array<(t: unknown) => void> = [];

vi.mock("node:fs", () => ({
  existsSync: (v: string) => mockPathExists.has(norm(String(v))),
  statSync: (v: string) => {
    const k = norm(String(v));
    const kind = mockStat.get(k);
    if (!kind) {
      const e = new Error(`ENOENT: ${v}`);
      (e as NodeJS.ErrnoException).code = "ENOENT";
      throw e;
    }
    return {
      isDirectory: () => kind === "dir",
      isFile: () => kind === "file"
    };
  }
}));

type PtyInstance = ReturnType<typeof makeFakePty>;
const spawnedPtys: PtyInstance[] = [];

function makeFakePty() {
  const handlers = new Map<string, Array<(e?: unknown) => void>>();
  const inst = {
    disposed: false,
    closed: false,
    markShuttingDownCalled: false,
    handleInputCalls: [] as string[],
    on: (evt: string, l: (e?: unknown) => void) => {
      if (!handlers.has(evt)) handlers.set(evt, []);
      handlers.get(evt)!.push(l);
      return { dispose: vi.fn() };
    },
    fire: (evt: string, payload?: unknown) => {
      for (const l of handlers.get(evt) ?? []) l(payload);
    },
    onDidWrite: (l: (e?: unknown) => void) => inst.on("write", l),
    onDidClose: (l: (e?: unknown) => void) => inst.on("close", l),
    onDidTerminateEarly: (l: (e?: unknown) => void) => inst.on("term", l),
    onDidStartupComplete: (l: (e?: unknown) => void) => inst.on("startup", l),
    open: vi.fn(),
    close: () => { inst.closed = true; },
    handleInput: (d: string) => { inst.handleInputCalls.push(d); },
    setDimensions: vi.fn(),
    markShuttingDown: () => { inst.markShuttingDownCalled = true; },
    lockInput: vi.fn(),
    resetState: vi.fn(),
    dispose: () => { inst.disposed = true; }
  };
  return inst;
}

vi.mock("../../src/services/local/localShellPty", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/local/localShellPty")>();
  return {
    ...actual,
    resolveLocalPtySidecarPath: (extPath: string) =>
      path.join(extPath, "dist", "native", "local-pty", "integration", "nexus-local-pty-fake"),
    LocalShellPty: vi.fn(function FakeLocalShellPty() {
      const pty = makeFakePty();
      spawnedPtys.push(pty);
      return pty;
    })
  };
});

vi.mock("vscode", () => ({
  EventEmitter: class<T> {
    private readonly ls: Array<(e: T) => void> = [];
    public event = (l: (e: T) => void) => { this.ls.push(l); return { dispose: vi.fn() }; };
    public fire(e: T): void { for (const l of this.ls) l(e); }
  },
  Disposable: class {
    public constructor(private readonly fn: () => void) {}
    public dispose(): void { this.fn(); }
  },
  TerminalLocation: { Panel: 1, Editor: 2 },
  Pseudoterminal: class {},
  commands: { executeCommand: vi.fn() },
  window: {
    createTerminal: (...a: unknown[]) => createTerminalMock(...a),
    onDidCloseTerminal: (l: (t: unknown) => void) => {
      closeTerminalListeners.push(l);
      return { dispose: vi.fn(() => { const i = closeTerminalListeners.indexOf(l); if (i >= 0) closeTerminalListeners.splice(i, 1); }) };
    },
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn()
  },
  workspace: {
    get isTrusted() { return mockConfig.get("isTrusted") ?? true; },
    get workspaceFolders() {
      const f = mockConfig.get("workspaceFolders");
      return f === undefined ? undefined : (f as Array<{ uri: { fsPath: string } }>);
    },
    getConfiguration: (_sec: string) => ({
      get: <T>(k: string, fb: T): T => {
        const v = mockConfig.get(k);
        return (v === undefined ? fb : v) as T;
      }
    })
  },
  ThemeColor: class {},
  ThemeIcon: class { public constructor(_id: string, _c?: unknown) {} }
}));

function markDir(p: string): void {
  mockPathExists.add(norm(p));
  mockStat.set(norm(p), "dir");
}
function markFile(p: string): void {
  mockPathExists.add(norm(p));
  mockStat.set(norm(p), "file");
}

function makeCoreSpy() {
  return {
    updateLocalServerSessionStatus: vi.fn(),
    setLocalServerLastExitCode: vi.fn(),
    registerLocalServerSession: vi.fn(),
    unregisterLocalServerSession: vi.fn(),
    incrementLocalServerRestartAttempts: vi.fn((_id: string) => 1),
    resetLocalServerRestartAttempts: vi.fn(),
    getActiveSessionById: vi.fn(() => undefined),
    // Must answer, or every scheduled restart aborts: retryStart now refuses to
    // respawn a profile that has been deleted mid-backoff.
    getLocalServer: vi.fn((id: string) => ({ id, name: "spy", executable: "node" }))
  } as any;
}

function makeManager(core: any, overrides: Partial<ConstructorParameters<typeof LocalServerManager>[0]> = {}) {
  return new LocalServerManager({
    core,
    extensionPath: "/tmp/nexus-ext-integration",
    terminals: new Map(),
    terminalRegistry: undefined as any,
    outputChannel: { appendLine: vi.fn(), show: vi.fn() },
    highlighter: undefined as any,
    diagnostics: vi.fn(),
    ...overrides
  });
}

function baseConfig(partial: Partial<LocalServerConfig> = {}): LocalServerConfig {
  return {
    id: "cfg-int-1",
    name: "Integration Server",
    executable: "node",
    ...partial
  };
}

beforeEach(() => {
  mockConfig.clear();
  mockPathExists.clear();
  mockStat.clear();
  spawnedPtys.length = 0;
  closeTerminalListeners.length = 0;
  mockConfig.set("isTrusted", true);
  // Stable runtime default to 10 ms for fast integration tests
  mockConfig.set("nexus.localServers.stableRuntimeMs", 10);
  mockConfig.set("nexus.localServers.initialBackoffMs", 1);
  mockConfig.set("nexus.localServers.maxBackoffMs", 5);
  mockConfig.set("nexus.localServers.defaultMaxAutoRestarts", 2);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("LocalServerManager integration (lifecycle + core hub + trust gating)", () => {
  it("happy path: start → register → startup complete → stable → stop unregisters", async () => {
    vi.useFakeTimers();
    const core = makeCoreSpy();
    const manager = makeManager(core);
    const cfg = baseConfig();

    const sessionId = await manager.start(cfg);
    expect(typeof sessionId).toBe("string");
    expect(core.registerLocalServerSession).toHaveBeenCalledTimes(1);
    expect(core.registerLocalServerSession.mock.calls[0][0].configId).toBe(cfg.id);
    expect(spawnedPtys).toHaveLength(1);
    const pty = spawnedPtys[0];

    // Simulate sidecar signalling startup done (stable timer is scheduled here)
    pty.fire("startup");
    expect(core.updateLocalServerSessionStatus).toHaveBeenCalled();

    // Fast-forward past LOCAL_SERVER_STABLE_RUN_MS (10s hardcoded constant)
    vi.advanceTimersByTime(10_500);
    await Promise.resolve();
    expect(core.resetLocalServerRestartAttempts).toHaveBeenCalledWith(sessionId);
    vi.useRealTimers();

    // User-initiated stop
    await manager.stop(sessionId, true);
    expect(pty.markShuttingDownCalled).toBe(true);
    // Manager issues close; simulate the real PTY firing onDidClose afterwards
    pty.fire("close", 0);
    expect(core.setLocalServerLastExitCode).toHaveBeenCalledWith(sessionId, 0);
    expect(core.unregisterLocalServerSession).toHaveBeenCalledWith(sessionId);

    manager.dispose();
    expect(pty.closed).toBe(true);
  });

  // NOTE: this exercises the spy, which fabricates the increment the real core
  // declines to perform on an unregistered session — so it cannot observe the
  // cap failing. "stops restarting a crash-looping server at the configured
  // cap" below covers the same ground against the real NexusCore, and is the
  // one that fails if the cap regresses.
  it("early crash triggers auto-restart with backoff, respecting max attempts", async () => {
    vi.useFakeTimers();
    const core = makeCoreSpy();
    core.incrementLocalServerRestartAttempts = vi.fn((_id: string) => {
      const last = (core.incrementLocalServerRestartAttempts as any).callCount;
      return last;
    });
    const manager = makeManager(core);
    const cfg = baseConfig({ autoRestart: true, maxAutoRestarts: 2 });

    await manager.start(cfg);
    expect(spawnedPtys).toHaveLength(1);

    // Simulate crash within stable window (before startup complete OR before
    // stable window elapses; we terminateEarly to signal an unclean death)
    const first = spawnedPtys[0];
    first.fire("term", { code: 1, stable: false } as LocalShellEarlyTerminationEvent);

    // Backoff is 500ms on the first retry and doubles from there, so the
    // window has to be generous. The original 6 x 50ms encoded the broken
    // schedule: attempts never incremented, so the delay was a constant
    // 500 * 2^-1 = 250ms and 300ms was enough to catch one.
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    // Total spawns: initial + 2 restarts (maxAutoRestarts=2) = 3
    expect(spawnedPtys.length).toBeGreaterThanOrEqual(2);
    expect(spawnedPtys.length).toBeLessThanOrEqual(3);
    // The count lives on the manager now, keyed by config: a per-session
    // counter restarts at zero with each new session and can never reach a cap.
    expect(core.updateLocalServerSessionStatus).toHaveBeenCalledWith(expect.any(String), "restarting");

    manager.dispose();
  });

  it("stops restarting a crash-looping server at the configured cap", async () => {
    // Against the REAL core, not a spy. The spy fabricates the increment that
    // the real core declines to perform on an unregistered session, which is
    // precisely the bug — so a mocked core cannot see this and the existing
    // cap test passes only because its fake ptys never crash twice.
    vi.useFakeTimers();
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    const cfg = baseConfig({ autoRestart: true, maxAutoRestarts: 2 });
    await core.addOrUpdateLocalServerConfig(cfg);
    const manager = makeManager(core);

    await manager.start(cfg);

    // Crash every process the manager spawns, as a broken executable would.
    for (let round = 0; round < 20; round += 1) {
      const pty = spawnedPtys[spawnedPtys.length - 1];
      if (!pty || pty.closed) break;
      pty.fire("term", { code: 1, stable: false } as LocalShellEarlyTerminationEvent);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    vi.useRealTimers();

    // One initial start plus at most `maxAutoRestarts` retries.
    expect(spawnedPtys.length).toBeLessThanOrEqual(3);

    manager.dispose();
  });

  it("keeps a crash-looping server visible as failed rather than silently stopped", async () => {
    // The status writes ran after the session had been unregistered, so they
    // were no-ops: the tree showed "stopped" while the loop ran, and the
    // `failed` state the provider draws could never be reached.
    vi.useFakeTimers();
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    const cfg = baseConfig({ autoRestart: true, maxAutoRestarts: 1 });
    await core.addOrUpdateLocalServerConfig(cfg);
    const manager = makeManager(core);
    const statuses: string[] = [];
    core.onDidChange(() => {
      for (const s of core.getSnapshot().activeLocalServerSessions) statuses.push(s.status);
    });

    await manager.start(cfg);
    for (let round = 0; round < 4; round += 1) {
      const pty = spawnedPtys[spawnedPtys.length - 1];
      if (!pty || pty.closed) break;
      pty.fire("term", { code: 1, stable: false } as LocalShellEarlyTerminationEvent);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    vi.useRealTimers();

    expect(statuses).toContain("failed");

    manager.dispose();
  });

  it("workspace trust gating: manager refuses AND never mutates core", async () => {
    const core = makeCoreSpy();
    mockConfig.set("isTrusted", false);
    const manager = makeManager(core);
    const cfg = baseConfig();

    const promise = manager.start(cfg);
    await expect(promise).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(LocalServerError);
      expect((e as LocalServerError).code).toBe("WorkspaceUntrusted");
      return true;
    });

    expect(spawnedPtys).toHaveLength(0);
    expect(core.registerLocalServerSession).not.toHaveBeenCalled();
    expect(core.updateLocalServerSessionStatus).not.toHaveBeenCalled();
    expect(core.incrementLocalServerRestartAttempts).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("stopAll() terminates every active session and is idempotent", async () => {
    const core = makeCoreSpy();
    const manager = makeManager(core);
    const cfgA = baseConfig({ id: "a" });
    const cfgB = baseConfig({ id: "b", executable: "python3" });

    await manager.start(cfgA);
    await manager.start(cfgB);
    expect(spawnedPtys).toHaveLength(2);

    expect(() => manager.stopAll()).not.toThrow();
    for (const p of spawnedPtys) {
      expect(p.markShuttingDownCalled).toBe(true);
    }

    expect(() => manager.stopAll()).not.toThrow();
    expect(() => manager.dispose()).not.toThrow();
    expect(() => manager.dispose()).not.toThrow();
  });

  it("restart() on a running config spawns a fresh PTY and returns a session id", async () => {
    vi.useFakeTimers();
    const core = makeCoreSpy();
    const manager = makeManager(core);
    const cfg = baseConfig();

    await manager.start(cfg);
    expect(spawnedPtys).toHaveLength(1);
    // Mark first PTY shutdown sequence (simulates what restart asks for)
    spawnedPtys[0].fire("startup");
    spawnedPtys[0].fire("close", 0);

    const secondId = await manager.restart(cfg.id);
    expect(typeof secondId).toBe("string");
    expect(spawnedPtys).toHaveLength(2);
    // Fire startup + advance past LOCAL_SERVER_STABLE_RUN_MS on the restarted PTY
    spawnedPtys[1].fire("startup");
    vi.advanceTimersByTime(10_500);
    await Promise.resolve();
    expect(core.resetLocalServerRestartAttempts).toHaveBeenCalledWith(secondId);
    vi.useRealTimers();

    manager.dispose();
  });

  it("PathOutsideScope fires even at integration level when restrictToWorkspaceRoots is set", async () => {
    const core = makeCoreSpy();
    const root = path.resolve(os.tmpdir(), "nexus-int-scope");
    mockConfig.set("workspaceFolders", [{ uri: { fsPath: root } }]);
    mockConfig.set("nexus.localServers.restrictToWorkspaceRoots", true);
    markDir(root);
    const outside = path.resolve(root, "..", "outside-scope-dir");
    const cfg = baseConfig({ cwd: outside, executable: "node" });
    const manager = makeManager(core);

    await expect(manager.start(cfg)).rejects.toSatisfy((e: unknown) => {
      expect((e as LocalServerError).code).toBe("PathOutsideScope");
      return true;
    });
    expect(spawnedPtys).toHaveLength(0);

    // But cwd inside root is allowed (and not a dir stat → CwdNotDirectory
    // is not hit here — test just confirms scope gate does not over-fire)
    const inside = path.join(root, "apps", "api");
    markDir(inside);
    const cfgIn = baseConfig({ cwd: inside, executable: "node" });
    await expect(manager.start(cfgIn)).resolves.toBeTypeOf("string");
    expect(spawnedPtys).toHaveLength(1);

    manager.dispose();
  });

  it("wireLocalServerTerminalCloseListener(): closing a tracked terminal triggers session cleanup", async () => {
    const core = makeCoreSpy();
    const terminals = new Map<string, unknown>();
    const manager = makeManager(core, { terminals } as any);
    const cfg = baseConfig();

    const sessionId = await manager.start(cfg);
    // Simulate the manager associating a VS Code terminal (what extension.ts
    // actually does by setting it into the terminals map).
    const fakeTerminal = { creationOptions: { name: cfg.name } };
    terminals.set(sessionId, fakeTerminal);

    const localServerTerminals = new Map<string, { terminal: unknown; sessionId: string; configId: string }>();
    localServerTerminals.set(sessionId, { terminal: fakeTerminal, sessionId, configId: cfg.id });

    const listenerD = wireLocalServerTerminalCloseListener({
      core,
      localServerTerminals,
      manager
    } as any);

    // Simulate VS Code firing terminal close
    for (const l of closeTerminalListeners) l(fakeTerminal);
    expect(localServerTerminals.has(sessionId)).toBe(false);

    listenerD.dispose();
    manager.dispose();
  });
});
