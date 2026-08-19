/*
 * End-to-end nexus.fs coverage: real Worker (loaded from dist/), real
 * ScriptRuntimeManager, real fixture files on disk. Same harness style as
 * scriptRuntime.integration.test.ts.
 *
 * Each fixture is written so that a completed run IS the assertion — the
 * script throws on any shape it doesn't expect, which the runtime turns into
 * `ended:failed`. So `ended:completed` for all three fixtures below is not a
 * weak "didn't crash" check: it's "every nexus.fs behavior the fixture probes
 * came back exactly as documented".
 */
import * as path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => {
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
      file: (p: string) => ({ fsPath: p, scheme: "file", authority: "", path: p, toString: () => p }),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
        fsPath: path.join(base.fsPath, ...parts),
        scheme: "file",
        authority: "",
        path: path.join(base.fsPath, ...parts),
        toString: () => path.join(base.fsPath, ...parts)
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
      workspaceFolders: [],
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue)
      }))
    },
    window: {
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
        append: vi.fn(),
        show: vi.fn(),
        dispose: vi.fn()
      })),
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showInputBox: vi.fn(),
      showOpenDialog: vi.fn(),
      showQuickPick: vi.fn()
    },
    commands: {
      executeCommand: vi.fn()
    }
  };
});

import { ScriptRuntimeManager } from "../../../src/services/scripts/scriptRuntimeManager";
import type { NexusCore } from "../../../src/core/nexusCore";
import type { ActiveSession, SessionPtyHandle } from "../../../src/models/config";
import type { PtyOutputObserver } from "../../../src/services/macroAutoTrigger";

interface TestPty extends SessionPtyHandle {
  emitOutput(text: string): void;
  writes: string[];
}

function makeTestPty(): TestPty {
  const observers = new Set<PtyOutputObserver>();
  const writes: string[] = [];
  const pty: TestPty = {
    addOutputObserver(o) {
      observers.add(o);
      return { dispose: () => observers.delete(o) };
    },
    setInputBlocked: vi.fn(),
    writeProgrammatic(data) {
      writes.push(data);
    },
    emitOutput(text) {
      observers.forEach((o) => o.onOutput(text));
    },
    writes
  };
  return pty;
}

function makeMockCore(session: ActiveSession): NexusCore & { emitChange(): void; removeSession(): void } {
  let sessionPresent = true;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({
      activeSessions: sessionPresent ? [session] : [],
      activeSerialSessions: [],
      servers: [{ id: session.serverId, name: "test-server" }],
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
      for (const l of listeners) l();
    },
    removeSession: () => {
      sessionPresent = false;
    }
  } as unknown as NexusCore & { emitChange(): void; removeSession(): void };
}

function runtimeFixture(scriptFixture: string): {
  manager: ScriptRuntimeManager;
  pty: TestPty;
  core: ReturnType<typeof makeMockCore>;
  outputLines: string[];
  scriptUri: { fsPath: string; scheme: string; authority: string; path: string; toString: () => string };
} {
  const pty = makeTestPty();
  const session: ActiveSession = {
    id: "test-session",
    serverId: "srv1",
    terminalName: "test-terminal",
    startedAt: Date.now(),
    pty
  };
  const core = makeMockCore(session);
  const outputLines: string[] = [];
  const outputChannel = {
    appendLine: vi.fn((s: string) => outputLines.push(s)),
    append: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn()
  } as unknown as { appendLine: (s: string) => void };

  const workerPath = path.resolve(__dirname, "..", "..", "..", "dist", "services", "scripts", "scriptWorker.js");
  const mockMacroAutoTrigger = {
    pushFilter: () => ({ dispose: () => {} }),
    bindObserverToSession: () => {}
  };
  const manager = new ScriptRuntimeManager({
    core,
    macroAutoTrigger: mockMacroAutoTrigger as never,
    outputChannel: outputChannel as never,
    workerPath,
    // A real, but otherwise irrelevant, tmp path: with no workspace folder
    // configured (workspaceFolders: []) this becomes the snapshot root
    // (<tmp>/scripts), which doesn't exist on disk and has nothing to do with
    // test/fixtures/scripts/ — so every read below rides the script's own-dir
    // scope (decision 4), which is exactly what these fixtures probe.
    globalStoragePath: path.join(require("node:os").tmpdir(), "nexus-scriptfs-integration")
  });

  const fixturePath = path.resolve(__dirname, "..", "..", "fixtures", "scripts", scriptFixture);
  const scriptUri = { fsPath: fixturePath, scheme: "file", authority: "", path: fixturePath, toString: () => fixturePath };

  return { manager, pty, core, outputLines, scriptUri };
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timeout waiting for predicate"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("nexus.fs — end-to-end integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) readText / readJson / exists all resolve correctly against the script's own directory, and every read is logged", async () => {
    // ⊘ unlogged reads (decision 8 regression).
    const { manager, scriptUri, outputLines } = runtimeFixture("fs-read-ok.js");
    const events: string[] = [];
    manager.onDidChangeRun((e) => events.push(e.kind + (e.kind === "ended" ? `:${e.finalState}` : "")));

    await manager.runScript(scriptUri as never, "test-session");
    await waitFor(() => events.includes("ended:completed"), 5_000);

    expect(events).toContain("ended:completed");
    const readLogLine = outputLines.find((l) => /fs\.readText .*config\.json \(\d+ bytes\)/.test(l));
    expect(readLogLine).toBeDefined();
  }, 10_000);

  it("(b) readJson on malformed JSON throws a worker-local SyntaxError (code InvalidJson) — no fs.readJson RPC method exists on the main thread", async () => {
    // ⊘ readJson implemented as a main-thread RPC method (decision 2
    // regression) — a main-thread implementation would have to register and
    // log its own method name, which would show up in the Output Channel.
    const { manager, scriptUri, outputLines } = runtimeFixture("fs-read-badjson.js");
    const events: string[] = [];
    manager.onDidChangeRun((e) => events.push(e.kind + (e.kind === "ended" ? `:${e.finalState}` : "")));

    await manager.runScript(scriptUri as never, "test-session");
    await waitFor(() => events.includes("ended:completed"), 5_000);

    expect(events).toContain("ended:completed");
    expect(outputLines.some((l) => l.includes("fs.readJson"))).toBe(false);
  }, 10_000);

  it("(c) a containment refusal rejects the RPC promise (catchable script-side) rather than crashing the worker", async () => {
    // ⊘ containment errors crashing the worker instead of rejecting the RPC
    // promise — this would surface as ended:failed, not ended:completed, since
    // the fixture's own try/catch would never get a chance to run.
    const { manager, scriptUri } = runtimeFixture("fs-read-escape.js");
    const events: string[] = [];
    manager.onDidChangeRun((e) => events.push(e.kind + (e.kind === "ended" ? `:${e.finalState}` : "")));

    await manager.runScript(scriptUri as never, "test-session");
    await waitFor(() => events.includes("ended:completed"), 5_000);

    expect(events).toContain("ended:completed");
  }, 10_000);

  it("(d) a REVIVED FileTooLarge error (real worker round-trip through dispatchRpc → extraFieldsOf → rpc-result → reviveError) carries sizeBytes/maxBytes as top-level properties, not nested under .extra", async () => {
    // ⊘ makeFsError nesting extra fields under a property literally named
    // "extra" — would round-trip through the real RPC wire format as
    // err.extra.sizeBytes, contradicting docs/scripting.md and the d.ts,
    // which both promise err.sizeBytes / err.maxBytes directly. This exercises
    // the REAL worker's reviveError, not a hand-rolled substitute.
    const fs = await import("node:fs/promises");
    const bigFixturePath = path.resolve(__dirname, "..", "..", "fixtures", "scripts", "fs-toolarge.bin");
    await fs.writeFile(bigFixturePath, Buffer.alloc(4 * 1024 * 1024 + 1, "a"));
    try {
      const { manager, scriptUri } = runtimeFixture("fs-read-toolarge.js");
      const events: string[] = [];
      manager.onDidChangeRun((e) => events.push(e.kind + (e.kind === "ended" ? `:${e.finalState}` : "")));

      await manager.runScript(scriptUri as never, "test-session");
      await waitFor(() => events.includes("ended:completed"), 5_000);

      expect(events).toContain("ended:completed");
    } finally {
      await fs.unlink(bigFixturePath).catch(() => {});
    }
  }, 10_000);

  it("(e) a BigInt / cyclic-object / Symbol / function argument all cross the real worker RPC boundary and revive as a typed InvalidPath error, with a refusal logged", async () => {
    // ⊘ formatting the offending value with a bare JSON.stringify inside
    // scriptFsScope.ts / scriptFs.ts: a BigInt and a cyclic object are both
    // structured-cloneable, so `postMessage` genuinely delivers them to the
    // main thread unchanged — this is the REAL RPC boundary, not a
    // hand-rolled substitute. A throwing formatter there means the whole call
    // never reaches `fail()`, so dispatchRpc's catch reshapes a generic
    // exception into UnknownError instead of the typed InvalidPath the
    // fixture's own catch block checks for, AND no refusal is logged — the
    // fixture would throw its own assertion error either way, ending the run
    // `failed` instead of `completed`.
    //
    // ⊘ scriptWorker.ts's rpc()/sanitizeFsPath NOT existing at all: a Symbol
    // and a function are NOT structured-cloneable (unlike a cyclic object,
    // which the structured-clone algorithm handles natively — only
    // JSON.stringify chokes on that one, which is what the BigInt/cyclic half
    // above actually pins). `parentPort.postMessage` throws SYNCHRONOUSLY for
    // these two — confirmed empirically: without the fix, the promise rejects
    // with a DOMException whose `.name` is "DataCloneError" and whose legacy
    // `.code` is the NUMBER 25 (the DOM spec's DATA_CLONE_ERR constant), not
    // the string "InvalidPath" the fixture's own catch checks for — so the
    // fixture throws its OWN assertion error ("got 25"), ending the run
    // `failed` on the very first non-cloneable case, before the function()
    // case ever runs at all. The `rpc()` try/catch additionally stops the
    // `pending` map entry from leaking on that path (unobservable from here;
    // see the comment on `rpc()` itself).
    const { manager, scriptUri, outputLines } = runtimeFixture("fs-read-invalid-value.js");
    const events: string[] = [];
    manager.onDidChangeRun((e) => events.push(e.kind + (e.kind === "ended" ? `:${e.finalState}` : "")));

    await manager.runScript(scriptUri as never, "test-session");
    await waitFor(() => events.includes("ended:completed"), 5_000);

    expect(events).toContain("ended:completed");
    expect(outputLines.some((l) => l.includes("fs.readText") && l.includes("InvalidPath"))).toBe(true);
    // Specifically the Symbol/function stand-in path: sanitizeFsPath()'s
    // `{ __nonCloneable: ... }` object is what actually got logged — proves
    // the refusal wasn't silently dropped for the two non-cloneable cases.
    expect(outputLines.some((l) => l.includes("__nonCloneable"))).toBe(true);
  }, 10_000);
});
