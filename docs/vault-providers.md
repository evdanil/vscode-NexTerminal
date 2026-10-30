# External vault provider examples

Nexus Terminal 2.8.305 adds **External Program** SSH authentication. These examples read credentials from HashiCorp Vault, AWS Secrets Manager and Azure Key Vault. For a desktop password manager, see the separate [1Password guide](1password.md).

Download [vault-provider.cjs](../examples/external-credentials/vault-provider.cjs) to a stable directory you control. It uses Node.js built-ins and the selected vendor's CLI; no npm install is needed. Protect the script and CLI from modification by other users. These are external credential providers, not Nexus Scripts-view automation.

## Shared settings and secret format

In **Nexus → Settings → Auth Profiles → New Profile**, set:

| Field | Value |
| --- | --- |
| Name | A descriptive name, such as `Vault — Lab Router` |
| Authentication | `External Program` |
| Authentication Method | `Password` or `Private Key` |
| Executable | Absolute Node.js 20/22 executable path, such as `/usr/bin/node` |
| Arguments | One of the five-line examples below |

Every backend stores a username and the chosen credential as string fields:

```json
{"username":"netadmin","password":"EXAMPLE-ONLY"}
```

For key authentication store `private_key` instead of `password`, containing the full **unencrypted** OpenSSH or traditional PEM key text with actual line breaks. Use a JSON-aware editor/serializer to escape those line breaks inside JSON. Install the matching public key on the server separately. No passphrase, certificate-signing, OTP or dynamic-lease handling is implemented by these examples.

Each argument line is literal: no shell quotes, environment-variable expansion or `~`. Do not add `--pass` or `--pkey`; Nexus appends the selected method. Arguments hold paths/identifiers only, never passwords, tokens or private keys. Identifiers remain visible in saved configuration and backups. Select the saved auth profile on your SSH server under **Advanced → Auth Profile**. The provider supplies the username; it receives no target hostname, so use separate profiles for different secrets.

## Example: 100 servers with different credential groups

Choose the secret through the server's **assigned auth profile**, not by writing a script for each server. All profiles can use the same provider script with different arguments.

| Servers | Assigned auth profile | Vault secret path |
| --- | --- | --- |
| 60 Linux production servers | `Linux production` | `network/linux-production` |
| 25 network devices | `Network devices` | `network/network-devices` |
| 15 lab servers | `Lab credentials` | `network/lab` |

Create three External Program profiles, each pointing to the same Node executable and `vault-provider.cjs`. For the **Linux production** profile, choose **Password** and use:

```text
/home/alex/.config/nexus/vault-provider.cjs
vault-kv2
/usr/local/bin/vault
secret
network/linux-production
```

For **Network devices**, change only the last line to `network/network-devices`; for **Lab credentials**, use `network/lab`. Each secret contains the username and password for that group. If a group uses a private key instead, select **Private Key** in that group's auth profile and store `username` plus `private_key` at its secret path.

Assign each profile under the corresponding server's **Advanced → Auth Profile**, or use the existing folder action to apply an auth profile to a group of servers. These are explicit server/profile assignments; folder organization alone does not make the script choose a secret. Inventory sources and device templates can also apply auth profiles during provisioning.

The same approach works with AWS secret IDs, Azure secret names, and [1Password field references](1password.md): keep the script, change the profile's arguments.

**No destination context is passed to the provider.** It receives the configured arguments plus `--pass` or `--pkey`, not the target server's hostname or ID. Three shared credential sets therefore need three profiles, even with 100 servers. If all 100 servers have unique credentials, typically create 100 auth profiles with distinct secret references, still using just one script. A single profile that automatically selects a secret from the destination hostname would require a future server-context feature; it is not supported by this version.

## HashiCorp Vault (KV v2 or KV v1)

Use a KV secret at mount `secret`, path `network/lab-router`, with `username` and `password` (or `private_key`) fields. Configure access in Vault's UI or your existing secret-management workflow. This is a **KV read** example, not Vault's SSH secrets engine, dynamic credentials or signed SSH certificates.

Arguments for KV v2:

```text
/home/alex/.config/nexus/vault-provider.cjs
vault-kv2
/usr/local/bin/vault
secret
network/lab-router
```

There are **five lines**: script, provider mode, CLI executable, mount and path. For KV v1 change only `vault-kv2` to `vault-kv1`. Use your actual mount name; do not insert `/data/` into the path. The script invokes [`vault kv get -format=json -mount=secret network/lab-router`](https://developer.hashicorp.com/vault/docs/commands/kv/get) and reads `data.data` for KV v2 or `data` for KV v1. Choosing the wrong mode fails rather than guessing.

Set `VAULT_ADDR` and, if needed, `VAULT_NAMESPACE`/`VAULT_CACERT` in the extension host's environment. Authenticate using your organization's normal Vault login/token-helper workflow before connecting. Give that identity read access to this secret (for KV v2, the data path), plus any mount-discovery permission required by your Vault configuration. Do not place `VAULT_TOKEN` in the argument list, disable TLS validation, or use a root token for this example. Nexus neither logs in to Vault nor renews its authentication token. See [Vault CLI configuration](https://developer.hashicorp.com/vault/docs/commands) and [KV v2 reads](https://developer.hashicorp.com/vault/docs/secrets/kv/kv-v2/cookbook/read-data).

## AWS Secrets Manager

Create a secret, for example `network/lab-router`, whose **SecretString** is the JSON object shown above. A binary secret is not supported. Select the AWS region containing it:

```text
/home/alex/.config/nexus/vault-provider.cjs
aws
/usr/local/bin/aws
us-east-1
network/lab-router
```

The script calls [`aws secretsmanager get-secret-value`](https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/get-secret-value.html), parses `SecretString`, and projects only the username and selected credential. It reads the default current version (`AWSCURRENT`). Configure the AWS CLI's normal credential chain for the extension-host user; for example, complete `aws sso login --profile lab` beforehand and launch VS Code with `AWS_PROFILE=lab`. Machine roles are another option. It needs `secretsmanager:GetSecretValue` and, for a customer-managed encryption key, the appropriate `kms:Decrypt` permission. No AWS login or credential renewal is performed by the script.

## Azure Key Vault

Create a Key Vault **secret** named, for example, `lab-router-ssh`, whose **value** is the JSON object above. This example reads secrets, not Key Vault keys or certificates.

Use the Python interpreter belonging to your Azure CLI installation. `az --version` reports its Python location; verify that interpreter can run `-I -m azure.cli --version`. A generic system Python without the `azure.cli` package will not work. This follows the CLI's [Python module entry point](https://github.com/Azure/azure-cli/blob/dev/src/azure-cli/az.bat), adding [Python isolated mode](https://docs.python.org/3/using/cmdline.html#cmdoption-I) so the temporary working directory cannot supply imported modules. Packages must be installed in that interpreter's environment, not only its user site.

```text
/home/alex/.config/nexus/vault-provider.cjs
azure
/opt/az/bin/python3
my-infrastructure-vault
lab-router-ssh
```

The Python path is illustrative: use the one from your installation. The adapter invokes `python -I -m azure.cli keyvault secret show --vault-name ... --name ... --output json --only-show-errors`, then parses the returned `value` as JSON. The [secret-show command](https://learn.microsoft.com/en-us/cli/azure/keyvault/secret#az-keyvault-secret-show) reads the latest version when no version is specified.

Complete `az login` and select the correct tenant/subscription for the extension-host user before connecting, or configure your supported workload/managed identity workflow separately. The identity needs secret-value read access, for example the **Key Vault Secrets User** role under the RBAC permission model, or the appropriate secret `get` access policy. The script does not run an interactive login.

## Windows, macOS and remote hosts

Find Node and vendor CLI locations with `command -v` on macOS/Linux or `Get-Command` in PowerShell. Node, the provider file, CLI, account configuration and environment must all be available on the machine running the extension host, which may be WSL, a container or a remote machine.

On Windows, set **Executable** to the actual `node.exe`, for example `C:\Program Files\nodejs\node.exe`. Replace script and CLI lines with absolute Windows paths. Vault and AWS examples use `vault.exe` and `aws.exe`. For Azure, use the CLI installation's **python.exe**, not `az.cmd`/`az.bat`. For example (replace the installation path if different):

```text
C:\Users\Alex\Nexus\vault-provider.cjs
azure
C:\Program Files\Microsoft SDKs\Azure\CLI2\python.exe
my-infrastructure-vault
lab-router-ssh
```

Do not quote paths in the Arguments form, even when they contain spaces. Restart/launch VS Code with any required environment changes: exporting variables in an existing integrated terminal does not change the extension host's environment. Complete MFA/SSO/token setup beforehand; the provider has no terminal input.

## Approval, rotation and troubleshooting

Save/link the profile and use **Connect** or **Test Connection** interactively in a trusted workspace. Review the invocation, run **Nexus: Continue External Credential Approval**, then choose **Allow for This Session**. Nexus execution approval is separate from the vault/cloud identity's authentication and permissions.

A new physical SSH authentication reads the secret again; a channel on an existing pooled connection does not. To test rotation, close existing sessions, use **Revoke All External Credential Approvals**, and reconnect/approve. Revocation retires pooled entries for future acquisitions but does not terminate established sessions. For more behavior and limitations, see [External Program credentials](ssh-and-telnet.md#external-program-credentials).

The adapter makes one bounded CLI request (20 seconds, 256 KiB output), leaving time inside Nexus's 30-second limit. It uses no shell, ignores CLI stderr, writes one protocol JSON object only after successful parsing, and reports a fixed failure message. It neither writes credential files nor caches responses; the vendor CLI still uses its own authentication/configuration storage. JavaScript memory erasure is not guaranteed. Large values, expired sessions, authorization errors, throttling and network failures fail the connection rather than falling back to stored credentials.

Troubleshoot the CLI's identity/account configuration, permissions, region/namespace and secret shape separately. Never log the provider's stdout or paste it into an issue: successful output contains the password or private key. CLI responses must be JSON; banners or malformed envelopes are rejected. Extra stored fields are omitted from the Nexus response.

**Validation:** automated tests run the actual adapter source with stubbed CLI responses and the real Nexus credential parser, covering both KV envelopes, cloud JSON envelopes, password whitespace, private keys and safe failure. These are contract tests, not live Vault/AWS/Azure account tests. Verify your deployment's authentication and permissions before use.
