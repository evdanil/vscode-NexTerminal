# Proxmox VE Sync

A Proxmox VE cluster is an inventory source too, and the shape is the same: **guests become servers** — each QEMU virtual machine and LXC container the cluster lists arrives as an SSH server, addressed from what the guest itself reports.

## Add a Proxmox Source

1. Run `Nexus: Add Inventory Source (NetBox, EVE-NG, Proxmox, GNS3…)`, choose **Proxmox**, and enter the cluster's base URL — what you open the web UI at, `https://pve.example.com:8006` shaped. Keep the port: PVE serves its API on 8006, and a URL without one sends every request to 443, where nothing answers. Omit the port only when a reverse proxy fronts the cluster on 443 — a mount path in the URL is fine and is kept. For **API Token**, enter the FULL credential as ONE string in Proxmox's own form — id, `=`, then the secret PVE shows you exactly once at creation:

    ```
    <user@realm>!<tokenid>=<secret>        e.g.  root@pam!nexus=8c1a4bb2-3d7f-4c22-9a51-e0f2b6c1d990
    ```

   The token is stored in VS Code SecretStorage, never in a settings file. **Test Connection** confirms the URL is reachable and the token is accepted — it does not check what the token may read, so a token PVE accepts but has granted nothing passes here and then syncs no guests at all, because PVE leaves out of its listing every guest the token may not see
2. Create the token least-privilege, on the PVE host. Nexus needs three privileges on `/vms`, and each buys one thing: **VM.Audit** lists the guests, reads each guest's config for its NIC addresses, and answers container addresses; **VM.PowerMgmt** is Start/Stop; **VM.GuestAgent.Audit** on PVE 9 — **VM.Monitor** on PVE 8 — is what makes VM addresses readable, because it talks to the guest agent, which must be installed and running inside the VM. Put exactly those in a role of your own. PVE's built-in `PVEVMUser` is not a substitute: it also grants console access, backups and CD-ROM/cloud-init changes, on PVE 9 it lets the token read and write files inside every VM through the guest agent, and on PVE 8 it lacks VM.Monitor, so every VM would import with no address.

   ```bash
   pveum user add nexus@pve
   pveum role add NexusSync -privs "VM.Audit VM.PowerMgmt VM.GuestAgent.Audit"
   pveum acl modify /vms -user nexus@pve -role NexusSync
   pveum user token add nexus@pve nexus -privsep 1
   pveum acl modify /vms -token 'nexus@pve!nexus' -role NexusSync
   ```

   That is PVE 9. On PVE 8, create the role with VM.Monitor in place of VM.GuestAgent.Audit — `pveum role add NexusSync -privs "VM.Audit VM.PowerMgmt VM.Monitor"` — and run the rest unchanged; each version rejects the other's privilege name. Know what VM.Monitor grants first: on PVE 8 it also lets the token run commands and read or write files inside a VM through its guest agent, so leave it out if you can do without VM addresses — every VM then imports as a placeholder with no address, exactly as if its guest agent were not running. PVE 9 replaced VM.Monitor with the separate VM.GuestAgent.* privileges, so when you upgrade the cluster, change the role to the PVE 9 list (`pveum role modify NexusSync -privs "VM.Audit VM.PowerMgmt VM.GuestAgent.Audit"`); the `pve8to9` checklist names every role that still carries VM.Monitor.

   The user gets the role as well as the token because a `-privsep 1` token can never do more than its user can — PVE intersects the two, so a token whose user holds nothing can do nothing, however much the token itself is granted. Anything you add later goes to both.

   **Sys.Audit** is only needed for cluster-node import (see [Include Cluster Nodes](#include-cluster-nodes)), and it goes on the root path `/`, not `/vms` — the cluster status endpoint checks it there, so a grant on `/vms` does not satisfy it:

   ```bash
   pveum role add NexusNodes -privs Sys.Audit
   pveum acl modify / -user nexus@pve -role NexusNodes -propagate 0
   pveum acl modify / -token 'nexus@pve!nexus' -role NexusNodes -propagate 0
   ```

   `-propagate 0` keeps the grant on `/` itself instead of letting it flow down to every node, storage and guest — on PVE 9, Sys.Audit on a VM also opens the informational commands of its QEMU monitor
3. Shape the tree with a **Folder Template** — `{node}` by default, so guests land under the PVE node that runs them. `{pool}`, `{type}` and `{tag}` are also available, and a guest carrying several tags syncs under the alphabetically first one. A guest with no pool or tags simply lands higher up
4. Pick a **Primary IP Family** — Automatic takes the first address the guest reports; Prefer IPv4 / Prefer IPv6 choose the family, falling back to the other when the guest has none in the preferred one. When the chosen network card carries both families, the other one fills **Alternate host** automatically, exactly as from NetBox (see [Primary IP Family and Alternate Host](netbox.md#primary-ip-family-and-alternate-host) and [Alternate Host](../ssh-and-telnet.md#alternate-host))
5. **Include Stopped Guests** is on by default. A stopped guest imports as a placeholder with no address — it cannot answer — and gains one on the sync after it starts; turning the toggle off makes a stopped guest look deleted, so the source's Removed-Device Policy applies to it
6. If the cluster answers with a certificate your machine does not trust — a stock PVE host issues one from the cluster's own CA — tick **Allow a Self-Signed or Mismatched Certificate** under **Advanced options**. It is the same option NetBox and EVE-NG sources have, doing the same thing: Nexus connects over HTTPS without checking the certificate for that one source. The traffic is still encrypted, but it is no longer *authenticated* — anything on the network path can intercept it, and **your Proxmox API token** is sent over that connection on every request. It is off by default, every sync that actually ran with it says so in its plan, and it does nothing at all on an `http://` base URL

## Guests Without an Address

A VM whose guest agent is not running — the common case, since nothing installs the agent for you — arrives as a server with no address and gains one on a later sync once the agent answers; the same is true of any guest the address crawl did not reach, because lookups are bounded at 1,000 guests or 120 seconds per sync. The crawl bounds address resolution, not the device listing itself — a sync whose crawl stopped short still knows every guest in the cluster, so pruning runs normally, and a warning names the budget that stopped. Both cases are the addressless placeholder described in [Servers with no address yet](README.md#servers-with-no-address-yet).

## Very Large Clusters

**Very large clusters have one number to raise.** **Hard Cap (entries)** under **Advanced options** bounds both halves of a sync at once: how many devices it imports, and how many running/stopped states it collects (guests, plus the cluster nodes when node import is on). It is 10,000 by default and accepts 100 to 1,000,000; leave it alone and nothing changes. Past the cap, guests are left out of the sync — the plan says so, and nothing is pruned, because a capped listing must never be read as *these guests are gone* — and the status the sync carries is merged with what is already on the tree instead of replacing it, so no guest beyond the cap loses its decoration to a collection that never reached it.

## Include Cluster Nodes

Tick **Include Cluster Nodes** under **Advanced options** to import the cluster's nodes as servers too, at the source's Target Folder root. This is where **Sys.Audit** earns its keep: the guest listing identifies nodes by name but carries no node addresses or running state — those come from a second call to the cluster's status endpoint — so without that privilege on the root path `/` the nodes arrive without addresses or running state, and without the toggle the nodes do not arrive at all. A guest's identity is its vmid — unique across the whole cluster, stable across renames and node migration — so renaming or migrating a guest keeps its server.

## See Which Guests Are Running, Live

Just **sync** — a completed Proxmox sync brings every guest's running/stopped state up to date by itself, no extra step, exactly as an EVE-NG sync does: the listing the sync reads already carries each guest's state, so the sync hands it back as it builds the tree. (Three things can leave one sync's picture partial, and the sync plan names each: a listing cut short by the hard cap, a status collection that ran out of that same budget, and a cluster-node status join that failed — a token without **Sys.Audit** on `/` is the usual reason. In each case the sync updates only what it reached, and whatever it did not reach keeps the state it already had.) Between syncs, **Refresh Inventory Status** from the Command Palette — or another **Sync Now** — brings the state up to date on demand, or set the source's **Status Poll Interval (seconds)** under **Advanced options** to poll while the Command Center is open (`0`–`3600`, whole seconds, `0` = off) — the field is the shared EVE-NG machinery with EVE-NG's "Lab" dropped, since a PVE cluster is not a lab, and there is no EVE-NG-style caveat to go with it: a PVE API token is stateless, so a poll costs nothing but its requests and cannot log you out of anything. Running guests get the green dot, stopped ones the hollow grey.

## Start and Stop Guests

**Start/Stop is async, like PVE itself.** Right-click a guest whose state is known — after a sync or with the poll on — and choose **Start Node** (on a stopped one) or **Stop Node** (on a running one), the same tree entries an EVE-NG lab node gets. A start or stop is issued to PVE, which answers immediately with a task id; Nexus polls that task — up to two minutes — and surfaces the task's own verdict, success or PVE's own message ("VM 105 already running"). A stop that is still running when the two minutes are up is reported honestly: the task keeps going on the PVE node, and the message names its task log. Start/Stop is offered for **guests only**: imported cluster nodes keep their running/stopped decoration — the green or hollow dot and its `(running)`/`(stopped)` suffix, where `(stopped)` on a node means PVE reports it offline — but carry no Start/Stop menu, because Nexus cannot power-cycle a hypervisor node. A template is never status-reported at all — a template cannot run, and a known status on its row would light a Start/Stop menu PVE refuses to serve. Its vmid is instead explicitly cleared on every poll — and on every sync too, by the status report the sync attaches to its tree — so a guest you converted into a template loses the stale running dot it carried before conversion, even on a partial (merging) report, without needing a separate status refresh first. A guest PVE lists but cannot describe yet — its row reads `unknown` before RRD data exists — is cleared the same way on both paths, so a stale running/stopped highlight (and its Start/Stop menu) cannot survive on a partial report either.

A start or stop spends the source's saved credentials; see [Start and Stop Nodes](README.md#start-and-stop-nodes) for when Nexus asks before handing them over.

## Guests Converted to Templates

**Converting a guest to a template retires its server, and the plan says which.** A template is not a syncable guest, so the server stops matching a device and the source's **Removed-Device Policy** applies to it — orphaned by default, deleted or kept per the source. The sync's confirmation names the conversion (*"web-template" is still at the source — it was not synced because it is now a template.*), so a server leaving because you converted its guest is no longer indistinguishable from one leaving because the guest was deleted. Turning **Include Templates** on keeps templates in the device set instead — as long as **Include Stopped Guests** is also on, since a template reports as stopped and the stopped gate would otherwise drop it anyway. A template dropped that way is still pruned, and the confirmation names the gate that actually dropped it: *it is stopped and Include Stopped Guests is off*, not the template opt-in you just switched on.

## Open the Guest Console in Your Browser

Right-click any Proxmox-synced guest and choose **Open Web Console** — or click the row and pick it from **Profile Actions**, where it sits with Connect and Test Connection: Nexus builds the address of PVE's own console page for that guest — noVNC for a virtual machine, xterm.js for a container, which is the frontend PVE's own Console button opens for each — and opens it in your browser. It needs **no address of its own**, which is the point — a VM with no guest agent, or one that is simply stopped, has nothing to SSH to, and its console is the way in. The credential for the console itself is the **PVE session your browser already holds**: the first open may land on PVE's login page, and after signing in the console is right there. Your API token is not that credential and is never put in the address — but it is used: each click makes one authenticated `GET /cluster/resources` call with it, to find which node is running the guest right now. So the token travels exactly as far as it does on a sync or a status refresh, on the same connection and under the same **Allow a Self-Signed or Mismatched Certificate** setting, and an invalid or unprivileged token fails that lookup rather than the console. No new secret is stored.

The guest's current node is resolved fresh at the moment you click, so a guest migrated since the last sync opens on the node running it now. A stopped guest opens PVE's own "not running" console page — honest, and in PVE's voice. The entry is offered for **guests only**: an imported cluster node has a shell of its own, not a guest console, so its row carries no such entry. A **template** (imported only if you tick Include Templates) does carry the entry — nothing on a synced row says "template", so the menu cannot know — but choosing it says so plainly: a template cannot run, so it has no console.

On a guest with no address yet, **Open Web Console** is also what **Connect** offers — see [Servers with No Address Yet](README.md#servers-with-no-address-yet).

## See also

- [Inventory Sync](README.md) — what every source shares
- [EVE-NG](eve-ng.md) — the Start/Stop machinery Proxmox guests share
- [Alternate Host](../ssh-and-telnet.md#alternate-host)
- [Device Templates](device-templates.md)
