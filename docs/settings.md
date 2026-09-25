# Settings

The key settings, grouped by the feature they belong to; each group links to that feature's guide. This is not every setting — for the full list, open VS Code Settings and search for `nexus.`. Everything below, except the legacy `nexus.scripts.maxRuntimeMs`, can also be edited in the Nexus Settings panel (`Nexus: Open Settings`).

## Logging

Guide: [Terminal → Session Transcript Logging](terminal.md#session-transcript-logging).

| Setting | Default | Description |
|---------|---------|-------------|
| `nexus.logging.sessionTranscripts` | `true` | Enable session transcript logging for SSH, telnet and serial sessions by default; each profile can override it |
| `nexus.logging.sessionLogDirectory` | `""` | Custom directory for session logs; leave empty for the extension's storage folder |
| `nexus.logging.terminalOutputTrace` | `false` | Troubleshooting only: write every chunk of terminal output to the diagnostic log. Slows terminal output and stores session data — including anything echoed on screen, such as passwords — as plaintext on disk |
| `nexus.logging.maxFileSizeMb` | `10` | Max log file size before rotation |
| `nexus.logging.maxRotatedFiles` | `1` | Number of rotated log files to keep |

## SSH

Guide: [SSH and Telnet](ssh-and-telnet.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `nexus.ssh.multiplexing.enabled` | `true` | Share one SSH connection per server across terminals, tunnels (shared mode) and SFTP. Requires a window reload |
| `nexus.ssh.multiplexing.idleTimeout` | `300` | Seconds to keep an idle multiplexed connection alive after all channels close (`0` = until the window closes, max `3600`). Requires a window reload |
| `nexus.ssh.trustNewHosts` | `true` | Auto-trust host keys on first connection (TOFU); prompt only on key change |
| `nexus.ssh.connectionTimeout` | `60` | SSH connection timeout in seconds |
| `nexus.ssh.keepaliveInterval` | `10` | Interval between SSH keepalive packets in seconds (`0` disables keepalives) |
| `nexus.ssh.keepaliveCountMax` | `3` | Missed keepalive responses before the connection is treated as dead |
| `nexus.ssh.terminalType` | `xterm-256color` | `$TERM` value reported to the remote shell |
| `nexus.ssh.proxyTimeout` | `60` | Proxy handshake timeout in seconds for SOCKS5 and HTTP CONNECT proxies |

## Port Forwarding

Guide: [Port Forwarding](port-forwarding.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `nexus.tunnel.defaultConnectionMode` | `shared` | `shared` or `isolated` SSH mode for tunnels |
| `nexus.tunnel.defaultBindAddress` | `127.0.0.1` | Default bind address for reverse tunnels |
| `nexus.tunnel.socks5HandshakeTimeout` | `10` | Dynamic tunnel SOCKS5 handshake timeout in seconds |

## Terminal

Guide: [Terminal](terminal.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `nexus.terminal.openLocation` | `editor` | Where to open terminals: `panel` or `editor` tab |
| `nexus.terminal.keyboardPassthrough` | `true` | Pass Ctrl+ key combinations to the terminal |
| `nexus.terminal.passthroughKeys` | `[b,e,g,j,k,n,o,p,q,r,w]` | Which Ctrl+ keys to pass through when enabled |
| `nexus.terminal.highlighting.enabled` | `true` | Enable regex-based terminal highlighting; rules are edited in the Highlighting Rules editor. The IPv6 and UUID rules ship disabled — switch either on with its per-rule checkbox in the editor |
| `nexus.settingsGuard.enabled` | `true` | Restore the `terminal.integrated.commandsToSkipShell` entries macro shortcuts need when an external program strips them — see [Settings Guard](connectivity-hub.md#settings-guard). External changes are still logged when this is off |

## Macros

Guide: [Macros](macros.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `nexus.terminal.macros.autoTrigger` | `true` | Enable auto-trigger for macros with a `triggerPattern`; per-macro scope can limit matching to the active terminal or a matching profile |
| `nexus.terminal.macros.defaultCooldown` | `3` | Default cooldown in seconds for auto-trigger macros without a per-macro override |
| `nexus.terminal.macros.bufferLength` | `2048` | Max characters retained per terminal for auto-trigger pattern matching |

## Connectivity Hub

Guide: [Connectivity Hub](connectivity-hub.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `nexus.ui.showTreeDescriptions` | `true` | Show connection details beside items in the Connectivity Hub |

## File Explorer

Guide: [File Explorer](file-explorer.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `nexus.sftp.cacheTtlSeconds` | `10` | SFTP directory listing cache TTL |
| `nexus.sftp.maxCacheEntries` | `500` | Maximum cached SFTP directory listings |
| `nexus.sftp.autoRefreshInterval` | `10` | Polling interval for file explorer (seconds); also used as the auto-mode safety net unless recursive inotify is available |
| `nexus.sftp.remoteWatchMode` | `auto` | Remote change detection mode: `auto` prefers recursive inotify, `polling` uses interval-based refresh only |
| `nexus.sftp.maxOpenFileSizeMB` | `5` | Largest single file Nexus will hold in memory — opening a remote file in the editor, and transferring a file whose reported size is `0` (pseudo-files and appliances that mis-report size have to be read to the end to find out how big they are). Ordinary uploads and downloads stream and are not limited by this |
| `nexus.sftp.operationTimeout` | `30` | Timeout for SFTP directory and metadata operations (listing, stat, realpath, rename, mkdir, delete) |
| `nexus.sftp.commandTimeout` | `300` | Timeout for remote SFTP commands, file transfers, and editor file open/save; upload/download use it as an inactivity timeout rather than a total duration cap |
| `nexus.sftp.deleteDepthLimit` | `100` | Safety limit for recursive delete directory depth |
| `nexus.sftp.deleteOperationLimit` | `10000` | Safety limit for items removed by one recursive delete |
| `nexus.sftp.sudo.enabled` | `true` | Offer to save remote files with sudo when the SSH user lacks write permission |
| `nexus.sftp.sudo.rememberPasswordForSession` | `false` | Keep the sudo password in memory until that server disconnects or the window closes, rather than clearing it after each save; never written to disk or secret storage. Turning this off doesn't guarantee a prompt every time — the remote host's own sudo credential timestamp can skip it regardless, and a short grace window (30 seconds) after each password entry applies either way |

## Network Servers

Guide: [Embedded Network Servers](network-servers.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `nexus.networkServers.engine` | `rust` | Which implementation backs the embedded TFTP and DHCP services. `rust` (default since 2.8.205) is a native binary packaged for all six supported platforms; `node` is the bundled JavaScript daemon, which is also the automatic fallback if no native binary is available here — the reason is logged and the services start either way. `nexus.networkServers.dhcp.allowRelayAgents` is honoured by the Rust engine only. Takes effect the next time the daemon starts |

## Local Servers

Guide: [Local Servers](local-servers.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `nexus.localServers.defaultMaxAutoRestarts` | `5` | How many times in a row a local server may restart automatically, for profiles that set no limit of their own. `0` means never. Five is also the hard ceiling — the setting can ask for fewer, not more |
| `nexus.localServers.stableRuntimeMs` | `10000` | How long a local server must run without exiting before it counts as healthy and its consecutive-restart count is cleared |
| `nexus.localServers.initialBackoffMs` | `500` | Delay before the first automatic restart. Each further attempt doubles it |
| `nexus.localServers.maxBackoffMs` | `30000` | Ceiling on the delay between automatic restarts, however far the doubling has gone |

## Serial

Guide: [Serial](serial.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `nexus.serial.rpcTimeout` | `10` | Timeout for serial sidecar commands in seconds |

## Scripts

Guide: [Scripting](scripting.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `nexus.scripts.path` | `.nexus/scripts` | Directory where Nexus scripts live. Absolute paths are used as-is. Relative paths resolve against the workspace root when a folder is open, otherwise the extension's global storage. Pick a folder via *Nexus Settings → Scripts → Scripts Folder* |
| `nexus.scripts.defaultTimeoutSeconds` | `30` | Default per-wait timeout in seconds for `waitFor` / `expect` / `waitAny` / `poll` when not specified; `poll` never waits less than its `every` interval |
| `nexus.scripts.macroPolicy` | `suspend-all` | Macro policy while a script runs: `suspend-all` or `keep-enabled` |
| `nexus.scripts.maxReadSizeMb` | `4` | Largest file (in MiB) a script may read via `nexus.fs.readText` / `readJson`; range 1–16. Snapshotted when a run starts |
| `nexus.scripts.maxRuntimeSeconds` | `1800` | Overall runtime cap in seconds. Exceeded runs are auto-stopped with reason `max-runtime-exceeded`; `0` disables the cap; maximum `2147483` |
| `nexus.scripts.maxRuntimeMs` | `1800000` | Legacy millisecond runtime cap retained for compatibility when the seconds setting is absent |
