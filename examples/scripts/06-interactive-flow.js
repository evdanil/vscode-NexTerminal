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
// `password: true` masks the input box AND prevents the entered value from
// being written to the "Nexus Scripts" Output Channel — safe for secrets.

await expect(/[$#] $/);

// Free-text input with a default.
const tag = await prompt("Image tag to deploy", { default: "latest" });
if (!tag) {
  log.warn("user cancelled — aborting");
} else if (!(await confirm(`Deploy image '${tag}' to production?`))) {
  log.info("user declined — aborting");
} else {
  // Password prompt — the value never appears in the log or the Output Channel.
  const registryPassword = await prompt("Registry password", { password: true });

  await sendLine(`echo "${registryPassword}" | docker login -u deploy --password-stdin`);
  await expect(/Login Succeeded/);

  await sendLine(`docker pull myregistry/app:${tag}`);
  await expect(/[$#] $/, { timeout: 60_000 });

  // Informational alert — use when you need the user's physical attention
  // (e.g. "insert USB stick and press OK").
  await alert("Image pulled. Ready to restart the service.");

  await sendLine("sudo systemctl restart app");
  await expect(/[$#] $/);
  log.info("deployed");
}
