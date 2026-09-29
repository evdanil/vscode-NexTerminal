import { describe, expect, it } from "vitest";
import { createAnsiRegex, EMPTY_STRIP_CARRY, stripChunk } from "../../src/utils/ansi";

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

  describe("stripChunk", () => {
    const run = (chunks: string[]): string => {
      let carry = EMPTY_STRIP_CARRY;
      let out = "";
      for (const c of chunks) {
        const r = stripChunk(carry, c);
        out += r.text;
        carry = r.carry;
      }
      return out;
    };

    it("drops a DCS payload far longer than 64 chars split across two or three chunks", () => {
      const payload = "q" + "#0;2;0;0;0".repeat(50);
      expect(run(["a\x1bP" + payload, payload + "\x1b\\b"])).toBe("ab");
      expect(run(["a\x1bP" + payload, payload, payload + "\x1b", "\\b"])).toBe("ab");
      expect(run(["a\x1b_Gf=100;" + payload + "\x1b\\b"])).toBe("ab");
    });

    it("drops an OSC payload across chunks until BEL or ST", () => {
      const title = "t".repeat(200);
      expect(run(["a\x1b]0;" + title, title + "\x07b"])).toBe("ab");
      expect(run(["a\x1b]0;" + title, "\x1b", "\\b"])).toBe("ab");
    });

    it.each([["CAN", "\x18"], ["SUB", "\x1a"]])("%s cancels a DCS or OSC string, split or in one chunk", (_n, cancel) => {
      // single chunk, via the regex
      expect(run([`a\x1bPpayload${cancel}Password: `])).toBe("aPassword: ");
      expect(run([`a\x1b]0;title${cancel}Password: `])).toBe("aPassword: ");
      // split: the string is open at the chunk boundary, the cancel arrives later
      expect(run(["a\x1bPpayload", `more${cancel}Password: `])).toBe("aPassword: ");
      expect(run(["a\x1b]0;title", `more${cancel}Password: `])).toBe("aPassword: ");
      expect(run(["a\x1bPpayload", "more", `${cancel}Password: `])).toBe("aPassword: ");
    });

    it("keeps text after an aborting ESC and after a bare ESC pair", () => {
      expect(run(["a\x1bPpayload", "more\x1b[31mred"])).toBe("ared");
    });

    it("holds a split CSI within the 64-char cap and releases a longer run", () => {
      expect(run(["a\x1b[>4;", "2mb"])).toBe("ab");
      expect(run(["\x1b[" + "1".repeat(100)]).length).toBeGreaterThan(90);
    });

    it("gives up discarding after 1 MiB and resumes normal text", () => {
      const big = "x".repeat(600 * 1024);
      const out = run(["a\x1bP" + big, big, "visible"]);
      expect(out.endsWith("visible")).toBe(true);
      expect(out.startsWith("a")).toBe(true);
    });

    it("releases ordinary text after a trailing ESC that does not extend (control pass removes the ESC)", () => {
      expect(run(["x\x1b", "\nabc"])).toBe("x\x1b\nabc");
    });
  });

  it("leaves an incomplete CSI unmatched so the highlighter can hold it back", () => {
    expect(createAnsiRegex().test("x\x1b[>4;")).toBe(false);
    expect(createAnsiRegex().test("x\x1b[")).toBe(false);
  });

  it("does not let an unterminated DCS swallow following text", () => {
    expect(strip("\x1bPpayload more text")).toBe("payload more text");
  });
});
