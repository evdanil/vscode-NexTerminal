import * as net from "node:net";
import type { Duplex } from "node:stream";
import { SocksClient } from "socks";
import type { ServerConfig, ProxyConfig } from "../../models/config";
import { clamp } from "../../utils/helpers";
import type {
  ContextAwareSshFactory,
  SecretVault,
  SshConnectContext,
  SshConnection
} from "./contracts";
import { ProxiedSshConnection, jumpHostCleanup, socketCleanup } from "./proxiedSshConnection";
import type { SilentAuthSshFactory } from "./silentAuth";
import { proxyPasswordSecretKey } from "./silentAuth";

const MAX_HTTP_RESPONSE_SIZE = 65536; // 64KB — more than enough for CONNECT headers

function normalizeProxyTimeoutMs(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) ? clamp(Math.floor(timeoutMs), 5_000, 300_000) : 60_000;
}

export class ProxySshFactory implements ContextAwareSshFactory {
  private proxyTimeoutMs: number;
  private jumpHostFactory?: ContextAwareSshFactory;

  public constructor(
    private readonly authFactory: SilentAuthSshFactory,
    private readonly serverLookup: (id: string) => ServerConfig | undefined,
    private readonly vault: SecretVault,
    proxyTimeoutMs: number = 60_000
  ) {
    this.proxyTimeoutMs = normalizeProxyTimeoutMs(proxyTimeoutMs);
  }

  public updateProxyTimeout(timeoutMs: number): void {
    this.proxyTimeoutMs = normalizeProxyTimeoutMs(timeoutMs);
  }

  public setJumpHostConnectionFactory(factory: ContextAwareSshFactory): void {
    this.jumpHostFactory = factory;
  }

  public connect(server: ServerConfig): Promise<SshConnection> {
    return this.connectWithContext(server);
  }

  public async connectWithContext(
    server: ServerConfig,
    context?: SshConnectContext
  ): Promise<SshConnection> {
    if (!server.proxy) {
      return this.authFactory.connect(server);
    }
    return this.connectViaProxy(server, server.proxy, context?.proxyVisited ?? new Set<string>());
  }

  private async connectViaProxy(
    server: ServerConfig,
    proxy: ProxyConfig,
    visited: ReadonlySet<string>
  ): Promise<SshConnection> {
    switch (proxy.type) {
      case "ssh":
        return this.connectViaSshJump(server, proxy.jumpHostId, visited);
      case "socks5":
        return this.connectViaSocks5(server, proxy);
      case "http":
        return this.connectViaHttpConnect(server, proxy);
    }
  }

  private async connectViaSshJump(
    target: ServerConfig,
    jumpHostId: string,
    visited: ReadonlySet<string>
  ): Promise<SshConnection> {
    const nextVisited = this.addToVisited(visited, target);
    const jumpServer = this.serverLookup(jumpHostId);
    if (!jumpServer) {
      throw new Error(`Jump host server not found (id: ${jumpHostId})`);
    }

    this.assertNoCircularProxyChain(jumpServer, nextVisited);
    const jumpConnection = await this.connectToJumpHost(jumpServer, nextVisited);

    // Open a TCP tunnel through the jump host to the target
    let tunnelStream: Duplex;
    try {
      tunnelStream = await jumpConnection.openDirectTcp(target.host, target.port);

      // Pause the tunnel stream to prevent the target's SSH banner from being
      // lost during the async gap before ssh2 attaches its data listeners
      // (vault password lookup, buildConnectConfig, etc.).
      // Same banner-loss issue as the SOCKS5 fix below (see connectViaSocks5).
      tunnelStream.pause();
    } catch (error) {
      jumpConnection.dispose();
      throw error;
    }

    // Connect to the target through the tunnel stream
    let targetConnection: SshConnection;
    try {
      targetConnection = await this.authFactory.connect(target, { sock: tunnelStream });
    } catch (error) {
      jumpConnection.dispose();
      throw error;
    }

    return new ProxiedSshConnection(targetConnection, jumpHostCleanup(jumpConnection));
  }

  private async connectViaSocks5(
    target: ServerConfig,
    proxy: { host: string; port: number; username?: string }
  ): Promise<SshConnection> {
    const proxyPassword = proxy.username
      ? await this.vault.get(proxyPasswordSecretKey(target.id))
      : undefined;

    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: 5,
        ...(proxy.username && {
          userId: proxy.username,
          password: proxyPassword ?? ""
        })
      },
      command: "connect",
      destination: {
        host: target.host,
        port: target.port
      },
      timeout: this.proxyTimeoutMs
    });

    // The socks library schedules setImmediate(() => socket.resume()) after the
    // SOCKS5 handshake completes. If there's any async gap before ssh2 takes the
    // socket (e.g., password lookup from SecretStorage), the premature resume causes
    // the SSH server's banner data to be lost — no data listeners are attached yet,
    // so flowing data is discarded, leading to "Timed out while waiting for handshake".
    // Fix: wait for the deferred resume to fire, then re-pause so ssh2 can take over.
    await new Promise<void>((r) => setImmediate(r));
    socket.pause();

    return this.connectThroughSocket(target, socket);
  }

  private async connectViaHttpConnect(
    target: ServerConfig,
    proxy: { host: string; port: number; username?: string }
  ): Promise<SshConnection> {
    const proxyPassword = proxy.username
      ? await this.vault.get(proxyPasswordSecretKey(target.id))
      : undefined;

    const socket = await this.httpConnectHandshake(
      proxy.host,
      proxy.port,
      target.host,
      target.port,
      proxy.username,
      proxyPassword
    );

    return this.connectThroughSocket(target, socket);
  }

  private async connectThroughSocket(
    target: ServerConfig,
    socket: net.Socket
  ): Promise<SshConnection> {
    let connection: SshConnection;
    try {
      connection = await this.authFactory.connect(target, { sock: socket });
    } catch (error) {
      socket.destroy();
      throw error;
    }
    return new ProxiedSshConnection(connection, socketCleanup(socket));
  }

  private addToVisited(visited: ReadonlySet<string>, server: ServerConfig): Set<string> {
    if (visited.has(server.id)) {
      throw new Error(`Circular proxy reference detected: ${server.name} (${server.id})`);
    }
    const next = new Set(visited);
    next.add(server.id);
    return next;
  }

  private assertNoCircularProxyChain(server: ServerConfig, visited: ReadonlySet<string>): void {
    const chainVisited = new Set(visited);
    let current = server;

    while (true) {
      if (chainVisited.has(current.id)) {
        throw new Error(
          `Circular proxy reference detected: ${current.name} (${current.id}) is already in the proxy chain`
        );
      }
      chainVisited.add(current.id);

      if (!current.proxy || current.proxy.type !== "ssh") {
        return;
      }

      const jumpServer = this.serverLookup(current.proxy.jumpHostId);
      if (!jumpServer) {
        throw new Error(`Jump host server not found (id: ${current.proxy.jumpHostId})`);
      }
      current = jumpServer;
    }
  }

  private connectToJumpHost(
    jumpServer: ServerConfig,
    visited: ReadonlySet<string>
  ): Promise<SshConnection> {
    if (this.jumpHostFactory) {
      return this.jumpHostFactory.connectWithContext(jumpServer, { proxyVisited: visited });
    }
    if (jumpServer.proxy) {
      return this.connectWithContext(jumpServer, { proxyVisited: visited });
    }
    return this.authFactory.connect(jumpServer);
  }

  private httpConnectHandshake(
    proxyHost: string,
    proxyPort: number,
    targetHost: string,
    targetPort: number,
    username?: string,
    password?: string
  ): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(proxyPort, proxyHost, () => {
        // Strip CR/LF to prevent HTTP header injection
        const safeHost = targetHost.replace(/[\r\n]/g, "");
        let request = `CONNECT ${safeHost}:${targetPort} HTTP/1.1\r\nHost: ${safeHost}:${targetPort}\r\n`;
        if (username) {
          const safeUser = username.replace(/[\r\n]/g, "");
          const credentials = Buffer.from(`${safeUser}:${password ?? ""}`).toString("base64");
          request += `Proxy-Authorization: Basic ${credentials}\r\n`;
        }
        request += "\r\n";
        socket.write(request);
      });

      socket.once("error", (error) => {
        reject(new Error(`HTTP CONNECT proxy error: ${error.message}`));
      });

      let responseData = "";
      const onData = (chunk: Buffer): void => {
        responseData += chunk.toString();

        if (responseData.length > MAX_HTTP_RESPONSE_SIZE) {
          socket.destroy();
          reject(new Error("HTTP CONNECT proxy response too large"));
          return;
        }

        const headerEnd = responseData.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return; // Headers not complete yet
        }
        socket.removeListener("data", onData);
        socket.setTimeout(0);

        const statusLine = responseData.substring(0, responseData.indexOf("\r\n"));
        const statusCode = parseInt(statusLine.split(" ")[1], 10);
        if (statusCode === 200) {
          // Push back any data that arrived after the HTTP headers (e.g., SSH banner)
          const trailing = responseData.substring(headerEnd + 4);
          if (trailing.length > 0) {
            socket.unshift(Buffer.from(trailing));
          }
          resolve(socket);
        } else {
          socket.destroy();
          reject(new Error(`HTTP CONNECT proxy returned status ${statusCode}: ${statusLine}`));
        }
      };

      socket.on("data", onData);

      socket.setTimeout(this.proxyTimeoutMs, () => {
        socket.destroy();
        reject(new Error("HTTP CONNECT proxy handshake timed out"));
      });
    });
  }
}
