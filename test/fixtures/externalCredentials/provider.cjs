const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const [mode, control] = process.argv.slice(2);
fs.appendFileSync(control, `${process.pid}\n`);
const valid = () => process.stdout.write(JSON.stringify({ version: 1, username: "fixture", password: "synthetic-value" }));
switch (mode) {
  case "valid": valid(); break;
  case "malformed": process.stdout.write("{invalid"); break;
  case "large-stdout": process.stdout.write(Buffer.alloc(262145, 65)); break;
  case "large-stderr": process.stderr.write(Buffer.alloc(65537, 65)); break;
  case "nonzero": process.stderr.write("SECRET_CANARY"); process.exitCode = 7; break;
  case "delayed": setTimeout(valid, 150); break;
  case "hang": setInterval(() => {}, 1000); break;
  case "waiting":
  case "inherited":
  case "escaped": {
    const descendant = spawn(process.execPath, [path.join(__dirname, "descendant.cjs"), control], {
      stdio: ["ignore", "inherit", "inherit"], detached: mode === "escaped", windowsHide: true
    });
    if (mode === "waiting") setInterval(() => {}, 1000);
    else { descendant.unref(); valid(); setTimeout(() => process.exit(0), 100); }
    break;
  }
  default: process.exitCode = 2;
}
