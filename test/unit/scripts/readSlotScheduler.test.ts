/*
 * Direct coverage of the read-slot state machine (readSlotScheduler.ts).
 *
 * These tests drive the scheduler with plain resolver-controlled promises and
 * a short real-timer deadline — no filesystem, no fake timers, no spy-count
 * inference. Every state the machine can be in is observable through
 * `snapshot()`, so each transition is asserted directly rather than deduced
 * from which caller happened to unblock.
 *
 * House rule (CLAUDE.md): every test must fail against the specific wrong
 * implementation it prevents. Each block below names its target-wrong-impl (⊘).
 */
import { describe, expect, it, vi } from "vitest";
import { ReadSlotScheduler, type GatedWork } from "../../../src/services/scripts/readSlotScheduler";

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

describe("ReadSlotScheduler — ungated work takes the deadline and nothing else", () => {
  it("never queues behind reads: a probe starts immediately with every permit occupied, and consumes none", async () => {
    // ⊘ routing an ungated probe through the gated path — with the pool
    // saturated it would sit in the FIFO instead of answering, which is what
    // makes a bufferless existence check cost a read's worth of capacity.
    const scheduler = makeScheduler({ maxConcurrent: 1, maxOrphaned: 1, deadlineMs: 5_000 });
    const readGate = deferred<string>();
    const read = scheduler.runGated({ label: "read", run: () => readGate.promise, timeoutError: () => TIMED_OUT });
    await tick(1);
    expect(scheduler.snapshot().permitsInUse).toBe(1);

    let probeStarted = false;
    const probe = scheduler.runUngated({
      run: () => {
        probeStarted = true;
        return Promise.resolve(true);
      },
      timeoutError: () => TIMED_OUT
    });
    await expect(probe).resolves.toBe(true);
    expect(probeStarted).toBe(true);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 1, orphaned: 0, held: [] });

    readGate.resolve("ok");
    await expect(read).resolves.toBe("ok");
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });
  });

  it("a timed-out probe charges no detached slot — that budget belongs to buffer-holding reads", async () => {
    // ⊘ letting an ungated timeout increment the detached count: it would
    // steal capacity from the reads the cap exists to bound, degrading the
    // pool to pay for memory nobody allocated. The discriminator is the
    // snapshot right after the probe's deadline, while its work is still
    // genuinely in flight.
    const scheduler = makeScheduler({ maxConcurrent: 1, maxOrphaned: 1 });
    const probeGate = deferred<boolean>();
    const probe = scheduler.runUngated({ run: () => probeGate.promise, timeoutError: () => TIMED_OUT });

    await expect(probe).rejects.toBe(TIMED_OUT);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });

    // With the pool uncontaminated, a read that times out afterwards still
    // finds room to detach and hands its permit straight back.
    const { work, gate } = stalledWork("read");
    await expect(scheduler.runGated(work)).rejects.toBe(TIMED_OUT);
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 1, held: [] });

    probeGate.resolve(true);
    gate.resolve("late");
    await tick();
    expect(scheduler.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });
  });

  it("returns a healthy result without waiting on the deadline", async () => {
    const scheduler = makeScheduler();
    await expect(
      scheduler.runUngated({ run: () => Promise.resolve(false), timeoutError: () => TIMED_OUT })
    ).resolves.toBe(false);
  });

  it("clears its deadline timer on the fast path", async () => {
    // ⊘ a `clearTimeout` reachable only from the timeout branch — every
    // healthy probe would pin a live timer for the whole deadline window.
    const scheduler = makeScheduler();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    try {
      await scheduler.runUngated({ run: () => Promise.resolve(true), timeoutError: () => TIMED_OUT });
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
  it("a stalled read on one scheduler charges nothing to another", async () => {
    // This is what lets a test start from a known-empty machine: detached work
    // outlives the call that started it, so per-instance state is the only
    // thing that keeps one test's stall out of the next test's budget.
    const first = makeScheduler({ maxConcurrent: 1, maxOrphaned: 1 });
    const second = makeScheduler({ maxConcurrent: 1, maxOrphaned: 1 });
    const { work, gate } = stalledWork("stall");
    await expect(first.runGated(work)).rejects.toBe(TIMED_OUT);

    expect(first.snapshot().orphaned).toBe(1);
    expect(second.snapshot()).toMatchObject({ permitsInUse: 0, orphaned: 0, held: [] });

    gate.resolve("late");
    await tick();
  });
});
