import { afterEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Failure-path tests for the buffered transcript writer.
 *
 * The buffered writer replaced a `writeSync` per chunk. These cover the three
 * ways that conversion can lose data that the synchronous writer could not:
 * a write that fails, a write that only partly lands, and a shutdown that does
 * not wait for the drain it started.
 *
 * `node:fs` is mocked here (and only here) so `write` / `writeSync` can be made
 * to fail, short-write, or hang. Everything else passes through to the real fs,
 * so the assertions are against bytes on a real disk.
 */
const hooks = vi.hoisted(() => ({
  actual: undefined as typeof import("node:fs") | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  write: undefined as undefined | ((...args: any[]) => void),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeSync: undefined as undefined | ((...args: any[]) => number),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openSync: undefined as undefined | ((...args: any[]) => number),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  closeSync: undefined as undefined | ((...args: any[]) => void)
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  hooks.actual = actual;
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    write: (...args: any[]) => (hooks.write ?? (actual.write as any))(...args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeSync: (...args: any[]) => (hooks.writeSync ?? (actual.writeSync as any))(...args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    openSync: (...args: any[]) => (hooks.openSync ?? (actual.openSync as any))(...args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    closeSync: (...args: any[]) => (hooks.closeSync ?? (actual.closeSync as any))(...args)
  };
});

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import {
  createSessionTranscript,
  flushSessionTranscripts,
  type SessionTranscript
} from "../../src/logging/sessionTranscriptLogger";

const tempDirs: string[] = [];
const openTranscripts: SessionTranscript[] = [];
/** Writes captured by a deferring stub, released by the test (or by cleanup). */
const parked: Array<{ run: () => void; fail: (error: Error) => void }> = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nexus-transcript-fail-"));
  tempDirs.push(dir);
  return dir;
}

function open(dir: string, prefix: string, maxFileSizeBytes: number, maxRotatedFiles: number): SessionTranscript {
  const transcript = createSessionTranscript(dir, prefix, true, { maxFileSizeBytes, maxRotatedFiles });
  openTranscripts.push(transcript);
  return transcript;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transcriptPath(dir: string, prefix: string): string {
  const name = readdirSync(dir).find((entry) => entry.startsWith(prefix) && entry.endsWith(".log"));
  if (!name) {
    throw new Error(`no transcript file in ${dir}`);
  }
  return path.join(dir, name);
}

/**
 * Base file plus every rotated generation, concatenated oldest-first. The base
 * file may legitimately be absent (a rotation that could not reopen it), so it
 * is skipped rather than throwing over the assertion that wanted to run.
 */
function allTranscriptText(dir: string, prefix: string): string {
  const names = readdirSync(dir).filter((entry) => entry.startsWith(prefix));
  const base = names.find((entry) => entry.endsWith(".log"));
  const rotated = names.filter((entry) => /\.log\.\d+$/.test(entry)).sort().reverse();
  const ordered = base === undefined ? rotated : [...rotated, base];
  return ordered.map((entry) => readFileSync(path.join(dir, entry), "utf8")).join("");
}

/**
 * A stub that keeps callbacks instead of writing. `deferCount` writes are
 * parked; every write after that goes to the real fs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deferringWrite(deferCount: number): (...args: any[]) => void {
  let seen = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (...args: any[]) => {
    if (seen >= deferCount) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (hooks.actual!.write as any)(...args);
      return;
    }
    seen += 1;
    const callback = args[args.length - 1] as (error: Error | null, written: number) => void;
    parked.push({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: () => (hooks.actual!.write as any)(...args),
      fail: (error: Error) => callback(error, 0)
    });
  };
}

afterEach(async () => {
  // Let anything the test parked complete, so close() below is not stuck
  // behind a drain that can never finish.
  hooks.write = undefined;
  hooks.writeSync = undefined;
  hooks.openSync = undefined;
  hooks.closeSync = undefined;
  for (const write of parked.splice(0, parked.length)) {
    write.fail(new Error("released by test cleanup"));
  }
  await sleep(0);
  for (const transcript of openTranscripts.splice(0, openTranscripts.length)) {
    transcript.close();
  }
  await sleep(0);
  await sleep(0);
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("session transcript failure paths", () => {
  /**
   * D1 — a failed write used to drop the batch it failed on *and* every batch
   * queued behind it. A transient EIO must cost a retry, not the session's log.
   */
  it("retries a failed drain without losing or reordering anything behind it", async () => {
    const dir = makeTempDir();
    // 200-byte files against 18-byte lines cuts the first drain into three
    // batches, so the failure lands on the first of several.
    const transcript = open(dir, "retry", 200, 5);

    let failed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.write = (...args: any[]) => {
      const callback = args[args.length - 1] as (error: Error | null, written: number) => void;
      if (!failed) {
        failed = true;
        setTimeout(() => callback(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }), 0), 0);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (hooks.actual!.write as any)(...args);
    };

    const lines = Array.from({ length: 24 }, (_, index) => `chunk-${String(index).padStart(3, "0")} pay\n`);
    for (const line of lines) {
      transcript.write(line);
    }
    await sleep(400); // timer drain — fails on the first batch
    expect(failed).toBe(true);

    // A later write pulls the retained batches out with it.
    transcript.write("chunk-024 pay\n");
    await sleep(400);

    const text = allTranscriptText(dir, "retry_");
    const order = [...text.matchAll(/chunk-(\d{3})/g)].map((match) => Number(match[1]));
    expect(order).toEqual(Array.from({ length: 25 }, (_, index) => index));
    // Non-vacuous: this fixture really does rotate, and the rotation that the
    // failed batches carried was replayed rather than swallowed.
    expect(readdirSync(dir).filter((entry) => /\.log\.\d+$/.test(entry)).length).toBeGreaterThan(0);
  });

  /**
   * D2 — `fs.write` may land fewer bytes than it was given. The callback used
   * to be treated as "all of it", so the unwritten suffix was lost and
   * `currentSize` (which drives rotation) drifted ahead of the real file.
   */
  it("finishes a short write and only counts bytes that actually landed", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "short", 1024 * 1024, 1);

    // 7 bytes a call, against 3-byte characters: every resume lands mid-glyph.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.write = (...args: any[]) => {
      const [fd, data, ...rest] = args;
      if (typeof data === "string") {
        // The shape the pre-fix writer used: whole string, no offset.
        const callback = rest[rest.length - 1] as (error: Error | null, written: number, data: string) => void;
        const slice = Buffer.from(data, "utf8").subarray(0, 7);
        hooks.actual!.write(fd, slice, 0, slice.length, (error, written) =>
          callback(error, written, data)
        );
        return;
      }
      const [offset, length, callback] = rest;
      hooks.actual!.write(fd, data, offset, Math.min(length, 7), callback);
    };

    const lines = Array.from({ length: 6 }, (_, index) => `日本語テスト-${String(index).padStart(3, "0")}\n`);
    for (const line of lines) {
      transcript.write(line);
    }

    const file = transcriptPath(dir, "short_");
    const expectedTail = lines.join("");
    for (let attempt = 0; attempt < 100 && !readFileSync(file, "utf8").endsWith(expectedTail); attempt += 1) {
      await sleep(20);
    }

    const text = readFileSync(file, "utf8");
    expect(text).toContain("--- Session started");
    expect(text.endsWith(expectedTail)).toBe(true);
    // Every multi-byte character survived the resume boundary intact.
    expect(text).not.toContain("�");
    for (const line of lines) {
      expect(text).toContain(line.trim());
    }
    // Rotation accounting tracks the file, not the bytes we handed to fs.
    const currentSize = (transcript as unknown as { currentSize: number }).currentSize;
    expect(currentSize).toBe(statSync(file).size);
  });

  /**
   * D3 — the lifecycle flush lands mid-drain, chains the tail behind it, and
   * returns. Nothing in the deactivate path used to wait for that chain, so the
   * extension host could exit with the batch still in flight — a regression
   * against the synchronous writer this replaced.
   */
  it("shutdown flush waits for the in-flight batch and the queued tail", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "shutdown", 1024 * 1024, 1);
    hooks.write = deferringWrite(1);

    transcript.write("alpha\n");
    await sleep(400); // timer drain starts and parks inside fs.write
    expect(parked).toHaveLength(1);

    // The tail a PTY writes between the drain starting and teardown.
    transcript.write("omega\n");
    // What markShuttingDown() does — it can only chain from here.
    transcript.flush?.();

    let settled = false;
    const shutdown = flushSessionTranscripts(4000).then(() => {
      settled = true;
    });

    await sleep(30);
    const file = transcriptPath(dir, "shutdown_");
    expect(settled).toBe(false);
    expect(readFileSync(file, "utf8")).not.toContain("alpha");

    parked.splice(0, parked.length)[0].run();
    await shutdown;

    expect(settled).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("alpha");
    expect(text).toContain("omega");
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("omega"));
  });

  /**
   * E1 — rotation closes the live descriptor before it opens the next one. If
   * that open fails (permissions, a directory that vanished, EMFILE), the old
   * descriptor is already gone but `this.fd` still holds its number, so every
   * later attempt closes a number the process no longer owns: EBADF forever if
   * the number is free, and *somebody else's file* once the OS reuses it.
   *
   * The load-bearing assertion is the second one — a transcript that recovers
   * its content but corrupts an unrelated descriptor on the way is not fixed.
   */
  it("recovers from a failed rotation without closing a descriptor it no longer owns", async () => {
    const dir = makeTempDir();
    // Same shape as D1: 200-byte files against 18-byte lines, so the queue is
    // cut into several batches and the first of them has to rotate.
    const transcript = open(dir, "rotfail", 200, 5);
    const firstFd = (transcript as unknown as { fd: number }).fd;

    // Every descriptor this transcript legitimately holds. A close for anything
    // not in here is a close of a descriptor the process does not own.
    const owned = new Set<number>([firstFd]);
    const closedWhileUnowned: number[] = [];
    let openFailures = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.openSync = (...args: any[]) => {
      if (openFailures === 0) {
        openFailures += 1;
        throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fd = (hooks.actual!.openSync as any)(...args);
      owned.add(fd);
      return fd;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.closeSync = (...args: any[]) => {
      const fd = args[0] as number;
      if (!owned.has(fd)) {
        closedWhileUnowned.push(fd);
      }
      owned.delete(fd);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (hooks.actual!.closeSync as any)(...args);
    };

    const lines = Array.from({ length: 24 }, (_, index) => `chunk-${String(index).padStart(3, "0")} pay\n`);
    for (const line of lines) {
      transcript.write(line);
    }
    await sleep(400); // timer drain — the rotation's open fails
    expect(openFailures).toBe(1); // non-vacuous: a rotation really did break

    // A later write drives the retry that has to recover the descriptor.
    transcript.write("chunk-024 pay\n");
    await sleep(400);
    transcript.flush?.();
    await sleep(50);

    // The fd-reuse hazard: the failed rotation must not leave a stale number
    // behind for a later close to hand back to the OS. Checked first — a
    // transcript that recovers its own content while closing somebody else's
    // descriptor is not fixed.
    expect(closedWhileUnowned).toEqual([]);

    // The transcript is recording again, and nothing was lost on the way.
    const text = allTranscriptText(dir, "rotfail_");
    const order = [...text.matchAll(/chunk-(\d{3})/g)].map((match) => Number(match[1]));
    expect(order).toEqual(Array.from({ length: 25 }, (_, index) => index));
  });

  /**
   * E2 — `close()` drained, and then closed the descriptor and deregistered the
   * transcript whether or not the drain landed. A transient failure on that
   * last write moved the tail and the session footer into `retained`, where
   * nothing could ever retry them: terminal closure lost exactly the bytes the
   * retention stage exists to preserve.
   */
  it("does not discard the tail when the close-time write fails", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "closefail", 1024 * 1024, 1);
    transcript.write("tail line\n");

    let failures = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.writeSync = (...args: any[]) => {
      if (failures === 0) {
        failures += 1;
        throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (hooks.actual!.writeSync as any)(...args);
    };

    transcript.close();

    // Non-vacuous: the close really did fail to write, and nothing reached the
    // file — the tail only survives if something retries it after close().
    expect(failures).toBe(1);
    const file = transcriptPath(dir, "closefail_");
    expect(readFileSync(file, "utf8")).toBe("");

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (readFileSync(file, "utf8").includes("--- Session ended")) {
        break;
      }
      await sleep(20);
    }

    const text = readFileSync(file, "utf8");
    expect(text).toContain("--- Session started");
    expect(text).toContain("tail line");
    expect(text).toContain("--- Session ended");
    expect(text.indexOf("tail line")).toBeLessThan(text.indexOf("--- Session ended"));
  });

  it("gives up the close-time retry on a bounded budget and says what was lost", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "closelost", 1024 * 1024, 1);
    transcript.write("tail that never lands\n");
    const fd = (transcript as unknown as { fd: number }).fd;

    const closed: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.closeSync = (...args: any[]) => {
      closed.push(args[0] as number);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (hooks.actual!.closeSync as any)(...args);
    };
    hooks.writeSync = () => {
      throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
    };
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      transcript.close();
      for (let attempt = 0; attempt < 200 && reported.mock.calls.length === 0; attempt += 1) {
        await sleep(20);
      }

      // Surfaced rather than swallowed...
      expect(reported).toHaveBeenCalledTimes(1);
      expect(String(reported.mock.calls[0][0])).toContain("closelost");
      // ...and the descriptor was handed back rather than held open forever by
      // a retry that can never succeed.
      expect(closed).toContain(fd);
    } finally {
      reported.mockRestore();
    }
  });

  /**
   * E3 — the retention cap exempted the last batch standing, so it only ever
   * bounded a queue of *several* batches. `takeBatches()` coalesces every
   * adjacent chunk bound for the same file into one batch, so the common shape
   * under a permanently failing fd is a single batch holding everything — and
   * that one was exempt. The stated 1 MiB bound did not hold.
   */
  it("bounds a single oversized retained batch, keeping the newest bytes", async () => {
    const dir = makeTempDir();
    // A file limit far above anything written here, so nothing rotates and the
    // whole queue coalesces into exactly one batch.
    const transcript = open(dir, "cap", 64 * 1024 * 1024, 1);

    hooks.write = (...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, written: number) => void;
      setTimeout(() => callback(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }), 0), 0);
    };

    // 3 MiB, three times the cap, in chunks that land in one batch. The first
    // and last carry markers so it is visible which end survived.
    transcript.write(`HEAD-MARKER${"a".repeat(1024 * 1024 - 11)}`);
    transcript.write("b".repeat(1024 * 1024));
    transcript.write(`${"c".repeat(1024 * 1024 - 11)}TAIL-MARKER`);
    await sleep(400); // timer drain — every write fails

    const retained = (transcript as unknown as { retained: Array<{ data: Buffer }> }).retained;
    // Non-vacuous: coalescing really did produce a single batch, which is the
    // shape the old `length > 1` guard exempted outright.
    expect(retained).toHaveLength(1);
    const retainedBytes = retained.reduce((total, batch) => total + batch.data.length, 0);
    expect(retainedBytes).toBeLessThanOrEqual(1024 * 1024);

    // Oldest-first shedding, so it is the tail that survives.
    const held = Buffer.concat(retained.map((batch) => batch.data)).toString("utf8");
    expect(held.endsWith("TAIL-MARKER")).toBe(true);
    expect(held).not.toContain("HEAD-MARKER");

    // Let the retry land, then check the accounting against the real file.
    hooks.write = undefined;
    transcript.write("after the drop\n");
    const file = transcriptPath(dir, "cap_");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (readFileSync(file, "utf8").endsWith("after the drop\n")) {
        break;
      }
      await sleep(20);
    }

    const text = readFileSync(file, "utf8");
    expect(text.endsWith("after the drop\n")).toBe(true);
    expect(text).toContain("TAIL-MARKER");
    // `currentSize` counts bytes that reached the file, and dropping unwritten
    // bytes must not move it out of step with what is on disk.
    const currentSize = (transcript as unknown as { currentSize: number }).currentSize;
    expect(currentSize).toBe(statSync(file).size);
    // Nothing here came close to the 64 MiB file limit, so the trimmed batch
    // must not have claimed a rotation the lost bytes never justified.
    expect(readdirSync(dir).filter((entry) => /\.log\.\d+$/.test(entry))).toEqual([]);
  });

  /**
   * E4 — the other half of E3. A batch's `rotateFirst` was resolved against a
   * projection that assumed every batch ahead of it would land. Shedding those
   * batches makes that projection wrong, and a batch that then still claims its
   * rotation shifts a generation to make room in a file the lost bytes never
   * filled — at `maxRotatedFiles: 1`, deleting the oldest one outright.
   */
  it("does not rotate for bytes the retention cap dropped", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "rotcap", 2 * 1024 * 1024, 1);

    // Land a first drain so the live file has content worth not shifting away.
    transcript.write("PRECIOUS\n");
    await sleep(400);
    const file = transcriptPath(dir, "rotcap_");
    expect(readFileSync(file, "utf8")).toContain("PRECIOUS");

    hooks.write = (...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, written: number) => void;
      setTimeout(() => callback(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }), 0), 0);
    };

    // 1.5 MiB then 1 MiB against a 2 MiB file: the second batch is cut at the
    // rotation the first one's bytes would have caused. The write fails, and
    // the 1 MiB cap sheds the first batch — so that rotation is now for bytes
    // that will never reach the file.
    transcript.write("a".repeat(1536 * 1024));
    transcript.write("b".repeat(1024 * 1024));
    await sleep(400);

    const retained = (transcript as unknown as { retained: Array<{ rotateFirst: boolean; data: Buffer }> }).retained;
    // Non-vacuous: shedding really did happen, and the survivor really is the
    // batch that carried the rotation.
    expect(retained).toHaveLength(1);
    expect(retained[0].data.length).toBe(1024 * 1024);

    hooks.write = undefined;
    transcript.write("after the drop\n");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (readFileSync(file, "utf8").endsWith("after the drop\n")) {
        break;
      }
      await sleep(20);
    }

    // No generation was shifted, and the live file kept everything it had.
    expect(readdirSync(dir).filter((entry) => /\.log\.\d+$/.test(entry))).toEqual([]);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("PRECIOUS");
    expect(text).toContain("after the drop");
    const currentSize = (transcript as unknown as { currentSize: number }).currentSize;
    expect(currentSize).toBe(statSync(file).size);
  });

  it("shutdown flush gives up rather than hanging on a wedged write", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "wedged", 1024 * 1024, 1);
    hooks.write = deferringWrite(Number.MAX_SAFE_INTEGER); // never calls back

    transcript.write("never lands\n");
    await sleep(400);
    expect(parked.length).toBeGreaterThan(0);

    const started = Date.now();
    await flushSessionTranscripts(50);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1500);
    // The wedged write really is still outstanding — the wait was bounded, not
    // satisfied.
    expect(parked.length).toBeGreaterThan(0);
    expect(existsSync(transcriptPath(dir, "wedged_"))).toBe(true);
  });
});
