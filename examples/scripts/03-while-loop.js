/**
 * @nexus-script
 * @name 03 — While loop with retry (expect + try/catch)
 * @description Retry a flaky operation until it succeeds or the attempts run out.
 * @target-type ssh
 */

// Two loop patterns come up all the time:
//
//   1. "Poll this device until it's ready" — use `poll(...)` (see 05-poll-for-prompt.js).
//   2. "Run this command, if it fails retry N times with backoff" — a plain
//      `while` + `try/catch` around `expect`, shown here.

await expect(/[$#] $/);

const maxAttempts = 5;
let attempt = 0;

while (attempt < maxAttempts) {
  attempt++;
  log.info(`attempt ${attempt}/${maxAttempts}`);

  await sendLine("ping -c 1 -W 2 8.8.8.8");

  try {
    // If ping times out the regex won't match — `expect` throws after its own timeout.
    const r = await expect(/(\d+)% packet loss/, { timeout: 5_000 });
    const loss = Number(r.groups[0]);
    if (loss === 0) {
      log.info("reachable");
      break;
    }
    log.warn(`packet loss=${loss}% — retrying`);
  } catch (err) {
    if (err.code === "Timeout") {
      log.warn("ping timed out — retrying");
    } else {
      // ConnectionLost or anything else — let it bubble so the run ends.
      throw err;
    }
  }

  // Exponential back-off between retries.
  await sleep(500 * attempt);
}

if (attempt === maxAttempts) {
  throw new Error("target unreachable after " + maxAttempts + " attempts");
}
