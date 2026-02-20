# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run build          # Clean + type-check + esbuild bundle to dist/
npm run build:production  # Same but minified, no sourcemaps
npm run compile        # Type-check only (no emit)
npm run watch          # Watch mode type-checking
npm run package:vsix   # Production build + package as installable VSIX
npm test               # Run all tests with coverage
npm run test:unit      # Run unit tests only (test/unit/)
npm run test:integration  # Run integration tests only (test/integration/)
```

To run a single test file: `npx vitest run test/unit/nexusCore.test.ts`
To run tests matching a pattern: `npx vitest run -t "pattern"`

## Tech Stack

- **Runtime:** VS Code Extension (desktop + web fallback)
- **Language:** TypeScript (strict, ES2022 target, CommonJS output)
- **Test framework:** Vitest with v8 coverage
- **Bundler:** esbuild (bundles all source + pure-JS deps; native `serialport` stays external)
- **No linter/formatter** configured

## Architecture

Layered architecture with observer-driven state synchronization:

```
extension.ts (command wiring + DI)
    ↓
NexusCore (src/core/nexusCore.ts) — single source of truth
    ↓ emits changes via onDidChange()
UI Layer ← snapshots → Tree/Webview providers refresh
    ↓
Service Layer — SSH (in-process), Serial (out-of-process sidecar), Tunnels
    ↓
Storage Layer — ConfigRepository interface (VS Code globalState or in-memory for tests)
```

### Key wiring: `extension.ts:activate()`
All services are instantiated and wired in the `activate()` function. NexusCore observers propagate state changes to UI providers. Service event emitters (TunnelManager, SerialSidecarManager) feed back into NexusCore to register/unregister active sessions.

### Core state: `NexusCore`
Observer pattern hub. Holds servers, tunnel profiles, serial profiles, and all active sessions/tunnels in memory. Persists config changes through `ConfigRepository`. UI consumers call `getSnapshot()` for immutable state views.

### Service isolation model
- **SSH terminals** (`SshPty`): Each terminal gets its own SSH connection via `SilentAuthSshFactory` → `Ssh2Connector`
- **Tunnels** (`TunnelManager`): Local TCP listener forwards to remote via SSH. Two modes: `isolated` (new SSH connection per client) or `shared` (single SSH connection)
- **Serial** (`SerialSidecarManager`): Spawns `serialSidecarWorker.js` child process. Communicates via JSON-RPC over stdio. Native `serialport` module runs outside extension host for crash isolation

### Auth flow: `SilentAuthSshFactory`
Tries saved password from `VscodeSecretVault` → falls back to `VscodePasswordPrompt` → optionally saves to vault. On auth failure, invalidates cached password and re-prompts.

### Storage
`ConfigRepository` interface with two implementations:
- `VscodeConfigRepository` — production, uses `globalState` with keys `nexus.servers`, `nexus.tunnels`, `nexus.serialProfiles`
- `InMemoryConfigRepository` — tests

Passwords stored separately via VS Code `SecretStorage` with key pattern `password-{serverId}`.

### UI components
- **NexusTreeProvider**: Command Center sidebar — servers, sessions, serial profiles. Supports drag-and-drop of tunnel profiles onto servers
- **TunnelTreeProvider**: Port Forwarding — tunnel profiles with live traffic counters
- **TunnelMonitorViewProvider**: Webview panel rendering tunnel status HTML (no scripts, static render via `renderTunnelMonitorHtml()`)

### Data models (`src/models/config.ts`)
`ServerConfig`, `TunnelProfile`, `SerialProfile` — persisted configs
`ActiveSession`, `ActiveTunnel`, `ActiveSerialSession` — runtime state tracked by NexusCore

### Web extension (`webExtension.ts`)
Graceful degradation — registers stub commands showing "not available in browser" warnings. Intentional MVP gap.

## Development Workflow

- Feature development uses git worktrees in the `.worktrees/` directory for isolation from the main working tree

## Testing Patterns

- Unit tests mock VS Code API and use `InMemoryConfigRepository`
- Integration tests for `SerialSidecarManager` spawn real child processes
- Integration tests for `TunnelManager` use real TCP sockets
- Test fixtures in `test/fixtures/` (mock sidecar scripts)
