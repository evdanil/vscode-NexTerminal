import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollapsedFolderStatePersistence } from "../../src/ui/collapsedFolderStatePersistence";

describe("createCollapsedFolderStatePersistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces rapid updates and persists only the latest state", async () => {
    const persist = vi.fn(async () => {});
    const persistence = createCollapsedFolderStatePersistence(persist, { debounceMs: 50 });

    persistence.schedule(["A"]);
    persistence.schedule(["A", "B"]);

    await vi.advanceTimersByTimeAsync(49);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(["A", "B"]);

    persistence.dispose();
  });

  it("serializes overlapping writes to preserve event order", async () => {
    const resolvers: Array<() => void> = [];
    const persist = vi.fn(
      (paths: string[]) =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const persistence = createCollapsedFolderStatePersistence(persist, { debounceMs: 10 });

    persistence.schedule(["A"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenNthCalledWith(1, ["A"]);

    persistence.schedule(["B"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(persist).toHaveBeenCalledTimes(1);

    resolvers.shift()?.();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenNthCalledWith(2, ["B"]);

    resolvers.shift()?.();
    await persistence.flush();
    persistence.dispose();
  });

  it("flush writes pending state immediately", async () => {
    const persist = vi.fn(async () => {});
    const persistence = createCollapsedFolderStatePersistence(persist, { debounceMs: 1000 });

    persistence.schedule(["Prod"]);
    await persistence.flush();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(["Prod"]);

    persistence.dispose();
  });
});
