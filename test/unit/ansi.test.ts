import { describe, expect, it } from "vitest";
import { createAnsiRegex, stripChunk } from "../../src/utils/ansi";

const strip = (s: string): string => s.replace(createAnsiRegex(), "");

describe("createAnsiRegex", () => {
  it.each([
    ["Kitty push", "\x1b[>1u"],
    ["Kitty pop", "\x1b[<u"],
    ["Kitty set", "\x1b[=5;1u"],
    ["modifyOtherKeys set", "\x1b[>4;2m"],
    ["modifyOtherKeys reset", "\x1b[>4;m"],
    ["DA2 query", "\x1b[>c"],
    ["DECSCUSR cursor shape", "\x1b[2 q"],
    ["DECSTR soft reset", "\x1b[!p"],
    ["DECSC", "\x1b7"],
    ["DECRC", "\x1b8"],
    ["DECKPAM", "\x1b="],
    ["DECKPNM", "\x1b>"],
    ["charset designation", "\x1b(B"],
    ["DECALN", "\x1b#8"],
    ["DCS XTGETTCAP with ST", "\x1bP+q544e\x1b\\"],
    ["existing: SGR", "\x1b[1;31m"],
    ["existing: DEC private mode", "\x1b[?2004h"],
    ["existing: function key", "\x1b[15~"],
    ["existing: OSC with BEL", "\x1b]0;title\x07"]
  ])("removes %s entirely", (_name, seq) => {
    expect(strip(`a${seq}b`)).toBe("ab");
  });

  it("removes a mixed run around a prompt", () => {
    expect(strip("\x1b[?2004h\x1b[>4;1m\x1b[=5u\x1b= user@host> ")).toBe(" user@host> ");
  });

  it("does not over-strip ordinary text", () => {
    const text = "ls > out; echo [>4;2m] 7 8 = > <u [2 q (B #8 P+q";
    expect(strip(text)).toBe(text);
  });

  it("holds an unterminated OSC/DCS tail, including a half ST, within the cap", () => {
    expect(stripChunk("", "a\x1b]0;title")).toEqual({ text: "a", carry: "\x1b]0;title" });
    expect(stripChunk("", "a\x1bP+q54\x1b")).toEqual({ text: "a", carry: "\x1bP+q54\x1b" });
    expect(stripChunk("\x1b]0;title", "\x07$ ")).toEqual({ text: "$ ", carry: "" });
    const long = "\x1b]0;" + "t".repeat(100);
    expect(stripChunk("", long).carry).toBe("");
  });

  it("leaves an incomplete CSI unmatched so the highlighter can hold it back", () => {
    expect(createAnsiRegex().test("x\x1b[>4;")).toBe(false);
    expect(createAnsiRegex().test("x\x1b[")).toBe(false);
  });

  it("does not let an unterminated DCS swallow following text", () => {
    expect(strip("\x1bPpayload more text")).toBe("payload more text");
  });
});
