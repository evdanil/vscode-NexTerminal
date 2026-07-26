import { describe, expect, it } from "vitest";
import { naturalCompare, naturalComparePath } from "../../src/utils/naturalCompare";

describe("naturalCompare", () => {
  it("orders embedded numbers numerically", () => {
    expect(["A10", "A2", "A1", "A21"].sort(naturalCompare)).toEqual(["A1", "A2", "A10", "A21"]);
  });

  it("orders pure numbers numerically", () => {
    expect(["10", "9", "100"].sort(naturalCompare)).toEqual(["9", "10", "100"]);
  });

  it("is case-insensitive for primary ordering", () => {
    expect(["beta", "Alpha"].sort(naturalCompare)).toEqual(["Alpha", "beta"]);
  });

  it("is deterministic for case-only differences", () => {
    expect(naturalCompare("core", "Core")).not.toBe(0);
    expect(naturalCompare("core", "Core")).toBe(-naturalCompare("Core", "core"));
  });

  it("handles multi-number names", () => {
    expect(["sw2-port10", "sw2-port2", "sw10-port1"].sort(naturalCompare))
      .toEqual(["sw2-port2", "sw2-port10", "sw10-port1"]);
  });

  it("handles empty strings", () => {
    expect(["b", "", "a"].sort(naturalCompare)).toEqual(["", "a", "b"]);
  });
});

describe("naturalComparePath", () => {
  it("compares segment by segment so parents group before deeper children", () => {
    expect(["Site10/Rack2", "Site2/Rack1", "Site10/Rack1"].sort(naturalComparePath))
      .toEqual(["Site2/Rack1", "Site10/Rack1", "Site10/Rack2"]);
  });

  it("sorts a parent before its own children", () => {
    expect(["DC1/Core", "DC1"].sort(naturalComparePath)).toEqual(["DC1", "DC1/Core"]);
  });

  it("does not let a separator outrank a numeric difference", () => {
    expect(["A2/x", "A10/x"].sort(naturalComparePath)).toEqual(["A2/x", "A10/x"]);
  });
});
