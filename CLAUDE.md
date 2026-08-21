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
- PTY integration: `SshPty`, `SmartSerialPty`, `SerialPty` all implement `SessionPtyHandle` — `addOutputObserver(o): Disposable`, `setInputBlocked(bool)`, `writeProgrammatic(data)`, `resetTerminal()`, `markShuttingDown(reason)`. A first dropped keystroke during `setInputBlocked(true)` emits a one-shot `[Nexus] Terminal is locked…` line via the PTY's `writeEmitter`. `markShuttingDown` fires from the deactivate subscription; it tears down the transport and fires a farewell banner, **but VS Code's IPC race on extension-host shutdown means the banner rarely reaches the renderer** (see microsoft/vscode#122825, #140697). The reliable mechanism is `services/terminal/orphanDetect.ts` (`detectOrphanNexusTerminals`), called as the first thing in `activate()` — it scans `vscode.window.terminals` for `/Nexus (SSH|Serial):/` and, if any match, shows an information notification. Orphans are intentionally NOT disposed: the last-rendered content is usually worth reviewing, and VS Code has no API to rewrite or append to a dead pseudoterminal from a new extension instance, so the only available action would be to destroy the content. Closing is the user's call. The handle is exposed on `ActiveSession.pty` / `ActiveSerialSession.pty` (runtime-only; not persisted).
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

Cross-window writes: `globalState` is shared across VS Code windows, last-writer-wins, no compare-and-swap — and every `save*` persists the whole collection list, so a save from one window can overwrite another window's edit to the same collection. `VscodeConfigRepository` keeps both the actual Memento cache object and an immutable JSON snapshot as its per-key baseline. `ExtensionMemento.update` synchronously JSON-clones object/array values into that cache before its persistence promise settles, so the repository captures the cache object immediately after `update()` while retaining the already-computed pending JSON as the content baseline. Reference identity says only whether that cache object was replaced; it neither proves content was untouched nor identifies a foreign writer. When replacement is observed, the repository serializes the current stored value and warns through `onConcurrentOverwrite` only if it differs both from the immutable baseline and from the pending save. The hook reports storage divergence, not who caused it; the write still proceeds, so the loss is surfaced rather than prevented (prevention isn't possible at the Memento layer). Cost is one serialization when a collection is read, one serialization of the pending value on every save, and one additional serialization of the stored value only when the cache object was replaced. Full semantics and residual gaps are in the doc comment atop `vscodeConfigRepository.ts`.

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

- **Every maintainer-authored change PR bumps the patch version** in `package.json` (e.g. 2.7.5 → 2.7.6). *Outside* contributors are asked in `CONTRIBUTING.md` **not** to bump — concurrent pull requests would collide on that one line — so when merging an outside contribution the maintainer bumps it in a separate commit. Nothing automates that: no workflow performs a merge-time bump, and `release.yml` only sets `package.json` to match an already-existing tag at publish time. Bumping is routine and carries no release consequence — it just means the work on `main` is always ready to be released. The VS Code Marketplace rejects re-publishing the same version, so a version is never re-used.
- **Releasing is opt-in, and only on the maintainer's explicit say-so.** Merging a version-bumped PR publishes nothing. A release happens only when the merge (squash) commit message contains a line that is **exactly** `[release]` (on its own line — a mention inside prose, such as "do not [release] this yet", deliberately does not count), or when the `v{version}` tag is pushed by hand — both run the full pipeline (VSIX build, GitHub Release, Marketplace, Open VSX) via `.github/workflows/auto-release.yml`.
- Do **not** add `[release]` to a merge on your own initiative. Wait to be told to release, in the maintainer's own words.
- This is deliberately the inverse of the earlier opt-out model, which released unless a merge said `[skip release]`. Once every PR bumps the version, opt-out is unsafe: forgetting the marker publishes irreversibly to two public registries, and a published version can be neither withdrawn nor re-used. Under opt-in, forgetting the marker costs a second merge or a manual tag push. **Do not write the string `[skip release]`** — it no longer does anything, and the workflow's opt-in marker cannot be matched by it.
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
