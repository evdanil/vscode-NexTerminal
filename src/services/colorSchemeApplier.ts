import type { ColorScheme, ColorKey } from "../models/colorScheme";

const SCHEME_TO_VSCODE_MAP: Record<ColorKey, string> = {
  background: "terminal.background",
  foreground: "terminal.foreground",
  cursor: "terminalCursor.foreground",
  selectionBackground: "terminal.selectionBackground",
  black: "terminal.ansiBlack",
  red: "terminal.ansiRed",
  green: "terminal.ansiGreen",
  yellow: "terminal.ansiYellow",
  blue: "terminal.ansiBlue",
  magenta: "terminal.ansiMagenta",
  cyan: "terminal.ansiCyan",
  white: "terminal.ansiWhite",
  brightBlack: "terminal.ansiBrightBlack",
  brightRed: "terminal.ansiBrightRed",
  brightGreen: "terminal.ansiBrightGreen",
  brightYellow: "terminal.ansiBrightYellow",
  brightBlue: "terminal.ansiBrightBlue",
  brightMagenta: "terminal.ansiBrightMagenta",
  brightCyan: "terminal.ansiBrightCyan",
  brightWhite: "terminal.ansiBrightWhite"
};

const TERMINAL_KEY_PREFIXES = ["terminal.", "terminalCursor."];

export function buildTerminalColorKeys(scheme: ColorScheme): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [schemeProp, vscodeKey] of Object.entries(SCHEME_TO_VSCODE_MAP)) {
    result[vscodeKey] = scheme[schemeProp as ColorKey];
  }
  return result;
}

export function buildColorCustomizations(
  existing: Record<string, string>,
  scheme: ColorScheme | null
): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!TERMINAL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      cleaned[key] = value;
    }
  }

  if (scheme === null) {
    return cleaned;
  }

  return { ...cleaned, ...buildTerminalColorKeys(scheme) };
}

/**
 * Normalize the value to write to `workbench.colorCustomizations`.
 *
 * When the merged object is empty (e.g. clearing the scheme with no other
 * non-terminal keys present in the global scope), writing `undefined` removes
 * the key from settings.json entirely — cleaner than persisting an empty `{}`
 * that VS Code would otherwise leave behind.
 *
 * The `existing` base MUST come from the SAME scope being written
 * (`inspect().globalValue`), never the effective merged value, or workspace /
 * default-scoped keys would leak into the global file (read-scope ==
 * write-scope invariant).
 */
export function colorCustomizationsWriteValue(
  merged: Record<string, string>
): Record<string, string> | undefined {
  return Object.keys(merged).length === 0 ? undefined : merged;
}
