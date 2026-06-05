import { describe, expect, it } from "vitest";
import { renderTerminalAppearanceHtml } from "../../src/ui/terminalAppearanceHtml";
import type { TerminalFontConfig } from "../../src/models/colorScheme";

const nonce = "test-nonce-appearance";

function render(font?: TerminalFontConfig): string {
  return renderTerminalAppearanceHtml([], "", font, nonce);
}

describe("renderTerminalAppearanceHtml", () => {
  it("includes CSP meta tag with nonce", () => {
    const html = render();
    expect(html).toContain(`nonce-${nonce}`);
  });

  it("renders the supplied font config into the inputs", () => {
    const html = render({ family: "Fira Code", size: 16, weight: "bold" });
    expect(html).toContain('id="font-family" value="Fira Code"');
    expect(html).toContain('id="font-size" min="8" max="72" value="16"');
    expect(html).toContain('id="font-weight" value="bold"');
  });

  // H2: the webview message handler must wire up the fontUpdated branch so an
  // external configuration change re-syncs the inputs.
  it("handles the fontUpdated message in the webview message listener", () => {
    const html = render();
    expect(html).toMatch(
      /msg\.type\s*===\s*"fontUpdated"\s*\)\s*\{\s*syncFontInputs\s*\(\s*msg\.font\s*\)\s*;/
    );
  });

  it("defines syncFontInputs to re-sync all three font inputs", () => {
    const html = render();
    expect(html).toContain("function syncFontInputs(font)");
    expect(html).toContain('document.getElementById("font-family").value');
    expect(html).toContain('document.getElementById("font-size").value');
    expect(html).toContain('document.getElementById("font-weight")');
  });

  it("still handles the schemesUpdated message (no regression)", () => {
    const html = render();
    expect(html).toMatch(/msg\.type\s*===\s*"schemesUpdated"/);
  });
});
