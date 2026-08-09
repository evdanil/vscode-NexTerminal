import { describe, expect, it } from "vitest";
import {
  computeFilterableSelectState,
  enterSelectionValue,
  isCreateOptionValue,
  isRealOptionValue,
  type FilterableOption
} from "../../src/ui/shared/filterableSelectLogic";

// These tests guard PR-F1 review §A — the Enter/auto-highlight model — which
// lives in client code (baseWebviewJs) that no test executes. The decision is
// lifted here into a pure twin of the inline applyFilter/Enter logic so it can
// be exercised for real without a DOM. The DOM WIRING remains uncovered; the
// smoke assertions in formHtml.test.ts prove the shipped string still carries
// this same decision.

// A create-bearing select (authProfileId / defaultServerId shape): (None) at the
// top, real options, and the ever-present __create__ affordance at the bottom.
const createBearing: FilterableOption[] = [
  { value: "", text: "(None)" },
  { value: "p1", text: "Prod root@prod" },
  { value: "d1", text: "Dev dev@dev" },
  { value: "__create__authProfile", text: "Create new auth profile…" }
];

// A non-create filterable select (proxyJumpHostId shape): sentinel + reals only.
const jumpHost: FilterableOption[] = [
  { value: "", text: "(Select jump host)" },
  { value: "a", text: "alpha host" },
  { value: "z", text: "Zeta host" }
];

describe("computeFilterableSelectState / enterSelectionValue — §A Enter model", () => {
  it("highlights the FIRST real match of a non-empty query and Enter selects it", () => {
    const state = computeFilterableSelectState(createBearing, "prod");
    // p1 is index 1; the (None) sentinel is never a highlight target.
    expect(state.highlightIndex).toBe(1);
    expect(enterSelectionValue(createBearing, state)).toBe("p1");
    // The description text is matched too — "root@prod" reached p1.
    expect(state.visible).toEqual([false, true, false, true]);
  });

  it("a zero-match typo on a create-bearing select highlights NOTHING and Enter is inert (never the create row)", () => {
    // This is the MUST-FIX guard: pre-fix, Enter after a zero-match filter
    // auto-picked the lone visible option — the always-present __create__ row —
    // silently launching the inline-create flow. Enter must now do nothing.
    const state = computeFilterableSelectState(createBearing, "zzz-no-such");
    expect(state.highlightIndex).toBe(-1);
    expect(enterSelectionValue(createBearing, state)).toBeNull();
    // The create affordance stays visible (escape hatch), so "No matches" stays
    // hidden — but it is reachable only by explicit arrow/click, never Enter.
    expect(state.visible[3]).toBe(true);
    expect(state.showNoMatches).toBe(false);
    // Nothing Enter could commit is the create sentinel.
    expect(enterSelectionValue(createBearing, state)).not.toBe("__create__authProfile");
  });

  it("a unique match on a NON-create select highlights it and Enter selects it (unchanged intent)", () => {
    const state = computeFilterableSelectState(jumpHost, "zeta");
    expect(state.highlightIndex).toBe(2);
    expect(enterSelectionValue(jumpHost, state)).toBe("z");
  });

  it("an empty query clears the transient highlight — Enter on the plain dropdown selects nothing", () => {
    const state = computeFilterableSelectState(createBearing, "");
    expect(state.highlightIndex).toBe(-1);
    expect(enterSelectionValue(createBearing, state)).toBeNull();
    // Everything visible when unfiltered.
    expect(state.visible).toEqual([true, true, true, true]);
  });

  it("filtering hides non-matching real options while the create affordance stays visible", () => {
    const state = computeFilterableSelectState(createBearing, "dev");
    // (None) hidden, Prod hidden, Dev shown, create always shown.
    expect(state.visible).toEqual([false, false, true, true]);
    expect(state.highlightIndex).toBe(2);
  });

  it("shows the No matches row only when no real option matches AND no create affordance exists", () => {
    // create-bearing zero-match → create speaks for the empty result, no row.
    expect(computeFilterableSelectState(createBearing, "zzz").showNoMatches).toBe(false);
    // non-create zero-match → the No matches row is the only feedback.
    expect(computeFilterableSelectState(jumpHost, "zzz").showNoMatches).toBe(true);
  });

  it("enterSelectionValue guards an out-of-range highlight index", () => {
    expect(enterSelectionValue(jumpHost, { visible: [], highlightIndex: 99, showNoMatches: false })).toBeNull();
    expect(enterSelectionValue(jumpHost, { visible: [], highlightIndex: -1, showNoMatches: false })).toBeNull();
  });
});

describe("option classification helpers", () => {
  it("treats only __create__* values as create options", () => {
    expect(isCreateOptionValue("__create__server")).toBe(true);
    expect(isCreateOptionValue("__create__authProfile")).toBe(true);
    expect(isCreateOptionValue("")).toBe(false);
    expect(isCreateOptionValue("p1")).toBe(false);
  });

  it("treats neither the empty sentinel nor create as a real option", () => {
    expect(isRealOptionValue("p1")).toBe(true);
    expect(isRealOptionValue("")).toBe(false);
    expect(isRealOptionValue("__create__server")).toBe(false);
  });
});
