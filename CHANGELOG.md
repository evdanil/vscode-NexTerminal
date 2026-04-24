# Changelog

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
