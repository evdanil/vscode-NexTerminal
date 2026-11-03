import type { HighlightProfile, HighlightProfileSelection } from "../models/highlightProfile";
import { validateAndSanitizeHighlightRulesWithError } from "./highlightRuleValidation";

export const MAX_HIGHLIGHT_PROFILES = 100;
export const MAX_HIGHLIGHT_PROFILE_ID_LENGTH = 100;
export const MAX_HIGHLIGHT_PROFILE_NAME_LENGTH = 100;

export type HighlightProfileValidationResult =
  | { ok: true; profiles: HighlightProfile[] | null }
  | { ok: false; message: string };

export function isHighlightProfileSelection(value: unknown): value is HighlightProfileSelection {
  return value === undefined || value === null || (
    typeof value === "string" && value.trim().length > 0 && value.length <= MAX_HIGHLIGHT_PROFILE_ID_LENGTH
  );
}

/** The null catalog is the legacy compatibility mode; an empty array is intentional. */
export function validateHighlightProfiles(raw: unknown): HighlightProfileValidationResult {
  if (raw === null) return { ok: true, profiles: null };
  if (!Array.isArray(raw)) return { ok: false, message: "Highlight profiles must be an array or null." };
  if (raw.length > MAX_HIGHLIGHT_PROFILES) {
    return { ok: false, message: `Too many highlight profiles (max ${MAX_HIGHLIGHT_PROFILES}).` };
  }

  const profiles: HighlightProfile[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const fail = (message: string): HighlightProfileValidationResult => ({
      ok: false, message: `Profile #${index + 1}: ${message}`
    });
    if (typeof item !== "object" || item === null || Array.isArray(item)) return fail("Profile must be an object.");
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !isHighlightProfileSelection(record.id)) {
      return fail(`ID must be a nonblank string of at most ${MAX_HIGHLIGHT_PROFILE_ID_LENGTH} characters.`);
    }
    if (ids.has(record.id)) return fail("Profile ID is already used.");
    if (typeof record.name !== "string" || record.name.trim().length === 0 ||
      record.name.trim().length > MAX_HIGHLIGHT_PROFILE_NAME_LENGTH) {
      return fail(`Profile name must contain 1–${MAX_HIGHLIGHT_PROFILE_NAME_LENGTH} characters.`);
    }
    const name = record.name.trim();
    const foldedName = name.toLowerCase();
    if (names.has(foldedName)) return fail("Profile name is already used.");

    const validatedRules = validateAndSanitizeHighlightRulesWithError(record.rules);
    if (!validatedRules.ok) return fail(validatedRules.message);
    for (const [ruleIndex, rule] of validatedRules.rules.entries()) {
      const rawRule = (record.rules as Array<Record<string, unknown>>)[ruleIndex];
      const flags = rawRule.flags;
      // The old reader tolerates malformed flags. New saves must not promise a
      // rule whose actual matching flags silently differ from the editor input.
      if (flags !== undefined && (typeof flags !== "string" || !/^(?:gi|ig|g|i)?$/.test(flags))) {
        return fail(`Rule #${ruleIndex + 1}: Flags may contain g and i once each.`);
      }
      try {
        const regex = new RegExp(rule.pattern, flags === undefined ? "gi" : flags as string);
        if (regex.test("")) return fail(`Rule #${ruleIndex + 1}: Pattern must not match an empty string.`);
      } catch {
        return fail(`Rule #${ruleIndex + 1}: Invalid regular expression.`);
      }
    }
    ids.add(record.id);
    names.add(foldedName);
    profiles.push({ id: record.id, name, rules: validatedRules.rules });
  }
  return { ok: true, profiles };
}
