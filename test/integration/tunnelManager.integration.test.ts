import * as net from "node:net";
import { PassThrough, type Duplex } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig, TunnelProfile } from "../../src/models/config";
import type { SecretVault, SshConnection, SshFactory, TcpConnectionInfo } from "../../src/services/ssh/contracts";
import { ProxySshFactory } from "../../src/services/ssh/proxySshFactory";
import { SshConnectionPool } from "../../src/services/ssh/sshConnectionPool";
import type { SilentAuthSshFactory } from "../../src/services/ssh/silentAuth";
import { TunnelManager, type TunnelEvent } from "../../src/services/tunnel/tunnelManager";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate free port");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startEchoServer(port: number): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

async function exchangeMessage(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host: "127.0.0.1", port }, () => {
      client.write(payload);
    });
    client.once("data", (chunk) => {
      resolve(chunk.toString("utf8"));
      client.destroy();
    });
    client.once("error", reject);
  });
}

class DirectTcpSshConnection implements SshConnection {
  private readonly openSockets = new Set<net.Socket>();
  private readonly closeListeners = new Set<() => void>();
  private readonly tcpConnectionHandlers = new Set<(info: TcpConnectionInfo, accept: () => Duplex, reject: () => void) => void>();
  private readonly forwardedPorts = new Map<string, { bindAddr: string; bindPort: number }>();

  public async openShell(): Promise<PassThrough> {
    return new PassThrough();
  }

  public async openDirectTcp(remoteIP: string, remotePort: number): Promise<net.Socket> {
    const socket = net.createConnection({ host: remoteIP, port: remotePort });
    this.openSockets.add(socket);
    socket.on("close", () => this.openSockets.delete(socket));
    return socket;
  }

  public async openSftp(): Promise<any> {
    throw new Error("Not implemented");
  }

  public async exec(_command: string): Promise<Duplex> {
    throw new Error("Not implemented");
  }

  public async requestForwardIn(bindAddr: string, bindPort: number): Promise<number> {
    this.forwardedPorts.set(`${bindAddr}:${bindPort}`, { bindAddr, bindPort });
    return bindPort;
  }

  public async cancelForwardIn(bindAddr: string, bindPort: number): Promise<void> {
    this.forwardedPorts.delete(`${bindAddr}:${bindPort}`);
  }

  public onTcpConnection(handler: (info: TcpConnectionInfo, accept: () => Duplex, reject: () => void) => void): () => void {
    this.tcpConnectionHandlers.add(handler);
    return () => this.tcpConnectionHandlers.delete(handler);
  }

  /** Simulate an incoming TCP connection from the remote side */
  public simulateIncomingConnection(destPort: number): { localStream: PassThrough; remoteStream: PassThrough } | undefined {
    const local = new PassThrough();
    const remote = new PassThrough();
    let accepted = false;

    for (const handler of this.tcpConnectionHandlers) {
      handler(
        { destIP: "127.0.0.1", destPort, srcIP: "10.0.0.1", srcPort: 12345 },
        () => {
          accepted = true;
          return remote;
        },
        () => {}
      );
      if (accepted) {
        return { localStream: local, remoteStream: remote };
      }
    }
    return undefined;
  }

  public onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  public getBanner(): string | undefined {
    return undefined;
  }

  public dispose(): void {
    for (const socket of this.openSockets) {
      socket.destroy();
    }
    this.openSockets.clear();
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}

class AlreadyClosedSshConnection extends DirectTcpSshConnection {
  public override onClose(listener: () => void): () => void {
    listener();
    return () => {};
  }
}

class DirectTcpSshFactory implements SshFactory {
  public connectCount = 0;
  public lastConnection?: DirectTcpSshConnection;

  public async connect(_server: ServerConfig): Promise<SshConnection> {
    this.connectCount += 1;
    const conn = new DirectTcpSshConnection();
    this.lastConnection = conn;
    return conn;
  }
}

/**
 * A shared SSH connection whose `openDirectTcp` can be scripted to reject a
 * given number of times before behaving normally, and which counts its own
 * disposals. Used to prove that a per-channel refusal does not take the shared
 * connection down with it.
 */
class ScriptedSshConnection extends DirectTcpSshConnection {
  public disposeCount = 0;
  public readonly pendingFailures: unknown[] = [];

  public override async openDirectTcp(remoteIP: string, remotePort: number): Promise<net.Socket> {
    if (this.pendingFailures.length > 0) {
      throw this.pendingFailures.shift();
    }
    return super.openDirectTcp(remoteIP, remotePort);
  }

  public override dispose(): void {
    this.disposeCount += 1;
    super.dispose();
  }
}

class ScriptedSshFactory implements SshFactory {
  public connectCount = 0;
  public readonly connections: ScriptedSshConnection[] = [];

  public async connect(_server: ServerConfig): Promise<SshConnection> {
    this.connectCount += 1;
    const conn = new ScriptedSshConnection();
    this.connections.push(conn);
    return conn;
  }
}

class CloseReplaySshConnection extends DirectTcpSshConnection {
  public disposeCount = 0;
  private closed = false;
  private disposed = false;

  public remoteClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    super.dispose();
  }

  public override async openDirectTcp(): Promise<net.Socket> {
    return new net.Socket();
  }

  public override onClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => {};
    }
    return super.onClose(listener);
  }

  public override dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeCount += 1;
    this.closed = true;
    super.dispose();
  }
}

class HeldForwardConnection extends DirectTcpSshConnection {
  public readonly forwardRequested = deferred<void>();
  private readonly forwardResult = deferred<number>();

  public override requestForwardIn(_bindAddr: string, _bindPort: number): Promise<number> {
    this.forwardRequested.resolve(undefined);
    return this.forwardResult.promise;
  }

  public releaseForward(port: number): void {
    this.forwardResult.resolve(port);
  }
}

class ControlledForwardConnection extends DirectTcpSshConnection {
  public forwardAttempts = 0;
  public cancelAttempts = 0;
  public readonly forwardRequests: Array<{ bindAddr: string; bindPort: number }> = [];
  public readonly cancelRequests: Array<{ bindAddr: string; bindPort: number }> = [];
  public transportClosed = false;
  private readonly forwardSignals = new Map<number, ReturnType<typeof deferred<void>>>();
  private readonly cancelSignals = new Map<number, ReturnType<typeof deferred<void>>>();
  private readonly heldForwardAttempts = new Set<number>();
  private readonly heldCancelAttempts = new Set<number>();
  private readonly heldForwards = new Map<number, { resolve: (port: number) => void; reject: (error: Error) => void }>();
  private readonly heldCancels = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

  public holdForward(attempt: number): void {
    this.heldForwardAttempts.add(attempt);
  }

  public holdCancel(attempt: number): void {
    this.heldCancelAttempts.add(attempt);
  }

  public waitForForwardAttempt(attempt: number): Promise<void> {
    if (this.forwardAttempts >= attempt) {
      return Promise.resolve();
    }
    return this.signal(this.forwardSignals, attempt).promise;
  }

  public waitForCancelAttempt(attempt: number): Promise<void> {
    if (this.cancelAttempts >= attempt) {
      return Promise.resolve();
    }
    return this.signal(this.cancelSignals, attempt).promise;
  }

  public releaseForward(attempt: number, port: number): void {
    this.heldForwards.get(attempt)?.resolve(port);
  }

  public rejectForward(attempt: number, error: Error): void {
    this.heldForwards.get(attempt)?.reject(error);
  }

  public resolveCancel(attempt: number): void {
    this.heldCancels.get(attempt)?.resolve();
  }

  public rejectCancel(attempt: number, error: Error): void {
    this.heldCancels.get(attempt)?.reject(error);
  }

  public override requestForwardIn(bindAddr: string, bindPort: number): Promise<number> {
    const attempt = ++this.forwardAttempts;
    this.forwardRequests.push({ bindAddr, bindPort });
    this.signal(this.forwardSignals, attempt).resolve(undefined);
    if (!this.heldForwardAttempts.has(attempt)) {
      return Promise.resolve(bindPort);
    }
    return new Promise<number>((resolve, reject) => {
      this.heldForwards.set(attempt, {
        resolve: (port) => {
          this.heldForwards.delete(attempt);
          resolve(port);
        },
        reject: (error) => {
          this.heldForwards.delete(attempt);
          reject(error);
        }
      });
    });
  }

  public override cancelForwardIn(bindAddr: string, bindPort: number): Promise<void> {
    const attempt = ++this.cancelAttempts;
    this.cancelRequests.push({ bindAddr, bindPort });
    this.signal(this.cancelSignals, attempt).resolve(undefined);
    if (!this.heldCancelAttempts.has(attempt)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.heldCancels.set(attempt, {
        resolve: () => {
          this.heldCancels.delete(attempt);
          resolve();
        },
        reject: (error) => {
          this.heldCancels.delete(attempt);
          reject(error);
        }
      });
    });
  }

  public override dispose(): void {
    if (this.transportClosed) {
      return;
    }
    this.transportClosed = true;
    super.dispose();
  }

  private signal(
    signals: Map<number, ReturnType<typeof deferred<void>>>,
    attempt: number
  ): ReturnType<typeof deferred<void>> {
    let signal = signals.get(attempt);
    if (!signal) {
      signal = deferred<void>();
      signals.set(attempt, signal);
    }
    return signal;
  }
}

class ObservedForwardConnection extends DirectTcpSshConnection {
  public readonly forwardRequested = deferred<void>();
  public forwardAttempts = 0;

  public override requestForwardIn(bindAddr: string, bindPort: number): Promise<number> {
    this.forwardAttempts += 1;
    this.forwardRequested.resolve(undefined);
    return super.requestForwardIn(bindAddr, bindPort);
  }
}

class BindNamespaceConnection extends DirectTcpSshConnection {
  public readonly forwardRequested = deferred<void>();
  public forwardAttempts = 0;
  private finishHeldRequest?: (result: { port: number } | { error: Error }) => void;

  public constructor(
    private readonly remoteBinds: Map<string, BindNamespaceConnection>,
    private readonly holdRequest = false
  ) {
    super();
  }

  public override requestForwardIn(bindAddr: string, bindPort: number): Promise<number> {
    this.forwardAttempts += 1;
    this.forwardRequested.resolve(undefined);
    const key = `${bindAddr}:${bindPort}`;
    if (this.remoteBinds.has(key)) {
      return Promise.reject(new Error("Remote bind is already in use"));
    }
    this.remoteBinds.set(key, this);
    if (!this.holdRequest) {
      return Promise.resolve(bindPort);
    }
    return new Promise<number>((resolve, reject) => {
      this.finishHeldRequest = (result) => {
        this.finishHeldRequest = undefined;
        if ("error" in result) {
          if (this.remoteBinds.get(key) === this) {
            this.remoteBinds.delete(key);
          }
          reject(result.error);
          return;
        }
        resolve(result.port);
      };
    });
  }

  public refuseHeldRequest(error: Error): void {
    this.finishHeldRequest?.({ error });
  }

  public override async cancelForwardIn(bindAddr: string, bindPort: number): Promise<void> {
    const key = `${bindAddr}:${bindPort}`;
    if (this.remoteBinds.get(key) === this) {
      this.remoteBinds.delete(key);
    }
  }
}

class RefusedForwardConnection extends DirectTcpSshConnection {
  public override async requestForwardIn(_bindAddr: string, _bindPort: number): Promise<number> {
    throw new Error("Remote forwarding refused");
  }
}

class DelayedCloseSharedConnection extends DirectTcpSshConnection {
  public readonly firstOpenStarted = deferred<void>();
  public readonly secondStreamActive = deferred<void>();
  public readonly disposeRequested = deferred<void>();
  private readonly firstOpenResult: Promise<Duplex>;
  private rejectFirstOpen!: (error: Error) => void;
  private openCount = 0;
  private transportClosed = false;
  private readonly streams = new Set<PassThrough>();

  public constructor() {
    super();
    this.firstOpenResult = new Promise<Duplex>((_resolve, reject) => {
      this.rejectFirstOpen = reject;
    });
  }

  public override async openDirectTcp(_remoteIP: string, _remotePort: number): Promise<Duplex> {
    this.openCount += 1;
    if (this.openCount === 1) {
      this.firstOpenStarted.resolve(undefined);
      return this.firstOpenResult;
    }
    if (this.openCount === 2) {
      const stream = new PassThrough();
      stream.once("pipe", () => this.secondStreamActive.resolve(undefined));
      this.streams.add(stream);
      return stream;
    }
    throw new Error(`Unexpected direct TCP open ${this.openCount}`);
  }

  public failFirstOpen(error: Error): void {
    this.rejectFirstOpen(error);
  }

  public override dispose(): void {
    // Model a transport whose close event is delayed while another client is
    // still using a stream that was opened on it.
    this.disposeRequested.resolve(undefined);
  }

  public finishTransportClose(): void {
    if (this.transportClosed) {
      return;
    }
    this.transportClosed = true;
    for (const stream of this.streams) {
      stream.destroy();
    }
    this.streams.clear();
    super.dispose();
  }
}

class ActiveStreamConnection extends DirectTcpSshConnection {
  public readonly streamActive = deferred<void>();
  private readonly stream = new PassThrough();

  public constructor() {
    super();
    this.stream.once("pipe", () => this.streamActive.resolve(undefined));
  }

  public override async openDirectTcp(_remoteIP: string, _remotePort: number): Promise<Duplex> {
    return this.stream;
  }
}

class OrderedConnectionFactory implements SshFactory {
  public connectCount = 0;

  public constructor(private readonly connections: SshConnection[]) {}

  public async connect(_server: ServerConfig): Promise<SshConnection> {
    const connection = this.connections[this.connectCount];
    this.connectCount += 1;
    if (!connection) {
      throw new Error("Unexpected SSH connection request");
    }
    return connection;
  }
}

class DelayedReplacementFactory implements SshFactory {
  public readonly replacementLoginStarted = deferred<void>();
  public readonly finishReplacementLogin = deferred<void>();
  public readonly replacementForwardRequested = deferred<void>();
  public readonly replacementConnections: ObservedForwardConnection[];
  private firstReplacementLogin = true;

  public constructor(
    private readonly retiredServerId: string,
    private readonly replacementServerId: string,
    public readonly retiredConnection: HeldForwardConnection,
    public readonly replacementConnection: ObservedForwardConnection
  ) {
    this.replacementConnections = [replacementConnection];
    this.observeReplacementForward(replacementConnection);
  }

  public async connect(server: ServerConfig): Promise<SshConnection> {
    if (server.id === this.retiredServerId) {
      return this.retiredConnection;
    }
    if (server.id === this.replacementServerId) {
      if (this.firstReplacementLogin) {
        this.firstReplacementLogin = false;
        this.replacementLoginStarted.resolve(undefined);
        await this.finishReplacementLogin.promise;
        return this.replacementConnection;
      }
      const connection = new ObservedForwardConnection();
      this.replacementConnections.push(connection);
      this.observeReplacementForward(connection);
      return connection;
    }
    throw new Error(`Unexpected server ${server.id}`);
  }

  private observeReplacementForward(connection: ObservedForwardConnection): void {
    void connection.forwardRequested.promise.then(() => this.replacementForwardRequested.resolve(undefined));
  }
}

class TrackingConnectionPool extends SshConnectionPool {
  public readonly replacementLeaseDisposed = deferred<void>();

  public constructor(
    factory: SshFactory,
    options: { enabled: boolean; idleTimeoutMs: number },
    private readonly replacementServerId: string
  ) {
    super(factory, options);
  }

  public override async connect(server: ServerConfig): Promise<SshConnection> {
    const lease = await super.connect(server);
    if (server.id === this.replacementServerId) {
      const dispose = lease.dispose.bind(lease);
      lease.dispose = () => {
        dispose();
        this.replacementLeaseDisposed.resolve(undefined);
      };
    }
    return lease;
  }
}

/**
 * The error ssh2 produces for SSH_MSG_CHANNEL_OPEN_FAILURE: the server answered
 * our channel request — over a perfectly healthy transport — and refused it
 * because the requested destination is unreachable.
 * (`node_modules/ssh2/lib/utils.js:onChannelOpenFailure`, reason 2 =
 * CONNECT_FAILED.)
 */
function channelOpenFailure(): Error {
  const error = new Error("(SSH) Channel open failure: Connection refused");
  (error as Error & { reason: number }).reason = 2;
  return error;
}

/** What ssh2's `Client` throws when the transport itself is gone. */
function transportFailure(): Error {
  return new Error("Not connected");
}

/** Connect, send a probe, and resolve once the tunnel closes us without data. */
async function expectRefusedConnection(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const client = net.createConnection({ host: "127.0.0.1", port }, () => {
      client.write("probe");
    });
    client.once("data", () => {
      client.destroy();
      reject(new Error("Expected the tunnel to refuse the connection, but data came back"));
    });
    client.once("error", () => resolve());
    client.once("close", () => resolve());
  });
}

/** Read exactly `count` bytes. Only safe when no further bytes can be in flight. */
function readBytes(socket: net.Socket, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= count) {
        cleanup();
        resolve(buf.subarray(0, count));
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`Socket closed after ${buf.length} of ${count} bytes`));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/**
 * Drive a full SOCKS5 CONNECT against the proxy. Returns the reply code and,
 * when the request succeeded and a payload was given, whatever echoed back.
 */
async function socks5Request(
  proxyPort: number,
  destPort: number,
  payload?: string
): Promise<{ reply: number; echo?: string }> {
  const client = net.createConnection({ host: "127.0.0.1", port: proxyPort });
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("error", reject);
    });
    client.write(Buffer.from([0x05, 0x01, 0x00]));
    const greeting = await readBytes(client, 2);
    expect(greeting[0]).toBe(0x05);
    expect(greeting[1]).toBe(0x00);

    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(destPort, 0);
    client.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1]), portBuf]));
    const reply = await readBytes(client, 10);
    if (reply[1] !== 0x00 || payload === undefined) {
      return { reply: reply[1] };
    }

    client.write(payload);
    const echo = await readBytes(client, Buffer.byteLength(payload));
    return { reply: reply[1], echo: echo.toString("utf8") };
  } finally {
    client.destroy();
  }
}

async function waitForTraffic(events: TunnelEvent[], timeoutMs = 1000): Promise<TunnelEvent | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const trafficEvent = [...events].reverse().find((event) => {
      if (event.type !== "traffic") {
        return false;
      }
      return event.bytesIn > 0 && event.bytesOut > 0;
    });
    if (trafficEvent) {
      return trafficEvent;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

const testServer: ServerConfig = {
  id: "server-1",
  name: "Server",
  host: "127.0.0.1",
  port: 22,
  username: "dev",
  authType: "password",
  isHidden: false
};

describe("TunnelManager integration", () => {
  let manager: TunnelManager | undefined;
  let echoServer: net.Server | undefined;

  beforeEach(async () => {
    if (manager) {
      await manager.stopAll();
    }
    if (echoServer) {
      await new Promise<void>((resolve) => echoServer?.close(() => resolve()));
    }
  });

  it("forwards bytes and emits traffic updates (local)", async () => {
    const remotePort = await getFreePort();
    echoServer = await startEchoServer(remotePort);
    const localPort = await getFreePort();

    const profile: TunnelProfile = {
      id: "tunnel-1",
      name: "Echo Tunnel",
      localPort,
      remoteIP: "127.0.0.1",
      remotePort,
      autoStart: false
    };

    const sshFactory = new DirectTcpSshFactory();
    manager = new TunnelManager(sshFactory, sshFactory);
    const events: TunnelEvent[] = [];
    manager.onDidChange((event) => events.push(event));

    const activeTunnel = await manager.start(profile, testServer);
    const response = await exchangeMessage(localPort, "nexus");

    expect(response).toBe("nexus");
    expect(sshFactory.connectCount).toBeGreaterThan(0);
    const trafficEvent = await waitForTraffic(events);
    expect(trafficEvent).toBeDefined();
    if (trafficEvent && trafficEvent.type === "traffic") {
      expect(trafficEvent.bytesIn).toBeGreaterThan(0);
      expect(trafficEvent.bytesOut).toBeGreaterThan(0);
    }

    await manager.stop(activeTunnel.id);
    expect(events.some((event) => event.type === "stopped")).toBe(true);
  });

  it("reuses one SSH connection in shared mode (local)", async () => {
    const remotePort = await getFreePort();
    echoServer = await startEchoServer(remotePort);
    const localPort = await getFreePort();

    const profile: TunnelProfile = {
      id: "tunnel-shared",
      name: "Shared Tunnel",
      localPort,
      remoteIP: "127.0.0.1",
      remotePort,
      autoStart: false,
      connectionMode: "shared"
    };

    const sshFactory = new DirectTcpSshFactory();
    manager = new TunnelManager(sshFactory, sshFactory);
    const activeTunnel = await manager.start(profile, testServer, { connectionMode: "shared" });

    const first = await exchangeMessage(localPort, "alpha");
    const second = await exchangeMessage(localPort, "beta");

    expect(first).toBe("alpha");
    expect(second).toBe("beta");
    expect(sshFactory.connectCount).toBe(1);

    await manager.stop(activeTunnel.id);
  });

  it.each(["local", "dynamic"] as const)(
    "rejects a shared %s tunnel when its SSH connection is already closed",
    async (tunnelType) => {
      const profile: TunnelProfile = {
        id: `tunnel-shared-closed-${tunnelType}`,
        name: `Closed ${tunnelType} tunnel`,
        localPort: await getFreePort(),
        remoteIP: "127.0.0.1",
        remotePort: 22,
        autoStart: false,
        connectionMode: "shared",
        tunnelType
      };
      const closedConnection = new AlreadyClosedSshConnection();
      let connectCount = 0;
      const innerFactory: SshFactory = {
        connect: async () => {
          connectCount += 1;
          return closedConnection;
        }
      };
      const pool = new SshConnectionPool(innerFactory, { enabled: true, idleTimeoutMs: 60_000 });
      const server = { ...testServer, multiplexing: false };
      manager = new TunnelManager(pool, pool);
      const events: TunnelEvent[] = [];
      manager.onDidChange((event) => events.push(event));

      try {
        await expect(manager.start(profile, server, { connectionMode: "shared" })).rejects.toThrow();
        expect(connectCount).toBe(1);
        expect(events.some((event) => event.type === "started")).toBe(false);
        expect(events.some((event) => event.type === "error")).toBe(false);
      } finally {
        await manager.stopAll();
        pool.dispose();
        manager = undefined;
      }
    }
  );

  it("reports an unexpected close of the active shared SSH connection", async () => {
    const profile: TunnelProfile = {
      id: "tunnel-shared-close",
      name: "Shared Close Tunnel",
      localPort: await getFreePort(),
      remoteIP: "127.0.0.1",
      remotePort: 22,
      autoStart: false,
      connectionMode: "shared"
    };
    const sshFactory = new DirectTcpSshFactory();
    manager = new TunnelManager(sshFactory, sshFactory);
    const events: TunnelEvent[] = [];
    manager.onDidChange((event) => events.push(event));

    const activeTunnel = await manager.start(profile, testServer, { connectionMode: "shared" });
    sshFactory.lastConnection?.dispose();

    expect(events.filter((event) => event.type === "error").map((event) => event.message)).toContain(
      `Shared SSH connection closed for tunnel ${profile.name}`
    );
    await manager.stop(activeTunnel.id);
  });

  it("reports a superseded shared transport closing while another client still uses it", async () => {
    const profile: TunnelProfile = {
      id: "tunnel-shared-reconnect",
      name: "Shared Reconnect Tunnel",
      localPort: await getFreePort(),
      remoteIP: "127.0.0.1",
      remotePort: 22,
      autoStart: false,
      connectionMode: "shared"
    };
    const supersededConnection = new DelayedCloseSharedConnection();
    const currentConnection = new ActiveStreamConnection();
    const sshFactory = new OrderedConnectionFactory([supersededConnection, currentConnection]);
    const pool = new SshConnectionPool(sshFactory, { enabled: true, idleTimeoutMs: 60_000 });
    const server = { ...testServer, multiplexing: false };
    manager = new TunnelManager(pool, pool);
    const events: TunnelEvent[] = [];
    manager.onDidChange((event) => events.push(event));
    const activeTunnel = await manager.start(profile, server, { connectionMode: "shared" });
    const connectClient = async (): Promise<net.Socket> => {
      const socket = net.createConnection({ host: "127.0.0.1", port: profile.localPort });
      socket.on("error", () => {});
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      return socket;
    };
    const firstClient = await connectClient();
    await supersededConnection.firstOpenStarted.promise;
    const secondClient = await connectClient();
    await supersededConnection.secondStreamActive.promise;

    const transportError = transportFailure();
    supersededConnection.failFirstOpen(transportError);
    try {
      await supersededConnection.disposeRequested.promise;
      expect(events.some((event) =>
        event.type === "error"
        && event.message === `Tunnel ${profile.name} failed to proxy connection`
        && event.error === transportError
      )).toBe(true);

      // The second client is still using the not-yet-closed first transport;
      // the next client reconnects through a new shared connection meanwhile.
      const thirdClient = await connectClient();
      try {
        await currentConnection.streamActive.promise;
        expect(sshFactory.connectCount).toBe(2);

        supersededConnection.finishTransportClose();

        expect(events.filter((event) => event.type === "error").map((event) => event.message)).toContain(
          `Shared SSH connection closed for tunnel ${profile.name}`
        );
      } finally {
        thirdClient.destroy();
      }
    } finally {
      firstClient.destroy();
      secondClient.destroy();
      supersededConnection.finishTransportClose();
      await manager.stop(activeTunnel.id);
      pool.dispose();
    }
  });

  it("starts and stops a reverse tunnel", async () => {
    const localPort = await getFreePort();
    echoServer = await startEchoServer(localPort);

    const profile: TunnelProfile = {
      id: "tunnel-reverse",
      name: "Reverse Tunnel",
      localPort,
      remoteIP: "127.0.0.1",
      remotePort: 8080,
      autoStart: false,
      tunnelType: "reverse",
      remoteBindAddress: "127.0.0.1",
      localTargetIP: "127.0.0.1"
    };

    const sshFactory = new DirectTcpSshFactory();
    manager = new TunnelManager(sshFactory, sshFactory);
    const events: TunnelEvent[] = [];
    manager.onDidChange((event) => events.push(event));

    const activeTunnel = await manager.start(profile, testServer);
    expect(activeTunnel.tunnelType).toBe("reverse");
    expect(activeTunnel.connectionMode).toBe("shared");
    expect(events.some((e) => e.type === "started")).toBe(true);

    await manager.stop(activeTunnel.id);
    expect(events.some((e) => e.type === "stopped")).toBe(true);
  });

  it.each([
    ["different port", "port"],
    ["different route", "route"]
  ] as const)("does not serialize an uncertain reverse request with a different %s", async (_label, difference) => {
    const firstConnection = new ControlledForwardConnection();
    firstConnection.holdForward(1);
    const secondConnection = new ControlledForwardConnection();
    const factory = new OrderedConnectionFactory([firstConnection, secondConnection]);
    const pool = new SshConnectionPool(factory, { enabled: true, idleTimeoutMs: 60_000 });
    manager = new TunnelManager(pool, pool);
    const firstServer = { ...testServer, id: "server-first-route" };
    const secondServer = difference === "route"
      ? { ...testServer, id: "server-second-route", host: "other.example.test" }
      : firstServer;
    const profile = (id: string, remotePort: number): TunnelProfile => ({
      id,
      name: id,
      localPort: 12345,
      remoteIP: "127.0.0.1",
      remotePort,
      autoStart: false,
      tunnelType: "reverse",
      remoteBindAddress: "0.0.0.0",
      localTargetIP: "127.0.0.1"
    });
    const firstStart = manager.start(profile("reverse-first-scope", 23456), firstServer);
    const secondStart = manager.start(
      profile("reverse-second-scope", difference === "port" ? 23457 : 23456),
      secondServer
    );

    try {
      await firstConnection.waitForForwardAttempt(1);
      const secondRequestObserved = await Promise.race([
        (difference === "port"
          ? firstConnection.waitForForwardAttempt(2)
          : secondConnection.waitForForwardAttempt(1)
        ).then(() => true),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))
      ]);
      expect(secondRequestObserved).toBe(true);
      expect(factory.connectCount).toBe(difference === "route" ? 2 : 1);

      firstConnection.releaseForward(1, 23456);
      await expect(Promise.all([firstStart, secondStart])).resolves.toHaveLength(2);
    } finally {
      firstConnection.releaseForward(1, 23456);
      await manager.stopAll();
      await Promise.allSettled([firstStart, secondStart]);
      pool.dispose();
      manager = undefined;
    }
  });

  it.each([
    ["SOCKS5", "socks5", 1080],
    ["HTTP CONNECT", "http", 3128]
  ] as const)("serializes reverse binds across proxy usernames for the same %s endpoint", async (_label, proxyType, proxyPort) => {
    const server = (id: string, username: string): ServerConfig => ({
      ...testServer,
      id,
      multiplexing: false,
      proxy: proxyType === "socks5"
        ? { type: "socks5", host: "proxy.example", port: proxyPort, username }
        : { type: "http", host: "proxy.example", port: proxyPort, username }
    });
    const aliceServer = server("server-alice", "alice");
    const bobServer = server("server-bob", "bob");
    const remoteBinds = new Map<string, BindNamespaceConnection>();
    const aliceConnection = new BindNamespaceConnection(remoteBinds, true);
    const bobConnection = new BindNamespaceConnection(remoteBinds);
    const sshFactory: SshFactory = {
      connect: async (config) => {
        if (config.id === aliceServer.id) {
          return aliceConnection;
        }
        if (config.id === bobServer.id) {
          return bobConnection;
        }
        throw new Error(`Unexpected server ${config.id}`);
      }
    };
    const pool = new SshConnectionPool(sshFactory, { enabled: true, idleTimeoutMs: 60_000 });
    manager = new TunnelManager(pool, pool);
    const profile = (id: string): TunnelProfile => ({
      id,
      name: id,
      localPort: 12345,
      remoteIP: "127.0.0.1",
      remotePort: 23456,
      autoStart: false,
      tunnelType: "reverse",
      remoteBindAddress: "127.0.0.1",
      localTargetIP: "127.0.0.1"
    });
    const aliceProfile = profile("reverse-alice");
    const bobProfile = profile("reverse-bob");
    const aliceStart = manager.start(aliceProfile, aliceServer);
    const bobStart = manager.start(bobProfile, bobServer);
    const aliceSettled = aliceStart.then(() => undefined, () => undefined);
    const bobSettled = bobStart.then(() => undefined, () => undefined);
    const refusal = new Error("Predecessor reverse request refused");
    const bindKey = "127.0.0.1:23456";

    try {
      await aliceConnection.forwardRequested.promise;
      expect(remoteBinds.get(bindKey)).toBe(aliceConnection);

      const bobAttemptedBeforeAliceSettled = await Promise.race([
        bobConnection.forwardRequested.promise.then(() => true),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))
      ]);
      expect(bobAttemptedBeforeAliceSettled).toBe(false);
      expect(bobConnection.forwardAttempts).toBe(0);

      aliceConnection.refuseHeldRequest(refusal);
      await expect(aliceStart).rejects.toBe(refusal);
      const bobTunnel = await bobStart;
      expect(bobTunnel.profileId).toBe(bobProfile.id);
      expect(bobConnection.forwardAttempts).toBe(1);
      expect(remoteBinds.get(bindKey)).toBe(bobConnection);

      await manager.stop(bobTunnel.id);
      expect(remoteBinds.has(bindKey)).toBe(false);
    } finally {
      aliceConnection.refuseHeldRequest(refusal);
      await Promise.all([aliceSettled, bobSettled]);
      await manager.stopAll();
      pool.dispose();
    }
  });

  it("waits for a retired bind across proxy usernames when a reverse start finishes logging in", async () => {
    const proxy = (username: string) => ({ type: "socks5" as const, host: "proxy.example", port: 1080, username });
    const retiredServer = { ...testServer, id: "server-retired", proxy: proxy("alice") };
    const replacementServer = {
      ...testServer,
      id: "server-replacement",
      multiplexing: false,
      proxy: proxy("bob")
    };
    const retiredConnection = new HeldForwardConnection();
    const replacementConnection = new ObservedForwardConnection();
    const factory = new DelayedReplacementFactory(
      retiredServer.id,
      replacementServer.id,
      retiredConnection,
      replacementConnection
    );
    const pool = new TrackingConnectionPool(factory, { enabled: true, idleTimeoutMs: 60_000 }, replacementServer.id);
    manager = new TunnelManager(pool, pool);
    const events: TunnelEvent[] = [];
    manager.onDidChange((event) => events.push(event));
    const terminalLease = await pool.connect(retiredServer);

    const profile = (id: string): TunnelProfile => ({
      id,
      name: id,
      localPort: 12345,
      remoteIP: "127.0.0.1",
      remotePort: 23456,
      autoStart: false,
      tunnelType: "reverse",
      remoteBindAddress: "127.0.0.1",
      localTargetIP: "127.0.0.1"
    });
    const retiredProfile = profile("reverse-retired");
    const replacementProfile = profile("reverse-replacement");
    const retiredStart = manager.start(retiredProfile, retiredServer);
    const retiredResult = retiredStart.then(
      () => "started",
      (error: unknown) => error
    );
    const replacementStart = manager.start(replacementProfile, replacementServer);
    const replacementResult = replacementStart.then(
      () => "started",
      (error: unknown) => error
    );

    try {
      // The second route is authenticating before the first route is stopped.
      await Promise.all([factory.replacementLoginStarted.promise, retiredConnection.forwardRequested.promise]);
      const retiredTunnelId = manager.getActiveTunnelId(retiredProfile.id);
      expect(retiredTunnelId).toBeDefined();
      await manager.stop(retiredTunnelId!);
      const retiredOutcome = await retiredResult;
      expect(retiredOutcome).toBeInstanceOf(Error);
      expect((retiredOutcome as Error).name).toBe("TunnelStoppedError");

      factory.finishReplacementLogin.resolve(undefined);
      const beforeRetiredTransportCloses = await Promise.race([
        pool.replacementLeaseDisposed.promise.then(() => "candidate-disposed"),
        replacementConnection.forwardRequested.promise.then(() => "forward-requested")
      ]);
      expect(beforeRetiredTransportCloses).toBe("candidate-disposed");
      expect(replacementConnection.forwardAttempts).toBe(0);
      expect(events.filter((event) => event.type === "error").map((event) => event.message)).not.toContain(
        `Shared SSH connection closed for tunnel ${replacementProfile.name}`
      );

      // The retired-bind barrier itself is stop-aware: a start that reaches
      // the pre-login `retiredAfterLogin` wait must not need the old terminal
      // lease to close before its caller can stop it.
      const preLoginWaitProfile = profile("reverse-retired-stop");
      const preLoginWaitStart = manager.start(preLoginWaitProfile, replacementServer);
      const preLoginWaitResult = preLoginWaitStart.then(
        () => "started",
        (error: unknown) => error
      );
      const preLoginWaitId = manager.getActiveTunnelId(preLoginWaitProfile.id);
      expect(preLoginWaitId).toBeDefined();
      await manager.stop(preLoginWaitId!);
      const preLoginWaitSettled = await Promise.race([
        preLoginWaitResult.then(() => true),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))
      ]);
      expect(preLoginWaitSettled).toBe(true);
      expect(await preLoginWaitResult).toBeInstanceOf(Error);
      expect((await preLoginWaitResult as Error).name).toBe("TunnelStoppedError");

      // The pooled connection remains open for the terminal lease, so the
      // replacement must wait until that lease releases the retired bind.
      terminalLease.dispose();
      await factory.replacementForwardRequested.promise;
      await expect(replacementResult).resolves.toBe("started");
      expect(factory.replacementConnections[1]?.forwardAttempts).toBe(1);

      const replacementTunnelId = manager.getActiveTunnelId(replacementProfile.id);
      expect(replacementTunnelId).toBeDefined();
      await manager.stop(replacementTunnelId!);
    } finally {
      factory.finishReplacementLogin.resolve(undefined);
      retiredConnection.releaseForward(23456);
      terminalLease.dispose();
      await manager.stopAll();
      await Promise.all([retiredResult, replacementResult]);
      pool.dispose();
    }
  });

  it.each(["late success", "late rejection", "no answer"] as const)(
    "releases a retired reverse bind after %s only when the transport closes or withdrawal succeeds",
    async (cancelOutcome) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const retiredConnection = new ControlledForwardConnection();
      retiredConnection.holdForward(1);
      retiredConnection.holdCancel(1);
      const replacementConnection = new ControlledForwardConnection();
      const factory = new OrderedConnectionFactory([retiredConnection, replacementConnection]);
      const pool = new SshConnectionPool(factory, { enabled: true, idleTimeoutMs: 60_000 });
      const server = { ...testServer };
      manager = new TunnelManager(pool, pool);
      const profile = (id: string, remoteBindAddress = "127.0.0.1"): TunnelProfile => ({
        id,
        name: id,
        localPort: 12345,
        remoteIP: "127.0.0.1",
        remotePort: 23456,
        autoStart: false,
        tunnelType: "reverse",
        remoteBindAddress,
        localTargetIP: "127.0.0.1"
      });
      let terminalLease: SshConnection | undefined;
      let retiredResult: Promise<unknown> | undefined;
      let replacementResult: Promise<unknown> | undefined;

      try {
        terminalLease = await pool.connect(server);
        const retiredProfile = profile(`reverse-retired-${cancelOutcome.replaceAll(" ", "-")}`, "0.0.0.0");
        const retiredStart = manager.start(retiredProfile, server);
        retiredResult = retiredStart.then(() => "started", (error: unknown) => error);
        await retiredConnection.waitForForwardAttempt(1);

        const retiredTunnelId = manager.getActiveTunnelId(retiredProfile.id);
        expect(retiredTunnelId).toBeDefined();
        await manager.stop(retiredTunnelId!);
        retiredConnection.releaseForward(1, 23456);
        await retiredConnection.waitForCancelAttempt(1);
        expect(retiredConnection.cancelRequests).toEqual([{ bindAddr: "0.0.0.0", bindPort: 23456 }]);
        await vi.advanceTimersByTimeAsync(5_000);

        const retiredOutcome = await retiredResult;
        expect(retiredOutcome).toBeInstanceOf(Error);
        expect((retiredOutcome as Error).name).toBe("TunnelStoppedError");

        const replacementProfile = profile(`reverse-replacement-${cancelOutcome.replaceAll(" ", "-")}`);
        const replacementStart = manager.start(replacementProfile, server);
        replacementResult = replacementStart.then(() => "started", (error: unknown) => error);
        const forwardedBeforeResolution = await Promise.race([
          replacementConnection.waitForForwardAttempt(1).then(() => true),
          new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))
        ]);
        expect(forwardedBeforeResolution).toBe(false);
        expect(replacementConnection.forwardAttempts).toBe(0);
        expect(factory.connectCount).toBe(1);

        if (cancelOutcome === "late success") {
          retiredConnection.resolveCancel(1);
          const forwardedBeforeTransportClose = await Promise.race([
            replacementConnection.waitForForwardAttempt(1).then(() => true),
            new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))
          ]);
          expect(forwardedBeforeTransportClose).toBe(true);
          expect(retiredConnection.transportClosed).toBe(false);
          expect(factory.connectCount).toBe(2);
        } else {
          if (cancelOutcome === "late rejection") {
            retiredConnection.rejectCancel(1, new Error("Withdrawal refused"));
          }
          const stillWaiting = await Promise.race([
            replacementConnection.waitForForwardAttempt(1).then(() => true),
            new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))
          ]);
          expect(stillWaiting).toBe(false);

          terminalLease.dispose();
          terminalLease = undefined;
          await replacementConnection.waitForForwardAttempt(1);
          expect(retiredConnection.transportClosed).toBe(true);
        }

        await expect(replacementResult).resolves.toBe("started");
        expect(replacementConnection.forwardAttempts).toBe(1);
        const replacementTunnelId = manager.getActiveTunnelId(replacementProfile.id);
        expect(replacementTunnelId).toBeDefined();
        await manager.stop(replacementTunnelId!);
      } finally {
        await manager.stopAll();
        retiredConnection.releaseForward(1, 23456);
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (retiredConnection.cancelAttempts > 0) {
          retiredConnection.resolveCancel(1);
        }
        await vi.advanceTimersByTimeAsync(5_000);
        terminalLease?.dispose();
        pool.dispose();
        await Promise.allSettled(
          [retiredResult, replacementResult].filter((result): result is Promise<unknown> => Boolean(result))
        );
        manager = undefined;
        vi.useRealTimers();
      }
    }
  );

  it.each([
    ["0.0.0.0", "127.0.0.1"],
    ["::", "::1"],
    ["localhost", "127.0.0.1"]
  ] as const)("releases an abandoned reverse bind across overlapping addresses (%s → %s)", async (retiredAddr, replacementAddr) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const retiredConnection = new ControlledForwardConnection();
    retiredConnection.holdForward(1);
    const replacementConnection = new ControlledForwardConnection();
    const factory = new OrderedConnectionFactory([retiredConnection, replacementConnection]);
    const pool = new SshConnectionPool(factory, { enabled: true, idleTimeoutMs: 60_000 });
    const server = { ...testServer };
    manager = new TunnelManager(pool, pool);
    const profile = (id: string, remoteBindAddress: string): TunnelProfile => ({
      id,
      name: id,
      localPort: 12345,
      remoteIP: "127.0.0.1",
      remotePort: 23456,
      autoStart: false,
      tunnelType: "reverse",
      remoteBindAddress,
      localTargetIP: "127.0.0.1"
    });
    let terminalLease: SshConnection | undefined;
    let retiredResult: Promise<unknown> | undefined;
    let replacementResult: Promise<unknown> | undefined;

    try {
      terminalLease = await pool.connect(server);
      const retiredProfile = profile("reverse-abandoned-refusal", retiredAddr);
      const retiredStart = manager.start(retiredProfile, server);
      retiredResult = retiredStart.then(() => "started", (error: unknown) => error);
      await retiredConnection.waitForForwardAttempt(1);

      const retiredTunnelId = manager.getActiveTunnelId(retiredProfile.id);
      expect(retiredTunnelId).toBeDefined();
      await manager.stop(retiredTunnelId!);
      await vi.advanceTimersByTimeAsync(5_000);
      const retiredOutcome = await retiredResult;
      expect(retiredOutcome).toBeInstanceOf(Error);
      expect((retiredOutcome as Error).name).toBe("TunnelStoppedError");

      const replacementProfile = profile("reverse-after-late-refusal", replacementAddr);
      const replacementStart = manager.start(replacementProfile, server);
      replacementResult = replacementStart.then(() => "started", (error: unknown) => error);
      const initiallyWaiting = await Promise.race([
        replacementConnection.waitForForwardAttempt(1).then(() => false),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(true)))
      ]);
      expect(initiallyWaiting).toBe(true);
      expect(replacementConnection.forwardAttempts).toBe(0);
      expect(factory.connectCount).toBe(1);

      retiredConnection.rejectForward(1, new Error("Remote forwarding refused"));
      const proceededAfterRefusal = await Promise.race([
        replacementConnection.waitForForwardAttempt(1).then(() => true),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))
      ]);
      expect(proceededAfterRefusal).toBe(true);
      expect(retiredConnection.transportClosed).toBe(false);
      expect(factory.connectCount).toBe(2);
      expect(replacementConnection.forwardRequests).toEqual([{ bindAddr: replacementAddr, bindPort: 23456 }]);
      await expect(replacementResult).resolves.toBe("started");

      const replacementTunnelId = manager.getActiveTunnelId(replacementProfile.id);
      expect(replacementTunnelId).toBeDefined();
      await manager.stop(replacementTunnelId!);
    } finally {
      await manager.stopAll();
      retiredConnection.rejectForward(1, new Error("Cleanup"));
      terminalLease?.dispose();
      pool.dispose();
      await Promise.allSettled(
        [retiredResult, replacementResult].filter((result): result is Promise<unknown> => Boolean(result))
      );
      manager = undefined;
      vi.useRealTimers();
    }
  });

  it("does not let an old close clear a newer same-bind retirement", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const retiredConnection = new ControlledForwardConnection();
    retiredConnection.holdForward(1);
    retiredConnection.holdCancel(1);
    const replacementConnection = new ControlledForwardConnection();
    replacementConnection.holdForward(2);
    replacementConnection.holdCancel(2);
    const finalConnection = new ControlledForwardConnection();
    const factory = new OrderedConnectionFactory([retiredConnection, replacementConnection, finalConnection]);
    const pool = new SshConnectionPool(factory, { enabled: true, idleTimeoutMs: 60_000 });
    const server = { ...testServer };
    manager = new TunnelManager(pool, pool);
    const profile = (id: string): TunnelProfile => ({
      id,
      name: id,
      localPort: 12345,
      remoteIP: "127.0.0.1",
      remotePort: 23456,
      autoStart: false,
      tunnelType: "reverse",
      remoteBindAddress: "127.0.0.1",
      localTargetIP: "127.0.0.1"
    });
    let oldTerminalLease: SshConnection | undefined;
    let newTerminalLease: SshConnection | undefined;
    const outcomes: Promise<unknown>[] = [];

    try {
      oldTerminalLease = await pool.connect(server);
      const firstStart = manager.start(profile("reverse-first-retirement"), server);
      const firstResult = firstStart.then(() => "started", (error: unknown) => error);
      outcomes.push(firstResult);
      await retiredConnection.waitForForwardAttempt(1);
      const firstTunnelId = manager.getActiveTunnelId("reverse-first-retirement");
      expect(firstTunnelId).toBeDefined();
      await manager.stop(firstTunnelId!);
      retiredConnection.releaseForward(1, 23456);
      await retiredConnection.waitForCancelAttempt(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await firstResult).toBeInstanceOf(Error);
      retiredConnection.resolveCancel(1);

      const replacementProfile = profile("reverse-first-replacement");
      const replacementStart = manager.start(replacementProfile, server);
      const replacementResult = replacementStart.then(() => "started", (error: unknown) => error);
      outcomes.push(replacementResult);
      await replacementConnection.waitForForwardAttempt(1);
      await expect(replacementResult).resolves.toBe("started");
      newTerminalLease = await pool.connect(server);
      const replacementTunnelId = manager.getActiveTunnelId(replacementProfile.id);
      expect(replacementTunnelId).toBeDefined();
      await manager.stop(replacementTunnelId!);

      const secondStart = manager.start(profile("reverse-second-retirement"), server);
      const secondResult = secondStart.then(() => "started", (error: unknown) => error);
      outcomes.push(secondResult);
      await replacementConnection.waitForForwardAttempt(2);
      const secondTunnelId = manager.getActiveTunnelId("reverse-second-retirement");
      expect(secondTunnelId).toBeDefined();
      await manager.stop(secondTunnelId!);
      replacementConnection.releaseForward(2, 23456);
      await replacementConnection.waitForCancelAttempt(2);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await secondResult).toBeInstanceOf(Error);

      // The first bind barrier already released on cancellation success, but
      // its old transport closes only after this terminal lease is released.
      oldTerminalLease.dispose();
      oldTerminalLease = undefined;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(retiredConnection.transportClosed).toBe(true);

      const finalStart = manager.start(profile("reverse-final-replacement"), server);
      const finalResult = finalStart.then(() => "started", (error: unknown) => error);
      outcomes.push(finalResult);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finalConnection.forwardAttempts).toBe(0);
      expect(factory.connectCount).toBe(2);

      newTerminalLease.dispose();
      newTerminalLease = undefined;
      await finalConnection.waitForForwardAttempt(1);
      await expect(finalResult).resolves.toBe("started");
      expect(finalConnection.forwardAttempts).toBe(1);
      const finalTunnelId = manager.getActiveTunnelId("reverse-final-replacement");
      expect(finalTunnelId).toBeDefined();
      await manager.stop(finalTunnelId!);
    } finally {
      await manager.stopAll();
      retiredConnection.releaseForward(1, 23456);
      replacementConnection.releaseForward(2, 23456);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (retiredConnection.cancelAttempts > 0) {
        retiredConnection.resolveCancel(1);
      }
      if (replacementConnection.cancelAttempts > 0) {
        replacementConnection.resolveCancel(2);
      }
      await vi.advanceTimersByTimeAsync(5_000);
      oldTerminalLease?.dispose();
      newTerminalLease?.dispose();
      pool.dispose();
      await Promise.allSettled(outcomes);
      manager = undefined;
      vi.useRealTimers();
    }
  });

  it("settles a stopped reverse start waiting for a competing forward request", async () => {
    const predecessorServer = { ...testServer, id: "server-forward-predecessor", multiplexing: false };
    const waitingServer = { ...testServer, id: "server-forward-waiter", multiplexing: false };
    const predecessorConnection = new HeldForwardConnection();
    const waitingConnection = new ObservedForwardConnection();
    const factory = new DelayedReplacementFactory(
      predecessorServer.id,
      waitingServer.id,
      predecessorConnection,
      waitingConnection
    );
    const pool = new TrackingConnectionPool(factory, { enabled: true, idleTimeoutMs: 60_000 }, waitingServer.id);
    manager = new TunnelManager(pool, pool);
    const profile = (id: string): TunnelProfile => ({
      id,
      name: id,
      localPort: 12345,
      remoteIP: "127.0.0.1",
      remotePort: 23456,
      autoStart: false,
      tunnelType: "reverse",
      remoteBindAddress: "127.0.0.1",
      localTargetIP: "127.0.0.1"
    });
    const predecessorProfile = profile("reverse-forward-predecessor");
    const waitingProfile = profile("reverse-forward-waiter");
    const waitingStart = manager.start(waitingProfile, waitingServer);
    const waitingResult = waitingStart.then(
      () => "started",
      (error: unknown) => error
    );
    let predecessorResult: Promise<"started" | unknown> | undefined;

    try {
      await factory.replacementLoginStarted.promise;
      const predecessorStart = manager.start(predecessorProfile, predecessorServer);
      predecessorResult = predecessorStart.then(
        () => "started",
        (error: unknown) => error
      );
      await predecessorConnection.forwardRequested.promise;

      factory.finishReplacementLogin.resolve(undefined);
      await pool.replacementLeaseDisposed.promise;

      const waitingId = manager.getActiveTunnelId(waitingProfile.id);
      expect(waitingId).toBeDefined();
      await manager.stop(waitingId!);
      const waitingSettled = await Promise.race([
        waitingResult.then(() => true),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))
      ]);
      expect(waitingSettled).toBe(true);
      expect(await waitingResult).toBeInstanceOf(Error);
      expect((await waitingResult as Error).name).toBe("TunnelStoppedError");

      predecessorConnection.releaseForward(23456);
      expect(await predecessorResult).toBe("started");
      const predecessorId = manager.getActiveTunnelId(predecessorProfile.id);
      expect(predecessorId).toBeDefined();
      await manager.stop(predecessorId!);
    } finally {
      factory.finishReplacementLogin.resolve(undefined);
      predecessorConnection.releaseForward(23456);
      await manager.stopAll();
      await Promise.all([waitingResult, ...(predecessorResult ? [predecessorResult] : [])]);
      pool.dispose();
    }
  });

  it("releases the bastion lease when a non-multiplexed reverse target receives a replayed close", async () => {
    const bastionConnection = new CloseReplaySshConnection();
    const targetConnection = new CloseReplaySshConnection();
    const jumpServer: ServerConfig = { ...testServer, id: "server-close-replay-bastion", multiplexing: true };
    const targetServer: ServerConfig = {
      ...testServer,
      id: "server-close-replay-target",
      multiplexing: false,
      proxy: { type: "ssh", jumpHostId: jumpServer.id }
    };
    const authFactory = {
      connect: async (server: ServerConfig, options?: { sockFactory?: () => Promise<Duplex> }) => {
        if (server.id === jumpServer.id) {
          return bastionConnection;
        }
        const hop = await options?.sockFactory?.();
        hop?.destroy();
        bastionConnection.remoteClose();
        return targetConnection;
      }
    } as unknown as SilentAuthSshFactory;
    const vault: SecretVault = {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {}
    };
    const proxyFactory = new ProxySshFactory(authFactory, (id) => id === jumpServer.id ? jumpServer : undefined, vault);
    const pool = new SshConnectionPool(proxyFactory, { enabled: true, idleTimeoutMs: 0 });
    proxyFactory.setJumpHostConnectionFactory(pool);
    manager = new TunnelManager(pool, pool);
    const profile: TunnelProfile = {
      id: "reverse-close-replay-target",
      name: "Replay-closed jump target",
      localPort: 12345,
      remoteIP: "127.0.0.1",
      remotePort: 23456,
      autoStart: false,
      tunnelType: "reverse",
      remoteBindAddress: "127.0.0.1",
      localTargetIP: "127.0.0.1"
    };
    const events: TunnelEvent[] = [];
    manager.onDidChange((event) => events.push(event));
    let bastionLease: SshConnection | undefined;

    try {
      // Keep another real pool lease alive so the target's leaked lease is
      // visible when this one is released after the remote close.
      bastionLease = await pool.connect(jumpServer);
      await expect(manager.start(profile, targetServer)).rejects.toThrow(
        "Shared SSH connection closed while starting tunnel Replay-closed jump target"
      );
      expect(events.filter((event) => event.type === "started")).toHaveLength(0);
      expect(events.filter((event) => event.type === "error")).toHaveLength(0);

      bastionLease.dispose();
      bastionLease = undefined;
      expect(bastionConnection.disposeCount).toBe(1);
      expect(targetConnection.disposeCount).toBe(1);
      expect(manager.getActiveTunnelId(profile.id)).toBeUndefined();
    } finally {
      await manager.stopAll();
      bastionLease?.dispose();
      pool.dispose();
      if (targetConnection.disposeCount === 0) {
        targetConnection.dispose();
      }
      if (bastionConnection.disposeCount === 0) {
        bastionConnection.dispose();
      }
      manager = undefined;
    }
  });

  it("does not report an expected close when a reverse forward is refused", async () => {
    const connection = new RefusedForwardConnection();
    const factory: SshFactory = { connect: async () => connection };
    const pool = new SshConnectionPool(factory, { enabled: true, idleTimeoutMs: 60_000 });
    manager = new TunnelManager(pool, pool);
    const events: TunnelEvent[] = [];
    manager.onDidChange((event) => events.push(event));
    const profile: TunnelProfile = {
      id: "reverse-refused",
      name: "Refused reverse tunnel",
      localPort: 12345,
      remoteIP: "127.0.0.1",
      remotePort: 23456,
      autoStart: false,
      tunnelType: "reverse",
      remoteBindAddress: "127.0.0.1",
      localTargetIP: "127.0.0.1"
    };
    const server = { ...testServer, multiplexing: false };
    const closeMessage = `Shared SSH connection closed for tunnel ${profile.name}`;

    try {
      await expect(manager.start(profile, server)).rejects.toThrow("Remote forwarding refused");
      expect(events.filter((event) => event.type === "error").map((event) => event.message)).not.toContain(
        closeMessage
      );
    } finally {
      await manager.stopAll();
      pool.dispose();
    }
  });

  it("starts a dynamic SOCKS5 tunnel and accepts SOCKS5 handshake", async () => {
    const remotePort = await getFreePort();
    echoServer = await startEchoServer(remotePort);
    const localPort = await getFreePort();

    const profile: TunnelProfile = {
      id: "tunnel-dynamic",
      name: "SOCKS5 Proxy",
      localPort,
      remoteIP: "0.0.0.0",
      remotePort: 0,
      autoStart: false,
      tunnelType: "dynamic"
    };

    const sshFactory = new DirectTcpSshFactory();
    manager = new TunnelManager(sshFactory, sshFactory);
    const events: TunnelEvent[] = [];
    manager.onDidChange((event) => events.push(event));

    const activeTunnel = await manager.start(profile, testServer);
    expect(activeTunnel.tunnelType).toBe("dynamic");
    expect(events.some((e) => e.type === "started")).toBe(true);

    // Perform a SOCKS5 handshake to connect to the local echo server
    const response = await new Promise<string>((resolve, reject) => {
      const client = net.createConnection({ host: "127.0.0.1", port: localPort }, () => {
        // SOCKS5 greeting: version 5, 1 method, no-auth
        client.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let phase = 0;
      let buf = Buffer.alloc(0);

      client.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);

        if (phase === 0 && buf.length >= 2) {
          // Greeting reply
          expect(buf[0]).toBe(0x05);
          expect(buf[1]).toBe(0x00);
          buf = buf.subarray(2);
          phase = 1;

          // SOCKS5 CONNECT request to echo server
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(remotePort, 0);
          client.write(Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1]),
            portBuf
          ]));
        }

        if (phase === 1 && buf.length >= 10) {
          // Connection reply
          expect(buf[0]).toBe(0x05);
          expect(buf[1]).toBe(0x00); // success
          buf = buf.subarray(10);
          phase = 2;

          // Send data through the SOCKS5 proxy
          client.write("socks5-echo");
        }

        if (phase === 2 && buf.length >= 11) {
          resolve(buf.toString("utf8", 0, 11));
          client.destroy();
        }
      });

      client.on("error", reject);
      setTimeout(() => reject(new Error("Timeout")), 5000);
    });

    expect(response).toBe("socks5-echo");

    const trafficEvent = await waitForTraffic(events, 2000);
    expect(trafficEvent).toBeDefined();

    await manager.stop(activeTunnel.id);
    expect(events.some((e) => e.type === "stopped")).toBe(true);
  });

  it("does not emit error when a raw TCP probe connects to a dynamic SOCKS5 tunnel", async () => {
    const localPort = await getFreePort();

    const profile: TunnelProfile = {
      id: "tunnel-probe",
      name: "SOCKS5 Probe Test",
      localPort,
      remoteIP: "0.0.0.0",
      remotePort: 0,
      autoStart: false,
      tunnelType: "dynamic"
    };

    const sshFactory = new DirectTcpSshFactory();
    manager = new TunnelManager(sshFactory, sshFactory);
    const events: TunnelEvent[] = [];
    manager.onDidChange((event) => events.push(event));

    await manager.start(profile, testServer);

    // Simulate a raw TCP probe (connect + immediate close, no SOCKS5 data)
    await new Promise<void>((resolve, reject) => {
      const probe = net.createConnection({ host: "127.0.0.1", port: localPort }, () => {
        probe.destroy();
      });
      probe.on("close", () => resolve());
      probe.on("error", reject);
    });

    // Give the handler time to process the closed socket
    await new Promise((resolve) => setTimeout(resolve, 200));

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);

    await manager.stopAll();
  });

  it("keeps the shared connection alive when a channel open is refused (local)", async () => {
    const remotePort = await getFreePort();
    echoServer = await startEchoServer(remotePort);
    const localPort = await getFreePort();

    const profile: TunnelProfile = {
      id: "tunnel-channel-refusal",
      name: "Channel Refusal Tunnel",
      localPort,
      remoteIP: "127.0.0.1",
      remotePort,
      autoStart: false,
      connectionMode: "shared"
    };

    const sshFactory = new ScriptedSshFactory();
    manager = new TunnelManager(sshFactory, sshFactory);
    const events: TunnelEvent[] = [];
    manager.onDidChange((event) => events.push(event));

    const activeTunnel = await manager.start(profile, testServer, { connectionMode: "shared" });
    const shared = sshFactory.connections[0];
    expect(shared).toBeDefined();

    // One client asks for a destination the remote cannot reach.
    shared.pendingFailures.push(channelOpenFailure());
    await expectRefusedConnection(localPort);

    // The transport is untouched, so the next client rides the same connection.
    const second = await exchangeMessage(localPort, "beta");
    expect(second).toBe("beta");
    expect(shared.disposeCount).toBe(0);
    expect(sshFactory.connectCount).toBe(1);
    expect(
      events.some((e) => e.type === "error" && e.message.includes("Shared SSH connection closed"))
    ).toBe(false);

    await manager.stop(activeTunnel.id);
  });

  it("tears down the shared connection when the SSH transport itself fails (local)", async () => {
    const remotePort = await getFreePort();
    echoServer = await startEchoServer(remotePort);
    const localPort = await getFreePort();

    const profile: TunnelProfile = {
      id: "tunnel-transport-failure",
      name: "Transport Failure Tunnel",
      localPort,
      remoteIP: "127.0.0.1",
      remotePort,
      autoStart: false,
      connectionMode: "shared"
    };

    const sshFactory = new ScriptedSshFactory();
    manager = new TunnelManager(sshFactory, sshFactory);
    manager.onDidChange(() => {});

    const activeTunnel = await manager.start(profile, testServer, { connectionMode: "shared" });
    const shared = sshFactory.connections[0];

    shared.pendingFailures.push(transportFailure());
    await expectRefusedConnection(localPort);

    expect(shared.disposeCount).toBe(1);

    // The dead connection was cleared, so the next client gets a fresh one.
    const second = await exchangeMessage(localPort, "beta");
    expect(second).toBe("beta");
    expect(sshFactory.connectCount).toBe(2);

    await manager.stop(activeTunnel.id);
  });

  it("keeps the shared connection alive when a SOCKS5 destination is refused (dynamic)", async () => {
    const remotePort = await getFreePort();
    echoServer = await startEchoServer(remotePort);
    const localPort = await getFreePort();

    const profile: TunnelProfile = {
      id: "tunnel-socks-refusal",
      name: "SOCKS5 Refusal Proxy",
      localPort,
      remoteIP: "0.0.0.0",
      remotePort: 0,
      autoStart: false,
      tunnelType: "dynamic",
      connectionMode: "shared"
    };

    const sshFactory = new ScriptedSshFactory();
    manager = new TunnelManager(sshFactory, sshFactory);
    manager.onDidChange(() => {});

    const activeTunnel = await manager.start(profile, testServer, { connectionMode: "shared" });
    const shared = sshFactory.connections[0];

    // One browser tab requests an unreachable host.
    shared.pendingFailures.push(channelOpenFailure());
    const refused = await socks5Request(localPort, remotePort);
    expect(refused.reply).toBe(0x01);

    // Every other tab must still be proxied over the same SSH connection.
    const ok = await socks5Request(localPort, remotePort, "socks5-echo");
    expect(ok.reply).toBe(0x00);
    expect(ok.echo).toBe("socks5-echo");
    expect(shared.disposeCount).toBe(0);
    expect(sshFactory.connectCount).toBe(1);

    await manager.stop(activeTunnel.id);
  });

  it("tears down the shared connection when the SSH transport fails (dynamic)", async () => {
    const remotePort = await getFreePort();
    echoServer = await startEchoServer(remotePort);
    const localPort = await getFreePort();

    const profile: TunnelProfile = {
      id: "tunnel-socks-transport-failure",
      name: "SOCKS5 Transport Failure Proxy",
      localPort,
      remoteIP: "0.0.0.0",
      remotePort: 0,
      autoStart: false,
      tunnelType: "dynamic",
      connectionMode: "shared"
    };

    const sshFactory = new ScriptedSshFactory();
    manager = new TunnelManager(sshFactory, sshFactory);
    manager.onDidChange(() => {});

    const activeTunnel = await manager.start(profile, testServer, { connectionMode: "shared" });
    const shared = sshFactory.connections[0];

    shared.pendingFailures.push(transportFailure());
    const refused = await socks5Request(localPort, remotePort);
    expect(refused.reply).toBe(0x01);
    expect(shared.disposeCount).toBe(1);

    const ok = await socks5Request(localPort, remotePort, "socks5-echo");
    expect(ok.reply).toBe(0x00);
    expect(sshFactory.connectCount).toBe(2);

    await manager.stop(activeTunnel.id);
  });
});
