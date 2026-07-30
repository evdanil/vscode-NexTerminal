import { describe, expect, it } from "vitest";
import {
  collectMacroFolders,
  macroGroup,
  sanitizeMacroFolderList,
  sanitizeMacroGroup
} from "../../src/services/macroFolders";
import type { TerminalMacro } from "../../src/models/terminalMacro";

describe("sanitizeMacroGroup (§4.2 — untrusted at every read site)", () => {
  it("passes through a clean path", () => {
    expect(sanitizeMacroGroup("Cisco/Routers")).toBe("Cisco/Routers");
  });

  it("undefined stays undefined", () => {
    expect(sanitizeMacroGroup(undefined)).toBeUndefined();
  });

  it("canonicalizes an empty string to undefined", () => {
    expect(sanitizeMacroGroup("")).toBeUndefined();
  });

  it("canonicalizes a blank string to undefined", () => {
    expect(sanitizeMacroGroup("   ")).toBeUndefined();
  });

  // §4.2's three concrete failure inputs.
  it("a non-string group does not throw and drops to undefined", () => {
    expect(() => sanitizeMacroGroup({ a: 1 })).not.toThrow();
    expect(sanitizeMacroGroup({ a: 1 })).toBeUndefined();
    expect(sanitizeMacroGroup(42)).toBeUndefined();
    expect(sanitizeMacroGroup(["Cisco"])).toBeUndefined();
    expect(sanitizeMacroGroup(null)).toBeUndefined();
  });

  it("rejects '..' as a path traversal attempt", () => {
    expect(sanitizeMacroGroup("../secrets")).toBeUndefined();
    expect(sanitizeMacroGroup("Cisco/../secrets")).toBeUndefined();
  });

  it("rejects an over-depth path (bounds an O(n^2) prefix-accumulation stall)", () => {
    const huge = Array.from({ length: 200 }, () => "a").join("/");
    expect(sanitizeMacroGroup(huge)).toBeUndefined();
  });

  it("rejects a backslash", () => {
    expect(sanitizeMacroGroup("Cisco\\Routers")).toBeUndefined();
  });
});

describe("macroGroup()", () => {
  it("reads a macro's sanitized group", () => {
    const macro: Pick<TerminalMacro, "group"> = { group: "Cisco" };
    expect(macroGroup(macro)).toBe("Cisco");
  });

  it("never throws on a malformed macro.group", () => {
    const macro = { group: { bad: true } } as unknown as Pick<TerminalMacro, "group">;
    expect(() => macroGroup(macro)).not.toThrow();
    expect(macroGroup(macro)).toBeUndefined();
  });
});

describe("sanitizeMacroFolderList", () => {
  it("keeps valid string paths", () => {
    expect(sanitizeMacroFolderList(["Cisco", "Juniper/Routers"])).toEqual(["Cisco", "Juniper/Routers"]);
  });

  it("drops non-strings, invalid paths, and dedupes", () => {
    const result = sanitizeMacroFolderList(["Cisco", 42, "../bad", "Cisco", null, "Juniper"]);
    expect(result.sort()).toEqual(["Cisco", "Juniper"]);
  });

  it("degrades a non-array (corrupt storage shape) to an empty list without throwing", () => {
    expect(sanitizeMacroFolderList("not-an-array")).toEqual([]);
    expect(sanitizeMacroFolderList({ 0: "Cisco", length: 1 })).toEqual([]);
    expect(sanitizeMacroFolderList(null)).toEqual([]);
    expect(sanitizeMacroFolderList(undefined)).toEqual([]);
  });
});

describe("collectMacroFolders — union of explicit + derived, ancestors included", () => {
  it("returns an empty list with no folders and no grouped macros", () => {
    expect(collectMacroFolders([], [])).toEqual([]);
  });

  it("derives a folder from a macro's group, including ancestors", () => {
    const macros: TerminalMacro[] = [{ name: "m", text: "t", group: "Cisco/Routers" }];
    expect(collectMacroFolders(macros, [])).toEqual(["Cisco", "Cisco/Routers"]);
  });

  it("includes an explicit folder even with zero macros assigned to it (§1.1 — empty folders persist)", () => {
    expect(collectMacroFolders([], ["Empty/Nested"])).toEqual(["Empty", "Empty/Nested"]);
  });

  it("unions explicit and derived, deduping the overlap", () => {
    const macros: TerminalMacro[] = [{ name: "m", text: "t", group: "Cisco" }];
    const result = collectMacroFolders(macros, ["Cisco", "Juniper"]);
    expect(result.sort()).toEqual(["Cisco", "Juniper"]);
  });

  it("ignores a malformed group on one macro without dropping folders derived from others", () => {
    const macros: TerminalMacro[] = [
      { name: "bad", text: "t", group: { nope: true } as unknown as string },
      { name: "good", text: "t", group: "Cisco" }
    ];
    expect(() => collectMacroFolders(macros, [])).not.toThrow();
    expect(collectMacroFolders(macros, [])).toEqual(["Cisco"]);
  });

  it("sorts folders by naturalComparePath, not plain string order", () => {
    const macros: TerminalMacro[] = [
      { name: "a", text: "t", group: "Item10" },
      { name: "b", text: "t", group: "Item2" }
    ];
    expect(collectMacroFolders(macros, [])).toEqual(["Item2", "Item10"]);
  });
});
