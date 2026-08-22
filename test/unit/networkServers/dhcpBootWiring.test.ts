/**
 * @author kanekitakitos
 *
 * Verifies that the ZTP boot settings actually reach the `dhcp` library's
 * option resolver — the half the pure encoder tests cannot cover.
 *
 * Rather than assert on the shape of our own `ServerConfig` (which would only
 * restate the implementation), each case feeds that config to a real
 * `dhcp.Server` and drives `_getOptions` — the exact function `sendOffer` and
 * `sendAck` call to decide which options go into the reply — with a stubbed
 * request. What is asserted is therefore the library's own answer to "what
 * would you put in the OFFER", keyed by option number.
 *
 * No socket is bound: `createServer` only allocates a dgram handle, which each
 * case closes again.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as dhcp from "dhcp";
import { DhcpEngine } from "../../../src/services/networkServers/dhcp/engine/DhcpEngine";
import type { DhcpEngineConfig } from "../../../src/services/networkServers/dhcp/engine/DhcpEngine";

const BASE: DhcpEngineConfig = {
  rangeStart: "172.28.1.10",
  rangeEnd: "172.28.1.20",
  subnet: "255.255.255.0",
  gateway: "172.28.1.1",
  serverId: "172.28.1.1"
};

const openSockets: Array<{ close: () => void }> = [];

afterEach(() => {
  while (openSockets.length > 0) {
    try {
      openSockets.pop()?.close();
    } catch {
      /* already closed */
    }
  }
});

/**
 * Resolves the options the library would send, given the engine config under
 * test and the option 60 a client claimed.
 *
 * `requestedParameters` is the client's option 55 list; passing `undefined`
 * models the common case of hardware that asks for nothing in particular,
 * which is precisely where `forceOptions` has to do the work.
 */
function resolveOfferedOptions(
  cfg: DhcpEngineConfig,
  vendorClassId?: string,
  requestedParameters?: number[]
): Record<number, unknown> {
  const engine = new DhcpEngine(cfg, () => undefined);
  const serverConfig = (engine as any).buildServerConfig();
  const server: any = dhcp.createServer(serverConfig);
  openSockets.push(server._sock);
  server._req = { options: vendorClassId === undefined ? {} : { 60: vendorClassId } };
  return server._getOptions({}, [], requestedParameters);
}

/**
 * Runs the dependency's real OFFER formatter and extracts one raw TLV option.
 * A change that reintroduces `dns: []` makes option 6's length byte zero.
 */
function formattedOfferOption(cfg: DhcpEngineConfig, optionCode: number): Buffer | undefined {
  const engine = new DhcpEngine(cfg, () => undefined);
  const serverConfig = (engine as any).buildServerConfig();
  const server: any = dhcp.createServer(serverConfig);
  openSockets.push(server._sock);
  let packet: Buffer | undefined;
  server._sock.send = (data: Buffer, offset: number, length: number, _port: number, _host: string, callback: (error: Error | null, bytes: number) => void) => {
    packet = Buffer.from(data.subarray(offset, offset + length));
    callback(null, length);
  };
  server.sendOffer({
    xid: 0x12345678,
    flags: 0,
    ciaddr: "0.0.0.0",
    giaddr: "0.0.0.0",
    chaddr: "AA-BB-CC-DD-EE-FF",
    options: {},
  });
  if (!packet) throw new Error("DHCP dependency did not format an OFFER");

  for (let offset = 240; offset < packet.length;) {
    const code = packet[offset++];
    if (code === 255) return undefined;
    if (code === 0) continue;
    const length = packet[offset++];
    const value = packet.subarray(offset, offset + length);
    if (code === optionCode) return value;
    offset += length;
  }
  return undefined;
}

describe("DHCP boot options — wiring into the `dhcp` library", () => {
  it("formats a non-empty option 6 DNS payload into a real OFFER", () => {
    expect([...formattedOfferOption({ ...BASE, dns: ["1.1.1.1", "8.8.8.8"] }, 6) ?? []]).toEqual([
      1, 1, 1, 1,
      8, 8, 8, 8,
    ]);
  });

  it("sends 66/67/150/43 unsolicited, without the client requesting them", () => {
    const offered = resolveOfferedOptions({
      ...BASE,
      nextServer: "172.28.1.1",
      bootFileName: "ios-image.bin",
      tftpServerAddresses: ["172.28.1.1", "172.28.1.2"],
      vendorSpecificOptions: [{ subOption: 241, value: "0x0A0B" }]
    });

    expect(offered[66], "option 66 — TFTP server name").toBe("172.28.1.1");
    expect(offered[67], "option 67 — bootfile name").toBe("ios-image.bin");
    expect(offered[150], "option 150 — Cisco TFTP servers").toEqual(["172.28.1.1", "172.28.1.2"]);
    expect(offered[43], "option 43 — TLV bytes").toEqual([241, 2, 0x0a, 0x0b]);
  });

  it("offers nothing extra when no boot option is configured", () => {
    const offered = resolveOfferedOptions(BASE);
    expect(offered[66]).toBeUndefined();
    expect(offered[67]).toBeUndefined();
    expect(offered[43]).toBeUndefined();
  });

  it("resolves a client's request for option 150 instead of erroring on it", () => {
    // Unregistered options make the library emit an `error` event, which the
    // adapter escalates to a failed service — and Cisco gear does ask for 150.
    const offered = resolveOfferedOptions(BASE, undefined, [150]);
    expect(offered[150]).toBeUndefined();
  });

  it("withholds every boot option from a client whose option 60 does not match", () => {
    const cfg: DhcpEngineConfig = {
      ...BASE,
      vendorClassId: "ArubaInstantAP",
      nextServer: "172.28.1.1",
      bootFileName: "aruba.cfg",
      tftpServerAddresses: ["172.28.1.1"],
      vendorSpecificOptions: [{ subOption: 1, value: "172.28.1.1" }]
    };

    const matched = resolveOfferedOptions(cfg, "arubainstantap");
    expect(matched[66]).toBe("172.28.1.1");
    expect(matched[67]).toBe("aruba.cfg");
    expect(matched[150]).toEqual(["172.28.1.1"]);
    expect(matched[43]).toEqual([1, 10, ...Buffer.from("172.28.1.1", "utf8")]);

    // `null`, not `undefined`/`0` — the sentinel the option writer skips.
    const other = resolveOfferedOptions(cfg, "Cisco Systems, Inc.");
    expect(other[66]).toBeNull();
    expect(other[67]).toBeNull();
    expect(other[150]).toBeNull();
    expect(other[43]).toBeNull();

    const silent = resolveOfferedOptions(cfg);
    expect(silent[66]).toBeNull();
  });

  it("fails closed for an explicit blank vendor filter supplied to the engine directly", () => {
    const offered = resolveOfferedOptions({
      ...BASE,
      // Strict daemon/RPC ingress rejects this. Direct construction must not
      // erase it into the unrestricted `undefined` configuration.
      vendorClassId: " \t ",
      nextServer: "172.28.1.1",
      bootFileName: "restricted.cfg",
      tftpServerAddresses: ["172.28.1.1"],
      vendorSpecificOptions: [{ subOption: 1, value: "172.28.1.1" }]
    }, "PXEClient");

    expect(offered[66]).toBeNull();
    expect(offered[67]).toBeNull();
    expect(offered[150]).toBeNull();
    expect(offered[43]).toBeNull();
  });

  it("drops an unencodable option 43 without disturbing the other boot options", () => {
    const offered = resolveOfferedOptions({
      ...BASE,
      bootFileName: "ios-image.bin",
      vendorSpecificOptions: [{ subOption: 1, value: "0xNOTHEX" }]
    });
    expect(offered[67]).toBe("ios-image.bin");
    expect(offered[43]).toBeUndefined();
  });
});
