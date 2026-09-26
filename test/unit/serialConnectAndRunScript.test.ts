/*
 * #207 — Connect and Run Script… on a serial profile (`nexus.serial.runWithScript`)
 * keeps the session's output from the moment the session registers, the way
 * the server command has since #166.
 *
 * The command is driven for real: a real NexusCore holds the serial session, a
 * real ScriptRuntimeManager runs the script on a fake worker, and a fake serial
 * PTY plays the device. The script file read is held open, the way a slow disk
 * or a cold remote file system holds it, so the gap between the session
 * registering and the run watching its output is guaranteed rather than raced.
 */

import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

// Set by a test before the command runs: the next read of the script file
// parks until `releaseRead` is called.
let holdNextRead = false;
let releaseRead: (() => void) | undefined;

vi.mock("vscode", async () => {
  const pathMod = await import("node:path");
  return {
    commands: {
      registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
        registeredCommands.set(id, handler);
        return { dispose: vi.fn() };
      }),
      executeCommand: vi.fn()
    },
    window: {
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showQuickPick: vi.fn(),
      showInputBox: vi.fn(),
      createTerminal: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() }))
    },
    workspace: {
      getConfiguration: vi.fn(() => ({ get: vi.fn((_k: string, d?: unknown) => d) })),
      workspaceFolders: [],
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
      }
    },
    env: { clipboard: { writeText: vi.fn() } },
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: "file", authority: "", path: p, toString: () => p }),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => {
        const p = pathMod.join(base.fsPath, ...parts);
        return { fsPath: p, scheme: "file", authority: "", path: p, toString: () => p };
      }
    },
    Disposable: class {
      public constructor(private readonly fn: () => void) {}
      public dispose(): void {
        this.fn();
      }
    },
    EventEmitter: class<T> {
      private readonly listeners = new Set<(v: T) => void>();
      public readonly event = (l: (v: T) => void) => {
        this.listeners.add(l);
        return { dispose: () => this.listeners.delete(l) };
      };
      public fire(v?: T): void {
        for (const l of this.listeners) l(v as T);
      }
      public dispose(): void {
        this.listeners.clear();
      }
    },
    TerminalLocation: { Editor: 2, Panel: 1 },
    TreeItem: class {
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
  };
});

/** A serial device on the other end of the port: prints what a test tells it to. */
interface DevicePty {
  addOutputObserver(o: { onOutput(text: string): void }): { dispose(): void };
  setInputBlocked(blocked: boolean): void;
  writeProgrammatic(data: string): void;
  resetTerminal(): void;
  markShuttingDown(reason: string): void;
  emitOutput(text: string): void;
  /** Output observers attached and not yet disposed. */
  live(): number;
}

interface StandardCallbacks {
  onSessionOpened(sessionId: string): void;
}
interface SmartCallbacks {
  onStateChanged(status: string): void;
}

const devices: Array<{ pty: DevicePty; callbacks: StandardCallbacks & SmartCallbacks }> = [];

function makeDevicePty(): DevicePty {
  const observers = new Set<{ onOutput(text: string): void }>();
  return {
    addOutputObserver(o) {
      observers.add(o);
      return { dispose: () => observers.delete(o) };
    },
    setInputBlocked: () => {},
    writeProgrammatic: () => {},
    resetTerminal: () => {},
    markShuttingDown: () => {},
    emitOutput(text) {
      for (const o of Array.from(observers)) o.onOutput(text);
    },
    live: () => observers.size
  };
}

vi.mock("../../src/services/serial/serialPty", () => ({
  SerialPty: vi.fn(function (_transport: unknown, _options: unknown, callbacks: StandardCallbacks & SmartCallbacks) {
    const pty = makeDevicePty();
    devices.push({ pty, callbacks });
    return pty;
  })
}));

vi.mock("../../src/services/serial/smartSerialPty", () => ({
  SmartSerialPty: vi.fn(function (_transport: unknown, _profile: unknown, callbacks: StandardCallbacks & SmartCallbacks) {
    const pty = makeDevicePty();
    devices.push({ pty, callbacks });
    return pty;
  }),
  normalizePortPath: vi.fn((p: string) => p)
}));

vi.mock("../../src/logging/sessionTranscriptLogger", () => ({
  createSessionTranscript: vi.fn(() => undefined)
}));

vi.mock("../../src/ui/webviewFormPanel", () => ({
  WebviewFormPanel: { open: vi.fn() }
}));

let pickedScript: { fsPath: string } | undefined;
vi.mock("../../src/services/scripts/scriptPicker", () => ({
  pickScriptFromWorkspace: vi.fn(async () => pickedScript)
}));

import * as vscode from "vscode";
import { registerSerialCommands } from "../../src/commands/serialCommands";
import type { CommandContext } from "../../src/commands/types";
import { NexusCore } from "../../src/core/nexusCore";
import type { SerialProfile } from "../../src/models/config";
import { ScriptRuntimeManager, type WorkerLike } from "../../src/services/scripts/scriptRuntimeManager";
import type { WorkerInbound, WorkerOutbound } from "../../src/services/scripts/scriptTypes";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";

interface FakeWorker extends WorkerLike {
  posted: WorkerInbound[];
  emit(outbound: WorkerOutbound): void;
}

function makeFakeWorker(): FakeWorker {
  const listeners: Array<(m: WorkerOutbound) => void> = [];
  const w: FakeWorker = {
    posted: [],
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === "message") listeners.push(listener as (m: WorkerOutbound) => void);
    },
    postMessage(msg: WorkerInbound) {
      w.posted.push(msg);
    },
    async terminate() {
      return 0;
    },
    unref() {},
    emit(outbound: WorkerOutbound) {
      for (const l of listeners) l(outbound);
    }
  } as FakeWorker;
  return w;
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("timeout waiting for predicate"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const MARKED = `/**\n * @nexus-script\n * @target-type serial\n */\n`;

type Mode = NonNullable<SerialProfile["mode"]>;

async function harness(mode: Mode, source = MARKED) {
  const profile: SerialProfile = {
    id: "sp1",
    name: "Lab Console",
    path: "/dev/ttyUSB0",
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    rtscts: false,
    mode
  };
  const core = new NexusCore(new InMemoryConfigRepository([], [], [profile]));
  await core.initialize();

  const workers: FakeWorker[] = [];
  const manager = new ScriptRuntimeManager({
    core,
    macroAutoTrigger: { pushFilter: () => ({ dispose: () => {} }), bindObserverToSession: () => {} } as never,
    outputChannel: { appendLine: () => {}, append: () => {}, show: () => {}, dispose: () => {} } as never,
    globalStoragePath: "/global-storage",
    workerPath: "/fake/worker.js",
    createWorker: () => {
      const w = makeFakeWorker();
      workers.push(w);
      return w;
    }
  });

  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const fixture = path.join(os.tmpdir(), `nexus-serial-run-${Date.now()}-${Math.random()}.js`);
  await fs.writeFile(fixture, source, "utf8");
  pickedScript = { fsPath: fixture, scheme: "file", authority: "", path: fixture, toString: () => fixture } as never;

  const ctx = {
    core,
    scriptRuntimeManager: manager,
    globalStoragePath: "/global-storage",
    serialSidecar: {},
    loggerFactory: { create: vi.fn(() => ({ log: () => {} })) },
    macroAutoTrigger: { createObserver: vi.fn(() => ({})), bindObserverToSession: vi.fn() },
    sessionLogDir: "",
    serialTerminals: new Map(),
    highlighter: {},
    activityIndicators: new Map(),
    focusedTerminal: undefined,
    terminalRegistry: undefined
  } as unknown as CommandContext;
  registerSerialCommands(ctx);

  return {
    manager,
    workers,
    core,
    command: (id: string) => registeredCommands.get(id)!("sp1") as Promise<void>,
    device: () => devices[0],
    /**
     * The port opens: a standard session registers here; a Smart Follow
     * session registered when its terminal opened and re-registers now.
     * Either way it is a registration change event, and the device may print
     * in the same tick.
     */
    openPort: () => {
      const { callbacks } = devices[0];
      if (mode === "smartFollow") callbacks.onStateChanged("connected");
      else callbacks.onSessionOpened("serial-session-1");
    },
    cleanup: async () => {
      for (const s of core.getSnapshot().activeSerialSessions) await manager.stopScript(s.id);
      await fs.unlink(fixture).catch(() => {});
    }
  };
}

async function tailOf(worker: FakeWorker, id: number): Promise<string> {
  worker.emit({ kind: "rpc", id, method: "tail", args: [4096] });
  const isResult = (m: WorkerInbound) => m.kind === "rpc-result" && (m as { id: number }).id === id;
  await waitFor(() => worker.posted.some(isResult));
  return (worker.posted.find(isResult) as unknown as { value: string }).value;
}

const BOOT = "System Bootstrap, Version 17.3(1r)\r\n";
const READY = "\r\nPress RETURN to get started!\r\n";

describe("Connect and Run Script… on a serial profile keeps the session's output from the moment it registers (#207)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    devices.length = 0;
    holdNextRead = false;
    releaseRead = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<Mode>(["standard", "smartFollow"])(
    "%s: the script sees what the device printed as the session registered and while the script was read — each chunk exactly once",
    async (mode) => {
      // ⊘ runScript(uri, id) with nothing kept (the code before this fix): the
      // run watches only once it has read the script file, so BOOT and READY
      // are lost and the tail is "Router>" alone.
      // ⊘ a capture taken after an await (inside the `.then` of anything, or
      // by runScript itself after the read): BOOT is printed in the same tick
      // as the registration.
      // ⊘ a capture wired into only one connect path (the standard port's
      // onSessionOpened): Smart Follow registers from its own callbacks and
      // would start empty.
      const h = await harness(mode);
      try {
        holdNextRead = true;
        await h.command("nexus.serial.runWithScript");
        h.openPort();
        h.device().pty.emitOutput(BOOT); // the registration tick
        await waitFor(() => releaseRead !== undefined);
        h.device().pty.emitOutput(READY); // while the script file is still being read
        releaseRead!();
        await waitFor(() => h.workers[0]?.posted.some((m) => m.kind === "load") ?? false);
        h.device().pty.emitOutput("Router>"); // once the run is going

        expect(await tailOf(h.workers[0], 1)).toBe(`${BOOT}${READY}Router>`);
        // One observer for the run: the capture's, taken over — not a second
        // one beside it.
        expect(h.device().pty.live()).toBe(1);
      } finally {
        await h.cleanup();
      }
    }
  );

  it("a refused run releases what was kept for it", async () => {
    // ⊘ a capture the command holds on to itself (or takes and never hands to
    // runScript): a refusal — here, a file with no @nexus-script marker —
    // leaves it attached, filling a 64 KiB buffer for the life of the session.
    const h = await harness("standard", "// not a Nexus script\n");
    try {
      await h.command("nexus.serial.runWithScript");
      h.openPort();
      h.device().pty.emitOutput(BOOT);
      await waitFor(() =>
        vi.mocked(vscode.window.showErrorMessage).mock.calls.some(([m]) => String(m).includes("is not a Nexus script"))
      );

      expect(h.workers).toHaveLength(0);
      expect(h.device().pty.live()).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  it("keeps nothing for a session that registers after the 90 s watchdog gave up", async () => {
    // ⊘ a capture taken on the session's registration outside the command's
    // `resolved` guard (a second change-event listener, or a hook in the
    // connect path): the watchdog has already said the script did not start,
    // no run will take the capture over, and it fills for the life of the
    // session.
    const h = await harness("standard");
    vi.useFakeTimers();
    try {
      await h.command("nexus.serial.runWithScript");
      await vi.advanceTimersByTimeAsync(90_000);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("the script did not start within 90s")
      );

      h.openPort();
      h.device().pty.emitOutput(BOOT);

      expect(h.device().pty.live()).toBe(0);
      expect(h.workers).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await h.cleanup();
    }
  });

  it.each<Mode>(["standard", "smartFollow"])(
    "%s: a declined connect clears the script-start watchdog",
    async (mode) => {
      const h = await harness(mode);
      try {
        // Open the profile once so the run-with-script command declines its
        // second connect through the normal same-profile precondition.
        await h.command("nexus.serial.connect");
        h.openPort();

        vi.useFakeTimers();
        await h.command("nexus.serial.runWithScript");
        await vi.advanceTimersByTimeAsync(90_000);

        expect(vscode.window.showWarningMessage).not.toHaveBeenCalledWith(
          expect.stringContaining("the script did not start within 90s")
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
        await h.cleanup();
      }
    }
  );

  it.each<Mode>(["standard", "smartFollow"])("%s: a plain Connect keeps no output for a script", async (mode) => {
    // ⊘ capturing at every serial session's registration: each session would
    // carry a 64 KiB buffer, and a later Quick Run could open on stale output
    // — only Connect and Run Script… starts a run at the session's start.
    const h = await harness(mode);
    try {
      await h.command("nexus.serial.connect");
      h.openPort();
      h.device().pty.emitOutput(BOOT);

      expect(h.device().pty.live()).toBe(0);
    } finally {
      await h.cleanup();
    }
  });
});
