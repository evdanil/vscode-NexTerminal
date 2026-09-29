import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PORT_DATA_NOTIFICATION,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse
} from "../../src/services/serial/protocol";
import { createSerialSidecarRequestHandler } from "../../src/services/serial/serialSidecarWorker";

type OpenCallback = (error?: Error | null) => void;
type OpenBehavior = (port: ControlledSerialPort, callback: OpenCallback) => void;

class ControlledSerialPort extends EventEmitter {
  public static instances: ControlledSerialPort[] = [];
  public static openBehavior: OpenBehavior = (_port, callback) => callback();
  public removeAllListenersCalls = 0;

  public constructor(public readonly options: { path: string; baudRate: number; autoOpen: boolean }) {
    super();
    ControlledSerialPort.instances.push(this);
  }

  public open(callback: OpenCallback): void {
    ControlledSerialPort.openBehavior(this, callback);
  }

  public write(_data: Buffer, callback: OpenCallback): void {
    callback();
  }

  public close(callback: OpenCallback): void {
    callback();
  }

  public set(_options: Record<string, boolean>, callback: OpenCallback): void {
    callback();
  }

  public override removeAllListeners(event?: string | symbol): this {
    this.removeAllListenersCalls += 1;
    return super.removeAllListeners(event);
  }
}

function makeHandler() {
  const output: Array<RpcNotification | RpcResponse> = [];
  const loadSerialModule = () => ({
    SerialPort: Object.assign(ControlledSerialPort, { list: async () => [] })
  });
  const handler = createSerialSidecarRequestHandler({
    loadSerialModule: loadSerialModule as never,
    writeLine: (message) => output.push(message)
  });
  return { handler, output };
}

function openRequest(id: string, sessionId: unknown = "session-17"): RpcRequest {
  return {
    id,
    method: "openPort",
    params: { path: "/dev/ttyUSB0", baudRate: 9600, sessionId }
  };
}

describe("production serial sidecar worker request handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ControlledSerialPort.instances = [];
    ControlledSerialPort.openBehavior = (_port, callback) => callback();
  });

  it("captures startup data with the requested session ID before open completes", async () => {
    const { handler, output } = makeHandler();
    const startupBytes = Buffer.from("boot banner\r\n", "utf8");
    ControlledSerialPort.openBehavior = (port, callback) => {
      // Real serial drivers may deliver bytes as soon as the descriptor opens,
      // before the open callback has settled the RPC.
      port.emit("data", startupBytes);
      callback();
    };

    const opened = await handler(openRequest("open-1"));

    expect(opened).toEqual({ id: "open-1", result: { sessionId: "session-17" } });
    expect(output).toContainEqual({
      method: PORT_DATA_NOTIFICATION,
      params: { sessionId: "session-17", data: startupBytes.toString("base64") }
    });
    expect(ControlledSerialPort.instances[0].options.autoOpen).toBe(false);
  });

  it("cleans up a failed open so its explicit session ID can be retried", async () => {
    const { handler } = makeHandler();
    ControlledSerialPort.openBehavior = (port, callback) => {
      if (port === ControlledSerialPort.instances[0]) {
        callback(new Error("driver open failed"));
      } else {
        callback();
      }
    };

    await expect(handler(openRequest("open-failed"))).rejects.toThrow("driver open failed");
    expect(ControlledSerialPort.instances[0].removeAllListenersCalls).toBe(1);

    await expect(handler(openRequest("open-retry"))).resolves.toEqual({
      id: "open-retry",
      result: { sessionId: "session-17" }
    });
    expect(ControlledSerialPort.instances).toHaveLength(2);
  });

  it("rejects an invalid session ID before constructing a serial port", async () => {
    const { handler } = makeHandler();

    await expect(handler(openRequest("open-invalid", " "))).resolves.toEqual({
      id: "open-invalid",
      error: { message: "invalid serial session ID" }
    });
    expect(ControlledSerialPort.instances).toHaveLength(0);
  });

  it("closes a port whose open completes after closePort cancelled it, and frees the session ID", async () => {
    const { handler, output } = makeHandler();
    let finishOpen!: OpenCallback;
    ControlledSerialPort.openBehavior = (_port, callback) => {
      finishOpen = callback;
    };
    const closeSpy = vi.spyOn(ControlledSerialPort.prototype, "close");

    const opening = handler(openRequest("open-slow"));
    const closed = await handler({ id: "close-1", method: "closePort", params: { sessionId: "session-17" } });
    expect(closed).toEqual({ id: "close-1", result: { ok: true } });
    // The native open is still pending, so nothing can be closed yet.
    expect(closeSpy).not.toHaveBeenCalled();

    finishOpen();
    await expect(opening).resolves.toEqual({
      id: "open-slow",
      error: { message: "Serial port open cancelled" }
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);
    await expect(
      handler({ id: "w-1", method: "writePort", params: { sessionId: "session-17", data: "eA==" } })
    ).resolves.toEqual({ id: "w-1", error: { message: "unknown serial session" } });
    // No disconnect notification for a port the caller already abandoned.
    expect(output.filter((m) => "method" in m && m.method !== PORT_DATA_NOTIFICATION)).toEqual([]);

    ControlledSerialPort.openBehavior = (_port, callback) => callback();
    await expect(handler(openRequest("open-again"))).resolves.toEqual({
      id: "open-again",
      result: { sessionId: "session-17" }
    });
  });

  it("keeps a cancelled open's port tracked and reports it when close keeps failing, so closePort can retry", async () => {
    const { handler, output } = makeHandler();
    let finishOpen!: OpenCallback;
    ControlledSerialPort.openBehavior = (_port, callback) => {
      finishOpen = callback;
    };
    let closeFails = true;
    const closeSpy = vi
      .spyOn(ControlledSerialPort.prototype, "close")
      .mockImplementation((callback: OpenCallback) => callback(closeFails ? new Error("EBUSY close") : undefined));

    const opening = handler(openRequest("open-slow"));
    await handler({ id: "close-1", method: "closePort", params: { sessionId: "session-17" } });
    finishOpen();
    const result = await opening;

    expect(result).toEqual({
      id: "open-slow",
      error: { message: "Serial port open cancelled; close failed: EBUSY close" }
    });
    expect(closeSpy.mock.calls.length).toBeGreaterThan(1);
    expect(output).toContainEqual({
      method: "portError",
      params: { sessionId: "session-17", message: "Could not release cancelled port: EBUSY close" }
    });

    // Still reachable: a later closePort retries and releases it.
    closeFails = false;
    const before = closeSpy.mock.calls.length;
    await expect(handler({ id: "close-2", method: "closePort", params: { sessionId: "session-17" } })).resolves.toEqual({
      id: "close-2",
      result: { ok: true }
    });
    expect(closeSpy.mock.calls.length).toBe(before + 1);
    await expect(
      handler({ id: "w-2", method: "writePort", params: { sessionId: "session-17", data: "eA==" } })
    ).resolves.toEqual({ id: "w-2", error: { message: "unknown serial session" } });
  });
});
