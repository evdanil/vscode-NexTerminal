import { describe, expect, it } from "vitest";

import { validateSavedFilter } from "../../src/utils/validation";

/**
 * SAVED FILTER DEFINITIONS (issue #48 PR-E, PR #64 Codex review round 5, P2) —
 * the persistence/import shape guard must reject a saved-filter `id` using the
 * reserved `__create__` prefix (the webview inline-create sentinel namespace),
 * mirroring the round-3 provider-option rejection. A normal uuid id is
 * unaffected.
 */
describe("validateSavedFilter — reserved `__create__` id prefix", () => {
  it("rejects an id using the reserved `__create__` prefix (would be un-selectable in the picker)", () => {
    expect(validateSavedFilter({ id: "__create__x", name: "n", filter: "" })).toBe(false);
    // Even an exact collision with the real save-current sentinel is rejected.
    expect(validateSavedFilter({ id: "__create__savedFilter", name: "n", filter: "x=1" })).toBe(false);
  });

  it("accepts an otherwise-identical uuid id (normal saved filters are unaffected)", () => {
    expect(validateSavedFilter({ id: "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f", name: "n", filter: "" })).toBe(true);
    expect(validateSavedFilter({ id: "sf1", name: "Syd core", filter: "role=core&site=syd" })).toBe(true);
  });

  it("still rejects the shapes it rejected before (empty id/name, non-string filter)", () => {
    expect(validateSavedFilter({ id: "", name: "n", filter: "" })).toBe(false);
    expect(validateSavedFilter({ id: "ok", name: "", filter: "" })).toBe(false);
    expect(validateSavedFilter({ id: "ok", name: "n", filter: 42 })).toBe(false);
    expect(validateSavedFilter(null)).toBe(false);
  });
});
