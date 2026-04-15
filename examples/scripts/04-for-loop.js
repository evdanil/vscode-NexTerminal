/**
 * @nexus-script
 * @name 04 — For loop over a command list (batch execute)
 * @description Run a list of commands and capture each command's output between prompts.
 * @target-type ssh
 */

// JavaScript's `for...of` is the clean way to iterate over an array of commands.
// Each iteration waits for the prompt before sending the next command and again
// after it — so we can slice the output using the `before` field on the Match.

await expect(/[$#] $/);

const commands = [
  "hostname",
  "uptime",
  "uname -sr",
  "df -h /"
];

const results = {};

for (const cmd of commands) {
  await sendLine(cmd);
  const out = await expect(/[$#] $/, { timeout: 5_000 });
  // `out.before` is the session output between the previous cursor and this prompt,
  // which is the command echo + its response. Drop the echoed command line itself.
  const lines = out.before.split("\n").slice(1).join("\n").trim();
  results[cmd] = lines;
  log.info(`${cmd}:\n${lines}`);
}

log.info("collected " + Object.keys(results).length + " result(s)");
