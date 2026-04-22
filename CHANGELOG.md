# Changelog

## [2.8.21] — 2026-04-22

### Security

- **Secret macro storage migration**: Macros marked `secret: true` are no longer stored in `settings.json` (plaintext). On first load, existing macros are silently migrated to VS Code `globalState` (non-secret fields) and `SecretStorage` (secret text). Backup/restore and share exports both handle the new storage transparently; a version 2 backup format carries secret text in an encrypted `secretMacros` blob keyed by stable UUID. The `nexus.terminal.macros` settings schema entry has been removed.

## [2.8.20] — prior

- See git log for earlier changes.
