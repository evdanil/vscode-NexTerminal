import { serializeForInlineScript } from "../ui/shared/inlineScriptData";

export interface RegexSafetyOk {
  ok: true;
}

export interface RegexSafetyError {
  ok: false;
  message: string;
}

export type RegexSafetyResult = RegexSafetyOk | RegexSafetyError;

const MAX_PATTERN_LENGTH = 500;
const GROUP_START_SOURCE = String.raw`\((?:\?(?::|=|!|<=|<!|<[^>]+>))?`;
const GROUP_BODY_SOURCE = String.raw`(?:[^()\\]|\\.)*`;
const INNER_QUANTIFIER_SOURCE = String.raw`(?:[+*]|\{\d+(?:,\d*)?\})`;
const REQUIRED_DELIMITER_AFTER_INNER_SOURCE = String.raw`(?![:./-])`;
const OUTER_UNBOUNDED_QUANTIFIER_SOURCE = String.raw`(?:[+*]|\{\d+,\})`;
const NESTED_QUANTIFIER_SOURCE = `${GROUP_START_SOURCE}${GROUP_BODY_SOURCE}${INNER_QUANTIFIER_SOURCE}${REQUIRED_DELIMITER_AFTER_INNER_SOURCE}${GROUP_BODY_SOURCE}\\)${OUTER_UNBOUNDED_QUANTIFIER_SOURCE}`;
const QUANTIFIED_ALTERNATION_SOURCE = `${GROUP_START_SOURCE}${GROUP_BODY_SOURCE}\\|${GROUP_BODY_SOURCE}\\)${OUTER_UNBOUNDED_QUANTIFIER_SOURCE}`;
const NESTED_QUANTIFIER_RE = new RegExp(NESTED_QUANTIFIER_SOURCE);
const QUANTIFIED_ALTERNATION_RE = new RegExp(QUANTIFIED_ALTERNATION_SOURCE);

export function validateRegexSafety(pattern: unknown, maxLength = MAX_PATTERN_LENGTH): RegexSafetyResult {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { ok: false, message: "Pattern is required." };
  }
  if (pattern.length > maxLength) {
    return { ok: false, message: `Pattern is too long (max ${maxLength} characters).` };
  }
  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    return { ok: false, message: "Pattern rejected: nested quantifiers can hang terminal processing." };
  }
  if (QUANTIFIED_ALTERNATION_RE.test(pattern)) {
    return { ok: false, message: "Pattern rejected: quantified alternation can hang terminal processing." };
  }
  return { ok: true };
}

export function regexSafetyWebviewJs(maxLength = MAX_PATTERN_LENGTH): string {
  return `
      function validateRegexSafety(pattern) {
        if (typeof pattern !== "string" || pattern.length === 0) {
          return "Pattern is required.";
        }
        if (pattern.length > ${maxLength}) {
          return "Pattern is too long (max ${maxLength} characters).";
        }
        var nestedQuantifierPattern = new RegExp(${serializeForInlineScript(NESTED_QUANTIFIER_SOURCE)});
        if (nestedQuantifierPattern.test(pattern)) {
          return "Pattern rejected: nested quantifiers can hang terminal processing.";
        }
        var quantifiedAlternationPattern = new RegExp(${serializeForInlineScript(QUANTIFIED_ALTERNATION_SOURCE)});
        if (quantifiedAlternationPattern.test(pattern)) {
          return "Pattern rejected: quantified alternation can hang terminal processing.";
        }
        return "";
      }
`;
}
