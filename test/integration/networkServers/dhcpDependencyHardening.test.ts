/** @author kanekitakitos */

import { fork, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as dhcp from "dhcp";
import { afterEach, describe, expect, it, vi } from "vitest";

const FIXTURE = path.resolve(__dirname, "..", "..", "fixtures", "dhcpAllocatorProbe.js");
const PROBE_DEADLINE_MS = 500;
const REAP_DEADLINE_MS = 2_000;
const REQUEST = { chaddr: "AA-BB-CC-00-00-02", options: {} };

const openSockets: Array<{ close: () => void }> = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (openSockets.length > 0) {
    try {
      openSockets.pop()?.close();
    } catch {
      // A never-bound dgram socket reports that it is already closed.
    }
  }
});

function createAllocatorServer(
  range: [string, string],
  randomIP = false,
  staticLeases: Record<string, string> = {}
): any {
  const server: any = dhcp.createServer({
    range,
    randomIP,
    static: staticLeases,
    server: "192.0.2.1",
    leaseTime: 3600
  });
  openSockets.push(server._sock);
  return server;
}

function writeIpv4(packet: Buffer, offset: number, address: string): void {
  address.split(".").forEach((octet, index) => packet.writeUInt8(Number(octet), offset + index));
}

/** Builds a DHCPRELEASE accepted by the dependency's real parser/dispatcher. */
function buildRelease(mac: string, address: string, clientId?: string): Buffer {
  const packet = Buffer.alloc(300);
  let offset = 0;
  packet.writeUInt8(1, offset++); // BOOTREQUEST
  packet.writeUInt8(1, offset++); // Ethernet
  packet.writeUInt8(6, offset++); // hardware-address length
  packet.writeUInt8(0, offset++); // hops
  packet.writeUInt32BE(0x12345678, offset);
  offset += 4;
  offset += 2; // secs
  offset += 2; // flags
  writeIpv4(packet, offset, address); // ciaddr identifies the leased address
  offset += 4;
  offset += 12; // yiaddr / siaddr / giaddr
  for (const octet of mac.split(/[-:]/)) packet.writeUInt8(parseInt(octet, 16), offset++);
  offset += 10; // unused tail of chaddr
  offset += 64; // sname
  offset += 128; // file
  packet.writeUInt32BE(0x63825363, offset); // DHCP magic cookie
  offset += 4;
  packet.writeUInt8(53, offset++);
  packet.writeUInt8(1, offset++);
  packet.writeUInt8(7, offset++); // DHCPRELEASE
  if (clientId !== undefined) {
    const encoded = Buffer.from(clientId, "ascii");
    packet.writeUInt8(61, offset++);
    packet.writeUInt8(encoded.length, offset++);
    encoded.copy(packet, offset);
    offset += encoded.length;
  }
  packet.writeUInt8(255, offset++);
  return packet.subarray(0, Math.max(offset, 240));
}

interface ProbeReply {
  readonly type: "result";
  readonly value: unknown;
}

function messageWithin(child: ChildProcess, timeoutMs: number): Promise<ProbeReply> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown): void => {
      cleanup();
      resolve(message as ProbeReply);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`allocator probe exited before replying (code=${code}, signal=${signal})`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`allocator probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function killAndReap(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  const exit = alreadyExited
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });

  try {
    child.kill("SIGKILL");
  } catch {
    // The child may have exited between the state check and the unconditional kill.
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("allocator probe was not reaped within 2000ms")), REAP_DEADLINE_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runAllocatorProbe(mode = "select-exhausted"): Promise<ProbeReply> {
  const child = fork(FIXTURE, {
    env: { ...process.env, DHCP_ALLOCATOR_PROBE_MODE: mode },
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  let reply: ProbeReply | undefined;
  let failure: unknown;
  let reaped: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  try {
    reply = await messageWithin(child, PROBE_DEADLINE_MS);
  } catch (error) {
    failure = error;
  } finally {
    reaped = await killAndReap(child);
  }

  if (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    throw new Error(`${message}; child reaped (code=${reaped!.code}, signal=${reaped!.signal})`);
  }
  return reply!;
}

describe("dhcp@0.2.20 dependency hardening", () => {
  it("returns a controlled no-address result for an exhausted pool", async () => {
    await expect(runAllocatorProbe()).resolves.toEqual({ type: "result", value: null });
  });

  it("can select the inclusive last address from a randomized range", () => {
    const server = createAllocatorServer(["192.0.2.10", "192.0.2.11"], true);
    vi.spyOn(Math, "random").mockReturnValue(0.999);

    expect(server._selectAddress(REQUEST.chaddr, REQUEST)).toBe("192.0.2.11");
  });

  it("does not retain provisional state or send an OFFER when no address is available", async () => {
    await expect(runAllocatorProbe("discover-exhausted")).resolves.toEqual({
      type: "result",
      value: {
        offers: 0,
        exhausted: ["AA-BB-CC-00-00-02"],
        stateHasClient: false
      }
    });
  });

  it("reclaims an expired BOUND lease using bindTime and leasePeriod", () => {
    const server = createAllocatorServer(["192.0.2.10", "192.0.2.11"]);
    server._state["AA-BB-CC-00-00-01"] = {
      address: "192.0.2.10",
      bindTime: new Date(Date.now() - 61_000),
      leasePeriod: 60,
      state: "BOUND"
    };

    expect(server._selectAddress(REQUEST.chaddr, REQUEST)).toBe("192.0.2.10");
    expect(server._state).not.toHaveProperty("AA-BB-CC-00-00-01");
  });

  it("reclaims an OFFER whose provisional lifetime exceeded 60 seconds", () => {
    const server = createAllocatorServer(["192.0.2.10", "192.0.2.11"]);
    server._state["AA-BB-CC-00-00-01"] = {
      address: "192.0.2.10",
      offerTime: Date.now() - 60_001,
      leasePeriod: 3600,
      state: "OFFERED"
    };

    expect(server._selectAddress(REQUEST.chaddr, REQUEST)).toBe("192.0.2.10");
    expect(server._state).not.toHaveProperty("AA-BB-CC-00-00-01");
  });

  it("preserves an expired BOUND address backed by a static reservation", () => {
    const server = createAllocatorServer(
      ["192.0.2.10", "192.0.2.11"],
      false,
      { "aa:bb:cc:00:00:01": "192.0.2.10" }
    );
    server._state["AA-BB-CC-00-00-01"] = {
      address: "192.0.2.10",
      bindTime: new Date(Date.now() - 61_000),
      leasePeriod: 60,
      state: "BOUND"
    };

    expect(server._selectAddress(REQUEST.chaddr, REQUEST)).toBe("192.0.2.11");
    expect(server._state["AA-BB-CC-00-00-01"].address).toBe("192.0.2.10");
  });

  it("timestamps a successful OFFER with a numeric provisional start time", () => {
    const server = createAllocatorServer(["192.0.2.10", "192.0.2.11"]);
    server.sendOffer = () => undefined;
    const before = Date.now();

    server.handleDiscover(REQUEST);

    const offer = server._state[REQUEST.chaddr];
    expect(offer.address).toBe("192.0.2.10");
    expect(offer.state).toBe("OFFERED");
    expect(offer.offerTime).toBeGreaterThanOrEqual(before);
    expect(offer.offerTime).toBeLessThanOrEqual(Date.now());
  });

  it("dispatches a matching RELEASE, emits its former address, and makes it reusable", () => {
    const server = createAllocatorServer(["192.0.2.10", "192.0.2.11"]);
    const mac = "AA-BB-CC-00-00-01";
    server.sendOffer = () => undefined;
    server.handleDiscover({ chaddr: mac, ciaddr: "0.0.0.0", options: { 61: "client-a" } });
    server._state[mac].state = "BOUND";
    server._state[mac].bindTime = new Date();
    const released: Array<[string, string]> = [];
    server.on("released", (releasedMac: string, address: string) => released.push([releasedMac, address]));

    server._sock.emit("message", buildRelease(mac, "192.0.2.10", "client-a"));

    expect(server._state).not.toHaveProperty(mac);
    expect(released).toEqual([[mac, "192.0.2.10"]]);
    expect(server._selectAddress(REQUEST.chaddr, REQUEST)).toBe("192.0.2.10");
  });

  it("preserves a lease when RELEASE carries a different client identifier", () => {
    const server = createAllocatorServer(["192.0.2.10", "192.0.2.11"]);
    const mac = "AA-BB-CC-00-00-01";
    server.sendOffer = () => undefined;
    server.handleDiscover({ chaddr: mac, ciaddr: "0.0.0.0", options: { 61: "client-a" } });
    server._state[mac].state = "BOUND";
    server._state[mac].bindTime = new Date();
    const released: Array<[string, string]> = [];
    server.on("released", (releasedMac: string, address: string) => released.push([releasedMac, address]));

    server._sock.emit("message", buildRelease(mac, "192.0.2.10", "client-b"));

    expect(server._state[mac].address).toBe("192.0.2.10");
    expect(released).toEqual([]);
  });
});
