import { describe, expect, it } from "vitest";
import { applySerialMacroNewline, isSerialUserInput, prepareSerialText } from "../../src/services/serial/serialUserInput";
import { resolveSerialMacroNewline } from "../../src/models/config";

describe("prepareSerialText", () => {
  it.each([
    ["a\nb", "crlf", "a\r\nb\r\n"],
    ["a\r\nb\rc\nd", "cr", "a\rb\rc\rd\r"],
    ["a\r\nb\rc\nd", "lf", "a\nb\nc\nd\n"],
    ["\na\n", "lf", "\na\n\n"],
    [" \ta\n\n", "cr", " \ta\r\r\r"],
    ["a\n", "cr", "a\r\r"],
    [" \r\na\r\n ", "none", " \r\na\r\n "],
    ["", "crlf", "\r\n"], ["", "cr", "\r"], ["", "lf", "\n"]
  ] as const)("converts %j with %s without trimming", (text, ending, expected) => {
    expect(prepareSerialText(text, ending)).toBe(expected);
  });
  it("refuses empty None and invalid line endings", () => {
    expect(() => prepareSerialText("", "none")).toThrow();
    expect(() => prepareSerialText("text", "bad" as never)).toThrow();
  });
  it("bounds the final UTF-8 payload, including converted and appended endings", () => {
    expect(Buffer.byteLength(prepareSerialText("é".repeat(32767), "crlf"))).toBe(65536);
    expect(() => prepareSerialText("é".repeat(32767) + "x", "crlf")).toThrow();
    expect(prepareSerialText("x".repeat(65536), "none")).toHaveLength(65536);
    expect(() => prepareSerialText("x".repeat(65537), "none")).toThrow();
    expect(() => prepareSerialText("\n".repeat(32768), "crlf")).toThrow();
  });
});

describe("isSerialUserInput", () => {
  it("requires the entire capability without invoking it", () => {
    const input = { getInputState() {}, onDidChangeInputState() {}, setDedicatedInputEnabled() {}, sendUserInput() {} };
    expect(isSerialUserInput(input)).toBe(true);
    for (const key of Object.keys(input)) {
      expect(isSerialUserInput({ ...input, [key]: undefined })).toBe(false);
    }
    for (const value of [null, undefined, {}, "serial"]) expect(isSerialUserInput(value)).toBe(false);
  });
});

describe("applySerialMacroNewline (issue #339)", () => {
  it.each([
    // Each \r?\n becomes exactly one ending: a CRLF pair is one newline, never two.
    ["a\nb\r\nc", "cr", "a\rb\rc"],
    ["a\nb\r\nc", "lf", "a\nb\nc"],
    ["a\nb\r\nc", "crlf", "a\r\nb\r\nc"],
    // A standalone CR is already Enter and is left alone, under every ending.
    ["a\rb\n", "lf", "a\rb\n"],
    ["a\rb\n", "crlf", "a\rb\r\n"],
    ["a\r\r\nb", "cr", "a\r\rb"],
    // Nothing is appended, and text with no newline is untouched.
    ["show run", "crlf", "show run"],
    ["", "crlf", ""],
    ["\n\n", "crlf", "\r\n\r\n"],
    [" \té\r\n\n", "cr", " \té\r\r"]
  ] as const)("converts %j with %s", (text, newline, expected) => {
    expect(applySerialMacroNewline(text, newline)).toBe(expected);
  });

  it.each([undefined, null, "", "CR", "Lf", "none", "\n", 1, {}, ["lf"]])("treats %j as CR", (setting) => {
    expect(applySerialMacroNewline("a\nb\r\n", setting)).toBe("a\rb\r");
    expect(resolveSerialMacroNewline(setting)).toBe("cr");
  });

  it("mirrors VS Code's sendText normalization when CR", () => {
    // terminalInstance.ts: text.replace(/\r?\n/g, '\r'). Any input must give the same bytes.
    for (const text of ["\r\n\r", "\n\r\n\r\r\n", "x\r\n\ny\rz", "\u2028\r\n"]) {
      expect(applySerialMacroNewline(text, undefined)).toBe(text.replace(/\r?\n/g, "\r"));
    }
  });
});
