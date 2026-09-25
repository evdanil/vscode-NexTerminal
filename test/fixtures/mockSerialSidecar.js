const readline = require("node:readline");
const sessions = new Set();

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
    const { path, sessionId = "session-1" } = request.params || {};
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      respond(request.id, undefined, "invalid serial session ID");
      return;
    }
    if (sessions.has(sessionId)) {
      respond(request.id, undefined, "serial session ID is already in use");
      return;
    }
    if (path === "ERR") {
      respond(request.id, undefined, "failed to open mock serial port");
      return;
    }
    sessions.add(sessionId);
    notify("portData", { sessionId, data: Buffer.from("ready").toString("base64") });
    respond(request.id, { sessionId });
    return;
  }
  if (request.method === "writePort") {
    const { sessionId, data } = request.params || {};
    respond(request.id, { ok: true });
    notify("portData", { sessionId, data });
    return;
  }
  if (request.method === "sendBreak") {
    respond(request.id, { ok: true });
    return;
  }
  if (request.method === "closePort") {
    sessions.delete(request.params.sessionId);
    respond(request.id, { ok: true });
    notify("portDisconnected", { sessionId: request.params.sessionId, reason: "Port closed" });
    return;
  }

  respond(request.id, undefined, `unknown method ${request.method}`);
});
