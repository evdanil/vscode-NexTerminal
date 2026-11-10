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

Each output line has a **local receive timestamp by default**, including milliseconds and a numeric UTC offset:

```text
2025-01-15 09:00:12.345+10:00 [WARN] Connection interrupted
2025-01-15 09:00:14.678+10:00 [INFO] Connected
```

Choose **Transcript Timestamps** under [Settings → Logging](settings.md#logging), or set `nexus.logging.sessionTranscriptTimestamps` to `local` (default), `utc` (for example, `2025-01-14 23:00:12.345Z`), or `off` for clean output without per-line timestamps. Changes apply to newly opened sessions; disconnecting and reconnecting an existing terminal keeps that terminal's format. The session start/end markers keep their UTC timestamps in every mode.

The time records when Nexus receives the first output on a line, before the log's write buffer flushes; it is not the remote device's execution time. Lines split across chunks keep their first timestamp, and lines arriving together share a timestamp. Empty lines are timestamped too; partial lines and, by default, received CR/LF separators are preserved. Commands appear only if the remote terminal echoes them. The live terminal and Copy All output are unchanged.

**Transcript Line Endings** under **Settings → Logging** (`nexus.logging.sessionTranscriptLineEndings`) offers **Preserve** (default) and **LF**. LF converts received `\r\n` pairs to `\n` in saved transcripts, even when the pair arrives in separate chunks; it keeps standalone `\r`, existing `\n`, and intentional blank lines. The choice applies to new SSH, telnet and serial sessions; reconnecting an existing terminal keeps its selected format. It changes only the saved transcript, independently of timestamps, and does not change live terminal output, Copy All, script/macro capture or diagnostic tracing. A final standalone CR is kept when the transport ends or the transcript closes.

The logging default, log directory and rotation limits are also under **Settings → Logging**. Timestamp prefixes count toward the file-size limit. **Terminal Output Trace** is a separate troubleshooting setting: it remains off by default and already records a UTC ISO timestamp on each diagnostic entry/chunk. Enable session transcripts for ordinary session records.

### Log folders and filenames

Set **Settings → Logging → Session Log Path Template** (`nexus.logging.sessionLogPathTemplate`) to organize new SSH, telnet and serial logs. It is a relative path beneath **Session Log Directory**, with a filename ending in `.log`. Empty keeps automatic filenames. Both `/` and `\` create subfolders on every platform.

For example, use root `D:\NexusLogs` on Windows or `/home/me/NexusLogs` on Linux and template `%G/%S/%S-%Y-%M-%D-%h-%m-%s-%t.log`. Profile **Switch1** in group **Canada/Core** could produce `Canada/Core/Switch1/Switch1-2026-11-03-09-08-07-006.log`. **Open Log Directory** opens the root.

| Token | Value |
| --- | --- |
| `%S` | Saved session/profile name |
| `%G` | Group/location hierarchy; omitted when empty |
| `%H` | Configured hostname; `unknown-host` for serial |
| `%P` | SSH/telnet port or configured serial device identifier; `auto` if unavailable |
| `%Y`, `%M`, `%D` | Four-digit year, two-digit month and day |
| `%h`, `%m`, `%s`, `%t` | Two-digit hour, minute and second; three-digit milliseconds |
| `%%` | Literal percent sign |
| `%ENVIRONMENT_VARIABLE%` | Variable from the machine running the extension |

Date tokens use one **local session-creation time**, independently of per-line timestamp mode. The opening profile/group/endpoint and filename remain fixed through reconnects and Smart Follow reattachments. Adjacent tokens work (`%S%Y`); reserved one-character tokens take precedence over one-letter environment variables. Values expand once, so percent characters inside them stay literal.

Environment variables also work in **Session Log Directory**: `%USERPROFILE%/NexusLogs` on Windows or `%HOME%/NexusLogs` on Linux/macOS. Put variables containing a root path there. Inside a relative template, environment values become a single safe filename component, like host/session/port values; group segments retain their hierarchy. Invalid filename characters are replaced, Windows device names protected and long substituted names shortened. Literal `.`/`..`, absolute paths, unsafe characters and symlink subfolders are refused.

Sessions get separate files: an existing filename, rotated generation or active reservation causes a suffix such as `Switch1-2.log`. A hidden `.nexus-transcript-reservations` folder beside the logs holds internal records while they are open; normal close removes the records. An interrupted host can leave one, safely making later sessions choose another filename. If a runtime template or variable is unavailable, Nexus reports the setting in its diagnostic console and uses an automatic filename; an unavailable root variable uses the default directory. Nexus Settings and import validation catch malformed templates. Changes apply to newly opened terminals.

## Keyboard Passthrough

Optionally pass `Ctrl+` key combinations (e.g. `Ctrl+B`, `Ctrl+N`) directly to the terminal for applications like vim, nano, and htop. Configurable per-key with 11 supported combinations.

Turn it on or off, and choose the keys, under [Settings → Terminal](settings.md#terminal).

Serial sessions can use an optional [dedicated send box](serial.md#dedicated-send-box). While it is enabled, the native serial terminal displays received output and blocks direct typing and terminal-send keybindings; **Use Direct Terminal Input** restores them.

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
