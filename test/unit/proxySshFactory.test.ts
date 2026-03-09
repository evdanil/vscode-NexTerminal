import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Duplex } from "node:stream";
import type { SFTPWrapper } from "ssh2";
import type { ServerConfig } from "../../src/models/config";
import type { SecretVault, SshConnection } from "../../src/services/ssh/contracts";
import { ProxiedSshConnection, jumpHostCleanup, socketCleanup } from "../../src/services/ssh/proxiedSshConnection";
import { SshConnectionPool } from "../../src/services/ssh/sshConnectionPool";

const makeServer = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  id: "srv-target",
  name: "Target",
  host: "target.example.com",
  port: 22,
  username: "root",
  authType: "password",
  isHidden: false,
  ...overrides
});

function makeFakeConnection(): SshConnection & { disposed: boolean; fireClose: () => void } {
  const closeListeners = new Set<() => void>();
  const conn: SshConnection & { disposed: boolean; fireClose: () => void } = {
    disposed: false,
    openShell: vi.fn(async () => ({} as Duplex)),
    openDirectTcp: vi.fn(async () => ({} as Duplex)),
    openSftp: vi.fn(async () => ({} as SFTPWrapper)),
    exec: vi.fn(async () => ({} as Duplex)),
    requestForwardIn: vi.fn(async () => 0),
    cancelForwardIn: vi.fn(async () => {}),
    onTcpConnection: vi.fn(() => () => {}),
    onClose: vi.fn((listener: () => void) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    }),
    getBanner: vi.fn(() => undefined),
    dispose: vi.fn(() => {
      conn.disposed = true;
      for (const listener of closeListeners) {
        listener();
      }
    }),
    fireClose: () => {
      for (const listener of closeListeners) {
        listener();
      }
    }
  };
  return conn;
}

function createVault(seed?: Record<string, string>): SecretVault {
  const entries = new Map(Object.entries(seed ?? {}));
  return {
    get: vi.fn(async (key: string) => entries.get(key)),
    store: vi.fn(async (key: string, value: string) => { entries.set(key, value); }),
    delete: vi.fn(async (key: string) => { entries.delete(key); })
  };
}

function createMockHttpSocket() {
  const dataListeners = new Set<(chunk: Buffer) => void>();
  const closeListeners = new Set<() => void>();
  const endListeners = new Set<() => void>();
  const runtimeErrorListeners = new Set<(error: Error) => void>();
  let errorListener: ((error: Error) => void) | undefined;
  let timeoutListener: (() => void) | undefined;

  const socket: any = {
    write: vi.fn(),
    destroy: vi.fn(),
    setTimeout: vi.fn((_ms: number, cb?: () => void) => {
      timeoutListener = cb;
      return socket;
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "error") {
        errorListener = handler as (error: Error) => void;
      }
      return socket;
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") {
        dataListeners.add(handler as (chunk: Buffer) => void);
      } else if (event === "close") {
        closeListeners.add(handler as () => void);
      } else if (event === "end") {
        endListeners.add(handler as () => void);
      } else if (event === "error") {
        runtimeErrorListeners.add(handler as (error: Error) => void);
      }
      return socket;
    }),
    removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") {
        dataListeners.delete(handler as (chunk: Buffer) => void);
      } else if (event === "close") {
        closeListeners.delete(handler as () => void);
      } else if (event === "end") {
        endListeners.delete(handler as () => void);
      } else if (event === "error") {
        runtimeErrorListeners.delete(handler as (error: Error) => void);
      }
      return socket;
    }),
    unshift: vi.fn(),
    emitData: (raw: string | Buffer) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      for (const listener of [...dataListeners]) {
        listener(chunk);
      }
    },
    emitError: (error: Error) => {
      if (errorListener) {
        const listener = errorListener;
        errorListener = undefined;
        listener(error);
        return;
      }
      for (const listener of [...runtimeErrorListeners]) {
        listener(error);
      }
    },
    emitClose: () => {
      for (const listener of [...closeListeners]) {
        listener();
      }
    },
    emitEnd: () => {
      for (const listener of [...endListeners]) {
        listener();
      }
    },
    emitTimeout: () => {
      timeoutListener?.();
    }
  };

  return socket;
}

function mockNetCreateConnectionWithSocket(socket: any): Promise<void> {
  return import("node:net").then((netMod) => {
    (netMod.createConnection as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_port: number, _host: string, onConnect?: () => void) => {
        setImmediate(() => onConnect?.());
        return socket;
      }
    );
  });
}

async function waitForSocketWrite(socket: { write: { mock: { calls: unknown[][] } } }): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (socket.write.mock.calls.length > 0) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for HTTP CONNECT request write");
}

describe("ProxiedSshConnection", () => {
  it("delegates all SshConnection methods to inner connection", async () => {
    const inner = makeFakeConnection();
    const cleanup = vi.fn();
    const proxied = new ProxiedSshConnection(inner, cleanup);

    await proxied.openShell({ term: "xterm" });
    expect(inner.openShell).toHaveBeenCalledWith({ term: "xterm" });

    await proxied.openDirectTcp("host", 80);
    expect(inner.openDirectTcp).toHaveBeenCalledWith("host", 80);

    await proxied.openSftp();
    expect(inner.openSftp).toHaveBeenCalled();

    await proxied.exec("ls");
    expect(inner.exec).toHaveBeenCalledWith("ls");

    await proxied.requestForwardIn("0.0.0.0", 8080);
    expect(inner.requestForwardIn).toHaveBeenCalledWith("0.0.0.0", 8080);

    await proxied.cancelForwardIn("0.0.0.0", 8080);
    expect(inner.cancelForwardIn).toHaveBeenCalledWith("0.0.0.0", 8080);

    const handler = () => {};
    proxied.onTcpConnection(handler as any);
    expect(inner.onTcpConnection).toHaveBeenCalled();

    const listener = vi.fn();
    proxied.onClose(listener);
    inner.fireClose();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("dispose() cleans up inner connection and proxy resources", () => {
    const inner = makeFakeConnection();
    const cleanup = vi.fn();
    const proxied = new ProxiedSshConnection(inner, cleanup);

    proxied.dispose();

    expect(inner.dispose).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });

  it("jumpHostCleanup disposes the jump host connection", () => {
    const jumpConn = makeFakeConnection();
    const cleanup = jumpHostCleanup(jumpConn);
    cleanup();
    expect(jumpConn.dispose).toHaveBeenCalled();
  });

  it("socketCleanup destroys the socket", () => {
    const socket = { destroy: vi.fn() };
    const cleanup = socketCleanup(socket as any);
    cleanup();
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("emits onClose when the proxy connection closes", () => {
    const inner = makeFakeConnection();
    const jump = makeFakeConnection();
    const proxied = new ProxiedSshConnection(
      inner,
      jumpHostCleanup(jump),
      (listener) => jump.onClose(listener)
    );
    const listener = vi.fn();
    proxied.onClose(listener);

    jump.fireClose();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// Use a separate describe block for ProxySshFactory that mocks socks
vi.mock("socks", () => ({
  SocksClient: {
    createConnection: vi.fn()
  }
}));

// We need to mock net for HTTP CONNECT tests
vi.mock("node:net", () => {
  const actual = vi.importActual("node:net");
  return {
    ...actual,
    createConnection: vi.fn()
  };
});

describe("ProxySshFactory", () => {
  let authFactory: any;
  let servers: Map<string, ServerConfig>;
  let vault: SecretVault;

  beforeEach(() => {
    vi.clearAllMocks();
    servers = new Map();
    vault = createVault();

    authFactory = {
      connect: vi.fn(async () => makeFakeConnection())
    };
  });

  async function createFactory() {
    const { ProxySshFactory } = await import("../../src/services/ssh/proxySshFactory");
    return new ProxySshFactory(
      authFactory,
      (id: string) => servers.get(id),
      vault
    );
  }

  async function createPooledFactory() {
    const factory = await createFactory();
    const pool = new SshConnectionPool(factory, { enabled: true, idleTimeoutMs: 5000 });
    factory.setJumpHostConnectionFactory(pool);
    return { factory, pool };
  }

  it("delegates to authFactory when server has no proxy", async () => {
    const factory = await createFactory();
    const server = makeServer();
    const connection = await factory.connect(server);

    expect(authFactory.connect).toHaveBeenCalledWith(server);
    expect(connection).toBeDefined();
  });

  it("connects through SSH jump host", async () => {
    const jumpServer = makeServer({ id: "srv-jump", name: "Jump Host", host: "jump.example.com" });
    const targetServer = makeServer({
      proxy: { type: "ssh", jumpHostId: "srv-jump" }
    });
    servers.set("srv-jump", jumpServer);

    const jumpConn = makeFakeConnection();
    const tunnelStream = { pause: vi.fn() } as unknown as Duplex;
    jumpConn.openDirectTcp = vi.fn(async () => tunnelStream);

    const targetConn = makeFakeConnection();

    authFactory.connect = vi.fn()
      .mockResolvedValueOnce(jumpConn) // Connect to jump host
      .mockResolvedValueOnce(targetConn); // Connect to target via tunnel

    const factory = await createFactory();
    const connection = await factory.connect(targetServer);

    // Should have connected to jump host first
    expect(authFactory.connect).toHaveBeenCalledWith(jumpServer);
    // Then opened a TCP tunnel
    expect(jumpConn.openDirectTcp).toHaveBeenCalledWith("target.example.com", 22);
    // Stream should be paused to prevent banner data loss
    expect(tunnelStream.pause).toHaveBeenCalled();
    // Then connected to target with sock
    expect(authFactory.connect).toHaveBeenCalledWith(targetServer, { sock: tunnelStream });
    // Result should be a ProxiedSshConnection
    expect(connection).toBeInstanceOf(ProxiedSshConnection);
  });

  it("throws when jump host server is not found", async () => {
    const targetServer = makeServer({
      proxy: { type: "ssh", jumpHostId: "nonexistent" }
    });

    const factory = await createFactory();
    await expect(factory.connect(targetServer)).rejects.toThrow("Jump host server not found");
  });

  it("throws on circular self-reference (A -> A)", async () => {
    const server = makeServer({
      id: "srv-self",
      proxy: { type: "ssh", jumpHostId: "srv-self" }
    });
    servers.set("srv-self", server);

    const factory = await createFactory();
    await expect(factory.connect(server)).rejects.toThrow("Circular proxy reference");
  });

  it("throws on circular chain (A -> B -> A)", async () => {
    const serverA = makeServer({
      id: "srv-a",
      name: "A",
      proxy: { type: "ssh", jumpHostId: "srv-b" }
    });
    const serverB = makeServer({
      id: "srv-b",
      name: "B",
      proxy: { type: "ssh", jumpHostId: "srv-a" }
    });
    servers.set("srv-a", serverA);
    servers.set("srv-b", serverB);

    const factory = await createFactory();
    await expect(factory.connect(serverA)).rejects.toThrow("Circular proxy reference");
  });

  it("supports chained jump hosts (A -> B -> C)", async () => {
    const serverC = makeServer({ id: "srv-c", name: "C", host: "c.example.com" });
    const serverB = makeServer({
      id: "srv-b",
      name: "B",
      host: "b.example.com",
      proxy: { type: "ssh", jumpHostId: "srv-c" }
    });
    const serverA = makeServer({
      id: "srv-a",
      name: "A",
      host: "a.example.com",
      proxy: { type: "ssh", jumpHostId: "srv-b" }
    });
    servers.set("srv-a", serverA);
    servers.set("srv-b", serverB);
    servers.set("srv-c", serverC);

    const connC = makeFakeConnection();
    const tunnelBC = { pause: vi.fn() } as unknown as Duplex;
    connC.openDirectTcp = vi.fn(async () => tunnelBC);

    const connB = makeFakeConnection();
    const tunnelAB = { pause: vi.fn() } as unknown as Duplex;
    connB.openDirectTcp = vi.fn(async () => tunnelAB);

    const connA = makeFakeConnection();

    authFactory.connect = vi.fn()
      .mockResolvedValueOnce(connC)  // Connect to C (no proxy)
      .mockResolvedValueOnce(connB)  // Connect to B via C
      .mockResolvedValueOnce(connA); // Connect to A via B

    const factory = await createFactory();
    const connection = await factory.connect(serverA);

    expect(authFactory.connect).toHaveBeenCalledTimes(3);
    expect(connection).toBeInstanceOf(ProxiedSshConnection);
  });

  it("reuses an active pooled jump host instead of re-authenticating it", async () => {
    const jumpServer = makeServer({ id: "srv-jump", name: "Jump Host", host: "jump.example.com" });
    const targetServer = makeServer({
      proxy: { type: "ssh", jumpHostId: "srv-jump" }
    });
    servers.set("srv-jump", jumpServer);

    const jumpConn = makeFakeConnection();
    const tunnelStream = { pause: vi.fn() } as unknown as Duplex;
    jumpConn.openDirectTcp = vi.fn(async () => tunnelStream);
    const targetConn = makeFakeConnection();

    authFactory.connect = vi.fn()
      .mockResolvedValueOnce(jumpConn)   // Pre-warm jump host pool entry
      .mockResolvedValueOnce(targetConn); // Final target auth over tunnel

    const { pool } = await createPooledFactory();
    const jumpLease = await pool.connect(jumpServer);
    const targetLease = await pool.connect(targetServer);

    expect(authFactory.connect).toHaveBeenCalledTimes(2);
    expect(authFactory.connect).toHaveBeenNthCalledWith(1, jumpServer);
    expect(authFactory.connect).toHaveBeenNthCalledWith(2, targetServer, { sock: tunnelStream });
    expect(jumpConn.openDirectTcp).toHaveBeenCalledWith("target.example.com", 22);

    targetLease.dispose();
    expect(jumpConn.dispose).not.toHaveBeenCalled();
    jumpLease.dispose();
  });

  it("reuses a pooled proxied jump host in a chained setup (A -> B -> C)", async () => {
    const serverC = makeServer({ id: "srv-c", name: "C", host: "c.example.com" });
    const serverB = makeServer({
      id: "srv-b",
      name: "B",
      host: "b.example.com",
      proxy: { type: "ssh", jumpHostId: "srv-c" }
    });
    const serverA = makeServer({
      id: "srv-a",
      name: "A",
      host: "a.example.com",
      proxy: { type: "ssh", jumpHostId: "srv-b" }
    });
    servers.set("srv-a", serverA);
    servers.set("srv-b", serverB);
    servers.set("srv-c", serverC);

    const connC = makeFakeConnection();
    const tunnelBC = { pause: vi.fn() } as unknown as Duplex;
    connC.openDirectTcp = vi.fn(async () => tunnelBC);

    const connB = makeFakeConnection();
    const tunnelAB = { pause: vi.fn() } as unknown as Duplex;
    connB.openDirectTcp = vi.fn(async () => tunnelAB);

    const connA = makeFakeConnection();

    authFactory.connect = vi.fn()
      .mockResolvedValueOnce(connC) // B pre-warm: connect to C
      .mockResolvedValueOnce(connB) // B pre-warm: connect to B via C
      .mockResolvedValueOnce(connA); // A connect: final target auth via B

    const { pool } = await createPooledFactory();
    const leaseB = await pool.connect(serverB);
    const leaseA = await pool.connect(serverA);

    expect(authFactory.connect).toHaveBeenCalledTimes(3);
    expect(connB.openDirectTcp).toHaveBeenCalledWith("a.example.com", 22);

    leaseA.dispose();
    leaseB.dispose();
  });

  it("ProxiedSshConnection.dispose() cleans up both connections", () => {
    const inner = makeFakeConnection();
    const jump = makeFakeConnection();
    const proxied = new ProxiedSshConnection(inner, jumpHostCleanup(jump));

    proxied.dispose();

    expect(inner.dispose).toHaveBeenCalled();
    expect(jump.dispose).toHaveBeenCalled();
  });

  it("cleans up jump host if target connection fails", async () => {
    const jumpServer = makeServer({ id: "srv-jump", name: "Jump", host: "jump.example.com" });
    const targetServer = makeServer({
      proxy: { type: "ssh", jumpHostId: "srv-jump" }
    });
    servers.set("srv-jump", jumpServer);

    const jumpConn = makeFakeConnection();
    jumpConn.openDirectTcp = vi.fn(async () => ({ pause: vi.fn() } as unknown as Duplex));

    authFactory.connect = vi.fn()
      .mockResolvedValueOnce(jumpConn)
      .mockRejectedValueOnce(new Error("Auth failed"));

    const factory = await createFactory();
    await expect(factory.connect(targetServer)).rejects.toThrow("Auth failed");
    expect(jumpConn.dispose).toHaveBeenCalled();
  });

  it("cleans up jump host if openDirectTcp fails", async () => {
    const jumpServer = makeServer({ id: "srv-jump", name: "Jump", host: "jump.example.com" });
    const targetServer = makeServer({
      proxy: { type: "ssh", jumpHostId: "srv-jump" }
    });
    servers.set("srv-jump", jumpServer);

    const jumpConn = makeFakeConnection();
    jumpConn.openDirectTcp = vi.fn(async () => { throw new Error("Connection refused"); });

    authFactory.connect = vi.fn().mockResolvedValueOnce(jumpConn);

    const factory = await createFactory();
    await expect(factory.connect(targetServer)).rejects.toThrow("Connection refused");
    expect(jumpConn.dispose).toHaveBeenCalled();
  });

  it("throws immediately for circular chains when using pooled jump-host reuse", async () => {
    const serverA = makeServer({
      id: "srv-a",
      name: "A",
      host: "a.example.com",
      proxy: { type: "ssh", jumpHostId: "srv-b" }
    });
    const serverB = makeServer({
      id: "srv-b",
      name: "B",
      host: "b.example.com",
      proxy: { type: "ssh", jumpHostId: "srv-a" }
    });
    servers.set("srv-a", serverA);
    servers.set("srv-b", serverB);

    const { pool } = await createPooledFactory();
    await expect(pool.connect(serverA)).rejects.toThrow("Circular proxy reference");
  });

  it("does not reuse jump host connections when jump host multiplexing is disabled", async () => {
    const jumpServer = makeServer({
      id: "srv-jump",
      name: "Jump Host",
      host: "jump.example.com",
      multiplexing: false
    });
    const targetServer = makeServer({
      proxy: { type: "ssh", jumpHostId: "srv-jump" }
    });
    servers.set("srv-jump", jumpServer);

    const activeJumpConn = makeFakeConnection();
    const proxiedJumpConn = makeFakeConnection();
    const tunnelStream = { pause: vi.fn() } as unknown as Duplex;
    proxiedJumpConn.openDirectTcp = vi.fn(async () => tunnelStream);
    const targetConn = makeFakeConnection();

    authFactory.connect = vi.fn()
      .mockResolvedValueOnce(activeJumpConn)
      .mockResolvedValueOnce(proxiedJumpConn)
      .mockResolvedValueOnce(targetConn);

    const { pool } = await createPooledFactory();
    const activeJumpLease = await pool.connect(jumpServer);
    const targetLease = await pool.connect(targetServer);

    expect(authFactory.connect).toHaveBeenCalledTimes(3);
    expect(authFactory.connect).toHaveBeenNthCalledWith(1, jumpServer);
    expect(authFactory.connect).toHaveBeenNthCalledWith(2, jumpServer);
    expect(authFactory.connect).toHaveBeenNthCalledWith(3, targetServer, { sock: tunnelStream });

    targetLease.dispose();
    activeJumpLease.dispose();
  });

  it("falls back to a standalone jump-host connection when a reused hop refuses extra channels", async () => {
    const jumpServer = makeServer({ id: "srv-jump", name: "Jump Host", host: "jump.example.com" });
    const targetServer = makeServer({
      proxy: { type: "ssh", jumpHostId: "srv-jump" }
    });
    servers.set("srv-jump", jumpServer);

    const pooledJumpConn = makeFakeConnection();
    pooledJumpConn.openDirectTcp = vi.fn(async () => {
      throw new Error("Channel open failure: Administratively prohibited");
    });

    const fallbackJumpConn = makeFakeConnection();
    const tunnelStream = { pause: vi.fn() } as unknown as Duplex;
    fallbackJumpConn.openDirectTcp = vi.fn(async () => tunnelStream);

    const targetConn = makeFakeConnection();

    authFactory.connect = vi.fn()
      .mockResolvedValueOnce(pooledJumpConn)
      .mockResolvedValueOnce(fallbackJumpConn)
      .mockResolvedValueOnce(targetConn);

    const { pool } = await createPooledFactory();
    const jumpLease = await pool.connect(jumpServer);
    const targetLease = await pool.connect(targetServer);

    expect(authFactory.connect).toHaveBeenCalledTimes(3);
    expect(authFactory.connect).toHaveBeenNthCalledWith(1, jumpServer);
    expect(authFactory.connect).toHaveBeenNthCalledWith(2, jumpServer);
    expect(authFactory.connect).toHaveBeenNthCalledWith(3, targetServer, { sock: tunnelStream });
    expect(fallbackJumpConn.openDirectTcp).toHaveBeenCalledWith("target.example.com", 22);

    targetLease.dispose();
    jumpLease.dispose();
  });

  it("sanitizes CRLF in HTTP CONNECT host and proxy username", async () => {
    const server = makeServer({
      host: "target.example.com\r\nX-Injected: 1",
      proxy: {
        type: "http",
        host: "proxy.local",
        port: 3128,
        username: "attacker\r\nX-Auth: 1"
      }
    });
    vault = createVault({ "proxy-password-srv-target": "pw-1" });

    const socket = createMockHttpSocket();
    await mockNetCreateConnectionWithSocket(socket);

    const factory = await createFactory();
    const promise = factory.connect(server);
    await waitForSocketWrite(socket);
    socket.emitData("HTTP/1.1 200 Connection Established\r\n\r\n");
    await promise;

    const request = String(socket.write.mock.calls[0][0]);
    expect(request).not.toContain("\r\nX-Injected: 1\r\n");
    const headerMatch = request.match(/Proxy-Authorization: Basic ([^\r\n]+)/);
    expect(headerMatch).toBeTruthy();
    const decoded = Buffer.from(headerMatch![1], "base64").toString("utf8");
    expect(decoded).not.toContain("\r");
    expect(decoded).not.toContain("\n");
  });

  it("rejects oversized HTTP CONNECT responses and destroys socket", async () => {
    const server = makeServer({
      proxy: { type: "http", host: "proxy.local", port: 3128 }
    });
    const socket = createMockHttpSocket();
    await mockNetCreateConnectionWithSocket(socket);

    const factory = await createFactory();
    const promise = factory.connect(server);
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.emitData("A".repeat(70000));

    await expect(promise).rejects.toThrow("HTTP CONNECT proxy response too large");
    expect(socket.destroy).toHaveBeenCalled();
    expect(authFactory.connect).not.toHaveBeenCalled();
  });

  it("pushes back trailing HTTP CONNECT data so SSH banner is preserved", async () => {
    const server = makeServer({
      proxy: { type: "http", host: "proxy.local", port: 3128 }
    });
    const socket = createMockHttpSocket();
    await mockNetCreateConnectionWithSocket(socket);

    const factory = await createFactory();
    const promise = factory.connect(server);
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.emitData("HTTP/1.1 200 OK\r\nProxy-Agent: test\r\n\r\nSSH-2.0-test-banner");
    await promise;

    expect(socket.unshift).toHaveBeenCalledTimes(1);
    const pushed = socket.unshift.mock.calls[0][0] as Buffer;
    expect(pushed.toString()).toBe("SSH-2.0-test-banner");
  });

  it("emits onClose when an HTTP CONNECT proxy socket closes after connection", async () => {
    const server = makeServer({
      proxy: { type: "http", host: "proxy.local", port: 3128 }
    });
    const socket = createMockHttpSocket();
    await mockNetCreateConnectionWithSocket(socket);
    const targetConn = makeFakeConnection();
    authFactory.connect = vi.fn().mockResolvedValueOnce(targetConn);

    const factory = await createFactory();
    const connection = await (async () => {
      const promise = factory.connect(server);
      await new Promise<void>((resolve) => setImmediate(resolve));
      socket.emitData("HTTP/1.1 200 Connection Established\r\n\r\n");
      return promise;
    })();

    const listener = vi.fn();
    connection.onClose(listener);
    socket.emitClose();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("passes the configured timeout to SOCKS5 proxy handshakes", async () => {
    const server = makeServer({
      proxy: { type: "socks5", host: "proxy.local", port: 1080 }
    });
    const socket = {
      pause: vi.fn(),
      on: vi.fn(() => socket),
      removeListener: vi.fn(() => socket)
    };
    const socksMod = await import("socks");
    (socksMod.SocksClient.createConnection as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ socket } as any);

    const { ProxySshFactory } = await import("../../src/services/ssh/proxySshFactory");
    const factory = new ProxySshFactory(
      authFactory,
      (id: string) => servers.get(id),
      vault,
      42_000
    );

    await factory.connect(server);

    expect(socksMod.SocksClient.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 42_000 })
    );
    expect(socket.pause).toHaveBeenCalled();
  });

  it("emits onClose when a SOCKS5 proxy socket closes after connection", async () => {
    const server = makeServer({
      proxy: { type: "socks5", host: "proxy.local", port: 1080 }
    });
    const closeListeners = new Set<() => void>();
    const endListeners = new Set<() => void>();
    const errorListeners = new Set<(error: Error) => void>();
    const socket: any = {
      pause: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "close") {
          closeListeners.add(handler as () => void);
        } else if (event === "end") {
          endListeners.add(handler as () => void);
        } else if (event === "error") {
          errorListeners.add(handler as (error: Error) => void);
        }
        return socket;
      }),
      removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "close") {
          closeListeners.delete(handler as () => void);
        } else if (event === "end") {
          endListeners.delete(handler as () => void);
        } else if (event === "error") {
          errorListeners.delete(handler as (error: Error) => void);
        }
        return socket;
      }),
      emitClose: () => {
        for (const listener of [...closeListeners]) {
          listener();
        }
      }
    };
    const targetConn = makeFakeConnection();
    authFactory.connect = vi.fn().mockResolvedValueOnce(targetConn);

    const socksMod = await import("socks");
    (socksMod.SocksClient.createConnection as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ socket } as any);

    const factory = await createFactory();
    const connection = await factory.connect(server);
    const listener = vi.fn();
    connection.onClose(listener);

    socket.emitClose();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
