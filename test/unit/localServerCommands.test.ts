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

vi.mock("../../src/services/configMutationLock", () => ({
  configMutationLock: { runExclusive: <T>(fn: () => Promise<T>) => fn() }
}));

vi.mock("../../src/services/local/localServerManager", () => ({
  LocalServerManager: class {},
  localServerDescription: (c: unknown) => String(c),
  localServerRemovalDisclosure: (c: unknown) => String(c)
}));

vi.mock("../../src/ui/webviewFormPanel", () => ({
  WebviewFormPanel: class { public static open() { return Promise.resolve(undefined); } }
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

beforeEach(() => {
  registeredCommands.clear();
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
 * `moveToFolder` and `moveToRoot` all resolve a config from the tree-item
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
