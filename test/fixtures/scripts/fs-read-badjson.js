/**
 * @nexus-script
 * @name fs read bad json
 * @description Asserts readJson() surfaces a worker-local SyntaxError with
 * code "InvalidJson" for a malformed fixture file — never a bare RPC failure.
 */

try {
  await nexus.fs.readJson("./fs-data/invalid.json");
  throw new Error("readJson should have thrown on malformed JSON");
} catch (err) {
  if (err.code !== "InvalidJson") {
    throw new Error("expected code InvalidJson, got " + err.code);
  }
  if (!(err instanceof SyntaxError)) {
    throw new Error("expected a SyntaxError instance");
  }
  if (!err.message.includes("invalid.json")) {
    throw new Error("expected the message to name the requested path: " + err.message);
  }
}
