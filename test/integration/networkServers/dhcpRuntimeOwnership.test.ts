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
import fs from "node:fs";
import { BaseNexusServer } from "../../../src/services/networkServers/core/BaseNexusServer";
import { ServerManager } from "../../../src/services/networkServers/core/ServerManager";
import { ServerStatus } from "../../../src/services/networkServers/core/ServerStatus";
import { DhcpAdapter } from "../../../src/services/networkServers/dhcp/DhcpAdapter";
import { DhcpEngine } from "../../../src/services/networkServers/dhcp/engine/DhcpEngine";
import { TftpAdapter } from "../../../src/services/networkServers/tftp/TftpAdapter";
import { TftpEngine } from "../../../src/services/networkServers/tftp/engine/TftpEngine";
import { mkdtemp } from "../../helpers/networkServerTestHelpers";

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

function tftpEngineOf(adapter: TftpAdapter): TftpEngine | null {
  return (adapter as unknown as { engine: TftpEngine | null }).engine;
}

function send(socket: dgram.Socket, message: Buffer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(message, port, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
  });
}

class ControlledDisposableServer extends BaseNexusServer {
  public disposeCalls = 0;
  public disposed = false;
  public stopCalls = 0;

  public constructor(
    id: string,
    private disposeAction: () => Promise<void>,
    private stopAction: () => Promise<void> = async () => undefined,
  ) {
    super(id, "Controlled server", 0);
  }

  public override async start(): Promise<void> {
    this.setStatus(ServerStatus.RUNNING);
  }

  public override async stop(): Promise<void> {
    this.stopCalls += 1;
    await this.stopAction();
    this.setStatus(ServerStatus.STOPPED);
  }

  public override async dispose(): Promise<void> {
    this.disposeCalls += 1;
    await this.disposeAction();
    this.disposed = true;
  }

}

class GatedFailingStartServer extends BaseNexusServer {
  public starts = 0;

  public constructor(
    private readonly entered: { resolve: () => void },
    private readonly release: Promise<void>,
  ) {
    super("failing", "Gated failing server", 0);
  }

  public override async start(): Promise<void> {
    this.starts += 1;
    this.setStatus(ServerStatus.STARTING);
    this.entered.resolve();
    await this.release;
    this.setStatus(ServerStatus.ERROR, "synthetic bind failure");
    throw new Error("synthetic bind failure");
  }

  public override async stop(): Promise<void> {
    this.setStatus(ServerStatus.STOPPED);
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

  it("treats a real closed dependency reply socket as ERROR, then releases its owned engine", async () => {
    const port = await freeLoopbackPort();
    const adapter = createAdapter(port);
    const manager = new ServerManager().register("dhcp", () => adapter);

    try {
      await manager.start("dhcp");
      const engine = engineOf(adapter)!;
      const dependencyServer = (engine as unknown as { _server: any })._server;
      await new Promise<void>((resolve) => dependencyServer._sock.close(() => resolve()));

      // This is the dependency's real OFFER formatter and its now-closed UDP
      // socket, not a synthetic engine error. A broken reply channel is fatal
      // even though the adapter still owns the engine long enough to stop it.
      expect(() => dependencyServer.sendOffer({
        xid: 0x12345678,
        flags: 0,
        ciaddr: "0.0.0.0",
        giaddr: "0.0.0.0",
        chaddr: "AA-BB-CC-DD-EE-FF",
        options: {},
      })).not.toThrow();
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

  it("queues same-tick DHCP start and Base disposal until the socket is stopped", async () => {
    const port = await freeLoopbackPort();
    const adapter = createAdapter(port);
    const starting = adapter.start();
    const disposing = adapter.dispose();

    try {
      await Promise.all([starting, disposing]);
      expect(adapter.status).toBe(ServerStatus.STOPPED);
      expect(adapter.boundPort).toBeNull();

      const release = await holdLoopbackPort(port);
      await release();
    } finally {
      await adapter.stop().catch(() => undefined);
    }
  });
});

describe("ServerManager disposal ownership", () => {
  it.each(["dhcp", "tftp"] as const)(
    "keeps a real %s adapter mapped when rejecting cleanup must be retried",
    async (kind) => {
      const root = kind === "tftp" ? mkdtemp("nexus-manager-drop-retry-") : undefined;
      const port = kind === "dhcp" ? await freeLoopbackPort() : 0;
      const adapter = kind === "dhcp"
        ? createAdapter(port)
        : new TftpAdapter({ root, port, interface: "127.0.0.1" });
      const manager = new ServerManager().register(kind, () => adapter);

      try {
        await manager.start(kind);
        const engine = kind === "dhcp" ? engineOf(adapter as DhcpAdapter)! : tftpEngineOf(adapter as TftpAdapter)!;
        const originalStop = engine.stop.bind(engine);
        let attempts = 0;
        const stopSpy = vi.spyOn(engine, "stop").mockImplementation(async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("synthetic manager cleanup failure");
          await originalStop();
        });

        try {
          await expect(manager.dropInstance(kind)).rejects.toThrow(
            new RegExp(`Failed to stop server '${kind}': synthetic manager cleanup failure`),
          );
          expect(manager.getInstance(kind)).toBe(adapter);
          expect(kind === "dhcp" ? (adapter as DhcpAdapter).boundPort : (adapter as TftpAdapter).boundPort).not.toBeNull();

          await expect(manager.dropInstance(kind)).resolves.toBe(true);
          expect(attempts).toBe(2);
          expect(manager.getInstance(kind)).toBeUndefined();
          expect(kind === "dhcp" ? (adapter as DhcpAdapter).boundPort : (adapter as TftpAdapter).boundPort).toBeNull();
        } finally {
          stopSpy.mockRestore();
          await originalStop();
        }
      } finally {
        await adapter.stop().catch(() => undefined);
        if (root) fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("serializes same-tick manager start and stop for a real DHCP socket", async () => {
    const port = await freeLoopbackPort();
    const adapter = createAdapter(port);
    const manager = new ServerManager().register("dhcp", () => adapter);
    const starting = manager.start("dhcp");
    const stopping = manager.stop("dhcp");

    try {
      await Promise.all([starting, stopping]);
      expect(adapter.status).toBe(ServerStatus.STOPPED);
      expect(adapter.boundPort).toBeNull();
    } finally {
      await adapter.stop().catch(() => undefined);
    }
  });

  it("serializes same-tick manager start and drop before deleting a real DHCP owner", async () => {
    const port = await freeLoopbackPort();
    const adapter = createAdapter(port);
    const manager = new ServerManager().register("dhcp", () => adapter);
    const starting = manager.start("dhcp");
    const dropping = manager.dropInstance("dhcp");

    try {
      await Promise.all([starting, dropping]);
      expect(manager.getInstance("dhcp")).toBeUndefined();
      expect(adapter.boundPort).toBeNull();

      const release = await holdLoopbackPort(port);
      await release();
    } finally {
      await adapter.stop().catch(() => undefined);
    }
  });

  it("queues a new drop after an intervening real DHCP start", async () => {
    const port = await freeLoopbackPort();
    const adapters: DhcpAdapter[] = [];
    const manager = new ServerManager().register("dhcp", () => {
      const adapter = createAdapter(port);
      adapters.push(adapter);
      return adapter;
    });
    const dropEntered = deferred();
    const releaseFirstDrop = deferred();
    let stopSpy: { mockRestore(): void } | undefined;
    let firstDrop: Promise<boolean> | undefined;
    let restarting: Promise<void> | undefined;
    let finalDrop: Promise<boolean> | undefined;

    try {
      await manager.start("dhcp");
      const firstEngine = engineOf(adapters[0])!;
      const originalStop = firstEngine.stop.bind(firstEngine);
      stopSpy = vi.spyOn(firstEngine, "stop").mockImplementation(async () => {
        dropEntered.resolve();
        await releaseFirstDrop.promise;
        await originalStop();
      });

      firstDrop = manager.dropInstance("dhcp");
      restarting = manager.start("dhcp");
      finalDrop = manager.dropInstance("dhcp");

      expect(finalDrop).not.toBe(firstDrop);
      await dropEntered.promise;
      releaseFirstDrop.resolve();
      await Promise.all([firstDrop, restarting, finalDrop]);

      expect(adapters).toHaveLength(2);
      expect(manager.getInstance("dhcp")).toBeUndefined();
      expect(adapters[1].boundPort).toBeNull();
      const releasePort = await holdLoopbackPort(port);
      await releasePort();
    } finally {
      releaseFirstDrop.resolve();
      stopSpy?.mockRestore();
      await Promise.allSettled(
        [firstDrop, restarting, finalDrop].filter((operation): operation is Promise<unknown> => operation !== undefined),
      );
      await Promise.allSettled(adapters.map((adapter) => adapter.stop()));
    }
  });

  it("queues a post-start drop when disposeAll follows a pending real DHCP drop", async () => {
    const port = await freeLoopbackPort();
    const adapters: DhcpAdapter[] = [];
    const manager = new ServerManager().register("dhcp", () => {
      const adapter = createAdapter(port);
      adapters.push(adapter);
      return adapter;
    });
    const dropEntered = deferred();
    const releaseFirstDrop = deferred();
    let stopSpy: { mockRestore(): void } | undefined;
    let firstDrop: Promise<boolean> | undefined;
    let restarting: Promise<void> | undefined;
    let disposingAll: Promise<void> | undefined;

    try {
      await manager.start("dhcp");
      const firstEngine = engineOf(adapters[0])!;
      const originalStop = firstEngine.stop.bind(firstEngine);
      stopSpy = vi.spyOn(firstEngine, "stop").mockImplementation(async () => {
        dropEntered.resolve();
        await releaseFirstDrop.promise;
        await originalStop();
      });

      firstDrop = manager.dropInstance("dhcp");
      restarting = manager.start("dhcp");
      disposingAll = manager.disposeAll();

      await dropEntered.promise;
      releaseFirstDrop.resolve();
      await Promise.all([firstDrop, restarting, disposingAll]);

      expect(adapters).toHaveLength(2);
      expect(manager.getInstance("dhcp")).toBeUndefined();
      expect(adapters[1].boundPort).toBeNull();
      const releasePort = await holdLoopbackPort(port);
      await releasePort();
    } finally {
      releaseFirstDrop.resolve();
      stopSpy?.mockRestore();
      await Promise.allSettled(
        [firstDrop, restarting, disposingAll].filter((operation): operation is Promise<unknown> => operation !== undefined),
      );
      await Promise.allSettled(adapters.map((adapter) => adapter.stop()));
    }
  });

  it("returns a missing-registry start error as a rejected promise", async () => {
    const manager = new ServerManager();
    let starting: Promise<void> | undefined;

    expect(() => {
      starting = manager.start("missing");
    }).not.toThrow();
    await expect(starting).rejects.toThrow(/Server 'missing' not found in registry/);
  });

  it("returns a factory configuration error from restart as a rejected promise", async () => {
    const manager = new ServerManager().register("invalid-config", () => {
      throw new Error("synthetic invalid DHCP configuration");
    });
    let restarting: Promise<void> | undefined;

    expect(() => {
      restarting = manager.restart("invalid-config");
    }).not.toThrow();
    await expect(restarting).rejects.toThrow(/synthetic invalid DHCP configuration/);
  });

  it("shares a concurrent manager start failure instead of resolving from STARTING", async () => {
    const startEntered = deferred();
    const releaseStart = deferred();
    const server = new GatedFailingStartServer(startEntered, releaseStart.promise);
    const manager = new ServerManager().register("failing", () => server);
    const first = manager.start("failing");

    try {
      await startEntered.promise;
      const second = manager.start("failing");
      releaseStart.resolve();

      await expect(first).rejects.toThrow(/synthetic bind failure/);
      await expect(second).rejects.toThrow(/synthetic bind failure/);
      expect(server.starts).toBe(1);
    } finally {
      releaseStart.resolve();
      await Promise.allSettled([first]);
    }
  });

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

  it("publishes a reentrant drop before disposal can invoke it again", async () => {
    const disposalEntered = deferred();
    const releaseDisposal = deferred();
    let reentrant: Promise<boolean> | undefined;
    let firstDisposal = true;
    const manager = new ServerManager();
    const server = new ControlledDisposableServer(
      "reentrant",
      async () => {
        disposalEntered.resolve();
        await releaseDisposal.promise;
      },
      async () => {
        if (firstDisposal) {
          firstDisposal = false;
          reentrant = manager.dropInstance("reentrant");
        }
      },
    );
    manager.register("reentrant", () => server);
    manager.ensureInstance("reentrant");
    const dropping = manager.dropInstance("reentrant");

    try {
      await disposalEntered.promise;
      expect(reentrant).toBe(dropping);
      expect(server.disposeCalls).toBe(1);

      releaseDisposal.resolve();
      await expect(dropping).resolves.toBe(true);
      await expect(reentrant).resolves.toBe(true);
    } finally {
      releaseDisposal.resolve();
      await Promise.allSettled([dropping, reentrant].filter((promise): promise is Promise<boolean> => promise !== undefined));
    }
  });

  it("shares ordinary concurrent drops before their disposal gate resolves", async () => {
    const disposalEntered = deferred();
    const releaseDisposal = deferred();
    const server = new ControlledDisposableServer("concurrent", async () => {
      disposalEntered.resolve();
      await releaseDisposal.promise;
    });
    const manager = new ServerManager().register("concurrent", () => server);
    manager.ensureInstance("concurrent");
    const first = manager.dropInstance("concurrent");
    const second = manager.dropInstance("concurrent");

    try {
      expect(second).toBe(first);
      await disposalEntered.promise;
      expect(server.disposeCalls).toBe(1);

      releaseDisposal.resolve();
      await expect(first).resolves.toBe(true);
      await expect(second).resolves.toBe(true);
    } finally {
      releaseDisposal.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("waits for a pending drop instead of double-disposing during disposeAll", async () => {
    const disposalEntered = deferred();
    const releaseDisposal = deferred();
    const server = new ControlledDisposableServer("shutdown", async () => {
      disposalEntered.resolve();
      await releaseDisposal.promise;
    });
    const manager = new ServerManager().register("shutdown", () => server);
    manager.ensureInstance("shutdown");
    const dropping = manager.dropInstance("shutdown");

    try {
      await disposalEntered.promise;
      const disposingAll = manager.disposeAll();
      await Promise.resolve();
      expect(server.disposeCalls).toBe(1);

      releaseDisposal.resolve();
      await Promise.all([dropping, disposingAll]);
      expect(manager.getInstance("shutdown")).toBeUndefined();
    } finally {
      releaseDisposal.resolve();
      await dropping.catch(() => undefined);
    }
  });

  it("retains failed shutdown cleanup while still attempting independent instances", async () => {
    const failing = new ControlledDisposableServer(
      "failed-shutdown",
      async () => undefined,
      async () => {
        throw new Error("synthetic shutdown cleanup failure");
      },
    );
    const independent = new ControlledDisposableServer("independent", async () => undefined);
    const manager = new ServerManager()
      .register("failed-shutdown", () => failing)
      .register("independent", () => independent);
    manager.ensureInstance("failed-shutdown");
    manager.ensureInstance("independent");

    await expect(manager.disposeAll()).resolves.toBeUndefined();
    expect(failing.stopCalls).toBe(1);
    expect(manager.getInstance("failed-shutdown")).toBe(failing);
    expect(independent.disposeCalls).toBe(1);
    expect(manager.getInstance("independent")).toBeUndefined();
  });
});
