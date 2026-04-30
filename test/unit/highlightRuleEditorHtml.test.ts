import { describe, expect, it } from "vitest";
import { renderHighlightRuleEditorHtml } from "../../src/ui/highlightRuleEditorHtml";

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
    expect(html).toContain("setDirty(true)");
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
});
