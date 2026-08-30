/**
 * Live NIC enumeration for the network-server editor's bind-address picker.
 *
 * The `nexus.networkServers.*.interface` settings stay `type: "string"` —
 * `contributes.configuration` has no way to offer a machine-specific option
 * list, so the native Settings UI keeps a free-text box. Only the
 * `WebviewFormPanel` form gets the picker, and it is built at open time rather
 * than baked into a static schema: a VPN coming up or a dock being unplugged
 * changes the answer between one Edit and the next.
 */

import * as os from "node:os";

export interface NetworkInterfaceOption {
  readonly label: string;
  readonly value: string;
  /**
   * The NIC's own netmask, as `os.networkInterfaces()` reports it.
   *
   * It never replaces the pool's mask in a NIC ↔ pool comparison — that has to
   * run under the *pool's* mask, because a NIC on a wider one would otherwise
   * claim a subnet it is not on. It is a second, independent condition: the
   * NIC's own subnet must also COVER the pool's, or the host routes part of the
   * pool away from the serving interface (see `nicCoversPool` in
   * `networkServerSettings.ts`). Absent for the all-interfaces choice, which is
   * not one NIC, and for any address reported without a mask — a case those
   * comparisons treat as "unverifiable", never as a match.
   */
  readonly netmask?: string;
  /**
   * The NIC looks like a virtual adapter — a hypervisor switch, a container
   * bridge, a WSL host link, a VPN tunnel — rather than a wire clients are on.
   *
   * It does NOT remove the address from the picker. Serving DHCP to VMs on a
   * Hyper-V internal switch is a real bench setup, and this enumerator's job is
   * to name every address that could be bound, not to decide which one should
   * be. What the flag governs is whether a comparison may pick this NIC *for*
   * the user: `suggestBindAddressForPool` never offers one confidently, so an
   * auto-select and an auto-derived Server Identifier both stay off it (see
   * that function for why one lever covers all three consumers).
   *
   * Withholding the identifier is why the flag is set conservatively rather
   * than generously. Under an all-interfaces bind it is the ONLY route to
   * option 54, so flagging a NIC that is really serving the pool does not just
   * decline to fill the field — it can leave an identifier filled for the
   * previous network sitting there after a change, which is worse than either
   * filling or clearing it. `applyVirtualMacArm` exists for the one case where
   * that was reachable.
   *
   * Absent when the NIC does not look virtual — including on any platform whose
   * `os.networkInterfaces()` answer this heuristic does not recognise, which is
   * the same "no opinion" the key's absence has always meant.
   */
  readonly virtual?: boolean;
}

/**
 * Adapter names that belong to a hypervisor, container runtime or VPN rather
 * than to a physical wire.
 *
 * Anchored at the start throughout, and closed at the end only where the name
 * is a whole identifier (`docker0`, `vmnet8`). The Windows spellings are prose
 * and are matched anywhere in it (`vEthernet (WSL)`, `VMware Network Adapter
 * VMnet1`); `br-` is Docker's user-defined bridge, whose suffix is a network
 * id; and `virbr` is left open because libvirt suffixes its own (`virbr0-nic`),
 * every one of which is as virtual as the bridge itself.
 */
const VIRTUAL_INTERFACE_NAMES: readonly RegExp[] = [
  /^docker\d*$/i,
  /^br-[0-9a-f]+$/i,
  /^virbr\d*/i,
  /^veth/i,
  /^vmnet\d*$/i,
  /^vboxnet\d*$/i,
  /^(?:tun|tap)\d*$/i,
  /^utun\d*$/i,
  /^wg\d*$/i,
  /vethernet/i,
  /virtualbox host-only/i,
  /vmware network adapter/i,
  /hyper-v/i,
  /tap-windows/i
];

/**
 * OUI prefixes hypervisors assign to the adapters they create.
 *
 * A second, independent signal because the name is not always diagnostic: a
 * renamed Windows connection ("Ethernet 3" for a Hyper-V vSwitch) keeps its
 * `00:15:5d` MAC. `02:42` is Docker's, from the locally-administered range.
 */
const VIRTUAL_MAC_PREFIXES: readonly string[] = [
  "00:15:5d",
  "00:50:56",
  "00:0c:29",
  "00:05:69",
  "00:1c:14",
  "08:00:27",
  "0a:00:27",
  "52:54:00",
  "02:42"
];

/**
 * Whether a NIC's NAME says it is virtual.
 *
 * A heuristic, deliberately, and one whose two failure modes are not equally
 * bad. A false NEGATIVE is simply the behaviour that shipped in 2.8.210. A
 * false POSITIVE costs more than the convenience it looks like: besides
 * withholding the suggestion, it stops `resolveDhcpServerIdentifier` resolving
 * option 54 under an all-interfaces bind, which can leave a PREVIOUSLY
 * auto-filled identifier pointing at the old subnet after a network change
 * instead of following it. So the list may be incomplete without the feature
 * becoming wrong, but it may not be liberal — every pattern here has to name a
 * thing that is virtual by construction, and nothing downstream may treat the
 * flag as an assertion that the NIC is unusable.
 */
export function isVirtualInterfaceName(name: string): boolean {
  return VIRTUAL_INTERFACE_NAMES.some((pattern) => pattern.test(name));
}

/** Whether a NIC's MAC carries a hypervisor's OUI. */
export function hasVirtualInterfaceMac(mac?: string): boolean {
  const normalised = (mac ?? "").toLowerCase();
  if (normalised.length === 0 || normalised === "00:00:00:00:00:00") return false;
  return VIRTUAL_MAC_PREFIXES.some((prefix) => normalised.startsWith(prefix));
}

/**
 * The "bind everywhere" choice. Empty rather than the literal `0.0.0.0` so
 * saving it clears the setting and the packaged default applies again — the
 * same thing a blank text box did before the picker existed.
 */
export const ALL_INTERFACES_VALUE = "";

export const ALL_INTERFACES_OPTION: NetworkInterfaceOption = {
  label: "All interfaces (0.0.0.0)",
  value: ALL_INTERFACES_VALUE
};

/**
 * The MAC arm is trusted only while it leaves something unflagged.
 *
 * A hypervisor OUI means two opposite things depending on which side of the
 * hypervisor this code is running on. On a HOST, `00:15:5d` is a Hyper-V switch
 * — the case the name arm misses when the connection has been renamed, which is
 * the whole reason the MAC arm exists. Inside a GUEST, it is the machine's one
 * real NIC: a VS Code running in a VMware or KVM VM, bridged to a physical lab
 * wire, is a perfectly ordinary bench for this extension (EVE-NG is exactly
 * that), and flagging its only NIC would withhold the Server Identifier the
 * pool needs rather than withhold a nicety.
 *
 * The two are told apart by what is left over. A host has something that is
 * neither named nor MAC'd as virtual — its own hardware. A guest does not. So
 * when honouring the MAC arm would flag EVERY remaining NIC, the signal is
 * telling us where we are running, not what this adapter is, and it is dropped;
 * names, which are unambiguous either way, are always honoured.
 */
function applyVirtualMacArm(
  entries: readonly { readonly name: string; readonly mac?: string }[]
): boolean[] {
  const byName = entries.map((entry) => isVirtualInterfaceName(entry.name));
  const byMac = entries.map((entry, index) => !byName[index] && hasVirtualInterfaceMac(entry.mac));
  const survivesMacArm = entries.some((_entry, index) => !byName[index] && !byMac[index]);
  return entries.map((_entry, index) => byName[index] || (survivesMacArm && byMac[index]));
}

function ipv4Options(includeInternal: boolean): NetworkInterfaceOption[] {
  const seen = new Set<string>();
  const entries: { name: string; address: string; netmask?: string; mac?: string }[] = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4") continue;
      if (address.internal && !includeInternal) continue;
      if (address.address === "0.0.0.0" || seen.has(address.address)) continue;
      seen.add(address.address);
      entries.push({
        name,
        address: address.address,
        netmask: typeof address.netmask === "string" && address.netmask.length > 0 ? address.netmask : undefined,
        mac: address.mac
      });
    }
  }
  // Decided across the whole list rather than per NIC, because whether a
  // hypervisor MAC means "this adapter is virtual" depends on what else is
  // here — see `applyVirtualMacArm`.
  const virtual = applyVirtualMacArm(entries);
  // Each key is added only when there is something to add, so an option built
  // from an address with no reported netmask — and one on a NIC that does not
  // look virtual — stays shape-identical to what this enumerator has always
  // returned.
  return entries.map((entry, index) => ({
    label: `${entry.name} — ${entry.address}`,
    value: entry.address,
    ...(entry.netmask === undefined ? {} : { netmask: entry.netmask }),
    ...(virtual[index] ? { virtual: true } : {})
  }));
}

/**
 * Every IPv4 address a service could bind to, with the all-interfaces choice
 * first so it stays the default.
 *
 * Loopback and other internal addresses are filtered out — binding a lab TFTP
 * or DHCP service to `127.0.0.1` serves nothing that could reach it — but only
 * as long as something else remains. A machine with no external IPv4 (offline
 * laptop, everything on IPv6) would otherwise get a picker offering exactly one
 * choice, so there the internal addresses come back rather than leaving the
 * user unable to name an address at all.
 *
 * Virtual adapters (Hyper-V, WSL, Docker, VirtualBox, VPN tunnels) are NOT
 * filtered — `os.networkInterfaces()` reports them as external, and a VM lab
 * served over a host-only switch is a legitimate thing to bind to. They are
 * flagged instead, via `NetworkInterfaceOption.virtual`, so the comparisons
 * that pick a NIC on the user's behalf can decline to pick one while the picker
 * still offers it.
 */
export function networkInterfaceBindOptions(): NetworkInterfaceOption[] {
  const external = ipv4Options(false);
  return [ALL_INTERFACES_OPTION, ...(external.length > 0 ? external : ipv4Options(true))];
}

/**
 * The NIC currently holding `address`, for annotating an address a setting
 * already stores with the interface it actually belongs to.
 *
 * Internal addresses are searched too, unlike {@link networkInterfaceBindOptions}:
 * this answers "what is this configured address" rather than "what should be
 * offered", and hiding the answer for a loopback binding would report a real
 * address as missing.
 *
 * @returns The interface name, or `undefined` when this machine has no IPv4
 *   interface on that address — including for the all-interfaces value, which
 *   is not one NIC and so has no name to give.
 */
export function networkInterfaceNameForAddress(address: string): string | undefined {
  if (address.length === 0 || address === "0.0.0.0") return undefined;
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family === "IPv4" && entry.address === address) return name;
    }
  }
  return undefined;
}
