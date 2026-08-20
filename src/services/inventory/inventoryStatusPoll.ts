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
 *    transition, the warm-up, the replace-on-period-change, and the in-flight
 *    latch are all just per-source state, which is what they should have been.
 * The cost is N timer handles instead of one. That is the trade accepted.
 *
 * THE WARM-UP — how a declined fire is made good without being told when.
 * The requirement: a source's status should be fresh SOON after it becomes
 * pollable. The arm fire (the immediate tick on a source's not-running →
 * running transition) can legitimately be DECLINED by `refreshStatus`: the
 * source may be claimed by a sibling command (mid-sync/edit/remove/control),
 * or its declared credential may not be in the vault yet (mid-restore of a
 * backup). Both blockers clear moments later — and used to announce that
 * through two cross-module notification channels (a per-source "claim
 * released" observer on the inventory commands, and the config-mutation
 * lock's queue-drained event), which the scheduler redeemed against a
 * deferred-obligation protocol. Seven review rounds each found a new way for
 * the obligation and the notification meant to discharge it to get out of
 * step across an await.
 *
 * The warm-up replaces the notifications with a clock the scheduler already
 * owns. A schedule that has NOT yet had a fire RUN since its arming is
 * `warming`: its timer runs at a short warm delay instead of the configured
 * period, so a declined fire is simply retried on the next warm tick. The
 * first fire that RUNS promotes it to `steady` at the configured period. A
 * repeating timer is a wakeup that cannot be lost — there is no check-then-act
 * window for a notification to fall into, because there is no notification.
 *
 * What a warm retry COSTS, stated plainly: a declined fire never reaches the
 * network. `refreshStatus` refuses a claimed source, and a source with a
 * missing declared credential, BEFORE any provider call — the pre-checks are
 * map lookups and local `SecretStorage` reads. The only warm retry that
 * reaches the lab box is the one that succeeds. The warm delay still BACKS
 * OFF (5 s doubling per declined retry, capped at the source's own configured
 * period), so a source whose credentials never arrive converges to polling
 * its vault at exactly the cadence the user configured — no more than a
 * steady source costs — instead of every 5 s forever. The other residual cost
 * is latency: a blocker that clears is noticed by the NEXT warm tick rather
 * than at the instant it clears, i.e. within the current warm delay (5 s in
 * every fresh arming; more only after repeated declines).
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
  /**
   * WHICH INCARNATION OF THE RECORD this is (review G1) — `revision` in
   * production. A source id is NOT an identity: a replace-mode restore removes
   * and recreates the same id, and an Edit Source save replaces the record
   * under it. `NexusCore.addOrUpdateInventorySource` mints a fresh `revision`
   * on EVERY write and is the only place a live record's revision is ever
   * assigned, so it is exactly the codebase's own notion of "a new incarnation
   * of this record" — and exactly what `refreshStatus` compares before it
   * applies a report.
   *
   * The scheduler needs it for one question it cannot otherwise answer: a
   * hide/show cycle and a remove-and-recreate look identical from here (both
   * disarm, retain the schedule for its latch, and re-arm the same id), yet an
   * outstanding sweep SERVES the first and is discarded by the second. The
   * incarnation is the only thing that separates them.
   *
   * REQUIRED, though the value may be `undefined`: a supplier must name it
   * rather than be able to forget it. Absent on both sides reads as "the same
   * record", which is sound for the real supplier — a recreate necessarily goes
   * through `addOrUpdateInventorySource`, which cannot leave a record without
   * one — but a supplier that silently omitted it would reintroduce the ABA,
   * so the type does not let it.
   */
  incarnation: string | undefined;
}

/**
 * What a fire reports back. A caller with nothing to say returns `void`, which
 * reads as "it ran" — the conservative direction, since a source is only ever
 * left warming by an explicit decline.
 */
export interface InventoryStatusPollFireResult {
  /**
   * FALSE when no refresh actually happened for this source AND something later
   * can change that: it was mid-sync/edit/remove/control, or its credentials
   * were not in the vault yet. A provider that simply has no status to give, or
   * a lab box that answered with an error, both count as RAN — the tick did its
   * job and there is nothing to retry for.
   */
  ran: boolean;
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
  fire: (sourceId: string) => void | Promise<InventoryStatusPollFireResult | void>;
}

/** The first warm retry delay; doubles per declined warm retry, capped at the source's period. */
const WARM_INITIAL_DELAY_SECONDS = 5;

/** Live scheduling state for one source. `timer === undefined` means "not running". */
interface SourceSchedule {
  timer?: ReturnType<typeof setInterval>;
  /** This source's CONFIGURED period — what `steady` runs at. */
  seconds: number;
  /** The period the current `timer` is armed at, so a mere re-evaluation can leave it alone. */
  armedPeriodSeconds: number;
  /**
   * P2-1 in-flight latch, PER SOURCE: an EVE `fetchStatus` sweep is a full
   * folder walk with no overall deadline, and the interval can be as low as 1 s.
   * Without this a slow sweep would let every tick stack another concurrent
   * crawl of the same lab (each re-logging in). A tick for this source is
   * skipped while its previous sweep is still running — and only this source's:
   * a global latch would let one slow lab box suppress every other source's
   * refresh. Warm ticks honour it too, which is what keeps the warm-up from
   * ever stacking a crawl: a retry the latch swallows costs nothing, and the
   * next warm tick asks again.
   */
  inFlight: boolean;
  /**
   * THE ONE THING THE SCHEDULER REMEMBERS ABOUT AN ARMING: has any fire RUN
   * since this source armed? `warming` = not yet — the timer runs at the warm
   * delay and every tick is a (re)try; `steady` = yes — the timer runs at the
   * configured period.
   *
   * Deliberately a STATE, not a debt and not a notification. Earlier shapes
   * stored an obligation redeemed by cross-module settle events, and every
   * review round found a new way for the obligation and the event meant to
   * discharge it to get out of step across an await. This says the same thing
   * with nothing to keep in step: the source wants a fire, retries for one on
   * its own clock, and stops wanting one the moment it gets one. A decline
   * NEVER demotes `steady` — a routine tick declined mid-sync is made good by
   * the sync itself, which applies fresh status, so retrying would buy a
   * redundant crawl of a lab whose status is already on screen.
   */
  state: "warming" | "steady";
  /**
   * The current warm retry delay in seconds. Reset to the initial delay by
   * every fresh arming; doubled by each DECLINED warm retry (the declined ARM
   * fire itself does not double it — the first retry is always the initial
   * delay). The effective timer period while warming is
   * `min(warmDelaySeconds, seconds)`, so warming never runs slower than the
   * source's own cadence.
   */
  warmDelaySeconds: number;
  /**
   * WHICH INCARNATION THIS ARMING WAS MADE FOR (review G1) — the source's
   * `incarnation` as of the arming, and the identity `state` is implicitly a
   * statement about.
   *
   * Without it, promotion records THAT a fire ran, not WHICH arming it ran
   * under, and the retained-schedule trick below turns that into an ABA. A
   * replace-mode restore removes and recreates a source under the SAME id
   * while its sweep is outstanding: the schedule object is deliberately kept
   * alive to hold the latch, so it is re-armed in place — same object, same
   * map entry — and the old fire then resolves `ran: true` and promotes an
   * arming it never served. `schedules.get(id) !== schedule` cannot catch
   * that; it is the same object. The recreated source would be left with no
   * status at all (its removal cleared it, and `refreshStatus` dropped the old
   * report on its own revision guard) until a whole period elapsed.
   *
   * A COUNTER BUMPED ON EVERY ARMING would fix that case and break the one
   * beside it. A hide/show cycle re-arms the same record, and there the
   * outstanding sweep DOES serve the new arming — its report is applied — so
   * invalidating it buys a redundant crawl of the lab box. Only the
   * incarnation tells the two apart, and it does so by the same test
   * `refreshStatus` uses to decide whether the report was worth applying:
   * a fire promotes an arming exactly when its report could still have
   * reached the tree.
   */
  armedIncarnation: string | undefined;
  /**
   * WHICH ARMING is currently live — a serial bumped on EVERY fresh arming,
   * including one that re-arms the same record (a hide/show cycle). It exists
   * because the incarnation is DELIBERATELY too coarse for one of the two
   * rules a completed fire drives (see `release`): one record can be armed
   * many times, and while a fire that RAN under an earlier arming of the same
   * record still serves the current one (its report landed — promotion is
   * per-RECORD), a fire that was DECLINED says something only about the
   * arming that dispatched it. The current arming has its own fresh warm
   * timer already counting; a stale decline must not double its delay or
   * restart its phase (backoff is per-ARMING).
   */
  armingSerial: number;
}

export interface InventoryStatusPoll {
  dispose(): void;
}

export function startInventoryStatusPoll(options: InventoryStatusPollOptions): InventoryStatusPoll {
  let visible = false;
  const schedules = new Map<string, SourceSchedule>();

  const disarm = (schedule: SourceSchedule): void => {
    if (schedule.timer !== undefined) {
      clearInterval(schedule.timer);
      schedule.timer = undefined;
    }
  };

  /** The period the timer SHOULD be running at, given the schedule's state. */
  const effectivePeriodSeconds = (schedule: SourceSchedule): number =>
    schedule.state === "steady" ? schedule.seconds : Math.min(schedule.warmDelaySeconds, schedule.seconds);

  /**
   * Make the timer match the schedule's state — creating it if absent,
   * replacing it if armed at a different period, and LEAVING IT ALONE (phase
   * intact) if already right. That last case is the important one: this runs
   * on every re-evaluation, and re-arming an unchanged source would restart
   * its phase every time an UNRELATED source was edited, so a long-period
   * source in a set that changes often would never reach a tick.
   */
  const syncTimer = (id: string, schedule: SourceSchedule): void => {
    const period = effectivePeriodSeconds(schedule);
    if (schedule.timer !== undefined) {
      if (schedule.armedPeriodSeconds === period) {
        return;
      }
      clearInterval(schedule.timer);
    }
    schedule.armedPeriodSeconds = period;
    schedule.timer = setInterval(() => tick(id, schedule, true), period * 1000);
  };

  /**
   * Fires one tick for this source. `viaTimer` says whether the warm backoff
   * may advance on a decline: only a retry the WARM TIMER dispatched doubles
   * the delay — the arm fire's own decline does not, so the first retry is
   * always at the initial warm delay.
   */
  const tick = (id: string, schedule: SourceSchedule, viaTimer: boolean): void => {
    if (schedule.inFlight) {
      return; // a prior sweep of THIS source is still running — do not stack another
    }
    // CAPTURED BEFORE THE FIRE (review G1). Everything this tick is later
    // allowed to conclude is a statement about the arming it was dispatched
    // under, and by the time it reports, the schedule may have been re-armed
    // in place for a DIFFERENT incarnation of the record.
    const dispatchedFor = schedule.armedIncarnation;
    const dispatchedUnderArming = schedule.armingSerial;
    const result = options.fire(id);
    // Latch only while a real (pending) sweep is outstanding: a fire that
    // returns a thenable (the executeCommand path / a gated test) holds the
    // latch until it settles; a synchronous fire needs no latch at all.
    if (result && typeof (result as Promise<unknown>).then === "function") {
      schedule.inFlight = true;
      const release = (outcome?: InventoryStatusPollFireResult | void): void => {
        schedule.inFlight = false;
        if (schedules.get(id) !== schedule) {
          return; // replaced by a fresh entry — that one owns its own state
        }
        // The schedule may have been retired while its sweep was outstanding —
        // it was kept alive only to hold this latch (see `reevaluate`). Now
        // that the latch is released, drop it. A disarmed source wants nothing.
        if (schedule.timer === undefined) {
          schedules.delete(id);
          return;
        }
        // TWO RULES, AT TWO DELIBERATELY DIFFERENT GRANULARITIES. Do not
        // "fix" the asymmetry: each guard is load-bearing for a case the
        // other would get wrong.
        if (!(outcome && outcome.ran === false)) {
          // PROMOTION IS PER-RECORD (the incarnation). ANYTHING BUT AN
          // EXPLICIT DECLINE PROMOTES — a `void` result (a caller with
          // nothing to say) and a REJECTED sweep (a lab box that is down)
          // both read as "ran": the tick reached the provider, and there is
          // nothing a retry would do differently. A fire that outlived its
          // RECORD promotes nothing — its report was dropped by
          // `refreshStatus`'s own revision guard — but a fire that merely
          // outlived its ARMING of the same record (a hide/show cycle) still
          // put this record's status on screen, which is everything the new
          // arming is warming FOR. Keying this to the arming instead would
          // leave the source warming and buy a redundant crawl of the lab
          // box for status already applied.
          if (schedule.armedIncarnation === dispatchedFor) {
            schedule.state = "steady";
            syncTimer(id, schedule);
          }
          return;
        }
        // BACKOFF IS PER-ARMING (the serial). A decline is a statement about
        // THIS dispatched attempt, and an attempt belongs to the arming whose
        // timer (or arm transition) dispatched it — not to the record. A
        // fresh arming of the SAME record resets its warm delay to 5 s and
        // starts its own timer; a stale decline passes the incarnation test,
        // and letting it through here would double that delay and replace
        // that timer, silently breaking "the first retry after a fresh
        // arming is 5 s". The stale decline is simply dropped: the live
        // arming's own warm tick is already on its way to retry.
        if (schedule.armingSerial === dispatchedUnderArming && schedule.state === "warming") {
          if (viaTimer) {
            schedule.warmDelaySeconds *= 2;
          }
          // Re-arms at the (possibly backed-off) warm delay; a no-op when the
          // period is unchanged, so the pending warm tick keeps its phase.
          syncTimer(id, schedule);
        }
        // A DECLINED tick on a STEADY schedule changes nothing: see `state`.
      };
      // Both settlements release: a rejected sweep must not wedge its source's
      // latch shut forever.
      (result as Promise<InventoryStatusPollFireResult | void>).then(release, () => release());
    } else {
      // Nothing to await, so nothing can decline it afterwards and nothing can
      // have re-armed underneath it: it ran, for this arming.
      schedule.state = "steady";
      syncTimer(id, schedule);
    }
  };

  const reevaluate = (): void => {
    // What SHOULD be running right now. Nothing runs while the view is hidden.
    // The whole SOURCE is kept, not just its period: arming is a statement
    // about a particular incarnation of the record (see `armedIncarnation`).
    const desired = new Map<string, InventoryStatusPollSource>();
    if (visible) {
      for (const source of options.getSources()) {
        const seconds = source.intervalSeconds;
        // Non-finite is rejected as well as non-positive: `NaN * 1000` arms a
        // timer that reports itself as running and never fires on its period.
        if (Number.isFinite(seconds) && seconds > 0) {
          desired.set(source.id, source);
        }
      }
    }

    // Stop everything that should no longer run: a source removed, set to 0, or
    // the whole set going quiet because the view was hidden.
    for (const [id, schedule] of schedules) {
      if (!desired.has(id)) {
        disarm(schedule);
        // DISARM ENDS THE WARM-UP with the arming that justified it (review
        // E2's rule, kept): once a source is not armed — interval 0, removed,
        // no longer offered, or the view hidden — retrying would crawl a lab
        // box for a source nothing is polling, against the very gating this
        // scheduler exists to enforce. Clearing the timer IS the whole stop:
        // warming lives in the timer, and a fresh arming resets the rest.
        //
        // Keep a schedule whose sweep is still outstanding, purely so its latch
        // survives: dropping it here and re-adding the source a moment later
        // would let a second crawl start against a lab box already being
        // crawled. `release` prunes it once the sweep settles. This retention
        // is also why arming needs an identity of its own — the re-armed entry
        // is the SAME OBJECT, so object identity cannot tell the two apart.
        if (!schedule.inFlight) {
          schedules.delete(id);
        }
      }
    }

    for (const [id, source] of desired) {
      const seconds = source.intervalSeconds;
      let schedule = schedules.get(id);
      if (!schedule) {
        schedule = {
          seconds,
          armedPeriodSeconds: 0,
          inFlight: false,
          state: "warming",
          warmDelaySeconds: WARM_INITIAL_DELAY_SECONDS,
          armedIncarnation: source.incarnation,
          armingSerial: 0
        };
        schedules.set(id, schedule);
      }
      // A FRESH ARMING is a not-running → running transition (became visible /
      // poll enabled / source added) — OR a new incarnation under a live
      // arming (review G1): an Edit Source save replaces the record in place,
      // so the id never leaves the list and nothing disarms it, yet
      // `addOrUpdateInventorySource` DROPS the source's runtime status
      // whenever a config value changed, so the tree is now blank for it. It
      // is a fresh arming in every sense that matters here.
      const freshArming = schedule.timer === undefined || schedule.armedIncarnation !== source.incarnation;
      schedule.seconds = seconds;
      if (freshArming) {
        // Stamped BEFORE the tick, so the fire it dispatches is captured
        // against this arming — and so a fire that re-enters `reevaluate`
        // synchronously sees an arming that already matches.
        schedule.armedIncarnation = source.incarnation;
        // A FRESH ARMING WANTS A FIRE, whatever the last one got: back to
        // warming, backoff reset. Set BEFORE the tick, so a fire that declines
        // (or that the latch swallows) leaves the source warming rather than
        // reading as satisfied by history.
        schedule.state = "warming";
        schedule.warmDelaySeconds = WARM_INITIAL_DELAY_SECONDS;
        // THIS arming's identity, for the backoff rule: a decline reported by
        // a fire an EARLIER arming dispatched must not be charged to this one.
        schedule.armingSerial += 1;
        // P3-8 — fire immediately on the fresh arming, so a reload (or an
        // edit that just blanked the row) does not sit on an empty status map.
        // `tick` still honours the latch, so a source re-armed while its
        // previous sweep is outstanding does not double-fire — the warm timer
        // below is what retries once that latch opens.
        tick(id, schedule, false);
      }
      // Create / retune / leave alone, per `syncTimer`'s contract. Covers the
      // fresh arming (timer at the warm delay — or already at the configured
      // period, when a synchronous fire promoted it in the tick above), a
      // period change on a running source (REPLACES the timer, never layers a
      // second one, and does NOT re-fire — a period change is not a
      // re-arming: a warming source keeps warming, phase intact, and a steady
      // one is simply re-tuned), and the unchanged source (left alone).
      syncTimer(id, schedule);
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
