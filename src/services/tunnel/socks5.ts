import type { Socket } from "node:net";

const SOCKS5_VERSION = 0x05;
const AUTH_NO_AUTH = 0x00;
const AUTH_NO_ACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_COMMAND_NOT_SUPPORTED = 0x07;
const REP_ATYP_NOT_SUPPORTED = 0x08;

const HANDSHAKE_TIMEOUT_MS = 10_000;

export class Socks5HandshakeAbortedError extends Error {
  constructor() {
    super("Socket closed during SOCKS5 handshake");
    this.name = "Socks5HandshakeAbortedError";
  }
}

export interface Socks5Target {
  destAddr: string;
  destPort: number;
}

function readBytes(socket: Socket, count: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let buf = Buffer.alloc(0);

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= count) {
        cleanup();
        socket.pause();
        if (buf.length > count) {
          // Push excess bytes back
          socket.unshift(buf.subarray(count));
          resolve(buf.subarray(0, count));
        } else {
          resolve(buf);
        }
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    const onClose = (): void => {
      cleanup();
      reject(new Socks5HandshakeAbortedError());
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error("SOCKS5 handshake timed out"));
    }, timeoutMs);

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.resume();
  });
}

function buildGreetingReply(method: number): Buffer {
  return Buffer.from([SOCKS5_VERSION, method]);
}

function buildSocks5Reply(rep: number): Buffer {
  // Minimal reply: version, rep, rsv, atyp=IPv4, addr=0.0.0.0, port=0
  return Buffer.from([SOCKS5_VERSION, rep, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
}

export async function handleSocks5Handshake(socket: Socket): Promise<Socks5Target> {
  socket.pause();

  // Phase 1: Greeting
  const greetingHeader = await readBytes(socket, 2, HANDSHAKE_TIMEOUT_MS);
  if (greetingHeader[0] !== SOCKS5_VERSION) {
    socket.end(buildGreetingReply(AUTH_NO_ACCEPTABLE));
    throw new Error(`Invalid SOCKS5 version: ${greetingHeader[0]}`);
  }

  const nMethods = greetingHeader[1];
  if (nMethods === 0) {
    socket.end(buildGreetingReply(AUTH_NO_ACCEPTABLE));
    throw new Error("No authentication methods offered");
  }

  const methods = await readBytes(socket, nMethods, HANDSHAKE_TIMEOUT_MS);
  if (!methods.includes(AUTH_NO_AUTH)) {
    socket.end(buildGreetingReply(AUTH_NO_ACCEPTABLE));
    throw new Error("No acceptable authentication method (only no-auth supported)");
  }

  socket.write(buildGreetingReply(AUTH_NO_AUTH));

  // Phase 2: Request
  const requestHeader = await readBytes(socket, 4, HANDSHAKE_TIMEOUT_MS);
  if (requestHeader[0] !== SOCKS5_VERSION) {
    socket.end(buildSocks5Reply(REP_GENERAL_FAILURE));
    throw new Error(`Invalid SOCKS5 version in request: ${requestHeader[0]}`);
  }

  const cmd = requestHeader[1];
  if (cmd !== CMD_CONNECT) {
    socket.end(buildSocks5Reply(REP_COMMAND_NOT_SUPPORTED));
    throw new Error(`Unsupported SOCKS5 command: ${cmd}`);
  }

  const atyp = requestHeader[3];
  let destAddr: string;

  if (atyp === ATYP_IPV4) {
    const addrBuf = await readBytes(socket, 4, HANDSHAKE_TIMEOUT_MS);
    destAddr = `${addrBuf[0]}.${addrBuf[1]}.${addrBuf[2]}.${addrBuf[3]}`;
  } else if (atyp === ATYP_DOMAIN) {
    const lenBuf = await readBytes(socket, 1, HANDSHAKE_TIMEOUT_MS);
    const domainLen = lenBuf[0];
    if (domainLen === 0) {
      socket.end(buildSocks5Reply(REP_GENERAL_FAILURE));
      throw new Error("Empty domain name");
    }
    const domainBuf = await readBytes(socket, domainLen, HANDSHAKE_TIMEOUT_MS);
    destAddr = domainBuf.toString("ascii");
  } else if (atyp === ATYP_IPV6) {
    const addrBuf = await readBytes(socket, 16, HANDSHAKE_TIMEOUT_MS);
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      groups.push(addrBuf.readUInt16BE(i).toString(16));
    }
    destAddr = groups.join(":");
  } else {
    socket.end(buildSocks5Reply(REP_ATYP_NOT_SUPPORTED));
    throw new Error(`Unsupported address type: ${atyp}`);
  }

  const portBuf = await readBytes(socket, 2, HANDSHAKE_TIMEOUT_MS);
  const destPort = portBuf.readUInt16BE(0);

  return { destAddr, destPort };
}

export function sendSocks5Success(socket: Socket): void {
  socket.write(buildSocks5Reply(REP_SUCCESS));
}

export function sendSocks5Failure(socket: Socket): void {
  socket.end(buildSocks5Reply(REP_GENERAL_FAILURE));
}

// Re-export constants for testing
export const SOCKS5_CONSTANTS = {
  SOCKS5_VERSION,
  AUTH_NO_AUTH,
  AUTH_NO_ACCEPTABLE,
  CMD_CONNECT,
  ATYP_IPV4,
  ATYP_DOMAIN,
  ATYP_IPV6,
  REP_SUCCESS,
  REP_GENERAL_FAILURE,
  REP_COMMAND_NOT_SUPPORTED,
  REP_ATYP_NOT_SUPPORTED
} as const;
