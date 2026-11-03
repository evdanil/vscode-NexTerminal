# Terminal

What Nexus adds to its own terminal tabs: regex-based highlighting, PuTTY-style tab commands, session transcript logging, `Ctrl+` key passthrough for full-screen tools, and appearance settings.

Everything the terminal layer gives an SSH tab it gives a telnet tab too — see [Telnet](ssh-and-telnet.md#telnet). A Local Server's output runs in an ordinary Nexus terminal, where highlighting, scrollback capture and Reset / Clear Scrollback / Copy All apply; session transcripts do not — see [Local Servers](local-servers.md).

## Highlighting

Configurable regex-based pattern highlighting for every Nexus session terminal — SSH, telnet, serial, Local Shell and Local Server output. 22 built-in rules detect errors, warnings, status keywords, IPv4/MAC addresses, URLs, interface counters and more with inline ANSI colouring while respecting existing terminal colours.

The IPv6 and UUID rules ship **disabled** — those two patterns cost more than all the others combined — but stay in the list, ready to switch on with a per-row checkbox in the Rule Editor. Every rule can also carry its own label and description so the list stays readable without decoding regexes.

Open **Nexus: Edit Highlighting Rules** to manage named highlight profiles. Create, rename, duplicate or delete a profile and choose the global default. Each profile has its own ordered rules, with live preview, staged Apply/Cancel, custom SGR foreground codes, regex safety checks, and reset to the built-in rules. Existing highlighting rules remain available as the default profile.

Use **Create empty**, **Create from defaults**, or **Duplicate** first, then type over the automatically selected name. The name field always edits the selected profile. **Rename** focuses and selects that name; Enter or clicking away accepts the edit, and Escape restores the last accepted name. **Apply** includes a name you are still typing and saves all profile changes. Blank or duplicate names show an error beside the field.

Use **Stage Rule** or the rule editor's **Cancel** before switching profiles or taking an action that would discard the unfinished rule. **Delete Rule** discards the unfinished edit and stages deletion of the rule. If settings change elsewhere while you have a draft, record the changes you want to keep, close the Highlight Profiles tab (discarding that draft), and run **Nexus: Edit Highlighting Rules** again to load the current settings.

If saving fails, the manager shows available error details. Some settings may already have changed; preserve any draft changes you need before closing the tab and reopening the manager. Remove private paths or other sensitive details before sharing an error message.

The Highlight Profile field on saved SSH/telnet, serial, Local Shell and Local Server connections chooses the global default, a named profile, or no highlighting. Right-click a Nexus terminal tab or active session and choose **Select Terminal Highlight Profile** to change that terminal alone; **Use saved connection setting** returns it to the connection's preference. Changes to a profile or default apply to running terminals that follow it. Deleting a profile warns about saved connections and live terminals using it; a missing profile does not silently fall back to another set of rules.

The manager saves global settings. If a workspace overrides the catalog or default, that workspace's setting takes precedence. Backups and sharing include highlight profiles; merging imports keeps the recipient's default and remaps colliding profile IDs. Terminal-category and Reset All settings resets clear the catalog, default and legacy rules.

When highlighting is disabled by the current settings, the manager offers a shortcut to the VS Code setting so you can enable it in the applicable scope.

If the catalog or default is invalid or the default profile is missing, inspect `nexus.terminal.highlighting.profiles` and `nexus.terminal.highlighting.defaultProfile` in the applicable User, Workspace, Folder or Remote Settings JSON and correct or remove the affected settings. The manager provides shortcuts to User and Workspace Settings JSON.

## Tab Commands

Right-click any Nexus terminal tab for these commands (plus **Go to Terminal Directory**, covered under [File Explorer → Directory Sync](file-explorer.md#directory-sync)):

- *Reset Terminal* — clears the visible screen while preserving scrollback
- *Clear Scrollback* — clears visible and captured transcript together
- *Copy All to Clipboard* — ANSI-stripped transcript of the session
- *Select Terminal Highlight Profile* — choose highlighting for this terminal

*What "ANSI-stripped" removes.* Copy All, transcripts, script output and macro trigger matching share one stripper. It removes CSI sequences including private-prefix and intermediate forms (Kitty keyboard, modifyOtherKeys, cursor shape), two-byte and `ESC`-plus-intermediate sequences (such as `ESC 7`, `ESC 8`, `ESC =`), and OSC/DCS/APC/PM/SOS strings ended by `ESC \` or the 8-bit ST (OSC also by BEL; a BEL inside the other strings is payload) and cancelled by CAN or SUB. A sequence split across two chunks of output is still removed whole: the result does not depend on where chunks split; an escape longer than 512 characters is text, and the payload of an unterminated control string is dropped until its terminator, giving up after 1 MiB and treating the rest as text.

After a session disconnects, Reset and Clear grey out; Copy All stays enabled so a run can always be captured for a ticket or chat.

## Session Transcript Logging

Automatically log clean terminal output (ANSI codes stripped) to files with configurable rotation, for SSH, telnet and serial sessions. Per-profile toggle (**Log session transcript** on the server and serial forms). Local Shell and Local Server output is not logged — use Copy All to capture a run.

The default, the log directory and the rotation limits are under [Settings → Logging](settings.md#logging).

## Keyboard Passthrough

Optionally pass `Ctrl+` key combinations (e.g. `Ctrl+B`, `Ctrl+N`) directly to the terminal for applications like vim, nano, and htop. Configurable per-key with 11 supported combinations.

Turn it on or off, and choose the keys, under [Settings → Terminal](settings.md#terminal).

## Appearance

Customize terminal font family, size, and weight. Import color schemes from MobaXterm INI files or configure custom themes with live preview. Open it with **Nexus: Terminal Appearance**.

## Unread Activity

Active SSH, telnet and serial sessions highlight unread terminal activity in the tree and prepend `●` to the terminal tab title until you focus that terminal again. See [Connectivity Hub](connectivity-hub.md).

## Related settings

[Settings → Terminal](settings.md#terminal) (open location, keyboard passthrough, highlighting) and [Settings → Logging](settings.md#logging) (session transcripts).

## See also

- [SSH and Telnet](ssh-and-telnet.md)
- [Serial](serial.md)
- [Local Shells](local-shells.md)
- [Local Servers](local-servers.md)
- [Macros](macros.md) — send saved text, or auto-trigger on terminal output
- [Scripting](scripting.md)
- [File Explorer](file-explorer.md#directory-sync) — follow the terminal's current directory
