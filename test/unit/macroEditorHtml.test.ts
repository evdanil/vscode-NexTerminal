import { describe, expect, it } from "vitest";
import { renderMacroEditorHtml } from "../../src/ui/macroEditorHtml";
import type { MacroVariable, TerminalMacro } from "../../src/models/terminalMacro";

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

  describe("the newline the HTML parser eats after <textarea>", () => {
    /** The raw child text of `#macro-text`, before any parsing. */
    function textareaSource(html: string): string {
      const match = html.match(/<textarea id="macro-text"[^>]*>([\s\S]*?)<\/textarea\s*>/i);
      expect(match).not.toBeNull();
      return match![1];
    }

    /**
     * What a spec-compliant parser hands the form element: "if the next token
     * is a U+000A LINE FEED character token, then ignore that token" (HTML
     * Standard, "in body" insertion mode, `textarea` start tag). Exactly one,
     * and only immediately after the start tag.
     */
    function afterParse(source: string): string {
      return source.startsWith("\n") ? source.slice(1) : source;
    }

    it("gives the parser a newline of its own to eat, so a leading blank line survives", () => {
      // Without a newline of ours the parser eats the macro's, the form comes
      // up one line short, and `MacroEditorPanel` saves `msg.text` verbatim —
      // so opening the editor on this macro and pressing Save with no edit at
      // all rewrites it, silently, to something the user did not type.
      const text = "\nsudo reboot\n";
      const source = textareaSource(render([{ name: "Leading blank", text }], 0));
      expect(source.startsWith("\n\n")).toBe(true);
      expect(afterParse(source)).toBe(text);
    });

    it("is a no-op for text that does not start with a newline", () => {
      const text = "sudo reboot\nexit\n";
      const source = textareaSource(render([{ name: "Ordinary", text }], 0));
      expect(afterParse(source)).toBe(text);
    });

    it("is a no-op for the empty new-macro form", () => {
      expect(afterParse(textareaSource(render([], null)))).toBe("");
    });
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
    // Case-insensitive, and the tag name is followed by a space-or-`>` rather
    // than by `[^>]*` alone: `<script` is emitted with an optional nonce
    // attribute (`formHtml.ts`), so the boundary has to be explicit or the
    // pattern would also claim a hypothetical `<scriptish>`. CodeQL's
    // `js/bad-tag-filter` flags the loose form.
    const scriptMatch = html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script\s*>/i);
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

    it("does not throw when a variable has a non-string label or default (legacy-absorption shape)", () => {
      const macros: TerminalMacro[] = [
        {
          name: "Legacy",
          text: "$host",
          variables: [{ name: "host", label: 42, default: 99 } as unknown as MacroVariable]
        }
      ];
      expect(() => render(macros, 0)).not.toThrow();
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

    // Fix 4: the strip must be BOUNDED, not just given a floor. `min-height` lets a
    // macro with several undeclared placeholders (one hint line each) grow the
    // strip without limit and push the controls below it around per keystroke —
    // exactly the layout-bounce this reserved strip exists to prevent. A fixed
    // `height` + `overflow-y: auto` caps it instead.
    it("bounds the diagnostics strip's height rather than only setting a minimum (Fix 4)", () => {
      const html = render([], null);
      const match = /\.variables-diagnostics\s*\{[^}]*\}/.exec(html);
      if (!match) throw new Error(".variables-diagnostics rule not found in the rendered CSS");
      const rule = match[0];
      expect(rule).toMatch(/(?<!-)height:\s*54px/); // bounded, not open-ended
      expect(rule).not.toMatch(/min-height:/);
      expect(rule).toContain("overflow-y: auto"); // content beyond the cap scrolls instead of expanding it
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

    // Fix 3: updateTriggerConflictWarning() now falls back to rowHasContent(row)
    // when no row has a declared name yet, so a row where the user typed only a
    // label (or ticked a box) still trips the conflict instead of hiding it until
    // Save. Same no-DOM environment as the "blank vs partially-filled variable
    // rows" block above: extract the real function from the rendered script (not
    // a hand-copied reimplementation) and execute it against stubs, rather than
    // asserting on source text — a pure-string assertion would pass even if the
    // fallback branch were deleted, as long as the literal identifier
    // "rowHasContent(row)" still appeared somewhere else in the file.
    describe("falls back to rowHasContent for undeclared rows (Fix 3)", () => {
      function extractUpdateTriggerConflictWarning(
        html: string
      ): (
        document: unknown,
        variablesList: unknown,
        rowHasContent: (row: unknown) => boolean,
        collectDeclaredVariableNames: () => string[],
        TRIGGER_CONFLICT_MESSAGE: string
      ) => () => void {
        const match = /function updateTriggerConflictWarning\(\) \{[\s\S]*?\n      \}/.exec(html);
        if (!match) throw new Error("updateTriggerConflictWarning() not found in the rendered script");
        return new Function(
          "document",
          "variablesList",
          "rowHasContent",
          "collectDeclaredVariableNames",
          "TRIGGER_CONFLICT_MESSAGE",
          `${match[0]}\nreturn updateTriggerConflictWarning;`
        ) as ReturnType<typeof extractUpdateTriggerConflictWarning>;
      }

      function stubWarningEl() {
        return { textContent: "", classes: {} as Record<string, boolean>, classList: undefined as unknown };
      }

      function makeHarness(triggerVal: string, pendingRows: unknown[]) {
        const w1 = stubWarningEl();
        const w2 = stubWarningEl();
        for (const w of [w1, w2]) {
          w.classList = { toggle: (cls: string, val: boolean) => { w.classes[cls] = val; } };
        }
        const elements: Record<string, unknown> = {
          "macro-trigger": { value: triggerVal },
          "variables-trigger-conflict": w1,
          "variables-trigger-conflict-2": w2
        };
        const stubDocument = { getElementById: (id: string) => elements[id] };
        const stubVariablesList = { querySelectorAll: () => pendingRows };
        return { w1, w2, stubDocument, stubVariablesList };
      }

      it("consults rowHasContent when no row has a declared name yet, and shows the conflict for a label-only row", () => {
        const html = render([], null);
        const updateTriggerConflictWarning = extractUpdateTriggerConflictWarning(html);
        const labelOnlyRow = { __marker: "label-only-row" };
        const { w1, w2, stubDocument, stubVariablesList } = makeHarness("router#", [labelOnlyRow]);

        let calledWith: unknown;
        const rowHasContent = (row: unknown) => {
          calledWith = row;
          return true; // simulates a row where the user typed only a label
        };
        const collectDeclaredVariableNames = () => []; // no row has a name yet

        const run = updateTriggerConflictWarning(
          stubDocument,
          stubVariablesList,
          rowHasContent,
          collectDeclaredVariableNames,
          "CONFLICT_MESSAGE"
        );
        run();

        expect(calledWith).toBe(labelOnlyRow); // the fallback actually reached the row
        expect(w1.textContent).toBe("CONFLICT_MESSAGE");
        expect(w2.textContent).toBe("CONFLICT_MESSAGE");
        expect(w1.classes.visible).toBe(true);
        expect(w2.classes.visible).toBe(true);
      });

      it("stays hidden when every pending row is wholly blank, even with a trigger pattern present", () => {
        const html = render([], null);
        const updateTriggerConflictWarning = extractUpdateTriggerConflictWarning(html);
        const blankRow = { __marker: "blank-row" };
        const { w1, w2, stubDocument, stubVariablesList } = makeHarness("router#", [blankRow]);

        const rowHasContent = () => false; // wholly untouched row
        const collectDeclaredVariableNames = () => [];

        const run = updateTriggerConflictWarning(
          stubDocument,
          stubVariablesList,
          rowHasContent,
          collectDeclaredVariableNames,
          "CONFLICT_MESSAGE"
        );
        run();

        expect(w1.textContent).toBe("");
        expect(w1.classes.visible).toBe(false);
      });

      it("does not fall back to rowHasContent when a row already has a declared name", () => {
        const html = render([], null);
        const updateTriggerConflictWarning = extractUpdateTriggerConflictWarning(html);
        const { w1, stubDocument, stubVariablesList } = makeHarness("router#", []);

        let rowHasContentCalled = false;
        const rowHasContent = () => { rowHasContentCalled = true; return false; };
        const collectDeclaredVariableNames = () => ["host"]; // already has a declared name

        const run = updateTriggerConflictWarning(
          stubDocument,
          stubVariablesList,
          rowHasContent,
          collectDeclaredVariableNames,
          "CONFLICT_MESSAGE"
        );
        run();

        expect(rowHasContentCalled).toBe(false); // short-circuited — hasVars already true
        expect(w1.classes.visible).toBe(true);
      });
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

  describe("blank vs partially-filled variable rows", () => {
    // `collectVariablesForSave()` drops any row with an empty name, so validation has
    // to be the thing that distinguishes "untouched row the user added by accident"
    // (skip silently — an extra row must never hard-block Save) from "row where a
    // label/default was typed and only the name is missing" (must be reported, or the
    // row vanishes on save with no explanation).
    //
    // The repo's vitest environment is "node" with no DOM, so rather than assert on
    // the source text — which would pass even if the logic were wrong — extract the
    // guard from the rendered script and run it against a stub row. It only ever
    // reads `.value` / `.checked` off querySelector results.
    function extractRowHasContent(html: string): (row: unknown) => boolean {
      const match = /function rowHasContent\(row\) \{[\s\S]*?\n      \}/.exec(html);
      if (!match) throw new Error("rowHasContent() not found in the rendered script");
      return new Function(`${match[0]}\nreturn rowHasContent;`)() as (row: unknown) => boolean;
    }

    function stubRow(fields: { label?: string; def?: string; secret?: boolean; remember?: boolean }) {
      const map: Record<string, { value: string; checked: boolean }> = {
        ".var-label": { value: fields.label ?? "", checked: false },
        ".var-default": { value: fields.def ?? "", checked: false },
        ".var-secret": { value: "", checked: !!fields.secret },
        ".var-remember": { value: "", checked: !!fields.remember }
      };
      return { querySelector: (sel: string) => map[sel] };
    }

    it("treats a wholly untouched row as empty", () => {
      const rowHasContent = extractRowHasContent(render([], null));
      expect(rowHasContent(stubRow({}))).toBe(false);
      expect(rowHasContent(stubRow({ label: "   " }))).toBe(false);
    });

    it("treats a row with any label, default, or ticked box as filled in", () => {
      const rowHasContent = extractRowHasContent(render([], null));
      expect(rowHasContent(stubRow({ label: "Target host" }))).toBe(true);
      expect(rowHasContent(stubRow({ def: "10.0.0.1" }))).toBe(true);
      expect(rowHasContent(stubRow({ secret: true }))).toBe(true);
      expect(rowHasContent(stubRow({ remember: true }))).toBe(true);
    });

    it("reports a missing name on a filled-in row rather than dropping it silently", () => {
      const html = render([], null);
      expect(html).toContain("rowHasContent(row)");
      expect(html).toContain("Variable name is required.");
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

  // NOTE: a whole-document sweep (every line of the fully rendered HTML) is NOT
  // used here because it also flags several PRE-EXISTING whitespace-only lines
  // that are unrelated to Fix 4 and out of scope for this change (reported
  // separately, not fixed): a leading "\n" in baseWebviewCss() (right after
  // `<style>`), a leading "\n" in baseWebviewJs() (right after `<script>`), a
  // leading "\n" in regexSafetyWebviewJs(), and the `${emptyStateHtml}` slot at
  // the top of the body template collapsing to a bare-indent line whenever at
  // least one macro exists. This guard is scoped to the exact call site Fix 4
  // changed — `${macroVariablesWebviewJs()}` embedded (indented) inside the
  // `<script>` block — so it fails only if THIS class of defect returns here.
  it("Fix 4 guard — no whitespace-only line immediately precedes the embedded macro-variable scan functions in the rendered HTML", () => {
    const html = render(
      [{ id: "m1", name: "Login", text: "login $password\n", variables: [{ name: "password", secret: true }] }],
      0
    );
    const lines = html.split("\n");
    const embedIndex = lines.findIndex((line) => line.includes("function isValidVariableName("));
    expect(embedIndex).toBeGreaterThan(0);
    const precedingLine = lines[embedIndex - 1];
    const isWhitespaceOnly = precedingLine.length > 0 && /^\s+$/.test(precedingLine);
    expect(isWhitespaceOnly).toBe(false);
  });
});

describe("renderMacroEditorHtml — Folder field (§4.11)", () => {
  it("renders the macro's existing group as the field value, with no notice", () => {
    const macros: TerminalMacro[] = [{ name: "M", text: "t", group: "Cisco/Routers" }];
    const html = renderMacroEditorHtml(macros, 0, nonce);
    expect(html).toContain('<input type="text" id="macro-folder" value="Cisco/Routers"');
    expect(html).not.toContain("shows at the root");
  });

  it("renders an empty value for a macro with no group", () => {
    const macros: TerminalMacro[] = [{ name: "M", text: "t" }];
    const html = renderMacroEditorHtml(macros, 0, nonce);
    expect(html).toContain('<input type="text" id="macro-folder" value=""');
    expect(html).not.toContain("shows at the root");
  });

  it("never crashes and renders blank for a malformed (§4.2) group", () => {
    const macros: TerminalMacro[] = [{ name: "M", text: "t", group: { bad: true } as unknown as string }];
    expect(() => renderMacroEditorHtml(macros, 0, nonce)).not.toThrow();
    const html = renderMacroEditorHtml(macros, 0, nonce);
    expect(html).toContain('<input type="text" id="macro-folder" value=""');
  });

  it("shows a stored-but-unrenderable group RAW, with a notice, instead of an empty field with nothing to correct", () => {
    // §4.9.3 promises such a value is "kept byte-for-byte and shown at the root
    // until you correct it". Sanitizing it away here made the editor — the one
    // surface where correcting it happens — display nothing to correct, and fed
    // the save handler an empty value that then destroyed the stored path.
    const macros: TerminalMacro[] = [{ name: "M", text: "t", group: "Cisco\\Routers" }];
    const html = renderMacroEditorHtml(macros, 0, nonce);
    expect(html).toContain('<input type="text" id="macro-folder" value="Cisco\\Routers"');
    expect(html).toContain("This folder path isn&#39;t usable, so this macro shows at the root.");
  });

  it("escapes an unrenderable group rather than injecting it — it is untrusted (§4.2) and now reaches the DOM", () => {
    const macros: TerminalMacro[] = [
      { name: "M", text: "t", group: '"><img src=x onerror=alert(1)>' }
    ];
    const html = renderMacroEditorHtml(macros, 0, nonce);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  it("withholds a group longer than the path cap from the DOM entirely, with its own notice", () => {
    // The bound exists so an 8 MB `group` (hand-written into settings.json and
    // absorbed verbatim) cannot be shipped into the webview on every render.
    const macros: TerminalMacro[] = [{ name: "M", text: "t", group: "X".repeat(8_000_000) }];
    const html = renderMacroEditorHtml(macros, 0, nonce);
    expect(html).toContain('<input type="text" id="macro-folder" value=""');
    expect(html).toContain("too long to show here");
    expect(html.length).toBeLessThan(1_000_000);
  });

  it("lists the supplied folders as combobox suggestions", () => {
    const html = renderMacroEditorHtml([], null, nonce, [], ["Cisco", "Juniper/Routers"]);
    expect(html).toContain('data-value="Cisco"');
    expect(html).toContain('data-value="Juniper/Routers"');
  });

  it("seeds the Folder field for a new (not-yet-saved) macro via the seedGroup param (§4.7 addToFolder)", () => {
    const html = renderMacroEditorHtml([], null, nonce, [], ["Cisco"], "Cisco");
    expect(html).toContain('<input type="text" id="macro-folder" value="Cisco"');
  });

  it("the seed is ignored once an existing macro is selected", () => {
    const macros: TerminalMacro[] = [{ name: "M", text: "t", group: "Juniper" }];
    const html = renderMacroEditorHtml(macros, 0, nonce, [], ["Cisco", "Juniper"], "Cisco");
    expect(html).toContain('<input type="text" id="macro-folder" value="Juniper"');
  });

  it("includes `group` in the save postMessage payload, read from the Folder input itself", () => {
    // Asserting only `group: folderVal || null` left the binding between the
    // payload and the DOM untested: `folderVal` sourced from any other element
    // id would still satisfy it. These two strings together pin both ends.
    // (A jsdom execution of the rendered script would be strictly better, but
    // vitest runs `environment: "node"` here and jsdom is not a dependency —
    // see the report's residual-risk note.)
    const html = render([], null);
    expect(html).toContain('var folderVal = document.getElementById("macro-folder").value.trim();');
    expect(html).toContain('group: folderVal || null');
    expect(html).toContain('variables: variablesForSave,');
  });

  it("calls initCustomComboboxes() so the Folder field's suggestion dropdown is wired up", () => {
    const html = render([], null);
    expect(html).toContain("initCustomComboboxes();");
  });
});
