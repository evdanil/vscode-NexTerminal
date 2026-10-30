"use strict";
// Run with Node.js; see docs/1password.md. No npm packages required.
const { spawnSync } = require("node:child_process");
const { isAbsolute } = require("node:path");

try {
  const [op, usernameReference, credentialReference, method, ...extra] = process.argv.slice(2);
  if (!op || !isAbsolute(op) || extra.length ||
      !usernameReference?.startsWith("op://") || !credentialReference?.startsWith("op://") ||
      !["--pass", "--pkey"].includes(method)) throw new Error();

  function read(reference) {
    const result = spawnSync(op, ["read", "--no-newline", reference], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 12_000,
      killSignal: "SIGKILL",
      maxBuffer: 192 * 1024
    });
    if (result.error || result.status !== 0 || !result.stdout) throw new Error();
    // --no-newline removes the CLI's added newline. Do not trim secret values.
    return result.stdout;
  }

  const username = read(usernameReference);
  if (/[\0\r\n]/u.test(username)) throw new Error();
  const credential = read(credentialReference);
  const field = method === "--pkey" ? "private_key" : "password";
  // Write only once, after BOTH reads succeed. Nexus validates the response.
  process.stdout.write(JSON.stringify({ version: 1, username, [field]: credential }));
} catch {
  // Never print an Error object, raw op output, references, or credentials.
  process.stderr.write("1Password credential retrieval failed.\n");
  process.exitCode = 1;
}
