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
 * structural interface covering exactly the `CwdTracker` methods used here)
 * rather than the concrete `CwdTracker` class. A real `CwdTracker` instance
 * satisfies it unchanged, so the wiring agent passes it with no cast — but it
 * also lets tests drive a plain fake tracker directly, which matters because
 * `CwdTracker.report()` enforces its own independent 300 ms-per-session floor
 * on listener delivery (`CWD_MIN_INTERVAL_MS`). That floor exceeds this
 * coordinator's own 250 ms debounce window, so a burst of *real* same-session
 * tracker events can never arrive close enough together to exercise the
 * coordinator's debounce coalescing in isolation. A fake tracker lets the
 * test fire synthetic events on whatever schedule it wants, testing the
 * coordinator's debounce purely on its own terms.
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
 *
 * **Generation token (race-fix):** `resolveAndApply` awaits two SFTP round
 * trips (`realpath` then `tryStat`) before committing a `setRootPath` call.
 * Anything that makes the eventual commit stale — a newer record superseding
 * this one, or the arbitration context itself changing underneath it (focus,
 * explorer server, pin, visibility, busy, following) — must stop that commit
 * from landing. A monotonic `generation` counter is bumped every time a
 * fresh apply attempt is dispatched (immediate or via the debounce firing) so
 * two overlapping attempts get distinct tokens; the dispatch captures its own
 * token and `resolveAndApply` aborts if `this.generation` has moved on by the
 * time each await resolves. This alone fixes *out-of-order completion*
 * (a slow record and a fast, newer record resolving in the "wrong" order).
 * Separately, `passesArbitration()` re-runs the full synchronous arbitration
 * set immediately before each commit point, which fixes *stale-context*
 * races (the explorer switched servers, the session lost focus, the view
 * was hidden, etc. while the awaits were in flight) even when no newer
 * record ever arrived to bump the generation. The two mechanisms are
 * deliberately redundant on some dimensions (e.g. a follow-off toggle bumps
 * the generation *and* is caught by the arbitration recheck) — cheap
 * insurance, not a design smell.
 */

import type { CwdRecord } from "../terminal/cwdTracker";

/** Default debounce window (§5.3 rule 5 / §9 — not user-configurable). */
const DEFAULT_DEBOUNCE_MS = 250;

/**
 * How often to poll for a stale/fresh UI-state transition while following is
 * on (§7.5/§8.2 state 4). This is a pure UI-observability timer — it never
 * calls `considerApply`/`resolveAndApply` and never triggers a re-root; it
 * only decides whether `emitStateChange()` needs firing so a "stale" label
 * appears or clears even when nothing else touches cwd state (ordinary
 * terminal output with no cwd report, or a same-value heartbeat, neither of
 * which fire `onDidChangeCwd`).
 */
export const FRESHNESS_POLL_MS = 5_000;

/**
 * The exact subset of `CwdTracker`'s public API this coordinator uses. A real
 * `CwdTracker` instance satisfies this interface unchanged.
 */
export interface CwdTrackerLike {
  getRecord(sessionId: string): CwdRecord | undefined;
  isDisabled(sessionId: string): boolean;
  isStale(sessionId: string, now: number, lastOutputAt: number | undefined): boolean;
  clear(sessionId: string): void;
  /** Lifts a §7.3 burst shutdown for a session (state 7 recovery — see
   * `setFollowing()`). */
  reenable(sessionId: string): void;
  onDidChangeCwd(listener: (record: CwdRecord) => void): () => void;
}

/** The exact subset of `FileExplorerTreeProvider`'s API this coordinator uses. */
export interface CwdSyncProviderLike {
  getActiveServerId(): string | undefined;
  getRootPath(): string | undefined;
  setRootPath(rootPath: string, opts?: { restartWatcher?: boolean }): void;
  isBusy(): boolean;
  /**
   * Fires exactly when `isBusy()` transitions from true to false (bug 1 fix —
   * see the `busyBuffer` doc comment below). Never fires on false->true.
   */
  onDidChangeBusy(listener: () => void): () => void;
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

  /**
   * Latest record withheld while `provider.isBusy()` is true; applied once
   * the explorer signals it has gone idle (`provider.onDidChangeBusy`).
   * Mirrors `hiddenBuffer`'s latest-wins semantics exactly — bug 1 fix
   * (§7.4): the busy check exists so a re-root cannot land mid-upload or
   * mid-listing, not so a report gets thrown away. Cleared at the same
   * lifecycle points as `hiddenBuffer` plus two more (`notifyExplorerServerChanged`,
   * `dispose`) — see each site's comment.
   */
  private busyBuffer: CwdRecord | undefined;

  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private debouncedRecord: CwdRecord | undefined;

  /** Cache for the cheap `focusedSessionId` diff (§5.2) — `core.onDidChange`
   * fires on every tunnel-traffic tick and must be a no-op when this hasn't
   * changed. */
  private lastFocusedSessionId: string | undefined;

  /** Monotonic token bumped on every fresh apply dispatch and on every
   * policy/server/focus change — see the module-level "generation token" doc
   * comment above. */
  private generation = 0;

  /** Cache for the periodic freshness-boundary poll (§7.5/§8.2 state 4) — set
   * of `sessionId:isStale` is unnecessary since only the focused session is
   * ever rendered; a single cached boolean is enough. */
  private lastKnownStale: boolean | undefined;
  private readonly freshnessPollTimer: ReturnType<typeof setInterval>;

  private readonly stateListeners = new Set<() => void>();
  private readonly unsubscribeTracker: () => void;
  private readonly unsubscribeCore: () => void;
  private readonly unsubscribeBusy: () => void;
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
      this.generation++; // invalidate any apply in flight for the old focus
      this.emitStateChange();
      this.applyForFocusedSession("focus-changed");
    });

    this.unsubscribeBusy = deps.provider.onDidChangeBusy(() => this.onBusyIdle());

    this.freshnessPollTimer = setInterval(() => this.checkFreshnessBoundary(), FRESHNESS_POLL_MS);
  }

  // ─── Enable state (§8.1) ────────────────────────────────────────────────

  public setFollowing(on: boolean): void {
    if (this.following === on) {
      return;
    }
    this.following = on;
    this.generation++;
    if (!on) {
      this.cancelDebounce();
      this.hiddenBuffer = undefined;
      this.busyBuffer = undefined;
    } else {
      // §8.3: toggling following off -> on clears any stale pin.
      this.paused = false;
      this.pinnedSessionId = undefined;
      // §7.3/§8.2 state 7 recovery: lift a rate-limit shutdown for the
      // currently focused session. Without this, the sticky per-session
      // `disabled` flag on `CwdTracker` survives an off/on toggle and the
      // session drops straight back into state 7 — the concrete mechanism
      // behind state 7's "use the Follow button to turn it back on" message.
      const focusedSessionId = this.deps.core.getSnapshot().focusedSessionId;
      if (focusedSessionId) {
        this.deps.tracker.reenable(focusedSessionId);
      }
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

  // ─── Busy buffering (§7.4 bug 1) ─────────────────────────────────────────

  /**
   * The explorer just went idle (`FileExplorerTreeProvider`'s combined busy
   * state transitioned true->false). Replay whatever was buffered while busy
   * through `considerApply`, which re-runs the *full* synchronous
   * arbitration set from scratch (following, record presence, focused
   * session, server match, pin, rate-limit, stale, busy again, visibility) —
   * never apply a buffered record blindly, because any of that may have
   * changed while the explorer was busy. This mirrors `setViewVisible(true)`'s
   * hidden-buffer replay exactly, including cascading into `hiddenBuffer` if
   * the view is *also* still hidden by the time this fires.
   */
  private onBusyIdle(): void {
    if (!this.busyBuffer) {
      return;
    }
    const record = this.busyBuffer;
    this.busyBuffer = undefined;
    this.considerApply(record, "busy-cleared", { immediate: true });
  }

  // ─── Pin / resume (§8.3) ─────────────────────────────────────────────────

  /** Called by the wiring agent from `goToPath` / `goHome` / the `..` row. */
  public notifyManualNavigation(): void {
    this.paused = true;
    this.pinnedSessionId = this.deps.core.getSnapshot().focusedSessionId;
    this.generation++; // abandon anything in flight from before the pin
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
    this.generation++;
    if (this.pinnedSessionId === sessionId) {
      this.paused = false;
      this.pinnedSessionId = undefined;
    }
    if (this.hiddenBuffer?.sessionId === sessionId) {
      this.hiddenBuffer = undefined;
    }
    if (this.busyBuffer?.sessionId === sessionId) {
      this.busyBuffer = undefined;
    }
    if (this.debouncedRecord?.sessionId === sessionId) {
      this.cancelDebounce();
    }
    if (this.lastFocusedSessionId === sessionId) {
      this.lastFocusedSessionId = undefined;
    }
    this.emitStateChange();
  }

  /**
   * Doc §8.3: "the pin clears automatically on ... explorer server change."
   * Call this from every place the File Explorer's active server changes
   * (`setActiveServer` / `clearActiveServer` call sites) — the provider
   * itself must stay unaware of this feature, so the wiring/command layer is
   * responsible for calling this alongside those provider calls. Clears the
   * pin, invalidates any apply in flight for the old server (generation
   * bump, and the pending debounce is moot for the old context regardless),
   * and re-evaluates the newly active server against the focused session's
   * tracked record.
   */
  public notifyExplorerServerChanged(): void {
    this.paused = false;
    this.pinnedSessionId = undefined;
    this.generation++;
    this.cancelDebounce();
    this.busyBuffer = undefined;
    this.emitStateChange();
    this.applyForFocusedSession("explorer-server-changed");
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

  // ─── Freshness-boundary observability (§7.5/§8.2 state 4) ───────────────

  /**
   * Periodic, side-effect-free check: has the focused session's stale/fresh
   * boolean flipped since the last poll? If so, fire a state-change event so
   * the UI's "stale" label appears or clears — this NEVER calls
   * `considerApply`/`resolveAndApply`, so it can never trigger a re-root.
   * Without this, a session that goes stale (or a stale session that
   * recovers via a heartbeat) only repaints the UI if something else
   * unrelated happens to call `emitStateChange()` first, which may never
   * happen (§7.5's own trigger: ordinary output with no cwd report for
   * 60+ seconds updates nothing observable at all).
   */
  private checkFreshnessBoundary(): void {
    if (!this.following || this.paused) {
      return;
    }
    const snapshot = this.deps.core.getSnapshot();
    const focusedSessionId = snapshot.focusedSessionId;
    if (!focusedSessionId) {
      return;
    }
    const focusedSession = snapshot.activeSessions.find((s) => s.id === focusedSessionId);
    if (!focusedSession) {
      return;
    }
    if (this.deps.provider.getActiveServerId() !== focusedSession.serverId) {
      return;
    }
    if (this.deps.tracker.isDisabled(focusedSessionId)) {
      return;
    }
    const record = this.deps.tracker.getRecord(focusedSessionId);
    if (!record) {
      return;
    }

    const now = this.deps.now();
    const stale = this.deps.tracker.isStale(focusedSessionId, now, this.deps.lastOutputAt(focusedSessionId));
    if (stale !== this.lastKnownStale) {
      this.lastKnownStale = stale;
      this.emitStateChange();
    }
  }

  // ─── Apply pipeline (§5.3) ───────────────────────────────────────────────

  private applyForFocusedSession(reason: string, opts?: { immediate?: boolean }): void {
    const focusedSessionId = this.deps.core.getSnapshot().focusedSessionId;
    const record = focusedSessionId ? this.deps.tracker.getRecord(focusedSessionId) : undefined;
    this.considerApply(record, reason, opts);
  }

  /**
   * Runs the synchronous arbitration rules (§5.3) for a specific record, then
   * either schedules the debounced resolve-and-apply or, for
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

    // §7.5/doc §5.3 rule 2: reject a rate-limit-disabled or stale record
    // before scheduling anything — re-applying a stale directory (e.g. one
    // marked stale by a nested-ssh/tmux authority change in the very same
    // tick that produced this record) would re-root onto an untrusted path.
    if (this.deps.tracker.isDisabled(record.sessionId)) {
      this.deps.log(`Directory sync: skip (${reason}) — rate-limit shutdown for session ${record.sessionId}`);
      return;
    }
    const now = this.deps.now();
    if (this.deps.tracker.isStale(record.sessionId, now, this.deps.lastOutputAt(record.sessionId))) {
      this.deps.log(`Directory sync: skip (${reason}) — stale record for session ${record.sessionId}`);
      return;
    }

    if (this.deps.provider.isBusy()) {
      // Bug 1 fix (§7.4): buffer, don't drop. The busy check exists so a
      // re-root can't land mid-upload or mid-listing — deferring satisfies
      // that; silently losing the report was never required. Latest-wins,
      // exactly like `hiddenBuffer` below. Replayed by `onBusyIdle()` once
      // `provider.onDidChangeBusy` fires the idle transition.
      this.busyBuffer = record;
      this.deps.log(`Directory sync: buffered (${reason}) — explorer is busy`);
      return;
    }

    if (!this.visible) {
      this.hiddenBuffer = record;
      this.deps.log(`Directory sync: buffered (${reason}) — view is hidden`);
      return;
    }

    if (opts?.immediate) {
      this.cancelDebounce();
      const generation = ++this.generation;
      void this.resolveAndApply(record, reason, generation);
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
        const generation = ++this.generation;
        void this.resolveAndApply(toApply, reason, generation);
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
   * Re-runs the full synchronous arbitration set — following, focused
   * session, server match, pin, busy, visibility — against *current* state
   * (as opposed to whatever was true when the apply was first dispatched).
   * Used at each commit point inside `resolveAndApply`, in addition to the
   * generation-token check, so a context change that happens without a
   * newer record ever arriving (e.g. the explorer switches server while a
   * `realpath` call is in flight) still aborts the commit.
   */
  private passesArbitration(record: CwdRecord): { ok: true } | { ok: false; reasonMsg: string } {
    if (!this.following) {
      return { ok: false, reasonMsg: "following was turned off" };
    }
    const focusedSessionId = this.deps.core.getSnapshot().focusedSessionId;
    if (record.sessionId !== focusedSessionId) {
      return { ok: false, reasonMsg: `session ${record.sessionId} is no longer focused` };
    }
    const activeServerId = this.deps.provider.getActiveServerId();
    if (activeServerId !== record.serverId) {
      return {
        ok: false,
        reasonMsg: `server mismatch (explorer=${activeServerId ?? "<none>"}, session=${record.serverId})`
      };
    }
    if (this.paused) {
      return { ok: false, reasonMsg: "pinned (manual navigation)" };
    }
    if (this.deps.provider.isBusy()) {
      return { ok: false, reasonMsg: "explorer is busy" };
    }
    if (!this.visible) {
      return { ok: false, reasonMsg: "view is hidden" };
    }
    return { ok: true };
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  /**
   * Logs a mid-flight `passesArbitration()` failure and, when the explorer
   * became busy during the awaited SFTP call (§7.4 bug 1), buffers the
   * record instead of dropping it — `onBusyIdle()` retries it (through full
   * arbitration again) once the explorer signals idle. `isBusy()` is
   * evaluated synchronously right here, immediately after the arbitration
   * check that already consulted it, so there is no race between the two
   * reads. A false positive (buffering when the *actual* blocking rule was
   * something else that happened to coincide with busy, e.g. a pin set in
   * the same tick) is harmless: the eventual retry re-runs every rule from
   * scratch and simply skips again if still blocked.
   */
  private abandonMidFlight(record: CwdRecord, reason: string, arbitration: { ok: false; reasonMsg: string }): void {
    this.deps.log(`Directory sync: abandon (${reason}) — ${arbitration.reasonMsg}`);
    if (this.deps.provider.isBusy()) {
      this.busyBuffer = record;
    }
  }

  /**
   * Rules 8-10 (§5.3). Both SFTP calls are wrapped in try/catch — §5.4 hole
   * (c): the explorer can be torn down mid-flight and `getSftp` throws
   * `No SFTP session for server …`. A failure logs and drops; it must never
   * reject out of the coordinator (it is always invoked via `void`).
   *
   * `generation` is captured by the caller at dispatch time; this method
   * abandons the commit if it no longer matches `this.generation` (a newer
   * apply superseded this one, or a policy/server/focus change bumped it),
   * and separately re-runs `passesArbitration()` against current state after
   * each await (§ generation-token doc comment above) — the two together
   * fix both the out-of-order-completion race and the stale-context race.
   */
  private async resolveAndApply(record: CwdRecord, reason: string, generation: number): Promise<void> {
    let resolved: string;
    try {
      resolved = await this.deps.sftp.realpath(record.serverId, record.cwd);
    } catch (err) {
      this.deps.log(
        `Directory sync: realpath(${record.serverId}, ${record.cwd}) failed (${reason}): ${describeError(err)}`
      );
      return;
    }

    if (!this.isCurrentGeneration(generation)) {
      this.deps.log(`Directory sync: abandon (${reason}) — superseded while resolving realpath`);
      return;
    }
    const afterRealpath = this.passesArbitration(record);
    if (!afterRealpath.ok) {
      this.abandonMidFlight(record, reason, afterRealpath);
      return;
    }

    let stat: { isDirectory: boolean } | undefined;
    try {
      stat = await this.deps.sftp.tryStat(record.serverId, resolved);
    } catch (err) {
      this.deps.log(`Directory sync: stat(${record.serverId}, ${resolved}) failed (${reason}): ${describeError(err)}`);
      return;
    }

    if (!this.isCurrentGeneration(generation)) {
      this.deps.log(`Directory sync: abandon (${reason}) — superseded while resolving stat`);
      return;
    }
    const afterStat = this.passesArbitration(record);
    if (!afterStat.ok) {
      this.abandonMidFlight(record, reason, afterStat);
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
    this.unsubscribeBusy();
    this.cancelDebounce();
    this.busyBuffer = undefined;
    clearInterval(this.freshnessPollTimer);
    this.stateListeners.clear();
  }
}
