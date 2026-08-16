const next = await nexus.include("./l5.js");
module.exports = { depth: next.depth + 1 };
