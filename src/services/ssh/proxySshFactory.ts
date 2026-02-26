import * as net from "node:net";
import type { Duplex } from "node:stream";
import { SocksClient } from "socks";
import type { ServerConfig, ProxyConfig } from "../../models/config";
import type { SecretVault, SshConnection, SshFactory } from "./contracts";
import { ProxiedSshConnection, jumpHostCleanup, socketCleanup } from "./proxiedSshConnection";
import type { SilentAuthSshFactory } from "./silentAuth";
import { proxyPasswordSecretKey } from "./silentAuth";

export class ProxySshFactory implements SshFactory {
  public constructor(
    private readonly authFactory: SilentAuthSshFactory,
    private readonly serverLookup: (id: string) => ServerConfig | undefined,
    private readonly vault: SecretVault
  ) {}

  public async connect(server: ServerConfig): Promise<SshConnection> {
    if (!server.proxy) {
      return this.authFactory.connect(server);
    }
    return this.connectViaProxy(server, server.proxy, new Set<string>());
  }

  private async connectViaProxy(
    server: ServerConfig,
    proxy: ProxyConfig,
    visited: Set<string>
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
    visited: Set<string>
  ): Promise<SshConnection> {
    if (visited.has(target.id)) {
      throw new Error(`Circular proxy reference detected: ${target.name} (${target.id})`);
    }
    visited.add(target.id);

    const jumpServer = this.serverLookup(jumpHostId);
    if (!jumpServer) {
      throw new Error(`Jump host server not found (id: ${jumpHostId})`);
    }

    if (visited.has(jumpServer.id)) {
      throw new Error(
        `Circular proxy reference detected: ${jumpServer.name} (${jumpServer.id}) is already in the proxy chain`
      );
    }

    // Recursively connect to jump host (it may itself have a proxy)
    let jumpConnection: SshConnection;
    if (jumpServer.proxy) {
      jumpConnection = await this.connectViaProxy(jumpServer, jumpServer.proxy, visited);
    } else {
      jumpConnection = await this.authFactory.connect(jumpServer);
    }

    // Open a TCP tunnel through the jump host to the target
    let tunnelStream: Duplex;
    try {
      tunnelStream = await jumpConnection.openDirectTcp(target.host, target.port);
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
      }
    });

    let connection: SshConnection;
    try {
      connection = await this.authFactory.connect(target, { sock: socket });
    } catch (error) {
      socket.destroy();
      throw error;
    }

    return new ProxiedSshConnection(connection, socketCleanup(socket));
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

    let connection: SshConnection;
    try {
      connection = await this.authFactory.connect(target, { sock: socket });
    } catch (error) {
      socket.destroy();
      throw error;
    }

    return new ProxiedSshConnection(connection, socketCleanup(socket));
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
        let request = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
        if (username) {
          const credentials = Buffer.from(`${username}:${password ?? ""}`).toString("base64");
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
        const headerEnd = responseData.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return; // Headers not complete yet
        }
        socket.removeListener("data", onData);

        const statusLine = responseData.substring(0, responseData.indexOf("\r\n"));
        const statusCode = parseInt(statusLine.split(" ")[1], 10);
        if (statusCode === 200) {
          resolve(socket);
        } else {
          socket.destroy();
          reject(new Error(`HTTP CONNECT proxy returned status ${statusCode}: ${statusLine}`));
        }
      };

      socket.on("data", onData);

      socket.setTimeout(60_000, () => {
        socket.destroy();
        reject(new Error("HTTP CONNECT proxy handshake timed out"));
      });
    });
  }
}
