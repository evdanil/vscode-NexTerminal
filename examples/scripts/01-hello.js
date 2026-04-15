/**
 * @nexus-script
 * @name 01 — Hello (basic expect/send)
 * @description Smoke test. Wait for a shell prompt, run `uname -a`, read the output.
 * @target-type ssh
 * @default-timeout 10s
 */

// Every Nexus script is an async function body. Use `await` on every primitive.
//
// `expect(pattern)` waits until `pattern` matches new output from the bound
// session. On match it returns a `Match` object with `text`, `groups`, and
// `before` (the output between the previous cursor and this match).
// On timeout it THROWS. Use `waitFor` if you'd rather get `null`.

const prompt = await expect(/[$#] $/);
log.info("shell ready:", prompt.text);

// `sendLine(text)` writes `text` + "\r" to the session — same effect as the
// user typing the line and pressing Enter.
await sendLine("uname -a");

// Capture everything between the previous prompt and the next one.
const out = await expect(/[$#] $/);
log.info("kernel:", out.before.trim());
