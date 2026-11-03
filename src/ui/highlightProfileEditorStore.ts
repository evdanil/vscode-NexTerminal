import * as vscode from "vscode";
import type { HighlightCatalog, HighlightProfile } from "../models/highlightProfile";
import { readGlobalHighlightCatalogForEditing, readHighlightCatalog, HIGHLIGHT_PROFILES_SECTION, HIGHLIGHT_PROFILES_KEY, HIGHLIGHT_PROFILES_FULL_KEY, HIGHLIGHT_DEFAULT_PROFILE_KEY, HIGHLIGHT_DEFAULT_PROFILE_FULL_KEY } from "../services/terminal/highlightProfileSettings";
import { recordNexusConfigWrite } from "../services/terminal/settingsWriteRegistry";
import { validateHighlightProfiles } from "../utils/highlightProfileValidation";
import { validateAndSanitizeHighlightRules, type HighlightRule } from "../utils/highlightRuleValidation";
import { upgradeHighlightRules } from "../utils/highlightRuleUpgrade";
import { HIGHLIGHT_CONFLICT_RECOVERY, HIGHLIGHT_SETTINGS_REPAIR } from "./highlightProfileForm";

export interface HighlightEditorState {
  catalog: HighlightCatalog;
  revision: string;
  workspaceLegacyRules?: HighlightRule[];
  shippedRules: HighlightRule[];
  workspaceCatalogOverrides?: boolean;
  effectiveValidationError?: string;
  effectiveMissingDefaultId?: string;
  effectiveEnabled?: boolean;
}
export type HighlightEditorSaveResult = { ok: true; state: HighlightEditorState } | { ok: false; message: string };

export function readHighlightEditorState(): HighlightEditorState {
  const catalog = readGlobalHighlightCatalogForEditing();
  const effective = readHighlightCatalog();
  const revision = JSON.stringify({ ...catalog, enabled: undefined });
  const settings = vscode.workspace.getConfiguration(HIGHLIGHT_PROFILES_SECTION);
  const workspaceCatalogOverrides = [HIGHLIGHT_PROFILES_KEY, HIGHLIGHT_DEFAULT_PROFILE_KEY].some((key) => {
    const inspected = settings.inspect<unknown>(key);
    return inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;
  });
  const rawDefaults = settings.inspect<unknown>("rules")?.defaultValue;
  const shippedRules = upgradeHighlightRules(Array.isArray(rawDefaults) ? rawDefaults.flatMap((rule) => validateAndSanitizeHighlightRules([rule]) ?? []) : []).rules;
  const globalRules = catalog.profiles[0]?.rules;
  const effectiveRules = effective.profiles[0]?.rules;
  return {
    catalog, revision, shippedRules, workspaceCatalogOverrides, effectiveEnabled: effective.enabled,
    ...(effective.validationError ? { effectiveValidationError: effective.validationError } : {}),
    ...(!effective.validationError && typeof effective.defaultProfileId === "string" &&
      !effective.profiles.some((profile) => profile.id === effective.defaultProfileId)
      ? { effectiveMissingDefaultId: effective.defaultProfileId } : {}),
    ...(catalog.legacy && effective.legacy && JSON.stringify(globalRules) !== JSON.stringify(effectiveRules)
      ? { workspaceLegacyRules: effectiveRules ?? [] } : {})
  };
}

let pendingSave: Promise<void> = Promise.resolve();

/** Serializes edits within this host; revisions reject drafts based on an older global catalog. */
export function saveHighlightEditorCatalog(profiles: unknown, defaultProfileId: unknown, expectedRevision: unknown): Promise<HighlightEditorSaveResult> {
  const save = async (): Promise<HighlightEditorSaveResult> => {
    const current = readHighlightEditorState();
    if (current.revision !== expectedRevision) return { ok: false, message: `Highlight profiles changed elsewhere. ${HIGHLIGHT_CONFLICT_RECOVERY}` };
    if (current.catalog.validationError) return { ok: false, message: `Cannot save invalid highlight settings: ${current.catalog.validationError} ${HIGHLIGHT_SETTINGS_REPAIR}` };
    const validation = validateHighlightProfiles(profiles);
    if (!validation.ok) return { ok: false, message: validation.message };
    if (validation.profiles === null) return { ok: false, message: "A profile catalog is required." };
    if (!(defaultProfileId === null || (typeof defaultProfileId === "string" && validation.profiles.some((profile) => profile.id === defaultProfileId)))) {
      return { ok: false, message: "Choose an existing default profile or None." };
    }
    const config = vscode.workspace.getConfiguration(HIGHLIGHT_PROFILES_SECTION);
    const writeDefault = async (value: string | null): Promise<void> => {
      recordNexusConfigWrite(HIGHLIGHT_DEFAULT_PROFILE_FULL_KEY, value, Date.now());
      await config.update(HIGHLIGHT_DEFAULT_PROFILE_KEY, value, vscode.ConfigurationTarget.Global);
    };
    try {
      const defaultChanged = defaultProfileId !== current.catalog.defaultProfileId;
      // A deleted default is cleared before removing its target; a newly chosen
      // default must be written after the target profile exists.
      const clearFirst = defaultChanged && (defaultProfileId === null || (current.catalog.defaultProfileId !== null && !validation.profiles.some((profile) => profile.id === current.catalog.defaultProfileId)));
      if (clearFirst) await writeDefault(null);
      recordNexusConfigWrite(HIGHLIGHT_PROFILES_FULL_KEY, validation.profiles, Date.now());
      await config.update(HIGHLIGHT_PROFILES_KEY, validation.profiles, vscode.ConfigurationTarget.Global);
      const afterProfiles = readHighlightEditorState();
      const expectedInterimDefault = clearFirst ? null : current.catalog.defaultProfileId;
      if (JSON.stringify(afterProfiles.catalog.profiles) !== JSON.stringify(validation.profiles) || afterProfiles.catalog.defaultProfileId !== expectedInterimDefault) {
        return { ok: false, message: `Highlight settings changed during save. ${HIGHLIGHT_CONFLICT_RECOVERY}` };
      }
      if (defaultChanged && defaultProfileId !== null) await writeDefault(defaultProfileId);
      const saved = readHighlightEditorState();
      if (JSON.stringify(saved.catalog.profiles) !== JSON.stringify(validation.profiles) || saved.catalog.defaultProfileId !== defaultProfileId) {
        return { ok: false, message: `Highlight settings changed during save. ${HIGHLIGHT_CONFLICT_RECOVERY}` };
      }
      return { ok: true, state: saved };
    } catch {
      return { ok: false, message: `Could not save highlight profiles. Check settings permissions. Some settings may have changed. ${HIGHLIGHT_CONFLICT_RECOVERY}` };
    }
  };
  const result = pendingSave.then(save, save);
  pendingSave = result.then(() => undefined, () => undefined);
  return result;
}
