import type { CollapsedFolderStatePersistence } from "./collapsedFolderStatePersistence";

/** The slice of a tree provider that holds collapsed-folder state in memory. */
interface CollapsibleTreeProvider {
  loadCollapsedFolders(paths: string[]): void;
  refresh(): void;
}

/**
 * Delete All Data: the remembered view state is cleared in `globalState` by the
 * command, but a live window still holds it in memory — the folders stay
 * collapsed, Follow Terminal Directory stays on, and the next expand/collapse or
 * a debounced write already pending would put the old set straight back. This
 * drops the pending and in-flight writes first and ignores new ones until
 * the sets are empty (so nothing stale lands after the reset), then empties the sets and turns follow off.
 */
export async function resetLiveViewState(deps: {
  trees: Array<{ provider: CollapsibleTreeProvider; persistence: CollapsedFolderStatePersistence }>;
  cwdSync: { setFollowing(on: boolean): void };
}): Promise<void> {
  // Each persistence ignores schedules from `discard()` until `resume()`, so a
  // toggle made while an in-flight write settles cannot queue the old paths. It
  // is left suspended on success: the caller resumes it (`resumeLiveViewState`)
  // once the stored keys are cleared, or a collapse in between could schedule a
  // write that lands after the clear. If this throws, nothing else will resume.
  try {
    await Promise.all(deps.trees.map(({ persistence }) => persistence.discard()));
    for (const { provider } of deps.trees) {
      provider.loadCollapsedFolders([]);
      provider.refresh();
    }
    deps.cwdSync.setFollowing(false);
  } catch (error) {
    resumeLiveViewState(deps.trees);
    throw error;
  }
}

/** End the suspension `resetLiveViewState` leaves in place. */
export function resumeLiveViewState(trees: Array<{ persistence: CollapsedFolderStatePersistence }>): void {
  for (const { persistence } of trees) {
    persistence.resume();
  }
}
