import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startInventoryStatusPoll, type InventoryStatusPollSource } from "../../src/services/inventory/inventoryStatusPoll";
import type { VisibilityAwareView } from "../../src/services/terminal/viewVisibilityWiring";

/**
 * PER-SOURCE LAB STATUS POLL — the visible-gated poll, now scheduled per
 * inventory source rather than as one global sweep. Each source with a positive
 * interval gets its own timer: it fires once immediately on arm (so a window
 * reload / becoming-visible does not sit on an empty status map for a whole
 * period), WARMS at a short self-clocked retry cadence until a fire actually
 * RUNS (a fire can be declined — source busy, or credentials not in the vault
 * yet), and then runs STEADY at its own N seconds while the Command Center is
 * visible. A PER-SOURCE in-flight latch keeps one slow lab box from stacking
 * concurrent crawls against itself — without slowing down every other source,
 * which a single global latch did.
 *
 * This file deliberately does NOT mock `vscode`: the module under test must
 * stay `vscode`-free (type-only imports), and an accidental runtime import
 * would fail to resolve here rather than pass unnoticed.
 */
function makeView(initialVisible: boolean): VisibilityAwareView & { emit(visible: boolean): void } {
  let listener: ((e: { visible: boolean }) => void) | undefined;
  return {
    visible: initialVisible,
    onDidChangeVisibility(l) {
      listener = l;
      return { dispose: () => { listener = undefined; } };
    },
    emit(visible: boolean) {
      listener?.({ visible });
    }
  };
}

/**
 * A source as these tests write one. `incarnation` is REQUIRED on the module's
 * own contract — a supplier must not be able to forget it (see
 * `InventoryStatusPollSource`) — but most tests here are about scheduling, not
 * identity, and for them one unchanging record is the honest fixture. Omitting
 * it means "the same record throughout", which is what a hide/show cycle or a
 * period change actually is; the identity tests name it explicitly.
 */
type PollSourceSeed = { id: string; intervalSeconds: number; incarnation?: string };

function makeSourceFeed(initial: PollSourceSeed[]): {
  onDidChangeSources: (cb: () => void) => { dispose(): void };
  getSources: () => InventoryStatusPollSource[];
  set(next: PollSourceSeed[]): void;
  disposed: () => boolean;
} {
  let cb: (() => void) | undefined;
  let disposed = false;
  let sources = initial;
  const seen = (seeds: PollSourceSeed[]): InventoryStatusPollSource[] =>
    seeds.map((seed) => ({ id: seed.id, intervalSeconds: seed.intervalSeconds, incarnation: seed.incarnation }));
  return {
    getSources: () => seen(sources),
    onDidChangeSources(listener) {
      cb = listener;
      return { dispose: () => { disposed = true; cb = undefined; } };
    },
    /** Replace the source list AND announce it, the way a config write does. */
    set(next) {
      sources = next;
      cb?.();
    },
    disposed: () => disposed
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Calls of `fire`, in order, as the source ids they named. */
function firedIds(fire: { mock: { calls: unknown[][] } }): string[] {
  return fire.mock.calls.map((call) => String(call[0]));
}

describe("startInventoryStatusPoll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("gives every source with a positive interval its own cadence, naming the source on each fire (⊘ one global timer at one interval cannot poll a busy lab often and a quiet one rarely — the whole point of moving the setting onto the source)", () => {
    const view = makeView(true);
    const feed = makeSourceFeed([
      { id: "busy", intervalSeconds: 10 },
      { id: "quiet", intervalSeconds: 60 }
    ]);
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });

    // Both arm immediately, each named.
    expect(firedIds(fire).sort()).toEqual(["busy", "quiet"]);

    fire.mockClear();
    vi.advanceTimersByTime(60_000);
    // 60 s: six busy ticks, one quiet tick.
    expect(firedIds(fire).filter((id) => id === "busy")).toHaveLength(6);
    expect(firedIds(fire).filter((id) => id === "quiet")).toHaveLength(1);
  });

  it("does NOT arm a source whose interval is 0, and arms NO timer at all when no source has a positive one (⊘ a 0 interval that still arms busy-loops the provider; a timer with nothing to poll wakes the extension host for nothing)", () => {
    const view = makeView(true);
    const feed = makeSourceFeed([
      { id: "off", intervalSeconds: 0 },
      { id: "also-off", intervalSeconds: 0 }
    ]);
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });

    expect(fire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(600_000);
    expect(fire).not.toHaveBeenCalled();

    // One source turning on arms exactly one timer — the other stays off.
    feed.set([{ id: "off", intervalSeconds: 0 }, { id: "also-off", intervalSeconds: 30 }]);
    expect(firedIds(fire)).toEqual(["also-off"]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does NOT fire while hidden, and fires every armed source immediately when the view becomes visible (⊘ hammering a lab box while the panel is closed)", () => {
    const view = makeView(false);
    const feed = makeSourceFeed([{ id: "a", intervalSeconds: 30 }, { id: "b", intervalSeconds: 30 }]);
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });

    vi.advanceTimersByTime(90_000);
    expect(fire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    view.emit(true);
    expect(firedIds(fire).sort()).toEqual(["a", "b"]);
    fire.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(firedIds(fire).sort()).toEqual(["a", "b"]);
  });

  it("disarms every source when the view is hidden again (⊘ timers that keep firing after the panel closes)", () => {
    const view = makeView(true);
    const feed = makeSourceFeed([{ id: "a", intervalSeconds: 30 }, { id: "b", intervalSeconds: 45 }]);
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });

    fire.mockClear();
    view.emit(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(600_000);
    expect(fire).not.toHaveBeenCalled();
  });

  it("fires ONCE on a source's not-running → running transition and leaves every already-running source's cadence untouched (⊘ re-arming the whole set on any source's change resets a 60 s source's phase every time an unrelated source is edited, so it never actually reaches its period)", () => {
    const view = makeView(true);
    const feed = makeSourceFeed([{ id: "old", intervalSeconds: 60 }]);
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });

    expect(firedIds(fire)).toEqual(["old"]);
    fire.mockClear();

    // 45 s into `old`'s period, an unrelated source is added.
    vi.advanceTimersByTime(45_000);
    expect(fire).not.toHaveBeenCalled();
    feed.set([{ id: "old", intervalSeconds: 60 }, { id: "new", intervalSeconds: 60 }]);

    // Only the NEW source fires on the transition…
    expect(firedIds(fire)).toEqual(["new"]);
    fire.mockClear();

    // …and `old` is still 15 s from its own tick, not restarted at 60.
    vi.advanceTimersByTime(15_000);
    expect(firedIds(fire)).toEqual(["old"]);
  });

  /**
   * THE WARM-UP, replacing the settle-notification protocol (reviews D6-G1).
   *
   * The arm fire is the one tick that cannot simply be missed: a source that
   * has just started polling has no status on screen at all, and the next tick
   * is a whole period away — up to an hour. But the refresh it calls can
   * legitimately DECLINE to run: the source may be mid-sync/edit/remove/control
   * (`inFlightSourceIds`), or its credentials may not be in the vault yet
   * (mid-restore of a backup). A decline that is silently treated as "fired"
   * is the whole bug.
   *
   * Earlier shapes answered a decline with a NOTIFICATION: the command layer
   * reported "this source's claim was released", the config-mutation lock
   * reported "the queue drained", and the scheduler redeemed the arming when
   * one arrived. Every review round found a new way for the obligation and the
   * notification meant to discharge it to get out of step — a settle landing
   * while the fire was still deciding, an arm tick the latch swallowed, a
   * record replaced under a live arming. The warm-up deletes the notifications
   * instead of patching them: a schedule that has NOT yet had a fire RUN since
   * it armed is WARMING and retries on its own short clock (5 s, backing off
   * 5 → 10 → 20 → …, never slower than the source's own period); the first
   * fire that RUNS promotes it to STEADY at the configured period. A wakeup
   * that is a repeating timer cannot be lost, so there is no check-then-act
   * window to straddle. A declined fire costs nothing on the network — both
   * declines are refused before any provider call — so the only warm retry
   * that reaches the lab box is the one that succeeds.
   */
  describe("the warm-up, and the fire a source is still waiting for", () => {
    /** A fire that declines everything, as a busy / credential-less refresh does. */
    const declining = () => vi.fn(async () => ({ ran: false }));

    it("retries a DECLINED arm fire on the warm cadence — 5 s — instead of waiting the configured period (⊘ treating a decline as a fire loses the arm tick entirely: polling appears to do nothing for an hour)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }]);
      const fire = declining();
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });

      expect(firedIds(fire)).toEqual(["a"]);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fire).toHaveBeenCalledTimes(1); // not before the warm delay
      await vi.advanceTimersByTimeAsync(1);
      expect(fire).toHaveBeenCalledTimes(2); // the warm retry, at 5 s
      // Still exactly one timer for the source — warm scheduling replaces, never layers.
      expect(vi.getTimerCount()).toBe(1);
    });

    it("backs off while each retry is declined too — 5, 10, 20 s between attempts — and stops warming the moment one runs (⊘ a fixed 5 s retry polls the vault every 5 s forever for a source whose credentials never arrive; not stopping on a run crawls the lab on every warm tick)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }]);
      let ran = false;
      const fire = vi.fn(async () => ({ ran }));
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      expect(fire).toHaveBeenCalledTimes(1); // arm fire (t=0) — declined

      await vi.advanceTimersByTimeAsync(5_000); // t=5s
      expect(fire).toHaveBeenCalledTimes(2); // first retry — declined
      await vi.advanceTimersByTimeAsync(9_000); // t=14s
      expect(fire).toHaveBeenCalledTimes(2); // the next gap is 10 s, not 5
      await vi.advanceTimersByTimeAsync(1_000); // t=15s
      expect(fire).toHaveBeenCalledTimes(3); // second retry — declined
      await vi.advanceTimersByTimeAsync(19_000); // t=34s
      expect(fire).toHaveBeenCalledTimes(3); // the next gap is 20 s
      await vi.advanceTimersByTimeAsync(1_000); // t=35s
      expect(fire).toHaveBeenCalledTimes(4); // third retry — declined; next gap 40 s

      ran = true;
      await vi.advanceTimersByTimeAsync(40_000); // t=75s — this retry RUNS
      expect(fire).toHaveBeenCalledTimes(5);
      // STEADY now: no warm retry follows a fire that ran; the next tick is a
      // whole configured period away.
      await vi.advanceTimersByTimeAsync(200_000);
      expect(fire).toHaveBeenCalledTimes(5);
    });

    it("never warms SLOWER than the source's own cadence — the warm delay is capped at configuredSeconds (⊘ uncapped doubling makes the 'warm' retry of a 3 s source arrive after its own routine tick would have)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3 }]);
      const fire = declining();
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      expect(fire).toHaveBeenCalledTimes(1); // arm fire — declined

      await vi.advanceTimersByTimeAsync(3_000);
      expect(fire).toHaveBeenCalledTimes(2); // min(5, 3) = 3 s
      await vi.advanceTimersByTimeAsync(3_000);
      expect(fire).toHaveBeenCalledTimes(3); // min(10, 3) = 3 s — capped, not backed off past the period
    });

    it("asks for nothing more once a fire has RUN — no warm retry follows a successful arm fire (⊘ warming regardless of the outcome turns every arming into an extra lab crawl 5 s later)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }]);
      const fire = vi.fn(async () => ({ ran: true }));
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      expect(fire).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fire).toHaveBeenCalledTimes(1);
    });

    it("treats a fire that reports NOTHING as one that ran — the shape a caller with no outcome to give returns (⊘ reading a void result as a decline leaves every source warming after every tick, retrying forever)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }]);
      const fire = vi.fn();
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      expect(fire).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fire).toHaveBeenCalledTimes(1);
    });

    it("leaves a STEADY source alone when a later routine tick is declined — a decline never demotes (⊘ demoting on any decline buys an extra lab crawl after every sync, which has already applied fresh status, and after every node control, which fires its own refresh)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 30 }]);
      let ran = true;
      const fire = vi.fn(async () => ({ ran }));
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0); // the ARM fire ran → STEADY
      ran = false;
      await vi.advanceTimersByTimeAsync(30_000); // routine tick at t=30 — declined
      expect(fire).toHaveBeenCalledTimes(2);

      // No warm retry sneaks in: the next fire is the routine tick at t=60.
      await vi.advanceTimersByTimeAsync(29_000);
      expect(fire).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fire).toHaveBeenCalledTimes(3);
    });

    it("stops warming when the view is hidden, and a fresh show starts its own warm-up (⊘ a warm timer that survives the disarm crawls the lab after the user closed the panel — against the poll's own visible-gating)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }]);
      const fire = declining();
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      fire.mockClear();

      view.emit(false); // panel closed — nothing is armed any more
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(fire).not.toHaveBeenCalled();

      // Coming back is a fresh not-running → running transition: it fires its
      // OWN arm tick (one), with nothing carried over from the ended warm-up.
      view.emit(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).toHaveBeenCalledTimes(1);
    });

    it("stops warming when the source stops being polled at all — interval 0, removed, or no longer offered (⊘ a stale warm timer fires after the user turned polling off, or for a source that is gone)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }, { id: "b", intervalSeconds: 3600 }]);
      const fire = declining();
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      fire.mockClear();

      // `a` turned off; `b` removed from the list entirely.
      feed.set([{ id: "a", intervalSeconds: 0 }]);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(fire).not.toHaveBeenCalled();
    });

    /**
     * THE RESTORE ORDERING (review F1's scenario, without review F1's bug
     * class). The arm refresh is ASYNCHRONOUS: `refreshStatus` awaits a vault
     * read before it can say whether it ran, and a backup restore's mutation
     * queue routinely drains inside that window — the record lands, the arm
     * fire goes off to read the vault, the credentials are written, and only
     * then does the fire resolve `ran: false`. Under a settle-notification
     * protocol this was the lost-wakeup race. Under the warm-up there is no
     * notification to lose: the warm timer keeps its own clock, its ticks are
     * swallowed by the latch while the fire is still deciding (never stacking
     * a second crawl), and the first tick after the late decline retries.
     */
    it("retries after a fire that reports its decline LATE, while warm ticks during the in-flight window are swallowed by the latch (⊘ counting the latch-swallowed tick as a retry stacks a second crawl; not retrying after the late decline strands a restored source for its whole configured period)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }]);
      const gate = deferred();
      let call = 0;
      const fire = vi.fn(() => {
        call++;
        // The arm fire reads the vault first, so it reports LATE — and declines.
        return call === 1 ? gate.promise.then(() => ({ ran: false })) : Promise.resolve({ ran: true });
      });
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      expect(fire).toHaveBeenCalledTimes(1); // armed; the fire is still in flight

      // Two warm ticks pass while the arm fire is still deciding — both
      // swallowed by the in-flight latch, neither reaching `fire`.
      await vi.advanceTimersByTimeAsync(12_000);
      expect(fire).toHaveBeenCalledTimes(1);

      gate.resolve(); // the decline lands (the restore has written the credential by now)
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).toHaveBeenCalledTimes(1); // the retry is the next warm TICK, not the release itself
      await vi.advanceTimersByTimeAsync(3_000); // t=15s — the warm timer's next tick
      expect(fire).toHaveBeenCalledTimes(2);
      // That one ran → STEADY: nothing more until the configured period.
      await vi.advanceTimersByTimeAsync(100_000);
      expect(fire).toHaveBeenCalledTimes(2);
    });

    /**
     * THE ABA (review G1). Promotion records THAT a fire ran; on its own that
     * does not record WHICH arming it ran under, and the retained-schedule
     * trick turns that into an identity bug.
     *
     * A replace-mode restore removes and recreates a source under the SAME id
     * while its sweep is outstanding. The schedule object is deliberately kept
     * alive to hold the latch, so it is re-armed IN PLACE — same object, same
     * map entry, which is why a `schedules.get(id) !== schedule` guard cannot
     * see it. Without the incarnation stamp the old fire resolves `ran: true`
     * and promotes an arming it never served; the recreated source is left
     * showing nothing at all (removal cleared its status, and `refreshStatus`
     * dropped the old report on its own revision guard) for a whole period.
     */
    it("does not let a sweep from the PREVIOUS incarnation promote a recreated source, which keeps warming and gets its fire on the next warm tick (⊘ an id is not an identity: the retained schedule is re-armed in place, so a fire that outlived the record it was dispatched for silently satisfies the new arming and the recreated source shows nothing for a whole period)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600, incarnation: "rev-1" }]);
      const gate = deferred();
      let call = 0;
      const fire = vi.fn(() => {
        call++;
        // The old incarnation's sweep runs to completion and reports that it RAN.
        return call === 1 ? gate.promise.then(() => ({ ran: true })) : Promise.resolve({ ran: true });
      });
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      expect(fire).toHaveBeenCalledTimes(1); // armed; its sweep is outstanding

      // A replace-mode restore: the source is removed…
      feed.set([]);
      // …and recreated under the SAME id, as a new record.
      feed.set([{ id: "a", intervalSeconds: 3600, incarnation: "rev-2" }]);
      expect(fire).toHaveBeenCalledTimes(1); // the arm tick is swallowed by the old sweep's latch

      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      // The old fire promoted NOTHING: the new arming is still warming, so its
      // next warm tick — not one second of the 3600 s period — brings the fire.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fire).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);
    });

    /**
     * The twin, and the reason arming identity is the SOURCE'S INCARNATION
     * rather than a counter bumped on every arming. A hide/show cycle re-arms
     * the same record, and there the outstanding sweep genuinely serves the new
     * arming — its report is applied — so treating every re-arm as a fresh
     * question buys a redundant crawl of the lab box. Only the incarnation
     * separates this from the case above, and it separates them by the same
     * test `refreshStatus` uses to decide whether the report was worth applying.
     */
    it("lets a sweep outstanding across a HIDE/SHOW cycle promote the new arming, because it is the same record and its report still lands (⊘ a counter bumped on every arming cannot tell a source that came back from one that was only hidden, and warm-crawls the lab again for status already on screen)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600, incarnation: "rev-1" }]);
      const gate = deferred();
      const fire = vi.fn(() => gate.promise.then(() => ({ ran: true })));
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      expect(fire).toHaveBeenCalledTimes(1);

      view.emit(false); // disarmed; the entry survives only to hold its latch
      view.emit(true); // re-armed — SAME record, so the outstanding sweep is still ours
      expect(fire).toHaveBeenCalledTimes(1);

      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).toHaveBeenCalledTimes(1);

      // STEADY — no warm retry crawls the lab for status already on screen.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fire).toHaveBeenCalledTimes(1);
    });

    /**
     * The same identity assumption, reached without any disarm at all (review
     * G1 sweep). An **Edit Source** save REPLACES the record under a live
     * arming: the id never leaves the source list, so nothing disarms and
     * re-arms it. `addOrUpdateInventorySource` drops the source's runtime
     * status whenever a config value changed, so the row is blank — and would
     * stay blank until the next routine tick, up to an hour after an edit the
     * user just made. A new incarnation under a live arming is therefore a
     * FRESH ARMING in every sense: it fires immediately, and the steady
     * cadence restarts from the fire that served it. (Restarting THIS source's
     * phase on ITS OWN edit is deliberate — the fresh fire just put fresh
     * status on screen, so "configured seconds from now" is the honest next
     * due time. What must never restart is an UNRELATED source's phase, which
     * the transition test above pins.)
     */
    it("treats a record REPLACED under a live arming as a fresh arming: fires immediately, and the steady cadence restarts from the fire that served it (⊘ an edit drops the source's runtime status while the old arming still reads as satisfied, so the row goes blank for up to an hour)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 30, incarnation: "rev-1" }]);
      const fire = vi.fn(async () => ({ ran: true }));
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).toHaveBeenCalledTimes(1);

      // Half a period in, the record is replaced — same id, same interval.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fire).toHaveBeenCalledTimes(1);
      feed.set([{ id: "a", intervalSeconds: 30, incarnation: "rev-2" }]);
      expect(fire).toHaveBeenCalledTimes(2); // the fresh arming's immediate fire
      await vi.advanceTimersByTimeAsync(0); // …which RAN → STEADY

      // The cadence restarts from that fire: nothing at the OLD phase mark
      // (t=30), the next routine tick lands 30 s after the edit (t=45).
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fire).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fire).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(1);
    });

    /**
     * A RE-ARMING the latch swallowed. A source re-armed while a ROUTINE sweep
     * is outstanding gets no arm fire (the latch swallows it, correctly), and
     * that sweep may then DECLINE. Nothing external announces anything — the
     * new arming is simply still warming, and its warm timer retries.
     */
    it("keeps a source re-armed behind an outstanding sweep warming when that sweep declines, so its warm tick brings the fire (⊘ trusting the swallowed arm tick, or the declined routine sweep, as the arming's fire leaves the source on an empty status map for a full period)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 30 }]);
      const gate = deferred();
      let call = 0;
      const fire = vi.fn(() => {
        call++;
        if (call === 1) return Promise.resolve({ ran: true }); // arm fire ran
        if (call === 2) return gate.promise.then(() => ({ ran: false })); // routine tick, slow, declined
        return Promise.resolve({ ran: true });
      });
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000); // routine tick — in flight
      expect(fire).toHaveBeenCalledTimes(2);

      view.emit(false); // disarmed; the entry survives only to hold its latch
      view.emit(true); // re-armed — its arm tick is swallowed by that latch
      expect(fire).toHaveBeenCalledTimes(2);

      gate.resolve();
      await vi.advanceTimersByTimeAsync(0); // the outstanding sweep DECLINED
      await vi.advanceTimersByTimeAsync(10_000); // within the warm window, not 30 s later
      expect(fire).toHaveBeenCalledTimes(3);
    });

    it("warms EVERY declined source independently — the shape a restore that persists sources before their credentials leaves behind (⊘ a lost arm fire per source leaves every one of them waiting a full period)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }, { id: "b", intervalSeconds: 3600 }]);
      const fire = declining();
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      fire.mockClear();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(firedIds(fire).sort()).toEqual(["a", "b"]);
    });

    it("keeps warming across a mere period change, which is not a re-arming (⊘ treating the replaced timer as a fresh arming re-fires on every re-tune; clearing the warm state there loses the arm fire for a source the user just re-tuned)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }]);
      const fire = declining();
      startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      fire.mockClear();

      feed.set([{ id: "a", intervalSeconds: 60 }]);
      expect(fire).not.toHaveBeenCalled(); // a period change never re-fires by itself
      await vi.advanceTimersByTimeAsync(5_000); // the warm retry still comes, on its own clock
      expect(firedIds(fire)).toEqual(["a"]);
    });
  });

  it("replaces a source's timer on an interval change WITHOUT a fresh immediate fire (⊘ firing on every config event turns a settings edit into a refresh storm)", () => {
    const view = makeView(true);
    const feed = makeSourceFeed([{ id: "a", intervalSeconds: 30 }]);
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });

    expect(firedIds(fire)).toEqual(["a"]);
    fire.mockClear();

    feed.set([{ id: "a", intervalSeconds: 60 }]);
    expect(fire).not.toHaveBeenCalled();
    // Exactly one timer for the source — the old one was replaced, not layered.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(fire).not.toHaveBeenCalled(); // 30 s into a 60 s period
    vi.advanceTimersByTime(30_000);
    expect(firedIds(fire)).toEqual(["a"]);
  });

  it("stops a source that goes to 0 or disappears, and leaves its neighbour running (⊘ tearing down every timer on a removal, or leaving a removed source's timer firing against a source that no longer exists)", () => {
    const view = makeView(true);
    const feed = makeSourceFeed([{ id: "a", intervalSeconds: 30 }, { id: "b", intervalSeconds: 30 }]);
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
    fire.mockClear();

    feed.set([{ id: "a", intervalSeconds: 0 }, { id: "b", intervalSeconds: 30 }]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(firedIds(fire)).toEqual(["b"]);

    fire.mockClear();
    feed.set([]); // both sources removed
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(300_000);
    expect(fire).not.toHaveBeenCalled();
  });

  it("latches PER SOURCE: a slow sweep skips only its OWN ticks, while every other source keeps polling on time (⊘ one shared latch lets one slow lab box silently stop every other source from refreshing; no latch at all lets a 1 s interval stack unbounded concurrent crawls)", async () => {
    const view = makeView(true);
    const feed = makeSourceFeed([{ id: "slow", intervalSeconds: 1 }, { id: "fast", intervalSeconds: 1 }]);
    const gate = deferred();
    const fire = vi.fn((id: string) => (id === "slow" ? gate.promise : Promise.resolve()));
    startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });

    expect(firedIds(fire).sort()).toEqual(["fast", "slow"]);
    fire.mockClear();

    await vi.advanceTimersByTimeAsync(5_000);
    // `slow` is still in flight — none of its ticks stacked…
    expect(firedIds(fire).filter((id) => id === "slow")).toHaveLength(0);
    // …and `fast` was not held hostage by it.
    expect(firedIds(fire).filter((id) => id === "fast")).toHaveLength(5);

    // The slow sweep completes → its latch releases → its next tick fires.
    fire.mockClear();
    gate.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(firedIds(fire).sort()).toEqual(["fast", "slow"]);
  });

  it("releases a source's latch when its sweep REJECTS, so one failed refresh does not stop that source forever (⊘ latching only on fulfilment wedges a source whose lab box is down)", async () => {
    const view = makeView(true);
    const feed = makeSourceFeed([{ id: "a", intervalSeconds: 1 }]);
    let reject!: (e: unknown) => void;
    const first = new Promise<void>((_r, rj) => { reject = rj; });
    first.catch(() => undefined); // the poll attaches its own handler; keep the runner quiet
    let call = 0;
    const fire = vi.fn(() => (call++ === 0 ? first : Promise.resolve()));
    startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });

    expect(fire).toHaveBeenCalledTimes(1);
    reject(new Error("lab box down"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("does not double-fire a source that is re-armed while its previous sweep is still in flight (⊘ dropping the latch with the timer lets a hide/show cycle stack a second crawl on the same lab box)", async () => {
    const view = makeView(true);
    const feed = makeSourceFeed([{ id: "a", intervalSeconds: 30 }]);
    const gate = deferred();
    const fire = vi.fn(() => gate.promise);
    startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });

    expect(fire).toHaveBeenCalledTimes(1);
    view.emit(false);
    view.emit(true); // re-arm transition while the first sweep is STILL pending
    expect(fire).toHaveBeenCalledTimes(1);

    gate.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("dispose clears every timer and unsubscribes (⊘ leaked intervals keep firing after teardown)", () => {
    const view = makeView(true);
    const feed = makeSourceFeed([{ id: "a", intervalSeconds: 30 }, { id: "b", intervalSeconds: 45 }]);
    const fire = vi.fn();
    const handle = startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });

    fire.mockClear();
    handle.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(300_000);
    expect(fire).not.toHaveBeenCalled();
    expect(feed.disposed()).toBe(true);
  });

  it("ignores a non-finite or negative interval rather than arming a timer that never fires (⊘ NaN * 1000 arms an interval the runtime treats as 1 ms, or as never)", () => {
    const view = makeView(true);
    const feed = makeSourceFeed([
      { id: "nan", intervalSeconds: Number.NaN },
      { id: "neg", intervalSeconds: -30 },
      { id: "inf", intervalSeconds: Number.POSITIVE_INFINITY }
    ]);
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });

    expect(fire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
