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
    // Set inspect to return corrupt value (empty array → shouldRemoveCorruptNexusValue returns true)
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

  it("startup no-op: healthy passthroughKeys globalValue produces no events and no update call", async () => {
    const gs = makeGlobalState();
    // Non-empty array → shouldRemoveCorruptNexusValue returns false
    mockConfig.inspectValues.set("nexus.terminal.passthroughKeys", { globalValue: ["b"] });

    const controller = new SettingsGuardController(fakeContext(gs), []);
    controller.start();
    await new Promise(r => setTimeout(r, 0));

    const log = gs._store.get("nexus.settingsGuard.eventLog") as Array<unknown> | undefined;
    expect(log ?? []).toHaveLength(0);
    expect(mockConfig.update).not.toHaveBeenCalled();
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
});
