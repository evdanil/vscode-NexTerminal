import * as net from "node:net";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerConfig, TunnelProfile } from "../../src/models/config";
import type { SshConnection } from "../../src/services/ssh/contracts";
import { TunnelManager, type TunnelEvent, type TunnelSshFactory } from "../../src/services/tunnel/tunnelManager";

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

  public async openShell(): Promise<PassThrough> {
    return new PassThrough();
  }

  public async openDirectTcp(remoteIP: string, remotePort: number): Promise<net.Socket> {
    const socket = net.createConnection({ host: remoteIP, port: remotePort });
    this.openSockets.add(socket);
    socket.on("close", () => this.openSockets.delete(socket));
    return socket;
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

class DirectTcpSshFactory implements TunnelSshFactory {
  public connectCount = 0;

  public async connect(_server: ServerConfig): Promise<SshConnection> {
    this.connectCount += 1;
    return new DirectTcpSshConnection();
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

  it("forwards bytes and emits traffic updates", async () => {
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
    const server: ServerConfig = {
      id: "server-1",
      name: "Server",
      host: "127.0.0.1",
      port: 22,
      username: "dev",
      authType: "password",
      isHidden: false
    };

    const sshFactory = new DirectTcpSshFactory();
    manager = new TunnelManager(sshFactory);
    const events: TunnelEvent[] = [];
    manager.onDidChange((event) => events.push(event));

    const activeTunnel = await manager.start(profile, server);
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

  it("reuses one SSH connection in shared mode", async () => {
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
    const server: ServerConfig = {
      id: "server-shared",
      name: "Server Shared",
      host: "127.0.0.1",
      port: 22,
      username: "dev",
      authType: "password",
      isHidden: false
    };

    const sshFactory = new DirectTcpSshFactory();
    manager = new TunnelManager(sshFactory);
    const activeTunnel = await manager.start(profile, server, { connectionMode: "shared" });

    const first = await exchangeMessage(localPort, "alpha");
    const second = await exchangeMessage(localPort, "beta");

    expect(first).toBe("alpha");
    expect(second).toBe("beta");
    expect(sshFactory.connectCount).toBe(1);

    await manager.stop(activeTunnel.id);
  });
});
