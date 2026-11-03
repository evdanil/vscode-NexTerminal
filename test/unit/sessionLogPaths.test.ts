import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTranscriptPathTemplate, validateTranscriptPathTemplate } from "../../src/logging/transcriptPathTemplate";
import { reserveTranscriptFile, resolveSessionLogDirectory } from "../../src/logging/sessionLogPaths";

const dirs: string[] = [];
const reservations: Array<ReturnType<typeof reserveTranscriptFile>> = [];
function temp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nexus-log-path-"));
  dirs.push(dir);
  return dir;
}
function reserve(root: string, relative: string): ReturnType<typeof reserveTranscriptFile> {
  const file = reserveTranscriptFile(root, relative);
  reservations.push(file);
  return file;
}
afterEach(() => {
  for (const file of reservations.splice(0)) {
    closeSync(file.fd);
    file.release();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const date = new Date(2026, 10, 3, 9, 8, 7, 6);
const context = { sessionName: "Switch1", host: "switch.example", port: 22, group: "Canada/Core" };

describe("transcript path templates", () => {
  it("expands all named tokens using one local creation time", () => {
    expect(renderTranscriptPathTemplate("%G/%S/%H-%P-%Y-%M-%D-%h-%m-%s-%t-%%.log", context, date, {}))
      .toBe("Canada/Core/Switch1/switch.example-22-2026-11-03-09-08-07-006-%.log");
  });

  it("distinguishes adjacent short tokens, environment tokens and escaped percent without recursion", () => {
    expect(renderTranscriptPathTemplate("%S%Y/%HOME%/%%HOME%%/%M%S.log", context, date, { HOME: "%S" }))
      .toBe("Switch12026/%S/%HOME%/11Switch1.log");
  });

  it("removes an empty group folder and uses honest missing-endpoint placeholders", () => {
    expect(renderTranscriptPathTemplate("%G/%S-%H-%P.log", { sessionName: "USB" }, date, {}))
      .toBe("USB-unknown-host-auto.log");
  });

  it("sanitizes endpoint, group and environment values as data while preserving readable Unicode", () => {
    expect(renderTranscriptPathTemplate("%G/%S-%H-%P-%LOCATION%.log", {
      sessionName: "CON", host: "fe80::1/../../host\n", port: "/dev/ttyUSB0", group: "../Canada/..\\日本"
    }, date, { LOCATION: "../../US" })).toBe("_/Canada/_/日本/_CON-fe80__1_.._.._host_-_dev_ttyUSB0-.._.._US.log");
  });

  it.each(["../%S.log", "/root/%S.log", "C:\\logs\\%S.log", "\\\\server\\share\\%S.log", "%S/../x.log", "%S.log/", "%S.txt", "%X.log", "x%.log", "bad\n.log", "CON.log", "bad?/x.log"])("rejects unsafe or malformed template %s", (template) => {
    expect(validateTranscriptPathTemplate(template)).toBeTypeOf("string");
    expect(() => renderTranscriptPathTemplate(template, context, date, {})).toThrow();
  });

  it("accepts empty default and valid templates without consulting this machine's environment", () => {
    expect(validateTranscriptPathTemplate("")).toBeUndefined();
    expect(validateTranscriptPathTemplate("%G/%COMPUTERNAME%/%S.log")).toBeUndefined();
    expect(validateTranscriptPathTemplate("%S.LOG")).toBeUndefined();
  });

  it("reports a missing environment variable by name", () => {
    expect(() => renderTranscriptPathTemplate("%MISSING%/%S.log", context, date, {})).toThrow(/MISSING/);
    expect(() => renderTranscriptPathTemplate("%EMPTY%/%S.log", context, date, { EMPTY: "" })).toThrow(/EMPTY/);
    expect(() => renderTranscriptPathTemplate("%toString%/%S.log", context, date, {})).toThrow(/toString.*missing/);
  });

  it("bounds substituted names without cutting a Unicode code point", () => {
    const result = renderTranscriptPathTemplate("%S.log", { sessionName: "🛰️".repeat(200) }, date, {});
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(124);
    expect(result).not.toContain("\ufffd");
    expect(validateTranscriptPathTemplate(`${"a".repeat(241)}.log`)).toBeTypeOf("string");
  });
});

describe("session log root", () => {
  it("expands environment roots and escaped percent once", () => {
    expect(resolveSessionLogDirectory("%ROOT%/%%archive", "/fallback", { ROOT: "/chosen/%literal%" }))
      .toBe(path.resolve("/chosen/%literal%/%archive"));
    expect(resolveSessionLogDirectory("", "/fallback", {})).toBe("/fallback");
  });

  it("falls back to the same default root with an actionable setting diagnostic", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveSessionLogDirectory("%MISSING%/logs", "/fallback", {})).toBe("/fallback");
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/nexus\.logging\.sessionLogDirectory.*MISSING/));
  });
});

describe("transcript filename reservations", () => {
  it("creates nested directories and keeps simultaneous static names separate", () => {
    const root = temp();
    const first = reserve(root, "Canada/Switch1/capture.log");
    const second = reserve(root, "Canada/Switch1/capture.log");
    expect(first.filepath).toBe(path.join(realpathSync(root), "Canada/Switch1/capture.log"));
    expect(second.filepath).toBe(path.join(realpathSync(root), "Canada/Switch1/capture-2.log"));
    writeFileSync(first.fd, "first");
    writeFileSync(second.fd, "second");
    expect(readFileSync(first.filepath, "utf8")).toBe("first");
    expect(readFileSync(second.filepath, "utf8")).toBe("second");
  });

  it("protects old rotated generations even when the base file is missing", () => {
    const root = temp();
    writeFileSync(path.join(root, "capture.log.99"), "other session");
    const file = reserve(root, "capture.log");
    expect(path.basename(file.filepath)).toBe("capture-2.log");
    expect(readFileSync(path.join(root, "capture.log.99"), "utf8")).toBe("other session");
  });

  it("holds the family reservation while rotation temporarily removes the live basename", () => {
    const root = temp();
    const first = reserve(root, "capture.log");
    rmSync(first.filepath);
    const second = reserve(root, "capture.log");
    expect(path.basename(second.filepath)).toBe("capture-2.log");
    expect(readdirSync(path.join(root, ".nexus-transcript-reservations"))).toHaveLength(2);
    first.release();
    first.release();
    expect(readdirSync(path.join(root, ".nexus-transcript-reservations"))).toHaveLength(1);
  });

  it("treats case-equivalent names conservatively while a session is active", () => {
    const root = temp();
    reserve(root, "capture.log");
    const other = reserve(root, "CAPTURE.LOG");
    expect(path.basename(other.filepath)).toBe("CAPTURE-2.LOG");
  });

  it("refuses traversal and symlink subfolders before creating directories outside the root", () => {
    const root = temp();
    const outside = temp();
    symlinkSync(outside, path.join(root, "link"), "junction");
    expect(() => reserve(root, "../escape.log")).toThrow();
    expect(() => reserve(root, "link/new/capture.log")).toThrow();
    expect(existsSync(path.join(outside, "new"))).toBe(false);
    mkdirSync(path.join(outside, "target"));
    symlinkSync(path.join(outside, "target"), path.join(root, "capture.log"), "junction");
    expect(path.basename(reserve(root, "capture.log").filepath)).toBe("capture-2.log");
  });
});
