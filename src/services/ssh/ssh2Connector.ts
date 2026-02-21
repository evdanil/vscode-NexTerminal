import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import type { ServerConfig } from "../../models/config";
import type { KeyboardInteractiveHandler, PtyOptions, SshConnection, SshConnector, TcpConnectionInfo } from "./contracts";

class Ssh2Connection implements SshConnection {
  private readonly closeListeners = new Set<() => void>();

  public constructor(private readonly client: Client) {
    this.client.on("close", () => {
      for (const listener of this.closeListeners) {
        listener();
      }
    });
  }

  public async openShell(ptyOptions?: PtyOptions): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const wndopts = {
        term: ptyOptions?.term ?? "xterm-256color",
        rows: ptyOptions?.rows ?? 24,
        cols: ptyOptions?.cols ?? 80
      };
      this.client.shell(wndopts, (error: Error | undefined, stream: Duplex) => {
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

  public async openSftp(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      this.client.sftp((error: Error | undefined, sftp: SFTPWrapper) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(sftp);
      });
    });
  }

  public async requestForwardIn(bindAddr: string, bindPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.client.forwardIn(bindAddr, bindPort, (error: Error | undefined, port: number) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  }

  public async cancelForwardIn(bindAddr: string, bindPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.unforwardIn(bindAddr, bindPort, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  public onTcpConnection(
    handler: (info: TcpConnectionInfo, accept: () => Duplex, reject: () => void) => void
  ): () => void {
    const listener = (
      details: { destIP: string; destPort: number; srcIP: string; srcPort: number },
      accept: () => Duplex,
      reject: () => void
    ): void => {
      handler(
        { destIP: details.destIP, destPort: details.destPort, srcIP: details.srcIP, srcPort: details.srcPort },
        accept,
        reject
      );
    };
    this.client.on("tcp connection", listener);
    return () => {
      this.client.removeListener("tcp connection", listener);
    };
  }

  public onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  public dispose(): void {
    this.client.end();
  }
}

async function toConnectConfig(server: ServerConfig, password?: string, passphrase?: string): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: 15_000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    tryKeyboard: true
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
    privateKey,
    passphrase
  };
}

export class Ssh2Connector implements SshConnector {
  public async connect(
    server: ServerConfig,
    auth: { password?: string; passphrase?: string; onKeyboardInteractive?: KeyboardInteractiveHandler }
  ): Promise<SshConnection> {
    const config = await toConnectConfig(server, auth.password, auth.passphrase);
    const client = new Client();
    return new Promise((resolve, reject) => {
      let settled = false;
      client.on("keyboard-interactive", (name, instructions, _lang, prompts, finish) => {
        if (auth.onKeyboardInteractive) {
          const mapped = prompts.map((p) => ({
            prompt: p.prompt,
            echo: p.echo ?? false
          }));
          auth.onKeyboardInteractive(name, instructions, mapped).then(
            (responses) => finish(responses),
            (error) => {
              client.end();
              if (!settled) {
                reject(error);
              }
            }
          );
          return;
        }
        // Legacy fallback: auto-fill password for all prompts
        if (auth.password) {
          finish(prompts.map(() => auth.password!));
          return;
        }
        finish([]);
      });
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
