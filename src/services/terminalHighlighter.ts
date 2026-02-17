import * as vscode from "vscode";
import { createAnsiRegex } from "../utils/ansi";

const MAX_INPUT_LENGTH = 8192;

const VALID_FLAGS_RE = /^[gi]*$/;

const COLOR_MAP: Record<string, number> = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  brightblack: 90, brightred: 91, brightgreen: 92, brightyellow: 93,
  brightblue: 94, brightmagenta: 95, brightcyan: 96, brightwhite: 97
};

// Foreground-only raw SGR codes allowed from user config
function isForegroundCode(code: number): boolean {
  return (code >= 30 && code <= 37) || (code >= 90 && code <= 97);
}

const enum SgrClass {
  None,
  FgSet,
  FgReset,
  Reset
}

// Zero-allocation SGR classifier — scans the sequence in-place
function classifySgr(seq: string): SgrClass {
  // SGR sequences: \x1b[ <params> m — minimum length 3
  if (seq.length < 3 || seq.charCodeAt(0) !== 0x1b || seq.charCodeAt(1) !== 0x5b
      || seq.charCodeAt(seq.length - 1) !== 0x6d) {
    return SgrClass.None;
  }

  // Parse semicolon-separated numeric params in-place
  let num = 0;
  let hasDigit = false;
  let foundFg = false;
  let foundReset = false;
  let foundFgReset = false;

  for (let i = 2, len = seq.length - 1; i < len; i++) {
    const ch = seq.charCodeAt(i);
    if (ch >= 0x30 && ch <= 0x39) { // digit
      num = num * 10 + (ch - 0x30);
      hasDigit = true;
    } else if (ch === 0x3b) { // semicolon
      if (!hasDigit) { num = 0; }
      if (num === 0) { foundReset = true; }
      else if (num === 39) { foundFgReset = true; }
      else if ((num >= 30 && num <= 37) || (num >= 90 && num <= 97) || num === 38) { foundFg = true; }
      num = 0;
      hasDigit = false;
    }
  }
  // Process final param
  if (!hasDigit) { num = 0; }
  if (num === 0) { foundReset = true; }
  else if (num === 39) { foundFgReset = true; }
  else if ((num >= 30 && num <= 37) || (num >= 90 && num <= 97) || num === 38) { foundFg = true; }

  // Priority: full reset > fg reset > fg set
  if (foundReset) { return SgrClass.Reset; }
  if (foundFgReset) { return SgrClass.FgReset; }
  if (foundFg) { return SgrClass.FgSet; }
  return SgrClass.None;
}

interface CompiledRule {
  regex: RegExp;
  openCode: string;
  closeCode: string;
}

interface HighlightRule {
  pattern: string;
  color: string;
  flags?: string;
  bold?: boolean;
  underline?: boolean;
}

function compileRule(rule: HighlightRule): CompiledRule | undefined {
  try {
    const rawFlags = typeof rule.flags === "string" ? rule.flags : "gi";
    const flags = VALID_FLAGS_RE.test(rawFlags) ? rawFlags : "gi";
    const regex = new RegExp(rule.pattern, flags);

    // Reject patterns that match empty strings
    if (regex.test("")) {
      return undefined;
    }

    const sgrParts: number[] = [];
    const resetParts: number[] = [];

    const colorLower = rule.color.toLowerCase();
    if (COLOR_MAP[colorLower] !== undefined) {
      sgrParts.push(COLOR_MAP[colorLower]);
      resetParts.push(39);
    } else {
      const code = Number(rule.color);
      // Only allow foreground-range SGR codes from raw numeric input
      if (Number.isFinite(code) && isForegroundCode(code)) {
        sgrParts.push(code);
        resetParts.push(39);
      }
    }

    if (rule.bold) {
      sgrParts.push(1);
      resetParts.push(22);
    }
    if (rule.underline) {
      sgrParts.push(4);
      resetParts.push(24);
    }

    if (sgrParts.length === 0) {
      return undefined;
    }

    return {
      regex,
      openCode: `\x1b[${sgrParts.join(";")}m`,
      closeCode: `\x1b[${resetParts.join(";")}m`
    };
  } catch {
    return undefined;
  }
}

interface Match {
  start: number;
  end: number;
  ruleIndex: number;
}

// Single-pass rule matching: find all matches against original text, resolve overlaps, build result
function applyRulesToPlainText(text: string, rules: CompiledRule[]): string {
  // Collect all matches from all rules against the original text
  const matches: Match[] = [];
  for (let ri = 0; ri < rules.length; ri++) {
    const regex = rules[ri].regex;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m[0].length > 0) {
        matches.push({ start: m.index, end: m.index + m[0].length, ruleIndex: ri });
      }
      // Avoid infinite loop on zero-length matches (should not happen due to compileRule guard)
      if (m[0].length === 0) { regex.lastIndex++; }
    }
  }

  if (matches.length === 0) {
    return text;
  }

  // Sort by start position, then by rule index (earlier rule wins on tie)
  matches.sort((a, b) => a.start - b.start || a.ruleIndex - b.ruleIndex);

  // Discard overlapping matches — first match at each position wins
  const filtered: Match[] = [matches[0]];
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].start >= filtered[filtered.length - 1].end) {
      filtered.push(matches[i]);
    }
  }

  // Build result in one pass
  const parts: string[] = [];
  let pos = 0;
  for (const fm of filtered) {
    if (fm.start > pos) {
      parts.push(text.slice(pos, fm.start));
    }
    const rule = rules[fm.ruleIndex];
    parts.push(rule.openCode, text.slice(fm.start, fm.end), rule.closeCode);
    pos = fm.end;
  }
  if (pos < text.length) {
    parts.push(text.slice(pos));
  }

  return parts.join("");
}

export class TerminalHighlighter {
  private enabled = false;
  private rules: CompiledRule[] = [];

  public constructor() {
    this.reload();
  }

  public reload(): void {
    const config = vscode.workspace.getConfiguration("nexus.terminal.highlighting");
    this.enabled = config.get<boolean>("enabled", true);
    const rawRules = config.get<HighlightRule[]>("rules", []);
    this.rules = [];
    for (const rule of rawRules) {
      if (!rule.pattern || !rule.color) { continue; }
      const compiled = compileRule(rule);
      if (compiled) {
        this.rules.push(compiled);
      }
    }
  }

  public apply(text: string): string {
    if (!this.enabled || this.rules.length === 0) {
      return text;
    }

    // Input length guard — protect against hostile large payloads
    if (text.length > MAX_INPUT_LENGTH) {
      return text;
    }

    // Fast-path for ANSI-free text (common in serial terminals / simple output)
    if (text.indexOf("\x1b") === -1) {
      return applyRulesToPlainText(text, this.rules);
    }

    // Inline ANSI segmentation — process segments as index ranges, no object allocation
    const ansiRe = createAnsiRegex();
    const parts: string[] = [];
    let colorActive = false;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = ansiRe.exec(text)) !== null) {
      // Plain text segment before this ANSI sequence
      if (match.index > lastIndex) {
        const plain = text.slice(lastIndex, match.index);
        parts.push(colorActive ? plain : applyRulesToPlainText(plain, this.rules));
      }

      // ANSI sequence — classify for color tracking
      const seq = match[0];
      const cls = classifySgr(seq);
      if (cls === SgrClass.Reset || cls === SgrClass.FgReset) {
        colorActive = false;
      } else if (cls === SgrClass.FgSet) {
        colorActive = true;
      }
      parts.push(seq);
      lastIndex = ansiRe.lastIndex;
    }

    // Trailing plain text
    if (lastIndex < text.length) {
      const plain = text.slice(lastIndex);
      parts.push(colorActive ? plain : applyRulesToPlainText(plain, this.rules));
    }

    return parts.join("");
  }
}
