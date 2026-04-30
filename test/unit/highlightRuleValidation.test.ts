import { describe, expect, it } from "vitest";
import { validateAndSanitizeHighlightRulesWithError } from "../../src/utils/highlightRuleValidation";

describe("validateAndSanitizeHighlightRulesWithError", () => {
  it("returns rule-specific safety errors", () => {
    const result = validateAndSanitizeHighlightRulesWithError([
      { pattern: "OK", color: "green", flags: "g" },
      { pattern: "^(a{1,})+$", color: "red", flags: "g" }
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Rule #2");
      expect(result.message).toContain("nested quantifiers");
    }
  });
});
