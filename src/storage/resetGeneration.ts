/**
 * Delete All Data clears globalState, but `globalState` is shared by every open
 * VS Code window and each window holds collapsed-folder sets and the Terminal
 * Appearance cache in memory. Left alone, another window's next toggle or scheme
 * edit would write its stale copy straight back into the keys just cleared.
 *
 * The reset therefore bumps a counter here, after clearing. Each owner of such a
 * cache holds a guard that recorded the counter it loaded under; before it
 * writes it asks the guard, and when the counter has moved it reloads from
 * storage (now empty) instead of persisting stale data.
 *
 * It acts only at the owner's next action, never immediately, and it cannot
 * reach a window that has not yet observed the bump.
 *
 * RESIDUAL RACE, deliberately not closed here: the guard stops stale state from
 * being written by any action that STARTS after the reset has become visible to
 * this window. A write already in flight when the reset lands, or one that starts
 * before the new generation reaches this window, can still commit. `globalState`
 * has no compare-and-swap and cross-window propagation is asynchronous, so that
 * check-then-write gap cannot be closed at this layer (the same limit as the
 * cross-window note atop `vscodeConfigRepository.ts`); a compensating re-clear
 * after the write would erase legitimate writes made after the reset. Reloading
 * the other window clears whatever such a write left.
 */
export const RESET_GENERATION_KEY = "nexus.resetGeneration";

export interface GenerationState {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export function readResetGeneration(state: GenerationState): number {
  const value = state.get<unknown>(RESET_GENERATION_KEY, 0);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Monotonic on purpose: never cleared, so a window that missed one reset still sees a difference. */
export async function bumpResetGeneration(state: GenerationState): Promise<void> {
  await state.update(RESET_GENERATION_KEY, readResetGeneration(state) + 1);
}

export interface ResetGenerationGuard {
  /** Whether a reset happened since this guard last synced; does not change that. */
  hasChanged(): boolean;
  /** Reports and acknowledges a change: true once per reset, after which the owner must reload. */
  consumeIfChanged(): boolean;
}

export function createResetGenerationGuard(state: GenerationState): ResetGenerationGuard {
  let seen = readResetGeneration(state);
  return {
    hasChanged: () => readResetGeneration(state) !== seen,
    consumeIfChanged: () => {
      const current = readResetGeneration(state);
      if (current === seen) {
        return false;
      }
      seen = current;
      return true;
    }
  };
}
