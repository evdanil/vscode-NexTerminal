import type { Duplex } from "node:stream";
import type { SFTPWrapper } from "ssh2";
import type { ServerConfig } from "../../models/config";
import type { PtyOptions, SshConnection, SshFactory, SshPoolControl } from "./contracts";

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

class PooledSshConnection implements SshConnection {
  private disposed = false;
  private readonly closeUnsubscribes: Array<() => void> = [];

  public constructor(
    private readonly inner: SshConnection,
    private readonly onRelease: () => void
  ) {}

  public openShell(ptyOptions?: PtyOptions): Promise<Duplex> {
    this.assertNotDisposed();
    return this.inner.openShell(ptyOptions);
  }

  public openDirectTcp(remoteIP: string, remotePort: number): Promise<Duplex> {
    this.assertNotDisposed();
    return this.inner.openDirectTcp(remoteIP, remotePort);
  }

  public openSftp(): Promise<SFTPWrapper> {
    this.assertNotDisposed();
    return this.inner.openSftp();
  }

  public onClose(listener: () => void): () => void {
    this.assertNotDisposed();
    const unsub = this.inner.onClose(listener);
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
    if (!this.options.enabled) {
      return this.innerFactory.connect(server);
    }

    const entry = await this.getOrCreateEntry(server);
    this.cancelIdleTimer(entry);
    entry.refCount++;

    return new PooledSshConnection(entry.connection, () => {
      entry.refCount--;
      if (entry.refCount === 0) {
        this.startIdleTimer(server.id, entry);
      }
    });
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
