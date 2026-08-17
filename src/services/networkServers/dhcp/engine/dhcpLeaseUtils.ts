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

/**
 * Rewrites a MAC into the exact key format the `dhcp` library uses for
 * `Server._state`: uppercase hex pairs joined by dashes, `AA-BB-CC-DD-EE-FF`.
 *
 * That format is not a style preference — it is what `seqbuffer.js:177`
 * (`mac.toUpperCase().match(/../g).join('-')`) produces when it decodes
 * `chaddr` off the wire, so it is the key every `_state` lookup in the library
 * is performed against. Settings, meanwhile, are typed by hand and usually
 * colon-separated and lowercase. Seeding `_state` under the user's spelling
 * would be worse than not seeding at all: the reserved address would be held
 * out of the pool under a key the library never matches, so the reserved
 * device would be handed a *different* dynamic address while its own sat
 * blocked.
 *
 * @param mac MAC in any common spelling (`aa:bb:cc:dd:ee:ff`, `AA-BB-…`,
 *   `aabb.ccdd.eeff`, `aabbccddeeff`).
 * @returns The canonical key, or the trimmed uppercase input when it does not
 *   contain exactly 12 hex digits — a malformed entry is passed through rather
 *   than silently reshaped into a valid-looking MAC that was never configured.
 */
export function toLibraryMacKey(mac: string): string {
  const hex = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return mac.trim().toUpperCase();
  return (hex.match(/../g) ?? []).join('-');
}

/**
 * Re-keys a configured static map into the library's MAC format.
 *
 * Every consumer that has to line a configured reservation up against
 * `_state` — the reservation seeding, the persistence reconciler, the
 * dynamic/static classification below — goes through this, so a MAC typed with
 * colons in Settings matches a MAC decoded with dashes off the wire.
 */
export function normalizeStaticMap(
  staticMap: Readonly<Record<string, string>>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [mac, ip] of Object.entries(staticMap)) {
    normalized[toLibraryMacKey(mac)] = ip;
  }
  return normalized;
}

/**
 * Determines whether a MAC/IP corresponds to a configured static entry.
 *
 * Both sides are canonicalised first: `mac` arrives as a `_state` key
 * (`AA-BB-…`) while `staticMap` is keyed by whatever the user typed, and a raw
 * comparison would classify every reserved lease as `dynamic`.
 */
export function isStaticLease(mac: string, ip: string, staticMap: Readonly<Record<string, string>>): boolean {
  const key = toLibraryMacKey(mac);
  for (const [candidate, address] of Object.entries(staticMap)) {
    if (toLibraryMacKey(candidate) === key) return address === ip;
  }
  return false;
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
