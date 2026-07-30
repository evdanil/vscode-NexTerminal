import { describe, expect, it } from "vitest";
import {
  normalizeFolderPath,
  normalizeOptionalFolderPath,
  isDescendantOrSelf,
  parentPath,
  folderDisplayName,
  getAncestorPaths,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_SEGMENT_LENGTH,
  MAX_FOLDER_PATH_LENGTH
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

  it("rejects segments containing backslashes", () => {
    expect(normalizeFolderPath("..\\..\\etc")).toBeUndefined();
    expect(normalizeFolderPath("A/B\\C")).toBeUndefined();
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

  // Fix 4 — depth alone bounds segment COUNT, not segment or total LENGTH.
  describe("length bounds (Fix 4)", () => {
    it("rejects a single segment longer than MAX_FOLDER_SEGMENT_LENGTH", () => {
      const tooLong = "a".repeat(MAX_FOLDER_SEGMENT_LENGTH + 1);
      expect(normalizeFolderPath(tooLong)).toBeUndefined();
    });

    it("accepts a single segment at exactly MAX_FOLDER_SEGMENT_LENGTH", () => {
      const exact = "a".repeat(MAX_FOLDER_SEGMENT_LENGTH);
      expect(normalizeFolderPath(exact)).toBe(exact);
    });

    it("rejects a pathologically long single-segment value — depth (segment COUNT = 1) alone never bounds this", () => {
      // The exact repro from the review: a single-segment `group` with no
      // slashes at all sails through the MAX_FOLDER_DEPTH check (its segment
      // count is 1) and, pre-fix, straight through normalizeFolderPath too.
      const huge = "X".repeat(8_000_000);
      expect(normalizeFolderPath(huge)).toBeUndefined();
    });

    it("rejects a path whose TOTAL length exceeds MAX_FOLDER_PATH_LENGTH even though every individual segment is short and the depth is within MAX_FOLDER_DEPTH", () => {
      // 9 segments (within MAX_FOLDER_DEPTH), each comfortably under
      // MAX_FOLDER_SEGMENT_LENGTH — neither the depth check nor the
      // per-segment length check would reject this. Only the total-length
      // check does, since the joined path still exceeds MAX_FOLDER_PATH_LENGTH.
      const segment = "s".repeat(25);
      const segments = Array.from({ length: 9 }, () => segment);
      const path = segments.join("/");
      expect(segments.length).toBeLessThanOrEqual(MAX_FOLDER_DEPTH);
      expect(segment.length).toBeLessThanOrEqual(MAX_FOLDER_SEGMENT_LENGTH);
      expect(path.length).toBeGreaterThan(MAX_FOLDER_PATH_LENGTH);
      expect(normalizeFolderPath(path)).toBeUndefined();
    });
  });
});

describe("normalizeOptionalFolderPath", () => {
  it("returns undefined for missing values", () => {
    expect(normalizeOptionalFolderPath(undefined)).toBeUndefined();
    expect(normalizeOptionalFolderPath(null)).toBeUndefined();
  });

  it("returns undefined for blank values", () => {
    expect(normalizeOptionalFolderPath("")).toBeUndefined();
    expect(normalizeOptionalFolderPath("   ")).toBeUndefined();
  });

  it("returns normalized value for valid input", () => {
    expect(normalizeOptionalFolderPath("  Prod / US-East  ")).toBe("Prod/US-East");
  });

  it("returns null for invalid non-empty input", () => {
    expect(normalizeOptionalFolderPath("/")).toBeNull();
    expect(normalizeOptionalFolderPath("A/../B")).toBeNull();
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
