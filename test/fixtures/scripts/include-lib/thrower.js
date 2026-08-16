/*
 * Throws from a KNOWN line — the `throw` below is on line 7, and the
 * integration tests assert `thrower.js:7:` appears in the attributed stack.
 */

exports.boom = () => {
  throw new Error("boom from the library");
};
