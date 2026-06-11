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
  const wasNonEmptyArray = Array.isArray(before) && before.length > 0;
  const shrank = wasNonEmptyArray && Array.isArray(after) && after.length < (before as unknown[]).length;
  const vanished = wasNonEmptyArray && (after === undefined || (Array.isArray(after) && after.length === 0));
  return {
    kind: shrank || vanished ? "external-strip" : "external-other",
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
      ? ` ${e.before ?? "?"} -> ${e.after ?? "?"}`
      : "";
  return `${e.timestamp} ${e.kind}${detail} ${e.key}${scope}${change}`;
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
 * Compute a refreshed last-known-good shadow from the current per-scope values.
 *
 * Returns the new shadow only when the observed state is fully healthy: at
 * least one scope has an override, and EVERY defined scope is a string array
 * containing all required commands. Any other state returns undefined, meaning
 * "keep the existing shadow" — the shadow is never updated from a corrupt or
 * partially-corrupt state, and is never cleared here (only an explicit Undo
 * clears a scope, in the controller).
 */
export function computeShadowUpdate(
  current: Record<GuardScope, unknown>,
  requiredCommands: readonly string[],
  nowIso: string
): SkipShellShadow | undefined {
  const values: Partial<Record<GuardScope, string[]>> = {};
  let anyDefined = false;
  for (const scope of GUARD_SCOPES) {
    const cur = current[scope];
    if (cur === undefined) continue;
    if (!Array.isArray(cur) || !containsAll(cur, requiredCommands)) return undefined;
    values[scope] = cur.filter((v): v is string => typeof v === "string");
    anyDefined = true;
  }
  if (!anyDefined) return undefined;
  return { values, updatedAt: nowIso };
}
