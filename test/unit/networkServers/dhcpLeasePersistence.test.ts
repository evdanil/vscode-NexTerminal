/**
 * @author kanekitakitos
 *
 * Unit tests for the DHCP lease store — the thing that stops a daemon restart
 * from handing a live device's address to a second device.
 *
 * The properties under test are the ones an in-memory-only lease table
 * violates, plus the ones a naive "just reload the file" implementation would:
 *
 *  1. A saved table reloads with every field intact (round trip).
 *  2. An expired lease is not restored — the device no longer holds a claim.
 *  3. A persisted dynamic lease loses to a static reservation added since the
 *     file was written. `_selectAddress` reads `_state` *before* the static map
 *     (dhcp.js:275-289), so restoring it would shadow the reservation for as
 *     long as the client keeps renewing.
 *  4. A lease outside the pool now configured is dropped — the range was
 *     re-pointed at another subnet.
 *  5. A burst of lease events produces far fewer writes than events.
 *
 * Files are written to a real temp directory rather than a mocked `fs`: the
 * atomicity claim (temp file + rename) is only meaningful against a real
 * filesystem, and the round trip is worth exercising through actual JSON.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createDhcpLeaseStore,
  LEASE_PERSIST_DEBOUNCE_MS,
  LEASE_STORE_VERSION,
  loadLeases,
  reconcilePersistedLeases,
  saveLeases,
  toRestoredLeaseState
} from "../../../src/services/networkServers/dhcp/engine/dhcpLeasePersistence";
import type { DhcpLeaseInfo } from "../../../src/services/networkServers/dhcp/engine/dhcpLeaseUtils";

const NOW = 1_770_000_000_000;

let tempDir: string;
let storePath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-dhcp-leases-"));
  storePath = path.join(tempDir, "networkServers", "dhcp-leases.json");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function lease(overrides: Partial<DhcpLeaseInfo> = {}): DhcpLeaseInfo {
  const leaseSec = overrides.leaseSec ?? 3600;
  const boundAt = overrides.boundAt ?? NOW - 60_000;
  return {
    mac: "aa:bb:cc:dd:ee:01",
    ip: "192.168.2.50",
    boundAt,
    leaseSec,
    expiresAt: boundAt + leaseSec * 1000,
    hostname: "bench-switch",
    leaseType: "dynamic",
    ...overrides
  };
}

/** Pool + reservations the reconciler is asked to validate leases against. */
function context(overrides: Partial<Parameters<typeof reconcilePersistedLeases>[1]> = {}) {
  return {
    staticMap: {} as Record<string, string>,
    rangeStart: "192.168.2.10",
    rangeEnd: "192.168.2.199",
    now: NOW,
    ...overrides
  };
}

describe("dhcpLeasePersistence — save/load round trip", () => {
  it("reloads every lease field exactly as written", async () => {
    const leases = [
      lease(),
      lease({ mac: "aa:bb:cc:dd:ee:02", ip: "192.168.2.51", hostname: null, leaseSec: 7200 })
    ];

    await saveLeases(storePath, leases);

    expect(loadLeases(storePath)).toEqual(leases);
  });

  it("creates the storage directory on demand", async () => {
    expect(fs.existsSync(path.dirname(storePath))).toBe(false);

    await saveLeases(storePath, [lease()]);

    expect(fs.existsSync(storePath)).toBe(true);
  });

  it("leaves no temp file behind, so a reader never sees a half-written table", async () => {
    await saveLeases(storePath, [lease()]);

    const strays = fs.readdirSync(path.dirname(storePath)).filter((name) => name.endsWith(".tmp"));
    expect(strays, "the temp file must be renamed over the target, not left next to it").toEqual([]);
  });

  it("overwrites a previous table rather than appending to it", async () => {
    await saveLeases(storePath, [lease(), lease({ mac: "aa:bb:cc:dd:ee:02", ip: "192.168.2.51" })]);
    await saveLeases(storePath, [lease({ mac: "aa:bb:cc:dd:ee:09", ip: "192.168.2.90" })]);

    const reloaded = loadLeases(storePath);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].mac).toBe("aa:bb:cc:dd:ee:09");
  });

  it("degrades to an empty table instead of throwing on an unusable file", () => {
    expect(loadLeases(path.join(tempDir, "absent.json")), "missing file").toEqual([]);

    fs.writeFileSync(path.join(tempDir, "corrupt.json"), "{ not json", "utf8");
    expect(loadLeases(path.join(tempDir, "corrupt.json")), "truncated JSON").toEqual([]);

    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({ version: LEASE_STORE_VERSION + 1, leases: [lease()] }), "utf8");
    expect(loadLeases(storePath), "future schema version").toEqual([]);
  });

  it("drops individual malformed entries while keeping the sound ones", () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: LEASE_STORE_VERSION,
        savedAt: NOW,
        leases: [{ mac: "aa:bb:cc:dd:ee:07" }, null, lease({ mac: "aa:bb:cc:dd:ee:08", ip: "192.168.2.80" })]
      }),
      "utf8"
    );

    const reloaded = loadLeases(storePath);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].ip).toBe("192.168.2.80");
  });
});

describe("dhcpLeasePersistence — reconciliation against current configuration", () => {
  it("drops a lease that has already expired", () => {
    const expired = lease({ mac: "aa:bb:cc:dd:ee:03", ip: "192.168.2.60", boundAt: NOW - 7_200_000, leaseSec: 3600 });
    const live = lease({ mac: "aa:bb:cc:dd:ee:04", ip: "192.168.2.61" });

    const { restored, dropped } = reconcilePersistedLeases([expired, live], context());

    expect(restored.map((l) => l.mac), "an expired lease is no longer a claim on the address").toEqual([
      "aa:bb:cc:dd:ee:04"
    ]);
    expect(dropped).toEqual([{ lease: expired, reason: "expired" }]);
  });

  it("refuses a persisted dynamic lease that a static reservation now contradicts", () => {
    const stale = lease({ mac: "aa:bb:cc:dd:ee:05", ip: "192.168.2.70" });

    const { restored, dropped } = reconcilePersistedLeases(
      [stale],
      context({ staticMap: { "aa:bb:cc:dd:ee:05": "192.168.2.5" } })
    );

    expect(restored, "static configuration must win over a stale persisted lease").toEqual([]);
    expect(dropped).toEqual([{ lease: stale, reason: "static-conflict" }]);
  });

  it("refuses a persisted lease sitting on an address now reserved for a different MAC", () => {
    const squatter = lease({ mac: "aa:bb:cc:dd:ee:06", ip: "192.168.2.70" });

    const { restored, dropped } = reconcilePersistedLeases(
      [squatter],
      context({ staticMap: { "aa:bb:cc:dd:ee:99": "192.168.2.70" } })
    );

    expect(restored, "restoring it would re-create the very IP conflict this guards against").toEqual([]);
    expect(dropped[0].reason).toBe("static-conflict");
  });

  it("keeps a reserved MAC whose persisted address still matches the reservation", () => {
    const reserved = lease({ mac: "aa:bb:cc:dd:ee:05", ip: "192.168.2.5", leaseType: "static" });

    const { restored } = reconcilePersistedLeases(
      [reserved],
      context({ staticMap: { "aa:bb:cc:dd:ee:05": "192.168.2.5" } })
    );

    expect(restored).toHaveLength(1);
    expect(restored[0].leaseType).toBe("static");
    expect(restored[0].boundAt, "history is preserved for a reserved device too").toBe(reserved.boundAt);
  });

  it("drops a dynamic lease that the currently configured pool no longer covers", () => {
    const below = lease({ mac: "aa:bb:cc:dd:ee:0a", ip: "192.168.2.9" });
    const above = lease({ mac: "aa:bb:cc:dd:ee:0b", ip: "192.168.2.200" });
    const otherSubnet = lease({ mac: "aa:bb:cc:dd:ee:0c", ip: "10.0.0.50" });
    const inside = lease({ mac: "aa:bb:cc:dd:ee:0d", ip: "192.168.2.10" });

    const { restored, dropped } = reconcilePersistedLeases([below, above, otherSubnet, inside], context());

    expect(restored.map((l) => l.ip)).toEqual(["192.168.2.10"]);
    expect(dropped.map((d) => d.reason)).toEqual(["out-of-pool", "out-of-pool", "out-of-pool"]);
  });

  it("compares pool bounds unsigned, so a 200.x range is not read as negative", () => {
    const inside = lease({ mac: "aa:bb:cc:dd:ee:0e", ip: "200.0.0.50" });

    const { restored } = reconcilePersistedLeases(
      [inside],
      context({ rangeStart: "200.0.0.10", rangeEnd: "200.0.0.99" })
    );

    expect(restored).toHaveLength(1);
  });
});

describe("dhcpLeasePersistence — seeding the dhcp library's lease table", () => {
  it("produces a BOUND entry the library's address selection will honour", () => {
    const state = toRestoredLeaseState(lease(), "192.168.2.1");

    expect(state.address, "_selectAddress returns _state[mac].address first (dhcp.js:275-277)").toBe("192.168.2.50");
    expect(state.state).toBe("BOUND");
    expect(state.bindTime?.getTime()).toBe(NOW - 60_000);
    expect(state.leasePeriod).toBe(3600);
    expect(state.server).toBe("192.168.2.1");
    expect(state.options?.hostname).toBe("bench-switch");
  });

  it("leaves leaseTime unset, matching entries the library writes itself", () => {
    const state = toRestoredLeaseState(lease(), "192.168.2.1");

    // dhcp.js:308 only ever *reads* leaseTime, in the pool-exhaustion eviction
    // scan. A number here would make restored leases the first ones evicted
    // while library-created ones (undefined) are never picked.
    expect(state.leaseTime).toBeUndefined();
  });
});

describe("dhcpLeasePersistence — debounced writer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses a burst of lease events into a single write carrying the final table", async () => {
    const writes: Array<readonly DhcpLeaseInfo[]> = [];
    const table: DhcpLeaseInfo[] = [];
    const store = createDhcpLeaseStore(
      storePath,
      () => [...table],
      {
        delayMs: 50,
        write: async (_filePath, leases) => {
          writes.push(leases);
        }
      }
    );

    // 200 lease mutations inside one window — a switch stack powering on.
    for (let i = 0; i < 200; i++) {
      table.push(lease({ mac: `aa:bb:cc:dd:ff:${i.toString(16).padStart(2, "0")}` }));
      store.schedule();
    }

    expect(writes, "nothing may hit the disk while events are still arriving").toEqual([]);

    await vi.advanceTimersByTimeAsync(50);

    expect(writes.length, `200 lease events produced ${writes.length} writes`).toBe(1);
    expect(writes[0], "the write must carry the final table, not an early snapshot").toHaveLength(200);
    expect(writes.length).toBeLessThan(200);
  });

  it("restarts the window on each change, so a steady stream writes once it settles", async () => {
    const writes: number[] = [];
    const store = createDhcpLeaseStore(storePath, () => [], {
      delayMs: 50,
      write: async () => {
        writes.push(Date.now());
      }
    });

    for (let i = 0; i < 20; i++) {
      store.schedule();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(writes, "a trailing-edge window must not fire mid-stream").toEqual([]);

    await vi.advanceTimersByTimeAsync(50);
    expect(writes.length).toBe(1);
  });

  it("flush() writes a pending change immediately, so shutdown cannot lose it", async () => {
    const writes: Array<readonly DhcpLeaseInfo[]> = [];
    const store = createDhcpLeaseStore(storePath, () => [lease()], {
      delayMs: 10_000,
      write: async (_filePath, leases) => {
        writes.push(leases);
      }
    });

    store.schedule();
    await store.flush();

    expect(writes).toHaveLength(1);

    // Drained, not merely duplicated onto the disk later.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(writes).toHaveLength(1);
  });

  it("dispose() cancels a pending write", async () => {
    const writes: number[] = [];
    const store = createDhcpLeaseStore(storePath, () => [], {
      delayMs: 50,
      write: async () => {
        writes.push(1);
      }
    });

    store.schedule();
    store.dispose();
    await vi.advanceTimersByTimeAsync(500);

    expect(writes).toEqual([]);
  });

  it("reports a failing write instead of rejecting into the lease path", async () => {
    const errors: unknown[] = [];
    const store = createDhcpLeaseStore(storePath, () => [lease()], {
      delayMs: 10,
      write: async () => {
        throw new Error("EROFS: read-only file system");
      },
      onError: (error) => errors.push(error)
    });

    store.schedule();
    await vi.advanceTimersByTimeAsync(10);

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("EROFS");
  });

  it("writes through to the real file with the default sink", async () => {
    vi.useRealTimers();
    const store = createDhcpLeaseStore(storePath, () => [lease()], { delayMs: 1 });

    store.schedule();
    await store.flush();

    expect(loadLeases(storePath)).toEqual([lease()]);
  });

  it("defaults to a window short enough that a crash loses little history", () => {
    expect(LEASE_PERSIST_DEBOUNCE_MS).toBeGreaterThanOrEqual(100);
    expect(LEASE_PERSIST_DEBOUNCE_MS).toBeLessThanOrEqual(1000);
  });
});
