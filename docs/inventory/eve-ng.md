# EVE-NG Lab Sync

Add an EVE-NG server as an inventory source and its lab tree becomes connection profiles: **labs become folders, nodes become servers**, each pointed at the node's own telnet console. The password you log into EVE-NG with is kept in VS Code SecretStorage, never in a settings file; the username is stored with the source's other, non-secret settings.

## Add an EVE-NG Source

1. Run `Nexus: Add Inventory Source (NetBox, EVE-NG, Proxmox, GNS3…)`, choose **EVE-NG**, and enter the base URL of the EVE-NG web UI plus the username and password you log into it with. The password is stored in VS Code SecretStorage
2. Optionally set a **Root Folder** to scan only part of the lab tree, a **Lab Filter** (a case-insensitive substring of a lab's full path), and a **Console Host Override** for when EVE-NG sits behind NAT and reports console addresses you cannot reach
3. **Include Stopped Nodes** is on by default. Turning it off makes a stopped node look deleted to the sync, so the source's Removed-Device Policy applies to it — leave it on unless you only ever want running gear
4. If the base URL is `https://` and the server holds EVE-NG's own self-signed certificate — or you reach it by IP address and its certificate does not list that address (a certificate *can* cover an IP, so check before assuming) — tick **Allow a Self-Signed or Mismatched Certificate** under **Advanced options**. It is off by default; read the note below the list before turning it on
5. Save, then **Sync Now**. As with any source, the plan is shown before anything is applied

## Allow a Self-Signed or Mismatched Certificate

**Allow a Self-Signed or Mismatched Certificate** is the honest name for what it does: Nexus connects over HTTPS without checking the server's certificate for that one source. The traffic is still encrypted, but it is no longer *authenticated* — anything on the network path between you and the lab can intercept it, and the EVE-NG username and password are sent over that connection. It is a reasonable trade for a lab box on a network you trust, which is what EVE-NG usually is; it is not reasonable for a server reachable from outside that network. It applies to that source alone — nothing else in VS Code is affected — and it does nothing at all on an `http://` base URL, which is not encrypted in the first place. Leave it off and use a trusted certificate where you can. If you hit a certificate error before finding this, the error itself now names the option.

## How Labs and Nodes Arrive

Each lab becomes a folder under the source's Target Folder, named after the lab file, nested under whatever folders it sits in relative to the Root Folder. A node with a native telnet console arrives as a **telnet** server on the console's own port. When EVE-NG reports that console on a loopback or unspecified address (`127.0.0.1`, `0.0.0.0`, `localhost`, `::1` and the like) — the usual answer, since it is describing its own machine — Nexus substitutes the host from the base URL, and a **Console Host Override** wins over both.

## Rename Nodes Freely; Rename Labs Deliberately

A node renamed inside its lab keeps its server — the name just follows on the next sync, as with any other source. A **lab** is different: EVE-NG offers no identifier for a lab that survives a rename, so Nexus identifies a node by its lab's path plus its node id, and renaming or moving a lab makes every node in it look like a brand-new device. The servers you had are handed to the source's Removed-Device Policy — moved to `_orphaned` with the default setting — and the nodes come back as fresh servers, without the credentials, jump host or other per-server settings you had put on the old ones. Nothing is lost silently (the plan shows the removals and the adds before it applies them), but there is no way to carry those edits across: settle the lab tree first, then invest in per-server settings.

## Nodes Without a Telnet Console

Nodes with an HTML5/VNC console, and nodes that have no console address yet, are still imported — as servers with no address. The two are not the same wait, though the warning wording covers both: a **stopped** node is temporary and gets its address on the first sync after it starts (a status refresh or poll shows it running but does not fill in the address), while an **HTML5/VNC-only** node already has a working console — it simply isn't telnet, which is what Nexus speaks to a lab node — so it stays a placeholder for good, until you change that node's console type to telnet in EVE-NG. One warning line mentions them, and the sync owns it: it gives the total and, when both apply, splits it into the placeholders this sync just added and the ones that were already placeholders from an earlier sync. They are deliberately not dropped: a device missing from the tree reads as *deleted at the source*, and the source's Removed-Device Policy would act on it. What such a placeholder can and can't do is described in [Servers with no address yet](README.md#servers-with-no-address-yet).

## Sync Limits

A sync is bounded rather than open-ended, so a huge or unresponsive installation can't hang it: the crawl stops at 1,000 labs, 10,000 nodes, 12 folder levels, 2,000 folder listings, or 120 seconds — whichever comes first — and the plan's warnings name what it didn't reach. A crawl that stopped short never prunes: servers whose labs it never got to are left alone instead of being read as deleted.

## Community Edition Is the Certified Target

The client is edition-aware and works against Professional, but a Pro server adds a warning to every sync saying so: lab discovery and console mapping are validated against Community, and Pro's differences are not yet covered.

## See Which Labs Are Running, Live

Just **sync** — a completed EVE-NG sync brings every node's running/stopped state up to date, no extra step, including the stopped nodes **Include Stopped Nodes** leaves out of the sync itself. (A crawl that stopped at one of its limits updates only what it reached.) Between syncs, run **Refresh Inventory Status** from the Command Palette, or set the source's **Lab Status Poll Interval (seconds)** under **Advanced options** to poll while the Command Center is open — it is per source (`0`–`3600`, whole seconds, `0` = off), so a busy lab can poll every 30 seconds while a quiet one stays off. Read the note on EVE-NG sessions [below](#give-nexus-its-own-eve-ng-account) before turning it on. Running EVE-NG nodes get a green dot with a `(running)` tag, while stopped ones get a hollow grey dot and a `(stopped)` tag. A green ▶ rides on every running node's row and on the lab folder holding it, so an at-a-glance look at the tree tells you which labs are up. A node you are already connected to keeps its plug icon, and there the ▶ and the `(running)` tag are what carry its lab state.

## Console Ports After a Restart

EVE-NG hands out console ports dynamically, so a restarted node often lands on a new one, and a **Refresh Inventory Status** stores the new port so the next connect goes to the right place instead of a dead one. Only a port the sync owns is healed that way — a port you set by hand never is — and it is the *next* connect that uses it; a terminal already open keeps the port it connected with. (See [Synced Fields and Your Edits](README.md#synced-fields-and-your-edits) for what makes a port sync-owned.)

## Give Nexus Its Own EVE-NG Account

EVE-NG Community allows only one active session per user account — confirmed in direct testing, where every poll deauthenticated the browser session; Professional is untested in this respect. Whichever login happened most recently is the one that stays: sync or poll while you are signed in as the same user and Nexus logs you out of the EVE-NG web UI — and when you log back in, Nexus's session is the one that goes. It also shows up as an occasional mid-sync `session timed out` / HTTP 412 failure. Nexus recovers from that by logging in again once, silently, which works but evicts the browser again in turn; with polling on and a browser open the two will keep taking the session off each other. Create a second EVE-NG account for Nexus and the problem disappears. Failing that, leave **Lab Status Poll Interval** at `0` and sync when you are not using the web UI.

## Start and Stop Nodes

Right-click an EVE-NG node whose state is known and choose **Start Node** (on a stopped one) or **Stop Node** (on a running one); Nexus issues the start/stop and then re-checks the status twice — once straight away and once a few seconds later, since a node does not change state the instant its API accepts the request. A slow start can outrun both re-checks, and the row then keeps its old state until a sync, a manual **Refresh Inventory Status**, or the source's poll interval picks it up. Tested against EVE-NG Community; EVE-NG Professional support is preliminary. The mechanism is provider-general: any inventory provider that can control nodes gets the same menu — for Proxmox guests, see [Start and Stop Guests](proxmox.md#start-and-stop-guests).

A start or stop spends the source's saved credentials; see [Start and Stop Nodes](README.md#start-and-stop-nodes) for when Nexus asks before handing them over.

## See also

- [Inventory Sync](README.md) — what every source shares, including [Servers with No Address Yet](README.md#servers-with-no-address-yet)
- [GNS3](gns3.md) — the other lab emulator Nexus syncs from
- [Telnet](../ssh-and-telnet.md#telnet)
- [Device Templates](device-templates.md)
