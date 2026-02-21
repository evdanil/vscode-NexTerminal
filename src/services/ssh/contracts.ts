import type { Duplex } from "node:stream";
import type { SFTPWrapper } from "ssh2";
import type { ServerConfig } from "../../models/config";

export interface PasswordPromptResult {
  password: string;
  save: boolean;
}

export interface PasswordPrompt {
  prompt(server: ServerConfig): Promise<PasswordPromptResult | undefined>;
}

export interface SecretVault {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PtyOptions {
  term?: string;
  rows?: number;
  cols?: number;
}

export interface TcpConnectionInfo {
  destIP: string;
  destPort: number;
  srcIP: string;
  srcPort: number;
}

export interface SshConnection {
  openShell(ptyOptions?: PtyOptions): Promise<Duplex>;
  openDirectTcp(remoteIP: string, remotePort: number): Promise<Duplex>;
  openSftp(): Promise<SFTPWrapper>;
  requestForwardIn(bindAddr: string, bindPort: number): Promise<number>;
  cancelForwardIn(bindAddr: string, bindPort: number): Promise<void>;
  onTcpConnection(handler: (info: TcpConnectionInfo, accept: () => Duplex, reject: () => void) => void): () => void;
  onClose(listener: () => void): () => void;
  dispose(): void;
}

export type KeyboardInteractiveHandler = (
  name: string,
  instructions: string,
  prompts: Array<{ prompt: string; echo: boolean }>
) => Promise<string[]>;

export interface SshConnector {
  connect(
    server: ServerConfig,
    auth: { password?: string; passphrase?: string; onKeyboardInteractive?: KeyboardInteractiveHandler }
  ): Promise<SshConnection>;
}

export interface SshFactory {
  connect(server: ServerConfig): Promise<SshConnection>;
}

export interface SshPoolControl {
  disconnect(serverId: string): void;
  dispose(): void;
}
