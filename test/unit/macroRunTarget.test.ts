import { describe, expect, it } from "vitest";
import {
  MACRO_ROUTES,
  MACRO_RUN_TARGETS,
  macroRunPlacementLabel,
  macroRunTargetBadge,
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

describe("macroRunTargetBadge (route-aware, issue #48 PR-C)", () => {
  it("badges a gateway-routed local-terminal macro as [IPMI gateway], not [Local terminal]", () => {
    // The round-8 P2: a localTerminal macro with route:ipmiGateway runs on the
    // target server's IPMI gateway session, but the launch pickers used to badge
    // it `[Local terminal] ` (derived from runIn only), hiding the execution host.
    // Red against 3c38972 (which returns `[Local terminal] `), green after.
    expect(macroRunTargetBadge({ runIn: "localTerminal", route: "ipmiGateway" })).toBe("[IPMI gateway] ");
  });

  it("keeps [Local terminal] for a local-terminal macro with no route or route:local", () => {
    expect(macroRunTargetBadge({ runIn: "localTerminal" })).toBe("[Local terminal] ");
    expect(macroRunTargetBadge({ runIn: "localTerminal", route: "local" })).toBe("[Local terminal] ");
  });

  it("reads an untrusted route as local, so a corrupt record still badges [Local terminal]", () => {
    // Route flows through resolveMacroRoute, so "IPMIGATEWAY"/7 can never promote
    // a badge to the gateway form — the same untrusted-field discipline the run
    // path uses (a direct `===` read is the bug this guards).
    expect(macroRunTargetBadge({ runIn: "localTerminal", route: "IPMIGATEWAY" as never })).toBe("[Local terminal] ");
  });

  it("leaves session (empty), browser, and route on a non-local target unchanged", () => {
    expect(macroRunTargetBadge({ runIn: "session" })).toBe("");
    expect(macroRunTargetBadge({})).toBe("");
    expect(macroRunTargetBadge({ runIn: "browser" })).toBe("[Browser] ");
    // route is meaningless off a local terminal — a browser macro carrying it is
    // still badged [Browser], never the gateway form.
    expect(macroRunTargetBadge({ runIn: "browser", route: "ipmiGateway" })).toBe("[Browser] ");
    expect(macroRunTargetBadge({ runIn: "session", route: "ipmiGateway" })).toBe("");
  });
});

describe("macroRunPlacementLabel (route-aware tooltip label, issue #48 PR-C)", () => {
  it("names the gateway placement for a routed local-terminal macro", () => {
    // The sidebar tooltip must not say "Local terminal" for a gateway-routed
    // macro. Red against 3c38972 (no such helper / plain "Local terminal"), green
    // after. Wording matches the editor "Run on" select.
    expect(macroRunPlacementLabel({ runIn: "localTerminal", route: "ipmiGateway" })).toBe(
      "the server's IPMI gateway (falls back to this machine)"
    );
  });

  it("keeps the plain run-target labels for every other placement", () => {
    expect(macroRunPlacementLabel({ runIn: "localTerminal" })).toBe("Local terminal");
    expect(macroRunPlacementLabel({ runIn: "localTerminal", route: "local" })).toBe("Local terminal");
    expect(macroRunPlacementLabel({ runIn: "browser" })).toBe("Browser");
    expect(macroRunPlacementLabel({})).toBe("Session terminal");
    // Declared route is what shows — a routed macro whose gateway is missing at
    // run time is still gateway-INTENDED here; the fall-back note covers runtime.
    expect(macroRunPlacementLabel({ runIn: "browser", route: "ipmiGateway" })).toBe("Browser");
  });
});
