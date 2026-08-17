import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { TelnetPty, type TelnetSocket, type TelnetSocketFactory } from "../../src/services/telnet/telnetPty";
import { DO, IAC, OPT_ECHO, WILL } from "../../src/services/telnet/telnetProtocol";
import { CLEAR_VISIBLE_SCREEN } from "../../src/services/terminal/terminalEscapes";
import { INPUT_LOCKED_NOTICE } from "../../src/services/terminal/ptyObserverHub";
import type { ServerConfig } from "../../src/models/config";

vi.mock("vscode", () => ({
  EventEmitter: class MockEventEmitter<T> {
    private listeners = new Set<(value: T) => void>();

    public readonly event = (listener: (value: T) => void): { dispose: () => void } => {
      this.listeners.add(listener);
      return {
        dispose: () => {
          this.listeners.delete(listener);
        }
      };
    };

    public fire(value?: T): void {
      for (const listener of this.listeners) {
        listener(value as T);
      }
    }

    public dispose(): void {
      this.listeners.clear();
    }
  },
  Disposable: class {
    public constructor(private readonly fn: () => void) {}
    public dispose(): void {
      this.fn();
    }
  },
  window: {
    showErrorMessage: vi.fn()
  }
}));

interface FakeSocketHandle {
  socket: TelnetSocket;
  factory: TelnetSocketFactory;
  connectArgs: Array<{ host: string; port: number }>;
  writes: Buffer[];
  destroy: ReturnType<typeof vi.fn>;
  emitConnect: () => void;
  emitData: (chunk: Buffer) => void;
  emitError: (error: Error) => void;
  emitClose: () => void;
}

function createFakeSocket(): FakeSocketHandle {
  const listeners = new Map<string, Array<(arg?: unknown) => void>>();
  const writes: Buffer[] = [];
  const destroy = vi.fn();
  const connectArgs: Array<{ host: string; port: number }> = [];

  const socket: TelnetSocket = {
    on(event: string, listener: (arg?: never) => void) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener as (arg?: unknown) => void);
      listeners.set(event, bucket);
      return socket;
    },
    write(data: Buffer) {
      writes.push(Buffer.from(data));
      return true;
    },
    destroy,
    setNoDelay: vi.fn()
  };

  const emit = (event: string, arg?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(arg);
    }
  };

  return {
    socket,
    factory: (options) => {
      connectArgs.push(options);
      return socket;
    },
    connectArgs,
    writes,
    destroy,
    emitConnect: () => emit("connect"),
    emitData: (chunk) => emit("data", chunk),
    emitError: (error) => emit("error", error),
    emitClose: () => emit("close")
  };
}

function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "lab-switch",
    host: "10.10.0.9",
    port: 23,
    username: "",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

interface Harness {
  pty: TelnetPty;
  fake: FakeSocketHandle;
  writes: string[];
  callbacks: {
    onSessionOpened: ReturnType<typeof vi.fn>;
    onSessionClosed: ReturnType<typeof vi.fn>;
    onDisconnected: ReturnType<typeof vi.fn>;
    onDataReceived: ReturnType<typeof vi.fn>;
    onConnectFailed: ReturnType<typeof vi.fn>;
  };
  logger: { log: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

function harness(config: Partial<ServerConfig> = {}): Harness {
  const fake = createFakeSocket();
  const writes: string[] = [];
  const callbacks = {
    onSessionOpened: vi.fn(),
    onSessionClosed: vi.fn(),
    onDisconnected: vi.fn(),
    onDataReceived: vi.fn(),
    onConnectFailed: vi.fn()
  };
  const logger = { log: vi.fn(), close: vi.fn() };
  const pty = new TelnetPty(serverConfig(config), callbacks, logger as never, {
    socketFactory: fake.factory
  });
  pty.onDidWrite((chunk) => writes.push(chunk));
  return { pty, fake, writes, callbacks, logger };
}

/** Everything the pty wrote to the terminal, joined. */
function rendered(h: Harness): string {
  return h.writes.join("");
}

/** Everything the pty wrote to the socket, as one byte array. */
function sent(h: Harness): number[] {
  return [...Buffer.concat(h.fake.writes)];
}

describe("TelnetPty — connect lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("opens a socket to the server's host and port", () => {
    const h = harness({ host: "192.0.2.7", port: 2001 });
    h.pty.open({ columns: 100, rows: 30 });
    expect(h.fake.connectArgs).toEqual([{ host: "192.0.2.7", port: 2001 }]);
  });

  it("writes a connect banner naming host:port and registers the session", () => {
    const h = harness({ host: "192.0.2.7", port: 2001 });
    h.pty.open();
    h.fake.emitConnect();

    expect(rendered(h)).toContain("[Nexus Telnet] Connected 192.0.2.7:2001");
    expect(h.callbacks.onSessionOpened).toHaveBeenCalledTimes(1);
  });

  // ⊘ A pty that registers the session at `open()` rather than at `connect`
  // puts an unreachable server in the tree as a live session forever.
  it("does not register a session before the socket connects", () => {
    const h = harness();
    h.pty.open();
    expect(h.callbacks.onSessionOpened).not.toHaveBeenCalled();
  });

  it("reports a connect failure in-terminal with a press-any-key notice and no session", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitError(new Error("ECONNREFUSED 10.10.0.9:23"));

    expect(rendered(h)).toContain("[Nexus Telnet] Connection failed: ECONNREFUSED 10.10.0.9:23");
    expect(rendered(h)).toContain("Press any key to close");
    expect(h.callbacks.onSessionOpened).not.toHaveBeenCalled();
    expect(h.callbacks.onConnectFailed).toHaveBeenCalledTimes(1);
  });

  it("closes the terminal on the next keystroke after a failed connect", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitError(new Error("nope"));
    const closed = vi.fn();
    h.pty.onDidClose(closed);

    h.pty.handleInput("q");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  // ⊘ Without a connect timeout an unroutable address leaves the tab spinning
  // silently until the OS gives up (minutes).
  it("gives up after the connect timeout and reports it like any other failure", () => {
    vi.useFakeTimers();
    const h = harness();
    h.pty.open();
    vi.advanceTimersByTime(10_000);

    expect(rendered(h)).toContain("[Nexus Telnet] Connection failed:");
    expect(rendered(h)).toContain("timed out");
    expect(h.fake.destroy).toHaveBeenCalled();
    expect(h.callbacks.onConnectFailed).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not fire the connect timeout once the socket is up", () => {
    vi.useFakeTimers();
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    vi.advanceTimersByTime(60_000);

    expect(rendered(h)).not.toContain("Connection failed");
    vi.useRealTimers();
  });

  it("reports a remote close as a disconnect with a press-any-key notice", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.fake.emitClose();

    expect(rendered(h)).toContain("[Nexus Telnet] Remote host closed the connection.");
    expect(rendered(h)).toContain("Press any key to close");
  });

  // ⊘ A pty that leaves the session registered after the remote hangs up leaves
  // a dead entry in the tree that scripts can still be targeted at.
  it("unregisters the session when the remote closes", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    const sessionId = h.callbacks.onSessionOpened.mock.calls[0][0] as string;

    h.fake.emitClose();
    expect(h.callbacks.onDisconnected).toHaveBeenCalledWith(sessionId);
  });

  it("falls back to onSessionClosed when no onDisconnected handler is supplied", () => {
    const fake = createFakeSocket();
    const onSessionClosed = vi.fn();
    const pty = new TelnetPty(
      serverConfig(),
      { onSessionOpened: vi.fn(), onSessionClosed },
      { log: vi.fn(), close: vi.fn() } as never,
      { socketFactory: fake.factory }
    );
    pty.open();
    fake.emitConnect();
    fake.emitClose();
    expect(onSessionClosed).toHaveBeenCalledTimes(1);
  });

  // ⊘ M11 (review) — `failConnect` idempotency. Two socket errors before the
  // connect completes is the ORDINARY shape of a failed connect on a dual-stack
  // host (one per address family), so a missing re-entry guard shows the user
  // two modal error toasts and writes the failure banner twice.
  it("reports a failed connect exactly once however many socket errors arrive", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitError(new Error("EHOSTUNREACH"));
    h.fake.emitError(new Error("ECONNREFUSED"));
    h.fake.emitClose();

    expect(h.callbacks.onConnectFailed).toHaveBeenCalledTimes(1);
    expect(rendered(h).match(/Connection failed/g)).toHaveLength(1);
    expect(rendered(h).match(/Press any key to close/g)).toHaveLength(1);
    expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalledTimes(1);
  });

  // ⊘ M37 (review) — `markShuttingDown` re-entry. The deactivate sweep can reach
  // a pty more than once (the subscription plus an explicit teardown), and
  // without the guard the tab ends up with two farewell banners and a second
  // socket destroy on an already-dead handle.
  it("writes the farewell banner exactly once when markShuttingDown is called twice", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.writes.length = 0;

    h.pty.markShuttingDown("Nexus Terminal is shutting down.");
    h.pty.markShuttingDown("Nexus Terminal is shutting down.");

    expect(rendered(h).match(/Nexus Terminal is shutting down\./g)).toHaveLength(1);
    expect(rendered(h).match(/Close this terminal and connect again/g)).toHaveLength(1);
  });

  // ⊘ M9 (review) — the `sendToSocket` disconnected guard. A macro or a script
  // that keeps writing after the remote hung up would otherwise write to a
  // destroyed socket; the guard is also what makes `writeProgrammatic`'s
  // "silently no-ops if the session is disconnected" contract true
  // (SessionPtyHandle, models/config.ts).
  it("writes nothing to the socket once disconnected, from either input path", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.fake.emitClose();
    h.fake.writes.length = 0;

    h.pty.writeProgrammatic("enable\r");
    h.pty.handleInput("x");

    expect(h.fake.writes).toHaveLength(0);
  });

  it("writes nothing to the socket before the connection is up", () => {
    const h = harness();
    h.pty.open();
    h.pty.writeProgrammatic("too early\r");
    expect(h.fake.writes).toHaveLength(0);
  });

  it("surfaces a mid-session socket error and then disconnects", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.fake.emitError(new Error("ECONNRESET"));

    expect(rendered(h)).toContain("[Nexus Telnet Error] ECONNRESET");
    expect(h.callbacks.onConnectFailed).not.toHaveBeenCalled();
  });
});

describe("TelnetPty — data path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ⊘ THE CORE PARITY REQUIREMENT. An observer wired before the IAC strip sees
  // 0xFF 0xFB 0x01 in the middle of a prompt, so every script `waitFor` and every
  // macro trigger can miss a match that is on screen.
  it("hands observers IAC-stripped output, never raw protocol bytes", () => {
    const h = harness();
    const seen: string[] = [];
    h.pty.addOutputObserver({
      onOutput: (text) => seen.push(text),
      pauseIntervalMacros: () => {},
      dispose: () => {}
    });
    h.pty.open();
    h.fake.emitConnect();
    h.fake.emitData(Buffer.concat([Buffer.from("Router"), Buffer.from([IAC, WILL, OPT_ECHO]), Buffer.from("> ")]));

    expect(seen.join("")).toBe("Router> ");
    expect(seen.join("")).not.toContain("ÿ");
  });

  it("renders IAC-stripped output to the terminal", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.fake.emitData(Buffer.concat([Buffer.from([IAC, WILL, OPT_ECHO]), Buffer.from("banner")]));
    expect(rendered(h)).toContain("banner");
  });

  it("answers negotiation on the socket without echoing it to the terminal", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.fake.writes.length = 0;
    h.fake.emitData(Buffer.from([IAC, WILL, OPT_ECHO]));

    expect(sent(h)).toEqual([IAC, DO, OPT_ECHO]);
  });

  // ⊘ A pty that decodes each chunk with `toString("utf8")` independently emits
  // two replacement characters where one multibyte character was split by TCP.
  it("reassembles a UTF-8 character split across two socket chunks", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    const encoded = Buffer.from("é", "utf8");
    h.fake.emitData(encoded.subarray(0, 1));
    h.fake.emitData(encoded.subarray(1));

    expect(rendered(h)).toContain("é");
    expect(rendered(h)).not.toContain("�");
  });

  it("fires onDataReceived for each inbound chunk carrying data", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.fake.emitData(Buffer.from("a"));
    h.fake.emitData(Buffer.from("b"));
    expect(h.callbacks.onDataReceived).toHaveBeenCalledTimes(2);
  });
});

describe("TelnetPty — input handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes keystrokes to the socket with NVT newline translation", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.fake.writes.length = 0;

    h.pty.handleInput("show ver\r");
    expect(Buffer.concat(h.fake.writes).toString("utf8")).toBe("show ver\r\n");
  });

  // ⊘ setInputBlocked that only stops the notice, not the write, lets a script's
  // session take stray keystrokes mid-run.
  it("drops keystrokes while input is blocked and emits the one-shot locked notice", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.fake.writes.length = 0;
    h.writes.length = 0;

    h.pty.setInputBlocked(true);
    h.pty.handleInput("a");
    h.pty.handleInput("b");

    expect(h.fake.writes).toHaveLength(0);
    expect(rendered(h)).toBe(INPUT_LOCKED_NOTICE);
  });

  it("resumes writing keystrokes once input is unblocked", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.pty.setInputBlocked(true);
    h.pty.handleInput("a");
    h.fake.writes.length = 0;
    h.pty.setInputBlocked(false);
    h.pty.handleInput("b");

    expect(Buffer.concat(h.fake.writes).toString("utf8")).toBe("b");
  });

  it("writeProgrammatic bypasses the input lock (scripts own it)", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.pty.setInputBlocked(true);
    h.fake.writes.length = 0;

    h.pty.writeProgrammatic("enable\r");
    expect(Buffer.concat(h.fake.writes).toString("utf8")).toBe("enable\r\n");
  });

  it("writeProgrammatic is a no-op once the session is disconnected", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.fake.emitClose();
    h.fake.writes.length = 0;

    h.pty.writeProgrammatic("late");
    expect(h.fake.writes).toHaveLength(0);
  });

  it("sends a NAWS update when the terminal is resized after NAWS is agreed", () => {
    const h = harness();
    h.pty.open({ columns: 80, rows: 24 });
    h.fake.emitConnect();
    h.fake.emitData(Buffer.from([IAC, DO, 31]));
    h.fake.writes.length = 0;

    h.pty.setDimensions({ columns: 120, rows: 40 });
    expect(sent(h)).toEqual([IAC, 250, 31, 0, 120, 0, 40, IAC, 240]);
  });
});

describe("TelnetPty — SessionPtyHandle parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ⊘ A resetTerminal that writes the escape to the SOCKET clears the remote
  // device's screen (or, on a console server, whatever is on the far side).
  it("resetTerminal clears the local screen and sends nothing to the socket", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.fake.writes.length = 0;
    h.writes.length = 0;

    h.pty.resetTerminal();
    expect(rendered(h)).toBe(CLEAR_VISIBLE_SCREEN);
    expect(h.fake.writes).toHaveLength(0);
  });

  it("markShuttingDown destroys the socket and leaves a farewell banner", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    const closed = vi.fn();
    h.pty.onDidClose(closed);

    h.pty.markShuttingDown("Nexus Terminal is shutting down.");

    expect(h.fake.destroy).toHaveBeenCalled();
    expect(rendered(h)).toContain("[Nexus Telnet] Nexus Terminal is shutting down.");
    // Contract: markShuttingDown must NOT close the tab (models/config.ts).
    expect(closed).not.toHaveBeenCalled();
  });

  it("markShuttingDown swallows later keystrokes instead of closing the tab", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    h.pty.markShuttingDown("bye");
    const closed = vi.fn();
    h.pty.onDidClose(closed);

    h.pty.handleInput("x");
    expect(closed).not.toHaveBeenCalled();
  });

  it("dispose destroys the socket and unregisters the session exactly once", () => {
    const h = harness();
    h.pty.open();
    h.fake.emitConnect();
    const sessionId = h.callbacks.onSessionOpened.mock.calls[0][0] as string;

    h.pty.dispose();
    h.pty.dispose();

    expect(h.fake.destroy).toHaveBeenCalled();
    expect(h.callbacks.onSessionClosed).toHaveBeenCalledTimes(1);
    expect(h.callbacks.onSessionClosed).toHaveBeenCalledWith(sessionId);
  });

  it("removes an output observer when its disposable is disposed", () => {
    const h = harness();
    const seen: string[] = [];
    const sub = h.pty.addOutputObserver({
      onOutput: (text) => seen.push(text),
      pauseIntervalMacros: () => {},
      dispose: () => {}
    });
    h.pty.open();
    h.fake.emitConnect();
    h.fake.emitData(Buffer.from("one"));
    sub.dispose();
    h.fake.emitData(Buffer.from("two"));

    expect(seen.join("")).toBe("one");
  });
});
