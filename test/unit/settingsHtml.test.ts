import { describe, expect, it } from "vitest";
import { renderSettingsHtml } from "../../src/ui/settingsHtml";
import { SETTINGS_META, CATEGORY_ORDER, CATEGORY_LABELS } from "../../src/ui/settingsMetadata";

function renderWithDefaults(): string {
  const values: Record<string, unknown> = {};
  for (const meta of SETTINGS_META) {
    const fullKey = `${meta.section}.${meta.key}`;
    switch (meta.type) {
      case "boolean": values[fullKey] = true; break;
      case "number": values[fullKey] = meta.min ?? 0; break;
      case "enum": values[fullKey] = meta.enumOptions?.[0]?.value ?? ""; break;
      case "directory": values[fullKey] = ""; break;
      case "string": values[fullKey] = ""; break;
      case "multi-checkbox": values[fullKey] = meta.checkboxOptions?.map((o) => o.value) ?? []; break;
    }
  }
  return renderSettingsHtml(values, "test-nonce-123");
}

describe("renderSettingsHtml", () => {
  it("contains all category section headings", () => {
    const html = renderWithDefaults();
    for (const cat of CATEGORY_ORDER) {
      const label = CATEGORY_LABELS[cat];
      expect(html).toContain(`id="section-${cat}"`);
      expect(html).toContain(label);
    }
  });

  it("renders all settings from metadata", () => {
    const html = renderWithDefaults();
    for (const meta of SETTINGS_META) {
      expect(html).toContain(meta.label);
      expect(html).toContain(`data-key="${meta.key}"`);
    }
  });

  it("includes CSP meta tag with nonce", () => {
    const html = renderWithDefaults();
    expect(html).toContain('nonce-test-nonce-123');
  });

  it("includes info banner about auto-save", () => {
    const html = renderWithDefaults();
    expect(html).toContain("auto-save");
    expect(html).toContain("info-banner");
  });

  it("renders enum settings with custom-select", () => {
    const html = renderWithDefaults();
    expect(html).toContain("custom-select");
    expect(html).toContain("Shared");
    expect(html).toContain("Isolated");
  });

  it("renders boolean settings with checkboxes", () => {
    const html = renderWithDefaults();
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Session Transcripts");
  });

  it("renders number settings with number inputs", () => {
    const html = renderWithDefaults();
    expect(html).toContain('type="number"');
    expect(html).toContain("MB");
  });

  it("renders directory settings with browse button", () => {
    const html = renderWithDefaults();
    expect(html).toContain("Browse");
    expect(html).toContain("Session Log Directory");
  });

  it("renders multi-checkbox settings", () => {
    const html = renderWithDefaults();
    expect(html).toContain("multi-checkbox-group");
    expect(html).toContain("Ctrl+B");
    expect(html).toContain("Ctrl+W");
  });

  it("includes Requires reload badge for SSH multiplexing", () => {
    const html = renderWithDefaults();
    expect(html).toContain("Requires reload");
    expect(html).toContain("setting-badge");
  });

  it("includes cross-link buttons", () => {
    const html = renderWithDefaults();
    expect(html).toContain("open-appearance-btn");
    expect(html).toContain("open-macros-btn");
    expect(html).toContain("open-highlighting-json");
  });

  it("includes reset all button", () => {
    const html = renderWithDefaults();
    expect(html).toContain("reset-all-btn");
    expect(html).toContain("Reset All to Defaults");
  });

  it("includes visibleWhen attributes for passthrough keys", () => {
    const html = renderWithDefaults();
    expect(html).toContain("data-visible-when-setting");
    expect(html).toContain("nexus.terminal.keyboardPassthrough");
  });

  it("includes save indicator elements", () => {
    const html = renderWithDefaults();
    expect(html).toContain("save-indicator");
  });
});
