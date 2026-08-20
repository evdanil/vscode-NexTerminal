/**
 * @author kanekitakitos
 *
 * Unit tests for the daemon's `runtimeUpdate` coalescing window.
 *
 * The daemon bridges one `runtimeUpdate` push per TFTP block and per DHCP lease
 * mutation onto stdout. `createRuntimeUpdateThrottle` is what stops that from
 * becoming thousands of tiny JSON lines per second, so the properties under
 * test are the ones an unthrottled bridge would violate:
 *
 *  1. A burst collapses to one emission per window (write-volume reduction).
 *  2. The emission lands *after* the burst, so a host that samples state on
 *     receipt sees the final value — never a stale intermediate one. This is
 *     why the throttle fires on the trailing edge; a leading-edge one would
 *     announce block 1 and then leave the host frozen there.
 *  3. Terminal updates (`final`) bypass the window entirely — a completed
 *     transfer must never be swallowed by a window later pushes keep alive.
 *  4. Ids are independent: a busy transfer cannot delay a lease notification.
 *
 * The host-side view is modelled the way it really works: the emission carries
 * only an id, and the callback samples whatever the current state happens to
 * be at that moment (as the host does by issuing `getServiceRuntime`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeUpdateThrottle,
  RUNTIME_UPDATE_THROTTLE_MS
} from "../../../src/services/networkServers/runtimeUpdateThrottle";

const WINDOW = 50;

describe("runtimeUpdateThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses a burst of 1000 updates into a single emission carrying the final state", () => {
    /** Stands in for the runtime the host would read back on each notification. */
    let blocksTransferred = 0;
    const sampled: number[] = [];
    const throttle = createRuntimeUpdateThrottle(() => sampled.push(blocksTransferred), WINDOW);

    for (let i = 0; i < 1000; i++) {
      blocksTransferred++;
      throttle.push("tftp");
    }

    // Nothing on the wire yet: the whole burst fits inside one window.
    expect(sampled).toEqual([]);

    vi.advanceTimersByTime(WINDOW);

    expect(sampled.length, "1000 pushes must not produce 1000 writes").toBe(1);
    expect(sampled[0], "the emission must reflect the last state, not an early one").toBe(1000);
  });

  it("emits at most once per window while updates keep arriving", () => {
    const emitted: string[] = [];
    const throttle = createRuntimeUpdateThrottle((id) => emitted.push(id), WINDOW);

    // 10 windows' worth of wall clock, 20 pushes in each.
    for (let window = 0; window < 10; window++) {
      for (let i = 0; i < 20; i++) throttle.push("tftp");
      vi.advanceTimersByTime(WINDOW);
    }

    expect(emitted.length, `200 pushes over 10 windows produced ${emitted.length} writes`).toBe(10);
  });

  it("emits a terminal update immediately instead of waiting out the window", () => {
    let activeTransfers = 1;
    const sampled: number[] = [];
    const throttle = createRuntimeUpdateThrottle(() => sampled.push(activeTransfers), WINDOW);

    throttle.push("tftp");
    throttle.push("tftp");
    expect(sampled).toEqual([]);

    // transfer:complete — the transfer just left activeTransfers().
    activeTransfers = 0;
    throttle.push("tftp", true);

    expect(sampled, "a completed transfer must be visible without waiting out the window").toEqual([0]);

    // And the window it pre-empted must not fire a redundant second write.
    vi.advanceTimersByTime(WINDOW * 4);
    expect(sampled).toEqual([0]);
  });

  it("never swallows a terminal update behind a window that later pushes keep alive", () => {
    const emitted: string[] = [];
    const throttle = createRuntimeUpdateThrottle((id) => emitted.push(id), WINDOW);

    for (let i = 0; i < 500; i++) {
      throttle.push("tftp");
      vi.advanceTimersByTime(1);
    }
    const beforeFinal = emitted.length;
    throttle.push("tftp", true);

    expect(emitted.length - beforeFinal, "the final state must produce its own emission").toBe(1);
  });

  it("throttles each service id independently", () => {
    const emitted: string[] = [];
    const throttle = createRuntimeUpdateThrottle((id) => emitted.push(id), WINDOW);

    for (let i = 0; i < 100; i++) throttle.push("tftp");
    throttle.push("dhcp");

    vi.advanceTimersByTime(WINDOW);

    expect(emitted.filter((id) => id === "tftp").length).toBe(1);
    expect(emitted.filter((id) => id === "dhcp").length, "a busy transfer must not eat a lease update").toBe(1);
  });

  it("flush() drains pending updates so shutdown cannot drop the last state", () => {
    let leases = 0;
    const sampled: Array<{ id: string; leases: number }> = [];
    const throttle = createRuntimeUpdateThrottle((id) => sampled.push({ id, leases }), WINDOW);

    throttle.push("tftp");
    leases = 3;
    throttle.push("dhcp");

    throttle.flush();

    expect(sampled.map((s) => s.id).sort()).toEqual(["dhcp", "tftp"]);
    expect(sampled.every((s) => s.leases === 3)).toBe(true);

    // Drained, not merely duplicated onto the wire later.
    vi.advanceTimersByTime(WINDOW * 4);
    expect(sampled.length).toBe(2);
  });

  it("defaults to a window at or under the 10 Hz a reader can actually follow", () => {
    expect(RUNTIME_UPDATE_THROTTLE_MS).toBeGreaterThanOrEqual(100);
    expect(RUNTIME_UPDATE_THROTTLE_MS).toBeLessThanOrEqual(200);
  });
});
