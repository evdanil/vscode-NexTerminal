import { describe, expect, it } from "vitest";
import {
  DO,
  DONT,
  IAC,
  OPT_BINARY,
  OPT_ECHO,
  OPT_NAWS,
  OPT_SGA,
  OPT_TERMINAL_TYPE,
  SB,
  SE,
  TelnetNegotiator,
  escapeIac,
  WILL,
  WONT
} from "../../src/services/telnet/telnetProtocol";

const TTYPE_SEND = 1;
const TTYPE_IS = 0;

function bytes(...values: number[]): Buffer {
  return Buffer.from(values);
}

function text(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

/** Feed one chunk and return both halves as plain arrays for readable diffs. */
function feed(negotiator: TelnetNegotiator, chunk: Buffer): { data: number[]; response: number[] } {
  const result = negotiator.receive(chunk);
  return { data: [...result.data], response: [...result.response] };
}

describe("TelnetNegotiator — data-stream handling", () => {
  // ⊘ Mutation table — each row is an implementation this test rejects:
  //   - a parser that passes IAC sequences through as data          → data would carry 0xFF 0xFB 0x01
  //   - a parser that swallows the byte AFTER a completed sequence  → data would lose "i"
  //   - a parser that treats IAC IAC as the start of a command      → "a\xffb" would lose bytes
  it("strips IAC sequences out of the data stream and passes everything else through", () => {
    const n = new TelnetNegotiator();
    const { data } = feed(n, Buffer.concat([text("h"), bytes(IAC, WILL, OPT_ECHO), text("i")]));
    expect(Buffer.from(data).toString("utf8")).toBe("hi");
  });

  it("unescapes IAC IAC to a single 0xFF data byte", () => {
    const n = new TelnetNegotiator();
    const { data, response } = feed(n, bytes(0x61, IAC, IAC, 0x62));
    expect(data).toEqual([0x61, 0xff, 0x62]);
    // An escaped data byte is not a negotiation — nothing may be sent back.
    expect(response).toEqual([]);
  });

  // ⊘ A parser that resets its state machine per chunk answers this wrong: the
  // IAC lands at the end of chunk 1, so a per-chunk parser either emits 0xFF as
  // data or drops WILL/ECHO on the floor and never replies DO.
  it("carries a sequence split across chunk boundaries (IAC at the end of a chunk)", () => {
    const n = new TelnetNegotiator();
    const first = feed(n, Buffer.concat([text("ab"), bytes(IAC)]));
    expect(Buffer.from(first.data).toString("utf8")).toBe("ab");
    expect(first.response).toEqual([]);

    const second = feed(n, bytes(WILL));
    expect(second.data).toEqual([]);
    expect(second.response).toEqual([]);

    const third = feed(n, Buffer.concat([bytes(OPT_ECHO), text("cd")]));
    expect(Buffer.from(third.data).toString("utf8")).toBe("cd");
    expect(third.response).toEqual([IAC, DO, OPT_ECHO]);
  });

  it("carries a subnegotiation split across three chunks", () => {
    const n = new TelnetNegotiator({ terminalType: "xterm-256color" });
    expect(feed(n, bytes(IAC, SB, OPT_TERMINAL_TYPE)).response).toEqual([]);
    expect(feed(n, bytes(TTYPE_SEND, IAC)).response).toEqual([]);
    const final = feed(n, Buffer.concat([bytes(SE), text("ok")]));
    expect(Buffer.from(final.data).toString("utf8")).toBe("ok");
    expect(final.response).toEqual([
      IAC,
      SB,
      OPT_TERMINAL_TYPE,
      TTYPE_IS,
      ...text("xterm-256color"),
      IAC,
      SE
    ]);
  });

  it("passes UTF-8 multibyte content through untouched", () => {
    const n = new TelnetNegotiator();
    const payload = "héllo — 日本語 ✓";
    const { data } = feed(n, Buffer.concat([text(payload), bytes(IAC, WILL, OPT_SGA)]));
    expect(Buffer.from(data).toString("utf8")).toBe(payload);
  });

  // ⊘ MAJOR-1 (review) — THE UNBOUNDED-PAYLOAD DoS. Telnet is unauthenticated,
  // so a server or an on-path attacker can open `IAC SB <opt>` and then stream
  // forever: every byte was pushed into a `number[]` that nothing capped and
  // nothing reset short of `IAC SE`, so the extension host died with nothing on
  // screen. A cap is the only thing that fails this test — a parser that merely
  // "ignores unknown subnegotiations" still accumulates the payload first.
  it("abandons a subnegotiation whose payload runs past the cap, without growing without bound", () => {
    const n = new TelnetNegotiator();
    const cap = n.maxSubnegotiationBytes;
    feed(n, bytes(IAC, SB, 99));
    // Well past any real subnegotiation (TERMINAL-TYPE ≤ 40, NAWS is 4).
    const flood = Buffer.alloc(200_000, 0x41);
    const during = feed(n, flood);

    // NOTHING is retained: the parser abandons at the cap and returns to the
    // data state, so the bytes it could not use are STREAMED (rendered) rather
    // than accumulated. The old parser held all 200_000 in a `number[]`.
    expect(n.pendingSubnegotiationBytes).toBe(0);
    expect(during.response).toEqual([]);
    // Exactly the flood minus the bytes swallowed as payload before the cap
    // tripped — proof it neither buffered them nor silently ate the stream.
    expect(during.data).toHaveLength(flood.length - cap);

    // …and the parser really is back in the data state, so ordinary output that
    // follows still arrives.
    expect(Buffer.from(feed(n, text("prompt> ")).data).toString("utf8")).toBe("prompt> ");
  });

  // ⊘ THE BENIGN WEDGE, the same bug's other face: a device that emits a
  // truncated subnegotiation (no IAC SE) left the parser in `sb-payload`
  // forever, silently discarding EVERY later byte — terminal, capture buffer,
  // highlighting and scripts all went dark with no way back short of closing
  // the tab. A parser that only caps memory but never leaves the state fails
  // this one.
  it("recovers the session when a device never terminates a subnegotiation", () => {
    const n = new TelnetNegotiator();
    feed(n, Buffer.concat([bytes(IAC, SB, OPT_TERMINAL_TYPE), Buffer.alloc(4096, 0x42)]));
    // The parser is back in the data state, so the NEXT chunk renders normally
    // instead of vanishing into a subnegotiation that never ends.
    const after = feed(n, text("Router> "));
    expect(Buffer.from(after.data).toString("utf8")).toBe("Router> ");
  });

  it("still answers a legitimately long-but-valid subnegotiation after an abandoned one", () => {
    const n = new TelnetNegotiator({ terminalType: "vt100" });
    feed(n, Buffer.concat([bytes(IAC, SB, 99), Buffer.alloc(4096, 0x43)]));
    const { response } = feed(n, bytes(IAC, SB, OPT_TERMINAL_TYPE, 1, IAC, SE));
    expect(response).toEqual([IAC, SB, OPT_TERMINAL_TYPE, 0, ...text("vt100"), IAC, SE]);
  });

  it("accepts a subnegotiation right at the cap", () => {
    const n = new TelnetNegotiator();
    const payload = Buffer.alloc(n.maxSubnegotiationBytes - 1, 0x01);
    const { response } = feed(
      n,
      Buffer.concat([bytes(IAC, SB, OPT_TERMINAL_TYPE, 1), payload, bytes(IAC, SE)])
    );
    // Payload was `SEND` + filler, so it is still a well-formed TERMINAL-TYPE SEND.
    expect(response.slice(0, 4)).toEqual([IAC, SB, OPT_TERMINAL_TYPE, 0]);
  });

  it("does not mistake a 0xFF byte inside a subnegotiation payload for IAC SE", () => {
    const n = new TelnetNegotiator();
    // IAC SB <unknown 99> 0x01 IAC IAC 0x02 IAC SE — the escaped 0xFF must not end it.
    const { data } = feed(
      n,
      Buffer.concat([bytes(IAC, SB, 99, 0x01, IAC, IAC, 0x02, IAC, SE), text("after")])
    );
    expect(Buffer.from(data).toString("utf8")).toBe("after");
  });
});

describe("TelnetNegotiator — CR handling (RFC 854 NVT)", () => {
  // ⊘ A parser that leaves CR NUL alone renders a spurious NUL; one that maps
  // CR NUL to LF breaks single-line overwrite (progress meters).
  it("collapses CR NUL to a bare CR", () => {
    const n = new TelnetNegotiator();
    const { data } = feed(n, Buffer.concat([text("x"), bytes(0x0d, 0x00), text("y")]));
    expect(data).toEqual([0x78, 0x0d, 0x79]);
  });

  it("passes CR LF through unchanged", () => {
    const n = new TelnetNegotiator();
    const { data } = feed(n, text("a\r\nb"));
    expect(Buffer.from(data).toString("utf8")).toBe("a\r\nb");
  });

  it("emits a bare CR followed by an ordinary byte", () => {
    const n = new TelnetNegotiator();
    const { data } = feed(n, bytes(0x0d, 0x41));
    expect(data).toEqual([0x0d, 0x41]);
  });

  // ⊘ A parser that flushes a trailing CR at the end of every chunk emits a
  // stray NUL when the CR NUL pair is split by TCP.
  it("holds a trailing CR across the chunk boundary so a split CR NUL still collapses", () => {
    const n = new TelnetNegotiator();
    expect(feed(n, bytes(0x0d)).data).toEqual([]);
    expect(feed(n, bytes(0x00, 0x7a)).data).toEqual([0x0d, 0x7a]);
  });

  it("holds a trailing CR across the chunk boundary so a split CR LF still passes through", () => {
    const n = new TelnetNegotiator();
    expect(feed(n, text("done\r")).data).toEqual([...text("done")]);
    expect(Buffer.from(feed(n, text("\nnext")).data).toString("utf8")).toBe("\r\nnext");
  });

  it("does not lose a CR that is followed by an IAC sequence", () => {
    const n = new TelnetNegotiator();
    const { data, response } = feed(n, Buffer.concat([bytes(0x0d), bytes(IAC, WILL, OPT_SGA), text("z")]));
    expect(Buffer.from(data).toString("utf8")).toBe("\rz");
    expect(response).toEqual([IAC, DO, OPT_SGA]);
  });
});

describe("TelnetNegotiator — option negotiation", () => {
  it("accepts server WILL ECHO and WILL SGA with DO", () => {
    const n = new TelnetNegotiator();
    expect(feed(n, bytes(IAC, WILL, OPT_ECHO)).response).toEqual([IAC, DO, OPT_ECHO]);
    expect(feed(n, bytes(IAC, WILL, OPT_SGA)).response).toEqual([IAC, DO, OPT_SGA]);
  });

  it("agrees to DO SGA for our own side with WILL", () => {
    const n = new TelnetNegotiator();
    expect(feed(n, bytes(IAC, DO, OPT_SGA)).response).toEqual([IAC, WILL, OPT_SGA]);
  });

  it("answers DO TERMINAL-TYPE with WILL", () => {
    const n = new TelnetNegotiator();
    expect(feed(n, bytes(IAC, DO, OPT_TERMINAL_TYPE)).response).toEqual([IAC, WILL, OPT_TERMINAL_TYPE]);
  });

  // ⊘ An implementation that negotiates BINARY (an explicit non-goal) answers
  // WILL/DO here instead of the refusal.
  it("refuses every option it does not implement, BINARY included", () => {
    const n = new TelnetNegotiator();
    expect(feed(n, bytes(IAC, WILL, OPT_BINARY)).response).toEqual([IAC, DONT, OPT_BINARY]);
    expect(feed(n, bytes(IAC, DO, OPT_BINARY)).response).toEqual([IAC, WONT, OPT_BINARY]);
    expect(feed(n, bytes(IAC, WILL, 77)).response).toEqual([IAC, DONT, 77]);
    expect(feed(n, bytes(IAC, DO, 77)).response).toEqual([IAC, WONT, 77]);
  });

  it("refuses DO ECHO — we never echo for the remote side", () => {
    const n = new TelnetNegotiator();
    expect(feed(n, bytes(IAC, DO, OPT_ECHO)).response).toEqual([IAC, WONT, OPT_ECHO]);
  });

  // ⊘ THE REFUSAL LOOP. An implementation that answers unconditionally replies
  // to every repeat, and two such peers ping-pong forever. Each of the four
  // verbs is repeated here because a state table that tracks only one direction
  // still loops on the other.
  it("answers each option state ONCE — repeats of the same negotiation are silent", () => {
    const n = new TelnetNegotiator();
    expect(feed(n, bytes(IAC, WILL, OPT_ECHO)).response).toEqual([IAC, DO, OPT_ECHO]);
    expect(feed(n, bytes(IAC, WILL, OPT_ECHO)).response).toEqual([]);

    expect(feed(n, bytes(IAC, WILL, 77)).response).toEqual([IAC, DONT, 77]);
    expect(feed(n, bytes(IAC, WILL, 77)).response).toEqual([]);

    expect(feed(n, bytes(IAC, DO, OPT_SGA)).response).toEqual([IAC, WILL, OPT_SGA]);
    expect(feed(n, bytes(IAC, DO, OPT_SGA)).response).toEqual([]);

    expect(feed(n, bytes(IAC, DO, 88)).response).toEqual([IAC, WONT, 88]);
    expect(feed(n, bytes(IAC, DO, 88)).response).toEqual([]);
  });

  it("re-answers when the peer genuinely changes an option's state", () => {
    const n = new TelnetNegotiator();
    expect(feed(n, bytes(IAC, WILL, OPT_ECHO)).response).toEqual([IAC, DO, OPT_ECHO]);
    // The server withdraws it: state changes, so a DONT confirmation is owed.
    expect(feed(n, bytes(IAC, WONT, OPT_ECHO)).response).toEqual([IAC, DONT, OPT_ECHO]);
    expect(feed(n, bytes(IAC, WONT, OPT_ECHO)).response).toEqual([]);
    // And back again.
    expect(feed(n, bytes(IAC, WILL, OPT_ECHO)).response).toEqual([IAC, DO, OPT_ECHO]);
  });

  it("confirms DONT with WONT once", () => {
    const n = new TelnetNegotiator();
    expect(feed(n, bytes(IAC, DO, OPT_SGA)).response).toEqual([IAC, WILL, OPT_SGA]);
    expect(feed(n, bytes(IAC, DONT, OPT_SGA)).response).toEqual([IAC, WONT, OPT_SGA]);
    expect(feed(n, bytes(IAC, DONT, OPT_SGA)).response).toEqual([]);
  });
});

describe("TelnetNegotiator — TERMINAL-TYPE subnegotiation", () => {
  it("answers SEND with IS <terminal type>", () => {
    const n = new TelnetNegotiator({ terminalType: "vt100" });
    const { response } = feed(n, bytes(IAC, SB, OPT_TERMINAL_TYPE, TTYPE_SEND, IAC, SE));
    expect(response).toEqual([IAC, SB, OPT_TERMINAL_TYPE, TTYPE_IS, ...text("vt100"), IAC, SE]);
  });

  it("defaults the terminal type to xterm-256color", () => {
    const n = new TelnetNegotiator();
    const { response } = feed(n, bytes(IAC, SB, OPT_TERMINAL_TYPE, TTYPE_SEND, IAC, SE));
    expect(response).toEqual([
      IAC,
      SB,
      OPT_TERMINAL_TYPE,
      TTYPE_IS,
      ...text("xterm-256color"),
      IAC,
      SE
    ]);
  });

  it("ignores a TERMINAL-TYPE subnegotiation that is not SEND", () => {
    const n = new TelnetNegotiator();
    expect(feed(n, bytes(IAC, SB, OPT_TERMINAL_TYPE, TTYPE_IS, 0x61, IAC, SE)).response).toEqual([]);
  });

  it("ignores subnegotiations for options it does not implement", () => {
    const n = new TelnetNegotiator();
    expect(feed(n, bytes(IAC, SB, 99, 0x01, 0x02, IAC, SE)).response).toEqual([]);
  });
});

describe("TelnetNegotiator — NAWS", () => {
  it("answers DO NAWS with WILL NAWS followed by the current window size", () => {
    const n = new TelnetNegotiator({ initialColumns: 80, initialRows: 24 });
    const { response } = feed(n, bytes(IAC, DO, OPT_NAWS));
    expect(response).toEqual([
      IAC,
      WILL,
      OPT_NAWS,
      IAC,
      SB,
      OPT_NAWS,
      0x00,
      80,
      0x00,
      24,
      IAC,
      SE
    ]);
  });

  // ⊘ THE 0xFF DIMENSION BUG. A width of 255 puts a literal 0xFF in the payload;
  // unescaped, the server reads it as IAC and the subnegotiation desynchronizes.
  it("escapes a dimension byte that equals 0xFF as IAC IAC", () => {
    const n = new TelnetNegotiator({ initialColumns: 255, initialRows: 65535 });
    const { response } = feed(n, bytes(IAC, DO, OPT_NAWS));
    expect(response).toEqual([
      IAC,
      WILL,
      OPT_NAWS,
      IAC,
      SB,
      OPT_NAWS,
      0x00,
      0xff,
      0xff, // width low byte 0xFF, escaped
      0xff,
      0xff, // height high byte 0xFF, escaped
      0xff,
      0xff, // height low byte 0xFF, escaped
      IAC,
      SE
    ]);
  });

  it("re-sends the window size on every resize once NAWS is agreed", () => {
    const n = new TelnetNegotiator({ initialColumns: 80, initialRows: 24 });
    feed(n, bytes(IAC, DO, OPT_NAWS));
    expect([...n.setWindowSize(132, 43)]).toEqual([IAC, SB, OPT_NAWS, 0x00, 132, 0x00, 43, IAC, SE]);
    expect([...n.setWindowSize(100, 30)]).toEqual([IAC, SB, OPT_NAWS, 0x00, 100, 0x00, 30, IAC, SE]);
  });

  // ⊘ A implementation that sends NAWS unconditionally injects an unsolicited
  // subnegotiation into a session whose server never asked for one.
  it("sends nothing on resize while NAWS has not been agreed", () => {
    const n = new TelnetNegotiator({ initialColumns: 80, initialRows: 24 });
    expect([...n.setWindowSize(132, 43)]).toEqual([]);
  });

  it("reports the size the last resize set when NAWS is agreed later", () => {
    const n = new TelnetNegotiator({ initialColumns: 80, initialRows: 24 });
    n.setWindowSize(132, 43);
    const { response } = feed(n, bytes(IAC, DO, OPT_NAWS));
    expect(response).toEqual([IAC, WILL, OPT_NAWS, IAC, SB, OPT_NAWS, 0x00, 132, 0x00, 43, IAC, SE]);
  });

  it("clamps out-of-range dimensions into the 16-bit NAWS field", () => {
    const n = new TelnetNegotiator({ initialColumns: 0, initialRows: 0 });
    feed(n, bytes(IAC, DO, OPT_NAWS));
    expect([...n.setWindowSize(-5, 1_000_000)]).toEqual([
      IAC,
      SB,
      OPT_NAWS,
      0x00,
      0x00,
      0xff,
      0xff,
      0xff,
      0xff,
      IAC,
      SE
    ]);
  });
});

describe("TelnetNegotiator — outgoing encoding", () => {
  // ⊘ An encoder that does not escape 0xFF lets a single raw byte be read as IAC
  // by the server and silently eat the two bytes after it. Reachable only
  // through the Buffer overload — a `string` is UTF-8 encoded, and valid UTF-8
  // contains no 0xFF byte — which is exactly why the escape is applied to the
  // ENCODED bytes rather than to the source text.
  it("escapes an outgoing 0xFF byte as IAC IAC", () => {
    expect([...escapeIac(bytes(0x61, 0xff, 0x62))]).toEqual([0x61, IAC, IAC, 0x62]);
    expect([...escapeIac(bytes(IAC, IAC))]).toEqual([IAC, IAC, IAC, IAC]);
  });

  it("returns a buffer with nothing to escape unchanged, by reference", () => {
    const clean = bytes(0x61, 0x0d, 0x62);
    expect(escapeIac(clean)).toBe(clean);
  });

  it("translates a bare CR to the NVT newline CR LF", () => {
    const n = new TelnetNegotiator();
    expect(n.encodeOutgoing("show ver\r").toString("utf8")).toBe("show ver\r\n");
  });

  // ⊘ A naive `replace(/\r/g, "\r\n")` doubles the LF here.
  it("leaves an already-well-formed CR LF alone", () => {
    const n = new TelnetNegotiator();
    expect(n.encodeOutgoing("a\r\nb").toString("utf8")).toBe("a\r\nb");
  });

  it("promotes a lone LF to CR LF", () => {
    const n = new TelnetNegotiator();
    expect(n.encodeOutgoing("a\nb").toString("utf8")).toBe("a\r\nb");
  });

  it("passes ordinary keystrokes and control characters through untouched", () => {
    const n = new TelnetNegotiator();
    expect([...n.encodeOutgoing("\u0003")]).toEqual([0x03]);
    expect(n.encodeOutgoing("interface Gi0/1").toString("utf8")).toBe("interface Gi0/1");
  });

  it("encodes multibyte UTF-8 input as UTF-8 bytes", () => {
    const n = new TelnetNegotiator();
    expect([...n.encodeOutgoing("é")]).toEqual([0xc3, 0xa9]);
  });
});
