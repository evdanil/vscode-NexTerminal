/**
 * Shared plumbing between the two network-server editors: the full
 * `WebviewFormPanel` form (`nexus.networkServer.edit`) and the fast quick pick
 * (`nexus.networkServer.quickAdjust`).
 *
 * Both write the same `nexus.networkServers.<kind>.*` keys, so both need the
 * same "blank means clear the key" reading rules and the same sanity checks —
 * a pool the form refuses must not be reachable through the quick pick, and
 * vice versa.
 */

import {
  computeBroadcastAddress,
  computePoolSize,
  computeRangeEnd
} from "../services/networkServers/dhcp/engine/dhcpNetworkUtils";
import { DEFAULTS } from "../services/networkServers/dhcp/engine/dhcpConstants";
import type { DhcpVendorSpecificEntry } from "../services/networkServers/core/index";
import type { NetworkServerKind } from "../models/networkServer";
import type { NetworkServerConfigProfile } from "../models/networkServerProfile";
import type { FormValues } from "../ui/formTypes";

export const NETWORK_SERVER_LABELS: Record<NetworkServerKind, string> = { tftp: "TFTP", dhcp: "DHCP" };

/** Value accepted by `WorkspaceConfiguration.update`; `undefined` clears the key. */
export type SettingValue =
  | string
  | number
  | boolean
  | string[]
  | Record<string, string>
  | DhcpVendorSpecificEntry[]
  | undefined;

/** Blank collapses to `undefined` so the key is removed and the default applies. */
export function readSettingString(value: FormValues[string]): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readSettingNumber(value: FormValues[string]): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Checkboxes arrive as `"on"` from the webview, or as a boolean under test. */
export function readSettingBoolean(value: FormValues[string]): boolean {
  return value === true || value === "on" || value === "true";
}

const DOTTED_QUAD = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

export function isValidIpv4(value: string): boolean {
  return DOTTED_QUAD.test(value);
}

export function compareIpv4(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 4; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** A mask is usable only if its set bits are contiguous from the top — `255.0.255.0` is not a subnet. */
export function isContiguousMask(mask: string): boolean {
  const value = mask.split(".").reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
  const inverted = ~value >>> 0;
  return ((inverted + 1) & inverted) === 0;
}

/**
 * The pool size currently configured, for seeding a "how many addresses?"
 * input from the `rangeStart`/`rangeEnd` pair that is actually stored.
 *
 * Blank settings fall back to the packaged defaults so the seed matches what a
 * start would really hand out, rather than showing an empty box over a pool
 * that is anything but empty.
 */
export function currentPoolCount(rangeStart: string | undefined, rangeEnd: string | undefined): number {
  return computePoolSize(rangeStart ?? DEFAULTS.rangeStart, rangeEnd ?? DEFAULTS.rangeEnd);
}

/**
 * The `rangeEnd` a pool of `count` addresses implies.
 *
 * `undefined` for a blank count clears the key, which is how the editors spell
 * "go back to the packaged pool". A start left blank resolves to the packaged
 * default before the arithmetic: the end has to be a concrete address, and
 * deriving it from anything other than the start that will really be used
 * would silently size the pool wrong.
 */
export function dhcpRangeEndForCount(rangeStart: string | undefined, count: number | undefined): string | undefined {
  if (count === undefined) return undefined;
  const end = computeRangeEnd(rangeStart ?? DEFAULTS.rangeStart, count);
  return end.length > 0 ? end : undefined;
}

/**
 * Why a `rangeStart` + count pool is unusable, or `undefined` if it is fine.
 *
 * Contiguity with the subnet is the check worth having: a pool that runs past
 * the subnet broadcast hands out addresses the client cannot use and the fault
 * only shows up as a device that "got an IP but has no network". Anything that
 * fails to parse is left alone here — the per-field dotted-quad checks report
 * that, and two messages for one typo is worse than one.
 */
export function dhcpPoolProblem(
  rangeStart: string | undefined,
  count: number | undefined,
  subnet: string | undefined
): string | undefined {
  if (count === undefined) return undefined;
  if (!Number.isInteger(count) || count < 1) {
    return `Pool Count must be a whole number of at least 1 (got "${String(count)}").`;
  }
  const start = rangeStart ?? DEFAULTS.rangeStart;
  if (!isValidIpv4(start)) return undefined;
  const end = computeRangeEnd(start, count);
  if (!end) {
    return `A pool of ${String(count)} addresses starting at ${start} runs past the end of the IPv4 address space.`;
  }
  const mask = subnet ?? DEFAULTS.subnet;
  if (!isValidIpv4(mask) || !isContiguousMask(mask)) return undefined;
  const broadcast = computeBroadcastAddress(start, mask);
  if (compareIpv4(end, broadcast) < 0) return undefined;
  const usable = computePoolSize(start, broadcast) - 1;
  const advice = usable >= 1 ? ` The most ${mask} allows from that start is ${String(usable)}.` : "";
  return `A pool of ${String(count)} addresses starting at ${start} ends at ${end}, at or past the subnet broadcast ${broadcast}.${advice}`;
}

/**
 * A saved profile expressed as the setting writes that restore it — the third
 * caller of the same `nexus.networkServers.<kind>.*` keys the form and the
 * quick pick write, so it belongs beside them rather than in the command file.
 *
 * Every configurable key is listed, including the ones the profile left unset:
 * an omitted entry would leave whatever the live settings happen to hold, so a
 * profile with no gateway would silently inherit the previous lab's. Writing
 * `undefined` clears the key and hands it back to the packaged default, which
 * is what "this profile does not set a gateway" has to mean.
 *
 * Two keys are deliberately absent. `leaseStorePath` is a machine-local path
 * derived from global storage, never a setting. And the adapter's
 * `bindAddress` is written to `interface`, which is what the setting has always
 * been called.
 */
export function networkServerProfileSettingUpdates(
  profile: NetworkServerConfigProfile
): Array<[string, SettingValue]> {
  if (profile.kind === "tftp") {
    const config = profile.config;
    return [
      ["root", config.root],
      ["port", config.port],
      ["allowWrite", config.allowWrite === true],
      ["interface", config.interface]
    ];
  }
  const config = profile.config;
  return [
    ["rangeStart", config.rangeStart],
    ["rangeEnd", config.rangeEnd],
    ["subnet", config.subnet],
    ["gateway", config.gateway],
    ["dns", config.dns ? [...config.dns] : undefined],
    ["leaseTimeSec", config.leaseTimeSec],
    ["serverId", config.serverId],
    ["broadcast", config.broadcast],
    ["interface", config.bindAddress],
    ["static", config.static ? { ...config.static } : undefined],
    ["bootFileName", config.bootFileName],
    ["nextServer", config.nextServer],
    ["tftpServerAddresses", config.tftpServerAddresses ? [...config.tftpServerAddresses] : undefined],
    ["vendorClassId", config.vendorClassId],
    ["vendorSpecificOptions", config.vendorSpecificOptions ? [...config.vendorSpecificOptions] : undefined],
    ["autoLinkTftp", profile.autoLinkTftp === true]
  ];
}

/**
 * Sanity checks run before any setting is written, returning the first problem
 * as a message.
 *
 * `WebviewFormPanel` has no field-level validation hook a caller can drive (the
 * webview understands a `validationError` message, but nothing exposes a way to
 * send one), so this rides the mechanism that does exist: throwing out of
 * `onSubmit` reports the reason and leaves the panel open with the user's input
 * intact. Only non-blank values are checked — blank means "clear the key and
 * use the packaged default", which is always valid.
 */
export function validateDhcpValues(values: FormValues): string | undefined {
  const rangeStart = readSettingString(values.rangeStart);
  const subnet = readSettingString(values.subnet);
  for (const [label, value] of [
    ["Pool Start", rangeStart],
    ["Subnet Mask", subnet],
    ["Gateway", readSettingString(values.gateway)],
    ["Server Identifier", readSettingString(values.serverId)],
    ["Broadcast Address", readSettingString(values.broadcast)]
  ] as const) {
    if (value && !isValidIpv4(value)) {
      return `${label} must be a dotted-quad IPv4 address (got "${value}").`;
    }
  }
  if (subnet && !isContiguousMask(subnet)) {
    return `Subnet Mask "${subnet}" is not a valid netmask — its set bits must be contiguous (e.g. 255.255.255.0).`;
  }
  return dhcpPoolProblem(rangeStart, readSettingNumber(values.poolCount), subnet);
}
