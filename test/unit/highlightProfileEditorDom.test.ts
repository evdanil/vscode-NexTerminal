import { describe, expect, it } from "vitest";
import { openHighlightRuleEditor } from "../helpers/highlightRuleEditorHarness";
import type { HighlightEditorState } from "../../src/ui/highlightProfileEditorStore";

const state: HighlightEditorState = {
  shippedRules: [], revision: "rev-1", catalog: { enabled: true, legacy: false, defaultProfileId: "one", profiles: [
    { id: "one", name: "One", rules: [{ pattern: "ONE", color: "red" }] },
    { id: "two", name: "Two", rules: [{ pattern: "TWO", color: "blue" }] }
  ] }
};

describe("highlight profile manager", () => {
  it("stages profile rename, duplication, default change, and independent rule edits", () => {
    const editor = openHighlightRuleEditor([], state);
    expect(editor.rowLabel(0)).toBe("ONE");
    editor.setProfileName("Copied"); editor.duplicateProfile();
    editor.clickEdit(0); editor.setPattern("COPY"); editor.stageRule();
    editor.selectProfile("one"); expect(editor.rowLabel(0)).toBe("ONE");
    editor.setProfileName("Renamed"); editor.renameProfile();
    editor.setDefault("two"); editor.clickApply();
    const message = editor.posted.find((entry) => entry.type === "saveCatalog");
    expect(message?.type).toBe("saveCatalog");
    if (message?.type !== "saveCatalog") throw new Error("missing catalog save");
    expect(message.revision).toBe("rev-1");
    expect(message.defaultProfileId).toBe("two");
    expect(message.profiles.map((p) => [p.name, p.rules[0]?.pattern])).toEqual([["Renamed", "ONE"], ["Two", "TWO"], ["Copied", "COPY"]]);
  });

  it("keeps dirty drafts when external settings change and protects an in-flight save snapshot", () => {
    const editor = openHighlightRuleEditor([], state);
    editor.clickEdit(0); editor.setPattern("EDIT ONE"); editor.stageRule(); editor.clickApply();
    editor.selectProfile("two"); editor.clickEdit(0); editor.setPattern("EDIT TWO"); editor.stageRule();
    editor.deliver({ type: "catalogUpdated", state: { ...state, revision: "remote" } });
    editor.deliver({ type: "catalogSaveResult", ok: true, revision: "rev-2" });
    expect(editor.isDirty()).toBe(true);
    editor.clickApply();
    const saves = editor.posted.filter((entry) => entry.type === "saveCatalog");
    expect(saves).toHaveLength(2);
    if (saves[1].type !== "saveCatalog") throw new Error("missing catalog save");
    expect(saves[1].profiles.map((p) => p.rules[0].pattern)).toEqual(["EDIT ONE", "EDIT TWO"]);
  });

  it("stages deletions and cancellation restores profiles without saving", () => {
    const editor = openHighlightRuleEditor([], state);
    editor.deleteProfile();
    expect(editor.posted).toContainEqual({ type: "confirmDeleteProfile", profileId: "one", profileName: "One" });
    editor.deliver({ type: "confirmDeleteProfileResult", profileId: "one", confirmed: true });
    expect(editor.rowLabel(0)).toBe("TWO");
    editor.clickCancel(); editor.selectProfile("one");
    expect(editor.rowLabel(0)).toBe("ONE");
    expect(editor.posted.some((entry) => entry.type === "saveCatalog")).toBe(false);
  });

  it("copies workspace rules only on the explicit copy action", () => {
    const editor = openHighlightRuleEditor([], { ...state, workspaceLegacyRules: [{ pattern: "WORKSPACE", color: "green" }] });
    expect(editor.rowLabel(0)).toBe("ONE");
    editor.copyWorkspaceRules(); expect(editor.rowLabel(0)).toBe("WORKSPACE");
    editor.clickApply();
    const save = editor.posted.find((entry) => entry.type === "saveCatalog");
    if (save?.type !== "saveCatalog") throw new Error("missing save");
    expect(save.profiles[0].rules[0].pattern).toBe("WORKSPACE");
  });


  it("creates from shipped rules and keeps failed saves editable", () => {
    const editor = openHighlightRuleEditor([], { ...state, shippedRules: [{ pattern: "SHIPPED", color: "red" }] });
    editor.setProfileName("Defaults copy"); editor.createFromDefaults();
    expect(editor.rowLabel(0)).toBe("SHIPPED");
    editor.clickApply(); editor.deliver({ type: "catalogSaveResult", ok: false, message: "Cannot save now" });
    expect(editor.isDirty()).toBe(true);
    expect(editor.rowLabel(0)).toBe("SHIPPED");
    expect(editor.saveError()).toBe("Cannot save now");
  });

  it("warns when workspace-scoped catalog settings override global edits", () => {
    const editor = openHighlightRuleEditor([], { ...state, workspaceCatalogOverrides: true });
    expect(editor.workspaceOverrideVisible()).toBe(true);
  });

  it.each(["global", "workspace"] as const)("shows settings repair actions for an invalid %s catalog", (scope) => {
    const invalid = scope === "global"
      ? { ...state, catalog: { ...state.catalog, validationError: "Invalid global default" } }
      : { ...state, effectiveValidationError: "Invalid workspace catalog" };
    const editor = openHighlightRuleEditor([], invalid);
    expect(editor.recoveryMessage()).toContain(scope === "global" ? "Invalid global default" : "Invalid workspace catalog");
    expect(editor.recoveryMessage()).toContain("nexus.terminal.highlighting.profiles");
    expect(editor.recoveryMessage()).toContain("nexus.terminal.highlighting.defaultProfile");
    expect(editor.recoveryMessage()).toContain("Folder Settings (JSON)");
    expect(editor.recoveryMessage()).not.toContain("Nexus: Edit Highlighting Rules");
    expect(editor.recoveryVisible()).toBe(true);
    editor.openUserSettings(); editor.openWorkspaceSettings();
    expect(editor.posted).toContainEqual({ type: "openHighlightSettingsJson", scope: "user" });
    expect(editor.posted).toContainEqual({ type: "openHighlightSettingsJson", scope: "workspace" });
    editor.deliver({ type: "catalogUpdated", state });
    expect(editor.recoveryVisible()).toBe(false);
  });
  it("explains a missing effective default from workspace settings", () => {
    const editor = openHighlightRuleEditor([], { ...state, effectiveMissingDefaultId: "lost" });
    expect(editor.recoveryMessage()).toContain("lost");
    expect(editor.recoveryMessage()).toContain("nexus.terminal.highlighting.defaultProfile");
    expect(editor.recoveryVisible()).toBe(true);
  });

});
