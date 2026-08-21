/**
 * Integration tests for what a *failed* service start reports.
 *
 * Both adapters used to record `ServerStatus.ERROR` and then return normally.
 * Status alone only reaches the sidebar: `start()` resolving is what the
 * daemon answers as `{ok: true}`, so `NetworkServerManager.start` resolved too,
 * the command layer never showed its "Failed to start…" message, and with
 * Verbose Mode on the user was told the service had started. A service that
 * cannot bind has to be a rejection, not a status field.
 *
 * Real sockets, no mocks: the TFTP case races a port that is genuinely held,
 * and the DHCP case binds an address that genuinely does not exist on this
 * host — deterministic on every platform, and neither depends on privileges.
 *
 * The rest of the chain (daemon RPC → host → manager → notification) is
 * asserted in `daemonBridge.test.ts`, which drives a real daemon child process.
 */

import { afterEach, describe, expect, it } from "vitest";
import dgram from "node:dgram";
import fs from "node:fs";
import { TftpAdapter } from "../../../src/services/networkServers/tftp/TftpAdapter";
import { DhcpAdapter } from "../../../src/services/networkServers/dhcp/DhcpAdapter";
import { ServerStatus } from "../../../src/services/networkServers/core/ServerStatus";
import { mkdtemp } from "../../helpers/networkServerTestHelpers";

/** Binds a UDP port and keeps it, so the next binder gets EADDRINUSE. */
function holdUdpPort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const { port } = socket.address() as { port: number };
      resolve({
        port,
        release: () => new Promise<void>((done) => socket.close(() => done()))
      });
    });
  });
}

describe("network server adapters — a start that fails must reject", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup().catch(() => undefined);
    }
  });

  it("TFTP: a port already in use rejects start() and records ERROR", async () => {
    const held = await holdUdpPort();
    cleanups.push(held.release);
    const root = mkdtemp("nexus-adapter-fail-");
    cleanups.push(async () => fs.rmSync(root, { recursive: true, force: true }));

    const adapter = new TftpAdapter({ root, port: held.port, interface: "127.0.0.1" });
    cleanups.push(() => adapter.stop());

    await expect(
      adapter.start(),
      "resolving here is what made the daemon answer {ok:true} for a service that never bound"
    ).rejects.toThrow(/already in use/i);
    expect(adapter.status).toBe(ServerStatus.ERROR);
    expect(adapter.boundPort, "nothing was bound, so nothing may be reported as bound").toBeNull();
  });

  it("DHCP: an unbindable address rejects start() and records ERROR", async () => {
    // TEST-NET-3 (RFC 5737). Not assigned to any interface anywhere, so the
    // bind fails with EADDRNOTAVAIL rather than depending on who owns port 67
    // — and unlike EACCES it does not trigger the 67 → 1067 fallback, so the
    // failure is the one under test.
    const adapter = new DhcpAdapter({ bindAddress: "203.0.113.7" });
    cleanups.push(() => adapter.stop());

    await expect(adapter.start()).rejects.toThrow(/EADDRNOTAVAIL/i);
    expect(adapter.status).toBe(ServerStatus.ERROR);
    expect(adapter.boundPort).toBeNull();
  });
});
