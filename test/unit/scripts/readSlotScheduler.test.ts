/*
 * Direct coverage of the read-slot state machine (readSlotScheduler.ts).
 *
 * These tests drive the scheduler with plain resolver-controlled promises and
 * a short real-timer deadline — no filesystem, no spy-count inference. Every
 * state the machine can be in is observable through `snapshot()`, so each
 * transition is asserted directly rather than deduced from which caller
 * happened to unblock.
 *
 * The one exception is the same-tick race between a grant and an expiry (the
 * last block): real timers cannot express it, because Node drains microtasks
 * between two timer callbacks, so the grant a first deadline releases is always
 * consumed before a second deadline can fire. That block — and only that block
 * — installs fake timers, whose synchronous `advanceTimersByTime` runs both due
 * callbacks in one stack and therefore reproduces the window exactly.
 *
 * House rule (CLAUDE.md): every test must fail against the specific wrong
 * implementation it prevents. Each block below names its target-wrong-impl (⊘).
 */
import { describe, expect, it, vi } from "vitest";
import {
  createSemaphore,
  ReadSlotScheduler,
  type GatedWork,
  type PermitOutcome
} from "../../../src/services/scripts/readSlotScheduler";

/** Short enough to keep the suite fast, long enough that a healthy op wins the race comfortably. */
const DEADLINE_MS = 60;

function makeScheduler(overrides?: Partial<{ maxConcurrent: number; deadlineMs: number; maxOrphaned: number }>): ReadSlotScheduler {
  return new ReadSlotScheduler({ maxConcurrent: 2, deadlineMs: DEADLINE_MS, maxOrphaned: 2, ...overrides });
}

/** A resolver-controlled promise standing in for an operation the caller can stall at will. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const TIMED_OUT = Object.assign(new Error("timed out"), { code: "ReadFailed" });

/**
 * A gated operation that never settles on its own: the returned `gate` is the
 * only thing that can finish it. `logAllowed` is captured so a test can check
 * the audit guard at any point, and `runs()` reports how many times the
 * operation was actually STARTED — the observable that separates "waited in
 * the queue and was admitted" from "waited in the queue and never ran".
 */
function stalledWork(label: string, extra?: Partial<GatedWork<string>>): {
  work: GatedWork<string>;
  gate: { resolve: (value: string) => void; reject: (err: unknown) => void };
  logAllowed: () => boolean;
  runs: () => number;
} {
  const gate = deferred<string>();
  let allowed: () => boolean = () => true;
  let runs = 0;
  const work: GatedWork<string> = {
    label,
    run: (logAllowed) => {
      runs++;
      allowed = logAllowed;
      return gate.promise;
    },
    timeoutError: () => TIMED_OUT,
    ...extra
  };
  return { work, gate, logAllowed: () => allowed(), runs: () => runs };
}

/** Waits for `predicate` or fails after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Lets the microtask queue drain plus one macrotask turn. */
async function tick(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drains the microtask queue WITHOUT letting a macrotask (or a fake-timer
 * advance) run. `rounds` is generous: one admission walks several `await` hops
 * — the semaphore grant, `claimPermit`, the `Promise.race` in `runGated` — and
 * this must outlast the longest of those chains.
 */
async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// -----------------------------------------------------------------------------

describe("ReadSlotScheduler — exactly-once permit release on every path out of a slot", () => {
  it("normal settle: work wins the race and the permit goes back", async () => {
    const scheduler = makeScheduler();
    const { work, gate } = stalledWork("a");
    const call = scheduler.runGated(work);

    await tick(1);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 1, orphaned: 0, held: [] });

    gate.resolve("ok");
    await expect(call).resolves.toBe("ok");
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });
  });

  it("declined at admission: throwing from onAdmitted rejects the caller AND hands the permit straight back", async () => {
    // ⊘ an admission check whose caller-side `throw` escapes before the slot
    // is accounted for — the permit would leak, and `maxConcurrent` such
    // refusals would wedge the pool permanently. The second call below is the
    // discriminator: it can only be admitted if the first one's permit came
    // back.
    const scheduler = makeScheduler({ maxConcurrent: 1 });
    const refusal = new Error("run already stopped");
    const { work } = stalledWork("declined", {
      onAdmitted: () => {
        throw refusal;
      }
    });

    await expect(scheduler.runGated(work)).rejects.toBe(refusal);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });

    const { work: next, gate } = stalledWork("next");
    const call = scheduler.runGated(next);
    await tick(1);
    expect(scheduler.snapshot().permitsInUse).toBe(1);
    gate.resolve("through");
    await expect(call).resolves.toBe("through");
  });

  it("declined at admission: the work itself is never started", async () => {
    // ⊘ calling `run()` before `onAdmitted()` — an already-doomed call would
    // still perform its I/O, which is the entire point of checking at the
    // moment the permit is granted.
    const scheduler = makeScheduler();
    const run = vi.fn(() => Promise.resolve("never"));

    await expect(
      scheduler.runGated({
        label: "declined",
        run,
        timeoutError: () => TIMED_OUT,
        onAdmitted: () => {
          throw new Error("no");
        }
      })
    ).rejects.toThrow("no");
    expect(run).not.toHaveBeenCalled();
  });

  it("timeout under capacity: the caller is rejected, the permit is released immediately, and the slot is charged to the detached pool until its work settles", async () => {
    // ⊘ holding the permit until the (possibly never-settling) work finishes:
    // `permitsInUse` would stay at 1 after the deadline instead of dropping,
    // and a fresh caller would queue behind a read nobody is waiting for.
    const scheduler = makeScheduler();
    const { work, gate } = stalledWork("slow");
    const call = scheduler.runGated(work);

    await expect(call).rejects.toBe(TIMED_OUT);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 1, held: [] });

    gate.resolve("late");
    await tick();
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });
  });

  it("timeout at capacity: the permit is withheld, then released exactly once when that read's own work finally settles", async () => {
    // ⊘ releasing on the timeout regardless of the detached cap — `orphaned`
    // would climb past `maxOrphaned` and the memory bound would be gone.
    const scheduler = makeScheduler({ maxConcurrent: 3, maxOrphaned: 1 });
    const first = stalledWork("orphan");
    const second = stalledWork("held");
    const firstCall = scheduler.runGated(first.work);
    const secondCall = scheduler.runGated(second.work);

    await expect(firstCall).rejects.toBe(TIMED_OUT);
    await expect(secondCall).rejects.toBe(TIMED_OUT);
    // The cap admitted exactly one detached slot; the other kept its permit.
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 1, orphaned: 1, held: ["held"] });

    second.gate.resolve("late");
    await tick();
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 1, held: [] });

    first.gate.resolve("late");
    await tick();
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });
  });

  it("promotion: a held slot's permit is released the moment detached capacity reopens, and its own late settlement does NOT release a second time", async () => {
    // ⊘ a promoted slot whose eventual settlement still runs the held-branch
    // release — `permitsInUse` would go NEGATIVE below (a second permit
    // handed to a pool that never lent it), which is exactly the corruption
    // that lets more than `maxConcurrent` reads run at once.
    const scheduler = makeScheduler({ maxConcurrent: 3, maxOrphaned: 1 });
    const orphan = stalledWork("orphan");
    const held = stalledWork("held");
    await expect(scheduler.runGated(orphan.work)).rejects.toBe(TIMED_OUT);
    await expect(scheduler.runGated(held.work)).rejects.toBe(TIMED_OUT);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 1, orphaned: 1, held: ["held"] });

    // Capacity reopens — the held slot is promoted: permit back, detached
    // charge transferred, nothing new opened.
    orphan.gate.resolve("late");
    await waitFor(() => scheduler.snapshot().held.length === 0);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 1, held: [] });

    // The promoted slot settles on its own schedule: it retires its detached
    // charge and must NOT touch the permit pool again.
    held.gate.resolve("late");
    await tick();
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });
  });

  it("a rejected operation releases its permit exactly like a fulfilled one", async () => {
    // ⊘ a release reachable only on the fulfilled path.
    const scheduler = makeScheduler({ maxConcurrent: 1 });
    const { work, gate } = stalledWork("boom");
    const call = scheduler.runGated(work);
    const failure = new Error("read failed");
    gate.reject(failure);

    await expect(call).rejects.toBe(failure);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });
  });
});

describe("ReadSlotScheduler — admission", () => {
  it("admits at most maxConcurrent operations and starts the rest in FIFO submission order", async () => {
    // ⊘ a release that returns the slot to a free-count a newcomer can race
    // for instead of handing it to the longest-waiting acquirer: `started`
    // below would come back scrambled, and/or more than `maxConcurrent`
    // operations would be running at once.
    const scheduler = makeScheduler({ maxConcurrent: 2, deadlineMs: 5_000 });
    const started: string[] = [];
    const gates = new Map<string, { resolve: (v: string) => void }>();
    const labels = ["a", "b", "c", "d", "e"];

    const calls = labels.map((label) => {
      const gate = deferred<string>();
      gates.set(label, gate);
      return scheduler.runGated({
        label,
        run: () => {
          started.push(label);
          return gate.promise;
        },
        timeoutError: () => TIMED_OUT
      });
    });

    await tick(1);
    expect(started).toEqual(["a", "b"]);
    expect(scheduler.snapshot().permitsInUse).toBe(2);

    for (const label of labels) {
      gates.get(label)!.resolve(label);
      await tick(1);
    }
    await expect(Promise.all(calls)).resolves.toEqual(labels);
    expect(started).toEqual(labels);
    expect(scheduler.snapshot().permitsInUse).toBe(0);
  });

  it("the permit pool neither leaks nor gains capacity across a batch that had to queue", async () => {
    // ⊘ a release that BOTH hands the slot to the waiting acquirer and returns
    // it to the free count — the over-release is invisible while a queue
    // exists (one out, one in), and only shows up afterwards as a pool that
    // has silently grown. The first batch below is sized to force queueing, so
    // every release happens with a waiter present; the second batch is the
    // discriminator: with the pool inflated, three or four of its members
    // would start at once instead of `maxConcurrent`.
    const scheduler = makeScheduler({ maxConcurrent: 2, deadlineMs: 5_000 });
    const firstBatch = ["q0", "q1", "q2", "q3"].map((label) => {
      const gate = deferred<string>();
      return { gate, call: scheduler.runGated({ label, run: () => gate.promise, timeoutError: () => TIMED_OUT }) };
    });
    await tick(1);
    expect(scheduler.snapshot().permitsInUse).toBe(2);
    firstBatch.forEach((entry) => entry.gate.resolve("done"));
    await Promise.all(firstBatch.map((entry) => entry.call));
    expect(scheduler.snapshot().permitsInUse).toBe(0);

    const started: string[] = [];
    const secondBatch = ["r0", "r1", "r2", "r3"].map((label) => {
      const gate = deferred<string>();
      return {
        gate,
        call: scheduler.runGated({
          label,
          run: () => {
            started.push(label);
            return gate.promise;
          },
          timeoutError: () => TIMED_OUT
        })
      };
    });
    await tick(5);
    expect(started).toEqual(["r0", "r1"]);
    expect(scheduler.snapshot().permitsInUse).toBe(2);

    secondBatch.forEach((entry) => entry.gate.resolve("done"));
    await Promise.all(secondBatch.map((entry) => entry.call));
    expect(scheduler.snapshot().permitsInUse).toBe(0);
  });

  it("a queued operation starts only once a permit is genuinely free", async () => {
    // ⊘ an ungated runGated() — `c` would start immediately (and
    // `permitsInUse` would read 3, past the limit) rather than waiting for one
    // of the first two to finish.
    const scheduler = makeScheduler({ maxConcurrent: 2, deadlineMs: 5_000 });
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started: string[] = [];
    const calls = ["a", "b", "c"].map((label, i) =>
      scheduler.runGated({
        label,
        run: () => {
          started.push(label);
          return gates[i].promise;
        },
        timeoutError: () => TIMED_OUT
      })
    );

    await tick(5);
    expect(started).toEqual(["a", "b"]);
    expect(scheduler.snapshot().permitsInUse).toBe(2);

    gates[0].resolve("a");
    await waitFor(() => started.length === 3);
    expect(started).toEqual(["a", "b", "c"]);
    expect(scheduler.snapshot().permitsInUse).toBe(2);

    gates[1].resolve("b");
    gates[2].resolve("c");
    await expect(Promise.all(calls)).resolves.toEqual(["a", "b", "c"]);
    expect(scheduler.snapshot().permitsInUse).toBe(0);
  });
});

describe("ReadSlotScheduler — the deadline bounds the WHOLE call, queueing included", () => {
  /**
   * Saturates a `maxOrphaned: 0` pool with one operation that will never give
   * its permit back on its own: at its deadline it is `held` (there is no
   * detachment capacity to move it to), so the permit comes back only when the
   * returned gate is finally resolved. That makes "queued behind a pool that
   * will not free a slot" a state a test can hold indefinitely and step out of
   * on demand — the exact shape a stalled `nexus.fs` pool degrades into.
   */
  async function saturate(scheduler: ReadSlotScheduler): Promise<ReturnType<typeof stalledWork>> {
    const hog = stalledWork("hog");
    await expect(scheduler.runGated(hog.work)).rejects.toBe(TIMED_OUT);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 1, orphaned: 0, held: ["hog"] });
    return hog;
  }

  it("a call still queued when its deadline fires is rejected with the same timeoutError, and its work is never started", async () => {
    // ⊘ the pre-fix `runGated`, which armed the deadline only AFTER
    // `permits.acquire()` resolved: the queued call below would sit in the
    // FIFO forever behind a pool that never frees a slot — it would never
    // settle at all, and this test would fail on its own timeout rather than
    // on an assertion. The second half is the other wrong implementation: a
    // queued call that expires must never have started its work.
    const scheduler = makeScheduler({ maxConcurrent: 1, maxOrphaned: 0 });
    const hog = await saturate(scheduler);

    const stranded = stalledWork("stranded");
    await expect(scheduler.runGated(stranded.work)).rejects.toBe(TIMED_OUT);
    expect(stranded.runs()).toBe(0);
    // The expired slot took nothing with it: no permit, no detached charge,
    // and it never joined the promotion queue.
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 1, orphaned: 0, held: ["hog"] });

    hog.gate.resolve("late");
    await waitFor(() => scheduler.snapshot().permitsInUse === 0);
  });

  it("declining at admission still works for a call that queued first — expiry is the only new way out of the queue", async () => {
    // ⊘ a queued-deadline implementation that treats every grant to a
    // still-queued slot as expired (e.g. checking the timer rather than the
    // slot's own state): a call that queued and was admitted IN TIME would
    // stop reaching `onAdmitted` at all, silently dropping the aborted-run
    // check `scriptFs` relies on.
    const scheduler = makeScheduler({ maxConcurrent: 1, deadlineMs: 5_000 });
    const first = stalledWork("first");
    const firstCall = scheduler.runGated(first.work);
    await tick(1);

    const refusal = new Error("run already stopped");
    const queued = stalledWork("queued", {
      onAdmitted: () => {
        throw refusal;
      }
    });
    const queuedCall = scheduler.runGated(queued.work);
    await tick(1);
    expect(scheduler.snapshot().permitsInUse).toBe(1);

    first.gate.resolve("done");
    await expect(firstCall).resolves.toBe("done");
    await expect(queuedCall).rejects.toBe(refusal);
    expect(queued.runs()).toBe(0);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });
  });

  it("the permit granted to a call that already expired in the queue goes straight to the next live waiter — the pool neither leaks nor gains capacity", async () => {
    // ⊘ a queued-deadline implementation that forgets the grant the semaphore
    // still owes an expired waiter: that permit is simply lost, so `next`
    // below never starts (open capacity: 0) and the pool is permanently one
    // slot poorer for every call that ever timed out while queued. The
    // opposite mutation — releasing the grant AND keeping it — shows up in the
    // final drain check, where a two-deep batch would start both members at
    // once instead of one.
    const scheduler = makeScheduler({ maxConcurrent: 1, maxOrphaned: 0, deadlineMs: 200 });
    const hog = await saturate(scheduler);

    // Expires in the queue: the semaphore still owes this call a grant.
    const stranded = stalledWork("stranded");
    await expect(scheduler.runGated(stranded.work)).rejects.toBe(TIMED_OUT);
    expect(stranded.runs()).toBe(0);

    // A live waiter, queued behind the dead one.
    const next = stalledWork("next");
    const nextCall = scheduler.runGated(next.work);
    await tick(1);
    expect(next.runs()).toBe(0);

    // The hog's own work finally settles — `held → settled` hands exactly one
    // permit back, and the FIFO offers it to the expired waiter first.
    hog.gate.resolve("late");
    await waitFor(() => next.runs() === 1);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 1, orphaned: 0, held: [] });

    next.gate.resolve("through");
    await expect(nextCall).resolves.toBe("through");
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });

    // Full-drain check: capacity is EXACTLY maxConcurrent again — one of the
    // two starts, the other waits, and both settle.
    const a = stalledWork("a");
    const b = stalledWork("b");
    const aCall = scheduler.runGated(a.work);
    const bCall = scheduler.runGated(b.work);
    await tick(1);
    expect([a.runs(), b.runs()]).toEqual([1, 0]);

    a.gate.resolve("a");
    await waitFor(() => b.runs() === 1);
    b.gate.resolve("b");
    await expect(Promise.all([aCall, bCall])).resolves.toEqual(["a", "b"]);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });
  });

  it("one timer per call: a call that queues and then runs still registers (and clears) exactly one deadline", async () => {
    // ⊘ two independently-armed timers — one for the queue, a fresh one at
    // admission: a call that queued for 29s would then get a WHOLE new 30s
    // window, so the documented "never blocks longer than 30 seconds" bound
    // would silently become 60. One timer per call is what makes the bound the
    // whole call's.
    const scheduler = makeScheduler({ maxConcurrent: 1, deadlineMs: 5_000 });
    const first = stalledWork("first");
    const firstCall = scheduler.runGated(first.work);
    await tick(1);

    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    /** Only the scheduler's own deadline timers — this suite's polling helpers use short ones too. */
    const deadlineTimers = (): unknown[] =>
      setTimeoutSpy.mock.calls
        .map((call, i) => ({ delay: call[1], handle: setTimeoutSpy.mock.results[i]!.value as unknown }))
        .filter((entry) => entry.delay === 5_000)
        .map((entry) => entry.handle);
    try {
      const queued = stalledWork("queued");
      const queuedCall = scheduler.runGated(queued.work);
      await tick(1);
      expect(queued.runs()).toBe(0);
      // Armed once, before the wait for a permit — not once per phase.
      expect(deadlineTimers()).toHaveLength(1);

      first.gate.resolve("done");
      await expect(firstCall).resolves.toBe("done");
      await waitFor(() => queued.runs() === 1);
      // Admission did not arm a second one.
      expect(deadlineTimers()).toHaveLength(1);

      queued.gate.resolve("through");
      await expect(queuedCall).resolves.toBe("through");
      expect(clearTimeoutSpy.mock.calls.some((call) => call[0] === deadlineTimers()[0])).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});

describe("ReadSlotScheduler — detached-pool bound and promotion order", () => {
  it("never charges more than maxOrphaned detached slots, however many operations time out", async () => {
    // ⊘ an implementation that increments the detached count on every timeout
    // — `orphaned` would reach 6 below instead of plateauing at the cap, and
    // the host-memory bound the cap exists for would be gone.
    const scheduler = makeScheduler({ maxConcurrent: 6, maxOrphaned: 2 });
    const stalls = ["s0", "s1", "s2", "s3", "s4", "s5"].map((label) => stalledWork(label));
    const calls = stalls.map((s) => scheduler.runGated(s.work).catch(() => "timed out"));

    await Promise.all(calls);
    const snapshot = scheduler.snapshot();
    expect(snapshot.orphaned).toBe(2);
    expect(snapshot.held).toEqual(["s2", "s3", "s4", "s5"]);
    expect(snapshot.permitsInUse).toBe(4);

    stalls.forEach((s) => s.gate.resolve("late"));
    await waitFor(() => scheduler.snapshot().permitsInUse === 0 && scheduler.snapshot().orphaned === 0);
  });

  it("promotion is OLDEST-FIRST: each reopened detached slot goes to the read that has been holding its permit longest", async () => {
    // ⊘ draining the held queue newest-first — the oldest permit holder, whose
    // own work is the least likely to ever settle, would be promoted last, so
    // a trickle of reopening capacity could starve it indefinitely.
    const scheduler = makeScheduler({ maxConcurrent: 5, maxOrphaned: 1 });
    const orphan = stalledWork("orphan");
    await expect(scheduler.runGated(orphan.work)).rejects.toBe(TIMED_OUT);

    // Time these out one at a time so their held-queue order is unambiguous.
    const held = [];
    for (const label of ["h0", "h1", "h2"]) {
      const entry = stalledWork(label);
      held.push(entry);
      await expect(scheduler.runGated(entry.work)).rejects.toBe(TIMED_OUT);
    }
    expect(scheduler.snapshot().held).toEqual(["h0", "h1", "h2"]);

    // One slot reopens at a time; exactly one promotion each, always the oldest.
    const expectedRemaining = [["h1", "h2"], ["h2"], []];
    const reopeners = [orphan, held[0], held[1]];
    for (let step = 0; step < reopeners.length; step++) {
      reopeners[step].gate.resolve("late");
      await waitFor(() => scheduler.snapshot().held.length === expectedRemaining[step].length);
      expect(scheduler.snapshot().held).toEqual(expectedRemaining[step]);
      // The bound never widens: promotion converts a held slot into a
      // detached one, it never adds one.
      expect(scheduler.snapshot().orphaned).toBeLessThanOrEqual(1);
    }

    held[2].gate.resolve("late");
    await waitFor(() => scheduler.snapshot().orphaned === 0);
    expect(scheduler.snapshot().permitsInUse).toBe(0);
  });

  it("promotion cascades: reopening several slots at once promotes exactly that many, oldest first", async () => {
    // ⊘ a promotion pass that promotes only one entry per reopened slot
    // regardless of how much capacity is available (or, conversely, one that
    // ignores the cap and drains the whole queue).
    const scheduler = makeScheduler({ maxConcurrent: 6, maxOrphaned: 2 });
    const orphans = [stalledWork("o0"), stalledWork("o1")];
    for (const o of orphans) await expect(scheduler.runGated(o.work)).rejects.toBe(TIMED_OUT);
    const held = [stalledWork("h0"), stalledWork("h1"), stalledWork("h2")];
    for (const h of held) await expect(scheduler.runGated(h.work)).rejects.toBe(TIMED_OUT);
    expect(scheduler.snapshot()).toMatchObject({ orphaned: 2, held: ["h0", "h1", "h2"], permitsInUse: 3 });

    orphans.forEach((o) => o.gate.resolve("late"));
    await waitFor(() => scheduler.snapshot().held.length === 1);
    // Two slots reopened → exactly two promotions, and the cap still holds.
    expect(scheduler.snapshot()).toMatchObject({ orphaned: 2, held: ["h2"], permitsInUse: 1 });

    held.forEach((h) => h.gate.resolve("late"));
    await waitFor(() => scheduler.snapshot().orphaned === 0);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, held: [] });
  });
});

describe("ReadSlotScheduler — the audit guard belongs to whoever wins the race", () => {
  it("logAllowed() is true while the operation can still be heard, and false from the instant its deadline fires", async () => {
    // ⊘ never closing the guard: a detached operation settling long after its
    // caller was rejected would still be allowed to write its own (now
    // contradictory) audit line.
    const scheduler = makeScheduler();
    const { work, gate, logAllowed } = stalledWork("slow");
    const call = scheduler.runGated(work);

    await tick(1);
    expect(logAllowed()).toBe(true);

    await expect(call).rejects.toBe(TIMED_OUT);
    expect(logAllowed()).toBe(false);

    gate.resolve("late");
    await tick();
    expect(logAllowed()).toBe(false);
  });

  it("timeoutError() is built AFTER the guard closes, so the deadline's own line is the only one that can be written in that tick", async () => {
    // ⊘ constructing the rejection before flipping the guard — an operation
    // settling in the same tick could slip its line in ahead of the deadline's.
    const scheduler = makeScheduler();
    let guardAtErrorTime: boolean | undefined;
    let logAllowed: () => boolean = () => true;
    const gate = deferred<string>();

    await expect(
      scheduler.runGated({
        label: "slow",
        run: (allowed) => {
          logAllowed = allowed;
          return gate.promise;
        },
        timeoutError: () => {
          guardAtErrorTime = logAllowed();
          return TIMED_OUT;
        }
      })
    ).rejects.toBe(TIMED_OUT);

    expect(guardAtErrorTime).toBe(false);
    gate.resolve("late");
    await tick();
  });

  it("the guard stays open for the whole of a healthy run", async () => {
    // ⊘ a guard that closes when the operation settles rather than when the
    // deadline fires — every normal read would lose its audit line.
    const scheduler = makeScheduler();
    let seen: boolean | undefined;
    const result = await scheduler.runGated({
      label: "quick",
      run: (allowed) => {
        seen = allowed();
        return Promise.resolve("ok");
      },
      timeoutError: () => TIMED_OUT
    });
    expect(result).toBe("ok");
    expect(seen).toBe(true);
  });
});

describe("ReadSlotScheduler — the deadline timer on the fast path", () => {
  it("a healthy call arms exactly one timer and clears it when it settles", async () => {
    // ⊘ a `clearTimeout` reachable only from the timeout branch — every
    // healthy call would pin a live timer for the whole deadline window.
    // (The queue-then-run case is covered by "one timer per call" above; this
    // is the same property for the simplest path there is.)
    const scheduler = makeScheduler();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    try {
      await scheduler.runGated({ label: "quick", run: () => Promise.resolve(true), timeoutError: () => TIMED_OUT });
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy.mock.calls[0][0]).toBe(setTimeoutSpy.mock.results[0].value);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});

describe("ReadSlotScheduler — instances are independent", () => {
  it("a stalled operation on one scheduler charges nothing to another", async () => {
    // This is what lets a test start from a known-empty machine: detached work
    // outlives the call that started it, so per-instance state is the only
    // thing that keeps one test's stall out of the next test's budget. It is
    // also what `scriptFs.ts` leans on to keep its read pool and its probe
    // pool from consuming each other's capacity — same machine, two instances,
    // no shared state between them.
    const first = makeScheduler({ maxConcurrent: 1, maxOrphaned: 1 });
    const second = makeScheduler({ maxConcurrent: 1, maxOrphaned: 1 });
    const { work, gate } = stalledWork("stall");
    await expect(first.runGated(work)).rejects.toBe(TIMED_OUT);

    expect(first.snapshot().orphaned).toBe(1);
    expect(second.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });

    // The second instance's own capacity is genuinely intact, not merely
    // reported as such: a call on it is admitted and runs while the first is
    // still fully occupied by its detached stall.
    const fresh = stalledWork("fresh");
    const freshCall = second.runGated(fresh.work);
    await tick(1);
    expect(fresh.runs()).toBe(1);
    expect(second.snapshot().permitsInUse).toBe(1);

    fresh.gate.resolve("through");
    await expect(freshCall).resolves.toBe("through");
    gate.resolve("late");
    await tick();
  });
});

describe("ReadSlotScheduler — a call that expires in the queue leaves NOTHING behind", () => {
  /**
   * Wide enough that retention is an order-of-magnitude difference rather than
   * an off-by-one, small enough that the suite stays fast. Stands in for the
   * real shape: a script fanning `nexus.fs` calls out at a dead provider, every
   * 30 seconds, for as long as the run lasts.
   */
  const FANOUT = 20;

  /**
   * Drives the pool to FULL degradation: one operation times out with no
   * detachment capacity, so it is `held` — its permit is withheld and can only
   * come back when its own (never-settling) work is finally gated open. Until
   * then the pool has zero free permits and no mechanism that could make one,
   * which is precisely the state every later call queues into and expires in.
   */
  async function degradePool(scheduler: ReadSlotScheduler): Promise<ReturnType<typeof stalledWork>> {
    const hog = stalledWork("hog");
    await expect(scheduler.runGated(hog.work)).rejects.toBe(TIMED_OUT);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 1, orphaned: 0, held: ["hog"], queued: 0 });
    return hog;
  }

  it("a fan-out that all expires in the queue retains no waiters at all", async () => {
    // ⊘ an `acquire()` with no cancellation path (the shipped implementation
    // before this fix): each expired call's RESOLVER stays linked in the FIFO
    // forever, so a degraded pool accumulates one dead promise, one slot label
    // and one closure per call, without bound, for as long as the host lives.
    // The caller-visible behaviour is identical either way — every call below
    // is rejected at its deadline regardless — so the retained queue is the
    // only thing that can tell the two implementations apart, and it reads 20
    // against the unfixed code and 0 against the fixed one.
    const scheduler = makeScheduler({ maxConcurrent: 1, maxOrphaned: 0 });
    const hog = await degradePool(scheduler);

    const stranded = Array.from({ length: FANOUT }, (_, i) => stalledWork(`stranded-${i}`));
    const results = await Promise.all(stranded.map((s) => scheduler.runGated(s.work).catch((e: unknown) => e)));

    expect(results).toEqual(Array.from({ length: FANOUT }, () => TIMED_OUT));
    // None of them ever ran: they died waiting for a permit.
    expect(stranded.map((s) => s.runs())).toEqual(Array.from({ length: FANOUT }, () => 0));
    // The machine is charged EXACTLY what it was before the fan-out — and the
    // fan-out is not still sitting in the FIFO waiting for a permit nobody
    // will ever use.
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 1, orphaned: 0, held: ["hog"], queued: 0 });

    hog.gate.resolve("late");
    await waitFor(() => scheduler.snapshot().permitsInUse === 0);
  });

  it("after a mass expiry the freed permit goes STRAIGHT to a live waiter, and the pool is still exactly maxConcurrent", async () => {
    // ⊘ two mutations at once. (a) No unlink: the live waiter below queues
    // BEHIND 20 dead ones, so the queue reads 21 instead of 1 and the permit
    // has to be forwarded through every corpse before it reaches anybody —
    // the assertion on `queued` fails long before any timing does. (b) Unlink
    // that ALSO forwards (cancel unlinks and `claimPermit` still hands a
    // permit back for the cancelled grant): each expiry quietly ADDS a permit,
    // so the final drain check starts both members of a two-deep batch at once
    // instead of one.
    const scheduler = makeScheduler({ maxConcurrent: 1, maxOrphaned: 0 });
    const hog = await degradePool(scheduler);

    const stranded = Array.from({ length: FANOUT }, (_, i) => stalledWork(`stranded-${i}`));
    await Promise.all(stranded.map((s) => scheduler.runGated(s.work).catch(() => undefined)));

    // A live caller arrives after the wreckage. It is the ONLY thing owed a
    // permit — the expired calls took their claims with them.
    const fresh = stalledWork("fresh");
    const freshCall = scheduler.runGated(fresh.work);
    await tick(1);
    expect(fresh.runs()).toBe(0);
    expect(scheduler.snapshot().queued).toBe(1);

    // One permit reopens: it reaches the live waiter with no forward hops.
    hog.gate.resolve("late");
    await waitFor(() => fresh.runs() === 1);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 1, orphaned: 0, held: [], queued: 0 });

    fresh.gate.resolve("through");
    await expect(freshCall).resolves.toBe("through");
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [], queued: 0 });

    // Full-drain check: the 20 expiries neither shrank nor grew the pool —
    // capacity is EXACTLY maxConcurrent, so one of these two starts and the
    // other waits.
    const a = stalledWork("a");
    const b = stalledWork("b");
    const aCall = scheduler.runGated(a.work);
    const bCall = scheduler.runGated(b.work);
    await tick(1);
    expect([a.runs(), b.runs()]).toEqual([1, 0]);

    a.gate.resolve("a");
    await waitFor(() => b.runs() === 1);
    b.gate.resolve("b");
    await expect(Promise.all([aCall, bCall])).resolves.toEqual(["a", "b"]);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [], queued: 0 });
  });
});

describe("createSemaphore — a cancelled wait unlinks, and cancel-vs-grant settles exactly once", () => {
  /** Every outcome the request promise ever produces, in order — one entry means "settled exactly once". */
  function record(request: { promise: Promise<PermitOutcome> }): PermitOutcome[] {
    const seen: PermitOutcome[] = [];
    void request.promise.then((outcome) => seen.push(outcome));
    return seen;
  }

  /**
   * How many permits the pool hands out without a single release — i.e. its
   * TRUE capacity right now. Probing with more requests than the limit is the
   * point: the surplus must stay queued, which is exactly what a pool that has
   * silently grown would fail to do. Leaves the pool exactly as it found it —
   * what was granted is handed back, what is still waiting is unlinked (the
   * surplus is unlinked FIRST, so the restoring releases cannot be intercepted
   * by this probe's own leftovers).
   */
  async function freeCapacity(sem: ReturnType<typeof createSemaphore>, probes: number): Promise<number> {
    const requests = Array.from({ length: probes }, () => sem.acquireCancellable());
    const outcomes: PermitOutcome[] = [];
    for (const request of requests) void request.promise.then((outcome) => outcomes.push(outcome));
    await flushMicrotasks();
    const granted = outcomes.filter((outcome) => outcome === "granted").length;
    const unlinked = requests.filter((request) => request.cancel()).length;
    expect(probes - unlinked).toBe(granted);
    for (let i = 0; i < granted; i++) sem.release();
    return granted;
  }

  it("cancel() unlinks a still-queued waiter, settles it as cancelled, and leaves the pool untouched", async () => {
    // ⊘ a `cancel()` that only marks a tombstone (or does nothing at all): the
    // entry stays linked, `queued()` never returns to 0, and a pool that is
    // degraded for a long time accumulates one entry per abandoned wait.
    const sem = createSemaphore(1);
    await sem.acquire();
    const request = sem.acquireCancellable();
    const outcomes = record(request);
    expect(sem.queued()).toBe(1);

    expect(request.cancel()).toBe(true);
    await flushMicrotasks();
    expect(outcomes).toEqual(["cancelled"]);
    expect(sem.queued()).toBe(0);
    // Cancelling took nothing from the pool: the one outstanding permit is
    // still the one this test acquired, and releasing it frees exactly one.
    sem.release();
    expect(await freeCapacity(sem, 3)).toBe(1);
  });

  it("cancel() after the grant is a no-op: the waiter is granted exactly once and owes a release", async () => {
    // ⊘ a `cancel()` that reports success regardless (or, worse, splices at
    // index -1 and evicts an unrelated waiter): the caller would believe the
    // permit was never granted, drop it, and the pool would shrink by one for
    // every such race — the deadlock this whole seam exists to prevent.
    const sem = createSemaphore(1);
    await sem.acquire();
    const request = sem.acquireCancellable();
    const outcomes = record(request);

    // The same tick, in the order the race produces: the grant lands first,
    // the deadline's cancel arrives behind it.
    sem.release();
    expect(request.cancel()).toBe(false);

    await flushMicrotasks();
    expect(outcomes).toEqual(["granted"]);
    expect(sem.queued()).toBe(0);
    // The permit is genuinely this waiter's — the pool has none free until it
    // hands it back, and then exactly one.
    expect(await freeCapacity(sem, 3)).toBe(0);
    sem.release();
    expect(await freeCapacity(sem, 3)).toBe(1);
  });

  it("a cancelled waiter never intercepts a later release — the permit reaches the next live waiter", async () => {
    // ⊘ a cancel that unlinks the wrong entry, or leaves a dead resolver the
    // next release would hand the permit to: `live` would never start.
    const sem = createSemaphore(1);
    await sem.acquire();
    const dead = sem.acquireCancellable();
    const live = sem.acquireCancellable();
    const liveOutcomes = record(live);
    expect(dead.cancel()).toBe(true);
    expect(sem.queued()).toBe(1);

    sem.release();
    await flushMicrotasks();
    expect(liveOutcomes).toEqual(["granted"]);
    expect(sem.queued()).toBe(0);
  });
});

describe("createSemaphore — mass cancellation is amortized, never quadratic", () => {
  /**
   * WHY A COUNTER AND NOT A STOPWATCH. The cost being asserted here is
   * per-cancel queue maintenance, and every scheme produces the same
   * caller-visible behaviour — the same outcomes, in the same order, for the
   * same requests — so behaviour cannot tell them apart at all. Wall clock can,
   * but only at sizes far past anything a suite should run: measured against
   * the splice-per-cancel implementation this replaces, 30_000 FIFO
   * cancellations move 450_015_000 array elements and still finish in ~70ms,
   * because V8 left-trims a `splice(0, 1)`. A ceiling loose enough not to flake
   * would therefore not fail against the quadratic implementation either — it
   * would be a decoration, not a discriminator. `queueStats().cancelWork`
   * counts the work directly (queue entries scanned or relocated on the
   * cancellation path), which is exact, order-independent and machine-
   * independent: ~2n for this scheme against ~n²/2 for a scan-and-splice one,
   * four orders of magnitude apart at the sizes below.
   */
  async function cancelFanout(n: number): Promise<{
    cancelWork: number;
    compactions: number;
    queued: number;
    capacity: number;
  }> {
    const sem = createSemaphore(1);
    // Degrade the pool: the single permit is taken and never handed back, so
    // every request below queues and none of them can be granted — the exact
    // state a stalled `nexus.fs` pool expires its whole fan-out in.
    await sem.acquire();
    const requests = Array.from({ length: n }, () => sem.acquireCancellable());
    expect(sem.queued()).toBe(n);

    const before = sem.queueStats();
    // FIFO order is the real one: deadlines fire in the order they were armed.
    let unlinked = 0;
    for (const request of requests) if (request.cancel()) unlinked++;
    expect(unlinked).toBe(n);

    const after = sem.queueStats();
    return {
      cancelWork: after.cancelWork - before.cancelWork,
      compactions: after.compactions - before.compactions,
      queued: sem.queued(),
      capacity: after.capacity
    };
  }

  it("expiring a whole fan-out costs work LINEAR in the fan-out, and leaves the queue empty", async () => {
    // ⊘ the splice-per-cancel implementation this replaces: each cancellation
    // scans the queue for its own entry and then shifts every entry behind it
    // down one, so N cancellations cost ~N²/2 element moves — 450 million of
    // them for the 30_000 below, on the extension host's only thread. The
    // assertion that discriminates is `cancelWork`: ~2N here (one halving
    // series of compaction passes), ~N²/2 there.
    const N = 30_000;
    const run = await cancelFanout(N);

    expect(run.queued).toBe(0);
    // Amortized O(1) per cancellation. The scheme's own bound is ~2N (the
    // compaction passes form a halving series over the array); 4N is slack for
    // the exact trigger point, and still 7_500x below the quadratic cost.
    expect(run.cancelWork).toBeLessThanOrEqual(4 * N);
    // Halving series ⇒ log-many passes, not one per cancellation.
    expect(run.compactions).toBeLessThanOrEqual(Math.ceil(Math.log2(N)) + 2);
    // Nothing at all is retained once the last live waiter is gone: the final
    // compaction has no survivors to keep, so the array itself is empty.
    expect(run.capacity).toBe(0);
  });

  it("the cost SHAPE is linear: doubling the fan-out roughly doubles the work, it does not quadruple it", async () => {
    // ⊘ any per-cancel-O(queue) scheme (splice, or a scan that compacts every
    // time): the absolute bound above could in principle be met by a lucky
    // constant, but the ratio cannot — quadratic work multiplies by 4 when the
    // fan-out doubles, amortized-linear work by 2.
    const small = await cancelFanout(8_000);
    const big = await cancelFanout(16_000);

    expect(big.cancelWork / small.cancelWork).toBeLessThanOrEqual(2.5);
  });

  it("the queue array never holds more than 2x the live waiters, and the survivors are still granted in FIFO order", async () => {
    // ⊘ marking without ever compacting: the dead shells stay in the array
    // forever, so `capacity` below reads 10_003 instead of <= 7 — the
    // retention the round-19 unlink existed to remove, reintroduced in a
    // cheaper-looking form. ⊘ a compaction that rebuilds the queue out of
    // order: the three survivors would come back scrambled.
    const DOOMED = 10_000;
    const sem = createSemaphore(1);
    await sem.acquire();

    // Survivors sit at the front, the middle and the back of the wreckage, so
    // a compaction that loses stability is visible in the grant order.
    const outcomes: PermitOutcome[][] = [];
    const survivors: ReturnType<typeof sem.acquireCancellable>[] = [];
    const doomed: ReturnType<typeof sem.acquireCancellable>[] = [];
    const addSurvivor = (): void => {
      const request = sem.acquireCancellable();
      const seen: PermitOutcome[] = [];
      void request.promise.then((outcome) => seen.push(outcome));
      outcomes.push(seen);
      survivors.push(request);
    };
    addSurvivor();
    for (let i = 0; i < DOOMED / 2; i++) doomed.push(sem.acquireCancellable());
    addSurvivor();
    for (let i = 0; i < DOOMED / 2; i++) doomed.push(sem.acquireCancellable());
    addSurvivor();
    expect(sem.queued()).toBe(DOOMED + 3);

    let unlinked = 0;
    for (const request of doomed) if (request.cancel()) unlinked++;
    expect(unlinked).toBe(DOOMED);

    // Live waiters only — the shells are not waiters, whatever the array
    // happens to still hold.
    expect(sem.queued()).toBe(3);
    // THE BOUND: live waiters plus shells, never more than 2x live + 1.
    expect(sem.queueStats().capacity).toBeLessThanOrEqual(2 * 3 + 1);
    expect(sem.queueStats().live).toBe(3);

    // Every cancelled wait settled, exactly once and as `cancelled` — the
    // shells are inert, not merely unreachable.
    const settled = await Promise.all(doomed.map((request) => request.promise));
    expect(settled).toHaveLength(DOOMED);
    expect(settled.filter((outcome) => outcome !== "cancelled")).toEqual([]);

    // The survivors are still a working FIFO: one permit each, in order.
    for (let i = 0; i < survivors.length; i++) {
      sem.release();
      await flushMicrotasks();
      expect(outcomes.map((seen) => seen.join(""))).toEqual(
        survivors.map((_, j) => (j <= i ? "granted" : ""))
      );
    }
    expect(sem.queued()).toBe(0);
    expect(sem.queueStats().capacity).toBe(0);
  });

  it("a release that meets a not-yet-compacted shell walks past it to the next live waiter", async () => {
    // ⊘ a `release()` that hands the permit to whatever `shift()` returns now
    // that cancellation leaves shells behind: the permit would land on a
    // corpse — silently swallowed (the pool loses a slot per abandoned wait)
    // or thrown on a null resolver — and `live` below would never start. The
    // fixture is built so no compaction can have run yet: one dead, one live,
    // and this scheme only compacts once the dead OUTNUMBER the live.
    const sem = createSemaphore(1);
    await sem.acquire();
    const dead = sem.acquireCancellable();
    const live = sem.acquireCancellable();
    const deadOutcomes: PermitOutcome[] = [];
    const liveOutcomes: PermitOutcome[] = [];
    void dead.promise.then((outcome) => deadOutcomes.push(outcome));
    void live.promise.then((outcome) => liveOutcomes.push(outcome));

    expect(dead.cancel()).toBe(true);
    // The shell is demonstrably still in the array — this is the state the
    // release below has to survive.
    expect(sem.queueStats()).toMatchObject({ capacity: 2, live: 1, compactions: 0 });

    sem.release();
    await flushMicrotasks();

    expect(liveOutcomes).toEqual(["granted"]);
    expect(deadOutcomes).toEqual(["cancelled"]);
    expect(sem.queued()).toBe(0);
    // The shell was retired by the walk, not left for the next release.
    expect(sem.queueStats().capacity).toBe(0);
  });

  it("the cancel-vs-grant race is arbitrated by the MARK, not by presence in the array", async () => {
    // ⊘ an arbiter that reads "is this entry still in the array?" — the
    // obvious carry-over from the splice scheme, and wrong the moment dead
    // entries legitimately stay in it: a second `cancel()` on an
    // already-cancelled request finds its shell still there, reports an unlink
    // that did not happen and counts the same corpse twice, after which
    // `queued()` under-reports the live waiters (0 instead of 1 below) and a
    // compaction can fire on a queue that has nothing to compact.
    const sem = createSemaphore(1);
    await sem.acquire();
    const shell = sem.acquireCancellable();
    const granted = sem.acquireCancellable();
    const seen: PermitOutcome[] = [];
    void granted.promise.then((outcome) => seen.push(outcome));

    expect(shell.cancel()).toBe(true);
    // One dead against one live is not enough to trigger a pass, so the shell
    // is demonstrably still linked — the state the wrong arbiter misreads.
    expect(sem.queueStats()).toMatchObject({ capacity: 2, live: 1, compactions: 0 });
    expect(shell.cancel()).toBe(false);
    expect(sem.queued()).toBe(1);

    // And the other side of the race: a request the FIFO has already granted
    // cannot be cancelled either — the caller owes that permit a release.
    sem.release();
    expect(granted.cancel()).toBe(false);

    await flushMicrotasks();
    expect(seen).toEqual(["granted"]);
    expect(sem.queued()).toBe(0);
  });
});

describe("ReadSlotScheduler — the grant that lands on an already-expired slot (the surviving race)", () => {
  /**
   * The race the unlink CANNOT close, reproduced deterministically. Two calls
   * share a deadline instant: the first is running (its timeout detaches it and
   * hands its permit back), the second is still queued (its timeout expires it).
   * When both fire in the same tick, the release happens BEFORE the expiry, so
   * the queued slot has already been handed the permit — `cancel()` finds
   * nothing to unlink and `claimPermit`'s forwarding is the only thing that can
   * return the permit to the pool.
   *
   * Fake timers are what make "the same tick" expressible: `advanceTimersByTime`
   * runs both due callbacks on one stack, with no microtask drain in between.
   * Under real timers Node drains microtasks between timer callbacks, so the
   * grant is always consumed before the second deadline can fire.
   */
  it("forwards the permit instead of losing or duplicating it, and the pool ends exactly at maxConcurrent", async () => {
    // ⊘ deleting the forwarding branch now that expiry unlinks: the branch is
    // rare, not dead, and without it this grant is dropped on the floor — the
    // pool below would come back with ZERO free permits and the next caller
    // would hang forever. ⊘ its opposite, forwarding AND keeping the grant:
    // the pool would come back with two.
    vi.useFakeTimers();
    try {
      const scheduler = new ReadSlotScheduler({ maxConcurrent: 1, deadlineMs: 1_000, maxOrphaned: 1 });
      const running = stalledWork("running");
      const runningCall = scheduler.runGated(running.work).catch((e: unknown) => e);
      await flushMicrotasks();
      expect(running.runs()).toBe(1);

      // Queued behind it, and — because no virtual time has passed — its
      // deadline is armed for the very same instant.
      const queued = stalledWork("queued");
      const queuedCall = scheduler.runGated(queued.work).catch((e: unknown) => e);
      await flushMicrotasks();
      expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 1, queued: 1 });

      // Both deadlines fire on one stack: the first detaches and releases,
      // which grants the permit to the second — which then expires.
      vi.advanceTimersByTime(1_000);
      await flushMicrotasks();

      expect(await runningCall).toBe(TIMED_OUT);
      expect(await queuedCall).toBe(TIMED_OUT);
      expect(queued.runs()).toBe(0);
      // The forwarded permit came back to the pool: nothing held, nothing
      // queued, one detached slot for the still-running work.
      expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 1, held: [], queued: 0 });

      // Capacity is EXACTLY one: a fresh caller is admitted straight away and
      // a second one has to wait for it.
      const first = stalledWork("first");
      const second = stalledWork("second");
      const firstCall = scheduler.runGated(first.work).catch((e: unknown) => e);
      const secondCall = scheduler.runGated(second.work).catch((e: unknown) => e);
      await flushMicrotasks();
      expect([first.runs(), second.runs()]).toEqual([1, 0]);

      first.gate.resolve("first");
      await flushMicrotasks();
      expect(second.runs()).toBe(1);
      second.gate.resolve("second");
      running.gate.resolve("late");
      await flushMicrotasks();
      expect(await firstCall).toBe("first");
      expect(await secondCall).toBe("second");
      expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [], queued: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
