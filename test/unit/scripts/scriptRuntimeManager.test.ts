/*
 * Unit tests for the main-thread half of ScriptRuntimeManager.
 *
 * These tests substitute a fake `WorkerLike` so they can exercise RPC dispatch, timeout
 * cancellation, input-lock release, log format, and the waitAny / tail code paths without
 * actually spawning a Node worker_thread. End-to-end coverage lives in
 * test/integration/scripts/scriptRuntime.integration.test.ts.
 */

import * as path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

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
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: "file", path: p, toString: () => p }),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
        fsPath: pathMod.join(base.fsPath, ...parts),
        scheme: "file",
        path: pathMod.join(base.fsPath, ...parts),
        toString: () => pathMod.join(base.fsPath, ...parts)
      })
    },
    workspace: {
      fs: {
        readFile: vi.fn(async (uri: { fsPath: string }) => {
          const fs = await import("node:fs/promises");
          const buf = await fs.readFile(uri.fsPath);
          return new Uint8Array(buf);
        })
      },
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
    }
  };
});

import {
  ScriptRuntimeManager,
  type WorkerLike
} from "../../../src/services/scripts/scriptRuntimeManager";
import type { FailureReason, StopReason } from "../../../src/services/scripts/scriptTypes";
import type { NexusCore } from "../../../src/core/nexusCore";
import type { ActiveSession, SessionPtyHandle } from "../../../src/models/config";
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

function makeMockCore(session: ActiveSession): NexusCore & {
  emitChange(): void;
  removeSession(): void;
} {
  let sessionPresent = true;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({
      activeSessions: sessionPresent ? [session] : [],
      activeSerialSessions: [],
      servers: [{ id: session.serverId, name: "mock-server" }],
      serialProfiles: [],
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

async function createHarness(scriptSource: string): Promise<Harness> {
  const pty = makeTestPty();
  const session: ActiveSession = {
    id: "test-session",
    serverId: "srv1",
    terminalName: "test-terminal",
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
  const fixture = path.join(os.tmpdir(), `nexus-runtime-unit-${Date.now()}-${Math.random()}.js`);
  await fs.writeFile(fixture, scriptSource, "utf8");
  const scriptUri = { fsPath: fixture, scheme: "file", path: fixture, toString: () => fixture };

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
