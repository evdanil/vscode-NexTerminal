/**
 * Minimal FIFO promise-chain async mutex. Serializes the mutation-phase
 * critical sections of config-level flows (replace-mode import, complete
 * reset) against inventory command critical sections (addSource/editSource/
 * removeSource/syncNow), closing races where those phases interleave — e.g.
 * a replace-mode import deleting an inventory source's vault key while
 * removeSource's post-apply cleanup is still reading/writing that same key.
 *
 * NOT RE-ENTRANT — a `runExclusive` call from *inside* another `runExclusive`
 * callback on the SAME instance deadlocks: the inner call waits on the tail
 * promise, which only the still-running outer call can advance. Acquirers
 * must not nest; anything invoked from within a locked section (core
 * methods, runtime teardown, vault calls) must never itself call
 * `runExclusive` on this lock.
 *
 * CRITICAL: never hold the lock across interactive UI (a modal, quick pick,
 * or input box awaiting the user) — only across the mutation phase itself.
 * Acquire after the last prompt resolves; release before showing another.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // Advance the queue once this call SETTLES, whether it resolved or threw
    // — a rejection must still release the lock for the next acquirer.
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

/** Shared singleton acquired by both config-import/reset flows and inventory commands. */
export const configMutationLock = new AsyncMutex();
