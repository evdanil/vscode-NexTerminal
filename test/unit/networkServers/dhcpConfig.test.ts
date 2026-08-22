/**
 * @author kanekitakitos
 *
 * Unit tests for the DHCP adapter's configuration surface
 * (`dhcp/DhcpAdapter.ts`), constructed directly — no daemon child process,
 * no `vscode` module (the adapter is deliberately free of both so it can run
 * inside the bare-Node daemon).
 *
 * Two halves:
 *  1. Constructor defaults — every getter falls back to the documented value
 *     when the corresponding config key is absent, and the initial lifecycle
 *     state is STOPPED.
 *  2. A real start/stop smoke test that binds an actual UDP socket (private
 *     172.28.1.0/24 range, so nothing on a developer LAN is served) and
 *     asserts the statusChange event sequence RUNNING → STOPPED. Keeping this
 *     as a real bind rather than a mock is the point: it is the only check
 *     that the adapter → engine → dgram wiring survives a port fallback.
 *
 * Ported from the standalone add-on's `tests/unit/dhcp-config.test.ts`.
 */

import * as dgram from "node:dgram";
import { describe, expect, it, vi } from "vitest";
import { DhcpAdapter } from "../../../src/services/networkServers/dhcp/DhcpAdapter";
import { ServerStatus } from "../../../src/services/networkServers/core/ServerStatus";

function buildPacket(messageType: number): Buffer {
  const packet = Buffer.alloc(300);
  let offset = 0;
  packet.writeUInt8(1, offset++); // BOOTREQUEST
  packet.writeUInt8(1, offset++); // Ethernet
  packet.writeUInt8(6, offset++); // chaddr length
  offset += 5; // hops + xid
  offset += 2; // secs
  offset += 2; // flags
  offset += 16; // ciaddr / yiaddr / siaddr / giaddr
  for (const octet of "AA:BB:CC:00:00:02".split(":")) packet.writeUInt8(parseInt(octet, 16), offset++);
  offset += 10; // chaddr tail
  offset += 64; // sname
  offset += 128; // file
  packet.writeUInt32BE(0x63825363, offset); // magic cookie
  offset += 4;
  packet.writeUInt8(53, offset++);
  packet.writeUInt8(1, offset++);
  packet.writeUInt8(messageType, offset++);
  packet.writeUInt8(255, offset++);
  return packet.subarray(0, Math.max(offset, 240));
}

async function freeLoopbackPort(): Promise<number> {
  const probe = dgram.createSocket("udp4");
  try {
    return await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.bind(0, "127.0.0.1", () => resolve(probe.address().port));
    });
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
}

function sendPacket(socket: dgram.Socket, packet: Buffer, port: number): Promise<void> {
  return new Promise((resolve, reject) =>
    socket.send(packet, port, "127.0.0.1", (error) => (error ? reject(error) : resolve()))
  );
}

describe("DHCP Adapter (DhcpAdapter)", () => {
  describe("constructor defaults", () => {
    it("port=67, status=STOPPED, defaults applied", () => {
      const adapter = new DhcpAdapter();
      expect(adapter.port, "default port must be 67").toBe(67);
      expect(adapter.status, "initial state must be STOPPED").toBe(ServerStatus.STOPPED);
      expect(adapter.rangeStart, "rangeStart default").toBe("192.168.2.10");
      expect(adapter.rangeEnd, "rangeEnd default").toBe("192.168.2.199");
      expect(adapter.subnet, "subnet default").toBe("255.255.255.0");
      expect(adapter.gateway, "gateway default").toBe("192.168.2.1");
      expect(adapter.dns, "dns default").toEqual(["8.8.8.8", "8.8.4.4"]);
      expect(adapter.leaseTimeSec, "leaseTime default").toBe(86400);
      expect(adapter.serverId, "serverId default").toBe("192.168.2.1");
      expect(adapter.broadcast, "broadcast default").toBe("192.168.2.255");
    });

    it("bindAddress defaults to 0.0.0.0 and honours an explicit interface", () => {
      expect(new DhcpAdapter().bindAddress).toBe("0.0.0.0");
      expect(new DhcpAdapter({ bindAddress: "127.0.0.1" }).bindAddress).toBe("127.0.0.1");
    });

    it("keeps a direct blank vendor filter fail-closed after the adapter starts", async () => {
      const port = await freeLoopbackPort();
      const adapter = new DhcpAdapter({
        rangeStart: "172.28.1.10",
        rangeEnd: "172.28.1.20",
        subnet: "255.255.255.0",
        gateway: "172.28.1.1",
        serverId: "172.28.1.1",
        broadcast: "127.0.0.1",
        bindAddress: "127.0.0.1",
        vendorClassId: " \t ",
        nextServer: "172.28.1.1",
        bootFileName: "restricted.cfg"
      });
      (adapter as any).port = port;

      try {
        await adapter.start();
        const server: any = (adapter as any).engine._server;
        server._req = { options: { 60: "PXEClient" } };
        const offered = server._getOptions({}, [], undefined);

        expect(offered[66]).toBeNull();
        expect(offered[67]).toBeNull();
      } finally {
        await adapter.stop();
      }
    });
  });

  describe("smoke start/close (UDP bind real)", () => {
    it(
      "start() with range 172.28.1.10→172.28.1.20 becomes RUNNING and stop() closes without crash",
      async () => {
        const adapter = new DhcpAdapter({
          rangeStart: "172.28.1.10",
          rangeEnd: "172.28.1.20",
          subnet: "255.255.255.0",
          gateway: "172.28.1.1",
          dns: ["1.1.1.1"],
          leaseTimeSec: 3600,
          serverId: "172.28.1.1",
          broadcast: "172.28.1.255"
        });

        let gotRunning = false;
        const runningPromise = new Promise<void>((resolve) => {
          const handler = (status: ServerStatus) => {
            if (status === ServerStatus.RUNNING) {
              gotRunning = true;
              adapter.off("statusChange", handler);
              resolve();
            }
          };
          adapter.on("statusChange", handler);
        });

        await adapter.start();
        await runningPromise;
        expect(gotRunning, "status must transition to RUNNING").toBeTruthy();
        expect(adapter.status).toBe(ServerStatus.RUNNING);

        const malformedClient = dgram.createSocket("udp4");
        const logs: string[] = [];
        adapter.on("log", (level, message) => {
          if (level === "warn") logs.push(message);
        });
        try {
          await new Promise<void>((resolve, reject) => {
            malformedClient.send(Buffer.from([1, 1, 6]), adapter.boundPort!, "127.0.0.1", (error) =>
              error ? reject(error) : resolve()
            );
          });
          await vi.waitFor(() => expect(logs.some((message) => message.includes("dropped malformed DHCP packet"))).toBe(true));
          expect(adapter.status, "a rejected packet must not make the adapter fatal").toBe(ServerStatus.RUNNING);
          expect(adapter.boundPort, "the adapter must retain its running socket after a packet rejection").not.toBeNull();
        } finally {
          await new Promise<void>((resolve) => malformedClient.close(() => resolve()));
        }
        let gotStopped = false;
        const stoppedPromise = new Promise<void>((resolve) => {
          const handler = (status: ServerStatus) => {
            if (status === ServerStatus.STOPPED) {
              gotStopped = true;
              adapter.off("statusChange", handler);
              resolve();
            }
          };
          adapter.on("statusChange", handler);
        });

        await adapter.stop();
        await stoppedPromise;
        expect(gotStopped, "status must transition to STOPPED").toBeTruthy();
        expect(adapter.status).toBe(ServerStatus.STOPPED);
      },
      15_000
    );

    it("observes DECLINE and INFORM through the adapter without leaving RUNNING", async () => {
      const port = await freeLoopbackPort();
      const adapter = new DhcpAdapter({
        rangeStart: "172.28.1.10",
        rangeEnd: "172.28.1.20",
        subnet: "255.255.255.0",
        gateway: "172.28.1.1",
        serverId: "172.28.1.1",
        broadcast: "127.0.0.1",
        bindAddress: "127.0.0.1"
      });
      (adapter as any).port = port;
      const connections: Array<{ code?: string }> = [];
      adapter.on("connection", (event) => connections.push(event));
      const client = dgram.createSocket("udp4");

      try {
        await adapter.start();
        await sendPacket(client, buildPacket(4), port);
        await sendPacket(client, buildPacket(8), port);

        await vi.waitFor(() => {
          expect(adapter.packetCounters.declineCount).toBe(1);
          expect(adapter.packetCounters.informCount).toBe(1);
          expect(connections).toContainEqual(expect.objectContaining({ code: "DHCPDECLINE" }));
        });
        expect(adapter.status).toBe(ServerStatus.RUNNING);
      } finally {
        await new Promise<void>((resolve) => client.close(() => resolve()));
        await adapter.stop();
      }
    });

    it("keeps a raw dgram socket error fatal at the adapter boundary", async () => {
      const port = await freeLoopbackPort();
      const adapter = new DhcpAdapter({
        rangeStart: "172.28.1.10",
        rangeEnd: "172.28.1.20",
        subnet: "255.255.255.0",
        gateway: "172.28.1.1",
        serverId: "172.28.1.1",
        broadcast: "127.0.0.1",
        bindAddress: "127.0.0.1"
      });
      (adapter as any).port = port;

      try {
        await adapter.start();
        const server: any = (adapter as any).engine._server;
        server._sock.emit("error", new Error("raw dgram failure"));
        await vi.waitFor(() => expect(adapter.status).toBe(ServerStatus.ERROR));
        expect(adapter.lastError).toContain("raw dgram failure");
      } finally {
        await adapter.stop();
      }
    });
  });
});
