import { describe, expect, it } from "vitest";
import {
  assessScopes,
  computeShadowUpdate,
  evaluateRateLimit,
  sanitizeShadow,
  SESSION_RESTORE_CAP,
  BURST_CAP,
  BURST_WINDOW_MS,
  GuardScope,
  appendEvent,
  classifyWatchedChange,
  renderValue,
  formatGuardReport,
  formatEventLine,
  EVENT_LOG_CAP,
  GuardEvent,
  assessWatchedValue,
  HEALABLE_KEYS,
  WatchedValuePolicy,
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

describe("R1 review fixes", () => {
  const GOOD = ["workbench.action.quickOpen", ...REQUIRED];

  it("assessScopes with empty requiredCommands classifies everything as none", () => {
    const result = assessScopes({ global: GOOD }, current(undefined), [], NO_OWN_WRITES);
    expect(result.every((a) => a.classification === "none")).toBe(true);
  });

  it("computeShadowUpdate with empty requiredCommands captures nothing", () => {
    expect(computeShadowUpdate(current(GOOD), [], "t")).toBeUndefined();
  });

  it("stripped restore drops orphaned nexus.macro.slot entries", () => {
    const remaining = ["nexus.macro.slot", "keep.me", "nexus.macro.run"];
    const result = assessScopes({ global: GOOD }, current(remaining), REQUIRED, NO_OWN_WRITES);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("stripped");
    expect(g?.restoreValue).toEqual(["keep.me", "nexus.macro.run", "nexus.macro.runBinding"]);
  });

  it("stripped restore drops non-string entries", () => {
    const remaining = ["keep.me", 42, { bad: true }, "nexus.macro.run"];
    const result = assessScopes({ global: GOOD }, current(remaining), REQUIRED, NO_OWN_WRITES);
    expect(result.find((a) => a.scope === "global")?.restoreValue).toEqual([
      "keep.me",
      "nexus.macro.run",
      "nexus.macro.runBinding",
    ]);
  });

  it("shadow capture drops orphaned and non-string entries", () => {
    const dirty = ["nexus.macro.slot", "keep.me", 7, ...REQUIRED];
    const shadow = computeShadowUpdate(current(dirty), REQUIRED, "t");
    expect(shadow?.values.global).toEqual(["keep.me", ...REQUIRED]);
  });

  it("formatEventLine marks one-sided changes as not recorded", () => {
    const line = formatEventLine({ timestamp: "t", key: "k", kind: "restore", after: '["a"]' });
    expect(line).toContain('(not recorded) -> ["a"]');
  });
});

describe("sanitizeShadow (global-scope-only guard)", () => {
  const GOOD = ["workbench.action.quickOpen", ...REQUIRED];

  it("keeps a valid global scope and drops workspace scopes from pre-release shadows", () => {
    const raw = {
      values: { global: GOOD, workspace: ["w1.only"], workspaceFolder: ["wf.only"] },
      updatedAt: "t",
    };
    expect(sanitizeShadow(raw)).toEqual({ values: { global: GOOD }, updatedAt: "t" });
  });

  it("rejects unrecognizable shapes", () => {
    expect(sanitizeShadow(undefined)).toBeUndefined();
    expect(sanitizeShadow(null)).toBeUndefined();
    expect(sanitizeShadow("junk")).toBeUndefined();
    expect(sanitizeShadow({})).toBeUndefined();
    expect(sanitizeShadow({ values: { global: GOOD } })).toBeUndefined(); // no updatedAt
    expect(sanitizeShadow({ values: { workspace: GOOD }, updatedAt: "t" })).toBeUndefined(); // no global
    expect(sanitizeShadow({ values: { global: "not-array" }, updatedAt: "t" })).toBeUndefined();
  });

  it("drops non-string entries and rejects an all-invalid global array", () => {
    expect(sanitizeShadow({ values: { global: ["a", 1, null] }, updatedAt: "t" })).toEqual({
      values: { global: ["a"] },
      updatedAt: "t",
    });
    expect(sanitizeShadow({ values: { global: [42] }, updatedAt: "t" })).toBeUndefined();
  });

  it("regression: a workspace-only shadow can never produce a workspace restore", () => {
    // Composition scenario from the release review: shadow captured in workspace
    // W1 must not classify W2's absent override as vanished.
    const dirty = sanitizeShadow({
      values: { workspace: GOOD },
      updatedAt: "t",
    });
    expect(dirty).toBeUndefined();
    const result = assessScopes(dirty?.values, current(undefined, undefined), REQUIRED, NO_OWN_WRITES);
    expect(result.every((a) => a.restoreValue === undefined)).toBe(true);
  });
});


describe("formatEventLine focus marker", () => {
  it("appends focused/unfocused when set and omits when undefined", () => {
    const base = { timestamp: "t", key: "k", kind: "external-other" as const };
    expect(formatEventLine({ ...base, focused: true })).toContain("{focused}");
    expect(formatEventLine({ ...base, focused: false })).toContain("{unfocused}");
    expect(formatEventLine(base)).not.toContain("{focused}");
    expect(formatEventLine(base)).not.toContain("{unfocused}");
  });
});

describe("classifyWatchedChange element-replacement detection", () => {
  it("classifies same-length {}-replacement as external-strip", () => {
    expect(classifyWatchedChange("k", ["b", "e"], [{}, {}])?.kind).toBe("external-strip");
  });
  it("classifies partial string loss as external-strip", () => {
    expect(classifyWatchedChange("k", ["b", "e", "g"], ["b", {}, {}])?.kind).toBe("external-strip");
  });
  it("keeps object-array edits (zero prior strings) as external-other", () => {
    expect(classifyWatchedChange("k", [{ pattern: "a" }], [{ pattern: "b" }, { pattern: "c" }])?.kind).toBe("external-other");
  });
  it("string additions stay external-other", () => {
    expect(classifyWatchedChange("k", ["b"], ["b", "e"])?.kind).toBe("external-other");
  });
});

describe("assessScopes full restore when every entry destroyed", () => {
  const GOOD = ["workbench.action.quickOpen", ...REQUIRED];
  it("restores the full shadow when all surviving entries are non-strings", () => {
    const result = assessScopes({ global: GOOD }, current([{}, {}]), REQUIRED, NO_OWN_WRITES);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("emptied");
    expect(g?.restoreValue).toEqual(GOOD);
  });
  it("still appends conservatively when some user strings survive", () => {
    const result = assessScopes({ global: GOOD }, current(["keep.me", {}]), REQUIRED, NO_OWN_WRITES);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("stripped");
    expect(g?.restoreValue).toEqual(["keep.me", ...REQUIRED]);
  });
});

describe("assessWatchedValue", () => {
  const PK = HEALABLE_KEYS.find((p) => p.key === "nexus.terminal.passthroughKeys")!;
  const HR = HEALABLE_KEYS.find((p) => p.key === "nexus.terminal.highlighting.rules")!;

  it("absent override", () => {
    expect(assessWatchedValue(PK, undefined)).toEqual({ state: "absent" });
  });
  it("passthroughKeys: corrupt on non-array, empty, or all-{} arrays", () => {
    expect(assessWatchedValue(PK, "junk").state).toBe("corrupt");
    expect(assessWatchedValue(PK, []).state).toBe("corrupt");
    expect(assessWatchedValue(PK, [{}, {}, {}]).state).toBe("corrupt");
  });
  it("passthroughKeys: healthy mixed array captures only strings", () => {
    expect(assessWatchedValue(PK, ["b", {}, "e"])).toEqual({ state: "healthy", captureValue: ["b", "e"] });
  });
  it("rules: empty array is healthy, all-{} is corrupt, valid rules captured", () => {
    expect(assessWatchedValue(HR, [])).toEqual({ state: "healthy", captureValue: [] });
    expect(assessWatchedValue(HR, [{}, {}]).state).toBe("corrupt");
    const rule = { pattern: "x", color: "red" };
    expect(assessWatchedValue(HR, [rule, {}])).toEqual({ state: "healthy", captureValue: [rule] });
  });
});

describe("assessScopes shadow-free recovery via fallbackBase", () => {
  const VSCODE_DEFAULT = ["workbench.action.terminal.focusNext", "workbench.action.quickOpen"];
  const fb = { global: VSCODE_DEFAULT };

  it("recovers {}-mangled global with no shadow: vscode default + macro commands", () => {
    // The exact field signature: ["nexus.macro.run","nexus.macro.runBinding"] -> [{},{}]
    const result = assessScopes(undefined, current([{}, {}]), REQUIRED, NO_OWN_WRITES, fb);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("emptied");
    expect(g?.restoreValue).toEqual([...VSCODE_DEFAULT, ...REQUIRED]);
  });

  it("recovers a vanished key with no shadow from the fallback base", () => {
    const result = assessScopes(undefined, current(undefined), REQUIRED, NO_OWN_WRITES, fb);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("vanished");
    expect(g?.restoreValue).toEqual([...VSCODE_DEFAULT, ...REQUIRED]);
  });

  it("recovers a corrupt non-array with no shadow from the fallback base", () => {
    const result = assessScopes(undefined, current("garbage"), REQUIRED, NO_OWN_WRITES, fb);
    expect(result.find((a) => a.scope === "global")?.restoreValue).toEqual([...VSCODE_DEFAULT, ...REQUIRED]);
  });

  it("prefers the user's surviving custom entries over the fallback base", () => {
    const result = assessScopes(undefined, current(["my.custom.cmd", {}]), REQUIRED, NO_OWN_WRITES, fb);
    const g = result.find((a) => a.scope === "global");
    expect(g?.classification).toBe("stripped");
    expect(g?.restoreValue).toEqual(["my.custom.cmd", ...REQUIRED]);
  });

  it("a healthy shadow still takes precedence over the fallback base", () => {
    const shadow = { global: ["shadow.cmd", ...REQUIRED] };
    const result = assessScopes(shadow, current([{}, {}]), REQUIRED, NO_OWN_WRITES, fb);
    expect(result.find((a) => a.scope === "global")?.restoreValue).toEqual(["shadow.cmd", ...REQUIRED]);
  });

  it("without a fallback base AND without a shadow, still classifies none (unchanged)", () => {
    const result = assessScopes(undefined, current([{}, {}]), REQUIRED, NO_OWN_WRITES);
    expect(result.find((a) => a.scope === "global")?.classification).toBe("none");
  });

  it("does not duplicate a macro command already present in the fallback base", () => {
    const fbWithMacro = { global: ["workbench.action.quickOpen", "nexus.macro.run"] };
    const result = assessScopes(undefined, current(undefined), REQUIRED, NO_OWN_WRITES, fbWithMacro);
    expect(result.find((a) => a.scope === "global")?.restoreValue).toEqual([
      "workbench.action.quickOpen", "nexus.macro.run", "nexus.macro.runBinding",
    ]);
  });
});
