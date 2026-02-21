import * as net from "node:net";
import { describe, expect, it, afterEach } from "vitest";
import { handleSocks5Handshake, sendSocks5Success, sendSocks5Failure, SOCKS5_CONSTANTS } from "../../src/services/tunnel/socks5";

const { SOCKS5_VERSION, AUTH_NO_AUTH, AUTH_NO_ACCEPTABLE, CMD_CONNECT, ATYP_IPV4, ATYP_DOMAIN, ATYP_IPV6 } = SOCKS5_CONSTANTS;

function createSocketPair(): Promise<{ client: net.Socket; server: net.Socket; cleanup: () => void }> {
  return new Promise((resolve) => {
    const srv = net.createServer((serverSocket) => {
      resolve({
        client: clientSocket,
        server: serverSocket,
        cleanup: () => {
          clientSocket.destroy();
          serverSocket.destroy();
          srv.close();
        }
      });
    });
    srv.listen(0, "127.0.0.1");
    const clientSocket = new net.Socket();
    srv.once("listening", () => {
      const addr = srv.address() as net.AddressInfo;
      clientSocket.connect(addr.port, "127.0.0.1");
    });
  });
}

function buildGreeting(methods: number[]): Buffer {
  return Buffer.from([SOCKS5_VERSION, methods.length, ...methods]);
}

function buildRequest(cmd: number, atyp: number, addr: Buffer, port: number): Buffer {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  return Buffer.concat([
    Buffer.from([SOCKS5_VERSION, cmd, 0x00, atyp]),
    addr,
    portBuf
  ]);
}

function ipv4Addr(a: number, b: number, c: number, d: number): Buffer {
  return Buffer.from([a, b, c, d]);
}

function domainAddr(domain: string): Buffer {
  return Buffer.from([domain.length, ...Buffer.from(domain, "ascii")]);
}

function ipv6Addr(hex: string): Buffer {
  // e.g., "20010db8000000000000000000000001" -> 16 bytes
  return Buffer.from(hex, "hex");
}

describe("SOCKS5 handleSocks5Handshake", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("completes IPv4 CONNECT handshake", async () => {
    const pair = await createSocketPair();
    cleanup = pair.cleanup;

    const handshakePromise = handleSocks5Handshake(pair.server);

    // Client sends greeting
    pair.client.write(buildGreeting([AUTH_NO_AUTH]));

    // Wait for greeting reply
    const greetingReply = await new Promise<Buffer>((resolve) => {
      pair.client.once("data", resolve);
    });
    expect(greetingReply[0]).toBe(SOCKS5_VERSION);
    expect(greetingReply[1]).toBe(AUTH_NO_AUTH);

    // Client sends CONNECT request
    pair.client.write(buildRequest(CMD_CONNECT, ATYP_IPV4, ipv4Addr(10, 0, 0, 5), 8080));

    const target = await handshakePromise;
    expect(target.destAddr).toBe("10.0.0.5");
    expect(target.destPort).toBe(8080);
  });

  it("completes domain CONNECT handshake", async () => {
    const pair = await createSocketPair();
    cleanup = pair.cleanup;

    const handshakePromise = handleSocks5Handshake(pair.server);

    pair.client.write(buildGreeting([AUTH_NO_AUTH]));

    await new Promise<Buffer>((resolve) => {
      pair.client.once("data", resolve);
    });

    pair.client.write(buildRequest(CMD_CONNECT, ATYP_DOMAIN, domainAddr("example.com"), 443));

    const target = await handshakePromise;
    expect(target.destAddr).toBe("example.com");
    expect(target.destPort).toBe(443);
  });

  it("completes IPv6 CONNECT handshake", async () => {
    const pair = await createSocketPair();
    cleanup = pair.cleanup;

    const handshakePromise = handleSocks5Handshake(pair.server);

    pair.client.write(buildGreeting([AUTH_NO_AUTH]));

    await new Promise<Buffer>((resolve) => {
      pair.client.once("data", resolve);
    });

    // ::1 = 0000...0001
    const ipv6Buf = Buffer.alloc(16);
    ipv6Buf[15] = 1;
    pair.client.write(buildRequest(CMD_CONNECT, ATYP_IPV6, ipv6Buf, 80));

    const target = await handshakePromise;
    expect(target.destAddr).toBe("0:0:0:0:0:0:0:1");
    expect(target.destPort).toBe(80);
  });

  it("rejects non-SOCKS5 version", async () => {
    const pair = await createSocketPair();
    cleanup = pair.cleanup;

    const handshakePromise = handleSocks5Handshake(pair.server);

    pair.client.write(Buffer.from([0x04, 0x01, AUTH_NO_AUTH]));

    await expect(handshakePromise).rejects.toThrow("Invalid SOCKS5 version");
  });

  it("rejects when no acceptable auth method", async () => {
    const pair = await createSocketPair();
    cleanup = pair.cleanup;

    const handshakePromise = handleSocks5Handshake(pair.server);

    // Offer only username/password auth (0x02), which we don't support
    pair.client.write(buildGreeting([0x02]));

    await expect(handshakePromise).rejects.toThrow("No acceptable authentication method");
  });

  it("rejects unsupported SOCKS5 command (BIND)", async () => {
    const pair = await createSocketPair();
    cleanup = pair.cleanup;

    const handshakePromise = handleSocks5Handshake(pair.server);

    pair.client.write(buildGreeting([AUTH_NO_AUTH]));

    await new Promise<Buffer>((resolve) => {
      pair.client.once("data", resolve);
    });

    // BIND = 0x02
    pair.client.write(buildRequest(0x02, ATYP_IPV4, ipv4Addr(10, 0, 0, 1), 80));

    await expect(handshakePromise).rejects.toThrow("Unsupported SOCKS5 command");
  });

  it("rejects unsupported address type", async () => {
    const pair = await createSocketPair();
    cleanup = pair.cleanup;

    const handshakePromise = handleSocks5Handshake(pair.server);

    pair.client.write(buildGreeting([AUTH_NO_AUTH]));

    await new Promise<Buffer>((resolve) => {
      pair.client.once("data", resolve);
    });

    // Unknown atyp = 0x05
    pair.client.write(buildRequest(CMD_CONNECT, 0x05, Buffer.from([1, 2, 3, 4]), 80));

    await expect(handshakePromise).rejects.toThrow("Unsupported address type");
  });

  it("rejects when socket closes during handshake", async () => {
    const pair = await createSocketPair();
    cleanup = pair.cleanup;

    const handshakePromise = handleSocks5Handshake(pair.server);

    // Close client immediately
    pair.client.destroy();

    await expect(handshakePromise).rejects.toThrow();
  });
});

describe("sendSocks5Success / sendSocks5Failure", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("sendSocks5Success writes success reply", async () => {
    const pair = await createSocketPair();
    cleanup = pair.cleanup;

    sendSocks5Success(pair.server);

    const reply = await new Promise<Buffer>((resolve) => {
      pair.client.once("data", resolve);
    });

    expect(reply[0]).toBe(SOCKS5_VERSION);
    expect(reply[1]).toBe(0x00); // success
  });

  it("sendSocks5Failure writes failure reply", async () => {
    const pair = await createSocketPair();
    cleanup = pair.cleanup;

    sendSocks5Failure(pair.server);

    const reply = await new Promise<Buffer>((resolve) => {
      pair.client.once("data", resolve);
    });

    expect(reply[0]).toBe(SOCKS5_VERSION);
    expect(reply[1]).toBe(0x01); // general failure
  });
});
