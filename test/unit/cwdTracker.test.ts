import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CwdTracker,
  CWD_MIN_INTERVAL_MS,
  CWD_STALE_MS,
  CWD_BURST_RATE_PER_SEC,
  CWD_BURST_SUSTAIN_MS
} from "../../src/services/terminal/cwdTracker";

const SID = "session-1";
const SERVER = "server-1";

describe("CwdTracker", () => {
  // ─── Basic accept / no-op ───────────────────────────────────────────────

  it("accepts the first report for a session", () => {
    const tracker = new CwdTracker();
    const changed = tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    expect(changed).toBe(true);
    expect(tracker.getRecord(SID)).toEqual({
      sessionId: SID,
      serverId: SERVER,
      cwd: "/a",
      source: "osc7",
      authority: "",
      updatedAt: 0
    });
  });

  it("returns false and does not fire a change for a repeated identical value", () => {
    const tracker = new CwdTracker();
    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    const changed = tracker.report(SID, SERVER, "/a", "osc7", "", 50);
    expect(changed).toBe(false);
  });

  it("still refreshes updatedAt on a repeated identical value (heartbeat)", () => {
    const tracker = new CwdTracker();
    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    tracker.report(SID, SERVER, "/a", "osc7", "", 59_000); // heartbeat, no change
    expect(tracker.getRecord(SID)?.updatedAt).toBe(59_000);
  });

  // ─── Rate limiting (§7.3) ────────────────────────────────────────────────
  //
  // Rate limiting gates *listener delivery* only — the tracked record itself
  // always reflects the latest report immediately, even mid-window. These
  // tests use real (fake) timers because the rate-limit flush is delivered
  // via a `setTimeout` scheduled at report() time (see the class doc comment).

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retains a distinct value reported within CWD_MIN_INTERVAL_MS of the last delivery as the current record, but defers listener delivery", () => {
    const tracker = new CwdTracker();
    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    const changed = tracker.report(SID, SERVER, "/b", "osc7", "", CWD_MIN_INTERVAL_MS - 1);
    expect(changed).toBe(false); // not delivered synchronously...
    expect(tracker.getRecord(SID)?.cwd).toBe("/b"); // ...but already the current record
  });

  it("accepts a distinct value once CWD_MIN_INTERVAL_MS has elapsed", () => {
    const tracker = new CwdTracker();
    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    const changed = tracker.report(SID, SERVER, "/b", "osc7", "", CWD_MIN_INTERVAL_MS);
    expect(changed).toBe(true);
    expect(tracker.getRecord(SID)?.cwd).toBe("/b");
  });

  it("a same-window burst (one ssh2 chunk, two matches stamped with the same `now`) keeps the FINAL value, not the first, and eventually delivers it", () => {
    const tracker = new CwdTracker();
    const seen: string[] = [];
    tracker.onDidChangeCwd((r) => seen.push(r.cwd));

    tracker.report(SID, SERVER, "/a", "osc7", "", 0); // first ever report — delivered immediately
    expect(seen).toEqual(["/a"]);

    // Two distinct values from a single chunk share one `now` (mirrors
    // serverCommands.ts's single `Date.now()` call covering the whole chunk).
    const mid = tracker.report(SID, SERVER, "/mid", "osc7", "", 10);
    const fin = tracker.report(SID, SERVER, "/final", "osc7", "", 10);
    expect(mid).toBe(false);
    expect(fin).toBe(false);

    // The record must already hold the latest value even though nothing has
    // been delivered to listeners yet.
    expect(tracker.getRecord(SID)?.cwd).toBe("/final");
    expect(seen).toEqual(["/a"]); // no new delivery yet — still rate-limited

    vi.advanceTimersByTime(CWD_MIN_INTERVAL_MS);

    // Once the window elapses, the tracker delivers the FINAL pending value —
    // never the first one that happened to squeak past the rate limit, and
    // never silently dropped.
    expect(seen).toEqual(["/a", "/final"]);
  });

  it("does not schedule a second flush timer for a second rate-limited value in the same window — the single scheduled flush picks up the latest record when it fires", () => {
    const tracker = new CwdTracker();
    const seen: string[] = [];
    tracker.onDidChangeCwd((r) => seen.push(r.cwd));

    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    tracker.report(SID, SERVER, "/b", "osc7", "", 50); // rate-limited, schedules a flush for now=300
    tracker.report(SID, SERVER, "/c", "osc7", "", 100); // rate-limited too — must NOT reschedule

    vi.advanceTimersByTime(CWD_MIN_INTERVAL_MS);

    expect(seen).toEqual(["/a", "/c"]); // exactly one flush delivery, carrying the latest value
  });

  it("a heartbeat (same value) does not disturb a pending rate-limit flush", () => {
    const tracker = new CwdTracker();
    const seen: string[] = [];
    tracker.onDidChangeCwd((r) => seen.push(r.cwd));

    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    tracker.report(SID, SERVER, "/b", "osc7", "", 50); // rate-limited, schedules a flush
    tracker.report(SID, SERVER, "/b", "osc7", "", 75); // heartbeat — same value, no-op for delivery

    vi.advanceTimersByTime(CWD_MIN_INTERVAL_MS);

    expect(seen).toEqual(["/a", "/b"]);
  });

  it("a burst-shutdown while a flush is pending cancels it — no phantom delivery after the session is disabled", () => {
    const tracker = new CwdTracker();
    const seen: string[] = [];
    tracker.onDidChangeCwd((r) => seen.push(r.cwd));

    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    tracker.report(SID, SERVER, "/b", "osc7", "", 50); // rate-limited, schedules a flush at now=300

    // Sustained burst trips the shutdown before the scheduled flush fires.
    for (let i = 0; i <= 60; i++) {
      tracker.report(SID, SERVER, `/dir-${i}`, "osc7", "", 100 + i * 50);
    }
    expect(tracker.isDisabled(SID)).toBe(true);

    seen.length = 0;
    vi.advanceTimersByTime(5_000);
    expect(seen).toEqual([]); // the pre-shutdown flush never fires
  });

  it("clear() cancels a pending rate-limit flush so it cannot fire into cleared state", () => {
    const tracker = new CwdTracker();
    const seen: string[] = [];
    tracker.onDidChangeCwd((r) => seen.push(r.cwd));

    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    tracker.report(SID, SERVER, "/b", "osc7", "", 50); // schedules a flush

    tracker.clear(SID);
    seen.length = 0;
    vi.advanceTimersByTime(CWD_MIN_INTERVAL_MS);

    expect(seen).toEqual([]);
  });

  it("dispose() cancels every pending flush across all sessions", () => {
    const tracker = new CwdTracker();
    const seen: string[] = [];
    tracker.onDidChangeCwd((r) => seen.push(r.cwd));

    tracker.report("s1", "srv", "/a", "osc7", "", 0);
    tracker.report("s1", "srv", "/b", "osc7", "", 50); // pending flush for s1
    tracker.report("s2", "srv", "/x", "osc7", "", 0);
    tracker.report("s2", "srv", "/y", "osc7", "", 50); // pending flush for s2

    tracker.dispose();
    seen.length = 0;
    vi.advanceTimersByTime(CWD_MIN_INTERVAL_MS);

    expect(seen).toEqual([]);
  });

  // ─── Burst shutdown (§7.3) ───────────────────────────────────────────────

  it("permanently disables tracking after a sustained >20 reports/sec burst for 3s", () => {
    const tracker = new CwdTracker();
    // 61 reports spaced 50ms apart spans exactly 3000ms once the 61st fires,
    // for a rate of 61 / 3.0s ≈ 20.33/s — just over the threshold.
    let tripped = false;
    for (let i = 0; i <= 60; i++) {
      const now = i * 50;
      tracker.report(SID, SERVER, `/dir-${i}`, "osc7", "", now);
      if (tracker.isDisabled(SID)) {
        tripped = true;
        expect(now).toBe(60 * 50); // trips on the 61st call, not earlier
        break;
      }
    }
    expect(tripped).toBe(true);
    expect(CWD_BURST_SUSTAIN_MS).toBe(3_000);
    expect(CWD_BURST_RATE_PER_SEC).toBe(20);
  });

  it("stays disabled even for reports arriving well within the rate limit afterward", () => {
    const tracker = new CwdTracker();
    for (let i = 0; i <= 60; i++) {
      tracker.report(SID, SERVER, `/dir-${i}`, "osc7", "", i * 50);
    }
    expect(tracker.isDisabled(SID)).toBe(true);
    const changed = tracker.report(SID, SERVER, "/late", "osc7", "", 3_000 + 10 * CWD_MIN_INTERVAL_MS);
    expect(changed).toBe(false);
    expect(tracker.isDisabled(SID)).toBe(true);
  });

  it("does not disable a session that never sustains the burst rate", () => {
    const tracker = new CwdTracker();
    // One accepted change every 500ms (well under 20/s) for several seconds.
    for (let i = 0; i < 20; i++) {
      tracker.report(SID, SERVER, `/dir-${i}`, "osc7", "", i * 500);
    }
    expect(tracker.isDisabled(SID)).toBe(false);
  });

  it("trips on a non-divisor cadence (~21.3/s, over threshold) that the old windowSpan>=3000 alignment check let evade detection entirely", () => {
    const tracker = new CwdTracker();
    // 47ms does not evenly divide CWD_BURST_SUSTAIN_MS (3000), so pruning
    // never leaves a retained sample exactly 3000ms old — the old formula's
    // `windowSpan >= CWD_BURST_SUSTAIN_MS` gate was never satisfied and this
    // stream evaded the burst detector forever despite exceeding 20/s.
    let tripped = false;
    for (let i = 0; i < 200; i++) {
      tracker.report(SID, SERVER, `/dir-${i}`, "osc7", "", i * 47);
      if (tracker.isDisabled(SID)) {
        tripped = true;
        break;
      }
    }
    expect(tripped).toBe(true);
  });

  it("does not trip on a cadence that never exceeds 20/s even when its window span happens to fall short of 3000ms", () => {
    const tracker = new CwdTracker();
    // 60ms cadence = 16.67/s, comfortably under threshold regardless of
    // alignment — the count-based check must not produce a false positive.
    for (let i = 0; i < 100; i++) {
      tracker.report(SID, SERVER, `/dir-${i}`, "osc7", "", i * 60);
    }
    expect(tracker.isDisabled(SID)).toBe(false);
  });

  // ─── Lazy staleness from updatedAt (§5.1/§7.5) ─────────────────────────

  it("is not stale when there has been no output since the last report", () => {
    const tracker = new CwdTracker();
    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    expect(tracker.isStale(SID, 200_000, undefined)).toBe(false);
  });

  it("is not stale when output happened but the report is still within the threshold", () => {
    const tracker = new CwdTracker();
    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    expect(tracker.isStale(SID, CWD_STALE_MS, CWD_STALE_MS - 1)).toBe(false);
  });

  it("is stale once output has happened since the last report and it's older than CWD_STALE_MS", () => {
    const tracker = new CwdTracker();
    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    expect(tracker.isStale(SID, CWD_STALE_MS + 1, CWD_STALE_MS)).toBe(true);
  });

  it("a heartbeat report defers staleness past what the original updatedAt would have implied", () => {
    const tracker = new CwdTracker();
    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    tracker.report(SID, SERVER, "/a", "osc7", "", 59_000); // heartbeat refreshes updatedAt to 59_000
    // Without the heartbeat refresh, now(61_000) - originalUpdatedAt(0) = 61_000 > 60_000 would be stale.
    expect(tracker.isStale(SID, 61_000, 60_999)).toBe(false);
  });

  it("returns false from isStale for a session with no record at all", () => {
    const tracker = new CwdTracker();
    expect(tracker.isStale(SID, 1_000_000, 999_999)).toBe(false);
  });

  // ─── Authority change → stale (§7.1/§7.5) ──────────────────────────────

  it("marks a session stale immediately when the reported authority changes", () => {
    const tracker = new CwdTracker();
    tracker.report(SID, SERVER, "/home/dev", "osc7", "hostA", 0);
    tracker.report(SID, SERVER, "/home/dev", "osc7", "hostB", CWD_MIN_INTERVAL_MS);
    // Stale regardless of elapsed time / output — the authority flip is its own signal.
    expect(tracker.isStale(SID, CWD_MIN_INTERVAL_MS, undefined)).toBe(true);
  });

  it("does not mark stale when the authority stays the same across changes", () => {
    const tracker = new CwdTracker();
    tracker.report(SID, SERVER, "/home/dev", "osc7", "hostA", 0);
    tracker.report(SID, SERVER, "/var/log", "osc7", "hostA", CWD_MIN_INTERVAL_MS);
    expect(tracker.isStale(SID, CWD_MIN_INTERVAL_MS, undefined)).toBe(false);
  });

  // ─── Clear on disconnect (§5.4 hole b) ──────────────────────────────────

  it("clear() removes all tracked state so a fresh report behaves like a new session", () => {
    const tracker = new CwdTracker();
    tracker.report(SID, SERVER, "/a", "osc7", "hostA", 0);
    tracker.report(SID, SERVER, "/b", "osc7", "hostB", CWD_MIN_INTERVAL_MS); // marks authority-stale

    tracker.clear(SID);

    expect(tracker.getRecord(SID)).toBeUndefined();
    expect(tracker.isDisabled(SID)).toBe(false);
    expect(tracker.isStale(SID, 10_000_000, 9_999_999)).toBe(false);

    // A report re-using the same sessionId (e.g. reconnect to a different
    // host) is accepted immediately, not rate-limited against old history.
    const changed = tracker.report(SID, SERVER, "/fresh", "osc7", "hostC", 1);
    expect(changed).toBe(true);
    expect(tracker.getRecord(SID)?.cwd).toBe("/fresh");
  });

  it("clear() on a disabled session lifts the shutdown", () => {
    const tracker = new CwdTracker();
    for (let i = 0; i <= 60; i++) {
      tracker.report(SID, SERVER, `/dir-${i}`, "osc7", "", i * 50);
    }
    expect(tracker.isDisabled(SID)).toBe(true);
    tracker.clear(SID);
    expect(tracker.isDisabled(SID)).toBe(false);
    expect(tracker.report(SID, SERVER, "/new", "osc7", "", 1_000_000)).toBe(true);
  });

  // ─── onDidChangeCwd listener ────────────────────────────────────────────

  it("fires onDidChangeCwd immediately on the first report and via the deferred rate-limit flush thereafter; never for a heartbeat", () => {
    const tracker = new CwdTracker();
    const seen: string[] = [];
    const unsubscribe = tracker.onDidChangeCwd((record) => seen.push(record.cwd));

    tracker.report(SID, SERVER, "/a", "osc7", "", 0); // first ever — fires immediately
    expect(seen).toEqual(["/a"]);

    tracker.report(SID, SERVER, "/a", "osc7", "", 50); // heartbeat — never fires
    expect(seen).toEqual(["/a"]);

    tracker.report(SID, SERVER, "/b", "osc7", "", 100); // distinct, < 300ms since last delivery — deferred
    expect(seen).toEqual(["/a"]);

    vi.advanceTimersByTime(CWD_MIN_INTERVAL_MS);
    expect(seen).toEqual(["/a", "/b"]); // the deferred flush delivers it

    unsubscribe();
    // A further genuinely-delivered change must not reach the unsubscribed listener.
    tracker.report(SID, SERVER, "/c", "osc7", "", 100 + 2 * CWD_MIN_INTERVAL_MS);
    expect(seen).toEqual(["/a", "/b"]); // unsubscribed — no further pushes
  });

  // ─── reenable() — §7.3/§8.2 state 7 recovery ───────────────────────────

  it("reenable() lifts a burst shutdown while preserving the last known record", () => {
    const tracker = new CwdTracker();
    for (let i = 0; i <= 60; i++) {
      tracker.report(SID, SERVER, `/dir-${i}`, "osc7", "", i * 50);
    }
    expect(tracker.isDisabled(SID)).toBe(true);
    const before = tracker.getRecord(SID);

    tracker.reenable(SID);

    expect(tracker.isDisabled(SID)).toBe(false);
    expect(tracker.getRecord(SID)).toEqual(before); // record survives — unlike clear()
  });

  it("reenable() resets the burst window so a session doesn't immediately re-trip on the very next report", () => {
    const tracker = new CwdTracker();
    for (let i = 0; i <= 60; i++) {
      tracker.report(SID, SERVER, `/dir-${i}`, "osc7", "", i * 50); // trips at i=60, now=3000
    }
    expect(tracker.isDisabled(SID)).toBe(true);

    tracker.reenable(SID);
    // React quickly (within the original 3s burst window) — without clearing
    // burstTimestamps, the stale entries would still count toward the next
    // check and re-trip immediately.
    tracker.report(SID, SERVER, "/recovered", "osc7", "", 3_050);

    expect(tracker.isDisabled(SID)).toBe(false);
    expect(tracker.getRecord(SID)?.cwd).toBe("/recovered");
  });

  it("reenable() is a no-op for a session with no tracked state", () => {
    const tracker = new CwdTracker();
    expect(() => tracker.reenable("nonexistent")).not.toThrow();
    expect(tracker.isDisabled("nonexistent")).toBe(false);
  });

  it("multiple sessions track independently", () => {
    const tracker = new CwdTracker();
    tracker.report("s1", "srv", "/a", "osc7", "", 0);
    tracker.report("s2", "srv", "/z", "osc7", "", 0);
    expect(tracker.getRecord("s1")?.cwd).toBe("/a");
    expect(tracker.getRecord("s2")?.cwd).toBe("/z");
  });
});
