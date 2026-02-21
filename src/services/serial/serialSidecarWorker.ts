import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import type { OpenPortParams, RpcNotification, RpcRequest, RpcResponse, SerialPortInfo } from "./protocol";

type PortRecord = {
  write(data: Buffer, callback: (error?: Error | null) => void): void;
  close(callback: (error?: Error | null) => void): void;
  set(options: Record<string, boolean>, callback: (error?: Error | null) => void): void;
  on(event: "data", listener: (data: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
};

type SerialPortCtor = new (options: {
  path: string;
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "even" | "odd" | "mark" | "space";
  rtscts?: boolean;
  autoOpen: boolean;
}) => PortRecord & { open(callback: (error?: Error | null) => void): void };

type SerialPortModule = {
  SerialPort: SerialPortCtor & { list: () => Promise<SerialPortInfo[]> };
};

const ports = new Map<string, PortRecord>();

function writeLine(message: RpcResponse | RpcNotification): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let serialLoadError = "serialport module not available";

function loadSerialModule(): SerialPortModule | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("serialport") as SerialPortModule;
  } catch (error) {
    serialLoadError = error instanceof Error ? error.message : String(error);
    return undefined;
  }
}

function response(id: string, result?: unknown, error?: string): RpcResponse {
  return error ? { id, error: { message: error } } : { id, result };
}

function friendlyOpenError(portPath: string, error: Error): Error {
  const msg = error.message;
  if (msg.includes("File not found")) {
    return new Error(`Port ${portPath} not found. Check that the device is connected and the port name is correct.`);
  }
  if (msg.includes("Access denied") || msg.includes("Permission denied")) {
    return new Error(`Permission denied on ${portPath}. Another application may have the port open, or you lack access rights.`);
  }
  if (msg.includes("resource busy") || msg.includes("already in use")) {
    return new Error(`Port ${portPath} is busy. Another application may already be using it.`);
  }
  return error;
}

async function handleRequest(request: RpcRequest): Promise<RpcResponse> {
  if (request.method === "listPorts") {
    const module = loadSerialModule();
    if (!module) {
      return response(request.id, undefined, serialLoadError);
    }
    const results = await module.SerialPort.list();
    return response(request.id, results);
  }

  if (request.method === "openPort") {
    const module = loadSerialModule();
    if (!module) {
      return response(request.id, undefined, serialLoadError);
    }

    const params = request.params as OpenPortParams | undefined;
    if (!params || !params.path || !params.baudRate) {
      return response(request.id, undefined, "invalid openPort parameters");
    }

    const sessionId = randomUUID();
    const port = new module.SerialPort({
      path: params.path,
      baudRate: params.baudRate,
      dataBits: params.dataBits,
      stopBits: params.stopBits,
      parity: params.parity,
      rtscts: params.rtscts,
      autoOpen: false
    });
    await new Promise<void>((resolve, reject) => {
      port.open((error) => (error ? reject(friendlyOpenError(params.path, error)) : resolve()));
    });
    port.on("data", (data: Buffer) => {
      writeLine({
        method: "portData",
        params: {
          sessionId,
          data: data.toString("base64")
        }
      });
    });
    port.on("error", (error: Error) => {
      writeLine({
        method: "portError",
        params: {
          sessionId,
          message: error.message
        }
      });
    });
    ports.set(sessionId, port);
    return response(request.id, { sessionId });
  }

  if (request.method === "writePort") {
    const params = request.params as { sessionId?: string; data?: string };
    if (!params.sessionId || !params.data) {
      return response(request.id, undefined, "invalid writePort parameters");
    }
    const port = ports.get(params.sessionId);
    if (!port) {
      return response(request.id, undefined, "unknown serial session");
    }
    const data = Buffer.from(params.data, "base64");
    await new Promise<void>((resolve, reject) => {
      port.write(data, (error) => (error ? reject(error) : resolve()));
    });
    return response(request.id, { ok: true });
  }

  if (request.method === "sendBreak") {
    const params = request.params as { sessionId?: string; duration?: number };
    if (!params.sessionId) {
      return response(request.id, undefined, "invalid sendBreak parameters");
    }
    const port = ports.get(params.sessionId);
    if (!port) {
      return response(request.id, undefined, "unknown serial session");
    }
    const duration = Math.min(Math.max(params.duration ?? 250, 0), 5000);
    await new Promise<void>((resolve, reject) => {
      port.set({ brk: true }, (error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve) => setTimeout(resolve, duration));
    await new Promise<void>((resolve, reject) => {
      port.set({ brk: false }, (error) => (error ? reject(error) : resolve()));
    });
    return response(request.id, { ok: true });
  }

  if (request.method === "closePort") {
    const params = request.params as { sessionId?: string };
    if (!params.sessionId) {
      return response(request.id, undefined, "invalid closePort parameters");
    }
    const port = ports.get(params.sessionId);
    if (!port) {
      return response(request.id, { ok: true });
    }
    ports.delete(params.sessionId);
    await new Promise<void>((resolve, reject) => {
      port.close((error) => (error ? reject(error) : resolve()));
    });
    return response(request.id, { ok: true });
  }

  return response(request.id, undefined, `unknown method ${request.method}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }
  let request: RpcRequest;
  try {
    request = JSON.parse(line) as RpcRequest;
  } catch {
    return;
  }
  try {
    const rpcResponse = await handleRequest(request);
    writeLine(rpcResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown sidecar error";
    writeLine(response(request.id, undefined, message));
  }
});
