import { describe, expect, it } from "vitest";
import { renderMacroEditorHtml } from "../../src/ui/macroEditorHtml";
import type { TerminalMacro } from "../../src/models/terminalMacro";

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

  it("renders an empty state with add and template actions when there are no macros", () => {
    const html = render([], null);
    expect(html).toContain("No macros yet");
    expect(html).toContain("empty-add-btn");
    expect(html).toContain("empty-template-btn");
    expect(html).toContain("Add Blank Macro");
    expect(html).toContain("Add Macro From Template");
  });

  it("routes empty-state actions through the dirty-discard guard", () => {
    const html = render([], null);
    expect(html).toContain("function requestNewMacro()");
    expect(html).toContain("function requestAddFromTemplate()");
    expect(html).toContain('type: "confirmSwitch", targetValue: "__new__"');
    expect(html).toContain('type: "confirmAddFromTemplate"');
    expect(html).toContain('emptyAddBtn.addEventListener("click", requestNewMacro)');
    expect(html).toContain('emptyTemplateBtn.addEventListener("click", requestAddFromTemplate)');
    expect(html).not.toContain('emptyTemplateBtn.addEventListener("click", function()');
  });

  it("renders macro selector with all macros", () => {
    const macros: TerminalMacro[] = [
      { name: "Hello", text: "echo hello" },
      { name: "Deploy", text: "npm run deploy" }
    ];
    const html = render(macros, 0);
    expect(html).toContain("Hello");
    expect(html).toContain("Deploy");
    expect(html).toContain("+ New Blank Macro");
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

  it("labels secret macro all-terminal scope as the compatibility default", () => {
    const macros: TerminalMacro[] = [
      { name: "Secret", text: "password", secret: true, triggerPattern: "Password:" }
    ];
    const html = render(macros, 0);
    expect(html).toContain("macro-trigger-scope");
    expect(html).toContain("All terminals (compatibility default)");
    expect(html).toContain("Recommended for secrets");
  });

  it("renders auto-trigger scope with the themed custom select", () => {
    const html = render([], null);
    expect(html).toContain('id="macro-trigger-scope-wrapper"');
    expect(html).toContain('input type="hidden" id="macro-trigger-scope"');
    expect(html).not.toContain('<select id="macro-trigger-scope">');
    expect(html).not.toContain("<option ");
  });

  it("renders binding input field", () => {
    const html = render([], null);
    expect(html).toContain("macro-binding");
    expect(html).toContain('placeholder="e.g., alt+m, alt+shift+5, ctrl+shift+a"');
  });

  it("renders start-paused checkbox for auto-triggers", () => {
    const html = render([], null);
    expect(html).toContain("macro-trigger-disabled");
    expect(html).toContain("Start auto-trigger paused");
  });

  it("renders trigger interval field for polling macros", () => {
    const html = render([], null);
    expect(html).toContain("macro-interval");
    expect(html).toContain("Trigger Interval");
    expect(html).toContain("An interval macro starts only when its pattern matches the active terminal");
    expect(html).toContain("delayed sends stay on that same session even if focus changes");
    expect(html).toContain("Later matches on the same session send immediately if the interval has elapsed");
    expect(html).toContain("Nexus does not send again until the pattern matches again");
    expect(html).not.toContain("without new terminal output");
  });

  it("describes macro text as exact saved text", () => {
    const html = render([], null);
    expect(html).toContain("Text is sent exactly as saved");
    expect(html).toContain("Press Enter in the textarea to include a newline");
    expect(html).not.toContain("Each line is sent as a separate command");
  });

  it("describes trigger patterns without slash delimiters or flags", () => {
    const html = render([], null);
    expect(html).toContain("Enter the JavaScript regex pattern only");
    expect(html).toContain("without surrounding /slashes/ or flags");
    expect(html).toContain("Avoid risky shapes like (.*)+");
    expect(html).toContain("use line-bounded text like [^\\n]*");
    expect(html).toContain("When matched, this macro's text is sent automatically");
  });

  it("shows current binding value when macro has keybinding", () => {
    const macros: TerminalMacro[] = [
      { name: "Quick", text: "q", keybinding: "alt+m" }
    ];
    const html = render(macros, 0);
    expect(html).toContain('value="alt+m"');
  });

  it("shows empty binding input when macro has no keybinding", () => {
    const macros: TerminalMacro[] = [
      { name: "Quick", text: "q" }
    ];
    const html = render(macros, 0);
    // The binding input should have empty value
    expect(html).toMatch(/id="macro-binding"[^>]*value=""/);
  });

  it("checks start-paused checkbox when macro starts disabled", () => {
    const macros: TerminalMacro[] = [
      { name: "Route", text: "show ip route 0.0.0.0\n", triggerPattern: "router#", triggerInitiallyDisabled: true }
    ];
    const html = render(macros, 0);
    expect(html).toMatch(/id="macro-trigger-disabled"[^>]*checked/);
  });

  it("shows trigger interval value when configured", () => {
    const macros: TerminalMacro[] = [
      { name: "Route", text: "show ip route 0.0.0.0\n", triggerPattern: "router#", triggerInterval: 10 }
    ];
    const html = render(macros, 0);
    expect(html).toMatch(/id="macro-interval"[^>]*value="10"/);
  });

  it("includes binding validation hint", () => {
    const html = render([], null);
    expect(html).toContain("Alt+S");
    expect(html).toContain("Alt+Shift");
    expect(html).toContain("Ctrl+Shift");
  });

  it("renders dirty state indicator", () => {
    const html = render([], null);
    expect(html).toContain("dirty-indicator");
    expect(html).toContain("dirty-flag");
    expect(html).toContain("Unsaved changes");
  });

  it("renders New Blank Macro button", () => {
    const html = render([], null);
    expect(html).toContain("new-btn");
    expect(html).toContain("New Blank Macro");
  });

  it("includes validation error placeholders", () => {
    const html = render([], null);
    expect(html).toContain("error-name");
    expect(html).toContain("error-text");
    expect(html).toContain("error-binding");
    expect(html).toContain("error-trigger-profile");
  });

  it("renders textarea with hint about newlines", () => {
    const html = render([], null);
    expect(html).toContain("editor-textarea");
    expect(html).toContain("newline");
  });

  it("includes client-side binding validation script", () => {
    const html = render([], null);
    expect(html).toContain("isValidBinding");
    expect(html).toContain("VALID_PATTERN");
  });

  it("includes client-side scope and regex safety validation", () => {
    const html = render([], null);
    expect(html).toContain("updateTriggerProfileState");
    expect(html).toContain('triggerVal && triggerScope === "profile" && !triggerProfileId');
    expect(html).toContain("validateRegexSafety");
    expect(html).not.toContain("NESTED_QUANTIFIER_RE");
  });

  it("renders matching profile choices by display name instead of raw ids", () => {
    const html = renderMacroEditorHtml([], null, nonce, [
      { id: "52a3b610-f871-462c-9541-20d13c0f7e56", name: "Core Router", kind: "server" },
      { id: "61a3b610-f871-462c-9541-20d13c0f7e57", name: "Core Router", kind: "serial" },
      { id: "console-1", name: "Lab Console", kind: "serial" }
    ]);

    expect(html).toContain("Core Router (Server, 52a3b610)");
    expect(html).toContain("Core Router (Serial, 61a3b610)");
    expect(html).toContain("Lab Console (Serial)");
    expect(html).not.toContain('placeholder="Server or serial profile id"');
    expect(html).not.toContain('type="text" id="macro-trigger-profile"');
  });
});
