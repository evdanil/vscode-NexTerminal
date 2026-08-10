import { describe, expect, it } from "vitest";
import {
  MACRO_ROUTES,
  MACRO_RUN_TARGETS,
  macroRunTargetLabel,
  resolveMacroRoute,
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

describe("resolveMacroRoute (issue #48 PR-C)", () => {
  it("reads an absent route as the compatibility default 'local'", () => {
    expect(resolveMacroRoute({})).toBe("local");
  });

  it("returns each declared route", () => {
    for (const route of MACRO_ROUTES) {
      expect(resolveMacroRoute({ route })).toBe(route);
    }
  });

  it("reads anything outside the union as 'local', never as 'ipmiGateway'", () => {
    // The untrusted-route case: an imported record deletes `route` on ingest, but
    // a hand-edited backup or legacy-settings absorption can carry a wrong-cased
    // string or a non-string. A direct `===`/truthiness read would let
    // "IPMIGATEWAY" or `7` route a command onto a bastion — the exact thing this
    // resolver exists to refuse.
    for (const bad of ["IPMIGATEWAY", "ipmigateway", 7, null, {}, [], "", "gateway", true]) {
      expect(resolveMacroRoute({ route: bad as TerminalMacro["route"] })).toBe("local");
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
