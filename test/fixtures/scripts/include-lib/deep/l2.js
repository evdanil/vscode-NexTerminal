const next = await nexus.include("./l3.js");
module.exports = { depth: next.depth + 1 };
