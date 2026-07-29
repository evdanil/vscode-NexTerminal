import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowInformationMessage = vi.fn();
const mockPromptGoToPath = vi.fn();

// Hand-rolled vscode mock, kept minimal — cwdSyncCommands.ts itself only
// touches `commands.registerCommand` and `window.showInformationMessage`.
// `promptGoToPath` (imported from fileCommands.ts) is mocked at the module
// boundary below instead of pulling in fileExplorerTreeProvider.ts's much
// larger vscode surface transitively.
vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    })
  },
  window: {
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args)
  }
}));

vi.mock("../../src/commands/fileCommands", () => ({
  promptGoToPath: (...args: unknown[]) => mockPromptGoToPath(...args)
}));

import {
  registerCwdSyncCommands,
  FOLLOW_TERMINAL_STATE_KEY,
  FIRST_SYNC_NUDGE_SHOWN_KEY
} from "../../src/commands/cwdSyncCommands";

interface ActiveSessionLike {
  id: string;
  serverId: string;
  terminalName: string;
}

interface Harness {
  ctx: CommandContext;
  globalStateStore: Map<string, unknown>;
  /** The focused session id this harness resolved to (unless overridden away
   * to `undefined`). §8.5(a)'s once-per-session toast is keyed by session id
   * in a *module-level* Set in cwdSyncCommands.ts, so reusing a literal id
   * (e.g. "session-1") across unrelated tests in this file would leak
   * "already shown" state between them — each `makeHarness()` call mints a
   * fresh id by default specifically to avoid that collision. */
  sessionId: string | undefined;
}

let sessionIdCounter = 0;

function makeHarness(overrides?: {
  activeServerId?: string | undefined;
  focusedSessionId?: string | undefined;
  activeSessions?: ActiveSessionLike[];
}): Harness {
  sessionIdCounter += 1;
  const defaultSessionId = `session-auto-${sessionIdCounter}`;
  const activeServerId = overrides && "activeServerId" in overrides ? overrides.activeServerId : "srv-1";
  const focusedSessionId = overrides && "focusedSessionId" in overrides ? overrides.focusedSessionId : defaultSessionId;
  const activeSessions = overrides?.activeSessions ?? [
    { id: defaultSessionId, serverId: "srv-1", terminalName: "Nexus SSH: Test" }
  ];

  const globalStateStore = new Map<string, unknown>();
  const globalState = {
    get: vi.fn((key: string, def?: unknown) => (globalStateStore.has(key) ? globalStateStore.get(key) : def)),
    update: vi.fn(async (key: string, value: unknown) => {
      globalStateStore.set(key, value);
    })
  };

  const cwdSyncCoordinator = {
    clearPin: vi.fn(),
    setFollowing: vi.fn(),
    resume: vi.fn(),
    notifyManualNavigation: vi.fn(),
    onSessionEnded: vi.fn()
  };

  const ctx: CommandContext = {
    core: {
      getSnapshot: vi.fn(() => ({ focusedSessionId, activeSessions })),
      getServer: vi.fn((id: string) => ({ id, name: `Server ${id}` }))
    } as any,
    tunnelManager: {} as any,
    serialSidecar: {} as any,
    sshFactory: {} as any,
    sshPool: {} as any,
    loggerFactory: {} as any,
    sessionLogDir: "",
    terminalsByServer: new Map(),
    sessionTerminals: new Map(),
    serialTerminals: new Map(),
    localShellTerminals: new Map(),
    highlighter: {} as any,
    macroAutoTrigger: {} as any,
    sftpService: {
      realpath: vi.fn(async (_serverId: string, p: string) => p),
      tryStat: vi.fn(async () => ({ isDirectory: true }))
    } as any,
    fileExplorerProvider: {
      getActiveServerId: vi.fn(() => activeServerId),
      getRootPath: vi.fn(() => "/home/dev"),
      getHomeDir: vi.fn(() => "/home/dev"),
      setRootPath: vi.fn()
    } as any,
    activityIndicators: new Map(),
    globalStoragePath: "",
    extensionPath: "",
    globalState: globalState as any,
    cwdTracker: {
      getRecord: vi.fn(() => undefined),
      isStale: vi.fn(() => false)
    } as any,
    cwdSyncCoordinator: cwdSyncCoordinator as any,
    cwdLastOutputAt: new Map<string, number>(),
    cwdSyncOutputChannel: { appendLine: vi.fn() } as any
  };

  return { ctx, globalStateStore, sessionId: focusedSessionId };
}

describe("cwdSyncCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  describe("follow / unfollow / resume", () => {
    it("nexus.files.followTerminal sets following on, clears the pin, and persists to globalState", () => {
      const { ctx, globalStateStore } = makeHarness();
      registerCwdSyncCommands(ctx);

      registeredCommands.get("nexus.files.followTerminal")!();

      expect(ctx.cwdSyncCoordinator!.setFollowing).toHaveBeenCalledWith(true);
      expect(ctx.cwdSyncCoordinator!.clearPin).toHaveBeenCalledTimes(1);
      expect(globalStateStore.get(FOLLOW_TERMINAL_STATE_KEY)).toBe(true);
    });

    it("nexus.files.unfollowTerminal sets following off and persists, without touching the pin", () => {
      const { ctx, globalStateStore } = makeHarness();
      registerCwdSyncCommands(ctx);

      registeredCommands.get("nexus.files.unfollowTerminal")!();

      expect(ctx.cwdSyncCoordinator!.setFollowing).toHaveBeenCalledWith(false);
      expect(ctx.cwdSyncCoordinator!.clearPin).not.toHaveBeenCalled();
      expect(globalStateStore.get(FOLLOW_TERMINAL_STATE_KEY)).toBe(false);
    });

    it("nexus.files.resumeFollowTerminal calls coordinator.resume()", () => {
      const { ctx } = makeHarness();
      registerCwdSyncCommands(ctx);

      registeredCommands.get("nexus.files.resumeFollowTerminal")!();

      expect(ctx.cwdSyncCoordinator!.resume).toHaveBeenCalledTimes(1);
    });

    it("all three toggle commands no-op gracefully when cwdSyncCoordinator is unavailable", () => {
      const { ctx } = makeHarness();
      delete (ctx as any).cwdSyncCoordinator;
      registerCwdSyncCommands(ctx);

      expect(() => {
        registeredCommands.get("nexus.files.followTerminal")!();
        registeredCommands.get("nexus.files.unfollowTerminal")!();
        registeredCommands.get("nexus.files.resumeFollowTerminal")!();
      }).not.toThrow();
    });
  });

  describe("nexus.files.syncFromTerminal — no-op guards", () => {
    it("no-ops when there is no active File Explorer server", async () => {
      const { ctx } = makeHarness({ activeServerId: undefined });
      registerCwdSyncCommands(ctx);

      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(ctx.fileExplorerProvider.setRootPath).not.toHaveBeenCalled();
      expect(mockShowInformationMessage).not.toHaveBeenCalled();
      expect(mockPromptGoToPath).not.toHaveBeenCalled();
    });

    it("no-ops when there is no focused SSH session", async () => {
      const { ctx } = makeHarness({ focusedSessionId: undefined });
      registerCwdSyncCommands(ctx);

      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(ctx.fileExplorerProvider.setRootPath).not.toHaveBeenCalled();
    });

    it("no-ops when the focused session is on a different server than the explorer", async () => {
      const { ctx } = makeHarness({
        activeServerId: "srv-1",
        focusedSessionId: "session-1",
        activeSessions: [{ id: "session-1", serverId: "srv-2", terminalName: "Nexus SSH: Other" }]
      });
      registerCwdSyncCommands(ctx);

      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(ctx.fileExplorerProvider.setRootPath).not.toHaveBeenCalled();
    });
  });

  describe("nexus.files.syncFromTerminal — resolution ladder", () => {
    it("step 1: uses a non-stale tracker record, clears the pin first, and re-roots immediately with no restartWatcher option", async () => {
      const { ctx } = makeHarness();
      (ctx.cwdTracker!.getRecord as any).mockReturnValue({
        sessionId: "session-1",
        serverId: "srv-1",
        cwd: "/var/log",
        source: "osc7",
        authority: "",
        updatedAt: 0
      });
      (ctx.cwdTracker!.isStale as any).mockReturnValue(false);
      (ctx.sftpService.realpath as any).mockResolvedValue("/var/log");
      (ctx.sftpService.tryStat as any).mockResolvedValue({ isDirectory: true });
      ctx.globalState.get = vi.fn(() => true); // nudge already shown — isolate this test to resolution behavior
      const callOrder: string[] = [];
      (ctx.cwdSyncCoordinator!.clearPin as any).mockImplementation(() => callOrder.push("clearPin"));
      (ctx.fileExplorerProvider.setRootPath as any).mockImplementation(() => callOrder.push("setRootPath"));

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(ctx.sftpService.realpath).toHaveBeenCalledWith("srv-1", "/var/log");
      expect(ctx.fileExplorerProvider.setRootPath).toHaveBeenCalledTimes(1);
      // Single-argument call — explicit navigation must NOT pass
      // { restartWatcher: false }; the watcher restarts immediately.
      expect((ctx.fileExplorerProvider.setRootPath as any).mock.calls[0]).toEqual(["/var/log"]);
      expect(callOrder).toEqual(["clearPin", "setRootPath"]);
      expect(mockPromptGoToPath).not.toHaveBeenCalled();
    });

    it("discards the validation when the explorer's active server changes during the awaits (cross-server race)", async () => {
      const { ctx, sessionId } = makeHarness({ activeServerId: "srv-1" });
      (ctx.cwdTracker!.getRecord as any).mockReturnValue({
        sessionId,
        serverId: "srv-1",
        cwd: "/var/log",
        source: "osc7",
        authority: "",
        updatedAt: 0
      });
      (ctx.cwdTracker!.isStale as any).mockReturnValue(false);
      (ctx.sftpService.realpath as any).mockImplementation(async (_serverId: string, p: string) => {
        // Simulate the explorer switching to a different server while
        // realpath() is still in flight (e.g. the user picked a different
        // server row in the File Explorer).
        (ctx.fileExplorerProvider.getActiveServerId as any).mockReturnValue("srv-2");
        return p;
      });
      (ctx.sftpService.tryStat as any).mockResolvedValue({ isDirectory: true });
      ctx.globalState.get = vi.fn(() => true);

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(ctx.fileExplorerProvider.setRootPath).not.toHaveBeenCalled();
    });

    it("discards the validation when the focused session changes during the awaits (cross-session race)", async () => {
      const { ctx, sessionId } = makeHarness({ activeServerId: "srv-1" });
      (ctx.cwdTracker!.getRecord as any).mockReturnValue({
        sessionId,
        serverId: "srv-1",
        cwd: "/var/log",
        source: "osc7",
        authority: "",
        updatedAt: 0
      });
      (ctx.cwdTracker!.isStale as any).mockReturnValue(false);
      (ctx.sftpService.realpath as any).mockImplementation(async (_serverId: string, p: string) => {
        // Simulate focus moving to a different SSH session (still on the
        // same server) while realpath() is still in flight.
        (ctx.core.getSnapshot as any).mockReturnValue({
          focusedSessionId: "other-session",
          activeSessions: [{ id: "other-session", serverId: "srv-1", terminalName: "Nexus SSH: Other" }]
        });
        return p;
      });
      (ctx.sftpService.tryStat as any).mockResolvedValue({ isDirectory: true });
      ctx.globalState.get = vi.fn(() => true);

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(ctx.fileExplorerProvider.setRootPath).not.toHaveBeenCalled();
    });

    it("falls through to the heuristic when the tracker record is stale", async () => {
      const { ctx, sessionId } = makeHarness();
      (ctx.cwdTracker!.getRecord as any).mockReturnValue({
        sessionId,
        serverId: "srv-1",
        cwd: "/stale/path",
        source: "osc7",
        authority: "",
        updatedAt: 0
      });
      (ctx.cwdTracker!.isStale as any).mockReturnValue(true);
      ctx.terminalRegistry = {
        get: vi.fn(() => ({ buffer: { getText: () => "dev@host:/etc$" } }))
      } as any;
      ctx.sessionTerminals.set(sessionId!, {} as any);
      (ctx.sftpService.realpath as any).mockResolvedValue("/etc");
      (ctx.sftpService.tryStat as any).mockResolvedValue({ isDirectory: true });
      ctx.globalState.get = vi.fn(() => true);

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(ctx.sftpService.realpath).toHaveBeenCalledWith("srv-1", "/etc");
      expect(ctx.fileExplorerProvider.setRootPath).toHaveBeenCalledWith("/etc");
    });

    it("step 2: heuristic fallback reads the focused terminal's scrollback via terminalRegistry when there is no tracker record", async () => {
      const { ctx, sessionId } = makeHarness();
      const terminalRef = { marker: "terminal-ref" };
      ctx.terminalRegistry = {
        get: vi.fn(() => ({ buffer: { getText: () => "banner line\ndev@host:/var/www$" } }))
      } as any;
      ctx.sessionTerminals.set(sessionId!, terminalRef as any);
      (ctx.sftpService.realpath as any).mockResolvedValue("/var/www");
      (ctx.sftpService.tryStat as any).mockResolvedValue({ isDirectory: true });
      ctx.globalState.get = vi.fn(() => true);

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(ctx.terminalRegistry!.get).toHaveBeenCalledWith(terminalRef);
      expect(ctx.sftpService.realpath).toHaveBeenCalledWith("srv-1", "/var/www");
      expect(ctx.fileExplorerProvider.setRootPath).toHaveBeenCalledWith("/var/www");
    });

    it("step 4: validation failure (not a directory) opens the goToPath prompt prefilled with the best candidate", async () => {
      const { ctx } = makeHarness();
      (ctx.cwdTracker!.getRecord as any).mockReturnValue({
        sessionId: "session-1",
        serverId: "srv-1",
        cwd: "/deleted/dir",
        source: "osc7",
        authority: "",
        updatedAt: 0
      });
      (ctx.cwdTracker!.isStale as any).mockReturnValue(false);
      (ctx.sftpService.tryStat as any).mockResolvedValue(undefined);
      mockPromptGoToPath.mockResolvedValue(undefined);
      ctx.globalState.get = vi.fn(() => true);

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(mockPromptGoToPath).toHaveBeenCalledWith(ctx, "/deleted/dir");
      expect(ctx.fileExplorerProvider.setRootPath).not.toHaveBeenCalled();
    });

    it("step 4: realpath failure also falls back to the prefilled prompt", async () => {
      const { ctx } = makeHarness();
      (ctx.cwdTracker!.getRecord as any).mockReturnValue({
        sessionId: "session-1",
        serverId: "srv-1",
        cwd: "/broken",
        source: "osc7",
        authority: "",
        updatedAt: 0
      });
      (ctx.cwdTracker!.isStale as any).mockReturnValue(false);
      (ctx.sftpService.realpath as any).mockRejectedValue(new Error("no such file"));
      mockPromptGoToPath.mockResolvedValue(undefined);
      ctx.globalState.get = vi.fn(() => true);

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(mockPromptGoToPath).toHaveBeenCalledWith(ctx, "/broken");
    });

    it("step 4: with no candidate at all, prefills the prompt with the current explorer root", async () => {
      const { ctx } = makeHarness();
      // no tracker record, and no terminalRegistry entry -> no heuristic candidate
      mockPromptGoToPath.mockResolvedValue(undefined);
      ctx.globalState.get = vi.fn(() => true);

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(mockPromptGoToPath).toHaveBeenCalledWith(ctx, "/home/dev");
    });

    it("step 4 success (the manual prompt resolves a path) counts as a successful sync — no incapability toast", async () => {
      const { ctx } = makeHarness();
      mockPromptGoToPath.mockResolvedValue("/typed/path");
      ctx.globalState.get = vi.fn(() => true);

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(mockShowInformationMessage).not.toHaveBeenCalledWith(
        expect.stringContaining("didn't report a directory")
      );
    });

    it("step 5: shows the once-per-session incapability message when nothing resolves, and only once", async () => {
      const { ctx } = makeHarness();
      mockPromptGoToPath.mockResolvedValue(undefined);
      ctx.globalState.get = vi.fn(() => true);

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        `"Server srv-1" didn't report a directory, so Nexus can't follow it. Directory sync is off for this session.`
      );
    });

    it("step 5: a different session gets its own incapability toast", async () => {
      const { ctx: ctxA } = makeHarness();
      mockPromptGoToPath.mockResolvedValue(undefined);
      ctxA.globalState.get = vi.fn(() => true);
      registerCwdSyncCommands(ctxA);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();
      expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);

      registeredCommands.clear();
      const { ctx: ctxB } = makeHarness({
        focusedSessionId: "session-2",
        activeSessions: [{ id: "session-2", serverId: "srv-1", terminalName: "Nexus SSH: Other" }]
      });
      mockPromptGoToPath.mockResolvedValue(undefined);
      ctxB.globalState.get = vi.fn(() => true);
      registerCwdSyncCommands(ctxB);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(mockShowInformationMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("§8.4 first-success nudge", () => {
    function makeSuccessfulHarness(): Harness {
      const harness = makeHarness();
      (harness.ctx.cwdTracker!.getRecord as any).mockReturnValue({
        sessionId: "session-1",
        serverId: "srv-1",
        cwd: "/var/log",
        source: "osc7",
        authority: "",
        updatedAt: 0
      });
      (harness.ctx.cwdTracker!.isStale as any).mockReturnValue(false);
      (harness.ctx.sftpService.realpath as any).mockResolvedValue("/var/log");
      (harness.ctx.sftpService.tryStat as any).mockResolvedValue({ isDirectory: true });
      return harness;
    }

    it("fires after the first successful sync, prefilled with the resolved path", async () => {
      const { ctx } = makeSuccessfulHarness();
      mockShowInformationMessage.mockResolvedValue("No Thanks");

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        "Synced the File Explorer to /var/log. Keep it on this terminal's directory from now on?",
        "Follow This Terminal",
        "No Thanks"
      );
    });

    it("clicking Follow This Terminal turns following on, clears the pin, and persists", async () => {
      const { ctx, globalStateStore } = makeSuccessfulHarness();
      mockShowInformationMessage.mockResolvedValue("Follow This Terminal");

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(ctx.cwdSyncCoordinator!.setFollowing).toHaveBeenCalledWith(true);
      // clearPin is called twice total: once by the resolution ladder itself
      // (step 3), once more from the nudge's Follow action.
      expect(ctx.cwdSyncCoordinator!.clearPin).toHaveBeenCalledTimes(2);
      expect(globalStateStore.get(FOLLOW_TERMINAL_STATE_KEY)).toBe(true);
    });

    it("clicking No Thanks does not turn following on", async () => {
      const { ctx } = makeSuccessfulHarness();
      mockShowInformationMessage.mockResolvedValue("No Thanks");

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(ctx.cwdSyncCoordinator!.setFollowing).not.toHaveBeenCalled();
    });

    it("never shows the nudge again after the first time, regardless of the user's choice", async () => {
      const { ctx } = makeSuccessfulHarness();
      mockShowInformationMessage.mockResolvedValue("No Thanks");

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);
    });

    it("does not fire again on a fresh command registration once globalState already records it shown", async () => {
      const { ctx, globalStateStore } = makeSuccessfulHarness();
      globalStateStore.set(FIRST_SYNC_NUDGE_SHOWN_KEY, true);

      registerCwdSyncCommands(ctx);
      await registeredCommands.get("nexus.files.syncFromTerminal")!();

      expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });

    it("marks the nudge shown before awaiting the user's choice (act-on-click, no second modal)", async () => {
      const { ctx, globalStateStore } = makeSuccessfulHarness();
      let resolveChoice: ((value: string | undefined) => void) | undefined;
      mockShowInformationMessage.mockImplementation(
        () => new Promise<string | undefined>((resolve) => { resolveChoice = resolve; })
      );

      registerCwdSyncCommands(ctx);
      const pending = registeredCommands.get("nexus.files.syncFromTerminal")!();

      // Let every microtask up to the awaited showInformationMessage call run.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(globalStateStore.get(FIRST_SYNC_NUDGE_SHOWN_KEY)).toBe(true);

      resolveChoice?.(undefined);
      await pending;
    });
  });
});
