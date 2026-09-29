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
    ["nF with [ final", "\x1b(["],
    ["nF with ] final", "\x1b#]"],
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

    it("the 8-bit ST (U+009C) terminates DCS and OSC, in one chunk or split", () => {
      expect(run(["a\x1bPpayload\x9cPassword: "])).toBe("aPassword: ");
      expect(run(["a\x1b]0;title\x9cPassword: "])).toBe("aPassword: ");
      expect(run(["a\x1bPpayload", "more\x9cPassword: "])).toBe("aPassword: ");
      expect(run(["a\x1b]0;title", "more", "\x9cPassword: "])).toBe("aPassword: ");
    });

    it.each([
      ["ESC \\ (7-bit ST)", "\\", "aPassword: "],
      ["CAN", "\x18", "aPassword: "],
      ["SUB", "\x1a", "aPassword: "],
      ["8-bit ST", "\x9c", "aPassword: "]
    ])("a carried lone ESC followed by %s ends the string without re-emitting either byte", (_n, next, expected) => {
      expect(run(["a\x1bPpayload\x1b", `${next}Password: `])).toBe(expected);
      expect(run(["a\x1b]0;title\x1b", `${next}Password: `])).toBe(expected);
    });

    it("a carried lone ESC followed by another ESC or an ordinary char aborts and starts a new sequence", () => {
      // ESC [ 3 1 m is a complete SGR that starts at the carried ESC.
      expect(run(["a\x1bPpayload\x1b", "[31mred"])).toBe("ared");
      // ESC followed by an ordinary char: two-byte ESC sequence, removed whole.
      expect(run(["a\x1bPpayload\x1b", "7rest"])).toBe("arest");
      // Another ESC: the first aborts, the second begins the SGR.
      expect(run(["a\x1bPpayload\x1b", "\x1b[31mred"]).replace(/\x1b/g, "")).toBe("ared");
    });

    it("BEL is payload inside DCS/APC/PM/SOS, whole or split on either side of it", () => {
      for (const intro of ["P", "_", "^", "X"]) {
        const open = `a\x1b${intro}pay`;
        expect(run([`${open}\x07load\x1b\\b`])).toBe("ab");
        expect(run([open, `\x07load\x1b\\b`])).toBe("ab");
        expect(run([`${open}\x07`, `load\x1b\\b`])).toBe("ab");
        expect(run([open, "\x07", "load", "\x1b", "\\b"])).toBe("ab");
      }
      expect(strip("a\x1bPpay\x07load\x1b\\b")).toBe("ab");
    });

    it("BEL still ends an OSC string", () => {
      expect(run(["a\x1b]0;title\x07Password: "])).toBe("aPassword: ");
      expect(run(["a\x1b]0;title", "\x07Password: "])).toBe("aPassword: ");
    });

    it("keeps text after an aborting ESC and after a bare ESC pair", () => {
      expect(run(["a\x1bPpayload", "more\x1b[31mred"])).toBe("ared");
    });

    it("holds a split CSI and releases a run past the 512-char bound as text", () => {
      expect(run(["a\x1b[>4;", "2mb"])).toBe("ab");
      expect(run(["\x1b[" + "1".repeat(600)]).length).toBeGreaterThan(590);
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

describe("stripChunk chunk-independence", () => {
  const stripFull = (chunks: string[], limit?: number): { text: string; carry: unknown } => {
    let carry = EMPTY_STRIP_CARRY;
    let out = "";
    for (const c of chunks) {
      const r = stripChunk(carry, c, limit);
      out += r.text;
      carry = r.carry;
    }
    return { text: out, carry };
  };
  const stripAll = (chunks: string[], limit?: number): string => stripFull(chunks, limit).text;

  // Tricky inputs: every string terminator and abort, CSI with private and
  // intermediate forms, nF, malformed escapes, and lone ESC at the end.
  const corpus = [
    "plain text",
    "a\x1b[31mred\x1b[0mb",
    "a\x1b[>4;2mb\x1b[=5ucd\x1b[<ue\x1b[?2004hf",
    "a\x1b[2 qb\x1b[!pc\x1b[1;2 !qd",
    "a\x1b([b\x1b#]c\x1b[31md\x1b]0;t\x07e",
    "a\x1b7b\x1b8c\x1b=d\x1b>e\x1b(Bf\x1b#8g\x1b ~h",
    "a\x1b]0;title\x07b",
    "a\x1b]0;title\x1b\\b",
    "a\x1b]0;title\x9cb",
    "a\x1b]0;title\x18b",
    "a\x1b]0;title\x1ab",
    "a\x1b]0;title\x1b[31mb",
    "a\x1bPpay\x07load\x1b\\b",
    "a\x1bPpayload\x9cb",
    "a\x1bPpayload\x18b",
    "a\x1bPpayload\x1ab",
    "a\x1bPpayload\x1b[31mPassword:",
    "a\x1b_Gf=1;pay\x07load\x1b\\b",
    "a\x1b^priv\x1b\\b\x1bXsos\x9cc",
    "a\x1bPpayload\x1b\x1b[31mb",
    "a\x1bPpayload\x1b7b",
    "a\x1bPpayload\x1b\x18b\x1b]t\x1b\x1ac",
    "a\x1b[1\x1b[31mb",
    "a\x1b[1;\nb\x1b[>\x07c",
    "a\x1b (b\x1b\x1b\x1bc",
    "a\x1b[0;1;3;4;5;7;9;38;2;255;255;255;48;2;255;255;255;58;2;255;255;255mb",
    "trailing lone ESC\x1b",
    "trailing CSI\x1b[>4;",
    "trailing OSC\x1b]0;ti",
    "trailing DCS\x1bPpay\x1b",
    "\x1b\x1b\x1b"
  ];

  // Escapes past the 512-char bound: too long for the all-splits sweep, so they
  // go through the per-character and random-split checks only.
  const longCorpus = [
    "a\x1b[" + "1".repeat(600) + "mb",
    "a\x1b " + " ".repeat(600) + "~b"
  ];

  function* splits(text: string): Generator<string[]> {
    yield [text];
    for (let i = 0; i <= text.length; i++) {
      yield [text.slice(0, i), text.slice(i)];
      for (let j = i; j <= text.length; j++) {
        yield [text.slice(0, i), text.slice(i, j), text.slice(j)];
      }
    }
  }

  // Deterministic PRNG so failures reproduce.
  function rng(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 0x100000000;
    };
  }

  it.each([undefined, 3])("every 1- and 2-cut split matches the one-shot result (discard limit %s)", (limit) => {
    for (const input of corpus) {
      const whole = stripFull([input], limit);
      for (const parts of splits(input)) {
        expect(stripFull(parts, limit), JSON.stringify({ input, parts })).toEqual(whole);
      }
    }
  });

  it("random multi-cut splits (fixed seed) and 1-character streams match the one-shot result", () => {
    const rand = rng(251);
    for (const input of [...corpus, ...longCorpus]) {
      const whole = stripFull([input]);
      expect(stripFull([...input]), JSON.stringify({ input, mode: "per-char" })).toEqual(whole);
      for (let k = 0; k < 25; k++) {
        const cuts = new Set<number>();
        const count = 1 + Math.floor(rand() * 6);
        for (let c = 0; c < count; c++) cuts.add(Math.floor(rand() * (input.length + 1)));
        const sorted = [...cuts].sort((a, b) => a - b);
        const parts: string[] = [];
        let prev = 0;
        for (const cut of sorted) {
          parts.push(input.slice(prev, cut));
          prev = cut;
        }
        parts.push(input.slice(prev));
        expect(stripFull(parts), JSON.stringify({ input, parts })).toEqual(whole);
      }
    }
  });

  it("nF sequences may end in [ or ], while a bare ESC [ or ESC ] still opens CSI or OSC", () => {
    expect(stripAll(["a\x1b([b\x1b#]c"])).toBe("abc");
    expect(stripAll(["a\x1b(", "[b\x1b#", "]c"])).toBe("abc");
    expect(stripAll([..."a\x1b([b\x1b#]c"])).toBe("abc");
    expect(strip("a\x1b([b\x1b#]c")).toBe("abc");
    expect(stripAll(["a\x1b[31mb"])).toBe("ab");
    expect(stripAll(["a\x1b]0;t\x07b"])).toBe("ab");
    expect(strip("a\x1b[31mb\x1b]0;t\x07c")).toBe("abc");
  });

  it("strips a long real SGR (67 chars) whole and split", () => {
    const sgr = "\x1b[0;1;3;4;5;7;9;38;2;255;255;255;48;2;255;255;255;58;2;255;255;255m";
    expect(sgr.length).toBeGreaterThan(64);
    expect(stripAll([`a${sgr}b`])).toBe("ab");
    expect(stripAll([`a${sgr.slice(0, 30)}`, `${sgr.slice(30)}b`])).toBe("ab");
    expect(stripAll([...`a${sgr}b`])).toBe("ab");
    const colon = "\x1b[38:2::255:255:255;48:2::255:255:255;58:2::255:255:255;4:3;1;3;9;53m";
    expect(stripAll([`a${colon}b`])).toBe("ab");
  });

  it("does not resume the text with a low surrogate orphaned by the discard cap", () => {
    // cap 2 drops "a" and the high surrogate, then hits the low half.
    const out = stripAll(["\x1bPa\u{1F600}b"], 2);
    expect(out).toBe("b");
    expect(out).not.toMatch(/[\udc00-\udfff]/);
    expect(stripAll(["\x1bPa\ud83d", "\ude00b"], 2)).toBe("b");
  });

  it("the corpus is stripped as intended, not vacuously equal", () => {
    expect(stripAll(["a\x1b[>4;2mb\x1b7c"])).toBe("abc");
    expect(stripAll(["a\x1bPpay\x07load\x1b\\b"])).toBe("ab");
    expect(stripAll(["a\x1b]0;title\x9cb"])).toBe("ab");
  });

  it("a DCS aborted by a non-ST ESC in the same chunk drops its payload", () => {
    expect(stripAll(["\x1bPpayload\x1b[31mPassword:"])).toBe("Password:");
    expect(stripAll(["\x1bPpayload", "\x1b[31mPassword:"])).toBe("Password:");
  });

  it("applies the discard cap when the opener and a huge payload arrive in one chunk", () => {
    const big = "x".repeat(1024 * 1024 + 500);
    const one = stripAll(["a\x1bP" + big + "Password: "]);
    expect(one.endsWith("Password: ")).toBe(true);
    expect(one.startsWith("a")).toBe(true);
    expect(stripAll(["a\x1bP", big, "Password: "])).toBe(one);
  });
});

