# Local Servers

Run the local processes a bench needs alongside everything else: a dev server, a proxy, a mock API, a build watcher. Save a profile with an executable, arguments, working directory and environment, then start, stop and restart it from the Connectivity Hub.

Distinct from [**Embedded Network Servers**](network-servers.md), which serves TFTP and DHCP to hardware on the wire — Local Servers runs programs on this machine.

## Add a Local Server

1. Run `Nexus: Add Local Server Profile`, or use `Nexus: Add Profile` and select **Local Server**
2. Name it for the thing it runs — `API (dev)`, `Mock Billing`, `Vite watch`
3. Set the executable. A bare name is looked up on `PATH`; `~`, `${workspaceFolder}` and `${env:NAME}` are expanded
4. Add arguments one per line, and a working directory if the default is wrong. With a folder open, the directory must resolve inside one of the open folders — a profile pointing outside them is refused rather than started. With no folder open, an absolute directory is used as-is and a relative one is refused
5. Add environment variables as `KEY=value`, one per line. Three forms are distinct: `KEY=value` sets it, `KEY=` sets it to an empty string, and `KEY=null` unsets it for the child process even when the extension host inherited one. `${workspaceFolder}` and `${env:NAME}` are expanded in values
6. Optionally tick **Auto-restart on unexpected exit** so the process comes back when it exits on its own. Leave **Maximum auto-restart attempts** empty to follow *Nexus Settings → Local Servers*, or set your own; `0` means never restart it
7. Right-click the profile and choose **Start**. Its output opens in a Nexus terminal, and the row shows whether it is running, restarting or failed. From the Command Palette the same commands are grouped under `Nexus Local Servers:` — `Nexus Local Servers: Start`, `Stop`, `Restart`, `Inspect Logs`

To file a profile in a folder, drag it onto the folder in the Connectivity Hub, or use **Move to Folder…** on its right-click menu, which offers your existing folders, a new one, or the top level.

Environment variables often hold tokens, so an [Encrypted Backup](import-export.md#encrypted-backup-and-share-export) keeps them in its password-protected part, and **Export for Sharing** leaves Local Server profiles out altogether.

## Output

A local server's output lands in an ordinary Nexus terminal — [highlighting](terminal.md#highlighting), scrollback capture and [Reset / Clear Scrollback / Copy All](terminal.md#tab-commands) all apply. [Session transcript logging](terminal.md#session-transcript-logging) is not available for Local Server output; use Copy All to capture a run.

## Automatic Restart

A process that exits on its own can be restarted automatically, with the delay doubling on each attempt and the count clearing once it has run steadily; five consecutive failures is a hard ceiling, because a process that has died five times without once staying up is broken rather than unlucky.

Auto-restart counts *consecutive* failures. A server that runs for the stable-runtime threshold without exiting has its count cleared, so this bounds a crash loop rather than restarts over the profile's life — and once the limit is reached the server is marked failed and waits for you to start it again.

## Workspace Trust and Working Directories

With a folder open, working directories are confined to the open folders; starting a local server always requires a trusted workspace.

## Related settings

Default restart limit, stable-runtime threshold and restart back-off: [settings.md#local-servers](settings.md#local-servers).

## See also

- [Network Servers](network-servers.md) — the embedded TFTP and DHCP services, for hardware on the wire
- [Local Shells](local-shells.md) — interactive local terminals
- [Terminal](terminal.md) — highlighting and tab commands
- [Connectivity Hub](connectivity-hub.md) — where Local Server profiles live
