# Design — `vscode://` URI handler to open SSH/SFTP profiles (issue #11)

**Date:** 2026-06-23
**Issue:** [#11](https://github.com/evdanil/vscode-NexTerminal/issues/11) — luckman212 wants to open a saved SSH/SFTP profile from the CLI / a link.

## Problem & constraint

`nexterm://foo` (what the reporter tried) cannot work: a VS Code extension cannot register an OS-level URL scheme. `vscode.window.registerUriHandler` only receives `vscode://<publisher>.<extension-id>/…` URIs; the `vscode://` scheme is owned by the Code installer. The reporter also used `--file-uri` (opens a *file*) instead of `--open-url` (routes to the URI handler).

The shortest achievable URI is therefore `vscode://sentriflow.vscode-nexterminal/<path>` — the extension-id segment is fixed. Short CLI ergonomics are delivered via a documented shell alias.

## URI format

```
vscode://sentriflow.vscode-nexterminal/<name>            # SSH connect (default action)
vscode://sentriflow.vscode-nexterminal/<name>?sftp       # connect + open File Explorer (SFTP)
vscode://sentriflow.vscode-nexterminal/<name>?id=<uuid>  # disambiguate by id (id wins over name)
```

- **Path** (first segment, URL-decoded) = profile **name** (case-insensitive; first match if duplicated).
- **`?id=<uuid>`** = exact id; when present it overrides the name path.
- **`?sftp`** (presence-only flag) = SFTP action; otherwise SSH connect.
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
  - `parseNexusUri(uri: vscode.Uri): { action: "connect" | "sftp"; name?: string; id?: string } | { error: string }` — pure parser over `uri.path` + `uri.query`.
  - `resolveServer(servers: ServerConfig[], ident: { id?: string; name?: string }): { server?: ServerConfig; ambiguous: boolean }` — id exact first, else case-insensitive name; reports ambiguity.
  - `createNexusUriHandler(deps: { core: NexusCore }): vscode.UriHandler` — `handleUri` parses, resolves over `deps.core.getSnapshot().servers`, dispatches commands, and surfaces errors.
- **`extension.ts:activate()`** — `context.subscriptions.push(vscode.window.registerUriHandler(createNexusUriHandler({ core })))`.
- **`package.json`** — add `"onUri"` to `activationEvents` so a link activates the extension when it is not already running.

## Data flow (`handleUri`)

1. `parseNexusUri(uri)`. On `{ error }` → `showErrorMessage("Nexus: " + error)` and return.
2. `resolveServer(core.getSnapshot().servers, { id, name })`.
3. No server → `showErrorMessage("Nexus: no SSH profile matching …")`.
4. `ambiguous` → `showWarningMessage` noting multiple name matches, suggest `?id=`; proceed with first.
5. Dispatch:
   - `connect` → `executeCommand("nexus.server.connect", server.id)`.
   - `sftp` → connect, then open the File Explorer for that server, reusing `nexus.server.connect` + `nexus.files.browse` (`browseServerFiles`). Implementer reads `browseServerFiles` to wire connect→browse without a readiness race (await connect first; fall back to browse-only if browse already auto-connects).

## Security

Allowlisted actions (`connect`/`sftp`); the path/query are used only to **look up an existing saved profile**, never executed and never used to build a connection target. A hostile web link can at worst reconnect the user to one of their own saved boxes after VS Code's external-URI consent prompt — no new host, no credentials, no command injection.

## Testing

- `parseNexusUri`: default connect, `?sftp`, `?id=` overrides name, URL-encoded name (`%20`), empty path + missing id → error, unknown extra query ignored, trailing slash.
- `resolveServer`: id exact, name case-insensitive, duplicate name → first + `ambiguous:true`, no match → undefined.
- `createNexusUriHandler.handleUri`: mock `vscode.commands.executeCommand` + `showErrorMessage`/`showWarningMessage`; assert correct command(s) per action, error path, ambiguous warning.
- `packageContributions.test.ts`: assert `onUri` present in `activationEvents`.

## Docs

- README: a short "Open a profile from the command line" subsection with the `--open-url` form + alias snippets, and the `--file-uri` caveat.
- Reply on issue #11 with the same.

## Out of scope (YAGNI)

Tunnels via URI; arbitrary host/credentials in the URI; a Nexus confirmation setting; custom OS protocol registration (`nexterm://`).
