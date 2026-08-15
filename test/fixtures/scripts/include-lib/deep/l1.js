const next = await nexus.include("./l2.js");
module.exports = { depth: next.depth + 1 };
