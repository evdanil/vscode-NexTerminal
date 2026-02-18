# Terminal Appearance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add MobaXterm-compatible color schemes and font customization via a rich webview UI panel.

**Architecture:** Standalone `ColorSchemeService` manages scheme storage (globalState), INI parsing, and applying colors to VS Code's `workbench.colorCustomizations`. A dedicated `TerminalAppearancePanel` webview provides the UI with color preview grid, scheme dropdown, font settings, and import buttons. Built-in schemes are hardcoded.

**Tech Stack:** TypeScript, VS Code Extension API (webview, globalState, workspace configuration), Vitest for tests.

---

### Task 1: Color Scheme Data Model

**Files:**
- Create: `src/models/colorScheme.ts`

**Step 1: Create the type definitions**

```typescript
// src/models/colorScheme.ts
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
```

**Step 2: Commit**

```bash
git add src/models/colorScheme.ts
git commit -m "feat: add ColorScheme and TerminalFontConfig data models"
```

---

### Task 2: INI Parser with Tests (TDD)

**Files:**
- Create: `src/services/colorSchemeParser.ts`
- Create: `test/unit/colorSchemeParser.test.ts`

**Step 1: Write the failing tests**

```typescript
// test/unit/colorSchemeParser.test.ts
import { describe, expect, it } from "vitest";
import { parseMobaXtermIni, rgbToHex, deriveSelectionBackground } from "../../src/services/colorSchemeParser";

describe("rgbToHex", () => {
  it("converts RGB triplet string to hex", () => {
    expect(rgbToHex("30,30,46")).toBe("#1e1e2e");
  });

  it("converts white", () => {
    expect(rgbToHex("255,255,255")).toBe("#ffffff");
  });

  it("converts black", () => {
    expect(rgbToHex("0,0,0")).toBe("#000000");
  });

  it("pads single-digit hex values", () => {
    expect(rgbToHex("1,2,3")).toBe("#010203");
  });
});

describe("deriveSelectionBackground", () => {
  it("blends foreground over background at 30% opacity", () => {
    // fg=#ffffff, bg=#000000 at 30% => each channel = 0 + 0.3*(255-0) = 76.5 => 77 => #4d4d4d
    const result = deriveSelectionBackground("#ffffff", "#000000");
    expect(result).toBe("#4d4d4d");
  });
});

describe("parseMobaXtermIni", () => {
  const catppuccinIni = `
;Paste the following configurations in the corresponding place in MobaXterm.ini.
;Theme: Catppuccin Mocha
[Colors]
DefaultColorScheme=0
BackgroundColour=30,30,46
ForegroundColour=205,214,244
CursorColour=245,224,220
Black=69,71,90
Red=243,139,168
Green=166,227,161
Yellow=249,226,175
Blue=137,180,250
Magenta=245,194,231
Cyan=148,226,213
White=166,173,200
BoldBlack=88,91,112
BoldRed=243,119,153
BoldGreen=137,216,139
BoldYellow=235,211,145
BoldBlue=116,168,252
BoldMagenta=242,174,222
BoldCyan=107,215,202
BoldWhite=186,194,222
`;

  it("parses a valid MobaXterm INI into a ColorScheme", () => {
    const scheme = parseMobaXtermIni(catppuccinIni, "Catppuccin Mocha");
    expect(scheme).not.toBeNull();
    expect(scheme!.name).toBe("Catppuccin Mocha");
    expect(scheme!.builtIn).toBe(false);
    expect(scheme!.background).toBe("#1e1e2e");
    expect(scheme!.foreground).toBe("#cdd6f4");
    expect(scheme!.cursor).toBe("#f5e0dc");
    expect(scheme!.black).toBe("#45475a");
    expect(scheme!.red).toBe("#f38ba8");
    expect(scheme!.green).toBe("#a6e3a1");
    expect(scheme!.brightBlack).toBe("#585b70");
    expect(scheme!.brightWhite).toBe("#bac2de");
  });

  it("generates a UUID id", () => {
    const scheme = parseMobaXtermIni(catppuccinIni, "Test");
    expect(scheme!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("derives selectionBackground from foreground and background", () => {
    const scheme = parseMobaXtermIni(catppuccinIni, "Test");
    expect(scheme!.selectionBackground).toBeTruthy();
    expect(scheme!.selectionBackground).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("returns null for invalid INI (no [Colors] section)", () => {
    const result = parseMobaXtermIni("[Other]\nfoo=bar", "Bad");
    expect(result).toBeNull();
  });

  it("returns null for INI missing required keys", () => {
    const result = parseMobaXtermIni("[Colors]\nBackgroundColour=0,0,0", "Partial");
    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/colorSchemeParser.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement the parser**

```typescript
// src/services/colorSchemeParser.ts
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

  // Check all required keys are present
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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/colorSchemeParser.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/services/colorSchemeParser.ts test/unit/colorSchemeParser.test.ts
git commit -m "feat: add MobaXterm INI color scheme parser with tests"
```

---

### Task 3: Built-in Color Schemes

**Files:**
- Create: `src/services/builtinSchemes.ts`

**Step 1: Create built-in schemes data**

Create `src/services/builtinSchemes.ts` with a `BUILTIN_SCHEMES: ColorScheme[]` array containing hardcoded data for these 8 schemes. Each has a stable `id` like `"builtin-catppuccin-mocha"` and `builtIn: true`. The color values come from the iTerm2-Color-Schemes project's MobaXterm INI files. Include:

1. **Catppuccin Mocha** - warm dark theme with pastel colors
2. **Dracula** - popular dark purple theme
3. **Solarized Dark** - Ethan Schoonover's dark variant
4. **Solarized Light** - Ethan Schoonover's light variant
5. **Nord** - arctic blue-ish dark theme
6. **Gruvbox Dark** - retro groove dark theme
7. **One Dark** - Atom editor's dark theme
8. **Tokyo Night** - dark theme inspired by Tokyo city lights

Source the exact RGB values from the iTerm2-Color-Schemes repository's MobaXterm folder. Convert to hex. Derive `selectionBackground` using `deriveSelectionBackground()`.

**Step 2: Commit**

```bash
git add src/services/builtinSchemes.ts
git commit -m "feat: add 8 built-in color schemes"
```

---

### Task 4: Color Scheme Service with Tests (TDD)

**Files:**
- Create: `src/services/colorSchemeService.ts`
- Create: `test/unit/colorSchemeService.test.ts`

**Step 1: Write the failing tests**

The service needs a storage abstraction for testing. Use a simple interface `ColorSchemeStorage` with get/set methods, and an in-memory implementation for tests.

```typescript
// test/unit/colorSchemeService.test.ts
import { describe, expect, it, vi } from "vitest";
import { ColorSchemeService, InMemoryColorSchemeStorage } from "../../src/services/colorSchemeService";
import { BUILTIN_SCHEMES } from "../../src/services/builtinSchemes";

describe("ColorSchemeService", () => {
  function createService(userSchemes: ColorScheme[] = [], activeId = "") {
    const storage = new InMemoryColorSchemeStorage(userSchemes, activeId);
    return new ColorSchemeService(storage);
  }

  it("getAllSchemes returns built-in + user schemes", () => {
    const userScheme = { ...BUILTIN_SCHEMES[0], id: "custom-1", name: "Custom", builtIn: false };
    const service = createService([userScheme]);
    const all = service.getAllSchemes();
    expect(all.length).toBe(BUILTIN_SCHEMES.length + 1);
    expect(all.find(s => s.id === "custom-1")).toBeTruthy();
  });

  it("addSchemes persists user schemes", async () => {
    const storage = new InMemoryColorSchemeStorage();
    const service = new ColorSchemeService(storage);
    const scheme = { ...BUILTIN_SCHEMES[0], id: "new-1", name: "New", builtIn: false };
    await service.addSchemes([scheme]);
    expect(service.getAllSchemes().find(s => s.id === "new-1")).toBeTruthy();
  });

  it("removeScheme removes user scheme", async () => {
    const scheme = { ...BUILTIN_SCHEMES[0], id: "del-1", name: "Del", builtIn: false };
    const service = createService([scheme]);
    await service.removeScheme("del-1");
    expect(service.getAllSchemes().find(s => s.id === "del-1")).toBeUndefined();
  });

  it("removeScheme refuses to delete built-in scheme", async () => {
    const service = createService();
    const builtInId = BUILTIN_SCHEMES[0].id;
    await service.removeScheme(builtInId);
    expect(service.getAllSchemes().find(s => s.id === builtInId)).toBeTruthy();
  });

  it("getActiveSchemeId returns stored active id", () => {
    const service = createService([], "builtin-dracula");
    expect(service.getActiveSchemeId()).toBe("builtin-dracula");
  });

  it("setActiveSchemeId persists the active id", async () => {
    const storage = new InMemoryColorSchemeStorage();
    const service = new ColorSchemeService(storage);
    await service.setActiveSchemeId("builtin-nord");
    expect(service.getActiveSchemeId()).toBe("builtin-nord");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/colorSchemeService.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement the service**

```typescript
// src/services/colorSchemeService.ts
import type { ColorScheme, TerminalFontConfig } from "../models/colorScheme";
import { BUILTIN_SCHEMES } from "./builtinSchemes";

export interface ColorSchemeStorage {
  getUserSchemes(): ColorScheme[];
  saveUserSchemes(schemes: ColorScheme[]): Promise<void>;
  getActiveSchemeId(): string;
  saveActiveSchemeId(id: string): Promise<void>;
  getFontConfig(): TerminalFontConfig | undefined;
  saveFontConfig(config: TerminalFontConfig): Promise<void>;
}

export class InMemoryColorSchemeStorage implements ColorSchemeStorage {
  constructor(
    private schemes: ColorScheme[] = [],
    private activeId: string = "",
    private font?: TerminalFontConfig
  ) {}

  getUserSchemes(): ColorScheme[] { return [...this.schemes]; }
  async saveUserSchemes(schemes: ColorScheme[]): Promise<void> { this.schemes = [...schemes]; }
  getActiveSchemeId(): string { return this.activeId; }
  async saveActiveSchemeId(id: string): Promise<void> { this.activeId = id; }
  getFontConfig(): TerminalFontConfig | undefined { return this.font; }
  async saveFontConfig(config: TerminalFontConfig): Promise<void> { this.font = config; }
}

export class ColorSchemeService {
  private userSchemes: ColorScheme[];
  private activeId: string;
  private fontConfig: TerminalFontConfig | undefined;

  constructor(private readonly storage: ColorSchemeStorage) {
    this.userSchemes = storage.getUserSchemes();
    this.activeId = storage.getActiveSchemeId();
    this.fontConfig = storage.getFontConfig();
  }

  getAllSchemes(): ColorScheme[] {
    return [...BUILTIN_SCHEMES, ...this.userSchemes];
  }

  getActiveSchemeId(): string {
    return this.activeId;
  }

  async setActiveSchemeId(id: string): Promise<void> {
    this.activeId = id;
    await this.storage.saveActiveSchemeId(id);
  }

  getSchemeById(id: string): ColorScheme | undefined {
    return this.getAllSchemes().find((s) => s.id === id);
  }

  async addSchemes(schemes: ColorScheme[]): Promise<void> {
    this.userSchemes.push(...schemes);
    await this.storage.saveUserSchemes(this.userSchemes);
  }

  async removeScheme(id: string): Promise<void> {
    const idx = this.userSchemes.findIndex((s) => s.id === id);
    if (idx === -1) return; // built-in or not found — do nothing
    this.userSchemes.splice(idx, 1);
    await this.storage.saveUserSchemes(this.userSchemes);
    if (this.activeId === id) {
      await this.setActiveSchemeId("");
    }
  }

  getFontConfig(): TerminalFontConfig | undefined {
    return this.fontConfig;
  }

  async saveFontConfig(config: TerminalFontConfig): Promise<void> {
    this.fontConfig = config;
    await this.storage.saveFontConfig(config);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/colorSchemeService.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/services/colorSchemeService.ts test/unit/colorSchemeService.test.ts
git commit -m "feat: add ColorSchemeService with storage abstraction and tests"
```

---

### Task 5: VS Code Settings Applier

**Files:**
- Create: `src/services/colorSchemeApplier.ts`
- Create: `test/unit/colorSchemeApplier.test.ts`

This module maps a `ColorScheme` to VS Code's `workbench.colorCustomizations` and applies font config to `terminal.integrated.*`. It's separated from the service for testability.

**Step 1: Write failing tests**

```typescript
// test/unit/colorSchemeApplier.test.ts
import { describe, expect, it } from "vitest";
import { buildColorCustomizations, buildTerminalColorKeys } from "../../src/services/colorSchemeApplier";
import { BUILTIN_SCHEMES } from "../../src/services/builtinSchemes";

describe("buildTerminalColorKeys", () => {
  it("maps a ColorScheme to VS Code terminal color keys", () => {
    const scheme = BUILTIN_SCHEMES[0];
    const keys = buildTerminalColorKeys(scheme);
    expect(keys["terminal.background"]).toBe(scheme.background);
    expect(keys["terminal.foreground"]).toBe(scheme.foreground);
    expect(keys["terminalCursor.foreground"]).toBe(scheme.cursor);
    expect(keys["terminal.selectionBackground"]).toBe(scheme.selectionBackground);
    expect(keys["terminal.ansiBlack"]).toBe(scheme.black);
    expect(keys["terminal.ansiRed"]).toBe(scheme.red);
    expect(keys["terminal.ansiGreen"]).toBe(scheme.green);
    expect(keys["terminal.ansiYellow"]).toBe(scheme.yellow);
    expect(keys["terminal.ansiBlue"]).toBe(scheme.blue);
    expect(keys["terminal.ansiMagenta"]).toBe(scheme.magenta);
    expect(keys["terminal.ansiCyan"]).toBe(scheme.cyan);
    expect(keys["terminal.ansiWhite"]).toBe(scheme.white);
    expect(keys["terminal.ansiBrightBlack"]).toBe(scheme.brightBlack);
    expect(keys["terminal.ansiBrightRed"]).toBe(scheme.brightRed);
    expect(keys["terminal.ansiBrightGreen"]).toBe(scheme.brightGreen);
    expect(keys["terminal.ansiBrightYellow"]).toBe(scheme.brightYellow);
    expect(keys["terminal.ansiBrightBlue"]).toBe(scheme.brightBlue);
    expect(keys["terminal.ansiBrightMagenta"]).toBe(scheme.brightMagenta);
    expect(keys["terminal.ansiBrightCyan"]).toBe(scheme.brightCyan);
    expect(keys["terminal.ansiBrightWhite"]).toBe(scheme.brightWhite);
  });
});

describe("buildColorCustomizations", () => {
  it("merges terminal colors into existing customizations", () => {
    const existing = { "editor.background": "#111111", "terminal.background": "#old" };
    const scheme = BUILTIN_SCHEMES[0];
    const result = buildColorCustomizations(existing, scheme);
    expect(result["editor.background"]).toBe("#111111"); // preserved
    expect(result["terminal.background"]).toBe(scheme.background); // overwritten
  });

  it("removes terminal keys when scheme is null (reset)", () => {
    const existing = { "editor.background": "#111111", "terminal.background": "#old", "terminal.ansiRed": "#red" };
    const result = buildColorCustomizations(existing, null);
    expect(result["editor.background"]).toBe("#111111");
    expect(result["terminal.background"]).toBeUndefined();
    expect(result["terminal.ansiRed"]).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/colorSchemeApplier.test.ts`
Expected: FAIL

**Step 3: Implement the applier**

```typescript
// src/services/colorSchemeApplier.ts
import type { ColorScheme } from "../models/colorScheme";

const SCHEME_TO_VSCODE_MAP: Record<string, string> = {
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
    result[vscodeKey] = (scheme as Record<string, string>)[schemeProp];
  }
  return result;
}

export function buildColorCustomizations(
  existing: Record<string, string>,
  scheme: ColorScheme | null
): Record<string, string> {
  // Remove all terminal-related keys
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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/colorSchemeApplier.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/services/colorSchemeApplier.ts test/unit/colorSchemeApplier.test.ts
git commit -m "feat: add color scheme to VS Code settings mapper with tests"
```

---

### Task 6: VS Code Storage Adapter

**Files:**
- Create: `src/storage/vscodeColorSchemeStorage.ts`

This implements `ColorSchemeStorage` backed by `globalState`, similar to how `VscodeConfigRepository` works (see `src/storage/vscodeConfigRepository.ts` for the pattern).

**Step 1: Implement the storage adapter**

```typescript
// src/storage/vscodeColorSchemeStorage.ts
import * as vscode from "vscode";
import type { ColorScheme, TerminalFontConfig } from "../models/colorScheme";
import type { ColorSchemeStorage } from "../services/colorSchemeService";

const SCHEMES_KEY = "nexus.colorSchemes";
const ACTIVE_SCHEME_KEY = "nexus.activeColorScheme";
const FONT_KEY = "nexus.terminalFont";

export class VscodeColorSchemeStorage implements ColorSchemeStorage {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getUserSchemes(): ColorScheme[] {
    return this.context.globalState.get<ColorScheme[]>(SCHEMES_KEY, []);
  }

  async saveUserSchemes(schemes: ColorScheme[]): Promise<void> {
    await this.context.globalState.update(SCHEMES_KEY, schemes);
  }

  getActiveSchemeId(): string {
    return this.context.globalState.get<string>(ACTIVE_SCHEME_KEY, "");
  }

  async saveActiveSchemeId(id: string): Promise<void> {
    await this.context.globalState.update(ACTIVE_SCHEME_KEY, id);
  }

  getFontConfig(): TerminalFontConfig | undefined {
    return this.context.globalState.get<TerminalFontConfig>(FONT_KEY);
  }

  async saveFontConfig(config: TerminalFontConfig): Promise<void> {
    await this.context.globalState.update(FONT_KEY, config);
  }
}
```

**Step 2: Commit**

```bash
git add src/storage/vscodeColorSchemeStorage.ts
git commit -m "feat: add VS Code globalState adapter for color scheme storage"
```

---

### Task 7: Terminal Appearance Webview HTML

**Files:**
- Create: `src/ui/terminalAppearanceHtml.ts`

This is the HTML/CSS/JS for the webview panel. Uses the same pattern as `src/ui/formHtml.ts` (VS Code CSS variables, nonce for CSP, acquireVsCodeApi for messaging).

**Step 1: Create the webview HTML renderer**

The function `renderTerminalAppearanceHtml(schemes, activeSchemeId, fontConfig, nonce)` returns a full HTML string.

Layout:
- **Section 1 - Font Settings**: family text input with datalist suggestions, size number input, weight select dropdown, "Apply Font" button
- **Section 2 - Color Scheme**: select dropdown with scheme names, a color preview grid (4x5 grid showing bg, fg, cursor, selection + 16 ANSI colors as colored squares with labels), "Import File" / "Import Directory" / "Delete Scheme" buttons

Messaging (script):
- On scheme select change: `postMessage({ type: "selectScheme", schemeId })`
- On Import File click: `postMessage({ type: "importFile" })`
- On Import Directory click: `postMessage({ type: "importDirectory" })`
- On Delete click: `postMessage({ type: "deleteScheme", schemeId })`
- On Apply Font click: `postMessage({ type: "applyFont", family, size, weight })`
- Listen for `schemesUpdated` message to refresh dropdown and preview
- Listen for `fontUpdated` message to refresh font fields

Style the color preview grid as small colored squares (~32x32px) with a border, 4 per row. Show color name below each swatch. Use VS Code CSS variables for the panel background/text, matching the existing form styling in `src/ui/formHtml.ts`.

**Step 2: Commit**

```bash
git add src/ui/terminalAppearanceHtml.ts
git commit -m "feat: add terminal appearance webview HTML renderer"
```

---

### Task 8: Terminal Appearance Panel Controller

**Files:**
- Create: `src/ui/terminalAppearancePanel.ts`

This follows the pattern of `src/ui/webviewFormPanel.ts` — singleton webview panel that handles messages.

**Step 1: Implement the panel**

```typescript
// src/ui/terminalAppearancePanel.ts
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ColorScheme, TerminalFontConfig } from "../models/colorScheme";
import { parseMobaXtermIni } from "../services/colorSchemeParser";
import { buildColorCustomizations } from "../services/colorSchemeApplier";
import type { ColorSchemeService } from "../services/colorSchemeService";
import { renderTerminalAppearanceHtml } from "./terminalAppearanceHtml";

export class TerminalAppearancePanel {
  private static instance: TerminalAppearancePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  private constructor(private readonly service: ColorSchemeService) {
    this.panel = vscode.window.createWebviewPanel(
      "nexus.terminalAppearance",
      "Terminal Appearance",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.render();
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      TerminalAppearancePanel.instance = undefined;
    });
  }

  public static open(service: ColorSchemeService): void {
    if (TerminalAppearancePanel.instance) {
      TerminalAppearancePanel.instance.panel.reveal();
      return;
    }
    TerminalAppearancePanel.instance = new TerminalAppearancePanel(service);
  }

  private render(): void {
    const nonce = randomBytes(16).toString("base64");
    this.panel.webview.html = renderTerminalAppearanceHtml(
      this.service.getAllSchemes(),
      this.service.getActiveSchemeId(),
      this.service.getFontConfig(),
      nonce
    );
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "selectScheme":
        await this.applyScheme(msg.schemeId as string);
        break;
      case "importFile":
        await this.importFile();
        break;
      case "importDirectory":
        await this.importDirectory();
        break;
      case "deleteScheme":
        await this.deleteScheme(msg.schemeId as string);
        break;
      case "applyFont":
        await this.applyFont(msg as { family: string; size: number; weight: string });
        break;
    }
  }

  private async applyScheme(schemeId: string): Promise<void> {
    await this.service.setActiveSchemeId(schemeId);
    const scheme = schemeId ? this.service.getSchemeById(schemeId) ?? null : null;
    const config = vscode.workspace.getConfiguration("workbench");
    const existing = config.get<Record<string, string>>("colorCustomizations", {});
    const updated = buildColorCustomizations(existing, scheme);
    await config.update("colorCustomizations", updated, vscode.ConfigurationTarget.Global);
    this.pushUpdate();
  }

  private async importFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      filters: { "MobaXterm INI": ["ini"] },
      title: "Import Color Scheme (.ini)"
    });
    if (!uris || uris.length === 0) return;
    const schemes = await this.parseIniFiles(uris.map((u) => u.fsPath));
    if (schemes.length > 0) {
      await this.service.addSchemes(schemes);
      this.pushUpdate();
      vscode.window.showInformationMessage(`Imported ${schemes.length} color scheme(s).`);
    }
  }

  private async importDirectory(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: "Import Color Schemes from Directory"
    });
    if (!uris || uris.length === 0) return;
    const dir = uris[0].fsPath;
    const files = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".ini"))
      .map((f) => path.join(dir, f));
    const schemes = await this.parseIniFiles(files);
    if (schemes.length > 0) {
      await this.service.addSchemes(schemes);
      this.pushUpdate();
      vscode.window.showInformationMessage(`Imported ${schemes.length} color scheme(s) from directory.`);
    } else {
      vscode.window.showWarningMessage("No valid .ini color scheme files found in directory.");
    }
  }

  private async parseIniFiles(filePaths: string[]): Promise<ColorScheme[]> {
    const schemes: ColorScheme[] = [];
    for (const filePath of filePaths) {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const name = path.basename(filePath, ".ini");
        const scheme = parseMobaXtermIni(content, name);
        if (scheme) {
          schemes.push(scheme);
        }
      } catch {
        // skip unreadable files
      }
    }
    return schemes;
  }

  private async deleteScheme(schemeId: string): Promise<void> {
    const scheme = this.service.getSchemeById(schemeId);
    if (!scheme || scheme.builtIn) return;
    await this.service.removeScheme(schemeId);
    if (this.service.getActiveSchemeId() === schemeId) {
      await this.applyScheme("");
    }
    this.pushUpdate();
  }

  private async applyFont(msg: { family: string; size: number; weight: string }): Promise<void> {
    const config: TerminalFontConfig = {
      family: msg.family,
      size: msg.size,
      weight: msg.weight
    };
    await this.service.saveFontConfig(config);
    const termConfig = vscode.workspace.getConfiguration("terminal.integrated");
    if (config.family) {
      await termConfig.update("fontFamily", config.family, vscode.ConfigurationTarget.Global);
    }
    if (config.size > 0) {
      await termConfig.update("fontSize", config.size, vscode.ConfigurationTarget.Global);
    }
    if (config.weight) {
      await termConfig.update("fontWeight", config.weight, vscode.ConfigurationTarget.Global);
    }
    vscode.window.showInformationMessage("Terminal font settings applied.");
  }

  private pushUpdate(): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({
      type: "schemesUpdated",
      schemes: this.service.getAllSchemes(),
      activeId: this.service.getActiveSchemeId()
    });
  }
}
```

**Step 2: Commit**

```bash
git add src/ui/terminalAppearancePanel.ts
git commit -m "feat: add terminal appearance webview panel controller"
```

---

### Task 9: Wire Into Extension

**Files:**
- Modify: `package.json` (commands array, ~line 87)
- Modify: `src/extension.ts` (activate function)
- Modify: `src/ui/settingsTreeProvider.ts` (add appearance item)
- Modify: `src/commands/settingsCommands.ts` (handle click)

**Step 1: Add command to package.json**

In the `commands` array (after the existing settings commands around line 120), add:

```json
{ "command": "nexus.terminal.appearance", "title": "Nexus: Terminal Appearance", "icon": "$(paintcan)" }
```

**Step 2: Add appearance item to settings tree**

In `src/ui/settingsTreeProvider.ts`, add a new tree item type `AppearanceTreeItem` that opens the webview when clicked, and include it in `getChildren()`. It should show the currently active scheme name as description (or "Default" if none).

**Step 3: Wire service in extension.ts**

In `src/extension.ts:activate()`, after the highlighter creation (~line 141):

```typescript
import { VscodeColorSchemeStorage } from "./storage/vscodeColorSchemeStorage";
import { ColorSchemeService } from "./services/colorSchemeService";
import { TerminalAppearancePanel } from "./ui/terminalAppearancePanel";

// In activate(), after highlighter creation:
const colorSchemeStorage = new VscodeColorSchemeStorage(context);
const colorSchemeService = new ColorSchemeService(colorSchemeStorage);
```

Register the command:

```typescript
const appearanceCommand = vscode.commands.registerCommand("nexus.terminal.appearance", () => {
  TerminalAppearancePanel.open(colorSchemeService);
});
```

Add `appearanceCommand` to `context.subscriptions.push(...)`.

Update `registerSettingsCommands` to receive `colorSchemeService` and handle the appearance tree item click.

**Step 4: Handle appearance click in settingsCommands.ts**

In `src/commands/settingsCommands.ts`, add handling for when the clicked item is the appearance item — call `TerminalAppearancePanel.open(colorSchemeService)`.

**Step 5: Run build to verify no type errors**

Run: `npm run compile`
Expected: No errors

**Step 6: Commit**

```bash
git add package.json src/extension.ts src/ui/settingsTreeProvider.ts src/commands/settingsCommands.ts
git commit -m "feat: wire terminal appearance into extension activation and settings tree"
```

---

### Task 10: Manual Testing & Polish

**Step 1: Build and test in VS Code**

Run: `npm run build`

Launch the extension in Extension Development Host (F5).

Test the following scenarios:
1. Open Terminal Appearance from Settings tree or command palette
2. Select a built-in color scheme — verify terminal colors change instantly
3. Switch between schemes — verify colors update
4. Select "None" — verify colors reset
5. Import a single `.ini` file — verify it appears in dropdown
6. Import a directory of `.ini` files — verify all appear
7. Delete an imported scheme — verify it's removed
8. Try to delete a built-in scheme — verify it's prevented
9. Change font family/size/weight — verify terminal font updates
10. Close and reopen VS Code — verify active scheme and imported schemes persist

**Step 2: Run all tests**

Run: `npm test`
Expected: All tests pass

**Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: polish terminal appearance panel"
```
