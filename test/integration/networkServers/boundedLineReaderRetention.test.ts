import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Heap retention of the bounded RPC line reader, measured in a child process.
 *
 * The fixture needs `--expose-gc` and a heap snapshot of a heap that holds
 * little besides the reader, so it runs in its own process rather than in a
 * Vitest worker, whose heap is many times larger. A WeakRef probe in-process
 * would not be a substitute: a WeakRef's target is kept alive until the
 * synchronous job that created it ends, and the release this test is about
 * happens inside one synchronous run of reentrant callbacks.
 *
 * On a loaded host the child has taken 6 s of wall time for 1 s of CPU. That is
 * why this lives in the integration project (30 s per test, one file at a time)
 * and not under the unit project's 5 s default: the child's own 15 s budget has
 * to fit inside the test's.
 */
describe("bounded RPC line reader (child process)", () => {
  it("releases historical queued snapshots during rolling reentrancy", () => {
    const fixture = resolve(process.cwd(), "test/fixtures/boundedLineReaderRollingRetention.fixture.mjs");
    const child = spawnSync(process.execPath, ["--expose-gc", fixture], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });

    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect((JSON.parse(child.stdout) as { readonly liveSnapshots: number }).liveSnapshots).toBeLessThanOrEqual(2);
  });
});
