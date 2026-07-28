/**
 * CwdTracker — per-session cwd state and policy (§5.1).
 *
 * A pure value object: no timers, no `Date.now()` calls, no `vscode` import.
 * `now` is always injected by the caller so tests are deterministic.
 * Staleness is computed lazily on read from `updatedAt` (§5.1/§7.5) rather
 * than pushed on a timer, which is what keeps this class trivially testable.
 *
 * Owns three independent pieces of policy, all Phase 1 (§7.3, §7.5):
 *  - Rate limiting: at most one *accepted change* per `CWD_MIN_INTERVAL_MS`
 *    per session, and a permanent per-session shutdown if reports sustain
 *    more than `CWD_BURST_RATE_PER_SEC` reports/second for
 *    `CWD_BURST_SUSTAIN_MS`.
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

/** §7.3 — accept at most one changed value per session within this window. */
export const CWD_MIN_INTERVAL_MS = 300;

/** §7.3 — sustained-burst threshold: reports/second above this rate... */
export const CWD_BURST_RATE_PER_SEC = 20;

/** ...for at least this long triggers a permanent per-session shutdown. */
export const CWD_BURST_SUSTAIN_MS = 3_000;

type ChangeListener = (record: CwdRecord) => void;

interface SessionState {
  record: CwdRecord;
  /** Sticky once set by an authority change; cleared only by `clear()`. */
  authorityStale: boolean;
  /** Sticky once the burst detector trips; cleared only by `clear()`. */
  disabled: boolean;
  /** Timestamps of every `report()` call within the trailing burst window,
   * used only for burst detection — independent of whether the report was
   * itself accepted as a change (§7.3: the flood itself is the risk, not
   * just floods of *distinct* values). */
  burstTimestamps: number[];
}

export class CwdTracker {
  private readonly sessions = new Map<string, SessionState>();
  private readonly listeners = new Set<ChangeListener>();

  /**
   * Report a freshly observed cwd for a session. Applies burst detection and
   * rate limiting, then updates the tracked record. Returns `true` only when
   * the tracked (cwd, authority) pair actually changed value — i.e. when the
   * caller (the coordinator) should treat this as a real transition worth
   * acting on. Repeated reports of the *same* value still refresh
   * `updatedAt` (a heartbeat, so lazy staleness reflects "still reporting"
   * rather than "directory hasn't changed lately") but return `false`.
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
    // whether it is ultimately accepted below — a flood of identical or
    // rate-limited reports is exactly the pattern this guards against.
    const burstTimestamps = existing ? existing.burstTimestamps : [];
    burstTimestamps.push(now);
    const cutoff = now - CWD_BURST_SUSTAIN_MS;
    while (burstTimestamps.length > 0 && burstTimestamps[0] < cutoff) {
      burstTimestamps.shift();
    }
    const windowSpan = now - burstTimestamps[0];
    const burstTripped =
      windowSpan >= CWD_BURST_SUSTAIN_MS &&
      burstTimestamps.length / (windowSpan / 1000) > CWD_BURST_RATE_PER_SEC;

    if (burstTripped) {
      const record: CwdRecord = existing?.record ?? { sessionId, serverId, cwd, source, authority, updatedAt: now };
      const state: SessionState = {
        record,
        authorityStale: existing?.authorityStale ?? false,
        disabled: true,
        burstTimestamps
      };
      this.sessions.set(sessionId, state);
      this.fireChange(state.record);
      return false;
    }

    if (!existing) {
      const record: CwdRecord = { sessionId, serverId, cwd, source, authority, updatedAt: now };
      this.sessions.set(sessionId, { record, authorityStale: false, disabled: false, burstTimestamps });
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

    if (now - existing.record.updatedAt < CWD_MIN_INTERVAL_MS) {
      // §7.3: at most one accepted change per CWD_MIN_INTERVAL_MS — drop this one.
      existing.burstTimestamps = burstTimestamps;
      return false;
    }

    const authorityChanged = existing.record.authority !== authority;
    existing.record = { sessionId, serverId, cwd, source, authority, updatedAt: now };
    existing.burstTimestamps = burstTimestamps;
    if (authorityChanged) {
      // §7.1/§7.5: the nested-ssh/tmux signal. Sticky — see class doc comment.
      existing.authorityStale = true;
    }
    this.fireChange(existing.record);
    return true;
  }

  /** The current tracked record for a session, or `undefined` if none exists
   * (the "no source reported yet" case — distinct from stale). */
  public getRecord(sessionId: string): CwdRecord | undefined {
    return this.sessions.get(sessionId)?.record;
  }

  /** True once the §7.3 burst detector has permanently shut tracking off for
   * this session (until `clear()`). Observable state for the UI (state 7)
   * and for the caller to log via the Nexus output channel (§7.6) — this
   * module cannot log itself, since it must stay `vscode`-free. */
  public isDisabled(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.disabled ?? false;
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
   * reconnect to a possibly different host reusing the same sessionId). */
  public clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Subscribe to cwd/state changes. Matches `NexusCore.onDidChange`'s style
   * (a plain listener Set + unsubscribe function) rather than
   * `vscode.EventEmitter`, since this module must stay vscode-free. Fires on:
   * an accepted cwd change, the first-ever report for a session, and a
   * burst-shutdown transition (so the coordinator can pick up state 7). */
  public onDidChangeCwd(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private fireChange(record: CwdRecord): void {
    for (const listener of this.listeners) {
      listener(record);
    }
  }
}
