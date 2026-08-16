/** @author kanekitakitos */

/**
 * Construction and enrichment of `DhcpLeaseInfo` from raw entries of the
 * `dhcp` library's `_state`. Extracted from the engine because the same
 * logic (computing `expiresAt`, `remainingSec`, `hostname`, `leaseType`)
 * was previously duplicated in `activeLeases()` and in `_diffLeases()` —
 * now it is a single pure function, testable in isolation.
 */

import type { LeaseState } from 'dhcp';

/** Known DHCP transaction types (used in `DhcpLeaseInfo.leaseType`). */
export type DhcpLeaseType = 'dynamic' | 'static' | 'renewed' | 'inform';

/** Immutable snapshot of an active lease — enriched version for TFTP parity. */
export interface DhcpLeaseInfo {
  /** Client MAC address (format aa:bb:cc:dd:ee:ff uppercase/lowercase per library). */
  readonly mac: string;
  /** IPv4 address assigned to the client. */
  readonly ip: string;
  /** Epoch timestamp (ms) when the lease was first granted. */
  readonly boundAt: number;
  /** Total lease duration in seconds. */
  readonly leaseSec: number;
  /** Epoch timestamp (ms) when the lease expires if not renewed. */
  readonly expiresAt: number;
  /** Seconds remaining until expiration (calculation updated at snapshot time). */
  readonly remainingSec: number;
  /** If the client provided a hostname (option 12). May be `null` if not sent. */
  readonly hostname: string | null;
  /** Lease type: dynamic by default, static if from fixed MAC mapping, renewed, inform (DHCPINFORM). */
  readonly leaseType: DhcpLeaseType;
}

/** Determines whether a MAC/IP corresponds to a configured static entry. */
export function isStaticLease(mac: string, ip: string, staticMap: Readonly<Record<string, string>>): boolean {
  return Object.prototype.hasOwnProperty.call(staticMap, mac) && staticMap[mac] === ip;
}

/**
 * Builds an enriched `DhcpLeaseInfo` from a raw entry of the `dhcp`
 * library's `_state`.
 *
 * @param mac - Client MAC (key of the entry in `_state`).
 * @param entry - Raw library entry (`bindTime`, `address`, `leasePeriod`, `options`).
 * @param staticMap - MAC → IP map configured as static (to classify `leaseType`).
 * @param now - Epoch timestamp (ms) used to calculate `remainingSec` (injected for deterministic tests).
 * @param defaultLeaseSec - Lease duration to use when `entry.leasePeriod` is not defined.
 * @param typeOverride - Forces `leaseType` (e.g. `'renewed'`) instead of inferring dynamic/static.
 * @returns Complete `DhcpLeaseInfo`, or `null` if the entry has no `address`.
 */
export function buildLeaseInfo(
  mac: string,
  entry: LeaseState,
  staticMap: Readonly<Record<string, string>>,
  now: number,
  defaultLeaseSec: number,
  typeOverride?: DhcpLeaseType,
): DhcpLeaseInfo | null {
  if (!entry?.address) return null;

  const boundAt = entry.bindTime instanceof Date ? entry.bindTime.getTime() : now;
  const leaseSec = entry.leasePeriod ?? defaultLeaseSec;
  const expiresAt = boundAt + leaseSec * 1000;
  const remainingSec = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const hostname: string | null = entry.options?.hostname ? String(entry.options.hostname) : null;
  const leaseType: DhcpLeaseType =
    typeOverride ?? (isStaticLease(mac, entry.address, staticMap) ? 'static' : 'dynamic');

  return { mac, ip: entry.address, boundAt, leaseSec, expiresAt, remainingSec, hostname, leaseType };
}
