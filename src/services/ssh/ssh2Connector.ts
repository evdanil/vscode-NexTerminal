import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { Client, type Algorithms, type ConnectConfig, type SFTPWrapper, type VerifyCallback } from "ssh2";
import type { ServerConfig } from "../../models/config";
import type {
  HostKeyVerifier,
  KeyboardInteractiveHandler,
  PtyOptions,
  SshConnection,
  SshConnector,
  TcpConnectionInfo
} from "./contracts";

/**
 * Legacy SSH algorithms appended as fallbacks when `ServerConfig.legacyAlgorithms`
 * is enabled. Targets older devices (Cisco IOS, embedded systems) that lack modern
 * algorithm support.
 *
 * Security notes:
 * - `diffie-hellman-group1-sha1` uses a 1024-bit group considered breakable by
 *   nation-state adversaries, but is required by many legacy devices.
 * - `ssh-dss` uses 1024-bit DSA keys, similarly weak but still common on older hosts.
 * - RC4/arcfour ciphers are intentionally excluded — they are cryptographically broken
 *   and unnecessary even for legacy devices (which typically support aes*-cbc or 3des-cbc).
 * - cast128-cbc and blowfish-cbc are excluded — OpenSSL 3.x (used by modern Node.js)
 *   dropped CAST5 and Blowfish support. ssh2 still advertises them in its supported list,
 *   but creating the actual cipher fails at runtime, causing silent handshake timeouts.
 * - These are appended, not prepended, so modern algorithms are always preferred when
 *   the server supports them.
 */
export const LEGACY_ALGORITHMS: Algorithms = {
  kex: { append: [
    "diffie-hellman-group-exchange-sha1",
    "diffie-hellman-group14-sha1",
    "diffie-hellman-group1-sha1"
  ], prepend: [], remove: [] },
  cipher: { append: [
    "aes256-cbc", "aes192-cbc", "aes128-cbc",
    "3des-cbc"
  ], prepend: [], remove: [] },
  serverHostKey: { append: ["ssh-dss"], prepend: [], remove: [] },
  hmac: { append: [
    "hmac-md5", "hmac-sha2-256-96", "hmac-sha2-512-96",
    "hmac-ripemd160", "hmac-sha1-96", "hmac-md5-96"
  ], prepend: [], remove: [] }
};

class Ssh2Connection implements SshConnection {
  private readonly closeListeners = new Set<() => void>();
  private banner?: string;

  public constructor(private readonly client: Client, banner?: string) {
    this.banner = banner;
    this.client.on("close", () => {
      for (const listener of this.closeListeners) {
        listener();
      }
    });
  }

  public getBanner(): string | undefined {
    const b = this.banner;
    this.banner = undefined;
    return b;
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

  public async exec(command: string): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (error: Error | undefined, stream: Duplex) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stream);
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

export async function buildConnectConfig(server: ServerConfig, password?: string, passphrase?: string, sock?: Duplex): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: 60_000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    tryKeyboard: true,
    ...(sock && { sock }),
    ...(server.legacyAlgorithms && { algorithms: LEGACY_ALGORITHMS })
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
  public constructor(private readonly hostKeyVerifier?: HostKeyVerifier) {}

  public async connect(
    server: ServerConfig,
    auth: { password?: string; passphrase?: string; sock?: Duplex; onKeyboardInteractive?: KeyboardInteractiveHandler }
  ): Promise<SshConnection> {
    const config = await buildConnectConfig(server, auth.password, auth.passphrase, auth.sock);
    if (this.hostKeyVerifier) {
      config.hostVerifier = (hostKey: Buffer | string, verify: VerifyCallback): void => {
        const rawHostKey = Buffer.isBuffer(hostKey) ? hostKey : Buffer.from(hostKey, "hex");
        void this.hostKeyVerifier!.verify(server, rawHostKey).then(
          (allowed) => verify(allowed),
          () => verify(false)
        );
      };
    }
    const client = new Client();
    return new Promise((resolve, reject) => {
      let settled = false;
      let banner: string | undefined;
      client.on("banner", (message: string) => {
        banner = message;
      });
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
        resolve(new Ssh2Connection(client, banner));
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
