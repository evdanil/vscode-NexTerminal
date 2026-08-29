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
  compareIpv4,
  computeBroadcastAddress,
  computePoolSize,
  computeRangeEnd,
  intToIp,
  ipToInt,
  isContiguousMask,
  isSameSubnet,
  isValidIpv4,
  maskToPrefix,
  networkAddress,
  parseCidr,
  prefixToMask
} from "../services/networkServers/dhcp/engine/dhcpNetworkUtils";
import { DEFAULTS } from "../services/networkServers/dhcp/engine/dhcpConstants";
import {
  MAX_DHCP_POOL_SIZE,
  SUGGESTED_CIDR_POOL_CAP,
  validateDhcpFormInput
} from "../services/networkServers/networkServerConfigValidation";
import type { DhcpVendorSpecificEntry } from "../services/networkServers/core/index";
import type { NetworkInterfaceOption } from "./networkInterfaceOptions";
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

/**
 * The address predicates live beside the rest of the pure IPv4 arithmetic in
 * `dhcpNetworkUtils`, and are re-exported here because this module has always
 * been where the editors import them from.
 *
 * They moved because the settings *read* path needs them too
 * (`readDhcpConfig`), and `src/services` must not reach into `src/commands` to
 * get at a regex. Nothing about the checks themselves changed.
 */
export { compareIpv4, isContiguousMask, isValidIpv4 };

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
  if (count > MAX_DHCP_POOL_SIZE) {
    return `Pool Count must not exceed ${MAX_DHCP_POOL_SIZE.toLocaleString("en-US")} addresses.`;
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
 * Why an explicit `rangeStart`/`rangeEnd` pair is unusable, or `undefined` if
 * it is fine.
 *
 * The form asks for a pool *size* and derives the end (see
 * {@link dhcpRangeEndForCount}), but `rangeEnd` is still the stored setting, so
 * it arrives directly from a hand-edited `settings.json` and from a restored
 * profile. An inverted pair is silently empty at runtime — the server binds,
 * answers nothing, and the fault reads as "DHCP is broken" — so it is worth
 * refusing at the point of entry.
 *
 * Ordering goes through {@link compareIpv4}, which compares the four octets as
 * numbers. A lexicographic string compare would place `10.0.0.100` *below*
 * `10.0.0.99` and wave the inversion through.
 *
 * Anything that fails to parse is left alone: the per-field dotted-quad checks
 * report that, and two messages for one typo is worse than one. A blank end is
 * not an inversion either — it means "clear the key and use the packaged
 * default".
 */
export function dhcpRangeOrderProblem(
  rangeStart: string | undefined,
  rangeEnd: string | undefined
): string | undefined {
  if (!rangeStart || !rangeEnd) return undefined;
  if (!isValidIpv4(rangeStart) || !isValidIpv4(rangeEnd)) return undefined;
  if (compareIpv4(rangeStart, rangeEnd) <= 0) return undefined;
  return `Pool Start (${rangeStart}) must not be higher than Pool End (${rangeEnd}).`;
}

/**
 * The addresses that follow from a pool start, for the editors that offer to
 * fill them in rather than making the user work the subnet out by hand.
 */
export interface DhcpDerivedAddresses {
  /** Option 3 — the last usable address of the subnet, one below the broadcast. */
  readonly gateway: string;
  /** Option 28. */
  readonly broadcast: string;
  /** Option 6. */
  readonly dns: readonly string[];
}

/**
 * What a pool starting at `rangeStart` implies for gateway, broadcast and DNS.
 *
 * The netmask is whatever is configured, falling back to the packaged
 * `255.255.255.0` — the quick editor never asks for a CIDR, so a subnet the
 * user has not set is the /24 the rest of the defaults assume. The gateway is
 * the top usable address rather than the bottom one because that is where the
 * appliances these labs plug into put it, and it keeps the gateway clear of a
 * pool that counts up from its start.
 *
 * DNS mirrors the gateway rather than the packaged `8.8.8.8`/`8.8.4.4` pair:
 * leaving the key unset already yields those two, so writing them out would be
 * a no-op with a settings-file entry attached, whereas router-as-resolver is
 * the setup an isolated lab subnet actually needs.
 *
 * @returns `undefined` when the start or the mask does not parse, or when the
 *   mask is too narrow to leave a gateway inside the subnet (/31, /32) — there
 *   is nothing to suggest in those cases and a wrong suggestion is worse than
 *   none.
 */
export function dhcpDerivedAddresses(
  rangeStart: string,
  subnet: string | undefined
): DhcpDerivedAddresses | undefined {
  const mask = subnet ?? DEFAULTS.subnet;
  if (!isValidIpv4(rangeStart) || !isValidIpv4(mask) || !isContiguousMask(mask)) return undefined;
  const broadcast = computeBroadcastAddress(rangeStart, mask);
  if (!isValidIpv4(broadcast)) return undefined;
  const gateway = intToIp((ipToInt(broadcast) - 1) >>> 0);
  const maskInt = ipToInt(mask);
  // A gateway that fell out of the subnet (or onto its network address) would
  // be handed to clients as an unreachable next hop.
  if ((ipToInt(gateway) & maskInt) !== (ipToInt(rangeStart) & maskInt)) return undefined;
  if (gateway === intToIp(ipToInt(rangeStart) & maskInt)) return undefined;
  return { gateway, broadcast, dns: [gateway] };
}

/** The smallest and largest prefix a DHCP pool can be built on. */
const MIN_POOL_PREFIX = 1;
const MAX_POOL_PREFIX = 30;

/**
 * The CIDR a stored `rangeStart`/`subnet` pair already describes.
 *
 * CIDR is not a setting — nothing new is persisted for it — so the editor's row
 * has to read one back out of the settings that do exist. That is what makes the
 * feature need no migration: an existing `192.168.2.10` + `255.255.255.0` shows
 * `192.168.2.0/24` the first time the row is rendered.
 *
 * @returns `undefined` when the mask is not a usable netmask or the start does
 *   not parse — there is no network to name in either case.
 */
export function dhcpCurrentCidr(rangeStart: string | undefined, subnet: string | undefined): string | undefined {
  const mask = subnet ?? DEFAULTS.subnet;
  const start = rangeStart ?? DEFAULTS.rangeStart;
  const prefix = maskToPrefix(mask);
  if (prefix === undefined || !isValidIpv4(start)) return undefined;
  return `${networkAddress(start, mask)}/${String(prefix)}`;
}

/** Every setting a network entered as CIDR implies. */
export interface DhcpCidrDerivation {
  readonly network: string;
  readonly prefix: number;
  /** Option 1. */
  readonly subnet: string;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  /** Addresses in `[rangeStart, rangeEnd]`. */
  readonly poolCount: number;
  /** Option 3 — the top usable address, exactly as {@link dhcpDerivedAddresses} picks it. */
  readonly gateway: string;
  /** Option 28. */
  readonly broadcast: string;
  /** Option 6. */
  readonly dns: readonly string[];
}

/** The pool window {@link excludeOwnAddresses} settled on. */
interface DhcpPoolWindow {
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly poolCount: number;
}

/**
 * Moves the suggested pool clear of the addresses this machine already holds.
 *
 * The settings model a pool as one contiguous `rangeStart`/`rangeEnd` pair —
 * there is no way to express a hole — so an occupied address is dealt with by
 * moving an END of the range, never by punching one out of the middle:
 *
 *  1. An address sitting exactly ON the start is stepped over: the start
 *     advances by one and the pool is re-measured from the ORIGINAL size logic
 *     (still capped, still stopping below the gateway). Repeated, because the
 *     next address up may be occupied too — a machine with two addresses on the
 *     same wire is ordinary.
 *  2. The lowest address left inside the window is then strictly above the
 *     start, so the pool simply stops one address below it. A single shrink,
 *     not a hunt for the largest gap: the range below the first conflict is the
 *     one that keeps `rangeStart` where the network says it should be, and
 *     "build the range around" the machine's own address is precisely the
 *     remedy this is for.
 *  3. If the start runs past the last poolable address on the way, there is no
 *     pool to suggest at all — the same answer `/31`, `/32` and `/0` already
 *     get, for the same reason: nothing this network could hand out.
 *
 * NOT solved by a reservation. The engine's `config.static` list
 * (`DhcpEngine.ts`) keys reservations by the MAC of the DEVICE they are for,
 * and the serving interface is not a client: no MAC ever asks for its address,
 * so an entry for it would be a fabricated key holding a slot no request will
 * ever match. That is a misuse of the reservation schema, not a fix — the
 * address has to be outside the pool, not spoken for inside it.
 */
function excludeOwnAddresses(input: {
  readonly firstHost: string;
  readonly poolSize: number;
  readonly poolTop: number;
  readonly network: string;
  readonly subnet: string;
  readonly ownAddresses: readonly string[] | undefined;
}): DhcpPoolWindow | undefined {
  const { firstHost, poolSize, poolTop, network, subnet } = input;
  const occupied = Array.from(
    new Set(
      (input.ownAddresses ?? [])
        .filter((address) => isValidIpv4(address) && isSameSubnet(address, network, subnet))
        .map((address) => ipToInt(address) >>> 0)
    )
  ).sort((left, right) => left - right);

  let start = ipToInt(firstHost) >>> 0;
  for (;;) {
    if (start > poolTop) return undefined;
    const end = Math.min(start + poolSize - 1, poolTop);
    const lowest = occupied.find((address) => address >= start && address <= end);
    if (lowest === undefined) {
      return { rangeStart: intToIp(start), rangeEnd: intToIp(end), poolCount: end - start + 1 };
    }
    if (lowest === start) {
      start = (start + 1) >>> 0;
      continue;
    }
    return {
      rangeStart: intToIp(start),
      rangeEnd: intToIp((lowest - 1) >>> 0),
      poolCount: lowest - start
    };
  }
}

/**
 * What a network in CIDR form implies for every DHCP setting it touches.
 *
 * The gateway, broadcast and DNS come straight from {@link dhcpDerivedAddresses}
 * rather than being recomputed here, so the two entry points cannot drift: a
 * CIDR typed in and a pool start typed in derive the same gateway for the same
 * network, and a change to the top-usable convention lands on both at once.
 *
 * The pool starts one above the network address (the network address itself is
 * not assignable) and stops {@link SUGGESTED_CIDR_POOL_CAP} addresses later at
 * the most, one short of the usable host count so the gateway keeps its address
 * out of the pool.
 *
 * `ownAddresses` are this machine's own IPv4 addresses — plain strings, not
 * `NetworkInterfaceOption`s, so this stays pure arithmetic with no dependency
 * on the NIC enumerator. Any of them that land on the derived network are kept
 * OUT of the suggested pool: a server that can lease the address it is itself
 * answering from creates an IP conflict with its own clients, and
 * `192.168.2.10/24` deriving `192.168.2.1`–`192.168.2.253` is exactly that.
 * See {@link excludeOwnAddresses} for how the single contiguous range is moved
 * around them, and why a reservation is not the answer.
 *
 * Omitting the argument means "exclude nothing", which is byte-for-byte the
 * behaviour this function has always had — the feasibility check in
 * {@link dhcpCidrProblem} wants exactly that, since it is asking whether the
 * NETWORK describes a pool, not whether this particular machine has room in it.
 *
 * @returns `undefined` for anything that is not a `/1`–`/30` network. `/31` and
 *   `/32` parse as CIDR but describe no pool, and `/0` is not a subnet. Also
 *   `undefined` when `ownAddresses` occupy every candidate start, i.e. the
 *   network is real but leaves this machine no address it could hand out — the
 *   same "no usable pool" contract, reached from the other direction.
 */
export function dhcpCidrDerivation(
  text: string,
  ownAddresses?: readonly string[]
): DhcpCidrDerivation | undefined {
  const parsed = parseCidr(text);
  if (!parsed) return undefined;
  const { network, prefix } = parsed;
  if (prefix < MIN_POOL_PREFIX || prefix > MAX_POOL_PREFIX) return undefined;
  const subnet = prefixToMask(prefix);
  if (subnet === undefined) return undefined;
  const firstHost = intToIp((ipToInt(network) + 1) >>> 0);
  const derived = dhcpDerivedAddresses(firstHost, subnet);
  if (!derived) return undefined;
  // −2 drops the network and broadcast addresses; the further −1 is the gateway,
  // which the pool must not hand to a second host.
  const usableHosts = 2 ** (32 - prefix) - 2;
  const poolSize = Math.min(usableHosts - 1, SUGGESTED_CIDR_POOL_CAP);
  if (computeRangeEnd(firstHost, poolSize) === "") return undefined;
  const window = excludeOwnAddresses({
    firstHost,
    poolSize,
    // The gateway is the top usable address, so the last address a pool may
    // reach is the one below it. Expressed as a ceiling rather than as a count
    // because advancing the start past an occupied address must not push the
    // far end onto the gateway.
    poolTop: (ipToInt(derived.gateway) - 1) >>> 0,
    network,
    subnet,
    ownAddresses
  });
  if (!window) return undefined;
  const { rangeStart, rangeEnd, poolCount } = window;
  return {
    network,
    prefix,
    subnet,
    rangeStart,
    rangeEnd,
    poolCount,
    gateway: derived.gateway,
    broadcast: derived.broadcast,
    dns: derived.dns
  };
}

/**
 * Why a typed CIDR cannot become a pool, phrased for an input box.
 *
 * The three prefixes that are legal CIDR but useless here get their own message
 * apiece rather than one shared range complaint: `/32` and `/31` are what
 * someone reaches for when they mean "just this host" or "just this link", and
 * "must be between 1 and 30" does not explain why the thing they typed —
 * which is a perfectly real network — was refused.
 *
 * @returns `undefined` for a usable network, and for blank input, which the
 *   editors treat as "leave it alone" rather than as an error.
 */
export function dhcpCidrProblem(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const parts = trimmed.split("/");
  if (parts.length !== 2) {
    return `Enter a network in CIDR form, e.g. 192.168.2.0/24 (got "${trimmed}").`;
  }
  const address = parts[0].trim();
  const prefixText = parts[1].trim();
  if (!isValidIpv4(address)) {
    return `"${address}" is not a dotted-quad IPv4 address — enter a network like 192.168.2.0/24.`;
  }
  if (!/^[0-9]{1,3}$/.test(prefixText)) {
    return `"${prefixText}" is not a prefix length — enter a whole number, e.g. ${address}/24.`;
  }
  const prefix = Number(prefixText);
  if (prefix === 0) {
    return "/0 is not a subnet — it covers every address there is, so there is no network to serve.";
  }
  if (prefix === 32) {
    return `/32 is a single address — it has no host range, so there is nothing for a pool to hand out. Try ${address}/24.`;
  }
  if (prefix === 31) {
    return `/31 is a point-to-point range (RFC 3021) — its two addresses are both endpoints, so there is no usable DHCP pool. Try ${address}/24.`;
  }
  if (prefix > MAX_POOL_PREFIX) {
    return `A prefix length must be between ${String(MIN_POOL_PREFIX)} and ${String(MAX_POOL_PREFIX)} to leave room for a pool (got /${String(prefix)}).`;
  }
  if (!dhcpCidrDerivation(trimmed)) {
    return `${trimmed} does not describe a usable DHCP subnet.`;
  }
  return undefined;
}

/** Whether a bind address means "every interface" rather than one NIC. */
function isAllInterfaces(bindAddress: string | undefined): boolean {
  const trimmed = bindAddress?.trim() ?? "";
  return trimmed.length === 0 || trimmed === "0.0.0.0";
}

/** The pool's own network, or `undefined` when the settings do not describe one. */
function poolNetwork(
  rangeStart: string | undefined,
  subnet: string | undefined
): { start: string; mask: string } | undefined {
  const mask = subnet ?? DEFAULTS.subnet;
  const start = rangeStart ?? DEFAULTS.rangeStart;
  if (!isValidIpv4(mask) || !isContiguousMask(mask) || !isValidIpv4(start)) return undefined;
  return { start, mask };
}

/**
 * How the interface the service binds relates to the subnet it serves.
 *
 * A DHCP server answers broadcasts that arrive on the wire it is bound to, so a
 * NIC on `192.168.1.x` handing out `10.0.0.x` leases is a lab that looks
 * configured and serves nothing. Nothing else in the settings catches it: every
 * individual field is valid, and only the pair is wrong.
 *
 * - `all-interfaces` — the bind address is unset or `0.0.0.0`, and at least one
 *   of this machine's NICs is on the pool's subnet. Every NIC is listening, so
 *   the one that serves this pool is among them.
 * - `all-interfaces-off-subnet` — the same bind, with NO NIC on the pool's
 *   subnet. Listening on every interface does not put this machine on a wire it
 *   has no address on: the DISCOVERs never arrive, exactly as they do not for a
 *   bind to one wrong NIC. Kept apart from `mismatch` because there is no bound
 *   address to name and no single NIC to blame — the remedy is the pool or a
 *   NIC that does not exist yet, not the Interface setting.
 * - `unknown-address` — an address this machine does not currently hold. That
 *   is already reported as its own problem where the address is shown; saying
 *   "and it is on the wrong subnet" on top of it would be guessing.
 * - `unusable-mask` — the pool's own subnet cannot be worked out (a
 *   non-contiguous or malformed `subnet`, or a `rangeStart` that does not
 *   parse). Whatever reports the bad field reports it; this one stays quiet —
 *   including under an all-interfaces bind, where a "looks fine" answer would
 *   be an assertion about a subnet nothing here could work out.
 *
 * @param interfaces The already-filtered list from `networkInterfaceBindOptions()`.
 *   Passing a raw `os.networkInterfaces()` read would let a WSL or Docker NIC
 *   answer for a subnet no client is on — and under an all-interfaces bind that
 *   list is now the whole basis of the answer, not just a membership check for
 *   one address.
 * @param allowRelayAgents When set, serving a subnet this machine is not on is
 *   the intended configuration — a relay agent forwards the request — so the
 *   comparison is not a fault to report at all, in either bind mode.
 */
export type DhcpInterfaceSubnetStatus =
  | "all-interfaces"
  | "all-interfaces-off-subnet"
  | "match"
  | "mismatch"
  | "unknown-address"
  | "unusable-mask";

export function dhcpInterfaceSubnetStatus(
  bindAddress: string | undefined,
  subnet: string | undefined,
  rangeStart: string | undefined,
  interfaces: readonly NetworkInterfaceOption[],
  allowRelayAgents = false
): DhcpInterfaceSubnetStatus {
  const address = bindAddress?.trim() ?? "";
  const bindsEveryInterface = isAllInterfaces(address);
  // Relay agents first, and for both bind modes: with one in front of the
  // service, being off the pool's subnet is the configuration the user asked
  // for, so there is no comparison worth making.
  if (allowRelayAgents) return bindsEveryInterface ? "all-interfaces" : "match";
  const pool = poolNetwork(rangeStart, subnet);
  if (!pool) return "unusable-mask";
  if (bindsEveryInterface) {
    // "Every NIC" is not "every subnet". The question is the same one a bound
    // address is asked — is this machine on the wire the pool describes — put
    // to the whole filtered list instead of to one address.
    return interfacesOnPoolSubnet(interfaces, pool).length > 0 ? "all-interfaces" : "all-interfaces-off-subnet";
  }
  if (!isValidIpv4(address) || !interfaces.some((option) => option.value === address)) return "unknown-address";
  return isSameSubnet(address, pool.start, pool.mask) ? "match" : "mismatch";
}

/**
 * The NICs from the already-filtered list that sit on the pool's own subnet.
 *
 * Shared by the all-interfaces branch above and {@link suggestBindAddressForPool}
 * so the two cannot drift: "is anything here on that subnet" and "which one
 * would I suggest" have to be the same question, or the status warns about a
 * pool the suggestion is happy to serve. The all-interfaces row is excluded —
 * its empty address masks to 0.0.0.0 and would match a 0.0.0.0 pool network.
 */
function interfacesOnPoolSubnet(
  interfaces: readonly NetworkInterfaceOption[],
  pool: { start: string; mask: string }
): NetworkInterfaceOption[] {
  return interfaces.filter(
    (option) => !isAllInterfaces(option.value) && isSameSubnet(option.value, pool.start, pool.mask)
  );
}

/** A NIC that could serve the configured pool. */
export interface BindAddressSuggestion {
  readonly address: string;
  /** More than one NIC is on the pool's subnet, so this one is a guess. */
  readonly ambiguous: boolean;
}

/**
 * The NIC that is already on the pool's subnet, if exactly one is.
 *
 * There is deliberately no fallback to "the first available interface" when
 * nothing matches. Binding a DHCP server to an arbitrary NIC is how a bench
 * service ends up answering DISCOVERs on an office network, and a suggestion
 * that is wrong is worse than no suggestion — the user still has the picker.
 *
 * @param interfaces The already-filtered list from `networkInterfaceBindOptions()`,
 *   for the same reason {@link dhcpInterfaceSubnetStatus} needs it: virtual NICs
 *   (WSL, Hyper-V, Docker) sit on RFC1918 ranges and would match confidently.
 * @returns The single matching address with `ambiguous: false`; the first of
 *   several with `ambiguous: true`, which callers must not auto-select; or
 *   `undefined` when nothing matches, when the pool's subnet is unusable, or
 *   when relay agents are allowed and being off-subnet is intended.
 */
export function suggestBindAddressForPool(
  rangeStart: string | undefined,
  subnet: string | undefined,
  interfaces: readonly NetworkInterfaceOption[],
  allowRelayAgents = false
): BindAddressSuggestion | undefined {
  if (allowRelayAgents) return undefined;
  const pool = poolNetwork(rangeStart, subnet);
  if (!pool) return undefined;
  const matches = interfacesOnPoolSubnet(interfaces, pool);
  if (matches.length === 0) return undefined;
  return { address: matches[0].value, ambiguous: matches.length > 1 };
}

/**
 * Whether a setting may be recomputed from a new pool start or network.
 *
 * Blank is the codebase's existing "no opinion" signal — an unset key means the
 * packaged default applies — so a blank value is always fair game. Beyond that,
 * only a value this auto-fill would itself have written for the *previous*
 * network is replaced: that is a stale suggestion, not a decision, and leaving
 * it behind is how a move from one lab subnet to another ends up advertising
 * the old subnet's gateway. Anything else the user typed is left exactly as
 * typed.
 *
 * Lives here rather than in either editor because both editors have to answer
 * the question identically: a gateway that survives a CIDR change in the quick
 * pick and is clobbered by the same change in the form is the sort of
 * divergence that only shows up on someone's bench.
 */
export function isAutoFillable(current: string | undefined, previousDerived: string | undefined): boolean {
  return current === undefined || (previousDerived !== undefined && current === previousDerived);
}

export function isDnsAutoFillable(
  current: readonly string[],
  previousDerived: readonly string[] | undefined
): boolean {
  if (current.length === 0) return true;
  if (previousDerived === undefined) return false;
  return current.length === previousDerived.length && current.every((value, index) => value === previousDerived[index]);
}

/**
 * The full form's CIDR row, which is an input shape rather than a setting.
 *
 * Named once because three places have to agree on it: the field descriptor,
 * the autofill dispatcher, and the submit-time check that refuses to save a
 * network the editor could not make sense of. Nothing is ever written under
 * this key — {@link networkServerProfileSettingUpdates} and the form's own
 * setting writes both work from explicit lists.
 */
export const DHCP_CIDR_FIELD_KEY = "cidr";

/** The DNS field's comma-separated text as the list it stands for. */
function formDnsList(value: FormValues[string]): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The NIC to fill in when a new network has moved the pool off the bound one.
 *
 * The full-form counterpart of the quick editor's `offSubnetInterfaceWrite`,
 * reading the form's own values instead of the settings. Same restraint: only
 * a single unambiguous NIC already on the new subnet is offered. Two matches
 * are a coin toss the editor has no business making, and none means the picker
 * stays the way to answer.
 */
function offSubnetBindAddress(
  values: FormValues,
  rangeStart: string,
  subnet: string,
  interfaces: readonly NetworkInterfaceOption[]
): string | undefined {
  const allowRelayAgents = readSettingBoolean(values.allowRelayAgents);
  const bindAddress = readSettingString(values.interface);
  if (dhcpInterfaceSubnetStatus(bindAddress, subnet, rangeStart, interfaces, allowRelayAgents) !== "mismatch") {
    return undefined;
  }
  const suggestion = suggestBindAddressForPool(rangeStart, subnet, interfaces, allowRelayAgents);
  return suggestion && !suggestion.ambiguous ? suggestion.address : undefined;
}

/**
 * Every form field a network entered as CIDR fills in, or `undefined` when the
 * text describes no usable pool.
 *
 * The gating is the quick editor's `editNetworkCidr` policy, field for field:
 * the three keys the CIDR *is* — mask, pool start, pool size — are always
 * offered, because a pool left on the old network after the mask moved to the
 * new one is not a state the user could have meant; the ones it merely implies
 * (gateway, broadcast, server identifier) and the DNS list are replaced only
 * while they are blank or still hold what the PREVIOUS network derived.
 *
 * The server identifier (option 54) is derived from the same address as the
 * gateway, because that is the packaged convention — `DEFAULTS.serverId` and
 * `DEFAULTS.gateway` are the one address `192.168.2.1`. Leaving it out is how a
 * `10.0.0.0/24` lab ends up telling clients to renew against a `192.168.2.1`
 * that is not on their wire. It is gated against the PREVIOUS network's
 * gateway, not against a separate remembered `serverId`: the gateway is what
 * this fill would itself have written there, so it is the only value that
 * counts as a stale suggestion rather than a decision.
 *
 * The addresses this machine holds are excluded from the suggested pool (see
 * {@link dhcpCidrDerivation}), which is why the NIC list is now needed for the
 * derivation itself and not only for the bind-address offer.
 *
 * Pool *size* rather than pool end: the form asks for a count and computes the
 * `rangeEnd` setting from it on submit ({@link dhcpRangeEndForCount}), so the
 * count is the field a fill has to reach. Writing `rangeEnd` here would land on
 * a key the form does not render and quietly leave the pool the old size.
 *
 * Nothing is written to settings — these are values for fields the user can
 * still see, edit and abandon before Save, which is why there is no
 * confirmation step like the quick editor's.
 */
export function dhcpCidrFormFills(
  text: string,
  values: FormValues,
  interfaces: readonly NetworkInterfaceOption[]
): Record<string, string> | undefined {
  const derived = dhcpCidrDerivation(
    text,
    interfaces.map((option) => option.value)
  );
  if (!derived) return undefined;
  const previous = dhcpDerivedAddresses(
    readSettingString(values.rangeStart) ?? DEFAULTS.rangeStart,
    readSettingString(values.subnet)
  );
  const fills: Record<string, string> = {
    // Normalised: a pool start typed as the CIDR host part (192.168.2.55/24)
    // is echoed back as the network it names, matching what dhcpCurrentCidr
    // would show the next time the form opens.
    [DHCP_CIDR_FIELD_KEY]: `${derived.network}/${String(derived.prefix)}`,
    subnet: derived.subnet,
    rangeStart: derived.rangeStart,
    poolCount: String(derived.poolCount)
  };
  if (isAutoFillable(readSettingString(values.gateway), previous?.gateway)) {
    fills.gateway = derived.gateway;
  }
  if (isAutoFillable(readSettingString(values.serverId), previous?.gateway)) {
    fills.serverId = derived.gateway;
  }
  if (isAutoFillable(readSettingString(values.broadcast), previous?.broadcast)) {
    fills.broadcast = derived.broadcast;
  }
  if (isDnsAutoFillable(formDnsList(values.dns), previous?.dns)) {
    fills.dns = derived.dns.join(", ");
  }
  const bind = offSubnetBindAddress(values, derived.rangeStart, derived.subnet, interfaces);
  if (bind !== undefined) fills.interface = bind;
  return fills;
}

/**
 * The network a chosen NIC is itself on, in CIDR form.
 *
 * @returns `undefined` for the all-interfaces choice (not one NIC, so no
 *   network), for an address this machine does not hold, and for one the
 *   platform reported without a usable netmask — an older or unusual
 *   `os.networkInterfaces()` answer must leave the pool alone rather than have
 *   a mask guessed for it.
 */
export function dhcpInterfaceCidr(
  address: string,
  interfaces: readonly NetworkInterfaceOption[]
): string | undefined {
  if (isAllInterfaces(address)) return undefined;
  const netmask = interfaces.find((option) => option.value === address)?.netmask;
  if (netmask === undefined) return undefined;
  if (!isValidIpv4(address) || !isValidIpv4(netmask) || !isContiguousMask(netmask)) return undefined;
  const prefix = maskToPrefix(netmask);
  if (prefix === undefined) return undefined;
  return `${networkAddress(address, netmask)}/${String(prefix)}`;
}

/**
 * The full form's single autofill entry point: what the field the user just
 * committed implies for the rest of the DHCP form.
 *
 * Both directions land on {@link dhcpCidrFormFills} rather than deriving
 * separately — a NIC is just another way of naming a network, and two
 * derivations would agree today and drift the first time one is touched.
 *
 * @returns `undefined` for a field this form derives nothing from, and for
 *   input that describes no usable pool (`/31`, `/32`, `/0`, anything
 *   malformed, or a network on which this machine's own addresses leave no
 *   room). A partial fill would be worse than none: it would leave the mask on
 *   one network and the pool on another.
 */
export function dhcpFormAutofillFields(
  key: string,
  value: string,
  values: FormValues | undefined,
  interfaces: readonly NetworkInterfaceOption[]
): Record<string, string> | undefined {
  const current = values ?? {};
  if (key === DHCP_CIDR_FIELD_KEY) return dhcpCidrFormFills(value, current, interfaces);
  if (key !== "interface") return undefined;
  const cidr = dhcpInterfaceCidr(value, interfaces);
  return cidr === undefined ? undefined : dhcpCidrFormFills(cidr, current, interfaces);
}

/** One entry of the form's bind-address picker, annotated for the pool it serves. */
export interface DhcpInterfaceChoice {
  readonly label: string;
  readonly value: string;
  /** Shown under the label in the dropdown; absent when there is nothing to say. */
  readonly description?: string;
}

/**
 * The bind-address options with the NICs already on the pool's subnet called
 * out, so the one that is certainly right is not found by reading addresses
 * octet by octet.
 *
 * Asked with relay support switched off, exactly as the quick picker's
 * `isOnPoolSubnet` does: "is this NIC on the pool's subnet" has the same answer
 * either way, and it is the *warning* a relay agent makes irrelevant, not the
 * fact.
 *
 * The order is left alone. The quick picker lifts an unambiguous match to the
 * top because a quick pick is scanned once and dismissed; a form's select is a
 * fixed list the user comes back to, and reordering it between one open and the
 * next costs more than the annotation saves.
 */
export function dhcpInterfaceChoices(
  interfaces: readonly NetworkInterfaceOption[],
  rangeStart: string | undefined,
  subnet: string | undefined
): DhcpInterfaceChoice[] {
  return interfaces.map((option) => {
    if (isAllInterfaces(option.value)) return { label: option.label, value: option.value };
    const onSubnet =
      dhcpInterfaceSubnetStatus(option.value, subnet, rangeStart, interfaces, false) === "match";
    return onSubnet
      ? { label: option.label, value: option.value, description: "matches the pool subnet" }
      : { label: option.label, value: option.value };
  });
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
    // `captureDhcpProfileBody` has always stored this (it comes in with
    // `readDhcpConfig`'s spread), so a profile that omitted the row here was
    // capturing the setting and then silently declining to put it back — the
    // one direction where "leave the live value alone" is indistinguishable
    // from a restore that worked.
    ["allowRelayAgents", config.allowRelayAgents === true],
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
  // Checked first, and by the same function the quick editor's input box uses.
  // The CIDR row is the shorthand every other pool field was filled from, so
  // when it is the thing that cannot be made sense of, saying so beats
  // reporting whichever derived field happens to fail afterwards. A blank row
  // is not an error — it means "leave the pool alone".
  const cidrProblem =
    typeof values[DHCP_CIDR_FIELD_KEY] === "string" ? dhcpCidrProblem(values[DHCP_CIDR_FIELD_KEY]) : undefined;
  if (cidrProblem) return cidrProblem;
  const parserProblem = validateDhcpFormInput(values);
  if (parserProblem) return parserProblem;
  const rangeStart = readSettingString(values.rangeStart);
  const subnet = readSettingString(values.subnet);
  return dhcpPoolProblem(rangeStart, readSettingNumber(values.poolCount), subnet);
}
