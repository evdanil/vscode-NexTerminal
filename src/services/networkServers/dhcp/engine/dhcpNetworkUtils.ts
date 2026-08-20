/** @author kanekitakitos */

/**
 * Pure IPv4 utilities used by the DHCP engine: parsing, pool size and
 * broadcast address calculation. No dependencies on VS Code or the `dhcp`
 * library — testable in isolation.
 */

import { DEFAULTS } from './dhcpConstants';

/**
 * Strict dotted-quad matcher.
 *
 * {@link ipToInt} is deliberately lenient — it maps anything it cannot parse to
 * `0`, which is also a perfectly legal address — so it cannot answer "is this
 * string a valid IPv4 address?". Validation needs its own predicate, and both
 * the editors (which refuse bad input outright) and the settings read path
 * (which falls back to the packaged default) share this one.
 */
const DOTTED_QUAD = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

/** Whether `value` is a dotted-quad IPv4 address. */
export function isValidIpv4(value: string): boolean {
  return DOTTED_QUAD.test(value);
}

/**
 * Orders two dotted-quad addresses, octet by octet as numbers.
 *
 * A lexicographic string compare would place `10.0.0.100` *below* `10.0.0.99`,
 * which is exactly the pair an inverted-pool check has to catch.
 *
 * @returns Negative when `left` sorts first, positive when `right` does, `0`
 *   when they are equal.
 */
export function compareIpv4(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 4; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** A mask is usable only if its set bits are contiguous from the top — `255.0.255.0` is not a subnet. */
export function isContiguousMask(mask: string): boolean {
  const value = mask.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
  const inverted = ~value >>> 0;
  return ((inverted + 1) & inverted) === 0;
}

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
 * Whether `ip` falls inside the inclusive dynamic pool `[rangeStart, rangeEnd]`.
 *
 * This is the question "does this static reservation collide with the pool?" —
 * an address inside the range can be handed to some other client by the
 * library's free-address scan, so it has to be reserved up front, while one
 * outside the range never competes with dynamic allocation at all.
 *
 * Comparisons are unsigned (`>>> 0`) so addresses above `127.x` — where the
 * signed 32-bit conversion goes negative — still order correctly.
 *
 * @returns `false` when any of the three addresses fails to parse, which keeps
 *   a malformed setting from silently reserving (or freeing) the wrong thing.
 */
export function isIpInPool(ip: string, rangeStart: string, rangeEnd: string): boolean {
  const address = ipToInt(ip) >>> 0;
  const first = ipToInt(rangeStart) >>> 0;
  const last = ipToInt(rangeEnd) >>> 0;
  if (address === 0 || first === 0 || last === 0) return false;
  return address >= first && address <= last;
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
