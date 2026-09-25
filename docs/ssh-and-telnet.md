# SSH and Telnet

Connect to remote servers over SSH from the Connectivity Hub, or set a server to raw telnet for console servers, virtual-lab consoles, and gear that offers nothing else.

**Unlike Remote-SSH, nothing is installed on the remote.** It's a pure client: no `vscode-server` unpacked into the target, no node process running on the far end. That matters when the far end is a Cisco switch, a bastion you only get a shell on, or a change-controlled box where you can't drop an agent.

## Add a Server

1. Click `+` (**Add Profile**) in the Connectivity Hub title bar and keep **Network Device Profile** as the profile type, or run `Nexus: Add Network Device Profile (SSH / Telnet)` from the command palette
2. Enter host, port, username, and authentication details (password, private key, or SSH agent)
3. Optionally configure a proxy (SSH jump host, SOCKS5, or HTTP CONNECT) under the Proxy section — see [Jump Hosts and Proxies](#jump-hosts-and-proxies)
4. Right-click the server and select **Connect** to open a terminal session
5. To set up key-based auth: right-click the server → **Deploy SSH Key** → select or generate a key → the public key is deployed automatically — see [Deploy an SSH Key](#deploy-an-ssh-key)

## Authentication

Connect to remote servers with password, private key, or SSH agent authentication.

Two-factor authentication (keyboard-interactive) is fully supported — passwords auto-fill while verification codes are prompted separately.

Credentials are cached securely via VS Code SecretStorage with silent re-auth.

### Deploy an SSH Key

Right-click any server and select "Deploy SSH Key" to automate key-based authentication setup. Discovers existing local keys or generates new ed25519 key pairs, deploys the public key to the remote `authorized_keys`, and optionally converts the server profile to key auth. Cross-platform (Windows, macOS, Linux).

### Host Key Verification

Trust-on-first-use (TOFU) model stores host keys on first connection and alerts if a key changes (potential MITM). Configurable via `nexus.ssh.trustNewHosts`.

## Auth Profiles

Define reusable credential sets (password, private key, or SSH agent) and apply them to individual servers or entire folders in bulk.

A NetBox or Proxmox [inventory source](inventory/README.md) can carry a profile too, so every SSH server it syncs connects with those credentials from the start. (The field is on every source's form, but EVE-NG and GNS3 nodes sync as [telnet](#telnet) consoles, which have no login for it to fill.)

The link is a reference, not a copy — edit the profile once and every server using it picks up the change, no re-sync needed.

A failed login on one linked server never erases the profile's saved credential — one broken device can't lock the rest of the fleet out of silent re-auth; the stored credential is only replaced when a device actually signs in with a new one.

Manage profiles from a dedicated editor panel accessible via the Settings tree or context menu.

## Jump Hosts and Proxies

Route SSH connections through intermediaries when direct access isn't available.

### Reaching a Device Two Hops Away

Jump hosts are set per server, and a jump host can have a jump host of its own — so the chain goes as deep as your network does. Below, an access switch is reached through an NMS host, which is itself reached through a bastion. One connect walks the chain, authenticating each hop in turn, and the shell lands on the switch. No `ProxyJump` stanza to hand-write, and nothing installed on any host along the way.

![Nexus Terminal setting up a two-level jump-host chain — access switch reached through an NMS host, which is itself reached through a bastion — then authenticating each hop in turn and opening a shell on the switch](../media/demo-jump-host.gif)

### Proxy Types

Three proxy types are supported per server:

- **SSH Jump Host** — Select another configured server as a bastion/jump host (ProxyJump equivalent). Supports multi-hop chaining (A → B → C) with full auth reuse.
- **SOCKS5 Proxy** — Connect through a SOCKS5 proxy server with optional username/password authentication.
- **HTTP CONNECT Proxy** — Connect through an HTTP proxy using the CONNECT method, common in corporate environments.

### Connect Through a Proxy

If your target server is behind a firewall or bastion host:

1. **SSH Jump Host** — First add the bastion server as a regular server profile, then edit the target server and set its proxy to "SSH Jump Host", selecting the bastion from the dropdown. Multi-hop chains (A → B → C) work automatically.
2. **SOCKS5 / HTTP CONNECT** — Edit the target server and set its proxy type, entering the proxy host, port, and optional credentials. Proxy passwords are stored securely in VS Code SecretStorage.

## Alternate Host

A server can hold a second SSH address in its **Alternate host** field (Advanced section of the server form) — typically the IPv6 to its IPv4, or the reverse.

When a terminal can't reach the primary Host at the connection level (no route, connection refused, a connect timeout before the TCP socket opens, or a name that won't resolve), Nexus retries once against the alternate and the terminal banner names the address that won.

It falls back only on those transport-level failures — an authentication, host-key, key, or proxy failure is never retried on the other address, since it would fail there too and could cost a second credential prompt. A handshake that times out after the socket has connected is not retried either — the host is reachable, so the alternate would not help.

One caveat: a password-auth server with no saved password is asked for the password before each attempt, so a fallback can prompt twice — saving the password (or using a key or agent) avoids it.

Only the terminal's own connect attempt tries the alternate. A tunnel, SFTP session or jump-host hop that opens its own connection always dials the primary Host — though with [connection multiplexing](#connection-multiplexing) on (the default), one that shares the terminal's existing connection rides whichever address that connection reached.

From NetBox, this fills itself in — see [Primary IP Family and Alternate Host](inventory/netbox.md#primary-ip-family-and-alternate-host). A [Proxmox](inventory/proxmox.md) source fills it in the same way when a guest's network card carries both families.

## Legacy Devices

A per-server legacy algorithm toggle is there for older devices (Cisco IOS, embedded systems) — including devices that only speak the 1024-bit `diffie-hellman-group1-sha1` key exchange, which VS Code's Electron crypto otherwise refuses to build ("Unknown DH group"). Together with multi-hop jump-host chaining (A → B → C), this per-server legacy KEX/cipher toggle keeps you connected to old IOS boxes that modern clients refuse.

## Connection Multiplexing

Share SSH connections across terminals, tunnels (in their default shared mode), and SFTP for the same server. A jump host's connection is shared the same way by everything routed through it, isolated-mode tunnels included, unless multiplexing is off for the jump host. Reduces connection overhead with automatic ref-counting and configurable idle timeout.

Per-server toggle lets you disable multiplexing for devices that don't support multiple channels (e.g. Cisco).

Automatic fallback to standalone connections handles channel failures transparently.

## When a Session Drops

Faults that arrive *after* a session is up — a keepalive timeout, a protocol error, the connection closing — are recorded in the **Nexus SSH** output channel, so a terminal that drops on its own leaves a cause behind instead of only "Connection lost".

## Telnet

Set a server's **Protocol** to *Telnet* and it connects over raw telnet instead of SSH, for console servers, virtual-lab consoles, and gear that offers nothing else.

It is a per-server switch on the profile you already have, not a separate kind of profile: pick Telnet and the credential fields disappear, because telnet has no login of its own — you authenticate at the device's own prompt, in the terminal.

Nexus speaks the negotiation properly (echo and suppress-go-ahead, terminal type, and live window-size updates on resize), so full-screen tools and line editing behave.

Everything the terminal layer gives an SSH tab it gives a telnet tab too: [highlighting](terminal.md#highlighting), [Reset / Clear Scrollback / Copy All](terminal.md#tab-commands), [auto-trigger macros](macros.md), and [scripts](scripting.md) (`@target-type telnet`).

**Telnet is cleartext** — there is no encryption and no authentication in the protocol — so SFTP, port forwarding, jump hosts and key deployment aren't available on a telnet server, and asking for one says so up front instead of failing inside a handshake.

## Related settings

SSH connection, keepalive, host-key, proxy-timeout and multiplexing settings: [settings.md#ssh](settings.md#ssh).

## See also

- [Port Forwarding](port-forwarding.md) — TCP tunnels through an SSH server
- [File Explorer](file-explorer.md) — SFTP browsing on a connected server
- [Terminal](terminal.md) — highlighting, tab commands, transcripts, keyboard passthrough
- [Import and Export](import-export.md#import-from-an-ssh-config) — bring servers in from `~/.ssh/config`, MobaXterm or SecureCRT
- [Inventory Sync](inventory/README.md) — servers created from NetBox, EVE-NG, Proxmox or GNS3, including [servers with no address yet](inventory/README.md#servers-with-no-address-yet)
- [Connectivity Hub](connectivity-hub.md) — folders, filter and drag and drop
