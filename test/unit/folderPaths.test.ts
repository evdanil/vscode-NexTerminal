import { describe, expect, it } from "vitest";
import {
  normalizeFolderPath,
  isDescendantOrSelf,
  parentPath,
  folderDisplayName,
  getAncestorPaths,
  MAX_FOLDER_DEPTH
} from "../../src/utils/folderPaths";

describe("normalizeFolderPath", () => {
  it("returns a valid single-segment path", () => {
    expect(normalizeFolderPath("Production")).toBe("Production");
  });

  it("returns a valid multi-segment path", () => {
    expect(normalizeFolderPath("Prod/US-East")).toBe("Prod/US-East");
  });

  it("trims whitespace from segments", () => {
    expect(normalizeFolderPath("  Prod / US-East ")).toBe("Prod/US-East");
  });

  it("filters empty segments from double slashes", () => {
    expect(normalizeFolderPath("A//B")).toBe("A/B");
  });

  it("returns undefined for empty string", () => {
    expect(normalizeFolderPath("")).toBeUndefined();
  });

  it("returns undefined for only slashes", () => {
    expect(normalizeFolderPath("///")).toBeUndefined();
  });

  it("rejects '..' segments", () => {
    expect(normalizeFolderPath("A/../B")).toBeUndefined();
  });

  it("rejects '.' segments", () => {
    expect(normalizeFolderPath("A/./B")).toBeUndefined();
  });

  it("rejects paths deeper than MAX_FOLDER_DEPTH", () => {
    const deep = Array.from({ length: MAX_FOLDER_DEPTH + 1 }, (_, i) => `level${i}`).join("/");
    expect(normalizeFolderPath(deep)).toBeUndefined();
  });

  it("accepts paths at exactly MAX_FOLDER_DEPTH", () => {
    const exact = Array.from({ length: MAX_FOLDER_DEPTH }, (_, i) => `level${i}`).join("/");
    expect(normalizeFolderPath(exact)).toBe(exact);
  });

  it("returns undefined for whitespace-only input", () => {
    expect(normalizeFolderPath("   ")).toBeUndefined();
  });
});

describe("isDescendantOrSelf", () => {
  it("returns true for exact match", () => {
    expect(isDescendantOrSelf("Prod", "Prod")).toBe(true);
  });

  it("returns true for descendant", () => {
    expect(isDescendantOrSelf("Prod/US-East", "Prod")).toBe(true);
  });

  it("returns true for deep descendant", () => {
    expect(isDescendantOrSelf("Prod/US-East/az1", "Prod")).toBe(true);
  });

  it("returns false for non-descendant", () => {
    expect(isDescendantOrSelf("Dev", "Prod")).toBe(false);
  });

  it("avoids prefix collision: 'Apps' vs 'AppServer'", () => {
    expect(isDescendantOrSelf("AppServer", "Apps")).toBe(false);
  });

  it("avoids prefix collision: 'Prod-US' vs 'Prod'", () => {
    expect(isDescendantOrSelf("Prod-US", "Prod")).toBe(false);
  });
});

describe("parentPath", () => {
  it("returns parent for nested path", () => {
    expect(parentPath("A/B/C")).toBe("A/B");
  });

  it("returns parent for two-level path", () => {
    expect(parentPath("A/B")).toBe("A");
  });

  it("returns undefined for root-level path", () => {
    expect(parentPath("A")).toBeUndefined();
  });
});

describe("folderDisplayName", () => {
  it("returns leaf segment of nested path", () => {
    expect(folderDisplayName("A/B/C")).toBe("C");
  });

  it("returns the path itself for single segment", () => {
    expect(folderDisplayName("Root")).toBe("Root");
  });
});

describe("getAncestorPaths", () => {
  it("returns all ancestor paths including self", () => {
    expect(getAncestorPaths("A/B/C")).toEqual(["A", "A/B", "A/B/C"]);
  });

  it("returns single element for root-level path", () => {
    expect(getAncestorPaths("Root")).toEqual(["Root"]);
  });

  it("returns two elements for two-level path", () => {
    expect(getAncestorPaths("X/Y")).toEqual(["X", "X/Y"]);
  });
});
