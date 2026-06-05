import { describe, expect, it } from "vitest";
import { renderWebviewDocument } from "../../src/ui/shared/webviewDocument";
import { renderHighlightRuleEditorHtml } from "../../src/ui/highlightRuleEditorHtml";
import { renderMacroEditorHtml } from "../../src/ui/macroEditorHtml";
import { renderTerminalAppearanceHtml } from "../../src/ui/terminalAppearanceHtml";
import { renderAuthProfileEditorHtml } from "../../src/ui/authProfileEditorHtml";
import { renderSettingsHtml } from "../../src/ui/settingsHtml";
import { renderFormHtml } from "../../src/ui/formHtml";
import type { ColorScheme } from "../../src/models/colorScheme";

const NONCE = "VERIFY_NONCE";

const SCHEME: ColorScheme = {
  id: "s1",
  name: "Scheme",
  builtIn: false,
  foreground: "#fff",
  background: "#000",
  cursor: "#fff",
  selectionBackground: "#333",
  black: "#000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#fff"
};

/**
 * These snapshots lock the full rendered HTML of every panel builder so the
 * `renderWebviewDocument` consolidation stays byte-identical. They were
 * generated from the pre-refactor templates; any structural drift fails here.
 */
describe("webview document shell (byte-identity guard)", () => {
  it("highlight rule editor", () => {
    expect(
      renderHighlightRuleEditorHtml([{ pattern: "err", color: "red", flags: "i" }], NONCE)
    ).toMatchSnapshot();
  });

  it("macro editor", () => {
    expect(
      renderMacroEditorHtml(
        [{ name: "Hello", text: "echo hi", secret: true, triggerPattern: "x", triggerInterval: 5 }],
        0,
        NONCE,
        [{ id: "abc12345-0000-0000-0000-000000000000", name: "Router", kind: "server" }]
      )
    ).toMatchSnapshot();
  });

  it("terminal appearance", () => {
    expect(
      renderTerminalAppearanceHtml([SCHEME], "s1", { family: "Mono", size: 13, weight: "normal" }, NONCE)
    ).toMatchSnapshot();
  });

  it("auth profile editor", () => {
    expect(
      renderAuthProfileEditorHtml(
        [{ id: "p1", name: "Prof", username: "root", authType: "password" }],
        "p1",
        NONCE
      )
    ).toMatchSnapshot();
  });

  it("settings (all categories)", () => {
    expect(renderSettingsHtml({}, NONCE)).toMatchSnapshot();
  });

  it("settings (single category)", () => {
    expect(renderSettingsHtml({}, NONCE, "ssh")).toMatchSnapshot();
  });

  it("form with nonce", () => {
    expect(
      renderFormHtml({ title: "T", fields: [{ type: "text", key: "name", label: "Name", value: "v" }] }, NONCE)
    ).toMatchSnapshot();
  });

  it("form without nonce", () => {
    expect(
      renderFormHtml({ title: "T", fields: [{ type: "text", key: "name", label: "Name", value: "v" }] })
    ).toMatchSnapshot();
  });

  it("renderWebviewDocument emits CSP and nonce attributes when a nonce is given", () => {
    const html = renderWebviewDocument({ nonce: "abc", css: "  .x{}", body: "  <p>hi</p>", script: "  // js" });
    expect(html).toContain('content="default-src \'none\'; style-src \'nonce-abc\'; script-src \'nonce-abc\';"');
    expect(html).toContain('<style nonce="abc">');
    expect(html).toContain('<script nonce="abc">');
    expect(html).toContain("  .x{}");
    expect(html).toContain("  <p>hi</p>");
    expect(html).toContain("  // js");
  });

  it("renderWebviewDocument omits CSP and nonce attributes when no nonce is given", () => {
    const html = renderWebviewDocument({ css: "  .x{}", body: "  <p>hi</p>", script: "  // js" });
    expect(html).not.toContain("Content-Security-Policy");
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
  });
});
