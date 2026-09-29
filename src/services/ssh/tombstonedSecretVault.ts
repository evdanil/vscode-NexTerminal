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
 * Tombstone clearing is generation-aware. Each markStale bumps a per-key
 * generation. Its delete clears only its own generation's tombstone, and a store
 * (the password the user just typed for the new endpoint) clears it only if no
 * markStale happened after that store was issued, so an older store settling can
 * never lift a newer tombstone. Until a store issued after the last markStale has
 * been written, or that markStale's delete has finished, reads stay absent rather
 * than return the old value. A read already in flight when a tombstone appears is
 * discarded too.
 * A failed delete keeps the tombstone: not sending a possibly stale secret is the
 * safe side.
 *
 * Reversible for tentative changes: `suspect` tombstones without deleting,
 * `lift` undoes it (a rolled-back save keeps the original password), and `commit`
 * deletes once the change is persisted. `markStale` is suspect + commit.
 *
 * Writes on one key run in order, so a store issued after a stale delete cannot
 * be overtaken and erased by it.
 */
export class TombstonedSecretVault implements SecretVault {
  private readonly tombstones = new Set<string>();
  /** Bumped by every markStale; a store or delete may clear only the tombstone of its own generation. */
  private readonly generations = new Map<string, number>();
  private readonly tails = new Map<string, Promise<unknown>>();
  /** Keys tombstoned by suspect() whose deletion has not been committed (and may still be lifted). */
  private readonly pendingDeletes = new Set<string>();

  public constructor(private readonly inner: SecretVault) {}

  public async get(key: string): Promise<string | undefined> {
    if (this.tombstones.has(key)) {
      return undefined;
    }
    const value = await this.inner.get(key);
    // A tombstone set while the read was in flight makes that value stale too.
    return this.tombstones.has(key) ? undefined : value;
  }

  public store(key: string, value: string): Promise<void> {
    // Queued behind any stale delete, so reads stay tombstoned until it is written.
    // It may lift the tombstone only if no markStale happened after it was issued:
    // an older store settling must not clear a newer tombstone.
    // A value stored for the new endpoint replaces the old one: a still-uncommitted
    // deletion of the old password must not later erase it.
    this.pendingDeletes.delete(key);
    const issuedAt = this.generation(key);
    const write = this.enqueue(key, () => this.inner.store(key, value));
    void write.then(
      () => {
        if (this.generation(key) === issuedAt) {
          this.tombstones.delete(key);
        }
      },
      () => undefined
    );
    return write;
  }

  /** Direct deletes do not touch the tombstone; only markStale does. */
  public delete(key: string): Promise<void> {
    return this.enqueue(key, () => this.inner.delete(key));
  }

  /**
   * Makes `key` read as absent immediately WITHOUT deleting it: the change that
   * made it stale is still tentative (it may be rolled back). Call `commit` once
   * it is persisted, or `lift` if it is undone.
   */
  public suspect(key: string): void {
    this.generations.set(key, this.generation(key) + 1);
    this.tombstones.add(key);
    this.pendingDeletes.add(key);
  }

  /** The suspected change was undone: the stored value is valid again and was never deleted. */
  public lift(key: string): void {
    if (!this.pendingDeletes.delete(key)) {
      return; // already committed (or never suspected): the value is gone or replaced
    }
    this.generations.set(key, this.generation(key) + 1);
    this.tombstones.delete(key);
  }

  /** The suspected change is persisted: delete the value. A newer stored value cancels this. Resolves when done. */
  public commit(key: string): Promise<void> {
    if (!this.pendingDeletes.delete(key)) {
      return Promise.resolve();
    }
    const generation = this.generation(key);
    return this.enqueue(key, () => this.inner.delete(key)).then(() => {
      // Only this generation's own tombstone: a newer suspect keeps it until its
      // own commit lands. A failed delete never reaches here and keeps it.
      if (this.generation(key) === generation) {
        this.tombstones.delete(key);
      }
    });
  }

  /** Suspect and commit at once: absent immediately, then deleted. Resolves when the delete has finished. */
  public markStale(key: string): Promise<void> {
    this.suspect(key);
    return this.commit(key);
  }

  private generation(key: string): number {
    return this.generations.get(key) ?? 0;
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
