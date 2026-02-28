import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoalescedInvoker } from "../../src/utils/coalescedInvoker";

describe("createCoalescedInvoker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid schedule calls into one invocation", () => {
    const run = vi.fn();
    const invoker = createCoalescedInvoker(run, 150);

    invoker.schedule();
    invoker.schedule();
    invoker.schedule();
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(149);
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("can schedule again after the first run executes", () => {
    const run = vi.fn();
    const invoker = createCoalescedInvoker(run, 150);

    invoker.schedule();
    vi.advanceTimersByTime(150);
    expect(run).toHaveBeenCalledTimes(1);

    invoker.schedule();
    vi.advanceTimersByTime(150);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("flushes immediately and clears pending timer", () => {
    const run = vi.fn();
    const invoker = createCoalescedInvoker(run, 150);

    invoker.schedule();
    invoker.flush();
    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels pending invocation", () => {
    const run = vi.fn();
    const invoker = createCoalescedInvoker(run, 150);

    invoker.schedule();
    invoker.dispose();

    vi.advanceTimersByTime(200);
    expect(run).not.toHaveBeenCalled();
  });
});
