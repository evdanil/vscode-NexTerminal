const fs = require("node:fs");
fs.appendFileSync(process.argv[2], `${process.pid}\n`);
setInterval(() => {}, 1000);
process.send?.("ready");
