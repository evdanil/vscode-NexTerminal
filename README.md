# Nexus Terminal

A full SSH + serial + port-forwarding client inside VS Code — without Remote-SSH's 300MB server payload on the box.

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/sentriflow.vscode-nexterminal.svg?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=sentriflow.vscode-nexterminal)
[![Open VSX](https://img.shields.io/open-vsx/v/sentriflow/vscode-nexterminal?label=Open%20VSX)](https://open-vsx.org/extension/sentriflow/vscode-nexterminal)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/evgeny_danilchenko)

- **Replaces PuTTY + MobaXterm + SecureCRT + TeraTerm** — SSH, serial consoles, local shells, port forwarding, and SFTP live in one VS Code sidebar instead of four separate windows. → [Connectivity Hub](docs/connectivity-hub.md)
- **Unlike Remote-SSH, nothing is installed on the remote.** A pure client: no `vscode-server` unpacked into the target, no node process on the far end — what you need on a Cisco switch, a shell-only bastion, or a change-controlled box. → [SSH and Telnet](docs/ssh-and-telnet.md)
- **Bring your existing connections** — import profiles from your `~/.ssh/config` (keys and all), MobaXterm `.ini`, and SecureCRT XML exports, folder hierarchy preserved where the source has one. → [Import and Export](docs/import-export.md)
- **Onboard a whole rack in one paste** — a CSV export or a plain list of hostnames becomes connections in bulk; duplicates are skipped and unparsable lines reported by line number. → [Import a device list](docs/import-export.md#import-a-device-list)
- **Sync servers straight from NetBox, EVE-NG, a Proxmox cluster or a GNS3 server** — NetBox devices arrive foldered by site and rack, EVE-NG and GNS3 labs become folders of nodes on their own telnet consoles, and Proxmox VMs and containers become SSH servers; every sync shows its plan before anything is applied. → [Inventory Sync](docs/inventory/README.md)
- **Edit root-owned files without dropping to a shell** — save `/etc/*` over SFTP with `sudo`, through the file's existing inode so owner, mode, and ACLs are preserved; your sudo password goes to the SSH channel's stdin only. → [Save as Root](docs/file-explorer.md#save-as-root)

## Reaching a device two hops away

Jump hosts are set per server, and a jump host can have one of its own. Below, an access switch is reached through an NMS host, itself reached through a bastion: one connect walks the chain, authenticating each hop in turn. No `ProxyJump` stanza to hand-write. → [Jump hosts and proxies](docs/ssh-and-telnet.md#jump-hosts-and-proxies)

![Nexus Terminal setting up a two-level jump-host chain — access switch reached through an NMS host, which is itself reached through a bastion — then authenticating each hop in turn and opening a shell on the switch](media/demo-jump-host.gif)

## Who it's for

- **Network and infra engineers** on Cisco, Juniper, and embedded gear — multi-hop jump-host chaining (A → B → C) and a per-server legacy KEX/cipher toggle keep you connected to old IOS boxes that modern clients refuse.
- **Embedded and firmware developers** on serial consoles — Smart Follow rides through Windows COM-port renumbering, reconnecting only to the device you already approved instead of dropping the session.
- **Homelab and self-hosters** — one sidebar for every box, tunnel, and serial cable, with expect/send auto-trigger macros and a JavaScript scripting engine for repeatable tasks.
- **VSCodium and Open VSX users** — full SSH that Remote-SSH (proprietary, Marketplace-only) can't give you, plus 2FA keyboard-interactive auth and encrypted config backup.

## Install

- **VS Code Marketplace** — open the Extensions view (`Ctrl+Shift+X`), search **Nexus Terminal**, and click **Install**. [Listing](https://marketplace.visualstudio.com/items?itemName=sentriflow.vscode-nexterminal)
- **Open VSX** (VSCodium, Eclipse Theia, Gitpod) — search **Nexus Terminal** in the Extensions view and click **Install**. [Listing](https://open-vsx.org/extension/sentriflow/vscode-nexterminal)
- **VSIX** — download the `.vsix` from [GitHub Releases](https://github.com/evdanil/vscode-NexTerminal/releases), then `Extensions` > `...` > `Install from VSIX...`.

Then open the **Nexus** sidebar (activity bar icon).

**Requires VS Code 1.105 or newer** (or an Open VSX-compatible editor built on that API level). Older hosts are not offered the extension by the Marketplace, and installing the VSIX by hand on one is refused.

## Quick start

1. Open the **Nexus** sidebar and create a profile with `Nexus: Add Profile`, `Nexus: Add Network Device Profile (SSH / Telnet)`, `Nexus: Add Serial Profile`, or `Nexus: Add Local Shell Profile` — or sync your whole device inventory in one go with `Nexus: Add Inventory Source (NetBox, EVE-NG, Proxmox, GNS3…)`. See [SSH and Telnet](docs/ssh-and-telnet.md#add-a-server), [Serial Consoles](docs/serial.md#add-a-serial-device), [Local Shells](docs/local-shells.md#add-a-local-shell-profile), [Inventory Sync](docs/inventory/README.md).
2. Select **Connect** / **Open Local Shell** on the profile to open an SSH, telnet, Serial, or Local Shell terminal. See [Terminal](docs/terminal.md).
3. For SSH profiles, open **File Explorer** and run **Browse Files** to choose the connected profile and browse SFTP files. See [File Explorer](docs/file-explorer.md#browse-remote-files).
4. Open **Port Forwarding**, add a tunnel with `Nexus: Add Tunnel`, assign an SSH server, then select **Start**. See [Port Forwarding](docs/port-forwarding.md#set-up-a-tunnel).
5. Create repeatable terminal input with `Nexus: Add Blank Macro` or **Add Macro From Template**; create longer automation with `Nexus: New Nexus Script`. See [Macros](docs/macros.md#quick-start-your-first-macro), [Scripting](docs/scripting.md#quickstart).
6. Open **Settings** and use **Backup…** to save a password-protected backup, or **Export for Sharing…** to create a sanitized export without secrets. See [Import and Export](docs/import-export.md#encrypted-backup-and-share-export).

## Features

### Connect

- **SSH sessions** — password, private key, SSH agent, and 2FA keyboard-interactive auth, with silent re-auth from VS Code SecretStorage. → [Authentication](docs/ssh-and-telnet.md#authentication)
- **Legacy devices** — a per-server legacy-algorithm toggle for older gear, including devices that only speak 1024-bit `diffie-hellman-group1-sha1`. → [Legacy Devices](docs/ssh-and-telnet.md#legacy-devices)
- **Alternate host** — a second SSH address for a server (e.g. the IPv6 to its IPv4), retried once when the primary can't be reached at the connection level; NetBox and Proxmox syncs fill it from the device's other address family. → [Alternate Host](docs/ssh-and-telnet.md#alternate-host)
- **SSH key deployment** — right-click a server → **Deploy SSH Key** to find or generate a key and install it in the remote `authorized_keys`. → [Deploy an SSH Key](docs/ssh-and-telnet.md#deploy-an-ssh-key)
- **Host key verification** — trust-on-first-use, with an alert when a host key changes. → [Host Key Verification](docs/ssh-and-telnet.md#host-key-verification)
- **Auth profiles** — reusable credential sets applied to single servers or whole folders; edit one and every linked server follows. → [Auth Profiles](docs/ssh-and-telnet.md#auth-profiles)
- **Jump hosts and proxies** — SSH jump-host chains, SOCKS5, and HTTP CONNECT, set per server. → [Jump Hosts and Proxies](docs/ssh-and-telnet.md#jump-hosts-and-proxies)
- **Connection multiplexing** — terminals, tunnels, and SFTP to one server share an SSH connection, with a per-server opt-out. → [Connection Multiplexing](docs/ssh-and-telnet.md#connection-multiplexing)
- **Dropped-session diagnostics** — faults after a session is up are recorded in the **Nexus SSH** output channel, so a dropped terminal leaves a cause behind. → [When a Session Drops](docs/ssh-and-telnet.md#when-a-session-drops)
- **Telnet** — a per-server protocol switch for console servers, lab consoles, and gear that offers nothing else. → [Telnet](docs/ssh-and-telnet.md#telnet)
- **Serial consoles** — COM/ttyUSB ports with full line settings, a port scan, and break signal, in an isolated sidecar process. → [Serial Consoles](docs/serial.md)
- **Smart Follow** — a serial session rides through Windows COM-port renumbering, reconnecting only to the device you approved. → [Smart Follow](docs/serial.md#smart-follow)
- **Local shells** — saved local terminal profiles (a VS Code terminal profile or a custom shell), several sessions per profile. → [Local Shells](docs/local-shells.md)

### Files & forwarding

- **SFTP File Explorer** — browse, upload, download, and drag-and-drop files on connected servers, every transfer size-checked; one SSH profile can open it on connect. → [File Explorer](docs/file-explorer.md)
- **Save as root** — save root-owned files with `sudo` when the SSH user can't write them. → [Save as Root](docs/file-explorer.md#save-as-root)
- **Windows network shares** — transfers to and from `\\server\share` paths; a host VS Code blocks fails with the real reason and an **Allow Host…** offer. → [Windows Network Shares](docs/file-explorer.md#windows-network-shares)
- **Directory Sync** — the File Explorer follows your SSH terminal's current directory on shells that announce it; Nexus never types anything into the session. → [Directory Sync](docs/file-explorer.md#directory-sync)
- **Port forwarding** — Local (-L), Reverse (-R), and Dynamic SOCKS5 (-D) tunnels with auto-start/stop, live traffic counters, and a browser shortcut; drop a tunnel on a server to start it. → [Port Forwarding](docs/port-forwarding.md)

### Fleet & inventory

- **Connectivity Hub** — one sidebar tree of servers, serial devices, local shells, and local servers in nested folders, with a filter and drag and drop. → [Connectivity Hub](docs/connectivity-hub.md)
- **Profile actions** — click a profile for Connect, **Test Connection**, Connect and Run Script, Duplicate, Copy Connection Info, and more; right-click a folder to connect or disconnect the servers in it. → [Profile Actions](docs/connectivity-hub.md#profile-actions)
- **Unread activity** — SSH and serial sessions with output you haven't seen are marked in the tree and with `●` on the tab. → [Unread Activity](docs/connectivity-hub.md#unread-activity)
- **Inventory sources** — add and manage sources from one command or **Settings → Inventory Sources**, with reusable saved filters and a per-source opt-in for self-signed certificates. → [Add a Source](docs/inventory/README.md#add-a-source)
- **NetBox sync** — devices become server profiles under a folder template, narrowed by any device filter; out-of-band IPs fill the BMC host. → [NetBox](docs/inventory/netbox.md)
- **EVE-NG sync** — labs become folders and nodes become telnet servers on their own consoles. → [EVE-NG](docs/inventory/eve-ng.md)
- **Proxmox VE sync** — VMs and containers become SSH servers foldered by node, pool, type, or tag; cluster nodes can come across too. → [Proxmox VE](docs/inventory/proxmox.md)
- **GNS3 sync** — projects become folders and nodes become telnet servers, closed projects included. → [GNS3](docs/inventory/gns3.md)
- **Sync plan preview** — every sync shows what it will add, update, move, or remove before anything is applied. → [Every Sync Shows Its Plan First](docs/inventory/README.md#every-sync-shows-its-plan-first)
- **Re-sync** — renames and moves at the source follow, a vanished device is orphaned, deleted, or kept per source, and a source's folder can carry a one-click sync icon. → [Keep a Source in Sync](docs/inventory/README.md#keep-a-source-in-sync)
- **Remove and re-adopt** — removing a source can keep its servers, and adding that source back offers to re-adopt them instead of duplicating them. → [Remove a Source and Re-Adopt Its Servers](docs/inventory/README.md#remove-a-source-and-re-adopt-its-servers)
- **Live status** — running nodes and guests light up in the tree after a sync, on **Refresh Inventory Status**, or on a per-source poll. → [EVE-NG](docs/inventory/eve-ng.md#see-which-labs-are-running-live), [Proxmox VE](docs/inventory/proxmox.md#see-which-guests-are-running-live), [GNS3](docs/inventory/gns3.md#closed-projects-come-across-too)
- **Start and stop nodes** — **Start Node** / **Stop Node** on a lab node's or guest's right-click menu. → [Start and Stop Nodes](docs/inventory/README.md#start-and-stop-nodes)
- **Proxmox web console** — **Open Web Console** opens a guest's console in your browser, with no guest address needed. → [Open the Guest Console](docs/inventory/proxmox.md#open-the-guest-console-in-your-browser)
- **Servers with no address yet** — a device the source has no address for still arrives, as a placeholder row that says why it can't connect. → [Servers with No Address Yet](docs/inventory/README.md#servers-with-no-address-yet)
- **Device templates** — reusable bundles of connection settings applied to the servers a sync creates, or to a folder on demand. → [Device Templates](docs/inventory/device-templates.md)
- **Import from an SSH config** — `~/.ssh/config` hosts arrive with their `IdentityFile` keys, `Include`s followed; offered once on first run when you have one. → [Import from an SSH Config](docs/import-export.md#import-from-an-ssh-config)
- **Import from MobaXterm or SecureCRT** — SSH sessions arrive with their folder hierarchy. → [Import from MobaXterm or SecureCRT](docs/import-export.md#import-from-mobaxterm-or-securecrt)
- **Import a device list** — paste or load a CSV or host list, confirmed in one summary before anything is written. → [Import a Device List](docs/import-export.md#import-a-device-list)

### Automation

- **Terminal macros** — reusable text sent with one click, a keybinding (108 combinations), or the `Alt+S` picker, written in the Macro Editor or started from a template. See the [macro guide](docs/macros.md) for step-by-step setup, trigger scopes, cooldowns, intervals, and regex examples.
- **Secret macros** — text kept in VS Code SecretStorage, with **Copy Value** / **Paste Value** in the Macros view. → [Secret Macros](docs/macros.md#secret-macros)
- **Auto-trigger (expect/send)** — a macro fires when terminal output matches its regex, scopable to the active terminal or a matching profile, with cooldowns, polling intervals, and pause/resume. → [Auto-Trigger Basics](docs/macros.md#auto-trigger-basics)
- **Macro variables** — prompt for values each run with `$name` / `${name}`. → [Variables](docs/macros.md#variables)
- **Server profile tokens & IPMI/BMC macros** — `${profile.host}`, `${profile.ipmiHost}` and friends, resolved by **Run Macro on Server…**; a macro can run in the session, a local terminal, or the browser. → [Profile tokens](docs/macros.md#profile-tokens)
- **BMC access without typing a password** — an IPMI Auth Profile can hand `ipmitool -E` its password through the environment, never the command line. → [Providing IPMI credentials](docs/macros.md#providing-ipmi-credentials)
- **One-click BMC actions** — **Connect BMC Serial Console** and **Open BMC Web Console** on a server's right-click menu. → [One-click BMC actions](docs/macros.md#one-click-bmc-actions)
- **Scripts** — JavaScript automation with an async expect/send API against any SSH, telnet, Serial, or Local Shell session, each run in an isolated worker with that session's macros suspended by default. → [Scripting guide](docs/scripting.md)
- **Running scripts** — from the Scripts view, the **▶ Run in Nexus** CodeLens, or **Connect and Run Script…** on a profile; runnable examples included. → [Commands and views](docs/scripting.md#commands-and-views)
- **Fix Macro Keybindings** — one command corrects the VS Code settings that let the terminal or the menu bar swallow macro shortcuts. → [Keybindings](docs/macros.md#keybindings)
- **Folders for macros and scripts** — both views group their contents into folders, like the Connectivity Hub. → [Macros](docs/macros.md#organising-macros-into-folders), [Scripts](docs/scripting.md#organising-scripts-into-folders)

### Lab services

- **TFTP server** — read-only until you opt into uploads, sandboxed to its root, with live transfer progress. → [TFTP](docs/network-servers.md#tftp)
- **DHCP server** — full DORA with reservations, leases that survive a restart, and ZTP boot options; a Network (CIDR) row fills in a whole subnet. → [DHCP](docs/network-servers.md#dhcp)
- **Bench profiles** — Quick Settings and named profiles capture a whole TFTP/DHCP setup; both services run in one isolated daemon. → [Quick Settings and Profiles](docs/network-servers.md#quick-settings-and-profiles)
- **NIC and pool check** — the Network Servers view, Quick Settings and the full form warn when DHCP's bound NIC is not on the pool's subnet, and offer the one NIC that is. → [When the NIC and the Pool Disagree](docs/network-servers.md#when-the-nic-and-the-pool-disagree)
- **Engine choice** — a native Rust daemon by default, with the bundled JavaScript one selectable and taking over automatically where no native binary is available. → [Engine](docs/network-servers.md#engine)
- **Local servers** — start, stop, and restart the local processes a bench needs from the Connectivity Hub, with optional auto-restart. → [Local Servers](docs/local-servers.md)

### Terminal

- **Highlighting** — regex rules colour errors, warnings, addresses, and more, edited in a visual Rule Editor. → [Highlighting](docs/terminal.md#highlighting)
- **Tab commands** — right-click a Nexus terminal tab for Reset Terminal, Clear Scrollback, and Copy All to Clipboard. → [Tab Commands](docs/terminal.md#tab-commands)
- **Session transcripts** — clean, ANSI-stripped output of SSH, telnet, and serial sessions logged to rotating files, per profile; **Open Log Directory** opens them. → [Session Transcript Logging](docs/terminal.md#session-transcript-logging)
- **Keyboard passthrough** — `Ctrl+` combinations go straight to vim, nano, or htop, configurable per key. → [Keyboard Passthrough](docs/terminal.md#keyboard-passthrough)
- **Appearance** — terminal font and colour schemes, including schemes imported from MobaXterm. → [Appearance](docs/terminal.md#appearance)

### Everything else

- **Settings panel** — edit settings in a grouped panel with validation and auto-save; key settings are listed in the [settings reference](docs/settings.md). → [Settings Panel](docs/connectivity-hub.md#settings-panel)
- **Settings Guard** — restores the `terminal.integrated.commandsToSkipShell` entries macro shortcuts need when an external program (e.g. a corporate DLP/endpoint agent) strips them, with Undo and **Nexus: Show Settings Guard Report**. → [Settings Guard](docs/connectivity-hub.md#settings-guard)
- **Encrypted backup and share export** — a master-password-protected backup, or a sanitized export (credentials stripped, IDs remapped) to share; a hand-written JSON file imports too. → [Encrypted Backup and Share Export](docs/import-export.md#encrypted-backup-and-share-export)
- **Start over** — **Nexus: Reset All Settings to Defaults** resets settings, and **Nexus: Delete All Data** deletes your connection profiles, tunnels, inventory sources, macros, and saved credentials after a typed confirmation. → [Start Over](docs/connectivity-hub.md#start-over)
- **Open from the command line** — a `vscode://` URI opens a saved network device (SSH or telnet), Serial, or Local Shell profile from a terminal, script, or link. → [Open a Profile from the Command Line](docs/open-from-command-line.md)
- **In the browser** — browser-based VS Code gets graceful degradation only: SSH and serial features require the desktop runtime. → [In the Browser](docs/connectivity-hub.md#in-the-browser)

## Documentation

Every feature has its own guide — start at the [documentation index](docs/README.md).

For contributors: [functional documentation](docs/functional-documentation.md) (architecture and design), the [network server daemon protocol](docs/network-server-daemon-protocol.md) (the wire contract between the extension host and the daemon), and [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```bash
npm install
npm run build
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution bar, tests, and packaging.

## Support

Nexus Terminal is free and open source. If it saves you time, you can say thanks with a coffee — it's appreciated but never expected, and every feature stays free regardless.

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/evgeny_danilchenko)

- **Found a bug or have a feature request?** Open an issue: https://github.com/evdanil/vscode-NexTerminal/issues

## Contact

Evgeny D. — [evgeny@netsectech.com.au](mailto:evgeny@netsectech.com.au)

## License

[Apache 2.0](LICENSE)
