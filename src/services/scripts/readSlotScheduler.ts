/**
 * The concurrency, deadline and detachment state machine behind `nexus.fs`.
 * One instance per pool of like work — `scriptFs.ts` runs two, a read pool and
 * a probe pool, so neither kind of stall can consume the other's capacity.
 * Deliberately free of any `vscode` import: it is pure scheduling policy over
 * caller-supplied work, so it stays usable (and directly testable) outside the
 * extension host.
 *
 * WHY A STATE MACHINE RATHER THAN COOPERATING COUNTERS: the pipeline has to
 * hold five things true at once — a concurrency cap, a deadline that bounds
 * the WHOLE call (the wait for a slot included) without pinning one forever, a
 * cap on the detached work left behind by that deadline, recovery once
 * detachment capacity reopens, and a permit pool that neither leaks nor grows
 * when a call dies while still queued. Expressed as separate counters and
 * flags, "the permit is released exactly once" becomes a property you can only
 * establish by cross-reading every branch. Expressed as one slot whose state
 * each transition consumes, it becomes a property of the table.
 */

/**
 * How a pending admission request ended. Exactly one of these is ever produced
 * per request, and producing it is what releases everything the request was
 * holding on to.
 */
export type PermitOutcome =
  /** The permit is the requester's; it now owes a `release()`. */
  | "granted"
  /** `cancel()` won: the requester was marked dead before any permit reached it, and owes nothing. */
  | "cancelled";

/**
 * A wait for a permit that the waiter can walk away from. Handed out by
 * `acquireCancellable()`; the two members are deliberately the ONLY way to
 * observe or end the wait, so "granted" and "cancelled" cannot both happen.
 */
export interface PermitRequest {
  /** Settles exactly once, with whichever outcome won. */
  readonly promise: Promise<PermitOutcome>;
  /**
   * Abandons the wait. True ⇒ the entry was still waiting and is now dead: the
   * promise settles `cancelled`, everything this request was holding on to is
   * dropped, and the FIFO will never offer it a permit. False ⇒ either a
   * `release()` already handed this request the permit (its resolution is an
   * in-flight microtask), so the outcome is `granted` and the caller owes a
   * `release()` — see invariant 6's forwarding — or this request was already
   * cancelled. Either way there is nothing left to abandon and nothing is
   * settled here.
   */
  cancel(): boolean;
}

/**
 * Tiny FIFO async semaphore — the classic promise-queue pattern, no deps.
 * `acquire()` resolves once a slot is free (immediately if one already is,
 * otherwise once an earlier waiter's slot is `release()`d, in queue order).
 * The caller MUST `release()` exactly once per granted acquisition; inside this
 * module that obligation belongs to `transition()` alone, with the single
 * carve-out of invariant 6's forwarded grant (`claimPermit`) — the one grant
 * whose slot never enters a permit-holding state, so `transition()` has no
 * state exit to pair the release with.
 *
 * `acquireCancellable()` is the same wait with an exit: a waiter that dies
 * before its turn (invariant 7) drops the resolver nobody will ever call
 * instead of leaving it linked, and the inert entry that remains is compacted
 * away in amortized O(1) (invariant 8). `acquire()` is that request with the
 * exit dropped, for callers whose wait cannot be abandoned.
 */
export interface Semaphore {
  acquire(): Promise<void>;
  acquireCancellable(): PermitRequest;
  release(): void;
  /** Waiters still waiting. Invariant 7's observable — dead entries are excluded, they are shells, not waiters. */
  queued(): number;
  /** Invariant 8's observables: what the queue array is holding, and what maintaining it has cost. */
  queueStats(): SemaphoreQueueStats;
}

/**
 * The retention and cost observables of invariant 8. Nothing in the scheduler
 * reads these — the amortization and the array bound are properties no
 * caller-visible behaviour can distinguish (every scheme settles the same
 * requests with the same outcomes in the same order), so this is the only seam
 * a test can hold them to.
 */
export interface SemaphoreQueueStats {
  /** Live waiters — the same number `queued()` reports. */
  live: number;
  /** Entries in the backing array: live waiters plus dead shells not yet compacted away. Bounded by `2 * live + 1`. */
  capacity: number;
  /** Compaction passes run so far. A halving series over the array, so log-many per fan-out, not one per cancellation. */
  compactions: number;
  /**
   * Queue entries scanned or relocated on the CANCELLATION path, cumulatively —
   * the unit the amortization claim is made in. Dequeueing is deliberately not
   * counted: `shift()` is the engine's business (V8 left-trims it), and the
   * release path is identical under every queue scheme, so counting it would
   * add only noise common to all of them.
   */
  cancelWork: number;
}

/**
 * A waiter's place in the FIFO. Identity, not index: the queue shifts under it.
 *
 * `settle` is the whole state machine of one waiter. Non-null ⇒ live and still
 * owed an outcome. Null ⇒ settled and inert, by exactly one of the two paths
 * that can settle it — `release()` (which also shifts it out) or `cancel()`
 * (which leaves the now-empty shell behind for the next compaction). Nulling it
 * is therefore three things at once: the arbiter of the cancel-vs-grant race,
 * the mark that keeps a later `release()` from granting to a corpse, and the
 * drop that releases the resolver — and through it the promise chain, the
 * caller's slot, its label and every closure the wait captured.
 */
interface Waiter {
  settle: ((outcome: PermitOutcome) => void) | null;
}

export function createSemaphore(limit: number): Semaphore {
  let available = limit;
  const queue: Waiter[] = [];
  /** Shells currently in `queue` — cancelled waiters not yet compacted or walked past. */
  let dead = 0;
  let compactions = 0;
  let cancelWork = 0;

  /**
   * Already-satisfied request: nothing was queued, so there is nothing to
   * cancel and `cancel()` correctly reports "too late" — the permit is the
   * caller's and it owes a release either way.
   */
  const immediate: PermitRequest = { promise: Promise.resolve<PermitOutcome>("granted"), cancel: () => false };

  /** Rebuilds the queue from its live entries, in order. Stable: FIFO position survives it. */
  const compact = (): void => {
    const scanned = queue.length;
    let write = 0;
    for (let read = 0; read < scanned; read++) {
      const waiter = queue[read];
      if (waiter.settle !== null) queue[write++] = waiter;
    }
    queue.length = write;
    dead = 0;
    compactions++;
    cancelWork += scanned;
  };

  /**
   * MARK AND AMORTIZED-COMPACT, NOT SCAN-AND-SPLICE. Cancelling is O(1): the
   * waiter is marked dead by nulling its resolver, which is also what drops
   * everything the wait was holding on to, so what stays in the array is an
   * inert one-field shell and nothing else — invariant 7 is a statement about
   * BYTES retained, and it still holds in full.
   *
   * The shells themselves are then bounded by compacting HERE, on the
   * cancellation path, rather than opportunistically from `release()`: the case
   * that matters is a pool degraded to zero free permits, which by definition
   * produces no releases to compact against, so a release-driven scheme would
   * let the array grow without bound in precisely the situation it exists for.
   * A pass runs when the shells come to outnumber the live waiters, which
   * leaves two properties:
   *
   *  - the array never exceeds `2 * live + 1` entries, so retention stays
   *    proportional to the LIVE waiters exactly as before, and
   *  - the passes form a halving series, so N cancellations cost ~2N entry
   *    moves in total — amortized O(1) each — against the ~N²/2 of scanning
   *    for one's own entry and shifting the rest down. At the fan-out this
   *    pool degrades into (tens of thousands of expiries against a dead
   *    provider) that is the difference between a linear pass and seconds of
   *    blocked extension host.
   *
   * The cost of the shells that a compaction does not catch is paid by
   * `release()`, which walks past them; each walk retires one permanently, so
   * it is charged to the cancellation that created it and adds nothing
   * asymptotically.
   */
  const cancelWaiter = (waiter: Waiter): boolean => {
    const settle = waiter.settle;
    // Already null ⇒ this waiter has been settled: either `release()` shifted
    // it and granted it (its resolution is an in-flight microtask) or it was
    // cancelled before. Report "too late" rather than settling a second
    // outcome — the mark, not presence in the array, is what arbitrates the
    // race now that dead entries legitimately remain in it.
    if (settle === null) return false;
    // Mark first, settle second: from here on no `release()` can grant to this
    // entry, and the promise is completed with the reference we already hold.
    waiter.settle = null;
    settle("cancelled");
    dead++;
    if (dead > queue.length - dead) compact();
    return true;
  };

  const semaphore: Semaphore = {
    queued: () => queue.length - dead,
    queueStats: () => ({ live: queue.length - dead, capacity: queue.length, compactions, cancelWork }),
    acquire(): Promise<void> {
      // The uncancellable view of the same wait. It can only ever see
      // "granted": nothing but the returned handle can cancel a request, and
      // this drops the handle.
      return semaphore.acquireCancellable().promise.then(() => undefined);
    },
    acquireCancellable(): PermitRequest {
      if (available > 0) {
        available--;
        return immediate;
      }
      // Built inside the executor so the resolver has exactly one owner — the
      // waiter — and nulling `settle` really is the last reference to it.
      let waiter!: Waiter;
      const promise = new Promise<PermitOutcome>((resolve) => {
        waiter = { settle: resolve };
      });
      queue.push(waiter);
      return { promise, cancel: () => cancelWaiter(waiter) };
    },
    release(): void {
      // Hand the slot straight to the next FIFO waiter rather than
      // incrementing `available` and letting it race a fresh `acquire()` —
      // this is what makes queueing order (FIFO) actually meaningful.
      for (;;) {
        const next = queue.shift();
        if (next === undefined) {
          available++;
          return;
        }
        const settle = next.settle;
        // A shell a compaction has not reached yet. Walking past it retires it
        // for good (it is out of the array now), so this loop can only ever
        // repeat as many times in total as there have been cancellations.
        if (settle === null) {
          dead--;
          continue;
        }
        // Granted and settled in one synchronous step, so a `cancel()` racing
        // this from the same tick finds the mark already set and correctly
        // reports that the permit is the caller's.
        next.settle = null;
        settle("granted");
        return;
      }
    }
  };
  return semaphore;
}

/**
 * The lifecycle of one scheduled operation. Each one is in EXACTLY ONE of
 * these at any instant, and every arrow below is an entry in `LEGAL_NEXT`:
 *
 *   queued ──permit──> admitted ──start──> running ──work wins──────> settled
 *     │                    │                  │
 *     │                    │                  ├─deadline, room─────> orphaned ──work settles──> retired
 *     │                    │                  │
 *     │                    │                  └─deadline, no room──> held ──┬─work settles────> settled
 *     │                    │                                                └─room reopens────> promoted ──work settles──> retired
 *     │                    │
 *     │                    └─caller declines─> abandoned
 *     │
 *     └─deadline─────────> expired
 *
 * INVARIANTS — all of them enforced inside `transition()` (bar the one
 * explicitly carved out in 2 and 6), so no call site has to re-establish any
 * of them:
 *
 *  1. BOUNDED LIVE WORK. A slot holds whatever its operation costs the host —
 *     a read's buffer and open handle, a probe's pending provider request,
 *     and in both cases the caller context the work captured — while it is in
 *     any state other than the terminals. At most `maxConcurrent` slots hold a
 *     permit and at most `maxOrphaned` are charged to the detached pool, so at
 *     most `maxConcurrent + maxOrphaned` operations can be alive at once no
 *     matter how many callers pile in or how many providers stall. Promotion
 *     cannot widen that: it converts a held slot into an orphan slot, never
 *     adds one. `expired` costs nothing on either budget — the work of a slot
 *     that died in the queue was never started, so there is nothing to bound.
 *
 *  2. EXACTLY-ONCE PERMIT RELEASE. `admitted`, `running` and `held` are the
 *     permit-holding states (`PERMIT_HOLDING`); `transition()` releases the
 *     permit precisely when a slot leaves that set — normal settle, abort at
 *     admission, timeout with room, timeout without room, and promotion are
 *     all the same one line. A slot can leave a given state only once (the
 *     transition overwrites it, and no edge leads back in), so a second
 *     release is not expressible rather than being guarded against. The single
 *     release NOT written that way is the forwarded grant of invariant 6,
 *     which pairs with an `acquire()` whose slot never entered the set at all —
 *     there is no state exit for `transition()` to hang it off.
 *
 *  3. LIVENESS. A timed-out operation hands its permit back immediately while
 *     detachment capacity remains, so healthy callers are never stuck behind a
 *     stalled provider. Past that capacity the pool degrades on purpose —
 *     memory is the scarcer budget — but only for as long as it must: every
 *     decrement of the detached count re-runs `promoteHeld()`, which is the
 *     only thing that can reopen capacity and therefore the only place
 *     recovery needs to be triggered.
 *
 *  4. FIFO IN BOTH QUEUES. Admission order is the semaphore's (a released
 *     permit is handed to the longest-waiting acquirer, never returned to a
 *     pool a newcomer could race for). Promotion order is `held`'s: the slot
 *     that has been holding its permit longest — the one whose own work is
 *     least likely to ever settle — is promoted first, so a trickle of
 *     reopening capacity cannot starve it behind newer arrivals.
 *
 *  5. ONLY THE WINNER OF THE RACE MAY LOG. Work is never cancellable (neither
 *     `node:fs/promises` nor `vscode.workspace.fs` offers that), so a timed-out
 *     operation keeps running detached and eventually settles with a result
 *     nobody will receive. `run()` is handed a `logAllowed` predicate that goes
 *     false the instant the deadline fires — set before anything else the
 *     deadline does, so work settling in that same tick cannot slip a line in —
 *     and the caller uses it to suppress the audit line of a settlement that
 *     was already discarded.
 *
 *  6. THE DEADLINE BOUNDS THE WHOLE CALL, QUEUEING INCLUDED. `deadlineMs` is a
 *     promise made to the CALLER ("a `nexus.fs` call never blocks longer than
 *     30 seconds"), and a caller cannot tell the wait for a slot apart from
 *     the wait for a provider — so the wait for a slot has to be inside the
 *     bound. Bounding only the admitted phase leaves the one case that most
 *     needs the guarantee unbounded: a pool degraded to zero free permits
 *     (detachment budget full, every remaining permit `held` by work that
 *     never settles) queues newcomers indefinitely, which is precisely when a
 *     script hangs. Two consequences, both structural:
 *
 *      - ONE TIMER PER CALL, armed before the FIRST thing the call waits on
 *        and cleared once it settles either way. Not one per phase: a fresh
 *        timer at admission would hand a call that queued for 29s a whole new
 *        window, quietly doubling the advertised bound. The single fire
 *        handler branches on which phase the call is actually in, so the
 *        machine — not a flag the two phases have to keep in sync — decides
 *        what the deadline means.
 *      - A GRANT MADE TO A DEAD SLOT IS FORWARDED, NEVER KEPT. An expiring slot
 *        normally marks itself dead in the FIFO (invariant 7), so it is not
 *        owed anything — but a `release()` that shifted it in the same tick
 *        the deadline fired gets there first, and that grant arrives with
 *        nobody left to use it. `claimPermit` checks the slot's state at the
 *        moment of the grant and releases it straight back, so it reaches the
 *        next live waiter in FIFO order. Dropping it would shrink the pool by
 *        one permit per lost race until nothing could run at all; keeping it
 *        would start work for a caller that was already rejected. Since
 *        invariant 7 this is a RACE window, not the routine path — narrow,
 *        still reachable, and still the only thing standing between that race
 *        and a permanently smaller pool.
 *
 *  7. AN EXPIRED CALL RETAINS NOTHING. A call that dies in the queue lets go of
 *     everything it was holding: `cancel()` settles the wait so no continuation
 *     is left pending, and drops the resolver — and with it the promise chain,
 *     the slot, its label and every closure the wait captured. What stays in
 *     the FIFO is a one-field shell with a null in it, which the next
 *     compaction (invariant 8) removes. This matters most exactly where it is
 *     hardest to see — a pool degraded to zero free permits expires EVERY later
 *     call, so a wait that could not be abandoned would retain one live entry
 *     per call for the life of the host, and the permit that eventually
 *     reopened would have to be forwarded through every one of them before
 *     reaching a live caller. Retention is therefore bounded by the number of
 *     LIVE waiters; the only exception is the microtask-wide race window of
 *     invariant 6, where the entry has already been shifted out anyway and the
 *     grant is being handed on.
 *
 *  8. ABANDONING A WAIT IS O(1), AMORTIZED. Invariant 7's dropping is not
 *     allowed to cost a queue walk: the pool degrades all at once, so the
 *     expiries arrive all at once too, and a scheme that scanned for its own
 *     entry and shifted the rest down would turn a fan-out of N dead calls
 *     into ~N²/2 element moves on the extension host's only thread. Marking is
 *     O(1); the shells it leaves are bounded by compacting when they come to
 *     outnumber the live waiters, which keeps the queue array under
 *     `2 * live + 1` entries and costs ~2N moves for N cancellations — see
 *     `createSemaphore` for why that compaction is triggered by cancellation
 *     rather than by release. `queueStats()` is the observable; `queued()`
 *     continues to report LIVE waiters only, because a shell is not a waiter.
 */
type SlotState =
  | "queued"
  | "admitted"
  | "running"
  | "settled"
  | "abandoned"
  | "expired"
  | "orphaned"
  | "held"
  | "promoted"
  | "retired";

const LEGAL_NEXT: Record<SlotState, readonly SlotState[]> = {
  queued: ["admitted", "expired"],
  admitted: ["running", "abandoned"],
  running: ["settled", "orphaned", "held"],
  held: ["promoted", "settled"],
  orphaned: ["retired"],
  promoted: ["retired"],
  settled: [],
  abandoned: [],
  expired: [],
  retired: []
};

/** States in which the slot owns a semaphore permit. Leaving the set releases it — see invariant 2. */
const PERMIT_HOLDING: ReadonlySet<SlotState> = new Set<SlotState>(["admitted", "running", "held"]);

/** States charged against `maxOrphaned`: detached work whose buffer is still alive. */
const ORPHAN_OCCUPYING: ReadonlySet<SlotState> = new Set<SlotState>(["orphaned", "promoted"]);

interface ReadSlot {
  state: SlotState;
  readonly label: string;
}

/** An operation the scheduler races against its deadline. */
export interface DeadlineWork<T> {
  /**
   * Starts the operation. `logAllowed()` reports whether this operation's own
   * audit line may still be written — see invariant 5. Called exactly once,
   * synchronously, before the deadline timer is armed.
   */
  run(logAllowed: () => boolean): Promise<T>;
  /**
   * Builds the rejection the CALLER receives when the deadline wins. Called
   * once, after the log guard has closed and after the slot has been accounted
   * for, so anything it logs is the deadline's own line and nothing else's.
   */
  timeoutError(): unknown;
}

/** An operation that additionally consumes an admission permit. */
export interface GatedWork<T> extends DeadlineWork<T> {
  /** Names this slot in `snapshot()`; promotion order has no other observable. */
  label: string;
  /**
   * Runs the instant a permit is granted, before any I/O — the point at which
   * a caller can still decline work it queued for (its run ended while it sat
   * in the FIFO). Throwing releases the permit and rejects the call with the
   * thrown value.
   */
  onAdmitted?(): void;
}

/**
 * One call's deadline: a single armed timer plus the two things the rest of
 * the call needs from it — the audit guard (invariant 5) and a way to publish
 * the operation once it starts, so the fire handler can tell "still queueing"
 * (`started === undefined`) from "running" without a second flag to keep in
 * sync. See invariant 6 for why there is exactly one of these per call rather
 * than one per phase.
 */
interface CallDeadline<T> {
  /** Rejects with `timeoutError()` when the timer fires; never resolves. */
  readonly expiry: Promise<never>;
  /** False from the instant the timer fires — invariant 5's log guard. */
  readonly logAllowed: () => boolean;
  /** Publishes the started operation to the fire handler. Called once, by `raceWork`. */
  readonly started: (operation: Promise<T>) => void;
  /** Disarms the timer. Called once, from the call's own `finally`. */
  readonly clear: () => void;
}

export interface ReadSlotSnapshot {
  /** Slots currently holding a permit (`admitted` + `running` + `held`). */
  permitsInUse: number;
  /** Slots charged against the detached-work cap (`orphaned` + `promoted`). */
  orphaned: number;
  /** Labels of the timed-out slots still holding a permit, oldest first — index 0 is promoted next. */
  held: string[];
  /** Callers still linked in the admission FIFO, live ones only — the retention observable of invariant 7. */
  queued: number;
}

export interface ReadSlotSchedulerOptions {
  /** Concurrently admitted operations. Bounds the live caller buffers. */
  maxConcurrent: number;
  /** Deadline on every operation, gated or not. */
  deadlineMs: number;
  /** Detached (timed-out, still-running) operations tolerated before the pool degrades instead. */
  maxOrphaned: number;
}

export class ReadSlotScheduler {
  private readonly permits: Semaphore;
  private readonly maxConcurrent: number;
  private readonly deadlineMs: number;
  private readonly maxOrphaned: number;

  /** Slots in `held`, oldest first — the promotion queue (invariant 4). */
  private readonly held: ReadSlot[] = [];
  private orphaned = 0;
  private permitsInUse = 0;

  public constructor(options: ReadSlotSchedulerOptions) {
    this.maxConcurrent = options.maxConcurrent;
    this.deadlineMs = options.deadlineMs;
    this.maxOrphaned = options.maxOrphaned;
    this.permits = createSemaphore(options.maxConcurrent);
  }

  /** Read-only view of the machine's live state. */
  public snapshot(): ReadSlotSnapshot {
    return {
      permitsInUse: this.permitsInUse,
      orphaned: this.orphaned,
      held: this.held.map((slot) => slot.label),
      queued: this.permits.queued()
    };
  }

  /**
   * Queues for a permit, runs `work` under the deadline, and owns the permit
   * for every way out: settle, decline at admission, expiry while still
   * queued, timeout with detachment capacity, timeout without it, and
   * promotion afterwards. The deadline armed here spans BOTH phases — the wait
   * for a permit and the work itself (invariant 6).
   */
  public async runGated<T>(work: GatedWork<T>): Promise<T> {
    const slot: ReadSlot = { state: "queued", label: work.label };
    // The call's first act: take a place in the FIFO, so the timer armed on
    // the next line bounds a wait that already exists — and so the fire
    // handler has something to cancel (invariant 7). Both statements are
    // synchronous and neither can be interleaved with, so submission order is
    // still exactly the order `runGated` was called in.
    const grant = this.permits.acquireCancellable();
    const deadline = this.armDeadline<T>(work, (started) => {
      if (started === undefined) {
        // Nothing was ever started, so this call is still in the FIFO: there
        // is no work to detach and no buffer to charge — the slot just
        // expires. (`started === undefined` is exactly `state === "queued"`:
        // everything between admission and `run()` below is a single
        // microtask chain, and a timer callback is a macrotask, so the
        // deadline cannot land in between.)
        this.transition(slot, "expired");
        // Then abandon the wait, so this call retains nothing (invariant 7).
        // The transition comes FIRST: if `cancel()` reports the grant already
        // in flight, `claimPermit` needs to see the slot's real state to know
        // it must forward rather than admit (invariant 6).
        grant.cancel();
        return;
      }
      this.transition(slot, this.orphaned < this.maxOrphaned ? "orphaned" : "held");
      started
        // Whichever state the slot is in by the time its own work settles —
        // still `held`, or `orphaned`/`promoted` — this retires it. `held`
        // is the one case that still owes a permit.
        //
        // The transition runs in its own try so the catch below only ever
        // swallows the DISCARDED work rejection — an illegal-edge throw from
        // the machine itself must stay loud, not vanish into the same sink.
        .finally(() => {
          try {
            this.transition(slot, slot.state === "held" ? "settled" : "retired");
          } catch (err) {
            queueMicrotask(() => {
              throw err;
            });
          }
        })
        .catch(() => {
          // The detached result is discarded by design; `raceWork()` already
          // observes the operation itself, so only this derived promise
          // needs its own handler to stay out of the unhandled-rejection
          // reporter.
        });
    });
    try {
      // Phase 1 — the FIFO, under the same deadline as everything after it.
      // Losing this race means the call expired while queued: it has already
      // unlinked itself, and `claimPermit` settles without admitting anything
      // — or, in the race window, hands the grant on.
      await Promise.race([deadline.expiry, this.claimPermit(slot, grant, deadline)]);
      try {
        work.onAdmitted?.();
      } catch (err) {
        this.transition(slot, "abandoned");
        throw err;
      }
      this.transition(slot, "running");
      try {
        // Phase 2 — the work, under the REMAINDER of the same deadline.
        return await this.raceWork(work, deadline);
      } finally {
        // Reached on both the fulfilled and the rejected path. The slot is
        // still `running` only when the work itself won the race — after a
        // deadline it has already moved on, and the transition table would
        // reject this edge.
        if (slot.state === "running") this.transition(slot, "settled");
      }
    } finally {
      deadline.clear();
    }
  }

  /**
   * Waits for this slot's turn in the semaphore's FIFO and takes the permit.
   * Two ways that wait can end without an admission, and both settle here
   * rather than being left pending — a wait nobody will ever resume is the
   * retention invariant 7 exists to prevent:
   *
   *  - CANCELLED. The deadline expired the slot and marked it dead. No permit
   *    was ever granted, so there is nothing to hand back; this is the routine
   *    cleanup path for a call that dies in the queue.
   *  - GRANTED TO AN EXPIRED SLOT. Invariant 6's forwarding, now narrowed to
   *    the race it always described: a `release()` that shifted this waiter in
   *    the same tick the deadline fired, so `cancel()` found the grant already
   *    marked. The grant is real and belongs to whoever is behind us, so it is
   *    released straight back rather than dropped (which would shrink the
   *    pool) or used (which would start work for a rejected caller).
   *
   * The already-settled `expiry` is adopted as this branch's own outcome
   * rather than a fresh sentinel: the caller has been rejected with it either
   * way, so there is exactly one rejection value in play no matter which
   * promise the race in `runGated` happened to observe first.
   */
  private async claimPermit<T>(slot: ReadSlot, grant: PermitRequest, deadline: CallDeadline<T>): Promise<void> {
    if ((await grant.promise) === "cancelled") return deadline.expiry;
    if (slot.state === "expired") {
      this.permits.release();
      return deadline.expiry;
    }
    this.transition(slot, "admitted");
  }

  /**
   * The single mutator. `next` overwrites the current state before any effect
   * runs, so the edge just taken can never be taken again — which is what
   * makes the permit release below exactly-once by construction rather than by
   * agreement between call sites.
   */
  private transition(slot: ReadSlot, next: SlotState): void {
    const from = slot.state;
    if (!LEGAL_NEXT[from].includes(next)) {
      throw new Error(`ReadSlotScheduler: illegal transition ${from} → ${next} for ${slot.label}`);
    }
    slot.state = next;

    if (next === "held") this.held.push(slot);
    if (from === "held") {
      const idx = this.held.indexOf(slot);
      // A held slot missing from the held list means the list invariant is
      // already broken — fail loud rather than let splice(-1) silently evict
      // whichever slot happens to be last.
      if (idx === -1) {
        throw new Error(`ReadSlotScheduler: held slot ${slot.label} missing from held list`);
      }
      this.held.splice(idx, 1);
    }

    if (ORPHAN_OCCUPYING.has(next)) this.orphaned++;
    if (ORPHAN_OCCUPYING.has(from)) this.orphaned--;

    if (PERMIT_HOLDING.has(from)) {
      if (!PERMIT_HOLDING.has(next)) {
        this.permitsInUse--;
        this.permits.release();
      }
    } else if (PERMIT_HOLDING.has(next)) {
      this.permitsInUse++;
    }

    // A freed detached slot is the ONLY thing that can open promotion room,
    // so this is the only place recovery has to be attempted (invariant 3).
    if (ORPHAN_OCCUPYING.has(from)) this.promoteHeld();
  }

  /**
   * Converts permit-holding timed-out slots into detached ones, oldest first,
   * for as much capacity as just reopened. Each promotion hands the permit
   * back immediately — exactly as if that slot had timed out with room to
   * spare in the first place — while its still-running work moves onto the
   * detached budget it was previously kept off.
   */
  private promoteHeld(): void {
    while (this.orphaned < this.maxOrphaned && this.held.length > 0) {
      this.transition(this.held[0], "promoted");
    }
  }

  /**
   * Arms the call's one and only deadline (invariant 6) and hands back the
   * handle the phases share. `onFire` runs BEFORE the rejection is built, and
   * receives the started operation — or `undefined` if the call had not got
   * that far — so a single handler can account for whichever phase the
   * deadline actually landed in.
   *
   * The returned `expiry` must be raced from synchronously by the caller: the
   * timer cannot fire before the current synchronous block finishes, so a
   * caller that subscribes in the same block can never see an unhandled
   * rejection, and once subscribed it stays subscribed for the rest of the
   * call.
   */
  private armDeadline<T>(work: DeadlineWork<T>, onFire: (started: Promise<T> | undefined) => void): CallDeadline<T> {
    let fired = false;
    let started: Promise<T> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // First, before anything else can yield: work settling in this very
        // tick must not win the race to log (invariant 5).
        fired = true;
        onFire(started);
        reject(work.timeoutError());
      }, this.deadlineMs);
    });
    return {
      expiry,
      logAllowed: () => !fired,
      started: (operation) => {
        started = operation;
      },
      clear: () => clearTimeout(timer)
    };
  }

  /**
   * The work half of the race. `work` is never cancelled — there is no API to
   * cancel it — so the deadline's fire handler receives the now-detached
   * operation and is where a caller-side budget (if any) takes ownership of
   * it. Publishing `started` before awaiting is what lets that handler tell a
   * detached operation from a call that never left the queue.
   */
  private async raceWork<T>(work: DeadlineWork<T>, deadline: CallDeadline<T>): Promise<T> {
    const started = work.run(deadline.logAllowed);
    deadline.started(started);
    return await Promise.race([started, deadline.expiry]);
  }
}
