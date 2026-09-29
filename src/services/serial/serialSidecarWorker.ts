import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import {
  PORT_DATA_NOTIFICATION,
  PORT_DISCONNECTED_NOTIFICATION,
  PORT_ERROR_NOTIFICATION,
  type OpenPortParams,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
  type SerialPortInfo
} from "./protocol";

type PortRecord = {
  write(data: Buffer, callback: (error?: Error | null) => void): void;
  close(callback: (error?: Error | null) => void): void;
  set(options: Record<string, boolean>, callback: (error?: Error | null) => void): void;
  removeAllListeners(): void;
  on(event: "data", listener: (data: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
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

function writeOutputLine(message: RpcResponse | RpcNotification): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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

const CLOSE_RETRY_DELAYS_MS = [50, 150];
// Total ~30 s. Used after a cancelled open whose close kept failing: the owner
// has already timed out and will never send another closePort, so the worker
// must keep trying on its own.
const BACKGROUND_CLOSE_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15000];

/** serialport reports closing a port that is already closed as "Port is not open". */
function isAlreadyClosed(error: Error): boolean {
  return /not open|already closed/i.test(error.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Resolves with the last close error, or undefined once the port is closed. */
async function closeWithRetry(port: PortRecord, delays: readonly number[] = CLOSE_RETRY_DELAYS_MS): Promise<Error | undefined> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) {
      await sleep(delays[attempt - 1]);
    }
    lastError = await new Promise<Error | undefined>((resolve) => {
      port.close((error) => resolve(error ?? undefined));
    });
    if (!lastError || isAlreadyClosed(lastError)) {
      return undefined;
    }
  }
  return lastError;
}

export function createSerialSidecarRequestHandler(dependencies: {
  loadSerialModule?: () => SerialPortModule | undefined;
  writeLine?: (message: RpcResponse | RpcNotification) => void;
} = {}): (request: RpcRequest) => Promise<RpcResponse> {
  const ports = new Map<string, PortRecord>();
  // Session ids whose native open() is still pending. A closePort for one of
  // these cannot close the port yet (close() on a not-open port errors, and the
  // open would then complete unreachable), so it flags the open as cancelled
  // and the openPort handler closes the port once open() settles.
  const openingSessions = new Map<string, { cancelled: boolean }>();
  let serialLoadError = "serialport module not available";
  const writeLine = dependencies.writeLine ?? writeOutputLine;
  const loadSerialModule =
    dependencies.loadSerialModule ??
    (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require("serialport") as SerialPortModule;
      } catch (error) {
        serialLoadError = error instanceof Error ? error.message : String(error);
        return undefined;
      }
    });

  async function releaseAbandonedPort(sessionId: string, port: PortRecord, firstError: Error): Promise<void> {
    let lastError = firstError;
    for (const delay of BACKGROUND_CLOSE_DELAYS_MS) {
      await sleep(delay);
      if (ports.get(sessionId) !== port) {
        return; // released meanwhile (explicit closePort or the close event)
      }
      const error = await closeWithRetry(port, []);
      if (!error) {
        if (ports.get(sessionId) === port) {
          ports.delete(sessionId);
        }
        port.removeAllListeners();
        return;
      }
      lastError = error;
    }
    if (ports.get(sessionId) === port) {
      ports.delete(sessionId);
    }
    port.removeAllListeners();
    const message = `Could not release a cancelled serial open (${lastError.message}). The port may stay busy until the sidecar restarts: unplug and replug the device or run Reload Window.`;
    writeLine({ method: PORT_ERROR_NOTIFICATION, params: { sessionId, message } });
    // The sidecar's stderr is logged by the manager, unlike the unowned id above.
    console.error(`[Nexus Serial Sidecar] ${message}`);
  }

  return async (request: RpcRequest): Promise<RpcResponse> => {
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

      const params = request.params as (OpenPortParams & { sessionId?: unknown }) | undefined;
      if (!params || !params.path || !params.baudRate) {
        return response(request.id, undefined, "invalid openPort parameters");
      }

      if (params.sessionId !== undefined && (typeof params.sessionId !== "string" || !params.sessionId.trim())) {
        return response(request.id, undefined, "invalid serial session ID");
      }
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : randomUUID();
      if (ports.has(sessionId)) {
        return response(request.id, undefined, "serial session ID is already in use");
      }
      const port = new module.SerialPort({
        path: params.path,
        baudRate: params.baudRate,
        dataBits: params.dataBits,
        stopBits: params.stopBits,
        parity: params.parity,
        rtscts: params.rtscts,
        autoOpen: false
      });
      // SerialPort can emit startup bytes before its open callback. Attach its
      // listeners before opening so the first data notification is preserved.
      let opening = true;
      let closedWhileOpening = false;
      port.on("data", (data: Buffer) => {
        writeLine({
          method: PORT_DATA_NOTIFICATION,
          params: {
            sessionId,
            data: data.toString("base64")
          }
        });
      });
      port.on("error", (error: Error) => {
        writeLine({
          method: PORT_ERROR_NOTIFICATION,
          params: {
            sessionId,
            message: error.message
          }
        });
      });
      port.on("close", () => {
        if (ports.get(sessionId) === port) {
          ports.delete(sessionId);
          if (opening) {
            closedWhileOpening = true;
            return;
          }
          writeLine({
            method: PORT_DISCONNECTED_NOTIFICATION,
            params: { sessionId, reason: "Port closed" }
          });
        }
      });
      ports.set(sessionId, port);
      const openState = { cancelled: false };
      openingSessions.set(sessionId, openState);
      try {
        await new Promise<void>((resolve, reject) => {
          port.open((error) => (error ? reject(friendlyOpenError(params.path, error)) : resolve()));
        });
      } catch (error) {
        if (ports.get(sessionId) === port) {
          ports.delete(sessionId);
        }
        port.removeAllListeners();
        throw error;
      } finally {
        if (openingSessions.get(sessionId) === openState) {
          openingSessions.delete(sessionId);
        }
      }
      if (openState.cancelled) {
        // The caller gave up on this open. Unregister first so the close event
        // is not reported as a disconnect, then release the device.
        if (ports.get(sessionId) === port) {
          ports.delete(sessionId);
        }
        if (closedWhileOpening) {
          // The port closed itself before the cancel arrived; there is nothing
          // left to release, and closing again would only fail "not open".
          port.removeAllListeners();
          return response(request.id, undefined, "Serial port open cancelled");
        }
        const closeError = await closeWithRetry(port);
        if (closeError) {
          // The descriptor may still be held and the owner has given up, so no
          // later closePort will come. Keep the id reserved (the port stays
          // reachable) while the worker keeps retrying on its own.
          ports.set(sessionId, port);
          void releaseAbandonedPort(sessionId, port, closeError);
          return response(request.id, undefined, `Serial port open cancelled; close failed: ${closeError.message}`);
        }
        port.removeAllListeners();
        return response(request.id, undefined, "Serial port open cancelled");
      }
      if (closedWhileOpening) {
        port.removeAllListeners();
        return response(request.id, undefined, "Serial port closed while opening");
      }
      opening = false;
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
      const openState = openingSessions.get(params.sessionId);
      if (openState) {
        openState.cancelled = true;
        return response(request.id, { ok: true });
      }
      const port = ports.get(params.sessionId);
      if (!port) {
        return response(request.id, { ok: true });
      }
      ports.delete(params.sessionId);
      try {
        await new Promise<void>((resolve, reject) => {
          port.close((error) => (error && !isAlreadyClosed(error) ? reject(error) : resolve()));
        });
      } catch (error) {
        // Still possibly open: stay reachable so the close can be retried.
        ports.set(params.sessionId, port);
        throw error;
      }
      return response(request.id, { ok: true });
    }

    return response(request.id, undefined, `unknown method ${request.method}`);
  };
}

export function startSerialSidecarWorker(input: NodeJS.ReadableStream = process.stdin): void {
  const handleRequest = createSerialSidecarRequestHandler();
  const rl = readline.createInterface({ input });
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
      writeOutputLine(rpcResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown sidecar error";
      writeOutputLine(response(request.id, undefined, message));
    }
  });
}

if (require.main === module) {
  startSerialSidecarWorker();
}
