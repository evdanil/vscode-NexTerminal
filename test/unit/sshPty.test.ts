import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../../src/models/config";
import { SshPty } from "../../src/services/ssh/sshPty";
import { CLEAR_VISIBLE_SCREEN } from "../../src/services/terminal/terminalEscapes";

const { mockShowErrorMessage } = vi.hoisted(() => ({
  mockShowErrorMessage: vi.fn()
}));

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
  // `PtyObserverHub.addOutputObserver` returns `new vscode.Disposable(...)`,
  // so the mock needs it for any test that attaches an observer the same way
  // production does (`serverCommands.ts`'s OSC 7 observer).
  Disposable: class MockDisposable {
    public constructor(private readonly callOnDispose: () => void) {}

    public dispose(): void {
      this.callOnDispose();
    }
  },
  window: {
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args)
  }
}));

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Server 1",
    host: "example.com",
    port: 22,
    username: "dev",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

function createConnection(stream: PassThrough, banner?: string): {
  connection: {
    openShell: ReturnType<typeof vi.fn>;
    getBanner: ReturnType<typeof vi.fn>;
    onClose: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  emitClose: () => void;
} {
  let closeListener: (() => void) | undefined;
  return {
    connection: {
      openShell: vi.fn(async () => stream),
      getBanner: vi.fn(() => banner),
      onClose: vi.fn((listener: () => void) => {
        closeListener = listener;
        return () => {
          if (closeListener === listener) {
            closeListener = undefined;
          }
        };
      }),
      dispose: vi.fn()
    },
    emitClose: () => closeListener?.()
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("SshPty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes pre-auth banner to terminal with CRLF normalization", async () => {
    const stream = new PassThrough();
    const connection = {
      openShell: vi.fn(async () => stream),
      getBanner: vi.fn(() => "Authorized users only\nDisconnect if not authorized"),
      onClose: vi.fn(() => () => {}),
      dispose: vi.fn()
    };
    const sshFactory = { connect: vi.fn(async () => connection) };
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn()
    };
    const logger = {
      log: vi.fn(),
      close: vi.fn()
    };
    const writes: string[] = [];
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    pty.onDidWrite((text) => {
      writes.push(text);
    });

    pty.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.getBanner).toHaveBeenCalledTimes(1);
    expect(writes[0]).toBe("Authorized users only\r\nDisconnect if not authorized");
    expect(mockShowErrorMessage).not.toHaveBeenCalled();

    pty.dispose();
  });

  it("uses connectWithContext with an onAuthMessage sink when the factory is context-aware", async () => {
    const stream = new PassThrough();
    const { connection } = createConnection(stream);
    const sshFactory = {
      connect: vi.fn(async () => connection),
      connectWithContext: vi.fn(async () => connection)
    };
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const server = makeServer();
    const pty = new SshPty(server, sshFactory as any, callbacks, logger as any);

    pty.open();
    await flushAsync();

    expect(sshFactory.connectWithContext).toHaveBeenCalledWith(
      server,
      expect.objectContaining({ onAuthMessage: expect.any(Function) })
    );
    expect(sshFactory.connect).not.toHaveBeenCalled();

    pty.dispose();
  });

  it("writes MFA auth messages (banner / keyboard-interactive name+instructions) via the onAuthMessage sink with CRLF normalization", async () => {
    const stream = new PassThrough();
    const { connection } = createConnection(stream);
    let capturedSink: ((text: string) => void) | undefined;
    const sshFactory = {
      connect: vi.fn(async () => connection),
      connectWithContext: vi.fn(async (_server: ServerConfig, context?: { onAuthMessage?: (text: string) => void }) => {
        capturedSink = context?.onAuthMessage;
        // Simulate the server pushing MFA context before the prompt resolves,
        // i.e. while auth is still in flight (before the connect() promise settles).
        capturedSink?.("Duo two-factor login\nEnter a passcode or select one of the following options:");
        capturedSink?.("Already CRLF-terminated\r\n");
        return connection;
      })
    };
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const writes: string[] = [];
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    pty.onDidWrite((text) => writes.push(text));

    pty.open();
    await flushAsync();

    expect(writes).toContain(
      "Duo two-factor login\r\nEnter a passcode or select one of the following options:\r\n"
    );
    expect(writes).toContain("Already CRLF-terminated\r\n");

    pty.dispose();
  });

  it("normalizes a lone CR (not followed by LF) to CRLF instead of leaving a bare cursor-to-column-0", async () => {
    const stream = new PassThrough();
    const { connection } = createConnection(stream);
    let capturedSink: ((text: string) => void) | undefined;
    const sshFactory = {
      connect: vi.fn(async () => connection),
      connectWithContext: vi.fn(async (_server: ServerConfig, context?: { onAuthMessage?: (text: string) => void }) => {
        capturedSink = context?.onAuthMessage;
        // A bare CR left un-normalized is cursor-to-column-0 in VS Code's
        // terminal — a malicious server could use it to overwrite/spoof an
        // already-rendered line.
        capturedSink?.("REAL PROMPT\rFAKE");
        return connection;
      })
    };
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const writes: string[] = [];
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    pty.onDidWrite((text) => writes.push(text));

    pty.open();
    await flushAsync();

    expect(writes).toContain("REAL PROMPT\r\nFAKE\r\n");
    // No bare CR should survive — every CR must be part of a CRLF pair.
    const combined = writes.join("");
    expect(combined.replace(/\r\n/g, "")).not.toContain("\r");

    pty.dispose();
  });

  it("strips ANSI escapes and C0 control chars from auth messages before writing (server-controlled text)", async () => {
    const stream = new PassThrough();
    const { connection } = createConnection(stream);
    let capturedSink: ((text: string) => void) | undefined;
    const sshFactory = {
      connect: vi.fn(async () => connection),
      connectWithContext: vi.fn(async (_server: ServerConfig, context?: { onAuthMessage?: (text: string) => void }) => {
        capturedSink = context?.onAuthMessage;
        // A malicious/misbehaving server could smuggle a cursor-move + bell
        // + other C0 control bytes into the banner or KI name/instructions.
        capturedSink?.("\x1b[2J\x1b[HFake login prompt\x07\x01\x0bstill here");
        return connection;
      })
    };
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const writes: string[] = [];
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    pty.onDidWrite((text) => writes.push(text));

    pty.open();
    await flushAsync();

    const combined = writes.join("");
    expect(combined).not.toContain("\x1b");
    expect(combined).not.toContain("\x07");
    expect(combined).not.toContain("\x01");
    expect(combined).not.toContain("\x0b");
    expect(combined).toContain("Fake login promptstill here");

    pty.dispose();
  });

  it("suppresses an auth message that is blank after ANSI/control-char stripping", async () => {
    const stream = new PassThrough();
    const { connection } = createConnection(stream);
    let capturedSink: ((text: string) => void) | undefined;
    const sshFactory = {
      connect: vi.fn(async () => connection),
      connectWithContext: vi.fn(async (_server: ServerConfig, context?: { onAuthMessage?: (text: string) => void }) => {
        capturedSink = context?.onAuthMessage;
        // Nothing left after stripping the escape sequence and control chars.
        capturedSink?.("\x1b[2J\x07\x01  ");
        return connection;
      })
    };
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const writes: string[] = [];
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    pty.onDidWrite((text) => writes.push(text));

    pty.open();
    await flushAsync();

    expect(writes).toEqual([]);

    pty.dispose();
  });

  it("auth-message sink is a no-op once markShuttingDown() has fired", async () => {
    const stream = new PassThrough();
    const { connection } = createConnection(stream);
    let capturedSink: ((text: string) => void) | undefined;
    const sshFactory = {
      connect: vi.fn(async () => connection),
      connectWithContext: vi.fn(async (_server: ServerConfig, context?: { onAuthMessage?: (text: string) => void }) => {
        capturedSink = context?.onAuthMessage;
        return connection;
      })
    };
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn(), onDisconnected: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    const writes: string[] = [];
    pty.onDidWrite((text) => writes.push(text));

    pty.open();
    await flushAsync();

    pty.markShuttingDown("shutting down");
    writes.length = 0;

    capturedSink?.("late MFA message");
    expect(writes).toEqual([]);
  });

  it("ignores stale onAuthMessage sink invocations from a superseded (reconnected) connection attempt", async () => {
    const stream1 = new PassThrough();
    const first = createConnection(stream1);
    const stream2 = new PassThrough();
    const second = createConnection(stream2);
    let firstSink: ((text: string) => void) | undefined;
    let secondSink: ((text: string) => void) | undefined;
    let callCount = 0;
    const sshFactory = {
      connect: vi.fn(),
      connectWithContext: vi.fn(async (_server: ServerConfig, context?: { onAuthMessage?: (text: string) => void }) => {
        callCount += 1;
        if (callCount === 1) {
          firstSink = context?.onAuthMessage;
          return first.connection;
        }
        secondSink = context?.onAuthMessage;
        return second.connection;
      })
    };
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn(), onDisconnected: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    const writes: string[] = [];
    pty.onDidWrite((text) => writes.push(text));

    pty.open();
    await flushAsync();

    first.emitClose();
    await flushAsync();

    pty.handleInput("R");
    await flushAsync();

    writes.length = 0;
    firstSink?.("stale message");
    expect(writes).toEqual([]);

    secondSink?.("fresh message");
    expect(writes).toContain("fresh message\r\n");

    pty.dispose();
  });

  it("fires onDataReceived callback when stream data arrives", async () => {
    const stream = new PassThrough();
    const { connection } = createConnection(stream);
    const sshFactory = { connect: vi.fn(async () => connection) };
    const onDataReceived = vi.fn();
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn(),
      onDataReceived
    };
    const logger = { log: vi.fn(), close: vi.fn() };

    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    pty.open();
    await flushAsync();

    const receivedSessionId = callbacks.onSessionOpened.mock.calls[0][0];

    stream.push("hello");
    expect(onDataReceived).toHaveBeenCalledWith(receivedSessionId);

    stream.push("world");
    expect(onDataReceived).toHaveBeenCalledTimes(2);

    pty.dispose();
  });

  it("pauses interval macros when the SSH session disconnects", async () => {
    const stream = new PassThrough();
    const first = createConnection(stream);
    const sshFactory = { connect: vi.fn(async () => first.connection) };
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn(),
      onDisconnected: vi.fn()
    };
    const logger = {
      log: vi.fn(),
      close: vi.fn()
    };
    const outputObserver = {
      onOutput: vi.fn(),
      pauseIntervalMacros: vi.fn(),
      dispose: vi.fn()
    };

    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any, undefined, undefined, outputObserver);
    pty.open();
    await flushAsync();

    first.emitClose();
    await flushAsync();

    expect(outputObserver.pauseIntervalMacros).toHaveBeenCalledTimes(1);

    pty.dispose();
  });

  it("reports when the remote host closes the shell stream", async () => {
    const stream = new PassThrough();
    const { connection } = createConnection(stream);
    const sshFactory = { connect: vi.fn(async () => connection) };
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn(),
      onDisconnected: vi.fn()
    };
    const logger = {
      log: vi.fn(),
      close: vi.fn()
    };
    const writes: string[] = [];
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    pty.onDidWrite((text) => {
      writes.push(text);
    });

    pty.open();
    await flushAsync();

    stream.emit("end");
    await flushAsync();

    expect(callbacks.onDisconnected).toHaveBeenCalledTimes(1);
    expect(writes).toContain("\r\n\r\n[Nexus SSH] Remote host closed the session.\r\n");

    pty.dispose();
  });

  it("flushes buffered highlighted output before disconnect messaging", async () => {
    const stream = new PassThrough();
    const { connection, emitClose } = createConnection(stream);
    const sshFactory = { connect: vi.fn(async () => connection) };
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn(),
      onDisconnected: vi.fn()
    };
    const logger = {
      log: vi.fn(),
      close: vi.fn()
    };
    const writes: string[] = [];
    let buffered = "";
    const highlighterStream = {
      push: vi.fn((text: string) => {
        buffered += text;
      }),
      flush: vi.fn(() => {
        if (buffered) {
          writes.push(`[hl]${buffered}`);
          buffered = "";
        }
      }),
      dispose: vi.fn()
    };
    const highlighter = {
      createStream: vi.fn(() => highlighterStream)
    };
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any, undefined, highlighter as any);
    pty.onDidWrite((text) => {
      writes.push(text);
    });

    pty.open();
    await flushAsync();

    stream.push("ERR");
    expect(highlighterStream.push).toHaveBeenCalledWith("ERR");
    expect(writes).toEqual([]);

    emitClose();
    await flushAsync();

    expect(highlighter.createStream).toHaveBeenCalledTimes(1);
    expect(highlighterStream.flush).toHaveBeenCalledTimes(1);
    expect(writes[0]).toBe("[hl]ERR");
    expect(writes.slice(1).join("")).toContain("Connection lost");

    pty.dispose();
  });

  /**
   * Directory sync (issue #35, §6.3/§10). `serverCommands.ts` attaches its
   * `Osc7Parser`-backed observer with `pty.addOutputObserver(...)` and depends
   * on receiving the *raw* stream text: OSC 7 bytes intact, and delivered
   * synchronously with the chunk rather than behind the highlighter's own
   * line-buffering/flush timer.
   *
   * This test deliberately constructs the PTY **with** a highlighter.
   * `SshPty`'s `highlighterStream` only exists when one is passed
   * (`sshPty.ts` constructor), so a highlighter-less variant of this test
   * would still pass even if OSC 7 handling were wrongly placed downstream of
   * the highlighter — where it would strip or delay what the observer sees.
   */
  it("delivers raw OSC 7 sequences to output observers unmodified, ahead of the highlighter's buffering", async () => {
    const stream = new PassThrough();
    const { connection } = createConnection(stream);
    const sshFactory = { connect: vi.fn(async () => connection) };
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn(),
      onDisconnected: vi.fn()
    };
    const logger = {
      log: vi.fn(),
      close: vi.fn()
    };

    // A line-buffering highlighter: nothing reaches the renderer until flush.
    let buffered = "";
    const highlighterStream = {
      push: vi.fn((text: string) => {
        buffered += text;
      }),
      flush: vi.fn(() => {
        buffered = "";
      }),
      dispose: vi.fn()
    };
    const highlighter = { createStream: vi.fn(() => highlighterStream) };

    const observed: string[] = [];
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any, undefined, highlighter as any);
    pty.addOutputObserver({
      onOutput: (text: string) => {
        observed.push(text);
      },
      pauseIntervalMacros: vi.fn(),
      dispose: vi.fn()
    } as any);

    pty.open();
    await flushAsync();
    expect(highlighter.createStream).toHaveBeenCalledTimes(1);

    // BEL-terminated form.
    const osc7Bel = "\x1b]7;file://host/tmp/work\x07";
    stream.push(`before${osc7Bel}after`);
    await flushAsync();

    expect(observed).toEqual([`before${osc7Bel}after`]);
    // The observer must not be gated on the highlighter emitting anything.
    expect(highlighterStream.flush).not.toHaveBeenCalled();
    expect(highlighterStream.push).toHaveBeenCalledWith(`before${osc7Bel}after`);

    // ST-terminated form (ESC \).
    const osc7St = "\x1b]7;file://host/etc\x1b\\";
    stream.push(osc7St);
    await flushAsync();

    expect(observed[1]).toBe(osc7St);

    pty.dispose();
  });

  it("allows activity indicators to be restored as soon as a reconnect session opens", async () => {
    const stream1 = new PassThrough();
    const first = createConnection(stream1);
    const stream2 = new PassThrough();
    const second = createConnection(stream2);
    const sshFactory = {
      connect: vi
        .fn()
        .mockResolvedValueOnce(first.connection)
        .mockResolvedValueOnce(second.connection)
    };
    const logger = {
      log: vi.fn(),
      close: vi.fn()
    };
    const nameChanges: string[] = [];
    let openCount = 0;
    let pty!: SshPty;
    const callbacks = {
      onSessionOpened: vi.fn(() => {
        openCount += 1;
        if (openCount === 2) {
          pty.setActivityIndicator(true);
        }
      }),
      onSessionClosed: vi.fn(),
      onDisconnected: vi.fn()
    };

    pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    pty.onDidChangeName((name) => {
      nameChanges.push(name);
    });

    pty.open();
    await flushAsync();

    first.emitClose();
    await flushAsync();
    nameChanges.length = 0;

    pty.handleInput("R");
    await flushAsync();

    expect(nameChanges.at(-1)).toBe("\u25cf Nexus SSH: Server 1");

    pty.dispose();
  });

  it("ignores stale disconnect events from a previous connection during reconnect", async () => {
    const stream1 = new PassThrough();
    const first = createConnection(stream1);

    const stream2 = new PassThrough();
    const openShell2 = deferred<PassThrough>();
    const second = createConnection(stream2);
    second.connection.openShell = vi.fn(() => openShell2.promise);

    const sshFactory = {
      connect: vi
        .fn()
        .mockResolvedValueOnce(first.connection)
        .mockResolvedValueOnce(second.connection)
    };
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn(),
      onDisconnected: vi.fn()
    };
    const logger = {
      log: vi.fn(),
      close: vi.fn()
    };
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);

    pty.open();
    await flushAsync();

    first.emitClose();
    await flushAsync();
    expect(callbacks.onDisconnected).toHaveBeenCalledTimes(1);

    pty.handleInput("R");
    await Promise.resolve();

    // Late close from the old connection must not tear down reconnect state.
    first.emitClose();

    openShell2.resolve(stream2);
    await flushAsync();

    const writeSpy = vi.spyOn(stream2, "write");
    pty.handleInput("echo");
    expect(writeSpy).toHaveBeenCalled();
    expect(callbacks.onDisconnected).toHaveBeenCalledTimes(1);

    pty.dispose();
  });

  it("resetTerminal() emits CLEAR_VISIBLE_SCREEN via writeEmitter and does not write to the transport", () => {
    const stream = new PassThrough();
    const { connection } = createConnection(stream);
    const sshFactory = { connect: vi.fn(async () => connection) };
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    const writes: string[] = [];
    pty.onDidWrite((s) => writes.push(s));
    const transportSpy = vi.spyOn(stream, "write");
    pty.resetTerminal();
    expect(writes).toContain(CLEAR_VISIBLE_SCREEN);
    expect(transportSpy).not.toHaveBeenCalled();
    pty.dispose();
  });

  it("markShuttingDown() writes a farewell banner, tears down transport, and keeps the tab open", async () => {
    const stream = new PassThrough();
    const { connection } = createConnection(stream);
    const sshFactory = { connect: vi.fn(async () => connection) };
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn(),
      onDisconnected: vi.fn()
    };
    const logger = { log: vi.fn(), close: vi.fn() };
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    const writes: string[] = [];
    pty.onDidWrite((s) => writes.push(s));
    const closes: void[] = [];
    pty.onDidClose(() => closes.push());
    const nameChanges: string[] = [];
    pty.onDidChangeName((n) => nameChanges.push(n));
    const streamDestroySpy = vi.spyOn(stream, "destroy");

    pty.open();
    await flushAsync();
    writes.length = 0;

    pty.markShuttingDown("Nexus extension is shutting down. This session has been closed.");

    expect(writes.join("")).toContain("Nexus extension is shutting down");
    expect(writes.join("")).toContain("Close this terminal and start a new session to reconnect.");
    expect(nameChanges.at(-1)).toBe("Nexus SSH: Server 1 [Disconnected]");
    expect(streamDestroySpy).toHaveBeenCalled();
    expect(connection.dispose).toHaveBeenCalled();
    expect(closes).toHaveLength(0);
    expect(callbacks.onSessionClosed).not.toHaveBeenCalled();

    // Input after shutdown must not re-dispose the pty (would close the tab).
    const writeSpyAfter = vi.spyOn(stream, "write");
    pty.handleInput("R");
    pty.handleInput("\r");
    expect(writeSpyAfter).not.toHaveBeenCalled();
    expect(closes).toHaveLength(0);
  });

  it("strips OSC 3008 context sequences from inbound SSH data before forwarding to writeEmitter", async () => {
    const stream = new PassThrough();
    const { connection } = createConnection(stream);
    const sshFactory = { connect: vi.fn(async () => connection) };
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn()
    };
    const logger = { log: vi.fn(), close: vi.fn() };
    const writes: string[] = [];
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    pty.onDidWrite((text) => writes.push(text));

    pty.open();
    await flushAsync();

    // Emit a line with an OSC 3008 sequence embedded (ST-terminated)
    const osc3008 = "\x1b]3008;start=abc;user=dev;pid=42\x1b\\";
    stream.push(`prompt> ${osc3008}$ `);
    await flushAsync();

    // The writeEmitter should have received text WITHOUT the OSC 3008 sequence
    const allOutput = writes.join("");
    expect(allOutput).not.toContain("\x1b]3008;");
    expect(allOutput).toContain("prompt> ");
    expect(allOutput).toContain("$ ");

    pty.dispose();
  });

  it("clears stale OSC 3008 carry on reconnect so the next session's leading output survives", async () => {
    const stream1 = new PassThrough();
    const first = createConnection(stream1);
    const stream2 = new PassThrough();
    const second = createConnection(stream2);
    const sshFactory = {
      connect: vi
        .fn()
        .mockResolvedValueOnce(first.connection)
        .mockResolvedValueOnce(second.connection)
    };
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn(),
      onDisconnected: vi.fn()
    };
    const logger = { log: vi.fn(), close: vi.fn() };
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    const writes: string[] = [];
    pty.onDidWrite((text) => writes.push(text));

    pty.open();
    await flushAsync();

    // Session A emits a chunk ending in an UNTERMINATED partial OSC 3008.
    // The filter holds the partial in carry — it must NOT reach the terminal.
    stream1.push("hello\x1b]3008;start=A;pid=1");
    await flushAsync();
    expect(writes.join("")).not.toContain("\x1b]3008;");
    expect(writes.join("")).toContain("hello");

    // Session A disconnects with that partial still held in carry.
    first.emitClose();
    await flushAsync();

    // Clear captured output so we only assess session B's bytes.
    writes.length = 0;

    // User presses R to reconnect — start() runs again on the SAME instance.
    pty.handleInput("R");
    await flushAsync();

    // Session B's first chunk: visible banner, then B's own BEL-terminated
    // OSC 3008 (its first prompt context line), then the prompt. If stale-A
    // carry survived, findTerminator fuses "<stale A partial>BANNER-B...<B's BEL>"
    // into ONE sequence and silently deletes B's leading visible output.
    stream2.push("BANNER-B\r\n\x1b]3008;start=B;pid=9\x07user@host:~$ ");
    await flushAsync();

    const sessionBOutput = writes.join("");
    expect(sessionBOutput).toContain("BANNER-B");
    expect(sessionBOutput).toContain("user@host:~$ ");
    // B's own 3008 is correctly stripped; no 3008 marker survives.
    expect(sessionBOutput).not.toContain("\x1b]3008;");
    // The stale-A partial must never resurface either.
    expect(sessionBOutput).not.toContain("start=A");

    pty.dispose();
  });

  it("markShuttingDown() is idempotent and safe to call twice", async () => {
    const stream = new PassThrough();
    const { connection } = createConnection(stream);
    const sshFactory = { connect: vi.fn(async () => connection) };
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn(), onDisconnected: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);

    pty.open();
    await flushAsync();

    const writes: string[] = [];
    pty.onDidWrite((s) => writes.push(s));

    pty.markShuttingDown("shutdown reason");
    const firstRoundLen = writes.length;
    pty.markShuttingDown("shutdown reason");
    expect(writes.length).toBe(firstRoundLen);
  });

  /**
   * REVIEW FINDING (P2) — the only signal a failed INITIAL connect emits
   * outside this class. Everything else about the failure is unchanged and
   * deliberately so: the error is still swallowed, the terminal is still left
   * open with the "press any key" notice, no session opens and nothing closes —
   * which is exactly why a caller waiting on a session (the connect-first macro
   * flow) needs to be told.
   */
  it("reports a failed initial connect through onConnectFailed, and still keeps the terminal open", async () => {
    const sshFactory = { connect: vi.fn(async () => { throw new Error("All configured authentication methods failed"); }) };
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn(), onConnectFailed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    let closed = false;
    pty.onDidClose(() => { closed = true; });

    pty.open();
    await flushAsync();

    expect(callbacks.onConnectFailed).toHaveBeenCalledTimes(1);
    expect(callbacks.onConnectFailed.mock.calls[0][1]).toBe("All configured authentication methods failed");
    // Unchanged contract: no session, no close, and the SSH layer still names
    // the cause itself — so a caller must not repeat it.
    expect(callbacks.onSessionOpened).not.toHaveBeenCalled();
    expect(callbacks.onSessionClosed).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    expect(mockShowErrorMessage).toHaveBeenCalledTimes(1);
  });

  it("does not fire onConnectFailed for a failed RECONNECT — that path rethrows to reconnect()", async () => {
    const stream = new PassThrough();
    const { connection, emitClose } = createConnection(stream);
    let attempt = 0;
    const sshFactory = {
      connect: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) return connection;
        throw new Error("host went away");
      })
    };
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn(), onConnectFailed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);

    pty.open();
    await flushAsync();
    emitClose();
    pty.handleInput("r");
    await flushAsync();

    expect(sshFactory.connect).toHaveBeenCalledTimes(2);
    expect(callbacks.onConnectFailed).not.toHaveBeenCalled();
  });
});
