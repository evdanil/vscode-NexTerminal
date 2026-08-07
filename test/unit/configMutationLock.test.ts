import { describe, expect, it } from "vitest";
import { AsyncMutex, configMutationLock } from "../../src/services/configMutationLock";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AsyncMutex", () => {
  it("serializes overlapping runExclusive calls — a queued call's body does not start until the holder's body has fully finished (kills a lock that only serializes acquisition, not execution)", async () => {
    const mutex = new AsyncMutex();
    const events: string[] = [];

    const holder = mutex.runExclusive(async () => {
      events.push("holder:start");
      await delay(20);
      events.push("holder:end");
    });

    // Queued while `holder` is still inside its critical section.
    const waiter = mutex.runExclusive(async () => {
      events.push("waiter:start");
      events.push("waiter:end");
    });

    await Promise.all([holder, waiter]);

    // If mutual exclusion were broken (e.g. runExclusive just called fn()
    // directly without chaining on `tail`), "waiter:start" would appear
    // before "holder:end".
    expect(events).toEqual(["holder:start", "holder:end", "waiter:start", "waiter:end"]);
  });

  it("runs queued acquirers strictly in call order (FIFO), even when a later call would naturally finish first", async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const run = (n: number, delayMs: number) =>
      mutex.runExclusive(async () => {
        await delay(delayMs);
        order.push(n);
      });

    // Called in order 1, 2, 3 but with DECREASING delays — a naive
    // "whichever settles first" scheduler would emit [3, 2, 1] instead.
    const p1 = run(1, 15);
    const p2 = run(2, 8);
    const p3 = run(3, 1);

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("releases the lock when a critical section throws, and still propagates the rejection to that caller (kills a lock that gets stuck after an error)", async () => {
    const mutex = new AsyncMutex();
    const events: string[] = [];

    const failing = mutex.runExclusive(async () => {
      events.push("failing:start");
      throw new Error("boom");
    });

    // Queued immediately after the failing call — must still run once the
    // failing call's promise settles.
    const after = mutex.runExclusive(async () => {
      events.push("after:start");
      return "ok";
    });

    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");

    expect(events).toEqual(["failing:start", "after:start"]);
  });

  it("propagates the resolved value of the wrapped function", async () => {
    const mutex = new AsyncMutex();
    const value = await mutex.runExclusive(async () => 42);
    expect(value).toBe(42);
  });

  it("exposes a shared singleton instance used across command modules", () => {
    expect(configMutationLock).toBeInstanceOf(AsyncMutex);
  });
});
