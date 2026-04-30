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
    expect(validateSettingUpdate("nexus.terminal", "passthroughKeys", ["b", "w"]).ok).toBe(true);
  });

  it("rejects unknown multi-checkbox values", () => {
    expect(validateSettingUpdate("nexus.terminal", "passthroughKeys", ["z"]).ok).toBe(false);
  });
});
