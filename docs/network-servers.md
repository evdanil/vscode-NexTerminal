# Embedded Network Servers (TFTP + DHCP)

Serve firmware and configs to lab hardware, and hand it addresses, without installing a separate daemon or borrowing the office DHCP server.

Both services live in the **Network Servers** view of the Nexus sidebar. Each one has **Quick Settings** for everyday changes and **Open Full Settings** for the full form.

## Choose an Interface

Both services bind every interface (`0.0.0.0`) unless you pick one, from a live list of this machine's IPv4 addresses, in Quick Settings or the full form.

## TFTP

TFTP is read-only until you opt into uploads, and sandboxes every filename a client sends inside the configured root, so a `../` cannot escape it.

Live transfers show progress and speed and can be cancelled from the sidebar.

## DHCP

DHCP runs full DORA with static reservations, leases that survive a restart, and the ZTP boot options a switch actually asks for (66, 67, 150, 60, 43).

### Network (CIDR) row

A **Network (CIDR)** row in both Quick Settings and the full form takes a whole network in one go — type `192.168.2.0/24` and the subnet mask, pool and gateway that follow from it are filled in, with DNS pointed at the gateway.

Nothing is stored under that shorthand, and Quick Settings shows exactly what it would write and asks before writing it.

### When the NIC and the pool disagree

If the NIC the service is bound to is not on the subnet the pool hands out — a lab that binds `192.168.1.x` and offers `10.0.0.x` leases looks correct in every individual field and serves nothing usable — the sidebar, Quick Settings and the form all say so, and offer the one NIC already on that subnet when exactly one matches — never a virtual adapter (Docker, WSL, Hyper-V, VPN), which stays selectable but is not something to pick for you.

Save refuses a bind only when the interface's network genuinely does not match the pool *and* no pool could be derived on that interface either, so a pool that already fits the NIC you picked — a `/30` point-to-point link, a range narrowed inside a wider subnet, a NIC the platform reports without a netmask — saves as it always did.

## Quick Settings and Profiles

**Quick Settings** also offers to fill in the gateway and broadcast that follow from a new pool, with DNS pointed at the gateway, and named profiles capture a whole bench setup for next week, relay-agent support included. Saved profiles travel in an [Encrypted Backup](import-export.md#encrypted-backup-and-share-export) but never in Export for Sharing, and Delete All Data removes them.

## Isolation and Trust

Both run inside one isolated daemon child process — the same crash-isolation model as the serial sidecar — so closing VS Code always releases UDP 69/67.

Requires a trusted workspace.

## Engine

The daemon has two interchangeable implementations behind `nexus.networkServers.engine`. The default is the native Rust one, packaged for all six supported platforms; the bundled JavaScript daemon remains available and is still the automatic fallback if no native binary is available here, so the services start either way.

`nexus.networkServers.dhcp.allowRelayAgents` is honoured by the Rust engine only. See [Settings → Network Servers](settings.md#network-servers).

## Related settings

[Settings → Network Servers](settings.md#network-servers)

## Upgrade notes

- Since 2.8.205 the default engine is the native Rust one.

## For contributors

The wire contract between the extension host and the network server daemon is specified in [network-server-daemon-protocol.md](network-server-daemon-protocol.md), written so that either side can be built from it alone.

## See also

- [Serial](serial.md) — console access to the same lab hardware
- [Local Servers](local-servers.md) — distinct from Embedded Network Servers: Local Servers runs programs on this machine, while this page serves TFTP and DHCP to hardware on the wire
- [Settings](settings.md#network-servers)
