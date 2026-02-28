import { beforeEach, describe, expect, it, vi } from "vitest";
import { SerialPty, type SerialTransport } from "../../src/services/serial/serialPty";

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
});
