/**
 * @nexus-script
 * @name 06 — Interactive flow (prompt / confirm / alert)
 * @description Pause mid-run to ask the user for input, a yes/no answer, or acknowledgment.
 * @target-type ssh
 */

// Scripts can pause and ask the user for input through native VS Code dialogs.
//
//   prompt(message, { default?, password? })  → string (empty string on cancel)
//   confirm(message)                           → boolean (true = OK, false = cancel)
//   alert(message)                             → void (OK-only modal)
//
// `password: true` masks the input box. The runtime never writes what the user
// typed into any prompt to the "Nexus Scripts" Output Channel — only what you
// pass to `log.*` yourself ends up there.

// Start from a fresh prompt — the one already on screen was printed before the
// script started, so the script can't see it (see 01-hello.js).
await sendLine("");
await expect(/[$#] $/);

// Free-text input with a default.
const tag = await prompt("Image tag to deploy", { default: "latest" });
if (!tag) {
  log.warn("user cancelled — aborting");
} else if (!(await confirm(`Deploy image '${tag}' to production?`))) {
  log.info("user declined — aborting");
} else {
  // Let `docker login` ask for the password itself, so the secret is typed at
  // its prompt instead of appearing in a command line (and the shell history).
  await sendLine("docker login -u deploy");
  await expect(/Password: ?$/);
  const registryPassword = await prompt("Registry password", { password: true });
  await sendLine(registryPassword);
  await expect(/Login Succeeded/);
  // Consume the prompt that follows, so the next wait can't match it early.
  await expect(/[$#] $/);

  await sendLine(`docker pull myregistry/app:${tag}`);
  await expect(/[$#] $/, { timeout: 60_000 });

  // Informational alert — use when you need the user's physical attention
  // (e.g. "insert USB stick and press OK").
  await alert("Image pulled. Ready to restart the service.");

  // Assumes passwordless sudo: if sudo asks for a password, this wait times
  // out — add a `waitAny([/password/i, /[$#] $/])` branch for that case.
  await sendLine("sudo systemctl restart app");
  await expect(/[$#] $/);
  log.info("deployed");
}
