import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { Client, type ConnectConfig } from "ssh2";
import type { ServerConfig } from "../../models/config";
import type { SshConnection, SshConnector } from "./contracts";

class Ssh2Connection implements SshConnection {
  private readonly closeListeners = new Set<() => void>();

  public constructor(private readonly client: Client) {
    this.client.on("close", () => {
      for (const listener of this.closeListeners) {
        listener();
      }
    });
  }

  public async openShell(): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      this.client.shell((error: Error | undefined, stream: Duplex) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stream);
      });
    });
  }

  public async openDirectTcp(remoteIP: string, remotePort: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      this.client.forwardOut("127.0.0.1", 0, remoteIP, remotePort, (error: Error | undefined, stream: Duplex) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stream);
      });
    });
  }

  public onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  public dispose(): void {
    this.client.end();
  }
}

async function toConnectConfig(server: ServerConfig, password?: string): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: 15_000
  };

  if (server.authType === "password") {
    return {
      ...base,
      password
    };
  }

  if (server.authType === "agent") {
    return {
      ...base,
      agent: process.env.SSH_AUTH_SOCK
    };
  }

  if (!server.keyPath) {
    throw new Error(`Missing keyPath for key auth on ${server.name}`);
  }

  const privateKey = await readFile(server.keyPath);
  return {
    ...base,
    privateKey
  };
}

export class Ssh2Connector implements SshConnector {
  public async connect(server: ServerConfig, auth: { password?: string }): Promise<SshConnection> {
    const config = await toConnectConfig(server, auth.password);
    const client = new Client();
    return new Promise((resolve, reject) => {
      let settled = false;
      client.on("ready", () => {
        settled = true;
        resolve(new Ssh2Connection(client));
      });
      client.on("error", (error: Error) => {
        if (!settled) {
          reject(error);
          return;
        }
      });
      client.connect(config);
    });
  }
}
