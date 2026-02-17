// Matches ANSI escape sequences: CSI (ESC[... final byte @-~), OSC (ESC]...), and two-byte ESC sequences
// CSI final bytes cover the full range 0x40-0x7E (@-~), fixing incomplete parsing of sequences like \x1b[15~
export function createAnsiRegex(): RegExp {
  return /\x1b(?:\[[0-9;?]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()#][A-Za-z0-9]|[A-Za-z])/g;
}
