import { validateRegexSafety } from "./regexSafety";

export interface HighlightRule {
  pattern: string;
  color: string;
  flags?: string;
  bold?: boolean;
  underline?: boolean;
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

    const rule: HighlightRule = { pattern: obj.pattern, color: obj.color };
    if (flags !== undefined) rule.flags = flags;
    if (bold !== undefined) rule.bold = bold;
    if (underline !== undefined) rule.underline = underline;
    result.push(rule);
  }

  return { ok: true, rules: result };
}

export function validateAndSanitizeHighlightRules(raw: unknown): HighlightRule[] | undefined {
  const result = validateAndSanitizeHighlightRulesWithError(raw);
  return result.ok ? result.rules : undefined;
}
