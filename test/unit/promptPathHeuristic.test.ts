import { describe, expect, it } from "vitest";
import { extractPromptPath, extractLatestPromptPath } from "../../src/services/terminal/promptPathHeuristic";

describe("extractPromptPath", () => {
  const HOME = "/home/dev";

  // ─── Debian/Ubuntu default \u@\h:\w\$ ───────────────────────────────────

  it("extracts an absolute path from the Debian/Ubuntu default prompt", () => {
    expect(extractPromptPath("dev@myhost:/var/log$ ", HOME)).toBe("/var/log");
  });

  it("works with no trailing space after the terminator", () => {
    expect(extractPromptPath("dev@myhost:/var/log$", HOME)).toBe("/var/log");
  });

  it("expands a bare ~ against homeDir", () => {
    expect(extractPromptPath("dev@myhost:~$ ", HOME)).toBe("/home/dev");
  });

  it("expands a ~/relative path against homeDir", () => {
    expect(extractPromptPath("dev@myhost:~/work$ ", HOME)).toBe("/home/dev/work");
  });

  it("handles homeDir with a trailing slash without a doubled slash", () => {
    expect(extractPromptPath("dev@myhost:~/work$ ", "/home/dev/")).toBe("/home/dev/work");
  });

  it("recognises root's # terminator", () => {
    expect(extractPromptPath("root@myhost:/etc# ", HOME)).toBe("/etc");
  });

  it("recognises root's # terminator with ~ expansion", () => {
    expect(extractPromptPath("root@myhost:~# ", "/root")).toBe("/root");
  });

  // ─── ~ with unknown home dir ────────────────────────────────────────────

  it("returns undefined for a ~-relative prompt when homeDir is unknown", () => {
    expect(extractPromptPath("dev@myhost:~/work$ ", undefined)).toBeUndefined();
  });

  it("returns undefined for a bare ~ prompt when homeDir is unknown", () => {
    expect(extractPromptPath("dev@myhost:~$ ", undefined)).toBeUndefined();
  });

  // ─── Fedora/RHEL bracketed \W form — basename only, not resolvable ─────

  it("returns undefined for the bracketed Fedora/RHEL prompt (\\W is a basename only)", () => {
    expect(extractPromptPath("[dev@myhost log]$ ", HOME)).toBeUndefined();
  });

  it("returns undefined for the bracketed root prompt too", () => {
    expect(extractPromptPath("[root@myhost etc]# ", HOME)).toBeUndefined();
  });

  // ─── No-candidate cases ─────────────────────────────────────────────────

  it("returns undefined for a line with no recognisable prompt shape", () => {
    expect(extractPromptPath("just some regular output", HOME)).toBeUndefined();
  });

  it("returns undefined for an empty line", () => {
    expect(extractPromptPath("", HOME)).toBeUndefined();
  });

  it("returns undefined when the user is mid-typing a command after the prompt", () => {
    expect(extractPromptPath("dev@myhost:/var/log$ ls -la", HOME)).toBeUndefined();
  });

  it("never throws on a pathological line", () => {
    expect(() => extractPromptPath("\x00\x1b[31m@:$".repeat(50), HOME)).not.toThrow();
  });
});

describe("extractLatestPromptPath", () => {
  const HOME = "/home/dev";

  it("finds the most recent bare-prompt line in a multi-line blob", () => {
    const blob = ["dev@myhost:/var/log$ ", "dev@myhost:/etc$ ls", "dev@myhost:/etc$ "].join("\n");
    expect(extractLatestPromptPath(blob, HOME)).toBe("/etc");
  });

  it("skips a trailing in-progress command line and falls back to the prior bare prompt", () => {
    const blob = ["dev@myhost:/opt$ ", "dev@myhost:/opt/app$ tail -f log"].join("\n");
    expect(extractLatestPromptPath(blob, HOME)).toBe("/opt");
  });

  it("returns undefined when no line in the blob is a recognisable bare prompt", () => {
    const blob = ["some output", "more output", "dev@myhost:/opt$ tail -f log"].join("\n");
    expect(extractLatestPromptPath(blob, HOME)).toBeUndefined();
  });

  it("returns undefined for an empty blob", () => {
    expect(extractLatestPromptPath("", HOME)).toBeUndefined();
  });
});
