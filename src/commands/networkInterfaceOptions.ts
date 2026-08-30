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
 * Anchored where the name is a whole identifier (`docker0`, `vmnet8`) and
 * substring-matched only for the Windows spellings, which are prose
 * (`vEthernet (WSL)`, `VMware Network Adapter VMnet1`). `br-` is Docker's
 * user-defined bridge, whose suffix is a network id.
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
 * Whether a NIC looks virtual, from the two things `os.networkInterfaces()`
 * reports about it.
 *
 * A heuristic, deliberately, and the asymmetry of its two failure modes is what
 * makes one acceptable here. A false POSITIVE costs a suggestion: the address
 * stays in the picker, still annotated as matching the pool subnet, and the
 * user selects it themselves. A false NEGATIVE is simply today's behaviour. So
 * the list may be incomplete without the feature becoming wrong — only less
 * helpful — and nothing downstream may treat the flag as an assertion that the
 * NIC is unusable.
 */
export function isVirtualInterface(name: string, mac?: string): boolean {
  if (VIRTUAL_INTERFACE_NAMES.some((pattern) => pattern.test(name))) return true;
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

function ipv4Options(includeInternal: boolean): NetworkInterfaceOption[] {
  const options: NetworkInterfaceOption[] = [];
  const seen = new Set<string>();
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4") continue;
      if (address.internal && !includeInternal) continue;
      if (address.address === "0.0.0.0" || seen.has(address.address)) continue;
      seen.add(address.address);
      const label = `${name} — ${address.address}`;
      // Each key is added only when there is something to add, so an option
      // built from an address with no reported netmask — and one on a NIC that
      // does not look virtual — stays shape-identical to what this enumerator
      // has always returned.
      const option: NetworkInterfaceOption = { label, value: address.address };
      options.push({
        ...option,
        ...(typeof address.netmask === "string" && address.netmask.length > 0
          ? { netmask: address.netmask }
          : {}),
        ...(isVirtualInterface(name, address.mac) ? { virtual: true } : {})
      });
    }
  }
  return options;
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
