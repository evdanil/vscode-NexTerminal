# CLAUDE.md

@AGENTS.md

The import above carries the shared rules — commands, build constraints, commit/release traps, testing standard, and an architecture summary. This file holds only the deep architecture detail and Claude-specific workflow.

## Claude Code specifics

- **Coding delegation:** Delegate implementation work (fixes, features, refactors) to an Opus-based expert sub-agent (`Agent` tool with `model: "opus"`) unless the user explicitly requests otherwise. Research, planning, and code-review agents may use their default models.
- Feature development uses git worktrees in the `.worktrees/` directory for isolation from the main working tree.

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
- **Scripts** (`ScriptRuntimeManager`): Each running script lives in its own `node:worker_threads` Worker (separate V8 isolate, same process). IPC is structured-clone `postMessage` with a pending-Promise map keyed by monotonic request id. Workers are killed via `worker.terminate()` — preempts tight JS loops at V8 safe points in single-digit ms. Three isolation tiers: in-process (SSH), worker-thread (Scripts — cheap, fast-kill), child-process (Serial — crash-isolates native addons)

### Auth flow: `SilentAuthSshFactory`
Tries saved password from `VscodeSecretVault` → falls back to `VscodePasswordPrompt` → optionally saves to vault. On auth failure, invalidates cached password and re-prompts.

### Storage
`ConfigRepository` interface with two implementations:
- `VscodeConfigRepository` — production, uses `globalState` with keys `nexus.servers`, `nexus.tunnels`, `nexus.serialProfiles`
- `InMemoryConfigRepository` — tests

Passwords stored separately via VS Code `SecretStorage` with key pattern `password-{serverId}`.

Cross-window writes: `globalState` is shared across VS Code windows, last-writer-wins, no compare-and-swap — and every `save*` persists the whole collection list, so a save from one window can overwrite another window's edit to the same collection. `VscodeConfigRepository` keeps both the actual Memento cache object and an immutable JSON snapshot as its per-key baseline; when the cache object is replaced by a foreign writer and the stored value differs from both the baseline and the pending save, it warns through `onConcurrentOverwrite`. The hook reports storage divergence, not who caused it; the write still proceeds, so the loss is surfaced rather than prevented (prevention isn't possible at the Memento layer). Full semantics and residual gaps are in the doc comment atop `vscodeConfigRepository.ts`.

### UI components
- **NexusTreeProvider**: Command Center sidebar — servers, sessions, serial profiles. Supports drag-and-drop of tunnel profiles onto servers
- **TunnelTreeProvider**: Port Forwarding — tunnel profiles with live traffic counters
- **TunnelMonitorViewProvider**: Webview panel rendering tunnel status HTML (no scripts, static render via `renderTunnelMonitorHtml()`)

### Data models (`src/models/config.ts`)
`ServerConfig`, `TunnelProfile`, `SerialProfile` — persisted configs
`ActiveSession`, `ActiveTunnel`, `ActiveSerialSession` — runtime state tracked by NexusCore

### Web extension (`webExtension.ts`)
Graceful degradation — registers stub commands showing "not available in browser" warnings. Intentional MVP gap.

## Scripts subsystem (`src/services/scripts/`)

- `scriptRuntimeManager.ts` — main-thread orchestrator. Holds `Map<sessionId, RunningScript>`, dispatches RPC from worker, manages lifecycle (starting → running → completed/stopped/failed/connection-lost → cleanup).
- `scriptWorker.ts` — bundled separately to `dist/services/scripts/scriptWorker.js`. Loads user `.js` source via the `AsyncFunction` constructor and exposes the script API (`waitFor` / `expect` / `sendLine` / `poll` / `prompt` / etc.) as globals that post RPCs back to the main thread. MUST NOT import `vscode` (see the build constraint in AGENTS.md — the build does not catch this for this bundle).
- `scriptOutputBuffer.ts` — rolling 64 KiB string buffer with forward-only cursor; ANSI stripped at write time via `createAnsiRegex()`.
- `scriptHeader.ts` — JSDoc header parser (`@nexus-script`, `@name`, `@target-type`, `@default-timeout`, `@lock-input`, `@allow-macros`).
- `scriptTarget.ts` — session picker. Filters by `@target-type`, auto-selects on `@target-profile` match.
- `scriptMacroFilter.ts` — per-session policy that gates macro firing during a script run.
- `scriptTypesGenerator.ts` — writes `nexus-scripts.d.ts` + `jsconfig.json` into the workspace's scripts directory on first script command so IntelliSense/hovers work.
- `assets/` — bundled `nexus-scripts.d.ts` + `jsconfig.json` copied by the esbuild step into `dist/services/scripts/assets/`.
- UI surfaces: `src/ui/scriptTreeProvider.ts` (Scripts sidebar entry), `src/ui/scriptCodeLensProvider.ts` (inline ▶ Run / ◼ Stop), status bar item in `extension.ts:activate()`. Output Channel: `"Nexus Scripts"`.
- Macro coordination: `MacroAutoTrigger` has `pushFilter(sessionId, filter)` / `bindObserverToSession(obs, id)` / `createObserver(..., sessionId?)` so scripts can suspend macros on their session without touching unrelated sessions.
- PTY integration: `SshPty`, `SmartSerialPty`, `SerialPty` all implement `SessionPtyHandle` — `addOutputObserver(o): Disposable`, `setInputBlocked(bool)`, `writeProgrammatic(data)`, `resetTerminal()`, `markShuttingDown(reason)`. `markShuttingDown` fires from the deactivate subscription; it tears down the transport and fires a farewell banner, **but VS Code's IPC race on extension-host shutdown means the banner rarely reaches the renderer** (see microsoft/vscode#122825, #140697). The reliable mechanism is `services/terminal/orphanDetect.ts` (`detectOrphanNexusTerminals`), called as the first thing in `activate()` — it scans `vscode.window.terminals` for `/Nexus (SSH|Serial):/` and, if any match, shows an information notification. Orphans are intentionally NOT disposed: the last-rendered content is usually worth reviewing, and VS Code has no API to rewrite or append to a dead pseudoterminal from a new extension instance, so the only available action would be to destroy the content. Closing is the user's call. The handle is exposed on `ActiveSession.pty` / `ActiveSerialSession.pty` (runtime-only; not persisted).
- Settings: `nexus.scripts.path`, `nexus.scripts.defaultTimeout`, `nexus.scripts.macroPolicy` — captured into each `RunningScript` at start; changes do not apply to in-flight runs.

## Terminal tab commands subsystem (`src/services/terminal/` + `src/commands/terminalTabCommands.ts`)

- `TerminalCaptureBuffer` — line-based ring buffer, per Nexus terminal. ANSI sequences and C0 control characters (except `\n`, `\r`, `\t`) stripped on ingest via `createAnsiRegex()` + a local `CONTROL_CHAR_RE`. Line cap seeded from `terminal.integrated.scrollback` and updated via `workspace.onDidChangeConfiguration`. Partial lines retained in `pending` and included in `getText()`.
- `TerminalRegistry` — maps `vscode.Terminal` → `{ pty, buffer }` for Nexus-owned terminals (SSH / Standard Serial / Smart Follow / Local Shell). Subscribes to `window.onDidChangeActiveTerminal`, `window.onDidCloseTerminal`, and `NexusCore.onDidChange`. Drives two context keys: `nexus.isNexusTerminal` (menu visibility) and `nexus.isNexusTerminalConnected` (enablement of Reset + Clear Scrollback). Connected state is derived by pty-reference identity against `NexusCore.getSnapshot()` active sessions.
- `terminalEscapes.ts` — exports `CLEAR_VISIBLE_SCREEN = "\x1b[H\x1b[2J"`, shared by `resetTerminal()` on all PTY classes. Reset fires through the local `writeEmitter` only (never to the transport), so the remote shell state stays untouched.
- `terminalTabCommands.ts` — registers `nexus.terminal.reset`, `nexus.terminal.clearScrollback`, `nexus.terminal.copyAll`. Clear Scrollback runs `buffer.clear()` before `workbench.action.terminal.clear` so Copy All stays consistent even if the built-in call fails. External clears (e.g., VS Code's own) do NOT touch the buffer — only `nexus.terminal.clearScrollback` does.
- Lifecycle: `TerminalRegistry.register(terminal, pty)` is called in the SSH connect path (`serverCommands.ts`), both serial connect paths (`serialCommands.ts`), and the local-shell connect path immediately after `vscode.window.createTerminal(...)`. `unregister` fires from `onDidCloseTerminal`; disconnect does NOT unregister (FR-011 — Copy All remains usable until the tab is closed).

## Testing patterns

- Unit tests mock the VS Code API and use `InMemoryConfigRepository`
- Integration tests for `SerialSidecarManager` spawn real child processes; `TunnelManager` tests use real TCP sockets; network-server tests use mock daemons from `test/fixtures/`
