# Changelog

## [2.8.83] — 2026-08-08

### Added

- **An inventory source can now carry an auth profile, so synced servers connect without hand-editing each one.** Servers created by a NetBox sync were always stamped with agent authentication, which meant that on password or key infrastructure every single one failed to connect with "All configured authentication methods failed" — and every device added at the source later arrived broken the same way. The Add and Edit Inventory Source forms now offer an Auth Profile alongside the default username, including creating a new profile inline without leaving the form, and servers the sync creates are linked to it. Choosing a profile fills in the default username from it and locks the field, so the two can never disagree.
- **Servers already synced adopt the source's auth profile on the next sync.** Only servers still carrying exactly what the sync gave them are touched — no profile, agent authentication, no key path, and the username the sync itself last wrote onto them. Anything you have edited by hand keeps its own credentials. The switch is listed in the sync plan for review before it is applied, and Show Warnings names every affected server so you can check the whole list before choosing Apply. Servers synced by an earlier version carry no record of the username they were given, so for those the comparison falls back to the source's current default username as before; if the auth profile you pick uses a different username than the source's default did, use Apply Auth Profile on the folder for that first batch.
- **Clearing the auth profile on a single synced server is a per-server opt-out that later syncs respect.** Set Auth Profile back to (None) on one server and the sync leaves it alone from then on — including after the source is pointed at a different profile — instead of reattaching the source's profile on the next run. Servers where the sync never applied a profile are unaffected and still adopt one when the source gains it. Deleting the profile itself is not an opt-out: it already clears the link everywhere it was used, and those servers stay eligible for whatever profile the source is given next.
- **Inventory sources are reachable from the Settings panel.** Previously the only way to edit or remove a source was the Command Palette. Settings now lists Inventory Sources alongside Macros and Auth Profiles, opening a hub that lists every configured source and offers Sync Now, Edit, and Remove for each — plus adding the first one when none exist yet.

### Fixed

- **Deleting an auth profile now clears it from inventory sources, not just servers.** The reference was already cleared from every server that used the profile, but a source still pointing at it would have handed a deleted profile to the next sync.
- **The delete confirmation for an auth profile now counts linked inventory sources too.** It only ever mentioned linked servers, so deleting a profile a source depended on looked harmless — while every device that source synced afterwards would have arrived on the default username with SSH agent authentication, with nothing anywhere saying why.
- **An auth profile created from inside a form now fills in and locks its fields immediately**, exactly as picking an existing one already did. This also affects the server form, where the same gap existed.

## [2.8.79] — 2026-08-06

### Security

- **Dependency updates close advisories in the SSH proxy path and in the packaging toolchain.** `ip-address` (10.2.0 → 10.4.0) is the only one of these that ships inside the extension — it reaches the bundle through `socks`, which handles SOCKS proxying for SSH connections. The rest are build-time only and never leave the repository: `undici` (7.28.0 → 7.29.0) and `fast-uri` (3.1.4 → 3.1.5) arrive via `@vscode/vsce`, and `brace-expansion` (5.0.7 → 5.0.9) fixes two high-severity denial-of-service advisories in the glob matcher `vsce` uses while packaging. No extension code changed; `npm audit` now reports no vulnerabilities in either the runtime or the development tree.

## [2.8.78] — 2026-08-01

### Changed

- **The README and Marketplace listing now open with a demo of multi-hop jump-host connectivity.** The page described chaining through jump hosts but never showed it, and the listing is where most people decide whether this replaces their current client. The recording sets a two-level chain — an access switch reached through an NMS host, which is itself reached through a bastion — then connects, authenticating each hop in turn before the shell lands on the switch. No code changed in this release; the Marketplace only picks up a README change when a new version is published.

## [2.8.77] — 2026-07-31

### Added

- **Drag a script onto a folder to move it there.** 2.8.75 added folders to the Scripts sidebar but no way to put an *existing* script into one — not by drag, not by any command — so the only route was moving the file in VS Code's Explorer. Drop a script on a folder to move it in, on another script to put it in that script's folder, or on empty space to move it back to the root. Because a script folder is a real directory, the drop renames the file: an editor you have open on it follows along, and Undo puts it back. Nexus refuses and says why in three cases — the script is running (stop it first), a file of the same name is already in the target folder (nothing is ever overwritten), or the file is not inside the scripts folder. Folders themselves are not draggable, and one script moves per drag.

### Fixed

- **Open Scripts Folder opened the wrong folder.** It used VS Code's "reveal in OS" action, which reveals its target *inside the containing folder* — so, handed a directory, it opened that directory's parent: `.nexus` rather than `.nexus/scripts`, or the extension's global-storage folder when no workspace is open. Neither contains a script. It now opens the scripts folder itself.

## [2.8.76] — 2026-07-31

### Fixed

- **A macro whose text began with a blank line lost that line whenever the Macro Editor was opened and saved.** The HTML parser discards one newline immediately after a `<textarea>`, so the form came up already missing it, and the editor saves the text exactly as the form returns it — pressing **Save** with no edit at all silently rewrote the macro one line shorter. The editor now emits a newline of its own for the parser to discard.

## [2.8.75] — 2026-07-31

### Added

- **Folders in the Terminal Macros sidebar.** Create one with **New Folder** in the view title, then drag a macro onto it or use **Move to Folder** from its context menu. Folders nest (`Cisco/Access`), sort above macros, and persist even while empty — an empty folder stays until you remove it, so you can set up a structure before filling it. Macros keep their manual order inside a folder, and **Move Up** / **Move Down** now move a macro within its own folder rather than jumping it out. **Remove Folder (keep macros)** never deletes anything: it moves the folder's contents up to its parent, preserving any subfolders. The Macro Editor gained a **Folder** field with suggestions from your existing folders, and the Run/Remove/Assign-Shortcut pickers now show which folder each macro is in, so two macros called `reload` in different folders are no longer indistinguishable.
- **Folders in the Scripts sidebar, backed by real directories.** A folder in the sidebar is an actual directory under your scripts path — nothing is stored separately, so organising scripts on disk and organising them in the sidebar are the same act. **New Folder** creates a directory; **New Script** accepts a path (`cisco/backup`) and creates any directories it needs; folders also offer **New Script** and **Reveal in Explorer**. Subdirectories previously existed on disk but were silently ignored by the sidebar.
- **Connect and Run Script now finds scripts in subfolders.** It previously scanned only the top level of the scripts directory, so a script moved into a folder disappeared from that flow with a misleading "no compatible scripts" message. It now scans recursively and shows each script's folder path.
- A **Refresh** button on the Scripts view, and the file watcher now notices directories being renamed or deleted — previously it only watched `.js` files, so renaming a folder left stale entries in the sidebar with no way to clear them short of reloading the window.

### Changed

- The Scripts sidebar scan is bounded: it stops after 10 levels of nesting or 500 examined entries and shows a note at the top of the tree (clicking it opens the `nexus.scripts.path` setting). This matters because that setting accepts an absolute path, so it can be pointed at a large directory. Dot-directories and `node_modules` are skipped, as is the generated `types/` directory at the scripts root — a folder of your own named `types` deeper in the tree is scanned normally.
- A symlinked (or junctioned) folder inside the scripts directory is scanned and its scripts are listed, but VS Code's file watcher cannot follow links nested inside the folder it watches, so changes made in the link's target do not refresh the view on their own. Those folders now carry a link icon and a hover explaining it — use **Refresh Scripts**. **Connect and Run Script…** rescans every time and is unaffected.

## [2.8.74] — 2026-07-31

### Changed

- **Nexus Terminal now requires VS Code 1.105 or newer** (previously 1.95). VS Code 1.105 was released in October 2025. If you are on an older build, the Marketplace will not offer this update and installing the VSIX by hand will be refused — update VS Code first. The reason is a single API: 1.105 is the first release in which an extension can ask VS Code which secrets it has stored, and that is what makes **Complete Reset** able to remove every macro secret rather than only the ones Nexus had separately written down. See the Complete Reset entry below for what that replaces.

### Fixed

- **Reordering a macro no longer moves another macro's paused/resumed auto-trigger state onto it.** `MacroAutoTrigger` tracked which macros were paused by their position in the list, and **Move Up** / **Move Down** change positions without moving that state — so reordering could silently resume a macro you had paused and pause one you hadn't. With a paused secret macro (a password auto-send, say) sitting next to an active trigger, a single Move Down was enough to make the secret one live again. All auto-trigger state — paused/resumed, interval ownership, cooldown timers — is now keyed to the macro itself, so it follows the macro wherever it moves in the list. Deleting a macro no longer shifts the state of the ones after it either.
- **Two macros that share an internal id no longer auto-trigger at all.** A macro list written by an older Nexus version, or edited by hand, can hold two macros that are indistinguishable to the auto-trigger — pausing one would pause the other, and resuming one could quietly arm a secret macro you never resumed. (No import can create the situation any more: Replace mode re-keys every imported macro, Merge mode drops any whose id you already have, and legacy `nexus.terminal.macros` absorption re-keys an absorbed macro that collides with a stored one.) Nexus now suppresses the auto-trigger for both and flags them in the Macros view with a warning icon and an explanation, rather than guessing which macro is which. **Move Up** / **Move Down** on any macro assigns fresh ids and clears the conflict. The macro editor also now refuses to save or delete a macro whose id is shared, instead of silently overwriting the other one. Existing ids are never rewritten while loading, so a secret macro's stored password is never reassigned or deleted behind your back.
- **Macros no longer fail to load when `nexus.terminal.macros` in `settings.json` contains a malformed entry.** A `null` in that array (or in the stored macro list) threw during startup migration, which aborted extension activation.
- **Startup no longer rewrites macro ids.** The legacy `slot` → `keybinding` migration used to re-save the whole macro list during activation whenever any macro still carried a `slot` — which also assigned fresh ids to any duplicate-id pair, before you had seen the warning about it, and so could arm two secret macros that should both have stayed suppressed. The migration now happens as macros are read, with no write at all; the stored record is updated by the next save you make.
- **A momentary keychain failure can no longer wipe every saved macro secret.** When the OS keyring is unavailable, VS Code's secret storage reports "no value" rather than an error, so every secret macro read back as empty — and the next save of any kind wrote those empty values over the real ones. Nexus now remembers which secrets failed to read and leaves their stored values alone. (While a value is unreadable it also cannot be deliberately cleared; reopen the window once the keyring is available.)
- **A crash mid-save no longer strands a saved macro password where nothing can find it, and neither does a second VS Code window.** **Complete Reset** now asks VS Code directly which secrets this extension has stored and removes every macro secret it finds, so it reaches ones no macro record names any more: a password left behind when a crash, a full disk or a storage error interrupted a save between writing the value and writing the macro list; one re-created by a save in one window at the moment another window was deleting the macro; and one written by an older Nexus version. Nothing else Nexus stores is touched — server passwords, key passphrases, proxy credentials and auth-profile secrets are left alone. A save also still writes a secret's new value before deleting its old one, so a secret being moved to a new id is never deleted from the old one first. Absorbing legacy `nexus.terminal.macros` settings no longer overwrites macro changes made in another VS Code window while it was running — it retries on the next start instead.

  Being able to ask is why this release raises the minimum VS Code version (see above). Until now Nexus kept its own register of which macro secrets it had written — a list in VS Code's shared extension storage — because there was no way to ask. Two VS Code windows adding a secret at the same moment each wrote their own copy of that list, so one of them could be dropped, and a password named by nothing is a password **Complete Reset** cannot remove. That register is gone rather than kept alongside: what VS Code reports is everything the register could have named and everything it could have lost. A leftover copy of the old list in your profile is simply ignored — it is never read, and it cannot cause anything to be deleted or missed — and the next **Complete Reset** removes it along with everything else.
- **The Macro Editor now tells you when a save fails instead of leaving you looking at "Unsaved changes" with no explanation.** The editor panel's messages are handled through a VS Code event, which — unlike a command — reports nothing when the handler fails. So if saving hit a storage error (the unwritable-folder case above, most likely on a roaming or network-backed profile), the editor stayed silent: no notification, no error next to the Save button, and nothing to say the edit had not been written. Failures are now reported in both places, your edit is left in the panel rather than being replaced by what is still stored, and the "Unsaved changes" marker correctly stays on until a save actually succeeds. A failed **delete** is reported as a failed delete rather than as a failed save.
- **Restoring a backup in Replace mode can no longer hand an imported macro one of your existing macros' saved passwords.** A macro's internal id in a backup file is only an id on the machine that wrote it, but Replace mode was matching those ids against local ones. With the OS keyring temporarily unavailable, an imported secret macro whose own password was missing from the backup could take over the vault entry of a local macro that happened to share its id — and then resolve to that local password, with its auto-trigger live, once the keyring came back. Replace mode now assigns every imported macro a fresh id and removes the replaced macros' stored secrets, so nothing is inherited. Merge mode still skips any imported macro whose id you already have, and additionally skips one that matches a macro you already have — see the duplicate-on-merge entry below.
- **Saving a macro now publishes one window's whole view of your macros, secrets included — which stops a second window from silently emptying a secret.** 2.8.73 tried to protect a password edited in another window by not rewriting a secret this window had not changed. That left the two windows' views mixed: if the other window had deleted the macro (or run **Complete Reset**) in the meantime, the macro came back marked as secret with no stored value behind it — an empty secret, reported to nobody. Checking that the value is still there before skipping does not fix it either; VS Code offers no way to check and write as one operation, so the check can be out of date before the write it guards.

  So the rule is now the simplest one that cannot produce that state: a save writes every secret the saving window holds, alongside the macro list it already rewrote in full. **The trade, stated plainly:** if you edit macros in two VS Code windows at once, saving in the window with the older view puts its whole view back — names, triggers, order, and now secret values too. That was already true of everything except the secret value. What is *not* covered: if the other window deletes a secret in the instant between this save writing it and this save committing the macro list, the record can still name a value that is gone. That needs the two saves to overlap, not merely a stale window, and VS Code gives extensions no lock or compare-and-swap to close it. Within a single window it cannot happen at all — **Complete Reset** issued while a macro save is waiting on an OS keychain prompt now runs after that save instead of through it.
- **Merging a backup you had already restored in Replace mode does not duplicate the macros in it.** This is the other half of the Replace-mode fix above and ships with it. Because Replace now gives each imported macro a fresh internal id, none of the ids in that file names anything locally afterwards — so a follow-up Merge of the same file, matching on id alone, would have added a second copy of every macro in it. Two copies with different ids are not caught by the duplicate-macro safeguard, so both would auto-trigger on the same output and a secret macro answering a `Password:` prompt would send the password twice. Merge now also skips an imported macro that already matches one you have in every respect — name, text, secret flag, shortcut, the whole auto-trigger configuration (pattern, scope, target profile, cooldown, repeat interval, start-paused) and every field of every declared variable — exactly as importing a shared macro file already did. The match has to be that complete: anything left out of it would be a field two genuinely different macros can differ in while one of them is dropped from the import without a word.

  It also has to compare what a macro *does* rather than how it happens to be spelled, and three spelling differences are now collapsed. **A macro you have opened in the Macro Editor and saved is no longer re-added when you later merge a backup written before that save** — the editor always records a trigger scope, older files and shared macros often leave it out, and "all terminals" is what both mean; with them treated as different macros you got two copies, both auto-triggering, so a `Password:` responder answered one prompt twice. **A macro whose only difference is a leftover cooldown or interval on a macro with no trigger pattern** is likewise the same macro (those settings do nothing without a pattern). And **a shortcut written in the old `slot` form now matches the same shortcut written the current way** — while two macros on *different* slots are correctly kept apart, which they were not before: the second was silently dropped from the import. In the other direction, **a secret macro saved by a much older version is no longer mistaken for a plain macro with the same text**, which discarded the plain one. A macro you have edited locally is still matched by id, so the backup's older copy does not come back beside it.
  Import itself had to change with it. A trigger timing written in a form Nexus adjusts — a cooldown above the 300-second maximum, a cooldown quoted as text, a repeat interval below one second — is now brought in as the timing the trigger actually runs with, instead of being dropped from the imported copy. Dropping it changed what the macro does (a pinned cooldown silently became "follow the default cooldown setting"), so the imported copy no longer matched the macro it came from and landed beside it as a second copy with its own live trigger. That was reachable without any second machine: exporting your macros to a shareable file and importing that same file back duplicated them. A start-paused flag written as text rather than true/false is honoured for the same reason, and a trigger scope Nexus does not recognise is now treated as the do-nothing it has always been at runtime rather than as a difference between two macros.

- **Absorbing old `nexus.terminal.macros` settings no longer loses macros that differ only in their trigger settings or shortcut slot.** The one-time migration out of `settings.json` compared macros on name, text, trigger pattern and shortcut alone, then cleared the setting — so two auto-triggers differing only in cooldown, repeat interval, start-paused, trigger scope or target profile, or two shortcuts on different legacy slots, were collapsed into one and the other was gone for good. The comparison now covers the whole macro, and re-importing the identical settings (Settings Sync replaying them, for instance) still adds nothing.

## [2.8.73] — 2026-07-29

Adds prompted input variables to macros (#35 follow-up) — the editor, sidebar, and template surface of the feature; the underlying scan/substitution engine and the runtime prompt flow ship in the same release.

### Added

- **Macros can now declare named variables and prompt for them at run time.** Add one or more variables in the Macro Editor's new **Variables** section (name, optional label, optional default, mask-input, remember), reference them in the macro's text as `$name` or `${name}`, and running the macro walks a step-by-step input box for each one actually used — filling in the command before it is sent to the terminal you invoked it from, even if you switch tabs while the prompts are still open. A new **Prompted command** template (Add Macro From Template) builds the `ipmitool ... sol activate` example from the originating feature request end to end, with `host` / `username` / `password` declared and the password masked.
- **Live editor feedback under the Text field** flags an undeclared `$foo` placeholder (with a one-click **Add variable "foo"** fix), a declared-but-unused variable, or confirms `Will prompt for: host, username, password` once the macro is well-formed — plus a live warning, shown immediately next to both the Variables section and the Auto-Trigger Pattern field, the moment a macro carries both a trigger pattern and a variable (they're mutually exclusive: prompting means opening an input box, which cannot happen safely from a background auto-trigger match). A macro that somehow has both renders in the sidebar as a plain, non-triggering macro with an explanatory tooltip rather than dead trigger controls.
- Variable macros get a `⌸` marker and a distinct icon in the Macros sidebar and the Run Macro quick pick, and their sidebar tooltip lists the variable names the macro will actually prompt for.
- `docs/macros.md` gains a **Variables** section: the `$host` / `${host}` syntax table, the worked ipmitool example, the `'${password}'` quoting idiom (Nexus never auto-quotes a value — quoting it automatically would corrupt commands sent to network-device CLIs), the `HISTCONTROL=ignorespace` trick for keeping a value out of the remote shell's own history, and the variables-vs-auto-trigger rule, pointing at Scripts for automated flows that need both prompted input and control flow.

## [2.8.72] — 2026-07-29

Review findings against 2.8.71's directory sync fixes (#35), from a staff-engineer pass over the whole feature.

### Fixed

- **A stale in-flight directory report could clobber a newer one buffered while the File Explorer was busy.** 2.8.71 fixed the busy-buffer drop, but the abandon path that runs when an in-flight `realpath`/`stat` resolves after the explorer has since gone busy wrote into the buffer unconditionally — so an older report resolving late could overwrite an already-buffered newer report, and the explorer would re-root to the stale directory once idle while silently discarding the newest one. Buffering a record now bumps the same generation token the out-of-order-completion fix already uses, and the mid-flight abandon path only writes the buffer when its own generation is still current and the buffer doesn't already hold a same-or-newer report (compared by `updatedAt`). The same fix closes an identical hole on the view-hidden path (a report could be lost, not just buffered, if the File Explorer was hidden rather than busy at the moment an in-flight report resolved).
- **Turning Follow Terminal Directory on could look inert.** If the terminal already had a fresh, applicable directory on record when the toggle was clicked, nothing happened until the next `cd` or focus change — now enabling Follow applies the already-known directory immediately whenever the explorer is idle and visible.
- **"Go to Terminal Directory" from a terminal tab's own right-click menu ignored which tab was clicked**, silently syncing whichever terminal happened to be focused instead. It now targets the terminal the menu was opened on; a tab that isn't a live Nexus SSH session (a plain shell, serial, or already-disconnected tab) is a clean no-op rather than a wrong-terminal sync.
- **A slow "Go to Path" navigation could commit onto the wrong server.** If the File Explorer's active server changed while the input box was open or the path was being validated, the typed path could still land on the explorer — now it's discarded if the active server changed underneath it, matching the same guard "Go to Terminal Directory" already had.
- **"Show Me How" gave zsh users a bash snippet they couldn't use.** The rc hook shown when a host has never reported a directory was bash's `PROMPT_COMMAND=` line followed by a comment naming zsh's `precmd_functions` mechanism without ever supplying it — a zsh user who clicked it ended up exactly where they started. The output channel, README, and functional documentation now all show a real zsh hook alongside the bash one (`precmd_functions+=(__nexus_osc7)`, using `${HOST}` rather than `$HOSTNAME` since zsh sets the former but frequently leaves the latter unset).

## [2.8.71] — 2026-07-29

Two fixes for the directory sync feature shipped in 2.8.70 (#35), from real-world use.

### Fixed

- **Directory sync no longer silently drops a `cd` while the File Explorer is busy.** `cd ..` twice in a row could lose the second hop — not path-dependent, timing-dependent: any tree refresh (the 10s safety-net poll, an inotify event, and especially every successful re-root, which itself triggers a refresh) left a short window where the explorer reported itself busy, and a cwd report arriving in that window was discarded outright with no retry. The busy check exists so a re-root can't land mid-upload or mid-listing (the fallback write target for drag-drop and new file/folder creation) — that safety property is unchanged. What's fixed is what happens to the report: it's now buffered (latest wins) and replayed through full arbitration — following, focus, server match, pin, staleness, visibility, busy — the moment the explorer goes idle, via a new `FileExplorerTreeProvider.onDidChangeBusy()` signal. No polling added.
- **Turning on Follow Terminal Directory for a host with no OSC 7 source now says something.** Previously the only feedback was a small grey line in the File Explorer's title bar (`... — no directory reported`, easy to miss and passive even when noticed) — clicking the toggle on a stock Linux host looked like the feature just didn't work. Turning follow on now shows an actionable, once-per-server notice explaining that Nexus never types into a session (so the shell has to announce its own directory — fish and starship already do; bash/zsh need one rc line), with **Show Me How** (drops the one-liner into the Nexus Directory Sync output channel) and **Go to Terminal Directory** (jumps there manually, immediately) as the two responses. The title-bar text for this state is also more direct now: `shell not reporting a directory` instead of `no directory reported`.

## [2.8.70] — 2026-07-29

Phase 1 of directory sync between the SSH terminal and the File Explorer (#35).

### Added

- **File Explorer can now follow your SSH terminal's directory.** Turn it on from the new toggle at the left of the File Explorer title bar, or from the right-click menu on the `.` row that shows your current directory — never from Settings. On shells that announce their own directory via the `OSC 7` escape sequence (`fish` ≥ 3.x, `starship`, and any prompt framework built on it), this is genuinely continuous: the explorer re-roots itself as you `cd` around, with no polling and nothing written to the terminal. Plain bash and zsh don't announce it by default; add one line to `~/.bashrc` (a zsh equivalent goes in `~/.zshrc`) and they will too:
  ```bash
  PROMPT_COMMAND='printf "\033]7;file://%s%s\033\\" "$HOSTNAME" "$PWD"'"${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  ```
  For anything else — Cisco IOS, Juniper, FortiOS, and other gear that will never emit that escape sequence — a new **Go to Terminal Directory** command (File Explorer overflow menu, `.` row context menu, and any Nexus terminal tab's right-click menu) does a one-shot sync using a best-effort read of the visible prompt, validated with `realpath` before the explorer moves. Manual navigation (Go to Path, Go Home, `..`) pauses following instead of fighting it; **Resume Following Terminal Directory** jumps straight back. A host that never reports a directory gets one explanatory notice per session, not a dead button. Nexus writes zero bytes to any terminal to make this work in this release — the push direction (having Nexus type `cd` for you) is tracked for a future phase. Addresses #35 (continuous coverage; the issue stays open pending automatic coverage for bash/zsh without a manual rc edit).

## [2.8.69] — 2026-07-27

Follow-up to 2.8.68: one import entry point instead of four, and it is now reachable when the Connectivity Hub already has profiles in it.

### Changed

- **`Nexus: Import Configuration` is now `Nexus: Import…` — one entry point for every import format.** It used to accept only Nexus's own JSON export and reject everything else, including the CSV/plain-text importer it now sits alongside; the reporter of #29 never found any importer at all. It now opens a picker asking what you're importing — **Paste Host List from Clipboard**, **Host List File…**, **MobaXterm INI File…**, **SecureCRT XML Export…**, **SecureCRT Sessions Folder…**, or **Nexus Export File…** (an encrypted backup or a shared config) — then branches into the matching format. It's also newly reachable from the Command Center's `...` overflow menu (next to **New Folder**) so it's available even once the tree isn't empty, not just from the empty-state welcome view. The Data Management section of Settings collapses its two former import rows into this one. If the file you picked doesn't match what you told the picker — say, you chose "Host List File…" but selected a MobaXterm export — Nexus names the mismatch and usually offers a one-click button to re-import it as the format it actually looks like, reusing the same bytes rather than a dead end or a re-opened dialog. `Nexus: Import from MobaXterm`, `Nexus: Import from SecureCRT`, and `Nexus: Import Servers from List (CSV/Text)` remain in the command palette as direct shortcuts into the same pickers, for anyone who already knows what they're importing. One extra keystroke for a keybound or muscle-memory `nexus.config.import` invocation — type-to-filter (e.g. `nex` + Enter) restores near-parity, and Enter-Enter now lands on clipboard paste rather than the JSON importer.

### Fixed

- **A UTF-8 BOM before a MobaXterm export's `[Bookmarks]` header no longer misroutes it as a host list.** The format sniffer's MobaXterm rule only tolerated spaces/tabs before `[`, not a leading BOM, while the MobaXterm parser itself strips one — so a BOM'd export sniffed as `host-list` and `Nexus: Import…` reported "no [Bookmarks] section found" before the parser, which handled the file fine, ever ran. The sniffer now strips a leading BOM once, up front, so every format rule is BOM-agnostic by construction.

## [2.8.68] — 2026-07-27

Closes the two open GitHub issues: bulk connection import and editing root-owned remote files (#29, #30).

### Added

- **Bulk import servers from a device list (CSV or plain text).** Run `Nexus: Import Servers from List (CSV/Text)` and paste from the clipboard or pick a `.csv` / `.txt` / `.tsv` file. Accepts a bare hostname list, positional `host,name,user,port,folder` rows, a header row whose columns are matched by name (`Mgmt IP`, `Device Name`, `Site`, …), tab- or whitespace-separated input, quoted fields containing commas, and `user@host:port` shorthand. Rows that duplicate an existing server (host + port + username, host compared case-insensitively) are skipped, unparsable lines are reported per line with a reason, and folders named in the list are created as groups. Imported servers default to password authentication. Addresses #29.
- **Save remote files that need root (`sudo`).** Editing a root-owned file over SFTP now offers to complete the save with `sudo` on the remote host instead of failing. Two paths: a file the SSH user cannot write prompts **Save as Root** when the save is denied, and a file VS Code marks read-only can be opened for editing with **Edit as Root (sudo)** from the File Explorer context menu. The content is staged to a `0600` temp file and written through the target's existing inode, so owner, mode, ACLs, SELinux context, and hard links are preserved. The `sudo` password is read from stdin (never placed in a command line) and never written to disk or to VS Code's secret storage. Even with `rememberPasswordForSession` off (the default), a 30-second grace window after you enter the password still covers an immediately-following elevated save on the same server — e.g. VS Code's own Save As, which issues two writes for one save — so you aren't prompted twice in a row. New settings: `nexus.sftp.sudo.enabled` (default `true`) and `nexus.sftp.sudo.rememberPasswordForSession` (default `false`). Addresses #30.

### Changed

- **Permission failures for delete, rename, and new-folder on remote files now explain themselves.** These three actions fail on the *parent* directory's write permission, not the file's, and elevated (sudo) saves only ever cover file contents — Nexus now says so directly and points at a terminal on the host as the workaround, instead of surfacing the raw SFTP permission-denied error.
- **`Nexus: Import Configuration` no longer answers a non-Nexus file with a bare "Invalid JSON file."** It now says the file isn't a Nexus JSON export and offers an **Import Servers from List** button to import it as a CSV/plain-text host list instead.

### Fixed

- **Numbered devices now sort in natural numeric order.** Servers, serial and local-shell profiles, tunnels, folders, and remote files previously ordered as `A1, A10, A11, A2` because every comparator used a plain `localeCompare`. All display sorts now use a shared numeric-aware collator, so `A1, A2, A10, A11` — including segment-wise ordering for folder paths (`Site2/Rack1` before `Site10/Rack1`) and for serial device paths (`COM2` before `COM10`). Reported in #29.
- **Four quick pickers now sort at all.** The server picker, tunnel picker, auth-profile picker, and the connected-server picker used for browsing files presented entries in arbitrary snapshot order.
- **Stopped mutating cached tree state while sorting.** The Connectivity Hub sorted its cached child-folder array in place on every refresh.
- **Boolean settings that declare a default of `false` now render correctly unset in the Settings panel.** The renderer ignored the declared default and always showed an unset boolean as enabled; no shipped setting used `default: false` before this release, so the bug had no user-visible effect until `nexus.sftp.sudo.rememberPasswordForSession` (above) needed one.

## [2.8.67] — 2026-07-25

### Fixed

- **SSH auth banners and MFA prompts now appear in the terminal.** Servers using MFA (e.g. Duo) deliver the login banner and option menu ("1. Duo Push / 2. SMS") through the keyboard-interactive `name`/`instructions` fields, which were dropped — users saw only a bare "Passcode or option (1-2)" input box with no context. The sshd `Banner` (USERAUTH_BANNER) was also buffered until after `ready`, so it appeared after login instead of before the prompt. Both are now relayed live to the terminal through every connect path (direct, SSH jump host, SOCKS5, HTTP CONNECT, and pooled), with ANSI and control sequences stripped from the server-controlled text.

## [2.8.66] — 2026-07-01

### Added

- **Maintainer contact and optional funding.** The manifest now carries an `author` contact (`evgeny@netsectech.com.au`), a `bugs` link to GitHub Issues, and a `sponsor` URL so the VS Code Marketplace shows a **Sponsor** button. Added `.github/FUNDING.yml` (Buy Me a Coffee) for the GitHub **Sponsor** button, and **Support** + **Contact** sections to the README. Nexus Terminal stays free and open source — donations are appreciated but never required, and no feature is gated behind them.

## [2.8.65] — 2026-06-30

Dependency and security maintenance release. No user-facing feature or behavior changes.

### Security

- **Cleared all 15 `npm audit` findings (6 high, 8 moderate, 1 low → 0).** Every advisory lived in the `@vscode/vsce` / `ovsx` publish-and-package toolchain (dev-only, never shipped in the VSIX, never processes untrusted input): bumped `@vscode/vsce` to `^3.9.2` (pulls fixed `tmp`, `underscore`, `uuid`, `@azure/*`, `form-data`, `fast-uri`, `linkify-it`, `markdown-it`, `minimatch`, `brace-expansion`, `ip-address`, `js-yaml`, `qs`), `ovsx` to `^1.0.2`, and `esbuild` to `^0.28.1` (clears GHSA-g7r4-m6w7-qqqr, a dev-server file-read issue; esbuild is used only as a library bundler here, never its dev server).

### Changed

- **Batched the open Dependabot updates.** Runtime: `fast-xml-parser` `5.3.7` → `5.9.3` (the SecureCRT XML import dependency; its import tests pass unchanged). Dev/test: `vitest` + `@vitest/coverage-v8` `3.x` → `4.1.9` and the `picomatch` / `undici` / `lodash` transitives. Migrated the test suite for Vitest 4 (constructor mocks must use `function`/`class`, not arrow functions); 116 files / 1759 tests pass.
- **Made the Open VSX publish step idempotent** by adding `--skip-duplicate` to `publish:ovsx`, so re-running a release on an already-published version no longer errors.

### Fixed

- **The VS Code Marketplace version badge in the README no longer shows "retired".** shields.io retired its `visual-studio-marketplace/*` badge family; swapped to `vsmarketplacebadges.dev`, which reads the live published version. The Open VSX badge was unaffected.

## [2.8.64] — 2026-06-23

### Added

- **Open any saved profile from the command line or a link via a `vscode://` URI handler (issue #11).** `code --open-url "vscode://sentriflow.vscode-nexterminal/<name>"` opens the profile named `<name>` — the kind (SSH, Serial, or Local Shell) is auto-detected from whatever the name resolves to. `?sftp` connects an SSH profile and opens the File Explorer; `?id=<uuid>` disambiguates when names collide. The handler acts only on **existing saved profiles** — the URI never carries a host, username, or password (lookup keys only). The README documents bash/zsh and PowerShell `nexterm` aliases, and the `--open-url` vs `--file-uri` distinction.

### Fixed

- **Strip systemd OSC 3008 "context" sequences that garbled the terminal on Ubuntu 26.04 / systemd 258.** The remote shell's `/etc/profile.d/80-systemd-osc-context.sh` emits an OSC 3008 sequence (`…;pid=…;type=shell;cwd=…`) before every prompt; no terminal consumes it (per systemd's docs). Combined with chunked SSH reads and the terminal highlighter splitting the sequence and injecting SGR codes into its payload, it surfaced as literal garbage in front of the prompt (e.g. `<uuid>;pid=…;type=shell;cwd=/home/user user@host:~$`). Nexus now strips OSC 3008 from SSH and Local Shell output before display (with cross-chunk buffering), and the highlighter never emits a slice that ends inside an escape sequence. Servers can also disable the emission with `sudo rm /etc/profile.d/80-systemd-osc-context.sh`.

## [2.8.63] — 2026-06-17

### Fixed

- **Settings Guard recovers ALL Nexus keys together in one direct settings.json write — re-shipped from v2.8.61 with the bundling defect that broke it now fixed.** Whenever any corruption is detected, and on startup and on Resume, the guard recomputes the correct value for every Nexus-required key (`terminal.integrated.commandsToSkipShell`, `nexus.terminal.passthroughKeys`, `nexus.terminal.highlighting.rules`) and persists them with a single surgical, BOM-free edit to settings.json (preserving every other key, comment, and line ending). This direct write is the authoritative persistence — it no longer depends on VS Code's settings writer landing the change — and **Resume now always re-checks state and heals every key.** The write-war rate limiter counts these direct repairs, so a tool that keeps re-corrupting settings.json is still bounded and pauses with a Resume prompt.
- **Root-cause fix for the v2.8.61 "empty Connectivity Hub after auto-update" regression.** v2.8.61 added the `jsonc-parser` dependency for the surgical write, but its UMD build calls `require("./impl/format")` through a runtime-passed `require` that esbuild cannot statically resolve — esbuild kept the UMD wrapper verbatim and the deep require dangled, so the packaged extension threw `Cannot find module './impl/format'` at load and **failed to activate at all** (which presented as a blank hub; profile data in globalState was never touched). The bundler now pins `jsonc-parser` to its ESM build (whose `import` statements esbuild inlines correctly), scoped to that one package so no other dependency's resolution changes.
- **New release smoke test prevents this entire class of bug from shipping again.** `npm run build:production` (the path CI uses for both Marketplace and Open VSX) now loads the production-bundled `dist/extension.js` exactly as the extension host does and fails the build if it throws at load or does not export `activate()`/`deactivate()`. Unit tests and a green esbuild build exercise source against `node_modules`; they never loaded the packaged bundle — which is why v2.8.61 passed CI yet bricked on install.

## [2.8.62] — 2026-06-17

### Reverted

- **Rolled back the v2.8.61 Settings Guard rewrite** (unified all-keys recovery + direct `settings.json` file write + `jsonc-parser` dependency). v2.8.61 was reported to leave the Connectivity Hub empty after auto-update. The Settings Guard reverts to the proven v2.8.60 behavior (in-memory `config.update` heal + BOM strip). Note: Nexus profiles (servers, tunnels, serial) are stored in VS Code's globalState, which the guard never writes — this rollback restores the known-good extension code; existing profile data is unaffected by the guard either way.

## [2.8.61] — 2026-06-16

### Fixed

- **Settings Guard now recovers ALL Nexus keys together, written directly to settings.json in one pass.** Previously the guard healed each key on its own and relied on VS Code's settings writer to persist — which left `nexus.terminal.passthroughKeys` stranded corrupt on disk in some cases (a per-key heal cap could pause one key, `Resume` only re-checked the macro keybinding list, and VS Code's writer races on reload after the BOM is stripped). Now, whenever any corruption is detected — and on startup and on Resume — the guard recomputes the correct value for every Nexus-required key (`terminal.integrated.commandsToSkipShell`, `nexus.terminal.passthroughKeys`, `nexus.terminal.highlighting.rules`) and writes them all with a single surgical, BOM-free edit to settings.json (via `jsonc-parser`, preserving every other key, comment, and line ending). This direct write is the authoritative persistence, so it no longer depends on VS Code's settings writer landing the change. **Resume now always re-checks state and heals every key.** The write-war rate limiter now counts these direct repairs, so a tool that keeps re-corrupting settings.json is still bounded and pauses with a Resume prompt.

## [2.8.60] — 2026-06-16

### Fixed

- **Settings Guard now strips a UTF-8 BOM from settings.json before healing.** The corporate DLP rewrites settings.json as UTF-8-with-BOM (bytes EF BB BF), which caused VS Code's settings writer to silently refuse to persist the guard's repair — the in-memory heal still kept macros working session-wide, but the on-disk file remained corrupt and was re-corrupted again at every save. VS Code's settings writer uses jsonc-parser under the hood, which treats a leading BOM as an `InvalidSymbol` parse error at offset 0 and refuses to write into a file with any parse error. The guard now removes the BOM first (all other bytes, including CRLF line endings and indentation, are preserved exactly), so the subsequent `config.update` repair lands on disk normally and also unblocks future writes by VS Code's own settings UI.

## [2.8.59] — 2026-06-12

### Fixed

- **No more redundant "macro shortcuts are blocked — Fix now?" prompt for the skip-shell list.** Since the Settings Guard now auto-repairs `terminal.integrated.commandsToSkipShell`, the proactive hint no longer warns about that blocker while the guard is enabled. It still appears for the settings the guard does not auto-fix (`terminal.integrated.sendKeybindingsToShell`, `window.enableMenuBarMnemonics`), and still appears for the skip-shell list if you have disabled the guard (`nexus.settingsGuard.enabled`).

## [2.8.58] — 2026-06-12

### Fixed

- **The Settings Guard now recovers `terminal.integrated.commandsToSkipShell` even with no prior backup.** Previously it could only restore the macro skip-shell entries if it had earlier captured a healthy copy — so damage that happened while VS Code was closed (or on a fresh install) left it with nothing to restore and it silently did nothing, and macros stayed dead. It now rebuilds the list from VS Code's own default skip-shell commands plus the Nexus macro commands (`nexus.macro.run` / `nexus.macro.runBinding`), so recovery no longer depends on a snapshot. This only runs when you have macros defined. Unlike `nexus.terminal.passthroughKeys` — which has an all-keys default and therefore self-heals when corrupted — `commandsToSkipShell` has no default containing the Nexus commands, which is why it needs to be written back explicitly.
- **The manual "Fix Macro Keybindings" repair no longer writes corrupted entries back.** When the skip-shell list had been mangled into `[{}, {}]`, the repair preserved those empty-object entries; it now drops all non-string entries before writing.

### Fixed

- **The Settings Guard now recognizes and heals the real corruption signature: array elements replaced with `{}`.** Live observation showed the external tool does not drop array keys — it rewrites them with every element turned into an empty object (`["b","e"]` → `[{},{}]`, consistent with depth-limited JSON re-serialization, e.g. PowerShell `ConvertTo-Json` with a low `-Depth`). Strip detection now counts string entries instead of array length, so these rewrites are classified `external-strip` instead of `external-other`, and a skip-shell list whose entries were all destroyed is restored from the full last-known-good copy.
- **`nexus.terminal.passthroughKeys` and `nexus.terminal.highlighting.rules` are now restored, not just tolerated.** The guard keeps a last-known-good copy of each (globalState `nexus.settingsGuard.lastKnownGoodValues`) and writes it back when the value is destroyed — on live change events as well as at startup. Without a stored copy the corrupt override is removed so package defaults apply. Healing is capped at 3 attempts per setting per session; hitting the cap shows a warning toast with a Resume button. Partially corrupt arrays that still carry user entries are left untouched (only the valid entries are shadowed).
- One forensic `external-strip` event per corruption (previously the report could double-count healable keys), carrying the window-focus marker.

## [2.8.56] — 2026-06-11

### Fixed

- **Settings changed through Nexus's own UI are no longer logged as "external" in the Settings Guard report.** All Nexus write paths (settings panel, reset-to-defaults, backup import, highlight rule editor, the keybinding repair) now register their writes, so the forensic report only flags genuinely external modifications. Remaining external events carry a `{focused}`/`{unfocused}` marker — background agent rewrites typically surface while the window is unfocused, helping IT separate them from interactive edits.
- **Corruption that happened while VS Code was closed is now detected and healed at startup.** A corrupt global override of `nexus.terminal.passthroughKeys` (empty or non-array — e.g. stripped by an external tool overnight) or a type-corrupt `nexus.terminal.highlighting.rules` is logged as evidence and removed so the package defaults apply again. This also fixes the native VS Code settings UI showing an empty passthrough key list that users felt compelled to rebuild by hand. Healing respects `nexus.settingsGuard.enabled`; an empty `highlighting.rules` array is a valid "no rules" choice and is never touched.
- **"Nexus: Show Settings Guard Report" now prints current per-scope values** of the watched settings (VS Code's live view), so a mismatch against the `settings.json` on disk — e.g. corporate folder redirection or an external rewrite race — is diagnosable on the affected machine.

## [2.8.55] — 2026-06-11

### Added

- **Settings Guard: Nexus now self-heals `terminal.integrated.commandsToSkipShell` when an external program strips it.** Some corporate environments run agents (e.g. DLP/endpoint tools) that periodically rewrite `settings.json` and drop array-valued keys, silently breaking Nexus macro shortcuts. Nexus now keeps a last-known-good copy of the skip-shell list and automatically restores it when it detects the strip signature (key vanished, array emptied, or Nexus commands removed) — including damage done while VS Code was closed. Every restore shows an Undo notification; restores are rate-limited (12 per session, max 3 per 10 minutes) and pause with a Resume button if an external tool fights back. Disable via `nexus.settingsGuard.enabled`. Boolean settings (`sendKeybindingsToShell`, `enableMenuBarMnemonics`) are never changed automatically — those keep the existing confirm-gated "Fix Macro Keybindings" repair.
- **New command "Nexus: Show Settings Guard Report"** — a forensic log of external modifications to the watched settings (timestamps, before/after values, kept across restarts). Hand it to your IT team to correlate against endpoint-agent activity logs and identify the tool corrupting `settings.json`.

## [2.8.54] — 2026-06-05

### Added

- **Nexus now warns when VS Code settings block macro keyboard shortcuts.** If `terminal.integrated.sendKeybindingsToShell` is enabled, `terminal.integrated.commandsToSkipShell` is missing the Nexus macro commands (including via workspace overrides), or `window.enableMenuBarMnemonics` intercepts Alt shortcuts, a one-time hint offers a one-click fix via the existing "Fix Macro Keybindings" repair. Detection is read-only — Nexus never changes these settings without your explicit click — and the hint can be permanently dismissed. Background: versions up to v2.8.27 silently rewrote `sendKeybindingsToShell` to `false` on every start; removing those automatic writes in v2.8.28 exposed pre-existing user configurations where macro shortcuts were swallowed by the shell.

## [2.8.53] — 2026-06-05

### Changed

- **Internal code consolidation (no functional changes intended).** Deduplicated ~250 lines across the codebase: shared PTY observer/lock handling (`PtyObserverHub`), shared webview document shell and nonce helpers, a single reset-settings helper, merged MobaXterm/SecureCRT import flows, simplified import/export internals, and the backup settings list is now derived from the settings metadata registry so the two can no longer drift apart. Byte-identity of rendered webview HTML is locked in with snapshot tests.
- **Local Shell input-lock message now matches SSH/serial terminals** ("Terminal is locked while a script is running. Stop the script to send input.").

## [2.8.51] — 2026-06-05

### Fixed

- **Applying a terminal color scheme no longer copies workspace-scoped `workbench.colorCustomizations` entries into your global settings.** The scheme merge now starts from the global-scope value only, and clearing the last scheme removes the key instead of leaving an empty object behind.
- **Terminal Appearance panel re-syncs font fields when settings change outside the panel** (second window, Settings Sync, manual edits), and Apply Font only writes the fields that actually changed — a stale panel can no longer revert an external font change.
- **Corrupt extension storage no longer breaks activation.** If stored profile, group, or macro data has an invalid shape, Nexus now degrades to an empty list instead of failing to activate.
- **Corrupt numeric settings values fall back to safe defaults.** `nexus.sftp.maxOpenFileSizeMB`, `nexus.sftp.autoRefreshInterval`, and `nexus.ssh.multiplexing.idleTimeout` are now range-clamped on read, so a hand-edited or synced-in invalid value can't silently break file opening, auto-refresh, or connection multiplexing.
- **Macro editor saves are now keyed by macro identity, not list position.** If macros change in another window while the editor is open, saving can no longer overwrite or delete the wrong macro; the editor re-syncs and warns instead.

## [2.8.50] — 2026-06-05

### Fixed

- **Settings corruption: `nexus.terminal.passthroughKeys` can no longer be saved or imported as an empty array.** An empty selection is now rejected by validation (the `nexus.terminal.keyboardPassthrough` master toggle is the supported way to disable passthrough), backup import skips a corrupted `[]` value with a warning, and the runtime falls back to the full default key set when the configured value is corrupt — without rewriting your `settings.json`.
- **Settings webview no longer clobbers externally-changed passthrough keys.** Multi-checkbox controls now re-sync when settings change outside the panel (second window, Settings Sync, import, reset), so a later checkbox click can't save a stale key set. Unchecking every key re-selects all keys instead of saving an empty list.
- **Keybinding repair cleans up orphaned `terminal.integrated.commandsToSkipShell` entries.** The confirm-gated "Fix Keybindings" command now removes the stale `nexus.macro.slot` entry left behind by v2.3.1–v2.8.27 auto-repair, only writes when a value actually changes, and applies its settings updates sequentially to avoid write races.

### Changed

- **Refreshed README and Marketplace description/keywords** to better describe the zero-footprint SSH client positioning.

## [2.8.49] — 2026-05-19

### Added

- **SSH profiles can auto-open the File Explorer on first connection.** A new advanced SSH profile checkbox starts SFTP and switches the single Nexus File Explorer to that server after normal Connect when the view is not already showing that server, with only one profile allowed to own the behavior at a time.

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
