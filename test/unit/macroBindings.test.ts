import { describe, expect, it } from "vitest";
import {
  ALL_BINDINGS,
  isValidBinding,
  bindingToContextKey,
  bindingToDisplayLabel,
  bindingToVscodeKey,
  slotToBinding,
  CRITICAL_CTRL_SHIFT_KEYS,
  SPECIAL_BINDING_WARNINGS
} from "../../src/macroBindings";

describe("macroBindings", () => {
  describe("ALL_BINDINGS", () => {
    it("contains exactly 108 bindings (3 modifiers x 36 keys)", () => {
      expect(ALL_BINDINGS).toHaveLength(108);
    });

    it("includes alt+a through alt+z and alt+0 through alt+9", () => {
      expect(ALL_BINDINGS).toContain("alt+a");
      expect(ALL_BINDINGS).toContain("alt+z");
      expect(ALL_BINDINGS).toContain("alt+0");
      expect(ALL_BINDINGS).toContain("alt+9");
    });

    it("includes alt+shift bindings", () => {
      expect(ALL_BINDINGS).toContain("alt+shift+a");
      expect(ALL_BINDINGS).toContain("alt+shift+z");
      expect(ALL_BINDINGS).toContain("alt+shift+0");
      expect(ALL_BINDINGS).toContain("alt+shift+9");
    });

    it("includes ctrl+shift bindings", () => {
      expect(ALL_BINDINGS).toContain("ctrl+shift+a");
      expect(ALL_BINDINGS).toContain("ctrl+shift+z");
      expect(ALL_BINDINGS).toContain("ctrl+shift+0");
      expect(ALL_BINDINGS).toContain("ctrl+shift+9");
    });
  });

  describe("isValidBinding", () => {
    it("accepts valid alt bindings", () => {
      expect(isValidBinding("alt+a")).toBe(true);
      expect(isValidBinding("alt+5")).toBe(true);
    });

    it("accepts valid alt+shift bindings", () => {
      expect(isValidBinding("alt+shift+m")).toBe(true);
      expect(isValidBinding("alt+shift+0")).toBe(true);
    });

    it("accepts valid ctrl+shift bindings", () => {
      expect(isValidBinding("ctrl+shift+p")).toBe(true);
      expect(isValidBinding("ctrl+shift+9")).toBe(true);
    });

    it("is case insensitive", () => {
      expect(isValidBinding("Alt+A")).toBe(true);
      expect(isValidBinding("ALT+SHIFT+Z")).toBe(true);
      expect(isValidBinding("CTRL+SHIFT+5")).toBe(true);
    });

    it("rejects invalid bindings", () => {
      expect(isValidBinding("ctrl+a")).toBe(false);
      expect(isValidBinding("shift+a")).toBe(false);
      expect(isValidBinding("alt+shift+ctrl+a")).toBe(false);
      expect(isValidBinding("alt+F1")).toBe(false);
      expect(isValidBinding("")).toBe(false);
      expect(isValidBinding("alt+")).toBe(false);
    });
  });

  describe("bindingToContextKey", () => {
    it("maps alt bindings correctly", () => {
      expect(bindingToContextKey("alt+a")).toBe("nexus.macro.alt.a");
      expect(bindingToContextKey("alt+5")).toBe("nexus.macro.alt.5");
    });

    it("maps alt+shift bindings correctly", () => {
      expect(bindingToContextKey("alt+shift+a")).toBe("nexus.macro.altShift.a");
      expect(bindingToContextKey("alt+shift+0")).toBe("nexus.macro.altShift.0");
    });

    it("maps ctrl+shift bindings correctly", () => {
      expect(bindingToContextKey("ctrl+shift+a")).toBe("nexus.macro.ctrlShift.a");
      expect(bindingToContextKey("ctrl+shift+9")).toBe("nexus.macro.ctrlShift.9");
    });
  });

  describe("bindingToVscodeKey", () => {
    it("keeps alt bindings as-is", () => {
      expect(bindingToVscodeKey("alt+a")).toBe("alt+a");
      expect(bindingToVscodeKey("alt+5")).toBe("alt+5");
    });

    it("reorders alt+shift to shift+alt", () => {
      expect(bindingToVscodeKey("alt+shift+a")).toBe("shift+alt+a");
      expect(bindingToVscodeKey("alt+shift+5")).toBe("shift+alt+5");
    });

    it("keeps ctrl+shift as-is", () => {
      expect(bindingToVscodeKey("ctrl+shift+a")).toBe("ctrl+shift+a");
      expect(bindingToVscodeKey("ctrl+shift+0")).toBe("ctrl+shift+0");
    });
  });

  describe("bindingToDisplayLabel", () => {
    it("capitalizes each part", () => {
      expect(bindingToDisplayLabel("alt+a")).toBe("Alt+A");
      expect(bindingToDisplayLabel("alt+shift+m")).toBe("Alt+Shift+M");
      expect(bindingToDisplayLabel("ctrl+shift+5")).toBe("Ctrl+Shift+5");
    });
  });

  describe("slotToBinding", () => {
    it("converts slot numbers to alt bindings", () => {
      expect(slotToBinding(0)).toBe("alt+0");
      expect(slotToBinding(1)).toBe("alt+1");
      expect(slotToBinding(5)).toBe("alt+5");
      expect(slotToBinding(9)).toBe("alt+9");
    });
  });

  describe("CRITICAL_CTRL_SHIFT_KEYS", () => {
    it("includes common VS Code shortcut keys", () => {
      expect(CRITICAL_CTRL_SHIFT_KEYS.has("p")).toBe(true);
      expect(CRITICAL_CTRL_SHIFT_KEYS.has("f")).toBe(true);
      expect(CRITICAL_CTRL_SHIFT_KEYS.has("e")).toBe(true);
    });

    it("does not include non-critical keys", () => {
      expect(CRITICAL_CTRL_SHIFT_KEYS.has("a")).toBe(false);
      expect(CRITICAL_CTRL_SHIFT_KEYS.has("z")).toBe(false);
    });
  });

  describe("SPECIAL_BINDING_WARNINGS", () => {
    it("has warning for alt+s", () => {
      expect(SPECIAL_BINDING_WARNINGS["alt+s"]).toBeDefined();
      expect(SPECIAL_BINDING_WARNINGS["alt+s"]).toContain("quick pick");
    });
  });

  describe("sync with generateKeybindings.mjs", () => {
    it("every ALL_BINDINGS entry produces a valid context key and VS Code key", () => {
      for (const binding of ALL_BINDINGS) {
        const ctxKey = bindingToContextKey(binding);
        expect(ctxKey).toMatch(/^nexus\.macro\.(alt|altShift|ctrlShift)\.[a-z0-9]$/);
        const vscodeKey = bindingToVscodeKey(binding);
        expect(vscodeKey).toMatch(/^(alt|shift\+alt|ctrl\+shift)\+[a-z0-9]$/);
      }
    });
  });
});
