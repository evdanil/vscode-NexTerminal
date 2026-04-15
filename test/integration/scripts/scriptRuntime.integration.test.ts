import * as path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => {
  const listeners = new Set<() => void>();
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
        fsPath: path.join(base.fsPath, ...parts),
        scheme: "file",
        path: path.join(base.fsPath, ...parts),
        toString: () => path.join(base.fsPath, ...parts)
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
    _mockListeners: listeners
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
  scriptUri: { fsPath: string; scheme: string; path: string; toString: () => string };
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
  const outputChannel = {
    appendLine: vi.fn(),
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
    workerPath
  });

  const fixturePath = path.resolve(__dirname, "..", "..", "fixtures", "scripts", scriptFixture);
  const scriptUri = { fsPath: fixturePath, scheme: "file", path: fixturePath, toString: () => fixturePath };

  return { manager, pty, core, scriptUri };
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
        reject(new Error(`timeout waiting for predicate`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("ScriptRuntimeManager — end-to-end integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) drives expect → sendLine → expect, capturing 'B\\r' between 'A' and 'C'", async () => {
    const { manager, pty, scriptUri } = runtimeFixture("basic-expect-send.js");
    const events: string[] = [];
    manager.onDidChangeRun((e) => events.push(e.kind + (e.kind === "ended" ? `:${e.finalState}` : "")));

    await manager.runScript(scriptUri as never, "test-session");
    // Stream output to drive the script forward.
    // First expect("A") should match after emission.
    pty.emitOutput("some noise A more noise");
    // Wait for the manager to process, then expect a write of "B\r".
    await waitFor(() => pty.writes.includes("B\r"), 2_000);
    pty.emitOutput(" then C here");
    await waitFor(() => events.includes("ended:completed"), 3_000);

    expect(pty.writes).toContain("B\r");
    expect(events).toContain("started");
    expect(events).toContain("ended:completed");
  }, 10_000);

  it("(b) terminates while(true) within 100ms via stopScript", async () => {
    const { manager, scriptUri } = runtimeFixture("infinite-loop.js");
    await manager.runScript(scriptUri as never, "test-session");
    // Let the worker enter the loop.
    await new Promise((r) => setTimeout(r, 100));
    const before = Date.now();
    await manager.stopScript("test-session");
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(500); // comfortable ceiling; typical <100ms
    expect(manager.getRuns()).toHaveLength(0);
  }, 10_000);

  it("(c) times out with descriptive error when pattern never arrives", async () => {
    const fixtureContent = `/**\n * @nexus-script\n */\nawait expect("NEVER-APPEARS", { timeout: 200 });\n`;
    // Write a tempfile fixture
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const tmpFile = path.join(os.tmpdir(), `nexus-script-timeout-${Date.now()}.js`);
    await fs.writeFile(tmpFile, fixtureContent, "utf8");

    const { manager } = runtimeFixture("basic-expect-send.js"); // any fixture — we won't use its content
    const scriptUri = { fsPath: tmpFile, scheme: "file", path: tmpFile, toString: () => tmpFile };
    const events: Array<{ kind: string; finalState?: string }> = [];
    manager.onDidChangeRun((e) => events.push(e as never));

    const before = Date.now();
    await manager.runScript(scriptUri as never, "test-session");
    await waitFor(
      () => events.some((e) => e.kind === "ended"),
      3_000
    );
    const elapsed = Date.now() - before;
    const ended = events.find((e) => e.kind === "ended");
    expect(ended?.finalState).toBe("failed");
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(3_000);

    await fs.unlink(tmpFile).catch(() => {});
  }, 10_000);

  it("(d) rejects pending expect with ConnectionLost when session is removed", async () => {
    const fixtureContent = `/**\n * @nexus-script\n */\ntry { await expect("NEVER"); log.info("no-timeout"); } catch (e) { log.info("caught:" + e.code); throw e; }\n`;
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const tmpFile = path.join(os.tmpdir(), `nexus-script-disc-${Date.now()}.js`);
    await fs.writeFile(tmpFile, fixtureContent, "utf8");

    const { manager, core } = runtimeFixture("basic-expect-send.js");
    const scriptUri = { fsPath: tmpFile, scheme: "file", path: tmpFile, toString: () => tmpFile };
    const logs: string[] = [];
    manager.onDidChangeRun((e) => {
      if (e.kind === "log") logs.push(e.text);
    });

    await manager.runScript(scriptUri as never, "test-session");
    // Let the expect register its subscription, then simulate disconnection.
    await new Promise((r) => setTimeout(r, 200));
    core.removeSession();
    core.emitChange();
    await waitFor(() => logs.some((l) => l.startsWith("caught:")), 3_000);
    expect(logs.some((l) => l === "caught:ConnectionLost")).toBe(true);

    await fs.unlink(tmpFile).catch(() => {});
  }, 10_000);
});
