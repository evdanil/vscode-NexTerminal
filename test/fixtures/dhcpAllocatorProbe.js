/** @author kanekitakitos */

"use strict";

const dhcp = require("dhcp");

const OCCUPIED_MAC = "AA-BB-CC-00-00-01";
const REQUESTING_MAC = "AA-BB-CC-00-00-02";
const OCCUPIED_ADDRESS = "192.0.2.10";
const mode = process.env.DHCP_ALLOCATOR_PROBE_MODE || "select-exhausted";
const range = mode === "select-oversized"
  ? ["0.0.0.0", "255.255.255.255"]
  : mode === "select-cap-boundary"
    ? ["192.0.0.0", "192.0.255.255"]
    : [OCCUPIED_ADDRESS, OCCUPIED_ADDRESS];

const server = dhcp.createServer({
  range,
  randomIP: mode !== "select-cap-boundary",
  static: {},
  server: "192.0.2.1",
  leaseTime: 3600
});

server._state[OCCUPIED_MAC] = {
  address: OCCUPIED_ADDRESS,
  bindTime: new Date(),
  leasePeriod: 3600,
  state: "BOUND"
};

const request = {
  chaddr: REQUESTING_MAC,
  ciaddr: "0.0.0.0",
  options: {}
};

// This process is disposable. Making every candidate look occupied turns a
// missing oversized-range guard into a deadline-bounded scan, so the parent
// can prove both the early return and the unconditional SIGKILL/reap path.
if (mode === "select-oversized") {
  Set.prototype.has = () => true;
}

let value;
if (mode === "select-exhausted") {
  value = server._selectAddress(REQUESTING_MAC, request);
} else if (mode === "select-oversized") {
  value = server._selectAddress(REQUESTING_MAC, request);
} else if (mode === "select-cap-boundary") {
  const tooWide = dhcp.createServer({
    range: ["192.0.0.0", "192.1.0.0"],
    randomIP: false,
    static: {},
    server: "198.51.100.1",
    leaseTime: 3600
  });
  value = {
    max: server._selectAddress(REQUESTING_MAC, request),
    over: tooWide._selectAddress(REQUESTING_MAC, request)
  };
} else if (mode === "discover-exhausted") {
  let offers = 0;
  const exhausted = [];
  server.sendOffer = () => {
    offers++;
  };
  server.on("poolExhausted", (req) => exhausted.push(req.chaddr));

  server.handleDiscover(request);
  value = {
    offers,
    exhausted,
    stateHasClient: Object.prototype.hasOwnProperty.call(server._state, REQUESTING_MAC)
  };
} else if (mode === "request-exhausted") {
  let acks = 0;
  const exhausted = [];
  server.sendAck = () => {
    acks++;
  };
  server.on("poolExhausted", (req) => exhausted.push(req.chaddr));

  server.handleRequest(request);
  value = {
    acks,
    exhausted,
    stateHasClient: Object.prototype.hasOwnProperty.call(server._state, REQUESTING_MAC)
  };
} else {
  throw new Error(`Unknown DHCP allocator probe mode: ${mode}`);
}

if (process.send) {
  process.send({ type: "result", value });
}
