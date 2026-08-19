import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startInventoryStatusPoll, type InventoryStatusPollSource } from "../../src/services/inventory/inventoryStatusPoll";
import type { VisibilityAwareView } from "../../src/services/terminal/viewVisibilityWiring";

/**
 * PER-SOURCE LAB STATUS POLL — the visible-gated poll, now scheduled per
 * inventory source rather than as one global sweep. Each source with a positive
 * interval gets its own timer: it fires once immediately on arm (so a window
 * reload / becoming-visible does not sit on an empty status map for a whole
 * period), then every N seconds while the Command Center is visible. A
 * PER-SOURCE in-flight latch keeps one slow lab box from stacking concurrent
 * crawls against itself — without slowing down every other source, which a
 * single global latch did.
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

function makeSourceFeed(initial: InventoryStatusPollSource[]): {
  onDidChangeSources: (cb: () => void) => { dispose(): void };
  getSources: () => InventoryStatusPollSource[];
  set(next: InventoryStatusPollSource[]): void;
  disposed: () => boolean;
} {
  let cb: (() => void) | undefined;
  let disposed = false;
  let sources = initial;
  return {
    getSources: () => sources,
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
   * REVIEW D6/E1/E2 — THE ARM DEBT.
   *
   * The arm fire is the one tick that cannot simply be missed: a source that
   * has just started polling has no status on screen at all, and the next tick
   * is a whole period away — up to an hour. But the refresh it calls can
   * legitimately decline to run: the source may be mid-sync/edit/remove/control
   * (`inFlightSourceIds`), or its credentials may not be in the vault yet
   * (mid-restore of a backup). A decline that is silently treated as "fired" is
   * the whole bug.
   *
   * So a declined arm fire becomes a DEBT — and the debt is a property of the
   * ARM STATE, held here, rather than a note kept by the refresh. That is what
   * gives it a lifecycle: it is created only by a decline, it dies with the
   * schedule that owns it (interval to 0, source removed, no longer offered,
   * view hidden), and it is redeemed only against live arm state. A debt cannot
   * outlive the arming that justified it, and cannot resurrect after it dies.
   */
  describe("the arm debt", () => {
    /** A fire that declines everything, as a busy/credential-less refresh does. */
    const declining = () => vi.fn(async () => ({ ran: false }));

    it("redeems a DECLINED arm fire when the source settles, and does not touch the schedule's phase (⊘ treating a decline as a fire loses the arm tick entirely: polling appears to do nothing for a whole period)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }]);
      const fire = declining();
      const poll = startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });

      expect(firedIds(fire)).toEqual(["a"]);
      await vi.advanceTimersByTimeAsync(0); // let the decline land
      fire.mockClear();

      poll.sourceSettled("a");
      expect(firedIds(fire)).toEqual(["a"]);
      // The timer is untouched: still one, still on its own period.
      expect(vi.getTimerCount()).toBe(1);
    });

    it("keeps owing while the redemption is declined too, and stops the moment one runs (⊘ clearing the debt on a declined retry drops it again, and re-owing on a successful one crawls the lab on every later settle)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }]);
      let ran = false;
      const fire = vi.fn(async () => ({ ran }));
      const poll = startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      fire.mockClear();

      // Still declined — still owed.
      poll.sourceSettled("a");
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).toHaveBeenCalledTimes(1);

      // This one runs, so the debt is paid…
      ran = true;
      poll.sourceSettled("a");
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).toHaveBeenCalledTimes(2);

      // …and no later settle fires again.
      poll.sourceSettled("a");
      poll.sourceSettled();
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).toHaveBeenCalledTimes(2);
    });

    it("never owes anything for a fire that RAN, however many settles arrive (⊘ redeeming on settle without a debt turns every sync, edit and node control into an extra lab crawl)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }]);
      const fire = vi.fn(async () => ({ ran: true }));
      const poll = startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).toHaveBeenCalledTimes(1);

      poll.sourceSettled("a");
      poll.sourceSettled();
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).toHaveBeenCalledTimes(1);
    });

    it("treats a fire that reports NOTHING as one that ran — the shape a caller with no outcome to give returns (⊘ reading a void result as a decline owes a debt for every tick and crawls on every settle)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }]);
      const fire = vi.fn();
      const poll = startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      fire.mockClear();

      poll.sourceSettled("a");
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).not.toHaveBeenCalled();
    });

    it("owes nothing for a declined ROUTINE tick — only the arm one (⊘ deferring every declined tick buys an extra lab crawl after every sync, which has already applied fresh status, and after every node control, which fires its own refresh)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 30 }]);
      let ran = true;
      const fire = vi.fn(async () => ({ ran }));
      const poll = startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0); // the ARM fire ran
      ran = false;
      await vi.advanceTimersByTimeAsync(30_000); // a routine tick — declined
      expect(fire).toHaveBeenCalledTimes(2);

      poll.sourceSettled("a");
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).toHaveBeenCalledTimes(2);
    });

    it("CANCELS the debt when the view is hidden, and does not resurrect it when the view comes back (⊘ a debt with no cancellation crawls the lab after the user closed the panel — against the poll's own visible-gating — and then a second time on the next settle)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }]);
      const fire = declining();
      const poll = startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      fire.mockClear();

      view.emit(false); // panel closed — nothing is armed any more
      poll.sourceSettled("a");
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).not.toHaveBeenCalled();

      // Coming back is a fresh not-running → running transition: it fires its OWN
      // arm tick (one), and the dead debt adds nothing on top.
      view.emit(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).toHaveBeenCalledTimes(1);
    });

    it("CANCELS the debt when the source stops being polled at all — interval 0, removed, or no longer offered (⊘ a stale debt pays out after the user turned polling off, or for a source that is gone)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }, { id: "b", intervalSeconds: 3600 }]);
      const fire = declining();
      const poll = startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      fire.mockClear();

      // `a` turned off; `b` removed from the list entirely.
      feed.set([{ id: "a", intervalSeconds: 0 }]);
      await vi.advanceTimersByTimeAsync(0);
      poll.sourceSettled("a");
      poll.sourceSettled("b");
      poll.sourceSettled();
      await vi.advanceTimersByTimeAsync(0);
      expect(fire).not.toHaveBeenCalled();
    });

    it("stays owed when the LATCH swallows the redemption, and pays on the next settle (⊘ counting a tick the latch never dispatched as payment loses the arm fire to a sweep that was already running)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 30 }]);
      const pending = deferred();
      let call = 0;
      const fire = vi.fn(() => {
        call++;
        if (call === 1) return Promise.resolve({ ran: false }); // arm fire declined → owed
        if (call === 2) return pending.promise.then(() => ({ ran: true })); // a routine sweep, still running
        return Promise.resolve({ ran: true });
      });
      const poll = startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000); // routine tick — now in flight
      expect(fire).toHaveBeenCalledTimes(2);

      // Settling now cannot dispatch: this source already has a sweep running.
      poll.sourceSettled("a");
      expect(fire).toHaveBeenCalledTimes(2);

      // The sweep finishes, and the NEXT settle finds the debt still owed.
      pending.resolve();
      await vi.advanceTimersByTimeAsync(0);
      poll.sourceSettled("a");
      expect(fire).toHaveBeenCalledTimes(3);
    });

    it("redeems EVERY armed source's debt when settled with no source id — the shape a finished config-level flow reports (⊘ a restore that persists sources before their credentials leaves every one of them waiting a full period)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }, { id: "b", intervalSeconds: 3600 }]);
      const fire = declining();
      const poll = startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      fire.mockClear();

      poll.sourceSettled();
      expect(firedIds(fire).sort()).toEqual(["a", "b"]);
    });

    it("keeps a debt across a mere period change, which re-arms nothing (⊘ dropping it there loses the arm fire for a source the user just re-tuned)", async () => {
      const view = makeView(true);
      const feed = makeSourceFeed([{ id: "a", intervalSeconds: 3600 }]);
      const fire = declining();
      const poll = startInventoryStatusPoll({ view, getSources: feed.getSources, onDidChangeSources: feed.onDidChangeSources, fire });
      await vi.advanceTimersByTimeAsync(0);
      fire.mockClear();

      feed.set([{ id: "a", intervalSeconds: 60 }]);
      expect(fire).not.toHaveBeenCalled(); // a period change never re-fires by itself
      poll.sourceSettled("a");
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
