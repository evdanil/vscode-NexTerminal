import * as net from "node:net";
import { PassThrough, type Duplex } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerConfig, TunnelProfile } from "../../src/models/config";
import type { SshConnection, SshFactory, TcpConnectionInfo } from "../../src/services/ssh/contracts";
import { TunnelManager, type TunnelEvent } from "../../src/services/tunnel/tunnelManager";

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
});
