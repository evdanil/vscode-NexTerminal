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
  writeSync: undefined as undefined | ((...args: any[]) => number)
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  hooks.actual = actual;
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    write: (...args: any[]) => (hooks.write ?? (actual.write as any))(...args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeSync: (...args: any[]) => (hooks.writeSync ?? (actual.writeSync as any))(...args)
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

/** Base file plus every rotated generation, concatenated oldest-first. */
function allTranscriptText(dir: string, prefix: string): string {
  const names = readdirSync(dir).filter((entry) => entry.startsWith(prefix));
  const base = names.find((entry) => entry.endsWith(".log"));
  const rotated = names.filter((entry) => /\.log\.\d+$/.test(entry)).sort().reverse();
  return [...rotated, base!].map((entry) => readFileSync(path.join(dir, entry), "utf8")).join("");
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
