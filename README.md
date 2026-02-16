# Nexus Terminal

Unified SSH, Serial, and Port Forwarding hub for VS Code.

Manage remote servers, serial devices, and TCP tunnels from a single sidebar — with session logging, drag-and-drop organization, and configuration import/export.

## Features

- **SSH Terminal Sessions** — Connect to remote servers with password or key-based authentication. Credentials are cached securely via VS Code SecretStorage with silent re-auth.
- **Serial Terminal Sessions** — Connect to serial ports (COM/ttyUSB) with configurable baud rate, data bits, parity, and stop bits. Runs in an isolated sidecar process for crash safety.
- **Port Forwarding (TCP Tunnels)** — Forward local ports to remote hosts through SSH. Supports isolated (one SSH connection per tunnel) and shared (single connection) modes.
- **Connectivity Hub** — Sidebar tree view showing all servers and serial devices, organized by group. Drag and drop to rearrange.
- **Settings Panel** — View and edit extension settings directly in the sidebar.
- **Session Transcript Logging** — Automatically log terminal I/O to files with configurable rotation.
- **Configuration Export/Import** — Back up and restore all profiles and settings as a single JSON file.
- **Web Extension Fallback** — Graceful degradation in browser-based VS Code (SSH/serial require desktop runtime).

## Getting Started

### Install from VSIX

1. Download the `.vsix` from [GitHub Releases](https://github.com/evdanil/vscode-NexTerminal/releases)
2. In VS Code: `Extensions` > `...` > `Install from VSIX...`
3. Open the **Nexus** sidebar (activity bar icon)

### Add a Server

1. Click `+` in the Connectivity Hub title bar, or run `Nexus: Add Server` from the command palette
2. Enter host, port, username, and authentication details
3. Right-click the server and select **Connect** to open a terminal session

### Add a Serial Device

1. Click the serial icon in the Connectivity Hub title bar, or run `Nexus: Add Serial Profile`
2. Use **Scan Serial Ports** to discover available ports
3. Configure baud rate, data bits, parity, and stop bits
4. Right-click the profile and select **Connect**

### Set Up Port Forwarding

1. Switch to the **Port Forwarding** section in the sidebar
2. Click `+` to add a tunnel profile (local port, remote host, remote port, SSH server)
3. Right-click the tunnel and select **Start**
4. Alternatively, drag a tunnel profile onto a server in the Connectivity Hub

### Export / Import Configuration

- Run `Nexus: Export Configuration` to save all profiles and settings to a JSON file
- Run `Nexus: Import Configuration` to restore from a backup (merge or replace)

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
| `nexus.logging.maxFileSizeMb` | `10` | Max log file size before rotation |
| `nexus.logging.maxRotatedFiles` | `1` | Number of rotated log files to keep |
| `nexus.logging.sessionTranscripts` | `true` | Enable session transcript logging |
| `nexus.logging.sessionLogDirectory` | *(extension storage)* | Custom directory for session logs |
| `nexus.tunnel.defaultConnectionMode` | `isolated` | `isolated` or `shared` SSH mode for tunnels |

## Documentation

See [docs/functional-documentation.md](docs/functional-documentation.md) for detailed architecture and design documentation.

## License

[MIT](LICENSE)
