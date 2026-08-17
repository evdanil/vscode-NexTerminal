import { wireViewVisibility, type VisibilityAwareView } from "../terminal/viewVisibilityWiring";

/**
 * LIVE STATUS (Phase 2) — the opt-in, visible-gated status poll. It fires
 * `refreshStatus` every N seconds, but ONLY while BOTH hold:
 *  - the Command Center view is visible (no point refreshing a highlight nobody
 *    is looking at, and no reason to keep hitting a lab box while the panel is
 *    closed), and
 *  - the interval is > 0 (0 means "off — use the manual command").
 *
 * Kept in its own `vscode`-free module (only the type-only `VisibilityAwareView`
 * import, erased at compile time) so it unit-tests with a plain fake view and
 * fake timers — matching `viewVisibilityWiring.ts` / `orphanDetect.ts`. Uses the
 * global `setInterval`/`clearInterval` so `vi.useFakeTimers()` drives it.
 */
export interface InventoryStatusPollOptions {
  view: VisibilityAwareView;
  /** Current poll interval in seconds; 0 (or less) disables polling. */
  getIntervalSeconds: () => number;
  /** Subscribe to changes of the interval setting; the callback re-evaluates. */
  onDidChangeInterval: (listener: () => void) => { dispose(): void };
  /**
   * Invoke one refresh of all sources (typically executeCommand of
   * refreshStatus). May return a promise; when it does, the poll's in-flight
   * latch awaits it so a slow sweep is never allowed to stack a second one.
   */
  fire: () => void | Promise<void>;
}

export function startInventoryStatusPoll(options: InventoryStatusPollOptions): { dispose(): void } {
  let visible = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Whether the poll is currently in its running state (a timer is armed). Used
  // to fire ONCE on the not-running → running transition (P3-8) without firing
  // again on a mere period change that keeps it running.
  let running = false;
  // P2-1 in-flight latch: an EVE `fetchStatus` sweep is a full folder walk with
  // no overall deadline, and the interval can be as low as 1s. Without this a
  // slow sweep would let every tick stack another concurrent crawl (each
  // re-logging in). A tick is skipped while the previous sweep is still running.
  let inFlight = false;

  const disarm = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const tick = (): void => {
    if (inFlight) {
      return; // a prior sweep is still running — do not stack another
    }
    const result = options.fire();
    // Latch only while a real (pending) sweep is outstanding: a fire that
    // returns a thenable (the executeCommand path / a gated test) holds the
    // latch until it settles; a synchronous fire needs no latch at all.
    if (result && typeof (result as Promise<void>).then === "function") {
      inFlight = true;
      const release = (): void => {
        inFlight = false;
      };
      (result as Promise<void>).then(release, release);
    }
  };

  const reevaluate = (): void => {
    const seconds = options.getIntervalSeconds();
    const shouldRun = visible && seconds > 0;
    // Always disarm first: a re-arm (visibility flip, or an interval change)
    // must REPLACE the running timer with one at the current period, never
    // layer a second timer on top of it.
    disarm();
    if (shouldRun) {
      // P3-8 — fire immediately ONLY on the arm transition (became visible /
      // poll enabled), so a reload does not sit on an empty status map for a
      // whole period. A period change that keeps it running does NOT re-fire.
      if (!running) {
        tick();
      }
      timer = setInterval(tick, seconds * 1000);
    }
    running = shouldRun;
  };

  // Seeds `visible` from the view's CURRENT value immediately (createTreeView
  // does not fire the visibility event at registration), then keeps it updated.
  const visibilitySub = wireViewVisibility(options.view, (v) => {
    visible = v;
    reevaluate();
  });
  const configSub = options.onDidChangeInterval(reevaluate);

  return {
    dispose(): void {
      disarm();
      visibilitySub.dispose();
      configSub.dispose();
    }
  };
}
