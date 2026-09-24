# GNS3 Sync

Point an inventory source at a GNS3 server and its projects become folders and its nodes become servers on their own telnet consoles — closed projects included, since that is how most projects sit most of the time.

## Add a GNS3 Source

1. Run `Nexus: Add Inventory Source (NetBox, EVE-NG, Proxmox, GNS3…)`, choose **GNS3**, and enter the server URL. A stock GNS3 server answers on plain HTTP at port 3080, so `http://gns3.example.com:3080` is the usual shape — keep the port, and include the scheme
2. Fill in **Username** and **Password** if your server needs them. GNS3 2.2 ships with HTTP authentication **off**, so both are optional there; GNS3 3.x always requires them. Nexus works out which generation it is talking to when it connects, so there is nothing to select. The password is stored in VS Code SecretStorage; on 3.x the login token it exchanges for is kept in memory for the session only and never written to disk
3. Narrow what comes across with **Project Filter** — a case-insensitive substring of the project name, with the same **Saved Filter** picker NetBox and EVE-NG sources have (see [Saved filters](README.md#add-a-source)). Leave it empty to import every project
4. If the consoles are reached through NAT or a port forward, set **Console Host Override** to the address you actually connect to. Without it, Nexus uses the host from the server URL, which is right for a direct connection
5. If your server is behind HTTPS with a certificate your machine does not trust, tick **Allow a Self-Signed or Mismatched Certificate** under **Advanced options** — the same option the other providers have, doing the same thing, and doing nothing at all on an `http://` URL

## Closed Projects Come Across Too

A GNS3 server will list the nodes of a project that is not open, and since most projects sit closed most of the time, skipping them would leave you with almost nothing. Their nodes arrive stopped, addressed from the project's saved topology. GNS3 reassigns console ports when a project is opened, so that saved port can be out of date — sync again once the project is open and the live port replaces it. **Refresh Inventory Status** from the Command Palette, or turning on **Node Status Poll Interval (seconds)** under **Advanced options**, keeps a running node's port current without a full sync — as on EVE-NG, only a port the sync owns is updated, and it is the next connect that uses it (see [Console Ports After a Restart](eve-ng.md#console-ports-after-a-restart)).

## Nexus Will Not Open a Project for You

**Nexus will not open a project for you, and that is deliberate.** Opening one can start every node in the lab, rewrites the project file on disk, reassigns console ports, and tells every other connected GNS3 client that it opened. So the sync only ever reads, and **Start Node** on a node in a closed project refuses and tells you to open the project in GNS3 first, rather than doing it on your behalf. Start/Stop stays visible on those nodes rather than quietly disappearing — whether a project is open changes outside Nexus, and a missing menu would not explain itself.

## How Projects and Nodes Arrive

Nodes whose console is not telnet — VNC or SPICE consoles, cloud and switch nodes with no console at all — arrive as placeholders with no address, described in [Servers with no address yet](README.md#servers-with-no-address-yet), rather than as servers pointed at a port that will not answer. Each project becomes one folder; a node's identity is its project and node id, so renaming a project or a node follows on the next sync instead of re-creating the server.

## Sync Limits

A sync is bounded rather than open-ended, so a huge or slow server can't hang it: the crawl stops at 1,000 projects (counted after the **Project Filter**), 10,000 nodes, or 120 seconds — whichever comes first — and the plan's warnings name what it didn't reach, with narrowing the **Project Filter** as the remedy. A crawl that stopped short never prunes: servers whose projects it never got to are left alone instead of being read as deleted. The same holds when a project is deleted while the crawl is running — the sync skips it with a warning and prunes nothing that time.

## See also

- [Inventory Sync](README.md) — what every source shares, including [Start and Stop Nodes](README.md#start-and-stop-nodes)
- [EVE-NG](eve-ng.md) — the other lab emulator Nexus syncs from
- [Telnet](../ssh-and-telnet.md#telnet)
- [Device Templates](device-templates.md)
