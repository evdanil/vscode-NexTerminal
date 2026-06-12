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
 *  - Restore values converge with the repair command's output: orphaned
 *    commands (ORPHAN_COMMANDS, e.g. "nexus.macro.slot") are filtered out of
 *    captured shadows and stripped-path restores, and non-string entries are
 *    dropped — both write paths produce the same canonical string[].
 *
 * Keeping this logic vscode-free makes it trivially unit-testable.
 */

import { ORPHAN_COMMANDS } from "./skipShellRepair";

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
 *    Repair writes are sanitizing: non-string entries and orphaned commands are
 *    dropped from the value written.
 *
 * An empty `requiredCommands` disables the guard entirely (all scopes classify
 * as none) — the guard never acts without a stake.
 *
 * Shadow-free recovery: when no healthy shadow exists for a scope, an optional
 * `fallbackBases` map can supply a VS Code default skip-shell list (read from
 * the resolved effective value). The guard then rebuilds the scope from that
 * base plus the required commands — enabling recovery for damage-while-closed
 * and fresh installs where no shadow has ever been captured.
 */
export function assessScopes(
  shadowValues: Partial<Record<GuardScope, string[]>> | undefined,
  current: Record<GuardScope, unknown>,
  requiredCommands: readonly string[],
  ownWrites: Record<GuardScope, string[] | null>,
  fallbackBases?: Partial<Record<GuardScope, string[]>>
): ScopeAssessment[] {
  if (requiredCommands.length === 0) {
    return GUARD_SCOPES.map((scope) => ({ scope, classification: "none" as const }));
  }
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

    const rawFallback = fallbackBases?.[scope];
    const fallbackBase = rawFallback
      ? rawFallback.filter((v): v is string => typeof v === "string")
      : undefined;

    if (Array.isArray(cur)) {
      if (containsAll(cur, requiredCommands)) {
        return { scope, classification: "healthy" as const };
      }
      // Compute surviving strings (non-string entries and orphans dropped).
      const surviving = cur.filter(
        (v): v is string => typeof v === "string" && !(ORPHAN_COMMANDS as readonly string[]).includes(v)
      );
      if (goodShadow) {
        // Shadow takes precedence.
        if (cur.length === 0 || surviving.length === 0) {
          return { scope, classification: "emptied" as const, restoreValue: [...goodShadow] };
        }
        const missing = requiredCommands.filter((c) => !surviving.includes(c));
        return { scope, classification: "stripped" as const, restoreValue: [...surviving, ...missing] };
      }
      // No shadow — try fallback base.
      if (surviving.length > 0) {
        const missing = requiredCommands.filter((c) => !surviving.includes(c));
        return { scope, classification: "stripped" as const, restoreValue: [...surviving, ...missing] };
      }
      if (fallbackBase) {
        const missingFromFallback = requiredCommands.filter((c) => !fallbackBase.includes(c));
        return {
          scope,
          classification: "emptied" as const,
          restoreValue: [...fallbackBase, ...missingFromFallback],
        };
      }
      return { scope, classification: "none" as const };
    }

    if (cur === undefined) {
      if (goodShadow) {
        return { scope, classification: "vanished" as const, restoreValue: [...goodShadow] };
      }
      if (fallbackBase) {
        const missingFromFallback = requiredCommands.filter((c) => !fallbackBase.includes(c));
        return {
          scope,
          classification: "vanished" as const,
          restoreValue: [...fallbackBase, ...missingFromFallback],
        };
      }
      return { scope, classification: "none" as const };
    }

    // Defined but not an array — corrupt type (string, object, null, …).
    if (goodShadow) {
      return { scope, classification: "corrupt-type" as const, restoreValue: [...goodShadow] };
    }
    if (fallbackBase) {
      const missingFromFallback = requiredCommands.filter((c) => !fallbackBase.includes(c));
      return {
        scope,
        classification: "corrupt-type" as const,
        restoreValue: [...fallbackBase, ...missingFromFallback],
      };
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

/** Session-wide restore cap. Sized for multi-day sessions against a ~3 h external rewrite cycle. */
export const SESSION_RESTORE_CAP = 12;
/** Burst guard: this many restores inside BURST_WINDOW_MS means a write-war — pause. */
export const BURST_CAP = 3;
export const BURST_WINDOW_MS = 10 * 60 * 1000;

export type PauseReason = "session-cap" | "burst";

/**
 * Decide whether the NEXT restore is allowed, given the timestamps (ms) of
 * restores already performed this session. Returns the pause reason, or null
 * if the restore may proceed.
 */
export function evaluateRateLimit(
  restoreTimestampsMs: readonly number[],
  nowMs: number
): PauseReason | null {
  if (restoreTimestampsMs.length >= SESSION_RESTORE_CAP) return "session-cap";
  const windowStart = nowMs - BURST_WINDOW_MS;
  const recent = restoreTimestampsMs.filter((t) => t > windowStart);
  if (recent.length >= BURST_CAP) return "burst";
  return null;
}

export type GuardEventKind =
  | "external-strip"   // an array value vanished, emptied, or shrank — the corruption signature
  | "external-other"   // any other non-Nexus change to a watched key
  | "own-write"        // a write performed by Nexus itself (guard restore or keybinding repair)
  | "restore"          // the guard wrote a repaired value
  | "restore-failed"   // the guard's repair write was rejected (e.g. settings.json locked)
  | "undo"             // the user clicked Undo on a restore toast
  | "paused"           // rate limit tripped; auto-repair suspended
  | "resumed";         // the user clicked Resume Guard

export interface GuardEvent {
  timestamp: string;
  key: string;
  scope?: GuardScope;
  kind: GuardEventKind;
  before?: string;
  after?: string;
  detail?: string;
  /**
   * Best-effort hint: VS Code window focus at OBSERVATION time (not write
   * time). Background agent rewrites usually surface as unfocused and
   * interactive edits as focused, but the correlation is heuristic — e.g. a
   * hand-edit of settings.json in an external editor logs as unfocused.
   */
  focused?: boolean;
}

export const EVENT_LOG_CAP = 50;

/** Append to the persisted forensic log, evicting the oldest entries past the cap. */
export function appendEvent(
  log: readonly GuardEvent[],
  event: GuardEvent,
  cap: number = EVENT_LOG_CAP
): GuardEvent[] {
  const next = [...log, event];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Render a setting value for the log: JSON, truncated, with undefined made explicit. */
export function renderValue(value: unknown, maxLength = 200): string {
  let rendered: string;
  if (value === undefined) {
    rendered = "(not set)";
  } else {
    try {
      rendered = JSON.stringify(value) ?? String(value);
    } catch {
      rendered = String(value);
    }
  }
  return rendered.length > maxLength ? `${rendered.slice(0, maxLength - 1)}…` : rendered;
}

/** Validity/heal policy for a watched Nexus-own setting (global scope). */
export interface WatchedValuePolicy {
  key: string;
  /** Is a single array entry meaningful for this setting? */
  isValidEntry: (entry: unknown) => boolean;
  /** Is an empty array a legitimate user choice (vs corruption)? */
  emptyArrayIsValid: boolean;
}

export const HEALABLE_KEYS: readonly WatchedValuePolicy[] = [
  {
    key: "nexus.terminal.passthroughKeys",
    // The runtime sanitizer accepts known key letters; anything non-string is
    // destroyed data. Validity here is just "is a string" — unknown strings
    // are dropped at capture, not treated as corruption.
    isValidEntry: (e) => typeof e === "string",
    emptyArrayIsValid: false,
  },
  {
    key: "nexus.terminal.highlighting.rules",
    // A rule must at least carry a string pattern; the {}-corruption destroys it.
    isValidEntry: (e) =>
      typeof e === "object" && e !== null && typeof (e as { pattern?: unknown }).pattern === "string",
    emptyArrayIsValid: true,
  },
];

export type WatchedValueState =
  | { state: "absent" }                            // no global override
  | { state: "healthy"; captureValue: unknown[] }  // valid entries to shadow
  | { state: "corrupt" };                          // heal: restore shadow or remove key

/**
 * Assess the raw GLOBAL value of a healable watched setting.
 *
 * healthy  — array whose entries include at least one valid entry (or a
 *            legitimately-empty array); captureValue is the valid subset,
 *            suitable for the last-known-good value shadow.
 * corrupt  — defined but non-array, an invalid empty array, or a non-empty
 *            array with ZERO valid entries (the {}-replacement signature).
 *            Mixed arrays (some valid, some garbage) are treated as healthy
 *            and captured filtered — conservative: never heal what still
 *            carries user data.
 */
export function assessWatchedValue(policy: WatchedValuePolicy, raw: unknown): WatchedValueState {
  if (raw === undefined) return { state: "absent" };
  if (!Array.isArray(raw)) return { state: "corrupt" };
  if (raw.length === 0) {
    return policy.emptyArrayIsValid ? { state: "healthy", captureValue: [] } : { state: "corrupt" };
  }
  const valid = raw.filter(policy.isValidEntry);
  if (valid.length === 0) return { state: "corrupt" };
  return { state: "healthy", captureValue: valid };
}


/**
 * Classify a change to a log-only watched key (everything except the
 * skip-shell list, which gets the richer per-scope assessment).
 * Returns undefined when nothing actually changed.
 */
export function classifyWatchedChange(
  key: string,
  before: unknown,
  after: unknown
): { kind: "external-strip" | "external-other"; before: string; after: string } | undefined {
  if (jsonEqual(before, after)) return undefined;
  // Strip detection counts STRING entries, not array length: the observed
  // external tool replaces every element with {} (depth-limited JSON
  // re-serialization), leaving length unchanged. Object-array settings
  // (e.g. highlighting.rules) have zero string entries to begin with, so
  // ordinary user edits to them still classify as external-other.
  const countStrings = (v: unknown): number =>
    Array.isArray(v) ? v.filter((e) => typeof e === "string").length : 0;
  const beforeStrings = countStrings(before);
  const wasStringArray = Array.isArray(before) && before.length > 0 && beforeStrings > 0;
  const stripped =
    wasStringArray &&
    (after === undefined ||
      (Array.isArray(after) && (after.length === 0 || countStrings(after) < beforeStrings)));
  return {
    kind: stripped ? "external-strip" : "external-other",
    before: renderValue(before),
    after: renderValue(after),
  };
}

/** One human-readable line per event, used for the output channel and the report. */
export function formatEventLine(e: GuardEvent): string {
  const scope = e.scope ? ` [${e.scope}]` : "";
  const detail = e.detail ? ` (${e.detail})` : "";
  const change =
    e.before !== undefined || e.after !== undefined
      ? ` ${e.before ?? "(not recorded)"} -> ${e.after ?? "(not recorded)"}`
      : "";
  const focus = e.focused === undefined ? "" : e.focused ? " {focused}" : " {unfocused}";
  return `${e.timestamp} ${e.kind}${detail} ${e.key}${scope}${change}${focus}`;
}

/**
 * The forensic report handed to corporate IT: summary counts, first/last-seen
 * timestamps for correlation against endpoint-agent logs, then the event log.
 */
export function formatGuardReport(
  events: readonly GuardEvent[],
  guardEnabled: boolean,
  nowIso: string
): string {
  const external = events.filter(
    (e) => e.kind === "external-strip" || e.kind === "external-other"
  );
  const strips = external.filter((e) => e.kind === "external-strip");
  const restores = events.filter((e) => e.kind === "restore");
  const keys = [...new Set(external.map((e) => e.key))];

  const lines: string[] = [];
  lines.push("=".repeat(72));
  lines.push(`Nexus Settings Guard Report — generated ${nowIso}`);
  lines.push(`Guard auto-repair: ${guardEnabled ? "ENABLED" : "DISABLED"} (nexus.settingsGuard.enabled)`);
  lines.push("");
  lines.push(`External modifications observed: ${external.length} (${strips.length} stripped/emptied arrays)`);
  lines.push(`Automatic restores performed:    ${restores.length}`);
  if (external.length > 0) {
    lines.push(`First seen: ${external[0].timestamp}`);
    lines.push(`Last seen:  ${external[external.length - 1].timestamp}`);
    lines.push(`Affected settings: ${keys.join(", ")}`);
  }
  lines.push("");
  lines.push("Give this report to your IT team: the timestamps below identify when an");
  lines.push("external program (e.g. a DLP/endpoint agent) rewrote settings.json, for");
  lines.push("correlation against agent activity logs. VS Code's Timeline view on the");
  lines.push("settings.json file (Local History) shows the same rewrites with content.");
  lines.push("");
  lines.push(`Event log (${events.length} events, newest last, cap ${EVENT_LOG_CAP}):`);
  for (const e of events) lines.push(`  ${formatEventLine(e)}`);
  lines.push("=".repeat(72));
  return lines.join("\n");
}

/**
 * Validate and narrow a shadow loaded from globalState.
 *
 * The shadow is machine-global, but workspace/workspaceFolder configuration
 * values are per-workspace: capturing them globally would make the guard
 * "restore" one workspace's list into every other workspace's
 * .vscode/settings.json (a version-controlled file). The guard therefore
 * protects ONLY the global (user-level) scope — which is also the only file
 * the external tool rewrites. Any workspace-scope values found in a persisted
 * shadow (e.g. from a pre-release build) are dropped; unrecognizable shapes
 * yield undefined (no shadow).
 */
export function sanitizeShadow(raw: unknown): SkipShellShadow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as { values?: unknown; updatedAt?: unknown };
  if (typeof candidate.updatedAt !== "string") return undefined;
  if (typeof candidate.values !== "object" || candidate.values === null) return undefined;
  const global = (candidate.values as Record<string, unknown>).global;
  if (!Array.isArray(global)) return undefined;
  const cleaned = global.filter((v): v is string => typeof v === "string");
  if (cleaned.length === 0) return undefined;
  return { values: { global: cleaned }, updatedAt: candidate.updatedAt };
}

/**
 * Compute a refreshed last-known-good shadow from the current per-scope values.
 *
 * Returns the new shadow only when the observed state is fully healthy: at
 * least one scope has an override, and EVERY defined scope is a string array
 * containing all required commands. Any other state returns undefined, meaning
 * "keep the existing shadow" — the shadow is never updated from a corrupt or
 * partially-corrupt state, and is never cleared here (only an explicit Undo
 * clears a scope, in the controller).
 *
 * An empty `requiredCommands` disables the guard entirely (no shadow captured)
 * — the guard never acts without a stake.
 */
export function computeShadowUpdate(
  current: Record<GuardScope, unknown>,
  requiredCommands: readonly string[],
  nowIso: string
): SkipShellShadow | undefined {
  if (requiredCommands.length === 0) return undefined;
  const values: Partial<Record<GuardScope, string[]>> = {};
  let anyDefined = false;
  for (const scope of GUARD_SCOPES) {
    const cur = current[scope];
    if (cur === undefined) continue;
    if (!Array.isArray(cur) || !containsAll(cur, requiredCommands)) return undefined;
    values[scope] = cur.filter(
      (v): v is string => typeof v === "string" && !(ORPHAN_COMMANDS as readonly string[]).includes(v)
    );
    anyDefined = true;
  }
  if (!anyDefined) return undefined;
  return { values, updatedAt: nowIso };
}
