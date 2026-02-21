import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SerialSidecarManager } from "../../src/services/serial/serialSidecarManager";

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

    manager.onDidReceiveData((sessionId, data) => {
      dataEvents.push({ sessionId, payload: data.toString("utf8") });
    });
    manager.onDidReceiveError((sessionId, message) => {
      errorEvents.push({ sessionId, message });
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
    const closedEvent = await waitFor(() => errorEvents.find((item) => item.message === "closed"));

    expect(readyData.sessionId).toBe("session-1");
    expect(echoedData.sessionId).toBe("session-1");
    expect(closedEvent.sessionId).toBe("session-1");

    manager.dispose();
  });

  it("propagates sidecar errors", async () => {
    const sidecarPath = path.resolve(__dirname, "..", "fixtures", "mockSerialSidecar.js");
    const manager = new SerialSidecarManager(sidecarPath);
    await expect(manager.openPort("ERR", 115200)).rejects.toThrow("failed to open mock serial port");
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
