/**
 * First generation: records its pid, ignores SIGTERM, and never announces
 * readiness. Later generations from the same fixture record their pids and
 * behave like a clean, ready daemon. The PID/signal files let the integration
 * test coordinate with real process state without adding host test hooks.
 */
const fs = require("node:fs");

const pidFile = process.env.NEXUS_MOCK_NETWORK_DAEMON_PID_FILE;
const signalFile = process.env.NEXUS_MOCK_NETWORK_DAEMON_SIGNAL_FILE;
if (!pidFile) throw new Error("NEXUS_MOCK_NETWORK_DAEMON_PID_FILE is required");

const isFirstGeneration = !fs.existsSync(pidFile);
fs.appendFileSync(pidFile, `${process.pid}\n`);
process.stdin.resume();

if (isFirstGeneration) {
  process.on("SIGTERM", () => {
    if (signalFile) fs.appendFileSync(signalFile, `SIGTERM:${process.pid}\n`);
  });
} else {
  process.stdout.write(`${JSON.stringify({ event: "ready", data: null })}\n`);
}

setInterval(() => {}, 60_000);
