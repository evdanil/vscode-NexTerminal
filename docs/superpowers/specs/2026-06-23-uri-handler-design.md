# Design — `vscode://` URI handler to open saved profiles (issue #11)

**Date:** 2026-06-23
**Issue:** [#11](https://github.com/evdanil/vscode-NexTerminal/issues/11) — luckman212 wants to open a saved profile from the CLI / a link. Generalized to open **any** saved profile type: SSH (optionally + SFTP), Serial, and Local Shell.

## Problem & constraint

`nexterm://foo` (what the reporter tried) cannot work: a VS Code extension cannot register an OS-level URL scheme. `vscode.window.registerUriHandler` only receives `vscode://<publisher>.<extension-id>/…` URIs; the `vscode://` scheme is owned by the Code installer. The reporter also used `--file-uri` (opens a *file*) instead of `--open-url` (routes to the URI handler).

The shortest achievable URI is therefore `vscode://sentriflow.vscode-nexterminal/<path>` — the extension-id segment is fixed. Short CLI ergonomics are delivered via a documented shell alias.

## URI format

The handler opens **any saved profile type — SSH, Serial, or Local Shell**. The profile kind is NOT encoded in the URI; it is derived from which saved profile the name/id resolves to.

```
vscode://sentriflow.vscode-nexterminal/<name>            # open the named profile (kind auto-detected)
vscode://sentriflow.vscode-nexterminal/<name>?sftp       # SSH only: connect + open File Explorer (SFTP)
vscode://sentriflow.vscode-nexterminal/<name>?id=<uuid>  # disambiguate by id (id wins over name)
```

- **Path** (first segment, URL-decoded) = profile **name**, matched case-insensitively across all three collections (first match if duplicated).
- **`?id=<uuid>`** = exact id; when present it overrides the name path. Searched across all three collections.
- **`?sftp`** (presence-only flag) = request the SFTP File Explorer; **SSH-only** — on a Serial / Local Shell profile it is an error.
- Connect is **silent** — no Nexus confirmation; rely on VS Code's built-in "allow this URI" consent. Acts only on **existing saved profiles**; the URI never carries host/user/password.

CLI usage (documented in README):
```bash
code --open-url "vscode://sentriflow.vscode-nexterminal/foo"
# alias for ergonomics:
nexterm() { code --open-url "vscode://sentriflow.vscode-nexterminal/$1"; }   # bash/zsh
```
```powershell
function nexterm($p){ code --open-url "vscode://sentriflow.vscode-nexterminal/$p" }   # PowerShell
```

## Components

- **`src/uri/nexusUriHandler.ts`** (new, no `vscode` UI side effects in the pure parts):
  - `parseNexusUri(uri: vscode.Uri): { name?: string; id?: string; sftp: boolean } | { error: string }` — pure parser over `uri.path` + `uri.query`. `?sftp` (presence-only) sets `sftp: true`. No connect-vs-sftp action enum — the kind is derived from the matched profile.
  - `resolveProfile(collections: { servers; serialProfiles; localShellProfiles }, ident: { id?; name? }): { profile?; kind?: "ssh" | "serial" | "localShell"; ambiguous: boolean }` — searches all three collections. id exact first (deterministic order ssh → serial → localShell), else case-insensitive name across all types; `ambiguous: true` when >1 name match across ALL types combined (returns first in that order).
  - `createNexusUriHandler(deps: { core: NexusCore }): vscode.UriHandler` — `handleUri` parses, resolves over `deps.core.getSnapshot()` (`servers` / `serialProfiles` / `localShellProfiles`), dispatches the kind-specific command(s), and surfaces errors.
- **`extension.ts:activate()`** — `context.subscriptions.push(vscode.window.registerUriHandler(createNexusUriHandler({ core })))`.
- **`package.json`** — add `"onUri"` to `activationEvents` so a link activates the extension when it is not already running.
- **Command arg resolution** — all three connect commands already accept a string profile id: `toSerialProfileFromArg` and `toLocalShellProfileFromArg` handle `typeof arg === "string"`; `fileCommands.ts:toServerFromArg` was extended to do the same (for the SSH `?sftp` browse path).

## Data flow (`handleUri`)

1. `parseNexusUri(uri)`. On `{ error }` → `showErrorMessage("Nexus: " + error)` and return.
2. `resolveProfile(core.getSnapshot(), { id, name })`.
3. No profile/kind → `showErrorMessage("Nexus: no profile matching …")`.
4. `sftp && kind !== "ssh"` → `showErrorMessage("Nexus: SFTP is only available for SSH profiles.")` and return (dispatch nothing).
5. `ambiguous` → `showWarningMessage` noting multiple name matches, suggest `?id=`; proceed with first.
6. Dispatch by kind (always with the resolved profile **id**):
   - `ssh` → `executeCommand("nexus.server.connect", id)`; if `sftp` → then `executeCommand("nexus.files.browse", id)`. `browseServerFiles` opens its own SFTP connection (via `ctx.sftpService.connect`) independent of the SSH terminal, so awaiting connect first just orders the UI — no readiness race.
   - `serial` → `executeCommand("nexus.serial.connect", id)`.
   - `localShell` → `executeCommand("nexus.localShell.connect", id)`.

## Security

The path/query are used only to **look up an existing saved profile**, never executed and never used to build a connection target. Allowlisted, kind-specific connect commands; `?sftp` only ever reaches the SSH browse path. A hostile web link can at worst reconnect the user to one of their own saved profiles after VS Code's external-URI consent prompt — no new host, no credentials, no command injection.

## Testing

- `parseNexusUri`: default (`sftp:false`), `?sftp` / `?sftp=1` (`sftp:true`), `?id=` keeps name, URL-encoded name (`%20`), empty path + missing id → error, unknown extra query ignored, trailing slash.
- `resolveProfile`: id + name match for each kind (ssh / serial / localShell); cross-type name ambiguity → first in deterministic order + `ambiguous:true`; no match → undefined profile/kind; id wins over name.
- `createNexusUriHandler.handleUri`: mock `vscode.commands.executeCommand` + `showErrorMessage`/`showWarningMessage`; assert per-kind command dispatch, SSH `?sftp` connect→browse, `?sftp` on serial/localShell → error + no dispatch, not-found error, ambiguous warning + first opened.
- `packageContributions.test.ts`: assert `onUri` present in `activationEvents`.

## Docs

- README: a short "Open a profile from the command line" subsection with the `--open-url` form + alias snippets, and the `--file-uri` caveat.
- Reply on issue #11 with the same.

## Out of scope (YAGNI)

Tunnels via URI; arbitrary host/credentials in the URI; a Nexus confirmation setting; custom OS protocol registration (`nexterm://`).
