# Nexus Terminal

Unified SSH, Serial, and Port Forwarding hub for VS Code.

Manage remote servers, serial devices, and TCP tunnels from a single sidebar — with proxy support, SFTP file explorer, connection multiplexing, terminal macros, regex highlighting, color schemes, and configuration import/export.

## Features

- **SSH Terminal Sessions** — Connect to remote servers with password, private key, or SSH agent authentication. Two-factor authentication (keyboard-interactive) is fully supported — passwords auto-fill while verification codes are prompted separately. Credentials are cached securely via VS Code SecretStorage with silent re-auth. Per-server legacy algorithm toggle for older devices (Cisco IOS, embedded systems).
- **SSH Key Deployment** — Right-click any server and select "Deploy SSH Key" to automate key-based authentication setup. Discovers existing local keys or generates new ed25519 key pairs, deploys the public key to the remote `authorized_keys`, and optionally converts the server profile to key auth. Cross-platform (Windows, macOS, Linux).
- **SSH Host Key Verification** — Trust-on-first-use (TOFU) model stores host keys on first connection and alerts if a key changes (potential MITM). Configurable via `nexus.ssh.trustNewHosts`.
- **Auth Profiles** — Define reusable credential sets (password, private key, or SSH agent) and apply them to individual servers or entire folders in bulk. Manage profiles from a dedicated editor panel accessible via the Settings tree or context menu.
- **Proxy Support** — Route SSH connections through intermediaries when direct access isn't available. Three proxy types are supported per server:
  - **SSH Jump Host** — Select another configured server as a bastion/jump host (ProxyJump equivalent). Supports multi-hop chaining (A → B → C) with full auth reuse.
  - **SOCKS5 Proxy** — Connect through a SOCKS5 proxy server with optional username/password authentication.
  - **HTTP CONNECT Proxy** — Connect through an HTTP proxy using the CONNECT method, common in corporate environments.
- **SFTP File Explorer** — Browse, download, and manage remote files on connected servers. Drag-and-drop support for moving files between directories.
- **Serial Terminal Sessions** — Connect to serial ports (COM/ttyUSB) with configurable baud rate, data bits, parity, stop bits, and RTS/CTS flow control. Supports break signal and XON passthrough. Runs in an isolated sidecar process for crash safety.
- **Port Forwarding (TCP Tunnels)** — Three tunnel modes:
  - **Local (-L)** — Forward a local port to a remote host through SSH.
  - **Reverse (-R)** — Forward a remote port back to a local target.
  - **Dynamic SOCKS5 (-D)** — Run a local SOCKS5 proxy that routes traffic to any destination through SSH.

  All modes support configurable local bind addresses (localhost, LAN, or all interfaces), auto-start/auto-stop with server connections, live traffic counters, and a browser URL shortcut for quick access.
- **SSH Connection Multiplexing** — Share SSH connections across terminals, tunnels, and SFTP for the same server. Reduces connection overhead with automatic ref-counting and configurable idle timeout. Per-server toggle lets you disable multiplexing for devices that don't support multiple channels (e.g. Cisco). Automatic fallback to standalone connections handles channel failures transparently.
- **Connectivity Hub** — Sidebar tree view showing all servers and serial devices, organized into nested folders. Built-in filter to quickly search by name. Drag and drop to rearrange profiles, move between folders, or assign tunnels to servers. Active SSH and serial sessions highlight unread terminal activity until you focus that terminal again.
- **Terminal Appearance** — Customize terminal font family, size, and weight. Import color schemes from MobaXterm INI files or configure custom themes with live preview.
- **Terminal Highlighting** — Configurable regex-based pattern highlighting for SSH and serial terminal output. 20+ built-in rules detect errors, warnings, status keywords, IP/MAC addresses, UUIDs, URLs, interface counters and more with inline ANSI colouring while respecting existing remote colours. Includes a visual Rule Editor with live preview, color picker, and one-click reset to defaults.
- **Terminal Macros** — Define reusable text sequences and send them to the active terminal with one click or keyboard shortcut. Assign any macro a custom keybinding from 108 combinations across three modifier groups: `Alt`, `Alt+Shift`, and `Ctrl+Shift` with A-Z or 0-9 keys. Macros without a keybinding are accessible via `Alt+S` quick-pick. Includes a Macro Editor panel with multiline editing, secret macro support, and inline keybinding assignment. **Auto-trigger (expect/send)**: add a `triggerPattern` regex to any macro — when terminal output matches, the macro text is sent automatically. Classic expect/send for password prompts, confirmations, and interactive scripts. `triggerCooldown` prevents echo loops, `triggerInterval` enables prompt-gated polling macros, and macros can optionally start with auto-trigger paused until you resume them from the Macros view.
- **Keyboard Passthrough** — Optionally pass `Ctrl+` key combinations (e.g. `Ctrl+B`, `Ctrl+N`) directly to the terminal for applications like vim, nano, and htop. Configurable per-key with 10 supported combinations.
- **Session Transcript Logging** — Automatically log clean terminal output (ANSI codes stripped) to files with configurable rotation. Per-profile toggle.
- **Settings Panel** — View and edit all extension settings in a dedicated webview panel with search, grouped categories, and auto-save.
- **Configuration Export/Import** — Full encrypted backup with master password protection, or sanitized share export (credentials stripped, IDs remapped). Proxy configurations are preserved across backup and restore.
- **Import from MobaXterm / SecureCRT** — Migrate SSH session profiles directly from MobaXterm INI files or SecureCRT XML exports and session directories. Folder hierarchy is preserved.
- **Web Extension Fallback** — Graceful degradation in browser-based VS Code (SSH/serial features require desktop runtime).

## Getting Started

### Install from VS Code Marketplace

1. Open VS Code and go to the Extensions view (`Ctrl+Shift+X`)
2. Search for **NexTerminal**
3. Click **Install**
4. Open the **Nexus** sidebar (activity bar icon)

### Install from VSIX

1. Download the `.vsix` from [GitHub Releases](https://github.com/evdanil/vscode-NexTerminal/releases)
2. In VS Code: `Extensions` > `...` > `Install from VSIX...`
3. Open the **Nexus** sidebar (activity bar icon)

### Add a Server

1. Click `+` in the Connectivity Hub title bar, or run `Nexus: Add Server` from the command palette
2. Enter host, port, username, and authentication details (password, private key, or SSH agent)
3. Optionally configure a proxy (SSH jump host, SOCKS5, or HTTP CONNECT) under the Proxy section
4. Right-click the server and select **Connect** to open a terminal session
5. To set up key-based auth: right-click the server → **Deploy SSH Key** → select or generate a key → the public key is deployed automatically

### Connect Through a Proxy

If your target server is behind a firewall or bastion host:

1. **SSH Jump Host** — First add the bastion server as a regular server profile, then edit the target server and set its proxy to "SSH Jump Host", selecting the bastion from the dropdown. Multi-hop chains (A → B → C) work automatically.
2. **SOCKS5 / HTTP CONNECT** — Edit the target server and set its proxy type, entering the proxy host, port, and optional credentials. Proxy passwords are stored securely in VS Code SecretStorage.

### Add a Serial Device

1. Click the serial icon in the Connectivity Hub title bar, or run `Nexus: Add Serial Profile`
2. Use **Scan Serial Ports** to discover available ports
3. Configure baud rate, data bits, parity, and stop bits
4. Right-click the profile and select **Connect**

### Set Up Port Forwarding

1. Switch to the **Port Forwarding** section in the sidebar
2. Click `+` to add a tunnel profile and choose the type:
   - **Local Forward (-L)**: specify local port, remote host, and remote port
   - **Reverse Forward (-R)**: specify remote bind address/port and local target host/port
   - **Dynamic SOCKS5 (-D)**: specify local port (default 1080) — routes traffic to any destination through SSH
3. Assign an SSH server to the tunnel, or leave it unassigned to choose at start time
4. Right-click the tunnel and select **Start**

You can also drag a tunnel profile onto a server in the Connectivity Hub to start it immediately.

### Browse Remote Files

1. Connect to an SSH server
2. Open the **File Explorer** section in the Nexus sidebar
3. Click the server icon to set it as the active SFTP target
4. Browse, download, or drag files between remote directories

### Export / Import Configuration

- **Encrypted Backup**: Run `Nexus: Export Backup` to create a master-password-protected backup including all profiles, settings, and saved credentials
- **Share Export**: Run `Nexus: Export Configuration` to create a sanitized export safe for sharing (credentials stripped, IDs remapped)
- **Import**: Run `Nexus: Import Configuration` to restore from either format (merge or replace)

#### Import from MobaXterm or SecureCRT

Power users migrating from other SSH clients can import their connection profiles directly:

- **MobaXterm**: Run `Nexus: Import from MobaXterm` and select your MobaXterm `.ini` configuration file. SSH sessions are imported with their folder organization preserved.
- **SecureCRT**: Run `Nexus: Import from SecureCRT` and select either your SecureCRT XML export file or your `Sessions/` directory. SSH sessions are imported with their hierarchy as folder groups.

Both importers extract hostname, port, and username from each SSH session. Non-SSH sessions (RDP, Telnet, etc.) are skipped. Imported servers default to password authentication.

## Development

```bash
npm install
npm run build
npm test
```

To package a VSIX:
```bash
npm run package:vsix
```

## Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `nexus.logging.sessionTranscripts` | `true` | Enable session transcript logging |
| `nexus.logging.sessionLogDirectory` | *(extension storage)* | Custom directory for session logs |
| `nexus.logging.maxFileSizeMb` | `10` | Max log file size before rotation |
| `nexus.logging.maxRotatedFiles` | `1` | Number of rotated log files to keep |
| `nexus.ssh.multiplexing.enabled` | `true` | Share SSH connections across terminals, tunnels, and SFTP |
| `nexus.ssh.multiplexing.idleTimeout` | `300` | Seconds to keep idle multiplexed connection alive |
| `nexus.ssh.trustNewHosts` | `true` | Auto-trust host keys on first connection (TOFU); prompt only on key change |
| `nexus.ssh.connectionTimeout` | `60` | SSH connection timeout in seconds |
| `nexus.ssh.keepaliveInterval` | `10` | Interval between SSH keepalive packets in seconds (`0` disables keepalives) |
| `nexus.ssh.keepaliveCountMax` | `3` | Missed keepalive responses before the connection is treated as dead |
| `nexus.ssh.terminalType` | `xterm-256color` | `$TERM` value reported to the remote shell |
| `nexus.ssh.proxyTimeout` | `60` | Proxy handshake timeout for SOCKS5 and HTTP CONNECT proxies |
| `nexus.tunnel.defaultConnectionMode` | `shared` | `shared` or `isolated` SSH mode for tunnels |
| `nexus.tunnel.defaultBindAddress` | `127.0.0.1` | Default bind address for reverse tunnels |
| `nexus.tunnel.socks5HandshakeTimeout` | `10` | Dynamic tunnel SOCKS5 handshake timeout in seconds |
| `nexus.terminal.openLocation` | `panel` | Where to open terminals: `panel` or `editor` tab |
| `nexus.terminal.keyboardPassthrough` | `false` | Pass Ctrl+ key combinations to the terminal |
| `nexus.terminal.passthroughKeys` | `[b,e,g,j,k,n,o,p,r,w]` | Which Ctrl+ keys to pass through when enabled |
| `nexus.terminal.macros` | `[]` | Terminal macros with optional `keybinding`, `triggerPattern`, `triggerCooldown`, `triggerInterval`, and `triggerInitiallyDisabled` |
| `nexus.terminal.macros.autoTrigger` | `true` | Enable auto-trigger for macros with a `triggerPattern` |
| `nexus.terminal.macros.defaultCooldown` | `3` | Default cooldown in seconds for auto-trigger macros without a per-macro override |
| `nexus.terminal.macros.bufferLength` | `2048` | Max characters retained per terminal for auto-trigger pattern matching |
| `nexus.terminal.highlighting.enabled` | `true` | Enable regex-based terminal highlighting |
| `nexus.ui.showTreeDescriptions` | `true` | Show connection details beside items in the Connectivity Hub |
| `nexus.sftp.cacheTtlSeconds` | `10` | SFTP directory listing cache TTL |
| `nexus.sftp.maxCacheEntries` | `500` | Maximum cached SFTP directory listings |
| `nexus.sftp.autoRefreshInterval` | `10` | Auto-refresh interval for file explorer (seconds) |
| `nexus.sftp.operationTimeout` | `30` | Timeout for SFTP metadata operations (listing, stat, rename, delete) |
| `nexus.sftp.commandTimeout` | `300` | Timeout for remote SFTP commands and file transfers |
| `nexus.sftp.deleteDepthLimit` | `100` | Safety limit for recursive delete directory depth |
| `nexus.sftp.deleteOperationLimit` | `10000` | Safety limit for items removed by one recursive delete |
| `nexus.serial.rpcTimeout` | `10` | Timeout for serial sidecar commands in seconds |

## Documentation

See [docs/functional-documentation.md](docs/functional-documentation.md) for detailed architecture and design documentation.

## License

[Apache 2.0](LICENSE)
