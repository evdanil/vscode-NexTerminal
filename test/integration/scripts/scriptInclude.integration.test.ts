/*
 * End-to-end `nexus.include()` coverage: the REAL Worker (loaded from dist/),
 * the real ScriptRuntimeManager, real fixture files on disk. Same harness style
 * as scriptFs.integration.test.ts.
 *
 * Most fixtures are written so that a completed run IS the assertion — the
 * script throws on any shape it does not expect, which the runtime turns into
 * `ended:failed`. So `ended:completed` is not a weak "didn't crash" check: it
 * means every behaviour the fixture probes came back exactly as documented.
 *
 * The stack-attribution tests are the exception, and are the reason this file
 * exists at all: a line number can only be checked against the REAL V8 wrapper,
 * in the REAL worker, through the REAL failure envelope and log path.
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
          return { type: st.isDirectory() ? 2 : 1, ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size };
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
    commands: { executeCommand: vi.fn() }
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
  return {
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
  } as TestPty;
}

function makeMockCore(session: ActiveSession): NexusCore {
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({
      activeSessions: [session],
      activeSerialSessions: [],
      servers: [{ id: session.serverId, name: "test-server" }],
      serialProfiles: [],
      tunnels: [],
      activeTunnels: []
    }),
    getActiveSessionById: (id: string) => (id === session.id ? session : undefined),
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  } as unknown as NexusCore;
}

function runtimeFixture(scriptFixture: string): {
  manager: ScriptRuntimeManager;
  outputLines: string[];
  scriptUri: { fsPath: string; scheme: string; authority: string; path: string; toString: () => string };
  events: string[];
  onEvents: () => void;
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
  const manager = new ScriptRuntimeManager({
    core,
    macroAutoTrigger: { pushFilter: () => ({ dispose: () => {} }), bindObserverToSession: () => {} } as never,
    outputChannel: outputChannel as never,
    workerPath,
    // A real but irrelevant tmp path: with no workspace folder configured this
    // becomes the snapshot scripts root (<tmp>/scripts), which does not exist
    // and has nothing to do with test/fixtures/scripts — so every include below
    // rides the script's OWN-dir scope (decision 4), which is what the fixtures
    // are written against.
    globalStoragePath: path.join(require("node:os").tmpdir(), "nexus-include-integration")
  });

  const fixturePath = path.resolve(__dirname, "..", "..", "fixtures", "scripts", scriptFixture);
  const scriptUri = {
    fsPath: fixturePath,
    scheme: "file",
    authority: "",
    path: fixturePath,
    toString: () => fixturePath
  };
  const events: string[] = [];
  return {
    manager,
    outputLines,
    scriptUri,
    events,
    onEvents: () =>
      manager.onDidChangeRun((e) => events.push(e.kind + (e.kind === "ended" ? `:${e.finalState}` : "")))
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("timeout waiting for predicate"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** Runs a fixture end to end and returns its events + Output Channel lines. */
async function run(fixture: string, until: string): Promise<{ events: string[]; outputLines: string[] }> {
  const h = runtimeFixture(fixture);
  h.onEvents();
  await h.manager.runScript(h.scriptUri as never, "test-session");
  await waitFor(() => h.events.includes(until));
  return { events: h.events, outputLines: h.outputLines };
}

describe("nexus.include — end-to-end integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) exports forms, module identity, module-relative nexus.fs, and a 6-level nested chain all behave as documented", async () => {
    // Fixture-as-assertion: include-happy.js throws on any deviation, so
    // `ended:completed` means every one of its checks passed. Notably:
    //  ⊘ resolving a library's own relative paths against the ENTRY script's
    //    folder — a decoy template.txt sits next to the entry script, so that
    //    wrong implementation reads a real file and returns the wrong string;
    //  ⊘ holding a read-slot permit across module EVALUATION — the chain is 6
    //    deep against a 4-permit pool, so that implementation deadlocks here
    //    and this test times out rather than passing.
    const { events, outputLines } = await run("include-happy.js", "ended:completed");
    expect(events).toContain("ended:completed");
    // The audit trail: one load line per module, and a `(cached)` line for the
    // repeat include of greet.js.
    expect(
      outputLines.some((l) => /include \.\/include-lib\/greet\.js → include-lib\/greet\.js \(\d+ bytes\)/.test(l))
    ).toBe(true);
    // inner.js is reached by two different specifiers (`./inner.js` from
    // greet.js, `./include-lib/inner.js` from the entry script) — same file,
    // so the second delivery is a cache hit with no re-read.
    expect(
      outputLines.some((l) => l.includes("include ./include-lib/inner.js → include-lib/inner.js (cached)"))
    ).toBe(true);
    // ⊘ no worker-side specifier memo: the entry script includes greet.js
    // TWICE with the same specifier, and the second one must not reach the
    // main thread at all — so greet.js has exactly one audit line, not two.
    expect(outputLines.filter((l) => l.includes("→ include-lib/greet.js")).length).toBe(1);
  }, 30_000);

  it("(b) a circular include throws CircularInclude with the whole cycle spelled out", async () => {
    const { events, outputLines } = await run("include-cycle.js", "ended:completed");
    expect(events).toContain("ended:completed");
    expect(
      outputLines.some((l) =>
        l.includes(
          "include ./cyc-a.js → CircularInclude (include-cycle.js → include-lib/cyc-a.js → include-lib/cyc-b.js → include-lib/cyc-a.js)"
        )
      )
    ).toBe(true);
  }, 30_000);

  it("(c) including an @nexus-script file is refused with IncludeIsScript", async () => {
    const { events, outputLines } = await run("include-header.js", "ended:completed");
    expect(events).toContain("ended:completed");
    expect(outputLines.some((l) => l.includes("include ./include-lib/marked.js → IncludeIsScript"))).toBe(true);
  }, 30_000);

  it("(d) a module that does not parse throws IncludeSyntaxError naming the file", async () => {
    const { events } = await run("include-syntax.js", "ended:completed");
    expect(events).toContain("ended:completed");
  }, 30_000);

  it("(e) a CAUGHT throw from inside a library propagates unwrapped, names the library file, and renders with its true line", async () => {
    // The fixture asserts script-side that the error is the library's OWN
    // (message intact, no include code wrapped around it) and that its stack
    // names include-lib/thrower.js — ⊘ no //# sourceURL, which leaves every
    // frame as `<anonymous>` with nothing identifying the file.
    //
    // The LINE is asserted here rather than in the fixture because a stack a
    // script reads out of the error object itself is deliberately not
    // rewritten (rewriting every Error in the isolate would mean overriding
    // Error.prepareStackTrace, which is per-isolate and would surprise user
    // code). The runtime's own renderings — log.* and the failure envelope —
    // are corrected, and that is what this asserts.
    const { events, outputLines } = await run("include-throw-caught.js", "ended:completed");
    expect(events).toContain("ended:completed");
    const logged = outputLines.filter((l) => l.includes("log error:")).join("\n");
    expect(logged).toMatch(/thrower\.js:7:/);
    expect(logged).not.toMatch(/thrower\.js:9:/);
  }, 30_000);

  it("(f) an UNCAUGHT throw from inside a library fails the run and reports thrower.js line 7 in the Output Channel", async () => {
    // ⊘ no `//# sourceURL` on the compiled unit: the frame reads
    //   `<anonymous>` and this regex never matches.
    // ⊘ no line-offset correction: V8 reports the AsyncFunction wrapper's own
    //   numbering, so the throw shows up as line 9 — plausible, adjacent, and
    //   wrong, which is exactly why this asserts the exact line rather than
    //   "some line".
    const { events, outputLines } = await run("include-throw-uncaught.js", "ended:failed");
    expect(events).toContain("ended:failed");
    const failure = outputLines.filter((l) => l.includes("failed:")).join("\n");
    expect(failure).toContain("boom from the library");
    expect(failure).toMatch(/thrower\.js:7:/);
    expect(failure).not.toMatch(/thrower\.js:9:/);
    expect(failure).not.toMatch(/<anonymous>:\d+:\d+/);
  }, 30_000);

  it("(g) the ENTRY script's own uncaught throw reports its own file and true line", async () => {
    // ⊘ today's implementation (no sourceURL, no offset): the frame reads
    //   `<anonymous>:10:7` — the file is unnamed and the line is 2 too high.
    //   The entry script is the common case (most scripts include nothing), so
    //   this is the half of the fix that touches every user.
    const { events, outputLines } = await run("include-root-throw.js", "ended:failed");
    expect(events).toContain("ended:failed");
    const failure = outputLines.filter((l) => l.includes("failed:")).join("\n");
    expect(failure).toContain("thrown by the entry script itself");
    expect(failure).toMatch(/include-root-throw\.js:8:/);
    expect(failure).not.toMatch(/include-root-throw\.js:10:/);
    expect(failure).not.toMatch(/<anonymous>:\d+:\d+/);
  }, 30_000);

  it("(h) log.error(err) writes the error's attributed stack, not `{}`", async () => {
    // ⊘ the pre-Phase-2 `JSON.stringify(arg)` renderer: `message` and `stack`
    //   are non-enumerable, so the single most common logging line a script
    //   writes — `catch (err) { log.error(err) }` — used to record a literal
    //   `{}` in the Output Channel.
    const { events, outputLines } = await run("include-log-error.js", "ended:completed");
    expect(events).toContain("ended:completed");
    const logged = outputLines.filter((l) => l.includes("log error:")).join("\n");
    expect(logged).toContain("boom from the library");
    expect(logged).toMatch(/thrower\.js:7:/);
    expect(logged).not.toMatch(/log error: \{\}/);
  }, 30_000);
});
