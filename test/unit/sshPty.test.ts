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
});
