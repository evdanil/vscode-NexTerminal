# Import and Export

Bring your existing connections into Nexus, and take your configuration with you. Migrate SSH session profiles directly from your `~/.ssh/config`, MobaXterm INI files, or SecureCRT XML exports and session directories — folder hierarchy is preserved where the source has one, so switching costs you minutes, not a weekend. Onboard a whole rack from a CSV export or a plain list of hostnames. Export an encrypted backup of your connections, credentials and settings, or a sanitized copy you can share.

## Import

Run `Nexus: Import…` — also reachable from the Connectivity Hub's `...` overflow menu, the Connectivity Hub welcome view, and the Data Management section of Settings. It asks what you're importing, then opens the matching picker:

- **Paste Host List from Clipboard** / **Host List File…** — a CSV export, a device inventory, or a plain hostname list
- **MobaXterm INI File…** — sessions from a MobaXterm `.ini` bookmarks export
- **SecureCRT XML Export…** / **SecureCRT Sessions Folder…** — sessions from SecureCRT
- **SSH Config File…** — hosts from an OpenSSH client config (`~/.ssh/config`), with their `IdentityFile` keys
- **Nexus Export File…** — an encrypted backup or a shared config (`.json`). Merge skips existing local `.ssh` / script files; Replace overwrites files present in the backup but does not delete extra local files.

If the file you picked doesn't match what you told the picker — say, you chose "Host List File…" but selected a MobaXterm export — Nexus names the mismatch and offers a one-click button to re-import it as the format it actually looks like, instead of a dead end.

`Nexus: Import from MobaXterm`, `Nexus: Import from SecureCRT`, `Nexus: Import from SSH Config`, and `Nexus: Import Servers from List (CSV/Text)` remain available in the command palette as direct shortcuts into those same pickers, for anyone who already knows exactly what they're importing.

## Import from MobaXterm or SecureCRT

Power users migrating from other SSH clients can import their connection profiles directly:

- **MobaXterm**: choose **MobaXterm INI File…** and select your MobaXterm `.ini` configuration file. SSH sessions are imported with their folder organization preserved.
- **SecureCRT**: choose **SecureCRT XML Export…** or **SecureCRT Sessions Folder…** and select the corresponding export file or `Sessions/` directory. SSH sessions are imported with their hierarchy as folder groups.

Both importers extract hostname, port, and username from each SSH session. Non-SSH sessions (RDP, Telnet, etc.) are skipped. Servers imported from MobaXterm or SecureCRT default to password authentication.

## Import from an SSH Config

Import hosts from your `~/.ssh/config`, keys and all. Choose **SSH Config File…** (or run `Nexus: Import from SSH Config`) and pick an OpenSSH client config — the picker opens in `~/.ssh`, where the file usually has no extension at all.

- Each `Host` block becomes a profile named after the alias you already type: `ssh web1` becomes a profile called **web1**. `HostName`, `Port` and `User` come across; a block with no `HostName` connects to its alias, exactly as `ssh` does, and a block with no `User` gets your local login name — or, on a machine that has no local login name to read (a plain container), Nexus asks you once for a username to use for those hosts rather than importing profiles that would fail to save.
- **`IdentityFile` hosts arrive as key authentication**, with the key path filled in (`~` expanded), so they connect without asking for a password you never set. Two exceptions, both deliberate: `IdentityFile none` is ssh's way of saying *this host has no key*, so it arrives on password auth like any other; and a key path Nexus cannot finish expanding — one still holding a `%` token it does not model — costs that host its key but not the host itself, which the confirm modal counts for you. Everything else arrives as password auth.
- `Include` directives are followed, with the same rules `ssh` uses (relative patterns resolve against `~/.ssh/`, a glob matches basenames only). A cycle, a missing file, or nesting deeper than 16 levels is reported and skipped — one bad line never costs you the rest of the file.
- Skipped, and counted in the confirmation: defaults blocks (`Host *`, `Host ?`), negated patterns (`!prod`), `Match` blocks (their conditions can only be evaluated while connecting), and any host whose `HostName` uses an ssh `%` token Nexus cannot expand at import time. `%h` and `%%` are expanded; `%p`, `%r`, `%C` and the rest depend on the connection, so those hosts are left out rather than imported as a name that can never resolve.
- **Importing twice is safe**: a host already in Nexus at the same address, port and username is skipped, not added again. That makes the file re-importable as it grows, rather than a one-shot migration.
- Not imported: `ProxyJump` — the confirmation names how many hosts are affected, and they import as direct connections; set **Proxy** to **SSH Jump Host** and pick the Jump Host Server on the profile afterwards. There is no folder concept in an ssh config, so every host lands at the root.

### The first-run offer

The first time Nexus starts on a machine with an importable `~/.ssh/config`, it offers this import once — and only once, whatever you answer. "Importable" means hosts you do not already have: if every host in the file is already in Nexus, the offer stays silent and is not spent, so upgrading with your hosts already imported does not burn it on a notification with nothing behind it. `Nexus: Import…` stays available forever.

## Import a Device List

Onboard a whole rack in one paste — feed it a CSV export or a plain list of hostnames and it creates the connections in bulk, with folders, ports, and usernames picked up from the columns. Duplicates are skipped and unparsable lines are reported with their line numbers instead of failing the batch.

For everyone else — a spreadsheet export, a device inventory, or just a list of hostnames — choose **Paste Host List from Clipboard** or **Host List File…** (`.csv`, `.txt`, `.tsv`, up to 2 MB and 5,000 rows; anything beyond the row cap is reported, not silently dropped).

### Accepted formats

- **A header row** naming columns in any order: `host`/`hostname`/`address`/`ip`, `name`/`label`/`device`, `user`/`username`, `port`, `folder`/`group`/`site`.
- **No header**, positional: `host[,name[,username[,port[,folder]]]]` — note the third field is read as a **username**, not a folder. A bare `host,name,folder` list needs a header row (e.g. `host,name,folder`) so the columns are matched by name instead of position.
- **Shorthand** in the host field: `user@host`, `host:port`, `user@host:port`.
- Lines starting with `#` and blank lines are ignored.

```csv
# host, name, user, port, folder
10.0.0.1, core-sw1, netadmin, 22, DC1/Core
10.0.0.2, core-sw2, netadmin, 22, DC1/Core
sw3.lab.example.com
netadmin@sw4.lab.example.com:2022
```

### Prompts, confirmation and duplicates

If any row omits a username you're prompted once for a default (pre-filled with your most common existing username). If the list has no folder column of its own you're then prompted for an optional folder prefix, applied to every row.

A single confirm dialog then summarizes what's about to happen — how many servers, how many folders will be created, how many rows already exist and will be skipped, how many lines couldn't be parsed — before anything is written; a **Show Skipped Lines** button opens the unparsable rows in a scratch document without importing.

Rows that already match an existing server (same host, port, and username — host compared case-insensitively) are skipped and the count is reported. Imported servers always use password authentication — switch to key-based auth afterward via **Edit Server** if needed.

## Hand-Write an Import File

Choosing **Nexus Export File…** also accepts a minimal hand-written JSON file — useful for one connection or a quick script, without going through any other importer:

```json
{
  "version": 2,
  "servers": [
    {
      "id": "8400e8b0-8b3e-4b8a-9b1a-000000000001",
      "name": "core-sw1",
      "host": "10.0.0.1",
      "port": 22,
      "username": "netadmin",
      "authType": "password",
      "isHidden": false,
      "group": "DC1/Core"
    }
  ]
}
```

`name`, `host`, `port`, `username` and `authType` (`password`, `key` or `agent`) are required, except that a telnet server (`"protocol": "telnet"`) can leave out `username`. `isHidden`, `group` and `id` are optional — omit `group` for a top-level server, and Nexus fills in an `id` if it's blank or missing; it just needs to be unique if you supply one.

## Encrypted Backup and Share Export

An encrypted backup protected by a master password, or a sanitized share export (credentials stripped, IDs remapped). Proxy configurations are preserved across backup and restore.

- **Encrypted Backup**: Run `Nexus: Encrypted Backup` to create a master-password-protected backup of your servers, tunnels, serial, Local Shell and Local Server profiles, saved TFTP/DHCP profiles, auth profiles, folders, inventory sources, device templates, saved filters, macros and macro folders, settings, saved credentials, trusted SSH host keys, the user `.ssh` folder, and the configured Nexus scripts folder
- **Share Export**: Run `Nexus: Export for Sharing` to create a sanitized export safe for sharing (credentials stripped, Local Shell environment variables removed, learned hardware identifiers removed, IDs remapped). Your inventory sources go with it, together with the device templates they use, your saved filters and the servers the sources synced — addressless ones included — so the servers arrive already belonging to their source, and the recipient's first sync updates them where they are instead of adding them a second time. A source never carries its saved token or password, a login typed into its URL, or when it last synced. A NetBox, EVE-NG, Proxmox or GNS3 source also arrives with **Allow a Self-Signed or Mismatched Certificate** turned off, an EVE-NG, Proxmox or GNS3 source without its status poll interval, and an EVE-NG or GNS3 source without your provider login. The recipient enters their own credentials in **Edit Inventory Source** (the import's notification has a button for it) before syncing; for a source that uses none, the notification asks only for a review. A key auth profile travels without its key file, so it arrives unlinked from the sources, device templates and synced servers that used it: the recipient gives it their own key file, or picks another profile, and links it on the source. A source set to delete servers whose device disappears arrives set to move them to `_orphaned` instead — see [Sources from a Shared Export](inventory/README.md#sources-from-a-shared-export). Someone on a version before 2.8.253 gets the servers but not their sources, so ask them to update first. Importing a share strips the same things again from the file it reads, so a hand-edited or older file cannot bring back a key path, a login, a Local Shell startup command, working directory or environment, a learned hardware identifier or a session log folder.

You can also open **Settings** and use **Backup…** to save a password-protected backup, or **Export for Sharing…** to create a sanitized export without secrets.

The master password encrypts the secrets — saved passwords, passphrases, tokens, secret macro text, and the environment variables of your Local Shell and Local Server profiles — along with your trusted SSH host keys and the backed-up `.ssh` and script files. Everything else in the file is readable by anyone who has it: profile names, hosts, usernames, ids, settings, and a Local Server's program, arguments and working directory. Keep the file private, and give a Local Server the secrets it needs through its environment variables rather than its arguments.

The password also seals the readable part. A backup made by this version records a fingerprint of it inside the encrypted part, and if anything in the readable part is changed afterwards — a server's host, a Local Server's command — the import is refused before anything on this machine changes, so the passwords and variables a backup restores are never attached to a record someone else rewrote. Restoring an unchanged backup works whatever the file's spacing or key order; a backup made before 2.8.243 has no seal and imports as it always did.

**Replace refuses a list it could not restore.** If the backup's Local Server, saved TFTP or saved DHCP profile list has entries but none of them can be imported, Replace stops before deleting anything and says which list; Merge imports what it can. An empty list is a real answer and still clears yours.

**Local Servers, TFTP/DHCP profiles and host keys on restore:** Merge adds the ones you don't have and keeps the ones you do; where the backup trusts a different SSH host key than this machine does, your current key is kept and the import summary says how many hosts that affected. Replace swaps in the backup's, stopping any running Local Server it removes first. A restore starts nothing — Local Servers come back stopped, and a TFTP/DHCP profile isn't applied until you load it. A backup made before 2.8.243 has none of these, and restoring it leaves yours untouched, Replace included. Export for Sharing never includes them. Session logs are not backed up.

To bring either file back in, run `Nexus: Import…` and choose **Nexus Export File…** — see [Import](#import) for how Merge and Replace treat local `.ssh` and script files.

Macros come back without their **Provide IPMI credentials** and **Run on** settings — re-enable them on the ones you trust; see [Capability settings are never imported](macros.md#capability-settings-are-never-imported).

## See also

- [SSH and Telnet](ssh-and-telnet.md) — auth types, proxies and jump hosts for imported servers
- [Inventory Sync](inventory/README.md) — keep servers in sync with NetBox, EVE-NG, Proxmox or GNS3 instead of importing once
- [Connectivity Hub](connectivity-hub.md) — folders imported servers land in
- [Open a Profile from the Command Line](open-from-command-line.md)
