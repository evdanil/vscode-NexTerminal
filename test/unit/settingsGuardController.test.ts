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

// Helper to wait for all pending promises/microtasks
async function flush(ms = 0): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

describe("SettingsGuardController", () => {
  beforeEach(() => {
    clearWriteRegistry();
    mockConfig.effectiveValues.clear();
    mockConfig.inspectValues.clear();
    mockConfig.update.mockReset().mockResolvedValue(undefined);
    (vscode.workspace.onDidChangeConfiguration as ReturnType<typeof vi.fn>).mockClear();
    (vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>).mockClear();
    (vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>).mockClear();
    mockFs.files.clear();
    capturedListener = undefined;
    mockState.windowFocused = true;
    mockState.showWarning.mockClear();
    mockState.showInformation.mockClear();
  });

  // ---------------------------------------------------------------------------
  // C1: Startup with corrupt skip-shell + corrupt passthroughKeys + BOM file
  // ---------------------------------------------------------------------------
  it("C1: startup corrupt skip-shell+passthroughKeys+BOM: one file write, both config.updates, file-repaired event", async () => {
    const gs = makeGlobalState();

    const macroCommands = ["nexus.macro.run", "nexus.macro.runBinding"];

    // Corrupt skip-shell
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    // Corrupt passthroughKeys (no shadow → will delete)
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [] });

    // BOM file with BOTH corrupt key values so profile-safety check passes
    const fileContent = JSON.stringify({
      "terminal.integrated.commandsToSkipShell": [{}, {}],
      "nexus.terminal.passthroughKeys": [],
    });
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fileContent, "utf8")])
    );

    const controller = new SettingsGuardController(fakeContext(gs), macroCommands, () => true);
    controller.start();
    await flush();

    // config.update called for both keys
    const updateCalls = mockConfig.update.mock.calls as [string, unknown, number][];
    expect(updateCalls.some(([leaf]) => leaf === "commandsToSkipShell")).toBe(true);
    expect(updateCalls.some(([leaf]) => leaf === "passthroughKeys")).toBe(true);

    // ONE file write
    const writeCalls = (vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>).mock.calls as [{ fsPath: string }, Uint8Array][];
    const settingsWrites = writeCalls.filter(([uri]) => uri.fsPath === "/userdata/User/settings.json");
    expect(settingsWrites).toHaveLength(1);

    // Written file has no BOM
    expect(settingsWrites[0][1][0]).toBe(0x7b);

    // Written file has commandsToSkipShell with macro commands
    const writtenText = Buffer.from(settingsWrites[0][1]).toString("utf8");
    const written = JSON.parse(writtenText) as Record<string, unknown>;
    expect(Array.isArray(written["terminal.integrated.commandsToSkipShell"])).toBe(true);
    expect((written["terminal.integrated.commandsToSkipShell"] as string[]).some(c => macroCommands.includes(c))).toBe(true);

    // passthroughKeys removed (no shadow → delete)
    expect(Object.prototype.hasOwnProperty.call(written, "nexus.terminal.passthroughKeys")).toBe(false);

    // file-repaired event in log
    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }>;
    const repairedEvent = log?.find(e => e.kind === "file-repaired" && e.key === "settings.json");
    expect(repairedEvent).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // C2: resume() re-heals ALL keys (the bug being fixed)
  // ---------------------------------------------------------------------------
  it("C2: resume() re-heals corrupt passthroughKeys after pause", async () => {
    const gs = makeGlobalState();
    // Pre-seed shadow for passthroughKeys
    gs._store.set("nexus.settingsGuard.lastKnownGoodValues", { "nexus.terminal.passthroughKeys": ["b"] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await flush();

    // Make showWarning resolve "Resume Guard" immediately
    mockState.showWarning.mockResolvedValue("Resume Guard");

    // Trigger a pause via session-cap (trigger SESSION_RESTORE_CAP restores)
    // Simpler: just call pause directly via the rate-limit burst path
    // Drive 3 restores fast to hit burst cap (BURST_CAP=3, BURST_WINDOW_MS=10min)
    for (let i = 0; i < 3; i++) {
      mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
      capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
      await flush();
      // healthy between
      mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });
      capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
      await flush();
    }

    // 4th corrupt → triggers pause → toast → Resume Guard → resume() → recoverAll("resume")
    mockConfig.update.mockClear();
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await flush(10); // allow toast promise and resume to run

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }>;
    const resumedEvent = log?.find(e => e.kind === "resumed");
    expect(resumedEvent).toBeDefined();

    // After resume, passthroughKeys should be healed
    // At resume time, passthroughKeys is still corrupt (globalValue [{},{}])
    expect(mockConfig.update).toHaveBeenCalledWith(
      "passthroughKeys",
      ["b"], // restored from shadow
      vscode.ConfigurationTarget.Global
    );
  });

  // ---------------------------------------------------------------------------
  // C3: Any single corrupt key triggers recovery of all corrupt keys
  // ---------------------------------------------------------------------------
  it("C3: change-event on skip-shell also repairs concurrently-corrupt passthroughKeys", async () => {
    const gs = makeGlobalState();
    const macroCommands = ["nexus.macro.run"];

    // Both corrupt at once
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    gs._store.set("nexus.settingsGuard.lastKnownGoodValues", { "nexus.terminal.passthroughKeys": ["b"] });
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });

    const controller = new SettingsGuardController(fakeContext(gs), macroCommands, () => true);
    controller.start();
    await flush();

    // Both config.update calls must have happened
    const updateCalls = mockConfig.update.mock.calls as [string, unknown, number][];
    expect(updateCalls.some(([leaf]) => leaf === "commandsToSkipShell")).toBe(true);
    expect(updateCalls.some(([leaf]) => leaf === "passthroughKeys")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // C4: Profile mismatch → no file write; config.update still attempted
  // ---------------------------------------------------------------------------
  it("C4: profile mismatch → no file write; file-repair-failed logged; config.update still called", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    // File has DIFFERENT value → profile mismatch
    const fileContent = '{"terminal.integrated.commandsToSkipShell":["something.else"]}';
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fileContent, "utf8")])
    );

    const controller = new SettingsGuardController(fakeContext(gs), ["nexus.macro.run"], () => true);
    controller.start();
    await flush();

    // No file write
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();

    // file-repair-failed event with profile-mismatch
    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const failedEvent = log?.find(e => e.kind === "file-repair-failed" && e.key === "settings.json");
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.detail).toContain("profile-mismatch");

    // In-memory heal still happened
    expect(mockConfig.update).toHaveBeenCalledWith(
      "commandsToSkipShell",
      expect.arrayContaining(["nexus.macro.run"]),
      vscode.ConfigurationTarget.Global
    );
  });

  // ---------------------------------------------------------------------------
  // C5: File parse failure → no file write, no crash; in-memory config.update still runs
  // ---------------------------------------------------------------------------
  it("C5: unparseable file (trailing comma) → no file write, no crash; config.update still called", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    const fileContent = '{"terminal.integrated.commandsToSkipShell":[{},{}],}';
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fileContent, "utf8")])
    );

    const controller = new SettingsGuardController(fakeContext(gs), ["nexus.macro.run"], () => true);
    controller.start();
    await flush();

    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(mockConfig.update).toHaveBeenCalledWith(
      "commandsToSkipShell",
      expect.arrayContaining(["nexus.macro.run"]),
      vscode.ConfigurationTarget.Global
    );
  });

  // ---------------------------------------------------------------------------
  // C6: Guard disabled → no config.update, no file write
  // ---------------------------------------------------------------------------
  it("C6: guard disabled → no config.update and no file write", async () => {
    const gs = makeGlobalState();
    mockConfig.effectiveValues.set("nexus.settingsGuard.enabled", false);
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [] });
    const fileContent = '{"terminal.integrated.commandsToSkipShell":[{},{}],"nexus.terminal.passthroughKeys":[]}';
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fileContent, "utf8")])
    );

    const controller = new SettingsGuardController(fakeContext(gs), ["nexus.macro.run"], () => true);
    controller.start();
    await flush();

    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    const skipShellCalls = mockConfig.update.mock.calls.filter(([l]) => l === "commandsToSkipShell");
    expect(skipShellCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // C7: No corruption → no writes, shadows captured
  // ---------------------------------------------------------------------------
  it("C7: no corruption → no config.update, no file write, shadow captured for healthy values", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b", "e"] });
    mockConfig.inspectValues.set("nexus.terminal.highlighting.rules", { globalValue: [{ pattern: "x", color: "red" }] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await flush();

    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(mockConfig.update).not.toHaveBeenCalled();

    // Shadows captured
    const shadows = gs._store.get("nexus.settingsGuard.lastKnownGoodValues") as Record<string, unknown[]>;
    expect(shadows?.["nexus.terminal.passthroughKeys"]).toEqual(["b", "e"]);
    expect(shadows?.["nexus.terminal.highlighting.rules"]).toEqual([{ pattern: "x", color: "red" }]);
  });

  // ---------------------------------------------------------------------------
  // Regression: own-write classification
  // ---------------------------------------------------------------------------
  it("classifies a marked Nexus write as own-write with detail nexus-ui", async () => {
    const gs = makeGlobalState();
    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();

    recordNexusConfigWrite("nexus.terminal.passthroughKeys", ["b"], Date.now());
    mockConfig.effectiveValues.set("nexus.terminal.passthroughKeys", ["b"]);

    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await flush();

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const ownWriteEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "own-write");
    expect(ownWriteEvent).toBeDefined();
    expect(ownWriteEvent?.detail).toBe("nexus-ui");

    const stripEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "external-strip");
    expect(stripEvent).toBeUndefined();
  });

  it("classifies an unmarked shrinking array change as external-strip with focused flag", async () => {
    const gs = makeGlobalState();
    mockConfig.effectiveValues.set("nexus.terminal.passthroughKeys", ["b", "e"]);
    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();

    mockConfig.effectiveValues.set("nexus.terminal.passthroughKeys", []);
    mockState.windowFocused = false;

    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await flush();

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; focused?: boolean; before?: string; key: string }>;
    const stripEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "external-strip");
    expect(stripEvent).toBeDefined();
    expect(stripEvent?.focused).toBe(false);
    expect(stripEvent?.before).toContain("b");
  });

  it("startup heal: logs external-strip and restore, calls config.update for corrupt passthroughKeys", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await flush();

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;

    const stripEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "external-strip" && e.detail === "found-at-startup");
    expect(stripEvent).toBeDefined();

    const restoreEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "restore" && e.detail === "removed-corrupt-key");
    expect(restoreEvent).toBeDefined();

    expect(mockConfig.update).toHaveBeenCalledWith(
      "passthroughKeys",
      undefined,
      vscode.ConfigurationTarget.Global
    );
  });

  it("startup no-op: healthy passthroughKeys globalValue produces no events and no config.update call", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await flush();

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<unknown> | undefined;
    expect(log ?? []).toHaveLength(0);
    expect(mockConfig.update).not.toHaveBeenCalled();
  });

  it("capture then restore-from-shadow: healthy then corrupt fires restored-from-shadow", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b", "e"] });
    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await flush();

    const shadows = gs._store.get("nexus.settingsGuard.lastKnownGoodValues") as Record<string, unknown[]> | undefined;
    expect(shadows?.["nexus.terminal.passthroughKeys"]).toEqual(["b", "e"]);

    mockConfig.update.mockClear();

    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await flush();

    expect(mockConfig.update).toHaveBeenCalledWith("passthroughKeys", ["b", "e"], vscode.ConfigurationTarget.Global);

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const stripEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "external-strip" && e.detail === "corrupt-value");
    expect(stripEvent).toBeDefined();
    const restoreEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "restore" && e.detail === "restored-from-shadow");
    expect(restoreEvent).toBeDefined();
  });

  it("no shadow → removes corrupt key", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await flush();

    expect(mockConfig.update).toHaveBeenCalledWith("passthroughKeys", undefined, vscode.ConfigurationTarget.Global);

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const restoreEvent = log?.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "restore" && e.detail === "removed-corrupt-key");
    expect(restoreEvent).toBeDefined();
  });

  it("mixed array captured filtered: healthy with invalid entries captures only valid subset", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b", {}, "e"] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await flush();

    const shadows = gs._store.get("nexus.settingsGuard.lastKnownGoodValues") as Record<string, unknown[]> | undefined;
    expect(shadows?.["nexus.terminal.passthroughKeys"]).toEqual(["b", "e"]);
    expect(mockConfig.update).not.toHaveBeenCalled();
  });

  it("rules empty array: highlighting.rules with [] captures shadow, no heal", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("nexus.terminal.highlighting.rules", { globalValue: [] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await flush();

    const shadows = gs._store.get("nexus.settingsGuard.lastKnownGoodValues") as Record<string, unknown[]> | undefined;
    expect(shadows?.["nexus.terminal.highlighting.rules"]).toEqual([]);
    expect(mockConfig.update).not.toHaveBeenCalled();

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }> | undefined;
    const stripEvent = log?.find(e => e.key === "nexus.terminal.highlighting.rules" && e.kind === "external-strip");
    expect(stripEvent).toBeUndefined();
  });

  it("classifies structurally equal but distinct highlighting.rules objects as own-write", async () => {
    const gs = makeGlobalState();
    const rules = [{ pattern: "x", color: "red" }];

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();

    recordNexusConfigWrite("nexus.terminal.highlighting.rules", rules, Date.now());
    const rulesClone = JSON.parse(JSON.stringify(rules)) as typeof rules;
    mockConfig.effectiveValues.set("nexus.terminal.highlighting.rules", rulesClone);

    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.highlighting.rules" });
    await flush();

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }>;
    const ownWrite = log?.find(e => e.key === "nexus.terminal.highlighting.rules" && e.kind === "own-write");
    expect(ownWrite).toBeDefined();

    const stripEvent = log?.find(e => e.key === "nexus.terminal.highlighting.rules" && e.kind === "external-strip");
    expect(stripEvent).toBeUndefined();

    const otherEvent = log?.find(e => e.key === "nexus.terminal.highlighting.rules" && e.kind === "external-other");
    expect(otherEvent).toBeUndefined();
  });

  it("multi-key capture race: both healable keys captured when globalState.update is async", async () => {
    const store = new Map<string, unknown>();
    const asyncGlobalState = {
      get: <T>(key: string, def?: T): T =>
        (store.has(key) ? store.get(key) as T : def as T),
      update: vi.fn((key: string, value: unknown) => new Promise<void>(r => setTimeout(() => { store.set(key, value); r(); }, 0))),
      _store: store,
    };
    const controller = new SettingsGuardController(fakeContext(asyncGlobalState as never), []);
    controller.start();
    await flush(10);

    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });
    mockConfig.inspectValues.set("nexus.terminal.highlighting.rules", { globalValue: [{ pattern: "x", color: "red" }] });

    capturedListener!({
      affectsConfiguration: (key: string) =>
        key === "nexus.terminal.passthroughKeys" || key === "nexus.terminal.highlighting.rules",
    });

    await flush(10);

    const shadows = store.get("nexus.settingsGuard.lastKnownGoodValues") as Record<string, unknown[]> | undefined;
    expect(shadows?.["nexus.terminal.passthroughKeys"]).toEqual(["b"]);
    expect(shadows?.["nexus.terminal.highlighting.rules"]).toEqual([{ pattern: "x", color: "red" }]);
  });

  it("no double logging: live corruption of passthroughKeys produces exactly one external-strip event", async () => {
    const gs = makeGlobalState();
    gs._store.set("nexus.settingsGuard.lastKnownGoodValues", { "nexus.terminal.passthroughKeys": ["b"] });
    mockConfig.effectiveValues.set("nexus.terminal.passthroughKeys", ["b"]);
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await flush();

    const startupLog = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }> | undefined;
    expect((startupLog ?? []).filter(e => e.key === "nexus.terminal.passthroughKeys")).toHaveLength(0);

    mockConfig.update.mockClear();

    mockConfig.effectiveValues.set("nexus.terminal.passthroughKeys", [{}, {}]);
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
    mockState.windowFocused = true;

    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await flush();

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string; focused?: boolean }>;
    const stripEvents = log.filter(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "external-strip");
    expect(stripEvents).toHaveLength(1);
    expect(stripEvents[0].focused).toBe(true);

    const restoreEvents = log.filter(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "restore");
    expect(restoreEvents).toHaveLength(1);
  });

  it("failed heal write: reclaimed so next external is not masked", async () => {
    const gs = makeGlobalState();
    gs._store.set("nexus.settingsGuard.lastKnownGoodValues", { "nexus.terminal.passthroughKeys": ["b"] });
    mockConfig.update.mockRejectedValue(new Error("locked"));

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await flush();

    mockConfig.update.mockClear();

    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await flush();

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const failedEvents = log.filter(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "restore-failed");
    expect(failedEvents.length).toBeGreaterThan(0);

    // After failed write: a genuine external change should NOT be classified as own-write
    mockConfig.update.mockResolvedValue(undefined);
    mockConfig.effectiveValues.set("nexus.terminal.passthroughKeys", []);
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [] });

    const logLengthBefore = log.length;
    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await flush();

    const logAfter = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }>;
    const newEvents = logAfter.slice(logLengthBefore);
    const ownWriteAfter = newEvents.find(e => e.key === "nexus.terminal.passthroughKeys" && e.kind === "own-write");
    expect(ownWriteAfter).toBeUndefined();
  });

  it("shadow-free recovery: no shadow + mangled global + hasMacros=true => writes fallback+required", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => true);
    controller.start();
    await flush();

    expect(mockConfig.update).toHaveBeenCalledWith(
      "commandsToSkipShell",
      ["workbench.action.quickOpen", "nexus.macro.run", "nexus.macro.runBinding"],
      vscode.ConfigurationTarget.Global
    );

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; scope?: string; key: string }>;
    const restoreEvent = log?.find(e => e.key === "terminal.integrated.commandsToSkipShell" && e.kind === "restore");
    expect(restoreEvent).toBeDefined();
  });

  it("shadow-free recovery: no shadow + mangled global + hasMacros=false => guard inert, no config.update", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => false);
    controller.start();
    await flush();

    const skipShellCalls = mockConfig.update.mock.calls.filter(
      (args) => args[0] === "commandsToSkipShell"
    );
    expect(skipShellCalls).toHaveLength(0);

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; key: string }> | undefined;
    const restoreEvent = (log ?? []).find(e => e.key === "terminal.integrated.commandsToSkipShell" && e.kind === "restore");
    expect(restoreEvent).toBeUndefined();
  });

  it("settings.json unreadable → no crash, heal still attempts config.update, no file-repair events", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    // No file seeded → readFile throws ENOENT

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => true);
    controller.start();
    await flush();

    expect(mockConfig.update).toHaveBeenCalledWith(
      "commandsToSkipShell",
      expect.arrayContaining(["nexus.macro.run", "nexus.macro.runBinding"]),
      vscode.ConfigurationTarget.Global
    );

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string }> | undefined;
    const fileRepairEvents = (log ?? []).filter(e => e.kind === "file-repaired" || e.kind === "file-repair-failed");
    expect(fileRepairEvents).toHaveLength(0);
  });

  it("guard disabled → no BOM strip and no config.update for commandsToSkipShell", async () => {
    const gs = makeGlobalState();
    mockConfig.effectiveValues.set("nexus.settingsGuard.enabled", false);
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    const fileContent = '{"terminal.integrated.commandsToSkipShell":[{},{}]}';
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fileContent, "utf8")])
    );

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => true);
    controller.start();
    await flush();

    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    const skipShellCalls = mockConfig.update.mock.calls.filter(
      (args) => args[0] === "commandsToSkipShell"
    );
    expect(skipShellCalls).toHaveLength(0);
  });

  it("write failure logged as file-repair-failed, no throw escapes, config.update still called", async () => {
    const gs = makeGlobalState();
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });
    const fileContent = '{"terminal.integrated.commandsToSkipShell":[{},{}]}';
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fileContent, "utf8")])
    );
    (vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("EACCES"));

    const requiredCommands = ["nexus.macro.run", "nexus.macro.runBinding"];
    const controller = new SettingsGuardController(fakeContext(gs), requiredCommands, () => true);
    controller.start();
    await flush();

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string; key: string }>;
    const failedEvent = log?.find(e => e.kind === "file-repair-failed" && e.key === "settings.json");
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.detail).toContain("EACCES");

    expect(mockConfig.update).toHaveBeenCalledWith(
      "commandsToSkipShell",
      expect.arrayContaining(["nexus.macro.run", "nexus.macro.runBinding"]),
      vscode.ConfigurationTarget.Global
    );
  });

  it("rate-limit pause: repeated corruptions trigger pause, then rate is re-armed on resume", async () => {
    const gs = makeGlobalState();
    gs._store.set("nexus.settingsGuard.lastKnownGoodValues", { "nexus.terminal.passthroughKeys": ["b"] });
    mockState.showWarning.mockResolvedValue("Resume Guard");

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await flush();

    // Drive 3 corrupt events to hit BURST_CAP (3 restores in BURST_WINDOW_MS)
    for (let i = 0; i < 3; i++) {
      mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
      capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
      await flush();
      mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });
      capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
      await flush();
    }

    // 4th corrupt → hits burst → paused
    mockConfig.update.mockClear();
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await flush(10);

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string }>;
    const pausedEvent = log?.find(e => e.kind === "paused");
    expect(pausedEvent).toBeDefined();
    const resumedEvent = log?.find(e => e.kind === "resumed");
    expect(resumedEvent).toBeDefined();

    // After resume, healing works again
    mockConfig.update.mockClear();
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await flush();
    expect(mockConfig.update).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // FIX 2: BOM file + config.update rejects → fs write succeeds, toast shown, rate limit counts
  // ---------------------------------------------------------------------------
  it("FIX2: BOM file + config.update rejects → fs write succeeds, toast shown, rate limit counts toward pause", async () => {
    const gs = makeGlobalState();
    gs._store.set("nexus.settingsGuard.lastKnownGoodValues", { "nexus.terminal.passthroughKeys": ["b"] });

    // Corrupt value
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });

    // File matches corrupt value → profile-safety passes
    const fileContent = JSON.stringify({ "nexus.terminal.passthroughKeys": [{}, {}] });
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fileContent, "utf8")])
    );

    // config.update always rejects
    mockConfig.update.mockRejectedValue(new Error("locked by DLP"));

    // showWarning resolves undefined (user dismisses)
    mockState.showWarning.mockResolvedValue(undefined);

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await flush(10);

    // fs write must have happened (disk repair succeeded)
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalled();

    // Toast was shown despite config.update failing
    expect(mockState.showWarning).toHaveBeenCalled();

    // Rate limit: drive enough recoveries to trigger pause (need fileRepaired to count)
    // The first recovery already counted. Drive 2 more file-based heals to hit burst(3).
    mockConfig.update.mockResolvedValue(undefined);
    mockState.showWarning.mockClear();
    mockState.showWarning.mockResolvedValue(undefined);

    for (let i = 0; i < 2; i++) {
      mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
      const freshContent = JSON.stringify({ "nexus.terminal.passthroughKeys": [{}, {}] });
      mockFs.files.set(
        "/userdata/User/settings.json",
        new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(freshContent, "utf8")])
      );
      capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
      await flush(5);
      // healthy in between
      mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });
      capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
      await flush(5);
    }

    // 4th event → should trip burst pause
    mockConfig.update.mockRejectedValue(new Error("locked by DLP"));
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });
    const freshContent2 = JSON.stringify({ "nexus.terminal.passthroughKeys": [{}, {}] });
    mockFs.files.set(
      "/userdata/User/settings.json",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(freshContent2, "utf8")])
    );
    capturedListener!({ affectsConfiguration: (key: string) => key === "nexus.terminal.passthroughKeys" });
    await flush(10);

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string }>;
    const pausedEvent = log?.find(e => e.kind === "paused");
    expect(pausedEvent).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // FIX 4: only passthroughKeys corrupt (no skip-shell) → toast shown WITHOUT "Undo" button
  // ---------------------------------------------------------------------------
  it("FIX4: only passthroughKeys corrupt (no skip-shell) → toast shown without Undo button", async () => {
    const gs = makeGlobalState();
    gs._store.set("nexus.settingsGuard.lastKnownGoodValues", { "nexus.terminal.passthroughKeys": ["b"] });

    // Only passthroughKeys corrupt, skip-shell is healthy (not set = no override)
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: [{}, {}] });

    mockState.showWarning.mockResolvedValue(undefined);

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await flush();

    expect(mockState.showWarning).toHaveBeenCalled();
    const callArgs = mockState.showWarning.mock.calls[0] as unknown[];
    // The button list should NOT include "Undo"
    expect(callArgs).not.toContain("Undo");
    // But should include "Disable Guard" and "Show Report"
    expect(callArgs).toContain("Disable Guard");
    expect(callArgs).toContain("Show Report");
  });

  // ---------------------------------------------------------------------------
  // FIX 1 verification: no-BOM corrupt file → disk-first write succeeds, no profile-mismatch logged
  // ---------------------------------------------------------------------------
  it("FIX1: no-BOM corrupt file → disk write happens (disk-first), no profile-mismatch event", async () => {
    const gs = makeGlobalState();
    const macroCommands = ["nexus.macro.run"];

    // Corrupt skip-shell
    mockConfig.inspectValues.set("terminal.integrated.commandsToSkipShell", {
      globalValue: [{}, {}],
      defaultValue: ["workbench.action.quickOpen"],
    });

    // File has same corrupt value (no BOM) → profile-safety should PASS because disk-first reads the still-corrupt file
    const fileContent = JSON.stringify({ "terminal.integrated.commandsToSkipShell": [{}, {}] });
    mockFs.files.set(
      "/userdata/User/settings.json",
      Buffer.from(fileContent, "utf8")  // No BOM
    );

    const controller = new SettingsGuardController(fakeContext(gs), macroCommands, () => true);
    controller.start();
    await flush();

    // fs write must have happened
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalled();

    // No profile-mismatch event
    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<{ kind: string; detail?: string }>;
    const mismatchEvent = log?.find(e => e.kind === "file-repair-failed" && e.detail?.includes("profile-mismatch"));
    expect(mismatchEvent).toBeUndefined();
  });
});
