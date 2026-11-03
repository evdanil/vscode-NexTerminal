import { readFileSync } from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  defaults: new Map<string, unknown>(),
  global: new Map<string, unknown>(),
  workspace: new Map<string, unknown>(),
  writes: [] as unknown[]
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section: string) => {
      if (section !== "nexus.terminal.highlighting") throw new Error(`Unexpected section: ${section}`);
      return {
        get: (key: string, fallback?: unknown) => state.workspace.has(key) ? state.workspace.get(key)
          : state.global.has(key) ? state.global.get(key) : state.defaults.get(key) ?? fallback,
        inspect: (key: string) => ({
          key: `${section}.${key}`, defaultValue: state.defaults.get(key), globalValue: state.global.get(key),
          workspaceValue: state.workspace.get(key)
        }),
        update: (...args: unknown[]) => {
          state.writes.push(args);
          throw new Error("Settings are read-only");
        }
      };
    }
  }
}));

import { readHighlightCatalog, readGlobalHighlightCatalogForEditing } from "../../src/services/terminal/highlightProfileSettings";
import type { HighlightRule } from "../../src/utils/highlightRuleValidation";

const properties = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"))
  .contributes.configuration.properties as Record<string, { default?: unknown }>;
const shippedRules = properties["nexus.terminal.highlighting.rules"].default as HighlightRule[];
const localRule = { pattern: "GLOBAL_ONLY", color: "red", enabled: false, label: "Global rule" };
const workspaceRule = { pattern: "WORKSPACE_ONLY", color: "green" };
const profiles = [{ id: "linux", name: "Linux", rules: [{ pattern: "LINUX_ONLY", color: "blue" }] }];

describe("highlight catalog settings compatibility", () => {
  beforeEach(() => {
    state.global.clear(); state.workspace.clear(); state.defaults.clear(); state.writes.length = 0;
    for (const [fullKey, value] of Object.entries(properties)) {
      const prefix = "nexus.terminal.highlighting.";
      if (fullKey.startsWith(prefix)) state.defaults.set(fullKey.slice(prefix.length), value.default);
    }
  });

  it("uses shipped rules through one virtual Default profile without materializing settings", () => {
    const catalog = readHighlightCatalog();
    expect(catalog.legacy).toBe(true);
    expect(catalog.defaultProfileId).toBe("default");
    expect(catalog.enabled).toBe(true);
    expect(catalog.profiles).toHaveLength(1);
    expect(catalog.profiles[0].id).toBe("default");
    expect(catalog.profiles[0].name).toBe("Default");
    expect(catalog.profiles[0].rules).toHaveLength(22);
    expect(catalog.profiles[0].rules.find((rule) => rule.label === "IPv6 addresses")?.enabled).toBe(false);
    expect(catalog.profiles[0].rules.find((rule) => rule.label?.includes("UUID"))?.enabled).toBe(false);
    expect(state.global.size).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it("preserves customized legacy rules, ordering and disabled flags", () => {
    state.global.set("rules", [localRule, { pattern: "SECOND", color: "yellow", description: "Second rule" }]);
    expect(readHighlightCatalog().profiles[0].rules).toEqual([
      localRule, { pattern: "SECOND", color: "yellow", description: "Second rule" }
    ]);
    expect(state.writes).toEqual([]);
  });

  it("honors effective workspace legacy rules while the global editor reads only global values", () => {
    state.global.set("rules", [localRule]);
    state.workspace.set("rules", [workspaceRule]);
    expect(readHighlightCatalog().profiles[0].rules).toEqual([workspaceRule]);
    expect(readGlobalHighlightCatalogForEditing().profiles[0].rules).toEqual([localRule]);
    expect(state.writes).toEqual([]);
    expect(state.global.get("rules")).toEqual([localRule]);
  });

  it("seeds global editing from shipped defaults when only a workspace customization exists", () => {
    state.workspace.set("rules", [workspaceRule]);
    expect(readGlobalHighlightCatalogForEditing().profiles[0].rules).toHaveLength(22);
    expect(readGlobalHighlightCatalogForEditing().profiles[0].rules.map((rule) => rule.pattern)).not.toContain("WORKSPACE_ONLY");
    expect(state.global.size).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it("retains explicit empty legacy rules as an empty Default profile", () => {
    state.global.set("rules", []);
    expect(readHighlightCatalog().profiles).toEqual([{ id: "default", name: "Default", rules: [] }]);
  });

  it("does not resurrect legacy rules when the new catalog is explicitly empty", () => {
    state.global.set("profiles", []);
    state.global.set("rules", [localRule]);
    expect(readHighlightCatalog()).toMatchObject({ legacy: false, profiles: [] });
    expect(readGlobalHighlightCatalogForEditing()).toMatchObject({ legacy: false, profiles: [] });
  });

  it("uses only configured profiles and preserves a None default and master switch", () => {
    state.global.set("profiles", profiles);
    state.global.set("defaultProfile", null);
    state.global.set("enabled", false);
    state.global.set("rules", [localRule]);
    expect(readHighlightCatalog()).toEqual({ profiles, defaultProfileId: null, enabled: false, legacy: false });
    expect(state.writes).toEqual([]);
  });

  it("keeps effective and global catalogs separate across scopes", () => {
    state.global.set("profiles", profiles);
    state.global.set("defaultProfile", "linux");
    state.workspace.set("profiles", []);
    state.workspace.set("defaultProfile", null);
    expect(readHighlightCatalog()).toMatchObject({ profiles: [], defaultProfileId: null, legacy: false });
    expect(readGlobalHighlightCatalogForEditing()).toMatchObject({ profiles, defaultProfileId: "linux", legacy: false });
  });

  it("reports a malformed catalog without falling back to legacy or writing an empty catalog", () => {
    const invalid = [{ id: "bad", name: "Bad", rules: [{ pattern: "[", color: "red" }] }];
    state.global.set("profiles", invalid);
    state.global.set("rules", [localRule]);
    const catalog = readHighlightCatalog();
    expect(catalog.profiles).toEqual([]);
    expect(catalog.legacy).toBe(false);
    expect(catalog.validationError).toContain("Rule #1");
    expect(readGlobalHighlightCatalogForEditing().validationError).toContain("Rule #1");
    expect(state.global.get("profiles")).toEqual(invalid);
    expect(state.writes).toEqual([]);
  });

  it("keeps a missing profile ID for repair, but treats a malformed default as none", () => {
    state.global.set("profiles", profiles);
    state.global.set("defaultProfile", "missing-id");
    expect(readHighlightCatalog().defaultProfileId).toBe("missing-id");
    state.global.set("defaultProfile", 42);
    expect(readHighlightCatalog().defaultProfileId).toBeNull();
    expect(readHighlightCatalog().validationError).toContain("default");
  });

  it("upgrades known legacy rule metadata at read time without changing saved values", () => {
    const builtin = shippedRules.find((rule) => rule.label && rule.enabled !== false)!;
    const legacy = { pattern: builtin.pattern, color: builtin.color, flags: builtin.flags, bold: builtin.bold };
    state.global.set("rules", [legacy]);
    expect(readHighlightCatalog().profiles[0].rules[0].label).toBe(builtin.label);
    expect(state.global.get("rules")).toEqual([legacy]);
    expect(state.writes).toEqual([]);
  });

  it("keeps valid legacy rules when another old entry is malformed", () => {
    state.global.set("rules", [null, localRule]);
    expect(readHighlightCatalog().profiles[0].rules).toEqual([localRule]);
    expect(state.global.get("rules")).toEqual([null, localRule]);
  });

  it("preserves intentionally unlabeled rules in a named catalog", () => {
    const builtin = shippedRules.find((rule) => rule.label && rule.enabled !== false)!;
    const savedRule = { pattern: builtin.pattern, color: builtin.color, flags: builtin.flags, bold: builtin.bold, enabled: false };
    const saved = [{ id: "custom", name: "Custom", rules: [savedRule] }];
    state.global.set("profiles", saved);
    expect(readHighlightCatalog().profiles[0].rules[0]).toEqual(savedRule);
    expect(readGlobalHighlightCatalogForEditing().profiles[0].rules[0]).toEqual(savedRule);
    expect(state.global.get("profiles")).toEqual(saved);
    expect(state.writes).toEqual([]);
  });

  it("does not truncate historically accepted large flat lists during read-only compatibility", () => {
    state.global.set("rules", Array.from({ length: 101 }, (_, i) => ({ pattern: `RULE_${i}`, color: "red" })));
    expect(readHighlightCatalog().profiles[0].rules).toHaveLength(101);
    expect(state.writes).toEqual([]);
  });
});
