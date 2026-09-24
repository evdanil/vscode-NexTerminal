/**
 * @nexus-script
 * @name 01 — Hello (basic expect/send)
 * @description Smoke test. Get a shell prompt, run `uname -a`, read the output.
 * @target-type ssh
 * @default-timeout 10s
 */

// Every Nexus script is an async function body. Use `await` on every primitive.
//
// `expect(pattern)` waits until `pattern` matches new output from the bound
// session. On match it returns a `Match` object with `text`, `groups`, and
// `before` (the output between the previous cursor and this match).
// On timeout it THROWS. Use `waitFor` if you'd rather get `null`.

// The script only sees output that arrives after it starts. On a terminal that
// is already open, the prompt is on screen and won't come again; under Connect
// and Run Script… it usually arrives just after the start. So wait briefly for
// it (`waitFor` returns null on timeout), and press Enter for a fresh one only
// if none came — an Enter while the first prompt is on its way would leave a
// spare prompt for a later wait to match too early.
let ready = await waitFor(/[$#] $/, { timeout: 2_000 });
if (!ready) {
  await sendLine("");
  ready = await expect(/[$#] $/);
}
log.info("shell ready — prompt ends with", JSON.stringify(ready.text));

// `sendLine(text)` writes `text` + "\r" to the session — same effect as the
// user typing the line and pressing Enter.
await sendLine("uname -a");

// `before` now holds the echoed command, its output, and the start of the next
// prompt (the pattern matched only the trailing "$ "). Keep the lines between.
const out = await expect(/[$#] $/);
const lines = out.before.trim().split(/\r?\n/);
log.info("kernel:", lines.slice(1, -1).join("\n"));
