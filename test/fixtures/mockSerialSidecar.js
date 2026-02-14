const readline = require("node:readline");

function respond(id, result, error) {
  const payload = error ? { id, error: { message: error } } : { id, result };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const request = JSON.parse(line);

  if (request.method === "listPorts") {
    respond(request.id, [{ path: "COM9", manufacturer: "Mock" }]);
    return;
  }
  if (request.method === "openPort") {
    const { path } = request.params || {};
    if (path === "ERR") {
      respond(request.id, undefined, "failed to open mock serial port");
      return;
    }
    respond(request.id, { sessionId: "session-1" });
    notify("portData", { sessionId: "session-1", data: Buffer.from("ready").toString("base64") });
    return;
  }
  if (request.method === "writePort") {
    const { sessionId, data } = request.params || {};
    respond(request.id, { ok: true });
    notify("portData", { sessionId, data });
    return;
  }
  if (request.method === "closePort") {
    respond(request.id, { ok: true });
    notify("portError", { sessionId: request.params.sessionId, message: "closed" });
    return;
  }

  respond(request.id, undefined, `unknown method ${request.method}`);
});
