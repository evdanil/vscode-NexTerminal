/** @author kanekitakitos */

"use strict";

const dhcp = require("dhcp");

const OCCUPIED_MAC = "AA-BB-CC-00-00-01";
const REQUESTING_MAC = "AA-BB-CC-00-00-02";
const OCCUPIED_ADDRESS = "192.0.2.10";
const mode = process.env.DHCP_ALLOCATOR_PROBE_MODE || "select-exhausted";

const server = dhcp.createServer({
  range: [OCCUPIED_ADDRESS, OCCUPIED_ADDRESS],
  randomIP: true,
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

let value;
if (mode === "select-exhausted") {
  value = server._selectAddress(REQUESTING_MAC, request);
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
} else {
  throw new Error(`Unknown DHCP allocator probe mode: ${mode}`);
}

if (process.send) {
  process.send({ type: "result", value });
}
