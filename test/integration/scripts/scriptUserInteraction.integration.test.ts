import * as path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

let mockInputResponse: string | undefined;
let mockConfirmResponse: "OK" | undefined;

vi.mock("vscode", () => ({
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
      get: vi.fn((_k: string, d?: unknown) => d)
    }))
  },
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(async () => mockConfirmResponse),
    showInputBox: vi.fn(async (opts?: { password?: boolean }) => {
      if (opts?.password && mockInputResponse !== undefined) {
        return `MASKED:${mockInputResponse}`;
      }
      return mockInputResponse;
    })
  }
}));

import { ScriptRuntimeManager } from "../../../src/services/scripts/scriptRuntimeManager";
import type { NexusCore } from "../../../src/core/nexusCore";
import type { ActiveSession, SessionPtyHandle } from "../../../src/models/config";
import type { PtyOutputObserver } from "../../../src/services/macroAutoTrigger";

function makeTestPty(): SessionPtyHandle & { emitOutput(t: string): void; writes: string[] } {
  const observers = new Set<PtyOutputObserver>();
  const writes: string[] = [];
  return {
    addOutputObserver(o: PtyOutputObserver) {
      observers.add(o);
      return { dispose: () => observers.delete(o) };
    },
    setInputBlocked: vi.fn(),
    writeProgrammatic(data: string) {
      writes.push(data);
    },
    emitOutput(text: string) {
      observers.forEach((o) => o.onOutput(text));
    },
    writes
  };
}

function makeMockCore(session: ActiveSession): NexusCore {
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
    onDidChange: () => () => {}
  } as unknown as NexusCore;
}

function runtimeFixture(): {
  manager: ScriptRuntimeManager;
  events: Array<{ kind: string; text?: string }>;
  pty: SessionPtyHandle & { emitOutput(t: string): void; writes: string[] };
} {
  const pty = makeTestPty();
  const session: ActiveSession = {
    id: "test-session",
    serverId: "srv1",
    terminalName: "test",
    startedAt: Date.now(),
    pty
  };
  const core = makeMockCore(session);
  const outputChannel = { appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() } as unknown as {
    appendLine: (s: string) => void;
  };
  const workerPath = path.resolve(__dirname, "..", "..", "..", "dist", "services", "scripts", "scriptWorker.js");
  const manager = new ScriptRuntimeManager({
    core,
    macroAutoTrigger: {
      pushFilter: () => ({ dispose: () => {} }),
      bindObserverToSession: () => {}
    } as never,
    outputChannel: outputChannel as never,
    workerPath
  });
  const events: Array<{ kind: string; text?: string }> = [];
  manager.onDidChangeRun((e) => {
    if (e.kind === "log") events.push({ kind: "log", text: e.text });
    else events.push({ kind: e.kind });
  });
  return { manager, events, pty };
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
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

describe("scriptUserInteraction — prompt / confirm / alert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInputResponse = undefined;
    mockConfirmResponse = undefined;
  });

  it("prompt resolves with the user's typed value", async () => {
    mockInputResponse = "ir1800.bin";
    const { manager, events } = runtimeFixture();
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const fixture = path.join(os.tmpdir(), `nexus-prompt-${Date.now()}.js`);
    await fs.writeFile(
      fixture,
      `/**\n * @nexus-script\n */\nconst v = await prompt("Image:");\nlog.info("got:" + v);\n`
    );
    await manager.runScript({ fsPath: fixture } as never, "test-session");
    await waitFor(() => events.some((e) => e.kind === "log" && e.text === "got:ir1800.bin"), 3_000);
    await fs.unlink(fixture).catch(() => {});
  }, 10_000);

  it("prompt with password masks the value in the log event stream", async () => {
    mockInputResponse = "s3cret";
    const { manager, events } = runtimeFixture();
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const fixture = path.join(os.tmpdir(), `nexus-prompt-pw-${Date.now()}.js`);
    // The script does NOT log the value — it just uses it internally.
    // We assert the plaintext "s3cret" never appears in any event.
    await fs.writeFile(
      fixture,
      `/**\n * @nexus-script\n */\nconst pw = await prompt("Password", { password: true });\nlog.info("done");\n`
    );
    await manager.runScript({ fsPath: fixture } as never, "test-session");
    await waitFor(() => events.some((e) => e.kind === "log" && e.text === "done"), 3_000);
    const hasPlaintext = events.some((e) => e.text?.includes("s3cret"));
    expect(hasPlaintext).toBe(false);
    await fs.unlink(fixture).catch(() => {});
  }, 10_000);

  it("confirm returns true on OK and false on cancel", async () => {
    const { manager, events } = runtimeFixture();
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const fixture = path.join(os.tmpdir(), `nexus-confirm-${Date.now()}.js`);
    await fs.writeFile(
      fixture,
      `/**\n * @nexus-script\n */\nconst a = await confirm("go?");\nconst b = await confirm("go?");\nlog.info("results:" + a + "," + b);\n`
    );
    // First call: confirm(OK) → true. Second call: confirm(cancel) → false.
    let callCount = 0;
    (await import("vscode")).window.showInformationMessage = vi.fn(async () => {
      callCount++;
      return callCount === 1 ? "OK" : undefined;
    }) as never;

    await manager.runScript({ fsPath: fixture } as never, "test-session");
    await waitFor(() => events.some((e) => e.kind === "log" && e.text === "results:true,false"), 3_000);
    await fs.unlink(fixture).catch(() => {});
  }, 10_000);

  it("confirm offers an explicit Cancel button and returns false on click (F7)", async () => {
    const { manager, events } = runtimeFixture();
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const fixture = path.join(os.tmpdir(), `nexus-confirm-cancel-${Date.now()}.js`);
    await fs.writeFile(
      fixture,
      `/**\n * @nexus-script\n */\nconst r = await confirm("Reboot?");\nlog.info("result:" + r);\n`
    );

    let capturedArgs: unknown[] | undefined;
    (await import("vscode")).window.showInformationMessage = vi.fn(async (...args: unknown[]) => {
      capturedArgs = args;
      return "Cancel";
    }) as never;

    await manager.runScript({ fsPath: fixture } as never, "test-session");
    await waitFor(() => events.some((e) => e.kind === "log" && e.text === "result:false"), 3_000);
    expect(capturedArgs).toBeDefined();
    // Signature: (message, { modal: true }, "OK", "Cancel")
    expect(capturedArgs).toEqual([
      "Reboot?",
      expect.objectContaining({ modal: true }),
      "OK",
      "Cancel"
    ]);
    await fs.unlink(fixture).catch(() => {});
  }, 10_000);

  it("alert resolves after the user dismisses the modal", async () => {
    mockConfirmResponse = "OK";
    const { manager, events } = runtimeFixture();
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const fixture = path.join(os.tmpdir(), `nexus-alert-${Date.now()}.js`);
    await fs.writeFile(
      fixture,
      `/**\n * @nexus-script\n */\nawait alert("Insert USB");\nlog.info("resumed");\n`
    );
    await manager.runScript({ fsPath: fixture } as never, "test-session");
    await waitFor(() => events.some((e) => e.kind === "log" && e.text === "resumed"), 3_000);
    await fs.unlink(fixture).catch(() => {});
  }, 10_000);
});
