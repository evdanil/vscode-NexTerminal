/**
 * @nexus-script
 * @name 07 — Complete procedure (everything together)
 * @description Canonical multi-step example — capture config, validate image, install, reboot, verify.
 * @target-type serial
 * @target-profile lab-router-a
 * @default-timeout 30s
 * @allow-macros hostname-prompt
 */

// This example walks through a realistic router procedure to demonstrate how the
// API primitives fit together. Adapt the prompts/commands to your device family.
//
// Note: `@allow-macros hostname-prompt` assumes a macro named "hostname-prompt"
// exists in your workspace — replace or remove this line if you don't have one.
// The header is just a declarative allow-list; an unknown name is a no-op.
//
// Key patterns:
//   - try/catch around every expect for graceful failure handling
//   - waitAny to disambiguate devices with multiple prompt styles
//   - poll for device reboots where a plain expect would time out
//   - macros.disableAll() to suspend unrelated password/hostname macros
//     that might fire on our input (the runtime auto-restores on exit,
//     so no finally-block cleanup is needed)
//   - `session` metadata so the same script can behave differently on
//     production vs. lab devices
//
// `@allow-macros hostname-prompt` lets the "expect hostname → send hostname"
// macro keep firing during the run while suspending everything else.

log.info(`procedure starting on ${session.name} (${session.type})`);

// Suspend any macros the default policy didn't catch.
macros.disableAll();

try {
  // 1. Wake the console and capture the running configuration.
  await poll({ send: "\r", until: /[>#] $/, every: 1_000, timeout: 15_000 });
  await sendLine("enable");
  const auth = await waitAny([/Password:\s*$/i, /# $/], { timeout: 5_000 });
  if (auth.index === 0) {
    await sendLine(await prompt("Enable password", { password: true }));
    await expect(/# $/);
  }
  await sendLine("terminal length 0");
  await expect(/# $/);
  await sendLine("show running-config");
  const cfg = await expect(/# $/, { timeout: 60_000 });
  log.info(`captured ${cfg.before.split("\n").length} lines of running-config`);

  // 2. Check what IOS images are on flash.
  await sendLine("dir usbflash0:");
  const dir = await expect(/# $/);
  const imageMatch = dir.before.match(/(\S+\.bin)/);
  if (!imageMatch) {
    await alert("No image found on usbflash0. Insert a USB stick with the image and click OK.");
    await sendLine("dir usbflash0:");
    const dir2 = await expect(/# $/);
    const imageMatch2 = dir2.before.match(/(\S+\.bin)/);
    if (!imageMatch2) throw new Error("no image on usbflash0 after re-insert");
  }
  const image = (imageMatch || dir.before.match(/(\S+\.bin)/))[1];
  log.info("using image:", image);

  // 3. Confirm before destructive action.
  if (!(await confirm(`Install ${image}? The device will reboot.`))) {
    log.info("user declined");
  } else {
    // 4. Kick off the install and wait through the reboot.
    await sendLine(`install add file usbflash0:${image} activate commit`);
    await poll({
      send: "",
      until: /Press RETURN to get started/i,
      every: 5_000,
      timeout: 15 * 60_000   // install + reboot can take 15 minutes
    });
    log.info("device rebooted onto new image");

    // 5. Verify.
    await sendLine("");
    await expect(/[>#] $/, { timeout: 30_000 });
    await sendLine("show version | include IOS XE Software");
    const ver = await expect(/[>#] $/);
    log.info("running version:", ver.before.trim());
    await alert("Downgrade complete. Verify the version string above.");
  }
} catch (err) {
  // Report whichever failure mode fired. Include a tail of recent output for
  // Timeout cases so the log actually shows what the device said last.
  if (err.code === "Timeout") {
    log.error(`timeout waiting for ${err.pattern} after ${err.elapsedMs}ms`);
    log.error("recent output:", await tail(1024));
  } else if (err.code === "ConnectionLost") {
    log.error("lost the session mid-procedure — manual intervention required");
  } else {
    log.error("procedure failed:", err.message);
  }
  throw err;
}
// No `finally { macros.restore() }` — the runtime auto-restores macros and
// releases the input lock on every exit path (success, stop, crash, ConnectionLost).
