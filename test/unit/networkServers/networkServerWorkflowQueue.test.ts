import { describe, expect, it } from "vitest";
import { ServiceWorkflowQueue } from "../../../src/services/networkServers/networkServerWorkflowQueue";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ServiceWorkflowQueue", () => {
  it("keeps a gated restart, later configure, and start in input order for one service", async () => {
    const queue = new ServiceWorkflowQueue();
    const restartEntered = deferred();
    const releaseRestart = deferred();
    const lifecycle: string[] = [];
    const sockets = new Set<string>(["old"]);
    let savedConfig = "old";
    let instance = { identity: "old", socket: "old" };

    const restart = queue.enqueue("tftp", async () => {
      lifecycle.push("restart:stop");
      restartEntered.resolve();
      await releaseRestart.promise;
      sockets.delete(instance.socket);
      savedConfig = "restart";
      instance = { identity: "restart", socket: "restart" };
      sockets.add(instance.socket);
      lifecycle.push("restart:start");
      return { id: 1, ok: true };
    });
    await restartEntered.promise;

    const configure = queue.enqueue("tftp", async () => {
      savedConfig = "configured";
      lifecycle.push("configure");
      return { id: 2, ok: true };
    });
    const start = queue.enqueue("tftp", async () => {
      lifecycle.push("start:no-op-running");
      return { id: 3, ok: true };
    });

    releaseRestart.resolve();
    await expect(Promise.all([restart, configure, start])).resolves.toEqual([
      { id: 1, ok: true },
      { id: 2, ok: true },
      { id: 3, ok: true },
    ]);

    expect(lifecycle).toEqual(["restart:stop", "restart:start", "configure", "start:no-op-running"]);
    expect(savedConfig).toBe("configured");
    expect(instance).toEqual({ identity: "restart", socket: "restart" });
    expect([...sockets]).toEqual(["restart"]);

    const finalRestart = await queue.enqueue("tftp", async () => {
      sockets.delete(instance.socket);
      instance = { identity: "configured", socket: savedConfig };
      sockets.add(instance.socket);
      return { id: 4, ok: true };
    });
    expect(finalRestart).toEqual({ id: 4, ok: true });
    expect(instance).toEqual({ identity: "configured", socket: "configured" });
    expect([...sockets]).toEqual(["configured"]);
  });

  it("drains a gated workflow before shutdown disposes its socket owner", async () => {
    const queue = new ServiceWorkflowQueue();
    const workflowEntered = deferred();
    const releaseWorkflow = deferred();
    let socketOwned = true;
    let disposed = false;

    const stopping = queue.enqueue("dhcp", async () => {
      workflowEntered.resolve();
      await releaseWorkflow.promise;
      socketOwned = false;
    });
    await workflowEntered.promise;

    const shutdown = (async (): Promise<void> => {
      await queue.drain();
      disposed = true;
    })();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposed, "shutdown must not dispose around an unfinished service workflow").toBe(false);
    expect(socketOwned).toBe(true);

    releaseWorkflow.resolve();
    await Promise.all([stopping, shutdown]);
    expect(socketOwned).toBe(false);
    expect(disposed).toBe(true);
  });

  it("recovers after a rejected workflow and removes its settled service tail (catches a rejected-map-entry retention mutation)", async () => {
    const queue = new ServiceWorkflowQueue();
    const rejection = new Error("synthetic workflow rejection");

    await expect(queue.enqueue("dhcp", async () => {
      throw rejection;
    })).rejects.toBe(rejection);

    await expect(queue.enqueue("dhcp", async () => "recovered")).resolves.toBe("recovered");
    await queue.drain();
    await Promise.resolve();

    expect((queue as unknown as { queues: Map<string, Promise<void>> }).queues.size).toBe(0);
  });

  it("runs a different service while one service workflow remains gated (catches a shared global-tail mutation)", async () => {
    const queue = new ServiceWorkflowQueue();
    const tftpEntered = deferred();
    const releaseTftp = deferred();
    let tftpFinished = false;

    const tftp = queue.enqueue("tftp", async () => {
      tftpEntered.resolve();
      await releaseTftp.promise;
      tftpFinished = true;
      return "tftp";
    });
    await tftpEntered.promise;

    let dhcpFinished = false;
    const dhcp = queue.enqueue("dhcp", async () => {
      dhcpFinished = true;
      return "dhcp";
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(dhcpFinished).toBe(true);
      expect(tftpFinished).toBe(false);
    } finally {
      releaseTftp.resolve();
      await expect(tftp).resolves.toBe("tftp");
      await expect(dhcp).resolves.toBe("dhcp");
    }
  });

  it("acquires tftp then dhcp atomically, without letting either single-service workflow interleave", async () => {
    const queue = new ServiceWorkflowQueue();
    const tftpEntered = deferred();
    const releaseTftp = deferred();
    const configureEntered = deferred();
    const releaseConfigure = deferred();
    const lifecycle: string[] = [];

    const tftp = queue.enqueue("tftp", async () => {
      lifecycle.push("tftp:before");
      tftpEntered.resolve();
      await releaseTftp.promise;
      lifecycle.push("tftp:after");
    });
    await tftpEntered.promise;

    const configure = queue.enqueueMany(["dhcp", "tftp"], async () => {
      lifecycle.push("configure");
      configureEntered.resolve();
      await releaseConfigure.promise;
    });
    const dhcp = queue.enqueue("dhcp", async () => {
      lifecycle.push("dhcp:after-configure");
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lifecycle).toEqual(["tftp:before"]);

    releaseTftp.resolve();
    await configureEntered.promise;
    expect(lifecycle).toEqual(["tftp:before", "tftp:after", "configure"]);

    releaseConfigure.resolve();
    await Promise.all([tftp, configure, dhcp]);
    expect(lifecycle).toEqual(["tftp:before", "tftp:after", "configure", "dhcp:after-configure"]);
  });

  it("keeps a queued coherent read ahead of a later mutation for the same service", async () => {
    const queue = new ServiceWorkflowQueue();
    const stopEntered = deferred();
    const releaseStop = deferred();
    const observed: string[] = [];

    const stop = queue.enqueue("tftp", async () => {
      stopEntered.resolve();
      await releaseStop.promise;
      observed.push("stopped");
    });
    await stopEntered.promise;
    const read = queue.read("tftp", async () => {
      observed.push("read:stopped");
    });
    const restart = queue.enqueue("tftp", async () => {
      observed.push("restarted");
    });

    releaseStop.resolve();
    await Promise.all([stop, read, restart]);
    expect(observed).toEqual(["stopped", "read:stopped", "restarted"]);
  });

  it("refuses new work after close while retaining already accepted tails for shutdown drain", async () => {
    const queue = new ServiceWorkflowQueue();
    const entered = deferred();
    const release = deferred();
    const accepted = queue.enqueue("dhcp", async () => {
      entered.resolve();
      await release.promise;
      return "accepted";
    });
    await entered.promise;

    queue.close();
    await expect(queue.enqueue("dhcp", async () => "late")).rejects.toThrow(/shutting down/i);

    let drained = false;
    const draining = queue.drain().then(() => { drained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    release.resolve();
    await expect(accepted).resolves.toBe("accepted");
    await draining;
    expect(drained).toBe(true);
  });
});
