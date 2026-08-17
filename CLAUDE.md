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
- **Network Servers** (`NetworkServerDaemonHost`): TFTP + DHCP engines share one `networkServerDaemon.js` child process. Same JSON-RPC-over-stdio plumbing as the serial sidecar, for the same reason plus two more — a pipe never collides with a user port or triggers a firewall prompt, and stdin-EOF + SIGTERM→SIGKILL guarantees no orphan holding UDP 69/67
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
- PTY integration: `SshPty`, `SmartSerialPty`, `SerialPty` all implement `SessionPtyHandle` — `addOutputObserver(o): Disposable`, `setInputBlocked(bool)`, `writeProgrammatic(data)`, `resetTerminal()`, `markShuttingDown(reason)`. A first dropped keystroke during `setInputBlocked(true)` emits a one-shot `[Nexus] Terminal is locked…` line via the PTY's `writeEmitter`. `markShuttingDown` fires from the deactivate subscription; it tears down the transport and fires a farewell banner, **but VS Code's IPC race on extension-host shutdown means the banner rarely reaches the renderer** (see microsoft/vscode#122825, #140697). The reliable mechanism is `services/terminal/orphanDetect.ts` (`detectOrphanNexusTerminals`), called as the first thing in `activate()` — it scans `vscode.window.terminals` for `/Nexus (SSH|Serial):/` and, if any match, shows an information notification. Orphans are intentionally NOT disposed: the last-rendered content is usually worth reviewing, and VS Code has no API to rewrite or append to a dead pseudoterminal from a new extension instance, so the only available action would be to destroy the content. Closing is the user's call. The handle is exposed on `ActiveSession.pty` / `ActiveSerialSession.pty` (runtime-only; not persisted).
- New settings: `nexus.scripts.path`, `nexus.scripts.defaultTimeout`, `nexus.scripts.macroPolicy`. Captured into each `RunningScript` at start — settings changes do not apply to in-flight runs.

### Terminal tab commands subsystem (`src/services/terminal/` + `src/commands/terminalTabCommands.ts`)
- `TerminalCaptureBuffer` — line-based ring buffer, per Nexus terminal. ANSI sequences and C0 control characters (except `\n`, `\r`, `\t`) stripped on ingest via `createAnsiRegex()` + a local `CONTROL_CHAR_RE`. Line cap seeded from `terminal.integrated.scrollback` and updated via `workspace.onDidChangeConfiguration`. Partial lines retained in `pending` and included in `getText()`.
- `TerminalRegistry` — maps `vscode.Terminal` → `{ pty, buffer }` for Nexus-owned terminals (SSH / Standard Serial / Smart Follow). Subscribes to `window.onDidChangeActiveTerminal`, `window.onDidCloseTerminal`, and `NexusCore.onDidChange`. Drives two context keys: `nexus.isNexusTerminal` (menu visibility) and `nexus.isNexusTerminalConnected` (enablement of Reset + Clear Scrollback). Connected state is derived by pty-reference identity against `NexusCore.getSnapshot().activeSessions` / `activeSerialSessions`.
- `terminalEscapes.ts` — exports `CLEAR_VISIBLE_SCREEN = "\x1b[H\x1b[2J"`, shared by `resetTerminal()` on all three PTY classes. Reset fires through the local `writeEmitter` only (never to the transport), so the remote shell state stays untouched.
- `terminalTabCommands.ts` — registers `nexus.terminal.reset`, `nexus.terminal.clearScrollback`, `nexus.terminal.copyAll`. Palette-invocation fallback to `vscode.window.activeTerminal`. Clear Scrollback runs `buffer.clear()` before `workbench.action.terminal.clear` so Copy All stays consistent even if the built-in call fails. External clears (e.g., VS Code's own) do NOT touch the buffer — only `nexus.terminal.clearScrollback` does.
- Lifecycle: `TerminalRegistry.register(terminal, pty)` is called in the SSH connect path (`serverCommands.ts`) and in both serial connect paths (`serialCommands.ts`) immediately after `vscode.window.createTerminal(...)`. `unregister` fires from `onDidCloseTerminal`; disconnect does NOT unregister (FR-011 — Copy All remains usable until the tab is closed).

### Network Servers subsystem (`src/services/networkServers/`)
- `networkServerManager.ts` — extension-host orchestrator. Owns the three things the daemon structurally cannot do: reading settings (daemon has no `vscode`), Workspace Trust enforcement (`assertTrusted()`), and fan-out into `NexusCore` + the `"Nexus Network Servers"` output channel. `readTftpConfig()` / `readDhcpConfig()` are exported and also called directly by the tree provider. `RUNTIME_REFRESH_DEBOUNCE_MS = 150`, `TRANSFER_HISTORY_LIMIT = 50`. Lease store path is `<globalStorage>/networkServers/dhcp-leases.json` (machine-scoped, not workspace-scoped). `toNetworkServerError` regex-maps daemon error text → `NetworkServerErrorCode`.
- `daemonHost.ts` — spawns `dist/services/networkServers/networkServerDaemon.js` via `process.execPath` + `ELECTRON_RUN_AS_NODE=1`, seeding config through the `NEXUS_NETWORK_SERVERS_CONFIG` env var so an early `list` doesn't report defaults. Newline-delimited JSON-RPC over stdio; **methods** `list` / `getStatus` / `configure` / `start` / `stop` / `restart` / `cancelTransfer` / `getServiceRuntime`; **events** `ready` / `statusChange` / `log` / `runtimeUpdate` / `connection`. RPC timeout 15 s (clamped 2–60 s), ready timeout 10 s (clamped 1–60 s). Deliberately mirrors `services/serial/serialSidecarManager.ts`.
- `networkServerDaemon.ts` — the child process. Registry + adapters, no `vscode` import anywhere in its bundle graph.
- `core/` — `NexusServer` interface, `BaseNexusServer`, `ServerRegistry`, `ServerManager`, `ServerStatus` (mirrors `NetworkServerStatus` 1:1 so wire values pass through untranslated).
- `tftp/TftpAdapter.ts` + `tftp/engine/` — `TftpEngine` (RFC 1350 RRQ/WRQ, TID = client `address:port`, `tsize` negotiation), `TransferSession`, `protocol.ts`, `PathGuard.ts` (path-traversal sandbox — **all** client-supplied filenames must go through it, never raw `fs`).
- `tftp/clientIdentity.ts` — `formatTftpClient(address, hostname?)` is the single display format (`"hostname (ip)"` / bare IP), rendered daemon-side so tree/logs/toasts never disagree. `ReverseDnsCache`: 5 min success TTL, 60 s failure TTL, 2 s hard per-lookup deadline (`dns.promises.reverse` has no timeout option on Node 20.x), in-flight dedup, fire-and-forget — a transfer never blocks on DNS.
- `dhcp/DhcpAdapter.ts` + `dhcp/engine/` — `DhcpEngine`, `dhcpBootOptions.ts` (ZTP option constants: **66** TFTP server name, **67** bootfile, **150** Cisco TFTP servers, **60** vendor class, **43** vendor-specific TLV; `MAX_OPTION_VALUE_BYTES = 255`), `dhcpLeasePersistence.ts`, `dhcpConstants.ts` (`DEFAULTS`), `dhcpNetworkUtils.ts`, `dhcpLeaseUtils.ts`.
- `runtimeUpdateThrottle.ts` — daemon-side coalescing of `runtimeUpdate` pushes.
- Models: `src/models/networkServer.ts` (runtime state only — nothing goes through `ConfigRepository`; config lives in `nexus.networkServers.*` settings), `src/models/networkServerProfile.ts` (named config snapshots, TFTP/DHCP lists independent, stored as one opaque JSON array in globalState).
- Commands: `networkServerCommands.ts` (start/stop/restart/quickAdjust/edit/inspectLogs + the full `WebviewFormPanel` form), `networkServerQuickAdjust.ts` (QuickPick editor + smart auto-fill), `networkServerTransferCommands.ts` (cancelTransfer/clearHistory), `networkServerProfileCommands.ts`, `networkServerSettings.ts` (shared validators + `dhcpDerivedAddresses`), `networkInterfaceOptions.ts` (live `os.networkInterfaces()` bind picker).
- UI: `src/ui/networkServerTreeProvider.ts`, view id `nexusNetworkServers`. Renders **only** from the `NexusCore` snapshot + synchronous settings reads — never issues its own RPC. Two context values are deliberately outside the `nexus.networkServer.` prefix (`nexus.networkServerTransfer.active`, `nexus.networkServerHistory.group`) because the service-level menu entries regex-match that prefix and would otherwise put Start/Stop on a transfer row.
- **Ghost-transfer fix** (two halves, both required). Daemon side: `TftpEngine.gcTick()` (interval 2 s) routes a timed-out transfer through `cleanupErroneous` and a `Done` straggler through `cleanupDone` — a silent `cleanup()` emits no event, so the row sat in the sidebar forever because the peer was gone and nothing would ever refresh it away. Host side: `NetworkServerManager.handleConnectionEvent` calls `refreshRuntimeNow(id)` on **any** non-`started` phase, bypassing the 150 ms coalescing debounce. That refresh runs regardless of Verbose Mode — the toast is optional, the sidebar being correct is not. History is recorded before the verbose check for the same reason.
- **Static-reservation seeding at startup**: `DhcpEngine.seedStaticReservations(server)`, called on both the preferred-port and 1067-fallback bind paths, immediately after `bindLeasePersistence`. The library's `_selectAddress` walks the range and takes the first address not in `_state`, and never consults `config.static` — so a reserved in-pool address was just a free slot until its device booted, and the first DISCOVER took it. Seeds `RESERVED_LEASE_STATE` placeholders for in-pool reservations only (out-of-pool ones never compete). Ordering matters: after persistence restore, so a reservation overwrites a conflicting persisted dynamic lease. Idempotent — an entry already holding the right address is left alone so a rebooted device keeps its `bindTime`. Placeholders are filtered out of `activeLeases()`, out of utilisation, and out of the persisted file (a persisted reservation would come back as a real lease and break idempotency).

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
- **Coding delegation:** Delegate implementation work (fixes, features, refactors) to an Opus-based expert sub-agent (`Agent` tool with `model: "opus"`) unless the user explicitly requests otherwise. Research, planning, and code-review agents may use their default models.
- **Repository hygiene (public repo):** Internal planning/design/implementation docs and local/agent config are **local-only — never commit them**. This includes `docs/plans/`, `docs/superpowers/`, `.claude/` (e.g. `settings.local.json`), `.specify/`, and `specs/*` (except the whitelisted `specs/001-scripting-support/contracts/`). All are in `.gitignore`; if any are found tracked, untrack with `git rm --cached` (keep the local copy). Author new planning docs outside version control.

## Testing Patterns

- Unit tests mock VS Code API and use `InMemoryConfigRepository`
- Integration tests for `SerialSidecarManager` spawn real child processes
- Integration tests for `TunnelManager` use real TCP sockets
- Test fixtures in `test/fixtures/` (mock sidecar scripts)

### Testing conventions

- **A test must fail against the specific wrong implementation it exists to prevent.** Before trusting a regression test, ask what happens if the fix it's guarding were reverted or never written — if the test would still pass, it's vacuous. The recurring trap: a fixture where the correct and the broken behaviour produce identical state (e.g. asserting a drop onto root left a macro's folder `undefined`, when the macro had no folder to begin with — a no-op reads the same whether the drop was correctly rejected or silently mis-processed). Construct the fixture so the buggy path visibly changes the outcome, and when in doubt, actually apply the wrong implementation and confirm the test fails before trusting it.

## Active Technologies
- TypeScript strict, ES2022 target, CommonJS output (extension host); `node:worker_threads` Worker bundle is the same target — Node 20.x via VS Code's extension host runtime + `vscode` API; `node:worker_threads`; `AsyncFunction` constructor for user-code loading (no `node:vm` module use); no new npm dependencies (001-scripting-support)
- User script files under workspace-relative directory (default `.nexus/scripts/`); generated IntelliSense scaffolding under `<scriptsDir>/types/nexus-scripts.d.ts` + `<scriptsDir>/jsconfig.json`; new VS Code settings keys `nexus.scripts.path`, `nexus.scripts.defaultTimeout`, `nexus.scripts.macroPolicy` (additive — no migration) (001-scripting-support)

## Recent Changes
- 001-scripting-support: Added TypeScript strict, ES2022 target, CommonJS output (extension host); `node:worker_threads` Worker bundle is the same target — Node 20.x via VS Code's extension host runtime + `vscode` API; `node:worker_threads`; `AsyncFunction` constructor for user-code loading (no `node:vm` module use); no new npm dependencies
