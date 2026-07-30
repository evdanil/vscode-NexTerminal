# Nexus Terminal Functional Documentation

## 1. Product Goal
Nexus Terminal provides one operational surface in VS Code for:
- SSH terminals
- SSH port-forwarding tunnels
- SFTP file management over SSH
- Serial connectivity through isolated sidecar IPC

## 2. Implemented Architecture

### 2.1 Core Components
- `NexusCore` (`src/core/nexusCore.ts`): state manager for servers, tunnel profiles, active sessions, active tunnels.
- `SilentAuthSshFactory` (`src/services/ssh/silentAuth.ts`): credential loop with `SecretStorage` and keyboard-interactive 2FA support.
- `Ssh2Connector` (`src/services/ssh/ssh2Connector.ts`): concrete SSH transport.
- `SshConnectionPool` (`src/services/ssh/sshConnectionPool.ts`): shared SSH connection manager for multiplexed terminals, tunnels, and SFTP.
- `TunnelManager` (`src/services/tunnel/tunnelManager.ts`): local TCP listeners + SSH forwarding.
- `SftpService` (`src/services/sftp/sftpService.ts`): shared SFTP operations layer backing the file explorer and `nexterm://` filesystem provider.
- `TunnelRegistrySync` (`src/services/tunnel/tunnelRegistrySync.ts`): cross-window tunnel ownership and visibility sync.
- `SerialSidecarManager` (`src/services/serial/serialSidecarManager.ts`): JSON-RPC sidecar client.
- `serialSidecarWorker` (`src/services/serial/serialSidecarWorker.ts`): isolated process runtime.

### 2.2 Isolation Model
- Interactive SSH terminals use `SshPty` shell channels. When SSH multiplexing is enabled, those channels can share a pooled underlying SSH connection; per-server disable and automatic standalone fallback are supported.
- Tunnels default to shared mode: all TCP clients reuse a single SSH connection. Isolated mode (one SSH connection per client) is available as a per-profile or global setting.
- SFTP reuses the shared SSH pool when connected to the same server.
- Serial code executes outside the extension host process.

## 3. Data Models
- `ServerConfig` and `TunnelProfile` defined in `src/models/config.ts`.
- `SerialProfile` defined in `src/models/config.ts` (`path`, `baudRate`, `dataBits`, `stopBits`, `parity`, `rtscts`, optional `group`, optional `mode`, optional `deviceHint`).
- `AuthProfile` defined in `src/models/config.ts` for reusable username/auth method templates linked to multiple servers.
- Persisted via `VscodeConfigRepository` into `globalState`.
- Password secrets persisted via VS Code `SecretStorage` using key pattern `password-${serverId}`.

## 4. User Workflows

### 4.1 Server Management
1. Run `Nexus: Add Server` (or use the unified `Nexus: Add Profile` form).
2. Fill host/auth details.
3. Server appears in **Connectivity Hub**.
4. Right-click server item to connect/disconnect/edit/remove/duplicate/rename.

#### 4.1.1 Profile Quick Actions
- `Nexus: Add Profile` opens the unified profile flow for SSH server or Serial profile creation.
- The tree-only `nexus.profile.actions` command opens the **Profile Actions** quick pick from a profile item. It is hidden from the Command Palette and exposed through the tree.
- Server profile actions include **Connect**, **Test Connection**, **Browse Files** when connected, **Connect and Run Script**, **Edit**, **Duplicate**, **Copy Connection Info**, and **Delete**.
- Serial profile actions include **Connect**, **Test Connection**, **Connect and Run Script**, **Edit**, **Duplicate**, **Copy Port Info**, and **Delete**.
- Local Shell profile actions include **Open Local Shell**, **Open and Run Script**, **Edit**, **Duplicate**, **Copy Shell Info**, and **Delete**. Local Shell profiles do not show a Test Connection action.
- The Local Shell VS Code profile dropdown lists only terminal profiles that expose an explicit executable path to extensions. For WSL, use a custom Local Shell profile with `wsl.exe` as the shell path and any distribution arguments as shell arguments.
- Folder actions use folder-specific labels for bulk operations: **Connect Folder Servers** and **Disconnect Folder Servers**.

#### 4.1.2 Connection Test Diagnostics
- Server profiles expose **Test Connection** (`nexus.server.testConnection`). It opens a progress notification, attempts an SSH connection with the same profile configuration, disposes the test connection on success, and shows `Connection test succeeded for <name>.`
- On SSH failure, the test classifies the connection error and shows a diagnostic title/detail pair with **Copy Details**. Copying details writes the formatted diagnostic text to the clipboard.
- Serial profiles expose **Test Connection** (`nexus.serial.testConnection`). Standard serial tests check whether the configured port path is currently available.
- Smart Follow serial tests also compare the saved path and saved hardware hint. Results distinguish saved-path availability, matching-device availability, and missing-device states. Failure prompts can offer **Scan Serial Ports**.

### 4.2 Silent Auth (Password mode)
1. Lookup in secret vault.
2. Attempt login.
3. On auth reject, delete stored secret.
4. Prompt user for new password and optional save.
5. Retry with new secret.

### 4.3 SSH Authentication
Supported authentication types:
- **Password** — stored in VS Code SecretStorage, auto-filled on reconnect.
- **Private key** — reads key file from disk, prompts for passphrase if encrypted.
- **SSH agent** — delegates to the system SSH agent via `SSH_AUTH_SOCK`.

All auth types support **keyboard-interactive 2FA**: `tryKeyboard` is enabled globally so servers can request verification codes after primary auth. When an `InputPromptFn` is provided (wired to `vscode.window.showInputBox` in production), the handler auto-fills password-like prompts and shows an input box for all other prompts (e.g., OTP codes).

### 4.4 SSH Terminal Session
1. Run `Nexus: Connect Server` (or context action).
2. A custom PTY terminal is created (`Nexus SSH: <server>`).
3. Terminal opens in an editor tab by default, or in the terminal panel when `nexus.terminal.openLocation` is set to `panel`.
4. Session appears in **Connectivity Hub**.
5. Unread output marks both the sidebar session node and the terminal tab title until the terminal regains focus.
6. Output/input logs are written under extension global storage logs.

#### 4.4.1 SFTP File Explorer Operations
- **Browse Files** (`nexus.files.browse`) selects an active connected SSH profile as the SFTP target.
- SSH profiles can enable **Open File Explorer on first connection** in advanced options. After a normal **Connect**, Nexus starts SFTP and switches the single **File Explorer** view to that server when it is not already active there.
- Only one SSH profile can have this automatic File Explorer behavior enabled. Saving it on one profile clears it from any other profile.
- Automatic File Explorer opening does not run for jump-host use, tunnel starts, group Connect, or Connect and Run Script.
- The **File Explorer** view supports open, upload, download, delete, rename, new directory, new file, go to path, go home, copy remote path, refresh, and disconnect commands.
- Upload and download operations track summary counts for completed items, skipped items, conflicts, and cancellations.
- Drag-and-drop uploads report `Upload completed`, `Upload completed with skips`, or `Upload canceled` notifications with summary counts.
- Recursive uploads skip symbolic links, unsafe entry names, unreadable local paths, and directories beyond the upload depth limit.
- Recursive deletes are constrained by `nexus.sftp.deleteDepthLimit` and `nexus.sftp.deleteOperationLimit`.
- Directory listings use the SFTP cache and remote watch settings. Manual refresh invalidates cached entries for the active target.
- **Save as Root**: SFTP writes as the logged-in SSH user, so a root-owned file normally fails to save. If a plain save is denied, Nexus offers to retry over `sudo` (declining suppresses the offer for that file until it's closed or Edit as Root is chosen); a file with no write bits at all (`0444`) can be marked editable up front via **Edit as Root (sudo)** (`nexus.files.editAsRoot`) in the File Explorer context menu or the command palette (when a `nexterm://` file is the active editor), since VS Code blocks editing such a file before any save is attempted. This covers writes only — elevated reads are not supported, so a file the SSH user can't even read still fails to open. The content is staged to a temporary path over SFTP, then moved into place with `sudo` on an SSH exec channel — the write goes through the target's existing inode when it already exists, so owner, mode, ACLs, and hard links are preserved; a new file, or one recreated because it vanished remotely between open and save, is created using the mode last observed for it (`644` if none was ever observed) — read/write bits only; a recreated file never comes back with execute or setuid/setgid/sticky bits, which can be narrowed but never restored. The sudo password (asked only when the account actually needs one) is piped to the exec channel's stdin and is never written to disk, secret storage, or a log; `nexus.sftp.sudo.rememberPasswordForSession` optionally keeps it in memory until that server disconnects or the window closes — though even with it off, the remote host's own sudo credential timestamp can let consecutive saves skip the prompt. The write is **not atomic** — a disk-full condition or a dropped connection mid-write can leave the target partially written with no backup, so a failed elevated save should be retried rather than abandoned. Sudoers policies requiring a TTY (`requiretty`) are unsupported and reported as such, along with a workaround. The whole feature is gated by `nexus.sftp.sudo.enabled`. Elevation depends on the SSH account actually having sudo rights on the remote host — the password prompt normally asks for the account's own login password, not root's. Knowing the root password doesn't help if the account isn't in sudoers, since sudo authenticates the invoking user rather than accepting root's password in its place; the practical workaround is a second Nexus server profile that logs in as root over SSH (only possible if the host permits root SSH login) and edits the file directly. Elevating with the root password via `su` instead of `sudo` is not supported and isn't planned: `su` reads its password from `/dev/tty` rather than stdin, and Nexus has no PTY channel to drive that prompt. Hosts that set `Defaults rootpw` (or `targetpw`) make sudo want root's password instead of the account's own — the retry prompt shown after a rejected password notes this possibility.

#### 4.4.2 Directory Sync (Follow Terminal Directory)
Keeps the File Explorer pointed at whichever SSH terminal is focused, tracking that terminal's current directory instead of sitting wherever it was last navigated. Two parts: continuous sync for shells that announce their own directory, and a manual, on-demand sync for everything else. Neither part writes anything to the terminal/pty channel in this release — the feature only reads what the shell already sends, or asks the user for a path directly.

- **Turning it on/off** — a three-way toggle occupies the leftmost slot (`navigation@1`) of the File Explorer title bar, guaranteed inline (it never falls into the `...` overflow), and the same three actions are mirrored on the right-click context menu of the `.` row (the row showing the current directory). There is no setting for this: the on/off state lives in `globalState`, never in `settings.json`, so turning it off never requires opening Settings.
  - **Follow Terminal Directory** (`nexus.files.followTerminal`, `$(link)`) — shown when off; turns following on, clears any pause, and — if the focused SSH session already has an applicable tracked directory and the explorer is idle and visible — immediately re-roots to it rather than waiting for the next reported `cd` or focus change.
  - **Stop Following Terminal Directory** (`nexus.files.unfollowTerminal`, `$(circle-slash)`) — shown while following and not paused; turns following off entirely.
  - **Resume Following Terminal Directory** (`nexus.files.resumeFollowTerminal`, `$(pinned)`) — shown only while paused (state 5 below); clears the pause and immediately re-roots to the terminal's last known directory.
  - Turning **Follow Terminal Directory** on for a focused SSH session that has never reported a directory (state 3) immediately shows an actionable notice — `"<server>" hasn't reported its directory yet...` — with **Show Me How** (writes the rc one-liner to the "Nexus Directory Sync" output channel and opens it) and **Go to Terminal Directory** (jumps there once, manually) as the two responses. Fires at most once per server per window, tracked in memory only, so it reappears after a reload or if a different server hits the same state.
- **Go to Terminal Directory** (`nexus.files.syncFromTerminal`) — a one-shot sync independent of the toggle, and the only new command Phase 1 puts in the overflow group (`1_sync@1`) rather than inline, since it is a secondary action next to the toggle. Also reachable from the `.` row context menu and from the right-click menu on any Nexus terminal tab (docked in the panel, or opened as an editor tab — both are covered). Resolution ladder: (1) the last directory the focused terminal reported, if not stale; (2) failing that, a heuristic candidate read from the terminal's own visible prompt text; (3) whichever candidate steps 1–2 produced is validated with `realpath` plus a directory check before the explorer re-roots; (4) if nothing validated, the Go to Path box opens prefilled with the best candidate found (or the current root) instead of dead-ending; (5) if that also yields nothing, a one-time-per-session notice explains the host never reported a directory. A successful sync (automatic or via the prefilled box) also clears any pause, since this command moves the explorer *toward* the terminal rather than away from it.
- **Continuous coverage** — genuinely continuous, not a poll, for any shell that emits the `OSC 7` "here is my directory" escape sequence before its prompt: `fish` (≥ 3.x) does this unconditionally, and prompt frameworks such as `starship` do too. Plain bash and zsh don't by default; one added snippet each makes them:
  ```bash
  # ~/.bashrc — let Nexus follow this shell's directory
  PROMPT_COMMAND='printf "\033]7;file://%s%s\033\\" "$HOSTNAME" "$PWD"'"${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  ```
  ```zsh
  # ~/.zshrc — let Nexus follow this shell's directory
  __nexus_osc7() { printf '\033]7;file://%s%s\033\\' "${HOST}" "$PWD"; }
  precmd_functions+=(__nexus_osc7)
  ```
  Once added, that shell reports its directory on every prompt from then on. (zsh sets `$HOST` automatically; `$HOSTNAME` is frequently unset there, unlike in bash.)
- **Non-POSIX devices** — Cisco IOS, Juniper, FortiOS, out-of-band console servers, and similar gear never emit `OSC 7` and have no prompt Nexus's heuristic can parse. Nothing breaks: following simply never activates for that session, silently — no periodic retries, no repeated errors, no probing traffic sent to the device. The one exception is **Go to Terminal Directory**: the first time it runs against such a session and finds nothing to sync, Nexus shows one informational message for that session only (`"<server>" didn't report a directory, so Nexus can't follow it. Directory sync is off for this session.`) and stays silent for the remainder of that session.
- **Manual navigation and pausing** — using Go to Path, Go Home, or the `..` row pauses following (state 5, "Pinned") instead of silently overriding your navigation on the next reported directory change. Expanding a subdirectory is not navigation and never pauses anything. **Resume Following Terminal Directory** (or the toggle) clears the pause and jumps to the terminal's current directory; the pause also clears automatically on an explorer server change or a session teardown.
- **The seven states**, rendered in the File Explorer view's title-bar description line (and, for the one abnormal case, as a banner pushed above the tree):

  | # | State | When it happens | What to do |
  |---|---|---|---|
  | 1 | Off | Following is turned off. | Turn it on if you want it. |
  | 2 | Following | On; the focused terminal's server matches the explorer's active server; its last reported directory is 60 seconds old or newer. | Nothing — this is the normal working state. |
  | 3 | Shell not reporting a directory | On and matched, but the host has never reported a directory (no `OSC 7`, and the prompt heuristic never matched). | Run **Go to Terminal Directory** once for a one-time diagnosis, or add the rc hook above if it's a bash/zsh host. Turning Follow on for a host in this state also raises an actionable notice immediately (see below), rather than leaving you to notice the quiet title-bar text on your own. |
  | 4 | Stale | On and matched, but more than 60 seconds have passed with terminal output since the last report — typically `sudo -i`, `su`, `tmux`, or a nested `ssh` swallowing the hook. | Nexus does not re-root automatically on stale data; run **Go to Terminal Directory** if you want to catch up manually. |
  | 5 | Pinned (paused) | Following was on, but you navigated manually (Go to Path / Go Home / `..`). | Click **Resume Following Terminal Directory** to jump back to the terminal's directory and clear the pause. |
  | 6 | Following another server | The focused terminal is connected to a different server than the one the File Explorer is currently showing. | Switch focus to a terminal on the explorer's server, or point the explorer at the terminal's server instead — Nexus never auto-switches the explorer's active server on a focus change. |
  | 7 | Rate-limited off | The terminal reported directory changes faster than Nexus could safely apply them; following was turned off automatically for that session as a burst-protection measure. | Click **Follow Terminal Directory** to turn it back on. |

### 4.5 Port Forwarding
1. Create tunnel profile with `Nexus: Add Tunnel`. Choose tunnel type from the dropdown:
   - **Local Forward (-L)**: local TCP listener forwards to a remote target through SSH.
   - **Reverse Forward (-R)**: the remote SSH server listens and forwards incoming connections back to a local target.
   - **Dynamic SOCKS5 (-D)**: local SOCKS5 proxy routes connections through SSH to arbitrary destinations.
2. Assign a default server, or leave unassigned to choose at start time.
3. Start a tunnel from **Port Forwarding** (right-click > Start), or drag it onto a server in **Connectivity Hub**.
4. In shared mode (default), the SSH connection is established eagerly at tunnel start - 2FA happens once upfront.
5. Active tunnels show traffic counters (bytes in/out).
6. The **Port Forwarding** view shows live route and traffic counters for active tunnels, and marks tunnels owned by another VS Code window separately.
7. Connection mode can be profile-based: `isolated`, `shared`, or `ask every start`. Reverse tunnels always use shared mode.
8. Right-click tunnel item to start/stop/restart/edit/remove/duplicate/copy info/open in browser.
9. Route labels indicate tunnel type with `L`, `R`, or `D`.
10. Cross-window tunnel visibility: all three tunnel types are registered in globalState and visible across VS Code windows.

### 4.6 Serial Sidecar
1. Create a serial profile with `Nexus: Add Serial Profile` (name + group + line settings).
2. Select `Standard` or `Smart Follow` connection mode.
3. Profiles appear in **Connectivity Hub** and support right-click connect/edit/remove/duplicate/rename.
4. Run `Nexus: Connect Serial Port` (or item context action) to open an interactive serial terminal.
5. Active serial sessions are shown under the profile node in **Connectivity Hub**.
6. Unread output marks both the sidebar session node and the terminal tab title until the terminal regains focus.
7. Smart Follow mode tries the saved preferred port first, silently reconnects only when a free replacement matches the saved device metadata, prompts before switching to unfamiliar free replacement ports, updates the saved preferred port after a successful move, and keeps the terminal open while waiting or stopped if the device disappears or serial runtime errors occur.
8. Smart Follow sessions coexist with standard serial sessions as long as they target different ports. Starting any new serial session is blocked only when the target port is already held by another Nexus serial session; the warning toast names the existing session.
9. Use `Nexus: Disconnect Serial Session` from profile/session context menu or command.
10. `Nexus: List Serial Ports` reports detected ports and manufacturers for diagnostics.

### 4.7 Logging and Rotation
1. Terminal and tunnel event logs are enabled automatically.
2. Each log file rotates when it reaches configured max size.
3. Rotation defaults: `10MB` file size and `1` rotated file.
4. Session transcript logs record clean terminal output with ANSI escape sequences and control characters stripped.
5. Settings:
   - `nexus.logging.maxFileSizeMb`
   - `nexus.logging.maxRotatedFiles` (`0-99`)
   - `nexus.logging.sessionTranscripts` (enable/disable)
   - `nexus.logging.sessionLogDirectory` (custom path)

### 4.8 Group Management
- Servers and serial profiles can be organized into named groups.
- Drag and drop items between groups in the Connectivity Hub.
- Right-click a group to rename or remove it.
- Groups can be created from the `+` menu or inline while editing a profile.

### 4.9 Terminal Macros
- Define named macros in the Macro Editor. Macro metadata is stored in VS Code globalState; secret macro text is stored in VS Code SecretStorage.
- Macros appear in the **Terminal Macros** sidebar view (`nexusMacros`).
- See the [Macro Guide](macros.md) for step-by-step setup, trigger scopes, cooldowns, intervals, and regex examples.
- Click the play button or the label to send macro text to the active terminal.
- Press `Alt+S` to open a quick pick of all macros.
- Each macro can have an explicit `keybinding` such as `alt+m`, `alt+shift+5`, or `ctrl+shift+a`. Right-click a macro and select **Assign Shortcut** to edit it.
- Conflict resolution: assigning a shortcut already taken by another macro clears the old assignment.
- Macros without a shortcut remain available via the `Alt+S` quick pick.
- If VS Code terminal/menu settings intercept macro shortcuts, run **Nexus: Fix Macro Keybindings** explicitly. Nexus no longer mutates those global settings during activation.
- Add `triggerPattern` to enable auto-trigger (expect/send). Matching terminal output sends the macro text automatically, with optional per-macro `triggerCooldown`.
- Existing macros with no trigger scope keep the compatibility default of matching all terminals. Secret prompts should use the safer `active-session` or `profile` trigger scope where practical.
- Add `triggerInterval` for polling-style macros. An interval macro starts only when its pattern matches the active terminal; that terminal owns delayed sends even if focus changes. Later matches on that same session send immediately if the interval has elapsed, or wait until it has.
- Add `triggerInitiallyDisabled` when a macro should start paused until you manually resume it from the macros view. If the prompt already matched recently, resuming can fire immediately without extra terminal output.
- Auto-trigger can be paused/resumed per macro from the macros view, and globally toggled with `nexus.terminal.macros.autoTrigger`.
- All auto-trigger state (paused/resumed, interval ownership, cooldown/scheduling timers) is keyed to a stable per-macro identity (`macroStateKey()` in `macroAutoTrigger.ts`: the macro's `id`, or a `name`+`text` composite when `id` is absent), never to the macro's array position. Reordering macros (**Move Up** / **Move Down**) or deleting a different macro cannot reattach one macro's paused/armed state to another — a fix in 2.8.74 for exactly that bug (a paused secret trigger could go live after an unrelated reorder moved it onto an active trigger's old slot, or vice versa).
- Secret macros support **Copy Value** and **Paste Value** from the macros view context menu. Copying writes the macro value to the OS clipboard as plain text.
- Pasting into a secret macro reads the current clipboard text and can optionally append a trailing newline before saving.
- Legacy `slot` values are still read and auto-migrated to `keybinding` on startup.
- Add, edit, remove, reorder, pause/resume auto-trigger, and assign shortcuts via the context menu.

#### 4.9.1 Macro Templates
- `Nexus: Add Macro From Template` opens a starter-template picker and then opens the Macro Editor on the created macro.
- Built-in templates are **Send command**, **Send password when prompted**, **Wait and send confirmation**, **Scoped auto-trigger example**, and **Prompted command** (see 4.9.2).
- The password template creates a secret macro with empty text, an active-session trigger scope, a password prompt pattern, and start-paused enabled. It stores no sample password; the user must enter and save the secret, then resume auto-trigger from the macros view before it can auto-send.
- Auto-trigger templates default to active-session scope so generated macros react only to the active terminal unless the user changes the scope.

#### 4.9.2 Macro Variables
- A macro can declare up to 10 named variables (`MAX_MACRO_VARIABLES` in `macroVariables.ts`) and prompt for them at run time instead of sending fixed text. Each variable has a `name` (`/^[A-Za-z_][A-Za-z0-9_]{0,31}$/`), an optional `label` (defaults to the name), an optional `default` (not allowed when masked), a mask-input flag (`secret`, never persisted or remembered), and a remember flag (non-secret values remember their last-entered value per VS Code window unless turned off for that variable).
- Reference a declared variable in the macro's text as `$name` or `${name}` — both forms resolve once `name` is declared. `$$name` / `$${name}` is the escape for a literal `$name` / `${name}`. A placeholder whose name is not declared is passed through to the terminal untouched, whether written as `$name`, `${name}`, or the `$$`-escaped form — this is deliberate (a typo fails silently rather than blocking the macro) and the Macro Editor's live hints under the Text field are the mechanism for catching it (undeclared-placeholder warning with a one-click "Add variable" fix, declared-but-unused notice, or a "Will prompt for: …" confirmation).
- Only declared variables whose placeholder actually appears, unescaped, in the text are prompted for — once each, in declaration order.
- Runtime flow (`src/commands/macroVariablePrompt.ts`): the target terminal is pinned to `vscode.window.activeTerminal` at invocation, before any prompt is shown. A single reused `InputBox` walks the used variables in order; each step shows a **Back** button except the first. Accepting a step records its value (and remembers it, per the variable's remember flag) and advances; Back steps back one; any other dismissal (Esc, clicking away, a button other than Back) cancels the entire run — no partial send. A masked step never prefills from a remembered value, a default, or a previously entered value for that same step. Once every used variable is collected, the substituted text is sent to the pinned target terminal via `terminal.sendText(text, false)`, even if a different terminal is now active. Only one variable-prompt macro run can be in flight at a time; invoking a second one while the first is still prompting shows a status-bar message naming the busy macro instead of queuing or interleaving prompts.
- This prompting path bypasses VS Code's own `Terminal.sendText`-driven variable resolution — `${workspaceFolder}` / `${env:FOO}`-style tokens in a variables-macro's text are sent to the terminal literally rather than resolved, unlike the plain (variable-free) send path.
- Variables and auto-trigger (`triggerPattern`) are mutually exclusive on the same macro: prompting requires opening a foreground input box, which cannot happen safely from a background pattern match against a possibly-inactive terminal. The Macro Editor surfaces this as a live warning next to both the Variables section and the Auto-Trigger Pattern field the moment a macro carries both. Config import sanitization strips the trigger in this case; a macro that reaches this state some other way (legacy `nexus.terminal.macros` settings absorption, or a direct edit to stored state) renders in the sidebar as a plain, non-auto-triggering macro — no zap icon, no enable/disable toggle — with tooltip text `Auto-trigger suppressed: macro has variables`.
- Variable macros get a `⌸` marker and a distinct icon in the Macros sidebar and the Run Macro quick pick; their sidebar tooltip lists the variable names the macro will actually prompt for.
- The **Prompted command** template (4.9.1) builds `ipmitool -I lanplus -H $host -U $username -P $password sol activate` with `host` (label "Host"), `username` (label "Username"), and `password` (label "Password", masked) declared — the originating feature request's worked example end to end.
- No automatic quoting: substituted values are inserted exactly as entered. See the [Macro Guide](macros.md) for the `'${password}'` single-quote idiom (a deliberate choice — network-device CLIs like Cisco IOS would have a value corrupted, not protected, by auto-quoting) and the `HISTCONTROL=ignorespace` leading-space convention for keeping a value out of the remote shell's own history.

### 4.10 Configuration Export/Import
- `Nexus: Export Configuration` creates a sanitized JSON export suitable for sharing (credentials stripped, learned Smart Follow hardware identifiers removed, IDs remapped).
- `Nexus: Export Backup` creates an encrypted backup that includes profiles, settings, saved credentials, the user `.ssh` folder, and the configured Nexus scripts folder.
- `Nexus: Import…` is the single universal entry point (retitled from `Nexus: Import Configuration`, which used to accept only Nexus's own JSON). It opens a `QuickPick` titled **Import** ("What are you importing?") with six rows under three separators — bulk host-list add first (**Paste Host List from Clipboard**, **Host List File…**), migration from another client second (**MobaXterm INI File…**, **SecureCRT XML Export…**, **SecureCRT Sessions Folder…**), and **Nexus Export File…** last (it's the only branch with a destructive Replace mode, so it's deliberately off the default-focused row) — then dispatches to the matching branch in `configCommands.ts`. It is reachable from the Command Center's `...` overflow menu (`view/title`, group `1_manage@2`, next to **New Folder**) so it's available even once the tree isn't empty, from the Command Center's empty-state welcome view (second link, after **Add Profile**), and from the Data Management section of Settings (single **Import…** row, `cloud-download` icon).
- Not every branch guards its input size, and not every branch sniffs. **Host List File…**, **MobaXterm INI File…**, and **Nexus Export File…**'s failure path each read a dialog-picked file and then sniff the content with `sniffImportFormat()` (`src/utils/importFormatSniffer.ts`, no `vscode` import — pure `{`/`<`/`[Bookmarks(_N)]`-header detection, defaulting to `host-list` for everything else). Sniffing only ever *contradicts* the declared format; it never chooses one (a generic INI's `[General]` header would otherwise parse as a valid server named "General" once `HOST_RE`'s IPv6-bracket tolerance strips the brackets — this is why content-detection isn't the primary mechanism). When the sniff confidently indicates a different supported format, the branch stops with a named error plus a one-click button that re-parses the **same already-read bytes** through the right importer (no re-opened dialog, no re-asked source); **Host List File…**'s contradiction also offers a second button, **Import as Host List Anyway**, so a genuine host list the sniffer mis-flags (say, a hostname list whose first line happens to start with `{`) still has a way through instead of a dead end. Otherwise the branch proceeds into that format's existing parser and tail unchanged. The **SecureCRT XML Export…** / **SecureCRT Sessions Folder…** branches never sniff — they validate content structurally instead (`parseSecureCrtXmlExport`, `hasSecureCrtSessionsRoot`) — and neither does **Paste Host List from Clipboard** or the `.inventory` deep link's file path; both go straight into the inventory parser. Regardless of sniffing, the host-list parser and the SecureCRT XML parser are each capped (2 MB, 10 MB) at a shared tail function (`applyInventoryText`, `applySecureCrtXmlText`) that every route funnels through — the direct dialog **and** every cross-branch reroute — so a reroute can never hand either parser more bytes than its direct route would accept. The MobaXterm and Nexus Export File dialogs have no size guard at all.
  - **Nexus Export File…**: JSON.parse + `isValidExport` failure gets format-aware messaging instead of always pointing at the CSV importer — sniffed as a host list → "That file isn't a Nexus JSON export." + **Import as Host List**; sniffed as MobaXterm → **Import as MobaXterm**; sniffed as XML → **Import as SecureCRT XML**; syntactically valid JSON that just isn't shaped like an export → a generic "valid JSON, but not a Nexus export" message with no button (nothing to reroute to); syntactically broken JSON that still starts with `{` gets its own "could not be parsed as JSON" message rather than being called "valid JSON". Also accepts a minimal hand-written JSON file (`{ "version": 2, "servers": [...] }`) for a single connection or a quick script.
  - **MobaXterm INI File…** / **SecureCRT XML Export…** / **SecureCRT Sessions Folder…**: `Nexus: Import from MobaXterm` and `Nexus: Import from SecureCRT` remain in the command palette as direct shortcuts into the same branches (`.securecrt` keeps its own XML-vs-folder picker). No `[Bookmarks]` section → named error with a reroute when the sniff points elsewhere; a SecureCRT XML whose root lacks `<VanDyke><key name="Sessions">` entirely (as opposed to having it with zero SSH entries inside, or every entry skipped — all "nothing new" outcomes previously returned the same empty result from `parseSecureCrtXmlExport`, distinguished now via the additional `hasSecureCrtSessionsRoot()` export in `securecrtParser.ts`, called only when the parse came back fully empty) gets a dedicated "isn't a SecureCRT export" message; a Sessions folder with zero `.ini` files gets a dedicated message naming the expected `%APPDATA%\VanDyke\Config\Sessions` location. The XML branch's file picker offers an "All Files" filter alongside "SecureCRT XML Files" and does not gate on the `.xml` extension — a renamed export still imports, since content validation (not the file suffix) is what actually distinguishes a SecureCRT export from anything else; only a selected directory is rejected outright with the generic "Unsupported SecureCRT input" message.
  - **Paste Host List from Clipboard** / **Host List File…**: bulk-creates servers from a pasted or file-based device inventory (`src/utils/inventoryParser.ts`). `Nexus: Import Servers from List (CSV/Text)` remains in the command palette as a direct shortcut (keeping its own clipboard-vs-file picker). Accepts an optional header row (columns matched by alias, e.g. `hostname`/`address`/`ip` → host — two or more alias matches are decisive even if an unrecognized column contains punctuation like `mgmt.ip`; a single-column list whose sole row is itself an alias is treated as an ambiguous header and reported as an issue rather than silently dropped), or a positional `host[,name[,username[,port[,folder]]]]` fallback (a 3-field row reads its third column as a username, not a folder) with `user@host:port` shorthand in the host field; comma- and tab-delimited (empty fields preserved), or whitespace-run-delimited (runs collapsed). Hosts are capped at 253 characters and names at 128; both cap violations, and an invalid row-level or prefix folder path, are reported as issues rather than silently accepted or discarded. Capped at 2 MB and 5000 rows — rows are collected without over-allocating past the cap, and truncation reports the real dropped-row count, not just a single generic issue entry. Rows missing a username trigger a single default-username prompt (stating how many rows need it, pre-filled with the most common username among existing servers); the optional folder-prefix prompt is skipped entirely when the list already carries its own folder column, and Esc cancels the whole import from either prompt (an empty Enter on the folder prompt just skips the prefix). Rows whose host+port+username (host compared case-insensitively) already exist are skipped and counted, and the folders they would have created are dropped too so no empty group is left behind; if every row already exists, the message says so plainly instead of pairing a skip count with "no sessions found". Everything culminates in a single confirm modal (`showInformationMessage` with `detail`) summarizing servers to import, folders to create, duplicates to skip, and unparsable/truncated rows, with an additional "Show Skipped Lines" button that opens a scratch document without importing; the apply step runs through `NexusCore.addServersBatch` (one `saveServers`/`saveGroups` write and one change notification for the whole import, instead of one round-trip per row) inside a non-cancellable `withProgress` (the batch is a single write, so there is nothing to cancel). Any remaining parse issues are reported afterward via a **non-awaited** toast so a corner notification the user ignores can never stall the import. Imported servers always get `authType: "password"`.
- The MobaXterm/SecureCRT importers still funnel through the shared `applyImportedSessions` tail in `configCommands.ts` (no-sessions warning, single confirm modal, group + server creation, success toast — pluralized without the "(s)" shorthand), which mints a fresh server `id` per row. The inventory importer above has enough UX differences (dedupe-aware wording, the detail-modal breakdown, batched apply) that it keeps its own tail instead of extending the shared one. `importInventory`'s source acquisition (clipboard/file) is split from its parse-and-apply tail (`applyInventoryText`) so the chooser's clipboard/file rows, the `.inventory` deep link, and cross-branch "Import as Host List" reroutes all share it.

#### 4.10.1 Security & Data Settings
- The Settings view includes a **Security & Data** category for host trust, credential storage, backups, exports, imports, resets, and data deletion.
- Credentials are stored in VS Code SecretStorage. Host keys and non-secret profile metadata are stored in VS Code global state.
- **Encrypted Backup** / `Nexus: Export Backup` is password-protected and can include secrets, the user `.ssh` folder, and the configured Nexus scripts folder.
- **Export for Sharing** / `Nexus: Export Configuration` is sanitized for sharing: credentials are stripped, learned Smart Follow hardware identifiers are removed, and IDs are remapped.
- **Import…** (single unified row; the `Nexus Export File…` branch of the chooser restores either encrypted backup or sanitized export data). Merge preserves existing local `.ssh` / script files; replace overwrites files present in the backup but does not delete extra local files.
- **Reset All Settings to Defaults** resets extension settings. **Delete All Data** / `nexus.config.completeReset` is destructive and removes Nexus data after confirmation.

### 4.11 Terminal Tab Commands
Right-click any Nexus terminal tab (SSH, Standard Serial, or Smart Follow Serial — docked in the panel or opened as an editor tab) to access three PuTTY-style commands:

- **Reset Terminal** — clears the visible terminal screen while preserving scrollback. The noisy or scrambled output is pushed up into scrollback where it can still be reviewed. The underlying session and terminal modes are untouched; the remote shell receives nothing. Use this when stray output clutters the screen but you want your history intact.
- **Clear Scrollback** — clears both the visible scrollback and the Nexus-maintained capture buffer. After running this command, *Copy All to Clipboard* returns only post-clear output. Note that clearing the terminal via VS Code's own built-in clear (from other surfaces) does NOT clear the Nexus capture buffer; only this command keeps them in sync.
- **Copy All to Clipboard** — copies the ANSI-stripped transcript of the session to the system clipboard. A toast reports the number of lines copied; an empty buffer shows "Nothing to copy." instead. The capture buffer's size tracks your `terminal.integrated.scrollback` setting and updates when that setting changes.

After a session disconnects but before the terminal tab is closed, *Reset Terminal* and *Clear Scrollback* grey out (nothing to act against), while *Copy All to Clipboard* remains enabled so you can still capture the full transcript for a ticket or chat. All three commands are also discoverable from the Command Palette, gated on an active Nexus terminal.

**Extension reload / disable / update.** When the VS Code window reloads, the extension is disabled, or Nexus is updated, VS Code does not reliably deliver a final write to the terminal before the extension host exits (it races the 1–4s shutdown timeout and the pseudoterminal IPC channel — see [microsoft/vscode#122825](https://github.com/microsoft/vscode/issues/122825) and [#140697](https://github.com/microsoft/vscode/issues/140697)), so any in-tab farewell banner is best-effort only. Instead, the next time the extension activates, Nexus scans `window.terminals` for its own naming pattern (`Nexus SSH:` / `Nexus Serial:`) and, if it finds any, shows an information notification — e.g. *"Nexus: 3 sessions disconnected after an extension reload or restart. The tabs are frozen on their last output — close them manually when you are done reviewing. Reconnect from the Connectivity Hub when ready."* The zombie tabs are **not** auto-closed: the last-rendered content (command history, log tails, error output) is usually worth reviewing, and closing is left to the user.

**Capture-buffer semantics** (implementation notes that surface in edge cases):

- The capture buffer is sized in **lines**, not bytes, matching the `terminal.integrated.scrollback` setting. A realistic interactive shell newline-terminates output promptly, so the retained size is well-bounded (~80 KB per session at the default 1000-line cap, 80-char average). A single never-terminated output (e.g., a raw binary paste with no `\n`) will accumulate in the pending-line fragment until a newline arrives or the terminal closes.
- An unfinished line (no trailing `\n`) still counts as one line in the "Copied N lines" toast and is included in the copied text — so a prompt like `switch> ` with no Enter yet adds 1 to the reported count.
- Setting `terminal.integrated.scrollback` to `0` does not disable Nexus capture; the buffer falls back to a 1000-line default so that *Copy All* and *Clear Scrollback* remain useful. If you need zero retention, close the terminal tab.

## 5. Settings Reference

### 5.1 SSH

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `nexus.ssh.trustNewHosts` | boolean | `true` | — | Auto-trust host keys on first connection (TOFU) |
| `nexus.ssh.multiplexing.enabled` | boolean | `true` | — | Share SSH connections across terminals, tunnels, and SFTP |
| `nexus.ssh.multiplexing.idleTimeout` | number | `300` | 0–3600 s | Idle timeout before closing a multiplexed connection |
| `nexus.ssh.connectionTimeout` | number | `60` | 5–300 s | SSH handshake timeout |
| `nexus.ssh.keepaliveInterval` | number | `10` | 0–300 s | Interval between keepalive packets (`0` disables) |
| `nexus.ssh.keepaliveCountMax` | number | `3` | 1–30 | Missed keepalives before the connection is treated as dead |
| `nexus.ssh.terminalType` | enum | `xterm-256color` | `xterm-256color`, `xterm`, `vt100`, `vt220`, `dumb` | `$TERM` value reported to the remote shell |
| `nexus.ssh.proxyTimeout` | number | `60` | 5–300 s | SOCKS5 / HTTP CONNECT proxy handshake timeout |

### 5.2 SFTP


| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `nexus.sftp.cacheTtlSeconds` | number | `10` | 0–3600 s | Directory listing cache TTL |
| `nexus.sftp.maxCacheEntries` | number | `500` | 10–5000 | Maximum cached directory listings |
| `nexus.sftp.autoRefreshInterval` | number | `10` | 0–60 s | Polling interval for the file explorer; also used as the auto-mode safety net unless recursive inotify is available |
| `nexus.sftp.remoteWatchMode` | enum | `auto` | `auto`, `polling` | Remote change detection mode for the file explorer |
| `nexus.sftp.operationTimeout` | number | `30` | 5–300 s | Timeout for SFTP directory and metadata operations (listing, stat, realpath, rename, mkdir, delete) |
| `nexus.sftp.commandTimeout` | number | `300` | 10–3600 s | Timeout for remote shell commands, file transfers, and editor file open/save |
| `nexus.sftp.deleteDepthLimit` | number | `100` | 10–500 levels | Safety limit: max directory depth for recursive delete |
| `nexus.sftp.deleteOperationLimit` | number | `10000` | 100–100000 | Safety limit: max items removed by one recursive delete |
### 5.3 Tunnels

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `nexus.tunnel.defaultConnectionMode` | enum | `shared` | `shared`, `isolated` | SSH connection mode for tunnels |
| `nexus.tunnel.defaultBindAddress` | string | `127.0.0.1` | — | Default bind address for reverse tunnels |
| `nexus.tunnel.socks5HandshakeTimeout` | number | `10` | 2–60 s | Dynamic tunnel SOCKS5 handshake timeout |

### 5.4 Terminal

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `nexus.terminal.openLocation` | enum | `editor` | `panel`, `editor` | Where to open terminals |
| `nexus.terminal.keyboardPassthrough` | boolean | `true` | - | Pass Ctrl+ key combinations to the terminal |
| `nexus.terminal.passthroughKeys` | array | `[b,e,g,j,k,n,o,p,r,w]` | - | Which Ctrl+ keys to pass through |
| `nexus.terminal.macros.autoTrigger` | boolean | `true` | - | Enable auto-trigger for macros with a `triggerPattern` |
| `nexus.terminal.macros.defaultCooldown` | number | `3` | 0–300 s | Default cooldown for auto-trigger macros |
| `nexus.terminal.macros.bufferLength` | number | `2048` | 256–16384 chars | Max characters retained per terminal for pattern matching |
| `nexus.terminal.highlighting.enabled` | boolean | `true` | — | Enable regex-based terminal highlighting. Rules are edited in the Highlighting Rules editor and unsafe regex shapes are rejected before use. |

### 5.5 Logging

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `nexus.logging.sessionTranscripts` | boolean | `true` | — | Enable session transcript logging |
| `nexus.logging.sessionLogDirectory` | string | *(extension storage)* | — | Custom directory for session logs |
| `nexus.logging.maxFileSizeMb` | number | `10` | 1–100 MB | Max log file size before rotation |
| `nexus.logging.maxRotatedFiles` | number | `1` | 0–99 | Number of rotated log files to keep |

### 5.6 Serial

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `nexus.serial.rpcTimeout` | number | `10` | 2–60 s | Timeout for serial sidecar commands |

### 5.7 UI

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `nexus.ui.showTreeDescriptions` | boolean | `true` | Show connection details beside items in the Connectivity Hub |

## 6. Commands and Views

### 6.1 Views
- `nexusCommandCenter`: servers, serial profiles, and active sessions.
- `nexusTunnels`: tunnel profiles and active traffic state.
- `nexusFileExplorer`: remote file browser for the active connected server.
- `nexusMacros`: terminal macros with optional custom keyboard shortcuts and auto-trigger state.
- `nexusScripts`: script files, run state, and script view actions.
- `nexusSettings`: extension settings sidebar panel.

### 6.2 Commands
**Server:**
- `nexus.server.add`, `nexus.server.edit`, `nexus.server.remove`
- `nexus.server.connect`, `nexus.server.testConnection`, `nexus.server.disconnect`
- `nexus.server.runWithScript`
- `nexus.server.copyInfo`, `nexus.server.duplicate`, `nexus.server.rename`
- `nexus.server.deployKey`

**Group:**
- `nexus.group.add`, `nexus.group.remove`, `nexus.group.rename`
- `nexus.group.connect`, `nexus.group.disconnect`

**Tunnel:**
- `nexus.tunnel.add`, `nexus.tunnel.edit`, `nexus.tunnel.remove`
- `nexus.tunnel.start`, `nexus.tunnel.stop`, `nexus.tunnel.restart`
- `nexus.tunnel.copyInfo`, `nexus.tunnel.duplicate`, `nexus.tunnel.openBrowser`

**Serial:**
- `nexus.serial.add`, `nexus.serial.edit`, `nexus.serial.remove`
- `nexus.serial.connect`, `nexus.serial.testConnection`, `nexus.serial.disconnect`
- `nexus.serial.runWithScript`
- `nexus.serial.copyInfo`, `nexus.serial.duplicate`, `nexus.serial.rename`
- `nexus.serial.listPorts`, `nexus.serial.sendBreak`

**Local Shell:**
- `nexus.localShell.add`, `nexus.localShell.edit`, `nexus.localShell.remove`
- `nexus.localShell.connect`, `nexus.localShell.runWithScript`, `nexus.localShell.disconnect`
- `nexus.localShell.copyInfo`, `nexus.localShell.duplicate`, `nexus.localShell.rename`

**Profile:**
- `nexus.profile.add` (unified add form)
- `nexus.profile.actions` (tree-item quick-action picker; hidden from the Command Palette)

**Auth Profile:**
- `nexus.authProfile.add`, `nexus.authProfile.manage`
- `nexus.authProfile.applyToFolder`, `nexus.authProfile.applyToServer`

**Macros:**
- `nexus.macro.editor`
- `nexus.macro.add`, `nexus.macro.addFromTemplate`, `nexus.macro.openDocs`, `nexus.macro.edit`, `nexus.macro.remove`
- `nexus.macro.run` (Alt+S quick pick)
- `nexus.macro.runBinding` (explicit shortcut dispatch)
- `nexus.macro.runItem` (tree item click/play button)
- `nexus.macro.assignSlot` (assign/remove custom shortcut via context menu)
- `nexus.macro.moveUp`, `nexus.macro.moveDown`
- `nexus.macro.disableTrigger`, `nexus.macro.enableTrigger`
- `nexus.macro.copySecret`, `nexus.macro.pasteSecret`
- `nexus.macro.copyAllAsJson`

**Scripts:**
- `nexus.script.new` (opens the script template picker before naming the script)
- `nexus.script.run`, `nexus.script.runQuick`, `nexus.script.stop`
- `nexus.script.edit`, `nexus.script.delete`
- `nexus.script.openOutput`, `nexus.script.openDocs`, `nexus.script.openExamples`
- `nexus.script.openScriptsFolder`, `nexus.script.revealInExplorer`

**Files:**
- `nexus.files.browse`, `nexus.files.open`
- `nexus.files.upload`, `nexus.files.download`
- `nexus.files.delete`, `nexus.files.rename`
- `nexus.files.createDir`, `nexus.files.createFile`
- `nexus.files.goToPath`, `nexus.files.goHome`
- `nexus.files.copyPath`, `nexus.files.refresh`, `nexus.files.disconnect`

**Config:**
- `nexus.config.export`, `nexus.config.export.backup`
- `nexus.config.import`, `nexus.config.import.mobaxterm`, `nexus.config.import.securecrt`, `nexus.config.import.inventory`
- `nexus.config.completeReset`

**Settings and Appearance:**
- `nexus.settings.openPanel`
- `nexus.openHighlightRuleEditor`
- `nexus.terminal.appearance`
- `nexus.settings.openJson`, `nexus.settings.openLogDir`
- `nexus.settings.resetAll`

**General:**
- `nexus.refresh`
- `nexus.filter`, `nexus.filter.clear`

## 7. Test Strategy

### 7.1 Unit Tests
- `test/unit/silentAuth.test.ts`: vault reuse, auth retry, cancellation, non-password auth path.
- `test/unit/nexusCore.test.ts`: repository load, CRUD, session/tunnel lifecycle updates.

### 7.2 Integration Tests
- `test/integration/tunnelManager.integration.test.ts`: local/reverse/dynamic tunnel forwarding through real TCP sockets, SOCKS5 handshake, and traffic event verification.
- `test/integration/serialSidecarManager.integration.test.ts`: sidecar request/response and notification flow with a mock worker process.

Run:
```bash
npm test
```

## 8. MVP Coverage vs Spec

Implemented (~90% target):
- Hybrid architecture with serial sidecar process.
- Nexus core state manager.
- Silent Auth workflow with secret invalidation + save/retry.
- Two-factor authentication (keyboard-interactive) for all SSH auth types.
- Port Forwarding model with drag/drop start and eager shared connection.
- Active tunnel counters and cross-window visibility in the Port Forwarding view.
- Dedicated terminal/tunnel connection model.
- Interactive serial terminal sessions through sidecar-managed ports.
- Session transcript logging with ANSI stripping and rotation.
- Configuration export/import.
- Browser-host fallback entrypoint with safe "desktop required" UX instead of activation failure.
- Build/test/packaging scripts.

Deferred (~10%):
- Full browser-host feature parity for Node-dependent runtime features.

## 9. Scripts

Author-and-run automation on top of any active SSH, Serial, or Local Shell session.

### 9.1 Flow
1. Create a `.js` file under `<workspaceRoot>/<nexus.scripts.path>` (default `.nexus/scripts/`). Tag the leading JSDoc block with `@nexus-script` and any of the optional fields `@name`, `@description`, `@target-type`, `@target-profile`, `@default-timeout`, `@lock-input`, `@allow-macros`.
2. First time a Nexus script command runs in the workspace, `ScriptTypesGenerator` seeds `types/nexus-scripts.d.ts` + `jsconfig.json` so the editor gives autocomplete and JSDoc hovers for `expect`, `sendLine`, `poll`, `prompt`, etc.
3. Invoke `nexus.script.run` from the Command Palette / sidebar / `▶ Run in Nexus` CodeLens. The runtime parses the header, resolves the target session (filter by `@target-type` values `ssh`, `serial`, or `local`; auto-select on `@target-profile` id/name match; else QuickPick), and spawns a `node:worker_threads` Worker.
4. While running, the script's status shows in the **Nexus Scripts** status-bar entry and the **Nexus Scripts** Output Channel logs timestamped events (`→ expect …`, `← matched`, `log info: …`, `end: completed (…ms)`).

#### 9.1.1 Script Templates
- `Nexus: New Nexus Script` opens a starter-template picker before asking for the script name.
- Built-in templates are **Basic command**, **Wait for prompt then send**, **Capture command output**, and **Backup running config**.
- New scripts are written to the resolved scripts directory: `<workspace>/<nexus.scripts.path>` when a workspace folder is open, or the extension global-storage scripts directory when no folder is open.
- If `<name>.js` already exists, Nexus opens the existing file instead of overwriting it.
- Template bodies include the required `@nexus-script` marker and use the entered script name in the generated `@name` field.
- The generated script comments link developers to `types/nexus-scripts.d.ts`; that type file is seeded on first script command run in the workspace.

### 9.2 Macro coordination
- When a script starts, macros on the script's bound session are suspended by default (`nexus.scripts.macroPolicy = "suspend-all"`). Macros on unrelated sessions keep firing.
- `@allow-macros name1, name2` in the header whitelists specific macros.
- Inside the script: `macros.allow("pw")`, `macros.deny("pw")`, `macros.disableAll()`, `macros.restore()` mutate the active policy for the rest of the run. The original policy restores on any exit path.

### 9.3 Stopping / failure paths
- User stops from the status bar, CodeLens, or `nexus.script.stop`. `worker.terminate()` kills tight loops in <100 ms.
- Wait timeout: `expect` throws `{ code: "Timeout", pattern, timeoutMs, elapsedMs }`; `waitFor` returns `null`.
- SSH drop / serial session close / Local Shell unregister while a wait is pending: pending RPCs reject with `{ code: "ConnectionLost", sessionId }`; the runtime gives the script a 150 ms grace period to run `try/catch`/`finally` before force-termination.
- Macros, input lock, and output-observer subscription are restored/disposed on every exit path (`finally` in `cleanupRun`).

### 9.4 Isolation
- The Worker has its own V8 isolate with `resourceLimits.maxOldGenerationSizeMb = 192` so a runaway allocation terminates the worker rather than bloating the extension host.
- The Worker bundle (`dist/services/scripts/scriptWorker.js`) does NOT import `vscode`. All UI operations round-trip through the main thread via structured-clone `postMessage`.
