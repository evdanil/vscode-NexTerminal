import type { Duplex } from "node:stream";
import type { SFTPWrapper } from "ssh2";
import type { ServerConfig } from "../../models/config";
import type {
  ContextAwareSshFactory,
  PtyOptions,
  SshConnectContext,
  SshCommandChannel,
  SshConnection,
  SshFactory,
  SshPoolControl,
  TcpConnectionInfo
} from "./contracts";
import { SshInteractionRequiredError } from "./contracts";
import { hasContextAwareConnect } from "./contracts";
import { isStaleConnectionError, shouldFallbackForChannelLimit } from "./channelErrors";
import { AuthNotJudgedError } from "./authErrors";

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
  closePromise: Promise<void>;
  markClosed: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
  closeUnsubscribe: () => void;
}

interface PendingConnectionOwner {
  context?: SshConnectContext;
  controller: AbortController;
  removeAbortListener?: () => void;
  released: boolean;
}

interface PendingConnectionGroup {
  key: string;
  serverId: string;
  promise: Promise<PoolEntry>;
  owners: PendingConnectionOwner[];
  controller: AbortController;
  settled: boolean;
  entry?: PoolEntry;
  livenessTimer?: ReturnType<typeof setInterval>;
}

interface PoolAcquisition {
  entry: PoolEntry;
  releasePendingOwner?: () => void;
}

const MAX_IDLE_TIMEOUT_MS = 3_600_000;

function waitForConnectionClose(connection: SshConnection): Promise<void> {
  return new Promise<void>((resolve) => {
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    const finish = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe?.();
      resolve();
    };
    unsubscribe = connection.onClose(finish);
    if (closed) {
      unsubscribe?.();
    }
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new AuthNotJudgedError("SSH connection attempt was canceled");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  if (!signal) {
    return promise;
  }
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

function awaitWithSignals<T>(promise: Promise<T>, signals: Array<AbortSignal | undefined>): Promise<T> {
  const activeSignals = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
  if (activeSignals.length === 0) {
    return promise;
  }
  const alreadyAborted = activeSignals.find((signal) => signal.aborted);
  if (alreadyAborted) {
    return Promise.reject(abortReason(alreadyAborted));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const listeners = new Map<AbortSignal, () => void>();
    const cleanup = (): void => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
      listeners.clear();
    };
    for (const signal of activeSignals) {
      const listener = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortReason(signal));
      };
      listeners.set(signal, listener);
      signal.addEventListener("abort", listener, { once: true });
    }
    promise.then(
      (value) => {
        if (settled) return;
        const aborted = activeSignals.find((signal) => signal.aborted);
        settled = true;
        cleanup();
        if (aborted) {
          reject(abortReason(aborted));
        } else {
          resolve(value);
        }
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

class PooledSshConnection implements SshConnection {
  public readonly execCommand?: NonNullable<SshConnection["execCommand"]>;
  private disposed = false;
  private readonly closeUnsubscribes: Array<() => void> = [];
  private fallbackConnection?: SshConnection;
  private fallbackUsed = false;
  private pooledReleased = false;
  private onRelease: () => void = () => this.releasePooledOnce();

  public constructor(
    private readonly inner: SshConnection,
    private readonly releasePooled: () => void,
    private readonly createFallback?: (signal?: AbortSignal) => Promise<SshConnection>,
    private readonly isReused = false,
    private readonly retireEntry: () => Promise<void> = () => Promise.resolve(),
    private readonly evictDeadEntry?: () => void
  ) {
    if (this.inner.execCommand) {
      this.execCommand = (command, signal) => this.execCommandWithFallback(command, signal);
    }
  }

  /** See `SshConnectionPool.retire`. */
  public retireTransport(): Promise<void> {
    if (this.fallbackUsed && this.fallbackConnection) {
      return waitForConnectionClose(this.fallbackConnection);
    }
    return this.retireEntry();
  }

  private get active(): SshConnection {
    return this.fallbackUsed && this.fallbackConnection ? this.fallbackConnection : this.inner;
  }

  public async openShell(ptyOptions?: PtyOptions): Promise<Duplex> {
    this.assertNotDisposed();
    const source = this.active;
    try {
      return await this.active.openShell(ptyOptions);
    } catch (err) {
      this.evictIfStale(err, source);
      if (this.shouldAttemptFallback(err)) {
        const fb = await this.tryFallback();
        // dispose() may have run between the fallback settling and this
        // continuation; the fallback is closed then, so never open on it.
        this.assertNotDisposed();
        if (fb) {
          return fb.openShell(ptyOptions);
        }
      }
      this.assertNotDisposed();
      throw err;
    }
  }

  public async openDirectTcp(remoteIP: string, remotePort: number): Promise<Duplex> {
    this.assertNotDisposed();
    const source = this.active;
    try {
      return await this.active.openDirectTcp(remoteIP, remotePort);
    } catch (err) {
      this.evictIfStale(err, source);
      if (this.shouldAttemptFallback(err)) {
        const fb = await this.tryFallback();
        // dispose() may have run between the fallback settling and this
        // continuation; the fallback is closed then, so never open on it.
        this.assertNotDisposed();
        if (fb) {
          return fb.openDirectTcp(remoteIP, remotePort);
        }
      }
      this.assertNotDisposed();
      throw err;
    }
  }

  public async openSftp(): Promise<SFTPWrapper> {
    this.assertNotDisposed();
    const source = this.active;
    try {
      return await this.active.openSftp();
    } catch (err) {
      this.evictIfStale(err, source);
      if (this.shouldAttemptFallback(err)) {
        const fb = await this.tryFallback();
        // dispose() may have run between the fallback settling and this
        // continuation; the fallback is closed then, so never open on it.
        this.assertNotDisposed();
        if (fb) {
          return fb.openSftp();
        }
      }
      this.assertNotDisposed();
      throw err;
    }
  }

  public async exec(command: string): Promise<Duplex> {
    this.assertNotDisposed();
    const source = this.active;
    try {
      return await this.active.exec(command);
    } catch (err) {
      this.evictIfStale(err, source);
      if (this.shouldAttemptFallback(err)) {
        const fb = await this.tryFallback();
        // dispose() may have run between the fallback settling and this
        // continuation; the fallback is closed then, so never open on it.
        this.assertNotDisposed();
        if (fb) {
          return fb.exec(command);
        }
      }
      this.assertNotDisposed();
      throw err;
    }
  }

  private async execCommandWithFallback(command: string, signal?: AbortSignal): Promise<SshCommandChannel> {
    this.assertNotDisposed();
    throwIfAborted(signal);
    const source = this.active;
    const execCommand = source.execCommand;
    if (!execCommand) {
      throw new Error("SSH transport does not support typed command channels");
    }
    try {
      const channel = await awaitWithSignal(execCommand.call(source, command, signal), signal, (late) => late.close());
      throwIfAborted(signal);
      this.closeChannelOnAbort(channel, signal);
      return channel;
    } catch (error) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      this.evictIfStale(error, source);
      if (this.shouldAttemptFallback(error)) {
        const fallback = await this.tryFallback(signal);
        this.assertNotDisposed();
        throwIfAborted(signal);
        if (fallback) {
          const fallbackExec = fallback.execCommand;
          if (!fallbackExec) {
            throw new Error("SSH transport does not support typed command channels");
          }
          const channel = await awaitWithSignal(fallbackExec.call(fallback, command, signal), signal, (late) => late.close());
          throwIfAborted(signal);
          this.closeChannelOnAbort(channel, signal);
          return channel;
        }
      }
      this.assertNotDisposed();
      throw error;
    }
  }

  private closeChannelOnAbort(channel: SshCommandChannel, signal?: AbortSignal): void {
    if (!signal) return;
    const onAbort = (): void => channel.close();
    signal.addEventListener("abort", onAbort, { once: true });
    void channel.completion.then(
      () => signal.removeEventListener("abort", onAbort),
      () => signal.removeEventListener("abort", onAbort)
    );
    if (signal.aborted) onAbort();
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

  /**
   * The pooled reference must drop exactly once: dispose() and a fallback that
   * settles afterwards both want to release it, and a second decrement would
   * orphan-dispose the shared transport under another live lease.
   */
  private releasePooledOnce(): void {
    if (this.pooledReleased) return;
    this.pooledReleased = true;
    this.releasePooled();
  }

  private fallbackPromise?: Promise<SshConnection | undefined>;

  /**
   * A stale-connection error from the pooled transport means the entry is
   * dead, whatever became of this lease or its fallback: a disposed lease
   * skips the dial, and with several opens in flight an earlier channel-limit
   * rejection may already have latched `fallbackUsed`. Keyed on the failing
   * connection so a fallback's own error never evicts a healthy pooled entry.
   * evictDeadEntry is idempotent.
   */
  private evictIfStale(error: unknown, source: SshConnection): void {
    if (source === this.inner && isStaleConnectionError(error)) {
      this.evictDeadEntry?.();
    }
  }

  private shouldAttemptFallback(error: unknown): boolean {
    if (this.fallbackUsed || !this.createFallback) return false;
    // Stale connections ("Not connected") should always retry — the pooled
    // socket is dead but the close event hasn't fired yet.
    if (isStaleConnectionError(error)) return true;
    // Channel-limit fallback only makes sense on reused connections where
    // the server refuses additional channels on the multiplexed session.
    return this.isReused && shouldFallbackForChannelLimit(error);
  }

  private tryFallback(signal?: AbortSignal): Promise<SshConnection | undefined> {
    if (this.fallbackUsed) {
      return Promise.resolve(this.fallbackConnection);
    }
    if (!this.createFallback) {
      return Promise.resolve(undefined);
    }
    // Cache the promise so concurrent callers share a single fallback attempt
    if (!this.fallbackPromise) {
      this.fallbackPromise = this.executeFallback(signal);
    }
    return awaitWithSignal(this.fallbackPromise, signal, (late) => late?.dispose());
  }

  private async executeFallback(signal?: AbortSignal): Promise<SshConnection | undefined> {
    if (this.disposed) {
      // Disposed while the original channel open was in flight: dialing (and
      // possibly prompting for a password/2FA) for a closed lease is unwanted.
      this.fallbackUsed = true;
      return undefined;
    }
    throwIfAborted(signal);
    try {
      const fallback = await this.createFallback!(signal);
      this.fallbackUsed = true;
      if (this.disposed || signal?.aborted) {
        // The lease was disposed while the fallback was connecting: nobody owns
        // this connection, so close it rather than hand it to the pending call.
        // dispose() already released the pooled reference.
        fallback.dispose();
        if (signal?.aborted) throw abortReason(signal);
        return undefined;
      }
      this.fallbackConnection = fallback;
      // Hand ownership to the fallback before releasing the pooled reference:
      // releasing can run arbitrary close handlers that dispose this lease, and
      // that dispose must then close the fallback rather than a stale release.
      this.onRelease = () => this.fallbackConnection?.dispose();
      this.releasePooledOnce();
      return this.fallbackConnection;
    } catch (error) {
      this.fallbackUsed = true; // prevent retries
      if (error instanceof SshInteractionRequiredError || signal?.aborted) {
        throw signal?.aborted ? abortReason(signal) : error;
      }
      return undefined;
    }
  }

  /** The connection this lease rides now: the pooled transport, or its own fallback. */
  public get transport(): SshConnection {
    return this.active;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Cannot use a disposed SSH connection lease");
    }
  }
}

export class SshConnectionPool implements ContextAwareSshFactory, SshPoolControl {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly retiredEntries = new Set<PoolEntry>();
  private readonly pending = new Map<string, PendingConnectionGroup>();
  private readonly listeners = new Set<(event: PoolEvent) => void>();
  // Per-server invalidation counter. A connect captures the value at handshake
  // start and re-checks it once the handshake settles; a bump in between means
  // the credentials/settings it authenticated with have since been replaced, so
  // the resulting connection must never be pooled. Removed IDs remain here to
  // fence detached in-flight handshakes, so this is bounded by distinct IDs
  // invalidated during this pool's lifetime and cleared when the pool is disposed.
  private readonly invalidationEpochs = new Map<string, number>();
  private disposed = false;

  public constructor(
    private readonly innerFactory: SshFactory,
    private readonly options: PoolOptions
  ) {}

  /** The default a server with no `multiplexing` of its own gets; see SshPoolControl. */
  public get multiplexingDefault(): boolean {
    return this.options.enabled;
  }

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
    throwIfAborted(context?.signal);
    if (context?.isActive?.() === false) {
      throw new AuthNotJudgedError("SSH connection attempt ended before authentication completed");
    }
    const multiplexingEnabled = server.multiplexing ?? this.options.enabled;
    if (!multiplexingEnabled) {
      return this.connectInner(server, context);
    }

    const acquisition = await this.getOrCreateEntry(server, context);
    const entry = acquisition.entry;
    try {
      throwIfAborted(context?.signal);
      if (context?.isActive?.() === false) {
        throw new AuthNotJudgedError("SSH connection attempt ended before authentication completed");
      }
      this.cancelIdleTimer(entry);
      entry.refCount++;
      acquisition.releasePendingOwner?.();
    } catch (error) {
      acquisition.releasePendingOwner?.();
      throw error;
    }

    // Offer fallback: if a channel open fails on a multiplexed connection
    // (e.g. Cisco devices that reject additional channels) or the pooled
    // connection is stale ("Not connected"), automatically create a standalone
    // connection so the caller doesn't see the failure.
    // Soft-remove the pool entry (mark unhealthy, remove from map) but do NOT
    // dispose the underlying connection — other leases may still hold active
    // streams. The last lease to release will dispose it via orphan cleanup.
    const evictDeadEntry = (): void => {
      if (this.entries.get(server.id) === entry) {
        entry.healthy = false;
        this.cancelIdleTimer(entry);
        this.entries.delete(server.id);
        this.emit({ type: "disconnected", serverId: server.id });
        if (entry.refCount === 0) {
          // A disposed lease already released it: nobody else will close it.
          entry.connection.dispose();
        } else {
          this.trackRetired(entry);
        }
      }
    };
    const createFallback = async (signal?: AbortSignal): Promise<SshConnection> => {
      evictDeadEntry();
      const fallbackSignal = signal ?? context?.signal;
      const fallbackContext = context || fallbackSignal
        ? { ...context, ...(fallbackSignal && { signal: fallbackSignal }) }
        : undefined;
      return this.connectInner(server, fallbackContext);
    };

    const isReused = entry.refCount > 1;

    return new PooledSshConnection(entry.connection, () => {
      entry.refCount--;
      if (entry.refCount === 0) {
        if (this.entries.get(server.id) === entry) {
          this.startIdleTimer(server.id, entry);
        } else {
          // Orphaned: entry was soft-removed from pool, dispose now
          entry.connection.dispose();
        }
      }
    }, createFallback, isReused, () => {
      this.trackRetired(entry);
      if (this.entries.get(server.id) === entry) {
        this.softRemoveEntry(server.id, entry);
      }
      if (this.disposed) {
        entry.connection.dispose();
      }
      return entry.closePromise;
    }, evictDeadEntry);
  }

  /**
   * Stops handing the transport `lease` rides to new consumers, without
   * closing it under the leases already on it: it closes when the last of them
   * is released. The returned promise settles when the transport actually
   * closes, so a caller can keep a conflicting resource from being rebound in
   * the meantime. For a transport left in a state no new consumer should
   * inherit — a remote forward it may still hold, say. Only that transport: if
   * the server's pooled entry has been replaced since the lease was taken — or
   * the lease fell back to a connection of its own, which takes its entry out
   * of the pool — the lease's own entry has already left the pool and closes on
   * its own, and the replacement is left alone. A no-op for a lease this pool
   * did not hand out.
   */
  public retire(lease: SshConnection): Promise<void> | undefined {
    if (lease instanceof PooledSshConnection) {
      return lease.retireTransport();
    }
    return undefined;
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
    const keyPrefix = `${serverId}\u0000`;
    for (const key of this.pending.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.pending.delete(key);
      }
    }

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
      this.entries.delete(serverId);
      entry.connection.dispose();
      this.emit({ type: "disconnected", serverId });
    }
    // Retired transports are no longer in entries, but shutdown must close
    // them even if a terminal or SFTP lease has not released its reference.
    for (const entry of this.retiredEntries) {
      entry.connection.dispose();
    }
    this.entries.clear();
    this.retiredEntries.clear();
    for (const group of this.pending.values()) {
      this.abortPendingGroup(group);
    }
    this.pending.clear();
    this.invalidationEpochs.clear();
    this.listeners.clear();
  }

  private async getOrCreateEntry(
    server: ServerConfig,
    context?: SshConnectContext
  ): Promise<PoolAcquisition> {
    const existing = this.entries.get(server.id);
    if (existing && existing.healthy) {
      return { entry: existing };
    }
    if (existing && !existing.healthy) {
      this.entries.delete(server.id);
      this.cancelIdleTimer(existing);
    }

    const interaction = context?.interaction ?? "interactive";
    const pendingKey = `${server.id}\u0000${interaction}`;
    const pending = this.pending.get(pendingKey);
    if (pending && !pending.settled && !pending.controller.signal.aborted) {
      const owner = this.addPendingOwner(pending, context);
      return this.waitForPendingOwner(pending, owner);
    }
    if (pending && this.pending.get(pendingKey) === pending) {
      this.pending.delete(pendingKey);
    }

    const group: PendingConnectionGroup = {
      key: pendingKey,
      serverId: server.id,
      promise: Promise.resolve(undefined as never),
      owners: [],
      controller: new AbortController(),
      settled: false
    };
    const owner = this.addPendingOwner(group, context);
    const sharedContext: SshConnectContext = {
      ...context,
      // A caller owns its wait, but the shared transport attempt belongs to
      // the whole policy group. Never let the first caller's signal cancel
      // authentication while another same-policy owner is still live.
      signal: group.controller.signal,
      isActive: () => this.isPendingGroupActive(group),
      onAuthMessage: (text: string) => {
        if (!this.isPendingGroupActive(group)) {
          return false;
        }
        const receiver = group.owners.find((candidate) => this.isPendingOwnerActive(candidate) && candidate.context?.onAuthMessage);
        return receiver?.context?.onAuthMessage?.(text) !== false;
      }
    };
    group.livenessTimer = setInterval(() => {
      this.isPendingGroupActive(group);
    }, 50);
    group.promise = this.createEntry(server, sharedContext).then((entry) => {
      group.entry = entry;
      return entry;
    }).finally(() => {
      group.settled = true;
      this.stopPendingGroupMonitoring(group);
      if (!group.owners.some((candidate) => this.isPendingOwnerActive(candidate))) {
        this.disposeUnclaimedEntry(group);
      }
      // Only clear the slot if it is still ours: invalidate() may have dropped
      // this connect from `pending` and a newer handshake may already hold it.
      if (this.pending.get(pendingKey) === group) {
        this.pending.delete(pendingKey);
      }
    });
    this.pending.set(pendingKey, group);
    return this.waitForPendingOwner(group, owner);
  }

  private addPendingOwner(group: PendingConnectionGroup, context?: SshConnectContext): PendingConnectionOwner {
    const owner: PendingConnectionOwner = { context, controller: new AbortController(), released: false };
    if (context?.signal) {
      const onAbort = (): void => {
        this.refreshPendingOwners(group);
      };
      context.signal.addEventListener("abort", onAbort, { once: true });
      owner.removeAbortListener = () => context.signal?.removeEventListener("abort", onAbort);
    }
    group.owners.push(owner);
    this.refreshPendingOwners(group);
    return owner;
  }

  private isPendingOwnerActive(owner: PendingConnectionOwner): boolean {
    return !owner.released && !owner.controller.signal.aborted &&
      owner.context?.signal?.aborted !== true && owner.context?.isActive?.() !== false;
  }

  private refreshPendingOwners(group: PendingConnectionGroup): boolean {
    for (const owner of group.owners) {
      if (owner.released || owner.controller.signal.aborted) {
        continue;
      }
      if (owner.context?.signal?.aborted) {
        owner.controller.abort(abortReason(owner.context.signal));
      } else if (owner.context?.isActive?.() === false) {
        owner.controller.abort(new AuthNotJudgedError("SSH connection attempt ended before authentication completed"));
      }
    }
    const hasActiveOwner = group.owners.some((owner) => this.isPendingOwnerActive(owner));
    if (!hasActiveOwner && !group.settled) {
      this.abortPendingGroup(group);
    }
    return hasActiveOwner && !group.controller.signal.aborted;
  }

  private isPendingGroupActive(group: PendingConnectionGroup): boolean {
    return this.refreshPendingOwners(group);
  }

  private async waitForPendingOwner(
    group: PendingConnectionGroup,
    owner: PendingConnectionOwner
  ): Promise<PoolAcquisition> {
    try {
      const entry = await awaitWithSignals(group.promise, [owner.controller.signal, group.controller.signal]);
      if (!this.isPendingOwnerActive(owner)) {
        throw owner.controller.signal.aborted
          ? abortReason(owner.controller.signal)
          : new AuthNotJudgedError("SSH connection attempt ended before authentication completed");
      }
      return {
        entry,
        releasePendingOwner: () => this.releasePendingOwner(group, owner)
      };
    } catch (error) {
      this.releasePendingOwner(group, owner);
      throw error;
    }
  }

  private releasePendingOwner(group: PendingConnectionGroup, owner: PendingConnectionOwner): void {
    if (owner.released) {
      return;
    }
    owner.released = true;
    owner.removeAbortListener?.();
    const index = group.owners.indexOf(owner);
    if (index >= 0) {
      group.owners.splice(index, 1);
    }
    if (!group.settled && !group.owners.some((candidate) => this.isPendingOwnerActive(candidate))) {
      this.abortPendingGroup(group);
    }
    if (group.settled && !group.owners.some((candidate) => this.isPendingOwnerActive(candidate))) {
      this.disposeUnclaimedEntry(group);
    }
    if (group.owners.length === 0) {
      this.stopPendingGroupMonitoring(group);
    }
  }

  private abortPendingGroup(group: PendingConnectionGroup): void {
    if (!group.controller.signal.aborted) {
      const canceledOwner = group.owners.find((owner) => owner.context?.signal?.aborted);
      const reason = canceledOwner?.context?.signal
        ? abortReason(canceledOwner.context.signal)
        : new AuthNotJudgedError("SSH connection attempt ended before authentication completed");
      group.controller.abort(reason);
    }
    if (this.pending.get(group.key) === group) {
      this.pending.delete(group.key);
    }
    if (group.owners.length === 0) {
      this.stopPendingGroupMonitoring(group);
    }
  }

  private disposeUnclaimedEntry(group: PendingConnectionGroup): void {
    const entry = group.entry;
    if (!entry || entry.refCount > 0) {
      return;
    }
    if (this.entries.get(group.serverId) === entry) {
      this.entries.delete(group.serverId);
      entry.healthy = false;
      this.cancelIdleTimer(entry);
      this.emit({ type: "disconnected", serverId: group.serverId });
    }
    entry.connection.dispose();
  }

  private stopPendingGroupMonitoring(group: PendingConnectionGroup): void {
    if (group.livenessTimer !== undefined) {
      clearInterval(group.livenessTimer);
      group.livenessTimer = undefined;
    }
    for (const owner of group.owners) {
      owner.removeAbortListener?.();
      owner.removeAbortListener = undefined;
    }
  }

  private invalidationEpoch(serverId: string): number {
    return this.invalidationEpochs.get(serverId) ?? 0;
  }

  private async createEntry(server: ServerConfig, context?: SshConnectContext): Promise<PoolEntry> {
    const epochAtStart = this.invalidationEpoch(server.id);
    const connection = await this.connectInner(server, context);

    if (context?.signal?.aborted || context?.isActive?.() === false) {
      connection.dispose();
      throw context.signal?.aborted ? abortReason(context.signal) : new AuthNotJudgedError("SSH connection attempt ended before authentication completed");
    }
    if (this.disposed) {
      connection.dispose();
      throw new Error("Connection pool is disposed");
    }

    let markClosed!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const entry: PoolEntry = {
      connection,
      refCount: 0,
      healthy: true,
      closePromise,
      markClosed,
      closeUnsubscribe: () => {}
    };

    entry.closeUnsubscribe = connection.onClose(() => {
      entry.markClosed();
      this.retiredEntries.delete(entry);
      entry.healthy = false;
      this.cancelIdleTimer(entry);
      if (this.entries.get(server.id) === entry) {
        this.entries.delete(server.id);
        this.emit({ type: "disconnected", serverId: server.id });
      }
      entry.closeUnsubscribe();
    });

    if (!entry.healthy) {
      // A tunnel may replay its close event from onClose() registration. That
      // means the connection is already unusable, so do not publish or return it.
      entry.closeUnsubscribe();
      connection.dispose();
      throw new Error("SSH connection closed before it could be pooled");
    }

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

    this.entries.set(server.id, entry);
    this.emit({ type: "connected", serverId: server.id });
    return entry;
  }

  private evictEntry(serverId: string, entry: PoolEntry): void {
    this.cancelIdleTimer(entry);
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
      entry.connection.dispose();
    } else {
      this.trackRetired(entry);
    }
  }

  /**
   * An entry out of `entries` but still leased is otherwise invisible to
   * pool.dispose(), which would leave its transport open at shutdown.
   */
  private trackRetired(entry: PoolEntry): void {
    this.retiredEntries.add(entry);
    void entry.closePromise.then(() => { this.retiredEntries.delete(entry); });
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
    if (context?.interaction === "noninteractive" && !hasContextAwareConnect(this.innerFactory)) {
      return Promise.reject(new SshInteractionRequiredError("SSH transport cannot guarantee noninteractive acquisition."));
    }
    if (hasContextAwareConnect(this.innerFactory)) {
      return this.innerFactory.connectWithContext(server, context);
    }
    return this.innerFactory.connect(server);
  }
}

/**
 * The connection `connection` actually rides: for a lease from a pool, the
 * pooled transport it shares with every other lease on it (or its own
 * fallback); anything else is its own. Two leases on one transport reach the
 * server by the same path.
 */
export function underlyingConnection(connection: SshConnection): SshConnection {
  return connection instanceof PooledSshConnection ? connection.transport : connection;
}
