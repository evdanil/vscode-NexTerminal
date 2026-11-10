import { describe, expect, it } from "vitest";
import { isSerialUserInput, prepareSerialText } from "../../src/services/serial/serialUserInput";

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
