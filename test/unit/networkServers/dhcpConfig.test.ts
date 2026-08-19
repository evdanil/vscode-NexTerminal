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

import { describe, expect, it } from "vitest";
import { DhcpAdapter } from "../../../src/services/networkServers/dhcp/DhcpAdapter";
import { ServerStatus } from "../../../src/services/networkServers/core/ServerStatus";

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

        await new Promise((res) => setTimeout(res, 1000));

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
  });
});
