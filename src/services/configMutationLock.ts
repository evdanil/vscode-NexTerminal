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
  /** Acquirers that have not settled yet — running plus queued. */
  private outstanding = 0;
  private idleListeners = new Set<() => void>();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.outstanding++;
    const result = this.tail.then(fn);
    // Advance the queue once this call SETTLES, whether it resolved or threw
    // — a rejection must still release the lock for the next acquirer.
    this.tail = result.then(
      () => undefined,
      () => undefined
    ).then(() => {
      if (--this.outstanding === 0) {
        this.notifyIdle();
      }
    });
    return result;
  }

  /**
   * Fires when the queue DRAINS — the last acquirer has settled and none is
   * waiting — i.e. "the configuration has stopped moving".
   *
   * REVIEW E1. It exists for one consumer with one honest need: the lab-status
   * poll. A config-level flow (a backup restore, a complete reset, the
   * one-time poll-setting migration) mutates through this lock, and a restore
   * in particular persists an inventory source's RECORD well before it writes
   * that source's credentials into the vault — both inside its locked run. A
   * source armed off the record's change event therefore fires its one arm
   * refresh at a source that cannot authenticate yet. The poll declines that
   * fire rather than spending it, and this is the event that tells it the
   * restore has finished and the credentials have landed.
   *
   * Deliberately NOT a "the lock is free, go" invitation: nothing here
   * acquires, queues, or is serialized by it, and status refreshes still run
   * concurrently with config mutations exactly as they did (the revision,
   * epoch and generation guards are what reconcile them). It is only a
   * notification that the mutation phase is over.
   *
   * Listener errors are swallowed: this runs inside the queue's own
   * continuation, and a throwing observer must never wedge the mutex.
   */
  onIdle(listener: () => void): { dispose(): void } {
    this.idleListeners.add(listener);
    return { dispose: () => { this.idleListeners.delete(listener); } };
  }

  private notifyIdle(): void {
    for (const listener of [...this.idleListeners]) {
      try {
        listener();
      } catch {
        // See onIdle's contract.
      }
    }
  }
}

/** Shared singleton acquired by both config-import/reset flows and inventory commands. */
export const configMutationLock = new AsyncMutex();
