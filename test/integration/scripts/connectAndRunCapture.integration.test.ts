import * as path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Resolved by the next read of the script file, so a test can hold that read
// open the way a slow disk (or a cold remote file system) does.
let releaseRead: (() => void) | undefined;
let holdNextRead = false;

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
  CancellationTokenSource: class MockCancellationTokenSource {
    public readonly token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
    public cancel(): void {
      this.token.isCancellationRequested = true;
    }
    public dispose(): void {}
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
        if (holdNextRead) {
          holdNextRead = false;
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
        }
        const fs = await import("node:fs/promises");
        return new Uint8Array(await fs.readFile(uri.fsPath));
      })
    },
    workspaceFolders: [],
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_k: string, d?: unknown) => d)
    }))
  },
  window: {
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showInputBox: vi.fn(async () => "s3cret")
  },
  env: {}
}));

import { ScriptRuntimeManager } from "../../../src/services/scripts/scriptRuntimeManager";
import { captureSessionOutput } from "../../../src/services/scripts/sessionOutputCapture";
import { SCRIPT_TEMPLATES } from "../../../src/commands/scriptCommands";
import type { NexusCore } from "../../../src/core/nexusCore";
import type { ActiveSession, SessionPtyHandle } from "../../../src/models/config";
import type { PtyOutputObserver } from "../../../src/services/macroAutoTrigger";

type DevicePty = SessionPtyHandle & { emitOutput(t: string): void; writes: string[] };

/**
 * A Telnet PTY on a Cisco IOS line with usernames: it answers each line the
 * script sends the way the device would, shortly after, as a network does.
 */
function makeIosTelnetPty(): DevicePty {
  const observers = new Set<PtyOutputObserver>();
  const writes: string[] = [];
  const replies: Record<string, string> = {
    "admin\r": "admin\r\nPassword: ",
    "s3cret\r": "\r\n\r\nRouter>",
    "terminal length 0\r": "terminal length 0\r\nRouter>"
  };
  const pty: DevicePty = {
    addOutputObserver(o: PtyOutputObserver) {
      observers.add(o);
      return { dispose: () => observers.delete(o) };
    },
    setInputBlocked: vi.fn(),
    writeProgrammatic(data: string) {
      writes.push(data);
      const reply = replies[data];
      if (reply !== undefined) setTimeout(() => pty.emitOutput(reply), 5);
    },
    resetTerminal: vi.fn(),
    markShuttingDown: vi.fn(),
    emitOutput(text: string) {
      observers.forEach((o) => o.onOutput(text));
    },
    writes
  };
  return pty;
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
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

async function telnetTemplateFixture() {
  const pty = makeIosTelnetPty();
  const session: ActiveSession = {
    id: "telnet-session",
    serverId: "srv1",
    terminalName: "Nexus Telnet: router",
    startedAt: Date.now(),
    protocol: "telnet",
    pty
  };
  const core = {
    getSnapshot: () => ({
      activeSessions: [session],
      activeSerialSessions: [],
      activeLocalShellSessions: [],
      servers: [{ id: "srv1", name: "router", protocol: "telnet" }],
      serialProfiles: [],
      tunnels: [],
      activeTunnels: []
    }),
    getActiveSessionById: (id: string) => (id === session.id ? session : undefined),
    onDidChange: () => () => {}
  } as unknown as NexusCore;
  const manager = new ScriptRuntimeManager({
    core,
    macroAutoTrigger: { pushFilter: () => ({ dispose: () => {} }), bindObserverToSession: () => {} } as never,
    outputChannel: { appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() } as never,
    workerPath: path.resolve(__dirname, "..", "..", "..", "dist", "services", "scripts", "scriptWorker.js")
  });
  const ended: string[] = [];
  manager.onDidChangeRun((e) => {
    if (e.kind === "ended") ended.push(e.finalState);
  });

  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const template = SCRIPT_TEMPLATES.find((t) => t.id === "wait-send")!;
  const fixture = path.join(os.tmpdir(), `nexus-telnet-login-${Date.now()}-${Math.random()}.js`);
  await fs.writeFile(fixture, template.body.replaceAll("{{NAME}}", "telnet-login"), "utf8");
  const scriptUri = { fsPath: fixture, scheme: "file", path: fixture, toString: () => fixture };
  return { manager, pty, ended, scriptUri, cleanup: () => fs.unlink(fixture).catch(() => {}) };
}

const IOS_LOGIN_BANNER = "\r\n\r\nUser Access Verification\r\n\r\nUsername: ";

describe("Connect and Run Script… keeps the session's output from the moment it opens (#166)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    holdNextRead = false;
    releaseRead = undefined;
  });

  it("Wait for prompt then send logs in when the device's prompt arrives while the script file is still being read", async () => {
    // ⊘ runScript(uri, id) with nothing kept: it reads the script file before
    // it watches the output, the device's "Username:" lands in that gap, and
    // the template waits 30 s and stops with "No login prompt arrived" —
    // under the very launch its message names as the remedy.
    // ⊘ a capture taken after an await (inside runScript, after the read):
    // the prompt below is printed in the same tick the session registers.
    const { manager, pty, ended, scriptUri, cleanup } = await telnetTemplateFixture();
    try {
      holdNextRead = true;
      // What connectAndRunScript does in the change event that registered
      // the session — then the device answers at once.
      const capture = captureSessionOutput(pty);
      const started = manager.runScript(scriptUri as never, "telnet-session", capture);
      pty.emitOutput(IOS_LOGIN_BANNER);
      await waitFor(() => releaseRead !== undefined, 2_000);
      releaseRead!();
      await started;

      await waitFor(() => pty.writes.includes("admin\r"), 5_000);
      await waitFor(() => ended.length > 0, 5_000);
      expect(ended).toEqual(["completed"]);
      expect(pty.writes).toEqual(["admin\r", "s3cret\r", "terminal length 0\r"]);
    } finally {
      await manager.stopScript("telnet-session");
      await cleanup();
    }
  });
});
