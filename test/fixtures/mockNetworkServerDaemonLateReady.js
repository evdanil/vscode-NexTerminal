/**
 * A network-servers daemon that announces readiness far too late — after the
 * host has already given up on it.
 *
 * Used to prove the abandoned child cannot still speak to the bridge: if its
 * stdout stays wired up, this `ready` marks the host ready (and resolves
 * waiters that belong to a completely different child) long after the spawn
 * that produced it failed.
 */
const delayMs = Number(process.env.NEXUS_MOCK_READY_DELAY_MS || 2000);
process.stdin.resume();
setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ event: "ready", data: null })}\n`);
}, delayMs);
setInterval(() => {}, 60_000);
