import { describe, expect, it } from "vitest";
import {
  buildColorCustomizations,
  buildTerminalColorKeys,
  colorCustomizationsWriteValue
} from "../../src/services/colorSchemeApplier";
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

  // H1: the merge base must be the GLOBAL-scope value only (inspect().globalValue),
  // never the effective merged value. A workspace-scoped key present only in the
  // effective value must NOT be carried into the global-scope object we write.
  it("does not carry workspace-scoped keys into the merge base when given globalValue only", () => {
    // Simulate read-scope == write-scope: caller passes ONLY the global-scope
    // value. A workspace-scoped 'editor.foreground' is absent here by construction.
    const globalValueOnly = { "editor.background": "#globalBg" };
    const result = buildColorCustomizations(globalValueOnly, BUILTIN_SCHEMES[0]);
    expect(result["editor.background"]).toBe("#globalBg");
    expect(result["editor.foreground"]).toBeUndefined();
  });

  it("preserves existing global non-terminal keys while replacing terminal.* with the scheme", () => {
    const globalValueOnly = {
      "editor.background": "#globalBg",
      "terminal.background": "#staleTermBg"
    };
    const scheme = BUILTIN_SCHEMES[0];
    const result = buildColorCustomizations(globalValueOnly, scheme);
    expect(result["editor.background"]).toBe("#globalBg");
    expect(result["terminal.background"]).toBe(scheme.background);
  });

  it("clear-scheme path keeps only non-terminal global keys", () => {
    const globalValueOnly = {
      "editor.background": "#globalBg",
      "terminal.background": "#termBg",
      "terminalCursor.foreground": "#cur"
    };
    const result = buildColorCustomizations(globalValueOnly, null);
    expect(result).toEqual({ "editor.background": "#globalBg" });
  });
});

describe("colorCustomizationsWriteValue", () => {
  it("returns undefined for an empty merged object (key removal)", () => {
    expect(colorCustomizationsWriteValue({})).toBeUndefined();
  });

  it("returns the object unchanged when it has keys", () => {
    const merged = { "editor.background": "#111" };
    expect(colorCustomizationsWriteValue(merged)).toBe(merged);
  });

  it("clear-scheme with no other global keys yields undefined (clean settings.json)", () => {
    // globalValue had only terminal.* keys; after stripping, merged is empty.
    const merged = buildColorCustomizations({ "terminal.background": "#bg" }, null);
    expect(colorCustomizationsWriteValue(merged)).toBeUndefined();
  });
});
