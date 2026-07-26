// Single collator instance: constructing an Intl.Collator per comparison is
// orders of magnitude slower than reusing one, and tree sorts run on every refresh.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Numeric-aware, case-insensitive-primary comparator with a deterministic tiebreak. */
export function naturalCompare(a: string, b: string): number {
  const primary = collator.compare(a, b);
  if (primary !== 0) {
    return primary;
  }
  // `sensitivity: "base"` treats "Core" and "core" as equal, which would make
  // Array.prototype.sort order-dependent. Fall back to code-point order so the
  // result is stable and reproducible across refreshes.
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Segment-wise natural compare for `/`-separated paths (folder paths, remote paths). */
export function naturalComparePath(a: string, b: string): number {
  const aParts = a.split("/");
  const bParts = b.split("/");
  const shared = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < shared; i++) {
    const result = naturalCompare(aParts[i], bParts[i]);
    if (result !== 0) {
      return result;
    }
  }
  return aParts.length - bParts.length;
}
