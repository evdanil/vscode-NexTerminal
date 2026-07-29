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

  it("produces syntactically valid inline JavaScript", () => {
    // A safety net against TS-template-literal escaping mistakes (this file
    // hand-builds JS source as text) — this would have caught a stray
    // unescaped quote or an unintentionally "live" ${...} interpolation.
    const macros: TerminalMacro[] = [
      { name: "IPMI", text: "ipmitool -H $host", variables: [{ name: "host", label: "Host" }] }
    ];
    const html = render(macros, 0);
    const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const scriptBody = scriptMatch![1];
    expect(() => new Function(scriptBody)).not.toThrow();
  });

  describe("Variables section (§9.1-§9.4)", () => {
    it("places the Variables section between Text and the macro-level Secret checkbox", () => {
      const html = render([], null);
      const textIdx = html.indexOf('id="macro-text"');
      const variablesIdx = html.indexOf('id="variables-list"');
      const secretIdx = html.indexOf('id="macro-secret"');
      expect(textIdx).toBeGreaterThan(-1);
      expect(variablesIdx).toBeGreaterThan(textIdx);
      expect(secretIdx).toBeGreaterThan(variablesIdx);
    });

    it("renders the Add Variable button", () => {
      const html = render([], null);
      expect(html).toContain('id="add-variable-btn"');
      expect(html).toContain("+ Add Variable");
    });

    it("renders a hidden template row for cloning new rows in webview JS", () => {
      const html = render([], null);
      expect(html).toContain('id="variable-row-template"');
      expect(html).toContain("<template");
    });

    it("renders existing variable rows from macro.variables, HTML-escaped", () => {
      const macros: TerminalMacro[] = [
        {
          name: "IPMI",
          text: "ipmitool -H $host",
          variables: [{ name: "host", label: "<b>Host</b>", default: '10.0.0.1"' }]
        }
      ];
      const html = render(macros, 0);
      expect(html).toContain('class="var-name" value="host"');
      expect(html).toContain("&lt;b&gt;Host&lt;/b&gt;");
      expect(html).toContain("10.0.0.1&quot;");
      expect(html).not.toContain("<b>Host</b>");
    });

    it("never renders a default value or an enabled default field for a masked variable", () => {
      const macros: TerminalMacro[] = [
        { name: "IPMI", text: "$password", variables: [{ name: "password", secret: true, default: "leaked" }] }
      ];
      const html = render(macros, 0);
      expect(html).not.toContain("leaked");
      expect(html).toMatch(/class="var-default" value=""\s+disabled/);
    });

    it("uses 'Mask input (never stored)' and \"Don't remember\" — never a second 'Secret' checkbox label", () => {
      const macros: TerminalMacro[] = [
        { name: "IPMI", text: "$password", variables: [{ name: "password", secret: true }] }
      ];
      const html = render(macros, 0);
      expect(html).toContain("Mask input (never stored)");
      expect(html).toContain("Don't remember");
      // The macro-level Secret checkbox keeps its own distinct label text.
      expect(html).toContain("Secret (hide value in sidebar and pickers");
    });

    it("checks the Don't remember checkbox when remember is explicitly false", () => {
      const macros: TerminalMacro[] = [
        { name: "IPMI", text: "$host", variables: [{ name: "host", remember: false }] }
      ];
      const html = render(macros, 0);
      const rowMatch = html.match(/<div class="variable-row"[^>]*>[\s\S]*?<\/div>\s*<\/div>/);
      expect(rowMatch).not.toBeNull();
      expect(rowMatch![0]).toContain('class="var-remember" checked');
    });

    it("sets aria-label on the remove button referencing the variable's name", () => {
      const macros: TerminalMacro[] = [
        { name: "IPMI", text: "$host", variables: [{ name: "host" }] }
      ];
      const html = render(macros, 0);
      expect(html).toContain('aria-label="Remove variable host"');
    });

    it("renders a per-row error slot addressed by data-var-error", () => {
      const macros: TerminalMacro[] = [
        { name: "IPMI", text: "$host", variables: [{ name: "host" }] }
      ];
      const html = render(macros, 0);
      expect(html).toContain('data-var-error="0"');
    });

    it("caps the variable name input at 32 characters client-side", () => {
      const macros: TerminalMacro[] = [
        { name: "IPMI", text: "$host", variables: [{ name: "host" }] }
      ];
      const html = render(macros, 0);
      expect(html).toContain('maxlength="32"');
    });

    it("renders an array-level error slot for the Variables section header", () => {
      const html = render([], null);
      expect(html).toContain('id="error-variables"');
    });
  });

  describe("Live diagnostics under Text (§9.3)", () => {
    it("uses macroVariablesWebviewJs's scan — never a second scanner", () => {
      const html = render([], null);
      expect(html).toContain("function scanMacroPlaceholders(");
      expect(html).toContain("function isValidVariableName(");
      // Called by name from this file's own diagnostics code.
      expect(html).toContain("scanMacroPlaceholders(text, declaredNames)");
    });

    it("recomputes diagnostics on a ~300ms debounce", () => {
      const html = render([], null);
      expect(html).toContain("function scheduleDiagnostics()");
      expect(html).toContain("setTimeout(computeDiagnostics, 300)");
    });

    it("reserves fixed height for the diagnostics strip so hints don't bounce the layout", () => {
      const html = render([], null);
      expect(html).toContain('id="variables-diagnostics"');
    });

    it("wires an Add variable button into the undeclared-placeholder hint", () => {
      const html = render([], null);
      expect(html).toContain("is not declared and will be sent as-is.");
      expect(html).toContain("addVariableRow(name)");
    });

    it("wires the declared-but-unused hint", () => {
      const html = render([], null);
      expect(html).toContain("does not appear in the text.");
    });

    it("wires the positive confirmation", () => {
      const html = render([], null);
      expect(html).toContain("Will prompt for: ");
    });
  });

  describe("Live trigger-conflict warning (§9.4)", () => {
    it("renders a warning slot next to both the Variables header and the trigger field", () => {
      const html = render([], null);
      expect(html).toContain('id="variables-trigger-conflict"');
      expect(html).toContain('id="variables-trigger-conflict-2"');
    });

    it("wires updateTriggerConflictWarning to both the trigger field and variable-row changes", () => {
      const html = render([], null);
      expect(html).toContain("function updateTriggerConflictWarning()");
      expect(html).toContain("prompt for input or auto-trigger, not both");
      expect(html).toContain("use a Script with prompt()");
    });
  });

  describe("saveError protocol extension (§9.2, §9.5)", () => {
    it("routes field:'variable' saveError messages to the matching data-var-error slot and scrolls it into view", () => {
      const html = render([], null);
      expect(html).toContain('msg.field === "variable"');
      expect(html).toContain('data-var-error="');
      expect(html).toContain("scrollIntoView");
    });

    it("includes variables in the save postMessage payload", () => {
      const html = render([], null);
      expect(html).toContain("variables: variablesForSave");
      expect(html).toContain("collectVariablesForSave()");
    });
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
