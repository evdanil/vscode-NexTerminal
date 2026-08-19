/**
 * @nexus-script
 * @name fs read too large
 * @description Asserts a FileTooLarge error carries sizeBytes/maxBytes as
 * TOP-LEVEL properties (not nested under .extra) after round-tripping through
 * the worker/main-thread RPC boundary and reviveError.
 */

try {
  await nexus.fs.readText("./fs-toolarge.bin");
  throw new Error("readText should have refused a file over the 4 MiB cap");
} catch (err) {
  if (err.code !== "FileTooLarge") {
    throw new Error("expected code FileTooLarge, got " + err.code);
  }
  if (typeof err.sizeBytes !== "number" || typeof err.maxBytes !== "number") {
    throw new Error(
      "expected top-level sizeBytes/maxBytes numbers, got sizeBytes=" +
        JSON.stringify(err.sizeBytes) +
        " maxBytes=" +
        JSON.stringify(err.maxBytes) +
        " extra=" +
        JSON.stringify(err.extra)
    );
  }
  if (err.maxBytes !== 4 * 1024 * 1024) {
    throw new Error("unexpected maxBytes: " + err.maxBytes);
  }
  if (err.sizeBytes !== 4 * 1024 * 1024 + 1) {
    throw new Error("unexpected sizeBytes: " + err.sizeBytes);
  }
}
