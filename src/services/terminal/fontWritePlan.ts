/**
 * Pure (vscode-free) planning logic for writing `terminal.integrated.font*`
 * settings from the Terminal Appearance panel.
 *
 * Responsibilities:
 *  - Emit a write only for the fields whose desired value actually differs from
 *    the value VS Code currently resolves (write-only-on-change). This mirrors
 *    the discipline of `planSkipShellRepair` and v2.8.50's skip-shell repair:
 *    never re-write a value the user (or another window / Settings Sync) just
 *    set, which would otherwise clobber an external change made while the panel
 *    was open with stale DOM values.
 *
 * Keeping this logic vscode-free makes it trivially unit-testable.
 */

/** A terminal font configuration (subset written to settings). */
export interface FontValues {
  family: string;
  size: number;
  weight: string;
}

/** Which font setting a write targets. */
export type FontField = "fontFamily" | "fontSize" | "fontWeight";

/** A single font setting write to perform. */
export interface FontWrite {
  field: FontField;
  value: string | number;
}

/**
 * Compute the minimal set of font writes needed.
 *
 * Empty / zero desired values are treated as "leave alone" (the panel never
 * deliberately clears a font setting), so a write is emitted only when the
 * desired value is non-empty AND differs from the current value.
 *
 * @param current The font values VS Code currently resolves (effective).
 * @param desired The font values the user wants to apply.
 * @returns Ordered list of writes. Empty if nothing needs to change.
 */
export function planFontWrites(current: FontValues, desired: FontValues): FontWrite[] {
  const writes: FontWrite[] = [];

  if (desired.family && desired.family !== current.family) {
    writes.push({ field: "fontFamily", value: desired.family });
  }
  if (desired.size > 0 && desired.size !== current.size) {
    writes.push({ field: "fontSize", value: desired.size });
  }
  if (desired.weight && desired.weight !== current.weight) {
    writes.push({ field: "fontWeight", value: desired.weight });
  }

  return writes;
}
