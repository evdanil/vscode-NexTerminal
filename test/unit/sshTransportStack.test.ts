import * as net from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxyConfig, ServerConfig, TunnelProfile } from "../../src/models/config";
import type { SecretVault, SshConnection } from "../../src/services/ssh/contracts";
import type { SilentAuthSshFactory } from "../../src/services/ssh/silentAuth";
import { createSshTransportStack, type SshTransportStack } from "../../src/services/ssh/sshTransportStack";
import { handleSocks5Handshake, sendSocks5Success } from "../../src/services/tunnel/socks5";

/**
 * Issue #148 — an isolated-mode tunnel was handed the bare credential factory
 * instead of the proxy-aware one, so on a server whose Proxy is a jump host,
 * SOCKS5 or HTTP CONNECT it dialled the server's Host directly. The wiring
 * lives in `createSshTransportStack` (extracted from `activate()` so it can be
 * exercised for real), and these tests drive the REAL ProxySshFactory, pool and
 * TunnelManager it composes; only the credential layer underneath is faked.
 */

const TARGET_HOST = "target.example.test";
const TARGET_PORT = 2222;

const jumpServer: ServerConfig = {
  id: "srv-jump",
  name: "Bastion",
  host: "bastion.example.test",
  port: 22,
  username: "ops",
  authType: "password",
  isHidden: false
};

function targetServer(proxy: ProxyConfig): ServerConfig {
  return {
    id: "srv-target",
    name: "Target",
    host: TARGET_HOST,
    port: TARGET_PORT,
    username: "root",
    authType: "password",
    isHidden: false,
    proxy
  };
}

function isolatedProfile(localPort: number): TunnelProfile {
  return {
    id: "tun-1",
    name: "Isolated tunnel",
    localPort,
    remoteIP: "10.0.0.5",
    remotePort: 80,
    autoStart: false,
    connectionMode: "isolated",
    tunnelType: "local"
  };
}

function fakeConnection(onDispose: () => void, openDirectTcp: (host: string, port: number) => Promise<Duplex>) {
  const closeListeners = new Set<() => void>();
  const connection: SshConnection = {
    openShell: vi.fn(async () => new PassThrough()),
    openDirectTcp: vi.fn(openDirectTcp),
    openSftp: vi.fn(async () => {
      throw new Error("not used");
    }),
    exec: vi.fn(async () => new PassThrough()),
    requestForwardIn: vi.fn(async () => 0),
    cancelForwardIn: vi.fn(async () => {}),
    onTcpConnection: vi.fn(() => () => {}),
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    getBanner: () => undefined,
    dispose: vi.fn(onDispose)
  };
  return connection;
}

/**
 * A forwarded channel whose far end keeps its half open, as a real one may:
 * ending what we send does not close it, so only an explicit destroy — or the
 * connection it rides being disposed — ever releases it.
 */
function halfOpenChannel(): Duplex {
  return new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Stands in for `SilentAuthSshFactory`. Like the real one it takes its
 * transport from `sockFactory` when one is given (a proxied connect) and
 * otherwise would dial `server.host` itself — recorded here as `direct`.
 * `gates` hold a target login, or a target channel open, in flight until the
 * test releases them.
 */
function createAuthFactory(gates: { targetLogin?: Promise<void>; channelOpen?: Promise<void> } = {}) {
  const calls: Array<{ serverId: string; route: "direct" | "via-proxy" }> = [];
  const jumpDials: string[] = [];
  // Forwarded streams opened on target connections — the last step of serving a
  // tunnel client, so waiting on it means the proxy handshake has finished.
  const forwardedStreams: string[] = [];
  const channels: Duplex[] = [];
  const disposedIds: string[] = [];
  const connect = vi.fn(async (server: ServerConfig, options?: { sockFactory?: () => Promise<Duplex> }) => {
    calls.push({ serverId: server.id, route: options?.sockFactory ? "via-proxy" : "direct" });
    const sock = await options?.sockFactory?.();
    if (server.id !== jumpServer.id) {
      await gates.targetLogin;
    }
    if (server.id === jumpServer.id) {
      return fakeConnection(
        () => disposedIds.push(server.id),
        async (host, port) => {
          jumpDials.push(`${host}:${port}`);
          return new PassThrough();
        }
      );
    }
    let disposed = false;
    return fakeConnection(
      () => {
        disposed = true;
        disposedIds.push(server.id);
        sock?.destroy();
      },
      async (host, port) => {
        forwardedStreams.push(`${host}:${port}`);
        await gates.channelOpen;
        if (disposed) {
          // What ssh2 does for a channel requested on a connection that has since closed.
          throw new Error("Not connected");
        }
        const channel = halfOpenChannel();
        channels.push(channel);
        return channel;
      }
    );
  });
  return {
    factory: { connect } as unknown as SilentAuthSshFactory,
    calls,
    jumpDials,
    forwardedStreams,
    channels,
    disposedIds,
    callsFor: (serverId: string) => calls.filter((call) => call.serverId === serverId).map((call) => call.route)
  };
}

const vault: SecretVault = {
  get: async () => undefined,
  store: async () => {},
  delete: async () => {}
};

// Loopback proxy handshakes are quick, but not 1 s-quick on a loaded CI runner.
const SETTLE = { timeout: 4_000 };

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function listenLocal(onSocket: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer(onSocket);
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      })
  );
  return (server.address() as net.AddressInfo).port;
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A SOCKS5 proxy on loopback that records the destination it is asked for. */
async function startSocks5Proxy(requested: string[]): Promise<number> {
  return listenLocal((socket) => {
    handleSocks5Handshake(socket)
      .then(({ destAddr, destPort }) => {
        requested.push(`${destAddr}:${destPort}`);
        sendSocks5Success(socket);
      })
      .catch(() => socket.destroy());
  });
}

/** An HTTP CONNECT proxy on loopback that records the destination it is asked for. */
async function startHttpConnectProxy(requested: string[]): Promise<number> {
  return listenLocal((socket) => {
    socket.once("data", (chunk: Buffer) => {
      const requestLine = chunk.toString("latin1").split("\r\n")[0];
      const match = /^CONNECT (\S+) HTTP\/1\.1$/.exec(requestLine);
      if (match) {
        requested.push(match[1]);
      }
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    });
  });
}

function buildStack(
  auth: ReturnType<typeof createAuthFactory>,
  servers: ServerConfig[],
  idleTimeoutMs = 0
): SshTransportStack {
  const byId = new Map(servers.map((server) => [server.id, server]));
  const stack = createSshTransportStack(auth.factory, {
    serverLookup: (id) => byId.get(id),
    vault,
    proxyTimeoutMs: 5_000,
    pool: { enabled: true, idleTimeoutMs },
    socks5HandshakeTimeoutMs: 10_000
  });
  cleanups.push(() => stack.pool.dispose());
  return stack;
}

async function startTunnel(
  stack: SshTransportStack,
  server: ServerConfig,
  overrides: Partial<TunnelProfile> = {}
): Promise<{ localPort: number; stop: () => Promise<void> }> {
  const localPort = await getFreePort();
  const profile = { ...isolatedProfile(localPort), ...overrides };
  const active = await stack.tunnelManager.start(profile, server, {
    connectionMode: profile.connectionMode === "shared" ? "shared" : "isolated"
  });
  const stop = () => stack.tunnelManager.stop(active.id);
  cleanups.push(stop);
  return { localPort, stop };
}

async function startIsolatedTunnel(stack: SshTransportStack, server: ServerConfig): Promise<number> {
  return (await startTunnel(stack, server)).localPort;
}

function openClient(localPort: number): net.Socket {
  const client = net.createConnection({ host: "127.0.0.1", port: localPort });
  client.on("error", () => {});
  cleanups.push(() => {
    client.destroy();
  });
  return client;
}

/** Opens a SOCKS5 client and asks the tunnel for `host:port`; the reply only comes once the tunnel has a connection. */
async function openSocks5Client(localPort: number, host: string, port: number): Promise<net.Socket> {
  const client = openClient(localPort);
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  client.write(Buffer.from([0x05, 0x01, 0x00]));
  await new Promise<void>((resolve) => client.once("data", () => resolve()));
  const name = Buffer.from(host, "ascii");
  client.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([port >> 8, port & 0xff])]));
  return client;
}

/**
 * The client goes away and the tunnel's end of it has closed. The wait is for
 * the red run's sake: the old code only leaked when that close landed BEFORE
 * the connection finished, and a fixed tunnel is correct in either order.
 */
async function leave(client: net.Socket, how: "fin" | "rst"): Promise<void> {
  const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
  if (how === "rst") {
    client.resetAndDestroy();
  } else {
    client.destroy();
  }
  await closed;
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
}

describe("createSshTransportStack — isolated-mode tunnels honour the server's proxy (issue #148)", () => {
  // Each case records what the configured proxy was asked to reach. Against the
  // pre-fix wiring (`new TunnelManager(pool, authFactory, …)`) the target is
  // authenticated `direct` and the proxy is never contacted, so every case fails.
  const proxyCases: Array<{
    name: string;
    setUp: (auth: ReturnType<typeof createAuthFactory>) => Promise<{ proxy: ProxyConfig; requested: () => string[] }>;
  }> = [
    {
      name: "SSH jump host",
      setUp: async (auth) => ({
        proxy: { type: "ssh", jumpHostId: jumpServer.id },
        requested: () => auth.jumpDials
      })
    },
    {
      name: "SOCKS5 proxy",
      setUp: async () => {
        const requested: string[] = [];
        const port = await startSocks5Proxy(requested);
        return { proxy: { type: "socks5", host: "127.0.0.1", port }, requested: () => requested };
      }
    },
    {
      name: "HTTP CONNECT proxy",
      setUp: async () => {
        const requested: string[] = [];
        const port = await startHttpConnectProxy(requested);
        return { proxy: { type: "http", host: "127.0.0.1", port }, requested: () => requested };
      }
    }
  ];

  it.each(proxyCases)("an isolated tunnel reaches the target through its $name", async ({ setUp }) => {
    const auth = createAuthFactory();
    const { proxy, requested } = await setUp(auth);
    const target = targetServer(proxy);
    const stack = buildStack(auth, [jumpServer, target]);
    const localPort = await startIsolatedTunnel(stack, target);

    openClient(localPort);

    await vi.waitFor(() => expect(auth.forwardedStreams).toHaveLength(1), SETTLE);
    expect(requested()).toEqual([`${TARGET_HOST}:${TARGET_PORT}`]);
    expect(auth.callsFor(target.id)).toEqual(["via-proxy"]);
  });

  it("gives every client its own target connection while the jump-host hop is leased from the pool", async () => {
    // Guards the other two ways to get this wiring wrong:
    //  - handing isolated mode the pool (`new TunnelManager(pool, pool, …)`)
    //    routes the proxy correctly but rides the terminal's pooled target
    //    connection — the target is then authenticated once, not per client;
    //  - a second ProxySshFactory without the pool as its jump-host factory
    //    re-authenticates to the bastion for every client (a password/2FA
    //    prompt per TCP connection) where terminals and shared tunnels lease it.
    const auth = createAuthFactory();
    const target = targetServer({ type: "ssh", jumpHostId: jumpServer.id });
    const stack = buildStack(auth, [jumpServer, target]);

    // An open terminal on the target: a pooled lease on its connection.
    const terminalLease = await stack.pool.connect(target);
    cleanups.push(() => terminalLease.dispose());
    expect(auth.callsFor(target.id)).toEqual(["via-proxy"]);

    const localPort = await startIsolatedTunnel(stack, target);
    openClient(localPort);
    await vi.waitFor(() => expect(auth.forwardedStreams).toHaveLength(1), SETTLE);
    openClient(localPort);
    await vi.waitFor(() => expect(auth.forwardedStreams).toHaveLength(2), SETTLE);

    expect(auth.callsFor(target.id)).toEqual(["via-proxy", "via-proxy", "via-proxy"]);
    expect(auth.callsFor(jumpServer.id)).toEqual(["direct"]);
    expect(auth.jumpDials).toEqual([
      `${TARGET_HOST}:${TARGET_PORT}`,
      `${TARGET_HOST}:${TARGET_PORT}`,
      `${TARGET_HOST}:${TARGET_PORT}`
    ]);
  });
  it("logs in to the bastion once per client when multiplexing is off for the jump host", async () => {
    // Pins the caveat the guides state ("unless multiplexing is off for the
    // jump host"): the hop goes through the pool, and the pool honours the
    // JUMP server's own multiplexing flag. A pool that consulted only the
    // global setting would share the bastion here — one login, not two.
    const auth = createAuthFactory();
    const bastion: ServerConfig = { ...jumpServer, multiplexing: false };
    const target = targetServer({ type: "ssh", jumpHostId: bastion.id });
    const stack = buildStack(auth, [bastion, target]);
    const localPort = await startIsolatedTunnel(stack, target);

    openClient(localPort);
    await vi.waitFor(() => expect(auth.forwardedStreams).toHaveLength(1), SETTLE);
    openClient(localPort);
    await vi.waitFor(() => expect(auth.forwardedStreams).toHaveLength(2), SETTLE);

    expect(auth.callsFor(bastion.id)).toEqual(["direct", "direct"]);
    expect(auth.callsFor(target.id)).toEqual(["via-proxy", "via-proxy"]);
  });

  it("releases a client's pooled bastion lease when the client disconnects", async () => {
    // With the last lease returned the pool's idle timer evicts the bastion
    // connection; a lease an isolated client never gave back would keep the
    // bastion logged in for as long as the tunnel runs.
    const auth = createAuthFactory();
    const target = targetServer({ type: "ssh", jumpHostId: jumpServer.id });
    const stack = buildStack(auth, [jumpServer, target], 20);
    const localPort = await startIsolatedTunnel(stack, target);

    const client = openClient(localPort);
    await vi.waitFor(() => expect(auth.forwardedStreams).toHaveLength(1), SETTLE);
    expect(auth.disposedIds).toEqual([]);

    client.destroy();

    await vi.waitFor(() => expect(auth.disposedIds).toContain(jumpServer.id), SETTLE);
    expect(auth.disposedIds).toContain(target.id);
  });
});

describe("TunnelManager — a client that leaves before its connection is up", () => {
  // An isolated connect can take seconds (a jump-host hop, a password or 2FA
  // prompt). A client that disconnects in that window — or a stop() that sweeps
  // the tunnel while it is still in flight — must not leave the connection it
  // was waiting for open, holding its pooled jump-host lease so the bastion is
  // never idle-evicted. `targetLogin` holds the target's login open until the
  // client has gone; the idle timeout (20 ms) makes the released lease visible
  // as the bastion connection being disposed.
  const behindBastion = () => targetServer({ type: "ssh", jumpHostId: jumpServer.id });
  // The local and SOCKS5 handlers each carry their own copy of these guards.
  const bothTunnelTypes = [
    { tunnelType: "local" as const, open: (localPort: number) => Promise.resolve(openClient(localPort)) },
    { tunnelType: "dynamic" as const, open: (localPort: number) => openSocks5Client(localPort, "intranet.example.test", 443) }
  ];

  it("disposes the target connection and releases the bastion when a local client leaves mid-login", async () => {
    const login = deferred();
    const auth = createAuthFactory({ targetLogin: login.promise });
    const target = behindBastion();
    const stack = buildStack(auth, [jumpServer, target], 20);
    const { localPort } = await startTunnel(stack, target);

    const client = openClient(localPort);
    await vi.waitFor(() => expect(auth.jumpDials).toHaveLength(1), SETTLE);
    await leave(client, "fin");
    login.resolve();

    await vi.waitFor(() => expect(auth.disposedIds).toEqual(expect.arrayContaining([target.id, jumpServer.id])), SETTLE);
    expect(auth.forwardedStreams).toEqual([]);
  });

  it("disposes the target connection and releases the bastion when stop() sweeps the tunnel mid-login", async () => {
    const login = deferred();
    const auth = createAuthFactory({ targetLogin: login.promise });
    const target = behindBastion();
    const stack = buildStack(auth, [jumpServer, target], 20);
    const { localPort, stop } = await startTunnel(stack, target);

    const client = openClient(localPort);
    await vi.waitFor(() => expect(auth.jumpDials).toHaveLength(1), SETTLE);
    const clientClosed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    await stop();
    // stop() destroys the tunnel's end at once but its 'close' lands a little
    // later; the login finishing after that is the case that leaked.
    await clientClosed;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    login.resolve();

    await vi.waitFor(() => expect(auth.disposedIds).toEqual(expect.arrayContaining([target.id, jumpServer.id])), SETTLE);
    expect(auth.forwardedStreams).toEqual([]);
  });

  it("disposes the target connection and releases the bastion when a SOCKS5 client resets mid-login", async () => {
    // A reset also arrives as an 'error' on the tunnel's socket; nothing may be
    // left unlistened for it while the connect is in flight.
    const login = deferred();
    const auth = createAuthFactory({ targetLogin: login.promise });
    const target = behindBastion();
    const stack = buildStack(auth, [jumpServer, target], 20);
    const { localPort } = await startTunnel(stack, target, { tunnelType: "dynamic" });

    const client = await openSocks5Client(localPort, "intranet.example.test", 443);
    await vi.waitFor(() => expect(auth.jumpDials).toHaveLength(1), SETTLE);
    await leave(client, "rst");
    login.resolve();

    await vi.waitFor(() => expect(auth.disposedIds).toEqual(expect.arrayContaining([target.id, jumpServer.id])), SETTLE);
    expect(auth.forwardedStreams).toEqual([]);
  });

  it.each(bothTunnelTypes)("closes a channel that opens after its $tunnelType client has left, without touching the shared connection", async ({ tunnelType, open }) => {
    // Shared mode keeps the connection — it carries the tunnel's other clients —
    // but the channel opened for a client that is gone has no one left to close it.
    const channelOpen = deferred();
    const auth = createAuthFactory({ channelOpen: channelOpen.promise });
    const target = behindBastion();
    const stack = buildStack(auth, [jumpServer, target]);
    const { localPort } = await startTunnel(stack, target, { connectionMode: "shared", tunnelType });

    const client = await open(localPort);
    await vi.waitFor(() => expect(auth.forwardedStreams).toHaveLength(1), SETTLE);
    await leave(client, "fin");
    channelOpen.resolve();

    await vi.waitFor(() => expect(auth.channels).toHaveLength(1), SETTLE);
    await vi.waitFor(() => expect(auth.channels[0].destroyed).toBe(true), SETTLE);
    expect(auth.disposedIds).not.toContain(target.id);
  });

  it.each(bothTunnelTypes)("disposes an isolated connection whose $tunnelType client leaves while its channel opens, without reporting an error", async ({ tunnelType, open }) => {
    // Disposing the connection is what fails the pending channel open; that is
    // the release working, not a tunnel failure to put in front of the user.
    const channelOpen = deferred();
    const auth = createAuthFactory({ channelOpen: channelOpen.promise });
    const target = behindBastion();
    const stack = buildStack(auth, [jumpServer, target], 20);
    const errors: string[] = [];
    stack.tunnelManager.onDidChange((event) => {
      if (event.type === "error") {
        errors.push(event.message);
      }
    });
    const { localPort } = await startTunnel(stack, target, { tunnelType });

    const client = await open(localPort);
    await vi.waitFor(() => expect(auth.forwardedStreams).toHaveLength(1), SETTLE);
    await leave(client, "fin");
    channelOpen.resolve();

    await vi.waitFor(() => expect(auth.disposedIds).toEqual(expect.arrayContaining([target.id, jumpServer.id])), SETTLE);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(errors).toEqual([]);
  });
});
