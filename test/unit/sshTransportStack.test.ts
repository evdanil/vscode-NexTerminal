import * as net from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxyConfig, ServerConfig, TunnelProfile } from "../../src/models/config";
import type { SecretVault, SshConnection } from "../../src/services/ssh/contracts";
import type { SilentAuthSshFactory } from "../../src/services/ssh/silentAuth";
import { createSshTransportStack, type SshTransportStack } from "../../src/services/ssh/sshTransportStack";
import { handleSocks5Handshake, sendSocks5Success } from "../../src/services/tunnel/socks5";
import { TunnelStoppedError, type TunnelEvent } from "../../src/services/tunnel/tunnelManager";
import type { PoolEvent } from "../../src/services/ssh/sshConnectionPool";

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

function fakeConnection(
  onDispose: () => void,
  openDirectTcp: (host: string, port: number) => Promise<Duplex>,
  requestForwardIn: (bindAddr: string, bindPort: number) => Promise<number> = async () => 0,
  cancelForwardIn: (bindAddr: string, bindPort: number) => Promise<void> = async () => {}
) {
  const closeListeners = new Set<() => void>();
  let closed = false;
  const emitClose = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const listener of [...closeListeners]) {
      listener();
    }
  };
  const connection: SshConnection & { drop(): void } = {
    openShell: vi.fn(async () => new PassThrough()),
    openDirectTcp: vi.fn(openDirectTcp),
    openSftp: vi.fn(async () => {
      throw new Error("not used");
    }),
    exec: vi.fn(async () => new PassThrough()),
    requestForwardIn: vi.fn(requestForwardIn),
    cancelForwardIn: vi.fn(cancelForwardIn),
    onTcpConnection: vi.fn(() => () => {}),
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    getBanner: () => undefined,
    dispose: vi.fn(() => {
      onDispose();
      emitClose();
    }),
    /** The transport drops under the connection, as when the server goes away. */
    drop: emitClose
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
 * `gates` hold a target login, a target channel open, or a target's remote
 * forward request or its cancel in flight until the test releases them. They
 * are read at each call, so a test can gate a later login than the first.
 * A target keeps a granted remote forward bound until it is cancelled or the
 * connection is disposed, and refuses a second one on the same address and
 * port, as an SSH server does; port 0 is allocated one from 40000 up.
 */
function createAuthFactory(
  gates: {
    targetLogin?: Promise<void>;
    channelOpen?: Promise<void>;
    forwardIn?: Promise<void>;
    forwardInRefusal?: Error;
    forwardCancel?: Promise<void>;
    forwardCancelRefusal?: Error;
  } = {},
  bindingNamespace: (server: ServerConfig) => string = (server) => `${server.host}:${server.port}`
) {
  const calls: Array<{ serverId: string; route: "direct" | "via-proxy" }> = [];
  // Every target connection handed out, in order.
  const targets: Array<ReturnType<typeof fakeConnection>> = [];
  const jumpDials: string[] = [];
  // Forwarded streams opened on target connections — the last step of serving a
  // tunnel client, so waiting on it means the proxy handshake has finished.
  const forwardedStreams: string[] = [];
  const channels: Duplex[] = [];
  const disposedIds: string[] = [];
  // Remote TCP forwards bind on the server, not inside one SSH connection.
  // Keeping the fake state at server scope catches collisions across transports.
  const boundForwardsByServer = new Map<string, Set<string>>();
  let nextAllocated = 40_000;
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
    const serverKey = bindingNamespace(server);
    let boundForwards = boundForwardsByServer.get(serverKey);
    if (!boundForwards) {
      boundForwards = new Set<string>();
      boundForwardsByServer.set(serverKey, boundForwards);
    }
    const ownedForwards = new Set<string>();
    const target = fakeConnection(
      () => {
        disposed = true;
        for (const binding of ownedForwards) {
          boundForwards!.delete(binding);
        }
        ownedForwards.clear();
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
      },
      async (bindAddr, bindPort) => {
        await gates.forwardIn;
        if (disposed) {
          throw new Error("Not connected");
        }
        if (gates.forwardInRefusal) {
          throw gates.forwardInRefusal;
        }
        const port = bindPort === 0 ? nextAllocated++ : bindPort;
        if (boundForwards.has(`${bindAddr}:${port}`)) {
          throw new Error(`Unable to bind to ${bindAddr}:${port}`);
        }
        const binding = `${bindAddr}:${port}`;
        boundForwards.add(binding);
        ownedForwards.add(binding);
        return port;
      },
      async (bindAddr, bindPort) => {
        await gates.forwardCancel;
        if (gates.forwardCancelRefusal) {
          throw gates.forwardCancelRefusal;
        }
        const binding = `${bindAddr}:${bindPort}`;
        boundForwards.delete(binding);
        ownedForwards.delete(binding);
      }
    );
    targets.push(target);
    return target;
  });
  return {
    factory: { connect } as unknown as SilentAuthSshFactory,
    calls,
    targets,
    jumpDials,
    forwardedStreams,
    channels,
    disposedIds,
    isForwardBound: (server: ServerConfig, bindAddr: string, bindPort: number) =>
      boundForwardsByServer.get(bindingNamespace(server))?.has(`${bindAddr}:${bindPort}`) ?? false,
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

describe("TunnelManager — a shared tunnel stopped while its connection logs in (issue #176)", () => {
  // stop() sweeps the connections a tunnel holds at that moment. A shared
  // connect still in flight is not held yet, so it used to land on the stopped
  // tunnel afterwards: its pooled lease was never released — the server's pooled
  // connection was never idle-evicted — and the start() it belonged to went on
  // to report the tunnel started. The idle timeout (20 ms) makes a released
  // lease visible as the target connection being disposed.
  const direct: ServerConfig = {
    id: "srv-direct",
    name: "Direct",
    host: TARGET_HOST,
    port: TARGET_PORT,
    username: "root",
    authType: "password",
    isHidden: false
  };
  const sharedProfile = async (tunnelType: TunnelProfile["tunnelType"]): Promise<TunnelProfile> => ({
    // Reverse tunnels do not bind a local port, so keep these tests independent
    // of OS port allocation. Local and dynamic tunnels need a real free port.
    ...isolatedProfile(tunnelType === "reverse" ? 12_345 : await getFreePort()),
    connectionMode: "shared",
    tunnelType
  });
  const bothTunnelTypes = [
    { tunnelType: "local" as const, open: (localPort: number) => Promise.resolve(openClient(localPort)) },
    { tunnelType: "dynamic" as const, open: (localPort: number) => openSocks5Client(localPort, "intranet.example.test", 443) }
  ];

  it.each(["local", "dynamic", "reverse"] as const)(
    "start() of a %s tunnel stopped mid-login rejects as stopped, never reports started, and releases its lease",
    async (tunnelType) => {
      const login = deferred();
      const auth = createAuthFactory({ targetLogin: login.promise });
      const stack = buildStack(auth, [direct], 20);
      const events: TunnelEvent[] = [];
      stack.tunnelManager.onDidChange((event) => events.push(event));
      const profile = await sharedProfile(tunnelType);

      const outcome = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
        () => "resolved",
        (error: unknown) => error
      );
      await vi.waitFor(() => expect(auth.calls).toHaveLength(1), SETTLE);
      // The one stop that reaches a tunnel before it has been reported started:
      // the extension shutting down.
      await stack.tunnelManager.stopAll();
      login.resolve();

      const result = await outcome;
      expect(events.map((event) => event.type)).not.toContain("started");
      await vi.waitFor(() => expect(auth.targets[0]?.dispose).toHaveBeenCalled(), SETTLE);
      expect(auth.targets[0].requestForwardIn).not.toHaveBeenCalled();
      expect(result).toBeInstanceOf(TunnelStoppedError);
    }
  );

  it("start() of a reverse tunnel stopped while its remote forward is requested never reports started", async () => {
    // Multiplexing off, so the tunnel holds the connection itself rather than a
    // pool lease. Port 0: the forward granted afterwards is withdrawn on the
    // port the server allocated, before the connection is closed.
    const forwardIn = deferred();
    const auth = createAuthFactory({ forwardIn: forwardIn.promise });
    const server: ServerConfig = { ...direct, multiplexing: false };
    const stack = buildStack(auth, [server], 20);
    const events: TunnelEvent[] = [];
    stack.tunnelManager.onDidChange((event) => events.push(event));
    const profile = { ...(await sharedProfile("reverse")), remotePort: 0 };

    const outcome = stack.tunnelManager.start(profile, server, { connectionMode: "shared" }).then(
      () => "resolved",
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);
    await stack.tunnelManager.stopAll();
    forwardIn.resolve();

    const result = await outcome;
    expect(events.map((event) => event.type)).not.toContain("started");
    expect(auth.targets[0].onTcpConnection).not.toHaveBeenCalled();
    expect(auth.targets[0].cancelForwardIn).toHaveBeenCalledWith("127.0.0.1", 40_000);
    expect(auth.targets[0].dispose).toHaveBeenCalledTimes(1);
    expect(auth.targets[0].cancelForwardIn.mock.invocationCallOrder[0]).toBeLessThan(
      auth.targets[0].dispose.mock.invocationCallOrder[0]
    );
    expect(result).toBeInstanceOf(TunnelStoppedError);
  });

  it("withdraws a remote forward granted after stop() from the pooled connection a terminal keeps open, then releases its lease", async () => {
    // stop() used to release the tunnel's lease while the forward request was
    // in flight. The terminal's lease kept the connection alive, so a forward
    // granted afterwards stayed bound on it, and starting the tunnel again
    // failed as already bound until that connection closed.
    const forwardIn = deferred();
    const gates: { forwardIn?: Promise<void> } = { forwardIn: forwardIn.promise };
    const auth = createAuthFactory(gates);
    const stack = buildStack(auth, [direct], 20);
    const terminalLease = await stack.pool.connect(direct);
    const profile = { ...(await sharedProfile("reverse")), remotePort: 8022 };

    const stale = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
      () => "resolved",
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);
    await stack.tunnelManager.stopAll();
    forwardIn.resolve();

    expect(await stale).toBeInstanceOf(TunnelStoppedError);
    expect(auth.targets[0].cancelForwardIn).toHaveBeenCalledWith("127.0.0.1", 8022);

    const restarted = await stack.tunnelManager.start(profile, direct, { connectionMode: "shared" });
    await stack.tunnelManager.stop(restarted.id);
    // Withdrawn cleanly, so the transport stays shared: no second login.
    expect(auth.targets).toHaveLength(1);
    expect(auth.targets[0].dispose).not.toHaveBeenCalled();
    terminalLease.dispose();
    // Evicted as idle only once every lease — the stopped start's included — is back.
    await vi.waitFor(() => expect(auth.targets[0].dispose).toHaveBeenCalledTimes(1), SETTLE);
  });

  it("lets a replacement start of the profile request its forward only once the stopped start's is withdrawn", async () => {
    // stop() forgets the tunnel at once, so the profile can start again while
    // the stopped start's request is still in flight on the same pooled
    // transport. Asked at once, the replacement's bind reached the server
    // behind the old one — granted, and not yet withdrawn — and was refused
    // as already bound.
    const forwardIn = deferred();
    const auth = createAuthFactory({ forwardIn: forwardIn.promise });
    const stack = buildStack(auth, [direct], 20);
    const profile = { ...(await sharedProfile("reverse")), remotePort: 8022 };

    const stale = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
      () => "resolved",
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);
    await stack.tunnelManager.stopAll();
    const replacement = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" });
    // Long enough for the replacement to reach its own request, unless it waits.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    forwardIn.resolve();

    expect(await stale).toBeInstanceOf(TunnelStoppedError);
    const active = await replacement;
    cleanups.push(() => stack.tunnelManager.stop(active.id));
    expect(stack.tunnelManager.getActiveTunnelId(profile.id)).toBe(active.id);
  });

  it("allows a reverse forward on a distinct proxy route while the first route's request is pending", async () => {
    const forwardIn = deferred();
    const auth = createAuthFactory({
      forwardIn: forwardIn.promise,
      forwardInRefusal: new Error("forward request refused")
    });
    const routeARequests: string[] = [];
    const routeBRequests: string[] = [];
    const routeAPort = await startSocks5Proxy(routeARequests);
    const routeBPort = await startSocks5Proxy(routeBRequests);
    const routeA: ServerConfig = {
      ...direct,
      id: "srv-direct-route-a",
      multiplexing: false,
      proxy: { type: "socks5", host: "127.0.0.1", port: routeAPort }
    };
    const routeB: ServerConfig = {
      ...direct,
      id: "srv-direct-route-b",
      multiplexing: false,
      proxy: { type: "socks5", host: "127.0.0.1", port: routeBPort }
    };
    const stack = buildStack(auth, [routeA, routeB], 20);
    const profileA: TunnelProfile = {
      ...isolatedProfile(12345),
      id: "tun-route-a",
      connectionMode: "shared",
      tunnelType: "reverse",
      remotePort: 8022
    };
    const profileB: TunnelProfile = { ...profileA, id: "tun-route-b" };

    const stale = stack.tunnelManager.start(profileA, routeA, { connectionMode: "shared" }).then(
      () => undefined,
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);
    await stack.tunnelManager.stopAll();

    const replacement = stack.tunnelManager.start(profileB, routeB, { connectionMode: "shared" }).then(
      () => undefined,
      (error: unknown) => error
    );
    try {
      await vi.waitFor(() => expect(auth.targets).toHaveLength(2), SETTLE);
      await vi.waitFor(
        () => expect(auth.targets[1].requestForwardIn).toHaveBeenCalledWith("127.0.0.1", 8022),
        SETTLE
      );
      expect(routeARequests).toEqual([`${TARGET_HOST}:${TARGET_PORT}`]);
      expect(routeBRequests).toEqual([`${TARGET_HOST}:${TARGET_PORT}`]);
    } finally {
      await stack.tunnelManager.stopAll();
      forwardIn.resolve();
      await Promise.all([stale, replacement]);
    }
  });

  it("does not wait for a non-pooled predecessor's login before connecting a replacement", async () => {
    const login = deferred();
    const auth = createAuthFactory({ targetLogin: login.promise });
    const server: ServerConfig = { ...direct, multiplexing: false };
    const stack = buildStack(auth, [server], 20);
    const profile: TunnelProfile = {
      ...isolatedProfile(12345),
      connectionMode: "shared",
      tunnelType: "reverse",
      remotePort: 8022
    };

    const stale = stack.tunnelManager.start(profile, server, { connectionMode: "shared" }).then(
      () => "resolved",
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(auth.calls).toHaveLength(1), SETTLE);
    await stack.tunnelManager.stopAll();

    const replacement = stack.tunnelManager.start(profile, server, { connectionMode: "shared" });
    await vi.waitFor(() => expect(auth.calls).toHaveLength(2), SETTLE);
    login.resolve();

    expect(await stale).toBeInstanceOf(TunnelStoppedError);
    const active = await replacement;
    cleanups.push(() => stack.tunnelManager.stop(active.id));
    expect(auth.targets[0].requestForwardIn).not.toHaveBeenCalled();
    expect(auth.targets[1].requestForwardIn).toHaveBeenCalledWith("127.0.0.1", 8022);
  });

  it("does not hold a replacement behind an old target lease after its jump host route changes", async () => {
    const forwardIn = deferred();
    const liveGates: Parameters<typeof createAuthFactory>[0] = {
      forwardIn: forwardIn.promise,
      forwardCancelRefusal: new Error("request failed")
    };
    const jump: ServerConfig = { ...jumpServer, host: "bastion-a.example.test", multiplexing: false };
    const jumpProxyRequests: string[] = [];
    const jumpProxyPort = await startSocks5Proxy(jumpProxyRequests);
    const target = targetServer({ type: "ssh", jumpHostId: jump.id });
    const auth = createAuthFactory(liveGates, (server) => {
      const proxy = jump.proxy;
      const jumpRoute = proxy
        ? proxy.type === "ssh"
          ? `ssh:${proxy.jumpHostId}`
          : `${proxy.type}:${proxy.host.toLowerCase()}:${proxy.port}:${proxy.username ?? ""}`
        : "direct";
      return `${server.host.toLowerCase()}:${server.port}:${jumpRoute}`;
    });
    const stack = buildStack(auth, [jump, target], 20);
    const terminalLease = await stack.pool.connect(target);
    const profile = { ...(await sharedProfile("reverse")), remotePort: 8022 };
    const stale = stack.tunnelManager.start(profile, target, { connectionMode: "shared" }).then(
      () => undefined,
      (error: unknown) => error
    );
    let replacement: Promise<{ active: Awaited<ReturnType<typeof stack.tunnelManager.start>> } | { error: unknown }> | undefined;

    try {
      await vi.waitFor(() => expect(auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);
      await stack.tunnelManager.stopAll();
      forwardIn.resolve();
      expect(await stale).toBeInstanceOf(TunnelStoppedError);
      expect(auth.targets[0].dispose).not.toHaveBeenCalled();

      liveGates.forwardCancelRefusal = undefined;
      jump.proxy = { type: "socks5", host: "127.0.0.1", port: jumpProxyPort };
      replacement = stack.tunnelManager.start(profile, target, { connectionMode: "shared" }).then(
        (active) => ({ active }),
        (error: unknown) => ({ error })
      );
      await vi.waitFor(() => expect(auth.targets).toHaveLength(2), SETTLE);

      const result = await replacement;
      expect(result).toHaveProperty("active");
      expect(auth.targets[1].requestForwardIn).toHaveBeenCalledWith("127.0.0.1", 8022);
      expect(auth.callsFor(jump.id)).toEqual(["direct", "via-proxy"]);
      expect(jumpProxyRequests).toEqual([`${jump.host}:${jump.port}`]);
      expect(auth.targets[0].dispose).not.toHaveBeenCalled();
      if ("active" in result) {
        await stack.tunnelManager.stop(result.active.id);
      }
    } finally {
      await stack.tunnelManager.stopAll();
      forwardIn.resolve();
      terminalLease.dispose();
      await stale;
      await vi.waitFor(() => expect(auth.targets[0]?.dispose).toHaveBeenCalled(), SETTLE);
      if (replacement) {
        await replacement;
      }
    }
  });

  it("does not reconnect a replacement stopped behind a pending forward", async () => {
    const forwardIn = deferred();
    const nextLogin = deferred();
    const gates: { forwardIn?: Promise<void>; targetLogin?: Promise<void> } = { forwardIn: forwardIn.promise };
    const auth = createAuthFactory(gates);
    const server: ServerConfig = { ...direct, multiplexing: false };
    const stack = buildStack(auth, [server], 20);
    const profile: TunnelProfile = {
      ...isolatedProfile(12345),
      connectionMode: "shared",
      tunnelType: "reverse",
      remotePort: 8022
    };

    const stale = stack.tunnelManager.start(profile, server, { connectionMode: "shared" }).then(
      () => "resolved",
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);
    await stack.tunnelManager.stopAll();

    gates.targetLogin = nextLogin.promise;
    const stoppedReplacement = stack.tunnelManager.start(profile, server, { connectionMode: "shared" }).then(
      () => "resolved",
      (error: unknown) => error
    );
    await stack.tunnelManager.stopAll();
    forwardIn.resolve();

    expect(await stale).toBeInstanceOf(TunnelStoppedError);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsAfterBarrier = auth.calls.length;
    nextLogin.resolve();

    expect(await stoppedReplacement).toBeInstanceOf(TunnelStoppedError);
    expect(callsAfterBarrier).toBe(1);
  });

  it.each([
    { outcome: "refuses", gates: { forwardCancelRefusal: new Error("request failed") } },
    { outcome: "never answers", gates: { forwardCancel: new Promise<void>(() => {}) } }
  ])("holds a replacement until the retired transport's late-granted forward the server $outcome to withdraw is gone", async ({ outcome, gates }) => {
    // The bind is server-wide. Keep the terminal lease usable, but do not let a
    // replacement bind until that lease is released and the old transport closes.
    const forwardIn = deferred();
    const liveGates: Parameters<typeof createAuthFactory>[0] = { forwardIn: forwardIn.promise, ...gates };
    const auth = createAuthFactory(liveGates);
    const stack = buildStack(auth, [direct], 20);
    const terminalLease = await stack.pool.connect(direct);
    const profile = { ...(await sharedProfile("reverse")), remotePort: 8022 };

    const stale = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
      () => "resolved",
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);
    await stack.tunnelManager.stopAll();
    if (outcome === "never answers") {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        forwardIn.resolve();
        await vi.waitFor(() => expect(auth.targets[0].cancelForwardIn).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(60_000);
      } finally {
        vi.useRealTimers();
      }
    } else {
      forwardIn.resolve();
    }
    expect(await stale).toBeInstanceOf(TunnelStoppedError);
    // Only that one withdrawal fails: stop() still awaits its own cancel unbounded (#184).
    liveGates.forwardCancel = undefined;
    liveGates.forwardCancelRefusal = undefined;

    const restarted = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
      (active) => ({ active }),
      (error: unknown) => ({ error })
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(auth.targets).toHaveLength(1);
    expect(auth.targets[0].dispose).not.toHaveBeenCalled();
    await expect(terminalLease.exec("uptime")).resolves.toBeDefined();

    terminalLease.dispose();
    await vi.waitFor(() => expect(auth.targets[0].dispose).toHaveBeenCalledTimes(1), SETTLE);
    const result = await restarted;
    expect("active" in result).toBe(true);
    if (!("active" in result)) {
      throw result.error;
    }
    const active = result.active;
    cleanups.push(() => stack.tunnelManager.stop(active.id));
    expect(auth.targets).toHaveLength(2);
    expect(auth.targets[1].requestForwardIn).toHaveBeenCalledWith("127.0.0.1", 8022);
  });

  it("releases the retired-forward barrier when an unpooled transport closes before cancel rejection", async () => {
    const forwardIn = deferred();
    const forwardCancel = deferred();
    const liveGates: Parameters<typeof createAuthFactory>[0] = {
      forwardIn: forwardIn.promise,
      forwardCancel: forwardCancel.promise,
      forwardCancelRefusal: new Error("request failed")
    };
    const auth = createAuthFactory(liveGates);
    const requested: string[] = [];
    const proxyPort = await startSocks5Proxy(requested);
    const server: ServerConfig = {
      ...direct,
      multiplexing: false,
      proxy: { type: "socks5", host: "127.0.0.1", port: proxyPort }
    };
    const stack = buildStack(auth, [server], 20);
    const profile = { ...(await sharedProfile("reverse")), remotePort: 8022 };
    const stale = stack.tunnelManager.start(profile, server, { connectionMode: "shared" }).then(
      () => undefined,
      (error: unknown) => error
    );
    let replacement: Promise<unknown> | undefined;

    try {
      await vi.waitFor(() => expect(auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);
      await stack.tunnelManager.stopAll();
      forwardIn.resolve();
      await vi.waitFor(() => expect(auth.targets[0].cancelForwardIn).toHaveBeenCalled(), SETTLE);
      // The transport's one-shot close event fires while withdrawal is pending.
      auth.targets[0].drop();
      forwardCancel.resolve();

      expect(await stale).toBeInstanceOf(TunnelStoppedError);
      replacement = stack.tunnelManager.start(profile, server, { connectionMode: "shared" }).then(
        (active) => ({ active }),
        (error: unknown) => ({ error })
      );
      await vi.waitFor(() => expect(auth.targets).toHaveLength(2), SETTLE);
      const result = await replacement;
      expect(result).toHaveProperty("active");
      expect(auth.targets).toHaveLength(2);
      expect(auth.targets[1].requestForwardIn).toHaveBeenCalledWith("127.0.0.1", 8022);
      expect(requested).toEqual([`${TARGET_HOST}:${TARGET_PORT}`, `${TARGET_HOST}:${TARGET_PORT}`]);
    } finally {
      await stack.tunnelManager.stopAll();
      forwardIn.resolve();
      forwardCancel.resolve();
      await stale;
      if (replacement) {
        await replacement;
      }
    }
  });

  it("takes a replacement start's lease only after the stopped start's request is over, so a transport it retires is not reused", async () => {
    // The replacement used to lease the pooled transport first and wait second.
    // When the stopped start's withdrawal was then refused, retiring that
    // transport could not revoke the lease already taken on it, and the
    // replacement asked for its bind over the transport still holding it.
    const forwardIn = deferred();
    const liveGates: Parameters<typeof createAuthFactory>[0] = {
      forwardIn: forwardIn.promise,
      forwardCancelRefusal: new Error("request failed")
    };
    const auth = createAuthFactory(liveGates);
    const stack = buildStack(auth, [direct], 20);
    const profile = { ...(await sharedProfile("reverse")), remotePort: 8022 };

    const stale = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
      () => "resolved",
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);
    await stack.tunnelManager.stopAll();
    const replacement = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" });
    // Long enough for the replacement to lease a transport, if it does so before waiting.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    forwardIn.resolve();

    expect(await stale).toBeInstanceOf(TunnelStoppedError);
    const active = await replacement;
    liveGates.forwardCancelRefusal = undefined;
    cleanups.push(() => stack.tunnelManager.stop(active.id));
    expect(auth.targets).toHaveLength(2);
    expect(auth.targets[1].requestForwardIn).toHaveBeenCalledWith("127.0.0.1", 8022);
  });

  describe("a replacement waits for its stopped predecessor to finish, however long that takes within its own bounds", () => {
    // The stopped start's cleanup is bounded phase by phase — its request 5 s
    // after stop(), then its withdrawal 5 s — so the worst case ends 10 s after
    // stop() with the transport retired. A barrier with a timeout of its own
    // gave up in the middle of that and leased the stale transport.
    const REQUEST_BOUND = 5_000;
    const CANCEL_BOUND = 5_000;

    async function flush(): Promise<void> {
      await vi.advanceTimersByTimeAsync(0);
    }

    function stalePredecessor() {
      const forwardIn = deferred();
      const liveGates: Parameters<typeof createAuthFactory>[0] = {
        forwardIn: forwardIn.promise,
        forwardCancel: new Promise<void>(() => {})
      };
      const auth = createAuthFactory(liveGates);
      const stack = buildStack(auth, [direct], 20);
      return { forwardIn, liveGates, auth, stack };
    }

    /** Granted just before the post-stop bound; its withdrawal then never answers, so it ends by retiring at the cancel bound. */
    async function runPredecessorToItsWorstCase(run: ReturnType<typeof stalePredecessor>, whileItWithdraws: () => void): Promise<void> {
      await vi.advanceTimersByTimeAsync(REQUEST_BOUND - 100);
      run.forwardIn.resolve();
      await flush();
      await vi.advanceTimersByTimeAsync(CANCEL_BOUND - 200);
      whileItWithdraws();
      await vi.advanceTimersByTimeAsync(200);
      await flush();
    }

    it("does not lease until the predecessor has retired its transport, then gets a fresh one — within the request and cancel bounds", async () => {
      const run = stalePredecessor();
      const profile = { ...(await sharedProfile("reverse")), remotePort: 8022 };
      const stale = run.stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
        () => "resolved",
        (error: unknown) => error
      );
      await vi.waitFor(() => expect(run.auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let replacement: Promise<unknown> | undefined;
      try {
        await run.stack.tunnelManager.stopAll();
        replacement = run.stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
          (active) => active,
          (error: unknown) => error
        );
        await runPredecessorToItsWorstCase(run, () => {
          // Still withdrawing: nothing asked over its transport but its own request.
          expect(run.auth.targets[0].requestForwardIn).toHaveBeenCalledTimes(1);
          expect(run.auth.targets).toHaveLength(1);
        });
      } finally {
        vi.useRealTimers();
      }

      expect(await stale).toBeInstanceOf(TunnelStoppedError);
      run.liveGates.forwardCancel = undefined;
      const active = await replacement;
      expect(active).not.toBeInstanceOf(Error);
      cleanups.push(() => run.stack.tunnelManager.stop((active as { id: string }).id));
      expect(run.auth.targets).toHaveLength(2);
      expect(run.auth.targets[1].requestForwardIn).toHaveBeenCalledWith("127.0.0.1", 8022);
    });

    it("holds a third start behind the first when the second is stopped while it waits", async () => {
      const run = stalePredecessor();
      const profile = { ...(await sharedProfile("reverse")), remotePort: 8022 };
      const first = run.stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
        () => "resolved",
        (error: unknown) => error
      );
      await vi.waitFor(() => expect(run.auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let second: Promise<unknown> | undefined;
      let third: Promise<unknown> | undefined;
      try {
        await run.stack.tunnelManager.stopAll();
        second = run.stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
          () => "resolved",
          (error: unknown) => error
        );
        await flush();
        await run.stack.tunnelManager.stopAll();
        third = run.stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
          (active) => active,
          (error: unknown) => error
        );
        await runPredecessorToItsWorstCase(run, () => {
          expect(run.auth.targets[0].requestForwardIn).toHaveBeenCalledTimes(1);
        });
      } finally {
        vi.useRealTimers();
      }

      expect(await first).toBeInstanceOf(TunnelStoppedError);
      expect(await second).toBeInstanceOf(TunnelStoppedError);
      run.liveGates.forwardCancel = undefined;
      const active = await third;
      expect(active).not.toBeInstanceOf(Error);
      cleanups.push(() => run.stack.tunnelManager.stop((active as { id: string }).id));
      expect(run.auth.targets[0].requestForwardIn).toHaveBeenCalledTimes(1);
      expect(run.auth.targets.at(-1)!.requestForwardIn).toHaveBeenCalledWith("127.0.0.1", 8022);
    });
  });

  it("abandons a request that does not answer, then waits for its possible late bind to disappear", async () => {
    // ssh2's request has no timeout. A stopped start must release its lease,
    // but the server may still grant the request later while another lease
    // keeps the transport alive; a replacement cannot race that bind.
    const forwardIn = deferred();
    const liveGates: Parameters<typeof createAuthFactory>[0] = { forwardIn: forwardIn.promise };
    const auth = createAuthFactory(liveGates);
    const stack = buildStack(auth, [direct], 20);
    const terminalLease = await stack.pool.connect(direct);
    const profile = { ...(await sharedProfile("reverse")), remotePort: 8022 };

    const stale = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
      () => "resolved",
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await stack.tunnelManager.stopAll();
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
    const pending = new Promise<string>((resolve) => setImmediate(() => resolve("still pending")));
    expect(await Promise.race([stale, pending])).toBeInstanceOf(TunnelStoppedError);
    forwardIn.resolve();
    await vi.waitFor(() => expect(auth.isForwardBound(direct, "127.0.0.1", 8022)).toBe(true), SETTLE);

    const restarted = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
      (active) => ({ active }),
      (error: unknown) => ({ error })
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(auth.targets).toHaveLength(1);
    await expect(terminalLease.exec("uptime")).resolves.toBeDefined();
    terminalLease.dispose();
    await vi.waitFor(() => expect(auth.targets[0].dispose).toHaveBeenCalledTimes(1), SETTLE);
    const result = await restarted;
    expect("active" in result).toBe(true);
    if (!("active" in result)) {
      throw result.error;
    }
    cleanups.push(() => stack.tunnelManager.stop(result.active.id));
    expect(auth.targets).toHaveLength(2);
  });

  it("does not hold a start of the profile on one server behind its stopped request on another", async () => {
    // The two binds are on different servers and cannot collide; the second
    // start must not wait out the first one's bound.
    const forwardIn = deferred();
    const auth = createAuthFactory({ forwardIn: forwardIn.promise });
    const other: ServerConfig = { ...direct, id: "srv-direct-b", name: "Direct B", host: "other.example.test" };
    const stack = buildStack(auth, [direct, other], 20);
    const profile = { ...(await sharedProfile("reverse")), remotePort: 8022 };

    const stale = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
      () => "resolved",
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);
    await stack.tunnelManager.stopAll();
    const elsewhere = stack.tunnelManager.start(profile, other, { connectionMode: "shared" });

    await vi.waitFor(() => expect(auth.targets[1]?.requestForwardIn).toHaveBeenCalled(), { timeout: 1_000 });
    forwardIn.resolve();
    expect(await stale).toBeInstanceOf(TunnelStoppedError);
    const active = await elsewhere;
    cleanups.push(() => stack.tunnelManager.stop(active.id));
  });

  it("leaves the server's replacement transport alone when the refused withdrawal's own transport has already left the pool", async () => {
    // The server was edited while the forward was requested: its transport was
    // retired then, and a terminal has logged in on a new one since. Retiring
    // "the server's transport" now would retire that healthy replacement — and
    // tell everyone on it the server disconnected.
    const forwardIn = deferred();
    const liveGates: Parameters<typeof createAuthFactory>[0] = {
      forwardIn: forwardIn.promise,
      forwardCancelRefusal: new Error("request failed")
    };
    const auth = createAuthFactory(liveGates);
    const stack = buildStack(auth, [direct], 20);
    const events: PoolEvent[] = [];
    stack.pool.onDidChange((event) => events.push(event));
    const profile = { ...(await sharedProfile("reverse")), remotePort: 8022 };

    const stale = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
      () => "resolved",
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);
    stack.pool.invalidate(direct.id);
    const terminalLease = await stack.pool.connect(direct);
    cleanups.push(() => terminalLease.dispose());
    expect(auth.targets).toHaveLength(2);
    events.length = 0;
    await stack.tunnelManager.stopAll();
    forwardIn.resolve();
    expect(await stale).toBeInstanceOf(TunnelStoppedError);
    liveGates.forwardCancelRefusal = undefined;

    const again = await stack.pool.connect(direct);
    again.dispose();
    expect(auth.targets).toHaveLength(2);
    expect(auth.targets[1].dispose).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    // The stopped start's transport closed with its last lease.
    await vi.waitFor(() => expect(auth.targets[0].dispose).toHaveBeenCalledTimes(1), SETTLE);
  });

  it("gives up withdrawing a late-granted forward that the server never answers, and still releases the connection", async () => {
    const forwardIn = deferred();
    const auth = createAuthFactory({ forwardIn: forwardIn.promise, forwardCancel: new Promise<void>(() => {}) });
    const server: ServerConfig = { ...direct, multiplexing: false };
    const stack = buildStack(auth, [server]);
    const profile = await sharedProfile("reverse");

    const stale = stack.tunnelManager.start(profile, server, { connectionMode: "shared" }).then(
      () => "resolved",
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(auth.targets[0]?.requestForwardIn).toHaveBeenCalled(), SETTLE);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await stack.tunnelManager.stopAll();
      forwardIn.resolve();
      await vi.waitFor(() => expect(auth.targets[0].cancelForwardIn).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }

    const pending = new Promise<string>((resolve) => setImmediate(() => resolve("still pending")));
    expect(await Promise.race([stale, pending])).toBeInstanceOf(TunnelStoppedError);
    expect(auth.targets[0].dispose).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("releases the connection of a reverse start whose forward is refused (multiplexing %s)", async (multiplexing) => {
    // Not stopped, just failed: the start was already unregistered, so no
    // stop() would ever come for what it held.
    const refusal = new Error("remote port forwarding failed for listen port 8022");
    const auth = createAuthFactory({ forwardInRefusal: refusal });
    const server: ServerConfig = { ...direct, multiplexing };
    const stack = buildStack(auth, [server], 20);
    const profile = { ...(await sharedProfile("reverse")), remotePort: 8022 };

    await expect(stack.tunnelManager.start(profile, server, { connectionMode: "shared" })).rejects.toBe(refusal);

    await vi.waitFor(() => expect(auth.targets[0]?.dispose).toHaveBeenCalledTimes(1), SETTLE);
    expect(stack.tunnelManager.getActiveTunnelId(profile.id)).toBeUndefined();
  });

  it.each(["local", "dynamic", "reverse"] as const)(
    "a %s start stopped mid-login leaves the start that replaced it registered",
    async (tunnelType) => {
      // The stale start's cleanup runs after the tunnel was started again; it
      // must drop only its own profile mapping, or the running tunnel becomes
      // invisible to start() — which would then open a second one for it.
      const login = deferred();
      const auth = createAuthFactory({ targetLogin: login.promise });
      const stack = buildStack(auth, [direct], 20);
      const profile = await sharedProfile(tunnelType);

      const stale = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" }).then(
        () => "resolved",
        (error: unknown) => error
      );
      await vi.waitFor(() => expect(auth.calls).toHaveLength(1), SETTLE);
      await stack.tunnelManager.stopAll();
      const fresh = stack.tunnelManager.start(profile, direct, { connectionMode: "shared" });
      // The new start is registered (a local or SOCKS5 one once its listener
      // is up) and joins the same pooled login.
      await vi.waitFor(() => expect(stack.tunnelManager.getActiveTunnelId(profile.id)).toBeDefined(), SETTLE);
      login.resolve();

      expect(await stale).toBeInstanceOf(TunnelStoppedError);
      const active = await fresh;
      cleanups.push(() => stack.tunnelManager.stop(active.id));
      expect(stack.tunnelManager.getActiveTunnelId(profile.id)).toBe(active.id);
    }
  );

  it.each(bothTunnelTypes)(
    "releases the shared connection a $tunnelType client re-establishes while stop() sweeps the tunnel",
    async ({ tunnelType, open }) => {
      // The running tunnel's shared connection drops; the next client logs in
      // again, and the tunnel is stopped while that login is still in flight.
      const gates: { targetLogin?: Promise<void> } = {};
      const auth = createAuthFactory(gates);
      const stack = buildStack(auth, [direct], 20);
      const { localPort, stop } = await startTunnel(stack, direct, { connectionMode: "shared", tunnelType });
      auth.targets[0].drop();
      const relogin = deferred();
      gates.targetLogin = relogin.promise;
      const errors: string[] = [];
      stack.tunnelManager.onDidChange((event) => {
        if (event.type === "error") {
          errors.push(event.message);
        }
      });

      await open(localPort);
      await vi.waitFor(() => expect(auth.calls).toHaveLength(2), SETTLE);
      await stop();
      relogin.resolve();

      await vi.waitFor(() => expect(auth.targets[1]?.dispose).toHaveBeenCalled(), SETTLE);
      expect(auth.forwardedStreams).toEqual([]);
      expect(errors).toEqual([]);
    }
  );
});
