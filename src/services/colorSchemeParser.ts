import { randomUUID } from "node:crypto";
import type { ColorScheme } from "../models/colorScheme";

export function rgbToHex(rgb: string): string {
  const parts = rgb.split(",").map((s) => parseInt(s.trim(), 10));
  if (parts.length !== 3 || parts.some((n) => isNaN(n) || n < 0 || n > 255)) {
    return "#000000";
  }
  return "#" + parts.map((n) => n.toString(16).padStart(2, "0")).join("");
}

export function deriveSelectionBackground(foreground: string, background: string): string {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  const alpha = 0.3;
  const r = Math.round(bg.r + alpha * (fg.r - bg.r));
  const g = Math.round(bg.g + alpha * (fg.g - bg.g));
  const b = Math.round(bg.b + alpha * (fg.b - bg.b));
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16)
  };
}

const INI_KEY_MAP: Record<string, keyof ColorScheme> = {
  ForegroundColour: "foreground",
  BackgroundColour: "background",
  CursorColour: "cursor",
  Black: "black",
  Red: "red",
  Green: "green",
  Yellow: "yellow",
  Blue: "blue",
  Magenta: "magenta",
  Cyan: "cyan",
  White: "white",
  BoldBlack: "brightBlack",
  BoldRed: "brightRed",
  BoldGreen: "brightGreen",
  BoldYellow: "brightYellow",
  BoldBlue: "brightBlue",
  BoldMagenta: "brightMagenta",
  BoldCyan: "brightCyan",
  BoldWhite: "brightWhite"
};

const REQUIRED_INI_KEYS = Object.keys(INI_KEY_MAP);

export function parseMobaXtermIni(content: string, name: string): ColorScheme | null {
  const lines = content.split(/\r?\n/);
  let inColors = false;
  const values: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inColors = trimmed.toLowerCase() === "[colors]";
      continue;
    }
    if (!inColors || trimmed.startsWith(";") || !trimmed.includes("=")) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();
    values[key] = value;
  }

  for (const key of REQUIRED_INI_KEYS) {
    if (!(key in values)) {
      return null;
    }
  }

  const colors: Record<string, string> = {};
  for (const [iniKey, schemeKey] of Object.entries(INI_KEY_MAP)) {
    colors[schemeKey] = rgbToHex(values[iniKey]);
  }

  const fg = colors["foreground"];
  const bg = colors["background"];

  return {
    id: randomUUID(),
    name,
    builtIn: false,
    selectionBackground: deriveSelectionBackground(fg, bg),
    ...colors
  } as ColorScheme;
}
