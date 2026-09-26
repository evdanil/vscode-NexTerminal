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
  /** Calls the listener immediately when already closed; otherwise subscribes until close. */
  onClose(listener: () => void): () => void;
  /** Returns the SSH pre-auth banner (if any) once, then undefined on subsequent calls. */
  getBanner(): string | undefined;
  dispose(): void;
}

export interface SshConnectContext {
  proxyVisited?: ReadonlySet<string>;
  /**
   * The live config record whose credentials this connect attempt belongs to.
   * The transport target may be a host-only clone (for alternate-host
   * fallback), but authentication and deferred credential changes must still
   * verify this record and its endpoint after asynchronous connection steps.
   */
  credentialSource?: ServerConfig;
  /** False once the owner has closed or superseded this connection attempt. */
  isActive?: () => boolean;
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
   * Pooled/multiplexed connections (`SshConnectionPool`) have one underlying
   * handshake. Messages go to the first live pending owner with a sink; if
   * that owner closes, a live joiner receives later messages. Existing leases
   * do not replay messages from an already completed handshake.
   */
  /** Return false when no live sink handled the message, so banners can be buffered. */
  onAuthMessage?: (text: string) => boolean | void;
}

export type KeyboardInteractiveHandler = (
  name: string,
  instructions: string,
  prompts: Array<{ prompt: string; echo: boolean }>,
  signal?: AbortSignal
) => Promise<string[]>;

export interface SshConnector {
  connect(
    server: ServerConfig,
    auth: {
      password?: string;
      passphrase?: string;
      sock?: Duplex;
      onKeyboardInteractive?: KeyboardInteractiveHandler;
      onAuthMessage?: (text: string) => boolean | void;
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
