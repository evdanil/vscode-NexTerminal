const next = await nexus.include("./l6.js");
module.exports = { depth: next.depth + 1 };
