/**
 * @nexus-script
 * @name fs read invalid value
 * @description Asserts nexus.fs.readText rejects a BigInt / a cyclic object /
 * a Symbol / a function argument with a typed, REVIVED InvalidPath error (not
 * UnknownError, and not a raw DataCloneError). BigInt and the cyclic object
 * are structured-cloneable and cross the real worker RPC boundary unchanged
 * — this is the round trip a bare JSON.stringify inside
 * scriptFsScope.ts/scriptFs.ts would break. A Symbol and a function are NOT
 * structured-cloneable at all — postMessage would throw DataCloneError
 * synchronously without scriptWorker.ts's sanitizeFsPath() stand-in.
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

try {
  await nexus.fs.readText(Symbol("probe-path"));
  throw new Error("readText(Symbol(...)) should have thrown InvalidPath");
} catch (err) {
  if (err.code !== "InvalidPath") {
    throw new Error("expected code InvalidPath for a Symbol, got " + err.code);
  }
}

try {
  await nexus.fs.readText(function notAPath() {});
  throw new Error("readText(function) should have thrown InvalidPath");
} catch (err) {
  if (err.code !== "InvalidPath") {
    throw new Error("expected code InvalidPath for a function, got " + err.code);
  }
}

// A Proxy whose every trap throws: non-cloneable AND hostile to description.
// String(p) throws via the traps, and even Object.prototype.toString.call(p)
// throws (reading Symbol.toStringTag goes through the get trap) — the
// description chain's constant last resort is the only thing standing between
// this value and the trap's error escaping instead of the typed InvalidPath.
const hostileProxy = new Proxy(function () {}, {
  get() { throw new Error("trap"); },
  getPrototypeOf() { throw new Error("trap"); },
  apply() { throw new Error("trap"); }
});
try {
  await nexus.fs.readText(hostileProxy);
  throw new Error("readText(hostileProxy) should have thrown InvalidPath");
} catch (err) {
  if (err.code !== "InvalidPath") {
    throw new Error("expected code InvalidPath for a throwing Proxy, got " + (err && err.code));
  }
}
