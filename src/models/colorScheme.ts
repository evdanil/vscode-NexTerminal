export interface ColorScheme {
  id: string;
  name: string;
  builtIn: boolean;
  foreground: string;
  background: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TerminalFontConfig {
  family: string;
  size: number;
  weight: string;
}

/** Keys in a ColorScheme that hold color hex values (excludes id, name, builtIn). */
export const COLOR_KEYS = [
  "foreground", "background", "cursor", "selectionBackground",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite"
] as const;

export type ColorKey = (typeof COLOR_KEYS)[number];
