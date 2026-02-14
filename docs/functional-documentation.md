# Nexus Terminal Functional Documentation

## 1. Product Goal
Nexus Terminal provides one operational surface in VS Code for:
- SSH terminals
- SSH port-forwarding tunnels
- Serial connectivity through isolated sidecar IPC

Design principle: reliability over resource sharing.

## 2. Implemented Architecture

### 2.1 Core Components
- `NexusCore` (`src/core/nexusCore.ts`): state manager for servers, tunnel profiles, active sessions, active tunnels.
- `SilentAuthSshFactory` (`src/services/ssh/silentAuth.ts`): credential loop with `SecretStorage`.
- `Ssh2Connector` (`src/services/ssh/ssh2Connector.ts`): concrete SSH transport.
- `TunnelManager` (`src/services/tunnel/tunnelManager.ts`): local TCP listeners + SSH forwarding.
- `SerialSidecarManager` (`src/services/serial/serialSidecarManager.ts`): JSON-RPC sidecar client.
- `serialSidecarWorker` (`src/services/serial/serialSidecarWorker.ts`): isolated process runtime.

### 2.2 Isolation Model
- Every interactive SSH terminal uses its own SSH connection (`SshPty`).
- Every tunnel proxy request opens an independent SSH forward connection.
- Serial code executes outside the extension host process.

## 3. Data Models
- `ServerConfig` and `TunnelProfile` defined in `src/models/config.ts`.
- Persisted via `VscodeConfigRepository` into `globalState`.
- Password secrets persisted via VS Code `SecretStorage` using key pattern `password-${serverId}`.

## 4. User Workflows

### 4.1 Server Management
1. Run `Nexus: Add Server`.
2. Fill host/auth details.
3. Server appears in **Command Center**.

### 4.2 Silent Auth (Password mode)
1. Lookup in secret vault.
2. Attempt login.
3. On auth reject, delete stored secret.
4. Prompt user for new password and optional save.
5. Retry with new secret.

### 4.3 SSH Terminal Session
1. Run `Nexus: Connect Server` (or context action).
2. A custom PTY terminal is created (`Nexus SSH: <server>`).
3. Session appears in **Command Center**.
4. Output/input logs are written under extension global storage logs.

### 4.4 Tunnel Patch Bay
1. Create tunnel profile with `Nexus: Add Tunnel`.
2. Connect a server session first.
3. Drag tunnel from **Tunnel Patch Bay** onto a server in **Command Center**.
4. Tunnel starts as local listener and forwards to remote destination.
5. Active tunnels show traffic counters (bytes in/out).
6. **Tunnel Monitor** panel shows live route, server, counters, and start time.

### 4.5 Serial Sidecar
1. Run `Nexus: List Serial Ports`.
2. Extension asks sidecar process over JSON-RPC.
3. Sidecar returns ports (empty when `serialport` module is unavailable).
4. Run `Nexus: Connect Serial Port` to open an interactive serial terminal.
5. Use `Nexus: Disconnect Serial Session` to close an active serial terminal session.

## 5. Commands and Views

### 5.1 Views
- `nexusCommandCenter`: servers and active sessions.
- `nexusTunnels`: tunnel profiles and active traffic state.
- `nexusTunnelMonitor`: dedicated traffic/status panel for active tunnels.

### 5.2 Commands
- `nexus.refresh`
- `nexus.server.add`
- `nexus.server.remove`
- `nexus.server.connect`
- `nexus.server.disconnect`
- `nexus.tunnel.add`
- `nexus.tunnel.remove`
- `nexus.tunnel.start`
- `nexus.tunnel.stop`
- `nexus.serial.listPorts`
- `nexus.serial.connect`
- `nexus.serial.disconnect`

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
- Tunnel Patch Bay model with drag/drop start.
- Dedicated Tunnel Monitor sidebar panel for active tunnel traffic/status.
- Dedicated terminal/tunnel connection model.
- Interactive serial terminal sessions through sidecar-managed ports.
- Logging for terminal/tunnel events.
- Build/test/packaging scripts.

Deferred (~10%):
- Full browser-host feature parity for Node-dependent runtime features.
