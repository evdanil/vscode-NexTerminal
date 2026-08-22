import { describe, expect, it } from "vitest";
import dgram from "node:dgram";
import { ServerStatus } from "../../../src/services/networkServers/core/ServerStatus";
import { DhcpAdapter } from "../../../src/services/networkServers/dhcp/DhcpAdapter";

async function freeLoopbackPort(): Promise<number> {
  const socket = dgram.createSocket("udp4");
  try {
    return await new Promise<number>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", () => resolve(socket.address().port));
    });
  } finally {
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
}

describe("DhcpEngine shutdown ownership", () => {
  it("observes a dependency error delivered during close, rejects adapter shutdown, and detaches listeners only after close settles (catches removeAllListeners before close completion)", async () => {
    const adapter = new DhcpAdapter({ bindAddress: "127.0.0.1" });
    Object.defineProperty(adapter, "port", { value: await freeLoopbackPort() });
    await adapter.start();

    const engine: any = (adapter as unknown as { engine: unknown }).engine;
    const dependencyServer: any = engine._server;
    const originalClose = dependencyServer.close.bind(dependencyServer);
    const closeError = new Error("late dependency close error");
    let escapedCloseError: unknown;
    dependencyServer.close = (callback: () => void): void => {
      originalClose(() => {
        queueMicrotask(() => {
          try {
            dependencyServer.emit("error", closeError);
          } catch (error) {
            escapedCloseError = error;
          }
          callback();
        });
      });
    };

    try {
      await expect(adapter.stop()).rejects.toThrow("late dependency close error");
      expect(adapter.status).toBe(ServerStatus.ERROR);
      expect(adapter.lastError).toContain("late dependency close error");
      expect(escapedCloseError).toBeUndefined();
      expect(dependencyServer.listenerCount("error")).toBe(0);

      await expect(adapter.stop()).resolves.toBeUndefined();
      expect(engine.listenerCount("error")).toBe(0);
    } finally {
      await adapter.stop().catch(() => undefined);
    }
  });
});
