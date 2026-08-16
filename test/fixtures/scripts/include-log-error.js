/**
 * @nexus-script
 * @name log.error(err) renders the error
 */

const thrower = await nexus.include("./include-lib/thrower.js");
try {
  thrower.boom();
} catch (err) {
  log.error(err);
}
