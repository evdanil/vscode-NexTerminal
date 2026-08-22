/** @author kanekitakitos */

/**
 * Trailing-edge coalescing for the daemon's `runtimeUpdate` push notifications.
 *
 * ## Why this exists
 *
 * The engines emit one runtime event per *real* state change — one per TFTP
 * block acknowledged, one per DHCP lease mutation — which is the right
 * granularity for in-process consumers. Bridged straight to stdout, though, it
 * becomes one JSON line per block: a firmware image pulled over a fast LAN with
 * a negotiated `blksize` near 1400 bytes produces thousands of tiny writes per
 * second, every one of them describing a state no human can perceive at that
 * rate.
 *
 * Throttling here — at the process boundary, not in the engines — keeps the
 * event granularity intact for everything upstream while collapsing the wire
 * traffic to a rate a UI can actually render.
 *
 * ## Trailing edge, deliberately
 *
 * The notification carries only the service `id`; the host answers it by asking
 * for the current runtime. So an update is only useful if it is delivered
 * *after* the change it is meant to announce. A leading-edge throttle would
 * announce the first block of a burst and then stay silent through the rest,
 * leaving the host's view frozen mid-transfer. Firing at the end of each window
 * guarantees the host always samples state no older than one window.
 *
 * Terminal events ({@link RuntimeUpdateThrottle.push} with `final`) bypass the
 * window entirely: a completed or failed transfer removes itself from the
 * runtime, and that disappearance must not wait out a window that later pushes
 * would keep extending.
 */

/**
 * Coalescing window.
 *
 * 10 Hz is roughly the ceiling at which a human reads a changing value, so
 * anything faster is spent on the pipe rather than on the reader. It also pairs
 * with the host's own 150 ms refresh debounce: a burst that survives this
 * window still collapses into a single `getServiceRuntime` round-trip.
 */
export const RUNTIME_UPDATE_THROTTLE_MS = 100;

export interface RuntimeUpdateThrottle {
  /**
   * Records that `id`'s runtime changed.
   *
   * @param id - Service the update belongs to. Ids are throttled independently,
   *   so a busy TFTP transfer cannot delay a DHCP lease notification.
   * @param final - `true` for terminal changes (transfer completed or failed,
   *   lease released), which emit immediately instead of waiting out a window.
   */
  push(id: string, final?: boolean): void;
  /** Emits every pending update now. For shutdown, before listeners go away. */
  flush(): void;
}

/**
 * Builds a throttle that forwards coalesced updates to `emit`.
 *
 * @param emit - Invoked once per window per id (and immediately for terminal
 *   updates) with the id whose runtime changed.
 * @param intervalMs - Coalescing window; defaults to
 *   {@link RUNTIME_UPDATE_THROTTLE_MS}. Injectable for tests.
 */
export function createRuntimeUpdateThrottle(
  emit: (id: string) => void,
  intervalMs: number = RUNTIME_UPDATE_THROTTLE_MS,
): RuntimeUpdateThrottle {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const fire = (id: string): void => {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
    emit(id);
  };

  return {
    push(id: string, final = false): void {
      if (final) {
        fire(id);
        return;
      }
      if (timers.has(id)) return;
      timers.set(id, setTimeout(() => fire(id), intervalMs));
    },
    flush(): void {
      for (const id of [...timers.keys()]) fire(id);
    },
  };
}
