import { describe, expect, it } from "vitest";
import { renderMacroEditorHtml } from "../../src/ui/macroEditorHtml";
import type { TerminalMacro } from "../../src/ui/macroTreeProvider";

const nonce = "test-nonce-456";

function render(macros: TerminalMacro[], selectedIndex: number | null): string {
  return renderMacroEditorHtml(macros, selectedIndex, nonce);
}

describe("renderMacroEditorHtml", () => {
  it("includes CSP meta tag with nonce", () => {
    const html = render([], null);
    expect(html).toContain(`nonce-${nonce}`);
  });

  it("renders empty state with new macro form", () => {
    const html = render([], null);
    expect(html).toContain("macro-name");
    expect(html).toContain("macro-text");
    expect(html).toContain("Create");
  });

  it("renders macro selector with all macros", () => {
    const macros: TerminalMacro[] = [
      { name: "Hello", text: "echo hello" },
      { name: "Deploy", text: "npm run deploy" }
    ];
    const html = render(macros, 0);
    expect(html).toContain("Hello");
    expect(html).toContain("Deploy");
    expect(html).toContain("+ New Macro");
  });

  it("populates form fields when macro is selected", () => {
    const macros: TerminalMacro[] = [
      { name: "Greet", text: "echo hi\necho bye" }
    ];
    const html = render(macros, 0);
    expect(html).toContain('value="Greet"');
    expect(html).toContain("echo hi\necho bye");
    expect(html).toContain("Save");
  });

  it("shows Create button for new macro mode", () => {
    const macros: TerminalMacro[] = [
      { name: "Existing", text: "test" }
    ];
    const html = render(macros, null);
    expect(html).toContain("Create");
  });

  it("disables delete button for new macro", () => {
    const html = render([], null);
    expect(html).toContain("delete-btn");
    expect(html).toContain("disabled");
  });

  it("enables delete button for existing macro", () => {
    const macros: TerminalMacro[] = [
      { name: "Test", text: "test" }
    ];
    const html = render(macros, 0);
    expect(html).toContain("delete-btn");
    // The delete button should not have disabled attribute
    const deleteBtnMatch = html.match(/id="delete-btn"[^>]*/);
    expect(deleteBtnMatch?.[0]).not.toContain("disabled");
  });

  it("renders secret checkbox", () => {
    const html = render([], null);
    expect(html).toContain("macro-secret");
    expect(html).toContain("Secret");
  });

  it("checks secret checkbox when macro is secret", () => {
    const macros: TerminalMacro[] = [
      { name: "Password", text: "secret123", secret: true }
    ];
    const html = render(macros, 0);
    expect(html).toContain("checked");
  });

  it("renders slot selector with all 10 slots", () => {
    const html = render([], null);
    expect(html).toContain("slot-selector");
    expect(html).toContain("None");
    for (let s = 0; s <= 9; s++) {
      expect(html).toContain(`Alt+${s}`);
    }
  });

  it("shows current slot owner in dropdown", () => {
    const macros: TerminalMacro[] = [
      { name: "Alpha", text: "a", slot: 3 },
      { name: "Beta", text: "b" }
    ];
    const html = render(macros, 1);
    expect(html).toContain("Alpha");
    expect(html).toContain("Alt+3");
  });

  it("selects current macro slot in dropdown", () => {
    const macros: TerminalMacro[] = [
      { name: "Quick", text: "q", slot: 5 }
    ];
    const html = render(macros, 0);
    expect(html).toContain("Alt+5");
    // The slot trigger should show the assigned slot
    expect(html).toMatch(/custom-select-text[^<]*>Alt\+5/);
  });

  it("renders dirty state indicator", () => {
    const html = render([], null);
    expect(html).toContain("dirty-indicator");
    expect(html).toContain("dirty-flag");
    expect(html).toContain("Unsaved changes");
  });

  it("renders New Macro button", () => {
    const html = render([], null);
    expect(html).toContain("new-btn");
    expect(html).toContain("New Macro");
  });

  it("includes validation error placeholders", () => {
    const html = render([], null);
    expect(html).toContain("error-name");
    expect(html).toContain("error-text");
  });

  it("renders textarea with hint about newlines", () => {
    const html = render([], null);
    expect(html).toContain("editor-textarea");
    expect(html).toContain("newline");
  });
});
