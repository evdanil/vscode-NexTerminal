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

  it("round-trips label, description, and enabled (both true and false)", () => {
    const result = validateAndSanitizeHighlightRulesWithError([
      { pattern: "OK", color: "green", flags: "g", label: "Success", description: "OK keyword", enabled: true },
      { pattern: "FAIL", color: "red", flags: "g", label: "Failure", description: "FAIL keyword", enabled: false }
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules[0]).toMatchObject({ label: "Success", description: "OK keyword", enabled: true });
    expect(result.rules[1]).toMatchObject({ label: "Failure", description: "FAIL keyword", enabled: false });
  });

  it("omits an empty-string label and description instead of keeping the empty string", () => {
    const result = validateAndSanitizeHighlightRulesWithError([
      { pattern: "OK", color: "green", flags: "g", label: "", description: "" }
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules[0].label).toBeUndefined();
    expect(result.rules[0].description).toBeUndefined();
  });

  it("truncates an over-length label to the cap instead of failing the whole array", () => {
    // Label/description are cosmetic (editor display only) — an over-length
    // value from a hand-edited settings.json must not blank the whole rule
    // list. A validator that still hard-fails here would return ok:false and
    // this assertion would catch it.
    const result = validateAndSanitizeHighlightRulesWithError([
      { pattern: "OK", color: "green", flags: "g" },
      { pattern: "FAIL", color: "red", flags: "g", label: "x".repeat(150) }
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules).toHaveLength(2);
    expect(result.rules[1].label).toBe("x".repeat(100));
    expect(result.rules[1].label!.length).toBe(100);
  });

  it("truncates an over-length description to the cap instead of failing the whole array", () => {
    const result = validateAndSanitizeHighlightRulesWithError([
      { pattern: "OK", color: "green", flags: "g" },
      { pattern: "FAIL", color: "red", flags: "g", description: "x".repeat(600) }
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules).toHaveLength(2);
    expect(result.rules[1].description).toBe("x".repeat(500));
    expect(result.rules[1].description!.length).toBe(500);
  });

  it("silently drops a non-string label while the rule survives", () => {
    const result = validateAndSanitizeHighlightRulesWithError([
      { pattern: "OK", color: "green", flags: "g", label: 123 }
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].label).toBeUndefined();
    expect(result.rules[0].pattern).toBe("OK");
  });

  it("treats a non-boolean enabled value as disabled (fails closed) rather than dropping it", () => {
    // Unlike label/flags/bold, `enabled` gates whether an expensive pattern
    // actually runs. A validator that drops the malformed value (leaving the
    // rule at its absent-means-enabled default) would silently re-enable a
    // rule the user explicitly turned off — this must never happen.
    const result = validateAndSanitizeHighlightRulesWithError([
      { pattern: "OK", color: "green", flags: "g", enabled: "false" }
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].enabled).toBe(false);
  });

  it("leaves enabled undefined (default-enabled) when the field is simply absent", () => {
    const result = validateAndSanitizeHighlightRulesWithError([
      { pattern: "OK", color: "green", flags: "g" }
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules[0].enabled).toBeUndefined();
  });
});
