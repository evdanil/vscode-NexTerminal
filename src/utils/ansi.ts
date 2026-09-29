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
// The same gap applies to a DCS/APC/PM/SOS string split across chunks: only a
// terminated one is removed whole, so a payload whose ST arrives in a later
// chunk is stripped as a bare `ESC P` and its text is left behind.
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
// CSI/nF sequences are far shorter; the cap keeps a stray ESC from retaining
// data indefinitely.
const MAX_HELD_ESCAPE = 64;
const INCOMPLETE_ESCAPE_TAIL_RE = /\x1b(?:\[[0-?]*[ -/]*|[ -/]+)?$/;

/**
 * Index where a trailing, not-yet-complete CSI / nF escape starts, or -1.
 * A chunk-wise stripper must not strip such a tail (it would leave the
 * fragment as text once the rest arrives); it holds it and prepends it to the
 * next chunk. Incomplete OSC/DCS are not reported: OSC matches without its
 * terminator by design (see the known gap above).
 */
export function findIncompleteEscapeStart(text: string): number {
  const esc = text.lastIndexOf("\x1b");
  if (esc < 0 || text.length - esc > MAX_HELD_ESCAPE) {
    return -1;
  }
  return INCOMPLETE_ESCAPE_TAIL_RE.test(text.slice(esc)) ? esc : -1;
}
