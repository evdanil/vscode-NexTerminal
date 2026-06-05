import { describe, expect, it } from "vitest";
import { sanitizePassthroughKeys, ALL_PASSTHROUGH_KEYS } from "../../src/services/terminal/passthroughKeys";

describe("sanitizePassthroughKeys", () => {
  it("preserves a valid subset in its original order", () => {
    expect(sanitizePassthroughKeys(["b", "q", "w"])).toEqual(["b", "q", "w"]);
  });

  it("preserves a single valid entry", () => {
    expect(sanitizePassthroughKeys(["r"])).toEqual(["r"]);
  });

  it("accepts uppercase entries and returns them lowercased", () => {
    expect(sanitizePassthroughKeys(["B", "Q", "W"])).toEqual(["b", "q", "w"]);
  });

  it("accepts mixed-case entries", () => {
    expect(sanitizePassthroughKeys(["B", "q", "W"])).toEqual(["b", "q", "w"]);
  });

  it("deduplicates repeated entries, preserving first occurrence", () => {
    expect(sanitizePassthroughKeys(["b", "b", "q", "b"])).toEqual(["b", "q"]);
  });

  it("deduplicates case-insensitively", () => {
    expect(sanitizePassthroughKeys(["B", "b", "q"])).toEqual(["b", "q"]);
  });

  it("empty array falls back to full default set", () => {
    expect(sanitizePassthroughKeys([])).toEqual([...ALL_PASSTHROUGH_KEYS]);
  });

  it("undefined falls back to full default set", () => {
    expect(sanitizePassthroughKeys(undefined)).toEqual([...ALL_PASSTHROUGH_KEYS]);
  });

  it("null falls back to full default set", () => {
    expect(sanitizePassthroughKeys(null)).toEqual([...ALL_PASSTHROUGH_KEYS]);
  });

  it("string falls back to full default set", () => {
    expect(sanitizePassthroughKeys("b,q,w")).toEqual([...ALL_PASSTHROUGH_KEYS]);
  });

  it("number falls back to full default set", () => {
    expect(sanitizePassthroughKeys(42)).toEqual([...ALL_PASSTHROUGH_KEYS]);
  });

  it("plain object falls back to full default set", () => {
    expect(sanitizePassthroughKeys({ b: true, q: true })).toEqual([...ALL_PASSTHROUGH_KEYS]);
  });

  it("array of garbage (numbers, unknown letters) falls back to full default set", () => {
    expect(sanitizePassthroughKeys([1, 2, "z", "x", "foo"])).toEqual([...ALL_PASSTHROUGH_KEYS]);
  });

  it("mixed valid and invalid entries returns only the valid subset", () => {
    expect(sanitizePassthroughKeys(["b", "z", "q", 99, null, "x", "w"])).toEqual(["b", "q", "w"]);
  });

  it("full valid set is accepted unchanged", () => {
    expect(sanitizePassthroughKeys([...ALL_PASSTHROUGH_KEYS])).toEqual([...ALL_PASSTHROUGH_KEYS]);
  });

  it("returned default is a fresh copy — mutating it does not poison later calls", () => {
    const first = sanitizePassthroughKeys([]);
    first.length = 0; // wipe it
    const second = sanitizePassthroughKeys([]);
    expect(second).toEqual([...ALL_PASSTHROUGH_KEYS]);
  });
});
