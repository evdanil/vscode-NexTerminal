import { wireViewVisibility, type VisibilityAwareView } from "../terminal/viewVisibilityWiring";

/**
 * LIVE STATUS — the opt-in, visible-gated status poll. It refreshes an
 * inventory source's lab running status every N seconds, but ONLY while BOTH
 * hold:
 *  - the Command Center view is visible (no point refreshing a highlight nobody
 *    is looking at, and no reason to keep hitting a lab box while the panel is
 *    closed), and
 *  - that SOURCE's own interval is > 0 (0, or absent, means "off — use the
 *    manual command").
 *
 * PER SOURCE, not global. Up to 2.8.191 this was one `nexus.inventory.
 * statusPollSeconds` setting driving one timer that swept every source at one
 * cadence. A user with two lab servers could not poll the busy one often and
 * leave the quiet one alone, and the sweep's single in-flight latch meant one
 * slow lab box silently suppressed refreshes for every other source. The
 * interval now lives on the EVE-NG source (`readEveNgStatusPollSeconds`), and
 * the scheduling below mirrors that.
 *
 * SCHEDULING: ONE `setInterval` PER ARMED SOURCE, rather than a single timer at
 * the smallest positive interval that checks each source for dueness. The
 * per-source timer is both simpler and cheaper here:
 *  - Cheaper, because a shared timer must wake at the SMALLEST period to serve
 *    it — one source at 1 s and one at 3600 s means 3600 wakeups per hour
 *    either way for the fast source, plus 3599 no-op wakeups the slow source
 *    caused nothing of. N separate timers wake exactly as often as the sources
 *    actually want, and N is the number of EVE-NG sources a user has
 *    configured: single digits in practice.
 *  - Simpler, because dueness needs no wall-clock bookkeeping. A shared timer
 *    has to track each source's next-due instant, which means either reading
 *    the clock (drift, and a dependency the fake-timer tests would have to mock)
 *    or accumulating counters that go wrong the moment a period changes
 *    mid-cycle. `setInterval` already keeps a period for us.
 *  - And it makes every invariant PER SOURCE for free: the fire-once-on-arm
 *    transition, the replace-on-period-change, and the in-flight latch are all
 *    just per-source state, which is what they should have been.
 * The cost is N timer handles instead of one. That is the trade accepted.
 *
 * Kept in its own `vscode`-free module (only the type-only `VisibilityAwareView`
 * import, erased at compile time) so it unit-tests with a plain fake view and
 * fake timers — matching `viewVisibilityWiring.ts` / `orphanDetect.ts`. Uses the
 * global `setInterval`/`clearInterval` so `vi.useFakeTimers()` drives it.
 */
export interface InventoryStatusPollSource {
  /** The inventory source id `fire` is called with. */
  id: string;
  /** This source's poll interval in seconds; 0 (or less, or non-finite) disables it. */
  intervalSeconds: number;
}

/** What `fire` is told about the tick it is being called for. */
export interface InventoryStatusPollFireOptions {
  /**
   * TRUE only on this source's not-running → running transition fire (poll
   * enabled, source added, view shown) — the one tick with nothing behind it:
   * the source has no status on screen yet, and the next tick is a whole period
   * away, up to an hour.
   *
   * It matters to the caller because the refresh it performs is allowed to
   * REFUSE a source that is mid-sync/edit/remove/control, silently. A routine
   * tick that is refused costs one period; the ARM tick that is refused costs
   * everything the arm fire exists to buy, so the refresh remembers a refused
   * arm tick and makes good on it when the claim clears (see `refreshStatus` in
   * `commands/inventoryCommands.ts`). The scheduler is the only layer that
   * knows which tick is which, so it is the layer that says.
   */
  arm: boolean;
}

export interface InventoryStatusPollOptions {
  view: VisibilityAwareView;
  /**
   * The sources to poll and their current intervals, re-read on every
   * re-evaluation. A source absent from the list is not polled.
   */
  getSources: () => readonly InventoryStatusPollSource[];
  /**
   * Subscribe to anything that can change that list — a source added, edited or
   * removed. The callback re-evaluates the whole schedule.
   */
  onDidChangeSources: (listener: () => void) => { dispose(): void };
  /**
   * Refresh ONE source (typically executeCommand of refreshStatus for that
   * source id). May return a promise; when it does, that source's in-flight
   * latch awaits it so a slow sweep is never allowed to stack a second one for
   * the same source.
   */
  fire: (sourceId: string, options: InventoryStatusPollFireOptions) => void | Promise<void>;
}

/** Live scheduling state for one source. `timer === undefined` means "not running". */
interface SourceSchedule {
  timer?: ReturnType<typeof setInterval>;
  /** The period the current `timer` was armed at, so a mere re-evaluation can leave it alone. */
  seconds: number;
  /**
   * P2-1 in-flight latch, PER SOURCE: an EVE `fetchStatus` sweep is a full
   * folder walk with no overall deadline, and the interval can be as low as 1 s.
   * Without this a slow sweep would let every tick stack another concurrent
   * crawl of the same lab (each re-logging in). A tick for this source is
   * skipped while its previous sweep is still running — and only this source's:
   * a global latch would let one slow lab box suppress every other source's
   * refresh.
   */
  inFlight: boolean;
}

export function startInventoryStatusPoll(options: InventoryStatusPollOptions): { dispose(): void } {
  let visible = false;
  const schedules = new Map<string, SourceSchedule>();

  const disarm = (schedule: SourceSchedule): void => {
    if (schedule.timer !== undefined) {
      clearInterval(schedule.timer);
      schedule.timer = undefined;
    }
  };

  const tick = (id: string, schedule: SourceSchedule, arm: boolean): void => {
    if (schedule.inFlight) {
      return; // a prior sweep of THIS source is still running — do not stack another
    }
    const result = options.fire(id, { arm });
    // Latch only while a real (pending) sweep is outstanding: a fire that
    // returns a thenable (the executeCommand path / a gated test) holds the
    // latch until it settles; a synchronous fire needs no latch at all.
    if (result && typeof (result as Promise<void>).then === "function") {
      schedule.inFlight = true;
      const release = (): void => {
        schedule.inFlight = false;
        // The schedule may have been retired while its sweep was outstanding —
        // it was kept alive only to hold this latch (see `reevaluate`). Now that
        // the latch is released, drop it, but only if nothing has re-armed or
        // replaced it in the meantime.
        if (schedule.timer === undefined && schedules.get(id) === schedule) {
          schedules.delete(id);
        }
      };
      // Both settlements release: a REJECTED sweep (a lab box that is down)
      // must not wedge its source's latch shut forever.
      (result as Promise<void>).then(release, release);
    }
  };

  const reevaluate = (): void => {
    // What SHOULD be running right now. Nothing runs while the view is hidden.
    const desired = new Map<string, number>();
    if (visible) {
      for (const source of options.getSources()) {
        const seconds = source.intervalSeconds;
        // Non-finite is rejected as well as non-positive: `NaN * 1000` arms a
        // timer that reports itself as running and never fires on its period.
        if (Number.isFinite(seconds) && seconds > 0) {
          desired.set(source.id, seconds);
        }
      }
    }

    // Stop everything that should no longer run: a source removed, set to 0, or
    // the whole set going quiet because the view was hidden.
    for (const [id, schedule] of schedules) {
      if (!desired.has(id)) {
        disarm(schedule);
        // Keep a schedule whose sweep is still outstanding, purely so its latch
        // survives: dropping it here and re-adding the source a moment later
        // would let a second crawl start against a lab box already being
        // crawled. `release` prunes it once the sweep settles.
        if (!schedule.inFlight) {
          schedules.delete(id);
        }
      }
    }

    for (const [id, seconds] of desired) {
      let schedule = schedules.get(id);
      if (!schedule) {
        schedule = { seconds, inFlight: false };
        schedules.set(id, schedule);
      }
      if (schedule.timer === undefined) {
        // P3-8 — fire immediately ONLY on THIS source's not-running → running
        // transition (became visible / poll enabled / source added), so a reload
        // does not sit on an empty status map for a whole period. `tick` still
        // honours the latch, so a source re-armed while its previous sweep is
        // outstanding does not double-fire.
        schedule.seconds = seconds;
        // The ARM tick, announced as one: it is the fire that must not simply be
        // dropped if the refresh refuses it (see `InventoryStatusPollFireOptions.arm`).
        tick(id, schedule, true);
        schedule.timer = setInterval(() => tick(id, schedule!, false), seconds * 1000);
      } else if (schedule.seconds !== seconds) {
        // A period change REPLACES this source's timer with one at the current
        // period — never layers a second one on top — and does NOT re-fire.
        clearInterval(schedule.timer);
        schedule.seconds = seconds;
        schedule.timer = setInterval(() => tick(id, schedule!, false), seconds * 1000);
      }
      // Unchanged period, already running: deliberately left alone. Re-arming it
      // would restart its phase every time an UNRELATED source was edited, so a
      // long-period source in a set that changes often would never reach a tick.
    }
  };

  // Seeds `visible` from the view's CURRENT value immediately (createTreeView
  // does not fire the visibility event at registration), then keeps it updated.
  const visibilitySub = wireViewVisibility(options.view, (v) => {
    visible = v;
    reevaluate();
  });
  const sourcesSub = options.onDidChangeSources(reevaluate);

  return {
    dispose(): void {
      for (const schedule of schedules.values()) {
        disarm(schedule);
      }
      schedules.clear();
      visibilitySub.dispose();
      sourcesSub.dispose();
    }
  };
}
