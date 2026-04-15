/**
 * @nexus-script
 * @name 05 — Poll for prompt after reboot (poll primitive)
 * @description Keep sending carriage returns every 2 seconds until the login prompt comes back.
 * @target-type serial
 * @default-timeout 90s
 */

// `poll({ send, until, every, timeout })` is a specialized waiter for the case
// "this device is busy; send something periodically and watch for a specific
// prompt". Use it when a plain `expect` would time out before the device is
// ready — e.g. a router booting, a firmware install, an sleeping modem.
//
//   send    — text to send on each tick (string). For a custom action use a
//             function that writes via `send` / `sendLine` yourself.
//   until   — pattern that ends the poll loop.
//   every   — tick interval in milliseconds (minimum 50).
//   timeout — total wall-clock budget in milliseconds.

log.info("rebooting device");
await sendLine("reload");
await expect(/Proceed with reload/i);
await sendLine("");  // confirm

// Now the device is rebooting. Send a carriage return every 2 seconds and
// watch for the next login banner (but give the whole thing up to 90 seconds).
const r = await poll({
  send: "\r",
  until: /Press RETURN to get started/i,
  every: 2_000,
  timeout: 90_000
});
log.info("device is back:", r.text);

await sendLine("");
await expect(/Username:/i);
log.info("login prompt reached");
