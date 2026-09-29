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
 * drops the pending and in-flight writes first (so nothing lands after the
 * reset), then empties the sets and turns follow off.
 */
export async function resetLiveViewState(deps: {
  trees: Array<{ provider: CollapsibleTreeProvider; persistence: CollapsedFolderStatePersistence }>;
  cwdSync: { setFollowing(on: boolean): void };
}): Promise<void> {
  await Promise.all(deps.trees.map(({ persistence }) => persistence.discard()));
  for (const { provider } of deps.trees) {
    provider.loadCollapsedFolders([]);
    provider.refresh();
  }
  deps.cwdSync.setFollowing(false);
}
