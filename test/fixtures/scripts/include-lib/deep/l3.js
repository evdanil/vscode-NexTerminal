const next = await nexus.include("./l4.js");
module.exports = { depth: next.depth + 1 };
