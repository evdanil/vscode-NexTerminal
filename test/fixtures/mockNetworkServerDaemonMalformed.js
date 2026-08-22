/**
 * Deliberately hostile daemon peer for host-boundary integration tests.
 *
 * Each mode sends one invalid stdout message followed by a valid-looking
 * message. A correct host must stop at the first protocol violation, so the
 * later line cannot reach a listener or settle a request.
 */
const mode = process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE || "clean";

const listResult = [
  { id: "tftp", name: "TFTP", port: 69, status: "stopped" },
  { id: "dhcp", name: "DHCP", port: 67, status: "stopped" },
];

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sendValidReply(id) {
  send({ id, result: listResult });
}

function sendInvalidThenValid(id, invalid) {
  if (typeof invalid === "string") process.stdout.write(`${invalid}\n`);
  else send(invalid);
  sendValidReply(id);
}

if (mode === "malformed-ready") {
  send({ event: "ready", data: {} });
  setTimeout(() => send({ event: "ready", data: null }), 20);
} else {
  send({ event: "ready", data: null });
}

if (mode === "exit-cleanly") {
  setTimeout(() => process.exit(0), 20);
}

let requestCount = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    requestCount += 1;
    const id = request.id;
    switch (mode) {
      case "invalid-json":
        sendInvalidThenValid(id, '{"event":"statusChange","data":');
        break;
      case "oversized-stdout":
        // Envelopes intentionally defer method-specific validation until the
        // host finds a pending id. This is a well-formed unknown envelope,
        // but its serialized line is larger than the transport byte cap.
        send({ id: id + 9_999, result: "x".repeat(1_048_576) });
        sendValidReply(id);
        break;
      case "null-status-event":
        sendInvalidThenValid(id, { event: "statusChange", data: null });
        break;
      case "invalid-connection":
        sendInvalidThenValid(id, {
          event: "connection",
          data: { id: "tftp", connection: { phase: "impossible", summary: "bad" } },
        });
        break;
      case "unknown-event":
        sendInvalidThenValid(id, { event: "madeUp", data: null });
        break;
      case "result-and-error":
        sendInvalidThenValid(id, {
          id,
          result: listResult,
          error: { code: "NOPE", message: "both branches" },
        });
        break;
      case "wrong-result":
        sendInvalidThenValid(id, { id, result: { ok: true, id: "tftp" } });
        break;
      case "stdout-eof":
        process.stdout.end();
        break;
      case "duplicate-unknown":
        sendValidReply(id);
        if (requestCount === 1) {
          sendValidReply(id);
          sendValidReply(id + 9_999);
        }
        break;
      default:
        sendValidReply(id);
        break;
    }
  }
});

process.stdin.resume();
setInterval(() => {}, 60_000);
