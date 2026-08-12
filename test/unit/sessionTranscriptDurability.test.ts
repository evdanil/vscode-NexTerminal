import { afterEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Failure-path tests for the buffered transcript writer.
 *
 * The buffered writer replaced a `writeSync` per chunk. These cover the ways
 * that conversion can lose data that the synchronous writer could not — a
 * write that fails, a write that only partly lands, a shutdown that does not
 * wait for the drain it started — and the retention cap's two-sided contract:
 * nothing is ever shed while the writer holds no more than the cap (however
 * slow, failing, or wedged the descriptor), and the writer never holds more
 * than the cap, for any arrival pattern, enforced at admission with no
 * dependence on drains or later arrivals. Fixtures that stage the cap itself
 * inject a small `maxRetainedBytes`; fixtures whose claim is about production
 * behaviour run against the 64 MiB default.
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

/**
 * `maxRetainedBytes` is the retention cap, injectable so the bound is
 * checkable at test-sized fixtures. Omitted, the production default (64 MiB)
 * applies — tests that stage healthy bursts run against the default on
 * purpose, because "no realistic burst is ever shed" is a claim about the
 * default.
 */
function open(
  dir: string,
  prefix: string,
  maxFileSizeBytes: number,
  maxRotatedFiles: number,
  maxRetainedBytes?: number
): SessionTranscript {
  const transcript = createSessionTranscript(dir, prefix, true, {
    maxFileSizeBytes,
    maxRotatedFiles,
    maxRetainedBytes
  });
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
 * The writer's carried-over bytes, in the stages the writer keeps them in:
 * `owed` — bytes already placed in the live file (any rotation they required
 * has been performed; only the append remains) — and `pending` — chunks whose
 * placement has not been decided yet, one per write() call, carrying no
 * decisions at all. `inFlight` is the fourth: placed bytes taken out of `owed`
 * for exactly as long as one `fs.write` holds them, and the only thing the
 * retention cap does not count. Read through a function rather than captured
 * once: all of them are reassigned as drains progress.
 */
function stagesOf(transcript: SessionTranscript): {
  owed: Buffer;
  inFlight: Buffer;
  pending: Buffer[];
  queue: string[];
} {
  return transcript as unknown as {
    owed: Buffer;
    inFlight: Buffer;
    pending: Buffer[];
    queue: string[];
  };
}

function retainedBytesOf(transcript: SessionTranscript): number {
  const { owed, pending } = stagesOf(transcript);
  return pending.reduce((total, chunk) => total + chunk.length, owed.length);
}

/** Everything the writer holds in its own stages: `owed` + `pending` + `queue`. */
function heldBytesOf(transcript: SessionTranscript): number {
  return shedableBytesOf(transcript) + stagesOf(transcript).owed.length;
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
   * bounded a queue of *several* batches. The stated bound did not hold.
   *
   * The cap is now enforced at admission — pushQueued(), the one place bytes
   * enter the writer — so by the time a failing descriptor has refused a
   * drain, everything the writer holds is already within the cap. This
   * fixture injects a 1 MiB cap (the old constant) to keep the arithmetic:
   * 3 MiB poured, exactly 1 MiB — the newest — retained, and the recovery
   * accounting still matches the file on disk byte for byte.
   */
  it("bounds a single oversized retained batch, keeping the newest bytes", async () => {
    const dir = makeTempDir();
    // A file limit far above anything written here, so nothing rotates and
    // every chunk is bound for the same generation.
    const transcript = open(dir, "cap", 64 * 1024 * 1024, 1, 1024 * 1024);

    let refusals = 0;
    hooks.write = (...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, written: number) => void;
      refusals += 1;
      setTimeout(() => callback(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }), 0), 0);
    };

    // 3 MiB, three times the cap. The first and last chunks carry markers so
    // it is visible which end survived.
    transcript.write(`HEAD-MARKER${"a".repeat(1024 * 1024 - 11)}`);
    transcript.write("b".repeat(1024 * 1024));
    transcript.write(`${"c".repeat(1024 * 1024 - 11)}TAIL-MARKER`);
    await sleep(400); // timer drain — the write fails

    // Non-vacuous: the fd really did refuse, so nothing left memory through
    // the file — and the admission cap shed two thirds of the 3 MiB as it
    // arrived, exactly, not approximately.
    expect(refusals).toBeGreaterThan(0);
    expect(retainedBytesOf(transcript)).toBe(1024 * 1024);

    // Oldest-first shedding, so it is the tail that survives.
    const held = heldTextOf(transcript);
    expect(held.endsWith("TAIL-MARKER")).toBe(true);
    expect(held).not.toContain("HEAD-MARKER");

    // Let the retry land, then check the accounting against the real file.
    // The backlog sits exactly at the cap, so it is flushed before the next
    // admission — otherwise that admission would shed 15 more bytes, which is
    // correct behaviour but not what this fixture is about.
    hooks.write = undefined;
    transcript.flush?.();
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
    const transcript = open(dir, "rotcap", 2 * 1024 * 1024, 1, 1024 * 1024);

    // Land a first drain so the live file has content worth not shifting away.
    transcript.write("PRECIOUS\n");
    await sleep(400);
    const file = transcriptPath(dir, "rotcap_");
    expect(readFileSync(file, "utf8")).toContain("PRECIOUS");

    hooks.write = (...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, written: number) => void;
      setTimeout(() => callback(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }), 0), 0);
    };

    // 1.5 MiB then 1 MiB against a 2 MiB file and a 1 MiB cap. The admission
    // cap sheds "a" — half on its own arrival, the rest when "b" arrives — so
    // "a" is never placed at all, and "b" is placed against what the file
    // really holds: no rotation, because the shed bytes never filled it.
    transcript.write("a".repeat(1536 * 1024));
    transcript.write("b".repeat(1024 * 1024));
    await sleep(400);

    const { owed, pending, queue } = stagesOf(transcript);
    // Non-vacuous: shedding really did happen — everything that arrived ahead
    // of "b" was dropped — and "b" alone survives, placed in the live file
    // (the write itself failed, so it is still owed).
    expect(owed.length).toBe(1024 * 1024);
    expect(pending).toEqual([]);
    expect(queue).toEqual([]);

    // Flush the at-cap backlog before the next admission — see E3.
    hooks.write = undefined;
    transcript.flush?.();
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
    const transcript = open(dir, "stale", maxFileSizeBytes, 5, 1024 * 1024);

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

    // "C", "D" and "E" push the carried-over total to 1,100,000 — over the
    // 1 MiB cap by 51,424 bytes the moment "E" is admitted.
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

    // Flush the at-cap backlog before the next admission — see E3.
    hooks.write = undefined;
    transcript.flush?.();
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
   * failure leaves a large remainder. The rotation this chunk asked for has
   * already been performed; nothing that happens afterwards — not the
   * failure, not a retry — may perform it again. At `maxRotatedFiles: 0` a
   * repeated rotation does not merely shift generations: it unlinks the live
   * file, destroying the prefix that already reached disk.
   *
   * Under the admission-time cap the remainder (1.5 MiB, well under the
   * 64 MiB default) is never shed at all — a failed write is a retry, not a
   * license to drop — so the whole chunk must land: prefix undisturbed,
   * remainder appended behind it, one rotation total.
   */
  it("does not rotate the same chunk twice when its remainder is retried after a partial failure", async () => {
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
    // The fault, expressed in bytes rather than in syscalls: exactly `partial`
    // bytes of this chunk are allowed to reach the file, however many appends
    // the writer splits it into, and the next append after that fails outright
    // — stranding a 1.5 MiB remainder. Counting calls instead would be
    // asserting how the writer chooses to slice its syscalls, which is not
    // what this test is about.
    let landed = 0;
    let refused = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.write = (...args: any[]) => {
      const [fd, data, offset, length, callback] = args;
      if (refused) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (hooks.actual!.write as any)(...args);
        return;
      }
      const room = partial - landed;
      if (room <= 0) {
        refused = true;
        setTimeout(() => callback(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }), 0), 0);
        return;
      }
      const take = Math.min(length as number, room);
      landed += take;
      hooks.actual!.write(fd, data, offset, take, callback);
    };

    transcript.write(chunk);
    await sleep(400); // timer drain: rotate once, prefix lands, resume fails

    // Non-vacuous: the rotation really happened — at maxRotatedFiles: 0 that
    // is one unlink of the live file — the prefix really is on disk, and the
    // fd really did refuse the rest.
    expect(unlinks).toBe(1);
    expect(landed).toBe(partial);
    expect(refused).toBe(true);
    const file = transcriptPath(dir, "double_");
    expect(statSync(file).size).toBe(partial);

    // The recovery drain. The remainder is bytes already owed to this very
    // file — nothing about it may rotate again, and nothing about it may be
    // shed: it is far below the cap, so it must land whole.
    transcript.flush?.();

    expect(unlinks).toBe(1); // the same logical chunk did not rotate a second time
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("PREFIX-MARKER")).toBe(true); // the prefix that reached disk was not destroyed
    expect(text.endsWith("TAIL-MARKER")).toBe(true); // the newest bytes of the remainder landed behind it
    expect(statSync(file).size).toBe(chunk.length); // the whole chunk — no byte of the remainder was shed
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

    // Same fault as F1, in bytes rather than syscalls: `partial` bytes land
    // however the writer slices its appends, then the next one fails.
    let landed = 0;
    let refused = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.write = (...args: any[]) => {
      const [fd, data, offset, length, callback] = args;
      if (refused) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (hooks.actual!.write as any)(...args);
        return;
      }
      const room = partial - landed;
      if (room <= 0) {
        refused = true;
        setTimeout(() => callback(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }), 0), 0);
        return;
      }
      const take = Math.min(length as number, room);
      landed += take;
      hooks.actual!.write(fd, data, offset, take, callback);
    };

    transcript.write(chunk);
    await sleep(400);
    // Non-vacuous: the partial write and the failure both happened.
    expect(landed).toBe(partial);
    expect(refused).toBe(true);

    transcript.flush?.();

    // The generation shifted when the chunk rotated still holds the session
    // header; retrying the remainder must not shift (and so destroy) it.
    const base = transcriptPath(dir, "keepgen_");
    expect(readFileSync(`${base}.1`, "utf8")).toContain("--- Session started");
    // And the chunk was not split across generations: prefix and remainder
    // sit together in the live file — the whole chunk, gap-free, because a
    // remainder below the cap is retried, never shed.
    const text = readFileSync(base, "utf8");
    expect(text.startsWith("PREFIX-MARKER")).toBe(true);
    expect(text.endsWith("TAIL-MARKER")).toBe(true);
    expect(text.length).toBe(chunk.length);
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
   * callback never fires (a stalled network share is the realistic case) left
   * the drain awaiting forever while terminal output piled into a queue
   * nothing was measuring. The cap is now enforced at admission, where no
   * drain has to run for it to hold; this fixture injects a 1 MiB cap to keep
   * the original arithmetic.
   */
  it("bounds what it holds while a write stays wedged forever, keeping the newest bytes", async () => {
    const dir = makeTempDir();
    // A file limit far above anything written here: nothing rotates, so this
    // is about the memory bound and nothing else.
    const transcript = open(dir, "wedgecap", 64 * 1024 * 1024, 1, 1024 * 1024);

    hooks.write = deferringWrite(Number.MAX_SAFE_INTEGER); // never calls back

    // Wedge a drain: it takes the header, hands it to fs.write, and never
    // hears back. From here on no drain can ever complete, so nothing but
    // admission-time enforcement stands between this session and the heap.
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

    // Non-vacuous: the write really never came back, so no drain ever ran
    // again, and 8 MiB really did arrive behind it.
    expect(parked).toHaveLength(1);
    expect(produced).toBeGreaterThan(8 * 1024 * 1024);

    // The bound, enforced with the drain permanently out of the picture.
    expect(shedableBytesOf(transcript)).toBeLessThanOrEqual(1024 * 1024);
    // The buffer inside the wedged syscall is exempt — the kernel owns it and
    // dropping it would free nothing — but it is a single append that cannot
    // grow, not a leak: it still holds only the pre-wedge write. It is read
    // from `inFlight` rather than `owed` because that is where an append's
    // bytes now live for the duration of the syscall; the claim is the one
    // this assertion always made.
    const { owed, inFlight } = stagesOf(transcript);
    expect(owed.length).toBe(0);
    expect(inFlight.length).toBeLessThan(1024);
    expect(heldBytesOf(transcript) + inFlight.length).toBeLessThanOrEqual(2 * 1024 * 1024);

    // Newest-first survival, the one shedding policy there is.
    const held = heldTextOf(transcript);
    expect(held.endsWith("NEWEST-MARKER")).toBe(true);
    expect(held).not.toContain("OLDEST-MARKER");

    // Nothing on the hot path blocked: no synchronous write, no open.
    expect(syncWrites).toBe(0);
    expect(opens).toBe(0);
  });

  /**
   * The hole in J2's original bound: before the first drain there used to be
   * a whole flush interval with no cap in force at all, and everything that
   * arrived in that window was then ingested wholesale, coalesced, and handed
   * to a single `fs.write` — wedge that write and the entire burst was pinned
   * *and* exempt. Admission-time enforcement closes the window by having no
   * window: the cap holds from the first byte, so what a wedged first append
   * can pin is one {@link MAX_APPEND_BYTES} batch, and what the writer holds
   * behind it is one capful — measured here at the syscall boundary, because
   * the exempt memory is whatever `fs.write` was given.
   */
  it("bounds a burst that arrived before the first drain and then wedged", async () => {
    const dir = makeTempDir();
    // Far above anything written here: this is about the memory bound, not
    // rotation.
    const transcript = open(dir, "burstcap", 64 * 1024 * 1024, 1, 1024 * 1024);

    // Record the size of every buffer handed to the kernel, and never call
    // back. Measuring the syscall argument rather than a field is the point:
    // the exempt memory is whatever `fs.write` was given.
    const appends: number[] = [];
    const park = deferringWrite(Number.MAX_SAFE_INTEGER);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.write = (...args: any[]) => {
      appends.push(args[3] as number);
      park(...args);
    };

    // 8 MiB before any drain has started. The admission cap holds throughout
    // — there is no pre-drain window where the writer holds more than one
    // capful, however early the burst arrives.
    let produced = 0;
    const produce = (text: string): void => {
      produced += Buffer.byteLength(text, "utf8");
      transcript.write(text);
    };
    produce(`OLDEST-MARKER${"o".repeat(64 * 1024)}`);
    for (let index = 0; index < 64; index += 1) {
      produce("x".repeat(128 * 1024));
    }
    produce(`${"p".repeat(64 * 1024)}PRE-DRAIN-TAIL`);

    // Non-vacuous: the burst really did arrive before anything was offered to
    // the file, and it really is many times the cap.
    expect(appends).toHaveLength(0);
    expect(produced).toBeGreaterThan(8 * 1024 * 1024);

    // The timer fires: the drain takes the whole burst on and wedges on its
    // first append.
    for (let attempt = 0; attempt < 200 && appends.length === 0; attempt += 1) {
      await sleep(5);
    }
    expect(appends).toHaveLength(1);
    // The one buffer the cap can never reclaim is one capful — not the burst.
    expect(appends[0]).toBeLessThanOrEqual(1024 * 1024);

    // Output keeps arriving while that append stays outstanding; each
    // admission re-applies the cap to everything the writer holds, with no
    // stall threshold to wait out.
    await sleep(400);
    produce(`${"n".repeat(1024 * 1024)}NEWEST-MARKER`);

    // Still wedged: not one byte has reached the file, and no second append
    // was ever attempted.
    expect(appends).toHaveLength(1);
    expect(statSync(transcriptPath(dir, "burstcap_")).size).toBe(0);

    // The bound. One capful in the writer's own stages, one capful inside the
    // syscall, and nothing else anywhere.
    expect(heldBytesOf(transcript)).toBeLessThanOrEqual(1024 * 1024);
    expect(heldBytesOf(transcript) + appends[0]).toBeLessThanOrEqual(2 * 1024 * 1024);

    // Oldest-first shedding: the burst went, the newest bytes stayed.
    const held = heldTextOf(transcript);
    expect(held.endsWith("NEWEST-MARKER")).toBe(true);
    expect(held).not.toContain("OLDEST-MARKER");
    expect(held).not.toContain("PRE-DRAIN-TAIL");
  });

  /**
   * The other half of that bound, and the property it must not buy: a backlog
   * under the cap is never shed, whatever the descriptor is doing. This runs
   * against the production default (64 MiB), because "no realistic healthy
   * burst is ever shed" is a claim about the default: 3 MiB arrives before
   * the first drain, an append parks mid-syscall with several times an
   * append-batch still committed behind it, more output lands meanwhile —
   * and every byte must reach the file in order.
   */
  it("writes a multi-batch burst in full and in order while the descriptor is healthy", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "healthy", 64 * 1024 * 1024, 1);

    let appends = 0;
    const park = deferringWrite(1); // hold the first append; the rest are real
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.write = (...args: any[]) => {
      appends += 1;
      park(...args);
    };

    // 3 MiB before the first drain.
    const burst = Array.from(
      { length: 48 },
      (_, index) => `chunk-${String(index).padStart(3, "0")}:${"=".repeat(64 * 1024)}\n`
    );
    for (const chunk of burst) {
      transcript.write(chunk);
    }

    // The drain starts and parks inside its first append.
    for (let attempt = 0; attempt < 200 && parked.length === 0; attempt += 1) {
      await sleep(5);
    }
    expect(parked).toHaveLength(1);

    // Non-vacuous: at this instant the writer is holding well over a capful in
    // the stages the cap can reach, with an append outstanding — the state
    // that decides whether splitting the append cost us the burst.
    expect(heldBytesOf(transcript)).toBeGreaterThan(1024 * 1024);

    const tail = Array.from(
      { length: 4 },
      (_, index) => `chunk-${String(48 + index).padStart(3, "0")}:${"=".repeat(64 * 1024)}\n`
    );
    for (const chunk of tail) {
      transcript.write(chunk);
    }

    // The descriptor was never broken — it was mid-syscall. Let it go.
    parked.splice(0, parked.length)[0].run();

    const file = transcriptPath(dir, "healthy_");
    const expected = [...burst, ...tail].join("");
    const last = tail[tail.length - 1];
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (readFileSync(file, "utf8").endsWith(last)) {
        break;
      }
      await sleep(20);
    }

    // Every byte, in order, with nothing shed and nothing duplicated across
    // the append boundaries.
    const body = readFileSync(file, "utf8").split("\n").slice(1).join("\n");
    expect(body).toBe(expected);
    // Non-vacuous: the burst really was split across several appends rather
    // than handed over in one.
    expect(appends).toBeGreaterThan(3);
  });

  /**
   * Arrivals behind an outstanding append are bounded like everything else:
   * the cap reads backlog, not descriptor state, so it holds identically
   * whether that append is progressing, slow, or never coming back. A chunk
   * the cap cuts in half must stay at the head of `queue` — a survivor moved
   * into any other stage would drift out of the stage its byte count is
   * tracked in, and one cut per arriving chunk would turn a slow write into
   * a slow leak.
   */
  it("holds arrivals to one capful while an append is still outstanding", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "arrivals", 64 * 1024 * 1024, 1, 1024 * 1024);
    hooks.write = deferringWrite(1);

    transcript.write("first\n");
    for (let attempt = 0; attempt < 200 && parked.length === 0; attempt += 1) {
      await sleep(5);
    }
    expect(parked).toHaveLength(1);
    // The drain took everything it had into that append, so what the writer
    // holds from here on is arrivals and nothing else.
    expect(heldBytesOf(transcript)).toBe(0);

    // 4 MiB of arrivals in two sizes, so the cap has to cut a chunk rather
    // than only drop whole ones.
    for (let index = 0; index < 40; index += 1) {
      transcript.write("L".repeat(100 * 1024));
      transcript.write(`s${"s".repeat(3 * 1024)}`);
    }

    // Non-vacuous: the append never came back, and the bound held anyway —
    // no stall clock had to expire first.
    expect(parked).toHaveLength(1);
    expect(heldBytesOf(transcript)).toBeLessThanOrEqual(1024 * 1024);

    // Newest-first survival, as everywhere else.
    expect(heldTextOf(transcript).endsWith("s".repeat(3 * 1024))).toBe(true);
  });

  /**
   * Finding 1 — the false positive in the old stall heuristic. A healthy but
   * slow `fs.write` — a busy network share taking longer than one flush
   * interval — was classified as wedged the moment arrivals pushed the writer
   * over the old 1 MiB cap, and the trim then discarded pending bytes the
   * still-active drain was going to write; a later successful callback could
   * not restore them. A latency spike silently truncated a healthy
   * transcript. There is no stall classification any more, and the cap is far
   * above any burst this fixture stages, so every byte must land.
   */
  it("loses nothing when a healthy append takes longer than a flush interval", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "slowfd", 64 * 1024 * 1024, 1); // production default cap
    hooks.write = deferringWrite(1); // first append: healthy, merely slow

    const line = (index: number): string => {
      const label = `chunk-${String(index).padStart(3, "0")}:`;
      return `${label}${"=".repeat(128 * 1024 - label.length - 1)}\n`;
    };
    // 2 MiB queued before the drain starts, so the parked append leaves a
    // full old-capful of committed bytes in `pending` behind it.
    for (let index = 0; index < 16; index += 1) {
      transcript.write(line(index));
    }
    for (let attempt = 0; attempt < 200 && parked.length === 0; attempt += 1) {
      await sleep(5);
    }
    expect(parked).toHaveLength(1);

    // The append is outstanding for well over one flush interval — the exact
    // signature the old heuristic read as "wedged" — when the next chunk
    // arrives.
    const outstandingSince = Date.now();
    await sleep(320);
    transcript.write(line(16));
    expect(Date.now() - outstandingSince).toBeGreaterThanOrEqual(250);

    // The share answers late — but it answers. Everything must land.
    parked.splice(0, parked.length)[0].run();
    transcript.flush?.();

    const file = transcriptPath(dir, "slowfd_");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (readFileSync(file, "utf8").endsWith(line(16))) {
        break;
      }
      await sleep(20);
    }
    const body = readFileSync(file, "utf8").split("\n").slice(1).join("\n");
    expect(body).toBe(Array.from({ length: 17 }, (_, index) => line(index)).join(""));
  });

  /**
   * Finding 2 — the false negative. The old heuristic re-armed its clock on
   * every `fs.write`, so a descriptor reporting a tiny positive write every
   * few milliseconds never looked stalled — while the pre-drain backlog it
   * could never catch up with sat in `pending`, beyond the reach of the
   * arrivals-only trim, at many times the stated cap, indefinitely. The cap
   * now reads backlog alone: trickling progress neither resets nor consults
   * anything, and the bound holds while the trickle genuinely proceeds.
   */
  it("stays bounded against a descriptor that accepts one byte at a time", async () => {
    const dir = makeTempDir();
    const cap = 2 * 1024 * 1024;
    const transcript = open(dir, "trickle", 64 * 1024 * 1024, 1, cap);

    // One byte really lands per call, with a callback quick enough that the
    // old stall clock re-armed every time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.write = (...args: any[]) => {
      const [fd, data, offset, , callback] = args;
      setTimeout(() => hooks.actual!.write(fd, data, offset, 1, callback), 4);
    };

    // 5 MiB before the first drain, then 1 MiB of arrivals mid-trickle.
    transcript.write(`OLDEST-MARKER${"o".repeat(128 * 1024 - 13)}`);
    for (let index = 0; index < 39; index += 1) {
      transcript.write("x".repeat(128 * 1024));
    }
    await sleep(400);
    for (let index = 0; index < 7; index += 1) {
      transcript.write("y".repeat(128 * 1024));
    }
    transcript.write(`${"n".repeat(128 * 1024 - 13)}NEWEST-MARKER`);

    // Non-vacuous: the descriptor is making real progress — this is the
    // healthy-but-hopelessly-slow case, not a wedge anyone could detect.
    const file = transcriptPath(dir, "trickle_");
    expect(statSync(file).size).toBeGreaterThan(0);
    expect(statSync(file).size).toBeLessThan(1024);

    // The bound, with the drain mid-trickle and a backlog it can never catch.
    expect(heldBytesOf(transcript)).toBeLessThanOrEqual(cap);
    expect(heldTextOf(transcript).endsWith("NEWEST-MARKER")).toBe(true);
    expect(heldTextOf(transcript)).not.toContain("OLDEST-MARKER");
  });

  /**
   * Finding 3 — enforcement that depended on future arrivals. One `write()`
   * larger than the cap was placed whole by promote(); the batch split left
   * the suffix in `owed` as a view of the original oversized allocation, and
   * if the first append wedged with no further terminal output, enqueue()
   * never ran again — so the cap was simply never applied. The cap is now
   * applied at admission, in the same synchronous step that accepts the
   * chunk, so a lone oversized chunk is bounded before any drain, callback,
   * or later arrival is involved — and the survivor is a copy, so the
   * oversized allocation itself is released.
   */
  it("bounds a lone chunk larger than the cap when nothing ever arrives after it", async () => {
    const dir = makeTempDir();
    const cap = 2 * 1024 * 1024;
    const transcript = open(dir, "lone", 64 * 1024 * 1024, 1, cap);
    await sleep(400); // header lands first, so the chunk is all the writer holds
    const file = transcriptPath(dir, "lone_");
    const preSize = statSync(file).size;

    hooks.write = deferringWrite(Number.MAX_SAFE_INTEGER); // wedge from here on

    transcript.write(`HEAD-MARKER${"x".repeat(8 * 1024 * 1024 - 22)}TAIL-MARKER`);

    // Bounded before any drain has run — admission alone did it.
    expect(heldBytesOf(transcript)).toBeLessThanOrEqual(cap);

    await sleep(400); // the drain starts and wedges on its first append
    expect(parked).toHaveLength(1);

    // No arrivals from here on, ever — the bound must hold on its own.
    const { owed, inFlight } = stagesOf(transcript);
    expect(heldBytesOf(transcript)).toBeLessThanOrEqual(cap);
    expect(inFlight.length).toBeLessThanOrEqual(1024 * 1024);
    expect(heldBytesOf(transcript) + inFlight.length).toBeLessThanOrEqual(cap + 1024 * 1024);
    // The suffix in `owed` must not pin the original 8 MiB allocation.
    expect(owed.buffer.byteLength).toBeLessThanOrEqual(cap + 16 * 1024);
    // Newest bytes survive.
    expect(heldTextOf(transcript).endsWith("TAIL-MARKER")).toBe(true);
    expect(heldTextOf(transcript)).not.toContain("HEAD-MARKER");
    // Not a byte of the chunk reached the file: the bound owes nothing to
    // the descriptor.
    expect(statSync(file).size).toBe(preSize);
  });

  /**
   * The guarantee behind goal B, in its checkable form: no byte is ever shed
   * while the writer holds no more than the cap — not for a slow append, not
   * for a failed drain, not for a wedge — so any backlog the cap can hold
   * survives a transient outage byte-for-byte. Under the old design a single
   * failed drain trimmed everything down to 1 MiB on the spot: five
   * megabytes of a six-megabyte backlog vanished because a share blinked.
   */
  it("keeps a backlog under the cap intact across a transient outage, byte for byte", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "outage", 64 * 1024 * 1024, 1); // production default cap
    await sleep(400); // header lands before the outage starts

    hooks.write = failingWrite; // every append fails, asynchronously

    const line = (index: number): string => {
      const label = `chunk-${String(index).padStart(3, "0")}:`;
      return `${label}${"=".repeat(128 * 1024 - label.length - 1)}\n`;
    };
    for (let index = 0; index < 24; index += 1) {
      transcript.write(line(index));
    }
    await sleep(400); // a drain fails against the dead share
    for (let index = 24; index < 48; index += 1) {
      transcript.write(line(index));
    }
    await sleep(400); // and another

    // Non-vacuous: 6 MiB is held right through the outage — nothing shed.
    expect(heldBytesOf(transcript)).toBe(48 * 128 * 1024);

    hooks.write = undefined; // the share comes back
    transcript.flush?.();

    const file = transcriptPath(dir, "outage_");
    const body = readFileSync(file, "utf8").split("\n").slice(1).join("\n");
    expect(body).toBe(Array.from({ length: 48 }, (_, index) => line(index)).join(""));
  });

  /**
   * The invariant itself: retained bytes never exceed the cap at any instant
   * between calls, for any arrival pattern, with no descriptor cooperation
   * required — the enforcement point is admission, so no drain, no callback
   * and no later arrival is part of the bound. Checked after every write,
   * against an independent recount of the writer's stages, entirely before
   * the first drain could possibly have run.
   */
  it("holds the cap after every single admission, for any arrival pattern", () => {
    const dir = makeTempDir();
    const cap = 2 * 1024 * 1024;
    const transcript = open(dir, "admission", 64 * 1024 * 1024, 1, cap);

    const sizes = [
      3 * 1024 * 1024, // over the cap on its own
      16,
      700 * 1024,
      1536 * 1024,
      64,
      2 * 1024 * 1024 + 1, // over the cap on its own again
      300 * 1024,
      5,
      1024 * 1024
    ];
    for (const [index, size] of sizes.entries()) {
      transcript.write(String.fromCharCode(65 + index).repeat(size));
      expect(heldBytesOf(transcript)).toBeLessThanOrEqual(cap);
    }
    // Chunks crossed the cap, so trims really ran — back to exactly the cap,
    // keeping the newest bytes.
    expect(heldBytesOf(transcript)).toBe(cap);
    expect(heldTextOf(transcript).endsWith("I".repeat(1024 * 1024))).toBe(true);
  });

  /**
   * Shedding is a function of backlog, never of descriptor state. A wedge on
   * its own sheds nothing: ten megabytes queued behind an append that will
   * never come back are all retained, because they fit the cap — the wedge
   * cannot prove they are lost, and a recovering share gets every one of
   * them. Only when the backlog itself crosses the cap does the writer shed,
   * down to exactly the cap, oldest first. Runs against the production
   * default deliberately: this pins 64 MiB as the real constant.
   */
  it("sheds nothing below the default cap under a wedge, and holds exactly at it above", async () => {
    const dir = makeTempDir();
    const transcript = open(dir, "backlog", 1024 * 1024 * 1024, 1); // rotation out of the picture

    hooks.write = deferringWrite(Number.MAX_SAFE_INTEGER); // never calls back
    transcript.write("wedge me\n");
    await sleep(400);
    expect(parked).toHaveLength(1);

    const chunk = 128 * 1024;
    transcript.write(`OLDEST-MARKER${"o".repeat(chunk - 13)}`);
    for (let index = 0; index < 79; index += 1) {
      transcript.write("x".repeat(chunk));
    }
    // 10 MiB behind a permanently wedged append: all of it retained.
    expect(heldBytesOf(transcript)).toBe(10 * 1024 * 1024);

    for (let index = 0; index < 447; index += 1) {
      transcript.write("y".repeat(chunk));
    }
    transcript.write(`${"n".repeat(chunk - 13)}NEWEST-MARKER`);
    // 66 MiB produced in total: held is now exactly the production cap.
    expect(heldBytesOf(transcript)).toBe(64 * 1024 * 1024);
    expect(heldTextOf(transcript).endsWith("NEWEST-MARKER")).toBe(true);
    expect(heldTextOf(transcript)).not.toContain("OLDEST-MARKER");
    // And none of it was bought with a blocking write: the file holds nothing.
    expect(statSync(transcriptPath(dir, "backlog_")).size).toBe(0);
  });

  /**
   * The touchiest shed there is: into `owed`, behind an append that already
   * landed part of its batch. The prefix on disk stays counted, the shed
   * shortens only what was still unwritten, and the retry resumes exactly
   * where the descriptor left off — prefix, gap, newest bytes, with the
   * accounting still matching the file exactly.
   */
  it("resumes cleanly after the cap sheds the head of a partially landed remainder", async () => {
    const dir = makeTempDir();
    const cap = 2 * 1024 * 1024;
    const transcript = open(dir, "gapfile", 64 * 1024 * 1024, 1, cap);
    await sleep(400); // header lands
    const file = transcriptPath(dir, "gapfile_");
    const headerBytes = statSync(file).size;

    // 600 KiB of the first batch lands for real; everything after fails.
    let landed = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.write = (...args: any[]) => {
      const [fd, data, offset, , callback] = args;
      if (landed === 0) {
        landed = 600 * 1024;
        hooks.actual!.write(fd, data, offset, landed, callback);
        return;
      }
      setTimeout(() => callback(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }), 0), 0);
    };

    transcript.write(`${"A".repeat(1024 * 1024)}${"B".repeat(1024 * 1024)}`);
    await sleep(400);

    // 600 KiB of "A" is on disk; the rest of the chunk is owed.
    expect(statSync(file).size).toBe(headerBytes + 600 * 1024);
    expect(stagesOf(transcript).owed.length).toBe(2 * 1024 * 1024 - 600 * 1024);

    // The arrival that crosses the cap sheds the oldest unwritten bytes —
    // the tail of "A" and the head of "B" — never the prefix already on disk.
    transcript.write("Z".repeat(1536 * 1024));
    expect(stagesOf(transcript).owed.length).toBe(512 * 1024);

    hooks.write = undefined;
    transcript.flush?.();

    const text = readFileSync(file, "utf8");
    expect(text.slice(headerBytes)).toBe(
      `${"A".repeat(600 * 1024)}${"B".repeat(512 * 1024)}${"Z".repeat(1536 * 1024)}`
    );
    const currentSize = (transcript as unknown as { currentSize: number }).currentSize;
    expect(currentSize).toBe(statSync(file).size);
    expect(readdirSync(dir).filter((entry) => /\.log\.\d+$/.test(entry))).toEqual([]);
  });
});
