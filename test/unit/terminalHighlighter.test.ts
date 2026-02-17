import { describe, expect, it, vi, beforeEach } from "vitest";

let mockConfig: Record<string, unknown> = {};

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue?: unknown) =>
        key in mockConfig ? mockConfig[key] : defaultValue
      )
    }))
  }
}));

import { TerminalHighlighter } from "../../src/services/terminalHighlighter";

function setConfig(enabled: boolean, rules: Array<Record<string, unknown>>): void {
  mockConfig = { enabled, rules };
}

describe("TerminalHighlighter", () => {
  beforeEach(() => {
    mockConfig = {};
  });

  it("highlights ERROR in plain text with red bold", () => {
    setConfig(true, [{ pattern: "\\bERROR\\b", color: "red", flags: "gi", bold: true }]);
    const h = new TerminalHighlighter();
    const result = h.apply("something ERROR happened");
    expect(result).toBe("something \x1b[31;1mERROR\x1b[39;22m happened");
  });

  it("returns input unchanged when disabled", () => {
    setConfig(false, [{ pattern: "\\bERROR\\b", color: "red", flags: "gi", bold: true }]);
    const h = new TerminalHighlighter();
    const input = "ERROR in logs";
    expect(h.apply(input)).toBe(input);
  });

  it("returns input unchanged when rules are empty", () => {
    setConfig(true, []);
    const h = new TerminalHighlighter();
    const input = "ERROR in logs";
    expect(h.apply(input)).toBe(input);
  });

  it("preserves existing ANSI sequences in output", () => {
    setConfig(true, [{ pattern: "\\bERROR\\b", color: "red", flags: "gi", bold: true }]);
    const h = new TerminalHighlighter();
    // Plain ERROR followed by an existing ANSI bold sequence
    const input = "ERROR \x1b[1mBOLD\x1b[0m";
    const result = h.apply(input);
    // ERROR should be highlighted, ANSI sequences preserved as-is
    expect(result).toContain("\x1b[31;1mERROR\x1b[39;22m");
    expect(result).toContain("\x1b[1m");
    expect(result).toContain("BOLD");
    expect(result).toContain("\x1b[0m");
  });

  it("skips highlighting inside color-active regions", () => {
    setConfig(true, [{ pattern: "\\bERROR\\b", color: "red", flags: "gi", bold: true }]);
    const h = new TerminalHighlighter();
    // ERROR inside a green foreground region — should NOT be highlighted
    const input = "\x1b[32mERROR\x1b[0m";
    const result = h.apply(input);
    expect(result).toBe("\x1b[32mERROR\x1b[0m");
  });

  it("highlights after color reset", () => {
    setConfig(true, [{ pattern: "\\bERROR\\b", color: "red", flags: "gi", bold: true }]);
    const h = new TerminalHighlighter();
    // ERROR inside colored region (no highlight), then ERROR after reset (should highlight)
    const input = "\x1b[32mERROR\x1b[0m ERROR";
    const result = h.apply(input);
    // First ERROR untouched, second highlighted
    expect(result).toBe("\x1b[32mERROR\x1b[0m \x1b[31;1mERROR\x1b[39;22m");
  });

  it("applies multiple rules", () => {
    setConfig(true, [
      { pattern: "\\bERROR\\b", color: "red", flags: "gi", bold: true },
      { pattern: "\\bINFO\\b", color: "cyan", flags: "gi" }
    ]);
    const h = new TerminalHighlighter();
    const result = h.apply("INFO: something ERROR");
    expect(result).toContain("\x1b[36mINFO\x1b[39m");
    expect(result).toContain("\x1b[31;1mERROR\x1b[39;22m");
  });

  it("applies bold SGR code", () => {
    setConfig(true, [{ pattern: "test", color: "green", flags: "gi", bold: true }]);
    const h = new TerminalHighlighter();
    const result = h.apply("test");
    expect(result).toBe("\x1b[32;1mtest\x1b[39;22m");
  });

  it("applies underline SGR code", () => {
    setConfig(true, [{ pattern: "link", color: "blue", flags: "gi", underline: true }]);
    const h = new TerminalHighlighter();
    const result = h.apply("link");
    expect(result).toBe("\x1b[34;4mlink\x1b[39;24m");
  });

  it("applies bold and underline together", () => {
    setConfig(true, [{ pattern: "both", color: "red", flags: "gi", bold: true, underline: true }]);
    const h = new TerminalHighlighter();
    const result = h.apply("both");
    expect(result).toBe("\x1b[31;1;4mboth\x1b[39;22;24m");
  });

  it("supports named colors", () => {
    const colors: Array<[string, number]> = [
      ["red", 31], ["green", 32], ["yellow", 33], ["blue", 34],
      ["magenta", 35], ["cyan", 36], ["white", 37],
      ["brightRed", 91], ["brightCyan", 96]
    ];
    for (const [name, code] of colors) {
      setConfig(true, [{ pattern: "x", color: name, flags: "g" }]);
      const h = new TerminalHighlighter();
      const result = h.apply("x");
      expect(result).toBe(`\x1b[${code}mx\x1b[39m`);
    }
  });

  it("supports raw SGR number as color", () => {
    setConfig(true, [{ pattern: "x", color: "91", flags: "g" }]);
    const h = new TerminalHighlighter();
    const result = h.apply("x");
    expect(result).toBe("\x1b[91mx\x1b[39m");
  });

  it("silently skips invalid regex patterns", () => {
    setConfig(true, [
      { pattern: "[invalid", color: "red", flags: "g" },
      { pattern: "OK", color: "green", flags: "g" }
    ]);
    const h = new TerminalHighlighter();
    const result = h.apply("OK");
    expect(result).toBe("\x1b[32mOK\x1b[39m");
  });

  it("skips rules with missing color", () => {
    setConfig(true, [{ pattern: "test", color: "" }]);
    const h = new TerminalHighlighter();
    expect(h.apply("test")).toBe("test");
  });

  it("default flags are case-insensitive", () => {
    setConfig(true, [{ pattern: "error", color: "red" }]);
    const h = new TerminalHighlighter();
    const result = h.apply("Error ERROR error");
    expect(result).toContain("\x1b[31mError\x1b[39m");
    expect(result).toContain("\x1b[31mERROR\x1b[39m");
    expect(result).toContain("\x1b[31merror\x1b[39m");
  });

  it("does not highlight inside extended foreground color (38;5;N)", () => {
    setConfig(true, [{ pattern: "\\bERROR\\b", color: "red", flags: "gi", bold: true }]);
    const h = new TerminalHighlighter();
    // 256-color foreground: \x1b[38;5;208m (orange)
    const input = "\x1b[38;5;208mERROR\x1b[0m";
    const result = h.apply(input);
    expect(result).toBe(input);
  });

  it("handles text with no ANSI sequences", () => {
    setConfig(true, [{ pattern: "hello", color: "green", flags: "gi" }]);
    const h = new TerminalHighlighter();
    expect(h.apply("hello world")).toBe("\x1b[32mhello\x1b[39m world");
  });

  it("handles text that is only ANSI sequences", () => {
    setConfig(true, [{ pattern: "hello", color: "green", flags: "gi" }]);
    const h = new TerminalHighlighter();
    const input = "\x1b[31m\x1b[0m";
    expect(h.apply(input)).toBe(input);
  });

  it("reload updates rules from config", () => {
    setConfig(true, [{ pattern: "\\bERROR\\b", color: "red", flags: "gi" }]);
    const h = new TerminalHighlighter();
    expect(h.apply("ERROR")).toContain("\x1b[31m");

    // Change config and reload
    setConfig(true, [{ pattern: "\\bWARN\\b", color: "yellow", flags: "gi" }]);
    h.reload();
    expect(h.apply("ERROR")).toBe("ERROR"); // no longer matched
    expect(h.apply("WARN")).toContain("\x1b[33m");
  });

  it("non-SGR ANSI sequences (CSI cursor moves) do not affect color tracking", () => {
    setConfig(true, [{ pattern: "\\bERROR\\b", color: "red", flags: "gi", bold: true }]);
    const h = new TerminalHighlighter();
    // Cursor move CSI sequence followed by plain ERROR
    const input = "\x1b[2AERROR";
    const result = h.apply(input);
    expect(result).toBe("\x1b[2A\x1b[31;1mERROR\x1b[39;22m");
  });

  it("bold-only SGR (no foreground) does not block highlighting", () => {
    setConfig(true, [{ pattern: "\\bERROR\\b", color: "red", flags: "gi", bold: true }]);
    const h = new TerminalHighlighter();
    // Bold without foreground color
    const input = "\x1b[1mERROR\x1b[0m";
    const result = h.apply(input);
    // Bold is not a foreground color, so ERROR should still be highlighted
    expect(result).toBe("\x1b[1m\x1b[31;1mERROR\x1b[39;22m\x1b[0m");
  });

  it("highlights MAC addresses", () => {
    setConfig(true, [{ pattern: "(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}", color: "magenta", flags: "g" }]);
    const h = new TerminalHighlighter();
    const result = h.apply("ether aa:bb:cc:dd:ee:ff");
    expect(result).toContain("\x1b[35maa:bb:cc:dd:ee:ff\x1b[39m");
  });

  it("highlights MAC addresses with dash separator", () => {
    setConfig(true, [{ pattern: "(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}", color: "magenta", flags: "g" }]);
    const h = new TerminalHighlighter();
    const result = h.apply("AA-BB-CC-DD-EE-FF");
    expect(result).toContain("\x1b[35mAA-BB-CC-DD-EE-FF\x1b[39m");
  });

  it("highlights IPv4 with CIDR notation", () => {
    setConfig(true, [{ pattern: "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(?:/\\d{1,2})?\\b", color: "magenta", flags: "g" }]);
    const h = new TerminalHighlighter();
    const result = h.apply("route 192.168.1.0/24 via 10.0.0.1");
    expect(result).toContain("\x1b[35m192.168.1.0/24\x1b[39m");
    expect(result).toContain("\x1b[35m10.0.0.1\x1b[39m");
  });

  it("highlights IPv6 addresses", () => {
    const ipv6Rule = { pattern: "[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){7}|(?:[0-9a-fA-F]{1,4}:){1,7}:[0-9a-fA-F]{1,4}|::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}", color: "magenta", flags: "g" };
    setConfig(true, [ipv6Rule]);
    const h = new TerminalHighlighter();
    expect(h.apply("addr fe80::1")).toContain("\x1b[35mfe80::1\x1b[39m");
    expect(h.apply("addr 2001:db8::1")).toContain("\x1b[35m2001:db8::1\x1b[39m");
    expect(h.apply("addr ::1")).toContain("\x1b[35m::1\x1b[39m");
    expect(h.apply("addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toContain("\x1b[35m2001:0db8:85a3:0000:0000:8a2e:0370:7334\x1b[39m");
  });

  it("highlights UUIDs", () => {
    setConfig(true, [{ pattern: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", color: "brightBlue", flags: "g" }]);
    const h = new TerminalHighlighter();
    const result = h.apply("id: 550e8400-e29b-41d4-a716-446655440000");
    expect(result).toContain("\x1b[94m550e8400-e29b-41d4-a716-446655440000\x1b[39m");
  });

  it("highlights network error counter labels", () => {
    setConfig(true, [{ pattern: "\\b(?:errors|dropped|overruns|collisions|discards|retransmits|failures|loss):", color: "red", flags: "gi" }]);
    const h = new TerminalHighlighter();
    const result = h.apply("RX errors: 0  dropped: 5  overruns: 0");
    expect(result).toContain("\x1b[31merrors:\x1b[39m");
    expect(result).toContain("\x1b[31mdropped:\x1b[39m");
    expect(result).toContain("\x1b[31moverruns:\x1b[39m");
  });

  it("highlights CRITICAL/FATAL with brightRed bold", () => {
    setConfig(true, [
      { pattern: "\\bCRITICAL\\b|\\bFATAL\\b|\\bPANIC\\b|\\bEMERG(?:ENCY)?\\b", color: "brightRed", flags: "gi", bold: true }
    ]);
    const h = new TerminalHighlighter();
    expect(h.apply("CRITICAL failure")).toContain("\x1b[91;1mCRITICAL\x1b[39;22m");
    expect(h.apply("FATAL error")).toContain("\x1b[91;1mFATAL\x1b[39;22m");
    expect(h.apply("kernel PANIC")).toContain("\x1b[91;1mPANIC\x1b[39;22m");
  });

  it("highlights state keywords: UP/DOWN/ACTIVE/INACTIVE", () => {
    setConfig(true, [
      { pattern: "\\bDOWN\\b|\\bINACTIVE\\b|\\bDISABLED\\b|\\bOFFLINE\\b", color: "red", flags: "gi" },
      { pattern: "\\bUP\\b|\\bACTIVE\\b|\\bENABLED\\b|\\bRUNNING\\b|\\bESTABLISHED\\b", color: "green", flags: "gi" }
    ]);
    const h = new TerminalHighlighter();
    expect(h.apply("eth0: DOWN")).toContain("\x1b[31mDOWN\x1b[39m");
    expect(h.apply("eth0: UP")).toContain("\x1b[32mUP\x1b[39m");
    expect(h.apply("state ESTABLISHED")).toContain("\x1b[32mESTABLISHED\x1b[39m");
  });

  it("highlights DENIED/REFUSED/TIMEOUT keywords", () => {
    setConfig(true, [
      { pattern: "\\bDENIED\\b|\\bREJECT(?:ED)?\\b|\\bREFUSED\\b|\\bFORBIDDEN\\b|\\bBLOCKED\\b", color: "red", flags: "gi" },
      { pattern: "\\bTIMEOUT\\b|\\bTIMED OUT\\b|\\bUNREACHABLE\\b", color: "red", flags: "gi" }
    ]);
    const h = new TerminalHighlighter();
    expect(h.apply("Connection REFUSED")).toContain("\x1b[31mREFUSED\x1b[39m");
    expect(h.apply("Permission DENIED")).toContain("\x1b[31mDENIED\x1b[39m");
    expect(h.apply("request TIMEOUT")).toContain("\x1b[31mTIMEOUT\x1b[39m");
  });

  it("highlights DEPRECATED with yellow underline", () => {
    setConfig(true, [{ pattern: "\\bDEPRECATED\\b", color: "yellow", flags: "gi", underline: true }]);
    const h = new TerminalHighlighter();
    const result = h.apply("this API is DEPRECATED");
    expect(result).toContain("\x1b[33;4mDEPRECATED\x1b[39;24m");
  });

  it("highlights DEBUG/TRACE with dim gray", () => {
    setConfig(true, [{ pattern: "\\bDEBUG\\b|\\bTRACE\\b", color: "brightBlack", flags: "gi" }]);
    const h = new TerminalHighlighter();
    expect(h.apply("[DEBUG] msg")).toContain("\x1b[90mDEBUG\x1b[39m");
    expect(h.apply("[TRACE] msg")).toContain("\x1b[90mTRACE\x1b[39m");
  });

  it("highlights PENDING/LISTENING keywords", () => {
    setConfig(true, [{ pattern: "\\bPENDING\\b|\\bWAITING\\b|\\bLISTENING\\b", color: "yellow", flags: "gi" }]);
    const h = new TerminalHighlighter();
    expect(h.apply("tcp LISTENING 0.0.0.0:22")).toContain("\x1b[33mLISTENING\x1b[39m");
    expect(h.apply("job PENDING")).toContain("\x1b[33mPENDING\x1b[39m");
  });

  // --- Security-focused tests ---

  it("SGR 39 (default foreground reset) resets colorActive", () => {
    setConfig(true, [{ pattern: "\\bERROR\\b", color: "red", flags: "gi", bold: true }]);
    const h = new TerminalHighlighter();
    // \x1b[32m sets fg green, \x1b[39m resets fg — ERROR after should be highlighted
    const input = "\x1b[32mtext\x1b[39m ERROR";
    const result = h.apply(input);
    expect(result).toContain("\x1b[31;1mERROR\x1b[39;22m");
  });

  it("invisible fg set/reset pair does NOT suppress highlighting", () => {
    setConfig(true, [{ pattern: "\\bERROR\\b", color: "red", flags: "gi", bold: true }]);
    const h = new TerminalHighlighter();
    // A hostile server sends \x1b[32m\x1b[39m — visually invisible but previously left colorActive=true
    const input = "\x1b[32m\x1b[39mERROR";
    const result = h.apply(input);
    expect(result).toContain("\x1b[31;1mERROR\x1b[39;22m");
  });

  it("input longer than 8192 chars passes through unchanged", () => {
    setConfig(true, [{ pattern: "\\bERROR\\b", color: "red", flags: "gi", bold: true }]);
    const h = new TerminalHighlighter();
    const longInput = "ERROR " + "x".repeat(8200);
    expect(h.apply(longInput)).toBe(longInput);
  });

  it("empty-match pattern is rejected (produces no highlighting)", () => {
    // \\b matches the empty string at word boundaries
    setConfig(true, [{ pattern: "\\b", color: "red", flags: "g" }]);
    const h = new TerminalHighlighter();
    expect(h.apply("hello")).toBe("hello");
  });

  it("raw SGR code outside foreground range is rejected", () => {
    // Code 8 = hidden text, should be rejected
    setConfig(true, [{ pattern: "secret", color: "8", flags: "g" }]);
    const h = new TerminalHighlighter();
    expect(h.apply("secret")).toBe("secret");
  });

  it("IPv6 pattern does NOT hang on backtracking input", () => {
    const ipv6Rule = { pattern: "[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){7}|(?:[0-9a-fA-F]{1,4}:){1,7}:[0-9a-fA-F]{1,4}|::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}", color: "magenta", flags: "g" };
    setConfig(true, [ipv6Rule]);
    const h = new TerminalHighlighter();
    // This input caused O(N^2) backtracking with the old pattern
    const hostile = "a:b:c:d:e:f:1:2:3:4:5:!";
    const start = performance.now();
    h.apply(hostile);
    const elapsed = performance.now() - start;
    // Should complete in well under 100ms; the old pattern could take seconds
    expect(elapsed).toBeLessThan(100);
  });

  it("invalid flags fall back to gi", () => {
    // 's' flag (dotAll) is not allowed
    setConfig(true, [{ pattern: "test", color: "red", flags: "gis" }]);
    const h = new TerminalHighlighter();
    const result = h.apply("TEST");
    // Should still match case-insensitively (fell back to "gi")
    expect(result).toContain("\x1b[31mTEST\x1b[39m");
  });

  it("CSI sequence with tilde final byte is recognized as ANSI, not plain text", () => {
    setConfig(true, [{ pattern: "\\bERROR\\b", color: "red", flags: "gi", bold: true }]);
    const h = new TerminalHighlighter();
    // \x1b[15~ is F5 key — should be consumed as ANSI, not leave ~ as plain text
    const input = "\x1b[15~ERROR";
    const result = h.apply(input);
    // The CSI sequence should be preserved, ERROR should be highlighted
    expect(result).toBe("\x1b[15~\x1b[31;1mERROR\x1b[39;22m");
  });
});
