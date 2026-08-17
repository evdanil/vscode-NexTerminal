import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startInventoryStatusPoll } from "../../src/services/inventory/inventoryStatusPoll";
import type { VisibilityAwareView } from "../../src/services/terminal/viewVisibilityWiring";

/**
 * LIVE STATUS (Phase 2) — the visible-gated poll. It fires refreshStatus only
 * while the Command Center is visible AND the interval is > 0, arms/disarms on
 * visibility toggles, and re-arms when the interval setting changes. Driven with
 * fake timers so "the command is invoked every N seconds" is asserted directly.
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

describe("startInventoryStatusPoll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("arms when the view is visible AND interval > 0, firing every N seconds (⊘ never arming leaves the poll dead; a wrong period fires at the wrong cadence)", () => {
    const view = makeView(true);
    const config = makeConfigSource();
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getIntervalSeconds: () => 30, onDidChangeInterval: config.onDidChangeInterval, fire });

    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("does NOT arm when interval is 0, even while visible (⊘ polling a 0 interval busy-loops the provider)", () => {
    const view = makeView(true);
    const config = makeConfigSource();
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getIntervalSeconds: () => 0, onDidChangeInterval: config.onDidChangeInterval, fire });

    vi.advanceTimersByTime(600_000);
    expect(fire).not.toHaveBeenCalled();
  });

  it("does NOT poll while hidden, and arms when the view becomes visible (⊘ hammering a lab box while the panel is closed)", () => {
    const view = makeView(false);
    const config = makeConfigSource();
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getIntervalSeconds: () => 30, onDidChangeInterval: config.onDidChangeInterval, fire });

    vi.advanceTimersByTime(90_000);
    expect(fire).not.toHaveBeenCalled();

    view.emit(true);
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("disarms when the view is hidden again (⊘ a timer that keeps firing after the panel closes)", () => {
    const view = makeView(true);
    const config = makeConfigSource();
    const fire = vi.fn();
    startInventoryStatusPoll({ view, getIntervalSeconds: () => 30, onDidChangeInterval: config.onDidChangeInterval, fire });

    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(1);

    view.emit(false);
    vi.advanceTimersByTime(120_000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("re-arms on an interval config change: 0→30 starts polling, and a period change replaces the running timer (⊘ ignoring the config event leaves a stale cadence, or 0→N never starts)", () => {
    const view = makeView(true);
    const config = makeConfigSource();
    const fire = vi.fn();
    let interval = 0;
    startInventoryStatusPoll({ view, getIntervalSeconds: () => interval, onDidChangeInterval: config.onDidChangeInterval, fire });

    vi.advanceTimersByTime(120_000);
    expect(fire).not.toHaveBeenCalled();

    interval = 30;
    config.emit();
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(1);

    // Change the period; the old timer must be replaced, not layered.
    interval = 60;
    config.emit();
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(1); // 30s into a 60s period — no new fire yet
    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("interval → 0 disarms a running poll", () => {
    const view = makeView(true);
    const config = makeConfigSource();
    const fire = vi.fn();
    let interval = 30;
    startInventoryStatusPoll({ view, getIntervalSeconds: () => interval, onDidChangeInterval: config.onDidChangeInterval, fire });

    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(1);

    interval = 0;
    config.emit();
    vi.advanceTimersByTime(300_000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("dispose clears the timer and unsubscribes (⊘ a leaked interval keeps firing after teardown)", () => {
    const view = makeView(true);
    const config = makeConfigSource();
    const fire = vi.fn();
    const handle = startInventoryStatusPoll({ view, getIntervalSeconds: () => 30, onDidChangeInterval: config.onDidChangeInterval, fire });

    vi.advanceTimersByTime(30_000);
    expect(fire).toHaveBeenCalledTimes(1);

    handle.dispose();
    vi.advanceTimersByTime(300_000);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(config.disposed()).toBe(true);
  });
});
