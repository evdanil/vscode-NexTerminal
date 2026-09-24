import { describe, expect, it } from "vitest";
import { ScriptOutputBuffer } from "../../../src/services/scripts/scriptOutputBuffer";

describe("ScriptOutputBuffer", () => {
  it("appends and advances writeHead", () => {
    const buf = new ScriptOutputBuffer();
    buf.append("hello");
    buf.append(" world");
    expect(buf.writeHead).toBe(11);
  });

  it("strips ANSI escapes on append", () => {
    const buf = new ScriptOutputBuffer();
    buf.append("\x1b[31mred\x1b[0m");
    expect(buf.writeHead).toBe(3);
    const m = buf.scan("red");
    expect(m?.text).toBe("red");
  });

  it("rolls trim when text exceeds capacity", () => {
    const buf = new ScriptOutputBuffer({ capacity: 10 });
    buf.append("1234567890");
    buf.append("ABCDE");
    expect(buf.writeHead).toBe(15);
    // Most recent 10 chars retained: "67890ABCDE"
    const m = buf.scan(/67890/);
    expect(m?.text).toBe("67890");
    const lost = buf.scan(/12345/);
    expect(lost).toBeNull();
  });

  it("first scan sees the whole buffer, subsequent scans start at the cursor (lookback 0)", () => {
    const buf = new ScriptOutputBuffer();
    buf.append("ABC");
    // First scan — the cursor is still at 0, so the window is the whole buffer
    const first = buf.scan(/ABC/);
    expect(first).not.toBeNull();
    buf.advanceCursor(first!.endPosition);
    // Second scan — lookback default 0, cursor past "ABC", no new bytes: no match
    const second = buf.scan(/ABC/);
    expect(second).toBeNull();
  });

  it("the first scan covers the WHOLE retained buffer — not the last 1024 characters — and lookback reaches back exactly N characters from the cursor", () => {
    // ⊘ a first-wait window limited to "the last 1 KB of output", which is
    // what the shipped d.ts promised: a prompt that arrived more than 1024
    // characters before the first wait would be missed. The window's start is
    // `max(oldest retained, cursor - lookback)`, and the cursor is 0 until the
    // first match, so the first wait always sees everything the run received.
    const buf = new ScriptOutputBuffer();
    buf.append("LOGIN: " + "x".repeat(5_000));
    const first = buf.scan(/LOGIN: /);
    expect(first?.text).toBe("LOGIN: ");
    expect(first?.before).toBe("");
    buf.advanceCursor(first!.endPosition);

    // Later scans start at the cursor; `lookback: N` re-includes exactly the N
    // characters before it — 6 is one short of re-reaching "LOGIN: ".
    expect(buf.scan(/LOGIN: /)).toBeNull();
    expect(buf.scan(/LOGIN: /, { lookback: 6 })).toBeNull();
    expect(buf.scan(/LOGIN: /, { lookback: 7 })?.text).toBe("LOGIN: ");
  });

  it("respects per-call lookback override", () => {
    const buf = new ScriptOutputBuffer();
    buf.append("PROMPT# ");
    const first = buf.scan(/PROMPT# /);
    buf.advanceCursor(first!.endPosition);
    // Default lookback=0, but force 16 bytes of lookback for this call
    const second = buf.scan(/PROMPT# /, { lookback: 16 });
    expect(second?.text).toBe("PROMPT# ");
  });

  it("advanceCursor is forward-only", () => {
    const buf = new ScriptOutputBuffer();
    buf.append("hello");
    buf.advanceCursor(5);
    buf.advanceCursor(2); // no-op
    expect(buf.cursor).toBe(5);
  });

  it("notifies subscribers on append and supports unsubscribe", () => {
    const buf = new ScriptOutputBuffer();
    const seen: number[] = [];
    const unsub = buf.subscribe(() => seen.push(buf.writeHead));
    buf.append("a");
    buf.append("b");
    unsub();
    buf.append("c");
    expect(seen).toEqual([1, 2]);
  });

  it("scan returns regex capture groups", () => {
    const buf = new ScriptOutputBuffer();
    buf.append("user=admin pw=s3cr3t");
    const m = buf.scan(/user=(\w+) pw=(\w+)/);
    expect(m?.groups).toEqual(["admin", "s3cr3t"]);
  });

  it("scan returns the 'before' text between cursor and match", () => {
    const buf = new ScriptOutputBuffer();
    buf.append("noise noise PROMPT# ");
    const m = buf.scan(/PROMPT# /);
    expect(m?.before).toBe("noise noise ");
  });

  it("finds matches even when the pattern has the global /g flag (P2 — Codex)", () => {
    const buf = new ScriptOutputBuffer();
    buf.append("noise PROMPT# ");
    // Global regexes are common in user code — scan must still find the first match.
    const m = buf.scan(/PROMPT# /g);
    expect(m).not.toBeNull();
    expect(m?.text).toBe("PROMPT# ");
    expect(m?.before).toBe("noise ");
  });

  it("respects capture groups on global regexes", () => {
    const buf = new ScriptOutputBuffer();
    buf.append("user=admin");
    const m = buf.scan(/user=(\w+)/g);
    expect(m?.groups).toEqual(["admin"]);
  });

  describe("tail()", () => {
    it("returns empty string for an empty buffer", () => {
      const buf = new ScriptOutputBuffer();
      expect(buf.tail(100)).toBe("");
    });

    it("returns the last N chars of stripped output", () => {
      const buf = new ScriptOutputBuffer();
      buf.append("123456789");
      expect(buf.tail(4)).toBe("6789");
    });

    it("caps at the buffer length when N exceeds what's been received", () => {
      const buf = new ScriptOutputBuffer();
      buf.append("short");
      expect(buf.tail(9999)).toBe("short");
    });

    it("returns empty string for non-positive N", () => {
      const buf = new ScriptOutputBuffer();
      buf.append("abc");
      expect(buf.tail(0)).toBe("");
      expect(buf.tail(-1)).toBe("");
    });

    it("reflects ANSI-stripped content, not raw escape bytes", () => {
      const buf = new ScriptOutputBuffer();
      buf.append("\x1b[31merror\x1b[0m");
      expect(buf.tail(5)).toBe("error");
    });
  });
});
