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
 * left waiting for another fire by an explicit decline.
 */
export interface InventoryStatusPollFireResult {
  /**
   * FALSE when no refresh actually happened for this source AND something later
   * can change that: it was mid-sync/edit/remove/control, or its credentials
   * were not in the vault yet. A provider that simply has no status to give, or
   * a lab box that answered with an error, both count as RAN — the tick did its
   * job and there is nothing to defer.
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
  /**
   * THE ONE THING THE ARM PROTOCOL REMEMBERS (review D6/E1/E2/F1): has any fire
   * for this source RUN since it was armed?
   *
   * Deliberately a STATE, not a debt. Five review rounds were spent on an
   * `armOwed` obligation — created only by a declined ARM fire, cancelled by
   * disarm, redeemed by a settle — and every one of them found a new way for
   * the obligation and the notification meant to discharge it to get out of
   * step. This says the same thing without an obligation to keep in step with
   * anything: the source wants a fire, and stops wanting one the moment it gets
   * one. Nothing can create it twice, nothing can resurrect it (arming resets
   * it), and it cannot outlive its arming (disarm deletes the schedule).
   *
   * It also subsumes two rules the debt needed separately. A ROUTINE tick that
   * RAN now discharges the arming as honestly as the arm tick would have —
   * status is on screen either way — so a settle after it fires nothing, where
   * the debt would have bought a redundant lab crawl. And an arm tick the LATCH
   * swallowed (a source re-armed while its previous sweep is still outstanding)
   * leaves this false, so the outstanding sweep discharges it if it ran and
   * leaves the source wanting a fire if it did not — where the debt recorded
   * nothing at all and the source waited a full period.
   */
  firedSinceArm: boolean;
  /**
   * WHICH INCARNATION THIS ARMING WAS MADE FOR (review G1) — the source's
   * `incarnation` as of the not-running → running transition, and the identity
   * `firedSinceArm` is implicitly a statement about.
   *
   * Without it `firedSinceArm` records THAT a fire ran, not WHICH arming it ran
   * under, and the retained-schedule trick below turns that into an ABA. A
   * replace-mode restore removes and recreates a source under the SAME id while
   * its sweep is outstanding: the schedule object is deliberately kept alive to
   * hold the latch, so it is re-armed in place — same object, same map entry —
   * and the old fire then resolves `ran: true` and discharges an arming it
   * never served. `schedules.get(id) !== schedule` cannot catch that; it is
   * the same object. The recreated source is left with no status at all (its
   * removal cleared it, and `refreshStatus` dropped the old report on its own
   * revision guard) until a whole period elapses.
   *
   * A COUNTER BUMPED ON EVERY ARMING would fix that case and break the one
   * beside it. A hide/show cycle re-arms the same record, and there the
   * outstanding sweep DOES serve the new arming — its report is applied — so
   * invalidating it buys a redundant crawl of the lab box. Only the incarnation
   * tells the two apart, and it does so by the same test `refreshStatus` uses
   * to decide whether the report was worth applying: a fire discharges the
   * arming exactly when its report could still have reached the tree.
   */
  armedIncarnation: string | undefined;
  /**
   * THE RE-TEST GUARD (review F1/G1). A reason to ask "does this source still
   * want a fire?" the moment the outstanding one completes — because while a
   * fire is in flight the question has no answer yet.
   *
   * Set by the two places that discover the question cannot be answered now: a
   * settle that arrives while a fire is in flight, and an ARM tick the latch
   * swallowed (a source re-armed while its previous sweep is still running).
   *
   * Without it the protocol has a check-then-act window straddling an await,
   * and the config-restore path walks straight into it: the restore persists a
   * source, the arm fire starts and goes off to read the vault, the mutation
   * queue drains and `sourceSettled` runs — finding a source that has neither
   * run a fire nor yet reported that it could not — and only afterwards does
   * the fire resolve `ran: false`. The only notification that could have helped
   * has already been and gone, and the source waits its whole configured
   * period, up to an hour.
   *
   * Recorded WITHOUT looking at `firedSinceArm`, because at that moment the
   * answer is not yet known; `release` asks the question again when it is. That
   * is the whole discipline — record the wakeup, re-test the condition after
   * the wait — and it is what makes a wakeup impossible to lose rather than
   * merely unlikely to be.
   *
   * It needs NO incarnation keying of its own, unlike `firedSinceArm`. It is
   * not an answer, only a prompt to look again, and the looking (`redeem`)
   * re-validates arming, incarnation and liveness against current state — so a
   * prompt recorded under a dead arming can only ever cause a fire the LIVE
   * arming was waiting for anyway.
   */
  pendingRecheck: boolean;
}

export interface InventoryStatusPoll {
  /**
   * "Something that could have been stopping this source's refresh has
   * finished." With no `sourceId`, every armed source. See the implementation's
   * own note for what it redeems and what it re-validates first.
   */
  sourceSettled(sourceId?: string): void;
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

  /**
   * Fires one tick for this source. Returns FALSE when the latch swallowed it,
   * so a redemption can record that it still has not happened rather than count
   * a tick that was never dispatched.
   */
  const tick = (id: string, schedule: SourceSchedule): boolean => {
    if (schedule.inFlight) {
      return false; // a prior sweep of THIS source is still running — do not stack another
    }
    // CAPTURED BEFORE THE FIRE (review G1). Everything this tick is later
    // allowed to conclude is a statement about the arming it was dispatched
    // under, and by the time it reports, the schedule may have been re-armed
    // in place for a DIFFERENT incarnation of the record.
    const dispatchedFor = schedule.armedIncarnation;
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
        // ANYTHING BUT AN EXPLICIT DECLINE DISCHARGES THE ARMING — but only
        // THE ARMING THIS FIRE WAS DISPATCHED UNDER (review G1). A `void`
        // result (a caller with nothing to say) and a REJECTED sweep (a lab box
        // that is down) both read as "ran": the tick reached the provider, and
        // there is nothing a later settle would do differently. A fire that
        // outlived its incarnation says nothing about the record standing here
        // now — its report was dropped by `refreshStatus`'s own revision guard
        // — so it discharges nothing and the new arming keeps waiting.
        if (schedule.armedIncarnation === dispatchedFor && !(outcome && outcome.ran === false)) {
          schedule.firedSinceArm = true;
        }
        // Take and clear the re-test guard BEFORE anything can return: a
        // recorded prompt is answered exactly once, here.
        const recheck = schedule.pendingRecheck;
        schedule.pendingRecheck = false;
        // The schedule may have been retired while its sweep was outstanding —
        // it was kept alive only to hold this latch (see `reevaluate`). Now that
        // the latch is released, drop it. A disarmed source wants nothing, so
        // the guard goes with it.
        if (schedule.timer === undefined) {
          schedules.delete(id);
          return;
        }
        if (recheck) {
          redeem(id, schedule);
        }
      };
      // Both settlements release: a rejected sweep must not wedge its source's
      // latch shut forever.
      (result as Promise<InventoryStatusPollFireResult | void>).then(release, () => release());
    } else {
      // Nothing to await, so nothing can decline it afterwards and nothing can
      // have re-armed underneath it: it ran, for this arming.
      schedule.firedSinceArm = true;
    }
    return true;
  };

  /**
   * Give an armed source the fire it is still waiting for, if it is still
   * waiting for one. The condition is re-tested HERE rather than trusted from
   * the caller, which is what lets every settle path — immediate, or deferred
   * through `pendingRecheck` — go through one door.
   *
   * A source that has already had a fire run since it armed, or that is no
   * longer armed at all (the user hid the panel, set the interval to 0, or
   * removed the source), gets nothing: there is no lab crawl to justify.
   */
  const redeem = (id: string, schedule: SourceSchedule): void => {
    if (schedule.firedSinceArm || schedule.timer === undefined) {
      return;
    }
    if (!tick(id, schedule)) {
      // The latch swallowed it. Record the question against the fire that is
      // holding the latch, so `release` re-tests instead of dropping it.
      schedule.pendingRecheck = true;
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
        // DISARM ENDS THE WAIT (review E2). The justification for firing at a
        // source that has not been refreshed since it armed is that it IS
        // armed; once it is not — interval 0, removed, no longer offered, or
        // the view hidden — a fire would crawl a lab box for a source nothing
        // is polling, against the very gating this scheduler exists to enforce.
        // `redeem` re-tests `timer` for exactly that, so clearing the re-test
        // guard here is hygiene rather than correctness — but the entry can
        // SURVIVE this loop (below) to hold its latch, and leaving a prompt on
        // a schedule whose arming is over reads as though it meant something.
        // `firedSinceArm` needs no clearing: a fresh arming resets it, and
        // until then nobody reads it.
        schedule.pendingRecheck = false;
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
          inFlight: false,
          armedIncarnation: source.incarnation,
          firedSinceArm: false,
          pendingRecheck: false
        };
        schedules.set(id, schedule);
      }
      if (schedule.timer === undefined) {
        // P3-8 — fire immediately ONLY on THIS source's not-running → running
        // transition (became visible / poll enabled / source added), so a reload
        // does not sit on an empty status map for a whole period. `tick` still
        // honours the latch, so a source re-armed while its previous sweep is
        // outstanding does not double-fire.
        schedule.seconds = seconds;
        // THE ARMING, stamped with the incarnation it is for. Set BEFORE the
        // tick so the fire it dispatches is captured against this arming.
        schedule.armedIncarnation = source.incarnation;
        // A FRESH ARMING WANTS A FIRE, whatever the last one got. Set BEFORE the
        // tick, so a fire that declines (or that the latch swallows) leaves the
        // source still waiting rather than reading as satisfied by history.
        schedule.firedSinceArm = false;
        if (!tick(id, schedule)) {
          // The latch swallowed the ARM tick — a source re-armed while its
          // previous sweep is still running. Record the question rather than
          // dropping it: `release` re-tests the moment the latch opens, which
          // is what gets a recreated source its fire without waiting for a
          // settle or a whole period.
          schedule.pendingRecheck = true;
        }
        schedule.timer = setInterval(() => tick(id, schedule!), seconds * 1000);
      } else {
        // ALREADY RUNNING. Two things can still have moved.
        if (schedule.armedIncarnation !== source.incarnation) {
          // A NEW INCARNATION UNDER A LIVE ARMING (review G1) — an Edit Source
          // save, which replaces the record in place: the id never leaves the
          // list, so nothing above disarms and re-arms it. It is a fresh arming
          // in every sense that matters here. `addOrUpdateInventorySource`
          // DROPS the source's runtime status whenever a config value changed,
          // so the tree is now blank for it; and any fire still in flight was
          // dispatched for the old record, so it discharges nothing. Without
          // this the source shows nothing until its next routine tick — up to
          // an hour after an edit the user just made.
          //
          // The TIMER IS LEFT ALONE, deliberately: re-arming it would restart
          // the phase on every edit. This changes only what the schedule is
          // waiting for, then asks for it — through `redeem`, which honours the
          // latch and re-validates like every other path.
          // Stamped BEFORE the ask, so a fire that re-enters `reevaluate`
          // synchronously sees an arming that already matches and cannot ask
          // again.
          schedule.armedIncarnation = source.incarnation;
          schedule.firedSinceArm = false;
          redeem(id, schedule);
        }
        if (schedule.seconds !== seconds) {
          // A period change REPLACES this source's timer with one at the current
          // period — never layers a second one on top — and does NOT re-fire of
          // itself. It is not a re-arming either: `firedSinceArm` is left
          // exactly as it was, so a source still waiting for its first fire
          // keeps waiting for it and one that has had it is not sent round
          // again. (In production a period change arrives WITH a new
          // incarnation — the interval lives in the source's config — so the
          // branch above has usually just asked for a fire; this one is only
          // about the timer.)
          clearInterval(schedule.timer);
          schedule.seconds = seconds;
          schedule.timer = setInterval(() => tick(id, schedule!), seconds * 1000);
        }
      }
      // Unchanged period and incarnation, already running: deliberately left
      // alone. Re-arming it would restart its phase every time an UNRELATED
      // source was edited, so a long-period source in a set that changes often
      // would never reach a tick.
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
    /**
     * "Something that could have been stopping this source's refresh has
     * finished." Brings a source the fire it has been waiting for since it
     * armed — and only that: a source that has already had one is left alone,
     * so a settle is never a lab crawl in its own right, however many arrive.
     *
     * Two callers, each reporting a fact it owns (see `extension.ts`): the
     * inventory commands, when a per-source busy claim is released — naming
     * that source; and the shared config-mutation lock, when the whole
     * mutation queue drains (a finished backup restore, complete reset or
     * migration) — naming none, which means "every armed source".
     *
     * THREE CASES, and the middle one is the whole point:
     *
     *  - NOT ARMED (`timer === undefined`): nothing. The source may be
     *    mid-teardown, holding a schedule entry open only for its latch; the
     *    user may have hidden the panel, zeroed the interval, or removed it.
     *    Firing at a source nothing is polling is exactly what the visible-gate
     *    exists to prevent.
     *  - A FIRE IS IN FLIGHT: the condition cannot be evaluated yet — that fire
     *    has not said whether it ran — so the wakeup is RECORDED against it
     *    (`pendingRecheck`) and `release` re-tests the moment it can. This is
     *    the case a check-then-act across the await silently dropped, and the
     *    config-restore path hits it every time: the restore persists a source,
     *    the arm fire goes off to read the vault, the mutation queue drains,
     *    and only afterwards does the fire report that it could not run.
     *  - OTHERWISE: `redeem` re-tests "still armed, still unfired" against LIVE
     *    state and fires if it holds. Nothing is scheduled, nothing retries on
     *    its own; the next settle asks again.
     */
    sourceSettled(sourceId?: string): void {
      for (const [id, schedule] of schedules) {
        if (sourceId !== undefined && id !== sourceId) {
          continue;
        }
        if (schedule.timer === undefined) {
          continue;
        }
        if (schedule.inFlight) {
          schedule.pendingRecheck = true;
          continue;
        }
        redeem(id, schedule);
      }
    },
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
