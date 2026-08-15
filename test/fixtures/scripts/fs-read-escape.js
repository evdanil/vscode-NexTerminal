/**
 * @nexus-script
 * @name fs read escape
 * @description Asserts a traversal attempt is refused with PathOutsideScope
 * and is catchable script-side — containment errors must reject the RPC
 * promise, never crash the worker.
 */

try {
  await nexus.fs.readText("../../../../../../etc/hostname");
  throw new Error("readText should have refused a path outside the scope");
} catch (err) {
  if (err.code !== "PathOutsideScope") {
    throw new Error("expected code PathOutsideScope, got " + err.code);
  }
}
