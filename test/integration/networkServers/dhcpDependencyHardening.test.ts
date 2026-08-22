/** @author kanekitakitos */

import { fork, type ChildProcess } from "node:child_process";
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as dhcp from "dhcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LEASE_STORE_VERSION,
  loadLeases,
  reconcilePersistedLeases,
  toRestoredLeaseState
} from "../../../src/services/networkServers/dhcp/engine/dhcpLeasePersistence";
import type { DhcpLeaseInfo } from "../../../src/services/networkServers/dhcp/engine/dhcpLeaseUtils";
import { DhcpEngine } from "../../../src/services/networkServers/dhcp/engine/DhcpEngine";

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

/** Builds a minimal BOOTP frame for packet-boundary tests. */
function buildPacket(messageType?: number, requestedOption?: number, opcode = 1): Buffer {
  const packet = Buffer.alloc(300);
  let offset = 0;
  packet.writeUInt8(opcode, offset++); // BOOTREQUEST or BOOTREPLY
  packet.writeUInt8(1, offset++); // Ethernet
  packet.writeUInt8(6, offset++); // chaddr length
  packet.writeUInt8(0, offset++); // hops
  packet.writeUInt32BE(0x12345678, offset);
  offset += 4;
  offset += 2; // secs
  offset += 2; // flags
  offset += 16; // ciaddr / yiaddr / siaddr / giaddr
  for (const octet of "AA:BB:CC:00:00:02".split(":")) packet.writeUInt8(parseInt(octet, 16), offset++);
  offset += 10; // chaddr tail
  offset += 64; // sname
  offset += 128; // file
  packet.writeUInt32BE(0x63825363, offset); // DHCP magic cookie
  offset += 4;
  if (messageType !== undefined) {
    packet.writeUInt8(53, offset++);
    packet.writeUInt8(1, offset++);
    packet.writeUInt8(messageType, offset++);
  }
  if (requestedOption !== undefined) {
    packet.writeUInt8(55, offset++);
    packet.writeUInt8(1, offset++);
    packet.writeUInt8(requestedOption, offset++);
  }
  packet.writeUInt8(255, offset++);
  return packet.subarray(0, Math.max(offset, 240));
}

function malformedOptionLengthPacket(): Buffer {
  const packet = buildPacket();
  return Buffer.concat([packet.subarray(0, packet.length - 1), Buffer.from([55, 4, 1])]);
}

async function sendLoopbackPacket(packet: Buffer, port: number): Promise<void> {
  const client = dgram.createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      client.send(packet, port, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
    });
  } finally {
    await new Promise<void>((resolve) => client.close(() => resolve()));
  }
}

/** Keeps the real DHCP OFFER send path free of ICMP-port-unreachable noise. */
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

async function freeLoopbackPort(): Promise<number> {
  const probe = dgram.createSocket("udp4");
  try {
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.bind(0, "127.0.0.1", () => resolve(probe.address().port));
    });
    return port;
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
}

async function createPacketServer(): Promise<{ server: any; port: number; close: () => Promise<void> }> {
  const server = dhcp.createServer({
    range: ["192.0.2.10", "192.0.2.11"],
    randomIP: false,
    static: {},
    server: "192.0.2.1",
    broadcast: "127.0.0.1",
    leaseTime: 3600
  });
  openSockets.push(server._sock);
  const port = await freeLoopbackPort();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function oncePacketError(server: any): Promise<[Error, unknown?, { messageEmitted?: boolean }?]> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onPacketError = (error: Error, req?: unknown, metadata?: { messageEmitted?: boolean }): void => {
      clearTimeout(timer);
      resolve([error, req, metadata]);
    };
    timer = setTimeout(() => {
      server.off("packetError", onPacketError);
      reject(new Error("packetError was not emitted within 750ms"));
    }, 750);
    server.once("packetError", onPacketError);
  });
}

/** Resolves only when the dependency reports an owned socket failure. */
function onceFatalSocketError(server: any): Promise<Error> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.off("error", onError);
      reject(new Error("fatal socket error was not emitted within 750ms"));
    }, 750);
    const onError = (error: Error): void => {
      clearTimeout(timer);
      resolve(error);
    };
    server.once("error", onError);
  });
}

function onceMessage(server: any): Promise<unknown> {
  return new Promise((resolve) => {
    server.once("message", resolve);
  });
}

/** A deadline is diagnostic only: the test otherwise waits on the real completion callback. */
function within<T>(promise: Promise<T>, description: string, timeoutMs = 750): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${description} was not observed within ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
  it("contains malformed datagrams as packetError and remains responsive on the same loopback port", async () => {
    const { server, port, close } = await createPacketServer();
    const closeReplySink = await createReplySink();
    const fatalErrors: unknown[] = [];
    server.on("error", (error: unknown) => fatalErrors.push(error));

    try {
      for (const packet of [
        Buffer.from([1, 1, 6]),
        malformedOptionLengthPacket(),
        buildPacket(),
        buildPacket(2),
        buildPacket(1, 254)
      ]) {
        const rejected = oncePacketError(server);
        await sendLoopbackPacket(packet, port);
        const [error] = await rejected;
        expect(error).toBeInstanceOf(Error);
      }

      expect(fatalErrors).toEqual([]);
      const originalSend = server._sock.send.bind(server._sock);
      let completeOfferSend: (() => void) | undefined;
      let failOfferSend: ((error: Error) => void) | undefined;
      const offerSent = new Promise<void>((resolve, reject) => {
        completeOfferSend = resolve;
        failOfferSend = reject;
      });
      server._sock.send = (...args: unknown[]): unknown => {
        const callback = args.at(-1);
        if (typeof callback !== "function") throw new Error("expected dgram send callback");
        args[args.length - 1] = (error: Error | null): void => {
          callback(error);
          if (error) failOfferSend?.(error);
          else completeOfferSend?.();
        };
        return originalSend(...args);
      };
      const message = onceMessage(server);
      await sendLoopbackPacket(buildPacket(1), port);
      await expect(message).resolves.toMatchObject({ options: { 53: 1 } });
      await expect(within(offerSent, "OFFER send completion")).resolves.toBeUndefined();
      expect(fatalErrors).toEqual([]);
    } finally {
      await closeReplySink();
      await close();
    }

    const rebound = dgram.createSocket("udp4");
    try {
      await new Promise<void>((resolve, reject) => {
        rebound.once("error", reject);
        rebound.bind(port, "127.0.0.1", () => resolve());
      });
    } finally {
      await new Promise<void>((resolve) => rebound.close(() => resolve()));
    }
  });

  it("observes every allowed client type actively and every known type passively", () => {
    const active = createAllocatorServer(["192.0.2.10", "192.0.2.11"]);
    const activeMessages: number[] = [];
    const activePacketErrors: Error[] = [];
    active.handleDiscover = () => undefined;
    active.handleRequest = () => undefined;
    active.handleRelease = () => undefined;
    active.on("message", (req: { options?: Record<number, number> }) => activeMessages.push(req.options?.[53] ?? -1));
    active.on("packetError", (error: Error) => activePacketErrors.push(error));

    for (const type of [1, 3, 4, 7, 8]) {
      active._sock.emit("message", buildPacket(type));
    }

    expect(activeMessages).toEqual([1, 3, 4, 7, 8]);
    expect(activePacketErrors).toEqual([]);

    for (const type of [2, 5, 6, 0, 9]) {
      active._sock.emit("message", buildPacket(type));
    }
    expect(activePacketErrors).toHaveLength(5);

    const passive: any = dhcp.createBroadcastHandler();
    openSockets.push(passive._sock);
    const passiveMessages: number[] = [];
    const passivePacketErrors: Error[] = [];
    passive.on("message", (req: { options?: Record<number, number> }) => passiveMessages.push(req.options?.[53] ?? -1));
    passive.on("packetError", (error: Error) => passivePacketErrors.push(error));

    for (let type = 1; type <= 8; type += 1) {
      const opcode = type === 2 || type === 5 || type === 6 ? 2 : 1;
      passive._sock.emit("message", buildPacket(type, undefined, opcode));
    }

    expect(passiveMessages).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(passivePacketErrors).toEqual([]);
  });

  it("keeps BOOTREPLY and invalid BOOTP opcodes out of active server dispatch", () => {
    const active = createAllocatorServer(["192.0.2.10", "192.0.2.11"]);
    const messages: number[] = [];
    const packetErrors: Error[] = [];
    active.on("message", (req: { options?: Record<number, number> }) => messages.push(req.options?.[53] ?? -1));
    active.on("packetError", (error: Error) => packetErrors.push(error));

    for (const packet of [
      buildPacket(2, undefined, 2),
      buildPacket(1, undefined, 0),
      buildPacket(1, undefined, 3)
    ]) {
      active._sock.emit("message", packet);
    }

    expect(messages).toEqual([]);
    expect(packetErrors).toHaveLength(3);
  });

  it("rejects a parser-produced non-integer DHCP message type", () => {
    const server = createAllocatorServer(["192.0.2.10", "192.0.2.11"]);
    const protocol = require("dhcp/lib/protocol.js") as { parse: (packet: Buffer) => unknown };
    vi.spyOn(protocol, "parse").mockReturnValue({ op: 1, options: { 53: 1.5 } });
    const packetErrors: Error[] = [];
    server.on("packetError", (error: Error) => packetErrors.push(error));

    server._sock.emit("message", Buffer.alloc(0));

    expect(packetErrors).toHaveLength(1);
    expect(packetErrors[0]).toBeInstanceOf(Error);
  });

  it("keeps packet-local throws on packetError but makes reply-socket failures fatal", async () => {
    const { server, port, close } = await createPacketServer();
    const fatalErrors: unknown[] = [];
    const packetErrors: unknown[] = [];
    server.on("error", (error: unknown) => fatalErrors.push(error));
    server.on("packetError", (error: unknown) => packetErrors.push(error));

    try {
      const nonErrorThrower = (): void => {
        throw "downstream non-Error failure";
      };
      server.once("message", nonErrorThrower);
      const downstream = oncePacketError(server);
      await sendLoopbackPacket(buildPacket(1), port);
      await expect(downstream).resolves.toMatchObject([expect.any(Error), expect.anything(), { messageEmitted: true }]);

      const originalSend = server._sock.send.bind(server._sock);
      server._sock.send = (): never => {
        throw "synchronous send failure";
      };
      const synchronous = onceFatalSocketError(server);
      await sendLoopbackPacket(buildPacket(1), port);
      await expect(synchronous).resolves.toBeInstanceOf(Error);

      server._sock.send = (...args: unknown[]): unknown => {
        const callback = args.at(-1);
        if (typeof callback !== "function") throw new Error("expected dgram send callback");
        queueMicrotask(() => callback("asynchronous send failure"));
        return undefined;
      };
      const asynchronous = onceFatalSocketError(server);
      await sendLoopbackPacket(buildPacket(1), port);
      await expect(asynchronous).resolves.toBeInstanceOf(Error);
      server._sock.send = originalSend;

      expect(packetErrors, "only the message-listener throw is packet-local").toHaveLength(1);
      expect(fatalErrors).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it("counts each rejected datagram exactly once across the message boundary", async () => {
    const port = await freeLoopbackPort();
    const warnings: string[] = [];
    const engine = new DhcpEngine(
      {
        rangeStart: "192.0.2.10",
        rangeEnd: "192.0.2.11",
        subnet: "255.255.255.0",
        gateway: "192.0.2.1",
        serverId: "192.0.2.1",
        broadcast: "127.0.0.1",
        bindAddress: "127.0.0.1"
      },
      () => undefined
    );
    engine.on("log", (level, message) => {
      if (level === "warn") warnings.push(message);
    });

    try {
      await engine.start(port);

      await sendLoopbackPacket(Buffer.from([1, 1, 6]), port);
      await vi.waitFor(() => expect(warnings).toHaveLength(1));
      expect(engine.packetCounters.packetsReceived).toBe(1);

      const server: any = (engine as any)._server;
      server.once("message", () => {
        throw new Error("post-message observer failure");
      });
      await sendLoopbackPacket(buildPacket(1), port);
      await vi.waitFor(() => expect(warnings).toHaveLength(2));
      expect(engine.packetCounters.packetsReceived).toBe(2);
    } finally {
      await engine.stop();
    }
  });

  it("returns a controlled no-address result for an exhausted pool", async () => {
    await expect(runAllocatorProbe()).resolves.toEqual({ type: "result", value: null });
  });

  it("rejects a full-width IPv4 pool before attempting an operationally unbounded scan", async () => {
    await expect(runAllocatorProbe("select-oversized")).resolves.toEqual({ type: "result", value: null });
  });

  it("accepts exactly 65,536 addresses and rejects 65,537 before scanning", async () => {
    await expect(runAllocatorProbe("select-cap-boundary")).resolves.toEqual({
      type: "result",
      value: {
        max: "192.0.0.0",
        over: null
      }
    });
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

  it("does not retain BOUND state or send an ACK when a direct REQUEST exhausts the pool", async () => {
    await expect(runAllocatorProbe("request-exhausted")).resolves.toEqual({
      type: "result",
      value: {
        acks: 0,
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

  it("expires a stale static OFFER while keeping its address reserved from dynamic allocation", () => {
    const staticMac = "AA-BB-CC-00-00-01";
    const server = createAllocatorServer(
      ["192.0.2.10", "192.0.2.11"],
      false,
      { "aa:bb:cc:00:00:01": "192.0.2.10" }
    );
    server._state[staticMac] = {
      address: "192.0.2.10",
      offerTime: Date.now() - 60_001,
      leasePeriod: 3600,
      state: "OFFERED"
    };

    expect(server._selectAddress(REQUEST.chaddr, REQUEST)).toBe("192.0.2.11");
    expect(server._state).not.toHaveProperty(staticMac);
  });

  it("compares allocator bounds unsigned across the signed IPv4 midpoint", () => {
    const server = createAllocatorServer(["127.255.255.255", "128.0.0.0"]);
    server._state["AA-BB-CC-00-00-01"] = {
      address: "127.255.255.255",
      bindTime: new Date(),
      leasePeriod: 3600,
      state: "BOUND"
    };

    expect(server._selectAddress(REQUEST.chaddr, REQUEST)).toBe("128.0.0.0");
  });

  it("allocates the single unsigned maximum IPv4 address", () => {
    const server = createAllocatorServer(["255.255.255.255", "255.255.255.255"]);

    expect(server._selectAddress(REQUEST.chaddr, REQUEST)).toBe("255.255.255.255");
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

  it("preserves a known-null lease when RELEASE unexpectedly carries a client identifier", () => {
    const server = createAllocatorServer(["192.0.2.10", "192.0.2.11"]);
    const mac = "AA-BB-CC-00-00-01";
    server.sendOffer = () => undefined;
    server.handleDiscover({ chaddr: mac, ciaddr: "0.0.0.0", options: {} });
    server._state[mac].state = "BOUND";
    server._state[mac].bindTime = new Date();
    const released: Array<[string, string]> = [];
    server.on("released", (releasedMac: string, address: string) => released.push([releasedMac, address]));

    server._sock.emit("message", buildRelease(mac, "192.0.2.10", "client-a"));

    expect(server._state[mac].clientId).toBeNull();
    expect(server._state[mac].address).toBe("192.0.2.10");
    expect(released).toEqual([]);
  });

  it("preserves a lease when RELEASE carries a different hardware address", () => {
    const server = createAllocatorServer(["192.0.2.10", "192.0.2.11"]);
    const mac = "AA-BB-CC-00-00-01";
    server._state[mac] = {
      address: "192.0.2.10",
      clientId: "client-a",
      leasePeriod: 3600,
      state: "BOUND"
    };
    const released: Array<[string, string]> = [];
    server.on("released", (releasedMac: string, address: string) => released.push([releasedMac, address]));

    server._sock.emit("message", buildRelease("AA-BB-CC-00-00-09", "192.0.2.10", "client-a"));

    expect(server._state[mac].address).toBe("192.0.2.10");
    expect(released).toEqual([]);
  });

  it("preserves a lease when RELEASE carries the wrong client address", () => {
    const server = createAllocatorServer(["192.0.2.10", "192.0.2.11"]);
    const mac = "AA-BB-CC-00-00-01";
    server._state[mac] = {
      address: "192.0.2.10",
      clientId: "client-a",
      leasePeriod: 3600,
      state: "BOUND"
    };
    const released: Array<[string, string]> = [];
    server.on("released", (releasedMac: string, address: string) => released.push([releasedMac, address]));

    server._sock.emit("message", buildRelease(mac, "192.0.2.11", "client-a"));

    expect(server._state[mac].address).toBe("192.0.2.10");
    expect(released).toEqual([]);
  });

  it("preserves static reservation ownership when a matching RELEASE targets its placeholder", () => {
    const server = createAllocatorServer(
      ["192.0.2.10", "192.0.2.11"],
      false,
      { "aa:bb:cc:00:00:01": "192.0.2.10" }
    );
    const mac = "AA-BB-CC-00-00-01";
    server._state[mac] = {
      address: "192.0.2.10",
      clientId: null,
      leasePeriod: 3600,
      state: "RESERVED"
    };
    const released: Array<[string, string]> = [];
    server.on("released", (releasedMac: string, address: string) => released.push([releasedMac, address]));

    server._sock.emit("message", buildRelease(mac, "192.0.2.10"));

    expect(server._state[mac].address).toBe("192.0.2.10");
    expect(released).toEqual([]);
    expect(server._selectAddress(REQUEST.chaddr, REQUEST)).toBe("192.0.2.11");
  });

  it("accepts a matching RELEASE after a persisted client identifier is restored", () => {
    const server = createAllocatorServer(["192.0.2.10", "192.0.2.11"]);
    const mac = "AA-BB-CC-00-00-01";
    const persisted: DhcpLeaseInfo = {
      mac,
      ip: "192.0.2.10",
      boundAt: Date.now() - 1_000,
      leaseSec: 3600,
      expiresAt: Date.now() + 3_599_000,
      remainingSec: 3599,
      hostname: null,
      leaseType: "dynamic",
      clientId: "client-a"
    };
    server._state[mac] = toRestoredLeaseState(persisted, "192.0.2.1");
    const released: Array<[string, string]> = [];
    server.on("released", (releasedMac: string, address: string) => released.push([releasedMac, address]));

    server._sock.emit("message", buildRelease(mac, "192.0.2.10", "client-b"));

    expect(server._state[mac].address).toBe("192.0.2.10");
    expect(released).toEqual([]);

    server._sock.emit("message", buildRelease(mac, "192.0.2.10", "client-a"));

    expect(server._state).not.toHaveProperty(mac);
    expect(released).toEqual([[mac, "192.0.2.10"]]);
  });

  it("releases a legacy disk-restored lease with unknown identity after exact MAC and ciaddr match", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-dhcp-legacy-release-"));
    try {
      const storePath = path.join(tempDir, "dhcp-leases.json");
      const now = Date.now();
      const mac = "AA-BB-CC-00-00-01";
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          version: LEASE_STORE_VERSION,
          savedAt: now,
          leases: [{
            mac,
            ip: "192.0.2.10",
            boundAt: now - 1_000,
            leaseSec: 3600,
            expiresAt: now + 3_599_000,
            remainingSec: 3599,
            hostname: null,
            leaseType: "dynamic"
          }]
        }),
        "utf8"
      );
      const loaded = loadLeases(storePath);
      const { restored } = reconcilePersistedLeases(loaded, {
        staticMap: {},
        rangeStart: "192.0.2.10",
        rangeEnd: "192.0.2.11",
        now
      });
      expect(restored).toHaveLength(1);
      expect(restored[0]).not.toHaveProperty("clientId");

      const server = createAllocatorServer(["192.0.2.10", "192.0.2.11"]);
      server._state[mac] = toRestoredLeaseState(restored[0], "192.0.2.1");
      expect(server._state[mac].clientId).toBeUndefined();
      const released: Array<[string, string]> = [];
      server.on("released", (releasedMac: string, address: string) => released.push([releasedMac, address]));

      server._sock.emit("message", buildRelease(mac, "192.0.2.10", "legacy-client"));

      expect(server._state).not.toHaveProperty(mac);
      expect(released).toEqual([[mac, "192.0.2.10"]]);
      expect(server._selectAddress(REQUEST.chaddr, REQUEST)).toBe("192.0.2.10");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
