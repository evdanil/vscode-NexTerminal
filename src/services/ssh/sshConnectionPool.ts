import type { Duplex } from "node:stream";
import type { SFTPWrapper } from "ssh2";
import type { ServerConfig } from "../../models/config";
import type { PtyOptions, SshConnection, SshFactory, SshPoolControl, TcpConnectionInfo } from "./contracts";

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
  connectedAt: number;
  closeUnsubscribe: () => void;
}

const MAX_IDLE_TIMEOUT_MS = 3_600_000;
const SSH_OPEN_ADMINISTRATIVELY_PROHIBITED = 1;
const SSH_OPEN_CONNECT_FAILED = 2;
const SSH_OPEN_UNKNOWN_CHANNEL_TYPE = 3;
const SSH_OPEN_RESOURCE_SHORTAGE = 4;

const FALLBACK_ALLOW_HINTS = [
  "administratively prohibited",
  "resource shortage",
  "too many sessions",
  "maxsessions",
  "channel limit",
  "no more sessions"
] as const;

const FALLBACK_DENY_HINTS = [
  "connection refused",
  "connect failed",
  "unknown channel type"
] as const;

function hasAnyNeedle(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function shouldFallbackForChannelLimit(error: unknown): boolean {
  const reason = typeof error === "object" && error !== null
    ? (error as { reason?: unknown }).reason
    : undefined;

  if (typeof reason === "number") {
    if (reason === SSH_OPEN_ADMINISTRATIVELY_PROHIBITED || reason === SSH_OPEN_RESOURCE_SHORTAGE) {
      return true;
    }
    if (reason === SSH_OPEN_CONNECT_FAILED || reason === SSH_OPEN_UNKNOWN_CHANNEL_TYPE) {
      return false;
    }
  }

  if (typeof reason === "string") {
    const normalizedReason = reason.toLowerCase();
    if (hasAnyNeedle(normalizedReason, FALLBACK_DENY_HINTS)) {
      return false;
    }
    if (hasAnyNeedle(normalizedReason, FALLBACK_ALLOW_HINTS)) {
      return true;
    }
  }

  const message = (error instanceof Error ? error.message : typeof error === "string" ? error : "").toLowerCase();
  if (!message) {
    return false;
  }
  if (hasAnyNeedle(message, FALLBACK_DENY_HINTS)) {
    return false;
  }
  return hasAnyNeedle(message, FALLBACK_ALLOW_HINTS);
}

class PooledSshConnection implements SshConnection {
  private disposed = false;
  private readonly closeUnsubscribes: Array<() => void> = [];
  private fallbackConnection?: SshConnection;
  private fallbackUsed = false;

  public constructor(
    private readonly inner: SshConnection,
    private onRelease: () => void,
    private readonly createFallback?: () => Promise<SshConnection>
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
    return Boolean(this.createFallback) && !this.fallbackUsed && shouldFallbackForChannelLimit(error);
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

export class SshConnectionPool implements SshFactory, SshPoolControl {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly pending = new Map<string, Promise<PoolEntry>>();
  private readonly listeners = new Set<(event: PoolEvent) => void>();
  private disposed = false;

  public constructor(
    private readonly innerFactory: SshFactory,
    private readonly options: PoolOptions
  ) {}

  public onDidChange(listener: (event: PoolEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async connect(server: ServerConfig): Promise<SshConnection> {
    if (this.disposed) {
      throw new Error("Connection pool is disposed");
    }
    const multiplexingEnabled = server.multiplexing ?? this.options.enabled;
    if (!multiplexingEnabled) {
      return this.innerFactory.connect(server);
    }

    const entry = await this.getOrCreateEntry(server);
    this.cancelIdleTimer(entry);
    entry.refCount++;

    // Offer fallback when this is a reused connection (refCount > 1).
    // If a channel open fails on a multiplexed connection (e.g. Cisco devices
    // that reject additional channels), automatically create a standalone
    // connection so the caller doesn't see the failure.
    // Offer fallback: soft-remove the pool entry (mark unhealthy, remove from
    // map) but do NOT dispose the underlying connection — other leases may
    // still hold active streams. The last lease to release will dispose it.
    const createFallback = entry.refCount > 1
      ? async (): Promise<SshConnection> => {
          if (this.entries.get(server.id) === entry) {
            entry.healthy = false;
            this.cancelIdleTimer(entry);
            this.entries.delete(server.id);
            this.emit({ type: "disconnected", serverId: server.id });
          }
          return this.innerFactory.connect(server);
        }
      : undefined;

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
    }, createFallback);
  }

  public disconnect(serverId: string): void {
    const entry = this.entries.get(serverId);
    if (!entry) {
      return;
    }
    this.evictEntry(serverId, entry);
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
    this.listeners.clear();
  }

  private async getOrCreateEntry(server: ServerConfig): Promise<PoolEntry> {
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

    const promise = this.createEntry(server).finally(() => {
      this.pending.delete(server.id);
    });
    this.pending.set(server.id, promise);
    return promise;
  }

  private async createEntry(server: ServerConfig): Promise<PoolEntry> {
    const connection = await this.innerFactory.connect(server);

    if (this.disposed) {
      connection.dispose();
      throw new Error("Connection pool is disposed");
    }

    const entry: PoolEntry = {
      connection,
      refCount: 0,
      healthy: true,
      connectedAt: Date.now(),
      closeUnsubscribe: () => {}
    };

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
}
