/**
 * DHCP adapter and manager lifecycle ownership regressions.
 *
 * These cases distinguish status from resource ownership.  A DHCP engine can
 * report a fatal runtime error while it still owns its UDP socket; a later
 * lifecycle request must find, close, and retain ownership of that engine
 * until cleanup actually succeeds.
 */

import { describe, expect, it, vi } from "vitest";
import dgram from "node:dgram";
import { BaseNexusServer } from "../../../src/services/networkServers/core/BaseNexusServer";
import { ServerManager } from "../../../src/services/networkServers/core/ServerManager";
import { ServerStatus } from "../../../src/services/networkServers/core/ServerStatus";
import { DhcpAdapter } from "../../../src/services/networkServers/dhcp/DhcpAdapter";
import { DhcpEngine } from "../../../src/services/networkServers/dhcp/engine/DhcpEngine";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function freeLoopbackPort(): Promise<number> {
  const socket = dgram.createSocket("udp4");
  try {
    return await new Promise<number>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", () => resolve(socket.address().port));
    });
  } finally {
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
}

async function holdLoopbackPort(port: number): Promise<() => Promise<void>> {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, "127.0.0.1", resolve);
  });
  return () => new Promise<void>((resolve) => socket.close(() => resolve()));
}

function createAdapter(port: number): DhcpAdapter {
  const adapter = new DhcpAdapter({
    rangeStart: "172.28.1.10",
    rangeEnd: "172.28.1.20",
    subnet: "255.255.255.0",
    gateway: "172.28.1.1",
    serverId: "172.28.1.1",
    broadcast: "127.0.0.1",
    bindAddress: "127.0.0.1",
  });
  // DHCP's public configuration intentionally keeps the IANA default at 67.
  // Test-only loopback ports avoid privileges and collisions while preserving
  // the adapter → engine binding path.
  Object.defineProperty(adapter, "port", { value: port });
  return adapter;
}

function engineOf(adapter: DhcpAdapter): DhcpEngine | null {
  return (adapter as unknown as { engine: DhcpEngine | null }).engine;
}

function send(socket: dgram.Socket, message: Buffer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(message, port, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
  });
}

class ControlledDisposableServer extends BaseNexusServer {
  public disposeCalls = 0;
  public disposed = false;

  public constructor(
    id: string,
    private disposeAction: () => Promise<void>,
  ) {
    super(id, "Controlled server", 0);
  }

  public override async start(): Promise<void> {
    this.setStatus(ServerStatus.RUNNING);
  }

  public override async stop(): Promise<void> {
    this.setStatus(ServerStatus.STOPPED);
  }

  public override async dispose(): Promise<void> {
    this.disposeCalls += 1;
    await this.disposeAction();
    this.disposed = true;
  }

}

describe("DHCP runtime ownership", () => {
  it("keeps packet rejection RUNNING on its existing loopback port", async () => {
    const port = await freeLoopbackPort();
    const adapter = createAdapter(port);
    const client = dgram.createSocket("udp4");
    const rejected = new Promise<void>((resolve) => {
      adapter.on("log", (level, message) => {
        if (level === "warn" && message.includes("dropped malformed DHCP packet")) resolve();
      });
    });

    try {
      await adapter.start();
      await send(client, Buffer.from([1, 1, 6]), port);
      await rejected;

      expect(adapter.status).toBe(ServerStatus.RUNNING);
      expect(adapter.boundPort).toBe(port);
    } finally {
      await new Promise<void>((resolve) => client.close(() => resolve()));
      await adapter.stop().catch(() => undefined);
    }
  });

  it("drops an ERROR-owned DHCP engine only after its socket is released", async () => {
    const port = await freeLoopbackPort();
    const adapter = createAdapter(port);
    const manager = new ServerManager().register("dhcp", () => adapter);

    try {
      await manager.start("dhcp");
      const engine = engineOf(adapter)!;
      engine.emit("error", new Error("synthetic socket ownership failure"));
      expect(adapter.status).toBe(ServerStatus.ERROR);
      expect(adapter.boundPort).toBe(port);

      await expect(manager.dropInstance("dhcp")).resolves.toBe(true);
      expect(manager.getInstance("dhcp")).toBeUndefined();
      expect(adapter.boundPort).toBeNull();

      const release = await holdLoopbackPort(port);
      await release();
    } finally {
      await adapter.stop().catch(() => undefined);
    }
  });

  it("reaps an ERROR-owned engine before replacing it", async () => {
    const port = await freeLoopbackPort();
    const adapter = createAdapter(port);

    try {
      await adapter.start();
      const oldEngine = engineOf(adapter)!;
      oldEngine.emit("error", new Error("synthetic runtime failure"));
      expect(adapter.status).toBe(ServerStatus.ERROR);

      await adapter.start();

      const replacement = engineOf(adapter)!;
      expect(replacement).not.toBe(oldEngine);
      expect(oldEngine.boundPort).toBeNull();
      expect(replacement.boundPort).toBe(port);
      expect(adapter.status).toBe(ServerStatus.RUNNING);
    } finally {
      await adapter.stop().catch(() => undefined);
    }
  });

  it("does not replace an ERROR-owned engine when its cleanup fails", async () => {
    const port = await freeLoopbackPort();
    const adapter = createAdapter(port);

    try {
      await adapter.start();
      const oldEngine = engineOf(adapter)!;
      const originalStop = oldEngine.stop.bind(oldEngine);
      const stopSpy = vi.spyOn(oldEngine, "stop").mockRejectedValue(new Error("synthetic cleanup failure"));
      oldEngine.emit("error", new Error("synthetic runtime failure"));

      try {
        await expect(adapter.start()).rejects.toThrow(/Cannot replace the previous DHCP engine: synthetic cleanup failure/);
        expect(engineOf(adapter)).toBe(oldEngine);
        expect(oldEngine.boundPort).toBe(port);
      } finally {
        stopSpy.mockRestore();
        await originalStop();
      }
    } finally {
      await adapter.stop().catch(() => undefined);
    }
  });

  it("serializes a pending DHCP start before its queued stop", async () => {
    const port = await freeLoopbackPort();
    const adapter = createAdapter(port);
    const startEntered = deferred();
    const releaseStart = deferred();
    const originalStart = DhcpEngine.prototype.start;
    const startSpy = vi.spyOn(DhcpEngine.prototype, "start").mockImplementation(async function (
      this: DhcpEngine,
      preferredPort: number,
    ) {
      startEntered.resolve();
      await releaseStart.promise;
      return originalStart.call(this, preferredPort);
    });
    let starting: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;

    try {
      starting = adapter.start();
      await startEntered.promise;
      let stopSettled = false;
      stopping = adapter.stop().then(() => {
        stopSettled = true;
      });
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      releaseStart.resolve();
      await Promise.all([starting, stopping]);
      expect(adapter.status).toBe(ServerStatus.STOPPED);
      expect(adapter.boundPort).toBeNull();
    } finally {
      releaseStart.resolve();
      await Promise.allSettled([starting, stopping].filter((promise): promise is Promise<void> => promise !== undefined));
      startSpy.mockRestore();
      await adapter.stop().catch(() => undefined);
    }
  });

  it("retains a failed cleanup owner for ERROR disposal to retry", async () => {
    const port = await freeLoopbackPort();
    const adapter = createAdapter(port);

    try {
      await adapter.start();
      const engine = engineOf(adapter)!;
      const originalStop = engine.stop.bind(engine);
      let attempts = 0;
      const stopSpy = vi.spyOn(engine, "stop").mockImplementation(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("synthetic cleanup failure");
        await originalStop();
      });

      try {
        await expect(adapter.stop()).rejects.toThrow(/synthetic cleanup failure/);
        expect(adapter.status).toBe(ServerStatus.ERROR);
        expect(engineOf(adapter)).toBe(engine);
        expect(engine.boundPort).toBe(port);

        await adapter.dispose();

        expect(attempts).toBe(2);
        expect(adapter.status).toBe(ServerStatus.STOPPED);
        expect(engineOf(adapter)).toBeNull();
        expect(engine.boundPort).toBeNull();
      } finally {
        stopSpy.mockRestore();
        await originalStop();
      }
    } finally {
      await adapter.stop().catch(() => undefined);
    }
  });
});

describe("ServerManager disposal ownership", () => {
  it("retains the mapped instance until delayed disposal finishes before creating a replacement", async () => {
    const disposalEntered = deferred();
    const releaseDisposal = deferred();
    const created: ControlledDisposableServer[] = [];
    const manager = new ServerManager();
    manager.register("replace", () => {
      if (created.length > 0 && !created[0].disposed) {
        throw new Error("replacement overlapped the previous disposal");
      }
      const server = new ControlledDisposableServer("replace", async () => {
        disposalEntered.resolve();
        await releaseDisposal.promise;
      });
      created.push(server);
      return server;
    });
    const first = manager.ensureInstance("replace");
    const dropping = manager.dropInstance("replace");

    try {
      await disposalEntered.promise;
      expect(manager.getInstance("replace")).toBe(first);
      expect(manager.ensureInstance("replace")).toBe(first);
      expect(created).toHaveLength(1);

      releaseDisposal.resolve();
      await expect(dropping).resolves.toBe(true);
      expect(manager.getInstance("replace")).toBeUndefined();

      const replacement = manager.ensureInstance("replace");
      expect(replacement).not.toBe(first);
      expect(created).toHaveLength(2);
    } finally {
      releaseDisposal.resolve();
      await dropping.catch(() => undefined);
    }
  });

  it("keeps a rejected disposal mapped and propagates an actionable retry error", async () => {
    let failDisposal = true;
    const server = new ControlledDisposableServer("retry", async () => {
      if (failDisposal) throw new Error("synthetic disposal failure");
    });
    const manager = new ServerManager().register("retry", () => server);
    manager.ensureInstance("retry");

    await expect(manager.dropInstance("retry")).rejects.toThrow(/retry.*synthetic disposal failure/i);
    expect(manager.getInstance("retry")).toBe(server);

    failDisposal = false;
    await expect(manager.dropInstance("retry")).resolves.toBe(true);
    expect(manager.getInstance("retry")).toBeUndefined();
  });
});
