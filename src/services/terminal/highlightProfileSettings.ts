import * as vscode from "vscode";
import type { HighlightCatalog } from "../../models/highlightProfile";
import { isHighlightProfileSelection, validateHighlightProfiles } from "../../utils/highlightProfileValidation";
import { validateAndSanitizeHighlightRules } from "../../utils/highlightRuleValidation";
import { upgradeHighlightRules } from "../../utils/highlightRuleUpgrade";

export const HIGHLIGHT_PROFILES_SECTION = "nexus.terminal.highlighting";
export const HIGHLIGHT_PROFILES_KEY = "profiles";
export const HIGHLIGHT_PROFILES_FULL_KEY = `${HIGHLIGHT_PROFILES_SECTION}.${HIGHLIGHT_PROFILES_KEY}`;
export const HIGHLIGHT_DEFAULT_PROFILE_KEY = "defaultProfile";
export const HIGHLIGHT_DEFAULT_PROFILE_FULL_KEY = `${HIGHLIGHT_PROFILES_SECTION}.${HIGHLIGHT_DEFAULT_PROFILE_KEY}`;
export const LEGACY_HIGHLIGHT_PROFILE_ID = "default";

type SettingReader = (key: string, fallback: unknown) => unknown;

function readCatalog(read: SettingReader): HighlightCatalog {
  const rawDefault = read(HIGHLIGHT_DEFAULT_PROFILE_KEY, LEGACY_HIGHLIGHT_PROFILE_ID);
  const validDefault = rawDefault !== undefined && isHighlightProfileSelection(rawDefault);
  const defaultProfileId = validDefault ? rawDefault as string | null : null;
  const defaultError = validDefault ? undefined : "The default highlight profile must be a profile ID or null.";
  const enabled = read("enabled", true) === true;
  const rawProfiles = read(HIGHLIGHT_PROFILES_KEY, null);
  const validation = validateHighlightProfiles(rawProfiles);
  if (!validation.ok) {
    return { profiles: [], defaultProfileId, enabled, legacy: false, validationError: validation.message };
  }

  if (validation.profiles !== null) {
    return {
      profiles: validation.profiles,
      defaultProfileId, enabled, legacy: false,
      ...(defaultError ? { validationError: defaultError } : {})
    };
  }

  const rawRules = read("rules", []);
  // Match the old runtime's per-rule tolerance, including legacy lists above
  // the new-write bound. A read-only upgrade must not silently lose rules.
  const sanitized = Array.isArray(rawRules)
    ? rawRules.flatMap((rule) => validateAndSanitizeHighlightRules([rule]) ?? [])
    : [];
  return {
    profiles: [{ id: LEGACY_HIGHLIGHT_PROFILE_ID, name: "Default", rules: upgradeHighlightRules(sanitized).rules }],
    defaultProfileId, enabled, legacy: true,
    ...(defaultError ? { validationError: defaultError } : {})
  };
}

/** Effective settings preserve a workspace's legacy behavior until a catalog is configured. */
export function readHighlightCatalog(): HighlightCatalog {
  const config = vscode.workspace.getConfiguration(HIGHLIGHT_PROFILES_SECTION);
  return readCatalog((key, fallback) => config.get<unknown>(key, fallback));
}

/** The editor writes Global: its initial value must not promote workspace data. */
export function readGlobalHighlightCatalogForEditing(): HighlightCatalog {
  const config = vscode.workspace.getConfiguration(HIGHLIGHT_PROFILES_SECTION);
  return readCatalog((key, fallback) => {
    const inspected = config.inspect<unknown>(key);
    if (inspected?.globalValue !== undefined) return inspected.globalValue;
    // VS Code's merged globalValue uses nullish coalescing, so an explicit
    // user null is omitted there even though the individual user layers retain it.
    const layers = inspected as (typeof inspected & { globalLocalValue?: unknown; globalRemoteValue?: unknown });
    if (layers?.globalRemoteValue === null ||
        (layers?.globalRemoteValue === undefined && layers?.globalLocalValue === null)) return null;
    return inspected?.defaultValue !== undefined ? inspected.defaultValue : fallback;
  });
}
