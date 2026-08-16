/** @author kanekitakitos */

/**
 * Pure IPv4 utilities used by the DHCP engine: parsing, pool size and
 * broadcast address calculation. No dependencies on VS Code or the `dhcp`
 * library — testable in isolation.
 */

import { DEFAULTS } from './dhcpConstants';

/** Converts a dotted-quad IPv4 (e.g. 192.168.2.10) to a 32-bit integer. Returns 0 on invalid parse. */
export function ipToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number(p) >>> 0);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return 0;
  return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
}

/** Converts a 32-bit integer back to dotted-quad IPv4. */
export function intToIp(n: number): string {
  const u = n >>> 0;
  return [(u >>> 24) & 255, (u >>> 16) & 255, (u >>> 8) & 255, u & 255].join('.');
}

/** Pool size (count of IPs between start and end inclusive). Returns 0 on parse error. */
export function computePoolSize(rangeStart: string, rangeEnd: string): number {
  const a = ipToInt(rangeStart);
  const b = ipToInt(rangeEnd);
  if (a === 0 || b === 0 || b < a) return 0;
  return b - a + 1;
}

/**
 * Last address of a pool of `count` addresses starting at `rangeStart` — the
 * inverse of {@link computePoolSize}, used by the editors that ask for a pool
 * size instead of an end address. The setting itself is still `rangeEnd`.
 *
 * @returns Dotted-quad end address, or `''` when the start does not parse, the
 *   count is not a positive integer, or the pool runs off the IPv4 space.
 */
export function computeRangeEnd(rangeStart: string, count: number): string {
  const start = ipToInt(rangeStart) >>> 0;
  if (start === 0 || !Number.isInteger(count) || count < 1) return '';
  const end = start + count - 1;
  if (end > 0xffffffff) return '';
  return intToIp(end);
}

/**
 * Calculates the broadcast address from the gateway and netmask
 * (`broadcast = (gateway & mask) | ~mask`).
 *
 * **Fixed bug:** the previous version always used a fixed broadcast
 * (`192.168.2.255`, the factory default) when the user did not explicitly
 * configure it — even if they had changed `gateway` or `subnet` to another
 * subnet, making it inconsistent with the real network. Now the broadcast
 * is always derived from `gateway` + `subnet` when not explicitly
 * provided.
 *
 * @returns The calculated broadcast, or `DEFAULTS.broadcast` if `gateway`/`subnet` are invalid.
 */
export function computeBroadcastAddress(gateway: string, netmask: string): string {
  const g = ipToInt(gateway);
  const m = ipToInt(netmask);
  if (g === 0 || m === 0) return DEFAULTS.broadcast;
  const broadcast = (g & m) | (~m >>> 0);
  return intToIp(broadcast);
}
