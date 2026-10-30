const fs = require("node:fs");
if (process.argv[3] === "ignore-term") process.on("SIGTERM", () => {});
fs.appendFileSync(process.argv[2], `${process.pid}\n`);
setInterval(() => {}, 1000);
process.send?.("ready");
