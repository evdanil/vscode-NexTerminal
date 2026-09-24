# Serial Consoles

Connect to serial ports (COM/ttyUSB) with configurable baud rate, data bits, parity, stop bits, and RTS/CTS flow control. Supports sending a break signal (**Nexus: Send Break**).

Built for embedded and firmware developers on serial consoles — Smart Follow rides through Windows COM-port renumbering, reconnecting only to the device you already approved instead of dropping the session.

## Add a Serial Device

1. Click `+` (**Add Profile**) in the Connectivity Hub title bar and choose **Serial Profile** as the profile type, or run `Nexus: Add Serial Profile`
2. Use **Scan Serial Ports** to discover available ports
3. Choose **Standard** or [**Smart Follow**](#smart-follow) connection mode, then configure baud rate, data bits, parity, and stop bits
4. Right-click the profile and select **Connect**

## Smart Follow

**Smart Follow** mode is for Windows COM-port renumbering: it retries the preferred port, silently reconnects only to the previously approved device when metadata matches, prompts before switching to unfamiliar replacement ports, updates the saved preferred port after a successful move, and keeps the terminal open while waiting or stopped instead of tearing the tab down on serial errors.

Smart Follow profiles coexist with other serial sessions on different ports, print status updates in the terminal when they switch ports or wait for reattach, silently reconnect only to the previously approved device, and prompt before switching to unfamiliar free ports.

## Several Serial Sessions at Once

Connect on a profile that is already connected just focuses its terminal. A connect is refused only when the target port is already held by another Nexus serial session — the warning names that session.

## Crash Isolation

Serial sessions run in an isolated sidecar process for crash safety.

## Related settings

Serial sidecar timeout: [settings.md#serial](settings.md#serial).

## See also

- [Terminal](terminal.md) — highlighting and tab commands for serial terminals
- [Terminal Macros](macros.md) and [Scripting](scripting.md) — automate a serial console
- [Network Servers](network-servers.md) — TFTP and DHCP for lab hardware on the bench
- [Connectivity Hub](connectivity-hub.md) — where serial profiles live
