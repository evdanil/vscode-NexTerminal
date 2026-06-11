# Settings Guard + Forensics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-restore externally stripped `terminal.integrated.commandsToSkipShell` values from a last-known-good shadow, with rate limiting and an always-on forensic event log + report command.

**Architecture:** Pure vscode-free logic in `src/services/terminal/settingsGuard.ts` (detection, restore planning, rate limiting, event log, report formatting — fully unit-tested), orchestrated by a thin vscode-dependent `SettingsGuardController` class wired in `extension.ts:activate()`. Shadow + event log persist in `globalState`. Spec: `docs/superpowers/specs/2026-06-11-settings-guard-design.md`.

**Tech Stack:** TypeScript strict / ES2022 / CommonJS, VS Code extension API, Vitest.

**Execution constraints (from user):**
- Implementation tasks are dispatched to **Sonnet** sub-agents (repo rule in CLAUDE.md).
- **Checkpoint R1 and R2:** dispatch an **Opus** review agent at **xhigh effort** after each chunk.
- **Checkpoint R3 (final):** dispatch a **Fable** review agent at **xhigh effort** over the full diff BEFORE the version bump and `v2.8.55` tag push (the tag triggers the marketplace release). Do not bump/tag until R3 findings are resolved.

---

## File map

| File | Action | Responsibility |
| --- | --- | --- |
| `src/services/terminal/settingsGuard.ts` | Create | Pure logic: scope assessment, shadow update rule, rate limiter, event ring buffer, change classification, report/line formatting |
| `src/services/terminal/settingsGuardController.ts` | Create | vscode-dependent orchestration: config listener, globalState persistence, restore writes, toasts (Undo / Disable / Resume / Show Report), output channel |
| `src/extension.ts` | Modify | Instantiate + start controller, register `nexus.settingsGuard.showReport`, record own-writes from `repairMacroKeybindings` |
| `package.json` | Modify | Contribute command + `nexus.settingsGuard.enabled` setting |
| `test/unit/settingsGuard.test.ts` | Create | Unit tests for all pure logic |
| `CHANGELOG.md` | Modify | 2.8.55 entry |

---

### Task 1: Pure module — types + `assessScopes`

**Files:**
- Create: `src/services/terminal/settingsGuard.ts`
- Test: `test/unit/settingsGuard.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/settingsGuard.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  assessScopes,
  GuardScope,
} from "../../src/services/terminal/settingsGuard";

const REQUIRED = ["nexus.macro.run", "nexus.macro.runBinding"];

const NO_OWN_WRITES: Record<GuardScope, string[] | null> = {
  global: null,
  workspace: null,
  workspaceFolder: null,
};

function current(
  global?: unknown,
  workspace?: unknown,
  workspaceFolder?: unknown
): Record<GuardScope, unknown> {
  return { global, workspace, workspaceFolder };
}

describe("assessScopes", () => {
  const GOOD = ["workbench.action.quickOpen", ...REQUIRED];

  it("classifies a scope containing all required commands as healthy", () => {
    const result = assessScopes({ global: GOOD }, current(GOOD), REQUIRED, NO_OWN_WRITES);
    expect(result.find((a) => a.scope === "global")).toEqual({
      scope: "global",
      classification: "healthy",
    });
  });

  it("classifies undefined scope with no shadow as none", () => {
    const result = assessScopes(undefined, current(undefined), REQUIRED, NO_OWN_WRITES);
    expect(result.every((a) => a.classification === "none")).toBe(true);
  });

  it("detects vanished key (shadow had it, now undefined) and restores full shadow", () => {
    const result = assessScopes({ global: GOOD }, current(undefined), REQUIRED, NO_OWN_WRITES);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("vanished");
    expect(g?.restoreValue).toEqual(GOOD);
  });

  it("detects emptied array and restores full shadow", () => {
    const result = assessScopes({ global: GOOD }, current([]), REQUIRED, NO_OWN_WRITES);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("emptied");
    expect(g?.restoreValue).toEqual(GOOD);
  });

  it("detects partially stripped array and appends only missing required commands", () => {
    const remaining = ["workbench.action.quickOpen", "nexus.macro.run"];
    const result = assessScopes({ global: GOOD }, current(remaining), REQUIRED, NO_OWN_WRITES);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("stripped");
    // Preserves the user's surviving entries, appends only what's missing.
    expect(g?.restoreValue).toEqual([...remaining, "nexus.macro.runBinding"]);
  });

  it("detects corrupt non-array value and restores full shadow", () => {
    const result = assessScopes({ global: GOOD }, current("oops"), REQUIRED, NO_OWN_WRITES);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("corrupt-type");
    expect(g?.restoreValue).toEqual(GOOD);
  });

  it("does NOT restore a scope that was never healthy in the shadow", () => {
    // Shadow exists but never contained the required commands at this scope.
    const result = assessScopes({ global: ["other.cmd"] }, current([]), REQUIRED, NO_OWN_WRITES);
    expect(result.find((a) => a.scope === "global")?.classification).toBe("none");
  });

  it("classifies a value equal to the recorded own-write as own-write, no restore", () => {
    const ownWrites: Record<GuardScope, string[] | null> = {
      ...NO_OWN_WRITES,
      global: GOOD,
    };
    const result = assessScopes({ global: GOOD }, current(GOOD), REQUIRED, ownWrites);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("own-write");
    expect(g?.restoreValue).toBeUndefined();
  });

  it("assesses workspace and workspaceFolder scopes independently", () => {
    const result = assessScopes(
      { global: GOOD, workspace: GOOD },
      current(GOOD, undefined),
      REQUIRED,
      NO_OWN_WRITES
    );
    expect(result.find((a) => a.scope === "global")?.classification).toBe("healthy");
    expect(result.find((a) => a.scope === "workspace")?.classification).toBe("vanished");
    expect(result.find((a) => a.scope === "workspaceFolder")?.classification).toBe("none");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/settingsGuard.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/terminal/settingsGuard'` (or missing exports).

- [ ] **Step 3: Write the implementation**

Create `src/services/terminal/settingsGuard.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/settingsGuard.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/terminal/settingsGuard.ts test/unit/settingsGuard.test.ts
git commit -m "feat: add settings guard scope assessment (pure logic)"
```

---

### Task 2: Pure module — shadow update rule + rate limiter

**Files:**
- Modify: `src/services/terminal/settingsGuard.ts` (append)
- Modify: `test/unit/settingsGuard.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append to `test/unit/settingsGuard.test.ts`; extend the import from `settingsGuard` with the new symbols)

```typescript
import {
  assessScopes,
  computeShadowUpdate,
  evaluateRateLimit,
  GuardScope,
  SESSION_RESTORE_CAP,
  BURST_CAP,
  BURST_WINDOW_MS,
} from "../../src/services/terminal/settingsGuard";
```

```typescript
describe("computeShadowUpdate", () => {
  const GOOD = ["workbench.action.quickOpen", ...REQUIRED];

  it("captures all defined healthy scopes", () => {
    const shadow = computeShadowUpdate(current(GOOD, GOOD), REQUIRED, "2026-06-11T00:00:00.000Z");
    expect(shadow).toEqual({
      values: { global: GOOD, workspace: GOOD },
      updatedAt: "2026-06-11T00:00:00.000Z",
    });
  });

  it("returns undefined when any defined scope is unhealthy (keep old shadow)", () => {
    expect(computeShadowUpdate(current(GOOD, []), REQUIRED, "t")).toBeUndefined();
    expect(computeShadowUpdate(current(["other"]), REQUIRED, "t")).toBeUndefined();
    expect(computeShadowUpdate(current("corrupt"), REQUIRED, "t")).toBeUndefined();
  });

  it("returns undefined when no scope has an override (nothing to shadow)", () => {
    expect(computeShadowUpdate(current(), REQUIRED, "t")).toBeUndefined();
  });

  it("drops non-string entries when capturing", () => {
    const shadow = computeShadowUpdate(current([...GOOD, 42 as unknown as string]), REQUIRED, "t");
    expect(shadow?.values.global).toEqual(GOOD);
  });
});

describe("evaluateRateLimit", () => {
  const MIN = 60_000;

  it("allows restores under both limits", () => {
    expect(evaluateRateLimit([], 0)).toBeNull();
    expect(evaluateRateLimit([0, 20 * MIN], 40 * MIN)).toBeNull();
  });

  it("pauses at the session cap", () => {
    // 12 prior restores spread far apart (no burst) → 13th blocked by session cap.
    const stamps = Array.from({ length: SESSION_RESTORE_CAP }, (_, i) => i * 3 * 60 * MIN);
    expect(evaluateRateLimit(stamps, stamps[stamps.length - 1] + 3 * 60 * MIN)).toBe("session-cap");
  });

  it("allows exactly the session cap minus one to pass without burst", () => {
    const stamps = Array.from({ length: SESSION_RESTORE_CAP - 1 }, (_, i) => i * 3 * 60 * MIN);
    expect(evaluateRateLimit(stamps, stamps[stamps.length - 1] + 3 * 60 * MIN)).toBeNull();
  });

  it("pauses on a burst: BURST_CAP restores inside the window", () => {
    const now = 100 * MIN;
    const stamps = [now - 9 * MIN, now - 5 * MIN, now - MIN]; // 3 within 10 min
    expect(evaluateRateLimit(stamps, now)).toBe("burst");
  });

  it("does not count restores older than the burst window", () => {
    const now = 100 * MIN;
    const stamps = [now - BURST_WINDOW_MS - MIN, now - 5 * MIN, now - MIN]; // only 2 recent
    expect(evaluateRateLimit(stamps, now)).toBeNull();
  });

  it("never triggers burst on a ~3-hour external rewrite cycle", () => {
    const cycle = 3 * 60 * MIN;
    const stamps = Array.from({ length: BURST_CAP + 2 }, (_, i) => i * cycle);
    expect(evaluateRateLimit(stamps, stamps[stamps.length - 1] + 1000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/settingsGuard.test.ts`
Expected: FAIL — `computeShadowUpdate is not a function` (and friends).

- [ ] **Step 3: Write the implementation** (append to `src/services/terminal/settingsGuard.ts`)

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/settingsGuard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/terminal/settingsGuard.ts test/unit/settingsGuard.test.ts
git commit -m "feat: add settings guard shadow rule and rate limiter"
```

---

### Task 3: Pure module — event log, change classification, report formatting

**Files:**
- Modify: `src/services/terminal/settingsGuard.ts` (append)
- Modify: `test/unit/settingsGuard.test.ts` (append; extend import with `appendEvent`, `classifyWatchedChange`, `renderValue`, `formatEventLine`, `formatGuardReport`, `EVENT_LOG_CAP`, `GuardEvent`)

- [ ] **Step 1: Write the failing tests** (append)

```typescript
describe("appendEvent ring buffer", () => {
  const ev = (n: number): GuardEvent => ({
    timestamp: `t${n}`,
    key: "k",
    kind: "external-other",
  });

  it("appends and preserves order", () => {
    const log = appendEvent(appendEvent([], ev(1)), ev(2));
    expect(log.map((e) => e.timestamp)).toEqual(["t1", "t2"]);
  });

  it("evicts oldest entries beyond the cap", () => {
    let log: GuardEvent[] = [];
    for (let i = 0; i < EVENT_LOG_CAP + 5; i++) log = appendEvent(log, ev(i));
    expect(log).toHaveLength(EVENT_LOG_CAP);
    expect(log[0].timestamp).toBe("t5");
    expect(log[log.length - 1].timestamp).toBe(`t${EVENT_LOG_CAP + 4}`);
  });
});

describe("renderValue", () => {
  it("renders undefined as (not set)", () => {
    expect(renderValue(undefined)).toBe("(not set)");
  });
  it("renders JSON and truncates long values", () => {
    expect(renderValue(["a", "b"])).toBe('["a","b"]');
    const long = renderValue(Array.from({ length: 100 }, (_, i) => `cmd${i}`));
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("classifyWatchedChange", () => {
  it("returns undefined when values are structurally equal", () => {
    expect(classifyWatchedChange("k", ["a"], ["a"])).toBeUndefined();
    expect(classifyWatchedChange("k", undefined, undefined)).toBeUndefined();
  });

  it("classifies array shrink / vanish / emptied as external-strip", () => {
    expect(classifyWatchedChange("k", ["a", "b"], ["a"])?.kind).toBe("external-strip");
    expect(classifyWatchedChange("k", ["a"], undefined)?.kind).toBe("external-strip");
    expect(classifyWatchedChange("k", ["a"], [])?.kind).toBe("external-strip");
  });

  it("classifies other changes as external-other", () => {
    expect(classifyWatchedChange("k", false, true)?.kind).toBe("external-other");
    expect(classifyWatchedChange("k", ["a"], ["a", "b"])?.kind).toBe("external-other");
    expect(classifyWatchedChange("k", undefined, ["a"])?.kind).toBe("external-other");
  });
});

describe("formatGuardReport", () => {
  it("summarizes counts, first/last seen, affected keys and includes event lines", () => {
    const events: GuardEvent[] = [
      { timestamp: "2026-06-11T01:00:00.000Z", key: "terminal.integrated.commandsToSkipShell", scope: "global", kind: "external-strip", before: '["a"]', after: "(not set)" },
      { timestamp: "2026-06-11T01:00:01.000Z", key: "terminal.integrated.commandsToSkipShell", scope: "global", kind: "restore" },
      { timestamp: "2026-06-11T04:00:00.000Z", key: "nexus.terminal.passthroughKeys", kind: "external-strip", before: '["b"]', after: "[]" },
    ];
    const report = formatGuardReport(events, true, "2026-06-11T05:00:00.000Z");
    expect(report).toContain("Nexus Settings Guard Report");
    expect(report).toContain("ENABLED");
    expect(report).toContain("External modifications observed: 2");
    expect(report).toContain("Automatic restores performed:    1");
    expect(report).toContain("First seen: 2026-06-11T01:00:00.000Z");
    expect(report).toContain("Last seen:  2026-06-11T04:00:00.000Z");
    expect(report).toContain("terminal.integrated.commandsToSkipShell");
    expect(report).toContain("nexus.terminal.passthroughKeys");
  });

  it("reports a disabled guard", () => {
    expect(formatGuardReport([], false, "t")).toContain("DISABLED");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/settingsGuard.test.ts`
Expected: FAIL on missing exports.

- [ ] **Step 3: Write the implementation** (append to `src/services/terminal/settingsGuard.ts`)

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/settingsGuard.test.ts`
Expected: PASS (all tests from Tasks 1–3).

- [ ] **Step 5: Run the full unit suite + type check to catch regressions**

Run: `npm run compile && npm run test:unit`
Expected: clean compile, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/terminal/settingsGuard.ts test/unit/settingsGuard.test.ts
git commit -m "feat: add settings guard event log, classification and report"
```

---

### CHECKPOINT R1 — Opus xhigh review (pure module)

- [ ] Dispatch a review agent — **model: opus, effort: xhigh** — with this prompt: *"Review commits since `<sha of last commit before Task 1>` (the pure settings-guard module `src/services/terminal/settingsGuard.ts` + its tests) against the spec `docs/superpowers/specs/2026-06-11-settings-guard-design.md` §§1–5. Hunt for: logic errors in scope assessment and restore-value construction, rate-limiter off-by-one errors, ring-buffer eviction bugs, classification edge cases (non-string array entries, null, corrupt types), type unsoundness under TS strict, and missing test coverage. Effort: xhigh — be adversarial."*
- [ ] Fix all confirmed findings; re-run `npm run compile && npm run test:unit`; commit fixes as `fix: address review findings in settings guard pure module`.

---

### Task 4: `SettingsGuardController` (vscode wiring)

**Files:**
- Create: `src/services/terminal/settingsGuardController.ts`

No unit tests — this class is thin orchestration over the tested pure module, following the repo pattern (e.g. `TerminalRegistry`). Verified by type-check + build + manual smoke.

- [ ] **Step 1: Write the controller**

Create `src/services/terminal/settingsGuardController.ts`:

```typescript
import * as vscode from "vscode";
import {
  appendEvent,
  assessScopes,
  classifyWatchedChange,
  computeShadowUpdate,
  evaluateRateLimit,
  formatEventLine,
  formatGuardReport,
  renderValue,
  GUARD_SCOPES,
  type GuardEvent,
  type GuardScope,
  type ScopeAssessment,
  type SkipShellShadow,
} from "./settingsGuard";

const SHADOW_KEY = "nexus.settingsGuard.lastKnownGood";
const EVENT_LOG_KEY = "nexus.settingsGuard.eventLog";
const SKIP_SHELL_SECTION = "terminal.integrated";
const SKIP_SHELL_LEAF = "commandsToSkipShell";
const SKIP_SHELL_FULL = `${SKIP_SHELL_SECTION}.${SKIP_SHELL_LEAF}`;

/** Log-only watched keys; the skip-shell list gets the richer per-scope handling. */
const WATCHED_KEYS = [
  "terminal.integrated.sendKeybindingsToShell",
  "window.enableMenuBarMnemonics",
  "nexus.terminal.passthroughKeys",
  "nexus.terminal.highlighting.rules",
] as const;

export function scopeToTarget(scope: GuardScope): vscode.ConfigurationTarget {
  switch (scope) {
    case "global":
      return vscode.ConfigurationTarget.Global;
    case "workspace":
      return vscode.ConfigurationTarget.Workspace;
    case "workspaceFolder":
      return vscode.ConfigurationTarget.WorkspaceFolder;
  }
}

export function targetToScope(target: vscode.ConfigurationTarget): GuardScope {
  switch (target) {
    case vscode.ConfigurationTarget.Workspace:
      return "workspace";
    case vscode.ConfigurationTarget.WorkspaceFolder:
      return "workspaceFolder";
    default:
      return "global";
  }
}

/**
 * Orchestrates the Settings Guard (spec: docs/superpowers/specs/2026-06-11-settings-guard-design.md).
 *
 * - Auto-restores externally-stripped `terminal.integrated.commandsToSkipShell`
 *   values from a last-known-good shadow kept in globalState (opt-out via
 *   `nexus.settingsGuard.enabled`).
 * - Logs every external mutation of the watched keys to a persisted ring buffer
 *   and the "Nexus Settings Guard" output channel — always on, even when the
 *   guard itself is disabled or paused.
 */
export class SettingsGuardController implements vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  /** Last value Nexus itself wrote per scope (guard restore, undo, or keybinding repair). */
  private readonly ownWrites: Record<GuardScope, string[] | null> = {
    global: null,
    workspace: null,
    workspaceFolder: null,
  };
  private restoreTimestamps: number[] = [];
  private paused = false;
  private readonly watchedSnapshot = new Map<string, unknown>();
  /**
   * In-memory mirror of the persisted event log. recordEvent appends here and
   * persists fire-and-forget; reading globalState back on every event would
   * race (stale read-modify-write drops entries when events arrive quickly).
   */
  private eventLog: GuardEvent[] = [];
  /** Serializes checkSkipShell runs so a restore's own change event can't interleave. */
  private checkChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly requiredCommands: readonly string[]
  ) {
    this.output = vscode.window.createOutputChannel("Nexus Settings Guard");
  }

  /** Subscribe to config changes and run the activation check (catches overnight damage). */
  start(): void {
    this.eventLog = this.context.globalState.get<GuardEvent[]>(EVENT_LOG_KEY, []);
    for (const key of WATCHED_KEYS) {
      this.watchedSnapshot.set(key, this.readEffective(key));
    }
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => this.onConfigChange(e))
    );
    this.enqueueCheck();
  }

  /** Called by repairMacroKeybindings so its writes classify as own-write, not external. */
  recordOwnWrite(scope: GuardScope, value: string[]): void {
    this.ownWrites[scope] = value;
  }

  showReport(): void {
    this.output.appendLine(formatGuardReport(this.eventLog, this.isEnabled(), new Date().toISOString()));
    this.output.show(true);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.output.dispose();
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration("nexus.settingsGuard").get<boolean>("enabled", true);
  }

  private readEffective(fullKey: string): unknown {
    const dot = fullKey.lastIndexOf(".");
    return vscode.workspace.getConfiguration(fullKey.slice(0, dot)).get(fullKey.slice(dot + 1));
  }

  private onConfigChange(e: vscode.ConfigurationChangeEvent): void {
    if (e.affectsConfiguration(SKIP_SHELL_FULL)) {
      this.enqueueCheck();
    }
    for (const key of WATCHED_KEYS) {
      if (!e.affectsConfiguration(key)) continue;
      const before = this.watchedSnapshot.get(key);
      const after = this.readEffective(key);
      this.watchedSnapshot.set(key, after);
      const change = classifyWatchedChange(key, before, after);
      if (change) {
        this.recordEvent({
          timestamp: new Date().toISOString(),
          key,
          kind: change.kind,
          before: change.before,
          after: change.after,
        });
      }
    }
  }

  private enqueueCheck(): void {
    this.checkChain = this.checkChain.then(() => this.checkSkipShell()).catch(() => undefined);
  }

  private async checkSkipShell(): Promise<void> {
    const config = vscode.workspace.getConfiguration(SKIP_SHELL_SECTION);
    const inspect = config.inspect<string[]>(SKIP_SHELL_LEAF);
    const current: Record<GuardScope, unknown> = {
      global: inspect?.globalValue,
      workspace: inspect?.workspaceValue,
      workspaceFolder: inspect?.workspaceFolderValue,
    };
    const shadow = this.context.globalState.get<SkipShellShadow>(SHADOW_KEY);
    const assessments = assessScopes(shadow?.values, current, this.requiredCommands, this.ownWrites);

    // Consume own-write markers once observed.
    for (const a of assessments) {
      if (a.classification === "own-write") {
        this.ownWrites[a.scope] = null;
        this.recordEvent({
          timestamp: new Date().toISOString(),
          key: SKIP_SHELL_FULL,
          scope: a.scope,
          kind: "own-write",
        });
      }
    }

    const restores = assessments.filter((a) => a.restoreValue !== undefined);
    if (restores.length === 0) {
      const update = computeShadowUpdate(current, this.requiredCommands, new Date().toISOString());
      if (update) await this.context.globalState.update(SHADOW_KEY, update);
      return;
    }

    // Forensics first — logged even when the guard is disabled or paused.
    for (const a of restores) {
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: SKIP_SHELL_FULL,
        scope: a.scope,
        kind: "external-strip",
        detail: a.classification,
        before: renderValue(shadow?.values?.[a.scope]),
        after: renderValue(current[a.scope]),
      });
    }

    if (!this.isEnabled() || this.paused) return;

    const pauseReason = evaluateRateLimit(this.restoreTimestamps, Date.now());
    if (pauseReason) {
      this.pause(pauseReason);
      return;
    }

    for (const a of restores) {
      const value = a.restoreValue as string[];
      this.ownWrites[a.scope] = value;
      await config.update(SKIP_SHELL_LEAF, value, scopeToTarget(a.scope));
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: SKIP_SHELL_FULL,
        scope: a.scope,
        kind: "restore",
        after: renderValue(value),
      });
    }
    this.restoreTimestamps.push(Date.now());
    this.showRestoreToast(restores, current);
  }

  private showRestoreToast(
    restores: ScopeAssessment[],
    preValues: Record<GuardScope, unknown>
  ): void {
    void vscode.window
      .showWarningMessage(
        "Nexus restored terminal settings modified by an external program.",
        "Undo",
        "Disable Guard",
        "Show Report"
      )
      .then(async (choice) => {
        if (choice === "Undo") {
          await this.undoRestore(restores, preValues);
        } else if (choice === "Disable Guard") {
          await vscode.workspace
            .getConfiguration("nexus.settingsGuard")
            .update("enabled", false, vscode.ConfigurationTarget.Global);
          void vscode.window.showInformationMessage(
            "Nexus Settings Guard disabled. External changes are still logged — see \"Nexus: Show Settings Guard Report\"."
          );
        } else if (choice === "Show Report") {
          this.showReport();
        }
      });
  }

  private async undoRestore(
    restores: ScopeAssessment[],
    preValues: Record<GuardScope, unknown>
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration(SKIP_SHELL_SECTION);

    // Clear the shadow for undone scopes FIRST so the undo write cannot be
    // re-detected as a fresh corruption and immediately re-restored.
    const shadow = this.context.globalState.get<SkipShellShadow>(SHADOW_KEY);
    if (shadow) {
      const values = { ...shadow.values };
      for (const a of restores) delete values[a.scope];
      await this.context.globalState.update(SHADOW_KEY, { ...shadow, values });
    }

    for (const a of restores) {
      const prev = preValues[a.scope];
      const value = Array.isArray(prev)
        ? prev.filter((v): v is string => typeof v === "string")
        : undefined; // vanished / corrupt-type → remove the override entirely
      this.ownWrites[a.scope] = value ?? null;
      await config.update(SKIP_SHELL_LEAF, value, scopeToTarget(a.scope));
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: SKIP_SHELL_FULL,
        scope: a.scope,
        kind: "undo",
        after: renderValue(value),
      });
    }
  }

  private pause(reason: "session-cap" | "burst"): void {
    this.paused = true;
    this.recordEvent({
      timestamp: new Date().toISOString(),
      key: SKIP_SHELL_FULL,
      kind: "paused",
      detail: reason,
    });
    const count = this.restoreTimestamps.length;
    void vscode.window
      .showWarningMessage(
        `An external program keeps rewriting settings.json (${count} Nexus auto-repairs this session) — auto-repair paused.`,
        "Resume Guard",
        "Show Report"
      )
      .then((choice) => {
        if (choice === "Resume Guard") this.resume();
        else if (choice === "Show Report") this.showReport();
      });
  }

  private resume(): void {
    this.paused = false;
    this.restoreTimestamps = [];
    this.recordEvent({
      timestamp: new Date().toISOString(),
      key: SKIP_SHELL_FULL,
      kind: "resumed",
    });
    this.enqueueCheck(); // repair immediately if settings are still corrupt
  }

  private recordEvent(event: GuardEvent): void {
    this.eventLog = appendEvent(this.eventLog, event);
    void this.context.globalState.update(EVENT_LOG_KEY, this.eventLog);
    this.output.appendLine(formatEventLine(event));
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npm run compile`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/services/terminal/settingsGuardController.ts
git commit -m "feat: add settings guard controller (vscode wiring)"
```

---

### Task 5: Wire into `extension.ts` + `package.json` contributions

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: package.json — contribute the command**

In `contributes.commands`, after the `nexus.settings.fixMacroKeybindings` entry, add:

```json
{
  "command": "nexus.settingsGuard.showReport",
  "title": "Show Settings Guard Report",
  "category": "Nexus"
}
```

- [ ] **Step 2: package.json — contribute the setting**

In `contributes.configuration.properties`, add (next to the other `nexus.terminal.*` keys; no `order` field needed):

```json
"nexus.settingsGuard.enabled": {
  "type": "boolean",
  "default": true,
  "markdownDescription": "Automatically restore `terminal.integrated.commandsToSkipShell` entries when an external program (e.g. a corporate DLP/endpoint agent) strips them from `settings.json`. Restores are rate-limited and every restore shows an Undo notification. Forensic logging (see *Nexus: Show Settings Guard Report*) stays active even when this is disabled."
}
```

- [ ] **Step 3: extension.ts — import + module-level guard reference**

Add to the imports (next to the other `services/terminal` imports around `src/extension.ts:62-64`):

```typescript
import { SettingsGuardController, targetToScope } from "./services/terminal/settingsGuardController";
```

Add a module-level reference directly below `const MACRO_SKIP_SHELL_COMMANDS = ...` (`src/extension.ts:67`):

```typescript
/** Set during activate(); lets repairMacroKeybindings mark its writes as Nexus-own. */
let activeSettingsGuard: SettingsGuardController | undefined;
```

- [ ] **Step 4: extension.ts — record own-writes in `repairMacroKeybindings`**

In the skip-shell write loop (currently `src/extension.ts:107-113`), record each write with the guard before performing it:

```typescript
  for (const { target, value } of writes) {
    // "global-fallback" maps to ConfigurationTarget.Global (same write; different label for clarity)
    const configTarget = target === "global-fallback"
      ? vscode.ConfigurationTarget.Global
      : target;
    activeSettingsGuard?.recordOwnWrite(targetToScope(configTarget), value);
    await termConfig.update("commandsToSkipShell", value, configTarget);
  }
```

(Only the `recordOwnWrite` line is new.)

- [ ] **Step 5: extension.ts — instantiate, start, register command**

In `activate()`, immediately BEFORE `const fixMacroKeybindingsCommand = ...` (currently `src/extension.ts:985`):

```typescript
  const settingsGuard = new SettingsGuardController(context, MACRO_SKIP_SHELL_COMMANDS);
  activeSettingsGuard = settingsGuard;
  settingsGuard.start();
  const settingsGuardReportCommand = vscode.commands.registerCommand(
    "nexus.settingsGuard.showReport",
    () => settingsGuard.showReport()
  );
```

Add `settingsGuard,` and `settingsGuardReportCommand,` to the `context.subscriptions.push(...)` list (next to `fixMacroKeybindingsCommand` around `src/extension.ts:1022`).

- [ ] **Step 6: Build + full test suite**

Run: `npm run build && npm test`
Expected: build clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: wire settings guard into activation and contributions"
```

---

### CHECKPOINT R2 — Opus xhigh review (controller + wiring)

- [ ] Dispatch a review agent — **model: opus, effort: xhigh** — with this prompt: *"Review the commits for `settingsGuardController.ts`, the `extension.ts` wiring, and the `package.json` contributions against spec `docs/superpowers/specs/2026-06-11-settings-guard-design.md` §§2–6. Hunt specifically for: feedback loops (guard restore re-triggering itself — verify the own-write marker lifecycle across the async event chain), the Undo path re-triggering a restore, races between concurrent `checkSkipShell` runs (verify the promise-chain serialization), globalState read-modify-write races in `recordEvent`, toast button handlers after extension disposal, `inspect()` returning corrupt runtime types despite the TS generic, and the rate-limit semantics (12/session, 3-per-10-min burst, Resume re-arm). Effort: xhigh — be adversarial."*
- [ ] Fix all confirmed findings; re-run `npm run build && npm test`; commit as `fix: address review findings in settings guard wiring`.

---

### Task 6: Changelog

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the 2.8.55 section** directly under `## [Unreleased]`:

```markdown
## [2.8.55] — 2026-06-11

### Added

- **Settings Guard: Nexus now self-heals `terminal.integrated.commandsToSkipShell` when an external program strips it.** Some corporate environments run agents (e.g. DLP/endpoint tools) that periodically rewrite `settings.json` and drop array-valued keys, silently breaking Nexus macro shortcuts. Nexus now keeps a last-known-good copy of the skip-shell list and automatically restores it when it detects the strip signature (key vanished, array emptied, or Nexus commands removed) — including damage done while VS Code was closed. Every restore shows an Undo notification; restores are rate-limited (12 per session, max 3 per 10 minutes) and pause with a Resume button if an external tool fights back. Disable via `nexus.settingsGuard.enabled`. Boolean settings (`sendKeybindingsToShell`, `enableMenuBarMnemonics`) are never changed automatically — those keep the existing confirm-gated "Fix Macro Keybindings" repair.
- **New command "Nexus: Show Settings Guard Report"** — a forensic log of external modifications to the watched settings (timestamps, before/after values, kept across restarts). Hand it to your IT team to correlate against endpoint-agent activity logs and identify the tool corrupting `settings.json`.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add changelog entry for settings guard (v2.8.55)"
```

---

### Task 7: Full verification

- [ ] **Step 1:** `npm run build` — clean.
- [ ] **Step 2:** `npm test` — all tests pass with coverage.
- [ ] **Step 3:** `npm run package:vsix` — VSIX packages without errors (catches contribution-schema mistakes in package.json).

---

### CHECKPOINT R3 — FINAL Fable xhigh review (release gate)

- [ ] Dispatch a review agent — **model: fable, effort: xhigh** — with this prompt: *"Final pre-release review of the full diff `git diff <sha before Task 1>..HEAD` for NexTerminal v2.8.55 (Settings Guard + Forensics). Verify: (1) complete spec compliance against `docs/superpowers/specs/2026-06-11-settings-guard-design.md` — every numbered design section; (2) no regression risk to the existing repair flow (`repairMacroKeybindings`, `maybeWarnMacroKeybindingsBlocked`); (3) no path by which the guard can corrupt settings.json itself (this extension's history: automatic writes were the original corruption vector, see CHANGELOG 2.8.50); (4) user-facing strings are clear and the report is genuinely useful to corporate IT; (5) tests cover the failure modes that matter. Effort: xhigh. This gates a marketplace release — reject if anything is unsound."*
- [ ] Fix all confirmed findings, re-run Task 7 verification, commit fixes.
- [ ] **HARD GATE: do not proceed to Task 8 until R3 is clean.**

---

### Task 8: Release — version bump + tag (tag push triggers release)

- [ ] **Step 1: Bump version** in `package.json`: `"version": "2.8.54"` → `"version": "2.8.55"`, then sync the lockfile:

```bash
npm install --package-lock-only
```

- [ ] **Step 2: Verify** `git diff` shows only the version fields in `package.json` + `package-lock.json`.

- [ ] **Step 3: Commit and tag**

```bash
git add package.json package-lock.json
git commit -m "chore: release v2.8.55"
git tag v2.8.55
```

- [ ] **Step 4: Confirm with the user, then push** (the tag triggers the marketplace release):

```bash
git push origin main --tags
```

---

## Out of scope (tracked in spec as non-goals / future)

- Auto-flipping boolean settings — stays prompt-gated.
- Input-stream macro fallback (design option C) — separate future effort.
