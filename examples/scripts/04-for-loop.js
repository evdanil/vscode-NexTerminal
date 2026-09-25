/**
 * @nexus-script
 * @name 04 — For loop over a command list (batch execute)
 * @description Run a list of commands and capture each command's output between prompts.
 * @target-type ssh
 */

// JavaScript's `for...of` is the clean way to iterate over an array of commands.
// Each iteration sends a command and waits for the prompt that follows it — so
// we can slice the output using the `before` field on the Match.

// Start from a fresh prompt: on a terminal that is already open, the one on
// screen was printed before the script started, so the script can't see it.
// (Under Connect and Run Script… on a server the script already has the first
// prompt, and this Enter adds a spare one — 01-hello.js opens in a way that
// suits both.)
await sendLine("");
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
  // `out.before` is the session output between the previous cursor and this
  // match: the command echo, its response, and the start of the new prompt (the
  // pattern matched only its trailing "$ "). Drop the first and last lines.
  const lines = out.before.split(/\r?\n/).slice(1, -1).join("\n").trim();
  results[cmd] = lines;
  log.info(`${cmd}:\n${lines}`);
}

log.info("collected " + Object.keys(results).length + " result(s)");
