/**
 * CwdSyncCoordinator — the policy layer that decides whether a reported cwd
 * (from `CwdTracker`) becomes a `FileExplorerTreeProvider.setRootPath` call
 * (§5.1, §5.2, §5.3).
 *
 * This is the ONLY place that knows the arbitration rules. Everything
 * environmental (the provider, the SFTP client, the core session snapshot,
 * logging, the clock, the debounce interval) is injected via `CwdSyncDeps` —
 * this module MUST NOT import `vscode` at runtime, and does not even need it
 * for types: `dispose()` is a plain `(): void` method, structurally
 * compatible with `vscode.Disposable` without a type import. It must not call
 * `vscode.workspace.getConfiguration`, must not import `readBoundedNumber`
 * (module-scope `vscode` import), and must not reach into provider privates.
 *
 * **Deviation from the sketch:** `tracker` is typed as `CwdTrackerLike` (a
 * structural interface covering exactly the five `CwdTracker` methods used
 * here) rather than the concrete `CwdTracker` class. A real `CwdTracker`
 * instance satisfies it unchanged, so the wiring agent passes it with no
 * cast — but it also lets tests drive a plain fake tracker directly, which
 * matters because `CwdTracker.report()` enforces its own independent
 * 300 ms-per-session floor between accepted changes (`CWD_MIN_INTERVAL_MS`).
 * That floor exceeds this coordinator's own 250 ms debounce window, so a
 * burst of *real* same-session tracker events can never arrive close enough
 * together to exercise the coordinator's debounce coalescing in isolation.
 * A fake tracker lets the test fire synthetic events on whatever schedule it
 * wants, testing the coordinator's debounce purely on its own terms.
 *
 * **Second deviation:** `CwdTracker.isStale()` needs a `lastOutputAt`
 * timestamp per session, and nothing in `NexusCore`/`SftpService`/the
 * provider carries that today (no Phase 1 sibling wires an output-timestamp
 * source yet). `CwdSyncDeps.lastOutputAt(sessionId)` is added for this
 * purpose; until the wiring agent backs it with something real (e.g. off
 * `TerminalCaptureBuffer` or a small addition to `PtyObserverHub`), passing
 * `() => undefined` is a safe, honest stand-in — `isStale()` then degrades to
 * reporting staleness only via the authority-change signal, never the
 * elapsed-time signal, which matches "degrade to nothing happens" (R3)
 * rather than fabricating an age.
 */

import type { CwdRecord } from "../terminal/cwdTracker";

/** Default debounce window (§5.3 rule 5 / §9 — not user-configurable). */
const DEFAULT_DEBOUNCE_MS = 250;

/**
 * The exact subset of `CwdTracker`'s public API this coordinator uses. A real
 * `CwdTracker` instance satisfies this interface unchanged.
 */
export interface CwdTrackerLike {
  getRecord(sessionId: string): CwdRecord | undefined;
  isDisabled(sessionId: string): boolean;
  isStale(sessionId: string, now: number, lastOutputAt: number | undefined): boolean;
  clear(sessionId: string): void;
  onDidChangeCwd(listener: (record: CwdRecord) => void): () => void;
}

/** The exact subset of `FileExplorerTreeProvider`'s API this coordinator uses. */
export interface CwdSyncProviderLike {
  getActiveServerId(): string | undefined;
  getRootPath(): string | undefined;
  setRootPath(rootPath: string, opts?: { restartWatcher?: boolean }): void;
  isBusy(): boolean;
}

/** The exact subset of `SftpService`'s API this coordinator uses. */
export interface CwdSyncSftpLike {
  realpath(serverId: string, remotePath: string): Promise<string>;
  tryStat(serverId: string, remotePath: string): Promise<{ isDirectory: boolean } | undefined>;
}

/** A single active session as this coordinator needs to see it (§8.2 `terminalName`/`serverId`). */
export interface CwdSyncActiveSessionLike {
  id: string;
  serverId: string;
  terminalName: string;
}

/**
 * The exact subset of `NexusCore`'s API this coordinator uses. Note
 * `onDidChange`'s listener is declared as `() => void` (the caller always
 * re-reads via `getSnapshot()`) — matching the codebase's existing pattern
 * for narrowed `NexusCore` fakes (see `terminalRegistry.test.ts`), and a
 * bivariant-checked method-shorthand signature so the real
 * `NexusCore.onDidChange(listener: (snapshot) => void)` is assignable here
 * with no cast.
 */
export interface CwdSyncCoreLike {
  getSnapshot(): {
    focusedSessionId: string | undefined;
    activeSessions: ReadonlyArray<CwdSyncActiveSessionLike>;
  };
  onDidChange(listener: () => void): () => void;
}

export interface CwdSyncDeps {
  tracker: CwdTrackerLike;
  provider: CwdSyncProviderLike;
  sftp: CwdSyncSftpLike;
  core: CwdSyncCoreLike;
  /**
   * Most recent output timestamp for a session, or `undefined` if unknown /
   * none yet. Feeds `CwdTracker.isStale()`'s elapsed-time staleness signal
   * (§7.5). See the module-level "second deviation" note above.
   */
  lastOutputAt(sessionId: string): number | undefined;
  /** Diagnostics sink (§7.6) — the Nexus output channel, or a test spy. */
  log(message: string): void;
  /** Injected clock so tests are deterministic. */
  now(): number;
  /** Debounce window in ms (§5.3 rule 5). Defaults to 250. */
  debounceMs?: number;
}

/** Display state for the UI layer (§8.2) — a pure derived getter so the
 * wiring agent can render `TreeView.description` without duplicating policy. */
export type CwdSyncState =
  | { kind: "off" }
  | { kind: "following"; terminalName: string }
  | { kind: "noSource"; terminalName: string }
  | { kind: "stale"; terminalName: string; cwd: string; ageMs: number }
  | { kind: "pinned"; terminalName: string; trackedCwd: string | undefined }
  | { kind: "otherServer"; terminalName: string; otherServerId: string }
  | { kind: "rateLimited"; terminalName: string };

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CwdSyncCoordinator {
  private readonly debounceMs: number;

  private following = false;
  private paused = false;
  /** The session the current pin "belongs to" — needed so `onSessionEnded`
   * only clears the pin when it belonged to the ending session (§8.3). */
  private pinnedSessionId: string | undefined;

  private visible = false;
  /** Latest record withheld while `visible` is false; applied once on re-show. */
  private hiddenBuffer: CwdRecord | undefined;

  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private debouncedRecord: CwdRecord | undefined;

  /** Cache for the cheap `focusedSessionId` diff (§5.2) — `core.onDidChange`
   * fires on every tunnel-traffic tick and must be a no-op when this hasn't
   * changed. */
  private lastFocusedSessionId: string | undefined;

  private readonly stateListeners = new Set<() => void>();
  private readonly unsubscribeTracker: () => void;
  private readonly unsubscribeCore: () => void;
  private disposed = false;

  public constructor(private readonly deps: CwdSyncDeps) {
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.lastFocusedSessionId = deps.core.getSnapshot().focusedSessionId;

    this.unsubscribeTracker = deps.tracker.onDidChangeCwd((record) => {
      this.emitStateChange();
      this.considerApply(record, "cwd-changed");
    });

    this.unsubscribeCore = deps.core.onDidChange(() => {
      const focusedSessionId = this.deps.core.getSnapshot().focusedSessionId;
      if (focusedSessionId === this.lastFocusedSessionId) {
        // Cheap diff against the cached value — an unrelated tick (e.g. tunnel
        // traffic) must do no further work (§5.2).
        return;
      }
      this.lastFocusedSessionId = focusedSessionId;
      this.emitStateChange();
      this.applyForFocusedSession("focus-changed");
    });
  }

  // ─── Enable state (§8.1) ────────────────────────────────────────────────

  public setFollowing(on: boolean): void {
    if (this.following === on) {
      return;
    }
    this.following = on;
    if (!on) {
      this.cancelDebounce();
      this.hiddenBuffer = undefined;
    } else {
      // §8.3: toggling following off -> on clears any stale pin.
      this.paused = false;
      this.pinnedSessionId = undefined;
    }
    this.emitStateChange();
  }

  public isFollowing(): boolean {
    return this.following;
  }

  // ─── View visibility (§5.3 rule 4) ──────────────────────────────────────

  public setViewVisible(visible: boolean): void {
    if (this.visible === visible) {
      return;
    }
    this.visible = visible;
    if (visible && this.hiddenBuffer) {
      const record = this.hiddenBuffer;
      this.hiddenBuffer = undefined;
      this.considerApply(record, "view-reshown", { immediate: true });
    }
  }

  // ─── Pin / resume (§8.3) ─────────────────────────────────────────────────

  /** Called by the wiring agent from `goToPath` / `goHome` / the `..` row. */
  public notifyManualNavigation(): void {
    this.paused = true;
    this.pinnedSessionId = this.deps.core.getSnapshot().focusedSessionId;
    this.emitStateChange();
  }

  /** `syncFromTerminal` does not pin — it clears an existing pin. */
  public clearPin(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.pinnedSessionId = undefined;
    this.emitStateChange();
  }

  /** Clears the pin and immediately applies the tracker's current cwd for
   * the focused session. */
  public resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.pinnedSessionId = undefined;
    this.emitStateChange();
    this.applyForFocusedSession("resume", { immediate: true });
  }

  // ─── Lifecycle holes (§5.4) ──────────────────────────────────────────────

  /** Clears tracker state for the session (§5.4 hole b) and clears the pin
   * if it belonged to that session. */
  public onSessionEnded(sessionId: string): void {
    this.deps.tracker.clear(sessionId);
    if (this.pinnedSessionId === sessionId) {
      this.paused = false;
      this.pinnedSessionId = undefined;
    }
    if (this.hiddenBuffer?.sessionId === sessionId) {
      this.hiddenBuffer = undefined;
    }
    if (this.debouncedRecord?.sessionId === sessionId) {
      this.cancelDebounce();
    }
    if (this.lastFocusedSessionId === sessionId) {
      this.lastFocusedSessionId = undefined;
    }
    this.emitStateChange();
  }

  // ─── Derived UI state (§8.2) ─────────────────────────────────────────────

  public getState(): CwdSyncState {
    if (!this.following) {
      return { kind: "off" };
    }

    const snapshot = this.deps.core.getSnapshot();
    const focusedSessionId = snapshot.focusedSessionId;
    const focusedSession = focusedSessionId
      ? snapshot.activeSessions.find((s) => s.id === focusedSessionId)
      : undefined;

    if (!focusedSessionId || !focusedSession) {
      // No SSH session is (or was last) focused — nothing this feature can
      // meaningfully describe. Render as "off" rather than inventing a
      // misleading terminal name for one of the other six states.
      return { kind: "off" };
    }

    const terminalName = focusedSession.terminalName;
    const activeServerId = this.deps.provider.getActiveServerId();

    if (activeServerId !== focusedSession.serverId) {
      return { kind: "otherServer", terminalName, otherServerId: focusedSession.serverId };
    }

    if (this.paused) {
      const trackedCwd = this.deps.tracker.getRecord(focusedSessionId)?.cwd;
      return { kind: "pinned", terminalName, trackedCwd };
    }

    if (this.deps.tracker.isDisabled(focusedSessionId)) {
      return { kind: "rateLimited", terminalName };
    }

    const record = this.deps.tracker.getRecord(focusedSessionId);
    if (!record) {
      return { kind: "noSource", terminalName };
    }

    const now = this.deps.now();
    if (this.deps.tracker.isStale(focusedSessionId, now, this.deps.lastOutputAt(focusedSessionId))) {
      return { kind: "stale", terminalName, cwd: record.cwd, ageMs: now - record.updatedAt };
    }

    return { kind: "following", terminalName };
  }

  public onDidChangeState(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private emitStateChange(): void {
    for (const listener of this.stateListeners) {
      listener();
    }
  }

  // ─── Apply pipeline (§5.3) ───────────────────────────────────────────────

  private applyForFocusedSession(reason: string, opts?: { immediate?: boolean }): void {
    const focusedSessionId = this.deps.core.getSnapshot().focusedSessionId;
    const record = focusedSessionId ? this.deps.tracker.getRecord(focusedSessionId) : undefined;
    this.considerApply(record, reason, opts);
  }

  /**
   * Runs arbitration rules 1-6 (§5.3) for a specific record, then either
   * schedules the debounced resolve-and-apply (rule 7-10) or, for
   * `opts.immediate`, runs it right away (used by `resume()` and
   * re-show-with-buffered-value, both of which are explicit, already-decided
   * actions rather than a raw incoming signal).
   */
  private considerApply(record: CwdRecord | undefined, reason: string, opts?: { immediate?: boolean }): void {
    if (!this.following) {
      return;
    }
    if (!record) {
      // Nothing tracked yet for the relevant session — not a suppression,
      // just no data (state "noSource").
      return;
    }

    const focusedSessionId = this.deps.core.getSnapshot().focusedSessionId;
    if (record.sessionId !== focusedSessionId) {
      this.deps.log(`Directory sync: skip (${reason}) — session ${record.sessionId} is not focused`);
      return;
    }

    const activeServerId = this.deps.provider.getActiveServerId();
    if (activeServerId !== record.serverId) {
      this.deps.log(
        `Directory sync: skip (${reason}) — server mismatch (explorer=${activeServerId ?? "<none>"}, session=${record.serverId})`
      );
      return;
    }

    if (this.paused) {
      this.deps.log(`Directory sync: skip (${reason}) — pinned (manual navigation)`);
      return;
    }

    if (this.deps.provider.isBusy()) {
      this.deps.log(`Directory sync: skip (${reason}) — explorer is busy`);
      return;
    }

    if (!this.visible) {
      this.hiddenBuffer = record;
      this.deps.log(`Directory sync: buffered (${reason}) — view is hidden`);
      return;
    }

    if (opts?.immediate) {
      this.cancelDebounce();
      void this.resolveAndApply(record, reason);
      return;
    }

    this.scheduleApply(record, reason);
  }

  private scheduleApply(record: CwdRecord, reason: string): void {
    this.debouncedRecord = record;
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      const toApply = this.debouncedRecord;
      this.debouncedRecord = undefined;
      if (toApply) {
        void this.resolveAndApply(toApply, reason);
      }
    }, this.debounceMs);
  }

  private cancelDebounce(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.debouncedRecord = undefined;
  }

  /**
   * Rules 8-10 (§5.3). Both SFTP calls are wrapped in try/catch — §5.4 hole
   * (c): the explorer can be torn down mid-flight and `getSftp` throws
   * `No SFTP session for server …`. A failure logs and drops; it must never
   * reject out of the coordinator (it is always invoked via `void`).
   */
  private async resolveAndApply(record: CwdRecord, reason: string): Promise<void> {
    let resolved: string;
    try {
      resolved = await this.deps.sftp.realpath(record.serverId, record.cwd);
    } catch (err) {
      this.deps.log(
        `Directory sync: realpath(${record.serverId}, ${record.cwd}) failed (${reason}): ${describeError(err)}`
      );
      return;
    }

    if (this.disposed) {
      return;
    }

    let stat: { isDirectory: boolean } | undefined;
    try {
      stat = await this.deps.sftp.tryStat(record.serverId, resolved);
    } catch (err) {
      this.deps.log(`Directory sync: stat(${record.serverId}, ${resolved}) failed (${reason}): ${describeError(err)}`);
      return;
    }

    if (this.disposed) {
      return;
    }

    if (!stat || !stat.isDirectory) {
      this.deps.log(`Directory sync: skip (${reason}) — resolved path is not a directory: ${resolved}`);
      return;
    }

    if (resolved === this.deps.provider.getRootPath()) {
      return; // no-op — already there
    }

    this.deps.provider.setRootPath(resolved, { restartWatcher: false });
    this.deps.log(`Directory sync: re-rooted to ${resolved} (${reason})`);
    this.emitStateChange();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribeTracker();
    this.unsubscribeCore();
    this.cancelDebounce();
    this.stateListeners.clear();
  }
}
