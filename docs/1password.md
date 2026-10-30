# SSH credentials from 1Password

Use an **External Program** auth profile to read a username and password or private key from 1Password for each new SSH authentication. This example uses the [1Password CLI](https://developer.1password.com/docs/cli/) and a small [Node.js provider script](../examples/external-credentials/1password.cjs), with no npm dependencies. It requires the External Program feature introduced in Nexus Terminal 2.8.305.

This is a credential-provider program launched by Nexus, not a script to run from the Nexus Scripts view. For the general contract and supported consumers, see [External Program credentials](ssh-and-telnet.md#external-program-credentials).

For other services, see [HashiCorp Vault, AWS Secrets Manager and Azure Key Vault examples](vault-providers.md).

## Prepare the extension host

1. Install Node.js 20 or 22 and 1Password CLI on the machine running the Nexus extension host. Find their absolute executable paths with `command -v node` and `command -v op` on macOS/Linux, or `(Get-Command node.exe).Source` and `(Get-Command op.exe).Source` in PowerShell.
2. Copy [1password.cjs](../examples/external-credentials/1password.cjs) to a stable location you control, for example `/home/alex/.config/nexus/1password.cjs`. Protect it from modification by other users: Nexus approval trusts this program and its dependencies.
3. Configure [1Password desktop app integration](https://developer.1password.com/docs/cli/app-integration/) under **1Password → Settings → Developer → Integrate with 1Password CLI**. Follow the platform-specific unlock requirements in that guide. Confirm `op vault list` works from the same machine and user account as VS Code. With multiple accounts, configure `OP_ACCOUNT` in the environment inherited by the VS Code extension host.

The provider has no terminal input. Complete sign-in setup beforehand; 1Password may still show its own desktop authorization prompt. Each `op read` has a 12-second timeout, keeping two reads inside Nexus's 30-second process limit. Unlock 1Password first if authorization takes too long.

With Remote SSH, WSL or containers, the extension host can be remote: local paths and local desktop integration do not automatically exist there. Install/configure the CLI and script on that host with an authentication method it supports. Setting environment variables in an already-open integrated terminal does not update the extension host's environment; launch/restart VS Code with the required environment. Never put a service-account token, session token, account password or Secret Key in Nexus arguments or the script.

## Password example

Create a 1Password Login item named **Lab Router** in vault **Infrastructure**:

| 1Password field | Example value |
| --- | --- |
| username | `netadmin` |
| password | Your device's SSH password |

Use **Copy Secret Reference** on each field to obtain the actual references. Names below are illustrative; IDs also work and avoid ambiguity. See [1Password secret-reference syntax](https://developer.1password.com/docs/cli/secret-reference-syntax/).

In **Nexus → Settings → Auth Profiles**, create and save:

| Nexus field | Example |
| --- | --- |
| Name | `1Password — Lab Router` |
| Authentication | `External Program` |
| Authentication Method | `Password` |
| Executable | `/usr/bin/node` — replace with your Node executable |
| Arguments | The four lines below |

```text
/home/alex/.config/nexus/1password.cjs
/usr/local/bin/op
op://Infrastructure/Lab Router/username
op://Infrastructure/Lab Router/password
```

Replace both executable paths with the paths found above. Each line is **one argument**, including any spaces. Do not add shell quotes, `~`, `$HOME`, `%USERPROFILE%`, or `--pass`; Nexus appends the method flag itself. Secret references are locators rather than secret values, but their vault/item names are visible in saved configuration and backups.

On Windows, for example, set **Executable** to `C:\Program Files\nodejs\node.exe` and use these argument lines, replacing the `op.exe` location with its actual installed path:

```text
C:\Users\Alex\Nexus\1password.cjs
C:\Tools\1Password\op.exe
op://Infrastructure/Lab Router/username
op://Infrastructure/Lab Router/password
```

On macOS use the discovered Node and `op` paths, which may differ from Linux. This explicit Node interpreter works across platforms; Windows `.cmd` and `.bat` wrappers are not supported as the configured executable.

Edit your SSH server and choose **Advanced → Auth Profile → 1Password — Lab Router**. Nexus gets the login username from the provider, so no separate static username/password is needed for this profile. One profile can be linked to multiple servers that share those credentials. Nexus does not pass the target hostname to the script; create separate profiles/references for different credentials.

For a concrete 100-server setup with several credential groups, see [mapping servers to auth profiles](vault-providers.md#example-100-servers-with-different-credential-groups). The same mapping applies to 1Password: each profile supplies its own username and credential references to the shared script.

## Private-key example

Store/import the SSH private key in a 1Password **SSH Key** item, for example **Lab SSH Key**. Add a text field named `username` with the target account, or reference the username in a separate Login item. An SSH Key item does not inherently specify the target server's login username. Install the matching public key on the server separately.

Use the same script and executable, select **Authentication Method → Private Key**, and change the reference lines:

```text
/home/alex/.config/nexus/1password.cjs
/usr/local/bin/op
op://Infrastructure/Lab SSH Key/username
op://Infrastructure/Lab SSH Key/private key?ssh-format=openssh
```

Copy the actual field references from your item; a field inside a section needs that section in its reference. The [`ssh-format=openssh` parameter](https://developer.1password.com/docs/cli/reference/commands/read/) requests OpenSSH key text. Nexus appends `--pkey` and accepts only an **unencrypted** private key; this protocol has no key-passphrase field. This flow retrieves private-key material into the provider and Nexus processes. It does not use 1Password's SSH agent/signing interface.

## What the script does

Download the complete [1password.cjs example](../examples/external-credentials/1password.cjs). Its arguments are:

```text
node 1password.cjs <absolute-op-path> <username-reference> <credential-reference> --pass|--pkey
```

It calls `op read --no-newline` for each reference using an argument array and `shell: false`. The [CLI's no-newline option](https://developer.1password.com/docs/cli/reference/commands/read/) avoids an extra delimiter without trimming meaningful password whitespace. `JSON.stringify` escapes quotes, backslashes and key line breaks. Successful stdout is exactly one JSON object, for example with synthetic values:

```json
{"version":1,"username":"netadmin","password":"EXAMPLE-ONLY"}
```

For keys, the third property is `private_key` instead of `password`. Both reads must succeed before any JSON is emitted. Errors exit nonzero with a fixed message; CLI stderr and exception details are not forwarded. The script writes no secret files and caches nothing. Secrets still exist in process memory; JavaScript cannot guarantee erasure. Two field reads are not an atomic item snapshot, so avoid changing the username and credential during a connection attempt.

## Connect and troubleshoot

1. Trust the workspace, save/link the profile, then use **Connect** or **Test Connection** interactively.
2. Review the **External Credential Invocation** document, run **Nexus: Continue External Credential Approval**, and choose **Allow for This Session**. This Nexus approval permits program execution; it does not sign in to 1Password.
3. Complete any separate 1Password prompt promptly. Nexus runs the program for a new physical SSH connection; opening another channel on an existing pooled connection does not read the vault again. To verify a rotated secret, close the existing sessions, revoke external approvals as described below (which retires pooled connections for future use), then reconnect and approve again. Simply closing a terminal can leave an idle pooled connection available for reuse.
4. To withdraw Nexus permission, use **Revoke All External Credential Approvals** in the Auth Profiles editor. Already established sessions remain open.

If retrieval fails, verify the Node/script/CLI paths, selected account, vault access and copied field references. Use `op vault list` to troubleshoot sign-in without printing a credential. Do not run the provider directly in a terminal with real references: its successful stdout contains the password or private key. Do not log or attach that output to a bug report. If you intentionally inspect it during local diagnosis, treat it as secret material.

**Validation:** the checked-in example is exercised with a fake CLI process and the real Nexus response parser for password whitespace, key encoding and safe failure behavior. No live 1Password account is used by those tests; authenticate and verify your own installation before relying on it.
