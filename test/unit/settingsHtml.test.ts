import { describe, expect, it } from "vitest";
import { renderSettingsHtml } from "../../src/ui/settingsHtml";
import { SETTINGS_META, CATEGORY_ORDER, CATEGORY_LABELS } from "../../src/ui/settingsMetadata";

function buildDefaultValues(): Record<string, unknown> {
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
  return values;
}

function renderWithDefaults(): string {
  return renderSettingsHtml(buildDefaultValues(), "test-nonce-123");
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
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).not.toContain('aria-hidden="true"');
    expect(html).toContain("Shared");
    expect(html).toContain("Isolated");
  });

  it("renders boolean settings with checkboxes", () => {
    const html = renderWithDefaults();
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Session Logging");
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

  it("renders safety badges and default value hints for advanced limits", () => {
    const html = renderWithDefaults();
    expect(html).toContain("Safety limit");
    expect(html).toContain("setting-badge-safety");
    expect(html).toContain("default: 30");
    expect(html).toContain("default: 300");
    expect(html).toContain("default: 100");
    expect(html).toContain("default: 10000");
  });

  it("includes cross-link buttons", () => {
    const html = renderWithDefaults();
    expect(html).toContain("open-appearance-btn");
    expect(html).toContain("open-macros-btn");
    expect(html).toContain("open-highlight-editor-btn");
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

  it("preserves zero values when refreshing config updates", () => {
    const html = renderWithDefaults();
    expect(html).toContain('vals[fullKey] == null ? "" : String(vals[fullKey])');
  });

  describe("categoryFilter", () => {
    it("renders only target category settings when filter is set", () => {
      const values = buildDefaultValues();
      const html = renderSettingsHtml(values, "test-nonce-123", "logging");
      // Should contain logging settings
      expect(html).toContain("Session Logging");
      expect(html).toContain("Max Log File Size");
      // Should NOT contain other category settings
      expect(html).not.toContain("Connection Multiplexing");
      expect(html).not.toContain("Open Location");
      expect(html).not.toContain("Directory Cache Duration");
    });

    it("omits category headings in focused mode", () => {
      const values = buildDefaultValues();
      const html = renderSettingsHtml(values, "test-nonce-123", "logging");
      expect(html).not.toContain('id="section-logging"');
      // h3 used for category headings should not appear
      expect(html).not.toContain("<h3");
    });

    it("omits cross-link button elements in focused mode", () => {
      const values = buildDefaultValues();
      const html = renderSettingsHtml(values, "test-nonce-123", "ssh");
      expect(html).not.toContain('id="open-appearance-btn"');
      expect(html).not.toContain('id="open-macros-btn"');
    });

    it("omits import/export button elements in focused mode", () => {
      const values = buildDefaultValues();
      const html = renderSettingsHtml(values, "test-nonce-123", "ssh");
      expect(html).not.toContain('id="backup-btn"');
      expect(html).not.toContain('id="share-btn"');
      expect(html).not.toContain('id="import-btn"');
    });

    it("omits danger zone elements in focused mode", () => {
      const values = buildDefaultValues();
      const html = renderSettingsHtml(values, "test-nonce-123", "ssh");
      expect(html).not.toContain('id="complete-reset-btn"');
      expect(html).not.toContain("Danger Zone");
    });

    it("includes per-category reset button in focused mode", () => {
      const values = buildDefaultValues();
      const html = renderSettingsHtml(values, "test-nonce-123", "logging");
      expect(html).toContain("reset-category-btn");
      expect(html).toContain('data-category="logging"');
    });

    it("includes a route back to all settings in focused mode", () => {
      const values = buildDefaultValues();
      const html = renderSettingsHtml(values, "test-nonce-123", "logging");
      expect(html).toContain("open-all-settings-btn");
      expect(html).toContain('type: "openAllSettings"');
    });

    it("wraps settings in .settings-card in focused mode", () => {
      const values = buildDefaultValues();
      const html = renderSettingsHtml(values, "test-nonce-123", "logging");
      expect(html).toContain("settings-card");
    });

    it("includes highlight editor button for terminal category", () => {
      const values = buildDefaultValues();
      const html = renderSettingsHtml(values, "test-nonce-123", "terminal");
      expect(html).toContain("open-highlight-editor-btn");
    });

    it("omits highlight editor button for non-terminal category", () => {
      const values = buildDefaultValues();
      const html = renderSettingsHtml(values, "test-nonce-123", "ssh");
      expect(html).not.toContain('id="open-highlight-editor-btn"');
    });

    it("renders everything when filter is undefined (backward compat)", () => {
      const values = buildDefaultValues();
      const html = renderSettingsHtml(values, "test-nonce-123", undefined);
      // Should contain all sections
      for (const cat of CATEGORY_ORDER) {
        expect(html).toContain(`id="section-${cat}"`);
      }
      expect(html).toContain("open-appearance-btn");
      expect(html).toContain("open-highlight-editor-btn");
      expect(html).toContain("backup-btn");
      expect(html).toContain("complete-reset-btn");
    });
  });
});
