import { describe, expect, it } from "vitest";
import { renderHighlightRuleEditorHtml } from "../../src/ui/highlightRuleEditorHtml";
import { openHighlightRuleEditor } from "../helpers/highlightRuleEditorHarness";
import type { HighlightRule } from "../../src/utils/highlightRuleValidation";

describe("renderHighlightRuleEditorHtml", () => {
  it("renders numeric SGR colors without coercing them to red", () => {
    const html = renderHighlightRuleEditorHtml([{ pattern: "x", color: "91" }], "nonce");
    expect(html).toContain('"color":"91"');
    expect(html).toContain("Custom SGR code");
  });

  it("renders staged apply controls and rule ordering controls", () => {
    const html = renderHighlightRuleEditorHtml([{ pattern: "x", color: "red" }], "nonce");
    expect(html).toContain("apply-rules-btn");
    expect(html).toContain("cancel-rules-btn");
    expect(html).toContain("rules-dirty-indicator");
    expect(html).toContain("recomputeDirty()");
    expect(html).toContain("Stage Rule");
    expect(html).toContain("rule-up-btn");
    expect(html).toContain("rule-down-btn");
  });

  it("uses real DOM text for the empty state", () => {
    const html = renderHighlightRuleEditorHtml([], "nonce");
    expect(html).toContain("rules-empty-state");
    expect(html).toContain("No highlighting rules defined.");
  });

  it("escapes rules before embedding them in inline scripts", () => {
    const html = renderHighlightRuleEditorHtml(
      [{ pattern: "</script><script>alert(1)</script>", color: "red" }],
      "nonce"
    );

    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003C/script\\u003E");
  });

  it("uses the shared regex safety script instead of local detector literals", () => {
    const html = renderHighlightRuleEditorHtml([{ pattern: "x", color: "red" }], "nonce");
    expect(html).toContain("function validateRegexSafety");
    expect(html).not.toContain("NESTED_QUANTIFIER_RE");
  });

  it("advances the preview cursor after non-global matches without duplicating the sample", () => {
    const html = renderHighlightRuleEditorHtml([{ pattern: "\\b0\\b", color: "red", flags: "i" }], "nonce");
    expect(html).toContain("lastIdx = match.index + match[0].length;");
    expect(html).not.toContain("lastIdx = regex.lastIndex;");
  });

  it("renders a per-row enable checkbox wired to toggle the rule's enabled field", () => {
    const html = renderHighlightRuleEditorHtml([{ pattern: "x", color: "red" }], "nonce");
    expect(html).toContain("rule-enabled-cb");
    expect(html).toContain("delete rule.enabled");
    expect(html).toContain("rule.enabled = false");
  });

  it("renders the label and description form fields above the pattern field", () => {
    const html = renderHighlightRuleEditorHtml([{ pattern: "x", color: "red" }], "nonce");
    expect(html).toContain("edit-label");
    expect(html).toContain("edit-description");
    expect(html).toContain("Label (optional)");
    expect(html).toContain("Description (optional)");
  });

  it("mentions the per-rule enable checkbox in the intro copy", () => {
    const html = renderHighlightRuleEditorHtml([], "nonce");
    expect(html).toMatch(/untick/i);
  });
});

describe("highlight rule editor — behavioral (rendered script against a stub DOM)", () => {
  it("shows the rule's label as primary text with the pattern as secondary text when present, and just the pattern when not", () => {
    const rules: HighlightRule[] = [
      { pattern: "\\bERROR\\b", color: "red", label: "Errors", description: "Matches error keyword" },
      { pattern: "\\bWARN\\b", color: "yellow" }
    ];
    const h = openHighlightRuleEditor(rules);

    // Behavioral, not string-matching: this fails if renderRulesList ever
    // drops the label branch, since the row would then show the pattern
    // itself as primary text (still a real string, but the wrong one).
    expect(h.rowLabel(0)).toBe("Errors");
    expect(h.rowPatternSecondary(0)).toBe("\\bERROR\\b");

    expect(h.rowLabel(1)).toBe("\\bWARN\\b");
    expect(h.rowPatternSecondary(1)).toBeUndefined();
  });

  it("dims disabled rows via a rule-disabled class, and leaves enabled rows undimmed", () => {
    const rules: HighlightRule[] = [
      { pattern: "\\bERROR\\b", color: "red" },
      { pattern: "\\bWARN\\b", color: "yellow", enabled: false }
    ];
    const h = openHighlightRuleEditor(rules);

    expect(h.rowDimmed(0)).toBe(false);
    expect(h.rowDimmed(1)).toBe(true);
    expect(h.rowEnabled(0)).toBe(true);
    expect(h.rowEnabled(1)).toBe(false);
  });

  it("toggling the row checkbox flips the rule's enabled field and re-renders the dimming", () => {
    const h = openHighlightRuleEditor([{ pattern: "\\bERROR\\b", color: "red" }]);
    expect(h.rowDimmed(0)).toBe(false);

    h.toggleEnabled(0);
    expect(h.rowDimmed(0)).toBe(true);
    expect(h.rowEnabled(0)).toBe(false);

    h.toggleEnabled(0);
    expect(h.rowDimmed(0)).toBe(false);
    expect(h.rowEnabled(0)).toBe(true);
  });

  it("clears dirty when a checkbox toggle is undone back to the original state", () => {
    const h = openHighlightRuleEditor([{ pattern: "\\bERROR\\b", color: "red" }]);
    expect(h.isDirty()).toBe(false);

    h.toggleEnabled(0);
    expect(h.isDirty()).toBe(true);

    h.toggleEnabled(0);
    expect(h.isDirty()).toBe(false);
  });

  it("clears dirty after untick/retick even when the rule was stored with an explicit enabled: true", () => {
    // The checkbox handler deletes `enabled` when re-ticking (so the saved
    // payload stays clean), but a rule imported/hand-written with an
    // explicit `enabled: true` never had that key removed to begin with. A
    // dirty check that diffs raw JSON sees "no key" vs. "enabled: true" as a
    // real difference and never clears — this fails against that unfixed
    // comparison.
    const h = openHighlightRuleEditor([{ pattern: "\\bERROR\\b", color: "red", enabled: true }]);
    expect(h.isDirty()).toBe(false);

    h.toggleEnabled(0);
    expect(h.isDirty()).toBe(true);

    h.toggleEnabled(0);
    expect(h.isDirty()).toBe(false);
  });

  it("REGRESSION (stale editingIndex on reorder): editing B then moving C above it must edit B's slot, leave C intact, and not cross-contaminate the enabled flag", () => {
    // Reproduces the exact defect: with rules [A, B, C(enabled:false)],
    // open the editor on B, move C above it, then Stage Rule. Against the
    // unpatched handler (editingIndex never adjusted on Up/Down) this
    // overwrites C's slot with the edited content, destroys C, duplicates
    // B, and — because the carry-over line reads rules[editingIndex], which
    // now points at C — copies C's `enabled: false` onto the edited rule.
    const rules: HighlightRule[] = [
      { pattern: "AAA", color: "red", label: "A" },
      { pattern: "BBB", color: "green", label: "B" },
      { pattern: "CCC", color: "yellow", label: "C", enabled: false }
    ];
    const h = openHighlightRuleEditor(rules);

    h.clickEdit(1); // open B
    expect(h.patternValue()).toBe("BBB");
    h.setLabel("B Edited");

    h.clickUp(2); // move C (index 2) above B — editingIndex must follow B, not stay at index 1

    h.stageRule();

    expect(h.rowCount()).toBe(3);
    // A is untouched at index 0.
    expect(h.rowLabel(0)).toBe("A");
    // C moved up to index 1 and is completely intact — not overwritten, not
    // carrying anyone else's data.
    expect(h.rowLabel(1)).toBe("C");
    expect(h.rowPatternSecondary(1)).toBe("CCC");
    expect(h.rowEnabled(1)).toBe(false);
    // B — displaced down to index 2 by the reorder — is the one that got
    // the edit, keeping its own pattern and its own (enabled) state, not
    // C's disabled flag.
    expect(h.rowLabel(2)).toBe("B Edited");
    expect(h.rowPatternSecondary(2)).toBe("BBB");
    expect(h.rowEnabled(2)).toBe(true);
  });

  it("REGRESSION mirror (Down): editing C then moving B below it must edit C's slot and leave B intact", () => {
    const rules: HighlightRule[] = [
      { pattern: "AAA", color: "red", label: "A" },
      { pattern: "BBB", color: "green", label: "B" },
      { pattern: "CCC", color: "yellow", label: "C", enabled: false }
    ];
    const h = openHighlightRuleEditor(rules);

    h.clickEdit(2); // open C
    h.setLabel("C Edited");

    // Clicking Down on B (index 1) swaps it with whatever is at index 2 (C):
    // B moves to index 2, C moves up to index 1 — editingIndex must follow C
    // to its new slot (index 1), not stay at 2.
    h.clickDown(1);

    h.stageRule();

    expect(h.rowCount()).toBe(3);
    expect(h.rowLabel(0)).toBe("A");
    // C — swapped up to index 1 by the Down click — is the one that got the
    // edit, keeping its own disabled state (not overwritten with B's).
    expect(h.rowLabel(1)).toBe("C Edited");
    expect(h.rowEnabled(1)).toBe(false);
    // B — displaced down to index 2 — is untouched.
    expect(h.rowLabel(2)).toBe("B");
    expect(h.rowEnabled(2)).toBe(true);
  });
});
