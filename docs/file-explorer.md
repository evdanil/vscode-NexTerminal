# File Explorer (SFTP)

Browse, download, and manage remote files on connected servers over SFTP. The File Explorer can also save root-owned files with `sudo`, and follow your SSH terminal's current directory as you move around.

## Browse Remote Files

1. Connect to an SSH server
2. Right-click the connected server in the Connectivity Hub and choose **Browse Files** (it is also in the list you get by clicking the server — see [Profile Actions](connectivity-hub.md#profile-actions)), or click **Browse Files** in the **File Explorer** title bar and pick the connected server
3. The File Explorer opens at the server's home directory — browse, download, or drag files between remote directories

Drag-and-drop is supported for moving files between directories, and for uploading local files and folders onto a remote directory. Every upload and download is size-checked against its source once it finishes, and an item that was attempted and failed is counted as a failure rather than folded into the skip count.

Windows network shares (`\\server\share`) are handled explicitly — see [Windows Network Shares](#windows-network-shares).

## Open the File Explorer on Connect

In an SSH profile's advanced options, enable **Open File Explorer on first connection** to start SFTP automatically after normal Connect when the File Explorer is not already showing that server. Saving it checked disables it on any other SSH profile, and it does not run when that profile is used as a jump host, tunnel connection, group connect item, script-started connection, or a **Run Macro on Server…** connection.

## File Permissions

Saving a remote file in the editor, and creating one with **New File**, leave permissions alone: an existing file keeps its own mode, and a new file is created under the remote server's `umask`.

## Save as Root

Edit root-owned files without dropping to a shell — save `/etc/*` over SFTP with `sudo`, writing through the file's existing inode so owner, mode, and ACLs are preserved. Your sudo password goes to the SSH channel's stdin only: never to disk, never to secret storage, never to a log.

SFTP writes as the logged-in SSH user, so editing a root-owned file normally fails. If your SSH user has sudo rights on the remote host, Nexus can save it anyway:

- **Reactive**: edit and save a root-owned file as usual. If the write is denied, Nexus offers to retry with `sudo`. Declining suppresses the offer for that file until you close its editor tab or explicitly choose **Edit as Root (sudo)**.
- **Proactive**: right-click a file in the File Explorer and choose **Edit as Root (sudo)** to mark it editable up front — needed for files with no write bits at all (e.g. `0444`), which VS Code otherwise blocks from editing before the save is ever attempted. This only helps with *writes*: elevated reads are not supported, so a file you can't even read as your SSH user (e.g. `0440 root:root` on `/etc/sudoers`) still fails to open, Edit as Root notwithstanding.

### What elevation covers

Elevation covers saving file *contents* only — deleting, renaming, and creating directories are not elevated, because those need write access to the **parent directory** rather than to the file. So you can save a new file into a root-owned directory and then find you can't remove it from the File Explorer; do that from a terminal on the host. Extending elevation to those operations is tracked in [#32](https://github.com/evdanil/vscode-NexTerminal/issues/32).

### Your sudo password

The file is staged to a temporary path over SFTP and then moved into place with `sudo` over an SSH exec channel. Your sudo password (only asked if the account needs one) is piped directly to that channel — it is never written to disk, VS Code's secret storage, or any log.

By default the password isn't kept between saves; enable `nexus.sftp.sudo.rememberPasswordForSession` to keep it in memory until that server disconnects or the window closes. Either way, the remote host's own sudo credential timestamp (typically ~5 minutes) can let consecutive saves skip the password prompt regardless of this setting. A short grace window (30 seconds) after you type the password also covers an immediately-following elevated write to the same server — such as VS Code's own Save As, which issues two writes for one save — without prompting twice.

### How an elevated save writes the file

For an existing file, the write goes through the file's own inode, so its owner, mode, ACLs, and hard links are preserved exactly. A brand-new file — or an existing one recreated because it vanished remotely between open and save (log rotation, a concurrent delete) — is created using the mode last observed for it, or `644` if none was ever observed. That restoration is read/write bits only — a recreated file never comes back with execute or setuid/setgid/sticky bits, which can be narrowed but never restored.

A staged write the server refuses outright — no space left, an over-quota home directory, an appliance rejecting the path — fails the save instead of being installed over the target.

**The write is not atomic** — a disk-full condition or a dropped connection partway through can leave the target partially written with no backup, so if a save fails, keep the editor open and retry rather than closing it.

### Limits

Sudoers policies requiring a TTY (`requiretty`) are not supported over this path — a plain-language error explains that up front, along with how to work around it.

The install writes through a shell redirect (`cat < temp > target`), which follows symlinks and does not check the target's type first: if another local, non-root account on the remote host can write to the target's parent directory, it can swap the target for a symlink between your open and your save, and the elevated write lands root-owned content wherever that link points — the same exposure as the common `sudo tee /path` idiom.

Elevated saves can be turned off entirely with `nexus.sftp.sudo.enabled`.

### Which password sudo wants

Elevation depends on the SSH account actually having sudo rights on the remote host (sudoers membership, or a group like `wheel`/`sudo`) — the password Nexus asks for is normally **your own** login password, the same one a `sudo` prompt at a real terminal would ask for.

If you're not in sudoers but happen to know the root password, elevation can't use it: sudo authenticates the invoking user, not root, so the root password isn't accepted in its place. The practical workaround is to add a second Nexus server profile that logs in **as root** over SSH and edit the file directly through that connection — only possible if the remote host's SSH server permits root login.

Elevating with the root password via `su` instead of `sudo` is not supported and isn't planned: unlike `sudo -S`, `su` on Linux reads its password from `/dev/tty` rather than stdin, and Nexus has no PTY channel available to drive that prompt.

One host-configuration wrinkle worth knowing: if the remote sudoers file sets `Defaults rootpw` (or `targetpw`), sudo actually wants **root's** password instead of yours — a password rejected on such a host isn't necessarily wrong, just the wrong *kind*, and the retry prompt calls this out.

## Windows Network Shares

VS Code blocks access to Windows network paths (`\\server\share`) unless the host is listed in its own `security.allowedUNCHosts` setting. Nexus reads and writes the local side of a transfer through Node directly, so a blocked share fails with the real reason and names the host.

### Allowing a blocked host

A blocked transfer offers **Allow Host…** and **Open Settings**. **Allow Host…** asks again in a modal that names both the host and the setting, and only a positive answer there appends the host to `security.allowedUNCHosts` in your user settings; declining at either step changes nothing. `security.restrictUNCAccess` itself is never touched — the restriction stays on, one host is added to the list it consults.

The extension host is handed that list once when it starts, so Nexus re-checks the path afterwards: if it works now, it just asks you to repeat the transfer, and it offers **Reload Window** only when the change genuinely hasn't taken effect yet. One prompt per host rather than per file, so a directory upload from a blocked share asks once.

### Transfer pipeline for network shares

A transfer whose local side is a UNC path also runs a smaller pipeline — 8 concurrent 32 KB operations instead of the default 64 — because the default queues far more parallel file operations than Node's thread pool can serve and stalls the whole extension host whenever the share does. A mapped drive letter (`Z:\…`) can't be told from a local disk without Windows API calls, so it keeps the default profile.

Blocked hosts, and the byte count of every completed transfer, are recorded in the **Nexus SSH** output channel.

## Directory Sync

The File Explorer can track whichever SSH terminal you're focused on, so it moves with that terminal's current directory instead of sitting wherever you last navigated. In the menus this is **Follow Terminal Directory**.

This is **continuous sync** — not a one-off jump — for any shell that announces its own directory. `fish` (≥ 3.x) does this unconditionally, and prompt frameworks like `starship` do too, using the same `OSC 7` escape sequence Nexus already reads out of the terminal's own output.

### Make bash or zsh report its directory

Plain bash and zsh don't announce it by default, but one snippet each fixes that for good:

```bash
# ~/.bashrc — let Nexus follow this shell's directory
PROMPT_COMMAND='printf "\033]7;file://%s%s\033\\" "$HOSTNAME" "$PWD"'"${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
```

```zsh
# ~/.zshrc — let Nexus follow this shell's directory
__nexus_osc7() { printf '\033]7;file://%s%s\033\\' "${HOST}" "$PWD"; }
precmd_functions+=(__nexus_osc7)
```

(zsh sets `$HOST` automatically — `$HOSTNAME` is frequently unset there, unlike in bash.) Add either once and that shell reports its directory continuously from then on — no waiting for a future Nexus release.

### Devices that never report a directory

For anything that isn't a POSIX shell — Cisco IOS, Juniper, FortiOS, or any other device that will never emit that escape sequence — run **Go to Terminal Directory** to jump the File Explorer to your terminal's current directory on demand, using a best-effort read of the visible prompt.

### Turn following on or off

Turn continuous following on or off from the toggle at the left of the File Explorer title bar, or from the right-click menu on the `.` row that shows your current directory — never from Settings. Turning it on jumps immediately to the focused terminal's already-known directory if one is on record and the explorer is idle and visible, rather than waiting for the next `cd` or focus change.

Navigating manually (Go to Path, Go Home, or `..`) pauses following rather than fighting it; one click on **Resume Following Terminal Directory** jumps straight back to the terminal's directory.

### When a terminal hasn't reported a directory yet

If you turn following on for a terminal that hasn't reported a directory yet, Nexus tells you right away instead of leaving the toggle looking broken: **Show Me How** drops the rc one-liner into the Nexus Directory Sync output channel, and **Go to Terminal Directory** jumps there manually in the meantime. That notice shows once per server per window.

### Nothing is typed into your session

**Nexus never types anything into your session to make this work, in this release.** Every part of this feature only reads what the shell already sends — it either volunteers its own directory, or you ask for it explicitly with Go to Terminal Directory.

## Related settings

SFTP caching, refresh, timeouts, delete safety limits and sudo options: see [Settings → File Explorer](settings.md#file-explorer).

## Upgrade notes

- **File permissions on save:** Earlier releases wrote through a path that chmod'd every file it opened to `0666`, which quietly made a `0600` key or credentials file world-readable and world-writable on save.
- **Refused staged writes during Save as Root:** Earlier releases could report such a save as done and then move a truncated file into place — ssh2 reports a rejected SFTP write and a completed one with the same stream event.
- **Uploads from a blocked Windows network share:** A drag-and-drop upload from a share VS Code blocks used to be counted as a skipped file and finish as *Upload completed with skips*, having moved nothing.
- **Downloads into a Windows network share:** Downloading into a network share no longer takes the server's other sessions with it. The local file was opened deep inside the SSH client's own callback stack, so VS Code's UNC check threw there and tore down the shared connection — every terminal on that server disconnected at once. The destination is now probed first, on Nexus's own stack, without creating or truncating anything.

## See also

- [SSH and Telnet](ssh-and-telnet.md) — adding servers, authentication, and why SFTP isn't offered on a telnet server
- [Open a Profile from the Command Line](open-from-command-line.md) — `?sftp` connects and opens the File Explorer in one step
- [Terminal](terminal.md) — highlighting, tab commands, and transcripts for the terminal you're following
- [Settings](settings.md#file-explorer)
