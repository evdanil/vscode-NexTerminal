import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalLoggerFactory } from "../../src/logging/terminalLogger";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nexus-logger-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TerminalLoggerFactory", () => {
  it("rotates logs when max size is exceeded", () => {
    const dir = makeTempDir();
    const factory = new TerminalLoggerFactory(dir, {
      maxFileSizeBytes: 80,
      maxRotatedFiles: 1
    });
    const logger = factory.create("terminal", "server-a");

    logger.log("line 1 1234567890");
    logger.log("line 2 1234567890");
    logger.log("line 3 1234567890");
    logger.close();

    const base = path.join(dir, "terminal-server-a.log");
    const rotated = path.join(dir, "terminal-server-a.log.1");
    expect(existsSync(base)).toBe(true);
    expect(existsSync(rotated)).toBe(true);
    expect(readFileSync(base, "utf8").length).toBeGreaterThan(0);
    expect(readFileSync(rotated, "utf8").length).toBeGreaterThan(0);
  });

  it("does not keep rotated files when maxRotatedFiles is zero", () => {
    const dir = makeTempDir();
    const factory = new TerminalLoggerFactory(dir, {
      maxFileSizeBytes: 70,
      maxRotatedFiles: 0
    });
    const logger = factory.create("tunnel", "profile-a");

    logger.log("line a 1234567890");
    logger.log("line b 1234567890");
    logger.log("line c 1234567890");
    logger.close();

    const files = readdirSync(dir).filter((name) => name.startsWith("tunnel-profile-a.log."));
    expect(files).toHaveLength(0);
  });
});
