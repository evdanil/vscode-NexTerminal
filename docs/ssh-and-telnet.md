# SSH and Telnet

Connect to remote servers over SSH from the Connectivity Hub, or set a server to raw telnet for console servers, virtual-lab consoles, and gear that offers nothing else.

**Unlike Remote-SSH, nothing is installed on the remote.** It's a pure client: no `vscode-server` unpacked into the target, no node process running on the far end. That matters when the far end is a Cisco switch, a bastion you only get a shell on, or a change-controlled box where you can't drop an agent.

## Add a Server

1. Click `+` (**Add Profile**) in the Connectivity Hub title bar and keep **Network Device Profile** as the profile type, or run `Nexus: Add Network Device Profile (SSH / Telnet)` from the command palette
2. Enter host, port, username, and authentication details (password, private key, or SSH agent), or select an External Program auth profile under Advanced
3. Optionally configure a proxy (SSH jump host, SOCKS5, or HTTP CONNECT) under the Proxy section — see [Jump Hosts and Proxies](#jump-hosts-and-proxies)
4. Right-click the server and select **Connect** to open a terminal session
5. To set up key-based auth: right-click the server → **Deploy SSH Key** → select or generate a key → the public key is deployed automatically — see [Deploy an SSH Key](#deploy-an-ssh-key)

## Authentication

Connect with a stored password, private key file, SSH agent, or an [External Program auth profile](#external-program-credentials).

Stored password, private key file, and SSH agent authentication support keyboard-interactive two-factor challenges: password prompts can auto-fill while verification codes are prompted separately. External Program has the narrower challenge policy described below.

Stored passwords and key passphrases use VS Code SecretStorage for silent re-auth. External Program responses are never saved there.

When several SSH logins need input at once, server password, proxy password, key passphrase, and verification-code prompts appear one at a time. Logins that need the same credential can share one answer; prompts for different credentials wait their turn. Canceling a shared proxy-password prompt stops every waiting login before the proxy handshake; a later connection asks again. A queued prompt is discarded if its server changes before it opens or its terminal closes; a prompt shared with another open terminal remains available to that terminal. A timed-out connection drops its queued verification prompt. If a saved password or passphrase fails, Nexus clears it only if the saved value is still the one that failed, so a newer saved answer is kept. A saved password is cleared only when the server rejects it, and a saved key passphrase only when it fails to decrypt the key (the server never sees it). A login that ends without either verdict — a connection that closed mid-login, a terminal closed or reconnected while connecting, or a dismissed verification-code prompt — keeps both.

If the last connection waiting on an open server-password, proxy-password, or key-passphrase dialog closes, Nexus dismisses that dialog so another connection can prompt. A shared dialog stays open while another connection still needs it.

### SSH agents: Pageant and OpenSSH

A server or auth profile set to **SSH Agent** signs in with a key held by an SSH agent — and so does a server synced from an inventory source without an auth profile. Which agent is one choice for the machine, not a field of each server: **SSH Agent** in the Nexus Settings panel's SSH section (`nexus.ssh.agent`). It applies to terminals, SFTP, tunnels and jump hosts alike, and a change takes effect at the next login. A connection that is already open keeps the login it has — including one [connection multiplexing](#connection-multiplexing) keeps open for a while after its last terminal closes (`nexus.ssh.multiplexing.idleTimeout`) — so run **Reload Window**, or wait out that idle time, to make the next connect log in afresh.

With **Automatic** (the default), Nexus looks for the agent on every connection, in this order:

1. `SSH_AUTH_SOCK`, when VS Code was started with it — on any operating system.
2. On Windows, PuTTY's **Pageant** (0.75 or newer), found by the named pipe it opens for your Windows user. The pipe's name can change when Windows restarts, which is why Nexus finds it each time instead of asking you to enter it.
3. On Windows, the OpenSSH agent pipe (`\\.\pipe\openssh-ssh-agent`) — the **OpenSSH Authentication Agent** service, or another agent that provides that pipe, such as 1Password.

Nexus only uses a Pageant pipe named for your Windows user name. For some domain, Microsoft and Entra accounts Pageant names its pipe after another form of your name; Nexus then does not use it and names the pipe it found — in the error, or, when it uses the OpenSSH agent pipe instead, in the **Nexus SSH** output channel. If that Pageant is yours, choose **Custom socket or pipe** and enter that pipe (its name can change when Windows restarts).

When both Windows agents are running, Pageant is used; choose **OpenSSH Agent (Windows)** to use the other one. **Pageant (Windows)** and **OpenSSH Agent (Windows)** use only that agent and never fall back to another — they also ignore `SSH_AUTH_SOCK`. **Custom socket or pipe** uses the path in **Agent Socket or Pipe** (`nexus.ssh.agentPath`).

On Windows `SSH_AUTH_SOCK` is often set for the whole user, for example to `\\.\pipe\openssh-ssh-agent`. If the agent it points to is not running, Automatic stops there rather than quietly using another agent: start that agent, choose the agent to use instead (such as **Pageant (Windows)**), or remove `SSH_AUTH_SOCK` from the Windows environment and fully restart VS Code so Automatic can find Pageant or the OpenSSH agent itself.

On Linux and macOS, Automatic uses `SSH_AUTH_SOCK` only. VS Code started from a desktop launcher often does not have it: start VS Code from a shell where your agent runs, or choose Custom and enter the agent's full socket path. PuTTY's Pageant on Linux opens a differently named socket each time it starts; run it as `pageant --symlink <fixed path>` and enter that fixed path.

Before connecting, Nexus asks the agent which keys it holds. If the agent cannot be reached, or does not answer within 5 seconds, the connection stops there with the agent's path and what to do. If no agent is found, or the agent holds no keys (or is locked), the login carries on with whatever else the server offers — on many network devices a keyboard-interactive password prompt, exactly as before. If the server then refuses the login before you have typed anything, the error names the missing agent and the fix; a password or code you typed that the server refuses is reported as a rejected login, as it always was, with a note that no agent key was offered. A terminal's error offers **Open Agent Settings** and **Edit Server**, and Test Connection offers **Open Agent Settings**. The agent each login used, and why, is written to the **Nexus SSH** output channel.

Both settings are machine-specific: a workspace's `.vscode/settings.json` cannot set them and Export for Sharing leaves them out, so neither a repository you open nor a file someone sends you can redirect your key signing to another agent.

### Deploy an SSH Key

Right-click an SSH server using stored credentials and select "Deploy SSH Key" to automate key-based authentication setup. Discovers existing local keys or generates new ed25519 key pairs, deploys the public key to the remote `authorized_keys`, and optionally converts the server profile to key auth. Cross-platform (Windows, macOS, Linux). Servers linked to external or missing auth profiles cannot deploy keys; select a stored auth profile first.

### Host Key Verification

Trust-on-first-use (TOFU) model stores host keys on first connection and alerts if a key changes (potential MITM). Configurable via `nexus.ssh.trustNewHosts`.

## Auth Profiles

Define reusable credential sources (password, private key, SSH agent, or External Program) and apply them to individual servers or entire folders in bulk.

A NetBox or Proxmox [inventory source](inventory/README.md) can carry a profile too, so every SSH server it syncs connects with those credentials from the start. (The field is on every source's form, but EVE-NG and GNS3 nodes sync as [telnet](#telnet) consoles, which have no login for it to fill.)

The link is a reference, not a copy — edit the profile once and every server using it picks up the change, no re-sync needed.

For stored authentication, a failed login on one linked server never erases the profile's saved credential — one broken device can't lock the rest of the fleet out of silent re-auth; the stored credential is only replaced when a device actually signs in with a new one.

Manage profiles from a dedicated editor panel accessible via the Settings tree or context menu.

## External Program Credentials

For worked integrations, see [1Password](1password.md) and [HashiCorp Vault, AWS Secrets Manager and Azure Key Vault](vault-providers.md).

Choose **Settings → Auth Profiles → New Profile → Authentication: External Program**, then **Authentication Method: Password** or **Private Key**. Enter an absolute **Executable** path and optional **Arguments**, one argument per line. Select that profile on the server under **Advanced → Auth Profile**, or apply it to a folder, inventory source, or device template. Saving, selecting, importing, previewing and syncing these links do not retrieve credentials or grant execution approval.

Use **SSH Agent** when your vault already provides an agent: signing stays with the agent. Use **External Program** when a noninteractive program must return a username plus a password or private key for each new SSH authentication. Nexus does not integrate a particular vault CLI; your wrapper selects the vault item and converts its response to the protocol below. Unlock/sign in to the vault outside this protocol first.

### Execution location and approval

The executable runs on the **VS Code extension host**: the desktop for a local window, or the remote machine, container or WSL environment when the extension runs there. Browse selects a file on that host where supported; otherwise enter its absolute host path manually. It does not run on the SSH target. The browser-only extension cannot execute programs or approve them.

A trusted workspace is required. On the first interactive connection for an external profile in each extension-host session, Nexus opens a read-only **External Credential Invocation** document. Review the execution machine, executable, indexed arguments and appended method flag. If variable expansion is enabled, review both the template and the resolved example for this connection. **Continue External Credential Approval** (editor title or command palette) opens a native confirmation with **Allow for This Session**, **Cancel**, and **Back to Invocation**. Only Allow authorizes execution. Closing a dialog, a webview message, or merely opening the document cannot approve it. Cancel or an expired connection clears the review; a stale document cannot grant permission.

Approval is for that profile and invocation in this host session. With variable expansion enabled, it covers the template and future values for other connections, which can differ from the example shown. Concurrent logins can share the approval question, but each new authentication obtains its own response. Restart/reload requires new approval. Edits/deletion, replacement imports (even with identical configuration), reset, or **Nexus: Revoke All External Credential Approvals** revoke authority. The editor's **Session Approvals** action revokes all external approvals in this host too. Revocation cancels pending programs and authentication, and retires pooled connections for future acquisitions; established terminals, transfers and tunnels continue until their owners close them.

Background work never opens approval or credential dialogs. If approval is missing, start an interactive **Connect** to review the invocation, then repeat the background operation. Program/configuration failures offer **Manage Auth Profiles** on terminal, Test Connection, SFTP browse and tunnel-start surfaces. These provider failures do not automatically rerun the credential program. A provider failure does not trigger the alternate-host network fallback.

Programs inherit the extension host's environment and run with its user's file/network privileges. The working directory is that host's OS temporary directory, not your workspace or the script's folder. Nexus passes connection context only when you explicitly enable and reference variables in Arguments; it does not automatically pass context, passwords or vault tokens. Store only nonsecret item identifiers in arguments: configured paths and arguments are ordinary configuration, visible in backups, and resolved arguments can be visible in process listings. Neither the executable nor its dependencies are cryptographically pinned; approving a mutable program trusts subsequent changes at that path.

### Program contract (version 1)

Nexus invokes the executable directly with `shell: false`, configured arguments in order, then exactly one additional argument: **`--pass`** for Password or **`--pkey`** for Private Key. Do not include that final flag yourself. No shell expansion, `~`, environment substitution, file-association launch or interactive stdin is provided. The optional connection-variable expansion described below is limited to configured arguments. Stdin is closed. The program must finish its child work and exit successfully with all output streams closed.

The executable must be an absolute regular executable file on the host. On Linux it needs an ELF header or an explicit `#!` shebang; on macOS, a supported Mach-O/fat header or shebang. Headerless text is rejected to prevent an implicit shell fallback. Windows requires a native MZ executable; choose an explicit interpreter for `.ps1`, `.js`, `.py`, `.bat` or `.cmd` scripts. Batch files cannot be the executable themselves. No execution-policy bypass is added.

Arguments are at most 32 entries, each at most 4096 UTF-8 bytes. A completely empty Arguments field means no entries. Blank lines, a trailing blank line, leading/trailing whitespace, NUL and embedded CR/LF in an entry are rejected; values are never silently trimmed or dropped. Interior spaces, quotes and backslashes are literal. A path containing spaces occupies one line, without shell quotes. Executable paths containing control or bidirectional-formatting characters are rejected.

### Connection variables in arguments

**Expand connection variables in arguments**, next to Arguments in the External Program profile editor, is off by default. Existing arguments remain literal unless you opt in. When enabled, the following case-sensitive tokens are expanded once within each argument; the executable path is never expanded:

| Token | Value |
| --- | --- |
| `${host}` | Host actually being dialled, including an alternate-host retry |
| `${port}` | SSH port as a decimal number |
| `${SessionName}` | Server name |
| `${username}` | Username configured on that server, used as a lookup hint |
| `${profile}` | External auth profile name |
| `${protocol}` | `ssh` |

Write `$${host}` to pass the literal `${host}` when expansion is on. Unrecognized or malformed tokens, missing values used by a token, and arguments that violate the size or character limits stop the attempt. Substituted values are inserted literally, without recursive expansion, splitting, or a shell. Each jump host receives its own context, not the final destination's. The server username is editable as a lookup hint; the username returned by the program remains the SSH login. An inventory source's default username seeds new synced servers; changing the default does not replace usernames on existing servers unless the provider supplies a value.

Context values can contain untrusted input. Validate and map them to the secret identifiers your program is allowed to use; keeping argument boundaries does not make a vault path safe. Hostnames may change on an alternate-host retry, so use a stable session name if your vault naming requires it. See the [100-server example](vault-providers.md#example-100-servers-with-different-credential-groups).

**Before enabling:** update every Nexus installation that can access this configuration and export a backup from the newer version. Older clients cannot read enabled profiles and may remove them when saving auth profiles; backups exported by an older client may omit them. Export a backup from the newer version before downgrading. This warning reduces but cannot eliminate version-skew risk.

### Provider response

Stdout must be exactly one UTF-8 JSON object, with optional surrounding whitespace and no banner or additional JSON. Password response:

```json
{"version":1,"username":"example-user","password":"synthetic-example-only"}
```

Private Key response (replace the placeholder with the full unencrypted OpenSSH or PEM private-key text, JSON-escaped):

```json
{"version":1,"username":"example-user","private_key":"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n"}
```

`version` must be the number `1`. `username` is nonempty, at most 1024 UTF-8 bytes, with no NUL, CR or LF. `password` is nonempty and at most 64 KiB UTF-8; it is not trimmed or normalized. `private_key` is nonempty, at most 192 KiB UTF-8, and must parse as an OpenSSH private key or traditional PEM RSA/DSA/EC private key without a passphrase. PKCS#8 `BEGIN PRIVATE KEY` and other formats are not accepted. Encrypted keys, a `passphrase` field, mismatched credential fields, extra fields, invalid UTF-8, arrays, null and plaintext output are refused. Nexus does not create temporary private-key files.

| Bound | Limit |
|---|---|
| Program execution | 30 seconds from spawn |
| Stdout / stderr | 256 KiB / 64 KiB; the combined stdout response bound also limits key responses |
| Concurrent work per extension host | 4 running programs, 32 queued requests; queue overflow fails immediately |
| Queue wait | 30 seconds; approval review time is outside queue and program limits |
| Termination escalation / cleanup | 250 ms / 1000 ms; stream-drain grace after parent exit is 250 ms |

Stderr is counted and discarded, never shown. Errors name a finite failure category and sometimes a numeric exit code; they never include stdout, stderr or parser exception text. Debug your wrapper independently with synthetic data. If an owned parent cannot be stopped within the cleanup bound, further external requests are refused until the extension host restarts.

### Synthetic wrapper examples

These examples exercise Password mode only; replace the synthetic response with your vault lookup. Never hard-code a real secret. A POSIX executable script at `/home/example/bin/nexus-credentials` could contain:

```javascript
#!/usr/bin/env node
if (process.argv.at(-1) !== "--pass") process.exit(2);
process.stdout.write(JSON.stringify({
  version: 1, username: "example-user", password: "synthetic-example-only"
}));
```

Mark it executable, select its absolute path as **Executable**, and leave **Arguments** empty. The shebang requires `node` in the extension host's inherited PATH. Alternatively choose the absolute Node interpreter as Executable and the absolute script path as its one argument.

On Windows, select the installed absolute Node executable, for example `C:\Program Files\nodejs\node.exe`, and use one Arguments line `C:\Example\nexus-credentials.js` containing the same JavaScript (the shebang is optional for explicit Node invocation).

For PowerShell, choose its installed absolute executable, for example `C:\Program Files\PowerShell\7\pwsh.exe`, and enter these four Arguments lines:

```text
-NoProfile
-NonInteractive
-File
C:\Example\nexus-credentials.ps1
```

A synthetic script accepting the appended literal flag:

```powershell
if ($args.Count -ne 1 -or $args[0] -ne '--pass') { exit 2 }
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$response = @{ version = 1; username = 'example-user'; password = 'synthetic-example-only' }
[Console]::Write(($response | ConvertTo-Json -Compress))
```

### Supported surfaces and retained state

| Surface | External Program behavior |
|---|---|
| SSH terminals, Test Connection, SFTP, tunnels, SSH jump hosts | Supported through the shared authentication factory; every new authentication retrieves independently |
| Existing pooled SSH transport | Reuses its established login; opening another channel is not a new authentication and does not run the program |
| Inventory source / device-template SSH profile assignment | Carries the link without retrieving; External Private Key does not need a static key file |
| Inventory API tokens/passwords and SOCKS5/HTTP proxy passwords | Independent existing credential sources; External Program does not supply them |
| Deploy SSH Key | Unavailable for external or unresolved SSH profiles; choose a stored profile/source first |
| IPMI credentials, including macro credential injection | External profiles are unavailable; choose a supported stored profile |
| Macros and browser URLs using `${profile.username}` | Refused before execution; the dynamic username is not available as a static token, even after connecting; other tokens still work |
| Password keyboard-interactive | Only the recognized password challenge can use the response; arbitrary MFA/OTP challenges are refused without prompting |
| Private Key keyboard-interactive | No fallback; authentication rejection never falls through to stored passwords, agent keys or prompts |

Linked forms and tree tooltips show **External Program**, not a stored username presented as the sign-in identity. Server/tunnel pickers, copied connection info, the File Explorer header and sudo prompts omit the account when the profile is external or missing; they never run the program just to display a label. Containerlab discovery and its background approval are invalidated when a linked external program, arguments or authentication method changes. The server username remains visible and editable as a lookup hint; it is sent to the program only if enabled arguments reference `${username}`, and is never used as the SSH login in place of the returned username. Existing auth type and key path remain stored for an explicit unlink; new servers retain their normal username default. Explicitly unlinking reveals the retained authentication fields and applies normal validation. Missing or unconfigured profile links fail closed and remain visible for repair, instead of falling back to dormant credentials.

Switching a stored auth profile to External Program saves the external configuration and removes that profile's password/passphrase slots. Cleanup failure is reported accurately and those slots remain unused; retry Save to clean them. Switching back clears those slots before enabling stored mode, so a failed cleanup cannot resurrect an old secret. This does not erase unrelated server-scoped secrets. An external profile cannot be deleted while servers, sources or templates still reference it; unlink/change those references first. See [external-profile portability](import-export.md#external-program-profile-portability) for backups, sharing and older readers.

Nexus does not persist provider results in configuration, SecretStorage, webviews, logs, telemetry, backups, command history or pool keys, and does not cache or share them across authentications. It releases extension-owned references and wipes owned key/output buffers. JavaScript strings, SSH-library copies, OS buffers and crash dumps cannot be guaranteed erased; dependency-owned parsed key material may remain until connection disposal. Process groups and Windows process-tree termination bound cooperative cleanup, but cannot contain malicious detached descendants. This is trusted local execution, not a sandbox.

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
2. **SOCKS5 / HTTP CONNECT** — Edit the target server and set its proxy type, entering the proxy host, port, and optional credentials. Proxy passwords are stored securely in VS Code SecretStorage, one per proxy (type, host, port and user name): changing the proxy stops the old password from being used, and switching back to a proxy finds its saved password again until you save a change that leaves it.

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

Editing a jump host's connection settings (or its auth profile), or removing the jump host (or refreshing after another window saved a change), also retires the shared connections of the servers that go through it. Sessions already open keep running on their old connection; the next reconnect or tunnel start builds a new one over the current route.

Per-server toggle lets you disable multiplexing for devices that don't support multiple channels (e.g. Cisco).

Automatic fallback to standalone connections handles channel failures transparently.

## If the Server Changes While Connecting

If the server is removed or its connection settings (address, port, protocol, user name, authentication method, key file, auth profile link, proxy or jump host) change before the terminal opens (the user name, authentication method and key file count as they end up after the linked auth profile is applied, and a jump host's own connection settings count too), Nexus cancels the connect and shows a notice, with **Retry** on the current settings when the server still exists (it repeats the original action, such as Connect and Run Script). Saving the server without changes, renaming its folder, or refreshing after another window saved, does not cancel it. This applies to SSH and Telnet, and the check happens once, just before the terminal is created. Once the terminal is open — including while it waits for a password or verification code, or for the Telnet connection — the session keeps the settings it started with, and an edit applies at the next connect. These checks compare the saved configuration; a saved password, key passphrase or proxy password changed in the secret store does not cancel a pending start, and the new value is used at the next login.

## When a Session Drops

Faults that arrive *after* a session is up — a keepalive timeout, a protocol error, the connection closing — are recorded in the **Nexus SSH** output channel, so a terminal that drops on its own leaves a cause behind instead of only "Connection lost".

When an SSH session drops, Nexus disables terminal mouse-tracking, focus-reporting, color-scheme notification, alternate-scroll, bracketed-paste, application-cursor-key and application-keypad modes, shows the cursor, and resets the active screen's Kitty keyboard-mode stack and flags before showing the disconnect banner. Telnet, Serial and Smart Follow terminals get the same reset, and a disconnected Telnet or Serial tab closes only on a real key press, not on focus, mouse or color-scheme reports or up/down arrow sequences (wheel scrolling). Press **R** to reconnect an SSH session in the same tab; your visible output and scrollback stay available, and late output from the old connection is ignored even after reconnect.

## Telnet

Set a server's **Protocol** to *Telnet* and it connects over raw telnet instead of SSH, for console servers, virtual-lab consoles, and gear that offers nothing else.

It is a per-server switch on the profile you already have, not a separate kind of profile: pick Telnet and the credential fields disappear, because telnet has no login of its own — you authenticate at the device's own prompt, in the terminal.

Nexus speaks the negotiation properly (echo and suppress-go-ahead, terminal type, and live window-size updates on resize), so full-screen tools and line editing behave.

Everything the terminal layer gives an SSH tab it gives a telnet tab too: [highlighting](terminal.md#highlighting), [Reset / Clear Scrollback / Copy All](terminal.md#tab-commands), [auto-trigger macros](macros.md), and [scripts](scripting.md) (`@target-type telnet`).

**Telnet is cleartext** — there is no encryption and no authentication in the protocol — so SFTP, port forwarding, jump hosts and key deployment aren't available on a telnet server, and asking for one says so up front instead of failing inside a handshake.

## Related settings

SSH connection, SSH agent, keepalive, host-key, proxy-timeout and multiplexing settings: [settings.md#ssh](settings.md#ssh).

## See also

- [Port Forwarding](port-forwarding.md) — TCP tunnels through an SSH server
- [File Explorer](file-explorer.md) — SFTP browsing on a connected server
- [Terminal](terminal.md) — highlighting, tab commands, transcripts, keyboard passthrough
- [Import and Export](import-export.md#import-from-an-ssh-config) — bring servers in from `~/.ssh/config`, MobaXterm or SecureCRT
- [Inventory Sync](inventory/README.md) — servers created from NetBox, EVE-NG, Proxmox, GNS3 or Containerlab, including [servers with no address yet](inventory/README.md#servers-with-no-address-yet)
- [Connectivity Hub](connectivity-hub.md) — folders, filter and drag and drop
