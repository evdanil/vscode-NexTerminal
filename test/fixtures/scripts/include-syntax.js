/**
 * @nexus-script
 * @name include a file that does not parse
 */

try {
  await nexus.include("./include-lib/broken.js");
  throw new Error("including a file that does not parse should have thrown");
} catch (err) {
  if (err.code !== "IncludeSyntaxError") {
    throw new Error("expected IncludeSyntaxError, got " + err.code + ": " + err.message);
  }
  if (!err.message.startsWith("Failed to compile include-lib/broken.js: ")) {
    throw new Error("the message must name the file it was compiling: " + err.message);
  }
}
