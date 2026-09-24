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

// Get a fresh prompt first — the one already on screen was printed before the
// script started, so the script can't see it (see 01-hello.js).
await sendLine("");
await expect(/[$#] $/);

const maxAttempts = 5;
let attempt = 0;
let reachable = false;

while (attempt < maxAttempts) {
  attempt++;
  log.info(`attempt ${attempt}/${maxAttempts}`);

  // Linux `ping` flags: `-W` is in seconds there (macOS takes milliseconds).
  await sendLine("ping -c 1 -W 2 8.8.8.8");

  try {
    // If ping times out the regex won't match — `expect` throws after its own timeout.
    const r = await expect(/(\d+)% packet loss/, { timeout: 5_000 });
    const loss = Number(r.groups[0]);
    if (loss === 0) {
      log.info("reachable");
      reachable = true;
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

  // Exponential back-off between retries: 0.5 s, 1 s, 2 s, 4 s.
  if (attempt < maxAttempts) {
    await sleep(500 * 2 ** (attempt - 1));
  }
}

if (!reachable) {
  throw new Error("target unreachable after " + maxAttempts + " attempts");
}
