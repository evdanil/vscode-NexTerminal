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

  /**
   * The per-chunk data trace runs once per received chunk and each call is a
   * synchronous writeSync, so it is opt-in. It also persists session data —
   * echoed passwords included — as plaintext, which is the other half of why
   * it defaults to off.
   */
  describe("per-chunk output trace (nexus.logging.terminalOutputTrace)", () => {
    it("writes no data-trace line when the trace is off, while lifecycle lines still land", () => {
      const dir = makeTempDir();
      const factory = new TerminalLoggerFactory(dir, { maxFileSizeBytes: 1024 * 1024, maxRotatedFiles: 1 });
      const logger = factory.create("terminal", "trace-off");

      logger.log("connected to router-1");
      logger.logOutput?.(`stdout ${JSON.stringify("secret-password\r\n")}`);
      logger.log("terminal closed");
      logger.close();

      const contents = readFileSync(path.join(dir, "terminal-trace-off.log"), "utf8");
      expect(contents).toContain("connected to router-1");
      expect(contents).toContain("terminal closed");
      expect(contents).not.toContain("stdout ");
      expect(contents).not.toContain("secret-password");
    });

    it("defaults to off when no provider is supplied at all", () => {
      const dir = makeTempDir();
      const factory = new TerminalLoggerFactory(dir);
      const logger = factory.create("terminal", "trace-default");

      logger.logOutput?.('stdout "hello"');
      logger.close();

      expect(readFileSync(path.join(dir, "terminal-trace-default.log"), "utf8")).not.toContain("stdout");
    });

    it("writes the trace in the same format as any other log line when it is on", () => {
      const dir = makeTempDir();
      const factory = new TerminalLoggerFactory(
        dir,
        { maxFileSizeBytes: 1024 * 1024, maxRotatedFiles: 1 },
        () => true
      );
      const logger = factory.create("terminal", "trace-on");

      logger.logOutput?.(`stdout ${JSON.stringify("hello\r\n")}`);
      logger.close();

      const line = readFileSync(path.join(dir, "terminal-trace-on.log"), "utf8").trimEnd();
      // <ISO timestamp> stdout "hello\r\n" — byte-identical to the unconditional
      // logger.log() call this replaced.
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z stdout "hello\\r\\n"$/);
    });

    it("follows the provider when the setting is toggled on an already-open session", () => {
      const dir = makeTempDir();
      let enabled = false;
      const factory = new TerminalLoggerFactory(
        dir,
        { maxFileSizeBytes: 1024 * 1024, maxRotatedFiles: 1 },
        () => enabled
      );
      const logger = factory.create("terminal", "trace-toggle");

      logger.logOutput?.("stdout before");
      enabled = true;
      logger.logOutput?.("stdout after");
      logger.close();

      const contents = readFileSync(path.join(dir, "terminal-trace-toggle.log"), "utf8");
      expect(contents).not.toContain("stdout before");
      expect(contents).toContain("stdout after");
    });
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
