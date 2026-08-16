/**
 * @nexus-script
 * @name a library throw, uncaught
 */

const thrower = await nexus.include("./include-lib/thrower.js");
thrower.boom();
