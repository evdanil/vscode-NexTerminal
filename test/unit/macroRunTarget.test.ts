import { describe, expect, it } from "vitest";
import {
  MACRO_RUN_TARGETS,
  macroRunTargetLabel,
  resolveMacroRunTarget,
  validateMacroRunTarget
} from "../../src/models/terminalMacro";
import type { TerminalMacro } from "../../src/models/terminalMacro";

describe("resolveMacroRunTarget", () => {
  it("reads an absent runIn as the compatibility default", () => {
    expect(resolveMacroRunTarget({})).toBe("session");
  });

  it("returns each declared target", () => {
    for (const target of MACRO_RUN_TARGETS) {
      expect(resolveMacroRunTarget({ runIn: target })).toBe(target);
    }
  });

  it("reads anything else as session, never as 'runs elsewhere'", () => {
    // Legacy-settings absorption persists entries verbatim, so a non-string or
    // an unknown string is reachable. Resolving such a record to a non-session
    // target would make an ordinary macro start opening browsers; resolving it
    // to `undefined` would break every caller that switches on the result.
    for (const bad of [42, null, {}, [], "", "Browser", "local", true]) {
      expect(resolveMacroRunTarget({ runIn: bad as TerminalMacro["runIn"] })).toBe("session");
    }
  });
});

describe("validateMacroRunTarget", () => {
  it("refuses a non-session macro that also auto-triggers", () => {
    expect(validateMacroRunTarget("browser", { triggerPattern: "router#" })).toBeDefined();
    expect(validateMacroRunTarget("localTerminal", { triggerPattern: "router#" })).toBeDefined();
  });

  it("allows either one on its own", () => {
    expect(validateMacroRunTarget("session", { triggerPattern: "router#" })).toBeUndefined();
    expect(validateMacroRunTarget("browser", {})).toBeUndefined();
    expect(validateMacroRunTarget("browser", { triggerPattern: "" })).toBeUndefined();
  });
});

describe("macroRunTargetLabel", () => {
  it("names every target distinctly", () => {
    const labels = MACRO_RUN_TARGETS.map(macroRunTargetLabel);
    expect(new Set(labels).size).toBe(MACRO_RUN_TARGETS.length);
  });
});
