/** @author kanekitakitos */

/**
 * Disk persistence for the active DHCP lease table.
 *
 * ## Why this exists
 *
 * The `dhcp` library keeps its whole lease table in `Server._state`, a plain
 * in-memory object. A daemon restart — crash, extension reload, VS Code
 * restart — therefore starts with an empty table, and the very next
 * DHCPDISCOVER can be handed an address a device on the bench is still
 * holding under an unexpired lease. Two devices, one IP: exactly the failure
 * a lab DHCP server exists to avoid.
 *
 * Writing the table out and reading it back on start closes that window.
 *
 * ## Why the file is written the way it is
 *
 * - **Debounced.** A single client walking DISCOVER → REQUEST produces several
 *   `_state` mutations within milliseconds, and a room full of devices
 *   powering on produces bursts of them. One write per event would be one file
 *   rewrite per packet; a trailing-edge window collapses each burst into one.
 * - **Atomic.** The write goes to a temp file and is then renamed over the
 *   target. A crash mid-write leaves either the previous complete file or an
 *   orphan temp file — never a truncated lease table, which would be worse
 *   than no file at all since it would silently restore a partial view of who
 *   owns what.
 * - **Serialised.** Writes are chained rather than fired concurrently, so a
 *   slow write can never be overtaken by a later one and leave older leases on
 *   disk than the ones already superseded.
 *
 * No `vscode` import here (nor anywhere under `engine/`): this code runs inside
 * the network-server daemon, a bare Node child process. The store path is
 * resolved by the extension host and threaded in through `DhcpEngineConfig`.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type { LeaseState } from 'dhcp';

import { isIpInPool } from './dhcpNetworkUtils';
import { normalizeStaticMap, toLibraryMacKey } from './dhcpLeaseUtils';
import type { DhcpLeaseInfo, DhcpLeaseType } from './dhcpLeaseUtils';

/**
 * Schema version of the on-disk file.
 *
 * A file written by a different version is discarded rather than migrated:
 * the whole table is rebuilt within one lease renewal cycle anyway, so the
 * cost of dropping it is far lower than the cost of mis-reading it.
 */
export const LEASE_STORE_VERSION = 1;

/**
 * Trailing-edge window between the last lease change and the write.
 *
 * Long enough to swallow the DISCOVER/REQUEST burst of a client (and of a
 * whole switch stack coming up at once), short enough that a crash loses at
 * most half a second of lease history.
 */
export const LEASE_PERSIST_DEBOUNCE_MS = 500;

/** Shape of the persisted file. */
interface LeaseStoreFile {
  readonly version: number;
  /** Epoch ms of the write. Diagnostic only — expiry is decided per lease. */
  readonly savedAt: number;
  readonly leases: readonly DhcpLeaseInfo[];
}

/** Why a persisted lease was not restored. Surfaced in the engine's log line. */
export type LeaseDropReason = 'expired' | 'static-conflict' | 'out-of-pool';

/** A persisted lease that reconciliation refused to restore, and why. */
export interface DroppedLease {
  readonly lease: DhcpLeaseInfo;
  readonly reason: LeaseDropReason;
}

/** Current configuration a persisted lease has to still agree with. */
export interface LeaseReconcileContext {
  /** MAC → IP reservations currently configured. */
  readonly staticMap: Readonly<Record<string, string>>;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  /** Epoch ms used to decide expiry (injected so tests are deterministic). */
  readonly now: number;
}

/** Outcome of {@link reconcilePersistedLeases}. */
export interface LeaseReconcileResult {
  readonly restored: readonly DhcpLeaseInfo[];
  readonly dropped: readonly DroppedLease[];
}

const LEASE_TYPES: readonly DhcpLeaseType[] = ['dynamic', 'static', 'renewed', 'inform'];

/** Rejects anything that is not a complete, well-typed lease record. */
function isLeaseRecord(value: unknown): value is DhcpLeaseInfo {
  if (!value || typeof value !== 'object') return false;
  const lease = value as Record<string, unknown>;
  return (
    typeof lease.mac === 'string' && lease.mac.length > 0 &&
    typeof lease.ip === 'string' && lease.ip.length > 0 &&
    typeof lease.boundAt === 'number' && Number.isFinite(lease.boundAt) &&
    typeof lease.leaseSec === 'number' && Number.isFinite(lease.leaseSec) &&
    typeof lease.expiresAt === 'number' && Number.isFinite(lease.expiresAt) &&
    (lease.hostname === null || typeof lease.hostname === 'string') &&
    typeof lease.leaseType === 'string' && LEASE_TYPES.includes(lease.leaseType as DhcpLeaseType) &&
    (lease.clientId === undefined || lease.clientId === null || typeof lease.clientId === 'string')
  );
}

/**
 * Reads the persisted lease table.
 *
 * Synchronous on purpose: this runs between the socket binding and the first
 * packet being served, and an `await` there would let a DISCOVER be answered
 * from an empty table — the exact race this module exists to remove.
 *
 * Every failure mode (absent file, unreadable file, malformed JSON, wrong
 * schema version, junk entries) degrades to "no leases restored" rather than
 * throwing: a DHCP server that refuses to start because of a bad cache file is
 * strictly worse than one that starts with a cold table.
 *
 * @returns Leases as written, in file order. Reconciliation against current
 *   configuration is the caller's job — see {@link reconcilePersistedLeases}.
 */
export function loadLeases(filePath: string): DhcpLeaseInfo[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    const file = parsed as Partial<LeaseStoreFile>;
    if (file.version !== LEASE_STORE_VERSION || !Array.isArray(file.leases)) return [];
    return file.leases.filter(isLeaseRecord);
  } catch {
    return [];
  }
}

/**
 * Writes the lease table atomically (temp file, then rename over the target).
 *
 * The parent directory is created on demand — on a fresh install the
 * extension's global storage folder may not exist yet.
 */
export async function saveLeases(filePath: string, leases: readonly DhcpLeaseInfo[]): Promise<void> {
  const payload: LeaseStoreFile = { version: LEASE_STORE_VERSION, savedAt: Date.now(), leases: [...leases] };
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  try {
    await fsp.rename(tempPath, filePath);
  } catch (err) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Decides which persisted leases may be restored under the configuration
 * currently in effect.
 *
 * Configuration always wins over the file, because the file describes a world
 * that may be several edits old:
 *
 * - **Expired** leases are dropped — the device no longer has a claim.
 * - A MAC that now has a **static reservation** takes the reserved address.
 *   Restoring the persisted dynamic one instead would defeat the reservation
 *   outright: `_selectAddress` consults `_state` *before* the static map
 *   (dhcp.js:275-289), so a stale entry would shadow it for as long as the
 *   client keeps renewing.
 * - A lease on an address now **reserved for a different MAC** is dropped for
 *   the same reason in reverse: keeping it re-creates the very IP conflict
 *   this module exists to prevent.
 * - A dynamic lease now **outside the pool** is dropped — the range was
 *   re-pointed at a different subnet since the file was written.
 *
 * A lease whose MAC still holds the same reservation is kept, so a reserved
 * device keeps its `boundAt`/hostname history across a restart.
 */
export function reconcilePersistedLeases(
  leases: readonly DhcpLeaseInfo[],
  context: LeaseReconcileContext,
): LeaseReconcileResult {
  const restored: DhcpLeaseInfo[] = [];
  const dropped: DroppedLease[] = [];
  const reservedAddresses = new Set(Object.values(context.staticMap));
  // Re-keyed to the library's MAC format: persisted leases carry `_state` keys
  // (`AA-BB-…`) while the configured map is keyed as the user typed it, and a
  // raw lookup would miss every reservation written with colons — silently
  // restoring the stale dynamic lease that the reservation is meant to beat.
  const staticMap = normalizeStaticMap(context.staticMap);

  for (const lease of leases) {
    if (lease.expiresAt <= context.now) {
      dropped.push({ lease, reason: 'expired' });
      continue;
    }

    const reservedForMac = staticMap[toLibraryMacKey(lease.mac)];
    if (reservedForMac !== undefined) {
      if (reservedForMac === lease.ip) {
        restored.push({ ...lease, leaseType: 'static' });
      } else {
        dropped.push({ lease, reason: 'static-conflict' });
      }
      continue;
    }

    if (reservedAddresses.has(lease.ip)) {
      dropped.push({ lease, reason: 'static-conflict' });
      continue;
    }

    if (!isIpInPool(lease.ip, context.rangeStart, context.rangeEnd)) {
      dropped.push({ lease, reason: 'out-of-pool' });
      continue;
    }

    restored.push({ ...lease, leaseType: 'dynamic' });
  }

  return { restored, dropped };
}

/**
 * Converts a restored lease into an entry the `dhcp` library accepts in
 * `Server._state`.
 *
 * The library has no public seeding API — `_state` is initialised to `{}` in
 * the `Server` constructor (dhcp.js:118) and only ever mutated by
 * `handleDiscover`/`handleRequest` (dhcp.js:360, :404). Populating it directly
 * is what makes `_selectAddress` hand the same MAC its previous address back
 * (dhcp.js:275-277) and keep that address out of the free-IP scan for everyone
 * else (dhcp.js:304-306).
 *
 * `leaseTime` is deliberately left unset, matching what the library itself
 * writes: it is only ever *read*, by the pool-exhaustion eviction scan
 * (dhcp.js:308), where a numeric value would make restored leases the first
 * ones evicted while library-created ones (`undefined`) are never chosen.
 */
export function toRestoredLeaseState(lease: DhcpLeaseInfo, serverId: string): LeaseState {
  return {
    bindTime: new Date(lease.boundAt),
    leasePeriod: lease.leaseSec,
    renewPeriod: Math.floor(lease.leaseSec / 2),
    rebindPeriod: lease.leaseSec,
    state: 'BOUND',
    server: serverId,
    address: lease.ip,
    options: lease.hostname ? { hostname: lease.hostname } : {},
    clientId: lease.clientId,
    tries: 0,
    xid: 1,
  };
}

/**
 * `state` marker for a placeholder entry that holds a static reservation's
 * address out of the dynamic pool before its device has ever spoken.
 *
 * A value the `dhcp` library never writes itself (it only ever sets `OFFERED`,
 * `BOUND` and `RENEWING`), which is what makes it safe to use as the flag that
 * tells a reservation apart from a real lease. The engine filters entries
 * carrying it out of `activeLeases()` and out of its lease diff, so a
 * reservation never inflates pool utilisation, never appears in the sidebar's
 * Active Leases, never reaches the persisted lease file, and never fires a
 * `lease:bound` for a device that has not booted yet.
 */
export const RESERVED_LEASE_STATE = 'RESERVED';

/**
 * Builds the placeholder `_state` entry that reserves `ip` for a configured
 * static MAC.
 *
 * Poking `_state` is the same "no public seeding API" pattern as
 * {@link toRestoredLeaseState}, and it buys both halves of the reservation from
 * one write: `_selectAddress` returns `_state[mac].address` for the reserved
 * MAC itself (dhcp.js:275-277), and excludes that address from the free-IP scan
 * for every *other* MAC (dhcp.js:304-306). The second half is the point — it is
 * what stops another client's DISCOVER from being offered the address.
 *
 * `bindTime` is left unset: nothing is bound yet, and a timestamp here would
 * make the engine's renewal diff read the eventual real bind as a renewal of a
 * lease that never existed. `leaseTime` is unset for the same reason as in
 * {@link toRestoredLeaseState} — a numeric value would make reservations the
 * first entries evicted when the pool fills, which is precisely backwards.
 */
export function toReservedLeaseState(ip: string, serverId: string, leaseSec: number): LeaseState {
  return {
    leasePeriod: leaseSec,
    renewPeriod: Math.floor(leaseSec / 2),
    rebindPeriod: leaseSec,
    state: RESERVED_LEASE_STATE,
    server: serverId,
    address: ip,
    options: {},
    tries: 0,
    xid: 1,
  };
}

/** Debounced, serialised writer over one lease-store file. */
export interface DhcpLeaseStore {
  /** Records that the lease table changed; the write lands after the window. */
  schedule(): void;
  /** Writes any pending change now and waits for it (and for writes in flight). */
  flush(): Promise<void>;
  /** Cancels a pending write and refuses further ones. */
  dispose(): void;
}

/** Injection points for {@link createDhcpLeaseStore}; all optional. */
export interface DhcpLeaseStoreOptions {
  /** Debounce window; defaults to {@link LEASE_PERSIST_DEBOUNCE_MS}. */
  readonly delayMs?: number;
  /** Write implementation; defaults to {@link saveLeases}. */
  readonly write?: (filePath: string, leases: readonly DhcpLeaseInfo[]) => Promise<void>;
  /** Called instead of rejecting, so a failed write never breaks lease handling. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Builds a store that persists whatever `snapshot()` returns, one write per
 * quiet window.
 *
 * The snapshot is taken at *write* time, not at `schedule()` time, so a burst
 * always lands as the final state of the table rather than as an early
 * intermediate one.
 */
export function createDhcpLeaseStore(
  filePath: string,
  snapshot: () => readonly DhcpLeaseInfo[],
  options: DhcpLeaseStoreOptions = {},
): DhcpLeaseStore {
  const delayMs = options.delayMs ?? LEASE_PERSIST_DEBOUNCE_MS;
  const write = options.write ?? saveLeases;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let disposed = false;

  const writeNow = (): Promise<void> => {
    const leases = snapshot();
    inFlight = inFlight.then(async () => {
      try {
        await write(filePath, leases);
      } catch (error) {
        options.onError?.(error);
      }
    });
    return inFlight;
  };

  return {
    schedule(): void {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void writeNow();
      }, delayMs);
    },
    flush(): Promise<void> {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        return writeNow();
      }
      return inFlight;
    },
    dispose(): void {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
