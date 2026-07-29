import type * as vscode from "vscode";

/**
 * `vscode.window.createTreeView(...)` does NOT fire `onDidChangeVisibility`
 * at registration — only on a subsequent user-driven show/hide. Any consumer
 * that only subscribes to the event and never reads `TreeView.visible` up
 * front starts out believing the view is hidden even when it is visible in a
 * freshly opened window, and stays wrong until the user manually toggles it.
 *
 * This was the root cause of a Phase 1 bug: `CwdSyncCoordinator` started
 * `visible = false` and buffered every reported cwd indefinitely because
 * nothing ever seeded it from the File Explorer's actual, already-visible
 * state. `FileExplorerTreeProvider.setViewVisibility` has the identical
 * latent gap for its polling path (`updatePolling()` no-ops while
 * `isViewVisible` is false).
 *
 * `wireViewVisibility` fixes both by construction: it seeds every consumer
 * with the view's *current* `visible` value immediately, before ever
 * returning, and then keeps them updated via the real event. Kept in its own
 * `vscode`-free module (only a type-only import, erased at compile time) so
 * it can be unit tested with a plain fake `view` — no `vi.mock("vscode")`
 * required, matching `orphanDetect.ts`'s pattern.
 */
export interface VisibilityAwareView {
  readonly visible: boolean;
  onDidChangeVisibility(listener: (e: { visible: boolean }) => void): vscode.Disposable | { dispose(): void };
}

export function wireViewVisibility(
  view: VisibilityAwareView,
  onVisibilityChange: (visible: boolean) => void
): { dispose(): void } {
  onVisibilityChange(view.visible);
  return view.onDidChangeVisibility((e) => onVisibilityChange(e.visible));
}
