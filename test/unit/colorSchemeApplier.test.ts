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

  it("returns exactly 20 keys", () => {
    const keys = buildTerminalColorKeys(BUILTIN_SCHEMES[0]);
    expect(Object.keys(keys).length).toBe(20);
  });
});

describe("buildColorCustomizations", () => {
  it("merges terminal colors into existing customizations", () => {
    const existing = { "editor.background": "#111111", "terminal.background": "#old" };
    const scheme = BUILTIN_SCHEMES[0];
    const result = buildColorCustomizations(existing, scheme);
    expect(result["editor.background"]).toBe("#111111");
    expect(result["terminal.background"]).toBe(scheme.background);
  });

  it("removes terminal keys when scheme is null (reset)", () => {
    const existing = { "editor.background": "#111111", "terminal.background": "#old", "terminal.ansiRed": "#red" };
    const result = buildColorCustomizations(existing, null);
    expect(result["editor.background"]).toBe("#111111");
    expect(result["terminal.background"]).toBeUndefined();
    expect(result["terminal.ansiRed"]).toBeUndefined();
  });

  it("removes terminalCursor keys when scheme is null", () => {
    const existing = { "terminalCursor.foreground": "#old" };
    const result = buildColorCustomizations(existing, null);
    expect(result["terminalCursor.foreground"]).toBeUndefined();
  });
});
