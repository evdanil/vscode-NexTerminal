import { describe, expect, it } from "vitest";
import {
  assessScopes,
  GuardScope,
} from "../../src/services/terminal/settingsGuard";

const REQUIRED = ["nexus.macro.run", "nexus.macro.runBinding"];

const NO_OWN_WRITES: Record<GuardScope, string[] | null> = {
  global: null,
  workspace: null,
  workspaceFolder: null,
};

function current(
  global?: unknown,
  workspace?: unknown,
  workspaceFolder?: unknown
): Record<GuardScope, unknown> {
  return { global, workspace, workspaceFolder };
}

describe("assessScopes", () => {
  const GOOD = ["workbench.action.quickOpen", ...REQUIRED];

  it("classifies a scope containing all required commands as healthy", () => {
    const result = assessScopes({ global: GOOD }, current(GOOD), REQUIRED, NO_OWN_WRITES);
    expect(result.find((a) => a.scope === "global")).toEqual({
      scope: "global",
      classification: "healthy",
    });
  });

  it("classifies undefined scope with no shadow as none", () => {
    const result = assessScopes(undefined, current(undefined), REQUIRED, NO_OWN_WRITES);
    expect(result.every((a) => a.classification === "none")).toBe(true);
  });

  it("detects vanished key (shadow had it, now undefined) and restores full shadow", () => {
    const result = assessScopes({ global: GOOD }, current(undefined), REQUIRED, NO_OWN_WRITES);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("vanished");
    expect(g?.restoreValue).toEqual(GOOD);
  });

  it("detects emptied array and restores full shadow", () => {
    const result = assessScopes({ global: GOOD }, current([]), REQUIRED, NO_OWN_WRITES);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("emptied");
    expect(g?.restoreValue).toEqual(GOOD);
  });

  it("detects partially stripped array and appends only missing required commands", () => {
    const remaining = ["workbench.action.quickOpen", "nexus.macro.run"];
    const result = assessScopes({ global: GOOD }, current(remaining), REQUIRED, NO_OWN_WRITES);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("stripped");
    // Preserves the user's surviving entries, appends only what's missing.
    expect(g?.restoreValue).toEqual([...remaining, "nexus.macro.runBinding"]);
  });

  it("detects corrupt non-array value and restores full shadow", () => {
    const result = assessScopes({ global: GOOD }, current("oops"), REQUIRED, NO_OWN_WRITES);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("corrupt-type");
    expect(g?.restoreValue).toEqual(GOOD);
  });

  it("does NOT restore a scope that was never healthy in the shadow", () => {
    // Shadow exists but never contained the required commands at this scope.
    const result = assessScopes({ global: ["other.cmd"] }, current([]), REQUIRED, NO_OWN_WRITES);
    expect(result.find((a) => a.scope === "global")?.classification).toBe("none");
  });

  it("classifies a value equal to the recorded own-write as own-write, no restore", () => {
    const ownWrites: Record<GuardScope, string[] | null> = {
      ...NO_OWN_WRITES,
      global: GOOD,
    };
    const result = assessScopes({ global: GOOD }, current(GOOD), REQUIRED, ownWrites);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("own-write");
    expect(g?.restoreValue).toBeUndefined();
  });

  it("assesses workspace and workspaceFolder scopes independently", () => {
    const result = assessScopes(
      { global: GOOD, workspace: GOOD },
      current(GOOD, undefined),
      REQUIRED,
      NO_OWN_WRITES
    );
    expect(result.find((a) => a.scope === "global")?.classification).toBe("healthy");
    expect(result.find((a) => a.scope === "workspace")?.classification).toBe("vanished");
    expect(result.find((a) => a.scope === "workspaceFolder")?.classification).toBe("none");
  });
});
