import { describe, expect, it } from "vitest";
import { formatSettingValueForTree, CATEGORY_ICONS, type SettingMeta } from "../../src/ui/settingsMetadata";

describe("CATEGORY_ICONS", () => {
  it("has an icon for every category", () => {
    const expectedCategories = ["logging", "ssh", "tunnels", "terminal", "sftp", "highlighting"];
    for (const cat of expectedCategories) {
      expect(CATEGORY_ICONS[cat]).toBeDefined();
      expect(typeof CATEGORY_ICONS[cat]).toBe("string");
    }
  });
});

describe("formatSettingValueForTree", () => {
  it("formats boolean true as ON", () => {
    const meta: SettingMeta = { key: "x", section: "s", label: "X", type: "boolean", category: "logging" };
    expect(formatSettingValueForTree(meta, true)).toBe("ON");
  });

  it("formats boolean false as OFF", () => {
    const meta: SettingMeta = { key: "x", section: "s", label: "X", type: "boolean", category: "logging" };
    expect(formatSettingValueForTree(meta, false)).toBe("OFF");
  });

  it("formats number with unit", () => {
    const meta: SettingMeta = { key: "x", section: "s", label: "X", type: "number", category: "logging", unit: "MB", min: 1 };
    expect(formatSettingValueForTree(meta, 10)).toBe("10 MB");
  });

  it("formats number without unit", () => {
    const meta: SettingMeta = { key: "x", section: "s", label: "X", type: "number", category: "logging", min: 0 };
    expect(formatSettingValueForTree(meta, 5)).toBe("5");
  });

  it("formats number falling back to min when not a number", () => {
    const meta: SettingMeta = { key: "x", section: "s", label: "X", type: "number", category: "logging", min: 1, unit: "seconds" };
    expect(formatSettingValueForTree(meta, undefined)).toBe("1 seconds");
  });

  it("formats directory with value", () => {
    const meta: SettingMeta = { key: "x", section: "s", label: "X", type: "directory", category: "logging" };
    expect(formatSettingValueForTree(meta, "/tmp/logs")).toBe("/tmp/logs");
  });

  it("formats empty directory as (default)", () => {
    const meta: SettingMeta = { key: "x", section: "s", label: "X", type: "directory", category: "logging" };
    expect(formatSettingValueForTree(meta, "")).toBe("(default)");
  });

  it("formats string with value", () => {
    const meta: SettingMeta = { key: "x", section: "s", label: "X", type: "string", category: "tunnels" };
    expect(formatSettingValueForTree(meta, "127.0.0.1")).toBe("127.0.0.1");
  });

  it("formats empty string as (default)", () => {
    const meta: SettingMeta = { key: "x", section: "s", label: "X", type: "string", category: "tunnels" };
    expect(formatSettingValueForTree(meta, "")).toBe("(default)");
  });

  it("formats enum with display label", () => {
    const meta: SettingMeta = {
      key: "x", section: "s", label: "X", type: "enum", category: "tunnels",
      enumOptions: [
        { label: "Shared", value: "shared" },
        { label: "Isolated", value: "isolated" }
      ]
    };
    expect(formatSettingValueForTree(meta, "shared")).toBe("Shared");
    expect(formatSettingValueForTree(meta, "isolated")).toBe("Isolated");
  });

  it("formats enum falling back to raw value when no match", () => {
    const meta: SettingMeta = {
      key: "x", section: "s", label: "X", type: "enum", category: "tunnels",
      enumOptions: [{ label: "Shared", value: "shared" }]
    };
    expect(formatSettingValueForTree(meta, "unknown")).toBe("unknown");
  });

  it("formats multi-checkbox as count", () => {
    const meta: SettingMeta = {
      key: "x", section: "s", label: "X", type: "multi-checkbox", category: "terminal",
      checkboxOptions: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
        { label: "C", value: "c" }
      ]
    };
    expect(formatSettingValueForTree(meta, ["a", "b"])).toBe("2 of 3");
  });

  it("formats empty multi-checkbox", () => {
    const meta: SettingMeta = {
      key: "x", section: "s", label: "X", type: "multi-checkbox", category: "terminal",
      checkboxOptions: [
        { label: "A", value: "a" },
        { label: "B", value: "b" }
      ]
    };
    expect(formatSettingValueForTree(meta, [])).toBe("0 of 2");
  });
});
