import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Duplex } from "node:stream";
import type { SFTPWrapper } from "ssh2";
import type { ServerConfig } from "../../src/models/config";
import type { SecretVault, SshConnection } from "../../src/services/ssh/contracts";
import { ProxiedSshConnection, jumpHostCleanup, socketCleanup } from "../../src/services/ssh/proxiedSshConnection";

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

function makeFakeConnection(): SshConnection & { disposed: boolean } {
  const conn: SshConnection & { disposed: boolean } = {
    disposed: false,
    openShell: vi.fn(async () => ({} as Duplex)),
    openDirectTcp: vi.fn(async () => ({} as Duplex)),
    openSftp: vi.fn(async () => ({} as SFTPWrapper)),
    exec: vi.fn(async () => ({} as Duplex)),
    requestForwardIn: vi.fn(async () => 0),
    cancelForwardIn: vi.fn(async () => {}),
    onTcpConnection: vi.fn(() => () => {}),
    onClose: vi.fn(() => () => {}),
    dispose: vi.fn(() => { conn.disposed = true; })
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

    const listener = () => {};
    proxied.onClose(listener);
    expect(inner.onClose).toHaveBeenCalledWith(listener);
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
    const tunnelStream = {} as Duplex;
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
    const tunnelBC = {} as Duplex;
    connC.openDirectTcp = vi.fn(async () => tunnelBC);

    const connB = makeFakeConnection();
    const tunnelAB = {} as Duplex;
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
    jumpConn.openDirectTcp = vi.fn(async () => ({} as Duplex));

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
});
