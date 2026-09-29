import { describe, expect, it, vi } from "vitest";
import { ColorSchemeService, type ColorSchemeStorage } from "../../src/services/colorSchemeService";
import type { ColorScheme, TerminalFontConfig } from "../../src/models/colorScheme";
import { bumpResetGeneration, createResetGenerationGuard, type GenerationState } from "../../src/storage/resetGeneration";
import { createCollapsedFolderState } from "../../src/ui/collapsedFolderState";

/** One globalState shared by every window, as VS Code shares it. */
function sharedMemento(): GenerationState & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string, fallback: T): T => (data.has(key) ? (data.get(key) as T) : fallback),
    update: async (key, value) => {
      if (value === undefined) data.delete(key);
      else data.set(key, JSON.parse(JSON.stringify(value)));
    }
  };
}

class FakeTree {
  private readonly collapsed = new Set<string>();
  collapseFolder(path: string): void { this.collapsed.add(path); }
  expandFolder(path: string): void { this.collapsed.delete(path); }
  getCollapsedFolders(): string[] { return [...this.collapsed]; }
  loadCollapsedFolders(paths: string[]): void { this.collapsed.clear(); paths.forEach((p) => this.collapsed.add(p)); }
  refresh(): void {}
}

const KEY = "nexus.ui.collapsedFolders";

async function twoWindows(withGuard: boolean) {
  vi.useFakeTimers();
  const memento = sharedMemento();
  await memento.update(KEY, ["Old", "Old/Core"]);
  const make = () => {
    const provider = new FakeTree();
    const guard = withGuard ? createResetGenerationGuard(memento) : { hasChanged: () => false, consumeIfChanged: () => false };
    const window = createCollapsedFolderState({ state: memento, storageKey: KEY, provider, guard, onError: () => undefined });
    return { provider, ...window };
  };
  return { memento, a: make(), b: make() };
}

describe("Delete All Data reaches other windows through the reset generation", () => {
  it("window A's next toggle does not write its stale set back over window B's reset (⊘ persisting the in-memory set)", async () => {
    try {
      const { memento, a, b } = await twoWindows(true);
      expect(a.provider.getCollapsedFolders()).toEqual(["Old", "Old/Core"]);

      // Window B: Delete All Data — clear the key, empty its provider, bump the counter (as completeReset does, in that order).
      await memento.update(KEY, undefined);
      b.provider.loadCollapsedFolders([]);
      await bumpResetGeneration(memento);

      a.handleChange("New", true);
      await vi.advanceTimersByTimeAsync(500);

      expect(memento.data.get(KEY)).toEqual(["New"]);
      expect(a.provider.getCollapsedFolders()).toEqual(["New"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a write already queued in A when the reset lands is dropped, not persisted stale", async () => {
    try {
      const { memento, a } = await twoWindows(true);
      a.handleChange("Queued", true); // scheduled, not yet written
      await memento.update(KEY, undefined);
      await bumpResetGeneration(memento);
      await vi.advanceTimersByTimeAsync(500);

      expect(memento.data.has(KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("control: without the guard the stale set does come back (the scenario is real)", async () => {
    try {
      const { memento, a } = await twoWindows(false);
      await memento.update(KEY, undefined);
      await bumpResetGeneration(memento);

      a.handleChange("New", true);
      await vi.advanceTimersByTimeAsync(500);

      expect(memento.data.get(KEY)).toEqual(["Old", "Old/Core", "New"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the Terminal Appearance cache of another window is reloaded, not written back", async () => {
    const memento = sharedMemento();
    const storage = (): ColorSchemeStorage => ({
      getUserSchemes: () => memento.get<ColorScheme[]>("s", []),
      saveUserSchemes: async (v) => memento.update("s", v),
      getActiveSchemeId: () => memento.get<string>("a", ""),
      saveActiveSchemeId: async (v) => memento.update("a", v),
      getFontConfig: () => memento.get<TerminalFontConfig | undefined>("f", undefined),
      saveFontConfig: async (v) => memento.update("f", v),
      clearAll: async () => { memento.data.delete("s"); memento.data.delete("a"); memento.data.delete("f"); }
    });
    const scheme = (id: string) => ({ id, name: id } as unknown as ColorScheme);
    await memento.update("s", [scheme("imported")]);
    await memento.update("a", "imported");
    const windowA = new ColorSchemeService(storage(), createResetGenerationGuard(memento));
    const windowB = new ColorSchemeService(storage(), createResetGenerationGuard(memento));

    await windowB.reset();
    await bumpResetGeneration(memento);

    // A's cache still holds "imported"; its next edit must persist only the new scheme.
    await windowA.addSchemes([scheme("fresh")]);
    expect(memento.data.get("s")).toEqual([scheme("fresh")]);
    expect(windowA.getActiveSchemeId()).toBe("");
  });
});
