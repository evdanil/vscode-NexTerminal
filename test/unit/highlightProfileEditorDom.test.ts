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
  it("deletes the rule being edited after a reorder and stages the deletion", () => {
    const editor = openHighlightRuleEditor([], { ...state, catalog: { ...state.catalog, profiles: [
      { id: "one", name: "One", rules: [{ pattern: "FIRST", color: "red" }, { pattern: "SECOND", color: "blue" }] }
    ] } });
    editor.clickEdit(0);
    editor.setPattern("UNFINISHED");
    editor.clickDown(0);
    editor.deleteEditedRule();
    expect(editor.editorVisible()).toBe(false);
    expect(editor.rowCount()).toBe(1);
    expect(editor.rowLabel(0)).toBe("SECOND");
    expect(editor.isDirty()).toBe(true);
    editor.clickApply();
    const save = editor.posted.find((message) => message.type === "saveCatalog");
    if (save?.type !== "saveCatalog") throw new Error("missing save");
    expect(save.profiles[0].rules.map((rule) => rule.pattern)).toEqual(["SECOND"]);
  });
  it("preserves an unfinished edit if the same rule's row delete is clicked", () => {
    const editor = openHighlightRuleEditor([], state);
    editor.clickEdit(0); editor.setPattern("DRAFT");
    editor.clickDelete(0);
    expect(editor.editorVisible()).toBe(true);
    expect(editor.patternValue()).toBe("DRAFT");
    expect(editor.rowLabel(0)).toBe("ONE");
    expect(editor.saveError()).toContain("Stage Rule");
    editor.stageRule();
    expect(editor.rowLabel(0)).toBe("DRAFT");
  });
  it.each(["stage", "cancel", "delete"] as const)("clears only the rule guard message after %s", (resolution) => {
    const editor = openHighlightRuleEditor([], state);
    editor.clickEdit(0); editor.setPattern("DRAFT"); editor.selectProfile("two");
    expect(editor.saveError()).toContain("Stage Rule");
    if (resolution === "stage") editor.stageRule();
    if (resolution === "cancel") editor.cancelRuleEdit();
    if (resolution === "delete") editor.deleteEditedRule();
    expect(editor.editorVisible()).toBe(false);
    expect(editor.saveError()).toBe("");
  });
  it("keeps a real save failure after closing a rule editor", () => {
    const editor = openHighlightRuleEditor([], state);
    editor.clickEdit(0); editor.setPattern("DRAFT");
    editor.deliver({ type: "catalogSaveResult", ok: false, message: "Real save failure" });
    editor.cancelRuleEdit();
    expect(editor.saveError()).toBe("Real save failure");
  });
  it("restores a pre-existing save failure after a rule guard is resolved", () => {
    const editor = openHighlightRuleEditor([], state);
    editor.clickEdit(0); editor.setPattern("DRAFT");
    editor.deliver({ type: "catalogSaveResult", ok: false, message: "Real save failure" });
    editor.selectProfile("two");
    expect(editor.saveError()).toContain("Stage Rule");
    editor.cancelRuleEdit();
    expect(editor.saveError()).toBe("Real save failure");
  });
  it("updates the effective highlighting notice live, including while a rule draft is open", () => {
    const editor = openHighlightRuleEditor([], { ...state, effectiveEnabled: true });
    expect(editor.highlightingDisabledVisible()).toBe(false);
    editor.clickEdit(0); editor.setPattern("DRAFT");
    editor.deliver({ type: "catalogUpdated", state: { ...state, effectiveEnabled: false } });
    expect(editor.highlightingDisabledVisible()).toBe(true);
    expect(editor.patternValue()).toBe("DRAFT");
    expect(editor.saveError()).not.toContain("changed elsewhere");
    editor.openHighlightingSettings();
    expect(editor.posted).toContainEqual({ type: "openHighlightingSettings" });
    editor.deliver({ type: "catalogUpdated", state: { ...state, effectiveEnabled: true } });
    expect(editor.highlightingDisabledVisible()).toBe(false);
    expect(editor.patternValue()).toBe("DRAFT");
  });
  it("normalizes explicit enabled true when deriving catalog dirty state", () => {
    const editor = openHighlightRuleEditor([], { ...state, catalog: { ...state.catalog, profiles: [
      { id: "one", name: "One", rules: [{ pattern: "ONE", color: "red", enabled: true }] }
    ] } });
    expect(editor.isDirty()).toBe(false);
    editor.toggleEnabled(0); expect(editor.isDirty()).toBe(true);
    editor.toggleEnabled(0); expect(editor.isDirty()).toBe(false);
    editor.clickEdit(0); editor.setPattern("CHANGE"); editor.stageRule();
    expect(editor.isDirty()).toBe(true);
  });
  it.each(["create", "defaults", "duplicate"] as const)("creates a unique usable name by default for %s", (action) => {
    const editor = openHighlightRuleEditor([], state);
    if (action === "create") editor.createProfile();
    if (action === "defaults") editor.createFromDefaults();
    if (action === "duplicate") editor.duplicateProfile();
    editor.clickApply();
    const save = editor.posted.find((message) => message.type === "saveCatalog");
    if (save?.type !== "saveCatalog") throw new Error("missing save");
    const names = save.profiles.map((profile) => profile.name.toLowerCase());
    expect(new Set(names).size).toBe(3);
    expect(save.profiles[2].name).toContain(action === "duplicate" ? "One" : "New");
  });

  it("gives immediate feedback for explicitly chosen duplicate names", () => {
    const editor = openHighlightRuleEditor([], state);
    editor.setProfileName("Two"); editor.createProfile();
    expect(editor.saveError()).toContain("already");
    expect(editor.isDirty()).toBe(false);
    expect(editor.posted.some((message) => message.type === "saveCatalog")).toBe(false);
  });

  it("keeps an unfinished rule on profile switch until explicitly staged or cancelled", () => {
    const editor = openHighlightRuleEditor([], state);
    editor.clickEdit(0); editor.setPattern("UNFINISHED"); editor.selectProfile("two");
    expect(editor.selectedProfile()).toBe("one");
    expect(editor.editorVisible()).toBe(true);
    expect(editor.patternValue()).toBe("UNFINISHED");
    expect(editor.saveError()).toContain("Stage Rule");
    expect(editor.saveError()).toContain("Cancel");
    editor.stageRule(); editor.selectProfile("two"); editor.selectProfile("one");
    expect(editor.rowLabel(0)).toBe("UNFINISHED");
    editor.clickEdit(0); editor.setPattern("DISCARD"); editor.cancelRuleEdit(); editor.selectProfile("two"); editor.selectProfile("one");
    expect(editor.rowLabel(0)).toBe("UNFINISHED");
  });

  it.each(["create", "duplicate", "reset", "copy", "delete", "apply", "cancel", "edit", "add"] as const)(
    "protects an unfinished rule from the %s action", (action) => {
      const editor = openHighlightRuleEditor([], { ...state, workspaceLegacyRules: [{ pattern: "WORKSPACE", color: "green" }] });
      editor.clickEdit(0); editor.setPattern("UNFINISHED");
      if (action === "create") { editor.setProfileName("New"); editor.createProfile(); }
      if (action === "duplicate") { editor.setProfileName("Copy"); editor.duplicateProfile(); }
      if (action === "reset") editor.resetRules();
      if (action === "copy") editor.copyWorkspaceRules();
      if (action === "delete") editor.deleteProfile();
      if (action === "apply") editor.clickApply();
      if (action === "cancel") editor.clickCancel();
      if (action === "edit") editor.clickEdit(0);
      if (action === "add") editor.clickAdd();
      expect(editor.editorVisible()).toBe(true);
      expect(editor.patternValue()).toBe("UNFINISHED");
      expect(editor.selectedProfile()).toBe("one");
      expect(editor.saveError()).toContain("Stage Rule");
      expect(editor.posted.some((msg) => msg.type === "saveCatalog" || msg.type === "confirmDeleteProfile")).toBe(false);
    }
  );

  it("preserves an unfinished rule when external settings arrive and gives a real recovery path", () => {
    const editor = openHighlightRuleEditor([], state);
    editor.clickEdit(0); editor.setPattern("UNFINISHED");
    editor.deliver({ type: "catalogUpdated", state: { ...state, revision: "remote" } });
    expect(editor.editorVisible()).toBe(true);
    expect(editor.patternValue()).toBe("UNFINISHED");
    expect(editor.saveError()).toContain("close the Highlight Profiles tab");
    expect(editor.saveError()).toContain("discard");
    expect(editor.saveError()).toContain("Nexus: Edit Highlighting Rules");
    expect(editor.saveError()).not.toContain("reopen to review");
  });

  it("preserves an unfinished rule if a deletion confirmation arrives late", () => {
    const editor = openHighlightRuleEditor([], state);
    editor.deleteProfile();
    editor.clickEdit(0); editor.setPattern("UNFINISHED");
    editor.deliver({ type: "confirmDeleteProfileResult", profileId: "one", confirmed: true });
    expect(editor.editorVisible()).toBe(true);
    expect(editor.patternValue()).toBe("UNFINISHED");
    expect(editor.selectedProfile()).toBe("one");
    expect(editor.rowLabel(0)).toBe("ONE");
  });

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
