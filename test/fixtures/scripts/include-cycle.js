/**
 * @nexus-script
 * @name include cycle
 */

try {
  await nexus.include("./include-lib/cyc-a.js");
  throw new Error("a circular include should have thrown");
} catch (err) {
  if (err.code !== "CircularInclude") {
    throw new Error("expected CircularInclude, got " + err.code + ": " + err.message);
  }
  const rendered = (err.cycle || []).join(" → ");
  if (rendered !== "include-cycle.js → include-lib/cyc-a.js → include-lib/cyc-b.js → include-lib/cyc-a.js") {
    throw new Error("the cycle was not spelled out correctly: " + rendered);
  }
  if (!err.message.includes(rendered)) {
    throw new Error("the message does not contain the cycle: " + err.message);
  }
}
