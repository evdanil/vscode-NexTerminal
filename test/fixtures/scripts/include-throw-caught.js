/**
 * @nexus-script
 * @name a library throw, caught
 */

const thrower = await nexus.include("./include-lib/thrower.js");
try {
  thrower.boom();
  throw new Error("thrower.boom() should have thrown");
} catch (err) {
  if (err.message !== "boom from the library") {
    throw new Error("the library's own error was not propagated unwrapped: " + err.message);
  }
  if (err.code !== undefined) {
    throw new Error("a module body's error must not be wrapped in an include code: " + err.code);
  }
  // A stack the SCRIPT reads out of the error object itself is not rewritten
  // (only the failure envelope and log.* are — see docs/scripting.md). What it
  // does carry, and what this pins, is the FILE: without the appended
  // //# sourceURL this frame reads `<anonymous>` and nothing identifies which
  // included file threw.
  if (!/include-lib\/thrower\.js:\d+:/.test(err.stack || "")) {
    throw new Error("the stack does not name the library file: " + err.stack);
  }
  // The runtime's own rendering of the same error DOES carry the true line —
  // scriptInclude.integration.test.ts asserts `thrower.js:7:` on this line.
  log.error(err);
}
