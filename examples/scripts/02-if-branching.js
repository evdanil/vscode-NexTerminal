/**
 * @nexus-script
 * @name 02 — Branching on what matched (if / waitAny)
 * @description Handle different login prompts (password vs. key vs. denied) with one wait.
 * @target-type ssh
 */

// `waitAny([...])` waits for the first of several patterns. It returns the
// matching pattern's `index` and the `match` details — so you can branch on
// which prompt appeared.

await sendLine("ssh user@jumphost");

const r = await waitAny(
  [
    /password:\s*$/i,        // index 0
    /passphrase for key/i,   // index 1
    /permission denied/i,    // index 2
    /[$#] $/                 // index 3 — already logged in somehow
  ],
  { timeout: 20_000 }
);

switch (r.index) {
  case 0:
    log.info("password prompt — supplying credential");
    await sendLine(await prompt("Password", { password: true }));
    break;

  case 1:
    log.info("key passphrase prompt — supplying passphrase");
    await sendLine(await prompt("Key passphrase", { password: true }));
    break;

  case 2:
    log.error("permission denied — aborting");
    throw new Error("auth failed");

  case 3:
    log.info("already logged in");
    break;
}

// Wait for the remote shell prompt regardless of which path we took.
await expect(/[$#] $/, { timeout: 15_000 });
log.info("logged in");
