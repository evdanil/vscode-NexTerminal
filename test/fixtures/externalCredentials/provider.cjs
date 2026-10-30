const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const [mode, control] = process.argv.slice(2);
fs.appendFileSync(control, `${process.pid}\n`);
const valid = (done) => process.stdout.write(JSON.stringify({ version: 1, username: "fixture", password: "synthetic-value" }), done);
switch (mode) {
  case "valid": valid(); break;
  case "malformed": process.stdout.write("{invalid"); break;
  case "large-stdout": process.stdout.write(Buffer.alloc(262145, 65)); break;
  case "large-stderr": process.stderr.write(Buffer.alloc(65537, 65)); break;
  case "nonzero": process.stderr.write("SECRET_CANARY"); process.exitCode = 7; break;
  case "delayed": setTimeout(valid, 150); break;
  case "cancel-ready": process.stderr.write("ready"); setInterval(() => {}, 1000); break;
  case "hang": setInterval(() => {}, 1000); break;
  case "waiting":
  case "inherited":
  case "escaped": {
    const descendant = spawn(process.execPath, [path.join(__dirname, "descendant.cjs"), control], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      // Windows libuv kills non-detached children when their parent exits. Detach
      // this fixture there so it actually retains pipes; POSIX keeps its owned group.
      detached: mode === "escaped" || (mode === "inherited" && process.platform === "win32"), windowsHide: true
    });
    descendant.once("message", () => {
      descendant.disconnect();
      if (mode !== "waiting") { descendant.unref(); valid(() => process.exit(0)); }
    });
    if (mode === "waiting") setInterval(() => {}, 1000);
    break;
  }
  default: process.exitCode = 2;
}
