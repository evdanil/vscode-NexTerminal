/**
 * @nexus-script
 * @name include a marked script
 */

try {
  await nexus.include("./include-lib/marked.js");
  throw new Error("including an @nexus-script file should have thrown");
} catch (err) {
  if (err.code !== "IncludeIsScript") {
    throw new Error("expected IncludeIsScript, got " + err.code + ": " + err.message);
  }
  if (err.module !== "include-lib/marked.js") {
    throw new Error("the refusal must name the module: " + JSON.stringify(err.module));
  }
}
