import * as net from "node:net";
import type { Duplex } from "node:stream";
import { SocksClient } from "socks";
import type { ServerConfig, ProxyConfig, Socks5Proxy, HttpConnectProxy } from "../../models/config";
import { normalizeBoundedNumber } from "../../utils/helpers";
import type {
  ContextAwareSshFactory,
  SecretVault,
  SshConnectContext,
  SshConnection
} from "./contracts";
import { ProxiedSshConnection, jumpHostCleanup, socketCleanup, socketCloseRelay } from "./proxiedSshConnection";
import type { SilentAuthSshFactory } from "./silentAuth";
import { proxyPasswordSecretKey } from "./silentAuth";
import { isSameAuthenticatedEndpoint } from "../inventory/proxySecretHygiene";
import { configMutationLock } from "../configMutationLock";
import { telnetUnsupportedMessage } from "../../utils/protocolGuards";

const MAX_HTTP_RESPONSE_SIZE = 65536; // 64KB — more than enough for CONNECT headers

/**
 * Per-connect proxy-password prompt (design doc §5.3; §11 OQ2). §5.3 said a
 * template's authenticated socks5/http proxy "gets the existing per-connect
 * password prompt behavior" — but that prompt was assumed-but-never-built:
 * `connectViaSocks5` / `connectViaHttpConnect` only did `vault.get` and sent
 * `proxyPassword ?? ""`, so after a template applied an authenticated proxy
 * (templates carry no secret, and the round-2 hygiene sweeps any stale
 * `proxy-password-{id}`) the connection sent an empty password and failed. This
 * OPTIONAL dependency realizes that prompt: when present it is fired only for a
 * username-bearing proxy whose vault lookup returned nothing, at the SAME await
 * point the `vault.get` already happens (preserving the socket/banner IPC
 * ordering). Absent ⇒ exactly the prior behavior (backward-compatible). On a
 * saved success the password is stored under `proxyPasswordSecretKey(id)` so it
 * is one-time; a later template endpoint change re-clears it via the existing
 * hygiene → re-prompt next connect, exactly §5.3.
 */
export type ProxyPasswordPrompt = (
  server: ServerConfig,
  proxy: Socks5Proxy | HttpConnectProxy
) => Promise<{ password: string; save: boolean } | undefined>;

/**
 * Resolution of the per-connect proxy password. `password` is fed to the
 * handshake exactly as before. `storeOnSuccess`, when present, is a deferred
 * best-effort persist descriptor: the caller stores it ONLY after
 * `authFactory.connect` resolves (proxy handshake + ssh auth both succeeded),
 * so a mistyped first-time password is never persisted (which would otherwise
 * lock the proxy out of every later connect via the `stored !== undefined`
 * early-return).
 */
interface ResolvedProxyPassword {
  password: string | undefined;
  storeOnSuccess?: { key: string; value: string };
}

function normalizeProxyTimeoutMs(timeoutMs: number): number {
  return normalizeBoundedNumber(timeoutMs, 60_000, 5_000, 300_000);
}

export class ProxySshFactory implements ContextAwareSshFactory {
  private proxyTimeoutMs: number;
  private jumpHostFactory?: ContextAwareSshFactory;

  public constructor(
    private readonly authFactory: SilentAuthSshFactory,
    private readonly serverLookup: (id: string) => ServerConfig | undefined,
    private readonly vault: SecretVault,
    proxyTimeoutMs: number = 60_000,
    // OPTIONAL — see `ProxyPasswordPrompt`. Absent ⇒ today's `?? ""` behavior
    // unchanged (backward-compatible; existing constructions and tests keep
    // working). Only the socks5/http (password-bearing) paths consult it.
    private readonly promptProxyPassword?: ProxyPasswordPrompt
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
      return context?.onAuthMessage
        ? this.authFactory.connect(server, { onAuthMessage: context.onAuthMessage })
        : this.authFactory.connect(server);
    }
    return this.connectViaProxy(server, server.proxy, context?.proxyVisited ?? new Set<string>(), context?.onAuthMessage);
  }

  private async connectViaProxy(
    server: ServerConfig,
    proxy: ProxyConfig,
    visited: ReadonlySet<string>,
    onAuthMessage?: (text: string) => void
  ): Promise<SshConnection> {
    switch (proxy.type) {
      case "ssh":
        return this.connectViaSshJump(server, proxy.jumpHostId, visited, onAuthMessage);
      case "socks5":
        return this.connectViaSocks5(server, proxy, onAuthMessage);
      case "http":
        return this.connectViaHttpConnect(server, proxy, onAuthMessage);
    }
  }

  private async connectViaSshJump(
    target: ServerConfig,
    jumpHostId: string,
    visited: ReadonlySet<string>,
    onAuthMessage?: (text: string) => void
  ): Promise<SshConnection> {
    const nextVisited = this.addToVisited(visited, target);
    const jumpServer = this.serverLookup(jumpHostId);
    if (!jumpServer) {
      throw new Error(`Jump host server not found (id: ${jumpHostId})`);
    }

    // TELNET (Phase 0, MAJOR-3) — a jump host must speak SSH. The form no longer
    // OFFERS a telnet server here, but the stored id outlives that: a server can
    // be switched to Telnet long after another server named it, and no picker
    // can retract a choice already saved. Without this the chain handed the
    // telnet server to `SilentAuthSshFactory` — a vault read and a password
    // prompt for a host that has no SSH login — and then failed with a raw ssh2
    // handshake error against port 23. Refused BEFORE `connectToJumpHost`, so
    // no credential is ever read or requested.
    const jumpUnsupported = telnetUnsupportedMessage(jumpServer, "Use as an SSH jump host");
    if (jumpUnsupported) {
      throw new Error(jumpUnsupported);
    }

    this.assertNoCircularProxyChain(jumpServer, nextVisited);
    // ALTERNATE HOST (issue #48, PR #67 Codex round 2) — tag a jump-host CONNECTION
    // failure with jump-host provenance so `classifySshConnectionError` labels it
    // `proxy` instead of the raw `tcp`/`dns` of the underlying socket error. The SSH
    // terminal's alternate-host fallback (`SshPty`) excludes the `proxy` stage, so it
    // will NOT retry the target's `altHost` through a jump host that is itself
    // unreachable — both attempts would traverse the same failed hop, wasting a retry
    // and, for unsaved credentials, repeating the pre-connect prompt. A failure that
    // reaches the TARGET transport (below, through an established tunnel) keeps its own
    // `tcp`/`dns` stage and still triggers the fallback, which correctly re-dials the
    // target's alternate address VIA the (working) jump host.
    let jumpConnection: SshConnection;
    try {
      jumpConnection = await this.connectToJumpHost(jumpServer, nextVisited, onAuthMessage);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Jump host connection failed (${jumpServer.name}): ${detail}`);
    }

    // Each auth attempt gets its own TCP tunnel through the jump host.
    const sockFactory = async (): Promise<Duplex> => {
      const s = await jumpConnection.openDirectTcp(target.host, target.port);
      // Pause the tunnel stream to prevent the target's SSH banner from being
      // lost during the async gap before ssh2 attaches its data listeners
      // (vault password lookup, buildConnectConfig, etc.).
      // Same banner-loss issue as the SOCKS5 fix below (see connectViaSocks5).
      s.pause();
      return s;
    };

    let targetConnection: SshConnection;
    try {
      targetConnection = await this.authFactory.connect(target, {
        sockFactory,
        ...(onAuthMessage && { onAuthMessage })
      });
    } catch (error) {
      jumpConnection.dispose();
      throw error;
    }

    return new ProxiedSshConnection(
      targetConnection,
      jumpHostCleanup(jumpConnection),
      (listener) => jumpConnection.onClose(listener)
    );
  }

  private async connectViaSocks5(
    target: ServerConfig,
    proxy: Socks5Proxy,
    onAuthMessage?: (text: string) => void
  ): Promise<SshConnection> {
    const { password: proxyPassword, storeOnSuccess } = await this.resolveProxyPassword(target, proxy);

    // Track the most recently opened socket so the ProxiedSshConnection wrapper
    // can relay close events from whichever socket backed the successful attempt.
    let lastSock: net.Socket | undefined;

    const sockFactory = async (): Promise<net.Socket> => {
      let socket: net.Socket;
      try {
        ({ socket } = await SocksClient.createConnection({
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
        }));
      } catch (error) {
        // ALTERNATE HOST (issue #48, PR #67 Codex round 4) — a failure ESTABLISHING the
        // SOCKS proxy tunnel (proxy unreachable/refused, or the proxy cannot reach the
        // target) is a PROXY-stage failure, not a target `tcp`/`dns` one. SocksClient
        // surfaces raw `ECONNREFUSED`/`ETIMEDOUT` with no "proxy"/"socks" text, which the
        // reordered `classifySshConnectionError` (concrete errno BEFORE the broad proxy
        // keyword — round 3 P2a) would otherwise label `tcp`, causing `SshPty` to retry
        // the target's `altHost` through the SAME failed proxy (futile, and repeats the
        // proxy/password prompt). Tag it with the structured "Proxy connection failed"
        // marker so it classifies `proxy` (fallback excluded), mirroring the jump-host
        // wrap in connectViaSshJump. Target SSH-handshake failures happen AFTER this
        // sockFactory resolves and keep their own true stage.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Proxy connection failed (socks5 ${proxy.host}:${proxy.port}): ${detail}`);
      }

      // The socks library schedules setImmediate(() => socket.resume()) after the
      // SOCKS5 handshake completes. If there's any async gap before ssh2 takes the
      // socket (e.g., password lookup from SecretStorage), the premature resume causes
      // the SSH server's banner data to be lost — no data listeners are attached yet,
      // so flowing data is discarded, leading to "Timed out while waiting for handshake".
      // Fix: wait for the deferred resume to fire, then re-pause so ssh2 can take over.
      await new Promise<void>((r) => setImmediate(r));
      socket.pause();

      lastSock = socket;
      return socket;
    };

    const connection = await this.authFactory.connect(target, {
      sockFactory,
      ...(onAuthMessage && { onAuthMessage })
    });
    // The connection succeeded (proxy handshake + ssh auth). Now persist a freshly
    // prompted, save-flagged password — deferred to here so a mistyped first-time
    // secret is never stored before the handshake, and kept OUT of the timing-
    // sensitive sockFactory (setImmediate/resume banner-loss path). Best-effort: a
    // keychain-store failure must not abort an already-established connection.
    if (storeOnSuccess) {
      await this.persistProxyPasswordIfEndpointUnchanged(target, proxy, storeOnSuccess);
    }
    // lastSock is guaranteed to be defined here: a successful authFactory.connect
    // means sockFactory was called and resolved at least once.
    return new ProxiedSshConnection(connection, socketCleanup(lastSock!), socketCloseRelay(lastSock!));
  }

  private async connectViaHttpConnect(
    target: ServerConfig,
    proxy: HttpConnectProxy,
    onAuthMessage?: (text: string) => void
  ): Promise<SshConnection> {
    const { password: proxyPassword, storeOnSuccess } = await this.resolveProxyPassword(target, proxy);

    // Track the most recently opened socket so the ProxiedSshConnection wrapper
    // can relay close events from whichever socket backed the successful attempt.
    let lastSock: net.Socket | undefined;

    const sockFactory = async (): Promise<net.Socket> => {
      let socket: net.Socket;
      try {
        socket = await this.httpConnectHandshake(
          proxy.host,
          proxy.port,
          target.host,
          target.port,
          proxy.username,
          proxyPassword
        );
      } catch (error) {
        // ALTERNATE HOST (issue #48, PR #67 Codex round 4) — see the SOCKS wrap in
        // connectViaSocks5. `httpConnectHandshake` rejects with "HTTP CONNECT proxy
        // error: connect ECONNREFUSED …" when the proxy socket is unreachable; the
        // reordered classifier matches that concrete `econnrefused` BEFORE the broad
        // proxy keyword and would label it `tcp`, wrongly triggering the target
        // `altHost` retry through the same dead proxy. Tag proxy-tunnel-establishment
        // failures with the structured "Proxy connection failed" marker so they
        // classify `proxy` (fallback excluded). Target SSH-handshake failures happen
        // after this resolves and are unaffected.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Proxy connection failed (http ${proxy.host}:${proxy.port}): ${detail}`);
      }
      lastSock = socket;
      return socket;
    };

    const connection = await this.authFactory.connect(target, {
      sockFactory,
      ...(onAuthMessage && { onAuthMessage })
    });
    // The connection succeeded (proxy handshake + ssh auth). Now persist a freshly
    // prompted, save-flagged password — deferred to here so a mistyped first-time
    // secret is never stored before the handshake, and kept OUT of the timing-
    // sensitive sockFactory (setImmediate/resume banner-loss path). Best-effort: a
    // keychain-store failure must not abort an already-established connection.
    if (storeOnSuccess) {
      await this.persistProxyPasswordIfEndpointUnchanged(target, proxy, storeOnSuccess);
    }
    // lastSock is guaranteed to be defined here: a successful authFactory.connect
    // means sockFactory was called and resolved at least once.
    return new ProxiedSshConnection(connection, socketCleanup(lastSock!), socketCloseRelay(lastSock!));
  }

  /**
   * Store-side twin of `clearStaleProxyPasswordSecretsBeforeApply`
   * (proxySecretHygiene.ts). The invariant BOTH enforce: never leave a
   * `proxy-password-{id}` that doesn't match the server's CURRENT authenticated
   * endpoint — the clear side enforces it on delete, this enforces it on the
   * deferred store.
   *
   * SECURITY (issue #48 PR-T1b / PR #62 Codex round 8) — the deferred store key is
   * server-id-only, so a concurrent connect that read the OLD server config and
   * prompted for the OLD proxy's password can reach this post-connect store AFTER a
   * template apply has already cleared `proxy-password-{id}` and published a NEW
   * proxy endpoint. Storing unconditionally would repopulate the key with the OLD
   * endpoint's credential, which the factory would then send to the server's NEW
   * proxy — the exact leak the pre-apply hygiene prevents, recreated on the store
   * side. Guard: re-read the live server and store ONLY IF it still names the SAME
   * authenticated endpoint this connection actually used. A live proxy that is
   * undefined, a different endpoint, a different type, or ssh/none means the
   * endpoint changed under us → skip the store (the stale credential must not be
   * repopulated). Best-effort throughout: a lookup miss or a keychain-store failure
   * must never abort an already-established connection. `connectionProxy` is
   * password-bearing socks5/http (we only reach the prompt/store path for a
   * username-bearing proxy), so `isSameAuthenticatedEndpoint` compares like-for-like.
   *
   * SECURITY (issue #48 PR-T1b / PR #62 Codex round 9) — the round-8 re-read closed
   * the ordering hole but not the ATOMICITY hole: the sync `serverLookup` re-read +
   * `isSameAuthenticatedEndpoint` check and the async `await this.vault.store(...)`
   * were two separate steps, not one critical section. A template apply's
   * clear-then-publish (`clearStaleProxyPasswordSecretsBeforeApply` → publish new
   * endpoint) could land in the await window BETWEEN a passing check and the store
   * completing: the check saw the still-old endpoint and passed, then the apply
   * cleared `proxy-password-{id}` and published the NEW proxy, then the pending
   * store wrote the OLD endpoint's credential back under the server-only key — sent
   * to the new proxy = the same leak, again. Fix: run the re-read + check + store as
   * a single critical section under `configMutationLock` — the SAME lock the template
   * apply (manual and sync) holds across its clear+publish. With them mutually
   * exclusive, both orderings are safe: (a) store-then-apply — the store writes while
   * the endpoint is still old, then the apply's pre-publish clear deletes it before
   * publishing the new proxy; (b) apply-then-store — the apply clears+publishes first,
   * then the store re-reads the NEW endpoint, `isSameAuthenticatedEndpoint` is false,
   * and it skips. No interleaving leaves a mismatched secret.
   *
   * NO REENTRANCY: `configMutationLock` is NOT re-entrant, but the proxy connect/store
   * path is otherwise lock-free — it runs AFTER `authFactory.connect` resolved and
   * never itself holds the lock (mirrors the command-layer discipline: the connect
   * path is a lock-free consumer that briefly takes the lock only for this store), so
   * acquiring it here cannot deadlock. Accepted cost: a first-time proxy-authenticated
   * connection's password store briefly waits for any in-flight config mutation
   * (sync/apply) to release the lock before the connection object is returned — rare
   * (only the first prompt for a server's proxy), short, and the correctness win is
   * the point. The whole thing stays best-effort inside the try/catch.
   */
  private async persistProxyPasswordIfEndpointUnchanged(
    target: ServerConfig,
    connectionProxy: Socks5Proxy | HttpConnectProxy,
    storeOnSuccess: { key: string; value: string }
  ): Promise<void> {
    try {
      // Atomic w.r.t. the template apply's clear+publish (which holds the same lock):
      // re-read + endpoint check + store are one critical section, so no apply can
      // interleave between the check passing and the store completing.
      await configMutationLock.runExclusive(async () => {
        const live = this.serverLookup(target.id);
        if (live && isSameAuthenticatedEndpoint(live.proxy, connectionProxy)) {
          await this.vault.store(storeOnSuccess.key, storeOnSuccess.value);
        }
      });
    } catch {
      /* best-effort — a keychain-store failure must not abort an established connection */
    }
  }

  /**
   * Resolve the proxy password at the SAME await point the connect paths used to
   * call `vault.get` (do NOT move — it preserves the documented socket/banner IPC
   * ordering). Realizes the §5.3 per-connect prompt that was assumed-but-unbuilt:
   * a username-bearing proxy whose vault lookup returns nothing consults the
   * optional prompt (when wired). A saved success is NOT stored here — it is
   * returned as a `storeOnSuccess` descriptor and persisted by the caller ONLY
   * after `authFactory.connect` resolves (deferred, post-connect, best-effort),
   * so a mistyped first-time password is never persisted before the handshake
   * (which would lock the proxy out of every later connect). A cancelled prompt,
   * an absent prompt dependency, or a proxy without a username all fall back to
   * the prior behavior (`undefined` → `?? ""` downstream) with no behavior change.
   */
  private async resolveProxyPassword(
    target: ServerConfig,
    proxy: Socks5Proxy | HttpConnectProxy
  ): Promise<ResolvedProxyPassword> {
    if (!proxy.username) {
      return { password: undefined };
    }
    const stored = await this.vault.get(proxyPasswordSecretKey(target.id));
    if (stored !== undefined) {
      return { password: stored };
    }
    if (this.promptProxyPassword) {
      const result = await this.promptProxyPassword(target, proxy);
      if (result) {
        return {
          password: result.password,
          ...(result.save && {
            storeOnSuccess: { key: proxyPasswordSecretKey(target.id), value: result.password }
          })
        };
      }
    }
    return { password: undefined };
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
    visited: ReadonlySet<string>,
    onAuthMessage?: (text: string) => void
  ): Promise<SshConnection> {
    if (this.jumpHostFactory) {
      return this.jumpHostFactory.connectWithContext(jumpServer, { proxyVisited: visited, ...(onAuthMessage && { onAuthMessage }) });
    }
    if (jumpServer.proxy) {
      return this.connectWithContext(jumpServer, { proxyVisited: visited, ...(onAuthMessage && { onAuthMessage }) });
    }
    return onAuthMessage ? this.authFactory.connect(jumpServer, { onAuthMessage }) : this.authFactory.connect(jumpServer);
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
