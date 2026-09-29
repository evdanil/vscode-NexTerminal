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
// Chunk-wise consumers (capture buffer, script buffer, transcripts, macro
// triggers) close this gap with stripChunk(): an unfinished CSI/nF escape (at
// most 64 chars) is held until the next chunk, and an unterminated
// OSC/DCS/APC/PM/SOS string switches to a "discarding" state that drops the
// payload across chunks until its terminator, giving up after 1 MiB. The
// highlighter cannot do this: it must emit what it has. There a DCS string
// split across chunks is stripped as a bare `ESC P` and its payload is left
// behind, the same known gap as OSC.
//
// The durable fix is requiring the terminator here, so an unterminated OSC
// reads as incomplete and safeCutIndex protects it exactly as it protects an
// incomplete CSI. That is deliberately out of scope of the latency work: this
// regex is also the stripper for transcripts and capture buffers, where a
// never-terminated OSC would then stop stripping anything after it.
// Byte classes are spelled as explicit hex ranges (ECMA-48): \x30-\x3F CSI
// parameter bytes, \x20-\x2F intermediate bytes, \x40-\x7E CSI final bytes,
// and \x30-\x5A \x5C \x5E-\x7E the two-byte ESC finals (0x30-0x7E without
// `[` 0x5B and `]` 0x5D, which introduce CSI and OSC).
export function createAnsiRegex(): RegExp {
  return /\x1b(?:\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x07\x1b]*\x1b\\|[\x20-\x2F]*[\x30-\x5A\x5C\x5E-\x7E])/g;
}

// Longest trailing CSI/nF escape prefix a chunk-wise stripper will hold back.
// Real sequences are far shorter; the cap keeps a stray ESC from retaining
// data indefinitely.
const MAX_HELD_ESCAPE = 64;
// An unterminated string sequence is discarded, not held, so its payload
// (Sixel, Kitty graphics and XTGETTCAP run to kilobytes) never becomes text.
// If no terminator arrives within this many characters the discard is
// abandoned and output resumes as ordinary text, so a lone `ESC P` in binary
// output cannot swallow the session.
const MAX_DISCARDED_STRING = 1024 * 1024;
const INCOMPLETE_ESCAPE_TAIL_RE = /\x1b(?:\[[\x30-\x3F]*[\x20-\x2F]*|[\x20-\x2F]+)?$/;
// An OSC/DCS/APC/PM/SOS string still waiting for its terminator; a trailing
// ESC may be the first half of ST (`ESC \`).
const INCOMPLETE_STRING_TAIL_RE = /\x1b[\]PX^_][^\x07\x1b]*\x1b?$/;

/**
 * State a chunk-wise stripper carries between chunks. Opaque to callers:
 * start from {@link EMPTY_STRIP_CARRY} and pass back what stripChunk returns.
 * It belongs with the caller's stream, not with a display: clearing a buffer
 * does not interrupt the byte stream, so it must not reset the carry.
 */
export interface StripCarry {
  /** Held CSI/nF prefix, or (while discarding) a lone trailing ESC that may start ST. */
  readonly tail: string;
  /** Terminator rules of the string being discarded: OSC ends at BEL or ST, the rest at ST only. */
  readonly discarding: "" | "osc" | "st";
  /** Characters dropped so far in the current discard, for the give-up bound. */
  readonly discarded: number;
}

export const EMPTY_STRIP_CARRY: StripCarry = { tail: "", discarding: "", discarded: 0 };

/**
 * Chunk-safe ANSI stripping. Returns the text with every complete escape
 * removed and the carry for the next chunk:
 * - a trailing incomplete CSI/nF escape is held (at most 64 chars);
 * - a trailing unterminated OSC/DCS/APC/PM/SOS string is dropped and the
 *   carry enters a discarding state that drops payload in later chunks until
 *   the terminator, resuming normal text after it (or after 1 MiB, or when a
 *   new ESC aborts the string).
 */
export function stripChunk(carry: StripCarry, chunk: string): { text: string; carry: StripCarry } {
  let joined = carry.tail + chunk;
  let text = "";

  if (carry.discarding !== "") {
    const end = (carry.discarding === "osc" ? /[\x07\x1b]/ : /\x1b/).exec(joined);
    if (end === null) {
      const discarded = carry.discarded + joined.length;
      if (discarded > MAX_DISCARDED_STRING) {
        // Give up: treat the rest as ordinary text, and never re-enter.
        return { text: joined.replace(createAnsiRegex(), ""), carry: EMPTY_STRIP_CARRY };
      }
      return { text: "", carry: { tail: "", discarding: carry.discarding, discarded } };
    }
    let resume = end.index;
    if (joined.charCodeAt(resume) === 0x07) {
      resume += 1;
    } else if (resume === joined.length - 1) {
      // ESC at the very end: it may be the first half of ST.
      return { text: "", carry: { tail: "\x1b", discarding: carry.discarding, discarded: carry.discarded + resume } };
    } else if (joined.charCodeAt(resume + 1) === 0x5c) {
      resume += 2;
    }
    // Any other ESC aborts the string and starts a new sequence at that ESC.
    joined = joined.slice(resume);
  }

  const stringTail = INCOMPLETE_STRING_TAIL_RE.exec(joined);
  if (stringTail !== null) {
    const at = stringTail.index;
    const half = stringTail[0].endsWith("\x1b") && stringTail[0].length > 2;
    text = joined.slice(0, at).replace(createAnsiRegex(), "");
    return {
      text,
      carry: {
        tail: half ? "\x1b" : "",
        discarding: joined.charCodeAt(at + 1) === 0x5d ? "osc" : "st",
        discarded: stringTail[0].length - (half ? 1 : 0)
      }
    };
  }

  const windowStart = Math.max(0, joined.length - MAX_HELD_ESCAPE);
  const esc = joined.lastIndexOf("\x1b");
  if (esc >= windowStart && INCOMPLETE_ESCAPE_TAIL_RE.test(joined.slice(esc))) {
    return { text: joined.slice(0, esc).replace(createAnsiRegex(), ""), carry: { tail: joined.slice(esc), discarding: "", discarded: 0 } };
  }
  return { text: joined.replace(createAnsiRegex(), ""), carry: EMPTY_STRIP_CARRY };
}
