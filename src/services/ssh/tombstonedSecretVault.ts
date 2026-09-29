import type { SecretVault } from "./contracts";

/**
 * A SecretVault that can make a stored secret unusable SYNCHRONOUSLY while its
 * (asynchronous) deletion is still in flight.
 *
 * Why: an endpoint-specific secret, the saved password for a server's SOCKS5 /
 * HTTP proxy, must never be sent to a different proxy. NexusCore reports a proxy
 * edit synchronously, and pooled connections are retired then, so a connect that
 * starts before the SecretStorage delete lands would build a fresh connection to
 * the NEW proxy and read the OLD proxy's password. `markStale` tombstones the key
 * in memory (reads return undefined, as if nothing were saved) and then deletes.
 * The tombstone is dropped when the delete finishes, or once a new value stored
 * under the key (the password the user just typed for the new endpoint) has been
 * written; until then reads stay absent rather than return the old value.
 * A failed delete keeps the tombstone: not sending a possibly stale secret is the
 * safe side.
 *
 * Writes on one key run in order, so a store issued after a stale delete cannot
 * be overtaken and erased by it.
 */
export class TombstonedSecretVault implements SecretVault {
  private readonly tombstones = new Set<string>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly pendingStores = new Map<string, number>();

  public constructor(private readonly inner: SecretVault) {}

  public async get(key: string): Promise<string | undefined> {
    if (this.tombstones.has(key)) {
      return undefined;
    }
    return this.inner.get(key);
  }

  public store(key: string, value: string): Promise<void> {
    // The new value belongs to the new endpoint, but it is queued behind any stale
    // delete, so reads stay tombstoned until it has actually been written.
    this.pendingStores.set(key, (this.pendingStores.get(key) ?? 0) + 1);
    const write = this.enqueue(key, () => this.inner.store(key, value));
    const settled = (): void => {
      const left = (this.pendingStores.get(key) ?? 1) - 1;
      if (left <= 0) this.pendingStores.delete(key);
      else this.pendingStores.set(key, left);
    };
    void write.then(
      () => { settled(); this.tombstones.delete(key); },
      settled
    );
    return write;
  }

  public delete(key: string): Promise<void> {
    return this.enqueue(key, () => this.inner.delete(key));
  }

  /** Makes `key` read as absent immediately, then deletes it. Resolves when the delete has finished. */
  public markStale(key: string): Promise<void> {
    this.tombstones.add(key);
    const pending = this.enqueue(key, () => this.inner.delete(key));
    return pending.then(() => {
      // Dropped once the delete really finished, unless a newer value is still
      // being written (its own completion drops the tombstone then).
      if (!this.pendingStores.has(key)) {
        this.tombstones.delete(key);
      }
    });
  }

  private enqueue(key: string, op: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(op);
    this.tails.set(key, run);
    void run.then(
      () => { if (this.tails.get(key) === run) this.tails.delete(key); },
      () => { if (this.tails.get(key) === run) this.tails.delete(key); }
    );
    return run;
  }
}
