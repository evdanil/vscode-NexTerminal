import { describe, expect, it, beforeEach } from "vitest";
import { Osc7Parser } from "../../src/services/terminal/osc7Parser";

// Helpers — cloned from oscContextFilter.test.ts's shape.
const ESC = "\x1b";
const BEL = "\x07";
const ST = "\x1b\\"; // ESC backslash
const OPEN = `${ESC}]7;`;

function make7(payload: string, terminator: "st" | "bel" = "st"): string {
  return `${OPEN}${payload}${terminator === "bel" ? BEL : ST}`;
}

describe("Osc7Parser", () => {
  let parser: Osc7Parser;

  beforeEach(() => {
    parser = new Osc7Parser();
  });

  // ─── Terminators ────────────────────────────────────────────────────────

  it("extracts a file:// URI terminated by BEL", () => {
    const seq = make7("file:///tmp", "bel");
    expect(parser.feed(`prompt> ${seq}`)).toEqual([{ path: "/tmp", authority: "" }]);
  });

  it("extracts a file:// URI terminated by ESC \\", () => {
    const seq = make7("file:///var/log", "st");
    expect(parser.feed(seq)).toEqual([{ path: "/var/log", authority: "" }]);
  });

  // ─── Chunk-boundary splits ──────────────────────────────────────────────

  it("handles a sequence split across chunk boundaries", () => {
    const full = make7("file://myhost/home/user");
    const mid = Math.floor(full.length / 2);
    const m1 = parser.feed(full.slice(0, mid));
    const m2 = parser.feed(full.slice(mid));
    expect(m1).toEqual([]);
    expect(m2).toEqual([{ path: "/home/user", authority: "myhost" }]);
  });

  it("handles a split mid-URI", () => {
    const full = make7("file:///var/log/syslog");
    const idx = full.indexOf("/log");
    const m1 = parser.feed(full.slice(0, idx));
    const m2 = parser.feed(full.slice(idx));
    expect([...m1, ...m2]).toEqual([{ path: "/var/log/syslog", authority: "" }]);
  });

  it("a chunk ending in ESC ] does not corrupt a following OSC 7 split at that boundary", () => {
    // "\x1b]" (the first two bytes of OPEN) is a genuine prefix of "\x1b]7;",
    // so it must be held in carry and reassembled correctly.
    const full = make7("file:///etc/hosts", "bel");
    const c1 = full.slice(0, 2); // "\x1b]"
    const c2 = full.slice(2);
    const m1 = parser.feed(`text${c1}`);
    const m2 = parser.feed(c2);
    expect(m1).toEqual([]);
    expect(m2).toEqual([{ path: "/etc/hosts", authority: "" }]);
  });

  it("reset() drops a held partial so a subsequent complete sequence still parses cleanly", () => {
    const full = make7("file:///tmp");
    const mid = Math.floor(full.length / 2);
    parser.feed(full.slice(0, mid));
    parser.reset();
    const seq = make7("file:///var/log", "bel");
    expect(parser.feed(seq)).toEqual([{ path: "/var/log", authority: "" }]);
  });

  it("does not buffer indefinitely when the carry grows beyond the cap, and never throws", () => {
    const bigPayload = "x".repeat(5000); // > MAX_CARRY
    expect(() => {
      parser.feed(OPEN + bigPayload);
      parser.feed("y");
    }).not.toThrow();
  });

  // ─── Payload framing ────────────────────────────────────────────────────

  it("takes everything after the first ';' even when the payload itself contains ';'", () => {
    const seq = make7("file:///tmp/a;b;c");
    expect(parser.feed(seq)).toEqual([{ path: "/tmp/a;b;c", authority: "" }]);
  });

  // ─── Authority / scheme validation (§7.1 step 2) ───────────────────────

  it("accepts file://localhost/tmp (WHATWG normalizes the localhost host to empty)", () => {
    const seq = make7("file://localhost/tmp");
    expect(parser.feed(seq)).toEqual([{ path: "/tmp", authority: "" }]);
  });

  it("rejects file://localhost:22/tmp — WHATWG forbids a port on file: URLs", () => {
    const seq = make7("file://localhost:22/tmp");
    expect(parser.feed(seq)).toEqual([]);
  });

  it("accepts file:/tmp with no authority at all", () => {
    const seq = make7("file:/tmp");
    expect(parser.feed(seq)).toEqual([{ path: "/tmp", authority: "" }]);
  });

  it("rejects a non-file scheme", () => {
    const seq = make7("http://example.com/tmp");
    expect(parser.feed(seq)).toEqual([]);
  });

  it("exposes a non-empty authority for a real hostname", () => {
    const seq = make7("file://build-server/srv/data");
    expect(parser.feed(seq)).toEqual([{ path: "/srv/data", authority: "build-server" }]);
  });

  // ─── Hostile payloads (§7.1 steps 5-7) ─────────────────────────────────

  it("collapses .. after normalize but never escapes the root (sanity collapse, not a boundary)", () => {
    const seq = make7("file:///../../etc/passwd");
    expect(parser.feed(seq)).toEqual([{ path: "/etc/passwd", authority: "" }]);
  });

  it("rejects a payload with an embedded NUL", () => {
    const seq = make7("file:///tmp%00foo");
    expect(parser.feed(seq)).toEqual([]);
  });

  it("rejects a payload with an embedded C0 control character", () => {
    const seq = make7("file:///tmp%01foo");
    expect(parser.feed(seq)).toEqual([]);
  });

  it("rejects a payload with an embedded (encoded) newline", () => {
    const seq = make7("file:///path%0Afoo");
    expect(parser.feed(seq)).toEqual([]);
  });

  it("rejects a raw (unencoded) newline embedded in the payload, which WHATWG would otherwise silently strip before the decoded-path check ever sees it", () => {
    const seq = make7("fi\nle:///etc", "bel");
    expect(parser.feed(seq)).toEqual([]);
  });

  it("rejects a raw (unencoded) tab embedded in the payload", () => {
    const seq = make7("file:///et\tc/foo", "bel");
    expect(parser.feed(seq)).toEqual([]);
  });

  it("rejects a raw (unencoded) carriage return embedded in the payload", () => {
    const seq = make7("file:///et\rc/foo", "bel");
    expect(parser.feed(seq)).toEqual([]);
  });

  it("rejects an over-length decoded path", () => {
    const longPath = "/" + "a".repeat(5000);
    const seq = make7(`file://${longPath}`);
    expect(parser.feed(seq)).toEqual([]);
  });

  // ─── Decode safety ──────────────────────────────────────────────────────

  it("does not double-decode: %252e%252e%252f must not become ../", () => {
    const seq = make7("file:///%252e%252e%252fetc%252fpasswd");
    const matches = parser.feed(seq);
    expect(matches).toHaveLength(1);
    expect(matches[0].path).not.toContain("../");
    expect(matches[0].path).toBe("/%2e%2e%2fetc%2fpasswd");
  });

  it("returns no result for a malformed percent-escape, and never throws", () => {
    const seq = make7("file:///%zz");
    expect(() => parser.feed(seq)).not.toThrow();
    expect(parser.feed(seq)).toEqual([]);
  });

  it("tolerates a stray U+FFFD from a split multi-byte read without corrupting extraction", () => {
    const seq = make7("file:///tmp");
    const input = `before�after ${seq}`;
    expect(() => parser.feed(input)).not.toThrow();
    expect(parser.feed(input)).toEqual([{ path: "/tmp", authority: "" }]);
  });

  // ─── Multiple sequences / plain text ────────────────────────────────────

  it("extracts multiple OSC 7 sequences from one chunk, in order", () => {
    const s1 = make7("file:///a", "bel");
    const s2 = make7("file:///b", "st");
    expect(parser.feed(`x${s1}y${s2}z`)).toEqual([
      { path: "/a", authority: "" },
      { path: "/b", authority: "" }
    ]);
  });

  it("returns an empty array for plain text with no OSC 7 sequences", () => {
    expect(parser.feed("just some regular output\r\n")).toEqual([]);
  });

  it("does not react to other OSC types (e.g. OSC 0 window title)", () => {
    const title = `${ESC}]0;My Title${BEL}`;
    expect(parser.feed(`before ${title} after`)).toEqual([]);
  });
});
