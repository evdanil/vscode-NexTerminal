import type { Duplex } from "node:stream";
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

export interface SshConnection {
  openShell(ptyOptions?: PtyOptions): Promise<Duplex>;
  openDirectTcp(remoteIP: string, remotePort: number): Promise<Duplex>;
  onClose(listener: () => void): () => void;
  dispose(): void;
}

export interface SshConnector {
  connect(server: ServerConfig, auth: { password?: string; passphrase?: string }): Promise<SshConnection>;
}
