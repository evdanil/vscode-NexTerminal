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
  /** Invoke one refresh of all sources (typically executeCommand of refreshStatus). */
  fire: () => void;
}

export function startInventoryStatusPoll(options: InventoryStatusPollOptions): { dispose(): void } {
  let visible = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const disarm = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
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
      timer = setInterval(options.fire, seconds * 1000);
    }
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
