import { beforeEach, describe, expect, it, vi } from "vitest";
import { SerialPty, type SerialTransport } from "../../src/services/serial/serialPty";
import { CLEAR_VISIBLE_SCREEN } from "../../src/services/terminal/terminalEscapes";

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
  }
}));

type DataListener = (sessionId: string, data: Buffer) => void;
type ErrorListener = (sessionId: string, message: string) => void;
type DisconnectListener = (sessionId: string, reason: string) => void;

function createTransport(): {
  transport: SerialTransport;
  emitData: (sessionId: string, payload: string) => void;
  emitError: (sessionId: string, message: string) => void;
  emitDisconnect: (sessionId: string, reason: string) => void;
  writePort: ReturnType<typeof vi.fn>;
  closePort: ReturnType<typeof vi.fn>;
} {
  const dataListeners = new Set<DataListener>();
  const errorListeners = new Set<ErrorListener>();
  const disconnectListeners = new Set<DisconnectListener>();
  const writePort = vi.fn(async () => {});
  const closePort = vi.fn(async () => {});

  const transport: SerialTransport = {
    openPort: vi.fn(async () => "session-1"),
    writePort,
    closePort,
    onDidReceiveData(listener) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onDidReceiveError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    onDidDisconnect(listener) {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    }
  };

  return {
    transport,
    emitData: (sessionId, payload) => {
      for (const listener of dataListeners) {
        listener(sessionId, Buffer.from(payload, "utf8"));
      }
    },
    emitError: (sessionId, message) => {
      for (const listener of errorListeners) {
        listener(sessionId, message);
      }
    },
    emitDisconnect: (sessionId, reason) => {
      for (const listener of disconnectListeners) {
        listener(sessionId, reason);
      }
    },
    writePort,
    closePort
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SerialPty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enters disconnected state on sidecar disconnect notification", async () => {
    const { transport, emitDisconnect, closePort } = createTransport();
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn()
    };
    const logger = {
      log: vi.fn(),
      close: vi.fn()
    };
    const writes: string[] = [];

    const pty = new SerialPty(
      transport,
      { path: "COM9", baudRate: 115200 },
      callbacks,
      logger as any
    );
    pty.onDidWrite((chunk) => writes.push(chunk));

    pty.open();
    await flushAsync();

    emitDisconnect("session-1", "Port closed");
    expect(callbacks.onSessionClosed).toHaveBeenCalledWith("session-1");
    expect(writes.join("")).toContain("Port disconnected");

    pty.handleInput("x");
    expect(closePort).not.toHaveBeenCalled();
  });

  it("fires onDataReceived callback when transport data arrives", async () => {
    const { transport, emitData } = createTransport();
    const onDataReceived = vi.fn();
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn(),
      onDataReceived
    };
    const logger = { log: vi.fn(), close: vi.fn() };

    const pty = new SerialPty(
      transport,
      { path: "COM9", baudRate: 115200 },
      callbacks,
      logger as any
    );

    pty.open();
    await flushAsync();

    emitData("session-1", "hello");
    expect(onDataReceived).toHaveBeenCalledWith("session-1");

    emitData("session-1", "world");
    expect(onDataReceived).toHaveBeenCalledTimes(2);

    pty.dispose();
  });

  it("pauses interval macros when the serial session disconnects", async () => {
    const { transport, emitDisconnect } = createTransport();
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn()
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

    const pty = new SerialPty(
      transport,
      { path: "COM9", baudRate: 115200 },
      callbacks,
      logger as any,
      undefined,
      undefined,
      outputObserver
    );

    pty.open();
    await flushAsync();

    emitDisconnect("session-1", "Port closed");

    expect(outputObserver.pauseIntervalMacros).toHaveBeenCalledTimes(1);

    pty.dispose();
  });

  it("updates the terminal name when activity is flagged and clears it on disconnect", async () => {
    const { transport, emitDisconnect } = createTransport();
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn()
    };
    const logger = {
      log: vi.fn(),
      close: vi.fn()
    };
    const nameChanges: string[] = [];

    const pty = new SerialPty(
      transport,
      { path: "COM9", baudRate: 115200 },
      callbacks,
      logger as any
    );
    pty.onDidChangeName((name) => {
      nameChanges.push(name);
    });

    pty.open();
    await flushAsync();

    pty.setActivityIndicator(true);
    pty.setActivityIndicator(true);
    expect(nameChanges).toEqual(["\u25cf Nexus Serial: COM9"]);

    emitDisconnect("session-1", "Port closed");
    expect(nameChanges.at(-1)).toBe("Nexus Serial: COM9 [Disconnected]");

    pty.setActivityIndicator(true);
    expect(nameChanges.at(-1)).toBe("Nexus Serial: COM9 [Disconnected]");
  });

  it("shows serial errors without forcing disconnect", async () => {
    const { transport, emitError, writePort, closePort } = createTransport();
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn()
    };
    const logger = {
      log: vi.fn(),
      close: vi.fn()
    };

    const pty = new SerialPty(
      transport,
      { path: "COM9", baudRate: 115200 },
      callbacks,
      logger as any
    );

    pty.open();
    await flushAsync();

    emitError("session-1", "Parity check warning");
    expect(callbacks.onSessionClosed).not.toHaveBeenCalled();

    pty.handleInput("A");
    expect(writePort).toHaveBeenCalledTimes(1);

    pty.dispose();
    expect(closePort).toHaveBeenCalledWith("session-1");
  });

  it("flushes buffered highlighted output before disconnect messaging", async () => {
    const { transport, emitData, emitDisconnect } = createTransport();
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn()
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

    const pty = new SerialPty(
      transport,
      { path: "COM9", baudRate: 115200 },
      callbacks,
      logger as any,
      undefined,
      highlighter as any
    );
    pty.onDidWrite((chunk) => writes.push(chunk));

    pty.open();
    await flushAsync();

    emitData("session-1", "ERR");
    expect(highlighterStream.push).toHaveBeenCalledWith("ERR");
    expect(writes).toEqual(["\r\n[Nexus Serial] Connected COM9 @ 115200 (8N1)\r\n"]);

    emitDisconnect("session-1", "Port closed");

    expect(highlighter.createStream).toHaveBeenCalledTimes(1);
    expect(highlighterStream.flush).toHaveBeenCalledTimes(1);
    expect(writes[1]).toBe("[hl]ERR");
    expect(writes.slice(2).join("")).toContain("Port disconnected");
  });

  it("resetTerminal() emits CLEAR_VISIBLE_SCREEN via writeEmitter and does not write to the transport", () => {
    const { transport, writePort } = createTransport();
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const pty = new SerialPty(
      transport,
      { path: "COM9", baudRate: 115200 },
      callbacks,
      logger as any
    );
    const writes: string[] = [];
    pty.onDidWrite((s) => writes.push(s));
    pty.resetTerminal();
    expect(writes).toContain(CLEAR_VISIBLE_SCREEN);
    expect(writePort).not.toHaveBeenCalled();
  });

  it("markShuttingDown() writes a farewell banner, keeps the tab open, and locks input", async () => {
    const { transport, writePort, closePort } = createTransport();
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const pty = new SerialPty(
      transport,
      { path: "COM9", baudRate: 115200 },
      callbacks,
      logger as any
    );
    const writes: string[] = [];
    pty.onDidWrite((s) => writes.push(s));
    const closes: void[] = [];
    pty.onDidClose(() => closes.push());
    const nameChanges: string[] = [];
    pty.onDidChangeName((n) => nameChanges.push(n));

    pty.open();
    await flushAsync();
    writes.length = 0;

    pty.markShuttingDown("Nexus extension is shutting down. This session has been closed.");

    expect(writes.join("")).toContain("Nexus extension is shutting down");
    expect(writes.join("")).toContain("Close this terminal and reopen the serial profile to reconnect.");
    expect(nameChanges.at(-1)).toBe("Nexus Serial: COM9 [Disconnected]");
    expect(closes).toHaveLength(0);
    expect(callbacks.onSessionClosed).not.toHaveBeenCalled();

    // Input after shutdown must not dispose or write to the transport.
    pty.handleInput("x");
    expect(closes).toHaveLength(0);
    expect(writePort).not.toHaveBeenCalled();
    expect(closePort).not.toHaveBeenCalled();
  });

  it("markShuttingDown() is idempotent", async () => {
    const { transport } = createTransport();
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() };
    const pty = new SerialPty(
      transport,
      { path: "COM9", baudRate: 115200 },
      callbacks,
      logger as any
    );
    pty.open();
    await flushAsync();
    const writes: string[] = [];
    pty.onDidWrite((s) => writes.push(s));

    pty.markShuttingDown("reason");
    const firstLen = writes.length;
    pty.markShuttingDown("reason");
    expect(writes.length).toBe(firstLen);
  });
});
