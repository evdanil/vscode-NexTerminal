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
// triggers) close this gap for OSC/DCS/APC/PM/SOS and for CSI with
// stripChunk(), which holds an unfinished tail (at most 64 chars) until the
// next chunk. The highlighter cannot: it must emit what it has. There a DCS
// string split across chunks is stripped as a bare `ESC P` and its payload is
// left behind, the same known gap as OSC.
//
// The durable fix is requiring the terminator here, so an unterminated OSC
// reads as incomplete and safeCutIndex protects it exactly as it protects an
// incomplete CSI. That is deliberately out of scope of the latency work: this
// regex is also the stripper for transcripts and capture buffers, where a
// never-terminated OSC would then stop stripping anything after it.
export function createAnsiRegex(): RegExp {
  return /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x07\x1b]*\x1b\\|[ -/]*[0-Z\\^-~])/g;
}

// Longest trailing escape prefix a chunk-wise stripper will hold back. Real
// CSI/nF sequences and terminal titles are far shorter; the cap keeps a stray
// ESC from retaining data indefinitely.
const MAX_HELD_ESCAPE = 64;
const INCOMPLETE_ESCAPE_TAIL_RE = /\x1b(?:\[[0-?]*[ -/]*|[ -/]+)?$/;
// An OSC/DCS/APC/PM/SOS string still waiting for its terminator; a trailing
// ESC may be the first half of ST (`ESC \`).
const INCOMPLETE_STRING_TAIL_RE = /\x1b[\]PX^_][^\x07\x1b]*\x1b?$/;

/**
 * Index where a trailing, not-yet-complete escape sequence starts, or -1:
 * a CSI/nF escape, or an OSC/DCS/APC/PM/SOS string without its terminator.
 * A chunk-wise stripper must not strip such a tail (it would leave the rest as
 * text once it arrives); it holds the tail and prepends it to the next chunk.
 * Only the last {@link MAX_HELD_ESCAPE} characters are considered, so an
 * unterminated sequence is released as text rather than retained forever.
 */
export function findIncompleteEscapeStart(text: string): number {
  const windowStart = Math.max(0, text.length - MAX_HELD_ESCAPE);
  let start = -1;
  const esc = text.lastIndexOf("\x1b");
  if (esc >= windowStart && INCOMPLETE_ESCAPE_TAIL_RE.test(text.slice(esc))) {
    start = esc;
  }
  const str = INCOMPLETE_STRING_TAIL_RE.exec(text.slice(windowStart));
  if (str !== null) {
    const at = windowStart + str.index;
    start = start < 0 ? at : Math.min(start, at);
  }
  return start;
}

/**
 * Chunk-safe ANSI stripping: prepends the escape tail held back from the
 * previous chunk, strips everything complete, and returns the new tail to
 * carry. The carry belongs with the caller's stream state; it is not reset by
 * clearing a display or buffer, because the byte stream itself continues.
 */
export function stripChunk(carry: string, chunk: string): { text: string; carry: string } {
  const joined = carry + chunk;
  const hold = findIncompleteEscapeStart(joined);
  if (hold < 0) {
    return { text: joined.replace(createAnsiRegex(), ""), carry: "" };
  }
  return { text: joined.slice(0, hold).replace(createAnsiRegex(), ""), carry: joined.slice(hold) };
}
