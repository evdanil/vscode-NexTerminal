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
  return computePoolSize(rangeStart ?? DEFAULTS.rangeStart, effectiveDhcpRangeEnd(rangeEnd));
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
 * The pool end the running service actually uses, once a blank setting has been
 * resolved.
 *
 * A blank `rangeEnd` is not an unknown end. Both engines resolve it the same
 * flat way — `DhcpEngine.rangeEnd` is `this._cfg.rangeEnd ?? DEFAULTS.rangeEnd`
 * and the Rust daemon's `EngineOptions::default()` uses `DEFAULT_RANGE_END`
 * verbatim — so the value is known, concrete, and (this is the part that trips
 * callers up) INDEPENDENT of whatever `rangeStart` is set to. The packaged end
 * is not re-derived from a start the user did set.
 *
 * That distinction matters because {@link poolNetwork} treats an absent end as
 * genuinely unknown and widens the window to the subnet broadcast. That is the
 * right conservative answer for a caller that has no end yet — an in-progress
 * form derivation, say — but the wrong one for a caller reading the settings as
 * they stand: with `rangeStart` `192.168.2.10` and a `/16` mask, the effective
 * pool is `192.168.2.10`–`192.168.2.199`, which a `192.168.2.x/24` NIC serves
 * completely, yet the widened window tests through `192.168.255.255` and reports
 * that NIC as a mismatch. The visible costs are a false sidebar warning, a
 * vanished bind-address suggestion, and — because
 * {@link refreshDhcpServerIdentifier} cannot resolve either side — an option 54
 * left pointing at the NIC the socket has stopped answering on.
 *
 * So every settings-backed caller asking "does this NIC serve the pool as
 * CONFIGURED" resolves the blank here first; only a caller that truly has no end
 * to speak of leaves it out and gets `poolNetwork`'s conservative fallback.
 *
 * Note that the substitution can still describe a window the pool cannot use —
 * a packaged `192.168.2.199` under a `rangeStart` of `10.0.0.50` is exactly the
 * empty/invalid pool the daemon refuses to start on. `poolNetwork` bounds an end
 * that is below the start or above the subnet broadcast back to the conservative
 * fallback, so a nonsense pair lands on the same answer it did before rather
 * than widening any comparison on the strength of it.
 */
export function effectiveDhcpRangeEnd(rangeEnd: string | undefined): string {
  return rangeEnd ?? DEFAULTS.rangeEnd;
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
  readonly excludedAddresses: readonly string[] | undefined;
}): DhcpPoolWindow | undefined {
  const { firstHost, poolSize, poolTop, network, subnet } = input;
  const occupied = Array.from(
    new Set(
      (input.excludedAddresses ?? [])
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
 * `reservedAddresses` are kept out of the pool the same way, and exist because
 * this machine's own addresses are not the only ones on the wire that must not
 * be leased. A gateway or DNS server the user configured by hand SURVIVES this
 * fill — {@link isAutoFillable} preserves anything that is not a stale
 * suggestion — so it is an address the pool has to be built around, exactly as
 * a local NIC is. Without it, a manual gateway of `10.0.0.1` plus a typed
 * `10.0.0.0/24` derives `10.0.0.1`–`10.0.0.253` and the service can hand the
 * router's own address to a client. They are a separate parameter rather than
 * merged into `ownAddresses` by the callers because the two mean different
 * things to the one caller that reports on them: "this machine has no room on
 * that network" and "your own settings leave no room" are different sentences.
 * See {@link preservedInfrastructureAddresses} for working out which values
 * will in fact survive, which both editors must decide identically.
 *
 * @returns `undefined` for anything that is not a `/1`–`/30` network. `/31` and
 *   `/32` parse as CIDR but describe no pool, and `/0` is not a subnet. Also
 *   `undefined` when `ownAddresses` occupy every candidate start, i.e. the
 *   network is real but leaves this machine no address it could hand out — the
 *   same "no usable pool" contract, reached from the other direction.
 */
export function dhcpCidrDerivation(
  text: string,
  ownAddresses?: readonly string[],
  reservedAddresses?: readonly string[]
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
    excludedAddresses: [...(ownAddresses ?? []), ...(reservedAddresses ?? [])]
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
 * `ownAddresses` are this machine's own IPv4 addresses, as
 * {@link dhcpCidrDerivation} takes them. Supplied, they add one further reason
 * a real network still cannot become a pool: every address it could hand out is
 * already held here. Omitted — the quick editor's live input box passes
 * nothing — the check is skipped entirely, so the question stays "does this
 * NETWORK describe a pool", which is the only thing an input box validating
 * keystroke by keystroke can honestly answer.
 *
 * The full form supplies them, because that path has no other line of defence:
 * its autofill derives WITH exclusion, so a network with no room here fills
 * nothing, and without this check Save would then persist the pool the form was
 * still holding from before — the typed network discarded in silence.
 *
 * @returns `undefined` for a usable network, and for blank input, which the
 *   editors treat as "leave it alone" rather than as an error.
 */
export function dhcpCidrProblem(
  text: string,
  ownAddresses?: readonly string[],
  reservedAddresses?: readonly string[]
): string | undefined {
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
  // Reached only for a network that IS usable in the abstract — the check above
  // already said so — so the only thing left to refuse is somebody's occupancy
  // of it. Same wording the quick editor's post-selection warning uses for the
  // same causes, per this function's one-message-per-cause rule, and in the
  // same order: this machine's own addresses first, because "your hardware is
  // on it" is a fact the user cannot edit, while a reserved address is a
  // setting of theirs they can.
  if (ownAddresses && !dhcpCidrDerivation(trimmed, ownAddresses)) {
    return `${trimmed} leaves no pool once this machine's own addresses on it are kept out — every address it could hand out is already taken here.`;
  }
  if (reservedAddresses && !dhcpCidrDerivation(trimmed, ownAddresses, reservedAddresses)) {
    return `${trimmed} leaves no pool once the gateway and DNS addresses you set by hand are kept out — every address it could hand out is already spoken for.`;
  }
  return undefined;
}

/** Whether a bind address means "every interface" rather than one NIC. */
function isAllInterfaces(bindAddress: string | undefined): boolean {
  const trimmed = bindAddress?.trim() ?? "";
  return trimmed.length === 0 || trimmed === "0.0.0.0";
}

/**
 * The pool's own network and the window it actually hands out, or `undefined`
 * when the settings do not describe one.
 *
 * `rangeEnd` is optional, and its absence is not a gap to be filled with a
 * guess: the subnet broadcast is the widest end the `rangeStart`/`subnet` pair
 * could imply, so a caller that does not know the configured end asks the most
 * conservative question available to it — "could this NIC serve ANY pool
 * starting here". A caller that does know the end asks the narrower, truthful
 * one.
 *
 * The fallback window still begins at `start`, not at the subnet's network
 * address, so it is not literally the whole-subnet question the prefix check
 * this replaced asked. It is a WIDENING of it and never the reverse: a NIC whose
 * prefix was equal-or-wider is on-link for the entire subnet, so it contains
 * `start`–broadcast too and every pair the old check accepted is still accepted.
 * What it additionally accepts is the NIC that covers the pool's start and
 * everything above it — which is a true answer the old spelling could not give,
 * since a pool cannot hand out an address below its own start.
 *
 * An end that does not parse, one BELOW the start, or one ABOVE the subnet's own
 * broadcast falls back to that same conservative broadcast rather than being
 * used. `rangeEnd` is a stored setting ({@link dhcpRangeOrderProblem} refuses an
 * inverted pair at the point of entry, but a hand-edited `settings.json` or a
 * restored profile arrives unchecked), and neither malformed shape may be taken
 * at face value:
 *
 *  - an INVERTED window would make the containment test below trivially true — a
 *    NIC merely on-link with the START would be accepted for a pool that
 *    describes no usable window at all. Widening on the strength of nonsense is
 *    the one outcome worse than the conservative fallback.
 *  - an end OUTSIDE the subnet — a stale value left behind when the network was
 *    narrowed, which is exactly as reachable from a hand-edited file as an
 *    inverted one — would break the "pure widening" property this function's
 *    whole contract rests on. `end` is what the NIC has to cover, so an end past
 *    the subnet's broadcast demands coverage of addresses the pool cannot
 *    possibly hand out, and a NIC that is on-link for the ENTIRE advertised
 *    subnet gets reported as a mismatch — the old prefix check's own accepted
 *    case, newly rejected. Bounding the end by the broadcast keeps every pair the
 *    prefix check accepted accepted.
 */
function poolNetwork(
  rangeStart: string | undefined,
  subnet: string | undefined,
  rangeEnd?: string
): { start: string; mask: string; end: string } | undefined {
  const mask = subnet ?? DEFAULTS.subnet;
  const start = rangeStart ?? DEFAULTS.rangeStart;
  if (!isValidIpv4(mask) || !isContiguousMask(mask) || !isValidIpv4(start)) return undefined;
  const broadcast = computeBroadcastAddress(start, mask);
  const usableEnd =
    rangeEnd !== undefined &&
    isValidIpv4(rangeEnd) &&
    compareIpv4(rangeEnd, start) >= 0 &&
    compareIpv4(rangeEnd, broadcast) <= 0
      ? rangeEnd
      : undefined;
  return { start, mask, end: usableEnd ?? broadcast };
}

/**
 * How the interface the service binds relates to the subnet it serves.
 *
 * A DHCP server answers broadcasts that arrive on the wire it is bound to, so a
 * NIC on `192.168.1.x` handing out `10.0.0.x` leases is a lab that looks
 * configured and serves nothing. Nothing else in the settings catches it: every
 * individual field is valid, and only the pair is wrong.
 *
 * "On the pool's subnet" is two conditions, not one. The NIC's address masking
 * into the pool's network under the *pool's* mask is necessary but not
 * sufficient: the NIC's own link has to span every address the pool hands out as
 * well, or part of the range is off-link from this host's point of view. Both
 * are checked by {@link nicCoversPool}, which every branch below goes through.
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
 * @param interfaces From `networkInterfaceBindOptions()`, which filters loopback
 *   and flags virtual NICs without dropping them. This comparison reads the
 *   flag deliberately NOT at all: it asks whether the DISCOVERs can arrive, and
 *   under an all-interfaces bind they genuinely do arrive on a Hyper-V switch
 *   or a Docker bridge the socket is listening on. Warning that a pool served
 *   over a host-only switch is unreachable would be a false alarm about a
 *   working setup. What the flag governs is the opposite direction — picking a
 *   NIC *for* the user — and lives in {@link suggestBindAddressForPool}.
 * @param allowRelayAgents When set, serving a subnet this machine is not on is
 *   the intended configuration — a relay agent forwards the request — so the
 *   comparison is not a fault to report at all, in either bind mode.
 * @param rangeEnd The pool's configured last address, when the caller has it.
 *   Omitted, the comparison falls back to `start`–subnet-broadcast (not the
 *   subnet's own network–broadcast; see {@link poolNetwork}) — the widest window
 *   that start could imply, and the most conservative question a caller that does
 *   not know the end can ask honestly. Supplied, a NIC that covers the
 *   configured window is a `match` even when it does not cover the rest of the
 *   advertised subnet, which is the whole point: a pool of
 *   `10.0.0.130`–`10.0.0.200` on a `/24` is entirely reachable from a
 *   `10.0.0.254/25` NIC, and warning about it is a false alarm.
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
  allowRelayAgents = false,
  rangeEnd?: string
): DhcpInterfaceSubnetStatus {
  const address = bindAddress?.trim() ?? "";
  const bindsEveryInterface = isAllInterfaces(address);
  // Relay agents first, and for both bind modes: with one in front of the
  // service, being off the pool's subnet is the configuration the user asked
  // for, so there is no comparison worth making.
  if (allowRelayAgents) return bindsEveryInterface ? "all-interfaces" : "match";
  const pool = poolNetwork(rangeStart, subnet, rangeEnd);
  if (!pool) return "unusable-mask";
  if (bindsEveryInterface) {
    // "Every NIC" is not "every subnet". The question is the same one a bound
    // address is asked — is this machine on the wire the pool describes — put
    // to the whole filtered list instead of to one address.
    return interfacesOnPoolSubnet(interfaces, pool).length > 0 ? "all-interfaces" : "all-interfaces-off-subnet";
  }
  if (!isValidIpv4(address)) return "unknown-address";
  // Found by identity rather than tested with `.some`, because the verdict needs
  // the option's own reported netmask, not just the fact that it exists.
  const bound = interfaces.find((option) => option.value === address);
  if (!bound) return "unknown-address";
  return nicCoversPool(bound, pool) ? "match" : "mismatch";
}

/**
 * The NICs from the already-filtered list that can actually serve the pool.
 *
 * Shared by the all-interfaces branch above and {@link suggestBindAddressForPool}
 * so the two cannot drift: "is anything here on that subnet" and "which one
 * would I suggest" have to be the same question, or the status warns about a
 * pool the suggestion is happy to serve.
 *
 * Membership is {@link nicCoversPool}'s two conditions, not just the address
 * one: sitting in the pool's network is necessary but not sufficient, because a
 * NIC whose own link does not span the whole `start`–`end` window is off-link
 * for part of the range it would be handing out. The all-interfaces row is
 * excluded there too.
 */
function interfacesOnPoolSubnet(
  interfaces: readonly NetworkInterfaceOption[],
  pool: { start: string; mask: string; end: string }
): NetworkInterfaceOption[] {
  return interfaces.filter((option) => nicCoversPool(option, pool));
}

/**
 * Whether one NIC is on-link for *every* address the pool could hand out.
 *
 * Two conditions, and the second is the one an address-only comparison misses.
 * The NIC's address has to mask into the pool's network under the POOL's mask —
 * necessary, but not sufficient — and the NIC's own link has to contain the
 * whole `start`–`end` window, or part of the range is off-link from this host's
 * point of view.
 *
 * Worked example: `10.0.0.254/25` masks into `10.0.0.0/24` exactly as a
 * legitimate NIC would, so the address test passes. But this host's own subnet
 * for that NIC is `10.0.0.128/25` — a pool of `10.0.0.10`–`10.0.0.200` has its
 * lower half off-link entirely. The broadcast DISCOVER still arrives, which is
 * precisely why the arrangement looks configured; the unicast REQUEST/ACK of a
 * renewal for `10.0.0.10` does not route back out of that interface.
 *
 * REVIEW FINDING — the second condition used to be a PREFIX comparison: the
 * NIC's own mask had to be equal or wider than the pool's, i.e. it had to cover
 * the entire advertised subnet. That is the right question only for a pool that
 * fills its subnet, and a hand-configured one often does not. The very same
 * `10.0.0.254/25` NIC serves a pool of `10.0.0.130`–`10.0.0.200` perfectly —
 * every address in it is on `10.0.0.128/25` — yet `/25 <= /24` is false, so the
 * sidebar warned, the matching-NIC suggestions vanished and server-ID resolution
 * declined a bind that was never wrong. The condition the doc always claimed is
 * coverage of the offered RANGE, so both endpoints are now compared against the
 * NIC's own network and broadcast directly.
 *
 * That is a pure widening even where no configured end is known:
 * {@link poolNetwork} falls back to `start`–subnet-broadcast, and a NIC whose
 * prefix was equal-or-wider necessarily contains the whole subnet, so every pair
 * the prefix check accepted this one accepts too. It additionally accepts two
 * kinds of NIC the prefix spelling could not: the one whose link covers the
 * configured range inside a wider advertised subnet — which is the fix — and,
 * where no end is configured, the one whose link covers everything from the
 * pool's start upwards, since a pool never hands out an address below its own
 * start.
 *
 * A NIC mask that cannot be verified — absent, not a dotted quad, or
 * non-contiguous — is never a match, following this file's standing rule that a
 * wrong answer about a bind is worse than none (see
 * {@link suggestBindAddressForPool}).
 *
 * The all-interfaces pseudo-option is excluded here rather than at the call
 * sites: it is not one NIC, and its empty address masks to `0.0.0.0`, which
 * would falsely match a `0.0.0.0` pool network.
 */
function nicCoversPool(
  option: NetworkInterfaceOption,
  pool: { start: string; mask: string; end: string }
): boolean {
  if (isAllInterfaces(option.value)) return false;
  if (!isSameSubnet(option.value, pool.start, pool.mask)) return false;
  if (option.netmask === undefined || !isValidIpv4(option.netmask) || !isContiguousMask(option.netmask)) {
    return false;
  }
  const nicNetwork = networkAddress(option.value, option.netmask);
  const nicBroadcast = computeBroadcastAddress(option.value, option.netmask);
  return compareIpv4(nicNetwork, pool.start) <= 0 && compareIpv4(pool.end, nicBroadcast) <= 0;
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
 * By the same rule, "on the pool's subnet" here means {@link nicCoversPool}: a
 * NIC whose own mask is narrower than the pool's, or is unverifiable, is not
 * offered at all — and does not count towards `ambiguous` either.
 *
 * A NIC flagged `virtual` is held to the same rule for the same reason. A
 * Hyper-V switch, a Docker bridge and a WSL host link all sit on RFC1918 ranges
 * and would otherwise match a lab pool *confidently* — `docker0` on
 * `172.17.0.1/16` is the single unambiguous NIC for a `172.17.0.0/16` pool, and
 * offering it would bind the service to a bridge no physical client is on. So a
 * virtual NIC is never the confident answer: it is returned only when nothing
 * else matched, and then as `ambiguous`, which every consumer already reads as
 * "do not act on this by yourself". It stays fully usable — the picker lists
 * it, and a bind the user makes to it is a `match` like any other, which is
 * what keeps a deliberately-served VM network working.
 *
 * `ambiguous` therefore means "no single CANDIDATE", not "more than one NIC
 * matched": one physical match alongside a virtual one is unambiguous, because
 * the virtual one was never in the running.
 *
 * @param interfaces From `networkInterfaceBindOptions()`, which flags virtual
 *   NICs rather than dropping them (see above) and filters loopback.
 * @param rangeEnd The pool's configured last address, when the caller has it —
 *   see {@link dhcpInterfaceSubnetStatus}'s parameter of the same name. The two
 *   have to be asked with the same window or the status warns about a pool this
 *   function is happy to offer a NIC for.
 * @returns The single matching address with `ambiguous: false`; the first of
 *   several with `ambiguous: true`, which callers must not auto-select; or
 *   `undefined` when nothing matches, when the pool's subnet is unusable, or
 *   when relay agents are allowed and being off-subnet is intended.
 */
export function suggestBindAddressForPool(
  rangeStart: string | undefined,
  subnet: string | undefined,
  interfaces: readonly NetworkInterfaceOption[],
  allowRelayAgents = false,
  rangeEnd?: string
): BindAddressSuggestion | undefined {
  if (allowRelayAgents) return undefined;
  const pool = poolNetwork(rangeStart, subnet, rangeEnd);
  if (!pool) return undefined;
  const matches = interfacesOnPoolSubnet(interfaces, pool);
  if (matches.length === 0) return undefined;
  const candidates = matches.filter((option) => option.virtual !== true);
  // Nothing but virtual adapters on this subnet: still an answer worth
  // returning — a caller showing the list wants to know one exists — but never
  // a confident one, so it goes back marked the way a genuine tie does.
  if (candidates.length === 0) return { address: matches[0].value, ambiguous: true };
  return { address: candidates[0].value, ambiguous: candidates.length > 1 };
}

/**
 * The address to advertise as the Server Identifier (option 54) for a pool.
 *
 * Option 54 is not another address the network implies — it is *this machine's*
 * address on the wire it serves. `DhcpEngine` copies the `serverId` setting
 * verbatim into every OFFER and ACK, both as option 54 and as the BOOTP
 * `siaddr` a ZTP client reads its image from; the engine never recomputes it per
 * interface. So a value that names no host is not a cosmetic slip — renewals go
 * to an address nothing answers on, and a ZTP boot fetches from nowhere.
 *
 * That rules out the gateway, which is what an earlier pass used here. The
 * gateway this codebase derives is the top usable address of the network
 * ({@link dhcpDerivedAddresses}), chosen because that is where lab appliances
 * put a router — it is an address on the pool's subnet, not an address anyone
 * on this machine holds. The two only ever agreed by coincidence:
 * `DEFAULTS.serverId` and `DEFAULTS.gateway` are both `192.168.2.1`, and that
 * coincidence does not survive a `10.0.0.0/24` whose gateway derives to
 * `10.0.0.254` while the service answers from `10.0.0.10`.
 *
 * The question is therefore the bind address's, not the network's — and it is
 * answered in two different ways, because relay mode does not ask a
 * differently-flagged version of the same question, it asks a narrower one.
 *
 * WITHOUT a relay agent the pool's subnet IS the wire clients are on, so the
 * question is "which address of this machine is on that wire", answered with
 * the same two primitives the bind-address offer uses so a third inline "is
 * there a NIC on this subnet" cannot drift from them:
 *
 *  - a bind address {@link dhcpInterfaceSubnetStatus} calls a `match` is
 *    already an address this machine currently holds on this exact subnet, so
 *    it is returned as-is with nothing further to check;
 *  - otherwise the single unambiguous NIC on the pool's subnet, exactly as
 *    {@link suggestBindAddressForPool} picks the one to bind — the NIC that
 *    will serve the pool is the NIC clients see this machine on.
 *
 * Both are asked with `allowRelayAgents` forced off: they are subnet
 * comparisons, and the flag's entire effect on them is to stop comparing.
 *
 * WITH a relay agent the pool's subnet is by design a wire this machine is NOT
 * on, so every subnet comparison is meaningless and no NIC can be *suggested*
 * from the pool at all. What survives is the identity question about the bind
 * alone, asked directly here: an explicit bind address this machine currently
 * holds is still the address renewals and ZTP `siaddr` fetches have to reach —
 * a service bound to a concrete `192.168.1.5` while relaying `10.0.0.0/24`
 * answers from `192.168.1.5`, relay or not, and that is exactly what option 54
 * has to say. Nothing else resolves: an all-interfaces or unset bind names no
 * single address, and a bind that is not a dotted quad, or is one no interface
 * here holds, names nothing reachable.
 *
 * That identity check is made inline rather than by delegating to
 * {@link dhcpInterfaceSubnetStatus}'s own relay branch, which answers `match`
 * for ANY non-blank bind string. That branch is answering "is being off-subnet
 * a fault" — no, for a relayed pool, whatever the string says — not "does this
 * string name an address". Resolving an identifier through it would advertise
 * typos and addresses nothing here holds, which is worse than the blanket relay
 * skip this branch replaces.
 *
 * That blanket skip is what stood before: relay mode wrote no identifier at
 * all, at any of the three call sites, on the reasoning that a relayed pool
 * implies no local NIC. True of the POOL, false of the BIND — which is why
 * {@link suggestBindAddressForPool}'s own relay bail is left exactly as it is
 * and simply goes unreached from here: "which NIC should I BIND to" really is
 * unanswerable for a relayed pool, and it is a different question from this one.
 *
 * @returns `undefined` whenever no single address of this machine can be
 *   identified — without relay: no match, nothing on the pool's subnet, or more
 *   than one; with relay: a bind that is all-interfaces, unset, malformed, or
 *   unheld. There is deliberately no fallback: an unresolved case means "no
 *   confident answer", and callers must leave whatever is configured alone
 *   rather than write an address picked for the shape of it. Same restraint,
 *   and the same reason, as {@link suggestBindAddressForPool}'s refusal to guess.
 */
export function resolveDhcpServerIdentifier(
  rangeStart: string | undefined,
  subnet: string | undefined,
  bindAddress: string | undefined,
  interfaces: readonly NetworkInterfaceOption[],
  allowRelayAgents = false,
  rangeEnd?: string
): string | undefined {
  if (allowRelayAgents) {
    const trimmed = bindAddress?.trim() ?? "";
    if (isAllInterfaces(trimmed) || !isValidIpv4(trimmed)) return undefined;
    return interfaces.some((option) => option.value === trimmed) ? trimmed : undefined;
  }
  if (dhcpInterfaceSubnetStatus(bindAddress, subnet, rangeStart, interfaces, false, rangeEnd) === "match") {
    return bindAddress?.trim();
  }
  const suggestion = suggestBindAddressForPool(rangeStart, subnet, interfaces, false, rangeEnd);
  return suggestion && !suggestion.ambiguous ? suggestion.address : undefined;
}

/** One side of a server-identifier refresh: the pool and the bind, together. */
export interface DhcpServerIdentifierEndpoint {
  readonly rangeStart: string | undefined;
  readonly subnet: string | undefined;
  readonly bindAddress: string | undefined;
  /**
   * The pool's configured last address on this side of the change, when the
   * caller has it. Omitted, the resolution asks about `start`–subnet-broadcast
   * — the conservative fallback, and what every caller got before the window was
   * threaded through; see {@link dhcpInterfaceSubnetStatus}'s parameter of the
   * same name and {@link poolNetwork} for why that is not literally the whole
   * subnet.
   */
  readonly rangeEnd?: string;
}

/**
 * The Server Identifier a change implies, or `undefined` to leave the
 * configured one alone.
 *
 * This is the whole "resolve for the new state, resolve for the state it
 * replaces, write only if what is configured is still the old resolution"
 * shape, named once. It was independently copy-pasted at three trigger points —
 * {@link dhcpCidrFormFills} (the full form's CIDR and NIC-pick autofill),
 * `editNetworkCidr` and `rebindServerIdentifier` (Quick Adjust's Network row and
 * Interface row) — which is precisely why the relay-mode defect above had to be
 * found and fixed three separate times. A fourth trigger point calls this
 * instead of reimplementing the shape a fourth time.
 *
 * The endpoints are OBJECTS rather than positional arguments on purpose. Every
 * caller holds two bind addresses that differ by one field and read identically
 * at a call site, and mixing them up is not a near-miss: see the comment in
 * {@link dhcpCidrFormFills} for the exact bug — switching between two NICs on
 * ONE subnet resolved the NEW address on both sides, the stale identifier
 * survived the gate as though hand-set, and the service answered from `.6` while
 * telling every client to renew at `.5`. A shape that has to be labelled cannot
 * be transposed in silence.
 *
 * `allowRelayAgents` is FORWARDED, not decided here and not decided by the
 * callers: {@link resolveDhcpServerIdentifier} is the single place that knows
 * what relay mode does to this question, and both resolutions have to be asked
 * under the same rules or the gate compares two different questions' answers.
 */
export function refreshDhcpServerIdentifier(args: {
  readonly next: DhcpServerIdentifierEndpoint;
  readonly previous: DhcpServerIdentifierEndpoint;
  readonly interfaces: readonly NetworkInterfaceOption[];
  readonly allowRelayAgents: boolean;
  readonly configuredServerId: string | undefined;
}): string | undefined {
  const resolved = resolveDhcpServerIdentifier(
    args.next.rangeStart,
    args.next.subnet,
    args.next.bindAddress,
    args.interfaces,
    args.allowRelayAgents,
    args.next.rangeEnd
  );
  if (resolved === undefined) return undefined;
  const previous = resolveDhcpServerIdentifier(
    args.previous.rangeStart,
    args.previous.subnet,
    args.previous.bindAddress,
    args.interfaces,
    args.allowRelayAgents,
    args.previous.rangeEnd
  );
  return isAutoFillable(args.configuredServerId, previous) ? resolved : undefined;
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
 * The infrastructure addresses a CIDR fill is about to leave alone, and which
 * therefore have to be kept out of the pool it derives.
 *
 * A fill replaces the gateway and DNS only when they are its own stale
 * suggestions ({@link isAutoFillable}); anything the user typed survives. That
 * makes the surviving values part of the network the new pool is being built
 * on, no different from an address a NIC here holds — a router at `10.0.0.1`
 * is a router whether this machine can see it in `os.networkInterfaces()` or
 * not, and leasing its address to a client breaks the network either way.
 *
 * Deciding this BEFORE the derivation is what makes the ordering work, and it
 * is possible because neither predicate consults the new network: both compare
 * the value in hand against what the PREVIOUS network would have derived.
 *
 * The Server Identifier is deliberately not in here. When it is auto-filled it
 * resolves to an address this machine holds, which `ownAddresses` already
 * covers; when it is preserved it is the user's own statement about which of
 * this machine's addresses to advertise. Neither case adds an address the pool
 * does not already know about, and asking for it here would need the derived
 * window that {@link refreshDhcpServerIdentifier} is itself resolved from.
 *
 * @param previous What the network as it stood would have derived, or
 *   `undefined` when it derives nothing — in which case no current value can be
 *   a stale suggestion, so every one of them is preserved and excluded.
 */
export function preservedInfrastructureAddresses(args: {
  readonly gateway: string | undefined;
  readonly dns: readonly string[];
  readonly previous: { readonly gateway: string; readonly dns: readonly string[] } | undefined;
}): string[] {
  const preserved: string[] = [];
  if (!isAutoFillable(args.gateway, args.previous?.gateway) && args.gateway !== undefined) {
    preserved.push(args.gateway);
  }
  if (!isDnsAutoFillable(args.dns, args.previous?.dns)) preserved.push(...args.dns);
  return preserved.filter((address) => isValidIpv4(address));
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
  interfaces: readonly NetworkInterfaceOption[],
  rangeEnd?: string
): string | undefined {
  const allowRelayAgents = readSettingBoolean(values.allowRelayAgents);
  const bindAddress = readSettingString(values.interface);
  const status = dhcpInterfaceSubnetStatus(
    bindAddress,
    subnet,
    rangeStart,
    interfaces,
    allowRelayAgents,
    rangeEnd
  );
  if (status !== "mismatch") return undefined;
  const suggestion = suggestBindAddressForPool(rangeStart, subnet, interfaces, allowRelayAgents, rangeEnd);
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
 * The server identifier (option 54) is the one implied field that does NOT come
 * from the network: it is this machine's own address on the wire it serves, so
 * it is resolved from the serving NIC by {@link resolveDhcpServerIdentifier}.
 * Leaving it out is how a `10.0.0.0/24` lab ends up telling clients to renew
 * against a `192.168.2.1` that is not on their wire; filling it from the
 * gateway is how they end up renewing against a `10.0.0.254` that belongs to
 * the router, or to nothing at all. Its gate is the same resolution run against
 * the PREVIOUS network — "is what is there still what this fill would itself
 * have written before the network moved" — rather than the previous gateway,
 * which this fill no longer writes and so can no longer claim as its own.
 *
 * REVIEW FINDING (P1) — with relay agents allowed, the derived GATEWAY is never
 * written for it. A relayed pool is on the client subnet, so its gateway is the
 * CLIENT subnet's router: a server bound at `192.168.1.5` serving `10.0.0.0/24`
 * through a relay told every client that option 54 and BOOTP `siaddr` were
 * `10.0.0.254`, so unicast renewals and ZTP image fetches went to the router
 * instead of to this service. Fabricating a value is worse than declining to.
 *
 * REVIEW FINDING (P1, fifth round — relay with an explicit held bind) — but the
 * fix for that was a blanket relay skip *here*, and it went too far. It read
 * "relay means no address to resolve", which is true of the POOL and false of
 * the BIND: a service bound to a concrete address this machine holds answers
 * from that address whether or not a relay sits in front of it, and that is
 * exactly what option 54 must name. Relay mode is now FORWARDED into
 * {@link refreshDhcpServerIdentifier} rather than decided here, so the abstain
 * happens only where it is genuinely warranted — an all-interfaces, unset,
 * malformed or unheld bind, i.e. a bind that names no single address of this
 * machine. See {@link resolveDhcpServerIdentifier} for the two-branch contract.
 * The gate is still what makes "not written" the whole story either way — an
 * unresolved server identifier never reaches `fills`, so the field keeps what it
 * has.
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
 *
 * @param previousBindAddress The bind address as it stood BEFORE whatever
 *   gesture triggered this fill, for the previous-network server identifier
 *   baseline alone. Supplied only by the INTERFACE trigger, where the webview
 *   has already applied the new selection to the DOM before posting, so
 *   `values.interface` is the new NIC on both sides of the change and this is
 *   the only surviving record of the old one. Omitted by the CIDR-text trigger,
 *   which cannot move the bind address by committing itself — there the current
 *   address genuinely IS the address either side, and the fallback below says
 *   exactly that.
 */
export function dhcpCidrFormFills(
  text: string,
  values: FormValues,
  interfaces: readonly NetworkInterfaceOption[],
  previousBindAddress?: string
): Record<string, string> | undefined {
  const previousRangeStart = readSettingString(values.rangeStart) ?? DEFAULTS.rangeStart;
  const previousSubnet = readSettingString(values.subnet);
  // The previous network is resolved BEFORE the derivation, not after it as an
  // earlier pass had it, because the pool has to be built around the gateway
  // and DNS this fill is going to preserve — and which those are is a question
  // about the OLD network (see `preservedInfrastructureAddresses`). Nothing
  // here reads `derived`, so the move is an ordering change and not a
  // behavioural one for any value below.
  const previous = dhcpDerivedAddresses(previousRangeStart, previousSubnet);
  const derived = dhcpCidrDerivation(
    text,
    interfaces.map((option) => option.value),
    preservedInfrastructureAddresses({
      gateway: readSettingString(values.gateway),
      dns: formDnsList(values.dns),
      previous
    })
  );
  if (!derived) return undefined;
  // The form renders a pool COUNT, not an end, and derives `rangeEnd` from the
  // pair on submit (see the `rangeEnd` row in `networkServerCommands.ts`). The
  // previous window is therefore reconstructed the same way rather than read
  // from a field that does not exist — letting the previous-state resolution
  // fall back to the conservative `start`–subnet-broadcast window while the next
  // one is asked about a narrow one would compare two different questions'
  // answers through the gate. A blank count resolves through
  // `effectiveDhcpRangeEnd` to the packaged end. `FormValues` cannot say
  // whether that blank means the count was just cleared or was never set —
  // both read identically here, and nothing in this function can tell them
  // apart — but it does not need to: the packaged end is the right previous
  // state either way, because the alternative is `poolNetwork`'s conservative
  // subnet-broadcast widening, which would ask the two sides of the comparison
  // different questions.
  const previousRangeEnd = effectiveDhcpRangeEnd(
    dhcpRangeEndForCount(previousRangeStart, readSettingNumber(values.poolCount))
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
  // Two bind addresses, because the two resolutions are two different
  // questions. `bindAddress` answers "what would this fill write NOW", and has
  // to be the address currently selected. `previousBind` answers "would this
  // fill itself have written what is sitting in the field, under the network as
  // it stood" — and for an INTERFACE change the address that was selected then
  // is not this one. The webview applies the selection before it posts, so
  // reusing `bindAddress` for both asks the previous-network question about the
  // NEW NIC: switching between two NICs on ONE subnet (10.0.0.5 → 10.0.0.6)
  // then resolves .6 on both sides, an auto-filled serverId of .5 fails
  // isAutoFillable and survives, and the service answers from .6 while telling
  // clients to renew at .5. Absent a supplied one — the CIDR-text trigger,
  // which moves no NIC — the current address IS the address either side and the
  // fallback is exact. Labelled endpoints rather than four positional address
  // arguments precisely so that mix-up cannot be reintroduced silently.
  const bindAddress = readSettingString(values.interface);
  const previousBind = readSettingString(previousBindAddress ?? bindAddress);
  const resolvedServerId = refreshDhcpServerIdentifier({
    next: {
      rangeStart: derived.rangeStart,
      subnet: derived.subnet,
      bindAddress,
      rangeEnd: derived.rangeEnd
    },
    previous: {
      rangeStart: previousRangeStart,
      subnet: previousSubnet,
      bindAddress: previousBind,
      rangeEnd: previousRangeEnd
    },
    interfaces,
    allowRelayAgents: readSettingBoolean(values.allowRelayAgents),
    configuredServerId: readSettingString(values.serverId)
  });
  if (resolvedServerId !== undefined) fills.serverId = resolvedServerId;
  if (isAutoFillable(readSettingString(values.broadcast), previous?.broadcast)) {
    fills.broadcast = derived.broadcast;
  }
  if (isDnsAutoFillable(formDnsList(values.dns), previous?.dns)) {
    fills.dns = derived.dns.join(", ");
  }
  const bind = offSubnetBindAddress(values, derived.rangeStart, derived.subnet, interfaces, derived.rangeEnd);
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
 * The two triggers are NOT interchangeable in one respect, which is what
 * `previousValue` is for. Committing the CIDR row changes that row and nothing
 * else, so the bind address in `values` is the address this machine was on both
 * before and after. Picking a NIC changes the bind address itself, and the
 * webview has already applied that selection by the time this runs — so
 * `values.interface` holds the NEW address on both sides, and the previous one
 * survives only in `previousValue`. It is passed on for the interface trigger
 * alone; the CIDR trigger passes nothing and {@link dhcpCidrFormFills} falls
 * back to the current address, which for that trigger is correct rather than
 * merely convenient.
 *
 * @param previousValue What the field named by `key` held immediately before
 *   this change. Meaningful only for `interface`; ignored for anything else,
 *   including a CIDR commit, where the field it would describe is not a bind
 *   address at all.
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
  interfaces: readonly NetworkInterfaceOption[],
  previousValue?: string
): Record<string, string> | undefined {
  const current = values ?? {};
  if (key === DHCP_CIDR_FIELD_KEY) return dhcpCidrFormFills(value, current, interfaces);
  if (key !== "interface") return undefined;
  // Under a relay agent the two triggers stop meaning the same thing. Typing a
  // CIDR still says "serve THIS network" — that is the whole point of the row,
  // and a relayed pool is a network the user has to name by hand precisely
  // because this machine is not on it. Picking a NIC says only "answer from
  // this address", and the NIC's own network is the LOCAL one, on the far side
  // of the relay from every client. Deriving the pool from it replaces the
  // relayed subnet, pool, gateway, broadcast and DNS with a network no client
  // is on: rebinding a server that relays `10.0.0.0/24` from `192.168.1.5` to
  // `192.168.1.6` silently starts offering `192.168.1.0/24` on Save.
  if (readSettingBoolean(current.allowRelayAgents)) {
    return dhcpRelayBindFills(value, current, interfaces, previousValue);
  }
  const cidr = dhcpInterfaceCidr(value, interfaces);
  return cidr === undefined ? undefined : dhcpCidrFormFills(cidr, current, interfaces, previousValue);
}

/**
 * What a NIC change implies when a relay agent is in front of the service:
 * the Server Identifier, and nothing else.
 *
 * The identifier still has to move, and is the one value here that genuinely
 * does. Option 54 and BOOTP `siaddr` name the address clients reach THIS
 * machine on, which a relay does not change — the relay forwards to it — so a
 * rebind from `192.168.1.5` to `192.168.1.6` leaves an auto-filled identifier
 * pointing at an address the socket has stopped answering on. The gate is
 * {@link refreshDhcpServerIdentifier}'s, shared with the other call sites, so
 * an identifier the user typed survives this exactly as it survives the rest.
 *
 * Both endpoints carry the pool as it stands, unchanged: picking a NIC does not
 * move the pool, and under relay {@link resolveDhcpServerIdentifier} does not
 * read it at all. It is passed rather than omitted so the two sides are asked
 * the same question, which is the property the gate depends on.
 */
function dhcpRelayBindFills(
  value: string,
  values: FormValues,
  interfaces: readonly NetworkInterfaceOption[],
  previousValue?: string
): Record<string, string> | undefined {
  const rangeStart = readSettingString(values.rangeStart) ?? DEFAULTS.rangeStart;
  const subnet = readSettingString(values.subnet);
  const rangeEnd = dhcpRangeEndForCount(rangeStart, readSettingNumber(values.poolCount));
  const pool = { rangeStart, subnet, rangeEnd };
  const resolved = refreshDhcpServerIdentifier({
    next: { ...pool, bindAddress: value },
    previous: { ...pool, bindAddress: readSettingString(previousValue ?? value) },
    interfaces,
    allowRelayAgents: true,
    configuredServerId: readSettingString(values.serverId)
  });
  return resolved === undefined ? undefined : { serverId: resolved };
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
  subnet: string | undefined,
  rangeEnd?: string
): DhcpInterfaceChoice[] {
  return interfaces.map((option) => {
    if (isAllInterfaces(option.value)) return { label: option.label, value: option.value };
    const onSubnet =
      dhcpInterfaceSubnetStatus(option.value, subnet, rangeStart, interfaces, false, rangeEnd) === "match";
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
 * Why the pool this Save is about to write cannot be served by the interface it
 * is bound to, phrased for the submit check — the Interface picker's
 * counterpart to {@link dhcpCidrProblem}.
 *
 * Picking a NIC is the form's second way of naming a network: the fill derives
 * the NIC's own CIDR and moves the whole pool onto it
 * ({@link dhcpFormAutofillFields}). When that derivation produces nothing the
 * fill returns nothing, and the webview has ALREADY applied the selection to
 * the DOM before it posts — so the bind address moves, every pool row keeps the
 * previous network's values, and without this check Save persists the new bind
 * beside a pool on a network no client of it is on. The CIDR row's own check
 * closes the identical hole for the typed shorthand; this closes it for the
 * picked one.
 *
 * The question it asks is COHERENCE OF THE SUBMITTED PAIR, not feasibility of a
 * fresh derivation. That distinction is the whole contract, and getting it
 * wrong is what an earlier pass did: it ran {@link dhcpCidrDerivation} over the
 * NIC's own network and refused the save whenever no FRESH pool could be built
 * there, regardless of what the form was actually submitting. Two working, and
 * previously savable, configurations were refused by that:
 *
 *  - a `/30` point-to-point bind — this machine on `10.0.0.1`, handing its one
 *    peer `10.0.0.2`. The pool is perfectly coherent with the bind; it is
 *    excluded only by the derivation's own gateway-at-the-top convention
 *    (`poolTop` is the gateway minus one), which has no authority over a pool
 *    the user built by hand.
 *  - a held NIC the platform reports without a netmask, carrying a complete
 *    hand-typed pool for its own wire. Nothing was picked, so there was no
 *    stale pairing to catch — yet every save was refused, permanently, with no
 *    way out.
 *
 * So the verdict comes from {@link dhcpInterfaceSubnetStatus}, the same
 * already-tested predicate the sidebar annotation, the bind suggestion and the
 * server-identifier resolution all go through, asked about the pool AS THIS
 * SAVE WILL WRITE IT. A pool the bind already covers is accepted however it was
 * built. Only `mismatch` — the bind genuinely not on-link for the range the
 * pool hands out — is the stale pairing this check exists for, and only then is
 * the derivation consulted, to say whether the fill could have closed the gap.
 *
 * The other statuses are deliberately silent. `unknown-address` is an address
 * this machine no longer holds, which the picker keeps selectable on purpose
 * (see {@link suggestBindAddressForPool}) and which is reported where the
 * address is shown; `unusable-mask` is a malformed `subnet` or `rangeStart`,
 * which is {@link validateDhcpFormInput}'s field-labelled job — two messages
 * for one typo is worse than one. The all-interfaces choice names no single
 * NIC and returns above.
 *
 * Refusing the save is right for a NON-relayed service specifically, and not
 * merely because that is where the silent fill lives: without a relay agent the
 * only clients that can reach the service are the ones broadcasting on the wire
 * it is bound to, so the pool has to live on that wire's own network.
 *
 * That reasoning is exactly why relay mode is carved out rather than left to
 * fall through. Structurally the failure is already unreachable there —
 * {@link dhcpFormAutofillFields} sends a relayed NIC pick to
 * {@link dhcpRelayBindFills}, which resolves the Server Identifier and never
 * touches the pool — but running the check anyway would not be redundant, it
 * would be wrong: a relayed pool is on the CLIENT subnet by definition, and the
 * local bind is free to sit on a `/30` point-to-point uplink that could never
 * host a pool of its own. Same distinction {@link dhcpInterfaceChoices} draws
 * from the other side — it is the *comparison* a relay agent makes irrelevant,
 * not the fact.
 *
 * @returns `undefined` when there is no concrete NIC to ask about, when relay
 *   agents are allowed, when the submitted pool is one the bind already covers,
 *   and when nothing here can honestly decide — an address this machine does
 *   not hold, or a pool whose own subnet does not parse.
 */
function dhcpInterfacePairingProblem(
  values: FormValues,
  interfaces: readonly NetworkInterfaceOption[],
  ownAddresses: readonly string[] | undefined,
  reservedAddresses: readonly string[]
): string | undefined {
  if (readSettingBoolean(values.allowRelayAgents)) return undefined;
  const bindAddress = readSettingString(values.interface);
  if (bindAddress === undefined || isAllInterfaces(bindAddress)) return undefined;
  const rangeStart = readSettingString(values.rangeStart);
  const subnet = readSettingString(values.subnet);
  // The window this submission will really hand out. The form renders a pool
  // COUNT and `networkServerSettingUpdates` derives the `rangeEnd` setting from
  // it, so the end is reconstructed the same way rather than read from a field
  // the form does not have — exactly as `dhcpCidrFormFills` reconstructs the
  // previous state's end, and through `effectiveDhcpRangeEnd` for the same
  // reason: a blank count is a cleared key, and a cleared key runs on the
  // packaged end, not on the conservative whole-subnet fallback.
  const rangeEnd = effectiveDhcpRangeEnd(dhcpRangeEndForCount(rangeStart, readSettingNumber(values.poolCount)));
  if (dhcpInterfaceSubnetStatus(bindAddress, subnet, rangeStart, interfaces, false, rangeEnd) !== "mismatch") {
    return undefined;
  }
  const poolCidr = dhcpCurrentCidr(rangeStart, subnet);
  // Unreachable: `mismatch` is only reached once `poolNetwork` has resolved a
  // usable mask and a parseable start, which is precisely what this needs. Kept
  // as a silent bail rather than an assertion — a complaint that cannot name
  // the network it is about would be worse than saying nothing.
  if (poolCidr === undefined) return undefined;
  const cidr = dhcpInterfaceCidr(bindAddress, interfaces);
  if (cidr === undefined) {
    // Held (an unheld address answered `unknown-address` above) but with no
    // usable netmask to its name. Only one fact about it needs no mask: whether
    // the bind sits in the pool's own network. If it does, the pairing cannot be
    // proven wrong — a NIC the platform failed to describe is not evidence
    // against a pool — and a check that refuses on the strength of missing
    // information locks the user out of a config that works. If it does not,
    // the pairing IS decidably wrong, and it is the stale one: picking such a
    // NIC fills nothing, so a pool off its network was never moved to match it.
    const pool = poolNetwork(rangeStart, subnet, rangeEnd);
    if (pool === undefined || isSameSubnet(bindAddress, pool.start, pool.mask)) return undefined;
    return `The interface you picked (${bindAddress}) is not on ${poolCidr}, the network the pool below serves, and the platform reports no usable subnet mask for it — so there is no network to derive a pool from here either. Set a pool for the network that interface is on, or pick a different interface.`;
  }
  // A masked NIC genuinely off the pool's network. What the derivation adds is
  // only whether the fill COULD have moved the pool here — never a claim that
  // an address is occupied, which is a thing the convention below cannot know.
  // One message per cause, in the order `dhcpCidrProblem` uses for the same
  // three: what the network is, then the occupancy the user cannot edit, then
  // the settings of theirs that they can.
  const preface = `The interface you picked (${bindAddress}) is on ${cidr}, and the pool below is on ${poolCidr} — no client on that interface's wire would be offered a lease. The pool cannot be moved onto ${cidr} for you either:`;
  if (!dhcpCidrDerivation(cidr)) {
    return `${preface} a /31 or /32 has no host range for a pool to hand out. Pick a different interface.`;
  }
  if (ownAddresses && !dhcpCidrDerivation(cidr, ownAddresses)) {
    return `${preface} keeping this machine's own addresses on it clear of the pool leaves no room to derive one. Set a pool for ${cidr} by hand, or pick a different interface.`;
  }
  if (!dhcpCidrDerivation(cidr, ownAddresses, reservedAddresses)) {
    return `${preface} keeping the gateway and DNS addresses you set by hand clear of the pool leaves no room to derive one. Set a pool for ${cidr} by hand, or pick a different interface.`;
  }
  return undefined;
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
 *
 * @param interfaces The NICs the form enumerated when it opened, for the
 *   Interface picker's own network check. Defaults to an empty list, under
 *   which no bind address can resolve to a NIC and that check is inert — the
 *   behaviour every caller that does not know about the picker already had.
 */
export function validateDhcpValues(
  values: FormValues,
  ownAddresses?: readonly string[],
  interfaces: readonly NetworkInterfaceOption[] = []
): string | undefined {
  // The reserved addresses are worked out here rather than taken as a
  // parameter, from the same fields and by the same helper `dhcpCidrFormFills`
  // uses, because the two have to agree by construction. Threading them from
  // the caller would let one editor's idea of "preserved" drift from the
  // other's, which is the very divergence this check exists to close.
  const reservedAddresses = preservedInfrastructureAddresses({
    gateway: readSettingString(values.gateway),
    dns: formDnsList(values.dns),
    previous: dhcpDerivedAddresses(
      readSettingString(values.rangeStart) ?? DEFAULTS.rangeStart,
      readSettingString(values.subnet)
    )
  });
  // Checked first, and by the same function the quick editor's input box uses.
  // The CIDR row is the shorthand every other pool field was filled from, so
  // when it is the thing that cannot be made sense of, saying so beats
  // reporting whichever derived field happens to fail afterwards. A blank row
  // is not an error — it means "leave the pool alone".
  //
  // `ownAddresses` and the reserved addresses above are what make the CIDR row's
  // autofill and this check ask the same question. The autofill derives with
  // both excluded; without excluding them here too, a network that leaves no
  // room once they are kept out would fill nothing and still save, keeping the
  // pool the form opened on and discarding the typed network without a word.
  // The reserved half was the half that got away: a hand-set gateway of
  // 10.0.0.1 with 10.0.0.0/30 typed in filled nothing and saved cleanly.
  const cidrProblem =
    typeof values[DHCP_CIDR_FIELD_KEY] === "string"
      ? dhcpCidrProblem(values[DHCP_CIDR_FIELD_KEY], ownAddresses, reservedAddresses)
      : undefined;
  if (cidrProblem) return cidrProblem;
  // Second, because the Interface picker is the form's OTHER way of naming the
  // network — same silent-fill hole, so it belongs beside the row it mirrors
  // rather than after the per-field parser. The typed row keeps precedence when
  // both would refuse: a CIDR is a thing the user just wrote out in full, and
  // complaining about the network a NIC merely implies would answer a question
  // they did not ask.
  //
  // It asks a different question from the row above, though, and the difference
  // is deliberate: the CIDR row is checked for whether a pool can be DERIVED
  // from what was typed, while the bind is checked for whether the pool being
  // SUBMITTED is coherent with it. A hand-built pool the picked NIC already
  // serves is not the fill's business and is not refused here, however it came
  // to exist — see `dhcpInterfacePairingProblem` for the two working configs an
  // earlier "could a fresh pool be derived on this NIC" spelling rejected.
  const interfaceProblem = dhcpInterfacePairingProblem(values, interfaces, ownAddresses, reservedAddresses);
  if (interfaceProblem) return interfaceProblem;
  const parserProblem = validateDhcpFormInput(values);
  if (parserProblem) return parserProblem;
  const rangeStart = readSettingString(values.rangeStart);
  const subnet = readSettingString(values.subnet);
  return dhcpPoolProblem(rangeStart, readSettingNumber(values.poolCount), subnet);
}
