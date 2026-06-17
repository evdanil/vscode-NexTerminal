import { beforeEach, describe, expect, it, vi } from "vitest";

// State defined BEFORE vi.mock so the factory can close over it (Vitest hoists vi.mock).
const mockState = {
  windowFocused: true,
  showWarning: vi.fn(async () => undefined as unknown),
  showInformation: vi.fn(async () => undefined as unknown),
};

const mockConfig = {
  effectiveValues: new Map<string, unknown>(),
  inspectValues: new Map<string, { globalValue?: unknown; defaultValue?: unknown }>(),
  update: vi.fn(async () => {}),
};

const mockFs = { files: new Map<string, Uint8Array>() };

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
    fs: {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const b = mockFs.files.get(uri.fsPath);
        if (!b) throw new Error("ENOENT");
        return b;
      }),
      writeFile: vi.fn(async (uri: { fsPath: string }, data: Uint8Array) => {
        mockFs.files.set(uri.fsPath, data);
      }),
    },
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
  Uri: {
    file: (p: string) => ({ fsPath: p, path: p }),
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
    globalStorageUri: { fsPath: "/userdata/User/globalStorage/sentriflow.vscode-nexterminal" } as never,
  } as never;
}

describe("SettingsGuardController", () => {
  beforeEach(() => {
    clearWriteRegistry();
    mockConfig.effectiveValues.clear();
    mockConfig.inspectValues.clear();
    mockConfig.update.mockClear();
    (vscode.workspace.onDidChangeConfiguration as ReturnType<typeof vi.fn>).mockClear();
    (vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>).mockClear();
    (vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>).mockClear();
    mockFs.files.clear();
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
    const controller = new SettingsGuardController(fakeContext(asyncGlobalState as never), []);
    controller.start();
    // Let the startup scan finish while both keys are still ABSENT — captures
    // must happen via the single change event below, concurrently. Seeding
    // before start() would let the startup scan's serialized captures paper
    // over the lost-update race this test exists to pin.
    await new Promise(r => setTimeout(r, 10));

    // Both healable keys become healthy at once
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });
    mockConfig.inspectValues.set("nexus.terminal.highlighting.rules", { globalValue: [{ pattern: "x", color: "red" }] });

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

  it("shadow-free recovery: no shadow + mangled global + hasMacros=true => writes fallback+required", async () => {
    const gs = makeGlobalState();
    // No shadow. Global value is corrupt ({},{} = mangled). VS Code default is known.
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => true);
    controller.start();

    // Allow checkSkipShell (via enqueueCheck on start) to complete
    await new Promise(r => setTimeout(r, 0));

    // config.update must write the fallback default + required commands
    expect(mockConfig.update).toHaveBeenCalledWith(
      "commandsToSkipShell",
      ["workbench.action.quickOpen", "nexus.macro.run", "nexus.macro.runBinding"],
      vscode.ConfigurationTarget.Global
    );

    // A restore event must be logged
    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; scope?: string; key: string }>;
    const restoreEvent = log?.find(e => e.key === "terminal.integrated.commandsToSkipShell" && e.kind === "restore");
    expect(restoreEvent).toBeDefined();
  });

  it("shadow-free recovery: no shadow + mangled global + hasMacros=false => guard inert, no config.update", async () => {
    const gs = makeGlobalState();
    // Same mangled state as above but no macros.
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => false);
    controller.start();

    await new Promise(r => setTimeout(r, 0));

    // No config.update for commandsToSkipShell — guard is inert without macros
    const skipShellCalls = mockConfig.update.mock.calls.filter(
      (args) => args[0] === "commandsToSkipShell"
    );
    expect(skipShellCalls).toHaveLength(0);

    // No restore event logged
    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }> | undefined;
    const restoreEvent = (log ?? []).find(e => e.key === "terminal.integrated.commandsToSkipShell" && e.kind === "restore");
    expect(restoreEvent).toBeUndefined();
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

  // ---------------------------------------------------------------------------
  // BOM-stripping tests
  // ---------------------------------------------------------------------------

  it("skip-shell heal strips BOM before persisting", async () => {
    const gs = makeGlobalState();
    // Corrupt skip-shell: no shadow, but fallback default gives recovery material
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    // Seed settings.json with BOM prefix — content must match inspect globalValue for profile-safety check
    const fileContent = '{"terminal.integrated.commandsToSkipShell":[{},{}]}';
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fileContent, "utf8")])
    );

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => true);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    // writeFile must have been called for the settings.json path with no BOM
    const writeCalls = (vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>).mock.calls as [{ fsPath: string }, Uint8Array][];
    const bomWriteCall = writeCalls.find(([uri]) => uri.fsPath === "/userdata/User/settings.json");
    expect(bomWriteCall).toBeDefined();
    // First byte of the written data must not be 0xef (BOM removed)
    expect(bomWriteCall![1][0]).toBe(0x7b);
    // Full content check: written bytes should equal the file content without BOM
    expect(Buffer.from(bomWriteCall![1]).toString("utf8")).toBe(fileContent);

    // config.update must have been called for commandsToSkipShell
    expect(mockConfig.update).toHaveBeenCalledWith(
      "commandsToSkipShell",
      expect.arrayContaining(["nexus.macro.run", "nexus.macro.runBinding"]),
      vscode.ConfigurationTarget.Global
    );

    // Event log must contain a bom-stripped event
    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }>;
    const bomEvent = log?.find(e => e.kind === "bom-stripped" && e.key === "settings.json");
    expect(bomEvent).toBeDefined();
  });

  it("no BOM → no fs write, heal still calls config.update for commandsToSkipShell", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    // Seed settings.json WITHOUT a BOM
    mockFs.files.set("/userdata/User/settings.json", new Uint8Array([0x7b, 0x7d]));

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => true);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    // writeFile must NOT have been called (no BOM to strip)
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();

    // config.update still called to restore commandsToSkipShell
    expect(mockConfig.update).toHaveBeenCalledWith(
      "commandsToSkipShell",
      expect.arrayContaining(["nexus.macro.run", "nexus.macro.runBinding"]),
      vscode.ConfigurationTarget.Global
    );
  });

  it("value heal (passthroughKeys) strips BOM before persisting", async () => {
    const gs = makeGlobalState();
    // Seed shadow so heal can restore from it
    gs._store.set("nexus.settingsGuard.lastKnownGoodValues", { "nexus.terminal.passthroughKeys": ["b"] });
    // Corrupt passthroughKeys via inspect
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
    // Seed settings.json with BOM — content must match inspect globalValue for profile-safety check
    const fileContent = '{"nexus.terminal.passthroughKeys":[{},{}]}';
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fileContent, "utf8")])
    );

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    // writeFile called with stripped bytes
    const writeCalls = (vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>).mock.calls as [{ fsPath: string }, Uint8Array][];
    const bomWriteCall = writeCalls.find(([uri]) => uri.fsPath === "/userdata/User/settings.json");
    expect(bomWriteCall).toBeDefined();
    expect(bomWriteCall![1][0]).toBe(0x7b);
    // Full content check: written bytes should equal the file content without BOM
    expect(Buffer.from(bomWriteCall![1]).toString("utf8")).toBe(fileContent);

    // config.update called for passthroughKeys
    expect(mockConfig.update).toHaveBeenCalledWith(
      "passthroughKeys",
      ["b"],
      vscode.ConfigurationTarget.Global
    );

    // bom-stripped event in log
    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }>;
    const bomEvent = log?.find(e => e.kind === "bom-stripped" && e.key === "settings.json");
    expect(bomEvent).toBeDefined();
  });

  it("settings.json unreadable → no crash, heal still attempts config.update, no bom events", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    // Do NOT seed any file in mockFs — readFile will throw ENOENT

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => true);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    // Must not throw; config.update still called for skip-shell restore
    expect(mockConfig.update).toHaveBeenCalledWith(
      "commandsToSkipShell",
      expect.arrayContaining(["nexus.macro.run", "nexus.macro.runBinding"]),
      vscode.ConfigurationTarget.Global
    );

    // No bom-stripped or bom-strip-failed events
    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string }> | undefined;
    const bomEvents = (log ?? []).filter(e => e.kind === "bom-stripped" || e.kind === "bom-strip-failed");
    expect(bomEvents).toHaveLength(0);
  });

  it("guard disabled → no BOM strip and no config.update for commandsToSkipShell", async () => {
    const gs = makeGlobalState();
    mockConfig.effectiveValues.set("nexus.settingsGuard.enabled", false);
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    // Seed settings.json with BOM — matching-content so the profile-safety check would pass if reached
    const fileContent = '{"terminal.integrated.commandsToSkipShell":[{},{}]}';
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fileContent, "utf8")])
    );

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => true);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    // writeFile must NOT be called — guard is disabled
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();

    // config.update must NOT be called for commandsToSkipShell — guard is disabled
    const skipShellCalls = mockConfig.update.mock.calls.filter(
      (args) => args[0] === "commandsToSkipShell"
    );
    expect(skipShellCalls).toHaveLength(0);
  });

  it("profile mismatch → declines to write, bom-strip-skipped event logged", async () => {
    const gs = makeGlobalState();
    // Corrupt skip-shell: inspect globalValue is [{},{}], fallback gives recovery material
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    // macros present
    mockConfig.effectiveValues.set("nexus.settingsGuard.enabled", true);
    // Seed a BOM file whose value for commandsToSkipShell DIFFERS from inspect globalValue
    // This simulates a named-profile scenario where globalStorageUri points to the default profile's file
    const fileContent = '{"terminal.integrated.commandsToSkipShell":["something.else"]}';
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fileContent, "utf8")])
    );

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => true);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    // writeFile must NOT have been called — profile mismatch detected
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();

    // bom-strip-skipped event must be logged
    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const skippedEvent = log?.find(e => e.kind === "bom-strip-skipped" && e.key === "settings.json");
    expect(skippedEvent).toBeDefined();
    expect(skippedEvent?.detail).toContain("profile-mismatch");

    // config.update for commandsToSkipShell is still called (in-memory heal is unaffected)
    expect(mockConfig.update).toHaveBeenCalledWith(
      "commandsToSkipShell",
      expect.arrayContaining(["nexus.macro.run", "nexus.macro.runBinding"]),
      vscode.ConfigurationTarget.Global
    );
  });

  it("write failure logged as bom-strip-failed, no throw escapes", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    // Matching-content BOM file so the profile-safety check passes
    const fileContent = '{"terminal.integrated.commandsToSkipShell":[{},{}]}';
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fileContent, "utf8")])
    );
    // Make writeFile fail once (for the BOM strip attempt)
    (vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("EACCES"));

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => true);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    // bom-strip-failed event must be logged
    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const failedEvent = log?.find(e => e.kind === "bom-strip-failed" && e.key === "settings.json");
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.detail).toContain("EACCES");

    // config.update still called (BOM strip failure doesn't block heal)
    expect(mockConfig.update).toHaveBeenCalledWith(
      "commandsToSkipShell",
      expect.arrayContaining(["nexus.macro.run", "nexus.macro.runBinding"]),
      vscode.ConfigurationTarget.Global
    );
  });

  it("BOM file that is not parseable (trailing comma) → declines to write, no bom event", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    // BOM file whose content is NOT strict JSON (trailing comma) — JSON.parse fails,
    // so the profile-safety check cannot confirm this is the active file and declines.
    const fileContent = '{"terminal.integrated.commandsToSkipShell":[{},{}],}';
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fileContent, "utf8")])
    );

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => true);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    // No write, and no bom event of any kind (silent decline on unparseable content)
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    const log = (gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string }>) ?? [];
    expect(log.some(e => e.kind === "bom-stripped" || e.kind === "bom-strip-skipped" || e.kind === "bom-strip-failed")).toBe(false);

    // In-memory heal unaffected
    expect(mockConfig.update).toHaveBeenCalledWith(
      "commandsToSkipShell",
      expect.arrayContaining(["nexus.macro.run", "nexus.macro.runBinding"]),
      vscode.ConfigurationTarget.Global
    );
  });
});
