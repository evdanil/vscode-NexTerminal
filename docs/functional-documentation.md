# Nexus Terminal Functional Documentation

## 1. Product Goal
Nexus Terminal provides one operational surface in VS Code for:
- SSH terminals
- SSH port-forwarding tunnels
- Serial connectivity through isolated sidecar IPC

## 2. Implemented Architecture

### 2.1 Core Components
- `NexusCore` (`src/core/nexusCore.ts`): state manager for servers, tunnel profiles, active sessions, active tunnels.
- `SilentAuthSshFactory` (`src/services/ssh/silentAuth.ts`): credential loop with `SecretStorage` and keyboard-interactive 2FA support.
- `Ssh2Connector` (`src/services/ssh/ssh2Connector.ts`): concrete SSH transport.
- `TunnelManager` (`src/services/tunnel/tunnelManager.ts`): local TCP listeners + SSH forwarding.
- `SerialSidecarManager` (`src/services/serial/serialSidecarManager.ts`): JSON-RPC sidecar client.
- `serialSidecarWorker` (`src/services/serial/serialSidecarWorker.ts`): isolated process runtime.

### 2.2 Isolation Model
- Every interactive SSH terminal uses its own SSH connection (`SshPty`).
- Tunnels default to shared mode: all TCP clients reuse a single SSH connection. Isolated mode (one SSH connection per client) is available as a per-profile or global setting.
- Serial code executes outside the extension host process.

## 3. Data Models
- `ServerConfig` and `TunnelProfile` defined in `src/models/config.ts`.
- `SerialProfile` defined in `src/models/config.ts` (`path`, `baudRate`, `dataBits`, `stopBits`, `parity`, `rtscts`, optional `group`).
- Persisted via `VscodeConfigRepository` into `globalState`.
- Password secrets persisted via VS Code `SecretStorage` using key pattern `password-${serverId}`.

## 4. User Workflows

### 4.1 Server Management
1. Run `Nexus: Add Server` (or use the unified `Nexus: Add Profile` form).
2. Fill host/auth details.
3. Server appears in **Command Center**.
4. Right-click server item to connect/disconnect/edit/remove/duplicate/rename.

### 4.2 Silent Auth (Password mode)
1. Lookup in secret vault.
2. Attempt login.
3. On auth reject, delete stored secret.
4. Prompt user for new password and optional save.
5. Retry with new secret.

### 4.3 SSH Authentication
Supported authentication types:
- **Password** — stored in VS Code SecretStorage, auto-filled on reconnect.
- **Private key** — reads key file from disk, prompts for passphrase if encrypted.
- **SSH agent** — delegates to the system SSH agent via `SSH_AUTH_SOCK`.

All auth types support **keyboard-interactive 2FA**: `tryKeyboard` is enabled globally so servers can request verification codes after primary auth. When an `InputPromptFn` is provided (wired to `vscode.window.showInputBox` in production), the handler auto-fills password-like prompts and shows an input box for all other prompts (e.g., OTP codes).

### 4.4 SSH Terminal Session
1. Run `Nexus: Connect Server` (or context action).
2. A custom PTY terminal is created (`Nexus SSH: <server>`).
3. Terminal opens in the panel or an editor tab based on `nexus.terminal.openLocation`.
4. Session appears in **Command Center**.
5. Output/input logs are written under extension global storage logs.

### 4.5 Tunnel Patch Bay
1. Create tunnel profile with `Nexus: Add Tunnel`. Choose tunnel type from the dropdown:
   - **Local Forward (-L)**: local TCP listener forwards to a remote target through SSH.
   - **Reverse Forward (-R)**: the remote SSH server listens and forwards incoming connections back to a local target.
   - **Dynamic SOCKS5 (-D)**: local SOCKS5 proxy routes connections through SSH to arbitrary destinations.
2. Assign a default server, or leave unassigned to choose at start time.
3. Start a tunnel from **Port Forwarding** (right-click > Start), or drag it onto a server in **Command Center**.
4. In shared mode (default), the SSH connection is established eagerly at tunnel start — 2FA happens once upfront.
5. Active tunnels show traffic counters (bytes in/out).
6. **Tunnel Monitor** panel shows live route, type, server, counters, and start time.
7. Connection mode can be profile-based: `isolated`, `shared`, or `ask every start`. Reverse tunnels always use shared mode.
8. Right-click tunnel item to start/stop/restart/edit/remove/duplicate/copy info/open in browser.
9. Tree view indicates tunnel type with prefix: `R` for reverse, `D` for dynamic SOCKS5.
10. Cross-window tunnel visibility: all three tunnel types are registered in globalState and visible across VS Code windows.

### 4.6 Serial Sidecar
1. Create a serial profile with `Nexus: Add Serial Profile` (name + group + line settings).
2. Profiles appear in **Command Center** and support right-click connect/edit/remove/duplicate/rename.
3. Run `Nexus: Connect Serial Port` (or item context action) to open an interactive serial terminal.
4. Active serial sessions are shown under the profile node in **Command Center**.
5. Use `Nexus: Disconnect Serial Session` from profile/session context menu or command.
6. `Nexus: List Serial Ports` reports detected ports and manufacturers for diagnostics.

### 4.7 Logging and Rotation
1. Terminal and tunnel event logs are enabled automatically.
2. Each log file rotates when it reaches configured max size.
3. Rotation defaults: `10MB` file size and `1` rotated file.
4. Session transcript logs record clean terminal output with ANSI escape sequences and control characters stripped.
5. Settings:
   - `nexus.logging.maxFileSizeMb`
   - `nexus.logging.maxRotatedFiles` (`0-99`)
   - `nexus.logging.sessionTranscripts` (enable/disable)
   - `nexus.logging.sessionLogDirectory` (custom path)

### 4.8 Group Management
- Servers and serial profiles can be organized into named groups.
- Drag and drop items between groups in the Command Center.
- Right-click a group to rename or remove it.
- Groups can be created from the `+` menu or inline while editing a profile.

### 4.9 Terminal Macros
- Define named macros in `nexus.terminal.macros` settings (name + text + optional `keybinding`).
- Macros appear in the **Terminal Macros** sidebar view (`nexusMacros`).
- Click the play button or the label to send macro text to the active terminal.
- Press `Alt+S` to open a quick pick of all macros.
- Each macro can have an explicit `keybinding` such as `alt+m`, `alt+shift+5`, or `ctrl+shift+a`. Right-click a macro and select **Assign Shortcut** to edit it.
- Conflict resolution: assigning a shortcut already taken by another macro clears the old assignment.
- Macros without a shortcut remain available via the `Alt+S` quick pick.
- Add `triggerPattern` to enable auto-trigger (expect/send). Matching terminal output sends the macro text automatically, with optional per-macro `triggerCooldown`.
- Add `triggerInterval` for polling-style macros. Once the prompt matches again, the macro is armed and can fire on this interval without extra user input.
- Add `triggerInitiallyDisabled` when a macro should start paused until you manually resume it from the macros view. If the prompt already matched recently, resuming can fire immediately without extra terminal output.
- Auto-trigger can be paused/resumed per macro from the macros view, and globally toggled with `nexus.terminal.macros.autoTrigger`.
- Legacy `slot` values are still read and auto-migrated to `keybinding` on startup.
- Add, edit, remove, reorder, pause/resume auto-trigger, and assign shortcuts via the context menu.

### 4.10 Configuration Export/Import
- `Nexus: Export Configuration` saves all server, tunnel, and serial profiles to a JSON file.
- `Nexus: Import Configuration` restores from a backup with merge or replace options.

## 5. Settings Reference

### 5.1 SSH

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `nexus.ssh.trustNewHosts` | boolean | `true` | — | Auto-trust host keys on first connection (TOFU) |
| `nexus.ssh.multiplexing.enabled` | boolean | `true` | — | Share SSH connections across terminals, tunnels, and SFTP |
| `nexus.ssh.multiplexing.idleTimeout` | number | `300` | 0–3600 s | Idle timeout before closing a multiplexed connection |
| `nexus.ssh.connectionTimeout` | number | `60` | 5–300 s | SSH handshake timeout |
| `nexus.ssh.keepaliveInterval` | number | `10` | 0–300 s | Interval between keepalive packets (`0` disables) |
| `nexus.ssh.keepaliveCountMax` | number | `3` | 1–30 | Missed keepalives before the connection is treated as dead |
| `nexus.ssh.terminalType` | enum | `xterm-256color` | `xterm-256color`, `xterm`, `vt100`, `vt220`, `dumb` | `$TERM` value reported to the remote shell |
| `nexus.ssh.proxyTimeout` | number | `60` | 5–300 s | SOCKS5 / HTTP CONNECT proxy handshake timeout |

### 5.2 SFTP

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `nexus.sftp.cacheTtlSeconds` | number | `10` | 0–3600 s | Directory listing cache TTL |
| `nexus.sftp.maxCacheEntries` | number | `500` | 0–10000 | Maximum cached directory listings |
| `nexus.sftp.autoRefreshInterval` | number | `10` | 0–3600 s | Auto-refresh interval for the file explorer |
| `nexus.sftp.operationTimeout` | number | `30` | 5–300 s | Timeout for SFTP metadata operations (listing, stat, rename, delete) |
| `nexus.sftp.commandTimeout` | number | `300` | 10–3600 s | Timeout for remote shell commands and file transfers |
| `nexus.sftp.deleteDepthLimit` | number | `100` | 10–500 levels | Safety limit: max directory depth for recursive delete |
| `nexus.sftp.deleteOperationLimit` | number | `10000` | 100–100000 | Safety limit: max items removed by one recursive delete |

### 5.3 Tunnels

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `nexus.tunnel.defaultConnectionMode` | enum | `shared` | `shared`, `isolated` | SSH connection mode for tunnels |
| `nexus.tunnel.defaultBindAddress` | string | `127.0.0.1` | — | Default bind address for reverse tunnels |
| `nexus.tunnel.socks5HandshakeTimeout` | number | `10` | 2–60 s | Dynamic tunnel SOCKS5 handshake timeout |

### 5.4 Terminal

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `nexus.terminal.openLocation` | enum | `panel` | `panel`, `editor` | Where to open terminals |
| `nexus.terminal.keyboardPassthrough` | boolean | `false` | — | Pass Ctrl+ key combinations to the terminal |
| `nexus.terminal.passthroughKeys` | array | `[b,e,g,j,k,n,o,p,r,w]` | — | Which Ctrl+ keys to pass through |
| `nexus.terminal.macros` | array | `[]` | — | Terminal macros with optional `keybinding`, `triggerPattern`, `triggerCooldown`, `triggerInterval`, `triggerInitiallyDisabled` |
| `nexus.terminal.macros.autoTrigger` | boolean | `true` | — | Enable auto-trigger for macros with a `triggerPattern` |
| `nexus.terminal.macros.defaultCooldown` | number | `3` | 0–300 s | Default cooldown for auto-trigger macros |
| `nexus.terminal.macros.bufferLength` | number | `2048` | 256–16384 chars | Max characters retained per terminal for pattern matching |
| `nexus.terminal.highlighting.enabled` | boolean | `true` | — | Enable regex-based terminal highlighting |

### 5.5 Logging

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `nexus.logging.sessionTranscripts` | boolean | `true` | — | Enable session transcript logging |
| `nexus.logging.sessionLogDirectory` | string | *(extension storage)* | — | Custom directory for session logs |
| `nexus.logging.maxFileSizeMb` | number | `10` | 1–100 MB | Max log file size before rotation |
| `nexus.logging.maxRotatedFiles` | number | `1` | 0–99 | Number of rotated log files to keep |

### 5.6 Serial

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `nexus.serial.rpcTimeout` | number | `10` | 2–60 s | Timeout for serial sidecar commands |

### 5.7 UI

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `nexus.ui.showTreeDescriptions` | boolean | `true` | Show connection details beside items in the Connectivity Hub |

## 6. Commands and Views

### 6.1 Views
- `nexusCommandCenter`: servers, serial profiles, and active sessions.
- `nexusTunnels`: tunnel profiles and active traffic state.
- `nexusTunnelMonitor`: dedicated traffic/status panel for active tunnels.
- `nexusMacros`: terminal macros with optional custom keyboard shortcuts and auto-trigger state.
- `nexusSettings`: extension settings sidebar panel.

### 6.2 Commands
**Server:**
- `nexus.server.add`, `nexus.server.edit`, `nexus.server.remove`
- `nexus.server.connect`, `nexus.server.disconnect`
- `nexus.server.copyInfo`, `nexus.server.duplicate`, `nexus.server.rename`

**Group:**
- `nexus.group.add`, `nexus.group.remove`, `nexus.group.rename`
- `nexus.group.connect`, `nexus.group.disconnect`

**Tunnel:**
- `nexus.tunnel.add`, `nexus.tunnel.edit`, `nexus.tunnel.remove`
- `nexus.tunnel.start`, `nexus.tunnel.stop`, `nexus.tunnel.restart`
- `nexus.tunnel.copyInfo`, `nexus.tunnel.duplicate`, `nexus.tunnel.openBrowser`

**Serial:**
- `nexus.serial.add`, `nexus.serial.edit`, `nexus.serial.remove`
- `nexus.serial.connect`, `nexus.serial.disconnect`
- `nexus.serial.copyInfo`, `nexus.serial.duplicate`, `nexus.serial.rename`
- `nexus.serial.listPorts`

**Profile:**
- `nexus.profile.add` (unified add form)

**Macros:**
- `nexus.macro.add`, `nexus.macro.edit`, `nexus.macro.remove`
- `nexus.macro.run` (Alt+S quick pick)
- `nexus.macro.runBinding` (explicit shortcut dispatch)
- `nexus.macro.runItem` (tree item click/play button)
- `nexus.macro.assignSlot` (assign/remove custom shortcut via context menu)
- `nexus.macro.moveUp`, `nexus.macro.moveDown`
- `nexus.macro.disableTrigger`, `nexus.macro.enableTrigger`

**Config:**
- `nexus.config.export`, `nexus.config.import`

**Settings:**
- `nexus.settings.edit`, `nexus.settings.reset`
- `nexus.settings.openJson`, `nexus.settings.openLogDir`

**General:**
- `nexus.refresh`

## 7. Test Strategy

### 7.1 Unit Tests
- `test/unit/silentAuth.test.ts`: vault reuse, auth retry, cancellation, non-password auth path.
- `test/unit/nexusCore.test.ts`: repository load, CRUD, session/tunnel lifecycle updates.

### 7.2 Integration Tests
- `test/integration/tunnelManager.integration.test.ts`: local/reverse/dynamic tunnel forwarding through real TCP sockets, SOCKS5 handshake, and traffic event verification.
- `test/integration/serialSidecarManager.integration.test.ts`: sidecar request/response and notification flow with a mock worker process.

Run:
```bash
npm test
```

## 8. MVP Coverage vs Spec

Implemented (~90% target):
- Hybrid architecture with serial sidecar process.
- Nexus core state manager.
- Silent Auth workflow with secret invalidation + save/retry.
- Two-factor authentication (keyboard-interactive) for all SSH auth types.
- Tunnel Patch Bay model with drag/drop start and eager shared connection.
- Dedicated Tunnel Monitor sidebar panel for active tunnel traffic/status.
- Dedicated terminal/tunnel connection model.
- Interactive serial terminal sessions through sidecar-managed ports.
- Session transcript logging with ANSI stripping and rotation.
- Configuration export/import.
- Browser-host fallback entrypoint with safe "desktop required" UX instead of activation failure.
- Build/test/packaging scripts.

Deferred (~10%):
- Full browser-host feature parity for Node-dependent runtime features.
