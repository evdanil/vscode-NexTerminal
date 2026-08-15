/**
 * @nexus-script
 * @name fs read invalid value
 * @description Asserts nexus.fs.readText rejects a BigInt / a cyclic-object
 * argument with a typed, REVIVED InvalidPath error (not UnknownError). Both
 * are structured-cloneable, so both genuinely cross the real worker RPC
 * boundary — this is the true round trip a bare JSON.stringify inside
 * scriptFsScope.ts/scriptFs.ts would break.
 */

try {
  await nexus.fs.readText(10n);
  throw new Error("readText(10n) should have thrown InvalidPath");
} catch (err) {
  if (err.code !== "InvalidPath") {
    throw new Error("expected code InvalidPath for a BigInt, got " + err.code);
  }
}

const cyclic = { name: "probe" };
cyclic.self = cyclic;
try {
  await nexus.fs.readText(cyclic);
  throw new Error("readText(cyclic) should have thrown InvalidPath");
} catch (err) {
  if (err.code !== "InvalidPath") {
    throw new Error("expected code InvalidPath for a cyclic object, got " + err.code);
  }
}
