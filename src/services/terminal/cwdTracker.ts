/**
 * CwdTracker — per-session cwd state and policy (§5.1).
 *
 * A value object driven by an injected `now` for all its *decisions* — no
 * `Date.now()` calls, no `vscode` import — so tests stay deterministic.
 * Staleness is computed lazily on read from `updatedAt` (§5.1/§7.5) rather
 * than pushed on a timer.
 *
 * One deliberate, bounded exception to "no timers": §7.3's rate limiter gates
 * *listener delivery*, not what the tracker considers current (see `report()`
 * doc comment below). When a distinct value is rate-limited, a single
 * `setTimeout` per session schedules delivery of whatever the record holds
 * once the rate-limit window elapses, so a same-window burst's *final* value
 * is what listeners eventually see even if no further `report()` call ever
 * arrives to trigger it naturally. The timer's delay is always derived
 * arithmetically from the caller-injected `now` values (never from
 * `Date.now()`), so the class remains fully testable under `vi.useFakeTimers()`
 * without mixing a real wall clock into the deterministic `now` domain. Every
 * pending timer is cleared by `clear()` and `dispose()`.
 *
 * Owns three independent pieces of policy, all Phase 1 (§7.3, §7.5):
 *  - Rate limiting: at most one *listener delivery* per `CWD_MIN_INTERVAL_MS`
 *    per session (the tracked record itself always reflects the latest
 *    report), and a permanent per-session shutdown if reports sustain more
 *    than `CWD_BURST_RATE_PER_SEC` reports/second for `CWD_BURST_SUSTAIN_MS`.
 *  - Staleness: `isStale()` — see its doc comment for the exact rule.
 *  - An authority change (the URL host component reported alongside a path —
 *    see `osc7Parser.ts`) is a second, independent staleness trigger: it is
 *    the observable signal of a nested `ssh`/`tmux`/`su` changing what's
 *    "underneath" the shell the user is looking at (§7.1/§7.5).
 */

export type CwdSource = "osc7" | "heuristic" | "probe";

export interface CwdRecord {
  sessionId: string;
  serverId: string;
  cwd: string;
  source: CwdSource;
  authority: string;
  updatedAt: number;
}

/** §7.5 — stale if output has happened since the last cwd report, and the
 * last report is older than this. Named constant per the design doc. */
export const CWD_STALE_MS = 60_000;

/** §7.3 — accept at most one *listener delivery* per session within this window. */
export const CWD_MIN_INTERVAL_MS = 300;

/** §7.3 — sustained-burst threshold: reports/second above this rate... */
export const CWD_BURST_RATE_PER_SEC = 20;

/** ...for at least this long triggers a permanent per-session shutdown. */
export const CWD_BURST_SUSTAIN_MS = 3_000;

/**
 * Trip count derived from the two named constants above rather than a
 * windowSpan/rate division (§7.3 fix): the old formula required the oldest
 * retained sample to be *exactly* `CWD_BURST_SUSTAIN_MS` old before it would
 * even consider tripping, which a burst pruned every call (as any sustained
 * burst is) could only ever satisfy by cadence coincidence — e.g. reports
 * every 47ms (~21.3/s, over threshold) never tripped it, while 50ms exactly
 * did only because 3000 / 50 is an integer. Comparing the retained count
 * against a fixed threshold sidesteps sample alignment entirely: every
 * timestamp still in `burstTimestamps` is, by construction of the prune
 * below, already within the trailing `CWD_BURST_SUSTAIN_MS` window.
 */
const BURST_TRIP_THRESHOLD = (CWD_BURST_RATE_PER_SEC * CWD_BURST_SUSTAIN_MS) / 1000;

type ChangeListener = (record: CwdRecord) => void;

interface SessionState {
  record: CwdRecord;
  /** Sticky once set by an authority change; cleared only by `clear()`. */
  authorityStale: boolean;
  /** Sticky once the burst detector trips; cleared only by `clear()` / `reenable()`. */
  disabled: boolean;
  /** Timestamps of every `report()` call within the trailing burst window,
   * used only for burst detection — independent of whether the report was
   * itself delivered to listeners (§7.3: the flood itself is the risk, not
   * just floods of *distinct* values). */
  burstTimestamps: number[];
  /** `now`-domain instant of the last actual `fireChange()` delivery for this
   * session (§7.3 rate limiting — gates delivery, not the record itself). */
  lastFiredAt: number;
  /** At most one pending rate-limit flush per session — see `report()`. */
  pendingFlush?: ReturnType<typeof setTimeout>;
}

export class CwdTracker {
  private readonly sessions = new Map<string, SessionState>();
  private readonly listeners = new Set<ChangeListener>();

  /**
   * Report a freshly observed cwd for a session. Applies burst detection,
   * then *always* updates the tracked record to the latest (cwd, authority)
   * pair — `getRecord()` never lags behind the truth. Rate limiting
   * (§7.3, `CWD_MIN_INTERVAL_MS`) gates only `onDidChangeCwd` *delivery*: a
   * distinct value arriving too soon after the last delivery still becomes
   * the current record immediately, but the listener notification is
   * deferred to a timer that fires once the window elapses, delivering
   * whatever the record holds *at that moment* — never the first value that
   * happened to squeak in, and never silently dropped. This matters because
   * a single ssh2 chunk can contain multiple OSC 7 matches stamped with the
   * *same* `now` (one `Date.now()` call covers the whole chunk in
   * `serverCommands.ts`) — without this, the first of two same-tick values
   * would win and the coordinator's own debounce could never see a genuine
   * same-session burst resolve to its true latest value.
   *
   * Returns `true` only when the change was delivered to listeners
   * *synchronously* by this call (the first-ever report, or a distinct value
   * arriving after the rate-limit window has elapsed). A rate-limited
   * distinct value returns `false` even though the record was updated —
   * callers needing the authoritative current value should use `getRecord()`,
   * not this return value. Repeated reports of the *same* value still
   * refresh `updatedAt` (a heartbeat, so lazy staleness reflects "still
   * reporting" rather than "directory hasn't changed lately") but return
   * `false` and never touch delivery timing.
   */
  public report(
    sessionId: string,
    serverId: string,
    cwd: string,
    source: CwdSource,
    authority: string,
    now: number
  ): boolean {
    const existing = this.sessions.get(sessionId);

    if (existing?.disabled) {
      return false;
    }

    // §7.3 burst detection: count every incoming report, regardless of
    // whether it is ultimately delivered below — a flood of identical or
    // rate-limited reports is exactly the pattern this guards against.
    const burstTimestamps = existing ? existing.burstTimestamps : [];
    burstTimestamps.push(now);
    const cutoff = now - CWD_BURST_SUSTAIN_MS;
    while (burstTimestamps.length > 0 && burstTimestamps[0] < cutoff) {
      burstTimestamps.shift();
    }
    const burstTripped = burstTimestamps.length > BURST_TRIP_THRESHOLD;

    if (burstTripped) {
      if (existing) {
        this.clearPendingFlush(existing);
      }
      const record: CwdRecord = existing?.record ?? { sessionId, serverId, cwd, source, authority, updatedAt: now };
      const state: SessionState = {
        record,
        authorityStale: existing?.authorityStale ?? false,
        disabled: true,
        burstTimestamps,
        lastFiredAt: now
      };
      this.sessions.set(sessionId, state);
      this.fireChange(state.record);
      return false;
    }

    if (!existing) {
      const record: CwdRecord = { sessionId, serverId, cwd, source, authority, updatedAt: now };
      this.sessions.set(sessionId, { record, authorityStale: false, disabled: false, burstTimestamps, lastFiredAt: now });
      this.fireChange(record);
      return true;
    }

    const unchanged = existing.record.cwd === cwd && existing.record.authority === authority;
    if (unchanged) {
      // Heartbeat only — refresh updatedAt without treating this as a change.
      existing.record = { ...existing.record, source, updatedAt: now };
      existing.burstTimestamps = burstTimestamps;
      return false;
    }

    // Distinct value: the record always reflects the latest report
    // immediately (see doc comment above) — only listener *delivery* is
    // rate-limited below.
    const authorityChanged = existing.record.authority !== authority;
    const newRecord: CwdRecord = { sessionId, serverId, cwd, source, authority, updatedAt: now };
    existing.record = newRecord;
    existing.burstTimestamps = burstTimestamps;
    if (authorityChanged) {
      // §7.1/§7.5: the nested-ssh/tmux signal. Sticky — see class doc comment.
      existing.authorityStale = true;
    }

    const elapsedSinceFire = now - existing.lastFiredAt;
    if (elapsedSinceFire >= CWD_MIN_INTERVAL_MS) {
      // Window already elapsed — deliver now and supersede any stale pending
      // flush (this delivery already carries the latest value).
      this.clearPendingFlush(existing);
      existing.lastFiredAt = now;
      this.fireChange(newRecord);
      return true;
    }

    // Rate-limited: the record is already current (above); schedule (unless
    // one is already pending) a flush of whatever the record holds once the
    // window since the last delivery elapses.
    this.schedulePendingFlush(existing, CWD_MIN_INTERVAL_MS - elapsedSinceFire);
    return false;
  }

  /** The current tracked record for a session, or `undefined` if none exists
   * (the "no source reported yet" case — distinct from stale). Always the
   * latest reported value, independent of the §7.3 delivery rate limit. */
  public getRecord(sessionId: string): CwdRecord | undefined {
    return this.sessions.get(sessionId)?.record;
  }

  /** True once the §7.3 burst detector has permanently shut tracking off for
   * this session (until `clear()` or `reenable()`). Observable state for the
   * UI (state 7) and for the caller to log via the Nexus output channel
   * (§7.6) — this module cannot log itself, since it must stay `vscode`-free. */
  public isDisabled(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.disabled ?? false;
  }

  /**
   * Lifts a §7.3 burst shutdown for a session while preserving its last
   * known record and any authority-staleness — the counterpart to `clear()`,
   * which also wipes the record. This is the concrete mechanism behind
   * state 7's "use the Follow button to turn it back on" message
   * (`CwdSyncCoordinator.setFollowing(true)`): without resetting
   * `burstTimestamps` too, a user who reacts within the burst window would
   * immediately re-trip the detector on the very next report. A no-op for a
   * session with no tracked state at all.
   */
  public reenable(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }
    this.clearPendingFlush(state);
    state.disabled = false;
    state.burstTimestamps = [];
  }

  /**
   * Stale when either:
   *  - an authority change was observed for this session since the last
   *    `clear()` (sticky — see class doc comment), or
   *  - the session has produced output *since* the last cwd report
   *    (`lastOutputAt` is newer than the record's `updatedAt`) and that
   *    report is older than `CWD_STALE_MS`.
   *
   * A session with no output since its last report, or no report at all,
   * is not "stale" — it's simply quiet, which is a different UI state
   * (§8.2 states 1/3 vs 4).
   */
  public isStale(sessionId: string, now: number, lastOutputAt: number | undefined): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    if (state.authorityStale) return true;
    if (lastOutputAt === undefined) return false;
    if (lastOutputAt <= state.record.updatedAt) return false;
    return now - state.record.updatedAt > CWD_STALE_MS;
  }

  /** Drop all tracked state for a session (disconnect — §5.4 hole b, or a
   * reconnect to a possibly different host reusing the same sessionId).
   * Cancels any pending rate-limit flush timer for the session so it cannot
   * fire a phantom delivery for state that no longer exists. */
  public clear(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      this.clearPendingFlush(state);
    }
    this.sessions.delete(sessionId);
  }

  /** Subscribe to cwd/state changes. Matches `NexusCore.onDidChange`'s style
   * (a plain listener Set + unsubscribe function) rather than
   * `vscode.EventEmitter`, since this module must stay vscode-free. Fires on:
   * a delivered cwd change (immediate or a rate-limit flush), the first-ever
   * report for a session, and a burst-shutdown transition (so the
   * coordinator can pick up state 7). */
  public onDidChangeCwd(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Clears every pending rate-limit flush timer across all sessions. Not a
   * requirement for correctness on its own (each timer is already guarded by
   * `clear()`/`reenable()`/re-delivery), but tears down any handle still
   * outstanding if the tracker itself is discarded (e.g. extension
   * deactivation) rather than leaving it to fire into an empty listener set. */
  public dispose(): void {
    for (const state of this.sessions.values()) {
      this.clearPendingFlush(state);
    }
  }

  private schedulePendingFlush(state: SessionState, delayMs: number): void {
    if (state.pendingFlush !== undefined) {
      // Already scheduled for this rate-limit window — it reads `state.record`
      // fresh when it fires, so it will pick up whatever is latest by then.
      return;
    }
    state.pendingFlush = setTimeout(() => {
      state.pendingFlush = undefined;
      if (state.disabled) {
        // Superseded by a burst shutdown while waiting — nothing to deliver.
        return;
      }
      // Advance lastFiredAt by exactly the window we scheduled for, computed
      // arithmetically (never via Date.now()) so the deterministic `now`
      // domain used by `report()` stays internally consistent even though
      // this callback itself runs off a real (or fake) timer.
      state.lastFiredAt = state.lastFiredAt + CWD_MIN_INTERVAL_MS;
      this.fireChange(state.record);
    }, delayMs);
  }

  private clearPendingFlush(state: SessionState): void {
    if (state.pendingFlush !== undefined) {
      clearTimeout(state.pendingFlush);
      state.pendingFlush = undefined;
    }
  }

  private fireChange(record: CwdRecord): void {
    for (const listener of this.listeners) {
      listener(record);
    }
  }
}
