import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTranscript, type SessionTranscript } from "../../src/logging/sessionTranscriptLogger";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nexus-transcript-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createSessionTranscript", () => {
  it("releases a reserved filename if initialization fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = makeTempDir();
    const transcript = createSessionTranscript(dir, "failed", true, {
      pathTemplate: "failed.log",
      get maxFileSizeBytes(): number { throw new Error("initialization failed"); }
    });
    transcript.write("discarded");
    transcript.close();
    expect(readdirSync(path.join(dir, ".nexus-transcript-reservations"))).toHaveLength(0);
    expect(readFileSync(path.join(dir, "failed.log"), "utf8")).toBe("");
  });

  it("writes a nested template with endpoint context and releases its reservation on close", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 9, 8, 7, 6));
    const dir = makeTempDir();
    const transcript = createSessionTranscript(dir, "Switch1", true, {
      pathTemplate: "%G/%S/%H-%P-%Y-%M-%D-%h-%m-%s-%t.log",
      pathContext: { group: "Canada/Core", host: "switch.example", port: 22 }, timestampMode: "off"
    });
    const markerDir = path.join(dir, ".nexus-transcript-reservations");
    const log = path.join(dir, "Canada/Core/Switch1/switch.example-22-2026-11-03-09-08-07-006.log");
    transcript.write("first\n");
    transcript.flush?.();
    expect(readFileSync(log, "utf8")).toContain("first\n");
    expect(readdirSync(markerDir)).toHaveLength(1);
    transcript.close();
    expect(readdirSync(markerDir)).toHaveLength(0);
  });

  it("keeps simultaneous static-template sessions separate", () => {
    const dir = makeTempDir();
    const first = createSessionTranscript(dir, "one", true, { pathTemplate: "capture.log", timestampMode: "off" });
    const second = createSessionTranscript(dir, "two", true, { pathTemplate: "capture.log", timestampMode: "off" });
    first.write("FIRST ONLY\n");
    second.write("SECOND ONLY\n");
    first.close();
    second.close();
    expect(readFileSync(path.join(dir, "capture.log"), "utf8")).toContain("FIRST ONLY");
    expect(readFileSync(path.join(dir, "capture.log"), "utf8")).not.toContain("SECOND ONLY");
    expect(readFileSync(path.join(dir, "capture-2.log"), "utf8")).toContain("SECOND ONLY");
    expect(readFileSync(path.join(dir, "capture-2.log"), "utf8")).not.toContain("FIRST ONLY");
  });

  it("falls back to automatic names for invalid runtime templates without losing output", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = makeTempDir();
    const transcript = createSessionTranscript(dir, "fallback", true, { pathTemplate: "../escape.log" });
    transcript.write("kept\n");
    transcript.close();
    const file = readdirSync(dir).find((name) => /^fallback_.*\.log$/.test(name))!;
    expect(readFileSync(path.join(dir, file), "utf8")).toContain("kept\n");
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/nexus\.logging\.sessionLogPathTemplate.*automatic filename/));
  });

  function recordedOutput(dir: string): string {
    const file = readdirSync(dir).find((name) => name.endsWith(".log"))!;
    const contents = readFileSync(path.join(dir, file), "utf8");
    return contents.slice(contents.indexOf("\n") + 1, contents.lastIndexOf("\n--- Session ended "));
  }

  it.each([
    { offset: -330, suffix: "+05:30" },
    { offset: 210, suffix: "-03:30" }
  ])("defaults to local timestamps with a numeric $suffix offset", ({ offset, suffix }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2025, 0, 15, 9, 0, 12, 345));
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(offset);
    const dir = makeTempDir();
    const transcript = createSessionTranscript(dir, "local", true);
    transcript.write("ERROR\n");
    transcript.close();
    expect(recordedOutput(dir)).toBe(`2025-01-15 09:00:12.345${suffix} ERROR\n`);
  });

  it("timestamps each logical line at receipt, preserving split lines, blank lines and CRLF", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2025-01-15T09:00:12.345Z"));
    const dir = makeTempDir();
    const transcript = createSessionTranscript(dir, "utc", true, { timestampMode: "utc" });
    transcript.write("\x1b[31mfirst");
    vi.setSystemTime(new Date("2025-01-15T09:00:13.000Z"));
    transcript.flush?.();
    transcript.write(" part\r");
    vi.setSystemTime(new Date("2025-01-15T09:01:45.678Z"));
    transcript.write("\n\nthird\rprogress\n\x1b[0m");
    vi.setSystemTime(new Date("2025-01-15T10:00:00Z"));
    transcript.close();
    expect(recordedOutput(dir)).toBe(
      "2025-01-15 09:00:12.345Z first part\r\n" +
      "2025-01-15 09:01:45.678Z \n" +
      "2025-01-15 09:01:45.678Z third\r" +
      "2025-01-15 09:01:45.678Z progress\n"
    );
  });

  it("waits for visible output after ANSI-only chunks and preserves line state across reconnect", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2025-01-15T09:00:00Z"));
    const dir = makeTempDir();
    const transcript = createSessionTranscript(dir, "ansi", true, { timestampMode: "utc" });
    transcript.write("\x1b[31m");
    vi.setSystemTime(new Date("2025-01-15T09:00:01Z"));
    transcript.write("prompt\x1b]unfinished");
    transcript.resetEscapeState?.();
    vi.setSystemTime(new Date("2025-01-15T09:00:02Z"));
    transcript.write(": \nnext");
    transcript.close();
    expect(recordedOutput(dir)).toBe(
      "2025-01-15 09:00:01.000Z prompt: \n2025-01-15 09:00:02.000Z next"
    );
  });

  it("Off preserves cleaned transcript bytes without per-line timestamps", () => {
    const dir = makeTempDir();
    const transcript = createSessionTranscript(dir, "off", true, { timestampMode: "off" });
    transcript.write("\x1b[31mfirst\r");
    transcript.write("\n\nsecond\rprogress\n\x1b[0m");
    transcript.close();
    expect(recordedOutput(dir)).toBe("first\r\n\nsecond\rprogress\n");
  });

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

  it("strips an escape sequence split across writes", () => {
    const dir = makeTempDir();
    const transcript = createSessionTranscript(dir, "split", true);
    transcript.write("a\x1b[>4;");
    transcript.write("2mb\x1b]0;user@host: ~");
    transcript.write("\x07c\n");
    transcript.close();
    const base = readdirSync(dir).find((name) => /^split_.*\.log$/.test(name))!;
    const body = readFileSync(path.join(dir, base), "utf8");
    expect(body).toContain("abc\n");
    expect(body).not.toContain("[>");
    expect(body).not.toContain("2m");
    expect(body).not.toContain("user@host");
  });

  it("drops a DCS payload longer than the hold cap split across writes", () => {
    const dir = makeTempDir();
    const transcript = createSessionTranscript(dir, "dcs", true);
    const payload = "q" + "#0;2;0;0;0".repeat(50);
    transcript.write("a\x1bP" + payload);
    transcript.write(payload);
    transcript.write("\x1b\\b\n");
    transcript.close();
    const base = readdirSync(dir).find((name) => /^dcs_.*\.log$/.test(name))!;
    const body = readFileSync(path.join(dir, base), "utf8");
    expect(body).toContain("ab\n");
    expect(body).not.toContain("#0;2");
  });

  it("resetEscapeState drops an unterminated string so the next write is kept", () => {
    const dir = makeTempDir();
    const transcript = createSessionTranscript(dir, "reset", true);
    transcript.write("a\x1bPpayload");
    transcript.resetEscapeState?.();
    transcript.write("Password: \n");
    transcript.close();
    const base = readdirSync(dir).find((name) => /^reset_.*\.log$/.test(name))!;
    expect(readFileSync(path.join(dir, base), "utf8")).toContain("aPassword: \n");
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
      // This fixture compares byte-for-byte rotation, independently of clock time.
      const rotation = { maxFileSizeBytes: 300, maxRotatedFiles: 3, timestampMode: "off" as const };

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

      // The line reaches the file only after the 250 ms flush timer has fired
      // and the async fs.write it starts has come back. A fixed sleep can end
      // before both have happened on a loaded host, so poll the file instead.
      // Nothing here flushes or closes the writer, so a writer without its own
      // timer never writes the line and this still fails.
      await vi.waitFor(() => expect(transcriptFiles(dir, "timer_").base).toContain("timed line"), { timeout: 4_000 });
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
