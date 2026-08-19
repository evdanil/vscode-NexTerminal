/**
 * @nexus-script
 * @name fs read ok
 * @description Happy-path nexus.fs fixture — readText, readJson, and exists
 * all resolved against this script's own directory (fs-data/ is a sibling).
 */

const text = await nexus.fs.readText("./fs-data/config.json");
if (!text.includes("from-fixture")) {
  throw new Error("readText did not return the fixture content: " + text);
}

const value = await nexus.fs.readJson("./fs-data/config.json");
if (value.key !== "from-fixture") {
  throw new Error("readJson mismatch: " + JSON.stringify(value));
}

const hasConfig = await nexus.fs.exists("./fs-data/config.json");
if (hasConfig !== true) {
  throw new Error("exists() should be true for fs-data/config.json");
}

const hasMissing = await nexus.fs.exists("./fs-data/missing.json");
if (hasMissing !== false) {
  throw new Error("exists() should be false for fs-data/missing.json");
}
