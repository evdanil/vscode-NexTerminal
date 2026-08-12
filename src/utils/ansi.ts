// Matches ANSI escape sequences: CSI (ESC[... final byte @-~), OSC (ESC]...), and two-byte ESC sequences
// CSI final bytes cover the full range 0x40-0x7E (@-~), fixing incomplete parsing of sequences like \x1b[15~
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
// survives a mid-sequence cut is only `[0-9;?]*`, an alphabet no shipped rule
// can match, and safeCutIndex backs off from it explicitly.
//
// The durable fix is requiring the terminator here, so an unterminated OSC
// reads as incomplete and safeCutIndex protects it exactly as it protects an
// incomplete CSI. That is deliberately out of scope of the latency work: this
// regex is also the stripper for transcripts and capture buffers, where a
// never-terminated OSC would then stop stripping anything after it.
export function createAnsiRegex(): RegExp {
  return /\x1b(?:\[[0-9;?]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()#][A-Za-z0-9]|[A-Za-z])/g;
}
