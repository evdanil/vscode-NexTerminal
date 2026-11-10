# Serial Consoles

Connect to serial ports (COM/ttyUSB) with configurable baud rate, data bits, parity, stop bits, and RTS/CTS flow control. Supports sending a break signal (**Nexus: Send Break**).

Built for embedded and firmware developers on serial consoles — Smart Follow rides through Windows COM-port renumbering, reconnecting only to the device you already approved instead of dropping the session.

## Add a Serial Device

1. Click `+` (**Add Profile**) in the Connectivity Hub title bar and choose **Serial Profile** as the profile type, or run `Nexus: Add Serial Profile`
2. Use **Scan Serial Ports** to discover available ports
3. Choose **Standard** or [**Smart Follow**](#smart-follow) connection mode, then configure baud rate, data bits, parity, and stop bits
4. Right-click the profile and select **Connect**

For **Baud Rate**, choose a suggested speed or select **Custom…** and enter a whole number from 1 to 2,147,483,647. Whether a speed works depends on the serial adapter, operating system, and device; a driver may reject it or use an approximate speed. **Test Connection** checks port availability, not baud-rate compatibility.

## Smart Follow

**Smart Follow** mode is for Windows COM-port renumbering: it retries the preferred port, silently reconnects only to the previously approved device when metadata matches, prompts before switching to unfamiliar replacement ports, updates the saved preferred port after a successful move, and keeps the terminal open while waiting or stopped instead of tearing the tab down on serial errors.

Smart Follow profiles coexist with other serial sessions on different ports, print status updates in the terminal when they switch ports or wait for reattach, silently reconnect only to the previously approved device, and prompt before switching to unfamiliar free ports. Terminal input modes (mouse, focus reporting, bracketed paste, Kitty keyboard) are reset when the port is lost and again before a reattach, so the next device does not inherit the previous one's modes.

## Several Serial Sessions at Once

Connect on a profile that is already connected just focuses its terminal. A connect is refused only when the target port is already held by another Nexus serial session — the warning names that session.

If a Standard serial profile is removed or changed while its port is still opening, Nexus closes the late port and terminal instead of restoring the old session. After the port closes, a notice explains the cancellation and offers **Retry** when the profile still exists. If the port cannot be confirmed closed, Nexus offers **Reload Window** before reconnecting.

An open that takes longer than **Serial RPC Timeout** shows "Connection failed" and is cancelled: when the port's native open finally finishes, the sidecar closes it, so a later Connect (or a Smart Follow poll) is not blocked as "busy". A close that fails is retried in the background for about 30 seconds. If the port still cannot be released, a warning names it and offers **Reload Window** (which restarts the sidecar); unplugging and replugging the device also helps. A rejected open that reuses a session ID already in use never closes the live session that owns it.
For **Connect and Run Script**, cancellation also ends the pending script request, and **Retry** reopens the script picker for the current profile.

## Dedicated send box

For a device that prints continuous logs, choose **Open Serial Send Box** from its live profile/session context menu or the terminal’s own context menu, or run **Nexus: Open Serial Send Box**. In terminal editors, use the context menu inside the terminal; the editor-tab header has no send-box action. A companion editor, **Serial Send: _profile name_**, keeps your draft separate from the native terminal's received output. Each session starts with direct terminal input enabled; opening its send box changes only that session.

Type multiline text in the editor. **Enter** inserts a newline; **Send** or **Ctrl+Enter** (**Cmd+Enter** on macOS) transmits it. The header identifies the profile and current port. Incoming logs stay in the native terminal and do not change the draft. **Focus Terminal** returns to received output.

**Line ending** defaults to **CR**, like an ordinary terminal Enter:

| Choice | Sent text |
| --- | --- |
| None | The draft verbatim, with nothing appended |
| CR / LF / CRLF | Convert every draft line separator to that ending, then append one more ending |

Whitespace is preserved. A newline at the end of the draft therefore sends an additional line. An empty draft with CR, LF or CRLF sends Enter; empty **None** is refused. Text uses UTF-8, with a maximum of 65,536 bytes including the appended ending. Backslash escapes such as `\n` are literal text.

Only one send can be pending. You can keep editing; a successful write clears the draft only if you have not changed it since sending. **Written to serial driver** confirms the local write, not a response from the device. A failed write keeps the draft; delivery may be partial or unknown, so check received output before deliberately retrying. Nexus never resends automatically.

While the send box is enabled, typing or pasting into its native serial terminal sends nothing. Nexus macros and scripts continue to work; a script's input lock also blocks the send box and manual macros. Other extensions or keybindings that send through the terminal are blocked while this mode is enabled. Choose **Use Direct Terminal Input**, or close the send-box tab, to restore direct input. Switching to another editor or hiding the tab keeps the mode and draft. Closing it discards the draft; there is no saved history or restoration after restart.

Smart Follow keeps the draft while waiting for a device or stopped. Sending is disabled until connected and unlocked. If the connection changes before a send is processed, Nexus refuses that send; review the current port and send again deliberately. Each send box stays bound to its own session, even when another terminal becomes active. Device-generated echoes still appear in received output and can enter transcripts, just like any other device output.

## Transcript line endings

For serial log files, **Settings → Logging → Transcript Line Endings** offers **Preserve** (default) or **LF**, which converts received CRLF pairs to LF. This setting applies to newly opened Standard and Smart Follow sessions; an existing Smart Follow terminal keeps its format when it reattaches. Standalone CR/LF and intentional empty lines are preserved. Live terminal output is unchanged. See [Session Transcript Logging](terminal.md#session-transcript-logging).

## Crash Isolation

Serial sessions run in an isolated sidecar process for crash safety.

## Related settings

Serial sidecar timeout: [settings.md#serial](settings.md#serial).

## See also

- [Terminal](terminal.md) — highlighting and tab commands for serial terminals
- [Terminal Macros](macros.md) and [Scripting](scripting.md) — automate a serial console
- [Network Servers](network-servers.md) — TFTP and DHCP for lab hardware on the bench
- [Connectivity Hub](connectivity-hub.md) — where serial profiles live
