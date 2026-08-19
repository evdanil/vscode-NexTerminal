/**
 * @author kanekitakitos
 *
 * Integration test for DHCP lease survival across a daemon restart.
 *
 * Everything here is real: a `DhcpEngine` bound to a loopback UDP port, DHCP
 * packets assembled byte by byte and sent over the wire, and a lease file in a
 * real temp directory. Only the network is scoped down (127.0.0.1, an
 * ephemeral port, an eleven-address pool).
 *
 * The scenario is the bug this stage exists to fix: a device takes a lease, the
 * daemon dies, and a *second* device asks for an address before the first
 * one's lease expires. With the table held only in memory the second device can
 * be handed the first one's address — two hosts, one IP, on the bench network.
 *
 * ## Why `Math.random` is stubbed
 *
 * `dhcp@0.2.20` defaults `randomIP` to `true` (options.js:535-540), so
 * `_selectAddress` picks a random free address rather than the lowest one.
 * Left alone, "the second device was offered a different address" would pass by
 * luck most of the time even with no persistence at all. Scripting the sequence
 * makes both worlds deterministic: the first candidate is always the address
 * the restored lease holds, so a working restore *must* reject it and move to
 * the second candidate, and a broken one *must* hand it out.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DhcpEngine } from "../../../src/services/networkServers/dhcp/engine/DhcpEngine";
import { loadLeases } from "../../../src/services/networkServers/dhcp/engine/dhcpLeasePersistence";

const CLIENT_A = "aa:bb:cc:00:00:0a";
const CLIENT_B = "aa:bb:cc:00:00:0b";
const RANGE_START = "10.0.0.10";
const RANGE_END = "10.0.0.20";
/** `Math.random()` values that map to the first two addresses of the pool. */
const PICK_FIRST = 0;
const PICK_SECOND = 0.15;

const cleanups: Array<() => void | Promise<void>> = [];
let scriptedPicks: number[] = [];
let pickIndex = 0;

/** Forces `_selectAddress`'s candidate sequence for the next allocations. */
function scriptAddressPicks(...values: number[]): void {
  scriptedPicks = values;
  pickIndex = 0;
  vi.spyOn(Math, "random").mockImplementation(
    () => scriptedPicks[Math.min(pickIndex++, scriptedPicks.length - 1)]
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      /* best effort */
    }
  }
  cleanups.length = 0;
});

/** Assembles a BOOTREQUEST the `dhcp` library's parser accepts (RFC 2131 layout). */
function buildRequest(messageType: 1 | 3, mac: string, xid: number): Buffer {
  const packet = Buffer.alloc(300);
  let offset = 0;
  packet.writeUInt8(1, offset++); // op: BOOTREQUEST
  packet.writeUInt8(1, offset++); // htype: ethernet
  packet.writeUInt8(6, offset++); // hlen
  packet.writeUInt8(0, offset++); // hops
  packet.writeUInt32BE(xid, offset);
  offset += 4;
  offset += 2; // secs
  offset += 2; // flags
  offset += 16; // ciaddr / yiaddr / siaddr / giaddr, all zero
  for (const octet of mac.split(":")) packet.writeUInt8(parseInt(octet, 16), offset++);
  offset += 10; // chaddr is a 16-byte field; 6 used
  offset += 64; // sname
  offset += 128; // file
  packet.writeUInt32BE(0x63825363, offset); // magic cookie
  offset += 4;
  packet.writeUInt8(53, offset++); // option 53: DHCP message type
  packet.writeUInt8(1, offset++);
  packet.writeUInt8(messageType, offset++);
  packet.writeUInt8(255, offset++); // end
  return packet.subarray(0, Math.max(offset, 240));
}

/** The key a MAC appears under in the library's lease table (seqbuffer.js:177). */
function stateKey(mac: string): string {
  return mac.toUpperCase().replace(/:/g, "-");
}

/** A UDP port nothing is listening on, obtained by briefly holding it. */
async function freePort(): Promise<number> {
  const probe = dgram.createSocket("udp4");
  const port = await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.bind(0, "127.0.0.1", () => resolve(probe.address().port));
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Absorbs the server's replies on the DHCP client port.
 *
 * Without a listener the OFFER/ACK draw an ICMP port-unreachable back at the
 * server socket, which Windows surfaces as an error on the next read. Tolerated
 * if the port is already taken — the test does not depend on the replies.
 */
function createReplySink(): Promise<() => Promise<void>> {
  const sink = dgram.createSocket({ type: "udp4", reuseAddr: true });
  return new Promise((resolve) => {
    const close = async (): Promise<void> => {
      await new Promise<void>((done) => sink.close(() => done()));
    };
    sink.once("error", () => resolve(async () => undefined));
    sink.bind(68, "127.0.0.1", () => resolve(close));
  });
}

function startEngine(port: number, leaseStorePath: string): DhcpEngine {
  const engine = new DhcpEngine(
    {
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
      subnet: "255.255.255.0",
      gateway: "10.0.0.1",
      serverId: "10.0.0.1",
      // Replies go to loopback rather than the subnet broadcast, so nothing
      // this test does reaches the real network.
      broadcast: "127.0.0.1",
      bindAddress: "127.0.0.1",
      leaseTimeSec: 3600,
      leaseStorePath
    },
    () => undefined
  );
  // A UDP reply that finds no listener must not surface as an unhandled 'error'.
  engine.on("error", () => undefined);
  return engine;
}

function sendPacket(socket: dgram.Socket, packet: Buffer, port: number): Promise<void> {
  return new Promise((resolve, reject) =>
    socket.send(packet, port, "127.0.0.1", (err) => (err ? reject(err) : resolve()))
  );
}

function newClient(): dgram.Socket {
  const socket = dgram.createSocket("udp4");
  cleanups.push(() => new Promise<void>((resolve) => socket.close(() => resolve())));
  return socket;
}

/** Sends DISCOVER + REQUEST and resolves once the engine reports the bind. */
async function acquireLease(engine: DhcpEngine, port: number, mac: string): Promise<string> {
  const client = newClient();
  const key = stateKey(mac);
  const bound = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no lease for ${mac} within 5s`)), 5000);
    engine.on("lease:bound", (lease) => {
      if (lease.mac !== key) return;
      clearTimeout(timer);
      resolve(lease.ip);
    });
  });

  await sendPacket(client, buildRequest(1, mac, 0x1234), port);
  await sendPacket(client, buildRequest(3, mac, 0x1234), port);
  return bound;
}

/** Offers an address to `mac` without completing the handshake, and reports it. */
async function offeredAddress(engine: DhcpEngine, port: number, mac: string): Promise<string> {
  await sendPacket(newClient(), buildRequest(1, mac, 0x4321), port);

  const key = stateKey(mac);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const offered = engine.activeLeases().find((lease) => lease.mac === key);
    if (offered) return offered.ip;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no address offered to ${mac} within 5s`);
}

function makeStore(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  return path.join(tempDir, "networkServers", "dhcp-leases.json");
}

describe("DHCP lease persistence across a restart", () => {
  it("recovers a bound lease and keeps its address reserved for the original device", async () => {
    const storePath = makeStore("nexus-dhcp-restart-");
    cleanups.push(await createReplySink());

    // --- First run: a device takes a lease -----------------------------------
    scriptAddressPicks(PICK_FIRST);
    const portA = await freePort();
    const engineA = startEngine(portA, storePath);
    cleanups.push(() => engineA.stop());
    await engineA.start(portA);

    const leasedIp = await acquireLease(engineA, portA, CLIENT_A);
    expect(leasedIp).toBe(RANGE_START);

    // --- The daemon goes away ------------------------------------------------
    await engineA.stop();

    const persisted = loadLeases(storePath);
    expect(persisted, "stopping must flush the lease table to disk").toHaveLength(1);
    expect(persisted[0].ip).toBe(RANGE_START);
    expect(persisted[0].mac).toBe(stateKey(CLIENT_A));
    expect(persisted[0].expiresAt).toBeGreaterThan(Date.now());

    // --- Second run: a fresh engine, same file -------------------------------
    const portB = await freePort();
    const engineB = startEngine(portB, storePath);
    cleanups.push(() => engineB.stop());
    await engineB.start(portB);

    const restored = engineB.activeLeases();
    expect(restored, "the restarted engine must come up knowing the lease").toHaveLength(1);
    expect(restored[0].ip).toBe(RANGE_START);
    expect(restored[0].mac).toBe(stateKey(CLIENT_A));
    expect(restored[0].boundAt, "the original bind time survives, not a fresh one").toBe(persisted[0].boundAt);

    // The payoff: the next device asks while the restored lease is still live,
    // and the allocator's first candidate is the address that lease holds.
    scriptAddressPicks(PICK_FIRST, PICK_SECOND);
    const secondDevice = await offeredAddress(engineB, portB, CLIENT_B);
    expect(secondDevice, "a restored lease must keep its address out of the free pool").toBe("10.0.0.11");

    // And the original device is still handed its own address back.
    expect(await offeredAddress(engineB, portB, CLIENT_A)).toBe(RANGE_START);
  }, 30_000);

  it("hands the address to another device once the persisted lease has expired", async () => {
    const storePath = makeStore("nexus-dhcp-expired-");
    cleanups.push(await createReplySink());

    const boundAt = Date.now() - 7_200_000;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        savedAt: boundAt,
        leases: [
          {
            mac: stateKey(CLIENT_A),
            ip: RANGE_START,
            boundAt,
            leaseSec: 3600,
            expiresAt: boundAt + 3_600_000,
            hostname: null,
            leaseType: "dynamic"
          }
        ]
      }),
      "utf8"
    );

    scriptAddressPicks(PICK_FIRST, PICK_SECOND);
    const port = await freePort();
    const engine = startEngine(port, storePath);
    cleanups.push(() => engine.stop());
    await engine.start(port);

    expect(engine.activeLeases(), "an expired lease is not a claim on the address").toHaveLength(0);
    expect(
      await offeredAddress(engine, port, CLIENT_B),
      "an address whose lease has run out must go back into the pool"
    ).toBe(RANGE_START);
  }, 30_000);
});
