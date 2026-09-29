import { createCollapsedFolderStatePersistence, type CollapsedFolderStatePersistence } from "./collapsedFolderStatePersistence";
import type { GenerationState, ResetGenerationGuard } from "../storage/resetGeneration";

interface CollapsibleFolders {
  loadCollapsedFolders(paths: string[]): void;
  getCollapsedFolders(): string[];
  collapseFolder(path: string): void;
  expandFolder(path: string): void;
  refresh(): void;
}

/**
 * One tree's collapsed-folder state, loaded from and persisted to `storageKey`,
 * guarded against another window's Delete All Data (see `resetGeneration.ts`):
 * when a reset happened since this window last looked, the in-memory set is
 * dropped and reloaded from storage (now empty) before the user's action is
 * applied, so only that action is persisted; a write already queued when the
 * reset is noticed is dropped rather than landing stale.
 */
export function createCollapsedFolderState(options: {
  state: GenerationState;
  storageKey: string;
  provider: CollapsibleFolders;
  guard: ResetGenerationGuard;
  onError: (error: unknown) => void;
}): { persistence: CollapsedFolderStatePersistence; handleChange(folderPath: string, isCollapsed: boolean): void } {
  const { state, storageKey, provider, guard } = options;
  provider.loadCollapsedFolders(state.get<string[]>(storageKey, []));
  const persistence = createCollapsedFolderStatePersistence(
    async (paths) => {
      if (guard.hasChanged()) {
        return;
      }
      await state.update(storageKey, paths);
    },
    { onError: options.onError }
  );
  return {
    persistence,
    handleChange(folderPath, isCollapsed) {
      if (guard.consumeIfChanged()) {
        provider.loadCollapsedFolders(state.get<string[]>(storageKey, []));
        provider.refresh();
      }
      if (isCollapsed) {
        provider.collapseFolder(folderPath);
      } else {
        provider.expandFolder(folderPath);
      }
      persistence.schedule(provider.getCollapsedFolders());
    }
  };
}
