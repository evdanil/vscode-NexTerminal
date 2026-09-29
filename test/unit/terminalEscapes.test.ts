import { describe, expect, it } from "vitest";
import { isTerminalGeneratedReport, RESET_INTERACTIVE_MODES } from "../../src/services/terminal/terminalEscapes";

describe("RESET_INTERACTIVE_MODES", () => {
  it("clears input modes and shows the cursor", () => {
    expect(RESET_INTERACTIVE_MODES).toContain("\x1b[?9;1000;1002;1003;1004;1006;1016;2031;2004;1;66l");
    expect(RESET_INTERACTIVE_MODES).toContain("\x1b>");
    expect(RESET_INTERACTIVE_MODES).toContain("\x1b[?25h");
    expect(RESET_INTERACTIVE_MODES.indexOf("\x1b[<9999u")).toBeLessThan(RESET_INTERACTIVE_MODES.indexOf("\x1b[=0;1u"));
  });

  it("does not leave the alternate screen or full-reset the terminal", () => {
    expect(RESET_INTERACTIVE_MODES).not.toContain("1049");
    expect(RESET_INTERACTIVE_MODES).not.toContain("?47");
    expect(RESET_INTERACTIVE_MODES).not.toContain("\x1bc");
  });
});

describe("isTerminalGeneratedReport", () => {
  it("recognises focus, mouse and color-scheme reports", () => {
    for (const r of ["\x1b[I", "\x1b[O", "\x1b[<64;10;5M", "\x1b[<0;1;1m", "\x1b[M !!", "\x1b[?997;2n", "\x1b[I\x1b[O"]) {
      expect(isTerminalGeneratedReport(r)).toBe(true);
    }
  });

  it("treats real keys as keys", () => {
    for (const k of ["x", "\r", "\x03", "\x1b", "\x1b[A", "\x1bOA", "\x1b[Ix", "xx", ""]) {
      expect(isTerminalGeneratedReport(k)).toBe(false);
    }
  });
});
