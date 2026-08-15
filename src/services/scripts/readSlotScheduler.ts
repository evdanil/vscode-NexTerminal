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
 * Tiny FIFO async semaphore — the classic promise-queue pattern, no deps.
 * `acquire()` resolves once a slot is free (immediately if one already is,
 * otherwise once an earlier waiter's slot is `release()`d, in queue order).
 * The caller MUST `release()` exactly once per `acquire()`; inside this module
 * that obligation belongs to `transition()` alone, with the single carve-out
 * of invariant 6's forwarded grant (`claimPermit`) — the one `acquire()` whose
 * slot never enters a permit-holding state, so `transition()` has no state
 * exit to pair the release with.
 */
export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
}

export function createSemaphore(limit: number): Semaphore {
  let available = limit;
  const queue: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      if (available > 0) {
        available--;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => queue.push(resolve));
    },
    release(): void {
      const next = queue.shift();
      // Hand the slot straight to the next FIFO waiter rather than
      // incrementing `available` and letting it race a fresh `acquire()` —
      // this is what makes queueing order (FIFO) actually meaningful.
      if (next) next();
      else available++;
    }
  };
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
 *      - A GRANT MADE TO A DEAD SLOT IS FORWARDED, NEVER KEPT. A slot that
 *        expires in the queue is still owed a permit by the semaphore, and
 *        that grant arrives later with nobody left to use it. `claimPermit`
 *        checks the slot's state at the moment of the grant and releases it
 *        straight back, so it reaches the next live waiter in FIFO order.
 *        Dropping it would shrink the pool by one permit per queued timeout
 *        until nothing could run at all; keeping it would start work for a
 *        caller that was already rejected.
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
      held: this.held.map((slot) => slot.label)
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
    const deadline = this.armDeadline<T>(work, (started) => {
      if (started === undefined) {
        // Nothing was ever started, so this call is still in the FIFO: there
        // is no work to detach and no buffer to charge — the slot just
        // expires. (`started === undefined` is exactly `state === "queued"`:
        // everything between admission and `run()` below is a single
        // microtask chain, and a timer callback is a macrotask, so the
        // deadline cannot land in between.) The permit this call is still
        // owed is handled by `claimPermit` — invariant 6.
        this.transition(slot, "expired");
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
      // Losing this race means the call expired while queued: `claimPermit`
      // stays alive to hand the grant on, but nothing else here runs.
      await Promise.race([deadline.expiry, this.claimPermit(slot, deadline)]);
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
   * Waits for this slot's turn in the semaphore's FIFO and takes the permit —
   * unless the deadline already expired the slot while it waited, in which
   * case the grant belongs to whoever is behind it (invariant 6). The
   * already-settled `expiry` is adopted as this branch's own outcome rather
   * than a fresh sentinel: the caller has been rejected with it either way, so
   * there is exactly one rejection value in play no matter which promise the
   * race in `runGated` happened to observe first.
   */
  private async claimPermit<T>(slot: ReadSlot, deadline: CallDeadline<T>): Promise<void> {
    await this.permits.acquire();
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
