import { describe, expect, it } from "vitest";
import { validateSettingUpdate } from "../../src/ui/settingsValidation";

describe("validateSettingUpdate", () => {
  it("rejects forged settings outside Nexus metadata", () => {
    expect(validateSettingUpdate("workbench", "colorTheme", "Default Dark+").ok).toBe(false);
  });

  it("rejects wrong types and out-of-range numbers", () => {
    expect(validateSettingUpdate("nexus.sftp", "cacheTtlSeconds", "10").ok).toBe(false);
    expect(validateSettingUpdate("nexus.sftp", "cacheTtlSeconds", -1).ok).toBe(false);
    expect(validateSettingUpdate("nexus.sftp", "cacheTtlSeconds", 301).ok).toBe(false);
  });

  it("accepts valid enum and multi-checkbox values", () => {
    expect(validateSettingUpdate("nexus.terminal", "openLocation", "editor").ok).toBe(true);
    expect(validateSettingUpdate("nexus.terminal", "passthroughKeys", ["b", "q", "w"]).ok).toBe(true);
  });

  it("rejects unknown multi-checkbox values", () => {
    expect(validateSettingUpdate("nexus.terminal", "passthroughKeys", ["z"]).ok).toBe(false);
  });

  it("rejects empty array for passthroughKeys ([] is not valid — use master toggle to disable)", () => {
    const result = validateSettingUpdate("nexus.terminal", "passthroughKeys", []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Select at least one option");
    }
  });

  it("deduplicates duplicate entries in a valid multi-checkbox submission", () => {
    const result = validateSettingUpdate("nexus.terminal", "passthroughKeys", ["b", "q", "b", "w"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(["b", "q", "w"]);
    }
  });

  it("accepts a single-entry passthroughKeys value", () => {
    const result = validateSettingUpdate("nexus.terminal", "passthroughKeys", ["r"]);
    expect(result.ok).toBe(true);
  });
});
