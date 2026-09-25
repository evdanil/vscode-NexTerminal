/*
 * Unit tests for the main-thread half of ScriptRuntimeManager.
 *
 * These tests substitute a fake `WorkerLike` so they can exercise RPC dispatch, timeout
 * cancellation, input-lock release, log format, and the waitAny / tail code paths without
 * actually spawning a Node worker_thread. End-to-end coverage lives in
 * test/integration/scripts/scriptRuntime.integration.test.ts.
 */

import * as path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("vscode", async () => {
  const pathMod = await import("node:path");
  return {
    EventEmitter: class MockEventEmitter<T> {
      private readonly ls = new Set<(v: T) => void>();
      public readonly event = (l: (v: T) => void) => {
        this.ls.add(l);
        return { dispose: () => this.ls.delete(l) };
      };
      public fire(v?: T): void {
        for (const l of this.ls) l(v as T);
      }
      public dispose(): void {
        this.ls.clear();
      }
    },
    Disposable: class MockDisposable {
      public constructor(private readonly fn: () => void) {}
      public dispose(): void {
        this.fn();
      }
    },
    CancellationTokenSource: class MockCancellationTokenSource {
      private readonly listeners = new Set<() => void>();
      public readonly token = {
        isCancellationRequested: false,
        onCancellationRequested: (l: () => void) => {
          this.listeners.add(l);
          return { dispose: () => this.listeners.delete(l) };
        }
      };
      public cancel(): void {
        if (this.token.isCancellationRequested) return;
        this.token.isCancellationRequested = true;
        for (const l of Array.from(this.listeners)) l();
      }
      public dispose(): void {
        this.listeners.clear();
      }
    },
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: "file", authority: "", path: p, toString: () => p }),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
        fsPath: pathMod.join(base.fsPath, ...parts),
        scheme: "file",
        authority: "",
        path: pathMod.join(base.fsPath, ...parts),
        toString: () => pathMod.join(base.fsPath, ...parts)
      })
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      fs: {
        readFile: vi.fn(async (uri: { fsPath: string }) => {
          const fs = await import("node:fs/promises");
          const buf = await fs.readFile(uri.fsPath);
          return new Uint8Array(buf);
        }),
        stat: vi.fn(async (uri: { fsPath: string }) => {
          const fs = await import("node:fs/promises");
          const st = await fs.stat(uri.fsPath);
          return {
            type: st.isDirectory() ? 2 : 1,
            ctime: st.ctimeMs,
            mtime: st.mtimeMs,
            size: st.size
          };
        })
      },
      // Real VS Code always supplies a boolean here; left undefined so the
      // trust-gate `=== false` check (not `!isTrusted`) is exercised the same
      // way every OTHER test in this file already exercises it implicitly.
      isTrusted: undefined as boolean | undefined,
      workspaceFolders: [],
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_k: string, d?: unknown) => d)
      }))
    },
    window: {
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showInputBox: vi.fn(),
      showQuickPick: vi.fn()
    },
    commands: {
      executeCommand: vi.fn()
    }
  };
});

import {
  ScriptRuntimeManager,
  type WorkerLike
} from "../../../src/services/scripts/scriptRuntimeManager";
import type { FailureReason, StopReason } from "../../../src/services/scripts/scriptTypes";
import { captureSessionOutput } from "../../../src/services/scripts/sessionOutputCapture";
import type { NexusCore } from "../../../src/core/nexusCore";
import type { ActiveLocalShellSession, ActiveSession, SessionPtyHandle } from "../../../src/models/config";
import type { PtyOutputObserver } from "../../../src/services/macroAutoTrigger";
import type { WorkerInbound, WorkerOutbound } from "../../../src/services/scripts/scriptTypes";

// -----------------------------------------------------------------------------
// Fake worker — captures postMessage and lets tests fire outbound messages.
// -----------------------------------------------------------------------------

interface FakeWorker extends WorkerLike {
  messageListeners: Array<(m: WorkerOutbound) => void>;
  errorListeners: Array<(e: Error) => void>;
  exitListeners: Array<(c: number) => void>;
  posted: WorkerInbound[];
  terminated: boolean;
  emit(outbound: WorkerOutbound): void;
}

function makeFakeWorker(): FakeWorker {
  const w: FakeWorker = {
    messageListeners: [],
    errorListeners: [],
    exitListeners: [],
    posted: [],
    terminated: false,
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === "message") w.messageListeners.push(listener as (m: WorkerOutbound) => void);
      if (event === "error") w.errorListeners.push(listener as (e: Error) => void);
      if (event === "exit") w.exitListeners.push(listener as (c: number) => void);
    },
    postMessage(msg: WorkerInbound) {
      w.posted.push(msg);
    },
    async terminate() {
      w.terminated = true;
      return 0;
    },
    unref() {},
    emit(outbound: WorkerOutbound) {
      for (const l of w.messageListeners) l(outbound);
    }
  } as FakeWorker;
  return w;
}

// -----------------------------------------------------------------------------
// Mock session / pty / core.
// -----------------------------------------------------------------------------

interface TestPty extends SessionPtyHandle {
  emitOutput(text: string): void;
  writes: string[];
  inputBlockedHistory: boolean[];
  setInputBlocked: (b: boolean) => void;
}

function makeTestPty(): TestPty {
  const observers = new Set<PtyOutputObserver>();
  const inputBlockedHistory: boolean[] = [];
  const writes: string[] = [];
  const pty: TestPty = {
    addOutputObserver(o) {
      observers.add(o);
      return { dispose: () => observers.delete(o) };
    },
    setInputBlocked: vi.fn((b: boolean) => {
      inputBlockedHistory.push(b);
    }),
    writeProgrammatic(data: string) {
      writes.push(data);
    },
    emitOutput(text: string) {
      observers.forEach((o) => o.onOutput(text));
    },
    writes,
    inputBlockedHistory
  };
  return pty;
}

type TestSession = ActiveSession | ActiveLocalShellSession;

function makeMockCore(session: TestSession): NexusCore & {
  emitChange(): void;
  removeSession(): void;
} {
  let sessionPresent = true;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({
      activeSessions: sessionPresent && "serverId" in session ? [session] : [],
      activeSerialSessions: [],
      activeLocalShellSessions: sessionPresent && "profileId" in session ? [session] : [],
      servers: "serverId" in session ? [{ id: session.serverId, name: "mock-server" }] : [],
      serialProfiles: [],
      localShellProfiles: "profileId" in session ? [{ id: session.profileId, name: "mock-local" }] : [],
      tunnels: [],
      activeTunnels: []
    }),
    getActiveSessionById: (id: string) => (sessionPresent && id === session.id ? session : undefined),
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitChange: () => {
      for (const l of Array.from(listeners)) l();
    },
    removeSession: () => {
      sessionPresent = false;
    }
  } as unknown as NexusCore & { emitChange(): void; removeSession(): void };
}

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

interface Harness {
  manager: ScriptRuntimeManager;
  worker: FakeWorker;
  pty: TestPty;
  core: ReturnType<typeof makeMockCore>;
  output: string[];
  events: Array<{ kind: string; data?: unknown }>;
  scriptUri: { fsPath: string; scheme: string; path: string; toString: () => string };
}

async function createHarness(scriptSource: string, sessionOverrides: Partial<ActiveSession> = {}): Promise<Harness> {
  const pty = makeTestPty();
  const session: ActiveSession = {
    id: "test-session",
    serverId: "srv1",
    terminalName: "test-terminal",
    startedAt: Date.now(),
    pty,
    ...sessionOverrides
  };
  const core = makeMockCore(session);
  const output: string[] = [];
  const outputChannel = {
    appendLine: (s: string) => output.push(s),
    append: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn()
  } as unknown as { appendLine: (s: string) => void };

  const worker = makeFakeWorker();
  const manager = new ScriptRuntimeManager({
    core,
    macroAutoTrigger: {
      pushFilter: () => ({ dispose: () => {} }),
      bindObserverToSession: () => {}
    } as never,
    outputChannel: outputChannel as never,
    workerPath: "/fake/worker.js",
    createWorker: () => worker
  });

  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const fixture = path.join(os.tmpdir(), `nexus-runtime-unit-${Date.now()}-${Math.random()}.js`);
  await fs.writeFile(fixture, scriptSource, "utf8");
  const scriptUri = { fsPath: fixture, scheme: "file", authority: "", path: fixture, toString: () => fixture };

  const events: Array<{ kind: string; data?: unknown }> = [];
  manager.onDidChangeRun((e) => events.push({ kind: e.kind, data: e }));

  return { manager, worker, pty, core, output, events, scriptUri };
}

async function createLocalHarness(scriptSource: string): Promise<Harness> {
  const pty = makeTestPty();
  const session: ActiveLocalShellSession = {
    id: "test-local-session",
    profileId: "local1",
    terminalName: "Nexus Local Shell: Dev",
    startedAt: Date.now(),
    pty
  };
  const core = makeMockCore(session);
  const output: string[] = [];
  const outputChannel = {
    appendLine: (s: string) => output.push(s),
    append: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn()
  } as unknown as { appendLine: (s: string) => void };

  const worker = makeFakeWorker();
  const manager = new ScriptRuntimeManager({
    core,
    macroAutoTrigger: {
      pushFilter: () => ({ dispose: () => {} }),
      bindObserverToSession: () => {}
    } as never,
    outputChannel: outputChannel as never,
    workerPath: "/fake/worker.js",
    createWorker: () => worker
  });

  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const fixture = path.join(os.tmpdir(), `nexus-runtime-local-unit-${Date.now()}-${Math.random()}.js`);
  await fs.writeFile(fixture, scriptSource, "utf8");
  const scriptUri = { fsPath: fixture, scheme: "file", authority: "", path: fixture, toString: () => fixture };

  const events: Array<{ kind: string; data?: unknown }> = [];
  manager.onDidChangeRun((e) => events.push({ kind: e.kind, data: e }));

  return { manager, worker, pty, core, output, events, scriptUri };
}

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

async function waitNextTick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await waitNextTick();
  }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("ScriptRuntimeManager — unit fakes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes getRuns() and onDidChangeRun for the UI agent", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    expect(h.manager.getRuns()).toHaveLength(1);
    const run = h.manager.getRuns()[0];
    expect(run.sessionId).toBe("test-session");
    expect(run.state).toBe("running");
  });

  it("F9: log line format is [hh:mm:ss.sss] Name@SessionName  text", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n * @name MyScript\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    const logLine = h.output.find((l) => l.includes("start"));
    expect(logLine).toBeDefined();
    expect(logLine).toMatch(/\] MyScript@test-terminal /);
  });

  it("M1 / M2: releases input-lock even when session is already deregistered (ConnectionLost path)", async () => {
    const source = `/**\n * @nexus-script\n * @lock-input\n */\n`;
    const h = await createHarness(source);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    expect(h.pty.inputBlockedHistory).toEqual([true]);

    // Simulate session removal first, then fire ConnectionLost via onDidChange.
    h.core.removeSession();
    h.core.emitChange();
    // Wait past the grace timer (150ms).
    await new Promise((r) => setTimeout(r, 250));
    // The pty reference stored on the record must have released the lock even though
    // core.getActiveSessionById now returns undefined.
    expect(h.pty.inputBlockedHistory).toEqual([true, false]);
    expect(h.manager.getRuns()).toHaveLength(0);
  });

  it("M2: cleanupRun is idempotent across worker-exit + ConnectionLost race", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    const endedEvents: string[] = [];
    h.manager.onDidChangeRun((e) => {
      if (e.kind === "ended") endedEvents.push(e.finalState);
    });
    // Fire worker complete AND worker exit AND connection lost in close succession.
    h.worker.emit({ kind: "complete" });
    for (const l of h.worker.exitListeners) l(0);
    h.core.removeSession();
    h.core.emitChange();
    await new Promise((r) => setTimeout(r, 250));
    // Only one terminal "ended" event should have fired.
    expect(endedEvents.length).toBe(1);
    expect(h.manager.getRuns()).toHaveLength(0);
  });

  it("H1: stopScript cancels an in-flight waitAny instead of spinning to its deadline", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");

    // Kick off a waitAny RPC with a long timeout — without a cancellable implementation,
    // this promise would resolve only after `timeout` ms even after stopScript terminates.
    const rpcId = 1;
    h.worker.emit({ kind: "rpc", id: rpcId, method: "waitAny", args: [["alpha", "beta"], { timeout: 10_000 }] });

    // Stop immediately. The RPC must receive an error response quickly — not 10 seconds later.
    const stopStart = Date.now();
    await h.manager.stopScript("test-session");
    // Give the promise chain a tick.
    await waitNextTick();

    // Find the rpc-result for id=1 in posted messages.
    const result = h.worker.posted.find(
      (m): m is WorkerInbound & { kind: "rpc-result"; id: number } =>
        m.kind === "rpc-result" && (m as { id: number }).id === rpcId
    );
    // Either an error response arrived, or the worker was terminated before it needed to.
    // Concretely: stop completed in well under a second and no 10-second timer is pending.
    expect(Date.now() - stopStart).toBeLessThan(1000);
    // If an rpc-result was posted at all, it must be an error — never an ok:true "matched".
    if (result && "ok" in result) {
      expect(result.ok).toBe(false);
    }
  });

  it("F7: confirm presents a modal Yes/No dialog and returns true/false", async () => {
    const vscode = await import("vscode");
    const showInfo = vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");

    showInfo.mockResolvedValueOnce("OK");
    h.worker.emit({ kind: "rpc", id: 1, method: "confirm", args: ["Proceed?"] });
    await waitFor(() =>
      h.worker.posted.some(
        (m) => m.kind === "rpc-result" && (m as { id: number }).id === 1
      )
    );
    const okResult = h.worker.posted.find(
      (m) => m.kind === "rpc-result" && (m as { id: number }).id === 1
    ) as { kind: "rpc-result"; ok: true; value: boolean };
    expect(okResult.value).toBe(true);
    // Verify the call signature — must include { modal: true } AND "Cancel" arg.
    const call = showInfo.mock.calls[0];
    expect(call[1]).toEqual({ modal: true });
    expect(call).toEqual(expect.arrayContaining(["OK", "Cancel"]));

    showInfo.mockResolvedValueOnce("Cancel");
    h.worker.emit({ kind: "rpc", id: 2, method: "confirm", args: ["Proceed?"] });
    await waitFor(() =>
      h.worker.posted.some(
        (m) => m.kind === "rpc-result" && (m as { id: number }).id === 2
      )
    );
    const cancelResult = h.worker.posted.find(
      (m) => m.kind === "rpc-result" && (m as { id: number }).id === 2
    ) as { kind: "rpc-result"; ok: true; value: boolean };
    expect(cancelResult.value).toBe(false);
  });

  it("F5: tail(n) returns the last n chars of stripped output (default 512, clamped to buffer)", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");

    // Emit some output first — use ANSI to verify stripping.
    h.pty.emitOutput("\x1b[31mhello\x1b[0m world");
    // tail with default n.
    h.worker.emit({ kind: "rpc", id: 1, method: "tail", args: [] });
    await waitFor(() =>
      h.worker.posted.some(
        (m) => m.kind === "rpc-result" && (m as { id: number }).id === 1
      )
    );
    const r1 = h.worker.posted.find(
      (m) => m.kind === "rpc-result" && (m as { id: number }).id === 1
    ) as { kind: "rpc-result"; ok: true; value: string };
    expect(r1.ok).toBe(true);
    expect(r1.value).toBe("hello world");

    // tail with a large n — should clamp to the buffer contents, not throw.
    h.worker.emit({ kind: "rpc", id: 2, method: "tail", args: [10_000_000] });
    await waitFor(() =>
      h.worker.posted.some(
        (m) => m.kind === "rpc-result" && (m as { id: number }).id === 2
      )
    );
    const r2 = h.worker.posted.find(
      (m) => m.kind === "rpc-result" && (m as { id: number }).id === 2
    ) as { kind: "rpc-result"; ok: true; value: string };
    expect(r2.value).toBe("hello world");

    // tail with small n — returns only the last n chars.
    h.worker.emit({ kind: "rpc", id: 3, method: "tail", args: [5] });
    await waitFor(() =>
      h.worker.posted.some(
        (m) => m.kind === "rpc-result" && (m as { id: number }).id === 3
      )
    );
    const r3 = h.worker.posted.find(
      (m) => m.kind === "rpc-result" && (m as { id: number }).id === 3
    ) as { kind: "rpc-result"; ok: true; value: string };
    expect(r3.value).toBe("world");
  });

  it("exposes StopReason and FailureReason types so the UI can classify ended events", () => {
    const stopReasons: StopReason[] = ["user-requested", "max-runtime-exceeded", "extension-deactivating"];
    expect(stopReasons).toContain("max-runtime-exceeded");
    const failureReasons: FailureReason[] = ["worker-crash", "script-error", "expected"];
    expect(failureReasons).toContain("worker-crash");
  });

  it("S3: stopScript accepts a reason and surfaces it on the ended event", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    const endedEvents: Array<{ finalState: string; stopReason?: string }> = [];
    h.manager.onDidChangeRun((e) => {
      if (e.kind === "ended") endedEvents.push({ finalState: e.finalState, stopReason: e.stopReason });
    });
    await h.manager.stopScript("test-session", "max-runtime-exceeded");
    expect(endedEvents).toHaveLength(1);
    expect(endedEvents[0].finalState).toBe("stopped");
    expect(endedEvents[0].stopReason).toBe("max-runtime-exceeded");
  });

  it("F6: failureReason classifies well-known error codes as 'expected' so the UI can skip the toast", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    const endedEvents: Array<{ finalState: string; failureReason?: string }> = [];
    h.manager.onDidChangeRun((e) => {
      if (e.kind === "ended") endedEvents.push({ finalState: e.finalState, failureReason: e.failureReason });
    });
    // Simulate the worker posting a failed event carrying a known code.
    h.worker.emit({
      kind: "failed",
      error: { message: "timed out", code: "Timeout" }
    });
    await waitFor(() => endedEvents.length > 0);
    expect(endedEvents[0].finalState).toBe("failed");
    expect(endedEvents[0].failureReason).toBe("expected");
  });

  it("F6: failureReason is 'script-error' for unknown error codes (likely bug / syntax)", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    const endedEvents: Array<{ failureReason?: string }> = [];
    h.manager.onDidChangeRun((e) => {
      if (e.kind === "ended") endedEvents.push({ failureReason: e.failureReason });
    });
    h.worker.emit({
      kind: "failed",
      error: { message: "foo is not defined", code: "ReferenceError" }
    });
    await waitFor(() => endedEvents.length > 0);
    expect(endedEvents[0].failureReason).toBe("script-error");
  });

  it("runSnapshot exposes inputLockHeld so the UI can render a lock indicator without side caches", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n * @lock-input\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    const runs = h.manager.getRuns();
    expect(runs[0].inputLockHeld).toBe(true);
  });

  it("runSnapshot's inputLockHeld is false for scripts without @lock-input", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    expect(h.manager.getRuns()[0].inputLockHeld).toBe(false);
  });

  it("Codex P1: load message carries session metadata so `session` global is defined in user code", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    const load = h.worker.posted.find((m) => m.kind === "load") as unknown as {
      kind: "load";
      source: string;
      session: { id: string; type: string; name: string; targetId: string };
    };
    expect(load).toBeDefined();
    expect(load.session).toBeDefined();
    expect(load.session.id).toBe("test-session");
    expect(load.session.type).toBe("ssh");
    expect(load.session.name).toBe("test-terminal");
    expect(load.session.targetId).toBe("srv1");
  });

  it("runs against Local Shell sessions with local metadata", async () => {
    const h = await createLocalHarness(`/**\n * @nexus-script\n * @target-type local\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-local-session");
    const load = h.worker.posted.find((m) => m.kind === "load") as unknown as {
      kind: "load";
      session: { id: string; type: string; name: string; targetId: string };
    };
    expect(load.session).toEqual({
      id: "test-local-session",
      type: "local",
      name: "Nexus Local Shell: Dev",
      targetId: "local1"
    });
  });

  it("a Telnet run's `session` is type \"telnet\" with the server id as targetId, exactly like SSH", async () => {
    // ⊘ choosing targetId on `type === "ssh"` alone: a telnet session is an
    // ActiveSession too, but it fell through to the `profileId` branch — a
    // field ActiveSession does not have — so `session.targetId` was undefined
    // in every telnet run.
    const h = await createHarness(`/**\n * @nexus-script\n * @target-type telnet\n */\n`, { protocol: "telnet" });
    await h.manager.runScript(h.scriptUri as never, "test-session");
    const load = h.worker.posted.find((m) => m.kind === "load") as unknown as {
      session: { id: string; type: string; name: string; targetId: string };
    };
    expect(load.session).toEqual({
      id: "test-session",
      type: "telnet",
      name: "test-terminal",
      targetId: "srv1"
    });
  });

  it("header warnings (unknown tag, duplicate field) are written to the Output Channel when the run starts — and a clean header writes none", async () => {
    // ⊘ collecting `header.warnings` and never reading them: a misspelt tag
    // (`@lock-inputs`) silently did nothing, and the duplicate `@name` was
    // dropped without a word, although the scripting guide promises both a
    // warning in the Output Channel.
    const h = await createHarness(
      `/**\n * @nexus-script\n * @name First\n * @name Second\n * @lock-inputs\n */\n`
    );
    await h.manager.runScript(h.scriptUri as never, "test-session");
    const warnings = h.output.filter((l) => l.includes("header warning:"));
    expect(warnings).toHaveLength(2);
    // ⊘ logging them before the run's `start (…)` line: they belong to THIS
    // run, and a warning above its start line reads as the previous run's tail.
    const startIndex = h.output.findIndex((l) => l.includes("start ("));
    const firstWarningIndex = h.output.findIndex((l) => l.includes("header warning:"));
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(firstWarningIndex).toBeGreaterThan(startIndex);
    expect(warnings.some((l) => l.includes("First@test-terminal") && l.includes("header warning: unknown tag @lock-inputs"))).toBe(true);
    expect(warnings.some((l) => l.includes("header warning: duplicate field @name; keeping first occurrence"))).toBe(true);

    const clean = await createHarness(`/**\n * @nexus-script\n * @name Clean\n * @lock-input\n */\n`);
    await clean.manager.runScript(clean.scriptUri as never, "test-session");
    expect(clean.output.some((l) => l.includes("start ("))).toBe(true);
    expect(clean.output.some((l) => l.includes("header warning:"))).toBe(false);
  });

  it("rejects explicit sessions whose type does not match @target-type", async () => {
    const vscode = await import("vscode");
    const h = await createLocalHarness(`/**\n * @nexus-script\n * @target-type ssh\n */\n`);

    const runId = await h.manager.runScript(h.scriptUri as never, "test-local-session");

    expect(runId).toBeUndefined();
    expect(h.worker.posted).toHaveLength(0);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("targets SSH sessions")
    );
  });

  it("a target refusal names the session it was handed, and never claims a focused terminal (#155)", async () => {
    // ⊘ "…but the focused terminal is …": an explicit session reaches this
    // check from Quick Run AND from Connect/Open and Run Script…, where the
    // session is the one the command just opened and nothing was focused.
    // The runtime cannot tell the two apart, so the refusal must be true for both.
    const vscode = await import("vscode");
    const showError = vscode.window.showErrorMessage as unknown as ReturnType<typeof vi.fn>;

    const typeMismatch = await createLocalHarness(`/**\n * @nexus-script\n * @name Probe\n * @target-type ssh\n */\n`);
    await typeMismatch.manager.runScript(typeMismatch.scriptUri as never, "test-local-session");
    const typeMessage = String(showError.mock.calls.at(-1)?.[0]);
    expect(typeMessage).toContain('"Probe" targets SSH sessions');
    expect(typeMessage).toContain("Nexus Local Shell: Dev");
    expect(typeMessage).toContain("Local Shell");
    expect(typeMessage).not.toContain("focused terminal");

    const profileMismatch = await createHarness(`/**\n * @nexus-script\n * @name Probe\n * @target-profile lab-router-a\n */\n`);
    const runId = await profileMismatch.manager.runScript(profileMismatch.scriptUri as never, "test-session");
    expect(runId).toBeUndefined();
    const profileMessage = String(showError.mock.calls.at(-1)?.[0]);
    expect(profileMessage).toContain('"Probe" targets profile "lab-router-a"');
    expect(profileMessage).toContain("test-terminal");
    expect(profileMessage).not.toContain("focused terminal");
  });

  it("an explicit session the runtime cannot find is reported, not a silent no-op (#155)", async () => {
    // ⊘ `if (!target) return undefined` for an explicit session id: that is
    // how Quick Run on a focused Local Server terminal did nothing and said
    // nothing, and how Connect and Run Script… still would if the session
    // closed between registering and the run starting. (Cancelling the
    // session PICKER stays silent — that is the user's own choice.)
    const vscode = await import("vscode");
    const h = await createHarness(`/**\n * @nexus-script\n * @name Probe\n */\n`);

    const runId = await h.manager.runScript(h.scriptUri as never, "session-that-is-gone");

    expect(runId).toBeUndefined();
    expect(h.manager.getRuns()).toHaveLength(0);
    expect(h.worker.posted).toHaveLength(0);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    const message = String((vscode.window.showErrorMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(message).toContain('"Probe" did not run');
    expect(message).toContain("session could not be found");
  });

  it("releases input-lock when a Local Shell session is deregistered during a run", async () => {
    const h = await createLocalHarness(`/**\n * @nexus-script\n * @lock-input\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-local-session");
    expect(h.pty.inputBlockedHistory).toEqual([true]);

    h.core.removeSession();
    h.core.emitChange();
    await new Promise((r) => setTimeout(r, 250));

    expect(h.pty.inputBlockedHistory).toEqual([true, false]);
    expect(h.manager.getRuns()).toHaveLength(0);
  });

  it("Codex P1: readScriptFile prefers the live editor text over the filesystem (handles untitled + unsaved edits)", async () => {
    // Stage an open document in vscode.workspace.textDocuments whose getText()
    // returns source DIFFERENT from what's on disk — the runtime must honour
    // the live buffer. Otherwise unsaved edits are ignored and untitled:
    // URIs (which have no filesystem backing) can't run at all.
    const vscode = await import("vscode");
    const liveSource = `/**\n * @nexus-script\n * @name FromEditor\n */\n`;
    const liveUri = { fsPath: "/tmp/nonexistent.js", scheme: "untitled", path: "/tmp/nonexistent.js", toString: () => "untitled:/tmp/nonexistent.js" };
    (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [
      { uri: liveUri, getText: () => liveSource }
    ];

    const h = await createHarness(`/**\n * @nexus-script\n * @name OnDisk\n */\n`);
    // Use the in-memory URI — not the fixture on disk.
    await h.manager.runScript(liveUri as never, "test-session");
    // The log line captures scriptName from the header; if the live buffer
    // was used, the name is "FromEditor", not "OnDisk".
    const startLine = h.output.find((l) => l.includes("start"));
    expect(startLine).toBeDefined();
    expect(startLine).toMatch(/FromEditor@/);

    (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [];
  });
});

// -----------------------------------------------------------------------------
// Runtime error fields — the wire shape `reviveError` spreads onto the error a
// script catches. `rpc-result.error.extra` must hold the documented fields
// DIRECTLY: the worker does `Object.assign(err, { code }, extra)`, so whatever
// is one level down here is one level down on the script's error too.
// -----------------------------------------------------------------------------

describe("ScriptRuntimeManager — documented error fields arrive top-level", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  type ErrorResult = { ok: boolean; error?: { code: string; message: string; extra?: Record<string, unknown> } };

  async function rpcError(h: Harness, id: number): Promise<ErrorResult> {
    await waitFor(
      () => h.worker.posted.some((m) => m.kind === "rpc-result" && (m as { id: number }).id === id),
      2_000
    );
    return h.worker.posted.find(
      (m) => m.kind === "rpc-result" && (m as { id: number }).id === id
    ) as unknown as ErrorResult;
  }

  // ⊘ (all four) building these errors with a nested `{ extra: {...} }`
  // property: extraFieldsOf collected the single key literally named "extra",
  // so a script's `err.pattern` / `err.elapsedMs` / `err.sessionId` were
  // undefined and the values sat under `err.extra` — which the contract never
  // mentions. The guide's own catch block printed "timed out on undefined
  // after undefinedms".

  /**
   * Fire the pending wait's timer only after the wall clock has jumped 5 s past
   * the moment the wait started. A MEASURED `elapsedMs` is then at least 5000 —
   * deterministically different from the nominal timeout, from 0 and from a
   * missing field, with no real-time sleeping to flake on. (Not pinned to an
   * exact value: whether a method arms its timer before or after the jump is a
   * microtask-ordering detail, not the contract.) Only setTimeout/Date are
   * faked: the harness's waitFor polls on setImmediate.
   */
  function expectTimeoutFields(result: ErrorResult, pattern: string, timeoutMs: number): void {
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("Timeout");
    // Exactly these three keys: nothing nested under `extra`, nothing missing.
    expect(Object.keys(result.error?.extra ?? {}).sort()).toEqual(["elapsedMs", "pattern", "timeoutMs"]);
    expect(result.error?.extra).toMatchObject({ pattern, timeoutMs });
    expect(result.error?.extra?.elapsedMs).toBeGreaterThanOrEqual(5_000);
  }

  async function timeOutAfterClockJump(h: Harness, rpc: WorkerOutbound, timerMs: number): Promise<ErrorResult> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const startedAt = Date.now();
      h.worker.emit(rpc);
      vi.setSystemTime(startedAt + 5_000);
      await vi.advanceTimersByTimeAsync(timerMs);
      return await rpcError(h, (rpc as { id: number }).id);
    } finally {
      vi.useRealTimers();
    }
  }

  it("expect's Timeout carries pattern / timeoutMs / a MEASURED elapsedMs", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    const result = await timeOutAfterClockJump(h, { kind: "rpc", id: 1, method: "expect", args: ["NEVER", { timeout: 30 }] }, 30);
    expectTimeoutFields(result, '"NEVER"', 30);
  });

  it("waitAny's Timeout carries the joined pattern label / timeoutMs / a MEASURED elapsedMs", async () => {
    // ⊘ also: reporting the nominal timeout as elapsedMs (30 here), which the
    // d.ts's "how long the call waited" does not describe.
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    const result = await timeOutAfterClockJump(
      h,
      { kind: "rpc", id: 1, method: "waitAny", args: [["A-NEVER", /B-NEVER/], { timeout: 30 }] },
      30
    );
    expectTimeoutFields(result, '"A-NEVER" | /B-NEVER/', 30);
  });

  it("poll's Timeout carries pattern / timeoutMs / a MEASURED elapsedMs", async () => {
    // ⊘ also: reporting the nominal timeout as elapsedMs (60 here). The jump
    // passes the whole budget, so the loop exits after its first tick.
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    const result = await timeOutAfterClockJump(
      h,
      { kind: "rpc", id: 1, method: "poll", args: [{ send: "\r", until: "NEVER", every: 50, timeout: 60 }] },
      50
    );
    expectTimeoutFields(result, '"NEVER"', 60);
  });

  it("ConnectionLost carries sessionId", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    h.worker.emit({ kind: "rpc", id: 1, method: "waitFor", args: ["NEVER", { timeout: 60_000 }] });
    await waitNextTick();
    h.core.removeSession();
    h.core.emitChange();
    const result = await rpcError(h, 1);
    expect(result.error?.code).toBe("ConnectionLost");
    expect(result.error?.extra).toEqual({ sessionId: "test-session" });
  });

  it("a Stopped rejection carries no extra fields at all", async () => {
    // ⊘ assigning the fields as `{ code, extra }` even when there are none —
    // the old makeError did — which gives the error an own `extra: undefined`
    // key: extraFieldsOf ships it, and the script's caught error grows an
    // `extra` property the contract never mentions.
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    h.worker.emit({ kind: "rpc", id: 1, method: "waitFor", args: ["NEVER", { timeout: 60_000 }] });
    await h.manager.stopScript("test-session");
    const result = await rpcError(h, 1);
    expect(result.error?.code).toBe("Stopped");
    expect(result.error?.extra).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// nexus.fs plumbing — RPC wiring, decision 6 (root snapshot), decision 7
// (EXPECTED_ERROR_CODES unchanged), and record fields (scriptUri/scriptDirUri).
// Handler behavior itself (containment, size cap, decoding, ...) is covered in
// test/unit/scripts/scriptFs.test.ts; these tests are about the manager's
// wiring around scriptFs.ts, not the handlers.
// -----------------------------------------------------------------------------

describe("ScriptRuntimeManager — nexus.fs plumbing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fs.readText dispatches through invokeMethod and a PathOutsideScope refusal surfaces as an ok:false rpc-result (not swallowed into UnknownError)", async () => {
    // ⊘ an invokeMethod switch that doesn't add fs.readText/fs.exists cases at
    // all (dispatchRpc's catch-all would report "Unknown script RPC method"
    // instead of the fs handler's own PathOutsideScope code), and ⊘ any
    // handler that throws something dispatchRpc can't shape into {code,message}.
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");

    h.worker.emit({ kind: "rpc", id: 1, method: "fs.readText", args: ["/etc/passwd"] });
    await waitFor(() => h.worker.posted.some((m) => m.kind === "rpc-result" && (m as { id: number }).id === 1));
    const result = h.worker.posted.find(
      (m) => m.kind === "rpc-result" && (m as { id: number }).id === 1
    ) as { kind: "rpc-result"; ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PathOutsideScope");
  });

  it("fsContextFor's isAborted() tracks record.cleanedUp end to end: false while running, true for any fs call arriving after stopScript", async () => {
    // ⊘ fsContextFor not wiring `isAborted` to `cleanedUp` (or wiring it to
    // something that never flips) — a late RPC after stopScript would still
    // succeed instead of surfacing the typed Stopped refusal scriptFs.ts's
    // abort checks depend on.
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");

    // While running: reads the script's own fixture file (always in its own
    // scope), resolves normally.
    h.worker.emit({ kind: "rpc", id: 1, method: "fs.readText", args: [h.scriptUri.fsPath] });
    await waitFor(() => h.worker.posted.some((m) => m.kind === "rpc-result" && (m as { id: number }).id === 1));
    const beforeStop = h.worker.posted.find(
      (m) => m.kind === "rpc-result" && (m as { id: number }).id === 1
    ) as { ok: boolean };
    expect(beforeStop.ok).toBe(true);

    await h.manager.stopScript("test-session");

    // A late RPC "arriving" right after cleanup (the worker's message
    // listener still holds its captured `record` reference even though the
    // manager has already deregistered the run) sees isAborted() === true.
    h.worker.emit({ kind: "rpc", id: 2, method: "fs.readText", args: [h.scriptUri.fsPath] });
    await waitFor(() => h.worker.posted.some((m) => m.kind === "rpc-result" && (m as { id: number }).id === 2));
    const afterStop = h.worker.posted.find(
      (m) => m.kind === "rpc-result" && (m as { id: number }).id === 2
    ) as { ok: boolean; error?: { code: string } };
    expect(afterStop.ok).toBe(false);
    expect(afterStop.error?.code).toBe("Stopped");
  });

  it("fsContextFor's isAborted() also flips the instant a stop is REQUESTED — before cleanedUp — closing the ≤100ms stopScript grace-race window (P2, round 10)", async () => {
    // ⊘ isAborted wired to `record.cleanedUp` alone (dropping the
    // `|| record.stopReason !== undefined` half added in round 10): in
    // stopScript, `record.stopReason` is set SYNCHRONOUSLY at the very top,
    // well before the up-to-100ms `worker.terminate()` grace race resolves
    // and cleanupRun flips `cleanedUp`. An RPC arriving in that window would
    // see isAborted() === false under the cleanedUp-only predicate and
    // wrongly be allowed to proceed with I/O for a run that already asked to
    // stop.
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");

    // Make the grace race hang indefinitely: record.stopReason gets set, but
    // cleanupRun (and cleanedUp) can't run until the grace timer eventually
    // fires (~100ms real time) — a comfortably wide, deterministic window
    // where stopReason is set but cleanedUp is still false.
    h.worker.terminate = () => new Promise<number>(() => {});

    const stopPromise = h.manager.stopScript("test-session");

    // Emitted well within the (≥100ms) grace window — must already see
    // isAborted() === true.
    h.worker.emit({ kind: "rpc", id: 5, method: "fs.readText", args: [h.scriptUri.fsPath] });
    await waitFor(() => h.worker.posted.some((m) => m.kind === "rpc-result" && (m as { id: number }).id === 5));
    const duringWindow = h.worker.posted.find(
      (m) => m.kind === "rpc-result" && (m as { id: number }).id === 5
    ) as { ok: boolean; error?: { code: string } };
    expect(duringWindow.ok).toBe(false);
    expect(duringWindow.error?.code).toBe("Stopped");

    await stopPromise; // let the grace timer fire and cleanup finish before the test ends
  }, 2_000);

  it("fs.readText on a BigInt or a cyclic-object argument surfaces a typed InvalidPath rpc-result — not UnknownError — and logs the refusal", async () => {
    // ⊘ formatting the offending value with a bare JSON.stringify inside
    // scriptFsScope.ts / scriptFs.ts (instead of the non-throwing
    // safeStringify): both a BigInt and a cyclic object are
    // structured-cloneable, so a script's worker can genuinely send either as
    // an RPC arg. A throwing formatter means resolveScriptFsPath (or the
    // backslash guard) never returns at all — the throw escapes scriptFs.ts
    // entirely, dispatchRpc's catch reshapes THAT exception generically
    // instead of the typed InvalidPath one, and no `fail()` call ever runs —
    // so no refusal is ever logged either.
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");

    h.worker.emit({ kind: "rpc", id: 1, method: "fs.readText", args: [10n] });
    h.worker.emit({ kind: "rpc", id: 2, method: "fs.readText", args: [(() => {
      const cyclic: Record<string, unknown> = { name: "probe" };
      cyclic.self = cyclic;
      return cyclic;
    })()] });
    await waitFor(() =>
      h.worker.posted.filter((m) => m.kind === "rpc-result").length >= 2
    );

    for (const id of [1, 2]) {
      const result = h.worker.posted.find(
        (m) => m.kind === "rpc-result" && (m as { id: number }).id === id
      ) as { kind: "rpc-result"; ok: boolean; error?: { code: string } };
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("InvalidPath");
    }
    // The refusal audit-log line was written (not silently dropped by a throw
    // inside the formatter, which would have skipped the fail()/ctx.log call
    // entirely).
    expect(h.output.some((l) => l.includes("fs.readText") && l.includes("InvalidPath"))).toBe(true);
  });

  it("F6/decision 7: an uncaught nexus.fs error classifies as 'script-error', not 'expected' — EXPECTED_ERROR_CODES is unchanged", async () => {
    // ⊘ someone adding fs codes to EXPECTED_ERROR_CODES. This is the test that
    // pins decision 7's NO: an uncaught PathOutsideScope must toast, exactly
    // like a ReferenceError would.
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    const endedEvents: Array<{ finalState?: string; failureReason?: string }> = [];
    h.manager.onDidChangeRun((e) => {
      if (e.kind === "ended") endedEvents.push({ finalState: e.finalState, failureReason: e.failureReason });
    });
    h.worker.emit({
      kind: "failed",
      error: { message: "outside scope", code: "PathOutsideScope" }
    });
    await waitFor(() => endedEvents.length > 0);
    expect(endedEvents[0].finalState).toBe("failed");
    expect(endedEvents[0].failureReason).toBe("script-error");
  });

  it("decision 6: the scripts-root snapshot taken at run start survives a config/workspace-folder change mid-run", async () => {
    // ⊘ re-resolving resolveScriptsDir() on every fs call instead of once at
    // run start — a wrong implementation would follow the workspace-folder
    // flip below and refuse (or 404) the read from the ORIGINAL root A.
    const vscode = await import("vscode");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");

    const wsA = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-snapshot-a-"));
    const wsB = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-snapshot-b-"));
    const scriptsRootA = path.join(wsA, ".nexus", "scripts");
    await fs.mkdir(scriptsRootA, { recursive: true });
    await fs.writeFile(path.join(scriptsRootA, "marker.txt"), "root-A-content", "utf8");

    (vscode.workspace as unknown as { workspaceFolders: Array<{ uri: { fsPath: string } } > }).workspaceFolders = [
      { uri: vscode.Uri.file(wsA) as unknown as { fsPath: string } }
    ];

    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");

    // Flip the "config" AFTER the run has already snapshotted its root.
    (vscode.workspace as unknown as { workspaceFolders: Array<{ uri: { fsPath: string } } > }).workspaceFolders = [
      { uri: vscode.Uri.file(wsB) as unknown as { fsPath: string } }
    ];

    h.worker.emit({ kind: "rpc", id: 1, method: "fs.readText", args: [path.join(scriptsRootA, "marker.txt")] });
    await waitFor(() => h.worker.posted.some((m) => m.kind === "rpc-result" && (m as { id: number }).id === 1));
    const result = h.worker.posted.find(
      (m) => m.kind === "rpc-result" && (m as { id: number }).id === 1
    ) as { kind: "rpc-result"; ok: boolean; value?: string; error?: { code: string } };

    expect(result.ok).toBe(true);
    expect(result.value).toBe("root-A-content");

    (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [];
    await fs.rm(wsA, { recursive: true, force: true });
    await fs.rm(wsB, { recursive: true, force: true });
  });

  it("record fields: nexus.fs resolves against the exact scriptUri a run was launched with, even for a script outside any scripts root", async () => {
    // ⊘ a record that doesn't actually capture the launching Uri (e.g. always
    // deriving scriptDirUri from some other, stale, or default location) —
    // this would make a sibling-file read fail even though decision 4 says
    // "own-folder scope survives" for a script run from anywhere.
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-recordfields-"));
    await fs.writeFile(path.join(scriptDir, "sibling.txt"), "sibling-content", "utf8");
    const scriptFile = path.join(scriptDir, "probe.js");
    await fs.writeFile(scriptFile, `/**\n * @nexus-script\n */\n`, "utf8");
    const scriptUri = { fsPath: scriptFile, scheme: "file", authority: "", path: scriptFile, toString: () => scriptFile };

    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(scriptUri as never, "test-session");

    h.worker.emit({ kind: "rpc", id: 1, method: "fs.readText", args: ["sibling.txt"] });
    await waitFor(() => h.worker.posted.some((m) => m.kind === "rpc-result" && (m as { id: number }).id === 1));
    const result = h.worker.posted.find(
      (m) => m.kind === "rpc-result" && (m as { id: number }).id === 1
    ) as { kind: "rpc-result"; ok: boolean; value?: string };

    expect(result.ok).toBe(true);
    expect(result.value).toBe("sibling-content");

    await fs.rm(scriptDir, { recursive: true, force: true });
  });

  it("decision 6: the nexus.fs read cap is snapshotted at run start — changing nexus.scripts.maxReadSizeMb mid-run does not affect the in-flight run", async () => {
    // ⊘ `fsContextFor` reading `nexus.scripts.maxReadSizeMb` live on every fs
    // call instead of using the value captured once at run start: the read
    // below would then be admitted under the WIDENED (8 MiB) cap the user
    // switched to mid-run, and the same wrong implementation would equally
    // let a NARROWED cap start failing reads a running script had every
    // reason to expect to work. Also ⊘ a record that never captures the
    // setting at all (leaving the old fixed 4 MiB default in place), which
    // would likewise admit this 2 MiB read.
    const vscode = await import("vscode");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const MiB = 1024 * 1024;

    const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-readcap-"));
    await fs.writeFile(path.join(scriptDir, "two-mib.bin"), Buffer.alloc(2 * MiB, "a"));
    const scriptFile = path.join(scriptDir, "probe.js");
    await fs.writeFile(scriptFile, `/**\n * @nexus-script\n */\n`, "utf8");
    const scriptUri = { fsPath: scriptFile, scheme: "file", authority: "", path: scriptFile, toString: () => scriptFile };

    const settings: Record<string, unknown> = { maxReadSizeMb: 1 };
    const getConfiguration = vscode.workspace.getConfiguration as unknown as ReturnType<typeof vi.fn>;
    const restore = () =>
      getConfiguration.mockImplementation(() => ({ get: vi.fn((_k: string, d?: unknown) => d) }));
    getConfiguration.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback)
    }));

    try {
      const h = await createHarness(`/**\n * @nexus-script\n */\n`);
      await h.manager.runScript(scriptUri as never, "test-session");

      // Widen the cap AFTER the run has already snapshotted it.
      settings.maxReadSizeMb = 8;

      h.worker.emit({ kind: "rpc", id: 1, method: "fs.readText", args: ["two-mib.bin"] });
      await waitFor(() => h.worker.posted.some((m) => m.kind === "rpc-result" && (m as { id: number }).id === 1));
      const result = h.worker.posted.find(
        (m) => m.kind === "rpc-result" && (m as { id: number }).id === 1
      ) as { kind: "rpc-result"; ok: boolean; error?: { code: string; extra?: Record<string, unknown> } };

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("FileTooLarge");
      // The run's OWN snapshot (1 MiB), not the widened live value (8 MiB)
      // and not the 4 MiB default.
      expect(result.error?.extra?.maxBytes).toBe(1 * MiB);
    } finally {
      restore();
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// Workspace Trust gate (Step 4) — hard refuse before any Worker is created.
// -----------------------------------------------------------------------------

describe("ScriptRuntimeManager — Workspace Trust gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const vscode = await import("vscode");
    (vscode.workspace as unknown as { isTrusted?: boolean }).isTrusted = undefined;
  });

  async function trustHarness(scriptSource: string): Promise<{
    manager: ScriptRuntimeManager;
    worker: FakeWorker;
    createWorkerSpy: ReturnType<typeof vi.fn>;
    scriptUri: { fsPath: string; scheme: string; path: string; toString: () => string };
  }> {
    const pty = makeTestPty();
    const session: ActiveSession = {
      id: "trust-session",
      serverId: "srv1",
      terminalName: "trust-terminal",
      startedAt: Date.now(),
      pty
    };
    const core = makeMockCore(session);
    const worker = makeFakeWorker();
    const createWorkerSpy = vi.fn(() => worker);
    const manager = new ScriptRuntimeManager({
      core,
      macroAutoTrigger: {
        pushFilter: () => ({ dispose: () => {} }),
        bindObserverToSession: () => {}
      } as never,
      outputChannel: { appendLine: vi.fn(), append: vi.fn(), show: vi.fn(), dispose: vi.fn() } as never,
      workerPath: "/fake/worker.js",
      createWorker: createWorkerSpy
    });
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const fixture = path.join(os.tmpdir(), `nexus-trust-unit-${Date.now()}-${Math.random()}.js`);
    await fs.writeFile(fixture, scriptSource, "utf8");
    const scriptUri = { fsPath: fixture, scheme: "file", authority: "", path: fixture, toString: () => fixture };
    return { manager, worker, createWorkerSpy, scriptUri };
  }

  it("hard-refuses when isTrusted === false, and never creates a Worker", async () => {
    // ⊘ a gate that warns but still runs (i.e. logs/toasts but doesn't return early).
    const vscode = await import("vscode");
    (vscode.workspace as unknown as { isTrusted?: boolean }).isTrusted = false;
    const h = await trustHarness(`/**\n * @nexus-script\n */\n`);

    const runId = await h.manager.runScript(h.scriptUri as never, "trust-session");

    expect(runId).toBeUndefined();
    expect(h.manager.getRuns()).toHaveLength(0);
    expect(h.createWorkerSpy).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Restricted Mode"),
      "Manage Workspace Trust"
    );
  });

  it("proceeds normally when isTrusted === true", async () => {
    const vscode = await import("vscode");
    (vscode.workspace as unknown as { isTrusted?: boolean }).isTrusted = true;
    const h = await trustHarness(`/**\n * @nexus-script\n */\n`);

    const runId = await h.manager.runScript(h.scriptUri as never, "trust-session");

    expect(runId).toBeDefined();
    expect(h.createWorkerSpy).toHaveBeenCalledTimes(1);
  });

  it("proceeds normally when isTrusted is undefined (every pre-existing mock in this file, and VS Code's own transient state)", async () => {
    // ⊘ `!vscode.workspace.isTrusted` instead of `=== false` — would break
    // every other test in this file (none of which set isTrusted) and any
    // real session where VS Code hasn't resolved a trust value yet.
    const vscode = await import("vscode");
    (vscode.workspace as unknown as { isTrusted?: boolean }).isTrusted = undefined;
    const h = await trustHarness(`/**\n * @nexus-script\n */\n`);

    const runId = await h.manager.runScript(h.scriptUri as never, "trust-session");

    expect(runId).toBeDefined();
    expect(h.createWorkerSpy).toHaveBeenCalledTimes(1);
  });

  it("the 'Manage Workspace Trust' button opens VS Code's trust management UI", async () => {
    const vscode = await import("vscode");
    (vscode.workspace as unknown as { isTrusted?: boolean }).isTrusted = false;
    (vscode.window.showErrorMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      "Manage Workspace Trust"
    );
    const h = await trustHarness(`/**\n * @nexus-script\n */\n`);

    await h.manager.runScript(h.scriptUri as never, "trust-session");

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.trust.manage");
  });

  it("dismissing the message (no button picked) still refuses without opening the trust UI", async () => {
    const vscode = await import("vscode");
    (vscode.workspace as unknown as { isTrusted?: boolean }).isTrusted = false;
    (vscode.window.showErrorMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const h = await trustHarness(`/**\n * @nexus-script\n */\n`);

    await h.manager.runScript(h.scriptUri as never, "trust-session");

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// nexus.include plumbing (Phase 2). Policy itself is unit-tested in
// scriptInclude.test.ts; these pin the MANAGER's wiring around it — the RPC
// case, the per-run state, the module-id argument on fs.*, and the display name
// the worker needs for stack attribution.
// -----------------------------------------------------------------------------

describe("ScriptRuntimeManager — nexus.include plumbing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function includeHarness(): Promise<{
    h: Harness;
    scriptDir: string;
    cleanup: () => Promise<void>;
  }> {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-include-mgr-"));
    await fs.mkdir(path.join(scriptDir, "lib"), { recursive: true });
    await fs.writeFile(path.join(scriptDir, "lib", "a.js"), "exports.a = 1;", "utf8");
    await fs.writeFile(path.join(scriptDir, "lib", "template.txt"), "lib-copy", "utf8");
    await fs.writeFile(path.join(scriptDir, "template.txt"), "entry-copy", "utf8");
    const scriptFile = path.join(scriptDir, "main.js");
    await fs.writeFile(scriptFile, `/**\n * @nexus-script\n */\n`, "utf8");

    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    h.scriptUri.fsPath = scriptFile;
    (h.scriptUri as { path: string }).path = scriptFile;
    h.scriptUri.toString = () => scriptFile;
    await h.manager.runScript(h.scriptUri as never, "test-session");
    return { h, scriptDir, cleanup: () => fs.rm(scriptDir, { recursive: true, force: true }) };
  }

  function resultFor(h: Harness, id: number): { ok: boolean; value?: unknown; error?: { code: string; message: string; extra?: Record<string, unknown> } } {
    return h.worker.posted.find(
      (m) => m.kind === "rpc-result" && (m as { id: number }).id === id
    ) as { ok: boolean; value?: unknown; error?: { code: string; message: string; extra?: Record<string, unknown> } };
  }

  it("the `load` message carries the entry script's display name — without it the worker has no sourceURL and every frame reports <anonymous>", async () => {
    // ⊘ leaving `load` at its Phase-1 shape: stack attribution for the ENTRY
    // script (the common case — most scripts include nothing) silently stays
    // broken even though every module gets a proper name.
    const { h, cleanup } = await includeHarness();
    try {
      const load = h.worker.posted.find((m) => m.kind === "load") as { displayName?: string };
      expect(load.displayName).toBe("main.js");
    } finally {
      await cleanup();
    }
  });

  it("include.load dispatches through invokeMethod and returns the module id, display name and source", async () => {
    // ⊘ an invokeMethod switch with no include.load case: dispatchRpc's
    // catch-all would answer "Unknown script RPC method", so every
    // nexus.include() in every script would fail identically.
    const { h, cleanup } = await includeHarness();
    try {
      h.worker.emit({ kind: "rpc", id: 1, method: "include.load", args: ["./lib/a.js", ["#root"]] });
      await waitFor(() => resultFor(h, 1) !== undefined);
      const result = resultFor(h, 1);
      expect(result.ok).toBe(true);
      expect(result.value).toMatchObject({
        displayName: "lib/a.js",
        source: "exports.a = 1;",
        cached: false
      });
    } finally {
      await cleanup();
    }
  });

  it("a CircularInclude's `cycle` array arrives as a TOP-LEVEL extra field, ready for reviveError to spread onto err.cycle", async () => {
    // ⊘ building include errors with a nested `{ extra: {...} }` property (the
    // shape Timeout/ConnectionLost had before `makeScriptError`): extraFieldsOf would then collect
    // a single key literally named "extra", and the worker's reviveError would
    // spread THAT — so a script's `err.cycle` would be undefined and
    // `err.extra.cycle` would hold the array the docs promise directly.
    const { h, cleanup } = await includeHarness();
    try {
      h.worker.emit({ kind: "rpc", id: 1, method: "include.load", args: ["./lib/a.js", ["#root"]] });
      await waitFor(() => resultFor(h, 1) !== undefined);
      const moduleId = (resultFor(h, 1).value as { moduleId: string }).moduleId;

      h.worker.emit({ kind: "rpc", id: 2, method: "include.load", args: ["./a.js", ["#root", moduleId]] });
      await waitFor(() => resultFor(h, 2) !== undefined);
      const refusal = resultFor(h, 2);

      expect(refusal.ok).toBe(false);
      expect(refusal.error?.code).toBe("CircularInclude");
      expect(refusal.error?.extra?.cycle).toEqual(["main.js", "lib/a.js", "lib/a.js"]);
    } finally {
      await cleanup();
    }
  });

  it("fs.readText from inside a module resolves against THAT module's directory", async () => {
    // ⊘ ignoring args[1]: both template.txt files exist, so the wrong
    // implementation returns the entry script's copy — a different successful
    // answer, not an error. This is the module-relative half of "a relative
    // path resolves against the file it is written in".
    const { h, cleanup } = await includeHarness();
    try {
      h.worker.emit({ kind: "rpc", id: 1, method: "include.load", args: ["./lib/a.js", ["#root"]] });
      await waitFor(() => resultFor(h, 1) !== undefined);
      const moduleId = (resultFor(h, 1).value as { moduleId: string }).moduleId;

      h.worker.emit({ kind: "rpc", id: 2, method: "fs.readText", args: ["./template.txt", moduleId] });
      h.worker.emit({ kind: "rpc", id: 3, method: "fs.readText", args: ["./template.txt"] });
      await waitFor(() => resultFor(h, 2) !== undefined && resultFor(h, 3) !== undefined);

      expect(resultFor(h, 2).value).toBe("lib-copy");
      expect(resultFor(h, 3).value).toBe("entry-copy");
    } finally {
      await cleanup();
    }
  });

  it("an unknown module id on fs.readText or include.load is IncludeInternal — never a silent fallback to the entry script", async () => {
    // ⊘ `state.byId.get(id) ?? rootRecord`: a forged or stale id would read
    // from the wrong directory and report success, which is precisely the
    // "worker input is untrusted" property the main-side map exists to keep.
    const { h, cleanup } = await includeHarness();
    try {
      h.worker.emit({ kind: "rpc", id: 1, method: "fs.readText", args: ["./template.txt", "m-forged"] });
      h.worker.emit({ kind: "rpc", id: 2, method: "include.load", args: ["./lib/a.js", ["#root", "m-forged"]] });
      await waitFor(() => resultFor(h, 1) !== undefined && resultFor(h, 2) !== undefined);

      expect(resultFor(h, 1).ok).toBe(false);
      expect(resultFor(h, 1).error?.code).toBe("IncludeInternal");
      expect(resultFor(h, 2).ok).toBe(false);
      expect(resultFor(h, 2).error?.code).toBe("IncludeInternal");
    } finally {
      await cleanup();
    }
  });

  it("include state is per run: a second run of the same script starts with an empty module table", async () => {
    // ⊘ a module cache hung off the manager (or a module-level singleton)
    // rather than the run record — the edit → run loop would then serve the
    // previous run's source for the rest of the session, which is the single
    // most annoying bug this feature could have.
    const { h, scriptDir, cleanup } = await includeHarness();
    const fs = await import("node:fs/promises");
    try {
      h.worker.emit({ kind: "rpc", id: 1, method: "include.load", args: ["./lib/a.js", ["#root"]] });
      await waitFor(() => resultFor(h, 1) !== undefined);
      expect((resultFor(h, 1).value as { source?: string }).source).toBe("exports.a = 1;");

      await h.manager.stopScript("test-session");
      await fs.writeFile(path.join(scriptDir, "lib", "a.js"), "exports.a = 2;", "utf8");
      await h.manager.runScript(h.scriptUri as never, "test-session");

      // Both runs' message listeners are attached to this one fake worker, so
      // the stale run answers too (with Stopped). What matters is that the
      // LIVE run delivers the file's NEW contents, uncached.
      const answersFor9 = (): Array<{ ok: boolean; value?: { source?: string; cached?: boolean } }> =>
        h.worker.posted.filter(
          (m) => m.kind === "rpc-result" && (m as { id: number }).id === 9
        ) as Array<{ ok: boolean; value?: { source?: string; cached?: boolean } }>;
      h.worker.emit({ kind: "rpc", id: 9, method: "include.load", args: ["./lib/a.js", ["#root"]] });
      await waitFor(() => answersFor9().length >= 2);
      // The stale run answers from ITS OWN (already-populated) table, so the
      // discriminating assertion is that SOME answer is a fresh, uncached
      // delivery of the file's new contents. A cache shared across runs would
      // make every answer `cached: true` with no source at all.
      expect(
        answersFor9().some((r) => r.ok && r.value?.cached === false && r.value?.source === "exports.a = 2;")
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

// -----------------------------------------------------------------------------
// #155 — a prompt / confirm / alert must not outlive the run that asked. The
// run can end under an open dialog (stopped, its session dropped, or the
// script finished or threw without awaiting it). VS Code can close an input
// box (it takes a CancellationToken) but not a modal message; whatever the
// user answers after the run ended must reach nobody, and must be said to.
// -----------------------------------------------------------------------------

describe("ScriptRuntimeManager — dialogs do not outlive their run (#155)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  type Token = { isCancellationRequested: boolean; onCancellationRequested(l: () => void): unknown };

  function resultFor(h: Harness, id: number): WorkerInbound | undefined {
    return h.worker.posted.find((m) => m.kind === "rpc-result" && (m as { id: number }).id === id);
  }

  const endings: Array<[string, (h: Harness) => Promise<void>]> = [
    ["stopped", async (h) => h.manager.stopScript("test-session")],
    [
      "connection-lost",
      async (h) => {
        h.core.removeSession();
        h.core.emitChange();
        await new Promise((r) => setTimeout(r, 250));
      }
    ],
    // The script finished (or threw) without awaiting its prompt().
    ["completed", async (h) => h.worker.emit({ kind: "complete" })],
    ["failed", async (h) => h.worker.emit({ kind: "failed", error: { message: "boom" } })]
  ];

  it.each(endings)("an open prompt input box is closed when the run ends — %s", async (_label, endRun) => {
    // ⊘ showInputBox called without a CancellationToken (the box stays on
    // screen, its answer addressed to a worker that is gone), or a token
    // cancelled only by stopScript — which misses a dropped session and a
    // script that ended on its own.
    const vscode = await import("vscode");
    let token: Token | undefined;
    let called = false;
    vi.mocked(vscode.window.showInputBox).mockImplementationOnce(((_opts: unknown, t?: Token) => {
      called = true;
      token = t;
      return new Promise<string | undefined>((resolve) => t?.onCancellationRequested(() => resolve(undefined)));
    }) as never);
    const h = await createHarness(`/**\n * @nexus-script\n * @name Asker\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");

    h.worker.emit({ kind: "rpc", id: 1, method: "prompt", args: ["Image?"] });
    await waitFor(() => called);
    expect(token).toBeDefined();
    expect(token!.isCancellationRequested).toBe(false);

    await endRun(h);
    await waitNextTick();

    expect(token!.isCancellationRequested).toBe(true);
    // Closing the box ourselves is not an answer: nothing is posted to the
    // worker for it, and the user is not told an answer was ignored.
    expect(resultFor(h, 1)).toBeUndefined();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["confirm", "showInformationMessage", "OK"],
    ["alert", "showInformationMessage", "OK"],
    // An input box answered in the same moment the run ended.
    ["prompt", "showInputBox", "typed a moment too late"]
  ] as const)("%s: an answer given after the run ended is never delivered, and the user is told it was ignored", async (method, api, answer) => {
    // ⊘ posting the late answer as an rpc-result (what the runtime did): the
    // answer belongs to a run that is over, and a worker that is still ending
    // (stopScript waits up to 100 ms for it) would run the continuation the
    // script left on the dialog — a sendLine included.
    // ⊘ dropping it silently: a click on OK would read as "the script carried on".
    const vscode = await import("vscode");
    let answerNow: (v: string) => void = () => {};
    let shown = false;
    vi.mocked(vscode.window[api]).mockImplementationOnce((() => {
      shown = true;
      // A modal message has no token to honour; the late input box models the
      // user pressing Enter as the run ends.
      return new Promise<string>((resolve) => {
        answerNow = resolve;
      });
    }) as never);
    const h = await createHarness(`/**\n * @nexus-script\n * @name Asker\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");

    h.worker.emit({ kind: "rpc", id: 7, method, args: ["Insert the USB stick"] });
    await waitFor(() => shown);
    await h.manager.stopScript("test-session");
    answerNow(answer);
    await waitFor(
      () => resultFor(h, 7) !== undefined || vi.mocked(vscode.window.showWarningMessage).mock.calls.length > 0
    );

    expect(resultFor(h, 7)).toBeUndefined();
    const warning = String(vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0]);
    expect(warning).toContain('"Asker"');
    expect(warning).toContain("Insert the USB stick");
    expect(warning).toContain("ignored");
    // The answer itself is never echoed — it may be a password.
    expect(warning).not.toContain(answer);
    expect(h.output.some((l) => l.includes(`${method} answered after the run ended`))).toBe(true);
  });

  it("a dialog a finished run asks for afterwards is never shown, and the request is refused as Stopped", async () => {
    // ⊘ serving an RPC that arrives after the run ended. The worker is ended
    // with its run now, but a message it posted before that still arrives
    // (Node delivers what was already queued), so a timer the script left
    // behind can still reach the host asking for prompt(). Showing that
    // dialog is a question on behalf of a run that is over.
    const vscode = await import("vscode");
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    h.worker.emit({ kind: "complete" });

    h.worker.emit({ kind: "rpc", id: 3, method: "prompt", args: ["Still there?"] });
    h.worker.emit({ kind: "rpc", id: 4, method: "confirm", args: ["Still there?"] });
    await waitFor(() => resultFor(h, 3) !== undefined && resultFor(h, 4) !== undefined);

    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(resultFor(h, 3)).toMatchObject({ ok: false, error: { code: "Stopped" } });
    expect(resultFor(h, 4)).toMatchObject({ ok: false, error: { code: "Stopped" } });
  });

  it("an answer given while the run is live still reaches the script", async () => {
    // The guard above must not swallow the normal case.
    const vscode = await import("vscode");
    vi.mocked(vscode.window.showInputBox).mockImplementationOnce((async () => "ir1800.bin") as never);
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");

    h.worker.emit({ kind: "rpc", id: 5, method: "prompt", args: ["Image?"] });
    await waitFor(() => resultFor(h, 5) !== undefined);

    expect(resultFor(h, 5)).toMatchObject({ ok: true, value: "ir1800.bin" });
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// #155 review — a finished run must not act on its terminal. The worker's
// parentPort listener keeps its thread alive after the script settles, so it
// used to outlive every run that ended on its own (complete / failed): a timer
// the script left behind could still send, after the run had released its
// input lock and macro filter — and every such run leaked a Worker.
// -----------------------------------------------------------------------------

describe("ScriptRuntimeManager — a finished run cannot act on its terminal (#155)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function resultFor(h: Harness, id: number): WorkerInbound | undefined {
    return h.worker.posted.find((m) => m.kind === "rpc-result" && (m as { id: number }).id === id);
  }

  it.each([
    ["complete", { kind: "complete" }],
    ["failed", { kind: "failed", error: { message: "boom" } }]
  ] as const)("the worker is terminated when the script reports %s", async (_label, message) => {
    // ⊘ ending the run on `complete` / `failed` without terminating the
    // worker (only stop, a dropped session and deactivation used to).
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    expect(h.worker.terminated).toBe(false);

    h.worker.emit(message as WorkerOutbound);

    expect(h.worker.terminated).toBe(true);
    expect(h.manager.getRuns()).toHaveLength(0);
  });

  it("the worker is terminated when it crashes", async () => {
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    for (const l of h.worker.errorListeners) l(new Error("worker blew up"));
    expect(h.worker.terminated).toBe(true);
  });

  it.each(["send", "sendLine", "sendKey", "poll"] as const)(
    "%s posted before the worker ended is refused, not written, once the run has ended",
    async (method) => {
      // ⊘ terminating the worker and nothing else: a message the worker had
      // already posted is still delivered after terminate(), and would write
      // to a terminal whose input lock and macro filter were just released.
      const h = await createHarness(`/**\n * @nexus-script\n */\n`);
      await h.manager.runScript(h.scriptUri as never, "test-session");
      h.worker.emit({ kind: "complete" });

      const args = method === "poll" ? [{ send: "\r", until: "never", every: 50, timeout: 100 }] : method === "sendKey" ? ["enter"] : ["reload"];
      h.worker.emit({ kind: "rpc", id: 9, method, args });
      await waitFor(() => resultFor(h, 9) !== undefined);

      expect(h.pty.writes).toEqual([]);
      expect(resultFor(h, 9)).toMatchObject({ ok: false, error: { code: "Stopped" } });
    }
  );

  it("a send arriving while a stop is still waiting for the worker to end is refused too", async () => {
    // ⊘ guarding on `cleanedUp` alone: stopScript waits up to 100 ms for the
    // worker to end before it cleans up, and a script can still reach the
    // terminal in that window, after the user asked it to stop.
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    h.worker.terminate = () => new Promise<number>(() => {}); // a worker slow to end
    const stopping = h.manager.stopScript("test-session");

    h.worker.emit({ kind: "rpc", id: 11, method: "sendLine", args: ["reload"] });
    await waitFor(() => resultFor(h, 11) !== undefined);

    expect(h.pty.writes).toEqual([]);
    expect(resultFor(h, 11)).toMatchObject({ ok: false, error: { code: "Stopped" } });
    await stopping;
  });

  describe("a poll already running when its run ends sends nothing more (#155 review)", () => {
    // ⊘ checking the run only when `poll` is dispatched: a poll already in
    // its loop keeps ticking — cleanupRun does not reject a pending scan, so
    // each `every` the scan times out and the loop sends again, to a session
    // whose input lock and macro filter were released, or that a new run now
    // owns. A stop has the same window while it waits up to 100 ms for the
    // worker, before rejectAllPending runs.
    const POLL = { send: "\r", until: "NEVER", every: 50, timeout: 5_000 };

    async function startPolling(h: Harness): Promise<void> {
      await h.manager.runScript(h.scriptUri as never, "test-session");
      h.worker.emit({ kind: "rpc", id: 20, method: "poll", args: [POLL] });
      await waitFor(() => h.pty.writes.length >= 2); // two live ticks
    }

    it("after the script completes", async () => {
      const h = await createHarness(`/**\n * @nexus-script\n */\n`);
      await startPolling(h);
      h.worker.emit({ kind: "complete" });
      const atEnd = h.pty.writes.length;

      await waitFor(() => resultFor(h, 20) !== undefined, 2_000);

      expect(h.pty.writes).toHaveLength(atEnd);
      expect(resultFor(h, 20)).toMatchObject({ ok: false, error: { code: "Stopped" } });
    });

    it("after a stop is requested, while the worker is slow to end", async () => {
      const h = await createHarness(`/**\n * @nexus-script\n */\n`);
      await startPolling(h);
      h.worker.terminate = () => new Promise<number>(() => {});
      const stopping = h.manager.stopScript("test-session");
      const atStop = h.pty.writes.length;

      await stopping; // the whole ≤100 ms wait: two `every` intervals

      expect(h.pty.writes).toHaveLength(atStop);
    });

    it("after a new run has started on the same session", async () => {
      const h = await createHarness(`/**\n * @nexus-script\n * @name Second\n */\n`);
      await startPolling(h);
      h.worker.emit({ kind: "complete" });
      const atEnd = h.pty.writes.length;
      await h.manager.runScript(h.scriptUri as never, "test-session");
      expect(h.manager.getRuns()).toHaveLength(1);

      await new Promise((r) => setTimeout(r, 200)); // four `every` intervals

      expect(h.pty.writes).toHaveLength(atEnd);
    });
  });

  it("sends from a live run still reach the terminal", async () => {
    // The guard must not swallow the normal case.
    const h = await createHarness(`/**\n * @nexus-script\n */\n`);
    await h.manager.runScript(h.scriptUri as never, "test-session");
    h.worker.emit({ kind: "rpc", id: 12, method: "sendLine", args: ["show version"] });
    await waitFor(() => resultFor(h, 12) !== undefined);
    expect(h.pty.writes).toEqual(["show version\r"]);
  });
});

// #166 — Connect and Run Script… hands runScript the new session's output,
// kept since it opened (`captureSessionOutput`); every other run starts empty.
describe("ScriptRuntimeManager — the output a run starts with (#166)", () => {
  const MARKED = `/**\n * @nexus-script\n */\n`;

  interface CountingPty extends TestPty {
    /** Observers attached and not yet disposed. */
    live(): number;
  }

  function countingPty(): CountingPty {
    const pty = makeTestPty();
    const attach = pty.addOutputObserver.bind(pty);
    let live = 0;
    pty.addOutputObserver = (o) => {
      live++;
      const inner = attach(o);
      let disposed = false;
      return {
        dispose: () => {
          if (!disposed) {
            disposed = true;
            live--;
          }
          inner.dispose();
        }
      } as never;
    };
    return Object.assign(pty, { live: () => live });
  }

  async function harness(source = MARKED) {
    const pty = countingPty();
    const session: ActiveSession = { id: "test-session", serverId: "srv1", terminalName: "t", startedAt: Date.now(), pty };
    const workers: FakeWorker[] = [];
    const manager = new ScriptRuntimeManager({
      core: makeMockCore(session),
      macroAutoTrigger: { pushFilter: () => ({ dispose: () => {} }), bindObserverToSession: () => {} } as never,
      outputChannel: { appendLine: () => {}, append: vi.fn(), show: vi.fn(), dispose: vi.fn() } as never,
      workerPath: "/fake/worker.js",
      createWorker: () => {
        const w = makeFakeWorker();
        workers.push(w);
        return w;
      }
    });
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const fixture = path.join(os.tmpdir(), `nexus-capture-unit-${Date.now()}-${Math.random()}.js`);
    await fs.writeFile(fixture, source, "utf8");
    const scriptUri = { fsPath: fixture, scheme: "file", authority: "", path: fixture, toString: () => fixture };
    return { manager, pty, workers, scriptUri };
  }

  async function tailOf(worker: FakeWorker, id: number): Promise<string> {
    worker.emit({ kind: "rpc", id, method: "tail", args: [4096] });
    const isResult = (m: WorkerInbound) => m.kind === "rpc-result" && (m as { id: number }).id === id;
    await waitFor(() => worker.posted.some(isResult));
    return (worker.posted.find(isResult) as { value: string }).value;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps output from before, during and after the script read — each chunk exactly once", async () => {
    // ⊘ the capture ignored (runScript's own observer, attached after the
    // read, is all there is): only "C". ⊘ a handover with a gap — the capture
    // released when the run begins, the run's observer attached after the
    // read: "B" is lost. ⊘ a handover with an overlap — the run attaches its
    // own observer to the captured buffer and the capture's stays attached:
    // "C" twice, and two observers for the rest of the run.
    const h = await harness();
    const vscode = await import("vscode");
    let releaseRead: (() => void) | undefined;
    vi.mocked(vscode.workspace.fs.readFile).mockImplementationOnce(async (uri: { fsPath: string }) => {
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const fs = await import("node:fs/promises");
      return new Uint8Array(await fs.readFile(uri.fsPath));
    });

    const capture = captureSessionOutput(h.pty);
    h.pty.emitOutput("A"); // as the session registers, before runScript is called
    const started = h.manager.runScript(h.scriptUri as never, "test-session", capture);
    h.pty.emitOutput("B"); // while the script file is being read
    await waitFor(() => releaseRead !== undefined);
    releaseRead!();
    await started;
    h.pty.emitOutput("C"); // once the run is going

    expect(await tailOf(h.workers[0], 1)).toBe("ABC");
    expect(h.pty.live()).toBe(1);
  });

  it("starts a run with no capture empty, whatever the session printed before it", async () => {
    // ⊘ seeding every run with what the session already printed (a capture
    // each session keeps from registration, or the terminal's scrollback):
    // an already-open terminal's stale output would satisfy waits it must
    // not, contradicting `lookback`'s documented "starts empty".
    const h = await harness();
    h.pty.emitOutput("Router#");
    await h.manager.runScript(h.scriptUri as never, "test-session");
    expect(await tailOf(h.workers[0], 1)).toBe("");
    h.pty.emitOutput("X");
    expect(await tailOf(h.workers[0], 2)).toBe("X");
  });

  it("gives the capture to that one run: a later run on the same session starts empty", async () => {
    // ⊘ keeping the capture on the session for whatever runs next: a Quick
    // Run later would open on the login banner of a connect long past.
    // ⊘ the capture's observer outliving the run that took it over.
    const h = await harness();
    const capture = captureSessionOutput(h.pty);
    h.pty.emitOutput("Username: ");
    await h.manager.runScript(h.scriptUri as never, "test-session", capture);
    h.workers[0].emit({ kind: "complete" });
    expect(h.pty.live()).toBe(0);

    h.pty.emitOutput("Router#");
    await h.manager.runScript(h.scriptUri as never, "test-session");
    expect(await tailOf(h.workers[1], 1)).toBe("");
  });

  it("releases a capture whose run does not start", async () => {
    // ⊘ a refusal (here: no @nexus-script marker) that returns with the
    // capture still attached — it would fill for the life of the session.
    const h = await harness(`// not a Nexus script\n`);
    const capture = captureSessionOutput(h.pty);
    const runId = await h.manager.runScript(h.scriptUri as never, "test-session", capture);
    expect(runId).toBeUndefined();
    expect(h.pty.live()).toBe(0);
  });
});
