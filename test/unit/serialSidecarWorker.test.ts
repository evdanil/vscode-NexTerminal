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
});
