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

const tftpRuntime = {
  snapshot: listResult[0],
  transfers: [],
  root: "/tmp/tftp",
  allowWrite: false,
  boundPort: 69,
};

const dhcpRuntime = {
  snapshot: listResult[1],
  leases: [],
  packetCounters: {
    packetsReceived: 0,
    packetsSentEstimate: 0,
    discoverCount: 0,
    offerCount: 0,
    requestCount: 0,
    declineCount: 0,
    ackCount: 0,
    nakCount: 0,
    releaseCount: 0,
    informCount: 0,
  },
  poolInfo: {
    rangeStart: "192.168.2.10",
    rangeEnd: "192.168.2.199",
    poolSize: 190,
    activeCount: 0,
    utilizationPct: 0,
    staticEntryCount: 0,
  },
  boundPort: null,
};

function resultFor(request) {
  switch (request.method) {
    case "list": return listResult;
    case "getStatus": return request.params.id === "tftp" ? listResult[0] : listResult[1];
    case "configure": return { ok: true, changed: Object.keys(request.params.configs) };
    case "start":
    case "stop":
    case "restart": return { ok: true, id: request.params.id };
    case "cancelTransfer": return { ok: true, id: "tftp", transferId: request.params.transferId };
    case "getServiceRuntime": return request.params.id === "tftp" ? tftpRuntime : dhcpRuntime;
    default: return listResult;
  }
}

function sendValidReply(id, request = { method: "list" }) {
  send({ id, result: resultFor(request) });
}

function sendInvalidThenValid(id, invalid, request) {
  if (typeof invalid === "string") process.stdout.write(`${invalid}\n`);
  else send(invalid);
  sendValidReply(id, request);
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

if (mode === "stdout-eof-delayed-exit") {
  setTimeout(() => {
    process.stdout.end();
    setTimeout(() => process.exit(0), 125);
  }, 20);
}

if (mode === "late-stdio") {
  // Keeps the exact terminate-to-close interval open for the host's terminal
  // stream-ownership regression. The test performs its own final reap.
  process.on("SIGTERM", () => undefined);
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
        sendInvalidThenValid(id, '{"event":"statusChange","data":', request);
        break;
      case "oversized-stdout":
        // Envelopes intentionally defer method-specific validation until the
        // host finds a pending id. This is a well-formed unknown envelope,
        // but its serialized line is larger than the transport byte cap.
        send({ id: id + 9_999, result: "x".repeat(1_048_576) });
        sendValidReply(id);
        break;
      case "null-status-event":
        sendInvalidThenValid(id, { event: "statusChange", data: null }, request);
        break;
      case "invalid-connection":
        sendInvalidThenValid(id, {
          event: "connection",
          data: { id: "tftp", connection: { phase: "impossible", summary: "bad" } },
        }, request);
        break;
      case "unknown-event":
        sendInvalidThenValid(id, { event: "madeUp", data: null }, request);
        break;
      case "result-and-error":
        sendInvalidThenValid(id, {
          id,
          result: listResult,
          error: { code: "NOPE", message: "both branches" },
        }, request);
        break;
      case "wrong-result":
        sendInvalidThenValid(id, { id, result: { ok: true, id: "tftp" } }, request);
        break;
      case "wrong-get-status":
        send({ id, result: request.params.id === "tftp" ? listResult[1] : listResult[0] });
        break;
      case "wrong-runtime":
        send({ id, result: request.params.id === "tftp" ? dhcpRuntime : tftpRuntime });
        break;
      case "wrong-lifecycle":
        send({ id, result: { ok: true, id: request.params.id === "tftp" ? "dhcp" : "tftp" } });
        break;
      case "wrong-cancel":
        send({ id, result: { ok: true, id: "tftp", transferId: `${request.params.transferId}-wrong` } });
        break;
      case "wrong-configure":
        send({ id, result: { ok: true, changed: ["dhcp"] } });
        break;
      case "wrong-list":
        send({ id, result: [listResult[0]] });
        break;
      case "stdin-terminal":
        process.stdin.destroy();
        break;
      case "hold-first-list":
        if (requestCount > 1) sendValidReply(id, request);
        break;
      case "hold-all-list":
        break;
      case "late-stdio":
        // Hold a real host write pending until the test has torn its
        // generation down and delivers the buffered terminal callback/error.
        break;
      case "stdout-eof":
        process.stdout.end();
        break;
      case "duplicate-unknown":
        sendValidReply(id, request);
        if (requestCount === 1) {
          sendValidReply(id, request);
          sendValidReply(id + 9_999, request);
        }
        break;
      default:
        sendValidReply(id, request);
        break;
    }
  }
});

process.stdin.resume();
setInterval(() => {}, 60_000);
