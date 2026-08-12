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
  closeSync: undefined as undefined | ((...args: any[]) => void),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unlinkSync: undefined as undefined | ((...args: any[]) => void)
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
    closeSync: (...args: any[]) => (hooks.closeSync ?? (actual.closeSync as any))(...args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    unlinkSync: (...args: any[]) => (hooks.unlinkSync ?? (actual.unlinkSync as any))(...args)
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
 * The writer's carried-over bytes, in the two stages the writer keeps them in:
 * `owed` — bytes already placed in the live file (any rotation they required
 * has been performed; only the append remains) — and `pending` — chunks whose
 * placement has not been decided yet, one per write() call, carrying no
 * decisions at all. Read through a function rather than captured once: both
 * are reassigned as drains progress.
 */
function stagesOf(transcript: SessionTranscript): { owed: Buffer; pending: Buffer[]; queue: string[] } {
  return transcript as unknown as { owed: Buffer; pending: Buffer[]; queue: string[] };
}

function retainedBytesOf(transcript: SessionTranscript): number {
  const { owed, pending } = stagesOf(transcript);
  return pending.reduce((total, chunk) => total + chunk.length, owed.length);
}

/**
 * The bytes the writer is holding that it could still choose to drop: the
 * undecided chunks plus the raw queue. Counted independently of the writer's
 * own accounting — the point of the test that uses this is that the accounting
 * was measuring a subset.
 */
function shedableBytesOf(transcript: SessionTranscript): number {
  const { pending, queue } = stagesOf(transcript);
  return queue.reduce(
    (total, chunk) => total + Buffer.byteLength(chunk, "utf8"),
    pending.reduce((total, chunk) => total + chunk.length, 0)
  );
}

/** Everything still held, oldest first, as text. */
function heldTextOf(transcript: SessionTranscript): string {
  const { owed, pending, queue } = stagesOf(transcript);
  return [owed.toString("utf8"), ...pending.map((chunk) => chunk.toString("utf8")), ...queue].join("");
}

/** Every generation of a transcript on disk, base file included. */
function generationSizes(dir: string, prefix: string): number[] {
  return readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => statSync(path.join(dir, entry)).size);
}

/** A write that always fails, asynchronously, the way a wedged fd would. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function failingWrite(...args: any[]): void {
  const callback = args[args.length - 1] as (error: Error | null, written: number) => void;
  setTimeout(() => callback(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }), 0), 0);
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
  hooks.unlinkSync = undefined;
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

    const { owed, pending } = stagesOf(transcript);
    // Non-vacuous: coalescing really did put everything into one placed
    // buffer — the single-unit shape the old cap exempted outright.
    expect(pending).toHaveLength(0);
    expect(owed.length).toBeGreaterThan(0);
    expect(retainedBytesOf(transcript)).toBeLessThanOrEqual(1024 * 1024);

    // Oldest-first shedding, so it is the tail that survives.
    const held = owed.toString("utf8");
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

    // 1.5 MiB then 1 MiB against a 2 MiB file: "a" is placed in the live
    // file; "b" would overflow it once "a" lands, so it stays undecided. The
    // write fails, and the 1 MiB cap sheds "a" — so nothing that remains
    // justifies a rotation any more.
    transcript.write("a".repeat(1536 * 1024));
    transcript.write("b".repeat(1024 * 1024));
    await sleep(400);

    const { owed, pending } = stagesOf(transcript);
    // Non-vacuous: shedding really did happen — everything placed ahead of
    // "b" was dropped — and "b", the chunk whose projected overflow the shed
    // bytes caused, survives with its placement still undecided.
    expect(owed.length).toBe(0);
    expect(pending.map((chunk) => chunk.length)).toEqual([1024 * 1024]);

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

  /**
   * E5 — the rest of E4's story. When the cap sheds bytes, everything that
   * survives must still land at the synchronous writer's byte boundaries,
   * measured against what the file really holds — not against a projection
   * that assumed the shed bytes would land. The old design cached a rotation
   * flag per batch and had to re-resolve the whole queue here (finding 8 was
   * that re-resolution resurrecting an already-performed rotation); now
   * surviving undecided chunks simply take their one placement test later, so
   * this test guards the outcome itself: the bound holds exactly, no
   * generation overruns the limit, nothing rotates that does not have to, and
   * nothing is lost but the oldest bytes the cap shed.
   */
  it("keeps rotation at the synchronous writer's boundaries after the cap sheds the oldest bytes", async () => {
    const dir = makeTempDir();
    const maxFileSizeBytes = 400_000;
    const transcript = open(dir, "stale", maxFileSizeBytes, 5);

    // One drain that lands first, so the surviving bytes are measured against
    // a live file that already holds something.
    transcript.write("P".repeat(100_000));
    await sleep(400);
    const file = transcriptPath(dir, "stale_");
    const headerBytes = statSync(file).size - 100_000;
    expect(headerBytes).toBeGreaterThan(0);

    hooks.write = failingWrite;

    // Drain two, failing outright: "A" fits alongside what is already in the
    // file, so it is placed there; "B" would overflow once "A" lands, so it
    // stays undecided. Still under the 1 MiB cap, so nothing is trimmed yet.
    transcript.write("A".repeat(250_000));
    transcript.write("B".repeat(250_000));
    await sleep(400);
    expect(stagesOf(transcript).owed.length).toBe(250_000);
    expect(stagesOf(transcript).pending.map((chunk) => chunk.length)).toEqual([250_000]);

    // Drain three, also failing, pushes the carried-over total to 1,100,000 —
    // over the cap by 51,424 bytes.
    transcript.write("C".repeat(100_000));
    transcript.write("D".repeat(300_000));
    transcript.write("E".repeat(200_000));
    await sleep(400);

    // The cap shed exactly the oldest 51,424 bytes — the head of "A" — and
    // nothing else: the bound holds while every newer byte survives. The
    // shortened "A" stays placed in the live file; everything behind it is
    // still undecided, with nothing about it resolved ahead of time.
    expect(stagesOf(transcript).owed.length).toBe(198_576);
    expect(stagesOf(transcript).pending.map((chunk) => chunk.length)).toEqual([
      250_000, 100_000, 300_000, 200_000
    ]);
    expect(retainedBytesOf(transcript)).toBe(1024 * 1024);

    hooks.write = undefined;
    transcript.write("after the drop\n");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (allTranscriptText(dir, "stale_").endsWith("after the drop\n")) {
        break;
      }
      await sleep(20);
    }

    // The invariant this design holds by construction: the transcript rotates
    // at the same byte boundaries the synchronous writer would have produced
    // for the surviving chunks. No generation overruns the limit...
    expect(Math.max(...generationSizes(dir, "stale_"))).toBeLessThanOrEqual(maxFileSizeBytes);
    // ...and nothing rotated that did not have to: the trimmed "A" still fits
    // the live file, "C" fits behind "B", and only "B", "D" and "E" each
    // overflow the file left by the bytes settled ahead of them.
    expect(readdirSync(dir).filter((entry) => /\.log\.\d+$/.test(entry))).toHaveLength(3);

    // Only the oldest bytes the cap shed are missing; everything else is
    // intact and in order across the generations.
    const text = allTranscriptText(dir, "stale_");
    expect(text.startsWith("--- Session started")).toBe(true);
    expect(text.slice(headerBytes)).toBe(
      `${"P".repeat(100_000)}${"A".repeat(198_576)}${"B".repeat(250_000)}${"C".repeat(100_000)}${"D".repeat(300_000)}${"E".repeat(200_000)}after the drop\n`
    );
  });

  /**
   * F1 — finding 8. An oversized chunk rotates, lands only a prefix, and the
   * failure leaves a remainder bigger than the retention cap. The rotation
   * this chunk asked for has already been performed; nothing that happens
   * afterwards — not the failure, not the cap shedding bytes — may perform it
   * again. At `maxRotatedFiles: 0` a repeated rotation does not merely shift
   * generations: it unlinks the live file, destroying the prefix that already
   * reached disk.
   */
  it("does not rotate the same chunk twice when its remainder is trimmed by the cap", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "double", 2 * 1024 * 1024, 0);
    await sleep(400); // the session header lands before the fault is armed

    // One write() call, over maxFileSizeBytes on its own: 1.5 MiB of it will
    // reach disk (more than the 1 MiB cap), the 1.5 MiB remainder will not
    // (also more than the cap, so the trim has to shed into it).
    const partial = 1536 * 1024;
    const chunk = `PREFIX-MARKER${"x".repeat(3 * 1024 * 1024 - 24)}TAIL-MARKER`;

    let unlinks = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.unlinkSync = (...args: any[]) => {
      unlinks += 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (hooks.actual!.unlinkSync as any)(...args);
    };
    let writes = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.write = (...args: any[]) => {
      const [fd, data, offset, , callback] = args;
      writes += 1;
      if (writes === 1) {
        // A short write: only the prefix lands.
        hooks.actual!.write(fd, data, offset, partial, callback);
        return;
      }
      if (writes === 2) {
        // The resume fails, stranding a remainder larger than the cap.
        setTimeout(() => callback(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }), 0), 0);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (hooks.actual!.write as any)(...args);
    };

    transcript.write(chunk);
    await sleep(400); // timer drain: rotate once, prefix lands, resume fails, cap trims

    // Non-vacuous: the rotation really happened — at maxRotatedFiles: 0 that
    // is one unlink of the live file — and the prefix really is on disk.
    expect(unlinks).toBe(1);
    expect(writes).toBe(2);
    const file = transcriptPath(dir, "double_");
    expect(statSync(file).size).toBe(partial);

    // The recovery drain. The remainder is bytes already owed to this very
    // file — nothing about it may rotate again.
    transcript.flush?.();

    expect(unlinks).toBe(1); // the same logical chunk did not rotate a second time
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("PREFIX-MARKER")).toBe(true); // the prefix that reached disk was not destroyed
    expect(text.endsWith("TAIL-MARKER")).toBe(true); // the newest bytes of the remainder landed behind it
    expect(statSync(file).size).toBe(partial + 1024 * 1024); // prefix + exactly the capped remainder
  });

  /**
   * F2 — finding 8 with generations kept. The same double rotation at
   * `maxRotatedFiles: 1` does not delete the prefix outright; it shifts the
   * prefix into `.1` — destroying the generation that was already there — and
   * strands the remainder alone in a fresh live file, splitting one `write()`
   * call across a rotation boundary, which the synchronous writer never did.
   */
  it("keeps earlier generations when an oversized chunk's remainder is retried", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "keepgen", 2 * 1024 * 1024, 1);
    await sleep(400); // header lands; the first rotation will shift it to .1

    const partial = 1536 * 1024;
    const chunk = `PREFIX-MARKER${"x".repeat(3 * 1024 * 1024 - 24)}TAIL-MARKER`;

    let writes = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.write = (...args: any[]) => {
      const [fd, data, offset, , callback] = args;
      writes += 1;
      if (writes === 1) {
        hooks.actual!.write(fd, data, offset, partial, callback);
        return;
      }
      if (writes === 2) {
        setTimeout(() => callback(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }), 0), 0);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (hooks.actual!.write as any)(...args);
    };

    transcript.write(chunk);
    await sleep(400);
    expect(writes).toBe(2); // non-vacuous: the partial write and the failure both happened

    transcript.flush?.();

    // The generation shifted when the chunk rotated still holds the session
    // header; retrying the remainder must not shift (and so destroy) it.
    const base = transcriptPath(dir, "keepgen_");
    expect(readFileSync(`${base}.1`, "utf8")).toContain("--- Session started");
    // And the chunk was not split across generations: prefix and remainder
    // sit together in the live file.
    const text = readFileSync(base, "utf8");
    expect(text.startsWith("PREFIX-MARKER")).toBe(true);
    expect(text.endsWith("TAIL-MARKER")).toBe(true);
  });

  /**
   * The placement invariant behind F1/F2, without an oversized chunk: bytes a
   * failed write leaves behind were already placed in a specific generation,
   * and a retry may only finish that placement — while chunks queued behind
   * them are placed afresh, against what the file really holds by then.
   */
  it("lands a failed remainder in the generation it was placed in, and later chunks behind it", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "placed", 200, 3);
    await sleep(400); // header (49 bytes) lands

    transcript.write("X".repeat(140)); // 49 + 140 ≤ 200 — same file
    await sleep(400);

    let writes = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.write = (...args: any[]) => {
      const [fd, data, offset, , callback] = args;
      writes += 1;
      if (writes === 1) {
        hooks.actual!.write(fd, data, offset, 5, callback); // "YYYYY" lands
        return;
      }
      if (writes === 2) {
        setTimeout(() => callback(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }), 0), 0);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (hooks.actual!.write as any)(...args);
    };
    transcript.write("Y".repeat(100)); // 189 + 100 > 200 — rotates, then fails mid-write
    await sleep(400);
    expect(writes).toBe(2);

    hooks.write = undefined;
    transcript.write("Z".repeat(10));
    await sleep(400);

    // One rotation, exactly where the synchronous writer would have put it:
    // the shifted generation ends at the X chunk, and the Y remainder landed
    // in the file the Y chunk was placed in, with Z appended after it.
    const base = transcriptPath(dir, "placed_");
    expect(readdirSync(dir).filter((entry) => /\.log\.\d+$/.test(entry))).toHaveLength(1);
    const first = readFileSync(`${base}.1`, "utf8");
    expect(first).toContain("--- Session started");
    expect(first.endsWith("X".repeat(140))).toBe(true);
    expect(readFileSync(base, "utf8")).toBe(`${"Y".repeat(100)}${"Z".repeat(10)}`);
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

  /**
   * J2 — the retention cap measured `owed` plus `pending` and ignored `queue`,
   * the one stage that can grow while a write is wedged. An `fs.write` whose
   * callback never fires (a stalled network share is the realistic case) leaves
   * the drain awaiting forever: `trimRetained` is never reached, every later
   * drain queues behind the blocked promise, and terminal output piles into a
   * queue nothing was measuring. A busy session could exhaust the extension
   * host despite MAX_RETAINED_BYTES.
   */
  it("bounds what it holds while a write stays wedged forever, keeping the newest bytes", async () => {
    const dir = makeTempDir();
    // A file limit far above anything written here: nothing rotates, so this
    // is about the memory bound and nothing else.
    const transcript = open(dir, "wedgecap", 64 * 1024 * 1024, 1);

    hooks.write = deferringWrite(Number.MAX_SAFE_INTEGER); // never calls back

    // Wedge a drain: it takes the header, hands it to fs.write, and never hears
    // back. From here on no drain can complete, so nothing this session writes
    // can ever reach the drain-time trim.
    transcript.write("wedge me\n");
    await sleep(400);
    expect(parked).toHaveLength(1);

    // The hot path must stay off blocking syscalls even while the bound is
    // being enforced — a cap that holds by draining synchronously would put a
    // wedged fd's latency straight onto the render path.
    let syncWrites = 0;
    let opens = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.writeSync = (...args: any[]) => {
      syncWrites += 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (hooks.actual!.writeSync as any)(...args);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.openSync = (...args: any[]) => {
      opens += 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (hooks.actual!.openSync as any)(...args);
    };

    // 8 MiB of output into a writer that cannot write anything at all.
    let produced = 0;
    const produce = (text: string): void => {
      produced += Buffer.byteLength(text, "utf8");
      transcript.write(text);
    };
    produce(`OLDEST-MARKER${"o".repeat(64 * 1024)}`);
    for (let index = 0; index < 63; index += 1) {
      produce("x".repeat(128 * 1024));
    }
    produce(`${"n".repeat(64 * 1024)}NEWEST-MARKER`);
    await sleep(400);

    // Non-vacuous: the write really never came back, so no drain ever ran the
    // trim, and 8 MiB really did arrive behind it.
    expect(parked).toHaveLength(1);
    expect(produced).toBeGreaterThan(8 * 1024 * 1024);

    // The bound, enforced with the drain permanently out of the picture.
    expect(shedableBytesOf(transcript)).toBeLessThanOrEqual(1024 * 1024);
    // The buffer inside the wedged syscall is exempt — the kernel owns it and
    // dropping it would free nothing — but it is a single append that cannot
    // grow, not a leak: it still holds only the pre-wedge write.
    const { owed } = stagesOf(transcript);
    expect(owed.length).toBeLessThan(1024);
    expect(shedableBytesOf(transcript) + owed.length).toBeLessThanOrEqual(2 * 1024 * 1024);

    // Newest-first survival, the same policy the drain-time cap applies.
    const held = heldTextOf(transcript);
    expect(held.endsWith("NEWEST-MARKER")).toBe(true);
    expect(held).not.toContain("OLDEST-MARKER");

    // Nothing on the hot path blocked: no synchronous write, no open.
    expect(syncWrites).toBe(0);
    expect(opens).toBe(0);
  });
});
