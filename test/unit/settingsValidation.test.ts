import { describe, expect, it } from "vitest";
import { validateSettingUpdate } from "../../src/ui/settingsValidation";

describe("validateSettingUpdate", () => {
  it("accepts transcript line-ending choices and rejects unsupported values", () => {
    for (const value of ["preserve", "lf"]) {
      expect(validateSettingUpdate("nexus.logging", "sessionTranscriptLineEndings", value)).toMatchObject({ ok: true, value });
    }
    for (const value of ["crlf", "invalid", true, null]) {
      expect(validateSettingUpdate("nexus.logging", "sessionTranscriptLineEndings", value).ok).toBe(false);
    }
  });
  it("accepts valid log path templates and returns actionable syntax errors", () => {
    for (const value of ["", "%G/%S/%S-%Y-%M-%D.log", "%COMPUTERNAME%/%S.log"]) {
      expect(validateSettingUpdate("nexus.logging", "sessionLogPathTemplate", value).ok).toBe(true);
    }
    for (const value of ["../%S.log", "%UNKNOWN.log", "%S.txt", true]) {
      expect(validateSettingUpdate("nexus.logging", "sessionLogPathTemplate", value).ok).toBe(false);
    }
  });
  it("accepts transcript timestamp choices and rejects unsupported values", () => {
    for (const value of ["local", "utc", "off"]) {
      expect(validateSettingUpdate("nexus.logging", "sessionTranscriptTimestamps", value)).toMatchObject({ ok: true, value });
    }
    for (const value of ["invalid", true, null]) {
      expect(validateSettingUpdate("nexus.logging", "sessionTranscriptTimestamps", value).ok).toBe(false);
    }
  });
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
