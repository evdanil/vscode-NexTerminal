import { describe, expect, it } from "vitest";
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

  it("rejects a distinct value reported within CWD_MIN_INTERVAL_MS of the last accepted change", () => {
    const tracker = new CwdTracker();
    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    const changed = tracker.report(SID, SERVER, "/b", "osc7", "", CWD_MIN_INTERVAL_MS - 1);
    expect(changed).toBe(false);
    expect(tracker.getRecord(SID)?.cwd).toBe("/a"); // rejected change never applied
  });

  it("accepts a distinct value once CWD_MIN_INTERVAL_MS has elapsed", () => {
    const tracker = new CwdTracker();
    tracker.report(SID, SERVER, "/a", "osc7", "", 0);
    const changed = tracker.report(SID, SERVER, "/b", "osc7", "", CWD_MIN_INTERVAL_MS);
    expect(changed).toBe(true);
    expect(tracker.getRecord(SID)?.cwd).toBe("/b");
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

  it("fires onDidChangeCwd on an accepted change and not on a rejected/no-op report", () => {
    const tracker = new CwdTracker();
    const seen: string[] = [];
    const unsubscribe = tracker.onDidChangeCwd((record) => seen.push(record.cwd));

    tracker.report(SID, SERVER, "/a", "osc7", "", 0); // fires, updatedAt=0
    tracker.report(SID, SERVER, "/a", "osc7", "", 50); // heartbeat, updatedAt=50, no fire
    tracker.report(SID, SERVER, "/b", "osc7", "", 100); // distinct but < 300ms since updatedAt(50) — rejected, no fire
    tracker.report(SID, SERVER, "/b", "osc7", "", 50 + CWD_MIN_INTERVAL_MS); // >= 300ms since updatedAt(50) — fires

    expect(seen).toEqual(["/a", "/b"]);

    unsubscribe();
    // A further genuinely-accepted change must not reach the unsubscribed listener.
    tracker.report(SID, SERVER, "/c", "osc7", "", 50 + 2 * CWD_MIN_INTERVAL_MS);
    expect(seen).toEqual(["/a", "/b"]); // unsubscribed — no further pushes
  });

  it("multiple sessions track independently", () => {
    const tracker = new CwdTracker();
    tracker.report("s1", "srv", "/a", "osc7", "", 0);
    tracker.report("s2", "srv", "/z", "osc7", "", 0);
    expect(tracker.getRecord("s1")?.cwd).toBe("/a");
    expect(tracker.getRecord("s2")?.cwd).toBe("/z");
  });
});
