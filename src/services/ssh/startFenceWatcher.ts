import type { ConnectionConfigMutation } from "../../core/nexusCore";

/**
 * A fence-local, sticky watcher for one pending start.
 *
 * Comparing a captured descriptor with the live one at the end misses an
 * A -> B -> A change made while the start was in flight (the transport may have
 * authenticated with B). Comparing raw pool invalidations instead is too
 * conservative (pool invalidation deliberately over-fires: an unchanged save that
 * spells out a default, an unused key path, an alt host during an isolated
 * tunnel). This watcher takes the middle road: on every synchronous NexusCore
 * mutation it recomputes the fence's OWN effective descriptor, with the fence's
 * own inputs, and latches `dirty` the first time it differs from the captured
 * one. The latch never clears, so an intermediate value is remembered, and a
 * raw-only change leaves the descriptor, and so the fence, alone.
 *
 * Owners must `dispose()` when the fence settles (start finished or failed, the
 * terminal session opened and its sweep ran, the pty closed) so nothing stays
 * subscribed.
 */
export interface StartFence {
  /** The effective descriptor captured when the fence was created. */
  readonly descriptor: string;
  /** True once any mutation made the recomputed descriptor differ from the captured one. */
  isDirty(): boolean;
  dispose(): void;
}

export interface StartFenceSource {
  onDidMutateConnectionConfig?: (listener: (mutation: ConnectionConfigMutation) => void) => () => void;
}

export function watchStartFence(
  source: StartFenceSource,
  descriptor: string,
  recompute: () => string
): StartFence {
  let dirty = false;
  let unsubscribe: (() => void) | undefined = source.onDidMutateConnectionConfig?.(() => {
    if (dirty) {
      return;
    }
    try {
      if (recompute() !== descriptor) {
        dirty = true;
      }
    } catch {
      // Cannot tell what changed: fail safe.
      dirty = true;
    }
  });
  return {
    descriptor,
    isDirty: () => dirty,
    dispose: () => {
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
}
