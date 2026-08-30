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
      // The key is added only when there is one to add, so an option built from
      // an address with no reported netmask stays shape-identical to what this
      // enumerator has always returned.
      options.push(
        typeof address.netmask === "string" && address.netmask.length > 0
          ? { label, value: address.address, netmask: address.netmask }
          : { label, value: address.address }
      );
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
