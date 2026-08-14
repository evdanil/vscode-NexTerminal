import { validateRegexSafety } from "./regexSafety";

export interface HighlightRule {
  pattern: string;
  color: string;
  flags?: string;
  bold?: boolean;
  underline?: boolean;
  label?: string;
  description?: string;
  enabled?: boolean;
}

export interface HighlightRuleValidationOk {
  ok: true;
  rules: HighlightRule[];
}

export interface HighlightRuleValidationError {
  ok: false;
  message: string;
}

export type HighlightRuleValidationResult = HighlightRuleValidationOk | HighlightRuleValidationError;

const VALID_COLORS = new Set([
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"
]);

const VALID_FLAGS_RE = /^[gi]*$/;
const MAX_RULES = 100;
const MAX_PATTERN_LENGTH = 500;
const MAX_LABEL_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

function isForegroundCode(code: number): boolean {
  return (code >= 30 && code <= 37) || (code >= 90 && code <= 97);
}

function fail(index: number | undefined, message: string): HighlightRuleValidationError {
  return { ok: false, message: index === undefined ? message : `Rule #${index + 1}: ${message}` };
}

export function validateAndSanitizeHighlightRulesWithError(raw: unknown): HighlightRuleValidationResult {
  if (!Array.isArray(raw)) return fail(undefined, "Highlighting rules must be an array.");
  if (raw.length > MAX_RULES) return fail(undefined, `Too many highlighting rules (max ${MAX_RULES}).`);

  const result: HighlightRule[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) return fail(index, "Rule must be an object.");
    const obj = item as Record<string, unknown>;
    if (typeof obj.pattern !== "string" || obj.pattern.length === 0) return fail(index, "Pattern is required.");
    if (obj.pattern.length > MAX_PATTERN_LENGTH) return fail(index, `Pattern is too long (max ${MAX_PATTERN_LENGTH} characters).`);
    if (typeof obj.color !== "string") return fail(index, "Color is required.");

    if (!VALID_COLORS.has(obj.color)) {
      const code = Number(obj.color);
      if (!Number.isFinite(code) || !isForegroundCode(code)) return fail(index, "Color must be a supported foreground color.");
    }

    const safety = validateRegexSafety(obj.pattern, MAX_PATTERN_LENGTH);
    if (!safety.ok) return fail(index, safety.message);

    const flags = typeof obj.flags === "string" && VALID_FLAGS_RE.test(obj.flags) ? obj.flags : undefined;
    const bold = typeof obj.bold === "boolean" ? obj.bold : undefined;
    const underline = typeof obj.underline === "boolean" ? obj.underline : undefined;
    // Label/description are cosmetic (shown only in the Highlighting Rules
    // editor) — an over-length value is truncated rather than failing the
    // whole array, matching the tolerance already given to a malformed
    // `flags`/`bold`. Failing here would blank the editor ("No highlighting
    // rules defined") on a hand-edited settings.json and set up a wipe-all
    // if the user then hits Save.
    const label = typeof obj.label === "string" && obj.label.length > 0 ? obj.label.slice(0, MAX_LABEL_LENGTH) : undefined;
    const description = typeof obj.description === "string" && obj.description.length > 0
      ? obj.description.slice(0, MAX_DESCRIPTION_LENGTH)
      : undefined;
    // `enabled` gates whether an (often expensive, e.g. IPv6/UUID) pattern
    // actually runs, so unlike the cosmetic fields above a malformed value
    // must fail CLOSED, never open: a present-but-non-boolean value is
    // treated as `false` rather than dropped, so a rule the user disabled
    // can never silently re-enable itself just because its stored value got
    // corrupted to something other than a boolean.
    const enabled = typeof obj.enabled === "boolean" ? obj.enabled : obj.enabled !== undefined ? false : undefined;

    const rule: HighlightRule = { pattern: obj.pattern, color: obj.color };
    if (flags !== undefined) rule.flags = flags;
    if (bold !== undefined) rule.bold = bold;
    if (underline !== undefined) rule.underline = underline;
    if (label !== undefined) rule.label = label;
    if (description !== undefined) rule.description = description;
    if (enabled !== undefined) rule.enabled = enabled;
    result.push(rule);
  }

  return { ok: true, rules: result };
}

export function validateAndSanitizeHighlightRules(raw: unknown): HighlightRule[] | undefined {
  const result = validateAndSanitizeHighlightRulesWithError(raw);
  return result.ok ? result.rules : undefined;
}
