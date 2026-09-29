import { describe, expect, it } from "vitest";
import { isTerminalGeneratedReport, RESET_INTERACTIVE_MODES } from "../../src/services/terminal/terminalEscapes";

// Every parameter of every DEC private-mode set/reset group (ESC[?...h / ESC[?...l),
// so an alternate-screen mode hidden inside a grouped list (";47") is still caught.
function privateModeParams(seq: string): string[] {
  return [...seq.matchAll(/\x1b\[\?([\d;]*)[hl]/g)].flatMap((m) => m[1].split(";"));
}

describe("RESET_INTERACTIVE_MODES", () => {
  it("clears input modes and shows the cursor", () => {
    expect(RESET_INTERACTIVE_MODES).toContain("\x1b[?9;1000;1002;1003;1004;1005;1006;1007;1015;1016;2031;2004;1;66l");
    expect(RESET_INTERACTIVE_MODES).toMatch(/\x1b\[\?[\d;]*\b1007\b[\d;]*l/);
    expect(RESET_INTERACTIVE_MODES).toContain("\x1b>");
    expect(RESET_INTERACTIVE_MODES).toContain("\x1b[?25h");
    expect(RESET_INTERACTIVE_MODES.indexOf("\x1b[<9999u")).toBeLessThan(RESET_INTERACTIVE_MODES.indexOf("\x1b[=0;1u"));
  });

  it("does not leave the alternate screen or full-reset the terminal", () => {
    const params = privateModeParams(RESET_INTERACTIVE_MODES);
    expect(params).toContain("1007");
    for (const alt of ["47", "1047", "1048", "1049"]) {
      expect(params).not.toContain(alt);
    }
    expect(RESET_INTERACTIVE_MODES).not.toContain("\x1bc");
  });
});

describe("isTerminalGeneratedReport", () => {
  it("recognises focus, mouse and color-scheme reports", () => {
    for (const r of ["\x1b[I", "\x1b[O", "\x1b[<64;10;5M", "\x1b[<0;1;1m", "\x1b[M !!", "\x1b[?997;2n", "\x1b[I\x1b[O", "\x1b[0;10;5M", "\x1b[32;10;5M\x1b[35;10;5M", "\x1b[A", "\x1b[B\x1b[B\x1b[B", "\x1bOA", "\x1bOB"]) {
      expect(isTerminalGeneratedReport(r)).toBe(true);
    }
  });

  it("treats real keys as keys", () => {
    for (const k of ["x", "\r", "\x03", "\x1b", "\x1b[C", "\x1b[D", "\x1bOC", "\x1b[Ax", "\x1b[2;5M", "\x1b[1;2;3;4M", "\x1b[0;10;5m", "\x1b[0;10M", "\x1b[Ix", "xx", ""]) {
      expect(isTerminalGeneratedReport(k)).toBe(false);
    }
  });
});
