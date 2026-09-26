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

## Canceling and Stopping

Stopping a shared tunnel while its SSH connection is still opening cancels that start; it cannot later be announced as running. A client arriving during that login joins the same connection attempt, and another start request waits for the tunnel to be announced before it returns. If the shared SSH connection closes later, Nexus releases its lease, including any jump-host lease. If the SSH server refuses a reverse bind, startup fails and Nexus releases only that tunnel's lease on a pooled SSH connection, leaving other terminal and SFTP leases intact.

For a running reverse tunnel, Stop asks the SSH server to remove its remote listener and waits about one second for an answer before finishing local cleanup. If the peer does not answer, Nexus cannot confirm removal; the remote listener may remain until the SSH transport closes. If a reverse start is stopped while its remote-bind request is unanswered, Nexus holds another start on the same SSH route and remote port until the earlier request is refused or withdrawn, or its SSH connection closes. When the requested port was `0`, a late grant moves that hold to the allocated port, allowing another automatic allocation while starts targeting the allocated port still wait for the old connection to close. Stopping unregisters the tunnel from cross-window visibility; other windows clear its remote marker on a later sync.

## Which Servers Can Carry a Tunnel

A tunnel reaches its server the way a terminal does — through the server's [jump host or proxy](ssh-and-telnet.md#jump-hosts-and-proxies) when it has one — in shared and isolated mode alike. In isolated mode each client gets its own connection to the server, but a jump-host hop underneath it is shared through [connection multiplexing](ssh-and-telnet.md#connection-multiplexing), as a terminal's is.

Each isolated client logs in to the server on its own, but a password is not asked for per client. The server's password or key passphrase, or a SOCKS5 or HTTP proxy's password, is asked for once, and clients that arrive while you answer it — or before the first login using it has finished — use the same answer. A server password or passphrase you chose not to save is asked for again by the next client after that. The exception is a server behind a jump host with [multiplexing](ssh-and-telnet.md#connection-multiplexing) turned off: each client then reaches the server over a jump connection of its own and is asked for the server password separately, and prompts that open together dismiss each other — save the password, or keep multiplexing on for the jump host.

If several isolated clients were waiting on one credential prompt and you cancel it, Nexus shows one tunnel error notification for that group, even when the clients use different tunnel profiles or the prompt was for a jump host. A later connection attempt can prompt and report its own cancellation again.

A tunnel that opens its own connection always dials the server's primary Host — the [Alternate host](ssh-and-telnet.md#alternate-host) fallback is the terminal's own. A shared-mode tunnel that rides a terminal's existing multiplexed connection uses whichever address that connection reached. Port forwarding isn't available on a [telnet](ssh-and-telnet.md#telnet) server.

## Related settings

Tunnel connection mode, reverse-tunnel bind address and SOCKS5 handshake timeout: [settings.md#port-forwarding](settings.md#port-forwarding).

## See also

- [SSH and Telnet](ssh-and-telnet.md) — the servers a tunnel runs through, including [connection multiplexing](ssh-and-telnet.md#connection-multiplexing), which shares one SSH connection across terminals, tunnels and SFTP
- [Connectivity Hub](connectivity-hub.md) — drag a tunnel onto a server
