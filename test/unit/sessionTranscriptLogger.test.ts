import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionTranscript, type SessionTranscript } from "../../src/logging/sessionTranscriptLogger";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nexus-transcript-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createSessionTranscript", () => {
  it("rotates session transcripts using the configured size and file count", () => {
    const dir = makeTempDir();
    const transcript = createSessionTranscript(dir, "router", true, {
      maxFileSizeBytes: 120,
      maxRotatedFiles: 1
    });

    transcript.write("line 1 1234567890\n");
    transcript.write("line 2 1234567890\n");
    transcript.write("line 3 1234567890\n");
    transcript.write("line 4 1234567890\n");
    transcript.close();

    const base = readdirSync(dir).find((name) => /^router_.*\.log$/.test(name));
    expect(base).toBeDefined();
    expect(existsSync(path.join(dir, `${base}.1`))).toBe(true);
    expect(readFileSync(path.join(dir, base!), "utf8").length).toBeGreaterThan(0);
    expect(readFileSync(path.join(dir, `${base}.1`), "utf8").length).toBeGreaterThan(0);
  });

  /**
   * The writer queues chunks and drains them asynchronously instead of doing a
   * blocking writeSync per chunk. What must not change: what ends up on disk,
   * the order it is in, and where rotation cuts the file.
   */
  describe("buffered writes", () => {
    function transcriptFiles(dir: string, prefix: string): { base: string; rotated: string[] } {
      const names = readdirSync(dir).filter((name) => name.startsWith(prefix));
      const base = names.find((name) => /\.log$/.test(name));
      if (!base) throw new Error(`no transcript file found in ${dir}`);
      return {
        base: readFileSync(path.join(dir, base), "utf8"),
        rotated: names
          .filter((name) => /\.log\.\d+$/.test(name))
          .sort()
          .map((name) => readFileSync(path.join(dir, name), "utf8"))
      };
    }

    function stripSessionMarkers(text: string): string {
      return text
        .split("\n")
        .filter((line) => !line.startsWith("--- Session "))
        .join("\n");
    }

    it("writes the same bytes, in the same order, on the same side of a rotation boundary", async () => {
      const chunks = Array.from({ length: 40 }, (_, i) => `chunk-${String(i).padStart(3, "0")} payload\n`);
      const rotation = { maxFileSizeBytes: 300, maxRotatedFiles: 3 };

      // Reference: force a drain after every single chunk, which is exactly
      // what the old synchronous writer did.
      const syncDir = makeTempDir();
      const reference = createSessionTranscript(syncDir, "ref", true, rotation);
      for (const chunk of chunks) {
        reference.write(chunk);
        reference.flush?.();
      }
      reference.close();

      // Buffered: everything queued, drained by close() / the timer.
      const bufferedDir = makeTempDir();
      const buffered = createSessionTranscript(bufferedDir, "ref", true, rotation);
      for (const chunk of chunks) {
        buffered.write(chunk);
      }
      buffered.close();

      const a = transcriptFiles(syncDir, "ref_");
      const b = transcriptFiles(bufferedDir, "ref_");
      expect(stripSessionMarkers(b.base)).toBe(stripSessionMarkers(a.base));
      expect(b.rotated.map(stripSessionMarkers)).toEqual(a.rotated.map(stripSessionMarkers));

      // Non-vacuous: this fixture really does rotate, and the chunks that
      // survive rotation are still contiguous and in order across the boundary,
      // ending at the last one written.
      expect(b.rotated.length).toBeGreaterThan(0);
      // `.log.3` is the oldest generation and `.log.1` the newest, so read the
      // rotated files in reverse before the live file.
      const everything = [...b.rotated].reverse().concat(b.base).join("");
      const order = [...everything.matchAll(/chunk-(\d{3})/g)].map((m) => Number(m[1]));
      expect(order.length).toBeGreaterThan(5);
      expect(order[order.length - 1]).toBe(chunks.length - 1);
      expect(order).toEqual(order.map((_, i) => order[0] + i));
    });

    it("close() writes everything still queued", () => {
      const dir = makeTempDir();
      const transcript = createSessionTranscript(dir, "closer", true, {
        maxFileSizeBytes: 1024 * 1024,
        maxRotatedFiles: 1
      });

      transcript.write("queued line 1\n");
      transcript.write("queued line 2\n");
      // Nothing has been drained yet — no timer has fired.
      transcript.close();

      const contents = transcriptFiles(dir, "closer_").base;
      expect(contents).toContain("queued line 1");
      expect(contents).toContain("queued line 2");
      expect(contents).toContain("--- Session ended");
      expect(contents.indexOf("queued line 1")).toBeLessThan(contents.indexOf("queued line 2"));
      expect(contents.indexOf("queued line 2")).toBeLessThan(contents.indexOf("--- Session ended"));
    });

    it("flush() writes everything still queued and leaves the transcript usable", () => {
      const dir = makeTempDir();
      const transcript: SessionTranscript = createSessionTranscript(dir, "flusher", true, {
        maxFileSizeBytes: 1024 * 1024,
        maxRotatedFiles: 1
      });

      transcript.write("before disconnect\n");
      transcript.flush?.();

      // Readable on disk without the session having been closed — this is the
      // disconnect / extension-deactivate path.
      expect(transcriptFiles(dir, "flusher_").base).toContain("before disconnect");

      transcript.write("after disconnect\n");
      transcript.close();
      const contents = transcriptFiles(dir, "flusher_").base;
      expect(contents).toContain("after disconnect");
      expect(contents.indexOf("before disconnect")).toBeLessThan(contents.indexOf("after disconnect"));
    });

    it("drains on its own timer without an explicit flush", async () => {
      const dir = makeTempDir();
      const transcript = createSessionTranscript(dir, "timer", true, {
        maxFileSizeBytes: 1024 * 1024,
        maxRotatedFiles: 1
      });

      transcript.write("timed line\n");
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(transcriptFiles(dir, "timer_").base).toContain("timed line");
      transcript.close();
    });

    it("does not write anything after close()", async () => {
      const dir = makeTempDir();
      const transcript = createSessionTranscript(dir, "afterclose", true, {
        maxFileSizeBytes: 1024 * 1024,
        maxRotatedFiles: 1
      });

      transcript.write("kept\n");
      transcript.close();
      transcript.write("dropped\n");
      transcript.flush?.();
      await new Promise((resolve) => setTimeout(resolve, 400));

      const contents = transcriptFiles(dir, "afterclose_").base;
      expect(contents).toContain("kept");
      expect(contents).not.toContain("dropped");
    });
  });

  it("does not retain rotated transcript files when the configured count is zero", () => {
    const dir = makeTempDir();
    const transcript = createSessionTranscript(dir, "console", true, {
      maxFileSizeBytes: 100,
      maxRotatedFiles: 0
    });

    transcript.write("line a 1234567890\n");
    transcript.write("line b 1234567890\n");
    transcript.write("line c 1234567890\n");
    transcript.write("line d 1234567890\n");
    transcript.close();

    const rotated = readdirSync(dir).filter((name) => /^console_.*\.log\.\d+$/.test(name));
    expect(rotated).toHaveLength(0);
  });
});
