import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CwdSyncCoordinator,
  FRESHNESS_POLL_MS,
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
    reenable: vi.fn((sessionId: string) => {
      disabled.delete(sessionId);
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
  let idleListener: (() => void) | undefined;
  return {
    state,
    getActiveServerId: vi.fn(() => state.activeServerId),
    getRootPath: vi.fn(() => state.rootPath),
    setRootPath: vi.fn((rootPath: string, _opts?: { restartWatcher?: boolean }) => {
      state.rootPath = rootPath;
    }),
    isBusy: vi.fn(() => state.busy),
    onDidChangeBusy: vi.fn((l: () => void) => {
      idleListener = l;
      return () => {
        if (idleListener === l) idleListener = undefined;
      };
    }),
    /**
     * Test-only helper mirroring the real `FileExplorerTreeProvider`'s
     * true->false edge detection: fires the registered `onDidChangeBusy`
     * listener exactly when `busy` transitions from true to false, never
     * otherwise. Tests that only care about `isBusy()`'s return value (not
     * the edge-triggered retry signal) can still set `state.busy` directly.
     */
    setBusy(next: boolean): void {
      const was = state.busy;
      state.busy = next;
      if (was && !next) {
        idleListener?.();
      }
    }
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

  it("defers apply while the explorer reports itself busy — never drops it (§7.4 bug 1)", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    provider.setBusy(true);
    core.state.focusedSessionId = "s1";

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // While busy, the report must NOT be dropped — it is deferred.
    expect(provider.setRootPath).not.toHaveBeenCalled();

    // Once the explorer goes idle, the deferred report is applied.
    provider.setBusy(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(provider.setRootPath).toHaveBeenCalledWith("/var/log", { restartWatcher: false });
  });

  // ─── Busy buffering (§7.4 bug 1 — "cwd reports silently dropped while the
  // explorer is busy") ───────────────────────────────────────────────────────

  describe("busy buffering (§7.4 bug 1)", () => {
    it("buffers a burst while busy, latest wins, and applies only the latest once idle", async () => {
      const { tracker, provider, sftp, core, coordinator } = setup();
      coordinator.setFollowing(true);
      coordinator.setViewVisible(true);
      provider.state.activeServerId = "srv-1";
      provider.setBusy(true);
      core.state.focusedSessionId = "s1";

      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a" }));
      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/b" })); // supersedes the buffer
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(sftp.realpath).not.toHaveBeenCalled();
      expect(provider.setRootPath).not.toHaveBeenCalled();

      provider.setBusy(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).toHaveBeenCalledTimes(1);
      expect(provider.setRootPath).toHaveBeenCalledWith("/b", { restartWatcher: false });
    });

    it("re-runs full arbitration on idle — a busy-buffered record is discarded if the server changed in the meantime", async () => {
      const { tracker, provider, core, coordinator } = setup();
      coordinator.setFollowing(true);
      coordinator.setViewVisible(true);
      provider.state.activeServerId = "srv-1";
      provider.setBusy(true);
      core.state.focusedSessionId = "s1";
      core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];

      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(provider.setRootPath).not.toHaveBeenCalled();

      // Explorer moves to a different server while still busy.
      provider.state.activeServerId = "srv-2";
      coordinator.notifyExplorerServerChanged();

      provider.setBusy(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).not.toHaveBeenCalled();
    });

    it("discards a busy-buffered record when the owning session ends before idle", async () => {
      const { tracker, provider, core, coordinator } = setup();
      coordinator.setFollowing(true);
      coordinator.setViewVisible(true);
      provider.state.activeServerId = "srv-1";
      provider.setBusy(true);
      core.state.focusedSessionId = "s1";

      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(provider.setRootPath).not.toHaveBeenCalled();

      coordinator.onSessionEnded("s1");

      provider.setBusy(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).not.toHaveBeenCalled();
    });

    it("discards a busy-buffered record when following is turned off before idle", async () => {
      const { tracker, provider, core, coordinator } = setup();
      coordinator.setFollowing(true);
      coordinator.setViewVisible(true);
      provider.state.activeServerId = "srv-1";
      provider.setBusy(true);
      core.state.focusedSessionId = "s1";

      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(provider.setRootPath).not.toHaveBeenCalled();

      coordinator.setFollowing(false);
      coordinator.setFollowing(true); // back on — must not resurrect the old buffered record

      provider.setBusy(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).not.toHaveBeenCalled();
    });

    it("discards a busy-buffered record superseded by a newer record that resolves before idle (generation token)", async () => {
      const { tracker, provider, sftp, core, coordinator } = setup();
      coordinator.setFollowing(true);
      coordinator.setViewVisible(true);
      provider.state.activeServerId = "srv-1";
      core.state.focusedSessionId = "s1";

      // First record arrives, debounce fires, but realpath() never resolves
      // before the explorer becomes busy mid-flight.
      let releaseRealpath: ((path: string) => void) | undefined;
      (sftp.realpath as any).mockImplementationOnce(
        () => new Promise<string>((resolve) => { releaseRealpath = resolve; })
      );
      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a" }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // realpath("/a") now pending

      provider.setBusy(true);
      releaseRealpath?.("/a");
      await vi.advanceTimersByTimeAsync(0); // arbitration recheck sees busy -> buffers "/a"
      expect(provider.setRootPath).not.toHaveBeenCalled();

      // A newer record for the same session supersedes the buffered one.
      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/b" }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // also buffered (still busy) — latest wins

      provider.setBusy(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).toHaveBeenCalledTimes(1);
      expect(provider.setRootPath).toHaveBeenCalledWith("/b", { restartWatcher: false });
    });

    it("buffers (rather than drops) a record that becomes stale-context mid-flight because the explorer went busy while realpath() was in flight", async () => {
      const { tracker, provider, sftp, core, coordinator } = setup();
      coordinator.setFollowing(true);
      coordinator.setViewVisible(true);
      provider.state.activeServerId = "srv-1";
      core.state.focusedSessionId = "s1";

      let releaseRealpath: ((path: string) => void) | undefined;
      (sftp.realpath as any).mockImplementationOnce(
        () => new Promise<string>((resolve) => { releaseRealpath = resolve; })
      );

      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // realpath("/var/log") now pending, not yet busy

      // Explorer becomes busy (e.g. a tree refresh) while the realpath call is in flight.
      provider.setBusy(true);
      releaseRealpath?.("/var/log");
      await vi.advanceTimersByTimeAsync(0);

      // Must not be dropped — buffered for retry.
      expect(provider.setRootPath).not.toHaveBeenCalled();

      provider.setBusy(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).toHaveBeenCalledWith("/var/log", { restartWatcher: false });
    });

    it("does nothing on idle when nothing was buffered", async () => {
      const { provider, coordinator } = setup();
      coordinator.setFollowing(true);
      coordinator.setViewVisible(true);
      provider.state.activeServerId = "srv-1";

      provider.setBusy(true);
      provider.setBusy(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).not.toHaveBeenCalled();
    });

    it("P1 fix (§7.4): a stale in-flight record's mid-flight abandon must not clobber a newer already-buffered record", async () => {
      const { tracker, provider, sftp, core, coordinator } = setup();
      coordinator.setFollowing(true);
      coordinator.setViewVisible(true);
      provider.state.activeServerId = "srv-1";
      core.state.focusedSessionId = "s1";

      // Step 1: record A dispatches (debounce fires) and its realpath() call
      // hangs, simulating an in-flight resolve.
      let releaseRealpathA: ((path: string) => void) | undefined;
      (sftp.realpath as any).mockImplementationOnce(
        () => new Promise<string>((resolve) => { releaseRealpathA = resolve; })
      );
      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a" }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // resolveAndApply(A) dispatched; realpath("/a") pending

      // Step 2: the explorer goes busy while A is still in flight.
      provider.setBusy(true);

      // Step 3: a newer record B arrives for the same session WHILE busy is
      // true and A's realpath() has not yet resolved -> considerApply(B)
      // buffers it immediately (busyBuffer = B), *before* A's mid-flight
      // abandon ever runs.
      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/b" }));

      // Step 4: A's realpath() now resolves. The generation check / mid-flight
      // arbitration recheck fails (busy), triggering abandonMidFlight(A) —
      // which must NOT overwrite the newer buffered B with the stale A.
      releaseRealpathA?.("/a");
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.setRootPath).not.toHaveBeenCalled();

      // Step 5: busy clears -> the buffered record is replayed. It must be
      // B (the newer report), never the stale A.
      provider.setBusy(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).toHaveBeenCalledTimes(1);
      expect(provider.setRootPath).toHaveBeenCalledWith("/b", { restartWatcher: false });
    });

    it("a buffered record still survives a mid-flight abandon that is not superseded (plain deferral, v2.8.71)", async () => {
      const { tracker, provider, sftp, core, coordinator } = setup();
      coordinator.setFollowing(true);
      coordinator.setViewVisible(true);
      provider.state.activeServerId = "srv-1";
      core.state.focusedSessionId = "s1";

      let releaseRealpath: ((path: string) => void) | undefined;
      (sftp.realpath as any).mockImplementationOnce(
        () => new Promise<string>((resolve) => { releaseRealpath = resolve; })
      );

      // Only one record ever arrives; nothing supersedes it. The explorer
      // becomes busy purely because of unrelated activity (e.g. a tree
      // refresh), not because a newer record was buffered.
      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/only" }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // realpath("/only") pending, not yet busy

      provider.setBusy(true);
      releaseRealpath?.("/only");
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).not.toHaveBeenCalled();

      provider.setBusy(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).toHaveBeenCalledTimes(1);
      expect(provider.setRootPath).toHaveBeenCalledWith("/only", { restartWatcher: false });
    });

    it("dispose() clears any busy-buffered record and stops listening for idle", async () => {
      const { tracker, provider, core, coordinator } = setup();
      coordinator.setFollowing(true);
      coordinator.setViewVisible(true);
      provider.state.activeServerId = "srv-1";
      provider.setBusy(true);
      core.state.focusedSessionId = "s1";

      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      coordinator.dispose();
      provider.setBusy(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).not.toHaveBeenCalled();
    });
  });

  // ─── Hidden buffering, mid-flight (the `hiddenBuffer` half of
  // `abandonMidFlight` — symmetric with the busy half above) ────────────────

  describe("hidden buffering (mid-flight view-hide)", () => {
    it("buffers (rather than drops) a record that becomes stale-context mid-flight because the view was hidden while realpath() was in flight", async () => {
      const { tracker, provider, sftp, core, coordinator } = setup();
      coordinator.setFollowing(true);
      coordinator.setViewVisible(true);
      provider.state.activeServerId = "srv-1";
      core.state.focusedSessionId = "s1";

      let releaseRealpath: ((path: string) => void) | undefined;
      (sftp.realpath as any).mockImplementationOnce(
        () => new Promise<string>((resolve) => { releaseRealpath = resolve; })
      );

      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/var/log" }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // realpath("/var/log") now pending, view still visible

      // The user collapses/hides the File Explorer view while the realpath
      // call is in flight. The explorer is NOT busy — so the busy half of
      // `abandonMidFlight` cannot save this record.
      coordinator.setViewVisible(false);
      expect(provider.isBusy()).toBe(false);

      releaseRealpath?.("/var/log");
      await vi.advanceTimersByTimeAsync(0);

      // Must not be dropped — buffered for the re-show replay.
      expect(provider.setRootPath).not.toHaveBeenCalled();

      coordinator.setViewVisible(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).toHaveBeenCalledTimes(1);
      expect(provider.setRootPath).toHaveBeenCalledWith("/var/log", { restartWatcher: false });
    });

    it("a stale in-flight record's mid-flight abandon must not clobber a newer already-hidden-buffered record", async () => {
      const { tracker, provider, sftp, core, coordinator } = setup();
      coordinator.setFollowing(true);
      coordinator.setViewVisible(true);
      provider.state.activeServerId = "srv-1";
      core.state.focusedSessionId = "s1";

      // Record A dispatches and its realpath() hangs.
      let releaseRealpathA: ((path: string) => void) | undefined;
      (sftp.realpath as any).mockImplementationOnce(
        () => new Promise<string>((resolve) => { releaseRealpathA = resolve; })
      );
      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a" }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      // View is hidden, then a newer record B arrives and is hidden-buffered.
      coordinator.setViewVisible(false);
      tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/b" }));

      // A's realpath() finally resolves — its abandon path must not overwrite B.
      releaseRealpathA?.("/a");
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.setRootPath).not.toHaveBeenCalled();

      coordinator.setViewVisible(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).toHaveBeenCalledTimes(1);
      expect(provider.setRootPath).toHaveBeenCalledWith("/b", { restartWatcher: false });
    });
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

  // ─── Rate-limit recovery (§7.3/§8.2 state 7) ─────────────────────────────

  it("setFollowing(true) re-enables the focused session's tracker, so a rate-limit shutdown does not survive an off/on toggle", () => {
    const { tracker, provider, core, coordinator } = setup();
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];
    coordinator.setFollowing(true);
    tracker.disabled.add("s1");
    expect(coordinator.getState().kind).toBe("rateLimited");

    coordinator.setFollowing(false);
    coordinator.setFollowing(true);

    expect(tracker.reenable).toHaveBeenCalledWith("s1");
  });

  // ─── Turning Follow on applies an already-tracked cwd ────────────────────

  describe("setFollowing(true) immediate apply", () => {
    it("applies the focused session's already-tracked cwd right away when the explorer is idle and visible", async () => {
      const { tracker, provider, core, coordinator } = setup();
      provider.state.activeServerId = "srv-1";
      core.state.focusedSessionId = "s1";
      core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];
      tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/already/here" }));
      coordinator.setViewVisible(true);

      coordinator.setFollowing(true);
      // Goes through the `{ immediate: true }` path — no debounce wait.
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.setRootPath).toHaveBeenCalledTimes(1);
      expect(provider.setRootPath).toHaveBeenCalledWith("/already/here", { restartWatcher: false });
    });

    it("does nothing extra when the explorer is busy at the instant following is enabled", async () => {
      const { tracker, provider, core, coordinator } = setup();
      provider.state.activeServerId = "srv-1";
      core.state.focusedSessionId = "s1";
      core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];
      tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/already/here" }));
      coordinator.setViewVisible(true);
      provider.setBusy(true);

      coordinator.setFollowing(true);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(provider.setRootPath).not.toHaveBeenCalled();

      // Nothing was buffered either — enabling must not resurrect a decision
      // the user never made (see "discards a busy-buffered record when
      // following is turned off before idle").
      provider.setBusy(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.setRootPath).not.toHaveBeenCalled();
    });

    it("does nothing extra when the view is hidden at the instant following is enabled", async () => {
      const { tracker, provider, core, coordinator } = setup();
      provider.state.activeServerId = "srv-1";
      core.state.focusedSessionId = "s1";
      core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];
      tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/already/here" }));

      coordinator.setFollowing(true); // view has never been shown
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(provider.setRootPath).not.toHaveBeenCalled();
    });
  });

  it("does not call tracker.reenable() when no session is focused", () => {
    const { tracker, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setFollowing(false);
    coordinator.setFollowing(true);

    expect(tracker.reenable).not.toHaveBeenCalled();
  });

  // ─── Explorer-server-change hook (§8.3) ──────────────────────────────────

  it("notifyExplorerServerChanged() clears an existing pin", () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];
    tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/pinned" }));

    coordinator.notifyManualNavigation();
    expect(coordinator.getState().kind).toBe("pinned");

    coordinator.notifyExplorerServerChanged();
    expect(coordinator.getState().kind).not.toBe("pinned");
  });

  it("notifyExplorerServerChanged() re-evaluates the focused session's tracked record against the newly active server", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-2", terminalName: "term-1" }];
    tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-2", cwd: "/new-server-root" }));

    // Explorer was on srv-1 (mismatch); the user switches it to srv-2.
    provider.state.activeServerId = "srv-2";
    coordinator.notifyExplorerServerChanged();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(provider.setRootPath).toHaveBeenCalledWith("/new-server-root", { restartWatcher: false });
  });

  it("notifyExplorerServerChanged() invalidates a same-session apply already in flight for the old server", async () => {
    const { tracker, provider, sftp, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];

    let releaseRealpath: ((path: string) => void) | undefined;
    (sftp.realpath as any).mockImplementationOnce(
      () => new Promise<string>((resolve) => { releaseRealpath = resolve; })
    );

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // debounce fires, realpath("/a") issued and now pending

    // Explorer switches server while realpath() is still in flight.
    provider.state.activeServerId = "srv-2";
    coordinator.notifyExplorerServerChanged();

    releaseRealpath?.("/a");
    await vi.advanceTimersByTimeAsync(0);

    expect(provider.setRootPath).not.toHaveBeenCalled();
  });

  // ─── Generation-token race fix (out-of-order completion) ─────────────────

  it("a slow record and a fast, newer record resolving out of order land on the newer one, never the stale one", async () => {
    const { tracker, provider, sftp, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";

    let resolveSlow: ((path: string) => void) | undefined;
    (sftp.realpath as any).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveSlow = resolve; })
    );

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // debounce fires; realpath("/a") pending, held open

    // A newer record for the same session arrives and debounces to
    // completion before the slow "/a" resolves.
    (sftp.realpath as any).mockResolvedValueOnce("/b");
    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/b" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(provider.setRootPath).toHaveBeenCalledWith("/b", { restartWatcher: false });

    provider.setRootPath.mockClear();
    // Now the slow "/a" resolves — it must be abandoned, not applied.
    resolveSlow?.("/a");
    await vi.advanceTimersByTimeAsync(0);

    expect(provider.setRootPath).not.toHaveBeenCalled();
  });

  // ─── Reject stale / rate-limit-disabled records (§5.3 rule 2, §7.3) ──────

  it("does not schedule an apply for a record whose session is currently rate-limit-disabled", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    tracker.disabled.add("s1");

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/etc" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(provider.setRootPath).not.toHaveBeenCalled();
  });

  it("does not schedule an apply for a record the tracker reports as stale — the authority-change-mid-burst trigger", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    coordinator.setViewVisible(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    // Simulates: ESC]7;file://outer/home/user BEL, then (after an authority
    // change) ESC]7;file://inner/etc BEL — the tracker marks the record
    // stale at the same moment it fires the change.
    tracker.stale.add("s1");

    tracker.fire(makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/etc" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(provider.setRootPath).not.toHaveBeenCalled();
  });

  // ─── Freshness-boundary observability (§7.5/§8.2 state 4) ───────────────

  it("emits a state-change on a stale/fresh boundary flip via the periodic poll, without ever calling setRootPath", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];
    tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a" }));

    const listener = vi.fn();
    coordinator.onDidChangeState(listener);

    // The session becomes stale per the tracker, independent of any tracker
    // event (mirrors "60s of ordinary output with no cwd report").
    tracker.stale.add("s1");

    await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS);

    expect(listener).toHaveBeenCalled();
    expect(provider.setRootPath).not.toHaveBeenCalled();
  });

  it("does not emit a redundant state-change on the freshness poll when nothing has changed", async () => {
    const { tracker, provider, core, coordinator } = setup();
    coordinator.setFollowing(true);
    provider.state.activeServerId = "srv-1";
    core.state.focusedSessionId = "s1";
    core.state.activeSessions = [{ id: "s1", serverId: "srv-1", terminalName: "term-1" }];
    tracker.records.set("s1", makeRecord({ sessionId: "s1", serverId: "srv-1", cwd: "/a" }));

    await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS); // first poll establishes the cached baseline

    const listener = vi.fn();
    coordinator.onDidChangeState(listener);
    await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS); // nothing changed

    expect(listener).not.toHaveBeenCalled();
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
