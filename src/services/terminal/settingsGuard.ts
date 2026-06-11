/**
 * Pure (vscode-free) logic for the Settings Guard.
 *
 * Some corporate environments run agents (DLP/endpoint tools) that periodically
 * rewrite the user-level settings.json and drop array-valued keys. The damaging
 * loss for Nexus is `terminal.integrated.commandsToSkipShell`: without the Nexus
 * macro commands in that list, macro shortcuts never reach the extension while a
 * terminal is focused. That setting is consumed by VS Code core, so read-time
 * sanitization (the fix used for nexus.* arrays) is impossible — the only remedy
 * is writing the entries back.
 *
 * This module contains all decision logic: per-scope corruption assessment,
 * the last-known-good shadow update rule, rate limiting, the forensic event ring
 * buffer, watched-key change classification, and report formatting. The
 * vscode-dependent orchestration (config listeners, globalState, toasts, the
 * output channel) lives in `settingsGuardController.ts`.
 *
 * Design notes:
 *  - "External" classification really means "not written by Nexus" — a user
 *    hand-editing settings.json is indistinguishable from a DLP agent. The Undo
 *    button on every restore toast is the safety valve for that ambiguity.
 *  - Booleans are never auto-flipped; only the skip-shell array is restored.
 *  - A scope is only ever restored if the shadow previously saw it healthy
 *    (containing all required commands) — the guard never invents state.
 *
 * Keeping this logic vscode-free makes it trivially unit-testable.
 */

export type GuardScope = "global" | "workspace" | "workspaceFolder";

export const GUARD_SCOPES: readonly GuardScope[] = ["global", "workspace", "workspaceFolder"];

/** Last-known-good per-scope snapshot of `terminal.integrated.commandsToSkipShell`. */
export interface SkipShellShadow {
  values: Partial<Record<GuardScope, string[]>>;
  updatedAt: string;
}

export interface ScopeAssessment {
  scope: GuardScope;
  classification:
    | "none"        // nothing to do: no override and no healthy shadow history
    | "healthy"     // override present and contains all required commands
    | "own-write"   // value matches what the guard/repair just wrote — ignore
    | "vanished"    // key existed (healthy shadow) and is now gone
    | "emptied"     // key existed and is now []
    | "stripped"    // array survives but required commands were removed
    | "corrupt-type"; // key now holds a non-array value
  /** Set when the guard should write this value to the scope to repair it. */
  restoreValue?: string[];
}

/**
 * Assess each configuration scope of commandsToSkipShell against the
 * last-known-good shadow and any recorded own-writes.
 *
 * Restore policy (per spec §3):
 *  - vanished / emptied / corrupt-type → restore the FULL shadow array, which
 *    also recovers the user's non-Nexus entries the external tool destroyed.
 *  - stripped (array survives, Nexus entries missing) → conservative: keep the
 *    current array and append only the missing required commands.
 */
export function assessScopes(
  shadowValues: Partial<Record<GuardScope, string[]>> | undefined,
  current: Record<GuardScope, unknown>,
  requiredCommands: readonly string[],
  ownWrites: Record<GuardScope, string[] | null>
): ScopeAssessment[] {
  return GUARD_SCOPES.map((scope) => {
    const cur = current[scope];
    const own = ownWrites[scope];
    if (own !== null && jsonEqual(cur, own)) {
      return { scope, classification: "own-write" as const };
    }

    const rawShadow = shadowValues?.[scope];
    const goodShadow =
      Array.isArray(rawShadow) && containsAll(rawShadow, requiredCommands)
        ? rawShadow
        : undefined;

    if (Array.isArray(cur)) {
      if (containsAll(cur, requiredCommands)) {
        return { scope, classification: "healthy" as const };
      }
      if (!goodShadow) return { scope, classification: "none" as const };
      if (cur.length === 0) {
        return { scope, classification: "emptied" as const, restoreValue: [...goodShadow] };
      }
      const surviving = cur.filter((v): v is string => typeof v === "string");
      const missing = requiredCommands.filter((c) => !surviving.includes(c));
      return { scope, classification: "stripped" as const, restoreValue: [...surviving, ...missing] };
    }

    if (cur === undefined) {
      if (goodShadow) {
        return { scope, classification: "vanished" as const, restoreValue: [...goodShadow] };
      }
      return { scope, classification: "none" as const };
    }

    // Defined but not an array — corrupt type (string, object, null, …).
    if (goodShadow) {
      return { scope, classification: "corrupt-type" as const, restoreValue: [...goodShadow] };
    }
    return { scope, classification: "none" as const };
  });
}

function containsAll(list: readonly unknown[], required: readonly string[]): boolean {
  return required.every((cmd) => list.includes(cmd));
}

/** Order-sensitive structural equality via JSON; sufficient for arrays/primitives. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
