# Nexus Terminal Documentation

One guide per feature. New here? Start with the [Quick start](../README.md#quick-start) in the main README.

## Connect

- [SSH and Telnet](ssh-and-telnet.md) — add a server, authentication and SSH keys, auth profiles, jump hosts and proxies, the alternate host, legacy devices, multiplexing, and telnet.
- [Serial Consoles](serial.md) — add a serial device, and keep a session through Windows COM-port renumbering with Smart Follow.
- [Local Shells](local-shells.md) — save local terminal profiles and open several sessions from each.

## Files & forwarding

- [File Explorer (SFTP)](file-explorer.md) — browse and transfer remote files, save root-owned files with sudo, Windows network shares, and follow the terminal's directory.
- [Port Forwarding](port-forwarding.md) — local, reverse, and dynamic SOCKS5 tunnels through an SSH server.

## Fleet & inventory

- [Connectivity Hub](connectivity-hub.md) — the sidebar tree: folders, drag and drop, profile and folder actions, Test Connection, filter, unread activity, the Settings panel, Settings Guard, starting over, and what works in the browser.
- [Inventory Sync](inventory/README.md) — what every inventory source shares: the sync plan, removing and re-adopting servers, and servers with no address yet.
  - [NetBox](inventory/netbox.md) — devices from a NetBox instance.
  - [EVE-NG](inventory/eve-ng.md) — lab nodes from an EVE-NG server, with live lab status.
  - [Proxmox VE](inventory/proxmox.md) — VMs and containers from a Proxmox cluster, with the guest's web console.
  - [GNS3](inventory/gns3.md) — project nodes from a GNS3 server.
  - [Device Templates](inventory/device-templates.md) — reusable connection settings for synced servers.
- [Import and Export](import-export.md) — import from `~/.ssh/config`, MobaXterm, SecureCRT, or a device list; encrypted backup and share export.

## Automation

- [Macros](macros.md) — reusable terminal input, variables, profile tokens, IPMI/BMC macros, keybindings, and auto-trigger.
- [Scripting](scripting.md) — JavaScript automation with an expect/send API against live sessions.

## Lab services

- [Embedded Network Servers (TFTP + DHCP)](network-servers.md) — serve firmware and hand out addresses to lab hardware.
- [Local Servers](local-servers.md) — start, stop, and restart the local processes a bench needs, with optional auto-restart.

## Terminal

- [Terminal](terminal.md) — highlighting, tab commands, session transcripts, keyboard passthrough, and appearance.

## Everything else

- [Open a Profile from the Command Line](open-from-command-line.md) — the `vscode://` URI handler, with shell alias and PowerShell examples.
- [Settings](settings.md) — the key settings, grouped by feature.

## Contributor references

- [Functional documentation](functional-documentation.md) — architecture and design detail.
- [Network server daemon protocol](network-server-daemon-protocol.md) — the wire contract between the extension host and the TFTP/DHCP daemon.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — contribution bar and review expectations.
- [Example scripts](../examples/scripts/) — runnable Nexus scripts.
