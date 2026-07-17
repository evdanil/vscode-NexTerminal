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

export interface HostKeyVerifier {
  verify(server: ServerConfig, hostKey: Buffer): Promise<boolean>;
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
  exec(command: string): Promise<Duplex>;
  requestForwardIn(bindAddr: string, bindPort: number): Promise<number>;
  cancelForwardIn(bindAddr: string, bindPort: number): Promise<void>;
  onTcpConnection(handler: (info: TcpConnectionInfo, accept: () => Duplex, reject: () => void) => void): () => void;
  onClose(listener: () => void): () => void;
  /** Returns the SSH pre-auth banner (if any) once, then undefined on subsequent calls. */
  getBanner(): string | undefined;
  dispose(): void;
}

export interface SshConnectContext {
  proxyVisited?: ReadonlySet<string>;
  /**
   * Called during authentication with human-readable server messages
   * (USERAUTH_BANNER, keyboard-interactive `name`/`instructions`). May be
   * called multiple times before the connection is established. The caller
   * (the terminal owning this connection attempt) renders these to its
   * screen so MFA prompts (e.g. Duo) show their context instead of a bare
   * input box. The text is server-controlled and unsanitized at this layer —
   * consumers rendering it to a terminal must strip ANSI/control sequences
   * themselves (see `SshPty`'s sink).
   *
   * Pooled/multiplexed connections (`SshConnectionPool`): only the FIRST
   * caller to trigger a given server's connect gets its sink wired to the
   * in-flight handshake. A second caller that joins an already-pending
   * connect (or reuses an already-established one) has its `onAuthMessage`
   * silently discarded — there is only one underlying handshake, so only
   * one sink can observe it. This is acceptable because the MFA popup this
   * is meant to contextualize is itself global to the connection, not
   * per-lease.
   */
  onAuthMessage?: (text: string) => void;
}

export type KeyboardInteractiveHandler = (
  name: string,
  instructions: string,
  prompts: Array<{ prompt: string; echo: boolean }>
) => Promise<string[]>;

export interface SshConnector {
  connect(
    server: ServerConfig,
    auth: {
      password?: string;
      passphrase?: string;
      sock?: Duplex;
      onKeyboardInteractive?: KeyboardInteractiveHandler;
      onAuthMessage?: (text: string) => void;
    }
  ): Promise<SshConnection>;
}

export interface SshFactory {
  connect(server: ServerConfig): Promise<SshConnection>;
}

export interface ContextAwareSshFactory extends SshFactory {
  connectWithContext(server: ServerConfig, context?: SshConnectContext): Promise<SshConnection>;
}

export interface SshPoolControl {
  disconnect(serverId: string): void;
  dispose(): void;
}

export function hasContextAwareConnect(factory: SshFactory): factory is ContextAwareSshFactory {
  return typeof (factory as Partial<ContextAwareSshFactory>).connectWithContext === "function";
}
