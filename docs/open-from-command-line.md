# Open a Profile from the Command Line

Nexus registers a `vscode://` URI handler so you can open any saved profile — an **SSH or Telnet network device, a Serial port, or a Local Shell** — from a terminal, a script, a browser link, or a CI job. The profile type is detected automatically from the name (or id) you give, and Nexus runs the matching connect action.

## URI Forms

```
vscode://sentriflow.vscode-nexterminal/<name>            # open the named profile (network device / Serial / Local Shell)
vscode://sentriflow.vscode-nexterminal/<name>?sftp       # SSH only: connect + open File Explorer (SFTP)
vscode://sentriflow.vscode-nexterminal/<name>?id=<uuid>  # use profile id instead of name
```

- `<name>` is case-insensitive and matched across all profile types; the first match is used when multiple profiles share a name (a warning suggests `?id=` to disambiguate).
- `?id=<uuid>` overrides the name for unambiguous lookup. When a name matches more than one profile, the warning shows the id of the profile it opened. A profile's id is also in an **Encrypted Backup** file, whose profile list is stored in the clear (only secrets and backed-up files are encrypted) — but not in an **Export for Sharing** file, which gives every profile a new id.
- `?sftp` is **SSH-only** — it opens the SSH terminal **and** the File Explorer for SFTP browsing in one click. Requesting `?sftp` on a Serial or Local Shell profile shows an error. On a Telnet profile the terminal opens and a warning then explains that SFTP isn't available for telnet servers.

## Open from a Terminal

```bash
code --open-url "vscode://sentriflow.vscode-nexterminal/Production"
```

> **Note:** Use `--open-url`, not `--file-uri` or `--folder-uri` — those open local files/folders and do not route to the extension's URI handler.

## Shell Alias (bash / zsh)

```bash
nexterm() { code --open-url "vscode://sentriflow.vscode-nexterminal/$1"; }
# Usage (works for network device, Serial, and Local Shell profiles by name):
nexterm Production
nexterm "My Server"
nexterm "Lab Console"      # a saved Serial profile
nexterm 'Production?sftp'   # SSH only — quote it: zsh treats an unquoted ? as a wildcard
```

Add this to your `~/.bashrc` or `~/.zshrc` to make it permanent.

## PowerShell Function

```powershell
function nexterm($p) { code --open-url "vscode://sentriflow.vscode-nexterminal/$p" }
# Usage:
nexterm Production
nexterm "My Server"
nexterm "Production?sftp"
```

Add this to your PowerShell profile (`$PROFILE`) to make it permanent.

## See also

- [SSH and Telnet](ssh-and-telnet.md)
- [Serial](serial.md)
- [Local Shells](local-shells.md)
- [File Explorer](file-explorer.md) — what `?sftp` opens
- [Import and Export](import-export.md#encrypted-backup-and-share-export)
