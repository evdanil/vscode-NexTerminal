import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionTranscript } from "../../src/logging/sessionTranscriptLogger";

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
