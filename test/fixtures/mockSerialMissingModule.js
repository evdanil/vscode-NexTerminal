const readline = require("node:readline");

function respond(id, result, error) {
  const payload = error ? { id, error: { message: error } } : { id, result };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const request = JSON.parse(line);
  if (request.method === "listPorts" || request.method === "openPort") {
    respond(request.id, undefined, "serialport module not installed");
    return;
  }
  if (request.method === "closePort" || request.method === "writePort") {
    respond(request.id, { ok: true });
    return;
  }
  respond(request.id, undefined, `unknown method ${request.method}`);
});
