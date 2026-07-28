import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CwdSyncCoordinator,
  type CwdSyncActiveSessionLike,
  type CwdSyncDeps
} from "../../src/services/sftp/cwdSyncCoordinator";
import type { CwdRecord } from "../../src/services/terminal/cwdTracker";

// No `vi.mock("vscode")` anywhere in this file — the coordinator must not
// need one (§5.1 purity constraint). Every dependency is a plain fake.

function makeRecord(overrides: Partial<CwdRecord> = {}): CwdRecord {
  return {
    sessionId: "s1",
    serverId: "srv-1",
    cwd: "/home/dev",
    source: "osc7",
    authority: "",
    updatedAt: 0,
    ...overrides
  };
}

/**
 * A plain fake satisfying `CwdTrackerLike`, with a test-only `.fire()` hook
 * that both stores the record and invokes the registered listener directly —
 * bypassing the real `CwdTracker`'s own 300ms-per-session rate limit
 * (`CWD_MIN_INTERVAL_MS`), which otherwise makes it impossible to deliver a
 * burst of same-session events closer together than the coordinator's own
 * 250ms debounce window. See the coordinator module's header comment.
 */
function makeFakeTracker() {
  const records = new Map<string, CwdRecord>();
  const disabled = new Set<string>();
  const stale = new Set<string>();
  let listener: ((record: CwdRecord) => void) | undefined;

  return {
    records,
    disabled,
    stale,
    getRecord: vi.fn((sessionId: string) => records.get(sessionId)),
    isDisabled: vi.fn((sessionId: string) => disabled.has(sessionId)),
    isStale: vi.fn((sessionId: string, _now: number, _lastOutputAt: number | undefined) => stale.has(sessionId)),
    clear: vi.fn((sessionId: string) => {
      records.delete(sessionId);
      disabled.delete(sessionId);
      stale.delete(sessionId);
    }),
    onDidChangeCwd: vi.fn((l: (record: CwdRecord) => void) => {
      listener = l;
      return () => {
        if (listener === l) listener = undefined;
      };
    }),
    fire(record: CwdRecord): void {
      records.set(record.sessionId, record);
      listener?.(record);
    }
  };
}

function makeFakeProvider() {
  const state: { activeServerId: string | undefined; rootPath: string | undefined; busy: boolean } = {
    activeServerId: undefined,
    rootPath: undefined,
    busy: false
  };
  return {
    state,
    getActiveServerId: vi.fn(() => state.activeServerId),
    getRootPath: vi.fn(() => state.rootPath),
    setRootPath: vi.fn((rootPath: string, _opts?: { restartWatcher?: boolean }) => {
      state.rootPath = rootPath;
    }),
    isBusy: vi.fn(() => state.busy)
  };
}

function makeFakeSftp() {
  return {
    // Identity by default: realpath just echoes what it's given.
    realpath: vi.fn(async (_serverId: string, remotePath: string) => remotePath),
    tryStat: vi.fn(async (_serverId: string, _remotePath: string) => ({ isDirectory: true }))
  };
}

function makeFakeCore() {
  const state: { focusedSessionId: string | undefined; activeSessions: CwdSyncActiveSessionLike[] } = {
    focusedSessionId: undefined,
    activeSessions: []
  };
  let listener: (() => void) | undefined;
  return {
    state,
    getSnapshot: vi.fn(() => ({
      focusedSessionId: state.focusedSessionId,
      activeSessions: state.activeSessions
    })),
    onDidChange: vi.fn((l: () => void) => {
      listener = l;
      return () => {
        if (listener === l) listener = undefined;
      };
    }),
    /** Test-only: simulate a `NexusCore.onDidChange` tick (e.g. tunnel traffic, or a real focus change). */
    fireChange(): void {
      listener?.();
    }
  };
}

function setup(opts?: { debounceMs?: number }) {
  const tracker = makeFakeTracker();
  const provider = makeFakeProvider();
  const sftp = makeFakeSftp();
  const core = makeFakeCore();
  const log = vi.fn();
  const clock = { now: 0 };

  const deps: CwdSyncDeps = {
    tracker,
    provider,
    sftp,
    core,
    log,
    now: () => clock.now,
    lastOutputAt: () => undefined,
    debounceMs: opts?.debounceMs
  };
  const coordinator = new CwdSyncCoordinator(deps);

  return { tracker, provider, sftp, core, log, clock, coordinator };
}

const DEBOUNCE_MS = 250;

describe("CwdSyncCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Following off (default) ────────────────────────────────────────────

  it("does not apply anything while following is off (default state)", async () => {
    const { tracker, provider, core } = setup();
    core.state.focusedSessionId = "s1";
    provider.state.activeServerId = "srv-1";

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(provider.setRootPath).not.toHaveBeenCalled();
  });

  // ─── Arbitration rules (§5.3) ────────────────────────────────────────────

  it("does not apply, and reports state 'otherServer', when the focused session is on a different server than the explorer", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-A", terminalName: "Nexus (SSH): host-a" }];
    provider.state.activeServerId = "srv-B"; // explorer is on a different server

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-A", cwd: "/var/log" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(provider.setRootPath).not.toHaveBeenCalled();
    expect(coordinator.getState()).toEqual({
      kind: "otherServer",
      terminalName: "Nexus (SSH): host-a",
      otherServerId: "srv-A"
    });
  });

  it("does not apply when the reporting session is not the focused session", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    core.state.focusedSessionId = "s2"; // a different session is focused
    provider.state.activeServerId = "srv-1";

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(provider.setRootPath).not.toHaveBeenCalled();
  });

  it("re-applies the newly focused session's tracked cwd on a focus change, and an unrelated tick does no work at all", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a" }));
    tracker.records.set("s2", makeRecord({ sessionId: "s2", serverId: "srv-1", cwd: "/b" }));

    // Genuine focus transition: undefined -> s1.
    core.state.focusedSessionId = "s1";
    core.fireChange();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(provider.setRootPath).toHaveBeenCalledWith("/a", { restartWatcher: false });

    provider.getActiveServerId.mockClear();
    provider.isBusy.mockClear();
    provider.setRootPath.mockClear();
    tracker.getRecord.mockClear();

    // Unrelated tick (e.g. tunnel traffic): focusedSessionId unchanged.
    core.fireChange();
    expect(tracker.getRecord).not.toHaveBeenCalled();
    expect(provider.getActiveServerId).not.toHaveBeenCalled();
    expect(provider.isBusy).not.toHaveBeenCalled();
    expect(provider.setRootPath).not.toHaveBeenCalled();

    // Genuine focus transition: s1 -> s2.
    core.state.focusedSessionId = "s2";
    core.fireChange();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(provider.setRootPath).toHaveBeenCalledWith("/b", { restartWatcher: false });
  });

  it("buffers the latest cwd while the view is hidden (no SFTP traffic) and applies it once on re-show", async () => {
    const { tracker, provider, sftp, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(false); // hidden
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a" }));
    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/b" })); // supersedes the buffer
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(sftp.realpath).not.toHaveBeenCalled();
    expect(provider.setRootPath).not.toHaveBeenCalled();

    coordinator.setViewVisible(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(provider.setRootPath).toHaveBeenCalledTimes(1);
    expect(provider.setRootPath).toHaveBeenCalledWith("/b", { restartWatcher: false });
  });

  it("coalesces a burst of changes within the debounce window into a single setRootPath call", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a" }));
    await vi.advanceTimersByTimeAsync(50);
    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/b" }));
    await vi.advanceTimersByTimeAsync(50);
    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/c" }));

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(provider.setRootPath).toHaveBeenCalledTimes(1);
    expect(provider.setRootPath).toHaveBeenCalledWith("/c", { restartWatcher: false });
  });

  it("does not call setRootPath when the resolved path equals the current root", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    provider.state.rootPath = "/home/dev";
    core.state.focusedSessionId = "s1";

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/home/dev" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(provider.setRootPath).not.toHaveBeenCalled();
  });

  it("suppresses apply while the explorer reports itself busy (§7.4)", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    provider.state.busy = true;
    core.state.focusedSessionId = "s1";

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(provider.setRootPath).not.toHaveBeenCalled();
  });

  // ─── Pin / resume (§8.3) ─────────────────────────────────────────────────

  it("blocks apply while pinned by notifyManualNavigation(), and resume() re-roots immediately", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];
    tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));

    coordinator.notifyManualNavigation();
    expect(coordinator.getState().kind).toBe("pinned");

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/etc" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(provider.setRootPath).not.toHaveBeenCalled();

    coordinator.resume();
    await vi.advanceTimersByTimeAsync(0); // "immediate" — no debounce wait needed
    expect(provider.setRootPath).toHaveBeenCalledWith("/etc", { restartWatcher: false });
  });

  it("clearPin() clears an existing pin without itself triggering an apply", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];
    tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));

    coordinator.notifyManualNavigation();
    expect(coordinator.getState().kind).toBe("pinned");

    coordinator.clearPin();
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.setRootPath).not.toHaveBeenCalled(); // clearPin itself never applies
    expect(coordinator.getState().kind).not.toBe("pinned");

    // Pin is gone — a subsequent tracker change now applies normally.
    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/etc" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(provider.setRootPath).toHaveBeenCalledWith("/etc", { restartWatcher: false });
  });

  it("clearPin() is a no-op when nothing is pinned", () => {
    const { coordinator } = setup();
    coordinator.setFollowing(true);
    expect(() => coordinator.clearPin()).not.toThrow();
  });

  it("does not pin from mere getChildren-style activity — only notifyManualNavigation() pins", () => {
    const { provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];

    // Simulates expanding a subtree: no notifyManualNavigation() call is made,
    // because the wiring agent must not route getChildren through it (§8.3).
    expect(coordinator.getState().kind).not.toBe("pinned");
  });

  it("clears the pin when following is toggled off then back on", () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];
    tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/pinned" }));

    coordinator.notifyManualNavigation();
    expect(coordinator.getState().kind).toBe("pinned");

    coordinator.setFollowing(false);
    coordinator.setFollowing(true);
    expect(coordinator.getState().kind).not.toBe("pinned");
  });

  // ─── Lifecycle holes (§5.4) ──────────────────────────────────────────────

  it("onSessionEnded() clears tracker state for the session, and clears the pin only if it belonged to that session", () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];
    tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/pinned" }));

    coordinator.notifyManualNavigation(); // pin belongs to s1, the currently focused session
    expect(coordinator.getState().kind).toBe("pinned");

    coordinator.onSessionEnded("s2"); // an unrelated session ends
    expect(tracker.clear).toHaveBeenCalledWith("s2");
    expect(tracker.clear).not.toHaveBeenCalledWith("s1");
    expect(coordinator.getState().kind).toBe("pinned"); // pin survives

    coordinator.onSessionEnded("s1"); // the session the pin belongs to ends
    expect(tracker.clear).toHaveBeenCalledWith("s1");
    expect(coordinator.getState().kind).not.toBe("pinned");
  });

  // ─── SFTP failure handling (§5.4 hole c) ─────────────────────────────────

  it("swallows a realpath rejection, logs it, and never throws or calls setRootPath", async () => {
    const { tracker, provider, sftp, core, log, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    sftp.realpath.mockRejectedValueOnce(new Error("No SFTP session for server srv-1"));

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(provider.setRootPath).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("No SFTP session for server srv-1"));
  });

  it("swallows a tryStat rejection, logs it, and never throws or calls setRootPath", async () => {
    const { tracker, provider, sftp, core, log, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    sftp.tryStat.mockRejectedValueOnce(new Error("stat exploded"));

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(provider.setRootPath).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("stat exploded"));
  });

  it("drops the apply when tryStat resolves a non-directory", async () => {
    const { tracker, provider, sftp, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    sftp.tryStat.mockResolvedValueOnce({ isDirectory: false });

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log/file.txt" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(provider.setRootPath).not.toHaveBeenCalled();
  });

  it("drops the apply when tryStat resolves undefined (path no longer exists)", async () => {
    const { tracker, provider, sftp, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    sftp.tryStat.mockResolvedValueOnce(undefined);

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/gone" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(provider.setRootPath).not.toHaveBeenCalled();
  });

  it("always calls setRootPath with { restartWatcher: false }, on both the debounced and immediate paths", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(provider.setRootPath).toHaveBeenLastCalledWith("/a", { restartWatcher: false });

    coordinator.notifyManualNavigation();
    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/b" }));
    coordinator.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.setRootPath).toHaveBeenLastCalledWith("/b", { restartWatcher: false });
  });

  // ─── getState() — the seven states (§8.2) ────────────────────────────────

  it("getState(): 'off' when following is disabled (default)", () => {
    const { coordinator } = setup();
    expect(coordinator.getState()).toEqual({ kind: "off" });
  });

  it("getState(): 'following' when on, matched, and the report is fresh", () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "Nexus (SSH): host" }];
    tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a", updatedAt: 0 }));

    expect(coordinator.getState()).toEqual({ kind: "following", terminalName: "Nexus (SSH): host" });
  });

  it("getState(): 'noSource' when matched but the host has never reported a directory", () => {
    const { provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "Nexus (SSH): host" }];

    expect(coordinator.getState()).toEqual({ kind: "noSource", terminalName: "Nexus (SSH): host" });
  });

  it("getState(): 'stale' when tracker.isStale() reports true", () => {
    const { tracker, provider, core, clock, coordinator } = setup();
    coordinator.setFollowing(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "Nexus (SSH): host" }];
    tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a", updatedAt: 1_000 }));
    tracker.stale.add("s1");
    clock.now = 61_000;

    expect(coordinator.getState()).toEqual({
      kind: "stale",
      terminalName: "Nexus (SSH): host",
      cwd: "/a",
      ageMs: 60_000
    });
  });

  it("getState(): 'pinned' while paused, including the last tracked cwd", () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "Nexus (SSH): host" }];
    tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/pinned/path" }));

    coordinator.notifyManualNavigation();

    expect(coordinator.getState()).toEqual({
      kind: "pinned",
      terminalName: "Nexus (SSH): host",
      trackedCwd: "/pinned/path"
    });
  });

  it("getState(): 'otherServer' when the focused session's server differs from the explorer's", () => {
    const { provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    provider.state.activeServerId = "srv-B";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-A", terminalName: "Nexus (SSH): host-a" }];

    expect(coordinator.getState()).toEqual({
      kind: "otherServer",
      terminalName: "Nexus (SSH): host-a",
      otherServerId: "srv-A"
    });
  });

  it("getState(): 'rateLimited' when the tracker's burst detector has tripped", () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "Nexus (SSH): host" }];
    tracker.disabled.add("s1");

    expect(coordinator.getState()).toEqual({ kind: "rateLimited", terminalName: "Nexus (SSH): host" });
  });

  // ─── onDidChangeState ────────────────────────────────────────────────────

  it("onDidChangeState() fires on a following toggle, and the returned unsubscribe stops further notifications", () => {
    const { coordinator } = setup();
    const listener = vi.fn();
    const unsubscribe = coordinator.onDidChangeState(listener);

    coordinator.setFollowing(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    coordinator.setFollowing(false);
    expect(listener).toHaveBeenCalledTimes(1); // no further calls after unsubscribe
  });

  // ─── dispose() ───────────────────────────────────────────────────────────

  it("dispose() is idempotent and cancels a pending debounce", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a" }));

    coordinator.dispose();
    expect(() => coordinator.dispose()).not.toThrow();

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(provider.setRootPath).not.toHaveBeenCalled();

    // Further tracker/core events after dispose must also do nothing — the
    // subscriptions themselves were torn down, not just the pending timer.
    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/b" }));
    core.fireChange();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(provider.setRootPath).not.toHaveBeenCalled();
  });
});
