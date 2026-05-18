# Changelog

## [Unreleased]

## [2.8.48] — 2026-05-18

### Fixed

- **Release builds now include the Local Shell highlighting fix.** This release republishes the Local Shell terminal-highlighting changes with the fixed code on `main` before the release tag is pushed, so tag-triggered builds consume the corrected implementation.

## [2.8.47] — 2026-05-18

### Fixed

- **Local Shell output now participates in terminal highlighting.** Regex highlighting now matches SSH, Serial, and Local Shell terminal output while macro/script observers continue to receive raw Local Shell data.

## [2.8.46] — 2026-05-15

### Fixed

- **Local Shell VS Code profile selection now includes more launchable local profiles.** Nexus maps common VS Code source/autodetected profiles such as PowerShell, Git Bash, Command Prompt, and detected WSL distros to executable-backed Local Shell profiles when possible, and avoids choosing missing `Sysnative` paths when a working `System32` path is available.

## [2.8.44] — 2026-05-15

### Added

- **Nexus Scripts can now run against Local Shell sessions.** `@target-type local`, `session.type === "local"`, quick-run from a focused Local Shell terminal, and Local Shell **Open and Run Script** profile actions are supported alongside SSH and Serial.

### Fixed

- **Local Shell startup failures now leave diagnostics visible without stale active sessions.** Early local process exits unregister the Nexus session while keeping the terminal tab available for reviewing startup output.

## [2.8.41] — 2026-05-13

### Changed

- **The README and Marketplace description now document Local Shell profiles.** The getting started flow and feature list now cover saved Local Shell profiles, VS Code terminal profile selection, custom shell paths and arguments, WSL through `wsl.exe`, multiple local sessions, and the current macros-versus-scripting scope.

## [2.8.40] — 2026-05-13

### Fixed

- **Release builds no longer fail while sanitizing share exports from older callers.** `sanitizeForSharing` accepts both the pre-Local Shell argument shape and the new Local Shell-aware shape.

## [2.8.39] — 2026-05-13

### Added

- **Local Shell profiles can now be saved and opened from the Connectivity Hub.** Profiles can use a saved VS Code terminal profile or a custom local shell path, support multiple simultaneous local sessions, and participate in active-terminal macro sending.

### Changed

- **The profile creation flow now includes Local Shell alongside SSH Server and Serial profiles.** VS Code terminal profiles are shown in an editable dropdown, while WSL and other shells that are not listed can be configured through Custom Shell with `wsl.exe` or another local executable.

## [2.8.38] — 2026-05-11

### Fixed

- **Test Connection icon is no longer shown on connected SSH and serial profiles.** The inline and context-menu test actions are hidden once a profile has an active session — testing is redundant when the connection is already established.
- **Profile creation forms now include a Test Connection button.** Clicking "Test Connection" in the Add SSH Server or Add Profile form runs the same connection test against the in-progress (unsaved) profile data, allowing verification before saving.

## [2.8.37] — 2026-05-10

### Added

- **A dedicated Macro Guide is now available from the extension and docs.** The new guide covers blank vs template macros, newlines, secret macro caveats, auto-trigger scope, cooldowns, intervals, pause/resume behavior, and practical JavaScript regex examples.
- **Terminal Macros now expose a direct guide action.** The Macros view includes an **Open Macro Guide** action and welcome link, including a web-extension fallback that opens the guide externally.

### Changed

- **Macro creation labels now distinguish blank macros from templates.** The command, title-bar actions, empty state, selector, and editor button copy make it clearer when a user is starting from scratch versus a starter template.
- **Macro editor help text is more explicit.** Hints now explain exact newline behavior, regex entry without `/slashes/` or flags, interval ownership, active-terminal start behavior, and safer regex alternatives for rejected patterns.
- **Shared repository-link generation is reused for docs commands.** Script and macro documentation links now use the same helper instead of duplicating GitHub URL construction.

### Fixed

- **The password macro template now starts paused by default.** It stores no sample secret and cannot auto-send an empty response before the user enters, saves, and resumes the secret macro.
- **Macro interval documentation now matches runtime behavior.** Interval macros start only from the active terminal, keep delayed sends on that same session, and do not send again until the pattern matches again.

## [2.8.36] — 2026-05-10

### Added

- **First-time setup is now more guided.** Clean installs show direct welcome actions for adding a generic profile, SSH server, serial profile, scanning serial ports, browsing files, opening settings, and creating script or macro templates.
- **Connection diagnostics are available before connecting.** SSH and serial profiles now have visible row/menu test-connection actions that report actionable success or failure details without starting a full terminal session.
- **Starter templates are available for scripts and macros.** The Scripts and Macros views now include guided template entry points, with documentation refreshed for the new commands.

### Changed

- **Settings are reorganized for first-time users.** Security and backup-related settings are grouped under a clearer Security & Data area, and advanced profile fields are tucked behind advanced sections in the add profile flow.
- **SFTP operations provide clearer progress and summaries.** Upload, download, and delete flows now report per-item progress, conflicts, skipped items, and failures more consistently.

### Fixed

- **Add Profile, Add SSH Server, and Add Serial Profile now open distinct add flows.** The generic action keeps the profile-type selector, while SSH and serial-specific actions open dedicated forms with the intended type selected.

## [2.8.26] — 2026-04-25

### Fixed

- **Password-expired retry through a jump host no longer hangs for 60 seconds.** When an SSH profile used a key-authenticated jump host with a password-authenticated end device, and the saved end-device password was wrong (e.g. expired), the prompted retry would silently hang for the full `ssh2.readyTimeout` (~60s) and any concurrent re-click would hang on the same promise. Root cause was reusing one tunnel stream across both the saved-credential and the prompted-retry SSH handshake — a stream can carry exactly one handshake before it's consumed. `SilentAuthSshFactory` now takes a `sockFactory: () => Promise<Duplex>` instead of a single `sock`, so every internal handshake attempt opens a fresh tunnel / SOCKS5 socket / HTTP CONNECT socket. Failed-attempt socks are explicitly destroyed. Same fix applies to SOCKS5 and HTTP CONNECT proxy paths.
- **A transient credential-vault failure no longer tears down a successfully authenticated SSH session.** In the prompted-retry paths, `connector.connect()` and the post-success `vault.store` / `vault.delete` calls used to share a single try/catch whose catch destroyed the underlying socket. If `SecretStorage` glitched (locked OS keychain, race with another VS Code window) after the SSH handshake had already succeeded, the catch destroyed the sock that backed the live connection. The two stages are now split: connection establishment owns the sock-destroy-on-failure semantics; credential persistence is best-effort and logs failures to `console.error` while returning the live connection. The natural fallback for a missed save is being re-prompted next time, which is strictly better than dropping the session.

## [2.8.25] — 2026-04-24

### Fixed

- **Orphan terminal tabs after extension reload are no longer auto-closed.** 2.8.24 introduced an activate-time sweep that called `terminal.dispose()` on every zombie tab found; that closed the tab AND discarded the last-rendered transcript, which is exactly what users want to preserve (command history, log tails, error output that a reload happened to interrupt). The sweep is now detection-only — it still fires a one-time notification describing how many sessions disconnected and where to reconnect, but the tabs stay open with their last output intact until the user closes them. Module renamed `orphanSweep` → `orphanDetect`, function `sweepOrphanNexusTerminals` → `detectOrphanNexusTerminals`.

## [2.8.24] — 2026-04-24

### Fixed

- **Zombie terminal tabs after extension reload / disable / update are now actively cleaned up.** The in-tab farewell banner shipped in 2.8.23 relied on a write during `deactivate` reaching the terminal renderer, but VS Code's extension-host shutdown wins that race (see microsoft/vscode#122825, #140697), so in practice the tab kept its last-rendered content with no message. The next time the extension activates, Nexus now sweeps `window.terminals` for its own naming patterns, closes any orphans left by the previous host, and shows an information toast: *"Nexus: N session(s) were closed due to an extension reload or restart. Reconnect from the Connectivity Hub when ready."* The 2.8.23 deactivate-time banner is retained as best-effort for the narrow paths where VS Code's IPC happens to flush in time.

## [2.8.23] — 2026-04-24

### Changed

- **Live terminal tabs now print a farewell banner on extension reload / disable / update.** Previously SSH sessions silently hung in a dead tab and serial sessions were silently disposed when the extension host tore down. Every active SSH, Standard Serial, and Smart Follow tab now receives a final `[Nexus …] Nexus extension is shutting down. This session has been closed.` message, stays visible for transcript capture, and is marked `[Disconnected]` / `[Stopped]` in the tab title. Close the tab and reconnect from the Connectivity Hub to start a new session.

## [2.8.22] — 2026-04-22

### Changed

- **Connectivity-hub folder nesting raised from 4 to 10 levels.** Lets you mirror deeper organizational hierarchies (e.g. imports from MobaXterm / SecureCRT that previously got flattened). No data-model change; existing configs are unaffected. Note: at the deepest levels, indentation may crowd folder labels on narrow sidebars.

## [2.8.21] — 2026-04-22

### Security

- **Secret macros now stored in SecretStorage**

  Macros flagged `secret: true` previously stored their value in cleartext in `settings.json`. This release moves macro storage to VS Code's `globalState` + `SecretStorage`:
  - **Secret macro text** → `SecretStorage` (encrypted by the OS credential manager).
  - **Macro metadata** (name, keybinding, trigger pattern) → `globalState` (plain JSON on disk, but outside `settings.json`).

- **Automatic migration.** On first launch, Nexus absorbs any `nexus.terminal.macros` entries from every settings.json scope and clears them. No action required.

- **Clean up synced machines.** If you use VS Code Settings Sync or commit `settings.json` to dotfiles, delete any `nexus.terminal.macros` block so the cleartext values there are removed. If they sync back, Nexus will absorb them again on next launch.

- **Threat model.** `SecretStorage` protects the secret `text`. Macro names, keybindings, and trigger patterns remain in plain globalState on disk — do not encode secrets in macro names. Also note: when a macro's text is sent to a terminal that echoes input, it can appear in terminal output and saved transcripts.

- **Backups still work.** Backups and share-exports continue to round-trip across versions. Imports accept both the new format and pre-2.8.21 backups.

- The `nexus.terminal.macros` setting has been removed from the schema — use the Macros view or Macro Editor.

## [2.8.20] — prior

- See git log for earlier changes.
