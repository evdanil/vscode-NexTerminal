# External vault provider examples

Nexus Terminal 2.8.306 adds **External Program** SSH authentication. These examples read credentials from HashiCorp Vault, AWS Secrets Manager and Azure Key Vault. For a desktop password manager, see the separate [1Password guide](1password.md).

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

Each argument line is literal by default: no shell quotes, environment-variable expansion or `~`. The opt-in connection-variable expansion described below is limited to the documented tokens. Do not add `--pass` or `--pkey`; Nexus appends the selected method. Arguments hold paths/identifiers only, never passwords, tokens or private keys. Identifiers remain visible in saved configuration and backups. Select the saved auth profile on your SSH server under **Advanced → Auth Profile**. The provider supplies the SSH login username; the server username is a lookup hint when explicitly included in expanded arguments.

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

### One profile for 100 distinct secrets

Alternatively, enable **Expand connection variables in arguments** in a single External Program profile and assign that profile to all 100 servers. Before enabling it, update all Nexus installations that access this configuration and export a backup with the newer version. Older clients cannot read enabled profiles, may erase them when saving auth profiles, and may omit them from backups. Before downgrading, disable expansion, save auth profiles in the newer version and export a backup there; see the [downgrade details](import-export.md#external-program-profile-portability), including the explicit-false case.

For a concrete Vault KV v2 example, suppose the servers are named `server-001` through `server-100`, with hosts such as `server-001.example.net`. Their server Username fields hold lookup hints such as `netadmin`; Vault stores a separate JSON secret at `secret` mount path `network/server-001/netadmin`, containing, for example:

```json
{"username":"actual-login","password":"EXAMPLE-ONLY"}
```

Put the following wrapper in `/home/alex/.config/nexus/fleet-vault.cjs`, alongside the downloaded `vault-provider.cjs`. Replace the paths and naming policy with ones appropriate for your environment. Its allowlist makes each substituted value a single safe path component and binds the host to the expected server name; adjust the policy for your fleet rather than blindly accepting inventory text.

```js
"use strict";
const { spawnSync } = require("node:child_process");

try {
  const [host, session, user, method, ...extra] = process.argv.slice(2);
  const match = /^server-(\d{3})$/.exec(session || "");
  const number = match ? Number(match[1]) : 0;
  if (!match || number < 1 || number > 100 ||
      host !== `${session}.example.net` ||
      !/^[a-z][a-z0-9_-]{0,31}$/.test(user || "") ||
      !["--pass", "--pkey"].includes(method) || extra.length) throw new Error();

  const result = spawnSync(process.execPath, [
    "/home/alex/.config/nexus/vault-provider.cjs",
    "vault-kv2", "/usr/local/bin/vault", "secret",
    `network/${session}/${user}`, method
  ], { shell: false, stdio: ["ignore", "pipe", "ignore"], timeout: 25000, maxBuffer: 256 * 1024 });
  if (result.error || result.status !== 0 || !result.stdout.length) throw new Error();
  process.stdout.write(result.stdout);
} catch {
  process.stderr.write("Fleet credential retrieval failed.\n");
  process.exitCode = 1;
}
```

Set **Executable** to `/usr/bin/node` (your actual absolute Node path), choose **Password**, check **Expand connection variables in arguments**, and enter these four separate argument lines:

```text
/home/alex/.config/nexus/fleet-vault.cjs
${host}
${SessionName}
${username}
```

Nexus appends `--pass`; the wrapper validates the context and calls the existing provider with separate arguments and no shell. The value stored at the selected path supplies the actual SSH username and password; the server Username is only a lookup hint. For key authentication select **Private Key** and store `private_key` instead. Restrict the vault identity to the appropriate secrets as well as validating input: argument separation alone does not authorize a vault path. The wrapper example has no live vault test; validate your own policy and setup.

The approval document shows the template and one resolved example; **Allow for This Session** authorizes that template for later connections whose values may differ. Context in process arguments may be visible in process listings. `${host}` is the actual dial target, including an alternate host. The strict host/name check above deliberately rejects alternate addresses unless you add an explicit allowed mapping; using `${SessionName}` for the secret path keeps the lookup stable across addresses. Jump hosts receive their own server's context. Inventory source default usernames seed new synced servers; changing the default does not replace existing usernames unless the provider supplies one.

The complete token list, escaping (`$${host}` for a literal `${host}`), validation and compatibility details are in [Connection variables in arguments](ssh-and-telnet.md#connection-variables-in-arguments). Expansion is off by default, so the earlier three-profile example remains literal and works unchanged.

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
