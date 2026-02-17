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
1. Create tunnel profile with `Nexus: Add Tunnel`.
2. Assign a default server, or leave unassigned to choose at start time.
3. Start a tunnel from **Port Forwarding** (right-click > Start), or drag it onto a server in **Command Center**.
4. In shared mode (default), the SSH connection is established eagerly at tunnel start — 2FA happens once upfront.
5. Active tunnels show traffic counters (bytes in/out).
6. **Tunnel Monitor** panel shows live route, server, counters, and start time.
7. Connection mode can be profile-based: `isolated`, `shared`, or `ask every start`.
8. Right-click tunnel item to start/stop/restart/edit/remove/duplicate/copy info/open in browser.

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
- Define named macros in `nexus.terminal.macros` settings (name + text + optional slot).
- Macros appear in the **Terminal Macros** sidebar view (`nexusMacros`).
- Click the play button or the label to send macro text to the active terminal.
- Press `Alt+S` to open a quick pick of all macros.
- Press `Alt+1` through `Alt+0` to trigger macros by slot assignment.
- **Slot assignment:** each macro can have an explicit `slot` (0-9) binding it to a specific `Alt+N` shortcut. Right-click a macro and select **Assign Shortcut** to pick a slot. If no macros have explicit slots, the first 10 macros auto-assign positionally (legacy mode).
- Conflict resolution: assigning a slot already taken by another macro clears the old assignment.
- Add, edit, remove, reorder, and assign shortcuts via the context menu.

### 4.10 Configuration Export/Import
- `Nexus: Export Configuration` saves all server, tunnel, and serial profiles to a JSON file.
- `Nexus: Import Configuration` restores from a backup with merge or replace options.

## 5. Commands and Views

### 5.1 Views
- `nexusCommandCenter`: servers, serial profiles, and active sessions.
- `nexusTunnels`: tunnel profiles and active traffic state.
- `nexusTunnelMonitor`: dedicated traffic/status panel for active tunnels.
- `nexusMacros`: terminal macros with slot-based keyboard shortcuts.
- `nexusSettings`: extension settings sidebar panel.

### 5.2 Commands
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
- `nexus.macro.slot` (Alt+1–Alt+0 keybinding dispatch)
- `nexus.macro.runItem` (tree item click/play button)
- `nexus.macro.assignSlot` (assign Alt+N shortcut via context menu)
- `nexus.macro.moveUp`, `nexus.macro.moveDown`

**Config:**
- `nexus.config.export`, `nexus.config.import`

**Settings:**
- `nexus.settings.edit`, `nexus.settings.reset`
- `nexus.settings.openJson`, `nexus.settings.openLogDir`

**General:**
- `nexus.refresh`

## 6. Test Strategy

### 6.1 Unit Tests
- `test/unit/silentAuth.test.ts`: vault reuse, auth retry, cancellation, non-password auth path.
- `test/unit/nexusCore.test.ts`: repository load, CRUD, session/tunnel lifecycle updates.

### 6.2 Integration Tests
- `test/integration/tunnelManager.integration.test.ts`: local echo-server forwarding through real TCP sockets and traffic event verification.
- `test/integration/serialSidecarManager.integration.test.ts`: sidecar request/response and notification flow with a mock worker process.

Run:
```bash
npm test
```

## 7. MVP Coverage vs Spec

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
