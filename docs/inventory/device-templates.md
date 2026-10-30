# Device Templates

Apply a named, reusable bundle of connection settings to the servers a sync creates and maintains, instead of hand-editing each one.

A source's auth profile is one setting shared across every server it creates. A **device template** can link a different one to the devices it matches, and carries the rest: a proxy, a multiplexing choice, a legacy-algorithm toggle, session logging, and a BMC login (its own **IPMI Auth Profile** and **IPMI Gateway**) — a reusable bundle applied to matched devices so you don't set them on each synced server by hand.

An SSH **Auth Profile** may use [External Program](../ssh-and-telnet.md#external-program-credentials), including a dynamically supplied private key. Applying or previewing the template carries only the link and never runs the program. **IPMI Auth Profile** excludes external profiles; a previously selected incompatible profile stays marked unavailable until you choose a supported one.

## What a Template Can Set

A device template can set **Proxy**, **Auth Profile** (SSH), **Multiplexing**, **Legacy Algorithms**, **Session Logging**, **IPMI Auth Profile**, and **IPMI Gateway**. The non-proxy fields use *Not set*, *Fill* (only where nothing is set), or *Override* (replace source and earlier-synced values). Proxy rules also choose a route: *Not set* means no opinion, an SSH proxy selects a jump host, and *Direct* explicitly selects no proxy. Fill and Override apply that route according to the same ownership rules; a route you set by hand stays yours. Templates never store secrets, so a templated proxy may prompt for credentials on first connect.

## Create and Bind a Template

1. Create one with `Nexus: New Device Template` (or **Manage Device Templates**). For each field, choose **Not set**, **Fill** (write only where the server has nothing set), or **Override** (replace source data and values earlier syncs wrote — but never a value you set by hand). Templates hold no secrets, so a templated proxy still prompts for its password on first connect.
2. Bind it to devices. The simplest path is the **Device Template** select in the inventory source form, which applies one template to every device that source syncs. For finer control, run `Nexus: Edit Template Rules` and add filter rules like `role=switch&site=syd` (the keys are the ones the source's provider reports, and the filter box lists that source's own — NetBox: `role, site, location, rack, tenant, status, platform, tag, name`; EVE-NG: `lab, template, type, console, status, image, name`; Proxmox: `type, node, pool, tag, status, ip, ip6, mac, ifname, name` (a stopped guest has no `ip`, `ip6`, `mac` or `ifname`); GNS3: `project, type, console, status, compute, name`; Containerlab: `lab, kind, image, nodeName, name`. A key the provider doesn't report is flagged as you type, with its known keys listed; a repeated key is OR, distinct keys are AND, an empty filter matches every device, and `name` accepts `*` as a wildcard — `name=core-*` — so a bare `name=*` is a catch-all too), each pointing at a template.
3. When more than one rule matches a device, the settings **cascade per field**: the most specific rule (the one with more distinct keys) wins each setting it defines, while broader rules supply the rest — the order you added the rules never decides it. Two equally specific rules that disagree on a field are flagged in the plan's warnings, naming the one applied; make one more specific to choose deliberately.
4. The ownership rules match the rest of inventory sync: your own edits always win, clearing a template-applied value is a per-server opt-out, and changes apply on each source's **next** sync rather than the moment you save the template.

## Proxy Routes: Not Set, SSH and Direct

For a template's **Proxy** field, *Not set* is not the same as *Direct*. Not set leaves the route to another matching template or to the inventory source's default. Choose an SSH proxy to route through a particular jump host, or choose Direct to make the template supply an explicit direct route. Fill supplies its route where no configured route exists; Override may replace a route that inventory sync manages, while preserving a route you edited by hand.

Containerlab sources use their **Device Connection** setting for the source default. *Automatic* connects to devices directly for local discovery and through the configured lab-host SSH profile for remote discovery. *Direct* connects to devices directly even when Containerlab discovery itself runs over SSH. A matching template rule can provide its own SSH or Direct route. The discovery host and the node-connection route are separate: selecting Direct does not move discovery off the remote lab host.

On a source-managed profile, **Automatic** lets the source continue to manage its default route. **Keep Direct** records a manual direct choice, so later syncs do not put the source's jump host back. Choosing Automatic again returns the route to source management. See the [Containerlab guide](containerlab.md#device-connections-and-template-routes) for the full flow.

Create and manage templates with **New Device Template** / **Manage Device Templates** / **Edit Template Rules**; **Settings → Inventory Sources** also offers **Edit Template Rules** inline for each source.

## Apply a Template to a Folder Now

To apply a template to servers already in a folder without waiting for a sync, right-click the folder and choose **Apply Device Template**. Values written that way count as your own edits, so later syncs leave them alone — which is also how you overwrite a pre-template hand value that Override deliberately preserves.

## See also

- [Inventory Sync](README.md) — sources, the sync plan, and how synced fields hand off to your edits
- [Jump Hosts and Proxies](../ssh-and-telnet.md#jump-hosts-and-proxies) · [Auth Profiles](../ssh-and-telnet.md#auth-profiles) · [Session Transcript Logging](../terminal.md#session-transcript-logging)
- [Providing IPMI credentials](../macros.md#providing-ipmi-credentials) — how the BMC login a template links is used
