# Port Forwarding

TCP tunnels through an SSH server, managed from the **Port Forwarding** section of the Nexus sidebar.

## Tunnel Modes

Three tunnel modes:

- **Local (-L)** — Forward a local port to a remote host through SSH.
- **Reverse (-R)** — Forward a remote port back to a local target.
- **Dynamic SOCKS5 (-D)** — Run a local SOCKS5 proxy that routes traffic to any destination through SSH.

All modes support configurable local bind addresses (localhost, LAN, or all interfaces), auto-start/auto-stop with server connections, live traffic counters, and a browser URL shortcut for quick access.

## Set Up a Tunnel

1. Switch to the **Port Forwarding** section in the sidebar
2. Click `+` to add a tunnel profile and choose the type:
   - **Local Forward (-L)**: specify local port, remote host, and remote port
   - **Reverse Forward (-R)**: specify remote bind address/port and local target host/port
   - **Dynamic SOCKS5 (-D)**: specify local port (default 1080) — routes traffic to any destination through SSH
3. Assign an SSH server to the tunnel, or leave it unassigned to choose at start time
4. Right-click the tunnel and select **Start**

You can also drag a tunnel profile onto a server in the [Connectivity Hub](connectivity-hub.md) to start it immediately.

## Which Servers Can Carry a Tunnel

A tunnel that opens its own connection always dials the server's primary Host — the [Alternate host](ssh-and-telnet.md#alternate-host) fallback is the terminal's own. A shared-mode tunnel that rides a terminal's existing multiplexed connection uses whichever address that connection reached. Port forwarding isn't available on a [telnet](ssh-and-telnet.md#telnet) server.

## Related settings

Tunnel connection mode, reverse-tunnel bind address and SOCKS5 handshake timeout: [settings.md#port-forwarding](settings.md#port-forwarding).

## See also

- [SSH and Telnet](ssh-and-telnet.md) — the servers a tunnel runs through, including [connection multiplexing](ssh-and-telnet.md#connection-multiplexing), which shares one SSH connection across terminals, tunnels and SFTP
- [Connectivity Hub](connectivity-hub.md) — drag a tunnel onto a server
