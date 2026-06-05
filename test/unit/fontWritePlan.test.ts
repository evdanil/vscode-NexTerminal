import { describe, expect, it } from "vitest";
import { planFontWrites, type FontValues } from "../../src/services/terminal/fontWritePlan";

const CURRENT: FontValues = { family: "Consolas", size: 14, weight: "normal" };

describe("planFontWrites", () => {
  it("returns no writes when desired equals current", () => {
    const writes = planFontWrites(CURRENT, { ...CURRENT });
    expect(writes).toEqual([]);
  });

  it("emits only the changed family field", () => {
    const writes = planFontWrites(CURRENT, { ...CURRENT, family: "Fira Code" });
    expect(writes).toEqual([{ field: "fontFamily", value: "Fira Code" }]);
  });

  it("emits only the changed size field", () => {
    const writes = planFontWrites(CURRENT, { ...CURRENT, size: 16 });
    expect(writes).toEqual([{ field: "fontSize", value: 16 }]);
  });

  it("emits only the changed weight field", () => {
    const writes = planFontWrites(CURRENT, { ...CURRENT, weight: "bold" });
    expect(writes).toEqual([{ field: "fontWeight", value: "bold" }]);
  });

  it("emits writes for all three fields when all differ", () => {
    const writes = planFontWrites(CURRENT, { family: "Hack", size: 18, weight: "600" });
    expect(writes).toEqual([
      { field: "fontFamily", value: "Hack" },
      { field: "fontSize", value: 18 },
      { field: "fontWeight", value: "600" },
    ]);
  });

  it("does not write an empty family (treated as leave-alone)", () => {
    const writes = planFontWrites(CURRENT, { ...CURRENT, family: "" });
    expect(writes).toEqual([]);
  });

  it("does not write a zero/invalid size (treated as leave-alone)", () => {
    const writes = planFontWrites(CURRENT, { ...CURRENT, size: 0 });
    expect(writes).toEqual([]);
  });

  it("does not write an empty weight (treated as leave-alone)", () => {
    const writes = planFontWrites(CURRENT, { ...CURRENT, weight: "" });
    expect(writes).toEqual([]);
  });

  it("does not re-write a field the external change already set (stale-DOM guard)", () => {
    // The panel opened with size 14 in the DOM, but another window set it to 16.
    // The user clicks Apply Font with the stale DOM value (14). Because current
    // is now 16, applying 14 IS a real change and should write — but if the DOM
    // had been re-synced to 16, applying 16 must be a no-op (no clobber).
    const externallyChanged: FontValues = { family: "Consolas", size: 16, weight: "normal" };
    const reSyncedDesired: FontValues = { family: "Consolas", size: 16, weight: "normal" };
    expect(planFontWrites(externallyChanged, reSyncedDesired)).toEqual([]);
  });

  it("preserves field order: family, size, weight", () => {
    const writes = planFontWrites(CURRENT, { family: "Menlo", size: 20, weight: "bold" });
    expect(writes.map((w) => w.field)).toEqual(["fontFamily", "fontSize", "fontWeight"]);
  });
});
