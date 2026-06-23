import { describe, expect, it, beforeEach } from "vitest";
import { OscContextFilter } from "../../src/services/terminal/oscContextFilter";

// Helpers
const ESC = "\x1b";
const BEL = "\x07";
const ST = "\x1b\\"; // ESC backslash
const OPEN = `${ESC}]3008;`;

function make3008(payload: string, terminator: "st" | "bel" = "st"): string {
  return `${OPEN}${payload}${terminator === "bel" ? BEL : ST}`;
}

describe("OscContextFilter", () => {
  let filter: OscContextFilter;

  beforeEach(() => {
    filter = new OscContextFilter();
  });

  // ─── Complete sequence removal ──────────────────────────────────────────────

  it("removes a complete OSC 3008 (ST terminated) from a single chunk, preserving surrounding text", () => {
    const seq = make3008("start=abc;user=dev;pid=42");
    const input = `prompt> ${seq} more text`;
    expect(filter.filter(input)).toBe("prompt>  more text");
  });

  it("removes a complete OSC 3008 (BEL terminated) from a single chunk", () => {
    const seq = make3008("start=abc;user=dev", "bel");
    const input = `before ${seq} after`;
    expect(filter.filter(input)).toBe("before  after");
  });

  it("removes a 3008 at the very start of a chunk", () => {
    const seq = make3008("x=1");
    expect(filter.filter(seq + "hello")).toBe("hello");
  });

  it("removes a 3008 at the very end of a chunk", () => {
    const seq = make3008("x=1");
    expect(filter.filter("hello" + seq)).toBe("hello");
  });

  it("removes multiple OSC 3008 sequences in one chunk", () => {
    const s1 = make3008("a=1");
    const s2 = make3008("b=2", "bel");
    const input = `A${s1}B${s2}C`;
    expect(filter.filter(input)).toBe("ABC");
  });

  it("does not alter chunks with no escape sequences", () => {
    expect(filter.filter("hello world\r\n")).toBe("hello world\r\n");
  });

  it("does not alter chunks with only CSI sequences", () => {
    const input = "\x1b[31mred\x1b[0m normal \x1b[2J clear";
    expect(filter.filter(input)).toBe(input);
  });

  // ─── Cross-chunk splits ─────────────────────────────────────────────────────

  it("handles a 3008 split across two chunks (payload boundary)", () => {
    const full = make3008("start=abc;user=dev;pid=42");
    const mid = Math.floor(full.length / 2);
    const chunk1 = full.slice(0, mid);
    const chunk2 = full.slice(mid);

    const out1 = filter.filter("before" + chunk1);
    const out2 = filter.filter(chunk2 + "after");
    expect(out1 + out2).toBe("beforeafter");
  });

  it("handles a 3008 split across three chunks", () => {
    const full = make3008("start=abc;user=dev");
    const third = Math.floor(full.length / 3);
    const c1 = full.slice(0, third);
    const c2 = full.slice(third, third * 2);
    const c3 = full.slice(third * 2);

    const out = filter.filter(c1) + filter.filter(c2) + filter.filter(c3);
    expect(out).toBe("");
  });

  it("handles split exactly between ESC and \\ of the ST terminator", () => {
    // e.g. payload arrives, then ESC in one chunk, \\ in the next
    const payload = `${OPEN}start=x;user=y`;
    const out1 = filter.filter(payload + ESC); // ESC at end — could be start of ST
    const out2 = filter.filter("\\after");      // \\ completes the ST
    expect(out1 + out2).toBe("after");
  });

  it("handles split inside the opener (\\x1b] in one chunk, 3008; in next)", () => {
    // Chunk 1 ends with "\x1b]30", chunk 2 starts with "08;...ST"
    const openPart1 = `${ESC}]30`;
    const openPart2 = `08;payload${ST}`;
    const out1 = filter.filter("before" + openPart1);
    const out2 = filter.filter(openPart2 + "after");
    expect(out1 + out2).toBe("beforeafter");
  });

  it("handles split with just \\x1b at end of chunk", () => {
    // Chunk 1 ends with just ESC — could be opening of ]3008;
    const out1 = filter.filter("text" + ESC);
    const out2 = filter.filter("]3008;data" + ST + "more");
    expect(out1 + out2).toBe("textmore");
  });

  it("handles split with \\x1b]3008 across chunks (no semicolon yet)", () => {
    const out1 = filter.filter("A\x1b]3008");
    const out2 = filter.filter(";payload\x1b\\B");
    expect(out1 + out2).toBe("AB");
  });

  // ─── Other OSC sequences must NOT be stripped ───────────────────────────────

  it("passes through OSC 0 (window title) untouched", () => {
    const title = `${ESC}]0;My Title${BEL}`;
    expect(filter.filter("text" + title + "more")).toBe("text" + title + "more");
  });

  it("passes through OSC 8 (hyperlink) untouched", () => {
    const link = `${ESC}]8;;https://example.com${BEL}`;
    expect(filter.filter(link)).toBe(link);
  });

  it("passes through OSC 2 (icon name) with ST terminator untouched", () => {
    const osc = `${ESC}]2;icon name${ST}`;
    expect(filter.filter(osc)).toBe(osc);
  });

  it("passes through a window title split across two chunks (possibly delayed one boundary, but not corrupted)", () => {
    const title = `${ESC}]0;My Title${BEL}`;
    const mid = Math.floor(title.length / 2);
    const c1 = title.slice(0, mid);
    const c2 = title.slice(mid);

    // The filter may hold the prefix of the title if it starts with \x1b
    // but must NOT discard it — reassembled output must equal the full title
    const out = filter.filter(c1) + filter.filter(c2);
    expect(out).toBe(title);
  });

  it("does not delay OSC sequences that have diverged from OPEN past a single chunk boundary", () => {
    // \x1b]0;title is NOT a prefix of \x1b]3008;, so after the first chunk it should be released
    const diverged = `${ESC}]0;title`;
    const out1 = filter.filter(diverged);
    // The output may be empty (held) or equal to diverged — but the second chunk must release it
    const out2 = filter.filter(BEL + "more");
    expect(out1 + out2).toBe(diverged + BEL + "more");
  });

  it("passes through CSI sequences (cursor, color, erase) untouched", () => {
    const csi = "\x1b[31m\x1b[2J\x1b[15~\x1b[0m";
    expect(filter.filter(csi)).toBe(csi);
  });

  // ─── Mixed content ──────────────────────────────────────────────────────────

  it("strips 3008 interleaved with CSI sequences, leaving CSI intact", () => {
    const seq = make3008("u=dev");
    const input = `\x1b[32mok\x1b[0m ${seq} \x1b[31merr\x1b[0m`;
    expect(filter.filter(input)).toBe(`\x1b[32mok\x1b[0m  \x1b[31merr\x1b[0m`);
  });

  it("strips 3008 that appears adjacent to another OSC", () => {
    const osc0 = `${ESC}]0;title${BEL}`;
    const osc3008 = make3008("pid=1");
    const input = osc0 + osc3008 + "text";
    expect(filter.filter(input)).toBe(osc0 + "text");
  });

  // ─── reset() ────────────────────────────────────────────────────────────────

  it("reset() drops a held partial, which is not emitted on subsequent calls", () => {
    // Start an in-progress sequence
    filter.filter(`text${OPEN}partial`);
    filter.reset();
    // After reset, subsequent input should not be affected by the old partial
    const out = filter.filter("clean text");
    expect(out).toBe("clean text");
  });

  it("reset() allows normal operation after a partial was held", () => {
    filter.filter(`A${OPEN}no-terminator-yet`);
    filter.reset();
    const seq = make3008("fresh");
    expect(filter.filter("B" + seq + "C")).toBe("BC");
  });

  // ─── Cap behavior ───────────────────────────────────────────────────────────

  it("does not buffer indefinitely when the carry grows beyond MAX_CARRY", () => {
    // Feed a 3008 opener followed by more data than MAX_CARRY without a terminator
    // The filter must eventually emit something rather than silently buffering forever
    const opener = OPEN;
    const bigPayload = "x".repeat(5000); // > 4096 cap

    // The filter may emit the opener as literal text once it exceeds the cap —
    // what matters is it does NOT hold output forever (the output is non-empty after the cap is hit)
    let out = "";
    out += filter.filter(opener + bigPayload);
    // If nothing emitted yet, drive a tiny additional chunk
    out += filter.filter("y");
    // By now the cap should have fired and something was emitted
    expect(out.length).toBeGreaterThan(0);
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────────

  it("handles empty input gracefully", () => {
    expect(filter.filter("")).toBe("");
  });

  it("handles multiple consecutive calls with plain text", () => {
    expect(filter.filter("hello ")).toBe("hello ");
    expect(filter.filter("world")).toBe("world");
  });

  it("passes a stray \\x1b] that is not followed by 3008", () => {
    // e.g. \x1b]9;... — cannot be a prefix of \x1b]3008; after the digit '9'
    // So the filter should not hold it beyond one additional chunk
    const out1 = filter.filter("\x1b]9;notification\x07text");
    expect(out1).toBe("\x1b]9;notification\x07text");
  });

  it("handles a 3008 with a long payload (real systemd format)", () => {
    const payload =
      "start=550e8400-e29b-41d4-a716-446655440000;" +
      "user=ubuntu;hostname=myserver;" +
      "machineid=abcdef01234567890123456789abcdef;" +
      "bootid=fedcba0987654321fedcba0987654321;" +
      "pid=1234;type=shell;cwd=/home/ubuntu";
    const seq = make3008(payload);
    expect(filter.filter(`$ ${seq}$ `)).toBe("$ $ ");
  });
});
