import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startInventoryStatusPoll } from "../../src/services/inventory/inventoryStatusPoll";
import type { VisibilityAwareView } from "../../src/services/terminal/viewVisibilityWiring";

/**
 * LIVE STATUS (Phase 2) — the visible-gated poll. It fires refreshStatus once
 * immediately on arm (so a window reload / becoming-visible does not sit on an
 * empty status map for a whole period), then every N seconds while the Command
 * Center is visible AND the interval is > 0. An in-flight latch keeps a slow
 * sweep from stacking concurrent EVE crawls. Driven with fake timers.
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

function makeConfigSource(): { onDidChangeInterval: (cb: () => void) => { dispose(): void }; emit(): void; disposed: () => boolean } {
  let cb: (() => void) | undefined;
  let disposed = false;
  return {
    onDidChangeInterval(listener) {
      cb = listener;
      return { dispose: () => { disposed = true; cb = undefined; } };
    },
    emit() {
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

describe("startInventoryStatusPoll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once immediately on arm (visible + interval > 0), then every N seconds (⊘ P3-8: waiting a full period before the first refresh leaves a freshly-reloaded window on an empty status map)", () => {
    const view = makeView(true);
    const config = makeConfigSource();
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getIntervalSeconds: () => 30, onDidChangeInterval: config.onDidChangeInterval, fire });

    expect(fire).toHaveBeenCalledTimes(1); // immediate fire on arm
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(3);
  });

  it("does NOT arm or fire when interval is 0, even while visible (⊘ polling a 0 interval busy-loops the provider)", () => {
    const view = makeView(true);
    const config = makeConfigSource();
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getIntervalSeconds: () => 0, onDidChangeInterval: config.onDidChangeInterval, fire });

    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600_000);
    expect(fire).not.toHaveBeenCalled();
  });

  it("does NOT fire while hidden, and fires immediately when the view becomes visible (⊘ hammering a lab box while the panel is closed)", () => {
    const view = makeView(false);
    const config = makeConfigSource();
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getIntervalSeconds: () => 30, onDidChangeInterval: config.onDidChangeInterval, fire });

    vi.advanceTimersByTime(90_000);
    expect(fire).not.toHaveBeenCalled();

    view.emit(true);
    expect(fire).toHaveBeenCalledTimes(1); // immediate fire on becoming visible
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("disarms when the view is hidden again (⊘ a timer that keeps firing after the panel closes)", () => {
    const view = makeView(true);
    const config = makeConfigSource();
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getIntervalSeconds: () => 30, onDidChangeInterval: config.onDidChangeInterval, fire });

    expect(fire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(2);

    view.emit(false);
    vi.advanceTimersByTime(120_000);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("re-arms on an interval config change: 0→30 starts polling with an immediate fire, and a period change replaces the running timer WITHOUT a fresh immediate fire (⊘ ignoring the config event leaves a stale cadence, or 0→N never starts)", () => {
    const view = makeView(true);
    const config = makeConfigSource();
    const fire = vi.fn();
    let interval = 0;
    startInventoryStatusPoll({ view, getIntervalSeconds: () => interval, onDidChangeInterval: config.onDidChangeInterval, fire });

    expect(fire).not.toHaveBeenCalled();

    interval = 30;
    config.emit();
    expect(fire).toHaveBeenCalledTimes(1); // arm transition 0→running fires immediately
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(2);

    // Period change while already running: re-arm the timer, no fresh immediate fire.
    interval = 60;
    config.emit();
    expect(fire).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(2); // 30s into a 60s period
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(3);
  });

  it("interval → 0 disarms a running poll", () => {
    const view = makeView(true);
    const config = makeConfigSource();
    const fire = vi.fn();
    let interval = 30;
    startInventoryStatusPoll({ view, getIntervalSeconds: () => interval, onDidChangeInterval: config.onDidChangeInterval, fire });

    expect(fire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(2);

    interval = 0;
    config.emit();
    vi.advanceTimersByTime(300_000);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("P2-1: an in-flight latch skips ticks while a sweep is still running, so slow sweeps never stack (⊘ removing the latch lets a 1s interval stack unbounded concurrent EVE crawls)", async () => {
    const view = makeView(true);
    const config = makeConfigSource();
    const gate = deferred();
    const fire = vi.fn(() => gate.promise); // stays pending — one long sweep
    startInventoryStatusPoll({ view, getIntervalSeconds: () => 1, onDidChangeInterval: config.onDidChangeInterval, fire });

    // The immediate arm-fire is in flight; every tick during it is skipped.
    expect(fire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fire).toHaveBeenCalledTimes(1);

    // Sweep completes → the latch releases → the next tick fires again.
    gate.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("dispose clears the timer and unsubscribes (⊘ a leaked interval keeps firing after teardown)", () => {
    const view = makeView(true);
    const config = makeConfigSource();
    const fire = vi.fn();
    const handle = startInventoryStatusPoll({ view, getIntervalSeconds: () => 30, onDidChangeInterval: config.onDidChangeInterval, fire });

    expect(fire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(2);

    handle.dispose();
    vi.advanceTimersByTime(300_000);
    expect(fire).toHaveBeenCalledTimes(2);
    expect(config.disposed()).toBe(true);
  });
});
