import { describe, expect, it, vi } from "vitest";
import { createCollapsedFolderStatePersistence } from "../../src/ui/collapsedFolderStatePersistence";
import { resetLiveViewState } from "../../src/ui/viewStateReset";

/** The two tree providers hold their collapsed set exactly like this. */
class FakeTree {
  private readonly collapsed = new Set<string>();
  refreshes = 0;
  collapseFolder(path: string): void { this.collapsed.add(path); }
  getCollapsedFolders(): string[] { return [...this.collapsed]; }
  loadCollapsedFolders(paths: string[]): void { this.collapsed.clear(); paths.forEach((p) => this.collapsed.add(p)); }
  refresh(): void { this.refreshes++; }
}

describe("Delete All Data resets the live view state", () => {
  it("empties the collapsed sets, cancels a pending write, turns follow off, and a later toggle does not bring old entries back (⊘ clearing only the memento)", async () => {
    vi.useFakeTimers();
    try {
      const stored: string[][] = [];
      const tree = new FakeTree();
      const persistence = createCollapsedFolderStatePersistence(async (paths) => { stored.push(paths); }, { debounceMs: 100 });
      tree.loadCollapsedFolders(["Lab", "Lab/Core"]);
      // A write scheduled just before the reset must not land after it.
      tree.collapseFolder("Edge");
      persistence.schedule(tree.getCollapsedFolders());
      const setFollowing = vi.fn();

      await resetLiveViewState({ trees: [{ provider: tree, persistence }], cwdSync: { setFollowing } });
      await vi.advanceTimersByTimeAsync(500);

      expect(tree.getCollapsedFolders()).toEqual([]);
      expect(tree.refreshes).toBe(1);
      expect(setFollowing).toHaveBeenCalledWith(false);
      expect(stored).toEqual([]);

      // The next collapse persists only itself.
      tree.collapseFolder("New");
      persistence.schedule(tree.getCollapsedFolders());
      await vi.advanceTimersByTimeAsync(500);
      expect(stored).toEqual([["New"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a write already in flight before returning", async () => {
    let release!: () => void;
    let finished = false;
    const persistence = createCollapsedFolderStatePersistence(
      () => new Promise<void>((resolve) => { release = () => { finished = true; resolve(); }; }),
      { debounceMs: 0 }
    );
    persistence.schedule(["A"]);
    const flushing = persistence.flush();
    await Promise.resolve();
    const tree = new FakeTree();
    const reset = resetLiveViewState({ trees: [{ provider: tree, persistence }], cwdSync: { setFollowing: () => undefined } });
    let resetDone = false;
    void reset.then(() => { resetDone = true; });
    await Promise.resolve();
    expect(resetDone).toBe(false);
    release();
    await flushing;
    await reset;
    expect(finished).toBe(true);
  });

  it("a toggle made while the in-flight write settles queues nothing stale (⊘ discard() clearing the pending write once)", async () => {
    vi.useFakeTimers();
    try {
      const stored: string[][] = [];
      let release!: () => void;
      const persistence = createCollapsedFolderStatePersistence(
        (paths) => new Promise<void>((resolve) => { stored.push(paths); release = resolve; }),
        { debounceMs: 10 }
      );
      const tree = new FakeTree();
      tree.loadCollapsedFolders(["Old"]);
      persistence.schedule(tree.getCollapsedFolders());
      await vi.advanceTimersByTimeAsync(20); // the write is now in flight
      expect(stored).toEqual([["Old"]]);

      const reset = resetLiveViewState({ trees: [{ provider: tree, persistence }], cwdSync: { setFollowing: () => undefined } });
      await Promise.resolve();
      // The user collapses a folder during the wait: the provider still holds the old set.
      tree.collapseFolder("DuringWait");
      persistence.schedule(tree.getCollapsedFolders());
      release();
      await reset;
      await vi.advanceTimersByTimeAsync(500);

      expect(stored).toEqual([["Old"]]);
      expect(tree.getCollapsedFolders()).toEqual([]);

      // Writes are allowed again once the providers are empty.
      tree.collapseFolder("After");
      persistence.schedule(tree.getCollapsedFolders());
      release();
      await vi.advanceTimersByTimeAsync(500);
      expect(stored).toEqual([["Old"], ["After"]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
