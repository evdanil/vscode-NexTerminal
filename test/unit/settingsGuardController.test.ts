import { beforeEach, describe, expect, it, vi } from "vitest";

// State defined BEFORE vi.mock so the factory can close over it (Vitest hoists vi.mock).
const mockState = {
  windowFocused: true,
  showWarning: vi.fn(async () => undefined as unknown),
  showInformation: vi.fn(async () => undefined as unknown),
};

const mockConfig = {
  effectiveValues: new Map<string, unknown>(),
  inspectValues: new Map<string, { globalValue?: unknown }>(),
  update: vi.fn(async () => {}),
};

let capturedListener: ((e: { affectsConfiguration: (key: string) => boolean }) => void) | undefined;

vi.mock("vscode", () => ({
  workspace: {
    onDidChangeConfiguration: vi.fn((cb: (e: unknown) => void) => {
      capturedListener = cb as (e: { affectsConfiguration: (key: string) => boolean }) => void;
      return { dispose: vi.fn() };
    }),
    getConfiguration: (section: string) => ({
      get: (leaf: string, def?: unknown) => {
        const full = `${section}.${leaf}`;
        return mockConfig.effectiveValues.has(full) ? mockConfig.effectiveValues.get(full) : def;
      },
      inspect: (leaf: string) => mockConfig.inspectValues.get(`${section}.${leaf}`),
      update: mockConfig.update,
    }),
  },
  window: {
    get state() {
      return { focused: mockState.windowFocused };
    },
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
    get showWarningMessage() { return mockState.showWarning; },
    get showInformationMessage() { return mockState.showInformation; },
  },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3,
  },
}));

// Imports AFTER mock
import * as vscode from "vscode";
import { SettingsGuardController } from "../../src/services/terminal/settingsGuardController";
import { clearWriteRegistry, recordNexusConfigWrite } from "../../src/services/terminal/settingsWriteRegistry";

// Helper: minimal fake ExtensionContext
function makeGlobalState() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, def?: T): T =>
      (store.has(key) ? store.get(key) as T : def as T),
    update: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    _store: store,
  };
}

function fakeContext(gs: ReturnType<typeof makeGlobalState>): vscode.ExtensionContext {
  return {
    globalState: gs,
    subscriptions: [],
  } as never;
}

describe("SettingsGuardController", () => {
  beforeEach(() => {
    clearWriteRegistry();
    mockConfig.effectiveValues.clear();
    mockConfig.inspectValues.clear();
    mockConfig.update.mockClear();
    (vscode.workspace.onDidChangeConfiguration as ReturnType<typeof vi.fn>).mockClear();
    capturedListener = undefined;
    mockState.windowFocused = true;
    mockState.showWarning.mockClear();
    mockState.showInformation.mockClear();
  });

  it("classifies a marked Nexus write as own-write with detail nexus-ui", async () => {
    const gs = makeGlobalState();
    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();

    // Register the write BEFORE firing the change event
    recordNexusConfigWrite("nexus.terminal.passthroughKeys", ["b"], Date.now());

    // Mocked effective value for "nexus.terminal.passthroughKeys"
    mockConfig.effectiveValues.set("nexus.terminal.passthroughKeys", ["b"]);

    // Fire the config change event
    const affectsConfig = (key: string) => key === "nexus.terminal.passthroughKeys";
    capturedListener!({ affectsConfiguration: affectsConfig });

    // Allow any microtasks to flush
    await new Promise(r => setTimeout(r, 0));

    // Assert event log persisted to globalState
    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const ownWriteEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "own-write");
    expect(ownWriteEvent).toBeDefined();
    expect(ownWriteEvent?.detail).toBe("nexus-ui");

    // No external-strip event for this key
    const stripEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "external-strip");
    expect(stripEvent).toBeUndefined();
  });

  it("classifies an unmarked shrinking array change as external-strip with focused flag", async () => {
    const gs = makeGlobalState();
    // Seed the controller's watched snapshot with a non-empty value
    mockConfig.effectiveValues.set("nexus.terminal.passthroughKeys", ["b", "e"]);
    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();

    // Now change effective value to [] (simulates external strip)
    mockConfig.effectiveValues.set("nexus.terminal.passthroughKeys", []);
    // Set known focus state
    mockState.windowFocused = false;

    const affectsConfig = (key: string) => key === "nexus.terminal.passthroughKeys";
    capturedListener!({ affectsConfiguration: affectsConfig });
    await new Promise(r => setTimeout(r, 0));

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; focused?: boolean; before?: string; key: string }>;
    const stripEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "external-strip");
    expect(stripEvent).toBeDefined();
    expect(stripEvent?.focused).toBe(false);
    expect(stripEvent?.before).toContain("b"); // was ["b","e"]
  });

  it("startup heal: logs external-strip and restore, calls config.update for corrupt passthroughKeys", async () => {
    const gs = makeGlobalState();
    // Set inspect to return corrupt value (empty array → corrupt for passthroughKeys policy)
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [] });
    // guard enabled (default — no override in effectiveValues, so get("enabled", true) returns true)

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();

    // Allow scanStartupCorruption to complete
    await new Promise(r => setTimeout(r, 0));

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;

    // Must have external-strip with detail "found-at-startup"
    const stripEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "external-strip" && e.detail === "found-at-startup");
    expect(stripEvent).toBeDefined();

    // Must have restore with detail "removed-corrupt-key"
    const restoreEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "restore" && e.detail === "removed-corrupt-key");
    expect(restoreEvent).toBeDefined();

    // config.update must have been called with (leaf=passthroughKeys, undefined, Global)
    expect(mockConfig.update).toHaveBeenCalledWith(
      "passthroughKeys",
      undefined,
      vscode.ConfigurationTarget.Global
    );
  });

  it("startup no-op: healthy passthroughKeys globalValue produces no events and no config.update call", async () => {
    const gs = makeGlobalState();
    // Non-empty array → healthy, captures shadow but does NOT write config
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<unknown> | undefined;
    expect(log ?? []).toHaveLength(0);
    // mockConfig.update is vscode.workspace.getConfiguration(...).update — should NOT be called
    // (gs.update IS called for shadow capture, but that's globalState.update, not config.update)
    expect(mockConfig.update).not.toHaveBeenCalled();
  });

  it("capture then restore-from-shadow: healthy then corrupt fires restored-from-shadow", async () => {
    const gs = makeGlobalState();
    // 1) Set healthy value BEFORE start so scanStartupCorruption captures the shadow
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b", "e"] });
    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    // Verify shadow was stored
    const shadows = gs._store.get("nexus.settingsGuard.lastKnownGoodValues") as Record<string, unknown[]> | undefined;
    expect(shadows?.["nexus.terminal.passthroughKeys"]).toEqual(["b", "e"]);

    mockConfig.update.mockClear();

    // 2) Corrupt value — {}-element replacement
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
    // Fire change event for passthroughKeys
    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await new Promise(r => setTimeout(r, 0));

    // config.update called with restored shadow value
    expect(mockConfig.update).toHaveBeenCalledWith("passthroughKeys", ["b", "e"], vscode.ConfigurationTarget.Global);

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const stripEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "external-strip" && e.detail === "corrupt-value");
    expect(stripEvent).toBeDefined();
    const restoreEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "restore" && e.detail === "restored-from-shadow");
    expect(restoreEvent).toBeDefined();
  });

  it("no shadow → removes corrupt key", async () => {
    const gs = makeGlobalState();
    // No shadow in globalState, corrupt value
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    expect(mockConfig.update).toHaveBeenCalledWith("passthroughKeys", undefined, vscode.ConfigurationTarget.Global);

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const restoreEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "restore" && e.detail === "removed-corrupt-key");
    expect(restoreEvent).toBeDefined();
  });

  it("heal cap: 4th corruption does not call update, emits paused event", async () => {
    const gs = makeGlobalState();
    // Pre-seed a shadow so heals use restore-from-shadow path
    gs._store.set("nexus.settingsGuard.lastKnownGoodValues", { "nexus.terminal.passthroughKeys": ["b"] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();

    for (let i = 0; i < 3; i++) {
      mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
      capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
      await new Promise(r => setTimeout(r, 0));
      // Reset to healthy so next iteration starts fresh
      mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });
      capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
      await new Promise(r => setTimeout(r, 0));
    }

    // 4th corruption
    mockConfig.update.mockClear();
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await new Promise(r => setTimeout(r, 0));

    expect(mockConfig.update).not.toHaveBeenCalled();

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const pausedEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "paused" && e.detail === "value-heal-cap");
    expect(pausedEvent).toBeDefined();
  });

  it("mixed array captured filtered: healthy with invalid entries captures only valid subset", async () => {
    const gs = makeGlobalState();
    // Mixed array: strings + objects
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b", {}, "e"] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    // Shadow should contain only the valid (string) entries
    const shadows = gs._store.get("nexus.settingsGuard.lastKnownGoodValues") as Record<string, unknown[]> | undefined;
    expect(shadows?.["nexus.terminal.passthroughKeys"]).toEqual(["b", "e"]);

    // No heal should have occurred (healthy with valid entries)
    expect(mockConfig.update).not.toHaveBeenCalled();
  });

  it("rules empty array: highlighting.rules with [] captures shadow, no heal", async () => {
    const gs = makeGlobalState();
    // Empty array is valid for highlighting.rules (emptyArrayIsValid=true)
    mockConfig.inspectValues.set("nexus.terminal.highlighting.rules", { globalValue: [] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    // Shadow should capture empty array
    const shadows = gs._store.get("nexus.settingsGuard.lastKnownGoodValues") as Record<string, unknown[]> | undefined;
    expect(shadows?.["nexus.terminal.highlighting.rules"]).toEqual([]);

    // No heal write
    expect(mockConfig.update).not.toHaveBeenCalled();

    // No external-strip event
    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }> | undefined;
    const stripEvent = log?.find(e => e.key === "nexus.terminal.highlighting.rules" && e.kind === "external-strip");
    expect(stripEvent).toBeUndefined();
  });

  it("classifies structurally equal but distinct highlighting.rules objects as own-write", async () => {
    const gs = makeGlobalState();
    const rules = [{ pattern: "x", color: "red" }];

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();

    // Record BEFORE firing
    recordNexusConfigWrite("nexus.terminal.highlighting.rules", rules, Date.now());

    // Structurally equal but distinct object (different reference)
    const rulesClone = JSON.parse(JSON.stringify(rules)) as typeof rules;
    mockConfig.effectiveValues.set("nexus.terminal.highlighting.rules", rulesClone);

    const affectsConfig = (key: string) => key === "nexus.terminal.highlighting.rules";
    capturedListener!({ affectsConfiguration: affectsConfig });
    await new Promise(r => setTimeout(r, 0));

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }>;
    const ownWrite = log?.find(e => e.key === "nexus.terminal.highlighting.rules" && e.kind === "own-write");
    expect(ownWrite).toBeDefined();

    const stripEvent = log?.find(e => e.key === "nexus.terminal.highlighting.rules" && e.kind === "external-strip");
    expect(stripEvent).toBeUndefined();

    const otherEvent = log?.find(e => e.key === "nexus.terminal.highlighting.rules" && e.kind === "external-other");
    expect(otherEvent).toBeUndefined();
  });

  it("multi-key capture race: both healable keys captured when globalState.update is async", async () => {
    // This test verifies the in-memory mirror prevents the stale read-modify-write
    // race where concurrent captures for sibling keys (passthroughKeys + highlighting.rules)
    // would overwrite each other when globalState.update commits asynchronously.
    const store = new Map<string, unknown>();
    const asyncGlobalState = {
      get: <T>(key: string, def?: T): T =>
        (store.has(key) ? store.get(key) as T : def as T),
      update: vi.fn((key: string, value: unknown) => new Promise<void>(r => setTimeout(() => { store.set(key, value); r(); }, 0))),
      _store: store,
    };
    // Both healable keys healthy
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });
    mockConfig.inspectValues.set("nexus.terminal.highlighting.rules", { globalValue: [{ pattern: "x", color: "red" }] });

    const controller = new SettingsGuardController(fakeContext(asyncGlobalState as never), []);
    controller.start();

    // Fire a change event affecting both healable keys simultaneously
    capturedListener!({
      affectsConfiguration: (key: string) =>
        key === "nexus.terminal.passthroughKeys" || key === "nexus.terminal.highlighting.rules",
    });

    // Flush all microtasks and timers
    await new Promise(r => setTimeout(r, 10));

    // Both keys must be present in the persisted shadow
    const shadows = store.get("nexus.settingsGuard.lastKnownGoodValues") as Record<string, unknown[]> | undefined;
    expect(shadows?.["nexus.terminal.passthroughKeys"]).toEqual(["b"]);
    expect(shadows?.["nexus.terminal.highlighting.rules"]).toEqual([{ pattern: "x", color: "red" }]);
  });

  it("no double logging: live corruption of passthroughKeys produces exactly one external-strip event", async () => {
    const gs = makeGlobalState();
    // Pre-seed shadow so the heal path logs restore
    gs._store.set("nexus.settingsGuard.lastKnownGoodValues", { "nexus.terminal.passthroughKeys": ["b"] });
    // Effective (for snapshot) is healthy at start
    mockConfig.effectiveValues.set("nexus.terminal.passthroughKeys", ["b"]);
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    const startupLog = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }> | undefined;
    // Startup: healthy, no events
    expect((startupLog ?? []).filter(e => e.key === "nexus.terminal.passthroughKeys")).toHaveLength(0);

    mockConfig.update.mockClear();

    // Now corrupt it via change event
    mockConfig.effectiveValues.set("nexus.terminal.passthroughKeys", [{}, {}]);
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
    mockState.windowFocused = true;

    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await new Promise(r => setTimeout(r, 0));

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string; focused?: boolean }>;
    const stripEvents = log.filter(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "external-strip");
    expect(stripEvents).toHaveLength(1);
    expect(stripEvents[0].focused).toBe(true);

    const restoreEvents = log.filter(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "restore");
    expect(restoreEvents).toHaveLength(1);
  });

  it("failed heal write: counts toward cap, wildcard reclaimed so next external is not masked", async () => {
    const gs = makeGlobalState();
    gs._store.set("nexus.settingsGuard.lastKnownGoodValues", { "nexus.terminal.passthroughKeys": ["b"] });

    // Make config.update always throw
    mockConfig.update.mockRejectedValue(new Error("locked"));

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    mockConfig.update.mockClear();

    // Drive 4 corrupt change events — should get 3 restore-failed then paused
    for (let i = 0; i < 4; i++) {
      mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
      capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
      await new Promise(r => setTimeout(r, 0));
      // Restore to healthy between events to allow re-detection
      mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });
      capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
      await new Promise(r => setTimeout(r, 0));
    }

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const failedEvents = log.filter(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "restore-failed");
    expect(failedEvents.length).toBeLessThanOrEqual(3);

    const pausedEvent = log.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "paused" && e.detail === "value-heal-cap");
    expect(pausedEvent).toBeDefined();

    // After the cap: a genuine external change event should NOT be classified as own-write
    // (the wildcard registry entries were reclaimed by the failed heals)
    mockConfig.update.mockResolvedValue(undefined); // restore normal behavior
    mockConfig.effectiveValues.set("nexus.terminal.passthroughKeys", []);
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [] });

    const logLengthBefore = log.length;
    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await new Promise(r => setTimeout(r, 0));

    const logAfter = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }>;
    const newEvents = logAfter.slice(logLengthBefore);
    const ownWriteAfterCap = newEvents.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "own-write");
    expect(ownWriteAfterCap).toBeUndefined();
  });

  it("resume clears value-heal cap so healing works again", async () => {
    const gs = makeGlobalState();
    gs._store.set("nexus.settingsGuard.lastKnownGoodValues", { "nexus.terminal.passthroughKeys": ["b"] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    // Set showWarning to resolve "Resume Guard" so resume() is called when toast fires
    mockState.showWarning.mockResolvedValue("Resume Guard");

    // Exhaust the value heal cap (3 heals) + trigger 4th to hit cap + toast
    for (let i = 0; i < 3; i++) {
      mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
      capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
      await new Promise(r => setTimeout(r, 0));
      mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });
      capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
      await new Promise(r => setTimeout(r, 0));
    }

    // 4th corrupt → cap → toast fires → mockResolvedValue("Resume Guard") → resume() called
    mockConfig.update.mockClear();
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await new Promise(r => setTimeout(r, 10)); // time for the toast promise to resolve and resume() to run

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const pausedEvent = log.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "paused");
    expect(pausedEvent).toBeDefined();
    const resumedEvent = log.find(e => e.kind === "resumed");
    expect(resumedEvent).toBeDefined();

    // After resume, heal works again — trigger another corrupt event
    mockConfig.update.mockClear();
    // valueShadows in-memory still has ["b"] from the healthy captures in the loop
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await new Promise(r => setTimeout(r, 0));

    // Heal should fire again (cap was cleared by resume)
    expect(mockConfig.update).toHaveBeenCalled();
  });
});
