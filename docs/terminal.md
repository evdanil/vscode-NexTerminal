# Terminal

What Nexus adds to its own terminal tabs: regex-based highlighting, PuTTY-style tab commands, session transcript logging, `Ctrl+` key passthrough for full-screen tools, and appearance settings.

Everything the terminal layer gives an SSH tab it gives a telnet tab too — see [Telnet](ssh-and-telnet.md#telnet). A Local Server's output runs in an ordinary Nexus terminal, where highlighting, scrollback capture and Reset / Clear Scrollback / Copy All apply; session transcripts do not — see [Local Servers](local-servers.md).

## Highlighting

Configurable regex-based pattern highlighting for every Nexus terminal — SSH, telnet, serial, Local Shell and Local Server output. 22 built-in rules detect errors, warnings, status keywords, IPv4/MAC addresses, URLs, interface counters and more with inline ANSI colouring while respecting existing terminal colours.

The IPv6 and UUID rules ship **disabled** — those two patterns cost more than all the others combined — but stay in the list, ready to switch on with a per-row checkbox in the Rule Editor. Every rule can also carry its own label and description so the list stays readable without decoding regexes.

Includes a visual Rule Editor with live preview, staged Apply/Cancel, rule ordering, custom SGR foreground codes, regex safety checks, and one-click reset to defaults. Open it with **Nexus: Edit Highlighting Rules**.

## Tab Commands

Right-click any Nexus terminal tab for three PuTTY-style commands (plus **Go to Terminal Directory**, covered under [File Explorer → Directory Sync](file-explorer.md#directory-sync)):

- *Reset Terminal* — clears the visible screen while preserving scrollback
- *Clear Scrollback* — clears visible and captured transcript together
- *Copy All to Clipboard* — ANSI-stripped transcript of the session

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

Active SSH and serial sessions highlight unread terminal activity in the tree and prepend `●` to the terminal tab title until you focus that terminal again. See [Connectivity Hub](connectivity-hub.md).

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
