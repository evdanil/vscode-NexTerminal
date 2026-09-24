# Connectivity Hub

The Connectivity Hub is the sidebar tree view showing all servers, serial devices, local shell profiles, and local servers, organized into nested folders. It is where you add, connect, and organize your profiles.

## Folders and Drag and Drop

Drag a server, serial, Local Shell or Local Server profile — or a whole folder — onto another folder, or onto empty space for the top level, to move it there. There is no manual ordering: a folder lists its subfolders first, then its profiles, each in name order. Dropping a tunnel profile onto a server starts that tunnel through the server immediately — it does not change the tunnel's saved server (see [Port Forwarding](port-forwarding.md)).

[Auth profiles](ssh-and-telnet.md#auth-profiles) can be applied to individual servers or entire folders in bulk.

## Profile Actions

Click a profile in the Hub to open its **Profile Actions** list — the everyday actions for that profile in one pick. What it offers depends on the profile:

- **Server (SSH or telnet)** — Connect, Test Connection, Connect and Run Script, Run Macro on Server…, Edit, Duplicate, Copy Connection Info and Delete. **Browse Files** joins them while the server is connected; a synced lab node or guest whose source can power it adds **Start Node** or **Stop Node** to match its state (see [Start and Stop Nodes](inventory/README.md#start-and-stop-nodes)); a Proxmox guest adds **Open Web Console**.
- **Serial profile** — Connect, Test Connection, Connect and Run Script, Edit, Duplicate, Copy Port Info and Delete.
- **Local Shell profile** — Open Local Shell, Open and Run Script, Edit, Duplicate, Copy Shell Info and Delete.
- **Local Server** (the list is titled **Local Server Actions**) — Start, Stop, Restart, Inspect Logs, Edit, Duplicate, Copy Command Line and Delete.

The right-click menu has the less frequent ones too — Disconnect, Rename, Deploy SSH Key, Apply Auth Profile, and the BMC actions on a server with a BMC address.

### Test Connection

**Test Connection** checks a profile without opening a terminal. It is also an icon on a server or serial row that isn't connected, and a button on the **Add Profile** form, so you can check the details before saving.

- On a **server** it opens an SSH connection, authenticating exactly as Connect would (so it can ask for a password), and reports success — or names what failed: authentication, the host key, the private key, a name that won't resolve, a timeout, a refused or unreachable host, or the proxy. **Copy Details** puts the full diagnosis on the clipboard. On a server already connected with [multiplexing](ssh-and-telnet.md#connection-multiplexing) on, it reuses that connection instead of opening a second one, so it reports on the session you already have. It does not try the [Alternate host](ssh-and-telnet.md#alternate-host), and on a telnet server it explains that the test is SSH-only instead.
- On a **serial profile** it checks that the saved port is present, without opening it — and, for a [Smart Follow](serial.md#smart-follow) profile, whether a device matching the one you approved is attached. When nothing is found it offers **Scan Serial Ports**.

### Folder Actions

Right-click a folder that holds servers for **Connect Folder Servers** and **Disconnect Folder Servers** (also icons on the folder row). They act on the servers directly in that folder — not those in its subfolders, and not its serial, Local Shell or Local Server profiles. A server its inventory source has no address for yet is skipped, and one notice counts them.

The same menu renames the folder, adds a subfolder or a profile inside it, applies an auth profile or device template to every server in it and its subfolders, and removes it — asking whether to move its contents to the parent folder or delete them. A folder an inventory source syncs into also has **Sync Inventory Now**.

## Filter

Built-in filter to quickly search by name — servers also match on host, local servers on executable; when a filter matches nothing, the Hub says "No matches found" instead of showing the first-run onboarding.

## Unread Activity

Active SSH and serial sessions highlight unread terminal activity in the tree and prepend `●` to the terminal tab title until you focus that terminal again.

## Settings Panel

View and edit extension settings in a dedicated webview panel with grouped categories, terminal-adjacent actions, validation, and host-confirmed auto-save. The key settings are described in the [settings reference](settings.md).

## Settings Guard

Some corporate endpoint and DLP agents rewrite VS Code's `settings.json` and strip entries they don't recognise. When they strip the `terminal.integrated.commandsToSkipShell` entries that let [macro keyboard shortcuts](macros.md#keybindings) reach Nexus instead of the shell, Settings Guard puts them back — when Nexus starts (catching damage done while VS Code was closed) and whenever settings change. It guards that list only while you have macros. If the list was emptied or deleted outright, it restores the last good copy, your own entries included; if only the Nexus entries went missing, it adds just those back. A corrupted `nexus.terminal.passthroughKeys` or highlighting-rules value is repaired the same way — from its last good copy, or by falling back to the default.

Each repair shows a notification with **Disable Guard** and **Show Report**, plus **Undo** when it restored the shortcut list. If something keeps rewriting the file — three repairs within ten minutes, or twelve in one session — auto-repair pauses and offers **Resume Guard**.

Every outside change to those settings — and to `terminal.integrated.sendKeybindingsToShell` and `window.enableMenuBarMnemonics`, which it logs but never changes — is recorded in the **Nexus Settings Guard** output channel, even with the guard turned off; **Nexus: Show Settings Guard Report** prints that log with the current values. Turn the guard off with **Settings Guard** under *Nexus Settings → Terminal* (`nexus.settingsGuard.enabled`).

## Start Over

- **Nexus: Reset All Settings to Defaults** — also **Reset All to Defaults** in the Settings panel and under **Data Management** in the Settings view — asks once, then returns every setting the Settings panel shows, and your highlighting rules, to its default in your user settings. Profiles, macros and everything else stay. Each Settings panel category also has its own **Reset to Defaults**.
- **Nexus: Delete All Data** — also **Delete All Data…** in the Settings panel's Danger Zone and under **Data Management** — permanently deletes your servers, tunnels, serial, Local Shell and Local Server profiles, saved TFTP/DHCP profiles, auth profiles, folders, inventory sources, device templates, saved filters and macros, with every password, passphrase and token Nexus saved for them, and resets settings to their defaults. It asks twice: a warning you confirm with **Delete Everything**, then a box where you type `DELETE`. Once you confirm, the TFTP and DHCP services are stopped before anything is deleted, and each running Local Server is stopped just before its profile is removed. It leaves trusted SSH host keys, your script files and session logs in place. Take an [Encrypted Backup](import-export.md#encrypted-backup-and-share-export) first if you might want any of it back.

## In the Browser

Graceful degradation in browser-based VS Code (SSH/serial features require desktop runtime).

## Related settings

Connection details beside items in the tree: [settings.md#connectivity-hub](settings.md#connectivity-hub).

## See also

- [SSH and Telnet](ssh-and-telnet.md) — servers
- [Serial Consoles](serial.md) — serial profiles
- [Local Shells](local-shells.md) — local shell profiles
- [Local Servers](local-servers.md) — local processes you start, stop and restart from the Hub
- [Inventory Sync](inventory/README.md) — servers created and kept current from NetBox, EVE-NG, Proxmox or GNS3
- [Port Forwarding](port-forwarding.md) — tunnels you can drop onto a server
