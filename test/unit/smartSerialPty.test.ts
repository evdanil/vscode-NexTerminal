import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmartSerialPty, type SmartSerialTransport } from "../../src/services/serial/smartSerialPty";
import type { SerialProfile } from "../../src/models/config";
import type { OpenPortParams, SerialPortInfo } from "../../src/services/serial/protocol";

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

function makeProfile(overrides: Partial<SerialProfile> = {}): SerialProfile {
  return {
    id: "sp1",
    name: "Cisco Console",
    path: "COM5",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    rtscts: false,
    mode: "smartFollow",
    ...overrides
  };
}

function createTransport(options: {
  listPorts: () => Promise<SerialPortInfo[]>;
  openPort: (params: OpenPortParams) => Promise<string>;
}): {
  transport: SmartSerialTransport;
  openPort: ReturnType<typeof vi.fn>;
  emitDisconnect: (sessionId: string, reason: string) => void;
} {
  const dataListeners = new Set<DataListener>();
  const errorListeners = new Set<ErrorListener>();
  const disconnectListeners = new Set<DisconnectListener>();
  const openPort = vi.fn(options.openPort);

  const transport: SmartSerialTransport = {
    listPorts: vi.fn(options.listPorts),
    openPort,
    writePort: vi.fn(async () => {}),
    closePort: vi.fn(async () => {}),
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
    openPort,
    emitDisconnect: (sessionId, reason) => {
      for (const listener of disconnectListeners) {
        listener(sessionId, reason);
      }
    }
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe("SmartSerialPty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to a single available replacement port and updates the saved hint", async () => {
    const { transport, openPort } = createTransport({
      listPorts: async () => [{ path: "COM9", vendorId: "1111", productId: "2222", serialNumber: "ABC123" }],
      openPort: async (params) => {
        if (params.path === "COM5") {
          throw new Error("Port COM5 not found. Check that the device is connected and the port name is correct.");
        }
        return "session-1";
      }
    });
    const callbacks = {
      onClosed: vi.fn(),
      onTransportSessionChanged: vi.fn(),
      onResolvedPort: vi.fn()
    };
    const logger = { log: vi.fn(), close: vi.fn() };
    const writes: string[] = [];

    const pty = new SmartSerialPty(transport, makeProfile(), callbacks, logger as any);
    pty.onDidWrite((chunk) => writes.push(chunk));

    pty.open();
    await flushAsync();

    expect(openPort).toHaveBeenNthCalledWith(1, expect.objectContaining({ path: "COM5" }));
    expect(openPort).toHaveBeenNthCalledWith(2, expect.objectContaining({ path: "COM9" }));
    expect(callbacks.onTransportSessionChanged).toHaveBeenLastCalledWith("session-1");
    expect(callbacks.onResolvedPort).toHaveBeenCalledWith("COM9", {
      serialNumber: "ABC123",
      vendorId: "1111",
      productId: "2222"
    });
    expect(writes.join("")).toContain("Preferred port updated from COM5 to COM9");

    pty.dispose();
  });

  it("waits after disconnect and reattaches when a safe replacement port appears", async () => {
    vi.useFakeTimers();
    let currentPorts: SerialPortInfo[] = [{ path: "COM5", serialNumber: "ABC123" }];
    let opens = 0;
    const { transport, emitDisconnect, openPort } = createTransport({
      listPorts: async () => currentPorts,
      openPort: async (params) => {
        opens += 1;
        if (opens === 1 && params.path === "COM5") {
          return "session-1";
        }
        if (params.path === "COM5") {
          throw new Error("Port COM5 not found. Check that the device is connected and the port name is correct.");
        }
        return "session-2";
      }
    });
    const callbacks = {
      onClosed: vi.fn(),
      onTransportSessionChanged: vi.fn(),
      onResolvedPort: vi.fn()
    };
    const logger = { log: vi.fn(), close: vi.fn() };
    const writes: string[] = [];

    const pty = new SmartSerialPty(transport, makeProfile(), callbacks, logger as any);
    pty.onDidWrite((chunk) => writes.push(chunk));

    pty.open();
    await flushAsync();

    emitDisconnect("session-1", "Port closed");
    expect(writes.join("")).toContain("waiting for it or a safe replacement port to appear");

    currentPorts = [{ path: "COM9", serialNumber: "ABC123" }];
    await vi.advanceTimersByTimeAsync(2000);
    await flushAsync();

    expect(openPort).toHaveBeenNthCalledWith(2, expect.objectContaining({ path: "COM5" }));
    expect(openPort).toHaveBeenNthCalledWith(3, expect.objectContaining({ path: "COM9" }));
    expect(callbacks.onTransportSessionChanged).toHaveBeenNthCalledWith(2, undefined);
    expect(callbacks.onTransportSessionChanged).toHaveBeenLastCalledWith("session-2");
    expect(writes.join("")).toContain("Preferred port updated from COM5 to COM9");

    pty.dispose();
  });

  it("waits instead of guessing when several fallback ports are available", async () => {
    const { transport, openPort } = createTransport({
      listPorts: async () => [{ path: "COM7" }, { path: "COM8" }],
      openPort: async () => {
        throw new Error("Port COM5 not found. Check that the device is connected and the port name is correct.");
      }
    });
    const callbacks = {
      onClosed: vi.fn(),
      onTransportSessionChanged: vi.fn(),
      onResolvedPort: vi.fn()
    };
    const logger = { log: vi.fn(), close: vi.fn() };
    const writes: string[] = [];

    const pty = new SmartSerialPty(transport, makeProfile(), callbacks, logger as any);
    pty.onDidWrite((chunk) => writes.push(chunk));

    pty.open();
    await flushAsync();

    expect(openPort).toHaveBeenCalledTimes(1);
    expect(callbacks.onResolvedPort).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("will wait instead of guessing");

    pty.dispose();
  });
});
