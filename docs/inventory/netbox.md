# NetBox Inventory Sync

If your device inventory already lives in NetBox, you don't have to re-type it. Add your NetBox instance as an inventory source and Nexus creates and maintains server profiles from its devices: placed under a target folder of your choosing, organized by a folder template (`{site}/{rack}` by default; `{location}`, `{role}`, and `{tenant}` also available), narrowed by any NetBox device filter, with virtual machines included on request. The API token lives in VS Code SecretStorage, never in a settings file.

For what every inventory source shares — the sync plan, removing and re-adopting servers, credentials, servers with no address — see [Inventory Sync](README.md).

## Add a NetBox Source

1. Run `Nexus: Add Inventory Source (NetBox, EVE-NG, Proxmox, GNS3…)` and choose **NetBox** — the first step is choosing a provider — or open **Settings → Inventory Sources**, which lists every configured source with inline **Sync Inventory Now**, **Edit Inventory Source**, **Edit Template Rules** and **Remove Inventory Source** icons
2. Enter your NetBox base URL and an API token with read access to DCIM (and Virtualization, if you include VMs). The token is stored in VS Code SecretStorage. **Test Connection** confirms the URL is reachable and the token is accepted — it does not check that the token can read your devices, so a token NetBox accepts but hasn't granted DCIM access will pass here and fail on the first sync
3. Optionally narrow the sync with a device filter (e.g. `status=active&site=syd`), shape the folder layout with a template (`{site}/{rack}` by default), and set a **Target Folder** to keep synced servers under
4. Pick an **Auth Profile** so the servers the sync creates can actually connect — choose an existing profile or create one inline without leaving the form. Its username fills the **Default SSH Username** field; with **(None)**, servers use the default username with SSH agent authentication
5. If the base URL is `https://` and your NetBox is behind a self-signed certificate — or you reach it by IP address and its certificate does not list that address (a certificate *can* cover an IP, so check before assuming) — tick **Allow a Self-Signed or Mismatched Certificate** under **Advanced options**. It is off by default; read the note below the list before turning it on
6. Save, then choose **Sync Now**. The plan is shown before anything is applied — how many servers will be added, updated, moved, or removed, and, when credentials would change, exactly which servers by name under **Show Warnings**

## Allow a Self-Signed or Mismatched Certificate

**Allow a Self-Signed or Mismatched Certificate** is the same option EVE-NG sources have, doing the same thing: Nexus connects over HTTPS without checking the server's certificate for that one source. The traffic is still encrypted, but it is no longer *authenticated* — anything on the network path can intercept it, and **your NetBox API token** is sent over that connection, on every request. That is the part worth pausing on: the token is a bearer credential with nothing else standing behind it, so anyone who captures it has your NetBox's read access until you revoke it. Reasonable for a self-hosted NetBox on a network you trust; not for one reachable from outside it. It applies to that source alone — nothing else in VS Code is affected — and it does nothing at all on an `http://` base URL, which is not encrypted in the first place. One thing to know before you turn it on: every sync that actually runs unverified says so in its plan, by design, so the choice does not go quiet after you make it. Leave it off and use a trusted certificate where you can. If you hit a certificate error before finding this, the error itself names the option.

## Devices with No Usable IP

A device NetBox has no usable IP for is not skipped. It arrives as a server with **no address** — visible in the tree, marked `(no address)`, and counted in the plan's warnings — keeping its folder and settings until NetBox gives it an address, which the next sync fills in on that same server. It can't connect in the meantime, and asking it to says exactly that rather than failing inside a handshake (see [Servers with no address yet](README.md#servers-with-no-address-yet)).

## Out-of-Band (BMC) Addresses

A device that carries an **out-of-band IP** in NetBox (`oob_ip`) also fills that server's **IPMI / BMC Host**, so `${profile.ipmiHost}` macros — the IPMI SOL console and BMC web console templates, see [Profile tokens](../macros.md#profile-tokens) — work on synced servers without typing an address anywhere. A value you typed by hand is never overwritten, clearing the field on one server is a per-server opt-out later syncs respect, and a device that stops reporting an out-of-band IP keeps its last known address rather than having it erased. Where an address you typed already matches exactly what the device reports — the usual outcome of copying it out of NetBox — the sync starts keeping that field current: nothing visible changes, and from then on it follows the BMC when it is re-addressed at the source. An address NetBox reports that can't be used as a host — a URL, say — is reported in the plan's warnings instead of being stored. Removing a source with **Keep Servers** and reclaiming its servers later preserves all of this.

## Primary IP Family and Alternate Host

From NetBox, [Alternate host](../ssh-and-telnet.md#alternate-host) fills itself in. Set the source's **Primary IP Family** — **Automatic** (NetBox's own primary IP, IPv6 when a device has both), **Prefer IPv4**, or **Prefer IPv6** — to choose which family becomes the Host; when the device carries both, the other family's primary IP is written into Alternate host automatically, so synced servers arrive ready to fall back from one stack to the other. That alternate is sync-owned like every other synced field: an address you type in yourself is never overwritten, clearing it is a per-server opt-out, and a device that stops reporting a second family keeps its last known alternate. The out-of-band (BMC) address is not affected by the family choice.

## Keep NetBox in Sync

Run **Sync Now** again whenever devices change at the source: renames and rack moves follow, and a device that disappears from NetBox is handled per the source's [Removed-Device Policy](README.md#keep-a-source-in-sync) — moved to an `_orphaned` subfolder (the default, which keeps its settings in case it returns), deleted, or kept in place.

A sync imports at most 10,000 records — devices and virtual machines together. Past that the plan warns *Truncated at 10000 devices — narrow the filter.* and nothing is pruned, because a capped listing must never be read as *these devices are gone*; narrow the **Device Filter** until the source fits.

Removing a source, re-adopting the servers you kept, and how a source's auth profile reaches servers from earlier syncs work the same for every provider — see [Remove a Source and Re-Adopt Its Servers](README.md#remove-a-source-and-re-adopt-its-servers) and [Credentials Stay Yours](README.md#credentials-stay-yours).

## Upgrade notes

> **A credential prompt after upgrade (2.8.191).** Adding this option ([Allow a Self-Signed or Mismatched Certificate](#allow-a-self-signed-or-mismatched-certificate)) changed the NetBox source form, and Nexus asks you to re-confirm handing a changed provider your saved credentials whenever that happens. A NetBox source that already carries a record of the form it was configured against therefore asks on its next sync or edit, exactly as EVE-NG sources did in 2.8.190; a source saved by a build old enough to predate that record is brought up to date silently, with no prompt at all. The prompt stops once that source has actually been synced or saved through: a sync that is applied (or finds nothing to change) or a saved edit form records the new form. Answering **Continue** and then cancelling the edit form, declining the sync plan, or a sync that fails leaves it to ask again next time.

**Out-of-band address ownership (2.8.97).** One caveat if you move between versions: syncing on a build older than 2.8.97 drops the record of which addresses the sync owns. The addresses themselves survive, and any server whose address still matches its device picks the record back up on the next sync from a current build; for the rest — those whose BMC also moved meanwhile — clearing the IPMI / BMC Host hands the field back to the sync.

## See also

- [Inventory Sync](README.md) — what every source shares
- [Alternate Host](../ssh-and-telnet.md#alternate-host) — how a terminal falls back to the second address
- [Auth Profiles](../ssh-and-telnet.md#auth-profiles)
- [Device Templates](device-templates.md) — proxy, multiplexing, logging and BMC settings for matched devices
