/**
 * @author kanekitakitos
 *
 * Unit tests for the Local Servers command layer.
 *
 * Focus points:
 *  1. formValuesToLocalServer — pure parser / coercer from webview form
 *     values to a valid LocalServerConfig, with strict early failure on
 *     missing name / executable / invalid folder paths.
 *  2. Edge cases around env textarea parsing (null/undefined keywords,
 *     comments, empty values), args multi-line, boolean / number coercion
 *     for checkbox and number fields coming from the form layer.
 *
 * No real VS Code APIs are exercised here; the configMutationLock pattern
 * for destructive remove is covered conceptually by the command-level
 * integration tests in profileCommands.test.ts (same FSM as SSH remove,
 * only the disclosure helper differs and is type-checked by the compiler).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("vscode", () => ({
  EventEmitter: class<T> {
    private readonly listeners: Array<(e: T) => void> = [];
    public event = (l: (e: T) => void) => { this.listeners.push(l); return { dispose: vi.fn() }; };
    public fire(e: T): void { for (const l of this.listeners) l(e); }
  },
  Disposable: class { public constructor(private readonly fn: () => void) {} public dispose(): void { this.fn(); } },
  commands: {
    registerCommand: (id: string, h: (...a: unknown[]) => unknown) => { registeredCommands.set(id, h); return { dispose: vi.fn() }; },
    executeCommand: vi.fn()
  },
  window: {
    createTerminal: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn(), name: "Nexus" })),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() }))
  },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: (_k: string, fb: unknown) => fb }))
  },
  env: { clipboard: { writeText: vi.fn() } },
  TreeItem: class { public label?: unknown; public contextValue?: unknown; public constructor(label?: unknown) { this.label = label; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeColor: class {},
  ConfigurationTarget: { Global: 1 }
}));

// NOT mocked — the real AsyncMutex is what the #108 serialization tests below
// exercise (a pass-through stub runs every section immediately and so cannot
// tell a locked write from a lock-free one).

vi.mock("../../src/services/local/localServerManager", () => ({
  LocalServerManager: class {},
  localServerDescription: (c: unknown) => String(c),
  localServerRemovalDisclosure: (c: unknown) => String(c)
}));

const mockWebviewFormPanelOpen = vi.fn();

vi.mock("../../src/ui/webviewFormPanel", () => ({
  WebviewFormPanel: {
    open: (...args: unknown[]) => mockWebviewFormPanelOpen(...args)
  }
}));

vi.mock("../../src/ui/formDefinitions", () => ({ localServerFormDefinition: () => ({ title: "", fields: [] }) }));

vi.mock("../../src/ui/nexusTreeProvider", () => ({
  LocalServerConfigTreeItem: class { public constructor(public readonly config: unknown) {} },
  LocalServerSessionTreeItem: class { public constructor(public readonly session: unknown) {} }
}));

vi.mock("../../src/utils/folderPaths", async () => {
  const actual = await import("../../src/utils/folderPaths");
  return {
    ...actual,
    normalizeOptionalFolderPath: (value: unknown) => {
      if (value === undefined || value === null || value === "") return "";
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      if (trimmed.startsWith("/not/a/relative/path")) return null;
      return actual.normalizeOptionalFolderPath(value);
    }
  };
});

vi.mock("../../src/utils/naturalCompare", () => ({ naturalCompare: (a: string, b: string) => a.localeCompare(b) }));

vi.mock("../../src/commands/serverCommands", () => ({ collectGroups: () => [] }));

import * as vscode from "vscode";
import { formValuesToLocalServer, registerLocalServerCommands } from "../../src/commands/localServerCommands";
import type { LocalServerConfig } from "../../src/models/localServer";
import type { FormValues } from "../../src/ui/formTypes";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import type { CommandContext } from "../../src/commands/types";
import type { LocalServerManager } from "../../src/services/local/localServerManager";
import { configMutationLock } from "../../src/services/configMutationLock";

beforeEach(() => {
  registeredCommands.clear();
  mockWebviewFormPanelOpen.mockReset();
});

function baseValues(): FormValues {
  return {
    name: "Backend Dev Server",
    executable: "node",
    group: ""
  };
}

describe("formValuesToLocalServer", () => {
  it("returns a complete LocalServerConfig on the happy path", () => {
    const values: FormValues = {
      ...baseValues(),
      args: "--port\n8080\n",
      cwd: "${workspaceFolder}/apps/api",
      env: "NODE_ENV=development\nPORT=8080\n# comment line\nDEBUG=",
      autoRestart: "on",
      maxAutoRestarts: "3",
      description: "Runs the local API dev server via `node dist/main.js`."
    };

    const result = formValuesToLocalServer(values);
    expect(result).toBeDefined();
    expect(result!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result!.name).toBe("Backend Dev Server");
    expect(result!.executable).toBe("node");
    expect(result!.args).toEqual(["--port", "8080"]);
    expect(result!.cwd).toBe("${workspaceFolder}/apps/api");
    expect(result!.description).toBe(
      "Runs the local API dev server via `node dist/main.js`."
    );
    expect(result!.autoRestart).toBe(true);
    expect(result!.maxAutoRestarts).toBe(3);
  });

  it("returns undefined when required `name` is missing", () => {
    const values: FormValues = { ...baseValues(), name: "" };
    expect(formValuesToLocalServer(values)).toBeUndefined();
  });

  it("returns undefined when required `executable` is missing", () => {
    const values: FormValues = { ...baseValues(), executable: "   \n\t" };
    expect(formValuesToLocalServer(values)).toBeUndefined();
  });

  it("returns undefined when group contains an invalid folder path", () => {
    // normalizeOptionalFolderPath returns null for leading slashes with no root
    const values: FormValues = { ...baseValues(), group: "/not/a/relative/path" };
    expect(formValuesToLocalServer(values)).toBeUndefined();
  });

  it("preserves an existing id when editing", () => {
    const existing: Partial<LocalServerConfig> = { id: randomUUID() };
    const result = formValuesToLocalServer(baseValues(), existing);
    expect(result!.id).toBe(existing.id);
  });

  it("parses env textarea keywords: null / undefined / empty string", () => {
    // The field's hint states the contract: "Setting KEY=null unsets, KEY=
    // passes an empty string." `KEY=` used to be folded in with `KEY=null`,
    // which made an empty string unexpressible and the hint's promise false.
    const values: FormValues = {
      ...baseValues(),
      env: [
        "FORCE_COLOR=1",
        "WILDCARD=null",
        "INHERIT=undefined",
        "EMPTY=",
        "# ignored=yes"
      ].join("\n")
    };
    const result = formValuesToLocalServer(values);
    expect(result!.env).toEqual({
      FORCE_COLOR: "1",
      WILDCARD: null,
      INHERIT: undefined,
      EMPTY: ""
    });
    // toEqual treats a missing key and an undefined one alike, so pin the
    // three states apart explicitly: only `null` is an unset.
    expect(result!.env!.EMPTY).toBe("");
    expect(result!.env!.WILDCARD).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result!.env!, "INHERIT")).toBe(true);
    expect(result!.env!.INHERIT).toBeUndefined();
  });

  it("drops blank / whitespace-only argument lines", () => {
    const values: FormValues = {
      ...baseValues(),
      args: "\n  \n--host\n   \n0.0.0.0\n\n"
    };
    const result = formValuesToLocalServer(values);
    expect(result!.args).toEqual(["--host", "0.0.0.0"]);
  });

  it("coerces autoRestart from boolean true (checkbox) and string 'true'", () => {
    const viaBool = formValuesToLocalServer({ ...baseValues(), autoRestart: true });
    const viaStr = formValuesToLocalServer({ ...baseValues(), autoRestart: "true" });
    const viaOff = formValuesToLocalServer({ ...baseValues(), autoRestart: false });
    expect(viaBool!.autoRestart).toBe(true);
    expect(viaStr!.autoRestart).toBe(true);
    expect(viaOff!.autoRestart).toBeUndefined();
  });

  it("coerces maxAutoRestarts from string and number; keeps a deliberate 0, drops garbage", () => {
    // 0 now means "no automatic restarts" rather than "unset", so it has to
    // survive the form. Unparseable text must not: mapping it to 0 would turn a
    // typo into a silent disabling of auto-restart, which is the one outcome
    // nobody asks for. A value above the ceiling is stored as typed and clamped
    // where it is used, so the profile keeps saying what its owner wrote.
    const viaStr = formValuesToLocalServer({ ...baseValues(), maxAutoRestarts: "12" });
    const viaNum = formValuesToLocalServer({ ...baseValues(), maxAutoRestarts: 7 });
    const viaZero = formValuesToLocalServer({ ...baseValues(), maxAutoRestarts: "0" });
    const viaGarbage = formValuesToLocalServer({ ...baseValues(), maxAutoRestarts: "abc" });
    const viaNegative = formValuesToLocalServer({ ...baseValues(), maxAutoRestarts: "-3" });
    expect(viaStr!.maxAutoRestarts).toBe(12);
    expect(viaNum!.maxAutoRestarts).toBe(7);
    expect(viaZero!.maxAutoRestarts).toBe(0);
    expect(viaGarbage!.maxAutoRestarts).toBeUndefined();
    expect(viaNegative!.maxAutoRestarts).toBeUndefined();
  });

  it("normalizes group folder path and preserves leading / trailing group semantics", () => {
    const values: FormValues = { ...baseValues(), group: "   Production / APIs   " };
    const result = formValuesToLocalServer(values);
    expect(result!.group).toBe("Production/APIs");
  });

  it("leaves optional fields undefined when not submitted", () => {
    const result = formValuesToLocalServer(baseValues());
    expect(result!.args).toBeUndefined();
    expect(result!.cwd).toBeUndefined();
    expect(result!.env).toBeUndefined();
    expect(result!.description).toBeUndefined();
    expect(result!.autoRestart).toBeUndefined();
    expect(result!.maxAutoRestarts).toBeUndefined();
  });
});

/**
 * COMMAND PALETTE IS A FIRST-CLASS ENTRY POINT.
 *
 * `restart`, `edit`, `remove`, `rename`, `duplicate`, `copyInfo`,
 * and `moveToFolder` all resolve a config from the tree-item
 * argument OR fall back to `pickLocalServer`. `stop` and `inspectLogs` did
 * not: invoked from the palette they got no argument, resolved nothing, and
 * dead-ended on a notice telling the user to right-click a tree row instead —
 * a message, not a way through.
 */
describe("palette fallback for stop / inspectLogs", () => {
  interface Harness {
    stopConfig: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    cancelPendingRestart: ReturnType<typeof vi.fn>;
    inspectLogsTerminal: ReturnType<typeof vi.fn>;
    lastTerminalForConfig: ReturnType<typeof vi.fn>;
    terminal: { show: ReturnType<typeof vi.fn> };
    lastTerminal: { show: ReturnType<typeof vi.fn> };
  }

  function harness(
    options: {
      runningConfigIds?: string[];
      restartPendingConfigIds?: string[];
      stoppingConfigIds?: string[];
      /**
       * Configs whose session ends while the picker is open: reported running
       * the first time they are asked about (when the list is built) and gone
       * from then on (when the pick is resolved).
       */
      vanishingConfigIds?: string[];
      /** Configs whose crashed session left its terminal tab open. */
      lastTerminalConfigIds?: string[];
    } = {}
  ): Harness {
    const running = new Set(options.runningConfigIds ?? []);
    const restartPending = new Set(options.restartPendingConfigIds ?? []);
    const stopping = new Set(options.stoppingConfigIds ?? []);
    const vanishing = new Set(options.vanishingConfigIds ?? []);
    const lastTerminals = new Set(options.lastTerminalConfigIds ?? []);
    const terminal = { show: vi.fn() };
    const lastTerminal = { show: vi.fn() };
    const manager = {
      stop: vi.fn(async () => {}),
      stopConfig: vi.fn(async () => {}),
      getActiveSessionIdForConfig: vi.fn((configId: string) => {
        if (vanishing.delete(configId)) return `session-for-${configId}`;
        return running.has(configId) ? `session-for-${configId}` : undefined;
      }),
      hasPendingRestart: vi.fn((configId: string) => restartPending.has(configId)),
      cancelPendingRestart: vi.fn((configId: string) => restartPending.delete(configId)),
      isStoppingConfig: vi.fn((configId: string) => stopping.has(configId)),
      inspectLogsTerminal: vi.fn(() => terminal),
      lastTerminalForConfig: vi.fn((configId: string) =>
        lastTerminals.has(configId) ? lastTerminal : undefined
      )
    };
    const localServers = [
      { id: "cfg-1", name: "API", executable: "node" },
      { id: "cfg-2", name: "Worker", executable: "python" }
    ];
    const ctx = {
      core: {
        getSnapshot: () => ({ localServers }),
        getLocalServer: (id: string) => localServers.find((c) => c.id === id)
      },
      localServerTerminals: new Map(),
      localServerManager: manager
    };
    registerLocalServerCommands(ctx as never);
    return {
      stopConfig: manager.stopConfig,
      stop: manager.stop,
      cancelPendingRestart: manager.cancelPendingRestart,
      inspectLogsTerminal: manager.inspectLogsTerminal,
      lastTerminalForConfig: manager.lastTerminalForConfig,
      terminal,
      lastTerminal
    };
  }

  const quickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
  const showInfo = vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    quickPick.mockReset();
    showInfo.mockReset();
  });

  it("stop with no argument offers the picker and stops the chosen config", async () => {
    const h = harness({ runningConfigIds: ["cfg-2"] });
    quickPick.mockImplementation(async (items: Array<{ config: { id: string } }>) =>
      items.find((i) => i.config.id === "cfg-2")
    );
    await registeredCommands.get("nexus.localServer.stop")!(undefined);
    // Before the fix the picker was never opened and this never ran.
    expect(quickPick).toHaveBeenCalledTimes(1);
    expect(h.stopConfig).toHaveBeenCalledWith("cfg-2", true);
  });

  it("stop titles its picker so the palette flow says what it is about to do", async () => {
    harness({ runningConfigIds: ["cfg-1"] });
    quickPick.mockImplementation(async () => undefined);
    await registeredCommands.get("nexus.localServer.stop")!(undefined);
    expect(quickPick.mock.calls[0][1]).toEqual({ title: "Stop Local Server" });
  });

  it("stop does nothing and says nothing when the picker is dismissed", async () => {
    const h = harness({ runningConfigIds: ["cfg-1"] });
    quickPick.mockImplementation(async () => undefined);
    await registeredCommands.get("nexus.localServer.stop")!(undefined);
    expect(h.stopConfig).not.toHaveBeenCalled();
    expect(showInfo).not.toHaveBeenCalled();
  });

  it("stop reports a config that is not running instead of silently no-opping", async () => {
    // stopConfig() iterates the running set and returns quietly when it is
    // empty, so a stopped pick would otherwise produce no feedback at all.
    // Reached by right-clicking a stopped config row — the picker no longer
    // offers such a config in the first place.
    const h = harness({ runningConfigIds: [] });
    await registeredCommands.get("nexus.localServer.stop")!({ config: { id: "cfg-1" } });
    expect(quickPick).not.toHaveBeenCalled();
    expect(h.stopConfig).not.toHaveBeenCalled();
    expect(showInfo).toHaveBeenCalledWith('Local server "API" is not running.');
  });

  /**
   * A crashed auto-restart profile spends its whole backoff window with no
   * session, so the not-running pre-check fired, reported "not running" and
   * returned — leaving the timer armed to spawn the process again seconds
   * after the user explicitly stopped it.
   */
  it("stop calls off a pending auto-restart instead of reporting the config as merely not running", async () => {
    const h = harness({ runningConfigIds: [], restartPendingConfigIds: ["cfg-1"] });
    quickPick.mockImplementation(async (items: Array<{ config: { id: string } }>) =>
      items.find((i) => i.config.id === "cfg-1")
    );
    await registeredCommands.get("nexus.localServer.stop")!(undefined);
    // A config waiting out a backoff has no session, so the running-only
    // filter has to keep it anyway or this fix is unreachable from the palette.
    expect(quickPick).toHaveBeenCalledTimes(1);
    expect(h.cancelPendingRestart).toHaveBeenCalledWith("cfg-1");
    // The old message claimed the user's stop had nothing to act on, while a
    // restart it had just cancelled proves otherwise.
    expect(showInfo).not.toHaveBeenCalledWith('Local server "API" is not running.');
    expect(showInfo).toHaveBeenCalledWith(
      'Local server "API" is stopped — its pending auto-restart was cancelled.'
    );
  });

  /**
   * `getActiveSessionIdForConfig` excludes a session that is stopping so that
   * restart() can re-start the config without a false ServerAlreadyRunning.
   * The tree counts the same state as running and draws the row as
   * "stopping", so "is not running" contradicts what is on screen.
   */
  it("says a stopping server is stopping, not that it is not running", async () => {
    const h = harness({ runningConfigIds: [], stoppingConfigIds: ["cfg-1"] });
    quickPick.mockImplementation(async (items: Array<{ config: { id: string } }>) =>
      items.find((i) => i.config.id === "cfg-1")
    );
    await registeredCommands.get("nexus.localServer.stop")!(undefined);
    // A stopping config is still something Stop can be asked about, so it has
    // to survive the picker's running-only filter to reach this message.
    expect(quickPick).toHaveBeenCalledTimes(1);
    expect(showInfo).not.toHaveBeenCalledWith('Local server "API" is not running.');
    expect(showInfo).toHaveBeenCalledWith('Local server "API" is already stopping.');
    expect(h.stopConfig).not.toHaveBeenCalled();
  });

  it("stop still short-circuits on a session tree item without opening the picker", async () => {
    const h = harness({ runningConfigIds: ["cfg-1"] });
    await registeredCommands.get("nexus.localServer.stop")!({ session: { id: "sess-9" } });
    expect(h.stop).toHaveBeenCalledWith("sess-9", true);
    expect(quickPick).not.toHaveBeenCalled();
  });

  it("inspectLogs with no argument offers the picker and shows the chosen config's terminal", async () => {
    const h = harness({ runningConfigIds: ["cfg-2"] });
    quickPick.mockImplementation(async (items: Array<{ config: { id: string } }>) =>
      items.find((i) => i.config.id === "cfg-2")
    );
    await registeredCommands.get("nexus.localServer.inspectLogs")!(undefined);
    expect(quickPick).toHaveBeenCalledTimes(1);
    expect(quickPick.mock.calls[0][1]).toEqual({ title: "Inspect Local Server Logs" });
    expect(h.inspectLogsTerminal).toHaveBeenCalledWith("session-for-cfg-2");
    expect(h.terminal.show).toHaveBeenCalledTimes(1);
    expect(showInfo).not.toHaveBeenCalled();
  });

  it("inspectLogs keeps the 'no running session' notice, scoped to the picked config", async () => {
    // The picker now only offers running configs, so this notice is reached
    // by the race it was written for: the session ends while the picker is
    // open. cfg-1 reads as running when the list is built and gone by the
    // time the pick resolves.
    const h = harness({ runningConfigIds: ["cfg-2"], vanishingConfigIds: ["cfg-1"] });
    quickPick.mockImplementation(async (items: Array<{ config: { id: string } }>) =>
      items.find((i) => i.config.id === "cfg-1")
    );
    await registeredCommands.get("nexus.localServer.inspectLogs")!(undefined);
    // Without this the test passed against the dead-end implementation that
    // never opened a picker at all and reported the same notice
    // unconditionally — i.e. "scoped to the picked config", the half this
    // test exists for, went unasserted.
    expect(quickPick).toHaveBeenCalledTimes(1);
    expect(h.inspectLogsTerminal).not.toHaveBeenCalled();
    expect(showInfo).toHaveBeenCalledWith("No running local server session to display.");
  });

  /**
   * Every sibling stop-like picker in this codebase lists only what is
   * active — tunnelCommands' activeTunnels, serialCommands' serialTerminals,
   * scriptCommands' getRuns(). Listing every configured server made the user
   * guess which rows were live, then refused most of the picks.
   */
  it("stop offers only the servers it can act on", async () => {
    harness({ runningConfigIds: ["cfg-2"] });
    quickPick.mockImplementation(async () => undefined);
    await registeredCommands.get("nexus.localServer.stop")!(undefined);
    const offered = (quickPick.mock.calls[0][0] as Array<{ config: { id: string } }>).map((i) => i.config.id);
    expect(offered).toEqual(["cfg-2"]);
  });

  it("inspectLogs offers only the servers with a session to show", async () => {
    harness({ runningConfigIds: ["cfg-1"] });
    quickPick.mockImplementation(async () => undefined);
    await registeredCommands.get("nexus.localServer.inspectLogs")!(undefined);
    const offered = (quickPick.mock.calls[0][0] as Array<{ config: { id: string } }>).map((i) => i.config.id);
    expect(offered).toEqual(["cfg-1"]);
  });

  it.each([
    ["stop", "No Nexus local servers are running."],
    ["inspectLogs", "No Nexus local server has an open terminal to inspect."]
  ])("%s says why rather than opening an empty picker", async (verb, message) => {
    harness({ runningConfigIds: [] });
    await registeredCommands.get(`nexus.localServer.${verb}`)!(undefined);
    expect(quickPick).not.toHaveBeenCalled();
    expect(showInfo).toHaveBeenCalledWith(message);
  });

  /**
   * cleanupSession() unregisters the crashed session but deliberately leaves
   * its terminal open — the failure output on it is the whole reason to look.
   * Every lookup was session-keyed, so the command refused with that tab
   * sitting in the panel.
   */
  it("inspectLogs shows the terminal a crashed session left behind", async () => {
    const h = harness({ runningConfigIds: [], lastTerminalConfigIds: ["cfg-2"] });
    quickPick.mockImplementation(async (items: Array<{ config: { id: string } }>) =>
      items.find((i) => i.config.id === "cfg-2")
    );
    await registeredCommands.get("nexus.localServer.inspectLogs")!(undefined);
    expect(h.lastTerminal.show).toHaveBeenCalledTimes(1);
    expect(showInfo).not.toHaveBeenCalled();
  });

  it("inspectLogs offers a crashed server, not only the live ones", async () => {
    harness({ runningConfigIds: [], lastTerminalConfigIds: ["cfg-2"] });
    quickPick.mockImplementation(async () => undefined);
    await registeredCommands.get("nexus.localServer.inspectLogs")!(undefined);
    const offered = (quickPick.mock.calls[0][0] as Array<{ config: { id: string } }>).map((i) => i.config.id);
    expect(offered).toEqual(["cfg-2"]);
  });

  it("inspectLogs prefers the live session over the leftover terminal", async () => {
    const h = harness({ runningConfigIds: ["cfg-1"], lastTerminalConfigIds: ["cfg-1"] });
    quickPick.mockImplementation(async (items: Array<{ config: { id: string } }>) =>
      items.find((i) => i.config.id === "cfg-1")
    );
    await registeredCommands.get("nexus.localServer.inspectLogs")!(undefined);
    expect(h.terminal.show).toHaveBeenCalledTimes(1);
    expect(h.lastTerminal.show).not.toHaveBeenCalled();
  });

  /**
   * The filter is scoped to the two verbs that need it. restart / edit /
   * remove / rename / duplicate / copyInfo legitimately act on a config
   * whatever its state, and must keep listing all of them.
   */
  it.each(["restart", "edit", "remove", "rename", "duplicate", "copyInfo"])(
    "%s still offers every configured server, running or not",
    async (verb) => {
      harness({ runningConfigIds: [] });
      quickPick.mockImplementation(async () => undefined);
      await registeredCommands.get(`nexus.localServer.${verb}`)!(undefined);
      expect(quickPick).toHaveBeenCalledTimes(1);
      const offered = (quickPick.mock.calls[0][0] as Array<{ config: { id: string } }>).map((i) => i.config.id);
      expect(offered).toEqual(["cfg-1", "cfg-2"]);
    }
  );

  it("inspectLogs does nothing when the picker is dismissed", async () => {
    const h = harness({ runningConfigIds: ["cfg-1"] });
    quickPick.mockImplementation(async () => undefined);
    await registeredCommands.get("nexus.localServer.inspectLogs")!(undefined);
    expect(h.inspectLogsTerminal).not.toHaveBeenCalled();
    expect(showInfo).not.toHaveBeenCalled();
  });
});

/**
 * "MOVE TO FOLDER…" REPLACES THE "MOVE TO ROOT" PAIR.
 *
 * Moving a local server used to be two commands: an input box asking for a
 * folder path, plus a separate always-present "Move to Root" entry that needed
 * a per-row `.inFolder` contextValue marker (and a matching regex in eighteen
 * other `when` clauses) so it would only appear where it was not a no-op.
 *
 * Macros already solved this with one picker offering "(root)", "New folder…"
 * and every existing folder — no second command, no per-row marker. Local
 * servers now use the same shape, which is what let the marker be deleted.
 */
describe("moveToFolder destination picker", () => {
  const quickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
  const inputBox = vscode.window.showInputBox as unknown as ReturnType<typeof vi.fn>;

  function moveHarness(servers: Array<Partial<LocalServerConfig>> = []) {
    const localServers = servers.map((s) => ({
      id: "cfg-1",
      name: "API",
      executable: "node",
      ...s
    })) as LocalServerConfig[];
    const saved: LocalServerConfig[] = [];
    const ctx = {
      core: {
        getSnapshot: () => ({ localServers }),
        getLocalServer: (id: string) => localServers.find((c) => c.id === id),
        addOrUpdateLocalServerConfig: vi.fn(async (config: LocalServerConfig) => {
          saved.push(config);
        })
      },
      localServerTerminals: new Map(),
      localServerManager: {
        getActiveSessionIdForConfig: () => undefined,
        isStoppingConfig: () => false,
        hasPendingRestart: () => false,
        lastTerminalForConfig: () => undefined
      }
    };
    registerLocalServerCommands(ctx as never);
    return { saved, addOrUpdate: ctx.core.addOrUpdateLocalServerConfig };
  }

  const run = (config: Partial<LocalServerConfig>) =>
    registeredCommands.get("nexus.localServer.moveToFolder")!({ config: { id: "cfg-1" } });

  beforeEach(() => {
    quickPick.mockReset();
    inputBox.mockReset();
  });

  /** The destination picker is the last showQuickPick call the command makes. */
  const destinationItems = (): Array<{ label: string }> =>
    quickPick.mock.calls[quickPick.mock.calls.length - 1][0] as Array<{ label: string }>;

  it("offers (root), New folder… and every existing folder", async () => {
    moveHarness([{ group: "Backends/APIs" }, { id: "cfg-2", name: "Worker", group: "Jobs" }]);
    quickPick.mockImplementation(async () => undefined);
    await run({ group: "Backends/APIs" });

    const labels = destinationItems().map((i) => i.label);
    expect(labels[0]).toBe("(root)");
    expect(labels[1]).toContain("New folder");
    // Ancestors included, so an intermediate folder is a destination too.
    expect(labels).toContain("Backends");
    expect(labels).toContain("Backends/APIs");
    expect(labels).toContain("Jobs");
  });

  it("clears the group when (root) is chosen — what the retired command did", async () => {
    const h = moveHarness([{ group: "Backends/APIs" }]);
    quickPick.mockImplementation(async (items: Array<{ label: string }>) =>
      items.find((i) => i.label === "(root)")
    );
    await run({ group: "Backends/APIs" });
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].group).toBeUndefined();
  });

  it("moves into an existing folder when one is chosen", async () => {
    const h = moveHarness([{ group: "Backends/APIs" }, { id: "cfg-2", name: "Worker", group: "Jobs" }]);
    quickPick.mockImplementation(async (items: Array<{ label: string }>) =>
      items.find((i) => i.label === "Jobs")
    );
    await run({ group: "Backends/APIs" });
    expect(h.saved[0].group).toBe("Jobs");
  });

  it("marks the server's current folder so the picker says where it already is", async () => {
    moveHarness([{ group: "Jobs" }]);
    quickPick.mockImplementation(async () => undefined);
    await run({ group: "Jobs" });
    const current = (destinationItems() as Array<{ label: string; description?: string }>).find(
      (i) => i.label === "Jobs"
    );
    expect(current?.description).toBe("current");
  });

  it("marks (root) as current for a server that is not in a folder", async () => {
    moveHarness([{}]);
    quickPick.mockImplementation(async () => undefined);
    await run({});
    const root = (destinationItems() as Array<{ label: string; description?: string }>).find(
      (i) => i.label === "(root)"
    );
    expect(root?.description).toBe("current");
  });

  it("prompts for a path when New folder… is chosen, and moves there", async () => {
    const h = moveHarness([{}]);
    quickPick.mockImplementation(async (items: Array<{ label: string }>) =>
      items.find((i) => i.label.includes("New folder"))
    );
    inputBox.mockImplementation(async () => "Backends/New");
    await run({});
    expect(h.saved[0].group).toBe("Backends/New");
  });

  it("writes nothing when the picker is dismissed", async () => {
    const h = moveHarness([{ group: "Jobs" }]);
    quickPick.mockImplementation(async () => undefined);
    await run({ group: "Jobs" });
    expect(h.addOrUpdate).not.toHaveBeenCalled();
  });

  it("writes nothing when the New folder prompt is dismissed", async () => {
    const h = moveHarness([{ group: "Jobs" }]);
    quickPick.mockImplementation(async (items: Array<{ label: string }>) =>
      items.find((i) => i.label.includes("New folder"))
    );
    inputBox.mockImplementation(async () => undefined);
    await run({ group: "Jobs" });
    // Dismissing the second step must not fall through to root: the server
    // would be moved somewhere the user never asked for.
    expect(h.addOrUpdate).not.toHaveBeenCalled();
  });

  /**
   * The menu entry is gone, the command ID is not: it shipped in a released
   * version, so a user keybinding or task bound to it would break silently on
   * upgrade. Kept registered but undeclared in package.json — the same hidden
   * back-compat alias shape as `nexus.macro.slot` (the manifest side is
   * asserted in localServerMenu.test.ts).
   */
  it("keeps Move to Root registered as a hidden back-compat alias", () => {
    moveHarness([{}]);
    expect(registeredCommands.has("nexus.localServer.moveToRoot")).toBe(true);
    expect(registeredCommands.has("nexus.localServer.moveToFolder")).toBe(true);
  });

  it("moveToRoot clears the group directly, with no destination picker", async () => {
    const h = moveHarness([{ group: "Backends/APIs" }]);
    await registeredCommands.get("nexus.localServer.moveToRoot")!({ config: { id: "cfg-1" } });
    // Routing this through the folder picker instead would leave the server in
    // its folder until a second choice was made — from a keybinding, the point
    // of the alias, there is nobody to make it.
    expect(quickPick).not.toHaveBeenCalled();
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].group).toBeUndefined();
  });
});

function makeLocalServerConfig(overrides: Partial<LocalServerConfig> = {}): LocalServerConfig {
  return {
    id: "ls1",
    name: "Dev Server",
    executable: "node",
    group: "Backend",
    ...overrides
  };
}

async function fixture(
  configs: LocalServerConfig[]
): Promise<{ core: NexusCore; repo: InMemoryConfigRepository }> {
  const repo = new InMemoryConfigRepository([], [], [], [], [], [], configs);
  const core = new NexusCore(repo);
  await core.initialize();
  const ctx = {
    core,
    localServerTerminals: new Map(),
    localServerManager: {}
  } as unknown as CommandContext & { localServerManager: LocalServerManager };
  registerLocalServerCommands(ctx);
  return { core, repo };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * nexus.localServer.moveToRoot has no input box of its own, but on the
 * command-palette path (invoked with no arg) it falls through to
 * pickLocalServer, whose quick pick embeds a config snapshot taken at
 * OPEN time — same capture-then-write shape as rename / moveToFolder just
 * fixed for #108, only the interactive pause is the picker instead of an
 * input box.
 */
describe("nexus.localServer.moveToRoot re-resolves under the lock (issue #108)", () => {
  function moveToRoot(arg?: unknown): Promise<unknown> {
    const cmd = registeredCommands.get("nexus.localServer.moveToRoot");
    expect(cmd).toBeDefined();
    return Promise.resolve(cmd!(arg));
  }

  it("does not revert a concurrent edit's other fields", async () => {
    // pickLocalServer captures the config when the quick pick opens, then the
    // picker awaits the user for an unbounded time. While it is open, an edit
    // changes the executable. moveToRoot must apply ONLY group: undefined, to
    // the CURRENT record — not write back the pre-picker snapshot, which
    // silently undoes the edit to every other field.
    const { core } = await fixture([makeLocalServerConfig({ executable: "node" })]);
    const stale = core.getLocalServer("ls1")!;

    const pick = deferred<{ config: LocalServerConfig } | undefined>();
    vi.mocked(vscode.window.showQuickPick).mockReturnValue(pick.promise as never);

    const moving = moveToRoot(undefined);
    await core.addOrUpdateLocalServerConfig({ ...core.getLocalServer("ls1")!, executable: "python" });

    pick.resolve({ config: stale });
    await moving;

    const after = core.getLocalServer("ls1")!;
    expect(after.group).toBeUndefined();
    // Load-bearing: "node" here means moveToRoot reverted the concurrent edit.
    expect(after.executable).toBe("python");
  });

  it("does not resurrect a config removed during the prompt", async () => {
    const { core } = await fixture([makeLocalServerConfig()]);
    const stale = core.getLocalServer("ls1")!;

    const pick = deferred<{ config: LocalServerConfig } | undefined>();
    vi.mocked(vscode.window.showQuickPick).mockReturnValue(pick.promise as never);

    const moving = moveToRoot(undefined);
    await core.removeLocalServerConfig("ls1");

    pick.resolve({ config: stale });
    await moving;

    expect(core.getLocalServer("ls1")).toBeUndefined();
  });

  it("bails when a concurrent move changed the group to some OTHER value (#84 P2-1)", async () => {
    // The picker opened against group "Backend". Something else moved the
    // record to "Frontend" while it was open, so this picker's decision was
    // made against a folder that no longer applies — writing group: undefined
    // here would overwrite that newer move.
    const { core } = await fixture([makeLocalServerConfig({ group: "Backend" })]);
    const stale = core.getLocalServer("ls1")!;

    const pick = deferred<{ config: LocalServerConfig } | undefined>();
    vi.mocked(vscode.window.showQuickPick).mockReturnValue(pick.promise as never);

    const moving = moveToRoot(undefined);
    await core.addOrUpdateLocalServerConfig({ ...core.getLocalServer("ls1")!, group: "Frontend" });

    pick.resolve({ config: stale });
    await moving;

    expect(core.getLocalServer("ls1")!.group).toBe("Frontend");
  });

  it("writes nothing when the record is already at the root", async () => {
    // Both halves matter: the record reached the root by another route while
    // the picker was open, AND an edit changed a field this command does not
    // own. Re-writing the pre-picker snapshot would be a no-op on `group` and
    // would silently revert `executable` — which is exactly how the bug hid.
    const { core } = await fixture([makeLocalServerConfig({ group: "Backend" })]);
    const stale = core.getLocalServer("ls1")!;

    const pick = deferred<{ config: LocalServerConfig } | undefined>();
    vi.mocked(vscode.window.showQuickPick).mockReturnValue(pick.promise as never);

    const moving = moveToRoot(undefined);
    await core.addOrUpdateLocalServerConfig({
      ...core.getLocalServer("ls1")!,
      group: undefined,
      executable: "python"
    });

    pick.resolve({ config: stale });
    await moving;

    const after = core.getLocalServer("ls1")!;
    expect(after.group).toBeUndefined();
    // Load-bearing: "node" here means moveToRoot wrote the stale snapshot back.
    expect(after.executable).toBe("python");
  });
});

/**
 * The same #108 capture-then-write shape, on the command this PR redesigned:
 * moveToFolder now captures its config and THEN opens the destination picker
 * ("(root)" / "New folder…" / every existing folder). The picker is the
 * interactive pause — the record can be edited, moved or removed by another
 * window while it is open — so the write has to re-read the live record under
 * configMutationLock and apply ONLY `group`.
 */
describe("nexus.localServer.moveToFolder re-resolves under the lock (issue #108)", () => {
  beforeEach(() => {
    vi.mocked(vscode.window.showQuickPick).mockReset();
    vi.mocked(vscode.window.showInputBox).mockReset();
  });

  /**
   * Runs moveToFolder against the tree-item path (so the ONLY quick pick is
   * the destination picker) and hands back the offered items plus the deferred
   * that resolves the user's choice. The command is left suspended on that
   * picker exactly as it would be while a user thinks about it.
   */
  function openDestinationPicker(): {
    moving: Promise<unknown>;
    items: Array<{ label: string }>;
    pick: Deferred<unknown>;
  } {
    let items: Array<{ label: string }> = [];
    const pick = deferred<unknown>();
    vi.mocked(vscode.window.showQuickPick).mockImplementation(((offered: Array<{ label: string }>) => {
      items = offered;
      return pick.promise;
    }) as never);
    const cmd = registeredCommands.get("nexus.localServer.moveToFolder");
    expect(cmd).toBeDefined();
    // The handler runs synchronously up to the picker's await, so `items` is
    // populated by the time this returns.
    const moving = Promise.resolve(cmd!({ config: { id: "ls1" } }));
    return { moving, items, pick };
  }

  const itemNamed = (items: Array<{ label: string }>, label: string): unknown => {
    const found = items.find((i) => i.label === label);
    expect(found).toBeDefined();
    return found;
  };

  it("does not revert a concurrent edit's other fields", async () => {
    // The picker opened against the record as it was; while it was open an
    // edit changed the executable. Committing the captured snapshot would
    // apply the move AND silently undo that edit.
    const { core } = await fixture([
      makeLocalServerConfig({ group: "Backend", executable: "node" }),
      makeLocalServerConfig({ id: "ls2", name: "Web", group: "Frontend" })
    ]);

    const { moving, items, pick } = openDestinationPicker();
    await core.addOrUpdateLocalServerConfig({ ...core.getLocalServer("ls1")!, executable: "python" });

    pick.resolve(itemNamed(items, "Frontend"));
    await moving;

    const after = core.getLocalServer("ls1")!;
    expect(after.group).toBe("Frontend");
    // Load-bearing: "node" here means moveToFolder reverted the concurrent edit.
    expect(after.executable).toBe("python");
  });

  it("does not resurrect a config removed during the picker", async () => {
    const { core } = await fixture([
      makeLocalServerConfig({ group: "Backend" }),
      makeLocalServerConfig({ id: "ls2", name: "Web", group: "Frontend" })
    ]);

    const { moving, items, pick } = openDestinationPicker();
    await core.removeLocalServerConfig("ls1");

    pick.resolve(itemNamed(items, "Frontend"));
    await moving;

    expect(core.getLocalServer("ls1")).toBeUndefined();
  });

  it("bails when a concurrent move changed the group to some OTHER value (#84 P2-1)", async () => {
    // The picker opened against group "Backend". Something else moved the
    // record to "Archive" while it was open, so this pick was made against a
    // folder that no longer applies — writing "Frontend" here would overwrite
    // that newer move.
    const { core } = await fixture([
      makeLocalServerConfig({ group: "Backend" }),
      makeLocalServerConfig({ id: "ls2", name: "Web", group: "Frontend" })
    ]);

    const { moving, items, pick } = openDestinationPicker();
    await core.addOrUpdateLocalServerConfig({ ...core.getLocalServer("ls1")!, group: "Archive" });

    pick.resolve(itemNamed(items, "Frontend"));
    await moving;

    expect(core.getLocalServer("ls1")!.group).toBe("Archive");
  });

  it("writes nothing when the record already sits in the picked folder", async () => {
    // Someone else made the same move first, and also edited a field this
    // command does not own. Re-writing the captured snapshot would look like a
    // no-op on `group` while reverting `executable`.
    const { core } = await fixture([
      makeLocalServerConfig({ group: "Backend", executable: "node" }),
      makeLocalServerConfig({ id: "ls2", name: "Web", group: "Frontend" })
    ]);

    const { moving, items, pick } = openDestinationPicker();
    await core.addOrUpdateLocalServerConfig({
      ...core.getLocalServer("ls1")!,
      group: "Frontend",
      executable: "python"
    });

    pick.resolve(itemNamed(items, "Frontend"));
    await moving;

    const after = core.getLocalServer("ls1")!;
    expect(after.group).toBe("Frontend");
    // Load-bearing: "node" here means the stale snapshot was written back.
    expect(after.executable).toBe("python");
  });

  it("clears the group through the same guarded write when (root) is picked", async () => {
    const { core } = await fixture([
      makeLocalServerConfig({ group: "Backend", executable: "node" }),
      makeLocalServerConfig({ id: "ls2", name: "Web", group: "Frontend" })
    ]);

    const { moving, items, pick } = openDestinationPicker();
    await core.addOrUpdateLocalServerConfig({ ...core.getLocalServer("ls1")!, executable: "python" });

    pick.resolve(itemNamed(items, "(root)"));
    await moving;

    const after = core.getLocalServer("ls1")!;
    expect(after.group).toBeUndefined();
    expect(after.executable).toBe("python");
  });
});

/**
 * Parks INSIDE the lock until released — the "already in the critical section,
 * still awaiting its I/O" phase these races need to be pinned against rather
 * than raced for (copied from test/unit/localShellCommands.test.ts).
 */
function gatedLockedWrite(
  lock: { runExclusive: <T>(fn: () => Promise<T>) => Promise<T> },
  write: () => Promise<void>
): { done: Promise<void>; release: () => void } {
  const gate = deferred<void>();
  const done = lock.runExclusive(async () => {
    await gate.promise;
    await write();
  });
  return { done, release: () => gate.resolve() };
}

/**
 * nexus.localServer.edit was one of SEVERAL lock-free writes to the
 * localServers collection that the #108 audit missed — the drag-to-folder
 * handler and the unified Add Profile form's local-server branch are the
 * others, both outside this file and both tracked separately. What singles
 * this one out is the length of its interactive pause: a webview form the user
 * can leave open indefinitely. Every other handler in this file (rename /
 * moveToFolder / moveToRoot / duplicate / remove) already re-reads the live
 * record under configMutationLock.
 *
 * The form renders `group` from a snapshot taken when it OPENED, so a folder
 * rename or a removeFolderCascade — both of which rewrite each affected
 * record's `group` IN PLACE, and both of which are themselves lock-protected —
 * landing while the form sat open was silently reverted the moment the user
 * clicked Save, potentially stranding the record in a folder that no longer
 * exists.
 */
describe("nexus.localServer.edit re-resolves under the lock (issue #108 followups)", () => {
  /**
   * Drives the edit form open, then hands back the onSubmit callback the real
   * WebviewFormPanel would invoke on Save. WebviewFormPanel itself is mocked
   * (module-level `mockWebviewFormPanelOpen`) — its real implementation talks
   * to `vscode.window.createWebviewPanel`, which this file's vscode mock does
   * not provide.
   */
  async function editLocalServer(arg: unknown): Promise<(values: FormValues) => Promise<void>> {
    const cmd = registeredCommands.get("nexus.localServer.edit");
    expect(cmd).toBeDefined();
    await cmd!(arg);
    const call = mockWebviewFormPanelOpen.mock.calls.at(-1);
    expect(call).toBeDefined();
    const options = call![2] as { onSubmit: (values: FormValues) => Promise<void> };
    return options.onSubmit;
  }

  /** What the form hands back on Save, echoing the record it was rendered from. */
  function submittedValues(overrides: Record<string, string> = {}): FormValues {
    return {
      name: "Dev Server",
      executable: "node",
      group: "Backend",
      ...overrides
    } as unknown as FormValues;
  }

  it("does not revert a folder RENAME that landed while the form was open", async () => {
    // THE BUG. The form opened while the record sat in "Backend" and its group
    // field still reads "Backend". Meanwhile the folder was renamed to
    // "Platform", which rewrote this record's group in place. Saving the form's
    // pre-rename value puts the record back in a folder nobody has any more.
    const { core } = await fixture([makeLocalServerConfig({ group: "Backend", executable: "node" })]);

    const onSubmit = await editLocalServer("ls1");

    await core.renameFolder("Backend", "Platform");
    expect(core.getLocalServer("ls1")!.group).toBe("Platform");

    // The user edited the executable and never touched the folder field.
    await onSubmit(submittedValues({ executable: "python" }));

    const after = core.getLocalServer("ls1")!;
    // Load-bearing: "Backend" here means the Save reverted the folder rename.
    expect(after.group).toBe("Platform");
    // The edit the user actually made still lands.
    expect(after.executable).toBe("python");
  });

  it("does not strand the record in a folder removeFolderCascade deleted while the form was open", async () => {
    // Reparenting cascade: "Backend" is removed and its contents move up to the
    // root. Saving the form's stale "Backend" would re-file the record under a
    // folder that no longer exists — invisible in the tree until someone
    // notices the row never came back to the root.
    const { core } = await fixture([makeLocalServerConfig({ group: "Backend" })]);

    const onSubmit = await editLocalServer("ls1");

    await core.removeFolderCascade("Backend", false);
    expect(core.getLocalServer("ls1")!.group).toBeUndefined();

    await onSubmit(submittedValues({ description: "edited while unfiled" }));

    // Load-bearing: "Backend" here means the Save resurrected the dead folder.
    expect(core.getLocalServer("ls1")!.group).toBeUndefined();
  });

  it("still applies a folder the user DID pick in the form, even against a concurrent cascade", async () => {
    // The mirror image, and the reason the guard keys off "did the form field
    // change" rather than bailing outright the way rename/moveToFolder do: the
    // edit form is the primary editing surface, and a user who deliberately
    // retyped the folder has expressed an intent that must win. Deferring to
    // the live record here would silently discard their choice.
    const { core } = await fixture([makeLocalServerConfig({ group: "Backend" })]);

    const onSubmit = await editLocalServer("ls1");

    await core.renameFolder("Backend", "Platform");

    await onSubmit(submittedValues({ group: "Archive" }));

    expect(core.getLocalServer("ls1")!.group).toBe("Archive");
  });

  it("does not revert a nexus.localServer.rename that landed while the form was open", async () => {
    // Same shape as the folder-rename race above, but for `name`: rename is a
    // SEPARATE lock-protected command with its own live re-read, running
    // independently of this form. The form's `values.name` still reflects
    // "Dev Server" from when it opened; saving it after a concurrent rename to
    // "Build Server" must not silently undo that rename.
    const { core } = await fixture([makeLocalServerConfig({ name: "Dev Server", executable: "node" })]);

    const onSubmit = await editLocalServer("ls1");

    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("Build Server");
    const renameCmd = registeredCommands.get("nexus.localServer.rename");
    expect(renameCmd).toBeDefined();
    await renameCmd!("ls1");
    expect(core.getLocalServer("ls1")!.name).toBe("Build Server");

    // The user edited the executable and never touched the Name field.
    await onSubmit(submittedValues({ executable: "python" }));

    const after = core.getLocalServer("ls1")!;
    // Load-bearing: "Dev Server" here means the Save reverted the rename.
    expect(after.name).toBe("Build Server");
    expect(after.executable).toBe("python");
  });

  it("still applies a name the user DID retype in the form, even against a concurrent rename", async () => {
    // Mirror image: a deliberate edit to the Name field must win over a
    // concurrent rename, the same way a deliberately retyped folder does.
    const { core } = await fixture([makeLocalServerConfig({ name: "Dev Server" })]);

    const onSubmit = await editLocalServer("ls1");

    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("Build Server");
    const renameCmd = registeredCommands.get("nexus.localServer.rename");
    await renameCmd!("ls1");

    await onSubmit(submittedValues({ name: "Prod Server" }));

    expect(core.getLocalServer("ls1")!.name).toBe("Prod Server");
  });

  it("throws and saves nothing when the record was removed while the form was open", async () => {
    const { core, repo } = await fixture([makeLocalServerConfig()]);

    const onSubmit = await editLocalServer("ls1");

    await core.removeLocalServerConfig("ls1");

    await expect(onSubmit(submittedValues())).rejects.toThrow(
      'Local server "Dev Server" was removed while this form was open. Nothing was saved.'
    );

    expect(core.getLocalServer("ls1")).toBeUndefined();
    expect(await repo.getLocalServers()).toEqual([]);
  });

  it("queues its write behind an in-flight locked section (kills the lock-free save)", async () => {
    const { core } = await fixture([makeLocalServerConfig({ group: "Backend" })]);

    const onSubmit = await editLocalServer("ls1");

    // A folder cascade / replace-mode import stand-in: already inside the lock,
    // still awaiting its own I/O.
    const gated = gatedLockedWrite(configMutationLock, () => core.renameFolder("Backend", "Platform"));
    await settle();

    const saving = onSubmit(submittedValues({ executable: "python" }));
    await settle();

    // THE KILL. A lock-free save has already committed by now — before the
    // holder it should be queued behind has even started its body.
    expect(core.getLocalServer("ls1")!.executable).toBe("node");

    gated.release();
    await gated.done;
    await saving;

    const after = core.getLocalServer("ls1")!;
    expect(after.executable).toBe("python");
    expect(after.group).toBe("Platform");
  });
});

/**
 * nexus.localServer.duplicate writes a FRESH id, so no existing record is at
 * risk of being clobbered — but addOrUpdateLocalServerConfig persists the whole
 * collection, so an unserialized copy racing a lock-holding section commits
 * against a stale collection snapshot and can drop that section's writes. This
 * block covers that ordering half only; what the copy is built FROM is the
 * separate re-resolve concern covered by the block below.
 */
describe("nexus.localServer.duplicate serializes under the lock (issue #108)", () => {
  function duplicate(arg: unknown): Promise<unknown> {
    const cmd = registeredCommands.get("nexus.localServer.duplicate");
    expect(cmd).toBeDefined();
    return Promise.resolve(cmd!(arg));
  }

  it("queues behind an in-flight locked section instead of committing over it", async () => {
    const { core, repo } = await fixture([makeLocalServerConfig({ group: "Backend" })]);

    const gated = gatedLockedWrite(configMutationLock, () => core.renameFolder("Backend", "Platform"));
    await settle();

    const duplicating = duplicate({ config: { id: "ls1" } });
    await settle();

    // THE KILL. Lock-free, the copy is already persisted here — ahead of the
    // section it is supposed to queue behind.
    expect((await repo.getLocalServers()).map((c) => c.name)).toEqual(["Dev Server"]);

    gated.release();
    await gated.done;
    await duplicating;

    const stored = await repo.getLocalServers();
    expect(stored.map((c) => c.name).sort()).toEqual(["Dev Server", "Dev Server (copy)"]);
    // Both writes survive — the whole point of serializing.
    expect(stored.find((c) => c.name === "Dev Server")!.group).toBe("Platform");
  });

  // NO back-to-back "two rapid duplicates both land" test here, deliberately.
  // addOrUpdateLocalServerConfig mutates the in-memory Map SYNCHRONOUSLY before
  // it awaits the repository, so the second call's persisted array already
  // contains the first copy whether or not the lock is held — such a test
  // passes identically against the lock-free implementation it would exist to
  // prevent, which is exactly the vacuous shape this repo's testing standard
  // rules out. The gated case above is where duplicate's serialization is
  // actually observable.
});

/**
 * The #108 audit read duplicate's fresh id as proof that nothing was at risk,
 * and wrapped it in the lock for ordering alone. The id only ever settled the
 * question of clobbering an EXISTING record. Every OTHER field of the copy was
 * still spread off `config`, captured BEFORE the interactive pause — the tree
 * item's embedded snapshot, or pickLocalServer's quick pick, which the user can
 * sit on indefinitely. A folder rename, a rename, a cascade or an edit landing
 * in that window produced a copy of a record that no longer existed in that
 * shape: duplicate "Backend/Dev Server" while the folder is renamed to
 * "Platform" and the copy is filed under a folder nobody has any more.
 *
 * duplicate re-resolves the live record inside the lock, like rename /
 * moveToFolder / moveToRoot — but with no "bail on divergence" arm. Those own a
 * destination field a concurrent write could contradict; duplicate makes no
 * decision about the source at all, so the newest state is always what to copy.
 * The only bail is the source having been removed outright.
 *
 * Every concurrent change below is driven through addOrUpdateLocalServerConfig
 * or the rename command, NOT through renameFolder / removeFolderCascade: those
 * two rewrite `.group` IN PLACE on the very object getLocalServer hands back,
 * so a captured "stale" reference would already read the new value and the test
 * would pass against the broken implementation too.
 */
describe("nexus.localServer.duplicate re-resolves under the lock (issue #108 followups)", () => {
  function duplicateViaPicker(): {
    duplicating: Promise<unknown>;
    pick: Deferred<{ config: LocalServerConfig } | undefined>;
  } {
    const pick = deferred<{ config: LocalServerConfig } | undefined>();
    vi.mocked(vscode.window.showQuickPick).mockReturnValue(pick.promise as never);
    const cmd = registeredCommands.get("nexus.localServer.duplicate");
    expect(cmd).toBeDefined();
    // No arg — the palette path, so pickLocalServer's quick pick is the pause.
    return { duplicating: Promise.resolve(cmd!(undefined)), pick };
  }

  beforeEach(() => {
    vi.mocked(vscode.window.showQuickPick).mockReset();
    vi.mocked(vscode.window.showInputBox).mockReset();
  });

  it("copies the record as it is NOW, not as the picker captured it", async () => {
    // THE BUG. The picker embedded the record while it sat in "Backend" running
    // node. While the user thought about it, an edit moved it to "Platform" and
    // switched it to python. Building the copy from the picker's snapshot files
    // the duplicate under a folder that may no longer exist and resurrects the
    // superseded executable.
    const { core, repo } = await fixture([
      makeLocalServerConfig({ group: "Backend", executable: "node" })
    ]);
    const stale = core.getLocalServer("ls1")!;

    const { duplicating, pick } = duplicateViaPicker();
    await core.addOrUpdateLocalServerConfig({
      ...core.getLocalServer("ls1")!,
      group: "Platform",
      executable: "python"
    });

    pick.resolve({ config: stale });
    await duplicating;

    const copy = (await repo.getLocalServers()).find((c) => c.name === "Dev Server (copy)");
    expect(copy).toBeDefined();
    // Load-bearing: "Backend" / "node" here mean the copy was built from the
    // pre-picker snapshot instead of the live record.
    expect(copy!.group).toBe("Platform");
    expect(copy!.executable).toBe("python");
    expect(copy!.id).not.toBe("ls1");
  });

  it("names the copy after a concurrent rename, not the pre-picker name", async () => {
    // nexus.localServer.rename is its own lock-protected, live-rereading
    // command running independently of this picker. If it lands while the
    // picker is open, `${config.name} (copy)` off the snapshot names the
    // duplicate after a name that no longer exists anywhere.
    const { core, repo } = await fixture([makeLocalServerConfig({ name: "Dev Server" })]);
    const stale = core.getLocalServer("ls1")!;

    const { duplicating, pick } = duplicateViaPicker();

    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("Build Server");
    const renameCmd = registeredCommands.get("nexus.localServer.rename");
    expect(renameCmd).toBeDefined();
    await renameCmd!("ls1");
    expect(core.getLocalServer("ls1")!.name).toBe("Build Server");

    pick.resolve({ config: stale });
    await duplicating;

    // Load-bearing: "Dev Server (copy)" here means the stale name was copied.
    expect((await repo.getLocalServers()).map((c) => c.name).sort()).toEqual([
      "Build Server",
      "Build Server (copy)"
    ]);
  });

  it("does not resurrect a config removed while the picker was open", async () => {
    // The one bail duplicate needs: the source is gone, so there is nothing to
    // copy. Spreading the snapshot writes a fresh-id revival of a record the
    // user deliberately removed — under a NEW id, so removing it again means
    // finding a row nobody knowingly created.
    const { core, repo } = await fixture([makeLocalServerConfig()]);
    const stale = core.getLocalServer("ls1")!;

    const { duplicating, pick } = duplicateViaPicker();
    await core.removeLocalServerConfig("ls1");

    pick.resolve({ config: stale });
    await duplicating;

    expect(await repo.getLocalServers()).toEqual([]);
    expect(core.getSnapshot().localServers).toEqual([]);
  });
});
