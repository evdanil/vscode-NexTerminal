import type { SecretVault } from "./contracts";

/**
 * Serializes every write (store, delete, guarded delete) to the SAME secret key
 * through one per-key queue, so within this window operations on a key take effect
 * in the order they were issued: a store queued after a pending delete of the same
 * key survives it, and a delete cannot overtake a store that preceded it. Reads are
 * not queued. Different keys never wait for each other.
 *
 * This orders one window's own operations only. SecretStorage has no
 * compare-and-swap, so two windows writing the same key are last-writer-wins, like
 * `globalState`; see proxyPasswordKeys.ts for what that can and cannot cost.
 */
export class KeySerializedSecretVault implements SecretVault {
  private readonly tails = new Map<string, Promise<unknown>>();

  public constructor(private readonly inner: SecretVault) {}

  public keys(): Promise<string[]> | string[] {
    return this.inner.keys ? this.inner.keys() : [];
  }

  public get(key: string): Promise<string | undefined> {
    return this.inner.get(key);
  }

  public store(key: string, value: string): Promise<void> {
    return this.enqueue(key, () => this.inner.store(key, value));
  }

  public delete(key: string): Promise<void> {
    return this.enqueue(key, () => this.inner.delete(key));
  }

  /**
   * Deletes `key` only if `shouldDelete()` still holds when the delete reaches the
   * front of the key's queue, i.e. after every write issued before it has landed.
   * Resolves true if it deleted, false if it skipped.
   */
  public deleteIf(key: string, shouldDelete: () => boolean): Promise<boolean> {
    let deleted = false;
    return this.enqueue(key, async () => {
      if (!shouldDelete()) {
        return;
      }
      await this.inner.delete(key);
      deleted = true;
    }).then(() => deleted);
  }

  private enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    this.tails.set(key, run);
    const release = (): void => {
      if (this.tails.get(key) === run) {
        this.tails.delete(key);
      }
    };
    void run.then(release, release);
    return run;
  }
}
