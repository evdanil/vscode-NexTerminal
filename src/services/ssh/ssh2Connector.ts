import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";

// MUST stay above the ssh2 import: ssh2 destructures
// createDiffieHellmanGroup from node:crypto at module load, and this shim
// (needed for diffie-hellman-group1-sha1 on Electron) has to wrap it first.
// See sshDhGroupCompat.ts for the full story.
import { uninstallSshDhGroupCompat } from "./sshDhGroupCompat";

import { Client, createAgent, type Algorithms, type ConnectConfig, type SFTPWrapper, type VerifyCallback } from "ssh2";

// ssh2 captured the shim-wrapped function in its own module closure during the
// import above, so the wrapper keeps serving our connections — restore the
// shared crypto export now so other extensions in this extension-host process
// are not left with a permanent monkey-patch on node:crypto.
uninstallSshDhGroupCompat();

import { createExternalSshAuthentication, type ExternalSshAuthentication } from "./externalSshAuthentication";
import type { ResolvedExternalCredential } from "../credentials/contracts";
import type { ServerConfig } from "../../models/config";
import { normalizeBoundedNumber as normalizeTimeout } from "../../utils/helpers";
import type {
  HostKeyVerifier,
  KeyboardInteractiveHandler,
  PtyOptions,
  SshCommandChannel,
  SshConnection,
  SshConnector,
  TcpConnectionInfo
} from "./contracts";
import { SshInteractionRequiredError } from "./contracts";
import { AuthNotJudgedError, SshAgentUnavailableError } from "./authErrors";
import {
  hostSshAgentLookup,
  resolveSshAgent,
  SSH_AGENT_SOURCE_LABELS,
  sshAgentHoldsNoKeysMessage,
  sshAgentUnusableMessage,
  type SshAgentChoice
} from "./sshAgentLocator";

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new AuthNotJudgedError("SSH operation was canceled");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

type Ssh2CommandStream = Duplex & {
  stderr?: NodeJS.ReadableStream;
  close?: () => void;
};

function closeCommandStream(stream: Ssh2CommandStream): void {
  try {
    if (stream.close) {
      stream.close.call(stream);
    } else {
      stream.destroy();
    }
  } catch {
    stream.destroy();
  }
}

function createCommandChannel(stream: Ssh2CommandStream, signal?: AbortSignal): SshCommandChannel {
  const stderr = stream.stderr;
  if (!stderr) {
    stream.destroy();
    throw new Error("SSH command channel did not expose stderr");
  }

  let exit: { readonly code: number | null; readonly signal?: string } | undefined;
  let channelClosed = false;
  let stdoutEnded = false;
  let stdoutClosed = false;
  let stderrEnded = false;
  let stderrClosed = false;
  let settled = false;
  let rejectCompletion!: (error: Error) => void;
  let resolveCompletion!: (result: { readonly code: number | null; readonly signal?: string }) => void;
  const completion = new Promise<{ readonly code: number | null; readonly signal?: string }>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A short-lived command can fail before its caller attaches to completion.
  void completion.catch(() => undefined);

  const cleanup = (): void => {
    stream.removeListener("exit", onExit);
    stream.removeListener("close", onChannelClose);
    stream.removeListener("close", onStdoutClose);
    stream.removeListener("end", onStdoutEnd);
    stream.removeListener("error", onError);
    stderr.removeListener("close", onStderrClose);
    stderr.removeListener("end", onStderrEnd);
    stderr.removeListener("error", onError);
    signal?.removeEventListener("abort", onAbort);
  };
  const cleanupAfterTeardown = (): void => {
    // Channel close can arrive before buffered readable data is consumed; keep
    // the end observers until completion or failure has actually settled.
    if (settled && channelClosed && (stdoutEnded || stdoutClosed) && (stderrEnded || stderrClosed)) {
      cleanup();
    }
  };
  const fail = (error: Error): void => {
    if (!settled) {
      settled = true;
      rejectCompletion(error);
    }
    cleanupAfterTeardown();
  };
  const resolveIfComplete = (): void => {
    if (!settled && exit && channelClosed && stdoutEnded && stderrEnded) {
      settled = true;
      resolveCompletion(exit);
    }
    cleanupAfterTeardown();
  };
  const onExit = (code: number | null, exitSignal?: string): void => {
    exit = { code: code ?? null, ...(exitSignal && { signal: exitSignal }) };
    resolveIfComplete();
  };
  const onChannelClose = (): void => {
    channelClosed = true;
    if (!exit) {
      fail(new Error("SSH command channel closed without an exit result"));
    } else {
      resolveIfComplete();
    }
  };
  const onStdoutEnd = (): void => {
    stdoutEnded = true;
    resolveIfComplete();
  };
  const onStdoutClose = (): void => {
    stdoutClosed = true;
    cleanupAfterTeardown();
  };
  const onStderrEnd = (): void => {
    stderrEnded = true;
    resolveIfComplete();
  };
  const onStderrClose = (): void => {
    stderrClosed = true;
    cleanupAfterTeardown();
  };
  const onError = (error: Error): void => {
    if (!settled) {
      fail(error);
      closeCommandStream(stream);
    } else {
      cleanupAfterTeardown();
    }
  };
  const onAbort = (): void => {
    if (settled) return;
    fail(abortReason(signal!));
    closeCommandStream(stream);
  };

  // ssh2 can emit exit synchronously inside exec's callback for a short command.
  stream.on("exit", onExit);
  stream.on("close", onChannelClose);
  stream.on("close", onStdoutClose);
  stream.on("end", onStdoutEnd);
  stream.on("error", onError);
  stderr.on("close", onStderrClose);
  stderr.on("end", onStderrEnd);
  stderr.on("error", onError);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  return { stdout: stream, stderr, completion, close: () => closeCommandStream(stream) };
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.then(disposeLate, () => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled || signal.aborted) {
          disposeLate?.(value);
          if (!settled) {
            settled = true;
            cleanup();
            reject(abortReason(signal));
          }
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

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
  private closed = false;

  public constructor(
    private readonly client: Client,
    banner?: string,
    private readonly label?: string,
    private readonly diagnostics?: (line: string) => void
  ) {
    this.banner = banner;
    const emitClose = (): void => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      // Logged once (the `closed` latch covers ssh2 emitting both 'close' and
      // 'end'): a connection drop is the visible half of every "all my terminals
      // just disconnected" report, and the matching cause line — a keepalive
      // timeout, a protocol error — is written by the connector's error handler.
      this.diagnostics?.(`[ssh] ${this.label ?? "connection"}: connection closed`);
      for (const listener of this.closeListeners) {
        listener();
      }
    };
    this.client.on("close", emitClose);
    this.client.on("end", emitClose);
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

  public execCommand(command: string, signal?: AbortSignal): Promise<SshCommandChannel> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortReason(signal!));
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.client.exec(command, (error: Error | undefined, stream: Duplex) => {
          if (settled || signal?.aborted) {
            if (stream) closeCommandStream(stream as Ssh2CommandStream);
            return;
          }
          if (error) {
            fail(error);
            return;
          }
          try {
            const channel = createCommandChannel(stream as Ssh2CommandStream, signal);
            settled = true;
            cleanup();
            resolve(channel);
          } catch (channelError) {
            fail(channelError instanceof Error ? channelError : new Error(String(channelError)));
          }
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
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
    if (this.closed) {
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  public dispose(): void {
    this.client.end();
  }
}

export interface SshConnectionOptions {
  readyTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
}

function normalizeConnectionOptions(options?: SshConnectionOptions): Required<SshConnectionOptions> {
  return {
    readyTimeoutMs: normalizeTimeout(options?.readyTimeoutMs, 60_000, 5_000, 300_000),
    keepaliveIntervalMs: normalizeTimeout(options?.keepaliveIntervalMs, 10_000, 0, 300_000),
    keepaliveCountMax: normalizeTimeout(options?.keepaliveCountMax, 3, 1, 30)
  };
}

/**
 * `agent` is the socket or pipe `Ssh2Connector` resolved for an SSH Agent
 * login (`sshAgentLocator.ts`); undefined dials without one. The environment
 * is not read here: on Windows `SSH_AUTH_SOCK` is normally unset, and passing
 * it through is what left agent logins with no agent at all.
 */
export async function buildConnectConfig(
  server: ServerConfig,
  password?: string,
  passphrase?: string,
  sock?: Duplex,
  options?: SshConnectionOptions,
  agent?: string,
  externalOptions?: ExternalSshAuthentication["connectOptions"]
): Promise<ConnectConfig> {
  const normalized = normalizeConnectionOptions(options);
  const base: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: normalized.readyTimeoutMs,
    keepaliveInterval: normalized.keepaliveIntervalMs,
    keepaliveCountMax: normalized.keepaliveCountMax,
    tryKeyboard: true,
    ...(sock && { sock }),
    ...(server.legacyAlgorithms && { algorithms: LEGACY_ALGORITHMS })
  };

  if (externalOptions) return { ...base, ...externalOptions };

  if (server.authType === "password") {
    return {
      ...base,
      password
    };
  }

  if (server.authType === "agent") {
    return {
      ...base,
      agent
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

/** The agent an SSH Agent login dials with — or none, and what to say if the server then refuses. */
type AgentForLogin =
  | { readonly path: string; readonly ifRefused?: undefined }
  | {
      readonly path?: undefined;
      /** Why the agent offered no key, as the user is told it. */
      readonly ifRefused: SshAgentUnavailableError;
      /** The same, as a short clause for a refusal that was about something else. */
      readonly unoffered: string;
    };

/**
 * An SSH Agent login that went ahead with no agent key ends, if the server
 * refuses everything else, in ssh2's "All configured authentication methods
 * failed" — which names neither the agent nor a fix. While the server has
 * judged nothing the user typed, the agent is the whole story and its own
 * explanation replaces that failure. Once a keyboard-interactive answer went
 * in (a device's "Password:" prompt), the same failure means that answer was
 * refused — an `auth` failure exactly as it was before agent discovery — so it
 * is kept, with the missing agent added as context in words no classifier
 * branch reads as anything else. Any other failure (network, host key, a
 * cancelled prompt) is not the agent's doing and passes through as it is.
 */
function explainAgentShortfall(agent: AgentForLogin | undefined, error: Error, answeredKeyboardInteractive: boolean): Error {
  if (!agent?.ifRefused || !/all configured authentication methods failed/i.test(error.message)) {
    return error;
  }
  if (answeredKeyboardInteractive) {
    return Object.assign(new Error(`${error.message} (no SSH agent key was offered: ${agent.unoffered})`, { cause: error }), {
      level: (error as { level?: unknown }).level
    });
  }
  return new SshAgentUnavailableError(agent.ifRefused.message, { cause: error });
}

const AGENT_KEY_CHECK_TIMEOUT_MS = 5_000;

/** ssh2's OpenSSHAgent reports every failure before its socket connects as exactly this. */
const SSH2_AGENT_CONNECT_FAILURE = "Failed to connect to agent";

/**
 * How many keys the agent at `path` offers. Asked before dialling, so a
 * missing, hung or empty agent is reported as itself rather than as a failed
 * login. The timeout keeps a hung agent from hanging the connect, and the
 * connect's own cancellation stops it at once.
 *
 * ssh2 opens the agent's socket through the agent's `getStream` (OpenSSHAgent,
 * and CygwinAgent, which inherits it), so that is wrapped to keep the socket:
 * a check that gives up closes it instead of leaving one open per connect to
 * a hung agent. A socket still connecting when the check gives up is not yet
 * handed over and is left to fail or close on its own.
 */
export function countAgentKeys(path: string, signal?: AbortSignal, timeoutMs = AGENT_KEY_CHECK_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const agent = createAgent(path);
    let stream: Duplex | undefined;
    const getStream = agent.getStream?.bind(agent);
    if (getStream) {
      agent.getStream = (cb) =>
        getStream((error, opened) => {
          stream = opened;
          cb(error, opened);
        });
    }
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      outcome();
    };
    const giveUp = (reason: Error): void =>
      settle(() => {
        stream?.destroy();
        reject(reason);
      });
    const onAbort = (): void => giveUp(abortReason(signal!));
    const timer = setTimeout(() => giveUp(new Error(`it did not answer within ${timeoutMs / 1000} seconds`)), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    agent.getIdentities((error, keys) => settle(() => (error ? reject(error) : resolve(keys?.length ?? 0))));
  });
}

/** How an SSH Agent login finds its agent; both read on every connect. */
export interface SshAgentAccess {
  /** Throws `SshAgentUnavailableError` with the remedy as its message. */
  resolve(): SshAgentChoice;
  countKeys(path: string, signal?: AbortSignal): Promise<number>;
}

export class Ssh2Connector implements SshConnector {
  private connectionOptions: Required<SshConnectionOptions>;
  private readonly agentAccess: SshAgentAccess;

  public constructor(
    private readonly hostKeyVerifier?: HostKeyVerifier,
    connectionOptions?: SshConnectionOptions,
    private readonly diagnostics?: (line: string) => void,
    agentAccess?: Partial<SshAgentAccess>
  ) {
    this.connectionOptions = normalizeConnectionOptions(connectionOptions);
    this.agentAccess = {
      resolve: agentAccess?.resolve ?? (() => resolveSshAgent(hostSshAgentLookup({ mode: "auto", customPath: "" }))),
      countKeys: agentAccess?.countKeys ?? countAgentKeys
    };
  }

  public updateConnectionOptions(connectionOptions: SshConnectionOptions): void {
    this.connectionOptions = normalizeConnectionOptions(connectionOptions);
  }

  /**
   * Resolved on every connect — pooled, jump-host and tunnel connections
   * included — so a change to `nexus.ssh.agent`, or Pageant starting, applies
   * at the next login. A pooled connection already open is reused without
   * one, so it keeps the agent it logged in with until it closes (idle
   * timeout or Reload Window). A choice that cannot be honoured is refused here,
   * before anything is dialled. "No agent key to offer" (nothing found in auto
   * mode, or an empty agent) is not: those logins always went on to the
   * server's other methods, typically a keyboard-interactive password prompt,
   * and still do.
   */
  private async agentForLogin(label: string, signal?: AbortSignal): Promise<AgentForLogin> {
    let choice: SshAgentChoice;
    try {
      choice = this.agentAccess.resolve();
    } catch (error) {
      if (error instanceof SshAgentUnavailableError && error.proceedWithoutAgent) {
        this.diagnostics?.(`[agent] ${label}: none found, trying the server's other login methods — ${error.message}`);
        return { ifRefused: error, unoffered: "no agent was found" };
      }
      this.diagnostics?.(`[agent] ${label}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    const where = `${SSH_AGENT_SOURCE_LABELS[choice.source]} at ${choice.agent} (${choice.note})`;
    let keys: number;
    try {
      keys = await this.agentAccess.countKeys(choice.agent, signal);
    } catch (error) {
      // A cancel is the user's, not the agent's: it must stay a cancel.
      throwIfAborted(signal);
      const detail = error instanceof Error ? error.message : String(error);
      if (choice.ifUnreachable && detail === SSH2_AGENT_CONNECT_FAILURE) {
        this.diagnostics?.(
          `[agent] ${label}: nothing answers at ${where}, so no agent was found; trying the server's other login methods`
        );
        return { ifRefused: choice.ifUnreachable, unoffered: "no agent was found" };
      }
      this.diagnostics?.(`[agent] ${label}: ${where} cannot be used — ${detail}`);
      // The agent came from this machine's lookup, so this is its platform.
      throw new SshAgentUnavailableError(sshAgentUnusableMessage(choice, error, process.platform), { cause: error });
    }
    if (keys === 0) {
      this.diagnostics?.(`[agent] ${label}: ${where} holds no keys, trying the server's other login methods`);
      return {
        ifRefused: new SshAgentUnavailableError(sshAgentHoldsNoKeysMessage(choice), { proceedWithoutAgent: true }),
        unoffered: "the agent holds no keys"
      };
    }
    this.diagnostics?.(`[agent] ${label}: ${where} — ${keys} ${keys === 1 ? "key" : "keys"}`);
    return { path: choice.agent };
  }

  public async connect(
    server: ServerConfig,
    { externalCredential, password, passphrase, sock, onKeyboardInteractive, onAuthMessage, interaction, signal }: {
      externalCredential?: ResolvedExternalCredential;
      password?: string;
      passphrase?: string;
      sock?: Duplex;
      onKeyboardInteractive?: KeyboardInteractiveHandler;
      onAuthMessage?: (text: string) => boolean | void;
      interaction?: "interactive" | "noninteractive";
      signal?: AbortSignal;
    }
  ): Promise<SshConnection> {
    const label = `${server.name} (${server.host})`;
    throwIfAborted(signal);
    if (externalCredential && (password !== undefined || passphrase !== undefined)) {
      throw new Error("External credentials cannot be combined with password or passphrase authentication.");
    }
    let failInteraction: (() => void) | undefined;
    let external = externalCredential ? createExternalSshAuthentication(externalCredential, {
      onInteractionRequired: () => failInteraction?.()
    }) : undefined;
    externalCredential = undefined;
    let config: ConnectConfig | undefined;
    let agent: AgentForLogin | undefined;
    try {
      agent = !external && server.authType === "agent" ? await this.agentForLogin(label, signal) : undefined;
      config = await buildConnectConfig(server, password, passphrase, sock, this.connectionOptions, agent?.path, external?.connectOptions);
      passphrase = undefined;
      throwIfAborted(signal);
    } catch (error) {
      external?.dispose();
      throw error;
    }
    let hostKeyError: unknown;
    if (this.hostKeyVerifier) {
      config.hostVerifier = (hostKey: Buffer | string, verify: VerifyCallback): void => {
        const rawHostKey = Buffer.isBuffer(hostKey) ? hostKey : Buffer.from(hostKey, "hex");
        void this.hostKeyVerifier!.verify(server, rawHostKey, {
          ...(interaction && { interaction }),
          ...(signal && { signal })
        }).then(
          (allowed) => verify(allowed),
          (error: unknown) => {
            hostKeyError = error;
            verify(false);
          }
        );
      };
    }
    const client = new Client();
    return new Promise((resolve, reject) => {
      let settled = false;
      const authAbort = new AbortController();
      const onExternalAbort = (): void => {
        if (!settled) {
          settled = true;
          reject(signal ? abortReason(signal) : new AuthNotJudgedError("SSH connection attempt was canceled"));
        }
        cleanupAuthentication();
        client.end();
      };
      const removeExternalAbort = (): void => signal?.removeEventListener("abort", onExternalAbort);
      let banner: string | undefined;
      // Whether the server has been sent anything typed for it to judge — see
      // explainAgentShortfall: after that, a refusal is the answer's, not the
      // missing agent's.
      let answeredKeyboardInteractive = false;
      const answer = (finish: (responses: string[]) => void, responses: string[]): void => {
        if (responses.some((response) => response !== "")) {
          answeredKeyboardInteractive = true;
        }
        finish(responses);
      };
      const onBanner = (message: string): void => {
        // A live sink handles banners immediately, so getBanner() must stay
        // empty and sshPty.ts will not print them a second time. A pooled
        // handshake may begin without a terminal and gain one while pending;
        // its router returns false until a sink joins, preserving the banner.
        if (onAuthMessage) {
          // Legacy getBanner() consumers still see blank banners (unchanged
          // buffering below); the live sink only wants non-blank messages.
          if (!message.trim()) return;
          try {
            if (onAuthMessage(message) !== false) return;
          } catch {
            // Display is best-effort — a throwing sink must not unwind
            // ssh2's protocol handler mid-handshake or abort auth.
            return;
          }
        }
        banner = message;
      };
      const handleKeyboard = (name: string, instructions: string, _lang: string, prompts: import("ssh2").Prompt[], finish: (responses: string[]) => void): void => {
        if (onKeyboardInteractive) {
          const mapped = prompts.map((p) => ({
            prompt: p.prompt,
            echo: p.echo ?? false
          }));
          onKeyboardInteractive(name, instructions, mapped, authAbort.signal).then(
            (responses) => {
              if (!authAbort.signal.aborted) answer(finish, responses);
            },
            (error) => {
              if (authAbort.signal.aborted) return;
              if (!settled) { settled = true; reject(error); }
              cleanupAuthentication();
              client.end();
            }
          );
          return;
        }
        // Legacy fallback: auto-fill password for all prompts
        if (password) {
          answer(finish, prompts.map(() => password!));
          return;
        }
        finish([]);
      };
      const cleanupAuthentication = (): void => {
        authAbort.abort();
        removeExternalAbort();
        external?.dispose();
        external = undefined;
        password = undefined;
        onKeyboardInteractive = undefined;
        failInteraction = undefined;
        config = undefined;
        client.removeListener("keyboard-interactive", handleKeyboard);
        client.removeListener("banner", onBanner);
        client.removeListener("ready", onReady);
      };
      const onReady = (): void => {
        if (settled) return;
        cleanupAuthentication();
        settled = true;
        resolve(new Ssh2Connection(client, banner, label, this.diagnostics));
      };
      client.on("error", (error: Error) => {
        cleanupAuthentication();
        if (!settled) {
          settled = true;
          // Pre-ready errors are the caller's to handle and MUST stay a plain
          // rejection — the connect flow (auth retry, host-key prompts) reads
          // them. Nothing is logged here on purpose.
          reject(hostKeyError instanceof Error ? hostKeyError : explainAgentShortfall(agent, error, answeredKeyboardInteractive));
          return;
        }
        // Post-ready these used to be dropped on the floor, which is why a
        // keepalive timeout (30s of silence -> sock.destroy()) or a protocol
        // error surfaced to the user as nothing but "Connection lost" on every
        // tab, with no way to learn the cause. ssh2 tags them via `err.level`
        // ("client-timeout", "protocol", ...).
        const level = (error as { level?: string }).level;
        this.diagnostics?.(
          `[ssh] ${label}: post-ready client error: ${error.message}${level ? ` (level: ${level})` : ""}`
        );
      });
      client.on("close", () => {
        cleanupAuthentication();
        if (!settled) {
          settled = true;
          reject(hostKeyError instanceof Error ? hostKeyError : new AuthNotJudgedError("SSH connection closed before authentication completed"));
        }
      });
      failInteraction = (): void => {
        if (settled) return;
        settled = true;
        reject(new SshInteractionRequiredError("External SSH authentication requires an unsupported interactive response."));
        cleanupAuthentication();
        client.end();
      };
      client.on("banner", onBanner);
      if (!external) client.on("keyboard-interactive", handleKeyboard);
      client.on("ready", onReady);
      signal?.addEventListener("abort", onExternalAbort, { once: true });
      if (signal?.aborted) { onExternalAbort(); return; }
      try {
        client.connect(config!);
      } catch (error) {
        cleanupAuthentication();
        settled = true;
        reject(error);
        client.end();
      }
    });
  }
}
