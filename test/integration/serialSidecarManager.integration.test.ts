import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SerialSidecarManager } from "../../src/services/serial/serialSidecarManager";
import { SerialPty } from "../../src/services/serial/serialPty";

vi.mock("vscode", () => ({
  EventEmitter: class MockEventEmitter<T> {
    private listeners = new Set<(value: T) => void>();

    public readonly event = (listener: (value: T) => void): { dispose: () => void } => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };

    public fire(value?: T): void {
      for (const listener of this.listeners) listener(value as T);
    }

    public dispose(): void {
      this.listeners.clear();
    }
  }
}));

function waitFor<T>(check: () => T | undefined, timeoutMs = 1000): Promise<T> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const value = check();
      if (value !== undefined) {
        clearInterval(timer);
        resolve(value);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timeout waiting for value"));
      }
    }, 20);
  });
}

describe("SerialSidecarManager integration", () => {
  it("handles request/response and notifications", async () => {
    const sidecarPath = path.resolve(__dirname, "..", "fixtures", "mockSerialSidecar.js");
    const manager = new SerialSidecarManager(sidecarPath);
    const dataEvents: Array<{ sessionId: string; payload: string }> = [];
    const errorEvents: Array<{ sessionId: string; message: string }> = [];
    const disconnectEvents: Array<{ sessionId: string; reason: string }> = [];

    manager.onDidReceiveData((sessionId, data) => {
      dataEvents.push({ sessionId, payload: data.toString("utf8") });
    });
    manager.onDidReceiveError((sessionId, message) => {
      errorEvents.push({ sessionId, message });
    });
    manager.onDidDisconnect((sessionId, reason) => {
      disconnectEvents.push({ sessionId, reason });
    });

    const ports = await manager.listPorts();
    expect(ports).toHaveLength(1);
    expect(ports[0].path).toBe("COM9");

    const sessionId = await manager.openPort({
      path: "COM9",
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      rtscts: false
    });
    expect(sessionId).toBe("session-1");

    await manager.writePort(sessionId, Buffer.from("hello", "utf8"));
    await manager.sendBreak(sessionId);
    await manager.closePort(sessionId);

    const readyData = await waitFor(() => dataEvents.find((item) => item.payload === "ready"));
    const echoedData = await waitFor(() => dataEvents.find((item) => item.payload === "hello"));
    const disconnectedEvent = await waitFor(() => disconnectEvents.find((item) => item.reason === "Port closed"));

    expect(readyData.sessionId).toBe("session-1");
    expect(echoedData.sessionId).toBe("session-1");
    expect(disconnectedEvent.sessionId).toBe("session-1");
    expect(errorEvents).toHaveLength(0);

    manager.dispose();
  });

  it("captures sidecar data notified before the openPort response", async () => {
    const sidecarPath = path.resolve(__dirname, "..", "fixtures", "mockSerialSidecar.js");
    const manager = new SerialSidecarManager(sidecarPath);
    const writes: string[] = [];
    const pty = new SerialPty(
      manager,
      { path: "COM9", baudRate: 115200 },
      { onSessionOpened: () => {}, onSessionClosed: () => {} },
      { log: () => {}, close: () => {} } as any
    );
    pty.onDidWrite((chunk) => writes.push(chunk));

    try {
      pty.open();
      const output = await waitFor(() => {
        const current = writes.join("");
        return current.includes("ready") ? current : undefined;
      });
      expect(output).toContain("ready");
    } finally {
      pty.dispose();
      manager.dispose();
    }
  });

  it("propagates sidecar errors", async () => {
    const sidecarPath = path.resolve(__dirname, "..", "fixtures", "mockSerialSidecar.js");
    const manager = new SerialSidecarManager(sidecarPath);
    await expect(manager.openPort("ERR", 115200)).rejects.toThrow("failed to open mock serial port");
    manager.dispose();
  });

  it("uses and guards a requested session ID", async () => {
    const sidecarPath = path.resolve(__dirname, "..", "fixtures", "mockSerialSidecar.js");
    const manager = new SerialSidecarManager(sidecarPath);
    const params = { path: "COM9", baudRate: 115200 };

    const sessionId = await manager.openPort(params, "requested-session");
    expect(sessionId).toBe("requested-session");
    await expect(manager.openPort(params, "requested-session")).rejects.toThrow("serial session ID is already in use");
    await expect(manager.openPort(params, "")).rejects.toThrow("invalid serial session ID");
    await expect(manager.openPort(params, " ")).rejects.toThrow("invalid serial session ID");

    await manager.closePort(sessionId);
    manager.dispose();
  });

  it("propagates missing serial module errors", async () => {
    const sidecarPath = path.resolve(__dirname, "..", "fixtures", "mockSerialMissingModule.js");
    const manager = new SerialSidecarManager(sidecarPath);
    await expect(manager.listPorts()).rejects.toThrow("serialport module not installed");
    await expect(manager.openPort("COM1", 115200)).rejects.toThrow("serialport module not installed");
    manager.dispose();
  });
});
