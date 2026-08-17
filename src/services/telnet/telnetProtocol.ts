/**
 * The telnet (RFC 854) IAC state machine, as a PURE module: no `vscode` import,
 * no socket, no timers. `TelnetPty` owns the transport and calls in here for
 * every byte in both directions, which is what makes the protocol testable on
 * its own — the interesting failures (a sequence split across TCP chunks, a
 * refusal loop, an unescaped 0xFF in a NAWS payload) are all byte-level and none
 * of them need a socket to reproduce.
 *
 * SUBSET, DELIBERATELY. Implemented: ECHO (RFC 857) and SUPPRESS-GO-AHEAD
 * (RFC 858) on the server's side, SGA / TERMINAL-TYPE (RFC 1091) / NAWS
 * (RFC 1073) on ours. Everything else is refused. BINARY is NOT negotiated —
 * non-IAC bytes are passed through verbatim, so UTF-8 already works end to end
 * and asking for binary mode would only add a way for the two sides to disagree.
 * There is no authentication or encryption here because telnet has none; the use
 * case is lab gear and virtual-console servers on a trusted management network.
 *
 * KNOWN TRADE-OFF (MINOR-2, review) — a `CR` that ends a chunk is HELD until the
 * next byte arrives, because `CR NUL` and `CR LF` mean different things and TCP
 * is free to split the pair. The cost is that output ending in a bare `CR`
 * renders one packet late. The alternative — flushing a pending `CR` at the end
 * of every chunk — puts a stray `NUL` on screen every time a `CR LF` is split,
 * which is common on a busy session, so the latency is the cheaper of the two.
 * It is bounded in practice: a lone trailing `CR` only occurs when the peer has
 * more to send, and the very next byte releases it.
 */

/** Interpret As Command — the escape byte every telnet sequence starts with. */
export const IAC = 255;
/** End of subnegotiation. */
export const SE = 240;
/** Begin subnegotiation. */
export const SB = 250;
export const WILL = 251;
export const WONT = 252;
export const DO = 253;
export const DONT = 254;

export const OPT_BINARY = 0;
export const OPT_ECHO = 1;
export const OPT_SGA = 3;
export const OPT_TERMINAL_TYPE = 24;
export const OPT_NAWS = 31;

/** TERMINAL-TYPE subnegotiation commands (RFC 1091). */
const TTYPE_IS = 0;
const TTYPE_SEND = 1;

const CR = 0x0d;
const LF = 0x0a;
const NUL = 0x00;

/**
 * MAJOR-1 (review) — hard cap on a single subnegotiation's payload.
 *
 * WHY IT EXISTS. The `sb-payload` state accumulates every non-IAC byte, and the
 * only ways out were `IAC SE` or a malformed `IAC <x>`. Telnet is
 * unauthenticated, so a hostile or merely broken peer could open `IAC SB <opt>`
 * and stream forever: the array grew without bound until the extension host
 * died, with nothing on screen to say why. The same missing bound had a benign
 * face that was arguably worse — a device emitting a TRUNCATED subnegotiation
 * left the parser in `sb-payload` permanently, silently discarding every later
 * byte, so the terminal, the capture buffer, highlighting and any running script
 * all went dark with no recovery short of closing the tab.
 *
 * WHY 128. Every subnegotiation this client answers is tiny: NAWS is exactly 4
 * payload bytes and RFC 1091 bounds a terminal-type name at 40. 128 is generous
 * for both while being far below any interesting allocation.
 *
 * WHAT HAPPENS AT THE CAP: the subnegotiation is ABANDONED and the parser
 * returns to the data state — the same "abandon rather than swallow" escape the
 * `sb-iac` malformed branch already takes, and deliberately not a
 * discard-until-SE scan, which would keep a truncated subnegotiation wedged for
 * as long as the peer kept talking. The bytes that follow are therefore rendered
 * as ordinary output rather than eaten: noisy for one burst, but the session
 * stays alive and nothing is hidden from the user.
 */
const MAX_SUBNEGOTIATION_BYTES = 128;

const DEFAULT_TERMINAL_TYPE = "xterm-256color";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/**
 * Options the REMOTE side may turn on (we answer `DO`); everything else gets
 * `DONT`. ECHO means "the server echoes what I type", which is what every
 * network-OS console does and the reason a telnet terminal is not doubled up.
 */
const REMOTE_ACCEPTED = new Set([OPT_ECHO, OPT_SGA]);

/**
 * Options WE may turn on (we answer `WILL`); everything else gets `WONT`.
 * ECHO is deliberately absent — we never echo on the server's behalf.
 */
const LOCAL_ACCEPTED = new Set([OPT_SGA, OPT_TERMINAL_TYPE, OPT_NAWS]);

export interface TelnetNegotiatorOptions {
  /** Answered to a TERMINAL-TYPE `SEND`. Defaults to `xterm-256color`. */
  terminalType?: string;
  /** Window size reported through NAWS until the first `setWindowSize` call. */
  initialColumns?: number;
  initialRows?: number;
}

export interface TelnetReceiveResult {
  /** Application data: IAC sequences removed, `IAC IAC` unescaped, `CR NUL` collapsed. */
  data: Buffer;
  /** Protocol bytes owed to the peer. Empty when this chunk needed no answer. */
  response: Buffer;
}

type ParserState = "data" | "iac" | "negotiate" | "sb-option" | "sb-payload" | "sb-iac";

/** `undefined` = never answered; `true`/`false` = the last answer we sent. */
type OptionState = boolean | undefined;

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(0xffff, Math.trunc(value)));
}

/**
 * Append one byte of a subnegotiation payload, escaping `0xFF` as `IAC IAC`.
 *
 * THE NAWS 0xFF BUG this exists for: a terminal exactly 255 columns wide puts a
 * literal `0xFF` in the width field, and an unescaped one is read by the server
 * as the start of a command — it then eats the following bytes and the
 * subnegotiation never terminates. The same hazard applies to every payload byte
 * a subnegotiation carries, so the escape lives in the byte-append helper rather
 * than at any one call site.
 */
function pushEscaped(out: number[], byte: number): void {
  out.push(byte);
  if (byte === IAC) {
    out.push(IAC);
  }
}

/**
 * Escape every `0xFF` in an outbound buffer as `IAC IAC`, so a data byte can
 * never be read by the peer as the start of a command (which would make it eat
 * the two bytes after it).
 *
 * A SEPARATE EXPORTED FUNCTION rather than a branch inside `encodeOutgoing`,
 * and the reason is worth stating plainly: `encodeOutgoing` takes a `string`,
 * and a UTF-8 encode CANNOT produce a `0xFF` byte, so the escape is unreachable
 * through it today. It is kept as defence-in-depth for any future byte-level
 * writer, and it lives here so that invariant is directly testable instead of
 * being guarded by a parameter overload nothing calls (MINOR-5, review).
 *
 * Returns the input unchanged — no copy — when there is nothing to escape,
 * which is every ordinary keystroke.
 */
export function escapeIac(raw: Buffer): Buffer {
  if (!raw.includes(IAC)) {
    return raw;
  }
  const out: number[] = [];
  for (const byte of raw) {
    pushEscaped(out, byte);
  }
  return Buffer.from(out);
}

export class TelnetNegotiator {
  private readonly terminalType: string;
  private state: ParserState = "data";
  /** The verb (WILL/WONT/DO/DONT) whose option byte has not arrived yet. */
  private pendingVerb = 0;
  /** The option a subnegotiation is for; its payload accumulates in `sbPayload`. */
  private sbOption = 0;
  private sbPayload: number[] = [];
  /**
   * A `CR` seen in the data stream whose SUCCESSOR has not arrived yet. Held
   * across chunks on purpose: `CR NUL` and `CR LF` mean different things, and
   * TCP is free to split the pair. Flushing at the end of every chunk instead
   * would emit a stray `NUL` into the terminal on exactly that split.
   */
  private pendingCr = false;

  /** What we last told the peer about each option, per direction. */
  private readonly remoteState = new Map<number, OptionState>();
  private readonly localState = new Map<number, OptionState>();

  private columns: number;
  private rows: number;
  /** True once we have answered `DO NAWS` with `WILL NAWS`. */
  private nawsEnabled = false;

  public constructor(options: TelnetNegotiatorOptions = {}) {
    this.terminalType = options.terminalType ?? DEFAULT_TERMINAL_TYPE;
    this.columns = clampDimension(options.initialColumns ?? DEFAULT_COLUMNS);
    this.rows = clampDimension(options.initialRows ?? DEFAULT_ROWS);
  }

  /** The per-subnegotiation payload cap this parser enforces. */
  public get maxSubnegotiationBytes(): number {
    return MAX_SUBNEGOTIATION_BYTES;
  }

  /**
   * How many subnegotiation payload bytes are currently held. Never exceeds
   * `maxSubnegotiationBytes`; exposed so the DoS bound is directly assertable
   * rather than inferred from behaviour.
   */
  public get pendingSubnegotiationBytes(): number {
    return this.sbPayload.length;
  }

  /**
   * Consume one inbound chunk. Returns the application data it contained and
   * the protocol bytes owed back. The parser state persists across calls — a
   * chunk may end mid-sequence, which is the single most common way a hand-rolled
   * telnet client breaks.
   */
  public receive(chunk: Buffer): TelnetReceiveResult {
    const data: number[] = [];
    const response: number[] = [];

    for (const byte of chunk) {
      switch (this.state) {
        case "data":
          if (byte === IAC) {
            this.state = "iac";
          } else {
            this.consumeDataByte(byte, data);
          }
          break;
        case "iac":
          if (byte === IAC) {
            // Escaped 0xFF — a DATA byte, and it goes through the same CR
            // machinery as any other so `CR IAC IAC` cannot lose the CR.
            this.state = "data";
            this.consumeDataByte(byte, data);
          } else if (byte === SB) {
            this.state = "sb-option";
          } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
            this.pendingVerb = byte;
            this.state = "negotiate";
          } else {
            // A two-byte command with no option (NOP, Data Mark, Break, …).
            // Nothing here acts on one; dropping it is the correct NVT
            // behaviour for a client that implements no special functions.
            this.state = "data";
          }
          break;
        case "negotiate":
          this.answerNegotiation(this.pendingVerb, byte, response);
          this.state = "data";
          break;
        case "sb-option":
          this.sbOption = byte;
          this.sbPayload = [];
          this.state = "sb-payload";
          break;
        case "sb-payload":
          if (byte === IAC) {
            this.state = "sb-iac";
          } else if (this.sbPayload.length >= MAX_SUBNEGOTIATION_BYTES) {
            // Over the cap — abandon this subnegotiation and resync to data
            // (see MAX_SUBNEGOTIATION_BYTES). This byte is reprocessed AS DATA
            // rather than dropped, so the escape swallows nothing.
            this.sbPayload = [];
            this.state = "data";
            this.consumeDataByte(byte, data);
          } else {
            this.sbPayload.push(byte);
          }
          break;
        case "sb-iac":
          if (byte === SE) {
            this.answerSubnegotiation(this.sbOption, this.sbPayload, response);
            this.sbPayload = [];
            this.state = "data";
          } else if (byte === IAC) {
            // `IAC IAC` inside a payload is an escaped 0xFF, NOT the end.
            this.sbPayload.push(IAC);
            this.state = "sb-payload";
          } else {
            // Malformed: an IAC inside a subnegotiation followed by something
            // other than SE or IAC. Treat it as the command it looks like and
            // abandon the subnegotiation rather than swallowing the stream.
            this.sbPayload = [];
            this.state = "data";
          }
          break;
      }
    }

    return { data: Buffer.from(data), response: Buffer.from(response) };
  }

  /**
   * Record a new window size and return the NAWS subnegotiation to send, or an
   * EMPTY buffer while NAWS has not been agreed — an unsolicited subnegotiation
   * to a server that never asked for one is a protocol violation, and the size
   * is remembered either way so the first `DO NAWS` reports the current one.
   */
  public setWindowSize(columns: number, rows: number): Buffer {
    this.columns = clampDimension(columns);
    this.rows = clampDimension(rows);
    if (!this.nawsEnabled) {
      return Buffer.alloc(0);
    }
    return Buffer.from(this.nawsSubnegotiation());
  }

  /**
   * Encode outbound keystrokes / script writes: NVT newline translation (a
   * network-OS console expects `CR LF`, and a bare `CR` submits nothing on
   * plenty of them), UTF-8 encoding, then the `IAC IAC` escape.
   */
  public encodeOutgoing(text: string): Buffer {
    return escapeIac(Buffer.from(text.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"), "utf8"));
  }

  /**
   * RFC 854 NVT carriage-return rules, with the successor byte held across
   * chunks (see `pendingCr`): `CR NUL` is a bare carriage return and the NUL is
   * dropped; `CR LF` is a newline and passes through; `CR <other>` emits the CR
   * and then processes the byte normally.
   */
  private consumeDataByte(byte: number, out: number[]): void {
    if (this.pendingCr) {
      this.pendingCr = false;
      if (byte === NUL) {
        out.push(CR);
        return;
      }
      out.push(CR);
      if (byte === LF) {
        out.push(LF);
        return;
      }
      // Fall through so a second CR re-arms the hold.
    }
    if (byte === CR) {
      this.pendingCr = true;
      return;
    }
    out.push(byte);
  }

  /**
   * THE REFUSAL-LOOP GUARD, and the whole reason option state is tracked. A
   * client that answers every WILL/DO unconditionally will ping-pong forever
   * with a peer that does the same, so an answer is sent only when it CHANGES
   * what we last told the peer about that option. This is the standard
   * Q-method simplified to one bit per direction: we never initiate, so the
   * "awaiting reply" half of the real state machine has no states to occupy.
   */
  private answerNegotiation(verb: number, option: number, response: number[]): void {
    if (verb === WILL || verb === WONT) {
      const accept = verb === WILL && REMOTE_ACCEPTED.has(option);
      if (this.remoteState.get(option) === accept) {
        return;
      }
      this.remoteState.set(option, accept);
      response.push(IAC, accept ? DO : DONT, option);
      return;
    }

    const accept = verb === DO && LOCAL_ACCEPTED.has(option);
    if (this.localState.get(option) === accept) {
      return;
    }
    this.localState.set(option, accept);
    response.push(IAC, accept ? WILL : WONT, option);
    if (option === OPT_NAWS) {
      this.nawsEnabled = accept;
      if (accept) {
        // RFC 1073: the size follows the WILL immediately — a server that has
        // asked for NAWS is waiting for one before it sizes the session.
        response.push(...this.nawsSubnegotiation());
      }
    }
  }

  private answerSubnegotiation(option: number, payload: number[], response: number[]): void {
    if (option !== OPT_TERMINAL_TYPE || payload[0] !== TTYPE_SEND) {
      // Every other subnegotiation — including a TERMINAL-TYPE that is not a
      // SEND — is accepted off the wire and ignored. Answering an option we
      // never agreed to would be worse than silence.
      return;
    }
    response.push(IAC, SB, OPT_TERMINAL_TYPE, TTYPE_IS);
    for (const byte of Buffer.from(this.terminalType, "ascii")) {
      pushEscaped(response, byte);
    }
    response.push(IAC, SE);
  }

  /** `IAC SB NAWS <width16> <height16> IAC SE`, every payload byte 0xFF-escaped. */
  private nawsSubnegotiation(): number[] {
    const out: number[] = [IAC, SB, OPT_NAWS];
    pushEscaped(out, (this.columns >> 8) & 0xff);
    pushEscaped(out, this.columns & 0xff);
    pushEscaped(out, (this.rows >> 8) & 0xff);
    pushEscaped(out, this.rows & 0xff);
    out.push(IAC, SE);
    return out;
  }
}
