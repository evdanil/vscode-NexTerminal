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

  it("first scan uses 1024-byte default lookback, subsequent scans use 0", () => {
    const buf = new ScriptOutputBuffer();
    buf.append("ABC");
    // First scan — lookback default 1024 sees the whole buffer
    const first = buf.scan(/ABC/);
    expect(first).not.toBeNull();
    buf.advanceCursor(first!.endPosition);
    // Second scan — lookback default 0, cursor past "ABC", no new bytes: no match
    const second = buf.scan(/ABC/);
    expect(second).toBeNull();
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
});
