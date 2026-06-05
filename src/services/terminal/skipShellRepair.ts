/**
 * Pure (vscode-free) planning logic for repairing `terminal.integrated.commandsToSkipShell`.
 *
 * Responsibilities:
 *  - Drop orphaned `"nexus.macro.slot"` entries from any user-level override array.
 *    NOTE: `nexus.macro.slot` is still a registered back-compat command alias
 *    (macroCommands.ts) — we remove it only from the skip-shell list during an
 *    explicit confirm-gated repair; the command itself is not unregistered.
 *  - Append any `commands` that are missing from each user-level value.
 *  - Emit a write action only when the resulting array differs from the current value.
 *  - Fallback path (no user-level value at any inspected level): if one or more
 *    `commands` are missing from the effective (resolved) value, emit a single Global
 *    write of `[...effective, ...missing]`.  Using the effective value as the base
 *    preserves entries contributed by other extensions — we append only what we need.
 *
 * Keeping this logic vscode-free makes it trivially unit-testable.
 */

/** Orphaned command that was renamed; must be removed from skip-shell lists during repair. */
const ORPHAN_COMMANDS = ["nexus.macro.slot"] as const;

/**
 * A single per-level configuration update to perform.
 *
 * `target` is the opaque value supplied by the caller (typically a
 * `vscode.ConfigurationTarget` enum member, or the literal string
 * `"global-fallback"` for the fallback write).
 */
export interface SkipShellWrite<T> {
  target: T | "global-fallback";
  value: string[];
}

/**
 * Compute the minimal set of writes needed to repair commandsToSkipShell.
 *
 * @param levels   Each user-customised config level with its current value and an
 *                 opaque target identifier (passed through to the returned writes).
 *                 Levels with `value === undefined` are skipped.
 * @param effective The resolved effective value VS Code uses (accounts for all levels
 *                  and default contributions from package.json).
 * @param commands  The commands that must be present in the skip-shell list.
 * @returns         Ordered list of write actions. Empty if nothing needs to change.
 */
export function planSkipShellRepair<T>(
  levels: ReadonlyArray<{ value: string[] | undefined; target: T }>,
  effective: string[],
  commands: string[]
): Array<SkipShellWrite<T>> {
  const writes: Array<SkipShellWrite<T>> = [];
  let patchedAny = false;

  for (const { value, target } of levels) {
    if (value === undefined) continue;
    patchedAny = true;

    // Drop all orphaned entries, then add any missing required commands.
    const cleaned = value.filter((cmd) => !(ORPHAN_COMMANDS as readonly string[]).includes(cmd));
    const missing = commands.filter((cmd) => !cleaned.includes(cmd));
    const next = missing.length > 0 ? [...cleaned, ...missing] : cleaned;

    // Emit a write only if the array actually changed.
    if (!arraysEqual(next, value)) {
      writes.push({ target, value: next });
    }
  }

  // Safety net: no user-level override exists anywhere — rely on the effective
  // (resolved) value.  If any commands are still missing, write them to Global.
  // We merge with the effective value rather than writing only our commands so
  // that other extensions' skip-shell contributions are preserved.
  if (!patchedAny) {
    const missing = commands.filter((cmd) => !effective.includes(cmd));
    if (missing.length > 0) {
      writes.push({ target: "global-fallback", value: [...effective, ...missing] });
    }
  }

  return writes;
}

/** Shallow array equality check (order-sensitive). */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
