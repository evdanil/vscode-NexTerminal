# Terminal Appearance: Color Schemes & Font Settings

**Date:** 2026-02-18
**Status:** Approved

## Overview

Add MobaXterm-compatible color scheme support and font customization to Nexus Terminal. Users can import `.ini` color scheme files (compatible with the iTerm2-Color-Schemes MobaXterm collection), select schemes from a dropdown with instant preview, and configure terminal font properties. All settings are applied globally to VS Code's terminal via `workbench.colorCustomizations` and `terminal.integrated.*` settings.

## Data Model

### ColorScheme (`src/models/colorScheme.ts`)

```typescript
interface ColorScheme {
  id: string;              // UUID for imported, stable string for built-ins
  name: string;            // Display name
  builtIn: boolean;        // true = cannot be deleted
  foreground: string;      // hex "#RRGGBB"
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

interface TerminalFontConfig {
  family: string;
  size: number;
  weight: string;
}
```

### Storage

- `globalState` key `nexus.colorSchemes`: `ColorScheme[]` (user-imported only)
- `globalState` key `nexus.activeColorScheme`: `string` (scheme ID or empty)
- `globalState` key `nexus.terminalFont`: `TerminalFontConfig`
- Built-in schemes hardcoded in `builtinSchemes.ts`, not persisted

## INI Parser

Parses MobaXterm `.ini` files with `[Colors]` section:

| INI Key | ColorScheme Property |
|---------|---------------------|
| ForegroundColour | foreground |
| BackgroundColour | background |
| CursorColour | cursor |
| Black | black |
| Red | red |
| Green | green |
| Yellow | yellow |
| Blue | blue |
| Magenta | magenta |
| Cyan | cyan |
| White | white |
| BoldBlack | brightBlack |
| BoldRed | brightRed |
| BoldGreen | brightGreen |
| BoldYellow | brightYellow |
| BoldBlue | brightBlue |
| BoldMagenta | brightMagenta |
| BoldCyan | brightCyan |
| BoldWhite | brightWhite |

- RGB triplets `R,G,B` converted to `#RRGGBB` hex
- `selectionBackground` auto-derived: foreground at 30% opacity over background
- Filename (minus `.ini`) used as scheme name

## Color Scheme Application

When a scheme is selected:
1. Read current `workbench.colorCustomizations` from user settings
2. Set/overwrite all `terminal.*` keys with scheme colors
3. Write back to `workbench.colorCustomizations` at Global scope
4. Preserve any non-terminal entries in the object

"None/Reset" removes all `terminal.*` and `terminalCursor.*` keys.

Font settings write to `terminal.integrated.fontFamily`, `terminal.integrated.fontSize`, `terminal.integrated.fontWeight`.

## Architecture

Standalone `ColorSchemeService` (not in NexusCore) handles:
- Loading built-in + user-imported schemes
- Parsing INI files
- Applying schemes to VS Code settings
- Managing font config
- CRUD for user-imported schemes

## Webview Panel UI

`TerminalAppearancePanel` with sections:

1. **Font Settings**: family combobox (common mono fonts), size number input (8-72), weight dropdown
2. **Color Scheme**: dropdown for selection (instant apply), 2x8 color preview grid, bg/fg/cursor/selection preview, Import File / Import Directory / Delete buttons

Message protocol:
- `selectScheme`, `importFile`, `importDirectory`, `deleteScheme`, `applyFont`
- Extension pushes `schemesUpdated`, `fontUpdated` back

## Entry Points

- Command: `nexus.terminal.appearance`
- Settings tree: "Terminal Appearance" item (icon: `paintcan`)

## Built-in Schemes (~8)

Catppuccin Mocha, Dracula, Solarized Dark, Solarized Light, Nord, Gruvbox Dark, One Dark, Tokyo Night

## Files

**Create:**
1. `src/models/colorScheme.ts`
2. `src/services/colorSchemeParser.ts`
3. `src/services/colorSchemeService.ts`
4. `src/services/builtinSchemes.ts`
5. `src/ui/terminalAppearancePanel.ts`
6. `src/ui/terminalAppearanceHtml.ts`

**Modify:**
1. `package.json` - command registration
2. `src/extension.ts` - wire service, register command
3. `src/ui/settingsTreeProvider.ts` - add appearance item
4. `src/commands/settingsCommands.ts` - handle appearance click
