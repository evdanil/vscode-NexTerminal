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
- **Scripts** (`ScriptRuntimeManager`): Each running script lives in its own `node:worker_threads` Worker (separate V8 isolate, same process). IPC is structured-clone `postMessage` with a pending-Promise map keyed by monotonic request id. Workers are killed via `worker.terminate()` — preempts tight JS loops at V8 safe points in single-digit ms. Three isolation tiers total now: in-process (SSH), worker-thread (Scripts — cheap, fast-kill), child-process (Serial — crash-isolates native addons)

### Scripts subsystem (`src/services/scripts/`)
- `scriptRuntimeManager.ts` — main-thread orchestrator. Holds `Map<sessionId, RunningScript>`, dispatches RPC from worker, manages lifecycle (starting → running → completed/stopped/failed/connection-lost → cleanup).
- `scriptWorker.ts` — bundled separately to `dist/services/scripts/scriptWorker.js`. Loads user `.js` source via the `AsyncFunction` constructor and exposes the script API (`waitFor` / `expect` / `sendLine` / `poll` / `prompt` / etc.) as globals that post RPCs back to the main thread. MUST NOT import `vscode`.
- `scriptOutputBuffer.ts` — rolling 64 KiB string buffer with forward-only cursor; ANSI stripped at write time via `createAnsiRegex()`.
- `scriptHeader.ts` — JSDoc header parser (`@nexus-script`, `@name`, `@target-type`, `@default-timeout`, `@lock-input`, `@allow-macros`).
- `scriptTarget.ts` — session picker. Filters by `@target-type`, auto-selects on `@target-profile` match.
- `scriptMacroFilter.ts` — per-session policy that gates macro firing during a script run.
- `scriptTypesGenerator.ts` — writes `nexus-scripts.d.ts` + `jsconfig.json` into the workspace's scripts directory on first script command so IntelliSense/hovers work.
- `assets/` — bundled `nexus-scripts.d.ts` + `jsconfig.json` copied by the esbuild step into `dist/services/scripts/assets/`.
- UI surfaces: `src/ui/scriptTreeProvider.ts` (Scripts sidebar entry), `src/ui/scriptCodeLensProvider.ts` (inline ▶ Run / ◼ Stop), status bar item in `extension.ts:activate()`. Output Channel: `"Nexus Scripts"`.
- Macro coordination: `MacroAutoTrigger` gained `pushFilter(sessionId, filter)` / `bindObserverToSession(obs, id)` / extended `createObserver(..., sessionId?)` so scripts can suspend macros on their session without touching unrelated sessions.
- PTY integration: `SshPty`, `SmartSerialPty`, `SerialPty` all implement `SessionPtyHandle` — `addOutputObserver(o): Disposable`, `setInputBlocked(bool)`, `writeProgrammatic(data)`. A first dropped keystroke during `setInputBlocked(true)` emits a one-shot `[Nexus] Terminal is locked…` line via the PTY's `writeEmitter`. The handle is exposed on `ActiveSession.pty` / `ActiveSerialSession.pty` (runtime-only; not persisted).
- New settings: `nexus.scripts.path`, `nexus.scripts.defaultTimeout`, `nexus.scripts.macroPolicy`. Captured into each `RunningScript` at start — settings changes do not apply to in-flight runs.

### Terminal tab commands subsystem (`src/services/terminal/` + `src/commands/terminalTabCommands.ts`)
- `TerminalCaptureBuffer` — line-based ring buffer, per Nexus terminal. ANSI sequences and C0 control characters (except `\n`, `\r`, `\t`) stripped on ingest via `createAnsiRegex()` + a local `CONTROL_CHAR_RE`. Line cap seeded from `terminal.integrated.scrollback` and updated via `workspace.onDidChangeConfiguration`. Partial lines retained in `pending` and included in `getText()`.
- `TerminalRegistry` — maps `vscode.Terminal` → `{ pty, buffer }` for Nexus-owned terminals (SSH / Standard Serial / Smart Follow). Subscribes to `window.onDidChangeActiveTerminal`, `window.onDidCloseTerminal`, and `NexusCore.onDidChange`. Drives two context keys: `nexus.isNexusTerminal` (menu visibility) and `nexus.isNexusTerminalConnected` (enablement of Reset + Clear Scrollback). Connected state is derived by pty-reference identity against `NexusCore.getSnapshot().activeSessions` / `activeSerialSessions`.
- `terminalEscapes.ts` — exports `CLEAR_VISIBLE_SCREEN = "\x1b[H\x1b[2J"`, shared by `resetTerminal()` on all three PTY classes. Reset fires through the local `writeEmitter` only (never to the transport), so the remote shell state stays untouched.
- `terminalTabCommands.ts` — registers `nexus.terminal.reset`, `nexus.terminal.clearScrollback`, `nexus.terminal.copyAll`. Palette-invocation fallback to `vscode.window.activeTerminal`. Clear Scrollback runs `buffer.clear()` before `workbench.action.terminal.clear` so Copy All stays consistent even if the built-in call fails. External clears (e.g., VS Code's own) do NOT touch the buffer — only `nexus.terminal.clearScrollback` does.
- Lifecycle: `TerminalRegistry.register(terminal, pty)` is called in the SSH connect path (`serverCommands.ts`) and in both serial connect paths (`serialCommands.ts`) immediately after `vscode.window.createTerminal(...)`. `unregister` fires from `onDidCloseTerminal`; disconnect does NOT unregister (FR-011 — Copy All remains usable until the tab is closed).

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

## Versioning & Releases

- Every commit that will be tagged and deployed **must** bump the patch version in `package.json` (e.g. 2.7.5 → 2.7.6). The VS Code Marketplace rejects re-publishing the same version.
- Never move or re-use an existing version tag. If a fix lands after tagging, bump the patch and create a new tag.
- Tags follow `v{major}.{minor}.{patch}` format (e.g. `v2.7.6`).

## Development Workflow

- Feature development uses git worktrees in the `.worktrees/` directory for isolation from the main working tree

## Testing Patterns

- Unit tests mock VS Code API and use `InMemoryConfigRepository`
- Integration tests for `SerialSidecarManager` spawn real child processes
- Integration tests for `TunnelManager` use real TCP sockets
- Test fixtures in `test/fixtures/` (mock sidecar scripts)

## Active Technologies
- TypeScript strict, ES2022 target, CommonJS output (extension host); `node:worker_threads` Worker bundle is the same target — Node 20.x via VS Code's extension host runtime + `vscode` API; `node:worker_threads`; `AsyncFunction` constructor for user-code loading (no `node:vm` module use); no new npm dependencies (001-scripting-support)
- User script files under workspace-relative directory (default `.nexus/scripts/`); generated IntelliSense scaffolding under `<scriptsDir>/types/nexus-scripts.d.ts` + `<scriptsDir>/jsconfig.json`; new VS Code settings keys `nexus.scripts.path`, `nexus.scripts.defaultTimeout`, `nexus.scripts.macroPolicy` (additive — no migration) (001-scripting-support)

## Recent Changes
- 001-scripting-support: Added TypeScript strict, ES2022 target, CommonJS output (extension host); `node:worker_threads` Worker bundle is the same target — Node 20.x via VS Code's extension host runtime + `vscode` API; `node:worker_threads`; `AsyncFunction` constructor for user-code loading (no `node:vm` module use); no new npm dependencies
