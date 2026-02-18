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
