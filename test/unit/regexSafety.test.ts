import { describe, expect, it } from "vitest";
import { validateRegexSafety } from "../../src/utils/regexSafety";

describe("validateRegexSafety", () => {
  it("rejects common catastrophic-backtracking shapes", () => {
    for (const pattern of [
      "(a+)+$",
      "^(a|aa)+$",
      "([a-z]+)*$",
      "(.+)+$",
      "^(?:a+)+$",
      "^(?:a|aa)+$",
      "^(a{1,})+$",
      "^(?:a{1,3})+$",
      "^(?:a|a{1,})+$"
    ]) {
      expect(validateRegexSafety(pattern).ok, pattern).toBe(false);
    }
  });

  it("accepts safe built-in-style terminal patterns", () => {
    expect(validateRegexSafety("\\bERROR\\b").ok).toBe(true);
    expect(validateRegexSafety("\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b").ok).toBe(true);
    expect(validateRegexSafety("(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}").ok).toBe(true);
  });
});
