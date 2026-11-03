import { describe, expect, it } from "vitest";
import { resolveHighlightProfile, type HighlightCatalog, type HighlightProfile } from "../../src/models/highlightProfile";
import { isHighlightProfileSelection, validateHighlightProfiles } from "../../src/utils/highlightProfileValidation";

const defaultProfile: HighlightProfile = {
  id: "default", name: "Default", rules: [{ pattern: "DEFAULT_ONLY", color: "red" }]
};
const linux: HighlightProfile = {
  id: "linux", name: "Linux", rules: [{ pattern: "LINUX_ONLY", color: "green", enabled: false }]
};
const catalog: HighlightCatalog = {
  profiles: [defaultProfile, linux], defaultProfileId: "default", enabled: true, legacy: false
};

describe("highlight profile selection", () => {
  it("inherits only when absent, and resolves an explicit choice without adding default rules", () => {
    expect(resolveHighlightProfile(catalog, undefined)?.rules).toEqual([{ pattern: "DEFAULT_ONLY", color: "red" }]);
    expect(resolveHighlightProfile(catalog, "linux")?.rules).toEqual([
      { pattern: "LINUX_ONLY", color: "green", enabled: false }
    ]);
    expect(resolveHighlightProfile(catalog, "linux")?.rules.map((r) => r.pattern)).not.toContain("DEFAULT_ONLY");
  });

  it("keeps none and a missing explicit reference from falling through to the default", () => {
    expect(resolveHighlightProfile(catalog, null)).toBeUndefined();
    expect(resolveHighlightProfile(catalog, "deleted-profile")).toBeUndefined();
  });

  it("resolves no rules for a disabled catalog, missing default, or explicitly empty catalog", () => {
    expect(resolveHighlightProfile({ ...catalog, enabled: false }, "linux")).toBeUndefined();
    expect(resolveHighlightProfile({ ...catalog, defaultProfileId: null }, undefined)).toBeUndefined();
    expect(resolveHighlightProfile({ ...catalog, defaultProfileId: "deleted" }, undefined)).toBeUndefined();
    expect(resolveHighlightProfile({ ...catalog, profiles: [] }, undefined)).toBeUndefined();
  });

  it("keeps an empty profile as a valid explicit selection", () => {
    expect(resolveHighlightProfile({ ...catalog, profiles: [{ id: "empty", name: "Empty", rules: [] }] }, "empty"))
      .toEqual({ id: "empty", name: "Empty", rules: [] });
  });

  it.each([undefined, null, "default", "a".repeat(100)])("accepts saved selection %j", (value) => {
    expect(isHighlightProfileSelection(value)).toBe(true);
  });

  it.each(["", "  ", "a".repeat(101), 42, false, {}, []])("rejects malformed saved selection %j", (value) => {
    expect(isHighlightProfileSelection(value)).toBe(false);
  });
});

describe("highlight profile validation", () => {
  it("distinguishes legacy null from an explicitly empty catalog", () => {
    expect(validateHighlightProfiles(null)).toEqual({ ok: true, profiles: null });
    expect(validateHighlightProfiles([])).toEqual({ ok: true, profiles: [] });
  });

  it("sanitizes and deeply copies valid profiles while preserving rule order and disabled metadata", () => {
    const input = [{ id: "linux", name: "  Linux  ", extra: "discard", rules: [
      { pattern: "WARN", color: "yellow", flags: "g", label: "Warn", description: "Warning", enabled: false, extra: 1 },
      { pattern: "ERR", color: "red", bold: true, underline: true }
    ] }];
    const validated = validateHighlightProfiles(input);
    expect(validated).toEqual({ ok: true, profiles: [{ id: "linux", name: "Linux", rules: [
      { pattern: "WARN", color: "yellow", flags: "g", label: "Warn", description: "Warning", enabled: false },
      { pattern: "ERR", color: "red", bold: true, underline: true }
    ] }] });
    if (!validated.ok || !validated.profiles) throw new Error("Expected valid profiles");
    validated.profiles[0].rules[0].pattern = "CHANGED";
    expect(input[0].rules[0].pattern).toBe("WARN");
    expect(input[0].name).toBe("  Linux  ");
  });

  it.each([
    [undefined, "array"],
    [{}, "array"],
    [[null], "Profile #1"],
    [[{ ...linux, id: "" }], "ID"],
    [[{ ...linux, id: " ".repeat(3) }], "ID"],
    [[{ ...linux, id: "a".repeat(101) }], "ID"],
    [[{ ...linux, name: " " }], "name"],
    [[{ ...linux, name: "a".repeat(101) }], "name"],
    [[linux, { ...defaultProfile, id: "linux" }], "ID"],
    [[linux, { ...defaultProfile, name: " LINUX " }], "name"],
    [[{ ...linux, rules: {} }], "Rule"],
    [[{ ...linux, rules: Array.from({ length: 101 }, () => ({ pattern: "A", color: "red" })) }], "100"],
    [Array.from({ length: 101 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, rules: [] })), "100"]
  ])("rejects malformed or colliding catalog %j with a useful location", (input, message) => {
    const result = validateHighlightProfiles(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid profiles");
    expect(result.message.toLowerCase()).toContain(String(message).toLowerCase());
  });

  it.each([
    { pattern: "[", color: "red" },
    { pattern: "x", color: "red", flags: "gg" },
    { pattern: "x", color: "red", flags: "m" },
    { pattern: "x", color: "red", flags: 1 },
    { pattern: "a*", color: "red" },
    { pattern: "(a+)+$", color: "red" },
    { pattern: "(a|aa)+$", color: "red" },
    { pattern: "x".repeat(501), color: "red" },
    { pattern: "x", color: "background-red" }
  ])("rejects an unusable new rule even when disabled: %j", (rule) => {
    const result = validateHighlightProfiles([{ ...linux, rules: [{ ...rule, enabled: false }] }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid rule");
    expect(result.message).toContain("Profile #1");
    expect(result.message).toContain("Rule #1");
  });

  it("retains fail-closed malformed enabled values and tolerates omitted historic flags", () => {
    expect(validateHighlightProfiles([{ ...linux, rules: [{ pattern: "WARN", color: "yellow", enabled: "false" }] }]))
      .toEqual({ ok: true, profiles: [{ ...linux, rules: [{ pattern: "WARN", color: "yellow", enabled: false }] }] });
  });
});
