/**
 * @nexus-script
 * @name include happy path
 * @description Every documented nexus.include() behaviour, asserted by the
 * fixture itself: a completed run IS the assertion.
 */

// --- exports.* form, plus module-relative nexus.fs and a nested sibling include
const greet = await nexus.include("./include-lib/greet.js");
if (greet.hello("admin") !== "hello admin") {
  throw new Error("exports.* form did not survive the include: " + JSON.stringify(greet));
}
if (greet.template !== "LIB-TEMPLATE") {
  throw new Error(
    "a library's nexus.fs must resolve against ITS OWN folder, got: " + JSON.stringify(greet.template)
  );
}
if (greet.innerValue !== "inner-42") {
  throw new Error("a sibling include inside a library failed: " + JSON.stringify(greet.innerValue));
}

// --- the entry script's own relative paths still resolve against ITS folder
const entryTemplate = await nexus.fs.readText("./template.txt");
if (entryTemplate !== "ENTRY-TEMPLATE") {
  throw new Error("the entry script's own nexus.fs moved: " + JSON.stringify(entryTemplate));
}

// --- identity: one module, one exports object, one execution per run
const greetAgain = await nexus.include("./include-lib/greet.js");
if (greetAgain !== greet) {
  throw new Error("a second include returned a different exports object");
}
const [c1, c2] = await Promise.all([
  nexus.include("./include-lib/inner.js"),
  nexus.include("./include-lib/inner.js")
]);
if (c1 !== c2 || c1.value !== "inner-42") {
  throw new Error("concurrent includes did not share one module");
}

// --- bare-return form
const ret = await nexus.include("./include-lib/ret.js");
if (ret.kind !== "returned" || ret.backoff(21) !== 42) {
  throw new Error("bare-return form was ignored: " + JSON.stringify(ret));
}

// --- exports beats a returned value
const both = await nexus.include("./include-lib/both.js");
if (both.fromExports !== true || both.fromReturn !== undefined) {
  throw new Error("exports precedence is wrong: " + JSON.stringify(both));
}

// --- 6 levels of nesting: deeper than the 4-permit read pool, so an
// implementation holding a read permit across module evaluation deadlocks here.
const deep = await nexus.include("./include-lib/deep/l1.js");
if (deep.depth !== 6) {
  throw new Error("nested include chain did not reach the bottom: " + JSON.stringify(deep));
}

log.info("include-happy: all assertions passed");
