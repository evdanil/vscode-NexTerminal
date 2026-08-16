/**
 * @nexus-script
 * @name the entry script's own throw
 */

log.info("about to throw from the entry script");

throw new Error("thrown by the entry script itself");
