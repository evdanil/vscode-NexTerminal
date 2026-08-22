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

import { afterEach, describe, expect, it, vi } from "vitest";
import dgram from "node:dgram";
import fs from "node:fs";
import { TftpAdapter } from "../../../src/services/networkServers/tftp/TftpAdapter";
import { TftpEngine } from "../../../src/services/networkServers/tftp/engine/TftpEngine";
import { DhcpAdapter } from "../../../src/services/networkServers/dhcp/DhcpAdapter";
import { ServerStatus } from "../../../src/services/networkServers/core/ServerStatus";
import { mkdtemp } from "../../helpers/networkServerTestHelpers";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    vi.restoreAllMocks();
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

  it("TFTP: stop waits for a provisional engine start and then releases it", async () => {
    const root = mkdtemp("nexus-adapter-start-stop-");
    cleanups.push(async () => fs.rmSync(root, { recursive: true, force: true }));
    const startEntered = deferred();
    const releaseStart = deferred();
    const originalStart = TftpEngine.prototype.start;
    vi.spyOn(TftpEngine.prototype, "start").mockImplementation(async function (this: TftpEngine) {
      startEntered.resolve();
      await releaseStart.promise;
      await originalStart.call(this);
    });
    const adapter = new TftpAdapter({ root, port: 0, interface: "127.0.0.1" });
    cleanups.push(() => adapter.stop());
    let startPromise: Promise<void> | undefined;
    let stopPromise: Promise<void> | undefined;

    try {
      startPromise = adapter.start();
      await startEntered.promise;
      let stopSettled = false;
      stopPromise = adapter.stop().then(() => {
        stopSettled = true;
      });
      await Promise.resolve();
      expect(stopSettled, "stop must queue behind the provisional engine's start").toBe(false);

      releaseStart.resolve();
      await Promise.all([startPromise, stopPromise]);
      expect(adapter.status).toBe(ServerStatus.STOPPED);
      expect(adapter.boundPort).toBeNull();
    } finally {
      releaseStart.resolve();
      await Promise.allSettled(
        [startPromise, stopPromise].filter((p): p is Promise<void> => p !== undefined)
      );
    }
  });

  it("TFTP: failed start does not reject until its provisional engine is cleaned", async () => {
    const held = await holdUdpPort();
    cleanups.push(held.release);
    const root = mkdtemp("nexus-adapter-failed-cleanup-");
    cleanups.push(async () => fs.rmSync(root, { recursive: true, force: true }));
    const stopEntered = deferred();
    const releaseStop = deferred();
    const originalStop = TftpEngine.prototype.stop;
    vi.spyOn(TftpEngine.prototype, "stop").mockImplementation(async function (this: TftpEngine) {
      stopEntered.resolve();
      await releaseStop.promise;
      await originalStop.call(this);
    });
    const adapter = new TftpAdapter({ root, port: held.port, interface: "127.0.0.1" });
    cleanups.push(() => adapter.stop());
    let startSettled = false;
    const starting = adapter.start().then(
      () => {
        startSettled = true;
        return null;
      },
      (err: unknown) => {
        startSettled = true;
        return err;
      }
    );

    try {
      const firstOutcome = await Promise.race([
        stopEntered.promise.then(() => "cleanup-entered" as const),
        starting.then(() => "start-settled" as const)
      ]);
      expect(firstOutcome, "failed start must enter provisional cleanup before settling").toBe(
        "cleanup-entered"
      );
      await Promise.resolve();
      expect(startSettled, "the adapter must retain ownership until failed-start cleanup settles").toBe(false);

      releaseStop.resolve();
      const startError = await starting;
      expect(startError).toBeInstanceOf(Error);
      expect((startError as Error).message).toMatch(/already in use/i);
      expect(adapter.status).toBe(ServerStatus.ERROR);
      expect(adapter.boundPort).toBeNull();
    } finally {
      releaseStop.resolve();
      await starting;
    }
  });

  it("TFTP: dispose stops a live engine even after a runtime ERROR", async () => {
    const root = mkdtemp("nexus-adapter-error-dispose-");
    cleanups.push(async () => fs.rmSync(root, { recursive: true, force: true }));
    const adapter = new TftpAdapter({ root, port: 0, interface: "127.0.0.1" });
    const state = adapter as unknown as { engine: TftpEngine | null };

    await adapter.start();
    const engine = state.engine!;
    try {
      expect(engine.boundPort).not.toBeNull();
      engine.emit("error", new Error("synthetic runtime socket failure"));
      expect(adapter.status).toBe(ServerStatus.ERROR);

      await adapter.dispose();

      expect(adapter.boundPort, "dispose must release resources regardless of ERROR status").toBeNull();
      expect(engine.boundPort).toBeNull();
    } finally {
      await engine.stop();
    }
  });

  it.each(["stop", "dispose"] as const)(
    "TFTP: failed cleanup rejects stop, then %s retries and releases ownership",
    async (retryWith) => {
      const root = mkdtemp(`nexus-adapter-cleanup-retry-${retryWith}-`);
      cleanups.push(async () => fs.rmSync(root, { recursive: true, force: true }));
      const adapter = new TftpAdapter({ root, port: 0, interface: "127.0.0.1" });
      const state = adapter as unknown as { engine: TftpEngine | null };
      await adapter.start();
      const engine = state.engine!;
      const originalStop = engine.stop.bind(engine);
      let stopAttempts = 0;
      const stopSpy = vi.spyOn(engine, "stop").mockImplementation(async () => {
        stopAttempts++;
        if (stopAttempts === 1) throw new Error("synthetic engine cleanup failure");
        await originalStop();
      });

      try {
        await expect(adapter.stop()).rejects.toThrow(/synthetic engine cleanup failure/i);
        expect(adapter.status).toBe(ServerStatus.ERROR);
        expect(adapter.lastError).toMatch(/cleanup issue: synthetic engine cleanup failure/i);
        expect(state.engine, "failed cleanup must retain the captured engine").toBe(engine);
        expect(engine.boundPort, "the retained engine still owns its UDP port").not.toBeNull();

        if (retryWith === "stop") await adapter.stop();
        else await adapter.dispose();

        expect(stopAttempts, `${retryWith} must retry the retained engine`).toBe(2);
        expect(adapter.status).toBe(ServerStatus.STOPPED);
        expect(state.engine).toBeNull();
        expect(engine.boundPort).toBeNull();
      } finally {
        stopSpy.mockRestore();
        await originalStop();
      }
    }
  );

  it("TFTP: repeated dispose cleanup failure is awaited and swallowed with ownership retained", async () => {
    const root = mkdtemp("nexus-adapter-dispose-failure-");
    cleanups.push(async () => fs.rmSync(root, { recursive: true, force: true }));
    const adapter = new TftpAdapter({ root, port: 0, interface: "127.0.0.1" });
    const state = adapter as unknown as { engine: TftpEngine | null };
    await adapter.start();
    const engine = state.engine!;
    const originalStop = engine.stop.bind(engine);
    const disposeCleanupEntered = deferred();
    const releaseDisposeCleanup = deferred();
    let stopAttempts = 0;
    const stopSpy = vi.spyOn(engine, "stop").mockImplementation(async () => {
      stopAttempts++;
      if (stopAttempts === 1) throw new Error("first synthetic cleanup failure");
      disposeCleanupEntered.resolve();
      await releaseDisposeCleanup.promise;
      throw new Error("repeated synthetic cleanup failure");
    });
    let disposing: Promise<void> | undefined;

    try {
      await expect(adapter.stop()).rejects.toThrow(/first synthetic cleanup failure/i);
      disposing = adapter.dispose();
      await disposeCleanupEntered.promise;
      let disposeSettled = false;
      const observedDispose = disposing.then(() => {
        disposeSettled = true;
      });
      await Promise.resolve();
      expect(disposeSettled, "dispose must await the retrying engine cleanup").toBe(false);

      releaseDisposeCleanup.resolve();
      await expect(observedDispose).resolves.toBeUndefined();
      expect(stopAttempts).toBe(2);
      expect(adapter.status).toBe(ServerStatus.ERROR);
      expect(adapter.lastError).toMatch(/cleanup issue: repeated synthetic cleanup failure/i);
      expect(state.engine, "a failed disposal retry must keep ownership available").toBe(engine);
      expect(engine.boundPort).not.toBeNull();
    } finally {
      releaseDisposeCleanup.resolve();
      await Promise.allSettled([disposing].filter((p): p is Promise<void> => p !== undefined));
      stopSpy.mockRestore();
      await originalStop();
    }
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
