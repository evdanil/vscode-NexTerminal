import type { Duplex } from "node:stream";
import type { SFTPWrapper } from "ssh2";
import type { ServerConfig } from "../../models/config";
import type {
  ContextAwareSshFactory,
  PtyOptions,
  SshConnectContext,
  SshConnection,
  SshFactory,
  SshPoolControl,
  TcpConnectionInfo
} from "./contracts";
import { hasContextAwareConnect } from "./contracts";
import { isStaleConnectionError, shouldFallbackForChannelLimit } from "./channelErrors";

export interface PoolOptions {
  enabled: boolean;
  idleTimeoutMs: number;
}

export type PoolEvent =
  | { type: "connected"; serverId: string }
  | { type: "disconnected"; serverId: string };

interface PoolEntry {
  connection: SshConnection;
  refCount: number;
  healthy: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  closeUnsubscribe: () => void;
}

const MAX_IDLE_TIMEOUT_MS = 3_600_000;

class PooledSshConnection implements SshConnection {
  private disposed = false;
  private readonly closeUnsubscribes: Array<() => void> = [];
  private fallbackConnection?: SshConnection;
  private fallbackUsed = false;

  public constructor(
    private readonly inner: SshConnection,
    private onRelease: () => void,
    private readonly createFallback?: () => Promise<SshConnection>,
    private readonly isReused = false
  ) {}

  private get active(): SshConnection {
    return this.fallbackUsed && this.fallbackConnection ? this.fallbackConnection : this.inner;
  }

  public async openShell(ptyOptions?: PtyOptions): Promise<Duplex> {
    this.assertNotDisposed();
    try {
      return await this.active.openShell(ptyOptions);
    } catch (err) {
      if (this.shouldAttemptFallback(err)) {
        const fb = await this.tryFallback();
        if (fb) {
          return fb.openShell(ptyOptions);
        }
      }
      throw err;
    }
  }

  public async openDirectTcp(remoteIP: string, remotePort: number): Promise<Duplex> {
    this.assertNotDisposed();
    try {
      return await this.active.openDirectTcp(remoteIP, remotePort);
    } catch (err) {
      if (this.shouldAttemptFallback(err)) {
        const fb = await this.tryFallback();
        if (fb) {
          return fb.openDirectTcp(remoteIP, remotePort);
        }
      }
      throw err;
    }
  }

  public async openSftp(): Promise<SFTPWrapper> {
    this.assertNotDisposed();
    try {
      return await this.active.openSftp();
    } catch (err) {
      if (this.shouldAttemptFallback(err)) {
        const fb = await this.tryFallback();
        if (fb) {
          return fb.openSftp();
        }
      }
      throw err;
    }
  }

  public async exec(command: string): Promise<Duplex> {
    this.assertNotDisposed();
    try {
      return await this.active.exec(command);
    } catch (err) {
      if (this.shouldAttemptFallback(err)) {
        const fb = await this.tryFallback();
        if (fb) {
          return fb.exec(command);
        }
      }
      throw err;
    }
  }

  public requestForwardIn(bindAddr: string, bindPort: number): Promise<number> {
    this.assertNotDisposed();
    return this.active.requestForwardIn(bindAddr, bindPort);
  }

  public cancelForwardIn(bindAddr: string, bindPort: number): Promise<void> {
    this.assertNotDisposed();
    return this.active.cancelForwardIn(bindAddr, bindPort);
  }

  public onTcpConnection(
    handler: (info: TcpConnectionInfo, accept: () => Duplex, reject: () => void) => void
  ): () => void {
    this.assertNotDisposed();
    return this.active.onTcpConnection(handler);
  }

  public onClose(listener: () => void): () => void {
    this.assertNotDisposed();
    const unsub = this.active.onClose(listener);
    this.closeUnsubscribes.push(unsub);
    return () => {
      const idx = this.closeUnsubscribes.indexOf(unsub);
      if (idx >= 0) {
        this.closeUnsubscribes.splice(idx, 1);
      }
      unsub();
    };
  }

  public getBanner(): string | undefined {
    return this.active.getBanner();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const unsub of this.closeUnsubscribes) {
      unsub();
    }
    this.closeUnsubscribes.length = 0;
    this.onRelease();
  }

  private fallbackPromise?: Promise<SshConnection | undefined>;

  private shouldAttemptFallback(error: unknown): boolean {
    if (this.fallbackUsed || !this.createFallback) return false;
    // Stale connections ("Not connected") should always retry — the pooled
    // socket is dead but the close event hasn't fired yet.
    if (isStaleConnectionError(error)) return true;
    // Channel-limit fallback only makes sense on reused connections where
    // the server refuses additional channels on the multiplexed session.
    return this.isReused && shouldFallbackForChannelLimit(error);
  }

  private tryFallback(): Promise<SshConnection | undefined> {
    if (this.fallbackUsed) {
      return Promise.resolve(this.fallbackConnection);
    }
    if (!this.createFallback) {
      return Promise.resolve(undefined);
    }
    // Cache the promise so concurrent callers share a single fallback attempt
    if (!this.fallbackPromise) {
      this.fallbackPromise = this.executeFallback();
    }
    return this.fallbackPromise;
  }

  private async executeFallback(): Promise<SshConnection | undefined> {
    try {
      this.fallbackConnection = await this.createFallback!();
      this.fallbackUsed = true;
      // Release the pooled reference — we no longer use it
      this.onRelease();
      // Future dispose should clean up the standalone connection
      this.onRelease = () => this.fallbackConnection?.dispose();
      return this.fallbackConnection;
    } catch {
      this.fallbackUsed = true; // prevent retries
      return undefined;
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Cannot use a disposed SSH connection lease");
    }
  }
}

export class SshConnectionPool implements ContextAwareSshFactory, SshPoolControl {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly pending = new Map<string, Promise<PoolEntry>>();
  private readonly listeners = new Set<(event: PoolEvent) => void>();
  // Per-server invalidation counter. A connect captures the value at handshake
  // start and re-checks it once the handshake settles; a bump in between means
  // the credentials/settings it authenticated with have since been replaced, so
  // the resulting connection must never be pooled. Bounded by the number of
  // configured servers.
  private readonly invalidationEpochs = new Map<string, number>();
  private disposed = false;

  public constructor(
    private readonly innerFactory: SshFactory,
    private readonly options: PoolOptions
  ) {}

  public onDidChange(listener: (event: PoolEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public connect(server: ServerConfig): Promise<SshConnection> {
    return this.connectWithContext(server);
  }

  public async connectWithContext(
    server: ServerConfig,
    context?: SshConnectContext
  ): Promise<SshConnection> {
    if (this.disposed) {
      throw new Error("Connection pool is disposed");
    }
    const multiplexingEnabled = server.multiplexing ?? this.options.enabled;
    if (!multiplexingEnabled) {
      return this.connectInner(server, context);
    }

    const entry = await this.getOrCreateEntry(server, context);
    this.cancelIdleTimer(entry);
    entry.refCount++;

    // Offer fallback: if a channel open fails on a multiplexed connection
    // (e.g. Cisco devices that reject additional channels) or the pooled
    // connection is stale ("Not connected"), automatically create a standalone
    // connection so the caller doesn't see the failure.
    // Soft-remove the pool entry (mark unhealthy, remove from map) but do NOT
    // dispose the underlying connection — other leases may still hold active
    // streams. The last lease to release will dispose it via orphan cleanup.
    const createFallback = async (): Promise<SshConnection> => {
      if (this.entries.get(server.id) === entry) {
        entry.healthy = false;
        this.cancelIdleTimer(entry);
        this.entries.delete(server.id);
        this.emit({ type: "disconnected", serverId: server.id });
      }
      return this.connectInner(server, context);
    };

    const isReused = entry.refCount > 1;

    return new PooledSshConnection(entry.connection, () => {
      entry.refCount--;
      if (entry.refCount === 0) {
        if (this.entries.get(server.id) === entry) {
          this.startIdleTimer(server.id, entry);
        } else {
          // Orphaned: entry was soft-removed from pool, dispose now
          entry.closeUnsubscribe();
          entry.connection.dispose();
        }
      }
    }, createFallback, isReused);
  }

  public disconnect(serverId: string): void {
    const entry = this.entries.get(serverId);
    if (!entry) {
      return;
    }
    this.evictEntry(serverId, entry);
  }

  public invalidate(serverId: string): void {
    // Bump the epoch first: a connect that is currently mid-handshake captured
    // the previous value and will see the mismatch when it settles, refusing to
    // install itself into `entries`. Without this, an invalidate that lands
    // during a slow handshake (2FA, proxy dial) is a silent no-op and the
    // connection authenticated with the now-superseded credentials becomes the
    // pooled, shared connection for every later terminal/tunnel/SFTP session —
    // callers of invalidate() (extension.ts deletes the stale proxy secret at
    // this point) assume the opposite.
    this.invalidationEpochs.set(serverId, this.invalidationEpoch(serverId) + 1);
    // Drop the in-flight connect from the join point so callers arriving from
    // now on start a fresh handshake instead of joining the stale one.
    this.pending.delete(serverId);

    const entry = this.entries.get(serverId);
    if (!entry) {
      return;
    }
    this.softRemoveEntry(serverId, entry);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const [serverId, entry] of this.entries) {
      this.cancelIdleTimer(entry);
      entry.closeUnsubscribe();
      entry.connection.dispose();
      this.emit({ type: "disconnected", serverId });
    }
    this.entries.clear();
    this.pending.clear();
    this.invalidationEpochs.clear();
    this.listeners.clear();
  }

  private async getOrCreateEntry(
    server: ServerConfig,
    context?: SshConnectContext
  ): Promise<PoolEntry> {
    const existing = this.entries.get(server.id);
    if (existing && existing.healthy) {
      return existing;
    }
    if (existing && !existing.healthy) {
      this.entries.delete(server.id);
      this.cancelIdleTimer(existing);
      existing.closeUnsubscribe();
    }

    const pendingPromise = this.pending.get(server.id);
    if (pendingPromise) {
      return pendingPromise;
    }

    const promise: Promise<PoolEntry> = this.createEntry(server, context).finally(() => {
      // Only clear the slot if it is still ours: invalidate() may have dropped
      // this connect from `pending` and a newer handshake may already hold it.
      if (this.pending.get(server.id) === promise) {
        this.pending.delete(server.id);
      }
    });
    this.pending.set(server.id, promise);
    return promise;
  }

  private invalidationEpoch(serverId: string): number {
    return this.invalidationEpochs.get(serverId) ?? 0;
  }

  private async createEntry(server: ServerConfig, context?: SshConnectContext): Promise<PoolEntry> {
    const epochAtStart = this.invalidationEpoch(server.id);
    const connection = await this.connectInner(server, context);

    if (this.disposed) {
      connection.dispose();
      throw new Error("Connection pool is disposed");
    }

    const entry: PoolEntry = {
      connection,
      refCount: 0,
      healthy: true,
      closeUnsubscribe: () => {}
    };

    if (this.invalidationEpoch(server.id) !== epochAtStart) {
      // invalidate() fired while this handshake was in flight, so the
      // connection carries pre-invalidation credentials/settings. Callers
      // already awaiting this promise still receive it — an in-flight request
      // cannot be retroactively failed without breaking them — but it is never
      // installed in `entries` and never announced as "connected", so no new
      // consumer can be handed it. It stays unhealthy and orphaned: the release
      // path in connectWithContext disposes the underlying connection as soon
      // as the last pre-invalidation lease is released.
      entry.healthy = false;
      return entry;
    }

    entry.closeUnsubscribe = connection.onClose(() => {
      entry.healthy = false;
      this.cancelIdleTimer(entry);
      if (this.entries.get(server.id) === entry) {
        this.entries.delete(server.id);
        this.emit({ type: "disconnected", serverId: server.id });
      }
    });

    this.entries.set(server.id, entry);
    this.emit({ type: "connected", serverId: server.id });
    return entry;
  }

  private evictEntry(serverId: string, entry: PoolEntry): void {
    this.cancelIdleTimer(entry);
    entry.closeUnsubscribe();
    this.entries.delete(serverId);
    entry.connection.dispose();
    this.emit({ type: "disconnected", serverId });
  }

  private softRemoveEntry(serverId: string, entry: PoolEntry): void {
    this.cancelIdleTimer(entry);
    entry.healthy = false;
    this.entries.delete(serverId);
    this.emit({ type: "disconnected", serverId });
    if (entry.refCount === 0) {
      entry.closeUnsubscribe();
      entry.connection.dispose();
    }
  }

  private startIdleTimer(serverId: string, entry: PoolEntry): void {
    if (this.options.idleTimeoutMs === 0) {
      return;
    }
    const timeout = Math.min(this.options.idleTimeoutMs, MAX_IDLE_TIMEOUT_MS);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.refCount === 0 && this.entries.get(serverId) === entry) {
        this.evictEntry(serverId, entry);
      }
    }, timeout);
  }

  private cancelIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  private emit(event: PoolEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private connectInner(server: ServerConfig, context?: SshConnectContext): Promise<SshConnection> {
    if (hasContextAwareConnect(this.innerFactory)) {
      return this.innerFactory.connectWithContext(server, context);
    }
    return this.innerFactory.connect(server);
  }
}
