"use strict";
// See docs/vault-providers.md. No npm dependencies.
const { spawnSync } = require("node:child_process");
const { isAbsolute } = require("node:path");

try {
  const [provider, executable, scope, secret, method, ...extra] = process.argv.slice(2);
  if (!executable || !isAbsolute(executable) || extra.length ||
      !scope || !secret || scope.startsWith("-") || secret.startsWith("-") ||
      !["--pass", "--pkey"].includes(method)) throw new Error();
  let args;
  switch (provider) {
    case "vault-kv1":
    case "vault-kv2":
      args = ["kv", "get", "-format=json", `-mount=${scope}`, secret];
      break;
    case "aws":
      args = ["secretsmanager", "get-secret-value", "--region", scope,
        "--secret-id", secret, "--output", "json", "--no-cli-pager"];
      break;
    case "azure":
      // Use the Python interpreter containing Azure CLI, not az.cmd/az.bat.
      // Isolated mode excludes the working directory and PYTHONPATH from imports.
      args = ["-I", "-m", "azure.cli", "keyvault", "secret", "show",
        "--vault-name", scope, "--name", secret, "--output", "json", "--only-show-errors"];
      break;
    default: throw new Error();
  }
  const result = spawnSync(executable, args, {
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024
  });
  if (result.error || result.status !== 0) throw new Error();
  const response = JSON.parse(result.stdout);
  const value = provider === "vault-kv1" ? response.data :
    provider === "vault-kv2" ? response.data?.data :
    JSON.parse(provider === "aws" ? response.SecretString : response.value);
  const field = method === "--pass" ? "password" : "private_key";
  if (!value || typeof value.username !== "string" || !value.username ||
      /[\0\r\n]/u.test(value.username) || typeof value[field] !== "string" || !value[field]) throw new Error();
  // Project only the selected credential. Never forward CLI envelopes or metadata.
  process.stdout.write(JSON.stringify({ version: 1, username: value.username, [field]: value[field] }));
} catch {
  process.stderr.write("Vault credential retrieval failed.\n");
  process.exitCode = 1;
}
