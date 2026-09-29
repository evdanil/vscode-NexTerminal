// Matches ANSI escape sequences per ECMA-48:
//   - CSI: ESC [ + parameter bytes 0x30-0x3F (`0-?`, so `< = > ?` private
//     prefixes as well as digits and `;`) + intermediate bytes 0x20-0x2F
//     (` -/`) + final byte 0x40-0x7E (`@-~`). This covers Kitty keyboard
//     (`ESC[>1u`, `ESC[<u`, `ESC[=5;1u`), modifyOtherKeys (`ESC[>4;2m`), DA2,
//     DECSCUSR (`ESC[2 q`) and DECSTR (`ESC[!p`).
//   - OSC: ESC ] ... (terminator optional, see the known gap below).
//   - DCS/SOS/PM/APC: ESC P|X|^|_ ... ST, so payloads such as vim's XTGETTCAP
//     (`ESC P+q...ESC \`) are removed with their introducer. Only a terminated
//     string matches as a whole: an unterminated one must not swallow the
//     ordinary text that follows it.
//   - Two-byte / nF ESC sequences: optional intermediates 0x20-0x2F and a final
//     0x30-0x7E, which includes `ESC 7`, `ESC 8`, `ESC =`, `ESC >` and `ESC ( B`.
//     `ESC [` and `ESC ]` are excluded from the finals so an incomplete CSI or
//     OSC stays "incomplete" for TerminalHighlighterStream.safeCutIndex.
//
// KNOWN GAP — the OSC terminator is optional (`(?:\x07|\x1b\\)?`), so an OSC
// with no terminator *yet* matches as if it were complete. Every consumer that
// asks "does an escape sequence end here?" therefore answers no for a
// mid-arrival OSC: TerminalHighlighterStream's safeCutIndex() will happily cut
// after an unterminated `\x1b]0;…`, and the highlighter's apply() will treat
// what follows as plain text and colour tokens inside it. Confirmed: pushing
// `"\x1b]0;core-sw1 eth0 "` and then `"UP\x07$ "` more than one flush period
// later renders `\x1b[32mUP\x1b[39m\x07`, injecting SGR into a title string
// the terminal is still parsing — and titles routinely carry hostnames and
// IPv4s that the shipped rules match. Incomplete *CSI* is not affected: what
// survives a mid-sequence cut is only `[0-?]*[ -/]*` (parameter and
// intermediate bytes), and safeCutIndex backs off from it explicitly. That
// alphabet is wider than the old `[0-9;?]*` and now contains digits and dots,
// so the back-off is load-bearing, not merely defensive.
//
// The regex above is for the highlighter, which must emit what it has and so
// cannot carry state. Every chunk-wise consumer (capture buffer, script buffer,
// transcripts, macro triggers) uses stripChunk() below instead, a single-pass
// state machine over the same grammar with one invariant: the concatenated
// text is identical for ANY split of the input into chunks. In the highlighter
// a DCS string split across chunks is stripped as a bare `ESC P` and its
// payload is left behind, the same known gap as OSC.
//
// CAN (0x18) and SUB (0x1a) cancel a control string (OSC/DCS/APC/PM/SOS) per
// ECMA-48: both the whole-sequence match and the chunk-wise discard state end
// at them and consume the byte, so text after a cancelled string is kept.
//
// The single-byte 8-bit ST (U+009C) terminates a control string exactly like
// `ESC \`, in the same places. Only ST is recognised among the C1 controls:
// the 8-bit introducers (CSI 0x9B, OSC 0x9D, DCS 0x90, ...) are deliberately
// not handled here: widening the introducer set is a separate change.
//
// Only OSC ends at BEL. In DCS/APC/PM/SOS a BEL is ordinary payload (Sixel,
// Kitty graphics and XTGETTCAP data may contain it), so those payload classes
// do not exclude 0x07 and the "st" discard mode does not stop at it.
//
// Byte classes are spelled as explicit hex ranges (ECMA-48): \x30-\x3F CSI
// parameter bytes, \x20-\x2F intermediate bytes, \x40-\x7E CSI final bytes,
// and \x30-\x5A \x5C \x5E-\x7E the two-byte ESC finals (0x30-0x7E without
// `[` 0x5B and `]` 0x5D, which introduce CSI and OSC).
export function createAnsiRegex(): RegExp {
  return /\x1b(?:\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\][^\x07\x18\x1a\x1b\x9c]*(?:[\x07\x18\x1a\x9c]|\x1b\\)?|[PX^_][^\x18\x1a\x1b\x9c]*(?:\x1b\\|[\x18\x1a\x9c])|[\x20-\x2F]*[\x30-\x5A\x5C\x5E-\x7E])/g;
}

// Longest CSI/nF escape stripChunk() will treat as a sequence, ESC included.
// Real sequences are far shorter (a truecolor SGR with several colour
// parameters is under 100); a longer run is text, which only bounds memory and
// stray ESCs. It is a property of
// the grammar, not of chunking, so one-shot and chunked results still agree.
const MAX_ESCAPE_LENGTH = 512;
// Payload characters an unterminated string sequence may drop before it is
// abandoned and output resumes as ordinary text, so a lone `ESC P` in binary
// output cannot swallow the session. Sixel, Kitty graphics and XTGETTCAP
// payloads run to kilobytes, hence the generous bound.
const MAX_DISCARDED_STRING = 1024 * 1024;

const enum S {
  Text,
  Esc, // after ESC
  CsiParam, // ESC [ then parameter bytes
  CsiInter, // ... then intermediate bytes
  Nf, // ESC then intermediate bytes
  Osc, // discarding an OSC string
  OscEsc, // ... just saw ESC inside it
  Str, // discarding DCS/APC/PM/SOS
  StrEsc
}

/**
 * State a chunk-wise stripper carries between chunks. Opaque to callers:
 * start from {@link EMPTY_STRIP_CARRY} and pass back what stripChunk returns.
 * It belongs with the caller's stream, not with a display: clearing a buffer
 * does not interrupt the byte stream, so it must not reset the carry.
 */
export interface StripCarry {
  /** Parser state (opaque). */
  readonly state: number;
  /** Text of an escape still being recognised, emitted verbatim if it turns out not to be one. */
  readonly hold: string;
  /** Payload characters dropped so far in the current control string, for the give-up bound. */
  readonly discarded: number;
}

export const EMPTY_STRIP_CARRY: StripCarry = { state: S.Text, hold: "", discarded: 0 };

/**
 * Chunk-safe ANSI stripping as a single-pass state machine, ECMA-48 grammar:
 * - CSI (ESC [, parameter 0x30-0x3F, intermediate 0x20-0x2F, final 0x40-0x7E),
 *   two-byte and nF escapes (ESC, intermediates, final 0x30-0x7E) are removed;
 * - OSC, and DCS/APC/PM/SOS, payloads are dropped until their terminator: BEL
 *   (OSC only), `ESC \`, the 8-bit ST U+009C, or CAN/SUB, which consume the
 *   byte. An ESC followed by anything else aborts the string and starts a new
 *   sequence at that ESC;
 * - an escape that turns out malformed (or longer than 512 chars) is emitted
 *   as text, and the byte that broke it is reparsed as text.
 *
 * INVARIANT: for any input, calling this over any split into chunks (threading
 * the carry) yields the same concatenated `text` as one call over the whole
 * input. Nothing depends on where a chunk boundary falls; the only bounds are
 * per-sequence (512-char escape, `discardLimit` payload characters). Bytes of a
 * still-unfinished escape are held in the carry, so a trailing incomplete
 * escape is not in `text` yet.
 */
export function stripChunk(
  carry: StripCarry,
  chunk: string,
  discardLimit: number = MAX_DISCARDED_STRING
): { text: string; carry: StripCarry } {
  let state: number = carry.state;
  let hold = carry.hold;
  let discarded = carry.discarded;
  let text = "";
  let i = 0;
  const n = chunk.length;

  while (i < n) {
    if (state === S.Text) {
      const j = chunk.indexOf("\x1b", i);
      if (j < 0) {
        text += i === 0 ? chunk : chunk.slice(i);
        i = n;
        break;
      }
      text += chunk.slice(i, j);
      hold = "\x1b";
      state = S.Esc;
      i = j + 1;
      continue;
    }

    const c = chunk.charCodeAt(i);
    switch (state) {
      case S.Esc:
      case S.Nf: {
        if (state === S.Esc && c === 0x5b) {
          hold += "[";
          state = S.CsiParam;
        } else if (state === S.Esc && c === 0x5d) {
          hold = "";
          discarded = 0;
          state = S.Osc;
        } else if (state === S.Esc && (c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f)) {
          hold = "";
          discarded = 0;
          state = S.Str;
        } else if (c >= 0x20 && c <= 0x2f && hold.length < MAX_ESCAPE_LENGTH) {
          hold += chunk[i];
          state = S.Nf;
        } else if (c >= 0x30 && c <= 0x7e && c !== 0x5b && c !== 0x5d && hold.length < MAX_ESCAPE_LENGTH) {
          hold = "";
          state = S.Text;
        } else {
          text += hold;
          hold = "";
          state = S.Text;
          continue; // reparse this byte as text
        }
        i++;
        break;
      }
      case S.CsiParam:
      case S.CsiInter: {
        const tooLong = hold.length >= MAX_ESCAPE_LENGTH;
        if (!tooLong && state === S.CsiParam && c >= 0x30 && c <= 0x3f) {
          hold += chunk[i];
        } else if (!tooLong && c >= 0x20 && c <= 0x2f) {
          hold += chunk[i];
          state = S.CsiInter;
        } else if (!tooLong && c >= 0x40 && c <= 0x7e) {
          hold = "";
          state = S.Text;
        } else {
          text += hold;
          hold = "";
          state = S.Text;
          continue;
        }
        i++;
        break;
      }
      case S.Osc:
      case S.Str: {
        if (c === 0x18 || c === 0x1a || c === 0x9c || (state === S.Osc && c === 0x07)) {
          state = S.Text;
        } else if (c === 0x1b) {
          state = state === S.Osc ? S.OscEsc : S.StrEsc;
        } else if (discarded >= discardLimit) {
          // Cap reached: stop discarding; this byte and the rest are text. A
          // low surrogate here is orphaned by the cut (its high half was
          // dropped), so it goes too rather than start the text as a lone half.
          state = S.Text;
          if (c >= 0xdc00 && c <= 0xdfff) {
            i++;
          }
          continue;
        } else {
          discarded++;
        }
        i++;
        break;
      }
      default: {
        // OscEsc / StrEsc: ESC seen inside a control string.
        if (c === 0x5c || c === 0x18 || c === 0x1a || c === 0x9c) {
          state = S.Text;
          i++;
        } else {
          // Anything else aborts the string; the ESC starts a new sequence.
          hold = "\x1b";
          state = S.Esc;
          // reparse this byte in the Esc state
        }
        break;
      }
    }
  }

  return { text, carry: { state, hold, discarded } };
}
