import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ global: {} as Record<string, unknown>, workspace: {} as Record<string, unknown>, writes: [] as Array<[string, unknown]>, failKey: "", overrideAfterProfiles: undefined as unknown }));
vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: { getConfiguration: () => ({
    inspect: (key: string) => ({ globalValue: state.global[key], workspaceValue: state.workspace[key], defaultValue: key === "profiles" ? null : key === "defaultProfile" ? "default" : key === "enabled" ? true : [{ pattern: "SHIPPED", color: "red" }] }),
    get: (key: string, fallback: unknown) => state.workspace[key] ?? state.global[key] ?? (key === "profiles" ? null : key === "defaultProfile" ? "default" : key === "enabled" ? true : fallback),
    update: async (key: string, value: unknown) => { if (key === state.failKey) throw new Error("write failed"); state.writes.push([key, value]); state.global[key] = value; if (key === "profiles" && state.overrideAfterProfiles !== undefined) state.global.profiles = state.overrideAfterProfiles; }
  }) }
}));

import { FORMER_DEFAULT_PATTERNS } from "../../src/utils/highlightRuleUpgrade";
import { readHighlightEditorState, saveHighlightEditorCatalog } from "../../src/ui/highlightProfileEditorStore";

describe("highlight profile editor storage", () => {
  beforeEach(() => { state.global = {}; state.workspace = {}; state.writes = []; state.failKey = ""; state.overrideAfterProfiles = undefined; });

  it("does not promote workspace rules when materializing legacy global settings", async () => {
    state.global.rules = [{ pattern: "GLOBAL", color: "red" }];
    state.workspace.rules = [{ pattern: "WORKSPACE", color: "blue" }];
    const initial = readHighlightEditorState();
    expect(initial.catalog.profiles[0].rules[0].pattern).toBe("GLOBAL");
    expect(initial.workspaceLegacyRules?.[0].pattern).toBe("WORKSPACE");
    expect(state.writes).toEqual([]);
    expect(initial.shippedRules[0].pattern).toBe("SHIPPED");
    const result = await saveHighlightEditorCatalog(initial.catalog.profiles, initial.catalog.defaultProfileId, initial.revision);
    expect(result.ok).toBe(true);
    expect(state.global.profiles).toEqual([{ id: "default", name: "Default", rules: [{ pattern: "GLOBAL", color: "red" }] }]);
  });

  it("saves an explicit profile with a former default pattern without a false conflict", async () => {
    const pattern = Object.keys(FORMER_DEFAULT_PATTERNS)[0];
    const profile = { id: "custom", name: "Custom", rules: [{ pattern, color: "red" }] };
    const initial = readHighlightEditorState();
    const result = await saveHighlightEditorCatalog([profile], "custom", initial.revision);
    expect(result.ok).toBe(true);
    expect(state.global.profiles).toEqual([profile]);
    expect(readHighlightEditorState().catalog.profiles[0].rules[0].pattern).toBe(pattern);
  });

  it("reports workspace profile and default overrides before a global edit", () => {
    expect(readHighlightEditorState().workspaceCatalogOverrides).toBe(false);
    state.workspace.profiles = [];
    expect(readHighlightEditorState().workspaceCatalogOverrides).toBe(true);
    delete state.workspace.profiles;
    state.workspace.defaultProfile = null;
    expect(readHighlightEditorState().workspaceCatalogOverrides).toBe(true);
  });

  it.each(["profiles", "defaultProfile"])("reports malformed global %s with a settings repair path", async (key) => {
    state.global[key] = 42;
    const initial = readHighlightEditorState();
    expect(initial.catalog.validationError).toBeTruthy();
    const result = await saveHighlightEditorCatalog([], null, initial.revision);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("User Settings (JSON)");
      expect(result.message).toContain("nexus.terminal.highlighting.profiles");
      expect(result.message).toContain("nexus.terminal.highlighting.defaultProfile");
      expect(result.message).not.toContain("Nexus: Edit Highlighting Rules");
    }
    expect(state.writes).toEqual([]);
  });

  it.each(["profiles", "defaultProfile"])("surfaces malformed workspace %s to the global manager", (key) => {
    state.workspace[key] = 42;
    const initial = readHighlightEditorState();
    expect(initial.catalog.validationError).toBeUndefined();
    expect(initial.effectiveValidationError).toBeTruthy();
  });

  it("reports a missing effective default even when the global catalog is valid", () => {
    state.workspace.defaultProfile = "lost";
    const initial = readHighlightEditorState();
    expect(initial.catalog.defaultProfileId).toBe("default");
    expect(initial.effectiveValidationError).toBeUndefined();
    expect(initial.effectiveMissingDefaultId).toBe("lost");
  });

  it("rejects stale revisions and malformed profile data without writing", async () => {
    const initial = readHighlightEditorState();
    state.global.rules = [{ pattern: "OTHER", color: "green" }];
    expect((await saveHighlightEditorCatalog(initial.catalog.profiles, "default", initial.revision)).ok).toBe(false);
    const current = readHighlightEditorState();
    expect((await saveHighlightEditorCatalog([{ id: "x", name: "X", rules: [{ pattern: "(", color: "red" }] }], "x", current.revision)).ok).toBe(false);
    expect(state.writes).toEqual([]);
  });

  it("clears a deleted default before writing the remaining catalog", async () => {
    state.global.profiles = [{ id: "p", name: "P", rules: [] }]; state.global.defaultProfile = "p";
    const initial = readHighlightEditorState();
    const result = await saveHighlightEditorCatalog([], null, initial.revision);
    expect(result.ok).toBe(true);
    expect(state.writes).toEqual([["defaultProfile", null], ["profiles", []]]);
  });

  it("clears a deleted default before switching to another profile", async () => {
    state.global.profiles = [{ id: "p", name: "P", rules: [] }, { id: "q", name: "Q", rules: [] }]; state.global.defaultProfile = "p";
    const initial = readHighlightEditorState();
    expect((await saveHighlightEditorCatalog([{ id: "q", name: "Q", rules: [] }], "q", initial.revision)).ok).toBe(true);
    expect(state.writes).toEqual([["defaultProfile", null], ["profiles", [{ id: "q", name: "Q", rules: [] }]], ["defaultProfile", "q"]]);
  });

  it("does not acknowledge a save when an external write replaces its catalog", async () => {
    const initial = readHighlightEditorState();
    state.overrideAfterProfiles = [{ id: "other", name: "Other", rules: [] }];
    const result = await saveHighlightEditorCatalog(initial.catalog.profiles, initial.catalog.defaultProfileId, initial.revision);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("changed");
  });

  it("returns a failure and leaves the draft for retry when a write fails", async () => {
    const initial = readHighlightEditorState();
    state.failKey = "profiles";
    const result = await saveHighlightEditorCatalog(initial.catalog.profiles, initial.catalog.defaultProfileId, initial.revision);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("save");
    expect(state.writes).toEqual([]);
  });
});
